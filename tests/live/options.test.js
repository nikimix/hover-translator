// Страница настроек вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked), DeepL,
// OpenAI и Anthropic — заглушки на своём сервере (адреса подменены в копии background.js).
// Проверяет: шаги подключения DeepL «Согласие → Ключ → Готово» (а–г: «Отмена», ключ не принят, ключ работает,
// остаток), переводчик переключается только на «Готово», проверка ключа по Enter, отзыв согласия при DeepL;
// ИИ: согласие у каждого сервиса своё, смена сервиса не меняет переводчик до «Готово», «Отмена» возвращает прежний
// сервис, ключ другого сервиса не уходит не тому; фокус по просьбе окна (htFocus, openSettings); «Удалить»
// сохранённые переводы; «Показывать плавающую кнопку» (последняя строка «На странице»: пишет hudShown, кружок на
// открытой вкладке сайта появляется и исчезает). Скриншоты (светлая и тёмная тема) — с tests/run.sh --shots.
const path = require("path");
const fs = require("fs");
const http = require("http");
const assert = require("assert");
const { launch, sleep, until } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { pageUi } = require("../lib/live");
// Ожидаемые тексты — из _locales, а не вписанные руками: тексты правят отдельно от проверок.
const MSG_RU = require(path.join(__dirname, "..", "..", "hover-translate", "_locales", "ru", "messages.json"));
// Сообщение, как его соберёт chrome.i18n: $имя$ → подстановка по номеру из placeholders.
function msg(key, subs) {
  const m = MSG_RU[key];
  assert.ok(m, "нет сообщения " + key);
  const ph = {};
  for (const [n, d] of Object.entries(m.placeholders || {})) ph[n.toLowerCase()] = Number(String(d.content).replace("$", "")) - 1;
  return m.message.replace(/\$(\w+)\$/g, (all, n) => (n.toLowerCase() in ph ? String([].concat(subs || [])[ph[n.toLowerCase()]] ?? "") : all));
}

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// ---- заглушки сервисов ----
function mockApi() {
  const mock = { deepl: "ok", llm: "ok", usage: { character_count: 87700, character_limit: 500000 } };
  const log = [];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const send = (res, code, body) => { res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, cors)); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      log.push(u.pathname);
      const fail = (mode) => send(res, Number(mode) || 500, { message: "mock " + mode, error: { message: "mock " + mode, type: "mock" } });
      if (u.pathname === "/deepl/v2/usage") return mock.deepl === "ok" ? send(res, 200, mock.usage) : fail(mock.deepl);
      if (u.pathname === "/deepl/v2/translate") {
        if (mock.deepl !== "ok") return fail(mock.deepl);
        let j = {};
        try { j = JSON.parse(body); } catch (e) { j = { text: new URLSearchParams(body).getAll("text") }; }
        return send(res, 200, { translations: [].concat(j.text || []).map((t) => ({ detected_source_language: "EN", text: "[RU] " + t })) });
      }
      if (u.pathname === "/openai/v1/chat/completions" || u.pathname === "/anthropic/v1/messages") {
        if (mock.llm !== "ok") return fail(mock.llm);
        let j = {};
        try { j = JSON.parse(body); } catch (e) { /* пусто */ }
        const msg = ((j.messages || []).filter((m) => m.role === "user").pop() || {}).content || "[]";
        let arr;
        try { arr = JSON.parse(typeof msg === "string" ? msg : JSON.stringify(msg)); } catch (e) { arr = [String(msg)]; }
        const out = JSON.stringify({ translations: [].concat(arr).map((t) => "[RU] " + t) });
        if (u.pathname.startsWith("/anthropic")) return send(res, 200, { id: "m", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: out }] });
        return send(res, 200, { id: "c", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: out } }] });
      }
      send(res, 404, { message: "unknown " + u.pathname });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`, mock, log, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  })));
}

const DEEPL_KEY = "7f3c9a1e-5b2d-4e8f-a6c1-0d9e4b7a4f2a:fx";
const OPENAI_KEY = "sk-proj-4hQ2xT9mZr7Lw1Vb8Nc3Kd5Pf0Gy9Qa";
const CLAUDE_KEY = "sk-ant-api03-test-key-9Zq";

(async () => {
  const api = await mockApi();
  const srv = await serve();
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const ext = b.copyExt();
    const bgFile = path.join(ext, "background.js");
    fs.writeFileSync(bgFile, fs.readFileSync(bgFile, "utf8")
      .replaceAll("https://api-free.deepl.com", api.base + "/deepl").replaceAll("https://api.deepl.com", api.base + "/deepl")
      .replaceAll("https://api.openai.com", api.base + "/openai").replaceAll("https://api.anthropic.com", api.base + "/anthropic"));
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    const { targetInfos } = await b.cmd("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const sw = await b.attach(targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js").targetId);

    const pt = await b.openTab(EXT + "options.html");
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = (e) => pt.ev(e);
    const store = (o) => ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    const get = async (keys) => JSON.parse(await ev(`chrome.storage.local.get(${JSON.stringify(keys)}).then((s) => JSON.stringify(s))`));
    const ready = () => until(() => ev("!!document.querySelector('#engines .rcard') && typeof ui === 'object' && !!st"), 10000);
    const reload = async () => { await pt.cmd("Page.reload"); await sleep(600); await ready(); await sleep(400); };
    const BASE = { enabled: true, engine: "chrome", targetLang: "RU", sourceLang: "auto", trigger: "shift", consent: {}, apiKey: "", keyVerified: false,
      llmProvider: "openai", llmApiKey: "", llmVerified: false, llmKeyBy: {}, llmModel: "" };
    await ready();
    await ev("chrome.storage.local.clear().then(() => true)");
    await store(BASE);
    await reload();
    // настоящий щелчок по элементу (сначала прокрутить в середину экрана)
    const click = async (sel) => {
      const r = JSON.parse(await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "null";
        e.scrollIntoView({ block: "center", behavior: "instant" }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }); })()`));
      assert.ok(r, "нет элемента " + sel);
      await pt.click(r.x, r.y);
      await sleep(250);
    };
    const paste = (sel, text) => ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: ${JSON.stringify(text)} })); return true; })()`);
    const text = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, " ").trim() : null; })()`);
    const card = async (code) => JSON.parse(await ev(`(() => { const c = document.querySelector('[data-card="${code}"]'); if (!c) return "null";
      const s = [...c.querySelectorAll('.step')]; return JSON.stringify({ open: c.classList.contains('open'), on: c.classList.contains('on'),
        checked: c.querySelector('input[type=radio]').checked, tag: (c.querySelector('.rc-t .tag') || {}).textContent || "",
        steps: s.map((x) => x.className.replace('step', '').trim() + ':' + x.textContent.trim()).join(' | '),
        wait: (c.querySelector('.rc-wait') || {}).textContent || "", btns: [...c.querySelectorAll('.rc-acts .btn')].map((x) => x.textContent),
        msg: (c.querySelector('.inp-msg') || {}).textContent || "" }); })()`));
    // клавиша с клавиатуры (CDP, как настоящая): нажать и отпустить
    const press = async (k, vk) => { await pt.key("rawKeyDown", k, k, 0, vk); await pt.key("keyUp", k, k, 0, vk); await sleep(100); };
    const theme = (dark) => pt.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    // Снимок карточки (или всей страницы) в обеих темах.
    const shots = async (name, sel) => {
      if (!process.env.HT_SHOTS) return;
      await ev("document.activeElement && document.activeElement.blur(); true");
      for (const dark of [false, true]) {
        await theme(dark); await sleep(200);
        let clip;
        if (sel) {
          const r = JSON.parse(await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "start", behavior: "instant" });
            const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top + scrollY, width: r.width, height: r.height }); })()`));
          clip = Object.assign(r, { scale: 1 });
        }
        await pt.shot(`${name}-${dark ? "dark" : "light"}.png`, clip ? { clip, captureBeyondViewport: true } : { captureBeyondViewport: true });
      }
      await theme(false);
    };

    // ---- страница: разделы, меню, заголовок ----
    const page = JSON.parse(await ev(`JSON.stringify({ h1: document.querySelector('h1').textContent, title: document.title,
      nav: [...document.querySelectorAll('#nav .nav-a')].map((a) => a.textContent.trim()), cur: document.querySelector('#nav .nav-a.on').textContent.trim(),
      secs: [...document.querySelectorAll('main > section')].map((s) => s.id), how: document.querySelector('.pg-top a').getAttribute('href'),
      font: getComputedStyle(document.querySelector('.cr-t')).fontFamily.split(',')[0], size: getComputedStyle(document.body).fontSize,
      cards: [...document.querySelectorAll('#engines [data-card]')].map((c) => c.dataset.card) })`));
    console.log("      (" + JSON.stringify(page) + ")");
    assert.strictEqual(page.h1, "Настройки");
    assert.deepStrictEqual(page.nav, ["Переводчик", "На странице", "Языки", "Сайты и слова", "Горячие клавиши", "Данные"]);
    assert.deepStrictEqual(page.secs, ["translator", "page", "langs", "sites", "keys", "data"]);
    assert.strictEqual(page.cur, "Переводчик");
    assert.strictEqual(page.how, "welcome.html");
    assert.deepStrictEqual(page.cards, ["chrome", "deepl", "auto", "llm"]);
    assert.ok(/Inter/.test(page.font) && page.size === "14px", "шрифт Inter 14 px: " + page.font + " " + page.size);
    await ev("document.querySelector('#data').scrollIntoView({ behavior: 'instant' }); true"); await sleep(300);
    assert.strictEqual(await text("#nav .nav-a.on"), "Данные", "прокрутили вниз — в меню горит «Данные»");
    await ev("scrollTo({ top: 0, behavior: 'instant' }); true"); await sleep(300);
    ok("страница: «Настройки», меню из 6 разделов (текущий подсвечен и следует прокрутке), «Как пользоваться» → приветствие, 4 карточки переводчика, Inter 14 px");

    // ---- DeepL: а · согласие, «Отмена» ----
    await click('[data-card="deepl"] .rc-head');
    let c = await card("deepl");
    console.log("      (а: " + JSON.stringify(c) + ")");
    assert.ok(c.open && c.checked, "DeepL раскрылся");
    assert.strictEqual(c.steps, "cur:1Согласие | :2Ключ | :3Готово");
    assert.strictEqual(c.wait, "Пока переводит встроенный");
    assert.deepStrictEqual(c.btns, ["Разрешить отправку", "Отмена"]);
    assert.ok(/Отправлять текст в DeepL\?/.test(await text('[data-card="deepl"] .notice')));
    assert.strictEqual((await get(["engine"])).engine, "chrome", "переводчик не сменился");
    await shots("deepl-a-consent", '[data-card="deepl"]');
    await click('[data-fk="cancel"]');
    c = await card("deepl");
    assert.ok(!c.open && !c.checked && (await card("chrome")).checked, "«Отмена» вернула встроенный");
    assert.strictEqual(await ev("document.activeElement.dataset.fk"), "eng-chrome");
    assert.deepStrictEqual((await get(["engine", "consent"])), { engine: "chrome", consent: {} });
    ok("а · DeepL: выбор карточки раскрывает шаги «Согласие → Ключ → Готово», «Пока переводит встроенный»; «Отмена» возвращает встроенный, переводчик не менялся");

    // ---- б · ключ ----
    await click('[data-card="deepl"] .rc-head');
    await click('[data-fk="allow-deepl"]');
    c = await card("deepl");
    assert.strictEqual(c.steps, "done:Согласие | cur:2Ключ | :3Готово");
    assert.strictEqual(c.wait, "Пока переводит встроенный");
    assert.strictEqual(await ev("document.activeElement.id"), "deepl-key", "фокус — в поле ключа");
    assert.strictEqual(await ev("document.querySelector('#deepl-key').type"), "password");
    assert.strictEqual(await ev("document.querySelector('[data-card=deepl] .link-ext').href"), "https://www.deepl.com/your-account/keys");
    let s = await get(["engine", "consent"]);
    assert.deepStrictEqual(s, { engine: "chrome", consent: { deepl: true, openai: false, anthropic: false } });
    await shots("deepl-b-key", '[data-card="deepl"]');
    ok("б · «Разрешить отправку»: согласие только на DeepL, шаг «Ключ», фокус в поле (type=password), «Как получить ключ» → страница ключей DeepL; переводчик — по-прежнему встроенный");

    // ---- в · ключ не принят ----
    api.mock.deepl = "403";
    await paste("#deepl-key", DEEPL_KEY.replace(":fx", ""));
    await until(async () => (await card("deepl")).tag === "Ключ не принят", 8000);
    c = await card("deepl");
    console.log("      (в: " + JSON.stringify(c) + ")");
    assert.strictEqual(c.steps, "done:Согласие | err:!Ключ | :3Готово");
    assert.strictEqual(c.msg, "DeepL не принял ключ. Скопируйте его заново целиком — у бесплатного ключа в конце «:fx».");
    assert.strictEqual(c.wait, "Пока переводит встроенный");
    assert.ok(await ev("document.querySelector('#deepl-key').classList.contains('is-err') && document.querySelector('#deepl-key').getAttribute('aria-invalid') === 'true'"));
    assert.deepStrictEqual(await get(["engine", "keyVerified"]), { engine: "chrome", keyVerified: false });
    await shots("deepl-c-error", '[data-card="deepl"]');
    ok("в · вставили отклонённый ключ: проверка сама, шаг ② красный, рамка поля красная, «…в конце «:fx».»; переводчик — встроенный");

    // ---- г · готово: переводчик переключается только сейчас ----
    api.mock.deepl = "ok";
    const n0 = api.log.length;
    await paste("#deepl-key", DEEPL_KEY);
    await until(async () => (await card("deepl")).tag === "Подключён", 8000);
    c = await card("deepl");
    const quota = await text('[data-card="deepl"] .quota-t');
    console.log("      (г: " + JSON.stringify(c) + "; остаток: «" + quota + "»)");
    assert.strictEqual(c.steps, "", "шагов больше нет");
    assert.strictEqual(c.msg, "Ключ …4f2a:fx работает · бесплатный тариф");
    assert.ok(/^412\s300 из 500\s000 знаков\./.test(quota), quota);
    assert.ok(/Отозвать согласие/.test(await text('[data-card="deepl"] .consent-line')));
    assert.deepStrictEqual(await get(["engine", "keyVerified", "apiKey"]), { engine: "deepl", keyVerified: true, apiKey: DEEPL_KEY });
    assert.ok(api.log.slice(n0).every((p) => p === "/deepl/v2/usage"), "уходил только запрос остатка: " + api.log.slice(n0));
    await shots("deepl-d-ready", '[data-card="deepl"]');
    await shots("page-full");
    ok("г · ключ работает: метка «Подключён», «Ключ …4f2a:fx работает · бесплатный тариф», остаток 412 300 из 500 000, отзыв согласия; переводчик стал DeepL только сейчас");

    // ---- ключ правят по буквам: снова шаг «Ключ», Enter — проверка ----
    await ev("(() => { const i = document.querySelector('#deepl-key'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()");
    await pt.cmd("Input.insertText", { text: "x" });
    await sleep(300);
    c = await card("deepl");
    assert.strictEqual(c.steps, "done:Согласие | cur:2Ключ | :3Готово", "ключ правят — снова шаг «Ключ»");
    assert.strictEqual(c.wait, "", "переводчик — сам DeepL: «Пока переводит…» не пишем");
    assert.strictEqual(await ev("document.activeElement.id"), "deepl-key", "фокус остался в поле");
    await pt.key("rawKeyDown", "Backspace", "Backspace", 0, 8); await pt.key("keyUp", "Backspace", "Backspace", 0, 8);
    await sleep(100);
    await pt.key("rawKeyDown", "Enter", "Enter", 0, 13); await pt.key("keyUp", "Enter", "Enter", 0, 13);
    await until(async () => (await card("deepl")).tag === "Подключён", 8000);
    assert.strictEqual((await get(["keyVerified"])).keyVerified, true, "Enter проверил ключ");
    ok("ключ правят по буквам: шаг «Ключ» без «Пока переводит…» (переводчик — сам DeepL), фокус в поле; Enter проверяет");

    // ---- отозвали согласие при DeepL: шаг согласия, без «Пока переводит встроенный» ----
    await click('[data-fk="revoke-deepl"]');
    c = await card("deepl");
    assert.strictEqual(c.steps, "cur:1Согласие | :2Ключ | :3Готово");
    assert.strictEqual(c.wait, "");
    assert.deepStrictEqual(c.btns, ["Разрешить отправку", "Переводить встроенным"]);
    assert.deepStrictEqual(await get(["engine", "consent"]), { engine: "deepl", consent: { deepl: false, openai: false, anthropic: false } });
    assert.strictEqual(await ev("document.activeElement.dataset.fk"), "allow-deepl");
    await click('[data-fk="allow-deepl"]');
    assert.strictEqual((await card("deepl")).tag, "Подключён", "согласие снова — ключ уже проверен, сразу «Готово»");
    ok("отзыв согласия при DeepL: карточка на шаге согласия без «Пока переводит встроенный», вместо «Отмены» — «Переводить встроенным»; переводчик остаётся DeepL");

    // ---- «Авто»: DeepL подключён — переключается сразу, порядок виден ----
    await click('[data-card="auto"] .rc-head');
    await until(async () => /осталось/.test(await text('[data-card="auto"] .fb-row')), 5000);
    const rows = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('[data-card=auto] .fb-row')].map((r) => [...r.children].map((x) => x.textContent.trim()).filter(Boolean).join(' ')))"));
    console.log("      (ж: " + JSON.stringify(rows) + ")");
    assert.ok(/^1 DeepL Подключён · осталось 412\s300 знаков$/.test(rows[0]), rows[0]);
    assert.ok(/^2 Встроенный в Chrome/.test(rows[1]), rows[1]);
    assert.strictEqual((await get(["engine"])).engine, "auto");
    await shots("auto", '[data-card="auto"]');
    ok("ж · «Авто» при подключённом DeepL: переключился сразу; строки «1 DeepL — Подключён · осталось 412 300 знаков» и «2 Встроенный в Chrome»");

    // ---- ИИ: согласие по сервисам, смена сервиса только на «Готово» ----
    await store({ engine: "chrome", consent: { openai: true }, llmProvider: "openai", llmApiKey: OPENAI_KEY, llmVerified: true, llmKeyBy: {} });
    await reload();
    await click('[data-card="llm"] .rc-head');
    c = await card("llm");
    assert.strictEqual(c.tag, "Подключён");
    assert.strictEqual(c.msg, "Ключ …9Qa работает");
    assert.strictEqual((await get(["engine"])).engine, "llm", "ChatGPT готов — переключился сразу");
    const models = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#llm-model option')].map((o) => o.textContent))"));
    assert.deepStrictEqual(models.slice(-1), ["Другая…"]);
    assert.ok(/быстрая и дешёвая/.test(models[0]), models[0]);
    await shots("llm-ready", '[data-card="llm"]');
    await click('[data-fk="svc-anthropic"]');
    c = await card("llm");
    console.log("      (д: " + JSON.stringify(c) + ")");
    assert.strictEqual(c.steps, "cur:1Согласие | :2Ключ | :3Готово", "согласие на OpenAI не переносится на Anthropic");
    assert.strictEqual(c.wait, "Пока переводит ChatGPT");
    assert.deepStrictEqual(c.btns, ["Разрешить отправку", "Отмена"]);
    assert.ok(/Согласие на OpenAI спрашивается отдельно/.test(await text('[data-card="llm"] .notice')));
    assert.deepStrictEqual(await get(["engine", "llmProvider", "llmApiKey"]), { engine: "llm", llmProvider: "openai", llmApiKey: OPENAI_KEY }, "переводит прежний сервис");
    await shots("llm-claude-consent", '[data-card="llm"]');
    await click('[data-fk="cancel"]');
    c = await card("llm");
    assert.strictEqual(c.tag, "Подключён", "«Отмена» вернула ChatGPT");
    assert.strictEqual(await ev("document.querySelector('[data-fk=svc-openai]').getAttribute('aria-checked')"), "true");
    // снова Claude: согласие, затем ключ OpenAI по ошибке — не принят, переводит по-прежнему ChatGPT
    await click('[data-fk="svc-anthropic"]');
    await click('[data-fk="allow-anthropic"]');
    s = await get(["consent", "engine", "llmProvider"]);
    assert.deepStrictEqual(s, { consent: { deepl: false, openai: true, anthropic: true }, engine: "llm", llmProvider: "openai" });
    assert.strictEqual(await ev("document.querySelector('label[for=llm-key]').textContent"), "Ключ Anthropic");
    const nA = api.log.length;
    // всё, что страница пишет про ИИ в хранилище, — до «Готово» не должно быть ничего
    await ev(`(() => { self.__llmWrites = []; chrome.storage.onChanged.addListener((ch, area) => { if (area === "local")
      for (const k of ["llmProvider", "llmApiKey", "llmModel", "llmVerified", "llmKeyBy"]) if (k in ch) self.__llmWrites.push(k); }); return true; })()`);
    await paste("#llm-key", OPENAI_KEY);
    await until(async () => (await card("llm")).tag === "Ключ не принят", 8000);
    c = await card("llm");
    assert.strictEqual(c.msg, "Похоже, это ключ другого сервиса. Вставьте ключ Anthropic.");
    assert.ok(!api.log.slice(nA).some((p) => p.startsWith("/anthropic")), "ключ OpenAI в Anthropic не ушёл");
    assert.deepStrictEqual(await get(["engine", "llmProvider", "llmApiKey", "llmVerified"]),
      { engine: "llm", llmProvider: "openai", llmApiKey: OPENAI_KEY, llmVerified: true }, "не прошло — всё как было");
    assert.deepStrictEqual(JSON.parse(await ev("JSON.stringify(self.__llmWrites)")), [], "проверка ничего не писала в хранилище");
    await paste("#llm-key", CLAUDE_KEY);
    await until(async () => (await card("llm")).tag === "Подключён", 8000);
    s = await get(["engine", "llmProvider", "llmApiKey", "llmVerified", "llmKeyBy"]);
    assert.deepStrictEqual(s, { engine: "llm", llmProvider: "anthropic", llmApiKey: CLAUDE_KEY, llmVerified: true, llmKeyBy: { openai: OPENAI_KEY, anthropic: CLAUDE_KEY } });
    assert.ok(api.log.slice(nA).includes("/anthropic/v1/messages"));
    // правят ключ Claude по буквам — переводит прежний (записанный) ключ, в хранилище ничего не меняется
    const w0 = JSON.parse(await ev("JSON.stringify(self.__llmWrites)")).length;
    await ev("(() => { const i = document.querySelector('#llm-key'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()");
    await pt.cmd("Input.insertText", { text: "z" });
    await sleep(500);
    c = await card("llm");
    assert.strictEqual(c.steps, "done:Согласие | cur:2Ключ | :3Готово");
    assert.strictEqual(c.wait, "Пока переводит Claude");
    assert.strictEqual((await get(["llmApiKey"])).llmApiKey, CLAUDE_KEY);
    assert.strictEqual(JSON.parse(await ev("JSON.stringify(self.__llmWrites)")).length, w0, "черновик ключа не записан");
    await paste("#llm-key", CLAUDE_KEY);
    await until(async () => (await card("llm")).tag === "Подключён", 8000);
    ok("ИИ: ChatGPT готов — переключился сразу; «Claude» в сегменте — свой шаг согласия («Пока переводит ChatGPT», «Отмена» возвращает ChatGPT), ключ OpenAI не уходит в Anthropic, а проверка ничего не пишет в хранилище; ключ Claude принят — записан и переводит Claude, ключ OpenAI ждёт в llmKeyBy; правка ключа — черновик до проверки");

    // ---- ИИ с переводчиком «встроенный»: согласие спрашивается для выбранного сервиса ----
    await store({ engine: "chrome", consent: { deepl: true }, llmProvider: "anthropic", llmApiKey: "", llmVerified: false, llmKeyBy: {} });
    await reload();
    await click('[data-card="llm"] .rc-head');
    c = await card("llm");
    assert.strictEqual(c.steps, "cur:1Согласие | :2Ключ | :3Готово");
    assert.strictEqual(c.wait, "Пока переводит встроенный");
    assert.deepStrictEqual(c.btns, ["Разрешить отправку", "Отмена"]);
    assert.strictEqual((await get(["engine"])).engine, "chrome");
    ok("д · ИИ при встроенном: шаг согласия на Anthropic, «Пока переводит встроенный», «Отмена»");

    // ---- фокус по просьбе окна расширения ----
    await store({ engine: "deepl", consent: { deepl: true }, apiKey: "", keyVerified: false });
    await reload();
    await ev("document.querySelector('#nav .nav-a').focus(); scrollTo({ top: 0, behavior: 'instant' }); true");
    await ev(`chrome.storage.session.set({ htFocus: { to: "deepl-key", at: Date.now() } }).then(() => true)`);
    await until(async () => (await ev("document.activeElement.id")) === "deepl-key", 3000);
    assert.strictEqual(await ev("document.activeElement.id"), "deepl-key", "фокус в поле ключа DeepL");
    assert.ok(await ev("(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"), "поле видно");
    assert.strictEqual(await ev("chrome.storage.session.get('htFocus').then((s) => JSON.stringify(s))"), "{}", "htFocus снят");
    // устаревшая просьба (старше 10 с) — не трогаем
    await ev(`chrome.storage.session.set({ htFocus: { to: "data", at: Date.now() - 60000 } }).then(() => true)`);
    await sleep(400);
    assert.strictEqual(await ev("document.activeElement.id"), "deepl-key");
    // через background: openSettings — та же вкладка, фокус на языке перевода
    await ev(`chrome.runtime.sendMessage({ type: "openSettings", focus: "target-lang" }).then(() => true)`);
    await until(async () => (await ev("document.activeElement.id")) === "targetLang", 4000);
    assert.strictEqual(await ev("document.activeElement.id"), "targetLang");
    const tabs = JSON.parse(await ev(`chrome.tabs.query({}).then((ts) => JSON.stringify(ts.filter((t) => (t.url || '').includes('options.html')).length))`));
    assert.strictEqual(tabs, 1, "страница настроек одна");
    // при загрузке страницы: «llm-key» — раскрыть ИИ, нет согласия — фокус на «Разрешить отправку». Пока страница
    // открыта, она сама снимет просьбу — поэтому сначала уходим с неё, просьбу кладёт service worker.
    await pt.cmd("Page.navigate", { url: "about:blank" }); await sleep(400);
    await sw.ev(`chrome.storage.session.set({ htFocus: { to: "llm-key", at: Date.now() } }).then(() => true)`);
    await pt.cmd("Page.navigate", { url: EXT + "options.html" }); await sleep(600); await ready();
    await until(async () => (await ev("document.activeElement.dataset.fk")) === "allow-anthropic", 3000);
    assert.strictEqual(await ev("document.activeElement.dataset.fk"), "allow-anthropic");
    ok("htFocus: «deepl-key» — фокус в поле ключа и оно на экране, просьба снимается; старше 10 с — не действует; openSettings от background — та же вкладка, фокус на «Язык перевода»; при загрузке «llm-key» без согласия — фокус на «Разрешить отправку»");

    // ---- «Удалить» сохранённые переводы ----
    await store({ engine: "deepl", consent: { deepl: true }, apiKey: DEEPL_KEY, keyVerified: true });
    const tr = JSON.parse(await ev(`chrome.runtime.sendMessage({ type: "translateBatch", engine: "deepl", targetLang: "RU", sourceLang: "auto", formality: "default",
      noTranslate: "", by: "user-initiated", items: ["First saved text", "Second saved text"] }).then((r) => JSON.stringify(r))`));
    assert.ok(tr && tr.ok, "перевели через заглушку: " + JSON.stringify(tr));
    await until(async () => (JSON.parse(await ev("chrome.runtime.sendMessage({ type: 'getStats' }).then((r) => JSON.stringify(r))"))).entries >= 2, 5000);
    await reload();
    const [savedA, savedB] = msg("opSavedD_few", ["2", "@"]).split("@");    // «2 перевода, » … «. Хранятся 14 дней…»
    await until(async () => (await text("#savedD")).startsWith(savedA), 4000);
    const saved = await text("#savedD");
    console.log("      (сохранено: «" + saved + "»)");
    assert.ok(saved.startsWith(savedA) && saved.endsWith(savedB) && /^\d+ КБ$/.test(saved.slice(savedA.length, saved.length - savedB.length)), saved);
    await shots("data", "#data");
    await click("#clearCache");
    await until(async () => /^Пока ничего нет/.test(await text("#savedD")), 5000);
    const st2 = JSON.parse(await ev("chrome.runtime.sendMessage({ type: 'getStats' }).then((r) => JSON.stringify(r))"));
    assert.ok(st2.ok && st2.entries === 0 && st2.chars === 0, "удалено и счётчики обнулены: " + JSON.stringify(st2));
    assert.strictEqual(await ev("document.querySelector('#clearCache').disabled"), true, "удалять больше нечего");
    ok("«Удалить»: «2 перевода, N КБ. Хранятся 14 дней…» → «Пока ничего нет…», записей 0, счётчики обнулены");

    // ---- «Показывать плавающую кнопку»: последняя строка «На странице», пишет hudShown, кружок на вкладке сайта ----
    await store({ hudShown: false });
    const web = await b.openTab(srv.base + "/live.html");
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    await b.cmd("Target.activateTarget", { targetId: pt.targetId }); await sleep(200);
    const fabOnTab = async () => !!(await pageUi(web)).hud;
    const fabRow = () => ev(`(() => { const rows = [...document.querySelectorAll('#page .card-row')];
      const r = rows.find((x) => (x.querySelector('.cr-t') || {}).textContent === ${JSON.stringify(msg("opFab"))}); if (!r) return "null";
      const s = r.querySelector('[role=switch]'); s.scrollIntoView({ block: "center", behavior: "instant" }); const q = s.getBoundingClientRect();
      return JSON.stringify({ last: r === rows[rows.length - 1], d: (r.querySelector('.cr-d') || {}).textContent, checked: s.getAttribute('aria-checked'),
        x: q.left + q.width / 2, y: q.top + q.height / 2 }); })()`).then(JSON.parse);
    let fr = await fabRow();
    assert.ok(fr, "строка «Показывать плавающую кнопку» в разделе «На странице»");
    assert.deepStrictEqual([fr.last, fr.d, fr.checked], [true, msg("opFabD"), "false"], "последняя строка раздела, описание, выключено");
    assert.strictEqual(await fabOnTab(), false, "кружка на вкладке нет");
    await pt.click(fr.x, fr.y); await sleep(250);
    assert.ok(await until(async () => (await get(["hudShown"])).hudShown === true, 3000), "переключатель записал hudShown = true");
    assert.strictEqual((await fabRow()).checked, "true");
    assert.ok(await until(fabOnTab, 4000), "кружок появился на вкладке сайта");
    await web.shot("options-fab-on-tab.png", { clip: { x: 500, y: 460, width: 500, height: 300, scale: 1 } });
    await shots("page-fab", "#page");
    fr = await fabRow();
    await pt.click(fr.x, fr.y); await sleep(250);
    assert.ok(await until(async () => (await get(["hudShown"])).hudShown === false, 3000), "переключатель записал hudShown = false");
    assert.strictEqual((await fabRow()).checked, "false");
    assert.ok(await until(async () => !(await fabOnTab()), 4000), "кружок исчез с вкладки");
    // кружок показали из окна или меню — переключатель это видит
    await store({ hudShown: true });
    assert.ok(await until(async () => (await fabRow()).checked === "true", 3000), "hudShown = true извне — переключатель включён");
    await store({ hudShown: false });
    assert.ok(await until(async () => (await fabRow()).checked === "false", 3000));
    await b.cmd("Target.closeTarget", { targetId: web.targetId });
    ok("«Показывать плавающую кнопку» — последняя строка «На странице» с описанием; переключатель пишет hudShown, кружок на открытой вкладке сайта появляется и исчезает; изменение извне (окно, меню кружка) переключатель подхватывает");

    // ---- «Сбросить настройки»: подтверждение на месте; ключи, сохранённые переводы и счётчики остаются ----
    // Счётчики ведёт background (в памяти) и пишет в хранилище с задержкой 1,5 с: отложенная запись после
    // переводов выше иначе затёрла бы подставленное ниже значение нулём. Ждём её, потом подставляем.
    await sleep(1700);
    await ev("chrome.storage.local.set({ statChars: 1234 }).then(() => true)");
    await store({ engine: "deepl", consent: { deepl: true, anthropic: true }, apiKey: DEEPL_KEY, keyVerified: true, trigger: "alt", dwellMs: 900,
      targetLang: "DE", sourceLang: "EN", displayMode: "popover", showLangBadge: false, formality: "more", noTranslate: "Foo", dispMode: "custom",
      dispBg: "#8fb8ff", dispOpacity: 50, disabledSites: ["a.com"], recentLangs: ["DE", "FR"], hudShown: true, hudPos: { side: "left", top: 10 },
      enabled: false, llmProvider: "anthropic", llmApiKey: CLAUDE_KEY, llmVerified: true, llmModel: "claude-sonnet-5-5", llmKeyBy: { openai: OPENAI_KEY } });
    await reload();
    const resetUi = () => ev(`JSON.stringify({ t: document.querySelector('#resetT').textContent, d: document.querySelector('#resetD').textContent,
      btn: !document.querySelector('#resetBtn').hidden, yes: !document.querySelector('#resetYes').hidden, no: !document.querySelector('#resetNo').hidden,
      focus: document.activeElement.id })`).then(JSON.parse);
    const u0 = await resetUi();
    delete u0.focus;
    assert.deepStrictEqual(u0, { t: msg("opResetT"), d: msg("opResetD"), btn: true, yes: false, no: false });
    await click("#resetBtn");
    assert.deepStrictEqual(await resetUi(), { t: msg("opResetQ"), d: msg("opResetD"), btn: false, yes: true, no: true, focus: "resetNo" });
    await click("#resetNo");
    assert.deepStrictEqual(await resetUi(), { t: msg("opResetT"), d: msg("opResetD"), btn: true, yes: false, no: false, focus: "resetBtn" });
    await click("#resetBtn");
    await press("Escape", 27);
    await sleep(150);
    assert.strictEqual((await resetUi()).btn, true, "Esc — отмена");
    assert.strictEqual((await get(["engine"])).engine, "deepl", "отмена ничего не сбросила");
    await click("#resetBtn");
    await click("#resetYes");
    await until(async () => (await resetUi()).d === msg("opResetDone"), 3000);
    const after = await get(null);
    const want = { engine: "chrome", trigger: "shift", dwellMs: 600, targetLang: "RU", sourceLang: "auto", displayMode: "replace", showLangBadge: true,
      formality: "default", noTranslate: "", dispMode: "auto", dispBg: "#ffcf4a", dispOpacity: 35, consent: {}, disabledSites: [], recentLangs: [],
      hudShown: false, enabled: true,
      apiKey: DEEPL_KEY, keyVerified: true, llmProvider: "anthropic", llmApiKey: CLAUDE_KEY, llmVerified: true, llmModel: "claude-sonnet-5-5",
      llmKeyBy: { openai: OPENAI_KEY }, statChars: 1234 };
    for (const k in want) assert.deepStrictEqual(after[k], want[k], k + ": " + JSON.stringify(after[k]));
    assert.ok(!("hudPos" in after), "место плавающей кнопки — по умолчанию");
    // страница перерисована из хранилища
    const shown = JSON.parse(await ev(`JSON.stringify({ trig: document.querySelector('#trigger [aria-checked=true]').dataset.v, tgt: document.querySelector('#targetLang').value,
      words: document.querySelector('#noTranslate').value, sites: document.querySelectorAll('#siteList li').length, sel: ui.sel,
      card: document.querySelector('#engines .rcard.on').dataset.card, disp: document.querySelector('input[name=displayMode]:checked').value })`));
    assert.deepStrictEqual(shown, { trig: "shift", tgt: "RU", words: "", sites: 0, sel: "chrome", card: "chrome", disp: "replace" });
    await shots("data-reset", "#data");
    ok("«Сбросить настройки»: «Сбросить» → «Сбросить все настройки?» + «Сбросить»/«Отмена» (фокус на «Отмене», Esc — отмена); сброс — к значениям установки, ключи DeepL и ИИ (с сервисом и моделью), сохранённое и счётчики остаются; страница перерисована");

    // ---- кольцо фокуса: после мыши и при открытии из окна расширения — нет, с клавиатуры — одно, у карточки ----
    await store({ engine: "chrome", consent: { deepl: true }, apiKey: DEEPL_KEY, keyVerified: true });
    await reload();
    await click('[data-card="deepl"] .rc-head .rc-t');
    await until(async () => (await ev("document.activeElement.dataset.fk || ''")) === "eng-deepl", 2000);
    assert.strictEqual(await ev("document.activeElement.matches(':focus-visible')"), false, "щелчок мышью — без кольца");
    await pt.cmd("Page.navigate", { url: "about:blank" }); await sleep(300);
    await sw.ev(`chrome.storage.session.set({ htFocus: { to: "translator", at: Date.now() } }).then(() => true)`);
    await pt.cmd("Page.navigate", { url: EXT + "options.html" }); await sleep(600); await ready();
    await until(async () => (await ev("document.activeElement.dataset.fk || ''")) === "eng-deepl", 3000);
    assert.strictEqual(await ev("document.activeElement.matches(':focus-visible')"), false, "открыли из окна — без кольца");
    await press("ArrowDown", 40);
    await until(async () => (await ev("document.activeElement.dataset.fk || ''")) === "eng-auto", 2000);
    const ring = JSON.parse(await ev(`(() => { const a = document.activeElement, c = a.closest('.rcard'), s = getComputedStyle(c), r = getComputedStyle(a);
      return JSON.stringify({ fv: a.matches(':focus-visible'), cardOutline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineOffset, radioOutline: r.outlineStyle }); })()`));
    assert.deepStrictEqual(ring, { fv: true, cardOutline: "solid 3px 0px", radioOutline: "none" }, JSON.stringify(ring));
    await store({ engine: "chrome" });
    ok("кольцо фокуса: щелчок по карточке и открытие из окна — без кольца; стрелка — один ореол у карточки (3 px без отступа), у кружка своего нет");

    // ---- узкое окно: полоса вкладок ----
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const nav = JSON.parse(await ev(`(() => { const n = document.querySelector('#nav'); const s = getComputedStyle(n);
      return JSON.stringify({ dir: s.flexDirection, pos: s.position, h: document.querySelector('#nav .nav-a').getBoundingClientRect().height, scroll: n.scrollWidth > n.clientWidth }); })()`));
    assert.deepStrictEqual(nav, { dir: "row", pos: "sticky", h: 40, scroll: true }, JSON.stringify(nav));
    await shots("narrow");
    ok("уже 880 px: меню — липкая полоса вкладок высотой 40 с прокруткой вбок");

    assert.deepStrictEqual(pageErrors, [], "исключения в консоли");
    console.log("      (исключения в консоли: нет)");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await api.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); process.exit(1); });
