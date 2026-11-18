// Окно расширения и согласие вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked),
// настоящий встроенный переводчик, страница по HTTP (fixtures/live.html, свой сервер lib/server.js).
// Проверяет: согласие на отправку текста (без него — ни одного запроса к DeepL/ИИ ни от наведения, ни от
// «Перевести страницу», ни от сообщения прямо из content-скрипта; проверка ключа — можно), «Согласен» в
// окне, отзыв, «авто» без согласия; окно: высота в обычном состоянии, сворачиваемые блоки с клавиатуры,
// подписи и контраст; сохранённые переводы при встроенном переводчике; приветствие с наведением. Скриншоты
// окна (светлая и тёмная тема) — с tests/run.sh --shots.
// Сеть считаем дважды: крючком на fetch в копии background.js и событиями Network service worker-а.
// Профиль — общий для живых проверок прогона (HT_PROFILE): пара «английский → русский» не качается каждый раз.
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
const PROVIDERS = /api(-free)?\.deepl\.com|api\.openai\.com|api\.anthropic\.com/;
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 10000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const HOOK = `// крючок теста (только в копии): адреса всех запросов service worker-а
{ const f = self.fetch.bind(self); self.__htNet = []; self.fetch = (u, o) => { self.__htNet.push(String(u)); return f(u, o); }; }
`;
const FAKE_KEY = "00000000-0000-0000-0000-000000000000:fx";

(async () => {
  const srv = await serve();
  const LIVE = srv.base + "/live.html";
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  const swNet = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Network.requestWillBeSent") swNet.push(m.params.request.url);
  });
  try {
    const ext = b.copyExt();   // новая папка — новое расширение (см. copyExt в lib/chrome.js)
    fs.writeFileSync(path.join(ext, "background.js"), fs.readFileSync(path.join(ext, "background.js"), "utf8").replace('importScripts("shared.js");', 'importScripts("shared.js");\n' + HOOK));
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    // все вкладки (и about:blank: без адреса окно не отличило бы её от вкладки сайта) — закрываем
    for (const t of targetInfos) if (t.type === "page") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const sw = await b.attach(targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js").targetId);
    await sw.cmd("Network.enable").catch(() => {});
    const net = async () => (await sw.ev("JSON.stringify(self.__htNet)").then(JSON.parse)).filter((u) => PROVIDERS.test(u));

    const web = await b.openTab(LIVE);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    const pt = await b.openTab(EXT + "popup.html");
    await sleep(800);
    // профиль постоянный — начинаем с чистого хранилища расширения
    const BASE = { enabled: true, engine: "chrome", targetLang: "RU", sourceLang: "auto", trigger: "shift", dwellMs: 600, recentLangs: ["RU", "DE", "EN-US"] };
    const store = (o) => pt.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    await pt.ev(`chrome.storage.local.clear().then(() => true)`);
    await store(BASE);
    await sleep(300);
    const webTabId = JSON.parse(await pt.ev("chrome.tabs.query({}).then((ts) => JSON.stringify(ts.filter((t) => !t.url).map((t) => t.id)))"))[0];
    // окно открыто вкладкой, а не над сайтом: подменяем «активную вкладку» на вкладку сайта
    const point = () => pt.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${webTabId}).then((t) => cb([t])); refreshTabState().then(() => true)`);
    const reloadPopup = async () => { await pt.cmd("Page.reload"); await sleep(1200); await point(); await sleep(300); };
    const theme = (dark) => pt.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    // Высота содержимого — по body при высоком окне (в настоящем окне Chrome добавляет ширину полосы
    // прокрутки сам).
    const snap = async (name, after) => {
      const hs = [];
      for (const dark of [false, true]) {
        await theme(dark);
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 2400, deviceScaleFactor: 1, mobile: false });
        await reloadPopup();
        if (after) { await pt.ev(after + "; true"); await sleep(300); }
        const h = await pt.ev("Math.ceil(document.body.getBoundingClientRect().height)");
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        await pt.shot(`${name}-${dark ? "dark" : "light"}.png`);
        hs.push(h);
      }
      await theme(false);
      return hs[0];
    };

    // ---- встроенный переводчик готов (пара — из профиля, определение языка — щелчком) ----
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 900, deviceScaleFactor: 1, mobile: false });
    await reloadPopup();
    const bi = () => pt.ev("document.querySelector('.bi-text').textContent");
    await until(async () => !/Проверяю/.test(await bi()), 10000);
    console.log("      (встроенный при открытии окна: " + await bi() + ")");
    for (let round = 0; round < 3 && !(await pt.ev("document.querySelector('.bi-btn').hidden")); round++) {
      assert.strictEqual(await pt.ev("els.prepBox.hidden"), false, "нужно скачать модели — блок наверху окна");
      if (round === 0) {
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 2400, deviceScaleFactor: 1, mobile: false });
        const h = await pt.ev("Math.ceil(document.body.getBoundingClientRect().height)");
        await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false });
        await pt.shot("prepare-light.png");
      }
      const r = await pt.ev("(() => { const r = document.querySelector('.bi-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await pt.click(r.x, r.y);
      await until(async () => /Готово|Не удалось|ещё раз/.test(await bi()), 300000, 400);
    }
    assert.ok(/Готово/.test(await bi()), await bi());
    ok("встроенный переводчик готов (если нужно было скачать — блок с кнопкой был наверху окна, скриншот prepare-light.png)");

    // ---- обычное состояние: помещается в 600 px, всё свёрнуто, подписи и доступность ----
    const hNormal = await snap("normal");
    console.log(`      (окно в обычном состоянии: ${hNormal} px — с выключателем, строкой сайта, языком, способом, действиями, двумя свёрнутыми блоками)`);
    assert.ok(hNormal <= 600, "обычное состояние помещается в 600 px: " + hNormal);
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    await reloadPopup();
    const st = JSON.parse(await pt.ev(`JSON.stringify({
      site: !els.siteRow.hidden && els.siteName.textContent,
      setup: els.setup.hidden, prep: els.prepBox.hidden,
      q: [els.qualityHead.getAttribute("aria-expanded"), els.qualityBody.hidden, els.qualitySum.textContent],
      m: [els.moreHead.getAttribute("aria-expanded"), els.moreBody.hidden],
      sw: [els.enabled.getAttribute("role"), els.enabled.getAttribute("aria-checked"), els.enabledText.textContent],
      hint: els.triggerHint.textContent,
      acts: [...document.querySelectorAll(".act")].map((b) => b.textContent.trim()),
      chips: [...document.querySelectorAll(".chip")].map((b) => b.textContent),
      scroll: document.documentElement.scrollHeight <= innerHeight,
    })`));
    console.log("      (" + JSON.stringify(st) + ")");
    assert.strictEqual(st.site, "127.0.0.1");
    assert.deepStrictEqual([st.setup, st.prep, st.q, st.m], [true, true, ["false", true, "Встроенный ✓"], ["false", true]]);
    assert.deepStrictEqual(st.sw, ["switch", "true", "Перевод включён"]);
    assert.strictEqual(st.hint, "Наведите курсор на текст, нажмите и отпустите Shift. Ещё раз — вернётся оригинал.");
    assert.deepStrictEqual(st.acts, ["Перевести страницу", "Вернуть оригинал", "Мини-панель на странице"]);
    assert.deepStrictEqual(st.chips, ["Deutsch", "English (US)"], "недавние языки — названиями, без текущего");
    assert.ok(st.scroll, "в окне 600 px нет прокрутки");
    // доступность: шрифт подсказок, контраст рамок, подписи, живые строки
    const a11y = await pt.ev(`(() => {
      const lum = (c) => { const m = c.match(/[\\d.]+/g).slice(0, 3).map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
      const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const bg = getComputedStyle(document.body).backgroundColor;
      const border = getComputedStyle(els.targetLang).borderTopColor;
      const small = [...document.querySelectorAll(".hint, .status, .quota, .bi-text, .eng-hint, .chips-lbl, .fold-sum, .act, .keys-list")]
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => e.className);
      const unlabeled = [...document.querySelectorAll("input, select, textarea, button")].filter((e) => !e.closest("[hidden]")).filter((e) => {
        if (e.type === "radio") return !e.closest("label");
        return !(e.labels && e.labels.length) && !e.getAttribute("aria-label") && !e.textContent.trim() && !e.getAttribute("aria-labelledby");
      }).map((e) => e.id || e.className);
      return { border: cr(border, bg).toFixed(2), small, unlabeled,
        live: ["pageMsg", "setupText", "status", "quota", "llmStatus", "triggerHint", "stats"].every((id) => document.getElementById(id).getAttribute("aria-live") || document.getElementById(id).getAttribute("role") === "status"),
        biLive: document.querySelector(".bi-text").getAttribute("aria-live"),
        dwellLabel: els.dwellMs.labels[0].textContent };
    })()`);
    console.log("      (доступность: " + JSON.stringify(a11y) + ")");
    assert.ok(Number(a11y.border) >= 3, "контраст рамки поля " + a11y.border);
    assert.deepStrictEqual(a11y.small, [], "шрифт меньше 12 px");
    assert.deepStrictEqual(a11y.unlabeled, [], "элементы без подписи");
    assert.ok(a11y.live && a11y.biLive === "polite" && a11y.dwellLabel === "Задержка перед переводом");
    // клавиатура: Tab доходит до «Качества перевода», Enter раскрывает, фокус виден
    await pt.cmd("Page.bringToFront");
    await pt.ev("document.activeElement.blur(); els.translatePage.focus(); true");
    const tab = async () => { await pt.key("rawKeyDown", "Tab", "Tab", 0, 9); await pt.key("keyUp", "Tab", "Tab", 0, 9); await sleep(50); };
    let seen = [];
    for (let i = 0; i < 6 && (await pt.ev("document.activeElement.id")) !== "qualityHead"; i++) { await tab(); seen.push(await pt.ev("document.activeElement.id")); }
    assert.strictEqual(await pt.ev("document.activeElement.id"), "qualityHead", "Tab: " + seen.join(" → "));
    const ring = await pt.ev("(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; })()");
    assert.ok(/solid 2px/.test(ring), "фокус виден: " + ring);
    // Enter с текстом "\r" — как настоящее нажатие (кнопку нажимает keypress, его даёт keyDown с текстом)
    await pt.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await pt.key("keyUp", "Enter", "Enter", 0, 13); await sleep(100);
    assert.deepStrictEqual(await pt.ev("[els.qualityHead.getAttribute('aria-expanded'), els.qualityBody.hidden]"), ["true", false]);
    // переводчик — стрелками в группе переключателей
    await pt.ev("document.querySelector('input[name=engine]:checked').focus(); true");
    await pt.key("rawKeyDown", "ArrowDown", "ArrowDown", 0, 40); await pt.key("keyUp", "ArrowDown", "ArrowDown", 0, 40); await sleep(300);
    assert.strictEqual(await pt.ev("engineValue()"), "deepl", "стрелка вниз выбрала DeepL");
    assert.strictEqual(await pt.ev("chrome.storage.local.get('engine').then((s) => s.engine)"), "deepl", "и сохранила");
    assert.strictEqual(await pt.ev("els.consentBox.hidden"), false, "выбрали DeepL — сразу видно, что текст будет уходить в DeepL");
    await store({ engine: "chrome" });
    ok(`обычное состояние: ${hNormal} px (≤ 600, без прокрутки), всё свёрнуто, подписи у кнопок, недавние языки названиями; рамки полей ${a11y.border}:1, шрифт подсказок ≥ 12 px, у всех полей есть подписи; Tab/Enter раскрывают блок, фокус виден, переводчик выбирается стрелками`);

    // ---- прежний пользователь DeepL после обновления: ключ есть, согласия нет ----
    await store({ engine: "deepl", apiKey: FAKE_KEY, keyVerified: true });
    await sleep(400);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "!");
    assert.strictEqual(await pt.ev("chrome.action.getTitle({})"), "Переводчик при наведении — нужно ваше согласие на отправку текста");
    const hConsent = await snap("consent");
    await reloadPopup();
    const setupText = await pt.ev("els.setupText.textContent");
    console.log("      (окно: «" + setupText + "» [" + await pt.ev("els.setupGo.textContent") + "] [" + await pt.ev("els.setupFix.textContent") + "]; высота " + hConsent + " px)");
    assert.ok(/Текст, который вы переводите, будет отправляться в DeepL по вашему ключу\. Встроенный переводчик ничего не отправляет\./.test(setupText));
    assert.strictEqual(await pt.ev("els.setupGo.textContent"), "Согласен");
    const goBox = await pt.ev("(() => { const r = els.setupGo.getBoundingClientRect(); return r.bottom; })()");
    assert.ok(goBox < 600, "«Согласен» видно без прокрутки: " + goBox);
    // сайт: клавиша — ничего не уходит, страница не тронута
    await web.cmd("Page.bringToFront"); await sleep(200);
    const pos = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    const txt = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    const ru = async (sel) => /[а-яё]{3}/i.test(await txt(sel));
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const hover = async (sel) => { const p = await pos(sel); await web.mouse("mouseMoved", p.x, p.y); await sleep(40); await web.mouse("mouseMoved", p.x + 2, p.y); await sleep(40); };
    const esc = async () => { await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    await hover("#p1"); await tapShift(); await sleep(800);
    assert.ok(!(await ru("#p1")), "абзац не переведён");
    // «Перевести страницу» — тем же сообщением, что шлёт кнопка окна
    await pt.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "translatePage", via: "popup" }, { frameId: 0 }).then(() => true)`); await sleep(1200);
    assert.ok(!(await ru("#p2")) && !(await ru("#p3")), "страница не переведена");
    // старый или подменённый content-скрипт шлёт текст напрямую — background отказывает
    const iso = web.isolated();
    let direct = null;
    for (const c of iso) {
      const has = await web.ev("typeof HT_engine === 'function'", c.id).catch(() => false);
      if (!has) continue;
      direct = await web.ev(`chrome.runtime.sendMessage({ type: "translateBatch", engine: "deepl", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: ["Secret text straight from the content script"] }).then((r) => JSON.stringify(r))`, c.id);
      break;
    }
    console.log("      (сообщение из content-скрипта в обход проверок: " + direct + ")");
    assert.ok(direct && /"code":"no-consent"/.test(direct), direct);
    assert.deepStrictEqual(await net(), [], "ни одного запроса к DeepL/ИИ (крючок fetch)");
    assert.deepStrictEqual(swNet.filter((u) => PROVIDERS.test(u)), [], "ни одного запроса к DeepL/ИИ (Network)");
    ok(`DeepL с ключом без согласия (как у прежних пользователей после обновления): «!» и «нужно ваше согласие» на значке; наверху окна — что уходит и «Согласен» (видно без прокрутки, окно ${hConsent} px); Shift, «Перевести страницу» и прямое сообщение из content-скрипта — 0 запросов`);

    // ---- проверка ключа без согласия — можно (уходит только ключ) ----
    await reloadPopup();
    await pt.ev("checkDeepl(); true");
    const checkMsg = await until(async () => { const t = await pt.ev("els.status.textContent"); return /Проверяю/.test(t) ? "" : t; }, 20000);
    const n1 = await net();
    console.log("      (проверка ключа без согласия: запросы " + JSON.stringify(n1) + "; в окне: «" + checkMsg + "»)");
    assert.ok(n1.length === 1 && /\/v2\/usage$/.test(n1[0]), "один запрос /v2/usage, без текста");
    ok("«Проверить» без согласия: один запрос /v2/usage (только ключ) — решение этапа 3; текст страниц не уходил");

    // ---- «авто» с ключом без согласия: встроенный, без запросов, наверху — спокойная просьба ----
    await store({ engine: "auto" });
    await sleep(400);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "", "«авто» работает встроенным — значок чистый");
    await snap("consent-auto");
    await reloadPopup();
    assert.ok(await pt.ev("!els.setup.hidden && els.setup.classList.contains('info') && els.setupGo.textContent === 'Согласен'"), "просьба о согласии — не красная");
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ru("#p1"), 10000), "«авто» без согласия перевёл встроенным");
    await esc();
    assert.strictEqual((await net()).length, 1, "к DeepL ничего не ушло");
    ok("«авто» с ключом без согласия: переводит встроенный, 0 запросов к DeepL, значок чистый; наверху окна — спокойная просьба с «Согласен»");

    // ---- «Согласен» настоящим щелчком; потом отзыв ----
    await store({ engine: "deepl" });
    await pt.cmd("Page.bringToFront");
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 900, deviceScaleFactor: 1, mobile: false });
    await reloadPopup();
    const g = await pt.ev("(() => { const r = els.setupGo.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await pt.click(g.x, g.y); await sleep(500);
    assert.deepStrictEqual(JSON.parse(await pt.ev("chrome.storage.local.get('consent').then((s) => JSON.stringify(s.consent))")), { deepl: true, openai: false, anthropic: false });
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "", "согласились — «!» снят");
    assert.ok(await pt.ev("els.setup.hidden && !els.consentGiven.hidden && /отправляется в DeepL/.test(els.consentGivenText.textContent)"));
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p2"); await tapShift();
    const sent = await until(async () => (await net()).some((u) => /\/v2\/translate$/.test(u)), 20000);
    assert.ok(sent, "после согласия запрос в DeepL ушёл: " + JSON.stringify(await net()));
    await sleep(2500); await esc();
    // отозвали — снова ни одного запроса
    await pt.ev("els.consentRevoke.click(); true"); await sleep(500);
    assert.deepStrictEqual(JSON.parse(await pt.ev("chrome.storage.local.get('consent').then((s) => JSON.stringify(s.consent))")).deepl, false);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "!");
    const before = (await net()).length;
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p3"); await tapShift(); await sleep(1500);
    assert.strictEqual((await net()).length, before, "после отзыва — ни одного нового запроса");
    ok("«Согласен» (настоящий щелчок): согласие записано только для DeepL, «!» снят, текст ушёл в DeepL; «Отозвать согласие» — «!» вернулся, запросов больше нет");

    // ---- ИИ: согласие на DeepL не открывает Anthropic ----
    await store({ engine: "llm", llmProvider: "anthropic", llmApiKey: "sk-ant-fake", consent: { deepl: true } });
    await sleep(400);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "!");
    const n2 = (await net()).length;
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p1"); await tapShift(); await sleep(1200);
    assert.strictEqual((await net()).length, n2, "к Anthropic ничего не ушло");
    await pt.cmd("Page.bringToFront");
    await reloadPopup();
    assert.ok(/в Anthropic по вашему ключу/.test(await pt.ev("els.setupText.textContent")));
    ok("ИИ (Anthropic) с ключом и согласием только на DeepL: «!», Shift — 0 запросов, окно просит согласие на Anthropic");

    // ---- скриншоты остальных состояний ----
    await store({ engine: "deepl", apiKey: FAKE_KEY, consent: { deepl: true }, keyVerified: true });
    await snap("quality-deepl", "setFold(els.qualityHead, els.qualityBody, true); document.querySelector('#deeplHowto').open = true; renderQuota({ ok: true, used: 87650, limit: 500000 })");
    await store({ engine: "llm", llmProvider: "openai", llmApiKey: "sk-demo", llmModel: "", consent: { deepl: true, openai: true }, llmVerified: true });
    await snap("quality-llm", "setFold(els.qualityHead, els.qualityBody, true)");
    await snap("quality-llm-other", "setFold(els.qualityHead, els.qualityBody, true); els.llmModelSel.value = 'other'; els.llmModelSel.dispatchEvent(new Event('change')); els.llmModel.value = 'gpt-5.5'");
    await store({ engine: "deepl", apiKey: "", consent: {} });
    await snap("nokey-deepl");
    await store({ engine: "chrome", displayMode: "popover", dispMode: "custom", noTranslate: "GitHub, Vue" });
    await snap("more", "setFold(els.moreHead, els.moreBody, true); fetchStats()");
    await store({ trigger: "dwell", displayMode: "replace", dispMode: "auto" });
    const hDwell = await snap("normal-dwell");
    await store({ trigger: "shift", enabled: false });
    await snap("off");
    await store({ enabled: true });
    console.log(`      (наведение с задержкой: ${hDwell} px)`);
    assert.ok(hDwell <= 600);
    ok(`скриншоты окна (светлая и тёмная тема): normal, normal-dwell (${hDwell} px), off, consent, consent-auto, quality-deepl, quality-llm, quality-llm-other, nokey-deepl, more`);

    // ---- сохранённые переводы при встроенном переводчике ----
    // Ничего не сохранено (счётчики расхода нулевые) — блока нет; после работы с DeepL (счётчики подменены
    // в окне: настоящий DeepL здесь без ключа) — блок с кнопкой виден и при встроенном; «Удалить»
    // по-настоящему чистит и обнуляет счётчики, «Удалено.» не пропадает вместе с блоком.
    await store({ engine: "chrome" });
    await pt.ev("chrome.runtime.sendMessage({ type: 'resetStats' }).then(() => true)");
    await reloadPopup();
    await pt.ev("setFold(els.moreHead, els.moreBody, true); true");
    await until(async () => (await pt.ev("els.stats.textContent")) !== "", 3000);
    assert.strictEqual(await pt.ev("els.cacheRow.hidden"), true, "встроенный, ничего не сохранено — блока нет");
    const fakeStats = (chars, hits) => pt.ev(`(() => { const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...a) => m && m.type === "getStats" ? Promise.resolve({ ok: true, chars: ${chars}, hits: ${hits}, saved: ${hits * 150} }) : send(m, ...a);
      return fetchStats().then(() => true); })()`);
    await fakeStats(12345, 2);
    const shown = JSON.parse(await pt.ev("JSON.stringify({ hidden: els.cacheRow.hidden, stats: els.stats.textContent, btn: els.clearCache.textContent })"));
    console.log("      (встроенный, есть сохранённые: " + JSON.stringify(shown) + ")");
    assert.ok(!shown.hidden && /12\s345/.test(shown.stats) && shown.btn === "Удалить сохранённые переводы", JSON.stringify(shown));
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 2400, deviceScaleFactor: 1, mobile: false });
    await pt.ev("els.clearCache.scrollIntoView({ block: 'center' }); true");
    const cb = await pt.ev("(() => { const r = els.clearCache.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await pt.ev(`(() => { const send = chrome.runtime.sendMessage; chrome.runtime.sendMessage = (m, ...a) => m && m.type === "getStats" ? Promise.resolve({ ok: true, chars: 0, hits: 0, saved: 0 }) : send(m, ...a); return true; })()`);
    await pt.click(cb.x, cb.y);
    const after = await until(async () => { const r = JSON.parse(await pt.ev("JSON.stringify({ hidden: els.cacheRow.hidden, msg: els.cacheMsg.textContent, stats: els.stats.textContent })")); return r.msg === "Удалено." ? r : null; }, 5000);
    assert.ok(after && !after.hidden, "после удаления блок с «Удалено.» остаётся: " + JSON.stringify(after));
    const real = JSON.parse(await pt.ev("chrome.runtime.sendMessage({ type: 'getStats' }).then((r) => JSON.stringify(r))"));
    assert.ok(real.ok && real.chars === 0 && real.hits === 0, "счётчики обнулены: " + JSON.stringify(real));
    await reloadPopup();
    await until(async () => (await pt.ev("els.stats.textContent")) !== "", 3000);
    assert.strictEqual(await pt.ev("els.cacheRow.hidden"), true, "окно открыли снова — сохранять нечего, блока нет");
    ok("встроенный переводчик: «Удалить сохранённые переводы» видна, пока от DeepL или ИИ что-то сохранено; после удаления «Удалено.» на месте, при следующем открытии блока нет");

    // ---- приветствие: подзаголовок по выбранному способу ----
    const w = await b.openTab(EXT + "welcome.html");
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    const hero1 = await w.ev("document.querySelector('#heroText').textContent");
    await w.ev("document.querySelector('input[value=dwell]').click(); true"); await sleep(300);
    const hero2 = await w.ev("document.querySelector('#heroText').textContent");
    console.log("      (приветствие: «" + hero1 + "» → «" + hero2 + "»)");
    assert.ok(/нажмите Shift/.test(hero1) && /Задержите курсор на тексте/.test(hero2) && !/Shift/.test(hero2));
    for (const dark of [false, true]) {
      await w.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 4000, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const h = await w.ev("Math.ceil(document.body.getBoundingClientRect().bottom)");
      await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      await w.shot(`welcome-${dark ? "dark" : "light"}.png`);
    }
    await w.ev("document.querySelector('input[value=shift]').click(); true"); await sleep(200);
    ok("приветствие: подзаголовок следует способу включения (Shift → «Задержите курсор…» при наведении); скриншоты welcome-*.png");

    assert.deepStrictEqual(pageErrors, [], "исключения в консоли");
    console.log("      (исключения в консоли: нет)");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
