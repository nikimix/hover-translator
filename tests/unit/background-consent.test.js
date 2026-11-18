// Согласие на отправку текста: background.js и shared.js в node через vm (обвязка — как в
// background-errors.test.js, без согласия по умолчанию). Проверяет: согласие на отправку текста (сверка, по сервису, проблема «no-consent», значок,
// ни одного запроса без согласия, сохранённые переводы отдаются), проверку ключа без согласия (решение
// этапа 3), модели ИИ из списка (добавки к запросу, запас на рассуждение, блок thinking у Anthropic),
// подписи переводчиков и тексты окна, настроек и приветствия без жаргона.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { EXT } = require("../lib/env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(initialLocal = {}) {
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
      i18n: require("../lib/i18n-stub").makeI18n("ru"),   // этап 4а: тексты из _locales/ru
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
const msg = (engine, items, by = "page-initiated") => ({ type: "translateBatch", engine, targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by, items });
const JARGON = /popup|\bAPI\b|LLM|кэш|движ[оеа]к|поповер|фолбэк|on-device|formality|\bсимв\b/i;
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

(async () => {
  // ---- shared.js: согласие и проблемы ----
  {
    const { ctx } = makeEnv();
    const C = ctx.HT_consent;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C(null))), { deepl: false, openai: false, anthropic: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(C({ deepl: true, openai: "true", anthropic: 1, evil: true }))), { deepl: true, openai: false, anthropic: false });
    assert.strictEqual(ctx.HT_agreed({ deepl: true }, "deepl"), true);
    assert.strictEqual(ctx.HT_agreed({ deepl: true }, "anthropic"), false);
    assert.strictEqual(ctx.HT_agreed({}, ""), true, "встроенному согласие не нужно");
    assert.strictEqual(ctx.HT_agreed({ constructor: true }, "constructor"), false);
    assert.deepStrictEqual(["chrome", "deepl", "auto", "llm"].map((e) => ctx.HT_provider(e, "anthropic")), ["", "deepl", "deepl", "anthropic"]);
    assert.strictEqual(ctx.HT_provider("llm", "evil"), "openai", "провайдер сверяется с таблицей");
    const P = (engine, st, builtin = true) => ctx.HT_engineProblem(engine, st, builtin);
    assert.strictEqual(P("deepl", { apiKey: true, consent: {} }), "no-consent");
    assert.strictEqual(P("deepl", { apiKey: false, consent: {} }), "no-consent", "сначала согласие, потом ключ — как шаги на странице настроек");
    assert.strictEqual(P("deepl", { apiKey: false, consent: { deepl: true } }), "no-deepl-key");
    assert.strictEqual(P("llm", { llmApiKey: false, llmProvider: "openai", consent: { openai: true } }), "no-llm-key");
    assert.strictEqual(P("deepl", { apiKey: true, consent: { deepl: true } }, false), null);
    assert.strictEqual(P("auto", { apiKey: true, consent: {} }), null, "«авто» без согласия — встроенный");
    assert.strictEqual(P("auto", { apiKey: true, consent: {} }, false), "no-consent", "…а без встроенного — нужно согласие");
    assert.strictEqual(P("llm", { llmApiKey: true, llmProvider: "anthropic", consent: { openai: true } }), "no-consent");
    assert.strictEqual(P("llm", { llmApiKey: true, llmProvider: "anthropic", consent: { anthropic: true } }), null);
    assert.strictEqual(P("chrome", { consent: {} }), null);
    assert.strictEqual(ctx.HT_canSend("chrome", { consent: { deepl: true } }), false, "встроенный в сеть не ходит");
    assert.ok(ctx.HT_PROBLEMS["no-consent"] && ctx.HT_problemText("no-consent", "page") && !JARGON.test(ctx.HT_problemText("no-consent", "page")));
    ok("HT_consent/HT_agreed/HT_provider/HT_canSend/HT_engineProblem: согласие по сервису, только true; без согласия — «no-consent» (кроме «авто» со встроенным)");
  }

  // ---- background: без согласия — ни одного запроса ----
  {
    const env = makeEnv({ apiKey: "k:fx", llmApiKey: "sk-ant-x", llmProvider: "anthropic", consent: { openai: true } });
    env.setFetch(deeplOk);
    let r = await env.send(msg("deepl", ["Hello world"]), sender(1));
    assert.ok(!r.ok && r.code === "no-consent" && /не разрешили отправлять текст в DeepL/.test(r.error), JSON.stringify(r));
    r = await env.send(msg("auto", ["Hello world"], "user-initiated"), sender(1));
    assert.strictEqual(r.code, "no-consent", "«авто» — тоже (content переведёт встроенным)");
    r = await env.send(msg("llm", ["Hello world"]), sender(1));
    assert.ok(r.code === "no-consent" && /Anthropic/.test(r.error), JSON.stringify(r));
    assert.strictEqual(env.fetches.length, 0, "ни одного сетевого запроса");
    // согласие — перевод идёт и сохраняется
    env.local.consent = { deepl: true };
    r = await env.send(msg("deepl", ["Hello world"]), sender(1));
    assert.ok(r.ok && r.texts[0] === "T:Hello world", JSON.stringify(r));
    assert.strictEqual(env.fetches.length, 1);
    // отозвали: сохранённый перевод отдаём (он уже на компьютере), новый текст — нет
    env.local.consent = { deepl: false };
    r = await env.send(msg("deepl", ["Hello world"]), sender(1));
    assert.ok(r.ok && r.texts[0] === "T:Hello world", "сохранённый перевод");
    r = await env.send(msg("deepl", ["Brand new text"]), sender(1));
    assert.strictEqual(r.code, "no-consent");
    assert.strictEqual(env.fetches.length, 1, "после отзыва — ни одного нового запроса");
    // мусор в хранилище согласием не считается
    env.local.consent = "yes";
    r = await env.send(msg("deepl", ["Another text"]), sender(1));
    assert.strictEqual(r.code, "no-consent");
    assert.strictEqual(env.fetches.length, 1);
    ok("background: без согласия (или с согласием на другой сервис, или с мусором) DeepL/«авто»/ИИ — 0 запросов, код no-consent; с согласием — запрос; отозвали — только сохранённые переводы");
  }

  // ---- проверка ключа — без согласия (решение этапа 3: уходит только ключ, по действию человека) ----
  {
    const env = makeEnv({ apiKey: "k:fx", llmApiKey: "sk-x", llmProvider: "openai", consent: {} });
    env.setFetch((url, o) => (url.includes("deepl") ? deeplOk(url, o) : llmOk(url, o)));
    const u = await env.send({ type: "checkUsage" });
    assert.ok(u.ok && env.fetches[0].url === "https://api-free.deepl.com/v2/usage" && env.fetches[0].body === null, JSON.stringify(env.fetches[0]));
    const l = await env.send({ type: "checkLlm" });
    const lb = env.fetches[1].body;
    assert.ok(l.ok && JSON.parse(lb.messages[1].content)[0] === "Hello", "проверка ИИ переводит слово «Hello», а не текст страниц");
    ok("проверка ключа DeepL и ИИ работает и без согласия: в запросе только ключ (и слово «Hello» для ИИ), текста страниц нет");
  }

  // ---- значок: «!» без согласия, подсказка ----
  {
    const env = makeEnv({ engine: "deepl", apiKey: "k:fx", consent: {} });
    await sleep(30);
    assert.strictEqual(env.badge.text, "!");
    assert.strictEqual(env.badge.title, "Hover Translator — нужно ваше согласие на отправку текста");
    await env.ctx.chrome.storage.local.set({ consent: { deepl: true } });
    await sleep(30);
    assert.ok(env.badge.text === "" && env.badge.title === "Hover Translator", JSON.stringify(env.badge));
    await env.ctx.chrome.storage.local.set({ engine: "llm", llmApiKey: "sk-ant-x", llmProvider: "anthropic" });
    await sleep(30);
    assert.strictEqual(env.badge.text, "!", "согласие на DeepL не открывает Anthropic");
    await env.ctx.chrome.storage.local.set({ llmProvider: "openai", consent: { deepl: true, openai: true } });
    await sleep(30);
    assert.strictEqual(env.badge.text, "");
    ok("значок: «!» и «нужно ваше согласие на отправку текста», пока его нет; согласились — чисто; смена сервиса ИИ — снова «!»");
  }

  // ---- модели ИИ: список, добавки к запросу, запас на рассуждение ----
  {
    const env = makeEnv({ llmApiKey: "sk-x", llmProvider: "openai", llmModel: "", consent: { openai: true, anthropic: true } });
    env.setFetch(llmOk);
    const body = async (provider, model) => {
      env.local.llmProvider = provider; env.local.llmModel = model;
      env.local.llmApiKey = provider === "anthropic" ? "sk-ant-x" : "sk-x";   // у каждого сервиса свой ключ
      const r = await env.send(msg("llm", ["text " + Math.random()], "user-initiated"), sender(1));
      assert.ok(r.ok && r.texts[0] === "Привет", provider + "/" + model + ": " + JSON.stringify(r));
      return env.fetches[env.fetches.length - 1].body;
    };
    let b = await body("openai", "");
    assert.ok(b.model === "gpt-6-luna" && b.reasoning_effort === "none" && b.max_completion_tokens === 512, JSON.stringify(b));
    b = await body("openai", "gpt-6.1-terra");
    assert.ok(b.reasoning_effort === "none" && b.max_completion_tokens === 512);
    b = await body("openai", "gpt-5.5");
    assert.ok(!("reasoning_effort" in b) && b.max_completion_tokens === 512 + 4096, "вписанная вручную — без добавок, с запасом");
    b = await body("openai", "gpt-4o-mini");
    assert.ok(!("reasoning_effort" in b) && b.max_completion_tokens === 512);
    b = await body("anthropic", "");
    assert.ok(b.model === "claude-haiku-5-5" && b.thinking.type === "disabled" && b.max_tokens === 512, JSON.stringify(b));
    b = await body("anthropic", "claude-sonnet-5-5");
    assert.ok(b.thinking.type === "between_tools" && b.max_tokens === 512, "Sonnet 5.5 не принимает disabled — убираем рассуждение перед ответом");
    b = await body("anthropic", "claude-opus-5-5");
    assert.ok(!("thinking" in b) && b.max_tokens === 512 + 4096, "вписанная вручную модель Claude — с запасом на рассуждение (оно включено по умолчанию)");
    assert.ok(env.fetches.every((f) => !("temperature" in f.body)));
    // строки списка моделей в окне — без жаргона, у каждого провайдера 2 модели, первая — по умолчанию
    for (const p of ["openai", "anthropic"]) {
      const rows = env.ctx.HT_llmModels(p);
      assert.ok(rows.length >= 2 && rows.length <= 3 && env.ctx.HT_llmDefault(p) === rows[0][0]);
      for (const r of rows) assert.ok(!JARGON.test(env.ctx.HT_llmModelLabel(r)), env.ctx.HT_llmModelLabel(r));
    }
    ok("модели ИИ: по умолчанию gpt-6-luna и claude-haiku-5-5; модели из списка — без рассуждения (reasoning_effort none / thinking disabled, у Sonnet 5.5 between_tools) и без запаса; вписанные вручную — без добавок, с запасом 4096; ответ Claude с блоком thinking читается");
  }

  // ---- подписи и тексты окна, настроек и приветствия без жаргона ----
  {
    const { ctx } = makeEnv();
    const labels = Object.fromEntries(ctx.HT_ENGINES.map((r) => [r[0], ctx.HT_engineLabel(r[0]) + " — " + ctx.HT_engineHint(r[0])]));
    assert.strictEqual(labels.chrome, "Встроенный в Chrome — бесплатно, текст не уходит в интернет");
    assert.strictEqual(labels.llm, "ИИ (ChatGPT / Claude) — по своему ключу, платно");
    assert.ok(labels.auto.startsWith("DeepL, а если не вышло — встроенный"));
    assert.strictEqual(ctx.HT_ENGINES.map((r) => r[0]).join(), "chrome,deepl,auto,llm", "встроенный — первым");
    // окно, страница настроек и приветствие: видимый текст разметки; их строки — в _locales/ru/messages.json
    const PAGES = ["popup.html", "options.html", "welcome.html"];
    const html = PAGES.map((f) => fs.readFileSync(path.join(EXT, f), "utf8")).join("\n");
    const visible = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*(?<![-\w])(placeholder|aria-label|title)="([^"]*)"[^>]*>/g, " $2 ").replace(/<[^>]+>/g, " ");
    const RU = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "ru", "messages.json"), "utf8"));
    const strings = Object.values(RU).map((m) => JSON.stringify(m.message));
    // Допустимо: «API Keys» — название раздела на сайте DeepL.
    const allowed = (s) => s.replace(/«API Keys»/g, "");
    const badHtml = visible.split(/\s{2,}|\n/).map((x) => x.trim()).filter((x) => x && JARGON.test(allowed(x)));
    const badJs = strings.filter((x) => JARGON.test(allowed(x.replace(/\$\{[^}]*\}/g, ""))));
    assert.deepStrictEqual(badHtml, [], "жаргон в разметке: " + badHtml.join(" | "));
    assert.deepStrictEqual(badJs, [], "жаргон в строках: " + badJs.join(" | "));
    // Ключ DeepL вставляют на странице настроек (карточка DeepL): поле — «Ключ DeepL», без «API»; в описании
    // карточки — бесплатный тариф, 500 000 знаков (с неразрывным пробелом: число не рвётся по строкам);
    // под полем — ссылка «Как получить ключ» на страницу ключей в кабинете DeepL.
    const opts = fs.readFileSync(path.join(EXT, "options.js"), "utf8");
    const field = RU.opDeeplKey.message + " | " + RU.opDeeplKeyPh.message;
    assert.ok(/^Ключ DeepL \| .*ключ DeepL/.test(field) && !/API/.test(field), field);
    assert.ok(/бесплатно — 500\u00a0000 знаков в месяц/.test(RU.opEngDeeplD.message), RU.opEngDeeplD.message);
    assert.ok(/"https:\/\/www\.deepl\.com\/your-account\/keys"/.test(opts) && /HT_t\("opHowGetKey"\)/.test(opts) && RU.opHowGetKey.message === "Как получить ключ");
    ok(`подписи переводчиков по таблице этапа 3; видимый текст окна, настроек и приветствия и строки (${strings.length}) — без «popup», «API», «LLM», «кэш», «движок», «on-device», «фолбэк», «formality», «поповер», «симв»; в настройках — поле «Ключ DeepL», «бесплатно — 500 000 знаков в месяц», ссылка «Как получить ключ» на deepl.com/your-account/keys`);
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
