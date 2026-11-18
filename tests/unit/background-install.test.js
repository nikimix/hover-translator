// Установка и значок: значок, установка, одно уведомление за сессию, общие функции shared.js.
// background.js в node через vm с заглушкой chrome.* (как в background.test.js, плюс action/onInstalled).
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { EXT } = require("../lib/env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(initialLocal = {}, opts = {}) {
  // этап 3: согласие на отправку текста уже дано (проверки без него — в unit/background-consent.test.js)
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
  let listener = null;
  const installed = [];
  const startup = [];
  const badge = { text: null, color: null, title: null, calls: 0 };
  const tabsCreated = [];
  const ctx = {
    console, URL, TextEncoder, AbortController, DOMException, AbortSignal, JSON, Promise, Map, Set, Date, Math, Object, Array, String, Number, RegExp, Error, Intl,
    setTimeout, clearTimeout,
    chrome: {
      storage: { local: area(local, true), session: area(session, false), onChanged: { addListener: (fn) => changedFns.push(fn) } },
      alarms: { get: (n, cb) => cb(null), create() {}, onAlarm: { addListener() {} } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        onInstalled: { addListener: (fn) => installed.push(fn) },
        onStartup: { addListener: (fn) => startup.push(fn) },
        getURL: (p) => "chrome-extension://abc/" + p,
        getManifest: () => ({ name: "Cursor Translate" }),
      },
      action: {
        setBadgeText: ({ text }) => { badge.text = text; badge.calls++; return Promise.resolve(); },
        setBadgeBackgroundColor: ({ color }) => { badge.color = color; return Promise.resolve(); },
        setTitle: ({ title }) => { badge.title = title; return Promise.resolve(); },
      },
      i18n: Object.assign(require("../lib/i18n-stub").makeI18n("ru"), { getUILanguage: () => opts.ui || "ru" }), // этап 4а: тексты из _locales/ru
      tabs: { create: (o) => { tabsCreated.push(o.url); return Promise.resolve({}); } },
    },
    fetch: () => Promise.reject(new Error("no network in test")),
  };
  ctx.self = ctx;
  if (opts.swTranslator) ctx.Translator = function () {};
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const send = (msg, sender) => new Promise((resolve) => {
    const keep = listener(msg, sender || {}, resolve);
    if (keep !== true) resolve(undefined);
  });
  const install = async (reason) => { for (const fn of installed) await fn({ reason }); await sleep(20); };
  return { ctx, local, session, send, badge, tabsCreated, install, startup };
}

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

(async () => {
  // ---- shared.js ----
  {
    const { ctx } = makeEnv();
    assert.strictEqual(ctx.HT_DEFAULTS.engine, "chrome");
    // этап 3: согласие на отправку текста дано (без него — unit/background-consent.test.js)
    const ALL = { deepl: true, openai: true, anthropic: true };
    const P = (engine, keys, builtin) => ctx.HT_engineProblem(engine, Object.assign({ consent: ALL }, keys), builtin);
    assert.strictEqual(P("chrome", {}, true), null);
    assert.strictEqual(P("chrome", {}, false), "no-builtin");
    assert.strictEqual(P("deepl", {}, true), "no-deepl-key");
    assert.strictEqual(P("deepl", { apiKey: true }, false), null);
    assert.strictEqual(P("auto", {}, true), null, "авто без ключа — встроенный");
    assert.strictEqual(P("auto", {}, false), "no-deepl-key");
    assert.strictEqual(P("auto", { apiKey: true }, false), null);
    assert.strictEqual(P("llm", {}, true), "no-llm-key");
    assert.strictEqual(P("llm", { llmApiKey: true }, false), null);
    assert.strictEqual(P("bogus", {}, true), null, "неизвестный → встроенный");
    ok("HT_engineProblem: ключ/встроенный/авто/ИИ");
    const T = (l) => ctx.HT_targetFromLocale(l);
    assert.strictEqual(T("ru"), "RU");
    assert.strictEqual(T("en-US"), "EN-US");
    assert.strictEqual(T("en-GB"), "EN-GB");
    assert.strictEqual(T("en-AU"), "EN-GB");   // этап 4а: британское написание
    assert.strictEqual(T("pt-BR"), "PT-BR");
    assert.strictEqual(T("pt"), "PT-PT");
    assert.strictEqual(T("zh-TW"), "ZH-HANT"); // этап 4а: традиционный китайский есть в списке
    assert.strictEqual(T("uk"), "UK");
    assert.strictEqual(T("de_AT"), "DE");
    assert.strictEqual(T("kk"), "KK");          // этап 4а: казахский есть в списке
    assert.strictEqual(T("xx"), "EN-US");
    assert.strictEqual(T(""), "EN-US");
    ok("HT_targetFromLocale: точный код, по базе, иначе английский");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.HT_prepPair("RU"))), { src: "en", tgt: "ru" });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.HT_prepPair("EN-GB"))), { src: "ru", tgt: "en" });
    assert.strictEqual(ctx.HT_langLabel("en"), "английский");
    assert.strictEqual(ctx.HT_langLabel("de"), "немецкий");
    ok("HT_prepPair и HT_langLabel");
  }

  // ---- значок ----
  {
    const env = makeEnv({});        // первый запуск: ничего не сохранено, встроенный по умолчанию
    await sleep(30);
    assert.strictEqual(env.badge.text, "", "встроенный, ключей нет — значок чистый");
    assert.strictEqual(env.badge.title, "Переводчик при наведении");
    await env.ctx.chrome.storage.local.set({ engine: "deepl" });
    await sleep(30);
    assert.strictEqual(env.badge.text, "!");
    assert.strictEqual(env.badge.color, "#d93025");
    assert.strictEqual(env.badge.title, "Переводчик при наведении — не задан ключ DeepL");
    await env.ctx.chrome.storage.local.set({ apiKey: "k:fx" });
    await sleep(30);
    assert.strictEqual(env.badge.text, "");
    await env.ctx.chrome.storage.local.set({ enabled: false });
    await sleep(30);
    assert.strictEqual(env.badge.text, "off");
    assert.strictEqual(env.badge.color, "#6b7280");
    assert.strictEqual(env.badge.title, "Переводчик при наведении — перевод выключен");
    await env.ctx.chrome.storage.local.set({ enabled: true, engine: "chrome", htBuiltinApi: false });
    await sleep(30);
    assert.strictEqual(env.badge.text, "!");
    assert.strictEqual(env.badge.title, "Переводчик при наведении — встроенный переводчик недоступен в этом браузере");
    await env.ctx.chrome.storage.local.set({ engine: "llm" });
    await sleep(30);
    assert.ok(env.badge.text === "!" && /ключ ИИ/.test(env.badge.title), env.badge.title);
    const n = env.badge.calls;
    await env.ctx.chrome.storage.local.set({ "htlc:x": { v: "a", t: 1 }, statChars: 5 });
    await sleep(30);
    assert.strictEqual(env.badge.calls, n, "запись кэша/статистики значок не пересчитывает");
    ok("значок: чисто / «!» без ключа DeepL, ИИ, без встроенного / «off» при выключении; подсказка значка");
    // В service worker есть Translator — «нет встроенного» из хранилища не верим
    const env2 = makeEnv({ engine: "chrome", htBuiltinApi: false }, { swTranslator: true });
    await sleep(30);
    assert.strictEqual(env2.badge.text, "");
    ok("если в service worker встроенный есть — значок чистый, даже если окно когда-то записало «нет»");
  }

  // ---- установка ----
  {
    const env = makeEnv({}, { ui: "en-GB" });
    await env.install("install");
    assert.strictEqual(env.local.targetLang, "EN-GB");
    assert.deepStrictEqual(env.tabsCreated, ["chrome-extension://abc/welcome.html"]);
    const env2 = makeEnv({ targetLang: "DE", engine: "deepl", apiKey: "k" }, { ui: "ru" });
    await env2.install("update");
    assert.strictEqual(env2.local.targetLang, "DE");
    assert.strictEqual(env2.local.engine, "deepl", "сохранённый выбор движка не трогаем");
    assert.deepStrictEqual(env2.tabsCreated, [], "при обновлении страницу не открываем");
    const env3 = makeEnv({}, { ui: "ru" });
    await env3.install("install");
    assert.strictEqual(env3.local.targetLang, "RU");
    assert.ok(!("engine" in env3.local), "движок при установке не записывается — берётся HT_DEFAULTS (встроенный)");
    const env4 = makeEnv({}, { ui: "xx" });   // этап 4а: персидский теперь в списке — берём язык, которого нет
    await env4.install("install");
    assert.strictEqual(env4.local.targetLang, "EN-US");
    ok("установка: язык по языку браузера (иначе английский) + страница приветствия; обновление — ничего");
  }

  // ---- одно уведомление за сессию ----
  {
    const env = makeEnv({ engine: "deepl" });
    await sleep(30);
    const a = await env.send({ type: "noticeOnce", problem: "no-deepl-key" });
    const b = await env.send({ type: "noticeOnce", problem: "no-deepl-key" });
    const c = await env.send({ type: "noticeOnce", problem: "constructor" });
    assert.deepStrictEqual([a.show, b.show, c.show], [true, false, false]);
    assert.strictEqual(env.session["htNoticed:no-deepl-key"], true);
    // перезапуск воркера в той же сессии браузера: storage.session жив
    const env2 = makeEnv({ engine: "deepl" });
    Object.assign(env2.session, env.session);
    assert.strictEqual((await env2.send({ type: "noticeOnce", problem: "no-deepl-key" })).show, false);
    // проблему решили — следующая снова заслуживает уведомления
    await env2.ctx.chrome.storage.local.set({ apiKey: "k" });
    await sleep(30);
    assert.ok(!("htNoticed:no-deepl-key" in env2.session));
    ok("noticeOnce: одно уведомление за сессию браузера (переживает перезапуск воркера), сброс после исправления");
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
