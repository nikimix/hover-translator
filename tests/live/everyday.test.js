// Повседневное удобство вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked),
// настоящий встроенный переводчик (модели качаются из сети), страница по HTTP (fixtures/live.html, свой сервер
// lib/server.js): способ включения на приветствии, окно, перевод и Esc, карточка, горячие клавиши, настоящий
// ответ DeepL на выдуманный ключ, выключение на сайте, мини-панель, наведение с задержкой.
// Горячие клавиши: обработчик chrome.commands.onCommand вызываем из service worker (в копии расширения
// в начало background.js дописан крючок, сохраняющий обработчик); настоящее нажатие Alt+Shift+G через
// CDP тоже пробуем и сообщаем, что вышло.
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 10000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const HOOK = `// крючок теста (только в копии): обработчик горячих клавиш доступен из service worker
{ const add = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
  chrome.commands.onCommand.addListener = (fn) => { self.__htOnCommand = fn; add(fn); }; }
`;

(async () => {
  const srv = await serve();
  const LIVE = srv.base + "/live.html";
  const FRAME = srv.other + "/live-frame.html";
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.sessionId + " " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  const theme = (tab, dark) => tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  const shotFull = async (tab, file, width) => {
    await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: 4000, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const h = await tab.ev("Math.ceil(document.body.getBoundingClientRect().bottom)");
    await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    await tab.shot(file);
  };
  try {
    const ext = b.copyExt();
    fs.writeFileSync(path.join(ext, "background.js"), fs.readFileSync(path.join(ext, "background.js"), "utf8").replace('importScripts("shared.js");', 'importScripts("shared.js");\n' + HOOK));
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const swInfo = targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js");
    const sw = await b.attach(swInfo.targetId);

    // ---- приветствие: Shift отмечен, сочетания показаны; готовим встроенный переводчик ----
    const w = await b.attach(targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html").targetId);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    await w.cmd("Page.reload"); await sleep(1200);
    assert.strictEqual(await w.ev("document.querySelector('input[name=trigger]:checked').value"), "shift");
    assert.strictEqual(await w.ev("chrome.storage.local.get('trigger').then((s) => s.trigger)"), "shift", "способ записан при установке");
    const keysHint = await until(async () => { const t = await w.ev("document.querySelector('#keysHint').textContent"); return /Alt\+Shift\+O/.test(t) ? t : ""; }, 3000);
    console.log("      (приветствие, подсказка: " + keysHint + ")");
    assert.ok(/Esc возвращает оригинал/.test(keysHint) && /Alt\+Shift\+G/.test(keysHint) && /chrome:\/\/extensions\/shortcuts/.test(keysHint));
    const shortcuts = await sw.ev("chrome.commands.getAll().then((a) => JSON.stringify(a.map((c) => [c.name, c.shortcut, c.description])))");
    console.log("      (chrome.commands.getAll: " + shortcuts + ")");
    assert.ok(/"toggle-enabled","Alt\+Shift\+O"/.test(shortcuts) && /"translate-page","Alt\+Shift\+G"/.test(shortcuts));
    await theme(w, false); await shotFull(w, "welcome-light.png", 900);
    await theme(w, true); await shotFull(w, "welcome-dark.png", 900);
    await theme(w, false);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    ok("установка: на странице приветствия отмечен Shift (и записан), показаны Esc и сочетания; Chrome назначил Alt+Shift+O и Alt+Shift+G");
    const biText = () => w.ev("document.querySelector('.bi-text').textContent");
    await until(async () => !/Проверяю/.test(await biText()), 10000);
    if (await w.ev("!document.querySelector('.bi-btn').hidden")) {
      await w.ev("document.querySelector('.bi-btn').scrollIntoView({ block: 'center' }); true"); await sleep(200);
      const r = await w.ev("(() => { const r = document.querySelector('.bi-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await w.click(r.x, r.y);
      const done = await until(async () => { const t = await biText(); return /Готово|Не удалось|ещё раз/.test(t) ? t : ""; }, 240000, 400);
      if (/ещё раз/.test(done)) { await w.click(r.x, r.y); await until(async () => /Готово|Не удалось/.test(await biText()), 240000, 400); }
    }
    assert.ok(/Готово/.test(await biText()), await biText());

    // ---- окно расширения (вкладкой; «активная вкладка» подменяется на вкладку сайта) ----
    const web = await b.openTab(LIVE + "?frame=" + encodeURIComponent(FRAME));
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    const pt = await b.openTab(EXT + "popup.html");
    await sleep(1000);
    const webTabId = JSON.parse(await pt.ev("chrome.tabs.query({}).then((ts) => JSON.stringify(ts.filter((t) => !t.url).map((t) => t.id)))"))[0];
    const point = (tab) => tab.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${webTabId}).then((t) => cb([t])); refreshTabState().then(() => true)`);
    await point(pt); await sleep(300);
    const row = await pt.ev("[els.siteRow.hidden, els.siteName.textContent, els.siteOn.checked, els.keysText.textContent, els.badgeRow.hidden, els.enabled.title]");
    console.log("      (окно: сайт «" + row[1] + "», галочка " + row[2] + "; клавиши: " + row[3] + "; ⏻: " + row[5] + ")");
    assert.deepStrictEqual(row.slice(0, 3), [false, "127.0.0.1", true]);
    assert.ok(/Alt\+Shift\+O — включить или выключить перевод/.test(row[3]) && /Esc — вернуть оригинал/.test(row[3]));
    assert.strictEqual(row[4], true, "в режиме замены галочки «исходный язык в карточке» нет");
    await pt.ev("els.displayMode.value = 'popover'; els.displayMode.dispatchEvent(new Event('change')); true"); await sleep(200);
    assert.strictEqual(await pt.ev("els.badgeRow.hidden"), false, "в режиме карточки — есть");
    await pt.ev("setFold(els.moreHead, els.moreBody, true); true");   // этап 3: «Дополнительно»
    await pt.cmd("Page.bringToFront");
    for (const dark of [false, true]) {
      await theme(pt, dark); await shotFull(pt, `popup-${dark ? "dark" : "light"}.png`, 340);
    }
    await theme(pt, false);
    await pt.ev("els.displayMode.value = 'replace'; els.displayMode.dispatchEvent(new Event('change')); setFold(els.moreHead, els.moreBody, false); true"); await sleep(200);
    ok("окно расширения: «Переводить на сайте 127.0.0.1» (имя сайта — от content-скрипта вкладки), сочетания клавиш, галочка метки языка только в режиме карточки");
    // Вкладку окна открыли позже — активна она; щелчки в фоновую вкладку headless Chrome не доставляет.
    await web.cmd("Page.bringToFront"); await sleep(200);

    // ---- сайт: Shift (встроенный), Esc ----
    const pos = (sel, dx = 40) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + ${dx}, y: r.top + r.height / 2, b: r.bottom, t: r.top }; })()`);
    const txt = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    const ru = async (sel) => /[а-яё]{3}/i.test(await txt(sel));
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const esc = async () => { await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    const hover = async (sel, dx) => { const p = await pos(sel, dx); await web.mouse("mouseMoved", p.x, p.y); await sleep(40); await web.mouse("mouseMoved", p.x + 2, p.y); await sleep(40); return p; };
    const away = async () => { await web.mouse("mouseMoved", 990, 750); await sleep(80); };
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ru("#p1"), 8000), "Shift — встроенный перевёл");
    await hover("#p2"); await tapShift();
    assert.ok(await until(() => ru("#p2"), 8000));
    await esc();
    assert.ok(!(await ru("#p1")) && !(await ru("#p2")), "Esc — оригинал везде");
    ok("сайт: Shift переводит встроенным переводчиком, настоящий Esc возвращает оригинал везде");

    // ---- карточка ----
    await pt.ev("chrome.storage.local.set({ displayMode: 'popover' }).then(() => true)"); await sleep(200);
    await hover("#p2"); await tapShift();
    const cardBox = () => web.ev("(() => { const h = [...document.querySelectorAll('[data-ht-ui]')].find((x) => x.style.zIndex === '2147483644'); if (!h) return null; const r = h.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), left: Math.round(r.left) }; })()");
    const c = await until(async () => { const c = await cardBox(); return c && c.bottom - c.top > 50 ? c : null; }, 8000);
    const p2 = await pos("#p2");
    assert.ok(c && c.top >= p2.b && c.top - p2.b < 12, "карточка под абзацем: " + JSON.stringify(c) + " / " + p2.b);
    await sleep(300);
    await web.shot("live-card.png", { clip: { x: 0, y: 0, width: 720, height: 280, scale: 1 } });
    await web.click(c.right - 17, c.top + 17); await sleep(150);       // ✕ в правом верхнем углу
    assert.strictEqual(await cardBox(), null, "✕ закрыл");
    await hover("#p1"); await tapShift(); await until(cardBox, 8000);
    await web.click(900, 700); await sleep(150);
    assert.strictEqual(await cardBox(), null, "щелчок мимо закрыл");
    await hover("#p1"); await tapShift(); await until(cardBox, 8000);
    await esc();
    assert.strictEqual(await cardBox(), null, "Esc закрыл");
    await pt.ev("chrome.storage.local.set({ displayMode: 'replace' }).then(() => true)"); await sleep(200);
    ok("карточка вживую: под абзацем, ✕ (настоящий щелчок), щелчок мимо и Esc закрывают — скриншот live-card.png");

    // ---- горячие клавиши (путь chrome.commands.onCommand) ----
    await away();
    await sw.ev(`__htOnCommand("translate-page", { id: ${webTabId} }).then(() => true)`);
    const toastText = () => web.ev("(() => { const h = [...document.querySelectorAll('[data-ht-ui]')].find((x) => x.style.zIndex === '2147483646'); return h ? 'есть' : ''; })()");
    assert.ok(await until(() => ru("#p3"), 10000), "команда «перевести страницу» перевела");
    await sleep(800);
    await web.shot("live-page-done.png", { clip: { x: 0, y: 380, width: 1000, height: 380, scale: 1 } });
    // «Готово · Вернуть оригинал»: где кнопка, страница не знает (закрытый root) — щёлкаем по координатам уведомления
    const tb = await web.ev("(() => { const h = [...document.querySelectorAll('[data-ht-ui]')].find((x) => x.style.zIndex === '2147483646'); const r = h.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, pe: h.style.pointerEvents }; })()");
    console.log("      (уведомление после «перевести страницу»: " + JSON.stringify(tb) + ")");
    assert.strictEqual(tb.pe, "auto", "уведомление с кнопкой принимает мышь");
    await web.click(tb.x + 14 + 60, tb.y + tb.h - 9 - 13);   // кнопка «Вернуть оригинал» — внизу слева
    await sleep(300);
    assert.ok(!(await ru("#p3")) && !(await ru("#p1")), "«Вернуть оригинал» в уведомлении вернул");
    // вкл/выкл
    await sw.ev(`__htOnCommand("toggle-enabled", { id: ${webTabId} }).then(() => true)`); await sleep(300);
    assert.strictEqual(await pt.ev("chrome.storage.local.get('enabled').then((s) => s.enabled)"), false);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "off");
    await web.shot("live-toggle-off.png", { clip: { x: 150, y: 620, width: 700, height: 140, scale: 1 } });
    await hover("#p1"); await tapShift(); await sleep(600);
    assert.ok(!(await ru("#p1")), "выключено — Shift не переводит");
    await sw.ev(`__htOnCommand("translate-page", { id: ${webTabId} }).then(() => true)`); await sleep(400);
    assert.ok(!(await ru("#p1")));
    await sw.ev(`__htOnCommand("toggle-enabled", { id: ${webTabId} }).then(() => true)`); await sleep(300);
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "");
    ok("горячие клавиши (через chrome.commands.onCommand): «перевести страницу» → «Готово» с кнопкой «Вернуть оригинал» (работает); вкл/выкл → «off» на значке и уведомление на странице");
    // настоящее нажатие через CDP: доходит ли до обработчика сочетаний браузера
    await away();
    await web.key("rawKeyDown", "Alt", "AltLeft", 1, 18);
    await web.key("rawKeyDown", "Shift", "ShiftLeft", 9, 16);
    await web.key("rawKeyDown", "G", "KeyG", 9, 71);
    await web.key("keyUp", "G", "KeyG", 9, 71);
    await web.key("keyUp", "Shift", "ShiftLeft", 1, 16);
    await web.key("keyUp", "Alt", "AltLeft", 0, 18);
    const realKey = await until(() => ru("#p1"), 2500);
    console.log("      (настоящее Alt+Shift+G через CDP Input: " + (realKey ? "сработало" : "до сочетаний браузера не дошло — в headless клавиши идут прямо в страницу") + ")");
    await esc();

    // ---- ошибка с кнопкой: настоящий запрос в DeepL с выдуманным ключом ----
    // этап 3: без согласия запрос в DeepL не уходит — даём его (проверки без согласия — в live/popup.test.js)
    await pt.ev("chrome.storage.local.set({ engine: 'deepl', apiKey: '00000000-0000-0000-0000-000000000000:fx', consent: { deepl: true } }).then(() => true)"); await sleep(300);
    await hover("#p3"); await tapShift();
    const errHost = () => web.ev("(() => { const h = [...document.querySelectorAll('[data-ht-ui]')].find((x) => x.style.zIndex === '2147483646'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, pe: h.style.pointerEvents }; })()");
    const eh = await until(errHost, 20000);
    await sleep(400);
    await web.shot("live-error.png", { clip: { x: 100, y: 560, width: 800, height: 200, scale: 1 } });
    const p3now = await txt("#p3");
    console.log("      (DeepL с выдуманным ключом: " + (/[а-яё]{3}/i.test(p3now) ? "абзац переведён встроенным (сеть до DeepL недоступна → запасной путь)" : "показана ошибка") + "; уведомление " + JSON.stringify(eh) + ")");
    if (!/[а-яё]{3}/i.test(p3now)) {
      const before = (await b.cmd("Target.getTargets")).targetInfos.filter((t) => t.url === EXT + "popup.html").length;
      await web.click(eh.x + 14 + 60, eh.y + eh.h - 9 - 13);   // «Открыть настройки»
      await sleep(1200);
      const after = (await b.cmd("Target.getTargets")).targetInfos.filter((t) => t.url === EXT + "popup.html");
      console.log(`      («Открыть настройки»: окон настроек было ${before}, стало ${after.length} — ${after.map((t) => t.type).join(", ")})`);
      assert.ok(after.length > before, "настройки открылись");
      ok("настоящий ответ DeepL на выдуманный ключ: красное уведомление простыми словами с кнопкой «Открыть настройки»; щелчок открыл настройки");
    } else {
      ok("DeepL недоступен из этой сети: перевод ушёл встроенному переводчику, об этом сказано (запасной путь)");
    }
    await pt.ev("chrome.storage.local.set({ engine: 'chrome', apiKey: '' }).then(() => true)"); await sleep(300);
    await esc();

    // ---- выключить на этом сайте ----
    await point(pt); await sleep(200);
    await pt.ev("els.siteOn.click(); true"); await sleep(400);
    assert.deepStrictEqual(JSON.parse(await pt.ev("chrome.storage.local.get('disabledSites').then((s) => JSON.stringify(s.disabledSites))")), ["127.0.0.1"]);
    assert.strictEqual(await pt.ev(`chrome.action.getBadgeText({ tabId: ${webTabId} })`), "off", "значок этой вкладки — off");
    assert.strictEqual(await pt.ev("chrome.action.getBadgeText({})"), "", "общий значок чистый");
    await hover("#p1"); await tapShift(); await sleep(800);
    assert.ok(!(await ru("#p1")), "на выключенном сайте Shift не переводит");
    await pt.ev("els.translatePage.click(); true"); await sleep(200);
    console.log("      (окно: «Перевести страницу» на выключенном сайте — «" + await pt.ev("els.pageMsg.textContent") + "»)");
    // переход на другой адрес того же сайта — значок «off» снова ставит новая страница
    await web.cmd("Page.navigate", { url: LIVE + "?again=1" }); await sleep(1500);
    const sameSite = await pt.ev(`chrome.action.getBadgeText({ tabId: ${webTabId} })`);
    await web.cmd("Page.navigate", { url: srv.other + "/live.html" }); await sleep(1500);
    const otherSite = await pt.ev(`chrome.action.getBadgeText({ tabId: ${webTabId} })`);
    console.log(`      (значок вкладки: тот же сайт после перехода — «${sameSite}», другой сайт — «${otherSite}»)`);
    assert.strictEqual(sameSite, "off");
    assert.strictEqual(otherSite, "", "Chrome сбрасывает значок вкладки при переходе — на другом сайте он общий");
    await web.cmd("Page.navigate", { url: LIVE }); await sleep(1500);
    await point(pt); await sleep(200);
    assert.strictEqual(await pt.ev("els.siteOn.checked"), false);
    await pt.ev("els.siteOn.click(); true"); await sleep(400);
    assert.strictEqual(await pt.ev(`chrome.action.getBadgeText({ tabId: ${webTabId} })`), "");
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ru("#p1"), 8000), "включили — переводит");
    await esc();
    ok("выключить на этом сайте (окно расширения): Shift не переводит, «off» на значке только этой вкладки, переход по сайту — снова «off», на другом сайте — общий; включили — работает");

    // ---- мини-панель: запоминается между страницами, ⊘ выключает сайт ----
    await point(pt); await sleep(200);
    await pt.ev("els.hudBtn.click(); true"); await sleep(400);
    const hudBox = () => web.ev("(() => { const h = [...document.querySelectorAll('[data-ht-ui]')].find((x) => x.style.zIndex === '2147483645'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()");
    let hb = await hudBox();
    assert.ok(hb, "панель показана");
    // перетащить за ручку (⠿ — слева)
    const gx = hb.x + 13, gy = hb.y + hb.h / 2;
    await web.mouse("mouseMoved", gx, gy); await web.mouse("mousePressed", gx, gy, { button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) await web.mouse("mouseMoved", gx - i * 60, gy - i * 40, { button: "left", buttons: 1 });
    await web.mouse("mouseReleased", gx - 360, gy - 240, { button: "left", clickCount: 1 }); await sleep(300);
    const moved = await hudBox();
    await web.cmd("Page.navigate", { url: LIVE + "?next=1" }); await sleep(1500);
    hb = await hudBox();
    console.log(`      (панель: после перетаскивания ${JSON.stringify(moved)}, на следующей странице ${JSON.stringify(hb)})`);
    assert.ok(hb && hb.x === moved.x && hb.y === moved.y, "на новой странице панель на том же месте");
    await web.shot("live-hud.png", { clip: { x: 0, y: 0, width: 1000, height: 760, scale: 0.7 } });
    // ⊘ — четвёртая кнопка справа налево: ✕, ⊘ (по 28 px + зазор 6 px, отступ 6 px)
    const ox = hb.x + hb.w - 6 - 28 - 6 - 14, oy = hb.y + hb.h / 2;
    await web.click(ox, oy); await sleep(500);
    assert.deepStrictEqual(JSON.parse(await pt.ev("chrome.storage.local.get('disabledSites').then((s) => JSON.stringify(s.disabledSites))")), ["127.0.0.1"], "⊘ выключил сайт");
    assert.strictEqual(await hudBox(), null, "панель скрыта на выключенном сайте");
    await web.shot("live-site-off-toast.png", { clip: { x: 100, y: 600, width: 800, height: 160, scale: 1 } });
    await pt.ev("chrome.storage.local.set({ disabledSites: [] }).then(() => true)"); await sleep(400);
    assert.ok(await hudBox(), "включили сайт — панель вернулась");
    await point(pt); await sleep(200);
    await pt.ev("els.hudBtn.click(); true"); await sleep(300);
    assert.strictEqual(await hudBox(), null);
    ok("мини-панель: показ и место сохраняются при переходе на другую страницу; ⊘ в панели выключает сайт (панель скрывается, возвращается при включении)");

    // ---- наведение с задержкой: прокрутка без движения мыши ----
    await pt.ev("chrome.storage.local.set({ trigger: 'dwell' }).then(() => true)"); await sleep(300);
    await web.ev("document.querySelector('#f4').scrollIntoView({ block: 'center' }); true"); await sleep(200);
    const f4 = await pos("#f4");
    await web.mouse("mouseMoved", f4.x, f4.y); await sleep(30); await web.mouse("mouseMoved", f4.x + 1, f4.y); await sleep(100);
    for (let i = 0; i < 4; i++) { await web.mouse("mouseWheel", f4.x + 1, f4.y, { deltaX: 0, deltaY: 120 }); await sleep(120); }
    await sleep(1500);
    const anyRu = await web.ev("[...document.querySelectorAll('.filler')].some((p) => /[а-яё]{3}/i.test(p.textContent))");
    assert.strictEqual(anyRu, false, "прокрутка без движения мыши ничего не перевела");
    await web.mouse("mouseMoved", f4.x + 4, f4.y + 1);
    const got = await until(() => web.ev("[...document.querySelectorAll('.filler')].some((p) => /[а-яё]{3}/i.test(p.textContent))"), 5000);
    assert.ok(got, "мышь сдвинулась — перевод");
    await web.mouse("mouseMoved", 990, 20); await sleep(300);
    await web.ev("window.scrollTo(0, 0); true"); await sleep(200);
    // ссылка в режиме задержки — нет
    await hover("#navlink", 20); await sleep(1500);
    assert.ok(!(await ru("#navlink")), "ссылку наведением не переводим");
    ok("наведение (600 мс) вживую: прокрутка колесом под неподвижным курсором ничего не переводит, первое движение — переводит; ссылку — нет");

    // ---- Esc во встроенном окне той же вкладки ----
    await pt.ev("chrome.storage.local.set({ trigger: 'shift' }).then(() => true)"); await sleep(300);
    await web.cmd("Page.navigate", { url: LIVE + "?frame=" + encodeURIComponent(FRAME) }); await sleep(1800);
    const fr = await pos("#fr", 60);
    await web.click(fr.x, fr.y - 20); await sleep(200);                 // фокус во встроенное окно
    await web.mouse("mouseMoved", fr.x + 2, fr.y - 20); await sleep(50);
    await tapShift();
    // текст встроенного окна — его же сообщением (окно с другого сайта может жить в отдельном процессе)
    const frameText = () => web.ev(`new Promise((res) => { addEventListener("message", (e) => res(e.data.text), { once: true }); document.querySelector("#fr").contentWindow.postMessage("report", "*"); })`);
    const frameRu = await until(async () => /[а-яё]{3}/i.test(await frameText()), 8000);
    if (!frameRu) {
      // В headless встроенный переводчик во встроенном окне с другого сайта (даже с allow="translator")
      // так и не перевёл — рассылку Esc по фреймам проверяют заглушки (page/everyday.test.js, unit/background-errors.test.js).
      console.log("      (встроенное окно с другого сайта: встроенный переводчик там не перевёл — «" + (await frameText()).slice(0, 30) + "…»; Esc по фреймам вживую не проверен)");
    } else {
      await web.click(900, 30); await sleep(150);                           // фокус обратно на страницу
      await hover("#p1"); await tapShift();
      assert.ok(await until(() => ru("#p1"), 8000));
      await esc(); await sleep(400);
      const ft = await frameText();
      console.log("      (Esc на странице: #p1 «" + (await txt("#p1")).slice(0, 25) + "», во встроенном окне «" + ft.slice(0, 25) + "»)");
      assert.ok(!(await ru("#p1")) && !/[а-яё]{3}/i.test(ft), "Esc вернул оригинал и во встроенном окне (через background)");
      ok("Esc на странице возвращает оригинал и во встроенном окне с другого адреса (рассылка через background)");
    }

    const errs = pageErrors.filter((e) => !/favicon/.test(e));
    console.log("      (исключения в консоли: " + (errs.length ? JSON.stringify(errs) : "нет") + ")");
    assert.deepStrictEqual(errs, []);
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
