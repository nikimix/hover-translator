// Языки: background.js и shared.js в node через vm (обвязка — как в background-consent.test.js) на русском
// и английском.
// Проверяет: отказ модели переводить (Anthropic stop_reason "refusal", OpenAI refusal) — понятное сообщение;
// язык, которого DeepL не знает, — причина «lang» без запроса; коды языков DeepL в запросе; значок и его
// подсказка при языке, которого не знает встроенный (короткое название); тексты ошибок на английском,
// число в тексте — по языку интерфейса; AbortSignal.timeout вместо своего таймера.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { EXT } = require("../lib/env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(initialLocal = {}, lang = "ru") {
  const local = Object.assign({}, initialLocal);
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
  const badge = { text: null, title: null };
  const fetches = [];
  let fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  const ctx = {
    console, URL, TextEncoder, AbortController, DOMException, AbortSignal: { timeout: (ms) => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), (ms || 0) / 1000); return c.signal; } }, JSON, Promise, Map, Set, Date, Math, Object, Array, String, Number, RegExp, Error, Intl,
    setTimeout: (fn, ms) => setTimeout(fn, (ms || 0) / 1000), clearTimeout,
    navigator: { platform: "Linux x86_64" },
    chrome: {
      i18n: require("../lib/i18n-stub").makeI18n(lang),
      storage: { local: area(local, true), session: area(session, false), onChanged: { addListener: (fn) => changedFns.push(fn) } },
      alarms: { get: (n, cb) => cb(null), create() {}, onAlarm: { addListener() {} } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        onInstalled: { addListener() {} }, onStartup: { addListener() {} },
        getURL: (p) => "chrome-extension://abc/" + p,
        getManifest: () => ({ name: "Cursor Translate" }),
      },
      action: {
        setBadgeText: ({ text, tabId }) => { if (tabId == null) badge.text = text; return Promise.resolve(); },
        setBadgeBackgroundColor: () => Promise.resolve(),
        setTitle: ({ title, tabId }) => { if (tabId == null) badge.title = title; return Promise.resolve(); },
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
  return { ctx, local, send, badge, fetches, setFetch: (f) => { fetchImpl = f; } };
}

function jsonRes(status, obj) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: () => Promise.resolve(obj) });
}
const deeplOk = (url, o) => {
  if (url.includes("/v2/usage")) return jsonRes(200, { character_count: 10, character_limit: 500000 });
  const b = JSON.parse(o.body);
  return jsonRes(200, { translations: b.text.map((t) => ({ text: "T:" + t, detected_source_language: "EN" })) });
};
const llmOk = (url, o) => {
  const b = JSON.parse(o.body);
  const n = JSON.parse(b.messages[b.messages.length - 1].content).length;
  const json = JSON.stringify({ translations: Array(n).fill("Привет") });
  // Anthropic с рассуждением: первым — блок thinking (пустой при display: omitted), текст — вторым
  if (url.includes("anthropic")) return jsonRes(200, { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: json }] });
  return jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: json } }] });
};
const sender = (tab) => ({ tab: { id: tab, windowId: 7 }, frameId: 0, origin: "https://a.example", url: "https://a.example/x" });
const msg = (text, o = {}) => Object.assign({ type: "translateBatch", items: [text], engine: "llm", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated" }, o);
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

(async () => {
  // ---- отказ модели ----
  {
    const env = makeEnv({ engine: "llm", llmProvider: "anthropic", llmApiKey: "sk-ant-x", consent: { anthropic: true } });
    env.setFetch(() => jsonRes(200, { stop_reason: "refusal", content: [{ type: "text", text: "{\"translations\": [\"x\"]}" }] }));
    const r = await env.send(msg("Some text"), sender(1));
    assert.ok(!r.ok && r.code === "refused" && r.error === "ИИ отказался переводить этот текст.", JSON.stringify(r));
    const env2 = makeEnv({ engine: "llm", llmProvider: "openai", llmApiKey: "sk-x", consent: { openai: true } }, "en");
    env2.setFetch(() => jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can’t help with that." } }] }));
    const r2 = await env2.send(msg("Some text"), sender(1));
    assert.ok(!r2.ok && r2.code === "refused" && r2.error === "The AI declined to translate this text.", JSON.stringify(r2));
    // обычный ответ после этого не ломается
    env2.setFetch(llmOk);
    const r3 = await env2.send(msg("Other text"), sender(1));
    assert.ok(r3.ok && r3.texts[0] === "Привет", JSON.stringify(r3));
    ok("отказ модели: Anthropic stop_reason «refusal» и OpenAI refusal — «ИИ отказался переводить этот текст» (en: «The AI declined…»), без «неожиданного формата»");
  }

  // ---- языки и DeepL ----
  {
    const env = makeEnv({ engine: "deepl", apiKey: "k:fx", consent: { deepl: true } });
    env.setFetch(deeplOk);
    const r = await env.send(msg("Hello world", { engine: "deepl", targetLang: "KN" }), sender(1));
    assert.ok(!r.ok && r.code === "lang" && /DeepL не переводит на этот язык \(каннада\)/.test(r.error), JSON.stringify(r));
    const r2 = await env.send(msg("Hello world", { engine: "deepl", targetLang: "RU", sourceLang: "KN" }), sender(1));
    assert.ok(!r2.ok && r2.code === "lang" && /с этого языка \(каннада\)/.test(r2.error), JSON.stringify(r2));
    assert.strictEqual(env.fetches.length, 0, "к DeepL ничего не ушло");
    const r3 = await env.send(msg("Hello world", { engine: "deepl", targetLang: "ZH-HANT", sourceLang: "NB" }), sender(1));
    assert.ok(r3.ok, JSON.stringify(r3));
    assert.deepStrictEqual([env.fetches[0].body.target_lang, env.fetches[0].body.source_lang], ["ZH-HANT", "NB"]);
    await env.send(msg("Bonjour", { engine: "deepl", targetLang: "TT", sourceLang: "auto" }), sender(1));
    assert.strictEqual(env.fetches[1].body.target_lang, "TT", "татарский — у DeepL есть");
    // ИИ переводит на любой язык из списка — в инструкцию уходит английское имя
    const env2 = makeEnv({ engine: "llm", llmProvider: "openai", llmApiKey: "sk", consent: { openai: true } });
    env2.setFetch(llmOk);
    const r4 = await env2.send(msg("Hello", { targetLang: "KN" }), sender(1));
    assert.ok(r4.ok && /into Kannada\./.test(env2.fetches[0].body.messages[0].content), JSON.stringify(r4));
    ok("языки: DeepL на каннада / с каннада — причина «lang» с понятным текстом и без запроса; коды DeepL в запросе (ZH-HANT, NB, TT); ИИ — «into Kannada»");
  }

  // ---- значок: язык, которого не знает встроенный ----
  {
    const env = makeEnv({ engine: "chrome", targetLang: "TT", htBuiltinApi: true });
    await sleep(30);
    assert.strictEqual(env.badge.text, "!");
    assert.strictEqual(env.badge.title, "Переводчик при наведении — встроенный переводчик не переводит на этот язык: татарский");
    await env.ctx.chrome.storage.local.set({ targetLang: "RU" });
    await sleep(30);
    assert.ok(env.badge.text === "" && env.badge.title === "Переводчик при наведении", JSON.stringify(env.badge));
    await env.ctx.chrome.storage.local.set({ engine: "auto", targetLang: "KN" });   // у DeepL нет — «авто» переводит встроенным
    await sleep(30);
    assert.strictEqual(env.badge.text, "", "«авто» с каннада — встроенный, значок чистый");
    const en = makeEnv({ engine: "chrome", targetLang: "ET", htBuiltinApi: true }, "en");
    await sleep(30);
    assert.strictEqual(en.badge.title, "Hover Translator — the built-in translator can’t translate into Estonian");
    ok("значок: «!» и «…не переводит на этот язык: татарский» (en: «…can’t translate into Estonian»), подсказка — с коротким названием; «авто» с языком, которого нет у DeepL, — без «!»");
  }

  // ---- тексты ошибок на английском, числа по языку интерфейса ----
  {
    const env = makeEnv({ engine: "deepl", apiKey: "k:fx", consent: { deepl: true } }, "en");
    env.setFetch((url, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(o.signal.reason))));
    const r = await env.send(msg("Hello there", { engine: "deepl" }), sender(1));
    assert.ok(!r.ok && r.code === "timeout" && r.error === "DeepL didn’t respond within 15 seconds — try again.", JSON.stringify(r));
    env.setFetch(() => jsonRes(403, {}));
    const r2 = await env.send(msg("Hello again", { engine: "deepl" }), sender(1));
    assert.ok(r2.error === "DeepL didn’t accept the key — check it in the extension window." && r2.detail === "response code 403", JSON.stringify(r2));
    // суточный лимит: число по языку интерфейса
    const day = env.ctx.HT_plural("limitDay", 100000);
    assert.ok(/\(100,000 characters\)/.test(day), day);
    const ru = makeEnv({}).ctx.HT_plural("limitDay", 100000);
    assert.ok(/\(100\s000 знаков\)/.test(ru), ru);
    const env3 = makeEnv({ engine: "llm", llmProvider: "anthropic", llmApiKey: "sk-ant-x", consent: { anthropic: true } }, "en");
    env3.setFetch(() => jsonRes(404, { error: { type: "not_found_error", message: "model: x" } }));
    const r3 = await env3.send(msg("Hi there"), sender(1));
    assert.ok(r3.code === "model" && /^Anthropic doesn’t know the model “claude-haiku-5-5”/.test(r3.error) && r3.detail === "response code 404: model: x", JSON.stringify(r3));
    assert.ok(!/AbortController/.test(fs.readFileSync(path.join(EXT, "background.js"), "utf8").replace(/\/\/.*$/gm, "")), "свой таймер обрыва убран");
    ok("английский: тайм-аут «within 15 seconds», ключ не принят + «response code 403», неизвестная модель; лимит за сутки — «100,000 characters» / «100 000 знаков»");
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
