// Языки вживую: настоящее расширение в Chrome без интерфейса с английским и русским языком браузера.
// Проверяет: язык интерфейса — по языку браузера; при установке язык перевода — English (US) для
// английского браузера и русский для русского; в видимом тексте окна, приветствия, уведомлений и мини-панели
// на английском нет кириллицы, на русском — английских слов, кроме названий сервисов, моделей и клавиш;
// подсказка значка и описания горячих клавиш переведены; окно в обычном состоянии ≤ 600 px без прокрутки;
// ничего не переносится уродливо, не обрезается и не вылезает за край (несколько состояний окна), длинное
// имя сайта читается целиком; на новом сайте Chrome скрывает готовность пары с языком не из языков браузера
// (на этом стоит подсказка «щёлкните по тексту» в content.js).
// Скриншоты (светлая и тёмная тема) — с tests/run.sh --shots.
// Запуск: node tests/live/languages.test.js [en|ru] (без аргумента — оба).
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let LIVE = "";
const LANGS = process.argv[2] ? [process.argv[2]] : ["en", "ru"];
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 10000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};

// Английские слова, допустимые в русском интерфейсе: сервисы, модели, клавиши, адреса, название.
const RU_ALLOWED = new Set(["DeepL", "OpenAI", "Anthropic", "ChatGPT", "Claude", "Chrome", "Google", "GPT", "Luna", "Terra",
  "Haiku", "Sonnet", "gpt", "Shift", "Alt", "Ctrl", "Esc", "Option", "Cmd", "API", "Keys", "Free", "fx", "deepl", "com", "pro", "api",
  "chrome", "extensions", "shortcuts", "EN", "RU", "GitHub", "Vue", "Kubernetes", "sk"]);
// Переводится любой текстовый блок, поэтому «абзац» / «paragraph» в интерфейсе не встречается.
function langProblems(lang, texts) {
  const words = texts.filter((t) => /абзац|paragraph/i.test(t));
  if (lang === "en") return words.concat(texts.filter((t) => /[А-Яа-яЁё]/.test(t)));
  return words.concat(texts.filter((t) => (t.match(/[A-Za-z]{2,}/g) || []).some((w) => !RU_ALLOWED.has(w))));
}
const SHORT = { en: "Hover Translator", ru: "Переводчик при наведении" };

// Видимый текст страницы расширения: текстовые узлы и подписи (title, aria-label, placeholder), кроме
// самоназваний языков (списки, недавние языки), абзацев для пробы и имени сайта (оно — не текст интерфейса).
const PAGE_TEXT = `(() => {
  const skip = (el) => !el || el.closest("script, style, #targetLang, #sourceLang, .chip, .trainer, #siteName");
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

// Вёрстка окна: однострочные подписи не переносятся, текст не обрезан и не вылезает за край, кнопки
// действий — не больше двух строк и одной высоты, кнопки блока «что сделать» — в одну строку.
const LAYOUT = `(() => {
  const bad = [];
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const lh = (el) => { const s = getComputedStyle(el); const v = parseFloat(s.lineHeight); return Number.isFinite(v) ? v : parseFloat(s.fontSize) * 1.3; };
  const name = (el) => (el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]) + " «" + el.textContent.trim().slice(0, 40) + "»";
  // Сколько строк занимает текст элемента: по прямоугольникам текстовых узлов (высота самого элемента
  // не годится — у кнопок переключателя она задана).
  const lines = (el) => {
    const tops = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 1 && !tops.some((t) => Math.abs(t - r.top) < 3)) tops.push(r.top);
    }
    return tops.length;
  };
  for (const el of document.querySelectorAll(".seg span, .fold-title, .switch-text, .site-label, .btn-sec, .setup-actions .btn, h1, .chip, .sec-title, .lbl, .chips-lbl, kbd, .dwell-head label, .range-row span")) {
    if (vis(el) && lines(el) > 1) bad.push("переносится: " + name(el));
  }
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el) || el.closest("svg") || el.matches(".fold-sum, .sr-only, select, option, input, textarea, .bi-bar, .bi-fill")) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).overflowX !== "visible") bad.push("обрезано: " + name(el));
    const r = el.getBoundingClientRect();
    if (r.width && r.right > innerWidth + 0.5) bad.push("за правым краем: " + name(el));
  }
  // Сводка в заголовке «Качества перевода» обрезается многоточием только на крайний случай — наши тексты влезают.
  const sum = document.querySelector(".fold-sum");
  if (sum && vis(sum) && sum.scrollWidth > sum.clientWidth + 1) bad.push("сводка обрезана: «" + sum.textContent + "»");
  if (document.documentElement.scrollWidth > innerWidth) bad.push("горизонтальная прокрутка");
  const acts = [...document.querySelectorAll(".act")].filter(vis);
  const hs = new Set(acts.map((b) => Math.round(b.getBoundingClientRect().height)));
  if (hs.size > 1) bad.push("кнопки действий разной высоты: " + [...hs]);
  for (const b of acts) { const s = b.querySelector("span"); if (lines(s) > 2) bad.push("кнопка в 3+ строки: " + name(s)); }
  const sa = [...document.querySelectorAll(".setup-actions button")].filter(vis);
  if (sa.length === 2 && Math.abs(sa[0].getBoundingClientRect().top - sa[1].getBoundingClientRect().top) > 1) bad.push("кнопки блока «что сделать» в две строки");
  return bad;
})()`;

// Текст нашего интерфейса на странице сайта (закрытый shadow root виден через DOM.getDocument с pierce).
async function uiTexts(tab) {
  const { root } = await tab.cmd("DOM.getDocument", { depth: -1, pierce: true });
  const out = [];
  const walk = (n, ui, skip) => {
    const isUi = ui || !!(n.attributes && n.attributes.includes("data-ht-ui"));
    const sk = skip || n.nodeName === "OPTION" || n.nodeName === "STYLE";
    if (isUi && !sk) {
      if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
      for (let i = 0; n.attributes && i < n.attributes.length; i += 2) {
        if (["title", "aria-label"].includes(n.attributes[i]) && n.attributes[i + 1]) out.push(n.attributes[i + 1]);
      }
    }
    for (const c of n.children || []) walk(c, isUi, sk);
    for (const s of n.shadowRoots || []) walk(s, isUi, sk);
  };
  walk(root, false, false);
  return out;
}

async function runLang(lang) {
  console.log(`\n=== язык браузера: ${lang}`);
  const b = await launch({ lang, profile: process.env.HT_PROFILE || null });
  const errors = [];
  b.listeners.push((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); });
  try {
    const extDir = b.copyExt();   // новый путь — новая установка (onInstalled)
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: extDir });
    const EXT = `chrome-extension://${id}/`;
    // ---- установка: приветствие открылось, язык перевода — по языку браузера ----
    const welcomeTarget = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html"), 8000);
    assert.ok(welcomeTarget, "при установке открылась страница приветствия");
    const w = await b.attach(welcomeTarget.targetId);
    const stored = await until(() => w.ev("chrome.storage.local.get(['targetLang', 'trigger']).then((s) => s.targetLang ? JSON.stringify(s) : '')"), 5000);
    const ui = await w.ev("JSON.stringify([chrome.i18n.getUILanguage(), chrome.i18n.getMessage('uiLocale'), document.documentElement.lang])");
    console.log(`      (язык интерфейса Chrome / файл сообщений / lang страницы: ${ui}; записано при установке: ${stored})`);
    assert.strictEqual(JSON.parse(stored).targetLang, lang === "en" ? "EN-US" : "RU");
    assert.strictEqual(JSON.parse(ui)[1], lang);
    ok(`${lang}: интерфейс на языке браузера; при установке язык перевода — ${JSON.parse(stored).targetLang}, открыто приветствие`);

    // ---- приветствие: тексты и скриншоты ----
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    const bi = () => w.ev("document.querySelector('.bi-text').textContent");
    await until(async () => !(await w.ev("document.querySelector('.bi-text').classList.length === 1 && /…$/.test(document.querySelector('.bi-text').textContent)")), 10000);
    // встроенному, возможно, надо скачать пару (для английского браузера — испанский → английский): щелчок
    for (let round = 0; round < 3 && !(await w.ev("document.querySelector('.bi-btn').hidden")); round++) {
      const r = await w.ev("(() => { const r = document.querySelector('.bi-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      if (round === 0) console.log("      (приветствие до подготовки: «" + await bi() + "» — скачиваю модели)");
      await w.click(r.x, r.y);
      await until(async () => !(await w.ev("document.querySelector('.bi-btn').disabled")) && !/\d%|…$/.test(await bi()), 300000, 500);
    }
    const wInfo = JSON.parse(await w.ev(`JSON.stringify({ hero: heroText.textContent, hint: trainerHint.textContent, bi: document.querySelector('.bi-text').textContent,
      trainer: [...document.querySelectorAll('.trainer')].filter((p) => !p.hidden).map((p) => p.lang), title: document.title })`));
    console.log("      (приветствие: " + JSON.stringify(wInfo) + ")");
    assert.deepStrictEqual(wInfo.trainer, [lang === "en" ? "es" : "en"], "абзац для пробы — на языке пары, которую готовит встроенный");
    const wt = await w.ev(PAGE_TEXT);
    assert.deepStrictEqual(wt.empty, [], "пустые тексты");
    assert.deepStrictEqual(langProblems(lang, wt.texts), [], "чужой язык в тексте приветствия");
    assert.ok(!/абзац|paragraph|párrafo/i.test(await w.ev("document.body.textContent")), "«абзац»/«paragraph» на приветствии (с текстами для пробы)");
    assert.strictEqual(await w.ev("document.querySelector('h1').textContent"), SHORT[lang]);
    for (const dark of [false, true]) {
      await w.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 4000, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const h = await w.ev("Math.ceil(document.body.getBoundingClientRect().bottom)");
      await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      await w.shot(`welcome-${lang}-${dark ? "dark" : "light"}.png`);
    }
    ok(`${lang}: приветствие — ${wt.texts.length} строк без чужого языка, пустых нет; встроенный: «${wInfo.bi.slice(0, 60)}…»; скриншоты welcome-${lang}-*.png`);

    // Экран высокой плотности (×2): значок приветствия и окна — из icons/96.png, а не растянутый 48 px.
    const hi = await b.openTab("about:blank");
    await hi.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
    const iconAt = async (page, sel) => {
      await hi.cmd("Page.navigate", { url: EXT + page });
      return until(() => hi.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); return i && i.complete && i.naturalWidth ? i.currentSrc.split("/").pop() : ""; })()`), 5000);
    };
    const icons = [await iconAt("welcome.html", ".hero img"), await iconAt("popup.html", ".logo")];
    await b.cmd("Target.closeTarget", { targetId: hi.targetId });
    assert.deepStrictEqual(icons, ["96.png", "96.png"], "значки на экране ×2");
    ok(`${lang}: на экране ×2 значок приветствия и окна — 96.png`);

    // ---- окно расширения ----
    // Вкладки без адреса (about:blank при запуске) закрываем: окно ищет вкладку сайта как вкладку без адреса.
    for (const t of (await b.cmd("Target.getTargets")).targetInfos) {
      if (t.type === "page" && !t.url.startsWith(EXT)) await b.cmd("Target.closeTarget", { targetId: t.targetId });
    }
    const web = await b.openTab(LIVE);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    // На чём стоит подсказка «щёлкните по тексту» (content.js, hiddenLang): пару с языком не из языков
    // браузера Chrome на новом сайте показывает как «downloadable», хотя на приветствии её только что
    // скачали; английский и языки браузера — как есть. Поменяет Chrome правило — подсказка станет неверной.
    await sleep(800);
    const prep = JSON.parse(await w.ev("JSON.stringify(HT_prepPair(document.querySelector('#targetLang').value))"));
    const avail = (tab) => tab.ev(`Translator.availability({ sourceLanguage: "${prep.src}", targetLanguage: "${prep.tgt}" })`);
    const siteAv = await avail(web), extAv = await avail(w);
    const langs = await web.ev("JSON.stringify(navigator.languages)");
    const hidden = ![prep.src, prep.tgt].every((l) => l === "en" || JSON.parse(langs).some((x) => x.split("-")[0] === l));
    console.log(`      (пара ${prep.src} → ${prep.tgt}: на приветствии ${extAv}, на новом сайте ${siteAv}; языки браузера ${langs})`);
    assert.strictEqual(siteAv, extAv === "available" && !hidden ? "available" : "downloadable", "готовность пары на новом сайте");
    const pt = await b.openTab(EXT + "popup.html");
    await sleep(800);
    const BASE = { enabled: true, engine: "chrome", sourceLang: "auto", trigger: "shift", dwellMs: 600, displayMode: "replace", dispMode: "auto",
      apiKey: "", llmApiKey: "", consent: {}, keyVerified: false, llmVerified: false,
      recentLangs: lang === "en" ? ["EN-US", "DE", "ES"] : ["RU", "DE", "EN-US"] };
    const store = (o) => pt.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    await store(BASE);
    const webTabId = JSON.parse(await pt.ev(`chrome.tabs.query({}).then((ts) => JSON.stringify(ts.filter((t) => !t.url || /live\\.html/.test(t.url)).map((t) => t.id)))`))[0];
    const point = () => pt.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${webTabId}).then((t) => cb([t])); refreshTabState().then(() => true)`);
    const reloadPopup = async () => { await pt.cmd("Page.reload"); await sleep(1200); await point(); await sleep(300); };
    const theme = (dark) => pt.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    const allText = [];
    // Состояние окна: снимок в обеих темах, высота, вёрстка и текст.
    const snap = async (name, after) => {
      let h0 = 0;
      for (const dark of [false, true]) {
        await theme(dark);
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 2400, deviceScaleFactor: 1, mobile: false });
        await reloadPopup();
        await until(async () => !/…$/.test(await pt.ev("document.querySelector('.bi-text') ? document.querySelector('.bi-text').textContent : ''")), 8000);
        if (after) { await pt.ev(after + "; true"); await sleep(400); }
        const h = await pt.ev("Math.ceil(document.body.getBoundingClientRect().height)");
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        const bad = await pt.ev(LAYOUT);
        assert.deepStrictEqual(bad, [], `${name} (${dark ? "тёмная" : "светлая"}): вёрстка`);
        const t = await pt.ev(PAGE_TEXT);
        assert.deepStrictEqual(t.empty, [], name + ": пустые тексты");
        allText.push(...t.texts);
        await pt.shot(`popup-${lang}-${name}-${dark ? "dark" : "light"}.png`);
        if (!dark) h0 = h;
      }
      await theme(false);
      return h0;
    };

    // Длинное имя сайта читается целиком: оно на своей строке под подписью галочки (в одной строке с русской
    // подписью от него оставалось «garden.e…»). Строка добавляет к окну не больше 16 px.
    const LONG_SITE = "shop.garden-example.co.uk";
    const siteRow = () => pt.ev(`(() => { const r = els.siteRow.getBoundingClientRect(), n = els.siteName, l = document.querySelector(".site-label").getBoundingClientRect();
      return { h: Math.round(r.height), name: n.textContent, cut: n.scrollWidth > n.clientWidth, below: n.getBoundingClientRect().top >= l.bottom - 1 }; })()`);
    const hNormal = await snap("normal", `applyTabState({ hud: false, site: "${LONG_SITE}", siteOff: false })`);
    const sr = await siteRow();
    console.log(`      (строка сайта: ${JSON.stringify(sr)})`);
    assert.ok(sr.name === LONG_SITE && !sr.cut && sr.below && sr.h <= 18 + 16, "имя сайта целиком, под подписью: " + JSON.stringify(sr));
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    await reloadPopup();
    const normal = JSON.parse(await pt.ev(`JSON.stringify({ sum: els.qualitySum.textContent, sw: els.enabledText.textContent, hint: els.triggerHint.textContent,
      acts: [...document.querySelectorAll('.act')].map((b) => b.textContent.trim()), noScroll: document.documentElement.scrollHeight <= innerHeight, setup: els.setup.hidden })`));
    console.log(`      (окно в обычном состоянии: ${hNormal} px; ${JSON.stringify(normal)})`);
    assert.ok(hNormal <= 600 && normal.noScroll, "обычное состояние без прокрутки: " + hNormal);
    assert.ok(normal.setup, "в обычном состоянии блока «что сделать» нет");
    const hDwell = await snap("dwell", "setRadio('trigger', 'dwell'); updateTrigger()");
    await store({ engine: "deepl", apiKey: "00000000-0000-0000-0000-000000000000:fx", consent: {} });
    const hConsent = await snap("consent");
    await snap("quality-deepl", "setFold(els.qualityHead, els.qualityBody, true); document.querySelector('#deeplHowto').open = true; renderQuota({ ok: true, used: 87650, limit: 500000, free: true })");
    await store({ engine: "llm", llmProvider: "openai", llmApiKey: "sk-demo", llmModel: "", consent: { openai: true }, llmVerified: true });
    await snap("quality-llm", "setFold(els.qualityHead, els.qualityBody, true); setLlmStatus(checkError({ code: 'model', error: HT_t('llmModelUnknown', ['OpenAI', 'gpt-x']), detail: HT_t('respCode', 404) }), 'err')");
    await store({ engine: "chrome", targetLang: "TT" });   // татарский: встроенный его не знает
    const hLang = await snap("no-lang");
    const noLang = await pt.ev("els.setupText.textContent");
    await store({ targetLang: lang === "en" ? "EN-US" : "RU", displayMode: "popover", dispMode: "custom", engine: "auto", apiKey: "k:fx", consent: { deepl: true } });
    await snap("more", "setFold(els.moreHead, els.moreBody, true); els.stats.textContent = [HT_plural('statsSent', 12345), HT_plural('statsHits', 2, HT_plural('statsFree', 1501)), HT_t('statsKept')].join(' ')");
    await store({ engine: "chrome", apiKey: "", consent: {}, displayMode: "replace", dispMode: "auto", enabled: false });
    await snap("off");
    await store({ enabled: true });
    console.log(`      (высота: наведение ${hDwell} px, просьба о согласии ${hConsent} px, язык без встроенного ${hLang} px: «${noLang}»)`);
    assert.ok(hDwell <= 600, "наведение: " + hDwell);
    assert.ok(/(татарский|Tatar)/.test(noLang), noLang);
    const bad = langProblems(lang, [...new Set(allText)]);
    assert.deepStrictEqual(bad, [], "чужой язык в окне");
    ok(`${lang}: окно ${hNormal} px в обычном состоянии (≤ 600, без прокрутки), наведение ${hDwell} px; 8 состояний × 2 темы — ничего не переносится и не обрезается, ${new Set(allText).size} строк без чужого языка; скриншоты popup-${lang}-*.png`);

    // ---- значок и горячие клавиши ----
    await store({ engine: "deepl", apiKey: "", consent: {} });
    await sleep(500);
    const title = await pt.ev("chrome.action.getTitle({})");
    const cmds = await pt.ev("chrome.commands.getAll().then((a) => a.map((c) => c.description).filter(Boolean).join(' | '))");
    console.log(`      (подсказка значка: «${title}»; команды: «${cmds}»)`);
    assert.strictEqual(title, lang === "en" ? "Hover Translator — no DeepL key" : "Переводчик при наведении — не задан ключ DeepL");
    const names = JSON.parse(await pt.ev("JSON.stringify([chrome.runtime.getManifest().name, chrome.runtime.getManifest().short_name, document.querySelector('h1').textContent, document.title])"));
    console.log("      (название: manifest name / short_name / заголовок окна / title: " + JSON.stringify(names) + ")");
    assert.strictEqual(names[2], SHORT[lang]);
    assert.deepStrictEqual(langProblems(lang, [title, cmds]), []);
    assert.ok(lang === "en" ? /Turn translation on or off/.test(cmds) : /Включить или выключить перевод/.test(cmds), cmds);
    ok(`${lang}: подсказка значка «${title}», описания горячих клавиш на языке браузера`);

    // ---- подсказка под текстом для пробы следует выбранному переводчику: нет ключа, нет согласия ----
    const hintNow = () => w.ev("document.querySelector('#trainerHint').textContent");
    const noKey = await until(async () => { const t = await hintNow(); return /DeepL/.test(t) ? t : ""; }, 4000);
    await store({ apiKey: "k:fx" });
    const noConsent = await until(async () => { const t = await hintNow(); return /consent|согласие/.test(t) ? t : ""; }, 4000);
    await store({ engine: "chrome", apiKey: "" });
    const back = await until(async () => { const t = await hintNow(); return /DeepL|consent|согласие/.test(t) ? "" : t; }, 4000);
    console.log(`      (приветствие, DeepL без ключа: «${noKey}»; без согласия: «${noConsent}»; встроенный: «${back}»)`);
    assert.ok(lang === "en" ? /^Translation isn’t working yet: there’s no DeepL key\./.test(noKey) : /^Перевод сейчас не работает: не задан ключ DeepL\./.test(noKey), noKey);
    assert.ok(lang === "en" ? /sending text to DeepL needs your consent/.test(noConsent) : /нужно ваше согласие на отправку текста в DeepL/.test(noConsent), noConsent);
    assert.ok(back && langProblems(lang, [noKey, noConsent, back]).length === 0);
    await store({ engine: "deepl", apiKey: "", consent: {} });
    await sleep(300);
    ok(`${lang}: подсказка под текстом для пробы на приветствии учитывает DeepL без ключа и без согласия`);

        // Итог «Перевести страницу»: страница английская, поэтому на английском браузере видимая часть уже на
    // нужном языке (об этом и говорится — «Готово» было бы неправдой), на русском — переведена.
    const PAGE_RESULT = { en: /^(This part of the page is already in your language|Nothing to translate)/, ru: /^Готово/ };
// ---- уведомления и мини-панель на странице сайта ----
    await web.cmd("Page.bringToFront"); await sleep(300);
    const pos = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const hover = async (sel) => { const p = await pos(sel); await web.mouse("mouseMoved", p.x, p.y); await sleep(40); await web.mouse("mouseMoved", p.x + 2, p.y); await sleep(40); };
    await web.cmd("Page.reload"); await sleep(1500);
    await hover("#p1"); await tapShift();
    const notice = await until(async () => { const t = await uiTexts(web); return t.length ? t : null; }, 5000);
    console.log("      (уведомление «нет ключа»: " + JSON.stringify(notice) + ")");
    assert.ok(notice && notice.some((t) => lang === "en" ? /there’s no DeepL key/.test(t) : /не задан ключ DeepL/.test(t)), JSON.stringify(notice));
    assert.ok(notice.includes(lang === "en" ? "Switch to built-in" : "Переключиться на встроенный") && notice.includes(lang === "en" ? "Open settings" : "Открыть настройки"));
    assert.ok(notice.includes(SHORT[lang]), "заголовок уведомления — короткое название");
    for (const dark of [false, true]) {
      await web.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await sleep(250);
      await web.shot(`page-notice-${lang}-${dark ? "dark" : "light"}.png`);
    }
    const texts = [...notice];
    // ошибка с подробностями мелким шрифтом (≥ 12 px) и «перевести страницу» — на встроенном
    await store({ engine: "chrome" });
    await sleep(400);
    await pt.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "translatePage", via: "popup" }, { frameId: 0 }).then(() => true)`);
    const page = await until(async () => { const t = await uiTexts(web); return t.some((x) => PAGE_RESULT[lang].test(x)) ? t : null; }, 60000, 300);
    console.log("      (перевести страницу: " + JSON.stringify(page) + ")");
    assert.ok(page, "уведомление о переводе страницы; на странице сейчас: " + JSON.stringify(await uiTexts(web)));
    texts.push(...page);
    for (const dark of [false, true]) {
      await web.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await sleep(250);
      await web.shot(`page-done-${lang}-${dark ? "dark" : "light"}.png`);
    }
    await pt.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "restoreAll" }, { frameId: 0 }).then(() => true)`);
    // мини-панель: подписи кнопок
    await pt.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "toggleHud" }, { frameId: 0 }).then(() => true)`);
    await sleep(500);
    const hud = await uiTexts(web);
    console.log("      (мини-панель: " + JSON.stringify(hud.filter((t) => !texts.includes(t))) + ")");
    assert.ok(hud.includes(lang === "en" ? "Hide panel" : "Скрыть панель"), JSON.stringify(hud));
    texts.push(...hud);
    await web.shot(`page-hud-${lang}.png`);
    await pt.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "toggleHud" }, { frameId: 0 }).then(() => true)`);
    assert.deepStrictEqual(langProblems(lang, [...new Set(texts)]), [], "чужой язык на странице");
    ok(`${lang}: на странице — уведомление «нет ключа» с кнопками, «перевести страницу», мини-панель: ${new Set(texts).size} строк без чужого языка; скриншоты page-*-${lang}-*.png`);

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
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
