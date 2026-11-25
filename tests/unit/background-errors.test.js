// Ошибки и горячие клавиши: background.js в node через vm (как background-install.test.js), плюс commands,
// tabs.sendMessage, runtime.openOptionsPage и значок для вкладки. Проверяет: понятные ошибки с кодами, последний сбой
// сервиса для окна (htNetErr), способ включения при установке/обновлении и миграцию настроек, горячие клавиши,
// «Открыть настройки», Esc во всех фреймах, встроенные окна (hoverFrame, frameKey — всем фреймам вкладки), значок
// «off» для выключенного сайта, нижнюю границу токенов ИИ, «!» на значке, когда DeepL или ИИ (OpenAI, Anthropic) не
// принял ключ, а выбранный переводчик ходит в этот сервис (по htNetErr — переживает перезапуск воркера: новый
// vm-контекст с теми же storage.local и storage.session); подсказка — тем же текстом, что в окне расширения.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { EXT } = require("../lib/env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(initialLocal = {}, opts = {}) {
  // этап 3: согласие на отправку текста уже дано (проверки без него — в unit/background-consent.test.js)
  // opts.local/opts.session — хранилища прежнего воркера: перезапуск (новый контекст, те же данные)
  const local = opts.local || Object.assign({ consent: { deepl: true, openai: true, anthropic: true } }, initialLocal);
  const session = opts.session || {};
  const changedFns = [];
  // onChanged — как в Chrome: для обеих областей и при удалении (только ключей, которые были)
  function area(store, name) {
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
        for (const fn of changedFns) fn(changes, name);
        return Promise.resolve();
      },
      remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; }
        if (Object.keys(changes).length) for (const fn of changedFns) fn(changes, name);
        return Promise.resolve();
      },
    };
  }
  let listener = null;
  const installed = [];
  const commandFns = [];
  const badge = { text: null, color: null, title: null, tab: {} };
  const tabsCreated = [];
  const tabMsgs = [];
  const popups = [];
  const optionsOpened = { n: 0 };
  const tabSlot = (id) => (badge.tab[id] = badge.tab[id] || {});
  const fetches = [];
  let fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  const ctx = {
    console, URL, TextEncoder, AbortController, DOMException, AbortSignal: { timeout: (ms) => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), (ms || 0) / 1000); return c.signal; } }, JSON, Promise, Map, Set, Date, Math, Object, Array, String, Number, RegExp, Error, Intl,
    setTimeout: (fn, ms) => setTimeout(fn, (ms || 0) / 1000), clearTimeout,
    chrome: {
      storage: { local: area(local, "local"), session: area(session, "session"), onChanged: { addListener: (fn) => changedFns.push(fn) } },
      alarms: { get: (n, cb) => cb(null), create() {}, onAlarm: { addListener() {} } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        onInstalled: { addListener: (fn) => installed.push(fn) },
        onStartup: { addListener() {} },
        getURL: (p) => "chrome-extension://abc/" + p,
        getManifest: () => ({ name: "Cursor Translate" }),
        openOptionsPage: () => { optionsOpened.n++; return Promise.resolve(); },
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
      // этап 4а: тексты из _locales/ru (opts.lang: "en" — из _locales/en)
      i18n: Object.assign(require("../lib/i18n-stub").makeI18n(opts.lang || "ru"), { getUILanguage: () => opts.ui || opts.lang || "ru" }),
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
  return { ctx, local, session, send, badge, tabsCreated, tabMsgs, popups, install, command, fetches, setFetch: (f) => { fetchImpl = f; },
    get optionsOpened() { return optionsOpened.n; } };
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
      [403, "bad-key", /^DeepL не принял ключ — проверьте его в настройках расширения\.$/],
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
      env.local.apiKey = "k" + i + ":fx";   // отклонённый ключ запоминается (ниже) — у каждого случая свой
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

    // отклонённый ключ не отправляется с каждым абзацем заново — до смены ключа
    let hits = 0;
    env.local.apiKey = "bad:fx";
    env.setFetch(() => { hits++; return jsonRes(403, {}); });
    const r1 = await env.send(msg("x1"), sender(1));
    const r2 = await env.send(msg("x2"), sender(1));
    assert.ok(r1.code === "bad-key" && r2.code === "bad-key", JSON.stringify([r1, r2]));
    assert.strictEqual(hits, 1, "второй раз с тем же ключом в DeepL не ходили");
    env.local.apiKey = "good:fx";
    env.setFetch(() => { hits++; return jsonRes(200, { translations: [{ text: "x", detected_source_language: "EN" }] }); });
    const r3 = await env.send(msg("x3"), sender(1));
    assert.ok(r3.ok && hits === 2, JSON.stringify(r3));
    // остаток: бесплатный ли ключ — для окна; ответ не JSON — «непонятный ответ», а не «нет связи»
    env.setFetch(() => jsonRes(200, { character_count: 5, character_limit: 1e12 }));
    const rf = await env.send({ type: "checkUsage" });
    assert.ok(rf.ok && rf.free === true && rf.used === 5, JSON.stringify(rf));
    env.local.apiKey = "pro-key";
    const rp = await env.send({ type: "checkUsage" });
    assert.ok(rp.ok && rp.free === false && rp.limit === 1e12, JSON.stringify(rp));
    env.setFetch(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) }));
    const rj = await env.send({ type: "checkUsage" });
    assert.ok(!rj.ok && rj.code === "bad-response" && !/Unexpected|интернет/.test(rj.error + rj.detail), JSON.stringify(rj));
    ok("DeepL: отклонённый ключ не отправляется повторно до смены; остаток знает, бесплатный ли ключ; ответ не JSON — «непонятный ответ», а не «нет связи»");
  }

  // ---- последний сбой сервиса — для окна расширения (storage.session.htNetErr) ----
  {
    const env = makeEnv({ apiKey: "q:fx", engine: "deepl" });
    const msg = (t) => ({ type: "translateBatch", engine: "deepl", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    env.setFetch(() => jsonRes(456, {}));
    await env.send(msg("a"), sender(1));
    await sleep(10);
    assert.deepStrictEqual([env.session.htNetErr.code, env.session.htNetErr.via, env.session.htNetErr.provider], ["quota", "deepl", "deepl"]);
    env.setFetch(() => jsonRes(429, {}, { "Retry-After": "0" }));
    await env.send(msg("b"), sender(1));
    await sleep(10);
    assert.strictEqual(env.session.htNetErr.code, "quota", "«слишком много запросов» окну не показываем — запись прежняя");
    env.setFetch(() => jsonRes(200, { translations: [{ text: "x", detected_source_language: "EN" }] }));
    await env.send(msg("c"), sender(1));
    await sleep(10);
    assert.ok(!("htNetErr" in env.session), "успешный ответ того же сервиса снимает запись");
    env.setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await env.send({ type: "checkUsage" });
    await sleep(10);
    assert.strictEqual(env.session.htNetErr.code, "network", "проверка ключа тоже отмечает сбой");
    await env.ctx.chrome.storage.local.set({ apiKey: "new:fx" });
    await sleep(10);
    assert.ok(!("htNetErr" in env.session), "новый ключ — запись снята");
    const llm = makeEnv({ llmApiKey: "sk-proj-x", llmProvider: "openai", engine: "llm" });
    llm.setFetch(() => jsonRes(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }));
    await llm.send({ type: "checkLlm" });
    await sleep(10);
    assert.deepStrictEqual([llm.session.htNetErr.code, llm.session.htNetErr.via, llm.session.htNetErr.provider], ["money", "llm", "openai"]);
    const st = makeEnv({ "htlc:a": { v: "один", t: Date.now() }, "htlc:b": { v: "два", t: Date.now() }, statChars: 7 });
    const gs = await st.send({ type: "getStats" });
    assert.ok(gs.ok && gs.entries === 2 && gs.bytes > 0 && gs.chars === 7, JSON.stringify(gs));
    const ck = makeEnv({ llmApiKey: "sk-proj-saved", llmProvider: "openai" });
    ck.setFetch(() => jsonRes(500, {}));
    await ck.send({ type: "checkLlm", provider: "anthropic", key: "sk-ant-new", model: "" }, { url: "chrome-extension://abc/options.html", tab: { id: 5 } });
    await ck.send({ type: "checkLlm", provider: "anthropic", key: "sk-ant-evil", model: "" }, sender(1));
    assert.ok(/anthropic\.com/.test(ck.fetches[0].url) && /openai\.com/.test(ck.fetches[ck.fetches.length - 1].url), JSON.stringify(ck.fetches.map((f) => f.url)));
    assert.strictEqual(ck.local.llmProvider, "openai", "проверка не меняет настройки");
    ok("checkLlm: страница настроек проверяет новый сервис и ключ до сохранения; от сайта (content) — только сохранённые");
    ok("getStats: для страницы настроек — сколько переводов сохранено и сколько они занимают");
    ok("последний сбой DeepL/ИИ для окна (htNetErr): ключ, лимит, деньги, связь — пишется; успешный ответ и смена ключа — снимают; прочие коды не трогают");
  }

  // ---- «!» на значке: DeepL не принял ключ (и в «авто», где переводит запасной встроенный) ----
  {
    const RED = "#d93025", GREY = "#6b7280";
    const BAD = "Hover Translator — DeepL не принял ключ";
    const msg = (engine, t) => ({ type: "translateBatch", engine, targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    const tr200 = () => jsonRes(200, { translations: [{ text: "x", detected_source_language: "EN" }] });
    const badgeIs = (env, text, title, why) => assert.ok(env.badge.text === text && env.badge.title === title && (text !== "!" || env.badge.color === RED), why + ": " + JSON.stringify(env.badge));

    // «авто»: DeepL ответил 403 — перевод пойдёт встроенным, а на значке «!» с причиной
    const auto = makeEnv({ apiKey: "bad:fx", engine: "auto" });
    await sleep(20);
    badgeIs(auto, "", "Hover Translator", "до запроса значок чистый");
    auto.setFetch(() => jsonRes(403, {}));
    const ra = await auto.send(msg("auto", "a1"), sender(1));
    assert.strictEqual(ra.code, "bad-key", JSON.stringify(ra));
    await sleep(20);
    badgeIs(auto, "!", BAD, "«авто»: DeepL не принял ключ");
    // воркер заснул и проснулся: память пуста, отметка — в storage.session
    const auto2 = makeEnv({}, { local: auto.local, session: auto.session });
    await sleep(20);
    badgeIs(auto2, "!", BAD, "после перезапуска воркера «!» остаётся");
    await auto2.send({ type: "siteBadge", off: false }, sender(8, 0));
    await sleep(10);
    assert.ok(auto2.badge.tab[8].text === null && auto2.badge.tab[8].color === RED && auto2.badge.tab[8].title === BAD, JSON.stringify(auto2.badge.tab[8]));
    await auto2.ctx.chrome.storage.local.set({ enabled: false });
    await sleep(20);
    assert.ok(auto2.badge.text === "off" && auto2.badge.color === GREY && auto2.badge.title === "Hover Translator — перевод выключен", "«off» важнее «!»: " + JSON.stringify(auto2.badge));
    await auto2.ctx.chrome.storage.local.set({ enabled: true });
    await sleep(20);
    badgeIs(auto2, "!", BAD, "перевод снова включён — «!» на месте");
    await auto2.ctx.chrome.storage.local.set({ apiKey: "new:fx" });
    await sleep(20);
    badgeIs(auto2, "", "Hover Translator", "новый ключ снимает «!»");

    // чистый DeepL: 401 — «!»; после перезапуска успешный ответ DeepL снимает его
    const dl = makeEnv({ apiKey: "bad:fx", engine: "deepl" });
    dl.setFetch(() => jsonRes(401, {}));
    await dl.send(msg("deepl", "d1"), sender(1));
    await sleep(20);
    badgeIs(dl, "!", BAD, "DeepL: не принял ключ");
    const dl2 = makeEnv({}, { local: dl.local, session: dl.session });
    await sleep(20);
    badgeIs(dl2, "!", BAD, "DeepL: после перезапуска воркера «!» остаётся");
    dl2.setFetch(tr200);
    const rd = await dl2.send(msg("deepl", "d2"), sender(1));
    assert.ok(rd.ok, JSON.stringify(rd));
    await sleep(20);
    badgeIs(dl2, "", "Hover Translator", "успешный ответ DeepL снимает «!»");
    // проверка ключа в окне расширения тоже ставит и снимает «!»
    dl2.setFetch(() => jsonRes(403, {}));
    await dl2.send({ type: "checkUsage" });
    await sleep(20);
    badgeIs(dl2, "!", BAD, "проверка ключа: DeepL не принял");
    dl2.setFetch(() => jsonRes(200, { character_count: 1, character_limit: 500000 }));
    await dl2.send({ type: "checkUsage" });
    await sleep(20);
    badgeIs(dl2, "", "Hover Translator", "проверка ключа прошла — «!» снят");

    // смена переводчика на не-DeepL снимает «!»; переводчик не ходит в DeepL — отклонённый ключ DeepL значка не трогает
    dl2.setFetch(() => jsonRes(403, {}));
    await dl2.send(msg("deepl", "d3"), sender(1));
    await sleep(20);
    badgeIs(dl2, "!", BAD, "DeepL снова не принял ключ");
    await dl2.ctx.chrome.storage.local.set({ engine: "chrome" });
    await sleep(20);
    badgeIs(dl2, "", "Hover Translator", "встроенный переводчик — «!» снят");
    const llm = makeEnv({ apiKey: "bad:fx", llmApiKey: "sk-proj-x", llmProvider: "openai", engine: "llm" });
    llm.setFetch(() => jsonRes(403, {}));
    await llm.send({ type: "checkUsage" });
    await sleep(20);
    assert.strictEqual(llm.session.htNetErr.code, "bad-key");
    badgeIs(llm, "", "Hover Translator", "переводчик ИИ: отклонённый ключ DeepL на значке не показываем");
    ok("«!» на значке, когда DeepL не принял ключ — в «авто» и в чистом DeepL; переживает перезапуск воркера; снимают новый ключ, успешный ответ DeepL, смена переводчика; «off» важнее; подсказка вкладки — та же");
  }

  // ---- «!» на значке: ИИ (OpenAI, Anthropic) не принял ключ ----
  {
    const RED = "#d93025", GREY = "#6b7280";
    const BAD = (svc) => "Hover Translator — " + svc + " не принял ключ";
    const msg = (engine, t) => ({ type: "translateBatch", engine, targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: [t] });
    const r401 = () => jsonRes(401, { error: { message: "Incorrect API key provided.", code: "invalid_api_key" } });
    // один текст в запросе — один перевод в ответе
    const ai200 = (url) => {
      const json = JSON.stringify({ translations: ["x"] });
      return url.includes("anthropic") ? jsonRes(200, { stop_reason: "end_turn", content: [{ type: "text", text: json }] })
        : jsonRes(200, { choices: [{ finish_reason: "stop", message: { content: json } }] });
    };
    const badgeIs = (env, text, title, why) => assert.ok(env.badge.text === text && env.badge.title === title && (text !== "!" || env.badge.color === RED), why + ": " + JSON.stringify(env.badge));
    const fail = async (env, t) => {
      env.setFetch(r401);
      const r = await env.send(msg("llm", t), sender(1));
      assert.strictEqual(r.code, "bad-key", JSON.stringify(r));
      await sleep(20);
    };

    // OpenAI: 401 — «!» и название сервиса, как в окне расширения
    const oa = makeEnv({ apiKey: "k:fx", llmApiKey: "sk-proj-bad", llmProvider: "openai", engine: "llm" });
    await sleep(20);
    badgeIs(oa, "", "Hover Translator", "ИИ: до запроса значок чистый");
    await fail(oa, "o1");
    badgeIs(oa, "!", BAD("OpenAI"), "OpenAI не принял ключ");
    const oa2 = makeEnv({}, { local: oa.local, session: oa.session });
    await sleep(20);
    badgeIs(oa2, "!", BAD("OpenAI"), "ИИ: после перезапуска воркера «!» остаётся");
    await oa2.send({ type: "siteBadge", off: false }, sender(8, 0));
    await sleep(10);
    assert.ok(oa2.badge.tab[8].text === null && oa2.badge.tab[8].color === RED && oa2.badge.tab[8].title === BAD("OpenAI"), JSON.stringify(oa2.badge.tab[8]));
    await oa2.ctx.chrome.storage.local.set({ enabled: false });
    await sleep(20);
    assert.ok(oa2.badge.text === "off" && oa2.badge.color === GREY && oa2.badge.title === "Hover Translator — перевод выключен", "ИИ: «off» важнее «!»: " + JSON.stringify(oa2.badge));
    await oa2.ctx.chrome.storage.local.set({ enabled: true });
    await sleep(20);
    badgeIs(oa2, "!", BAD("OpenAI"), "ИИ: перевод снова включён — «!» на месте");
    // успешный ответ того же сервиса снимает «!»
    oa2.setFetch(ai200);
    const ro = await oa2.send(msg("llm", "o2"), sender(1));
    assert.ok(ro.ok, JSON.stringify(ro));
    await sleep(20);
    badgeIs(oa2, "", "Hover Translator", "успешный ответ OpenAI снимает «!»");
    // новый ключ ИИ снимает «!»
    await fail(oa2, "o3");
    badgeIs(oa2, "!", BAD("OpenAI"), "OpenAI снова не принял ключ");
    await oa2.ctx.chrome.storage.local.set({ llmApiKey: "sk-proj-new" });
    await sleep(20);
    badgeIs(oa2, "", "Hover Translator", "новый ключ ИИ снимает «!»");
    // последний сбой — уже DeepL (проверка его ключа), а переводит ИИ: значок перерисован, «!» снят
    await fail(oa2, "o4");
    badgeIs(oa2, "!", BAD("OpenAI"), "OpenAI не принял и новый ключ");
    oa2.setFetch(() => jsonRes(403, {}));
    await oa2.send({ type: "checkUsage" });
    await sleep(20);
    assert.deepStrictEqual([oa2.session.htNetErr.code, oa2.session.htNetErr.via], ["bad-key", "deepl"]);
    badgeIs(oa2, "", "Hover Translator", "последний отклонённый ключ — DeepL, переводчик ИИ: «!» снят");
    // смена сервиса ИИ снимает «!»
    await fail(oa2, "o5");
    badgeIs(oa2, "!", BAD("OpenAI"), "OpenAI не принял ключ (перед сменой сервиса)");
    await oa2.ctx.chrome.storage.local.set({ llmProvider: "anthropic", llmApiKey: "sk-ant-x" });
    await sleep(20);
    badgeIs(oa2, "", "Hover Translator", "смена сервиса ИИ снимает «!»");

    // Anthropic: так же; смена переводчика снимает «!»
    const an = makeEnv({ apiKey: "k:fx", llmApiKey: "sk-ant-bad", llmProvider: "anthropic", engine: "llm" });
    await fail(an, "a1");
    badgeIs(an, "!", BAD("Anthropic"), "Anthropic не принял ключ");
    const an2 = makeEnv({}, { local: an.local, session: an.session });
    await sleep(20);
    badgeIs(an2, "!", BAD("Anthropic"), "Anthropic: после перезапуска воркера «!» остаётся");
    await an2.ctx.chrome.storage.local.set({ engine: "deepl" });
    await sleep(20);
    badgeIs(an2, "", "Hover Translator", "переводчик DeepL — «!» ИИ снят");

    // ключ ИИ отклонён, а переводчик DeepL, «авто» или встроенный — «!» нет
    const dl = makeEnv({ apiKey: "k:fx", llmApiKey: "sk-proj-bad", llmProvider: "openai", engine: "deepl" });
    dl.setFetch(r401);
    const rc = await dl.send({ type: "checkLlm" });
    assert.strictEqual(rc.code, "bad-key", JSON.stringify(rc));
    await sleep(20);
    assert.deepStrictEqual([dl.session.htNetErr.code, dl.session.htNetErr.via, dl.session.htNetErr.provider], ["bad-key", "llm", "openai"]);
    badgeIs(dl, "", "Hover Translator", "переводчик DeepL: отклонённый ключ ИИ на значке не показываем");
    for (const engine of ["auto", "chrome"]) {
      dl.session.htNetErr = { code: "bad-key", via: "llm", provider: "openai", at: 1 };
      const d2 = makeEnv({}, { local: Object.assign(dl.local, { engine }), session: dl.session });
      await sleep(20);
      badgeIs(d2, "", "Hover Translator", "переводчик «" + engine + "»: отклонённый ключ ИИ на значке не показываем");
    }

    // подсказка — общим текстом окна расширения («$service$ не принял ключ») и для DeepL, и для ИИ
    const en = makeEnv({ apiKey: "bad:fx", engine: "deepl" }, { lang: "en" });
    en.setFetch(() => jsonRes(403, {}));
    await en.send(msg("deepl", "e1"), sender(1));
    await sleep(20);
    const enTitle = (svc) => en.ctx.HT_t("badgeProblem", ["Hover Translator", en.ctx.HT_t("ppBadKeyT", svc)]);
    assert.ok(en.badge.text === "!" && en.badge.title === enTitle("DeepL") && en.badge.title === "Hover Translator — DeepL didn't accept the key", JSON.stringify(en.badge));
    await en.ctx.chrome.storage.local.set({ engine: "llm", llmApiKey: "sk-ant-bad", llmProvider: "anthropic" });
    await fail(en, "e2");
    assert.ok(en.badge.text === "!" && en.badge.title === enTitle("Anthropic") && en.badge.title === "Hover Translator — Anthropic didn't accept the key", JSON.stringify(en.badge));
    ok("«!» на значке, когда ИИ не принял ключ — OpenAI и Anthropic, с названием сервиса; переживает перезапуск воркера; снимают успешный ответ, новый ключ, смена сервиса или переводчика, сбой DeepL поверх; «off» важнее; при переводчике DeepL/«авто»/встроенном — нет; подсказка (и для DeepL) — текстом окна расширения");
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
    const env2 = makeEnv({ llmApiKey: "sk-ant-x", llmProvider: "anthropic", llmModel: "" });
    env2.setFetch(() => jsonRes(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }));
    const r2 = await env2.send(msg("y"), sender(1));
    assert.ok(r2.code === "money" && /^На счёте Anthropic закончились деньги/.test(r2.error) && /credit balance/.test(r2.detail), JSON.stringify(r2));
    env2.setFetch(() => jsonRes(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { "Retry-After": "0" }));
    const r3 = await env2.send(msg("z"), sender(1));
    assert.ok(r3.code === "server" && /Anthropic сейчас недоступен или перегружен/.test(r3.error), JSON.stringify(r3));
    // без ключа — подсказка без «popup»
    const env3 = makeEnv({});
    const r4 = await env3.send(msg("k"), sender(1));
    assert.ok(r4.code === "no-key" && r4.error === "Не задан ключ ИИ — вставьте его в настройках расширения.", JSON.stringify(r4));
    assert.ok(!JARGON.test(env3.ctx.HT_t(env3.ctx.HT_KEY_HINTS.apiKey)) && !JARGON.test(env3.ctx.HT_t(env3.ctx.HT_KEY_HINTS.llmApiKey)));
    // ключ не того сервиса не отправляется вовсе (раньше после смены сервиса ключ OpenAI уходил в Anthropic)
    let sent = 0;
    const env5 = makeEnv({ llmApiKey: "sk-proj-abc", llmProvider: "anthropic", llmModel: "" });
    env5.setFetch(() => { sent++; return jsonRes(200, {}); });
    const r5 = await env5.send(msg("w"), sender(1));
    assert.ok(r5.code === "bad-key" && /ключ другого сервиса/.test(r5.error) && sent === 0, JSON.stringify(r5));
    env5.local.llmProvider = "openai"; env5.local.llmApiKey = "sk-ant-abc";
    const r6 = await env5.send(msg("w2"), sender(1));
    assert.ok(r6.code === "bad-key" && sent === 0, JSON.stringify(r6));
    ok("ИИ: нет денег на счёте (OpenAI 429 insufficient_quota, Anthropic 400 credit balance), 429, 403, 404 модель, 5xx/529, сеть, нет ключа, ключ другого сервиса (не отправляется) — простыми словами");
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
    const border = makeEnv({ dispMode: "custom", dispBg: "#123456", dispBorder: true, dispBorderColor: "#ff0000", dispBorderStyle: "dashed" });
    await border.install("update");
    assert.deepStrictEqual(["dispBorder", "dispBorderColor", "dispBorderStyle"].filter((k) => k in border.local), [], "обводки подсветки больше нет — ключи стёрты");
    assert.deepStrictEqual([border.local.dispMode, border.local.dispBg], ["custom", "#123456"], "свой цвет остаётся");
    assert.deepStrictEqual([env.ctx.HT_DEFAULTS.dispBg, env.ctx.HT_DEFAULTS.dispOpacity, "dispBorder" in env.ctx.HT_DEFAULTS], ["#ffcf4a", 35, false]);
    ok("обновление стирает ключи обводки подсветки (dispBorder*), свой цвет сохраняется; по умолчанию — янтарь 35 %");
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
    assert.deepStrictEqual(manifest.permissions, ["storage", "alarms", "activeTab", "contextMenus"], "разрешения: activeTab — адрес вкладки для окна, contextMenus — пункт «Перевести «…»», без tabs и хостов");
    assert.deepStrictEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
    ok("горячие клавиши: вкл/выкл пишет enabled и говорит на странице (верхний фрейм), «перевести страницу» — верхнему фрейму; manifest по правилам chrome.commands; разрешения storage, alarms, activeTab, contextMenus; настройки — options_ui во вкладке");
  }

  // ---- «Открыть настройки», Esc во всех фреймах, значок выключенного сайта, noticeOnce ----
  {
    const env = makeEnv({});
    const r = await env.send({ type: "openSettings", focus: "deepl-key" }, sender(3));
    assert.ok(r.ok && env.optionsOpened === 1, JSON.stringify(r));
    assert.strictEqual(env.session.htFocus.to, "deepl-key");
    assert.ok(Date.now() - env.session.htFocus.at < 5000);
    await env.send({ type: "openSettings", focus: "<script>" }, sender(3));
    assert.strictEqual(env.session.htFocus.to, "", "чужое значение focus не пропускаем");
    assert.strictEqual(env.popups.length, 0, "окно над значком больше не открываем — настройки на своей странице");
    ok("«Открыть настройки»: страница настроек (runtime.openOptionsPage, открытая — переключается), куда прокрутить — в storage.session.htFocus (только [a-z-])");

    await env.send({ type: "restoreTab" }, sender(4, 3));
    const m = env.tabMsgs.pop();
    assert.ok(m.tabId === 4 && m.msg.type === "restoreAll" && !("frameId" in m.o), JSON.stringify(m));
    ok("Esc: background рассылает restoreAll во все фреймы вкладки");

    await env.send({ type: "frameKey", at: 1700000000123, extra: "x" }, sender(4, 3));
    const k = env.tabMsgs.pop();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(k)), { tabId: 4, msg: { type: "frameKey", at: 1700000000123 }, o: {} }, "всем фреймам вкладки, только type и at");
    await env.send({ type: "frameKey", at: "<x>" }, sender(4, 0));
    assert.strictEqual(env.tabMsgs.pop().msg.at, 0, "at не число — 0 (фрейм тогда ничего не переводит)");
    await env.send({ type: "hoverFrame", from: "abc123", at: 5, extra: "x" }, sender(4, 2));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(env.tabMsgs.pop())), { tabId: 4, msg: { type: "hoverFrame", from: "abc123", at: 5 }, o: {} }, "только type, from и at");
    await env.send({ type: "hoverFrame", from: "abc123", at: "<x>" }, sender(4, 2));
    assert.strictEqual(env.tabMsgs.pop().msg.at, 0, "at не число — 0 (отпускание в другом фрейме тогда уступает этому)");
    const before = env.tabMsgs.length;
    await env.send({ type: "frameKey", at: 1 }, {});
    await env.send({ type: "hoverFrame", from: "x" }, {});
    assert.strictEqual(env.tabMsgs.length, before, "не из вкладки — некому пересылать");
    ok("встроенные окна: «курсор пришёл в этот фрейм» (hoverFrame) и клавишу-триггер для другого фрейма (frameKey) background пересылает всем фреймам вкладки отправителя");

    await env.send({ type: "siteBadge", off: true }, sender(8, 2));      // не верхний фрейм — не слушаем
    await sleep(10);
    assert.ok(!env.badge.tab[8], "значок вкладки меняет только верхний фрейм");
    await env.send({ type: "siteBadge", off: true }, sender(8, 0));
    await sleep(10);
    assert.deepStrictEqual(env.badge.tab[8], { color: "#6b7280", text: "off", title: "Hover Translator — на этом сайте перевод выключен" });
    await env.send({ type: "siteBadge", off: false }, sender(8, 0));
    await sleep(10);
    assert.ok(env.badge.tab[8].text === null && env.badge.tab[8].title === "Hover Translator", JSON.stringify(env.badge.tab[8]));
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
    // Имена констант внутри ${…} — не текст.
    const STAGE3 = ['"DeepL → встроенный (фолбэк)"', '"LLM (OpenAI / Anthropic) — контекстный"'];
    const bad = strings.filter((x) => !STAGE3.includes(x) && JARGON.test(x.replace(/\$\{[^}]*\}/g, "")));
    assert.deepStrictEqual(bad, [], "жаргон в текстах: " + bad.join(" | "));
    ok(`тексты для человека (${strings.length} строк в background/shared/content) — без «popup», «API», «LLM», «кэш», «движок», «поповер»`);
  }

  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
