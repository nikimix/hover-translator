// Ошибки и горячие клавиши: background.js в node через vm (как background-install.test.js), плюс commands,
// tabs.sendMessage, action.openPopup и значок для вкладки. Проверяет: понятные ошибки с кодами, способ включения при
// установке/обновлении, горячие клавиши, «Открыть настройки», Esc во всех фреймах, значок «off» для
// выключенного сайта, нижнюю границу токенов ИИ.
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
  const commandFns = [];
  const badge = { text: null, color: null, title: null, tab: {} };
  const tabsCreated = [];
  const tabMsgs = [];
  const popups = [];
  const tabSlot = (id) => (badge.tab[id] = badge.tab[id] || {});
  const fetches = [];
  let fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  const ctx = {
    console, URL, TextEncoder, AbortController, DOMException, AbortSignal: { timeout: (ms) => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), (ms || 0) / 1000); return c.signal; } }, JSON, Promise, Map, Set, Date, Math, Object, Array, String, Number, RegExp, Error, Intl,
    setTimeout: (fn, ms) => setTimeout(fn, (ms || 0) / 1000), clearTimeout,
    chrome: {
      storage: { local: area(local, true), session: area(session, false), onChanged: { addListener: (fn) => changedFns.push(fn) } },
      alarms: { get: (n, cb) => cb(null), create() {}, onAlarm: { addListener() {} } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        onInstalled: { addListener: (fn) => installed.push(fn) },
        onStartup: { addListener() {} },
        getURL: (p) => "chrome-extension://abc/" + p,
        getManifest: () => ({ name: "Cursor Translate" }),
      },
      action: {
        setBadgeText: ({ text, tabId }) => { if (tabId != null) tabSlot(tabId).text = text; else badge.text = text; return Promise.resolve(); },
        setBadgeBackgroundColor: ({ color, tabId }) => { if (tabId != null) tabSlot(tabId).color = color; else badge.color = color; return Promise.resolve(); },
        setTitle: ({ title, tabId }) => { if (tabId != null) tabSlot(tabId).title = title; else badge.title = title; return Promise.resolve(); },
        openPopup: (o) => { popups.push(o); return opts.popupFails ? Promise.reject(new Error("Could not find an active browser window.")) : Promise.resolve(); },
      },
      commands: {
        onCommand: { addListener: (fn) => commandFns.push(fn) },
        getAll: () => Promise.resolve([
          { name: "toggle-enabled", shortcut: opts.noKeys ? "" : "Alt+Shift+O", description: "" },
          { name: "translate-page", shortcut: opts.noKeys ? "" : "Alt+Shift+G", description: "" },
        ]),
      },
      i18n: Object.assign(require("../lib/i18n-stub").makeI18n("ru"), { getUILanguage: () => opts.ui || "ru" }), // этап 4а: тексты из _locales/ru
      tabs: {
        create: (o) => { tabsCreated.push(o.url); return Promise.resolve({}); },
        sendMessage: (tabId, msg, o) => { tabMsgs.push({ tabId, msg, o }); return opts.noContent ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")) : Promise.resolve(true); },
      },
    },
    fetch: (url, o) => { fetches.push({ url, body: o && o.body ? JSON.parse(o.body) : null }); return fetchImpl(url, o); },
  };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const send = (msg, sender) => new Promise((resolve) => {
    const keep = listener(msg, sender || {}, resolve);
    if (keep !== true) resolve(undefined);
  });
  const install = async (reason) => { for (const fn of installed) await fn({ reason }); await sleep(20); };
  const command = async (name, tab) => { for (const fn of commandFns) await fn(name, tab); await sleep(20); };
  return { ctx, local, session, send, badge, tabsCreated, tabMsgs, popups, install, command, fetches, setFetch: (f) => { fetchImpl = f; } };
}

function jsonRes(status, obj, headers) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: (h) => (headers || {})[h] || null }, json: () => Promise.resolve(obj) });
}
const sender = (tab, frameId = 0) => ({ tab: { id: tab, windowId: 7 }, frameId, origin: "https://a.example", url: "https://a.example/x" });
// Слова, которых в текстах для человека быть не должно (жаргон и англицизмы).
const JARGON = /popup|\bAPI\b|LLM|кэш|движ[оеа]к|поповер|фолбэк/i;
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

(async () => {
  // ---- ошибки DeepL: простые слова, код ответа — в detail ----
  {
    const env = makeEnv({ apiKey: "k:fx" });
    const msg = (t) => ({ type: "translateBatch", engine: "deepl", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    const cases = [
      [403, "bad-key", /^DeepL не принял ключ — проверьте его в окне расширения\.$/],
      [401, "bad-key", /не принял ключ/],
      [456, "quota", /^Лимит DeepL на этот месяц закончился\.$/],
      [429, "rate", /^Слишком много запросов к DeepL/],
      [413, "too-big", /слишком большой кусок/i],
      [503, "server", /^DeepL сейчас недоступен/],
      [400, "other", /^DeepL не смог перевести текст\.$/],
    ];
    let i = 0;
    for (const [status, code, re] of cases) {
      env.setFetch(() => jsonRes(status, {}, { "Retry-After": "0" }));
      const r = await env.send(msg("t" + i++), sender(1));
      assert.ok(!r.ok && r.code === code && re.test(r.error) && r.detail === "код ответа " + status, status + " " + JSON.stringify(r));
      assert.ok(!JARGON.test(r.error) && !/^\d/.test(r.error), r.error);
    }
    env.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const rn = await env.send(msg("net"), sender(1));
    assert.ok(rn.code === "network" && rn.error === "Нет связи с DeepL — проверьте интернет.", JSON.stringify(rn));
    env.setFetch(() => jsonRes(200, { nope: 1 }));
    const rb = await env.send(msg("bad"), sender(1));
    assert.ok(rb.code === "bad-response" && !JARGON.test(rb.error), JSON.stringify(rb));
    // проверка ключа в окне расширения — те же коды
    env.setFetch(() => jsonRes(403, {}));
    const ru = await env.send({ type: "checkUsage" });
    assert.ok(!ru.ok && ru.code === "bad-key", JSON.stringify(ru));
    ok("DeepL: 401/403 ключ, 456 лимит на месяц, 429, 413, 5xx, прочее, сеть, непонятный ответ — простыми словами, код ответа мелко (detail)");
  }

  // ---- ошибки ИИ ----
  {
    const env = makeEnv({ llmApiKey: "sk-x", llmProvider: "openai", llmModel: "gpt-4o-mini" });
    const msg = (t) => ({ type: "translateBatch", engine: "llm", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    const cases = [
      [() => jsonRes(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }), "money", /^На счёте OpenAI закончились деньги/],
      [() => jsonRes(429, { error: { message: "Rate limit reached", type: "requests" } }, { "Retry-After": "0" }), "rate", /^Слишком много запросов к OpenAI/],
      [() => jsonRes(403, { error: { message: "Country, region, or territory not supported", code: "unsupported_country_region_territory" } }), "denied", /^OpenAI отказал в доступе/],
      [() => jsonRes(404, { error: { message: "The model `gpt-9` does not exist", code: "model_not_found" } }), "model", /^OpenAI не знает модель «gpt-4o-mini»/],
      [() => jsonRes(500, { error: { message: "oops" } }, { "Retry-After": "0" }), "server", /^OpenAI сейчас недоступен или перегружен/],
      [() => Promise.reject(new TypeError("Failed to fetch")), "network", /^Нет связи с OpenAI/],
    ];
    let i = 0;
    for (const [f, code, re] of cases) {
      env.setFetch(f);
      const r = await env.send(msg("x" + i++), sender(1));
      assert.ok(!r.ok && r.code === code && re.test(r.error) && !JARGON.test(r.error), code + " " + JSON.stringify(r));
    }
    const env2 = makeEnv({ llmApiKey: "sk-x", llmProvider: "anthropic", llmModel: "" });
    env2.setFetch(() => jsonRes(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }));
    const r2 = await env2.send(msg("y"), sender(1));
    assert.ok(r2.code === "money" && /^На счёте Anthropic закончились деньги/.test(r2.error) && /credit balance/.test(r2.detail), JSON.stringify(r2));
    env2.setFetch(() => jsonRes(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { "Retry-After": "0" }));
    const r3 = await env2.send(msg("z"), sender(1));
    assert.ok(r3.code === "server" && /Anthropic сейчас недоступен или перегружен/.test(r3.error), JSON.stringify(r3));
    // без ключа — подсказка без «popup»
    const env3 = makeEnv({});
    const r4 = await env3.send(msg("k"), sender(1));
    assert.ok(r4.code === "no-key" && r4.error === "Не задан ключ ИИ — нажмите на значок расширения и вставьте ключ.", JSON.stringify(r4));
    assert.ok(!JARGON.test(env3.ctx.HT_t(env3.ctx.HT_KEY_HINTS.apiKey)) && !JARGON.test(env3.ctx.HT_t(env3.ctx.HT_KEY_HINTS.llmApiKey)));
    ok("ИИ: нет денег на счёте (OpenAI 429 insufficient_quota, Anthropic 400 credit balance), 429, 403, 404 модель, 5xx/529, сеть, нет ключа — простыми словами");
  }

  // ---- нижняя граница потолка ответа ИИ ----
  {
    const env = makeEnv({ llmApiKey: "sk-x", llmProvider: "openai", llmModel: "gpt-4o-mini" });
    env.setFetch((url, o) => {
      const b = JSON.parse(o.body);
      const n = JSON.parse(b.messages[1].content).length;
      return jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations: Array(n).fill("x") }) } }] });
    });
    const msg = (t) => ({ type: "translateBatch", engine: "llm", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    await env.send(msg("Settings"), sender(1));
    await env.send(msg("x".repeat(1500)), sender(1));
    env.local.llmModel = "gpt-5-mini";
    await env.send(msg("Menu"), sender(1));
    const caps = env.fetches.map((f) => f.body.max_completion_tokens);
    assert.deepStrictEqual(caps, [512, 1504, 512 + 4096]);
    ok("ИИ: потолок ответа на коротком тексте 512 токенов (было 2048), на длинном растёт с текстом; запас на рассуждение у OpenAI — сверху");
  }

  // ---- способ включения: установка и обновление ----
  {
    const env = makeEnv({});
    await env.install("install");
    assert.strictEqual(env.local.trigger, "shift", "новая установка — Shift, записан сразу");
    await env.install("update");
    assert.strictEqual(env.local.trigger, "shift", "следующее обновление — не трогаем");
    const old = makeEnv({ targetLang: "DE" });        // прежний пользователь, способ не выбирал
    await old.install("update");
    assert.strictEqual(old.local.trigger, "dwell", "прежний пользователь без выбора остаётся на наведении");
    const chose = makeEnv({ trigger: "alt" });
    await chose.install("update");
    assert.strictEqual(chose.local.trigger, "alt", "сохранённый выбор не трогаем");
    const chose2 = makeEnv({ trigger: "dwell", dwellMs: 250 });
    await chose2.install("update");
    assert.deepStrictEqual([chose2.local.trigger, chose2.local.dwellMs], ["dwell", 250]);
    assert.strictEqual(env.ctx.HT_DEFAULTS.trigger, "shift");
    assert.strictEqual(env.ctx.HT_DEFAULTS.dwellMs, 600);
    ok("способ по умолчанию — Shift (записывается при установке); при обновлении прежним пользователям без выбора — наведение; сохранённое не трогаем");
  }

  // ---- горячие клавиши ----
  {
    const env = makeEnv({});
    await env.command("toggle-enabled", { id: 5 });
    assert.strictEqual(env.local.enabled, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(env.tabMsgs.pop())), { tabId: 5, msg: { type: "say", what: "disabled", keys: "Alt+Shift+O" }, o: { frameId: 0 } });
    await sleep(20);
    assert.strictEqual(env.badge.text, "off", "значок — «off»");
    await env.command("toggle-enabled", { id: 5 });
    assert.strictEqual(env.local.enabled, true);
    assert.strictEqual(env.tabMsgs.pop().msg.what, "enabled");
    await env.command("translate-page", { id: 6 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(env.tabMsgs.pop())), { tabId: 6, msg: { type: "translatePage", via: "command", keys: "Alt+Shift+O" }, o: { frameId: 0 } });
    await env.command("toggle-enabled", undefined);   // без вкладки (фокус в devtools и т. п.)
    assert.strictEqual(env.local.enabled, false);
    const env2 = makeEnv({}, { noContent: true });     // служебная страница: content-скрипта нет — не падаем
    await env2.command("translate-page", { id: 9 });
    await env2.command("toggle-enabled", { id: 9 });
    assert.strictEqual(env2.local.enabled, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
    const cmds = manifest.commands;
    assert.deepStrictEqual(Object.keys(cmds), ["toggle-enabled", "translate-page"]);
    for (const c of Object.values(cmds)) {
      for (const [plat, k] of Object.entries(c.suggested_key)) {
        const parts = k.split("+");
        assert.ok(/^[A-Z0-9]$/.test(parts[parts.length - 1]), k);
        assert.ok(plat === "mac" ? parts.includes("MacCtrl") : (parts.includes("Ctrl") || parts.includes("Alt")), "нужен Ctrl или Alt: " + k);
        assert.ok(!(parts.includes("Ctrl") && parts.includes("Alt")), "Ctrl+Alt запрещён: " + k);
        assert.ok(plat === "mac" || !parts.includes("MacCtrl"), "MacCtrl только для mac: " + k);
        // занятые самим Chrome 157 (Linux): такие он расширению не назначает
        if (plat === "default") assert.ok(!/^Alt\+Shift\+[ABCINPRTWXZ]$/.test(k), "занято Chrome: " + k);
      }
    }
    assert.deepStrictEqual(manifest.permissions, ["storage", "alarms"], "новых разрешений нет");
    ok("горячие клавиши: вкл/выкл пишет enabled и говорит на странице (верхний фрейм), «перевести страницу» — верхнему фрейму; manifest по правилам chrome.commands, разрешения те же");
  }

  // ---- «Открыть настройки», Esc во всех фреймах, значок выключенного сайта, noticeOnce ----
  {
    const env = makeEnv({});
    const r = await env.send({ type: "openSettings" }, sender(3));
    assert.ok(r.ok && r.how === "popup" && env.popups[0].windowId === 7, JSON.stringify(r));
    const env2 = makeEnv({}, { popupFails: true });
    const r2 = await env2.send({ type: "openSettings" }, sender(3));
    assert.ok(r2.how === "tab" && env2.tabsCreated[0] === "chrome-extension://abc/popup.html", JSON.stringify(r2));
    ok("«Открыть настройки»: окно расширения над значком (action.openPopup), не вышло — те же настройки во вкладке");

    await env.send({ type: "restoreTab" }, sender(4, 3));
    const m = env.tabMsgs.pop();
    assert.ok(m.tabId === 4 && m.msg.type === "restoreAll" && !("frameId" in m.o), JSON.stringify(m));
    ok("Esc: background рассылает restoreAll во все фреймы вкладки");

    await env.send({ type: "siteBadge", off: true }, sender(8, 2));      // не верхний фрейм — не слушаем
    await sleep(10);
    assert.ok(!env.badge.tab[8], "значок вкладки меняет только верхний фрейм");
    await env.send({ type: "siteBadge", off: true }, sender(8, 0));
    await sleep(10);
    assert.deepStrictEqual(env.badge.tab[8], { color: "#6b7280", text: "off", title: "Переводчик при наведении — на этом сайте перевод выключен" });
    await env.send({ type: "siteBadge", off: false }, sender(8, 0));
    await sleep(10);
    assert.ok(env.badge.tab[8].text === null && env.badge.tab[8].title === "Переводчик при наведении", JSON.stringify(env.badge.tab[8]));
    ok("сайт выключен — «off» на значке только этой вкладки; включили — у вкладки снова общий значок");

    const a = await env.send({ type: "noticeOnce", problem: "deepl-quota" });
    const b = await env.send({ type: "noticeOnce", problem: "deepl-quota" });
    const c = await env.send({ type: "noticeOnce", problem: "__proto__" });
    assert.deepStrictEqual([a.show, b.show, c.show], [true, false, false]);
    ok("«Лимит DeepL закончился — перевожу встроенным» — один раз за сессию браузера");
  }

  // ---- тексты ошибок и подсказок без жаргона ----
  {
    // этап 4а: тексты для человека — в _locales/ru/messages.json (в коде кириллицы больше нет)
    const RU = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "ru", "messages.json"), "utf8"));
    const strings = Object.values(RU).map((m) => JSON.stringify(m.message)).map((x) => x.replace(/ключ API DeepL|«API Keys»|deepl\.com\/pro-api/g, ""));
    // Подписи переводчиков в списке окна (HT_ENGINES) переименовывает этап 3 (таблица подписей в
    // REVIEW.md) — здесь их не проверяем. Имена констант внутри ${…} — не текст.
    const STAGE3 = ['"DeepL → встроенный (фолбэк)"', '"LLM (OpenAI / Anthropic) — контекстный"'];
    const bad = strings.filter((x) => !STAGE3.includes(x) && JARGON.test(x.replace(/\$\{[^}]*\}/g, "")));
    assert.deepStrictEqual(bad, [], "жаргон в текстах: " + bad.join(" | "));
    ok(`тексты для человека (${strings.length} строк в background/shared/content) — без «popup», «API», «LLM», «кэш», «движок», «поповер»`);
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
