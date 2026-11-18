// Установка вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked).
// Установка → страница приветствия → «Подготовить переводчик» настоящим щелчком (модели качаются из
// сети) → текст для пробы → окно (состояния, значок) → сайт без ключа → обновление расширения при
// открытой вкладке → «Обновить вкладку». Скриншоты — с tests/run.sh --shots.
const path = require("path");
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 10000, step = 200) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};

(async () => {
  const srv = await serve();
  const WEB = srv.base + "/index.html";
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.sessionId + " " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) pageErrors.push(m.sessionId + " console." + m.params.type + ": " + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 300));
  });
  const shotFull = async (tab, file, width) => {
    await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: 4000, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const h = await tab.ev("Math.ceil(document.body.getBoundingClientRect().bottom)");
    await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    await tab.shot(file);
  };
  const theme = (tab, dark) => tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  try {
    const ext = b.copyExt();
    if (process.env.HT_DEBUG) {   // отладочный крючок — только в копии
      const fs = require("fs");
      let c = fs.readFileSync(path.join(ext, "content.js"), "utf8");
      c = c.replace("  // ---- может ли перевод работать ----", "  window.__htDbg = () => JSON.stringify({ dead, lines: lines.size, enabled: settings.enabled, trigger: settings.trigger, engine: settings.engine, hud: !!hud, unb: unbinders.length, hover: hoverEl && (hoverEl.id || hoverEl.tagName), det: !!detector, detP: !!detectorPending, tr: [...translators.keys()], inflight: [...document.querySelectorAll('p')].filter((p) => inFlight.has(p)).map((p) => p.id) });\n  // ---- может ли перевод работать ----");
      c = c.replace("  function showToast(message, kind, ms) {\n", "  function showToast(message, kind, ms) {\n    (window.__htToasts = window.__htToasts || []).push(Math.round(performance.now()) + ' ' + kind + ':' + message);\n");
      c = c.replace("      return err && err.name === \"NotAllowedError\"", "      (window.__htErr = window.__htErr || []).push(Math.round(performance.now()) + ' ' + what + ' ' + state + ' ' + (err && err.name) + ': ' + (err && err.message));\n      return err && err.name === \"NotAllowedError\"");
      const L = (fn) => "(window.__htLog = window.__htLog || []).push(Math.round(performance.now()) + ' " + fn + " ' + liveGen);";
      c = c.replace("  async function retranslateAll() {\n", "  async function retranslateAll() {\n    " + L("retranslateAll") + "\n");
      c = c.replace("  function restoreAll() {\n", "  function restoreAll() {\n    " + L("restoreAll") + "\n");
      c = c.replace("  async function translateLine(owner, persistent) {\n", "  async function translateLine(owner, persistent) {\n    " + L("translateLine") + "\n");
      c = c.replace("    if (txChanged) {\n", "    if (txChanged) {\n      " + L("txChanged") + " window.__htLog.push(JSON.stringify(Object.keys(changes)));\n");
      c = c.replace("    for (let i = 0; i < entries.length; i++) writeEntry(entries[i], results[i], entries[i].rec.translated);", "    " + L("retranslate-write") + "\n    for (let i = 0; i < entries.length; i++) writeEntry(entries[i], results[i], entries[i].rec.translated);");
      c = c.replace("    for (const n of line.nodes) {\n      const rec = nodeRecs.get(n);\n      if (!rec || rec.line !== line) continue; // узел перехвачен другим переводом — не трогаем\n      if (revert",
        "    for (const n of line.nodes) {\n      const rec = nodeRecs.get(n);\n      window.__htLog.push('release ' + (line.owner.id || line.owner.tagName) + ' pers=' + line.persistent + ' revert=' + revert + ' rec=' + !!rec + ' same=' + (rec && rec.line === line) + ' conn=' + n.isConnected + ' eq=' + (rec && n.nodeValue === rec.translated) + ' tr=' + (rec && String(rec.translated).slice(0, 15)) + ' now=' + n.nodeValue.slice(0, 15));\n      if (!rec || rec.line !== line) continue; // узел перехвачен другим переводом — не трогаем\n      if (revert");
      c = c.replace("  function writeEntry(e, res, expect) {\n", "  function writeEntry(e, res, expect) {\n    (window.__htLog = window.__htLog || []).push('write ' + (e.line && e.line.owner.id) + ' ok=' + !!(res && res.ok) + ' conn=' + e.node.isConnected + ' eqExpect=' + (e.node.nodeValue === expect));\n");
      c = c.replace("  async function translatePage() {\n", "  async function translatePage() {\n    (window.__htLog = window.__htLog || []).push(Math.round(performance.now()) + ' translatePage ' + location.href + ' ' + new Error().stack.split('\\n').slice(1, 4).join(' | '));\n");
      fs.writeFileSync(path.join(ext, "content.js"), c);
    }
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    const wt = targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html");
    assert.ok(wt, "страница приветствия открылась при установке");
    // начальная about:blank мешает опознать вкладку сайта без адреса (popup его не видит) — закрываем
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank") await b.cmd("Target.closeTarget", { targetId: t.targetId });

    // ---- страница приветствия ----
    const w = await b.attach(wt.targetId);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    await w.cmd("Page.reload");
    await sleep(1200);
    assert.strictEqual(await w.ev("document.querySelector('#targetLang').value"), "RU");
    assert.strictEqual(await w.ev("chrome.storage.local.get('targetLang').then((s) => s.targetLang)"), "RU");
    const biText = () => w.ev("document.querySelector('.bi-text').textContent");
    const st0 = await until(async () => { const t = await biText(); return /Проверяю/.test(t) ? "" : t; });
    console.log("      (до подготовки: " + st0 + ")");
    assert.strictEqual(await w.ev("chrome.action.getBadgeText({})"), "", "встроенный по умолчанию — значок чистый");
    ok("установка: открыта страница приветствия, язык перевода = язык браузера (RU), значок без «!»");
    await theme(w, false); await shotFull(w, "welcome-light-before.png", 900);
    await theme(w, true); await shotFull(w, "welcome-dark-before.png", 900);
    await theme(w, false);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });

    // «Подготовить переводчик» — настоящий щелчок
    const needPrep = await w.ev("!document.querySelector('.bi-btn').hidden");
    if (needPrep) {
      await w.ev("document.querySelector('.bi-btn').scrollIntoView({ block: 'center' }); true");
      await sleep(200);
      const r = await w.ev("(() => { const r = document.querySelector('.bi-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await w.click(r.x, r.y);
      let progressSeen = "";
      const done = await until(async () => {
        const t = await biText();
        if (/Скачиваю/.test(t) && !progressSeen) {
          progressSeen = t;
          await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
          await w.shot("welcome-progress.png");
        }
        return /Готово|Не удалось|ещё раз/.test(t) ? t : "";
      }, 180000, 300);
      console.log("      (во время загрузки: " + (progressSeen || "не застали") + ")");
      console.log("      (после: " + done + ")");
      if (/ещё раз/.test(done)) {   // Chrome отказал второй модели — второй щелчок
        await w.click(r.x, r.y);
        await until(async () => /Готово|Не удалось/.test(await biText()), 180000, 300);
      }
    }
    const st1 = await biText();
    assert.ok(/Готово: английский → русский/.test(st1), st1);
    ok("«Подготовить переводчик» настоящим щелчком: модели скачаны, «Готово: английский → русский»");
    await theme(w, false); await shotFull(w, "welcome-light.png", 900);
    await theme(w, true); await shotFull(w, "welcome-dark.png", 900);
    await theme(w, false);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });

    // Абзац для пробы: навести и нажать Shift (этап 2б: Shift по умолчанию) — переводится встроенным
    const shiftTap = async (tab) => { await tab.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await tab.key("keyUp", "Shift", "ShiftLeft", 0, 16); };
    await w.ev("document.querySelector('#trainerEn').scrollIntoView({ block: 'center' }); true");
    await sleep(200);
    const tr = await w.ev("(() => { const r = document.querySelector('#trainerEn').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; })()");
    const EN = await w.ev("document.querySelector('#trainerEn').textContent");
    await w.mouse("mouseMoved", tr.x, tr.y); await sleep(50); await shiftTap(w);
    const ru = await until(async () => { const t = await w.ev("document.querySelector('#trainerEn').textContent"); return t !== EN ? t : ""; }, 15000);
    console.log("      (абзац для пробы: " + ru.slice(0, 90) + "… | ht-error: " + await w.ev("document.querySelectorAll('.ht-error').length") + ", наших окон: " + await w.ev("document.querySelectorAll('[data-ht-ui]').length") + ")");
    if (!ru && process.env.HT_DEBUG) {
      console.log("      уведомления:", await w.ev("JSON.stringify(window.__htToasts || [])"), "\n      ошибки create:", await w.ev("JSON.stringify(window.__htErr || [])"), "\n      сейчас:", await w.ev("Math.round(performance.now())"));
      console.log("      dbg приветствие:", await w.ev("window.__htDbg ? window.__htDbg() : 'нет'"), "ht-loading:", await w.ev("document.querySelector('#trainerEn').className"));
      const race = (expr) => w.ev(`Promise.race([${expr}, new Promise((r) => setTimeout(() => r('ВИСИТ 5 с'), 5000))])`);
      console.log("      LD.create:", await race("LanguageDetector.create().then(async (d) => JSON.stringify((await d.detect('This is a test'))[0]), (e) => e.name + ': ' + e.message)"));
      console.log("      TR.create:", await race("Translator.create({ sourceLanguage: 'en', targetLanguage: 'ru' }).then(async (t) => await t.translate('Hello'), (e) => e.name + ': ' + e.message)"));
      await w.mouse("mouseMoved", 5, 5); await sleep(300); await w.mouse("mouseMoved", tr.x, tr.y);
      console.log("      повторное наведение:", await until(async () => { const t = await w.ev("document.querySelector('#trainerEn').textContent"); return t !== EN ? t : ""; }, 10000));
    }
    assert.ok(/[а-яё]{3,}/i.test(ru), "перевод на русский: " + ru);
    assert.strictEqual(await w.ev("document.querySelectorAll('.ht-error').length"), 0);
    await w.shot("welcome-trainer.png");
    await shiftTap(w);
    await until(async () => (await w.ev("document.querySelector('#trainerEn').textContent")) === EN, 3000);
    assert.strictEqual(await w.ev("document.querySelector('#trainerEn').textContent"), EN, "Shift ещё раз — оригинал");
    // подписи страницы (translate="no") не переводятся
    const h = await w.ev("(() => { const r = document.querySelector('.step p').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 8, t: document.querySelector('.step p').textContent }; })()");
    await w.mouse("mouseMoved", h.x, h.y); await sleep(50); await shiftTap(w); await sleep(1500);
    assert.strictEqual(await w.ev("document.querySelector('.step p').textContent"), h.t);
    ok("страница приветствия: content.js подключён напрямую, абзац для пробы переводится встроенным переводчиком, подписи страницы — нет");
    // способ включения: по умолчанию Shift (записан при установке и отмечен на странице)
    assert.strictEqual(await w.ev("document.querySelector('input[value=shift]').checked"), true);
    await w.ev("document.querySelector('input[value=dwell]').click(); true");
    await sleep(200);
    assert.strictEqual(await w.ev("chrome.storage.local.get('trigger').then((s) => s.trigger)"), "dwell");
    await w.ev("document.querySelector('input[value=shift]').click(); true");
    await sleep(200);
    assert.strictEqual(await w.ev("chrome.storage.local.get('trigger').then((s) => s.trigger)"), "shift");
    ok("способ включения: по умолчанию отмечен Shift; выбор сохраняется в trigger");

    // ---- popup ----
    const pt = await b.openTab(EXT + "popup.html");
    await sleep(1200);
    const r0 = await pt.ev("chrome.runtime.sendMessage({ type: 'getStats' }).then((r) => JSON.stringify(r))");
    assert.ok(/"ok":true/.test(r0) && /chars/.test(r0), "ответ background, а не content.js страницы приветствия: " + r0);
    assert.strictEqual(await pt.ev("engineValue()"), "chrome");   // этап 3: переводчик — переключатели
    const pbi = await until(async () => { const t = await pt.ev("document.querySelector('.bi-text').textContent"); return /Готово/.test(t) ? t : ""; });
    assert.ok(pbi, "в popup: " + await pt.ev("document.querySelector('.bi-text').textContent"));
    assert.strictEqual(await pt.ev("document.querySelector('#setup').hidden"), true);
    await theme(pt, false); await shotFull(pt, "popup-light.png", 340);
    await theme(pt, true); await shotFull(pt, "popup-dark.png", 340);
    await theme(pt, false);
    ok("popup: встроенный выбран по умолчанию, «Готово: английский → русский»; страница приветствия не перехватывает сообщения popup");
    // DeepL без ключа: подсказка в popup и «!» на значке
    await pt.ev("setEngine('deepl'); true");
    await sleep(400);
    assert.strictEqual(await pt.ev("document.querySelector('#setup').hidden"), false);
    console.log("      (popup, DeepL без ключа: " + await pt.ev("document.querySelector('#setupText').textContent") + " | " + await pt.ev("document.querySelector('#setupFix').textContent") + ")");
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "!");
    assert.ok(/не задан ключ DeepL/.test(await pt.ev("chrome.action.getTitle({})")));
    await theme(pt, false); await shotFull(pt, "popup-nokey-light.png", 340);
    await theme(pt, true); await shotFull(pt, "popup-nokey-dark.png", 340);
    await theme(pt, false);
    ok("popup: DeepL без ключа — объяснение с кнопкой «Включить встроенный переводчик», на значке «!»");

    // ---- сайт без ключа (DeepL выбран): ни красного, ни лавины ----
    const web = await b.openTab(WEB);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const pos = async (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    for (const sel of ["#p1", "#p2", "#p3", "#p1"]) { const p = await pos(sel); await web.mouse("mouseMoved", p.x, p.y); await sleep(600); }
    assert.strictEqual(await web.ev("document.querySelectorAll('.ht-error').length"), 0);
    assert.strictEqual(await web.ev("document.querySelector('#p1').textContent"), "The quick brown fox jumps over the lazy dog near the river bank.");
    const hosts = await web.ev("document.querySelectorAll('[data-ht-ui]').length");
    assert.ok(hosts <= 1, "не больше одного уведомления: " + hosts);
    await web.shot("page-nokey.png");
    ok(`сайт, DeepL без ключа: 4 наведения — ни одного красного абзаца, уведомлений на странице: ${hosts}`);
    // включили встроенный кнопкой в popup — значок чистый, сайт переводит встроенным (вживую)
    await pt.ev("document.querySelector('#setupFix').click(); true");
    await sleep(500);
    assert.strictEqual(await pt.ev("engineValue()"), "chrome");   // этап 3: переводчик — переключатели
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "");
    await web.mouse("mouseMoved", 5, 690); await sleep(300);
    const p1 = await pos("#p1");
    await web.mouse("mouseMoved", p1.x, p1.y); await sleep(50); await shiftTap(web);
    const ru1 = await until(async () => { const t = await web.ev("document.querySelector('#p1').textContent"); return /[а-яё]{3}/i.test(t) ? t : ""; }, 10000);
    console.log("      (сайт, встроенный: " + ru1 + ")");
    assert.ok(ru1, "встроенный перевёл абзац на сайте без щелчков (модель уже скачана)");
    await web.shot("page-builtin.png");
    ok("кнопка «Включить встроенный» в popup: значок очищен, сайт переводит встроенным переводчиком без щелчков");

    // выключили ⏻ — «off» на значке
    const D = async (label) => { if (process.env.HT_DEBUG) console.log("      dbg " + label + ":", await web.ev("window.__htDbg()", web.isolated()[0].id), "p1:", (await web.ev("document.querySelector('#p1').textContent")).slice(0, 20)); };
    await D("после dwell");
    await pt.ev("els.enabled.click(); true"); await sleep(300);
    await D("⏻ выкл");
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "off");
    await pt.ev("els.enabled.click(); true"); await sleep(300);
    await D("⏻ вкл");
    if (process.env.HT_DEBUG) console.log("      журнал:", await web.ev("JSON.stringify(window.__htLog)", web.isolated()[0].id));
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "");
    ok("⏻ выключил перевод — на значке «off», включил — чисто");

    // ---- обновление расширения при открытой вкладке ----
    await pt.ev("chrome.storage.local.set({ trigger: 'shift' }).then(() => true)");
    await web.mouse("mouseMoved", 5, 690); await sleep(300);
    await web.mouse("mouseMoved", p1.x, p1.y); await sleep(100);
    await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16);
    await D("сразу после Shift");
    const stuck = await until(async () => /[а-яё]{3}/i.test(await web.ev("document.querySelector('#p1').textContent")), 8000);
    await D("после Shift");
    assert.ok(stuck, "перевод по Shift до обновления");
    await sleep(600);
    console.log("      (перед обновлением p1: " + (await web.ev("document.querySelector('#p1').textContent")).slice(0, 40) + ")");
    if (process.env.HT_DEBUG) console.log("      dbg до:", await web.ev("window.__htDbg()", web.isolated()[0].id));
    const isoBefore = web.isolated().length;
    await web.ev("window.__overs = 0; document.addEventListener('mouseover', () => { window.__overs++; }, true); true", web.isolated()[0].id);
    pageErrors.length = 0;
    // Обновление расширения: повторная загрузка той же папки (chrome.runtime.reload() в этом режиме
    // выгружает расширение насовсем). Старый content-скрипт на вкладке остаётся без связи.
    await b.cmd("Extensions.loadUnpacked", { path: ext });
    await sleep(2500);
    ({ targetInfos } = await b.cmd("Target.getTargets"));
    assert.ok(!targetInfos.some((t) => t.type === "page" && t.url === EXT + "welcome.html"), "при обновлении страница приветствия не открывается");
    const iso = web.isolated();
    console.log(`      (изолированных миров на вкладке: до ${isoBefore}, после ${iso.length}; chrome.runtime.id в старом: ${iso[0] ? await web.ev("String(chrome.runtime.id)", iso[0].id) : "—"})`);
    const p2 = await pos("#p2");
    await web.mouse("mouseMoved", p2.x, p2.y); await sleep(100);
    await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16);
    await sleep(500);
    if (process.env.HT_DEBUG) console.log("      dbg после:", await web.ev("window.__htDbg()", web.isolated()[0].id));
    console.log("      (mouseover в старом мире после обновления: " + await web.ev("window.__overs", web.isolated()[0].id) + "; HUD/уведомлений: " + await web.ev("document.querySelectorAll('[data-ht-ui]').length") + "; ошибки: " + JSON.stringify(pageErrors) + ")");
    assert.strictEqual(await web.ev("document.querySelector('#p1').textContent"), "The quick brown fox jumps over the lazy dog near the river bank.", "старый скрипт вернул оригинал");
    assert.strictEqual(await web.ev("document.querySelectorAll('.ht-error').length"), 0);
    assert.strictEqual(await web.ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "ни одного уведомления");
    const webErr = pageErrors.filter((e) => e.startsWith(web.sessionId));
    assert.deepStrictEqual(webErr, [], "на вкладке нет ошибок в консоли");
    ok("расширение обновили при открытой вкладке: старый скрипт вернул оригиналы и замолчал (без ошибок и уведомлений); приветствие не открылось");

    // popup после обновления: вкладка не отвечает → «обновите вкладку» → «Обновить вкладку» → работает
    const pt2 = await b.openTab(EXT + "popup.html");
    await sleep(1000);
    for (let i = 0; i < 10 && !(await pt2.ev("!!(window.chrome && chrome.tabs)").catch(() => false)); i++) {
      await pt2.cmd("Page.reload"); await sleep(1000);   // расширение ещё перезагружается
    }
    const tabs = JSON.parse(await pt2.ev("chrome.tabs.query({}).then((ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url }))))"));
    const webTab = tabs.find((t) => !t.url);
    console.log("      (вкладки глазами popup: " + JSON.stringify(tabs) + ")");
    // popup открыт вкладкой, а не над сайтом: подменяем «активную вкладку» на вкладку сайта
    await pt2.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${webTab.id}).then((t) => cb([t])); queryTab("getHudState").then((r) => { setHudUI(r && r.hud); if (!r) tabNotResponding(true); }); true`);
    await sleep(500);
    const msg1 = await pt2.ev("els.pageMsg.textContent + ' | кнопка: ' + (els.reloadTab.hidden ? 'нет' : els.reloadTab.textContent)");
    console.log("      (popup на устаревшей вкладке: " + msg1 + ")");
    assert.ok(/обновите вкладку/.test(msg1) && /Обновить вкладку/.test(msg1));
    await theme(pt2, false); await shotFull(pt2, "popup-stale-light.png", 340);
    await pt2.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    const rb = await pt2.ev("(() => { const r = els.reloadTab.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await pt2.click(rb.x, rb.y);
    const msg2 = await until(async () => { const t = await pt2.ev("els.pageMsg.textContent"); return /Обновляю/.test(t) ? "" : t; }, 20000);
    console.log("      (после «Обновить вкладку»: " + msg2 + ")");
    assert.ok(/Готово/.test(msg2), msg2);
    await sleep(500);
    const p1b = await pos("#p1");
    await web.mouse("mouseMoved", 5, 690); await sleep(200);
    await web.mouse("mouseMoved", p1b.x, p1b.y); await sleep(100);
    await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16);
    assert.ok(await until(async () => /[а-яё]{3}/i.test(await web.ev("document.querySelector('#p1').textContent")), 8000), "после обновления вкладки перевод работает");
    ok("popup: вкладка с устаревшим скриптом — «…обновите вкладку» + кнопка; после обновления — «Готово», перевод работает");

    // служебная страница: обновление не помогает → «расширения не работают»
    await b.openTab("chrome://version/");
    await sleep(800);
    await pt2.cmd("Page.reload"); await sleep(1000);   // вернуть настоящий chrome.tabs.query
    const all = JSON.parse(await pt2.ev("chrome.tabs.query({}).then((ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url }))))"));
    const sysTab = all.filter((t) => !t.url).map((t) => t.id).find((tid) => tid !== webTab.id);
    await pt2.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${sysTab}).then((t) => cb([t])); queryTab("getHudState").then((r) => { setHudUI(r && r.hud); if (!r) tabNotResponding(true); }); true`);
    await sleep(400);
    const rb2 = await pt2.ev("(() => { const r = els.reloadTab.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await pt2.click(rb2.x, rb2.y);
    const msg3 = await until(async () => { const t = await pt2.ev("els.pageMsg.textContent"); return /Обновляю/.test(t) ? "" : t; }, 20000);
    console.log("      (служебная страница после «Обновить вкладку»: " + msg3 + ")");
    assert.ok(/расширения не работают/.test(msg3), msg3);
    ok("служебная страница: после «Обновить вкладку» — «На этой странице расширения не работают…»");

    const extErr = pageErrors.filter((e) => !e.startsWith(web.sessionId));
    console.log("      (ошибки в консоли страниц расширения: " + (extErr.length ? JSON.stringify(extErr) : "нет") + ")");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
