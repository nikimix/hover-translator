// Пункт контекстного меню «Перевести «…»»: background.js в node через vm с заглушкой chrome.* (как в
// background-install.test.js, плюс contextMenus, tabs.sendMessage, action.openPopup и значок по вкладкам).
// Проверяет: пункт создаётся при установке, обновлении и старте браузера без дублей (повторный create с тем же id в
// Chrome — ошибка); название, contexts, documentUrlPatterns; видимость следует enabled; выбор пункта — сообщение
// translateSelection тому фрейму, где выделено; получателя нет — окно расширения (action.openPopup), без openPopup
// или он отказал — «!» на значке этой вкладки.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { EXT } = require("../lib/env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MENU_ID = "ht-translate-selection";

function makeEnv(initialLocal = {}, opts = {}) {
  const local = Object.assign({ consent: { deepl: true, openai: true, anthropic: true } }, initialLocal);
  const session = {};
  const changedFns = [];
  function area(store, isLocal) {
    return {
      get(keys) {
        let out = {};
        if (keys == null) out = Object.assign({}, store);
        else if (Array.isArray(keys)) for (const k of keys) { if (k in store) out[k] = store[k]; }
        else if (typeof keys === "string") { if (keys in store) out[keys] = store[keys]; }
        else for (const k in keys) out[k] = k in store ? store[k] : keys[k];
        return Promise.resolve(JSON.parse(JSON.stringify(out)));
      },
      set(obj) {
        const changes = {};
        for (const k in obj) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = JSON.parse(JSON.stringify(obj[k])); }
        if (isLocal) for (const fn of changedFns) fn(changes, "local");
        return Promise.resolve();
      },
      remove(keys) { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
    };
  }
  const installed = [], startup = [], clicked = [];
  // Меню как в Chrome: create с уже занятым id — ошибка в runtime.lastError (видна только в колбэке), update
  // несуществующего — тоже; ошибки считаем.
  const items = new Map();
  const menu = { errors: [], calls: [] };
  let lastError;
  const finish = (cb, err) => {
    if (err) menu.errors.push(err);
    lastError = err ? { message: err } : undefined;
    try { if (cb) cb(); } finally { lastError = undefined; }
    return opts.menuPromises ? Promise.resolve() : undefined;
  };
  // Значок: общий и по вкладкам (tabId).
  const badge = { all: {}, tabs: {} };
  const setB = (k) => (o) => { (o.tabId == null ? badge.all : (badge.tabs[o.tabId] = badge.tabs[o.tabId] || {}))[k] = o[k]; return Promise.resolve(); };
  const sent = [], popups = [], tabsCreated = [];
  const action = {
    setBadgeText: setB("text"), setBadgeBackgroundColor: setB("color"), setTitle: setB("title"),
  };
  if (opts.openPopup !== "none") {
    action.openPopup = (o) => {
      popups.push(o === undefined ? null : JSON.parse(JSON.stringify(o)));
      if (opts.openPopup === "throw") throw new Error("Could not find an active browser window.");
      if (opts.openPopup === "reject") return Promise.reject(new Error("Failed to open popup."));
      return Promise.resolve();
    };
  }
  const ctx = {
    console, URL, TextEncoder, AbortController, DOMException, AbortSignal, JSON, Promise, Map, Set, Date, Math, Object, Array, String, Number, RegExp, Error, Intl,
    setTimeout, clearTimeout,
    chrome: {
      storage: { local: area(local, true), session: area(session, false), onChanged: { addListener: (fn) => changedFns.push(fn) } },
      alarms: { get: (n, cb) => cb(null), create() {}, onAlarm: { addListener() {} } },
      runtime: {
        get lastError() { return lastError; },
        onMessage: { addListener() {} },
        onInstalled: { addListener: (fn) => installed.push(fn) },
        onStartup: { addListener: (fn) => startup.push(fn) },
        getURL: (p) => "chrome-extension://abc/" + p,
        getManifest: () => ({ name: "Hover Translator" }),
      },
      contextMenus: {
        create(props, cb) {
          menu.calls.push("create");
          if (items.has(props.id)) return finish(cb, "Cannot create item with duplicate id " + props.id);
          items.set(props.id, JSON.parse(JSON.stringify(props)));
          return finish(cb);
        },
        update(id, props, cb) {
          menu.calls.push("update");
          if (!items.has(id)) return finish(cb, "Cannot find menu item with id " + id);
          Object.assign(items.get(id), JSON.parse(JSON.stringify(props)));
          return finish(cb);
        },
        removeAll(cb) { menu.calls.push("removeAll"); items.clear(); return finish(cb); },
        onClicked: { addListener: (fn) => clicked.push(fn) },
      },
      action,
      i18n: Object.assign(require("../lib/i18n-stub").makeI18n("ru"), { getUILanguage: () => "ru" }),
      tabs: {
        create: (o) => { tabsCreated.push(o.url); return Promise.resolve({}); },
        // Получателя нет (вкладка открыта до установки) — отказ, как у Chrome.
        sendMessage: (tabId, msg, o) => {
          sent.push([tabId, JSON.parse(JSON.stringify(msg)), o === undefined ? undefined : JSON.parse(JSON.stringify(o))]);
          return opts.noReceiver ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) : Promise.resolve(true);
        },
      },
    },
    fetch: () => Promise.reject(new Error("no network in test")),
  };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const install = async (reason) => { await Promise.all(installed.map((fn) => fn({ reason }))); await sleep(20); };
  const start = async () => { await Promise.all(startup.map((fn) => fn())); await sleep(20); };
  const click = async (info, tab) => { for (const fn of clicked) fn(info, tab); await sleep(20); };
  return { ctx, local, items, menu, badge, sent, popups, tabsCreated, install, start, click, installed, startup };
}

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const plain = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  // ---- создание пункта ----
  {
    const env = makeEnv();
    await sleep(20);
    assert.strictEqual(env.items.size, 0, "до установки пункта нет (Chrome хранит его сам, воркер при пробуждении не создаёт)");
    await env.install("install");
    assert.deepStrictEqual([...env.items.keys()], [MENU_ID], "один пункт");
    assert.deepStrictEqual(plain(env.items.get(MENU_ID)), {
      id: MENU_ID, title: "Перевести «%s»", contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"], visible: true,
    });
    assert.deepStrictEqual(env.tabsCreated, ["chrome-extension://abc/welcome.html"], "установка по-прежнему открывает приветствие");
    ok("установка: один пункт «Перевести «%s»» у выделенного (contexts: selection) только на http, https, file; виден");

    await env.install("update");
    await env.start();
    await env.install("chrome_update");
    assert.deepStrictEqual([...env.items.keys()], [MENU_ID]);
    assert.deepStrictEqual(env.menu.errors, [], "повторный create с тем же id не случался");
    // Обновление Chrome: onInstalled и onStartup приходят разом.
    await Promise.all([env.install("chrome_update"), env.start(), env.install("update")]);
    assert.deepStrictEqual([...env.items.keys()], [MENU_ID]);
    assert.deepStrictEqual(env.menu.errors, [], "одновременные события не создают пункт дважды: " + env.menu.errors);
    const n = env.menu.calls.filter((c) => c === "create").length;
    assert.strictEqual(n, 7, "на каждое событие — пересоздание (removeAll → create): " + env.menu.calls.join());
    for (let i = 0; i < env.menu.calls.length; i += 2) assert.deepStrictEqual(env.menu.calls.slice(i, i + 2), ["removeAll", "create"]);
    ok("обновление расширения, старт браузера, обновление Chrome (и все разом): пункт пересоздаётся (removeAll → create), без дублей");

    // Chrome без обещаний у contextMenus (до 123) и с ними — одинаково.
    const env2 = makeEnv({}, { menuPromises: true });
    await env2.install("update");
    await env2.start();
    assert.deepStrictEqual([...env2.items.keys()], [MENU_ID]);
    assert.deepStrictEqual(env2.menu.errors, []);
    ok("contextMenus с обещаниями (Chrome 123+) — тот же один пункт");
  }

  // ---- видимость следует enabled ----
  {
    const env = makeEnv({ enabled: false });
    await env.start();
    assert.strictEqual(env.items.get(MENU_ID).visible, false, "перевод выключен везде — пункт скрыт уже при создании");
    await env.ctx.chrome.storage.local.set({ enabled: true });
    await sleep(20);
    assert.strictEqual(env.items.get(MENU_ID).visible, true, "включили — пункт виден");
    await env.ctx.chrome.storage.local.set({ enabled: false });
    await sleep(20);
    assert.strictEqual(env.items.get(MENU_ID).visible, false, "выключили — скрыт");
    const u = env.menu.calls.filter((c) => c === "update").length;
    await env.ctx.chrome.storage.local.set({ engine: "deepl", targetLang: "DE" });
    await sleep(20);
    assert.strictEqual(env.menu.calls.filter((c) => c === "update").length, u, "другие настройки пункт не трогают");
    // Пункта не оказалось (его так и не создали) — включение создаёт его.
    env.items.clear();
    await env.ctx.chrome.storage.local.set({ enabled: true });
    await sleep(30);
    assert.deepStrictEqual([...env.items.keys()], [MENU_ID]);
    assert.strictEqual(env.items.get(MENU_ID).visible, true);
    ok("видимость: enabled = false — пункта нет (и при создании, и при смене настройки), true — есть; пропавший пункт создаётся заново");
  }

  // ---- выбор пункта ----
  {
    const env = makeEnv();
    await env.install("install");
    await env.click({ menuItemId: MENU_ID, selectionText: "directamente sobre la tierra", frameId: 3, editable: false }, { id: 7, windowId: 2 });
    assert.deepStrictEqual(env.sent, [[7, { type: "translateSelection", text: "directamente sobre la tierra" }, { frameId: 3 }]]);
    await env.click({ menuItemId: MENU_ID, selectionText: "hola", frameId: 0 }, { id: 7, windowId: 2 });
    assert.deepStrictEqual(env.sent[1], [7, { type: "translateSelection", text: "hola" }, { frameId: 0 }], "верхний фрейм — frameId 0");
    await env.click({ menuItemId: "other", selectionText: "x", frameId: 0 }, { id: 7 });
    await env.click({ menuItemId: MENU_ID, selectionText: "x", frameId: 0 }, { id: -1 });
    await env.click({ menuItemId: MENU_ID, selectionText: "x", frameId: 0 }, undefined);
    assert.strictEqual(env.sent.length, 2, "чужой пункт и пункт без вкладки ничего не шлют");
    assert.deepStrictEqual(env.popups, [], "скрипт ответил — окно не открывается");
    assert.deepStrictEqual(env.badge.tabs, {}, "и значок вкладки не трогается");
    ok("выбор пункта: tabs.sendMessage(вкладка, { type: translateSelection, text }, { frameId }) — тому фрейму, где выделено");
  }

  // ---- скрипта во вкладке нет ----
  {
    const env = makeEnv({}, { noReceiver: true });
    await env.install("install");
    await env.click({ menuItemId: MENU_ID, selectionText: "hola", frameId: 0 }, { id: 7, windowId: 2 });
    assert.strictEqual(env.sent.length, 1);
    assert.deepStrictEqual(env.popups, [{ windowId: 2 }], "открыто окно расширения в окне этой вкладки");
    assert.deepStrictEqual(env.badge.tabs, {}, "окно открылось — значок не нужен");
    ok("получателя нет (вкладка открыта до установки или обновления) — окно расширения (action.openPopup)");

    for (const how of ["none", "throw", "reject"]) {
      const e2 = makeEnv({}, { noReceiver: true, openPopup: how });
      await e2.install("install");
      const before = plain(e2.badge.all);
      await e2.click({ menuItemId: MENU_ID, selectionText: "hola", frameId: 2 }, { id: 9, windowId: 4 });
      assert.deepStrictEqual(e2.badge.tabs[9], { color: "#d93025", text: "!", title: "Hover Translator — Обновить вкладку" }, how);
      assert.deepStrictEqual(Object.keys(e2.badge.tabs), ["9"], "только у этой вкладки");
      assert.deepStrictEqual(plain(e2.badge.all), before, "общий значок прежний");
    }
    ok("нет openPopup (Chrome до 127), он бросил или отказал — «!» у этой вкладки с подсказкой «Обновить вкладку»");
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
