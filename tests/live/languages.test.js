// Языки вживую: настоящее расширение в Chrome без интерфейса с английским и русским языком браузера.
// Проверяет: язык интерфейса — по языку браузера; при установке язык перевода — English (US) для английского
// браузера и русский для русского; в видимом тексте приветствия (и в его состоянии «Подключите переводчик»), окна
// (настоящего и всех 19 состояний), уведомлений и плавающей кнопки (кружок и меню) на английском нет кириллицы, на русском — английских
// слов, кроме названий сервисов, клавиш и самого расширения; нигде нет «абзац» / «paragraph»; пустых текстов нет;
// значок расширения на приветствии и в окне — векторный (чёткий на экране ×2); в английском окне все 19 состояний
// влезают (место действия 72, подсказки в одну строку, ничего не обрезано, подвал ≤ 182 px, ряды одной высоты, окно
// ≤ 600) — русское проверяет live/popup.test.js; длинное имя сайта режется с начала («…garden-example.co.uk»),
// целиком — в подсказке; подсказка значка и описания горячих клавиш переведены; на новом сайте Chrome скрывает
// готовность пары с языком не из языков браузера (на этом стоит подсказка «щёлкните по тексту» в content.js).
// Скриншоты (светлая и тёмная тема) — с tests/run.sh --shots.
// Запуск: node tests/live/languages.test.js [en|ru] (без аргумента — оба).
const assert = require("assert");
const { launch, sleep, until } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { pageUi, fabUi, clickUi, popupOpener, popupView, prepareBuiltin } = require("../lib/live");
let LIVE = "";
const LANGS = process.argv[2] ? [process.argv[2]] : ["en", "ru"];
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// Английские слова, допустимые в русском интерфейсе: название, сервисы, модели, клавиши, адреса.
const RU_ALLOWED = new Set(["Hover", "Translator", "DeepL", "OpenAI", "Anthropic", "ChatGPT", "Claude", "Chrome", "Google", "GPT",
  "Haiku", "Sonnet", "Opus", "gpt", "Shift", "Alt", "Ctrl", "Esc", "Option", "Cmd", "API", "Keys", "Free", "fx", "deepl", "com", "pro", "api",
  "chrome", "extensions", "shortcuts", "EN", "RU", "GitHub", "Vue", "Kubernetes", "sk"]);
function langProblems(lang, texts) {
  const words = texts.filter((t) => /абзац|paragraph|párrafo/i.test(t));
  if (lang === "en") return words.concat(texts.filter((t) => /[А-Яа-яЁё]/.test(t)));
  return words.concat(texts.filter((t) => (t.match(/[A-Za-z]{2,}/g) || []).some((w) => !RU_ALLOWED.has(w))));
}

// Видимый текст страницы расширения: текстовые узлы и подписи (title, aria-label, placeholder), кроме самоназваний
// языков (списки, недавние языки), текста для пробы и имени сайта (оно — не текст интерфейса).
const PAGE_TEXT = `(() => {
  const skip = (el) => !el || !!el.closest("script, style, select, .chip, .try, .srow-t b") || el.matches("[data-full]");
  const out = [document.title];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.nodeValue.trim(); if (t && !skip(n.parentElement)) out.push(t); }
  for (const el of document.querySelectorAll("[title], [aria-label], [placeholder]")) {
    if (skip(el)) continue;
    for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v) out.push(v); }
  }
  const empty = [...document.querySelectorAll("[data-i18n]")].filter((e) => !e.textContent.trim()).map((e) => e.dataset.i18n);
  return { texts: out, empty };
})()`;

// Вёрстка окна: место действия 72, однострочное не переносится, ничего не обрезано и не вылезает за
// край, подвал ≤ 182 px.
const LAYOUT = `(() => {
  const out = [];
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); const c = [...r.getClientRects()].filter((q) => q.height > 8).map((q) => q.top + q.height / 2).sort((a, b) => a - b); return c.filter((v, i) => i === 0 || v - c[i - 1] > 10).length; };
  const name = (el) => String(el.className || el.tagName).split(" ")[0] + " «" + el.textContent.trim().slice(0, 40) + "»";
  for (const el of document.querySelectorAll(".p-act, .p-off")) if (Math.round(el.getBoundingClientRect().height) !== 72) out.push("не 72: " + name(el));
  for (const el of document.querySelectorAll(".p-act > .hint, .p-off-t, .p-off-d, .chip:not([hidden]), .seg button, .p-scope > span, .p-title, .lbl, .srow-t, .st-t, .prog-top span, .p-busy-t")) {
    if (vis(el) && lines(el) > 1) out.push("переносится: " + name(el));
  }
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el) || el.closest("svg") || el.matches("select, option")) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX !== "visible") out.push("обрезано: " + name(el));
    if (el.getBoundingClientRect().right > innerWidth + 0.5) out.push("за правым краем: " + name(el));
  }
  const st = document.querySelector(".st-t");
  if (st && st.getBoundingClientRect().width > 182.5) out.push("подвал шире 182: " + st.textContent);
  if (document.documentElement.scrollWidth > innerWidth) out.push("горизонтальная прокрутка");
  return out;
})()`;

// Факты для 19 состояний окна (HT_popup.show) — как в live/popup.test.js: вкладка medium.com.
function stateFacts(tabId, target) {
  const now = Date.now();
  const S = { enabled: true, targetLang: target, sourceLang: "auto", engine: "chrome", trigger: "shift", llmProvider: "openai",
    apiKey: false, apiKeyFree: true, llmApiKey: false, consent: { deepl: false, openai: false, anthropic: false },
    recentLangs: [target, "DE", "FR", "ES"], disabledSites: [] };
  const TAB = { id: tabId, url: "https://medium.com/story", kind: "web", loading: false };
  const src = target === "EN-US" ? "es" : "en", tgt = target === "EN-US" ? "en" : "ru";
  const TS = { ok: true, hud: false, site: "medium.com", siteOff: false, lang: src, page: "idle", done: 0, total: 0, count: 0, src: "" };
  const READY = { kind: "ready", src, tgt }, NEED = { kind: "need", src, tgt };
  const f = (o) => ({ s: Object.assign({}, S, o.s), tab: Object.assign({}, TAB, o.tab), ts: o.ts === null ? null : Object.assign({}, TS, o.ts),
    bi: o.bi || READY, dl: o.dl || null, net: o.net || null, hasApi: o.hasApi !== false, doing: "", keys: { toggle: "Alt+Shift+O", page: "Alt+Shift+G" } });
  const deepl = { engine: "deepl", apiKey: true, consent: { deepl: true } };
  const net = (code) => ({ code, via: "deepl", provider: "deepl", at: now });
  return [
    [0, "normal", f({})],
    [1, "first-run", f({ s: { recentLangs: [] }, bi: NEED })],
    [2, "downloading", f({ s: { recentLangs: [] }, bi: NEED, dl: { run: true, pct: 42 } })],
    [3, "busy", f({ ts: { page: "busy", done: 8, total: 12 } })],
    [4, "done", f({ ts: { page: "done", src } })],
    [5, "orig", f({ ts: { page: "orig", src } })],
    [6, "part", f({ ts: { page: "part", count: 3 } })],
    [7, "already", f({ ts: { lang: tgt, site: "habr.com" } })],
    [8, "site-off", f({ s: { disabledSites: ["medium.com"] } })],
    [9, "all-off", f({ s: { enabled: false } })],
    [10, "closed", f({ tab: { url: "chrome://extensions/", kind: "closed" }, ts: null })],
    [11, "reload", f({ ts: null })],
    [12, "no-builtin", f({ hasApi: false, bi: { kind: "none" } })],
    [13, "lang", f({ s: { targetLang: "AF", recentLangs: ["AF", "DE", "FR", "ES"] }, bi: { kind: "no-lang" } })],
    [14, "dl-fail", f({ s: { recentLangs: [] }, bi: NEED, dl: { fail: true } })],
    [15, "consent", f({ s: { engine: "deepl", apiKey: true } })],
    [16, "no-key", f({ s: { engine: "deepl", consent: { deepl: true } } })],
    [17, "bad-key", f({ s: deepl, net: net("bad-key") })],
    [18, "quota", f({ s: deepl, net: net("quota") })],
    [19, "offline", f({ s: deepl, net: net("network") })],
  ];
}
// Ряды окна одной высоты (как на макете PopupStates): 1–2, 3–9 (с обычным 0), 10–11.
const ROWS = [[1, 2], [0, 3, 4, 5, 6, 7, 8, 9], [10, 11]];

async function runLang(lang) {
  console.log(`\n=== язык браузера: ${lang}`);
  const b = await launch({ lang, profile: process.env.HT_PROFILE || null });
  const errors = [];
  b.listeners.push((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); });
  const theme = (tab, dark) => tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  const TARGET = lang === "en" ? "EN-US" : "RU";
  try {
    const extDir = b.copyExt();   // новый путь — новая установка (onInstalled)
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: extDir });
    const EXT = `chrome-extension://${id}/`;
    // ---- установка: приветствие открылось, язык перевода — по языку браузера ----
    const welcomeTarget = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html"), 8000);
    assert.ok(welcomeTarget, "при установке открылась страница приветствия");
    const swT = (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js");
    const sw = await b.attach(swT.targetId);
    const store = (o) => sw.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    const msg = (key, subs) => sw.ev(`chrome.i18n.getMessage(${JSON.stringify(key)}${subs != null ? ", " + JSON.stringify(subs) : ""})`);
    const NAME = await msg("extShortName");
    const w = await b.attach(welcomeTarget.targetId);
    const stored = await until(() => w.ev("chrome.storage.local.get(['targetLang', 'trigger']).then((s) => s.targetLang ? JSON.stringify(s) : '')"), 5000);
    const ui = await w.ev("JSON.stringify([chrome.i18n.getUILanguage(), chrome.i18n.getMessage('uiLocale'), document.documentElement.lang])");
    console.log(`      (язык интерфейса Chrome / файл сообщений / lang страницы: ${ui}; записано при установке: ${stored})`);
    assert.strictEqual(JSON.parse(stored).targetLang, TARGET);
    assert.strictEqual(JSON.parse(ui)[1], lang);
    ok(`${lang}: интерфейс на языке браузера; при установке язык перевода — ${TARGET}, открыто приветствие`);

    // ---- приветствие: готовим встроенный (для английского браузера — испанский → английский), тексты ----
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    const stage = await prepareBuiltin(w);
    const wInfo = JSON.parse(await w.ev(`JSON.stringify({ stage: document.querySelector('#step2').dataset.stage, h1: document.querySelector('.wl-h1').textContent,
      lead: document.querySelector('#lead').textContent, ok: (document.querySelector('.w-ok') || {}).textContent || "",
      trainer: [...document.querySelectorAll('#try p')].filter((p) => !p.hidden).map((p) => p.lang), title: document.title })`));
    console.log("      (приветствие: " + JSON.stringify(wInfo) + ")");
    assert.ok(/^(ready|ready-hover|success)$/.test(stage), "встроенный готов: " + stage);
    assert.deepStrictEqual(wInfo.trainer, [lang === "en" ? "es" : "en"], "текст для пробы — на языке пары, которую готовит встроенный");
    assert.strictEqual(wInfo.h1, NAME);
    const wTexts = [];
    const wShots = async (name) => {
      for (const dark of [false, true]) {
        await theme(w, dark);
        const h = await w.ev("Math.ceil(document.documentElement.scrollHeight)");
        await w.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        await w.shot(`welcome-${lang}-${name}-${dark ? "dark" : "light"}.png`);
      }
      await theme(w, false);
      await w.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    let wt = await w.ev(PAGE_TEXT);
    assert.deepStrictEqual(wt.empty, [], "пустые тексты");
    wTexts.push(...wt.texts);
    assert.ok(!/абзац|paragraph|párrafo/i.test(await w.ev("document.body.textContent")), "«абзац»/«paragraph» на приветствии (с текстами для пробы)");
    await wShots("ready");
    // «Подключите переводчик»: DeepL без ключа и согласия
    await store({ engine: "deepl", apiKey: "", consent: {} });
    assert.ok(await until(async () => (await w.ev("document.querySelector('#step2').dataset.stage")) === "problem", 4000), "приветствие — «Подключите переводчик»");
    wt = await w.ev(PAGE_TEXT);
    assert.deepStrictEqual(wt.empty, []);
    wTexts.push(...wt.texts);
    const probT = await w.ev("document.querySelector('#s2top .notice-t').textContent");
    assert.strictEqual(probT, await msg("probTitle"));
    await wShots("problem");
    await store({ engine: "chrome" });
    assert.ok(await until(async () => /^(ready|ready-hover|success)$/.test(await w.ev("document.querySelector('#step2').dataset.stage")), 4000));
    const wBad = langProblems(lang, [...new Set(wTexts)]);
    assert.deepStrictEqual(wBad, [], "чужой язык в тексте приветствия");
    ok(`${lang}: приветствие («Готово» и «Подключите переводчик») — ${new Set(wTexts).size} строк без чужого языка и без «абзац/paragraph», пустых нет; заголовок — «${NAME}»; скриншоты welcome-${lang}-*.png`);

    // ---- значок расширения на приветствии и в окне — векторный (на экране ×2 чёткий) ----
    const hi = await b.openTab("about:blank");
    await hi.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
    const logoAt = async (page, sel) => {
      await hi.cmd("Page.navigate", { url: EXT + page });
      return until(() => hi.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return ""; const r = e.getBoundingClientRect();
        return JSON.stringify({ tag: e.tagName, w: Math.round(r.width), h: Math.round(r.height), img: document.querySelectorAll('img[src*="icons/"]').length }); })()`), 5000);
    };
    const logos = [JSON.parse(await logoAt("welcome.html", ".wl-logo svg")), JSON.parse(await logoAt("popup.html", ".p-head svg"))];
    await b.cmd("Target.closeTarget", { targetId: hi.targetId });
    console.log("      (значок на ×2: приветствие " + JSON.stringify(logos[0]) + ", окно " + JSON.stringify(logos[1]) + ")");
    assert.deepStrictEqual(logos, [{ tag: "svg", w: 56, h: 56, img: 0 }, { tag: "svg", w: 24, h: 24, img: 0 }], "значки — svg 56 и 24, без растровых картинок");
    ok(`${lang}: значок на приветствии (56) и в окне (24) — векторный svg, растровых картинок значка нет (чёткий на экране ×2)`);

    // ---- на чём стоит подсказка «щёлкните по тексту» (content.js, hiddenLang) ----
    // Пару с языком не из языков браузера Chrome на новом сайте показывает как «downloadable», хотя на приветствии её
    // только что скачали; английский и языки браузера — как есть. Поменяет Chrome правило — подсказка станет неверной.
    for (const t of (await b.cmd("Target.getTargets")).targetInfos) {
      if (t.type === "page" && !t.url.startsWith(EXT)) await b.cmd("Target.closeTarget", { targetId: t.targetId });
    }
    const web = await b.openTab(LIVE);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    const prep = JSON.parse(await w.ev("JSON.stringify(HT_prepPair(document.querySelector('#targetLang').value))"));
    const avail = (tab) => tab.ev(`Translator.availability({ sourceLanguage: "${prep.src}", targetLanguage: "${prep.tgt}" })`);
    const siteAv = await avail(web), extAv = await avail(w);
    const langs = await web.ev("JSON.stringify(navigator.languages)");
    const hidden = ![prep.src, prep.tgt].every((l) => l === "en" || JSON.parse(langs).some((x) => x.split("-")[0] === l));
    console.log(`      (пара ${prep.src} → ${prep.tgt}: на приветствии ${extAv}, на новом сайте ${siteAv}; языки браузера ${langs})`);
    assert.strictEqual(siteAv, extAv === "available" && !hidden ? "available" : "downloadable", "готовность пары на новом сайте");
    ok(`${lang}: пара ${prep.src} → ${prep.tgt} на новом сайте — «${siteAv}» (${hidden ? "язык не из языков браузера — Chrome её скрывает" : "языки браузера — как есть"})`);

    // ---- окно по значку (обычное состояние) ----
    await store({ enabled: true, engine: "chrome", sourceLang: "auto", trigger: "shift", displayMode: "replace", apiKey: "", llmApiKey: "", consent: {},
      recentLangs: lang === "en" ? ["EN-US", "DE", "ES"] : ["RU", "DE", "EN-US"] });
    const allText = [];
    const pop = popupOpener(b, id);
    let p = await pop.open(web, (u) => u.startsWith(LIVE));
    const real = JSON.parse(await p.ev(`JSON.stringify({ n: HT_popup.view().n, h: Math.ceil(document.body.getBoundingClientRect().height),
      noScroll: document.documentElement.scrollHeight <= innerHeight, hint: document.querySelector(".p-act > .hint").textContent })`));
    console.log("      (окно по значку: " + JSON.stringify(real) + ")");
    assert.ok(real.h <= 600 && real.noScroll, "обычное состояние ≤ 600 px без прокрутки: " + real.h);
    const t0 = await p.ev(PAGE_TEXT);
    assert.deepStrictEqual(t0.empty, []);
    allText.push(...t0.texts);
    if (lang === "en") assert.deepStrictEqual(await p.ev(LAYOUT), [], "вёрстка окна по значку");
    await pop.close();

    // ---- все 19 состояний окна (вид по модели) в обеих темах ----
    const pt = await b.openTab(EXT + "popup.html");
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    await until(() => pt.ev("!!(window.HT_popup && HT_popup.view())").catch(() => false), 8000);
    const tid = await pt.ev("HT_popup.facts.tab ? HT_popup.facts.tab.id : 1");
    const heights = {};
    for (const dark of [false, true]) {
      await theme(pt, dark);
      for (const [n, name, facts] of stateFacts(tid, TARGET)) {
        const got = await pt.ev(`HT_popup.show(${JSON.stringify(facts)}).n`);
        assert.strictEqual(got, n, name);
        await pt.ev("document.fonts.ready.then(() => true)");
        const t = await pt.ev(PAGE_TEXT);
        assert.deepStrictEqual(t.empty, [], name + ": пустые тексты");
        allText.push(...t.texts);
        const h = await pt.ev("Math.ceil(document.body.getBoundingClientRect().height)");
        if (!dark) heights[n] = h;
        // русскую вёрстку проверяет live/popup.test.js (с высотами макета); здесь — английская
        if (lang === "en") {
          assert.deepStrictEqual(await pt.ev(LAYOUT), [], `${n} ${name} (${dark ? "тёмная" : "светлая"}): вёрстка`);
          assert.ok(h <= 600, `${n} ${name}: окно ${h} px`);
        }
        if (process.env.HT_SHOTS) {
          await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false });
          await sleep(100);
          await pt.shot(`popup-${lang}-${String(n).padStart(2, "0")}-${name}-${dark ? "dark" : "light"}.png`);
          await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
        }
      }
    }
    await theme(pt, false);
    console.log("      (высоты окна: " + Object.entries(heights).map(([n, h]) => n + ":" + h).join(" ") + ")");
    if (lang === "en") for (const row of ROWS) assert.strictEqual(new Set(row.map((n) => heights[n])).size, 1, "ряд одной высоты: " + row.map((n) => n + ":" + heights[n]).join(" "));

    // ---- длинное имя сайта: режется с начала, целиком — в подсказке ----
    const siteCut = async (site) => {
      const f = stateFacts(tid, TARGET)[0][2];
      f.ts.site = site;
      await pt.ev(`HT_popup.show(${JSON.stringify(f)}).n`);
      return JSON.parse(await pt.ev(`(() => { const row = document.querySelector(".srow"), t = row.querySelector(".srow-t"), b = t.querySelector("b");
        const rg = document.createRange(); rg.selectNodeContents(t);
        return JSON.stringify({ shown: b.textContent, title: row.title, fits: rg.getBoundingClientRect().width <= t.getBoundingClientRect().width + 0.5,
          h: Math.round(row.getBoundingClientRect().height) }); })()`));
    };
    const SHORT_SITE = "medium.com", LONG_SITE = "shop.garden-example-supplies.co.uk";
    const s1 = await siteCut(SHORT_SITE), s2 = await siteCut(LONG_SITE);
    console.log(`      (строка сайта: ${JSON.stringify(s1)} / ${JSON.stringify(s2)})`);
    assert.ok(s1.shown === SHORT_SITE && s1.fits && s1.title === SHORT_SITE, "короткое имя — целиком");
    assert.ok(s2.shown.startsWith("…") && LONG_SITE.endsWith(s2.shown.slice(1)) && s2.shown.length > 12 && s2.fits && s2.title === LONG_SITE && s2.h === s1.h,
      "длинное — с начала, хвост виден, высота строки та же: " + JSON.stringify(s2));
    await b.cmd("Target.closeTarget", { targetId: pt.targetId });
    const bad = langProblems(lang, [...new Set(allText)]);
    assert.deepStrictEqual(bad, [], "чужой язык в окне");
    ok(`${lang}: окно ${real.h} px в обычном состоянии (≤ 600, без прокрутки); 19 состояний × 2 темы — ${new Set(allText).size} строк без чужого языка и пустых` +
      (lang === "en" ? "; английская вёрстка: место действия 72, подсказки в строку, ничего не обрезано, подвал ≤ 182, ряды одной высоты" : "") +
      `; длинное имя сайта — «${s2.shown}»; скриншоты popup-${lang}-*.png`);

    // ---- значок и горячие клавиши ----
    await store({ engine: "deepl", apiKey: "", consent: {} });
    await sleep(500);
    const title = await sw.ev("chrome.action.getTitle({})");
    const st = JSON.stringify({ apiKey: false, llmApiKey: false, llmProvider: "openai", consent: {}, targetLang: TARGET, sourceLang: "auto" });
    const wantTitle = await sw.ev(`(() => { const st = ${st}; const p = HT_engineProblem("deepl", st, true); return HT_t("badgeProblem", [HT_t("extShortName"), HT_problemText(p, "short", st)]); })()`);
    const cmds = JSON.parse(await sw.ev("chrome.commands.getAll().then((a) => JSON.stringify(a.filter((c) => c.description).map((c) => [c.name, c.description])))"));
    console.log(`      (подсказка значка: «${title}»; команды: ${JSON.stringify(cmds)})`);
    assert.strictEqual(title, wantTitle);
    assert.deepStrictEqual(cmds.filter(([n]) => n !== "_execute_action"), [["toggle-enabled", await msg("cmdToggle")], ["translate-page", await msg("translatePage")]]);
    assert.deepStrictEqual(langProblems(lang, [title].concat(cmds.map((c) => c[1]))), []);
    ok(`${lang}: подсказка значка «${title}», описания горячих клавиш на языке браузера`);

    // ---- уведомления и плавающая кнопка на странице сайта ----
    const PAGE_RESULT = lang === "en" ? ["csVisibleInLang", "csAlreadyText", "csNothingText"] : ["csPageDone"];
    const resultTexts = await Promise.all(PAGE_RESULT.map((k) => msg(k)));
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await web.cmd("Page.bringToFront"); await sleep(300);
    const tabId = await sw.ev("chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id)");
    const pos = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const hover = async (sel) => { const q = await pos(sel); await web.mouse("mouseMoved", q.x, q.y); await sleep(40); await web.mouse("mouseMoved", q.x + 2, q.y); await sleep(40); };
    const pageShots = async (name) => {
      for (const dark of [false, true]) {
        await theme(web, dark); await sleep(250);
        await web.shot(`page-${name}-${lang}-${dark ? "dark" : "light"}.png`);
      }
      await theme(web, false);
    };
    await web.cmd("Page.reload"); await sleep(1500);
    await hover("#p1"); await tapShift();
    const notice = await until(async () => { const u = await pageUi(web); return u.toast && u.toast.texts.length ? u.toast : null; }, 5000);
    console.log("      (уведомление «Перевод не работает»: " + JSON.stringify(notice && notice.texts) + ")");
    assert.ok(notice, "уведомление о неработающем переводчике");
    for (const k of ["probTitle", "openSettings", "useBuiltin"]) assert.ok(notice.texts.includes(await msg(k)), k + ": " + JSON.stringify(notice.texts));
    assert.ok(notice.els.some((e) => e.tag === "svg" && /\bt-ic\b/.test(e.attrs.class || "")), "в уведомлении — значок расширения");
    await pageShots("notice");
    const texts = [...notice.texts];
    // «Перевести страницу» (встроенный): английская страница на английском браузере уже на нужном языке — так и сказано
    await store({ engine: "chrome" });
    await sleep(400);
    await sw.ev(`chrome.tabs.sendMessage(${tabId}, { type: "translatePage", via: "popup" }, { frameId: 0 }).then(() => true)`);
    const clickKey = await msg("csClickTitle");
    let clicked = false;
    const page = await until(async () => {
      const u = await pageUi(web);
      const t = u.toast ? u.toast.texts : [];
      if (!clicked && t.includes(clickKey)) {             // Chrome просит щелчок (модель на этом сайте) — щёлкаем по тексту
        clicked = true; texts.push(...t);
        const q = await pos("#p2"); await web.click(q.x, q.y);
      }
      return t.some((x) => resultTexts.includes(x)) ? t : null;
    }, 60000, 300);
    console.log("      (перевести страницу" + (clicked ? ", после щелчка по тексту" : "") + ": " + JSON.stringify(page) + ")");
    assert.ok(page, "уведомление о переводе страницы; на странице сейчас: " + JSON.stringify((await pageUi(web)).all.map((x) => x.texts)));
    texts.push(...page);
    await pageShots("done");
    await sw.ev(`chrome.tabs.sendMessage(${tabId}, { type: "restoreAll" }, { frameId: 0 }).then(() => true)`);
    // плавающая кнопка: подпись кружка, меню (язык, действие, пункты). Страницу только что переводили и вернули
    // оригинал (restoreAll) — место действия, как в окне, сегмент «Оригинал | Перевод».
    await sw.ev(`chrome.tabs.sendMessage(${tabId}, { type: "toggleHud" }, { frameId: 0 }).then(() => true)`);
    assert.ok(await until(async () => (await pageUi(web)).hud, 3000), "плавающая кнопка показана");
    const fabAria = await msg("csFabAria", await msg("extShortName"));
    await web.mouse("mouseMoved", 990, 20); await sleep(100);
    await clickUi(web, "hud", fabAria);
    assert.ok(await until(async () => (await fabUi(web)).open, 3000), "щелчок по кружку открыл меню");
    const hud = (await pageUi(web)).hud;
    for (const [k, sub] of [["csFabAria", await msg("extShortName")], ["targetLangAria"], ["ppOrig"], ["ppTr"], ["csFabSiteOff", "127.0.0.1"], ["csFabHide"], ["ppSettings"]]) {
      assert.ok(hud.texts.includes(await msg(k, sub)), k + ": " + JSON.stringify(hud.texts));
    }
    console.log("      (плавающая кнопка: " + JSON.stringify(hud.texts) + ")");
    texts.push(...hud.texts);
    await web.shot(`page-fab-${lang}.png`);
    await web.mouse("mouseMoved", 990, 20);
    await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150);
    await sw.ev(`chrome.tabs.sendMessage(${tabId}, { type: "toggleHud" }, { frameId: 0 }).then(() => true)`);
    assert.deepStrictEqual(langProblems(lang, [...new Set(texts)]), [], "чужой язык на странице");
    ok(`${lang}: на странице — «Перевод не работает» с кнопками и значком, «перевести страницу», плавающая кнопка с меню: ${new Set(texts).size} строк без чужого языка; скриншоты page-*-${lang}-*.png`);

    assert.deepStrictEqual(errors, [], "исключения в консоли");
  } finally {
    await b.close();
  }
}

(async () => {
  const srv = await serve();
  LIVE = srv.base + "/live.html";
  try {
    for (const lang of LANGS) await runLang(lang);
  } finally {
    await srv.close();
  }
  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); process.exit(1); });
