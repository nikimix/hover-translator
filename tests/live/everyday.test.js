// Повседневное удобство вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked), настоящий
// встроенный переводчик (модели качаются из сети), страница по HTTP (fixtures/live.html, свой сервер lib/server.js).
// Окно расширения — как настоящее, нажатием на значок (CDP Extensions.triggerAction, activeTab).
// Проверяет: сочетания клавиш (Chrome назначил; страница настроек и окно их показывают); Shift и Esc на сайте;
// карточку (под абзацем, пара языков, обводка абзаца, ✕, щелчок мимо, Esc); перевод выделенного (Shift над выделенным
// словом — карточка под строкой, сообщение пункта меню); горячие клавиши (перевести страницу →
// «Страница переведена» + «Показать оригинал», повторно — оригинал; вкл/выкл → «off» на значке и уведомления);
// перевод страницы из окна: «Перевожу… N из M» по видимым абзацам, «Стоп» без отката,
// «Переведено N абзацев · Показать оригинал», сегмент «Оригинал | Перевод» без повторных запросов, смена языка на
// переведённой странице, Esc; настоящий ответ DeepL на выдуманный ключ → «Открыть настройки»; выключение сайта из
// окна (значок вкладки, переходы); плавающая кнопка (из окна, перетаскивание и место между страницами, меню по щелчку:
// перевод и оригинал, выключить сайт, скрыть с «Вернуть»); наведение с задержкой (прокрутка без движения мыши не переводит, ссылки — тоже); Esc во встроенном окне.
// Для перевода страницы DeepL с платным ключом — заглушка с задержкой (в копии background.js подменён адрес
// api.deepl.com; бесплатный api-free.deepl.com — настоящий). Горячие клавиши: обработчик chrome.commands.onCommand
// вызываем из service worker (в копии background.js крючок сохраняет обработчик); настоящее нажатие Alt+Shift+G
// через CDP тоже пробуем и сообщаем, что вышло. Скриншоты — с tests/run.sh --shots.
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { launch, sleep, until } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { pageUi, findIn, hasCls, fabUi, centerOf, clickUi, popupOpener, popupView, clickSel, prepareBuiltin, mockDeepl } = require("../lib/live");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const HOOK = `// крючок теста (только в копии): обработчик горячих клавиш доступен из service worker
{ const add = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
  chrome.commands.onCommand.addListener = (fn) => { self.__htOnCommand = fn; add(fn); }; }
`;
const FAKE_FREE_KEY = "00000000-0000-0000-0000-000000000000:fx";   // настоящий DeepL (api-free)
const MOCK_KEY = "mock-paid-key-0000";                              // платный — в заглушку

// Сочетания клавиш — в новом временном профиле: в постоянном (HT_PROFILE) их могут держать копии расширения от
// прошлых прогонов (Chrome не снимает привязку, когда папки копии больше нет), и новая копия их не получает.
// Модели переводчика тут не нужны: DeepL с ключом и согласием — окно в обычном состоянии с «Перевести страницу».
async function shortcutsFresh(srvBase) {
  const b = await launch({ lang: "ru" });
  try {
    const ext = b.copyExt();
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1200);
    const { targetInfos } = await b.cmd("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const sw = await b.attach(targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js").targetId);
    const msg = (key, subs) => sw.ev(`chrome.i18n.getMessage(${JSON.stringify(key)}${subs != null ? ", " + JSON.stringify(subs) : ""})`);
    await sw.ev(`chrome.storage.local.set({ engine: "deepl", apiKey: "k", consent: { deepl: true } }).then(() => true)`);
    const shortcuts = JSON.parse(await sw.ev("chrome.commands.getAll().then((a) => JSON.stringify(a.map((c) => [c.name, c.shortcut])))"));
    console.log("      (новый профиль, chrome.commands.getAll: " + JSON.stringify(shortcuts) + ")");
    assert.ok(shortcuts.some(([n, s]) => n === "toggle-enabled" && s === "Alt+Shift+O") && shortcuts.some(([n, s]) => n === "translate-page" && s === "Alt+Shift+G"), "Chrome назначил сочетания из manifest.json");
    const opt = await b.openTab(EXT + "options.html");
    const keys = await until(async () => { const k = await opt.ev("[...document.querySelectorAll('#keys .kbd')].map((e) => e.textContent)").catch(() => []); return k.length >= 3 ? k : null; }, 5000);
    console.log("      (настройки, «Горячие клавиши»: " + JSON.stringify(keys) + ")");
    assert.deepStrictEqual(keys, ["Alt+Shift+G", "Alt+Shift+O", "Esc"]);
    await b.cmd("Target.closeTarget", { targetId: opt.targetId });
    const web = await b.openTab(srvBase + "/live.html");
    await sleep(1000);
    const pop = popupOpener(b, id);
    const p = await pop.open(web, (u) => u.startsWith(srvBase));
    const tips = JSON.parse(await p.ev(`JSON.stringify([HT_popup.view().n, document.querySelector(".p-scope").title,
      (document.querySelector("button[data-k=translate]") || {}).title, (document.querySelector(".p-act .hint .kbd") || {}).textContent])`));
    console.log("      (окно: " + JSON.stringify(tips) + ")");
    assert.deepStrictEqual(tips, [0, await msg("ppScopeTipKey", "Alt+Shift+O"), "Alt+Shift+G", "Shift"]);
    await pop.close();
  } finally {
    await b.close();
  }
}

(async () => {
  const srv = await serve();
  const api = await mockDeepl();
  const LIVE = srv.base + "/live.html";
  const FRAME = srv.other + "/live-frame.html";
  await shortcutsFresh(srv.base);
  ok("сочетания клавиш (новый профиль): Chrome назначил Alt+Shift+O и Alt+Shift+G; настройки («Горячие клавиши») показывают их и Esc; окно — в подсказке «Везде», у «Перевести страницу» и клавишу Shift");
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.sessionId + " " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  try {
    const ext = b.copyExt();
    const bg = path.join(ext, "background.js");
    fs.writeFileSync(bg, fs.readFileSync(bg, "utf8")
      .replace('importScripts("shared.js");', 'importScripts("shared.js");\n' + HOOK)
      .replaceAll("https://api.deepl.com", api.base + "/deepl"));
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    const { targetInfos } = await b.cmd("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const sw = await b.attach(targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js").targetId);
    const store = (o) => sw.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    const get = async (keys) => JSON.parse(await sw.ev(`chrome.storage.local.get(${JSON.stringify(keys)}).then((s) => JSON.stringify(s))`));
    const badge = (tabId) => sw.ev(`chrome.action.getBadgeText(${tabId ? `{ tabId: ${tabId} }` : "{}"})`);
    const msg = (key, subs) => sw.ev(`chrome.i18n.getMessage(${JSON.stringify(key)}${subs != null ? ", " + JSON.stringify(subs) : ""})`);
    const command = (name) => sw.ev(`__htOnCommand(${JSON.stringify(name)}, { id: ${webTabId} }).then(() => true)`);
    const targetsNow = async () => (await b.cmd("Target.getTargets")).targetInfos;

    // ---- встроенный переводчик — на приветствии (скачать, если в профиле его ещё нет) ----
    const w = await b.attach(targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html").targetId);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    const ws = await prepareBuiltin(w);
    assert.ok(/^(ready|ready-hover|success)$/.test(ws), "встроенный переводчик готов: " + ws);

    const web = await b.openTab(LIVE);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await sleep(200);
    const webTabId = await sw.ev("chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id)");
    const pop = popupOpener(b, id);
    const onLive = (u) => u.startsWith(LIVE);
    const front = async () => { await b.cmd("Target.activateTarget", { targetId: web.targetId }); await web.cmd("Page.bringToFront"); await sleep(200); };

    // Сочетание «вкл/выкл» в этом профиле (в постоянном его может держать прежняя копия — тогда пусто):
    // уведомления ниже называют именно его.
    const KEY_TOGGLE = await sw.ev("chrome.commands.getAll().then((a) => (a.find((c) => c.name === 'toggle-enabled') || {}).shortcut || '')");
    if (!KEY_TOGGLE) console.log("      (в этом профиле Alt+Shift+O держит прежняя копия расширения — сочетание не назначено)");
    let p;

    // ---- сайт: Shift (встроенный), Esc ----
    await front();
    const pos = (sel, dx = 40) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + ${dx}, y: r.top + r.height / 2, b: r.bottom, t: r.top, l: r.left }; })()`);
    const txt = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    const ru = async (sel) => /[а-яё]{3}/i.test(await txt(sel));
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const esc = async () => { await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    const hover = async (sel, dx) => { const q = await pos(sel, dx); await web.mouse("mouseMoved", q.x, q.y); await sleep(40); await web.mouse("mouseMoved", q.x + 2, q.y); await sleep(40); return q; };
    const away = async () => { await web.mouse("mouseMoved", 990, 750); await sleep(80); };
    const toastNow = async () => (await pageUi(web)).toast;
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ru("#p1"), 8000), "Shift — встроенный перевёл");
    await hover("#p2"); await tapShift();
    assert.ok(await until(() => ru("#p2"), 8000));
    await esc();
    assert.ok(!(await ru("#p1")) && !(await ru("#p2")), "Esc — оригинал везде");
    ok("сайт: Shift переводит встроенным переводчиком, настоящий Esc возвращает оригинал везде");

    // ---- карточка ----
    await store({ displayMode: "popover" }); await sleep(200);
    await hover("#p2"); await tapShift();
    const cardBox = async () => { const c = (await pageUi(web)).card; if (!c) return null; const r = await centerOf(web, c.hostId); return r && { top: Math.round(r.top), bottom: Math.round(r.top + r.h), left: Math.round(r.left), right: Math.round(r.left + r.w), texts: c.texts }; };
    const c = await until(async () => { const x = await cardBox(); return x && x.bottom - x.top > 50 ? x : null; }, 8000);
    const p2 = await pos("#p2");
    const pairEnRu = await sw.ev(`(() => { const s = HT_langLabel("en"); return HT_t("pairArrow", [s[0].toLocaleUpperCase("ru") + s.slice(1), HT_langLabel("ru")]); })()`);
    const ring = await web.ev("document.querySelector('#p2').style.outline");
    console.log("      (карточка: " + JSON.stringify(c) + "; абзац: низ " + p2.b + ", обводка «" + ring + "»)");
    assert.ok(c && c.top >= p2.b && c.top - p2.b < 32, "карточка под абзацем: " + JSON.stringify(c) + " / " + p2.b);
    assert.ok(c.texts.includes(pairEnRu), "на карточке — пара языков «" + pairEnRu + "»: " + JSON.stringify(c.texts));
    assert.ok(c.texts.some((t) => /[а-яё]{3}/i.test(t) && !t.includes("→")), "перевод на карточке");
    assert.ok(/\b2px\b/.test(ring) && /solid/.test(ring), "абзац обведён 2 px: " + ring);
    assert.ok(!(await ru("#p2")), "сам абзац не тронут");
    await sleep(300);
    await web.shot("live-card.png", { clip: { x: 0, y: 0, width: 720, height: 300, scale: 1 } });
    await clickUi(web, "card", await msg("cardCloseAria"));
    await sleep(150);
    assert.strictEqual(await cardBox(), null, "✕ закрыл");
    assert.strictEqual(await web.ev("document.querySelector('#p2').style.outline"), "", "обводка снята");
    await hover("#p1"); await tapShift(); await until(cardBox, 8000);
    await web.click(900, 700); await sleep(150);
    assert.strictEqual(await cardBox(), null, "щелчок мимо закрыл");
    await hover("#p1"); await tapShift(); await until(cardBox, 8000);
    await esc();
    assert.strictEqual(await cardBox(), null, "Esc закрыл");
    // «Язык оригинала на карточке» выключен — пары нет
    await store({ showLangBadge: false }); await sleep(200);
    await hover("#p2"); await tapShift();
    const c2 = await until(cardBox, 8000);
    assert.ok(c2 && !c2.texts.includes(pairEnRu), "без пары языков: " + JSON.stringify(c2 && c2.texts));
    await esc();
    await store({ displayMode: "replace", showLangBadge: true }); await sleep(200);
    ok("карточка вживую: под абзацем, пара «" + pairEnRu + "» (без неё, когда выключено в настройках), абзац обведён 2 px и не тронут; ✕ (настоящий щелчок), щелчок мимо и Esc закрывают, обводка снимается");

    // ---- перевод выделенного: Shift над выделенным словом и сообщение пункта меню ----
    {
      const wb = await web.ev(`(() => { const n = document.querySelector('#p1').firstChild, i = n.nodeValue.indexOf('brown');
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 5); const q = r.getBoundingClientRect();
        return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), b: q.bottom }; })()`);
      await web.mouse("mouseMoved", wb.x - 2, wb.y); await sleep(40); await web.mouse("mouseMoved", wb.x, wb.y); await sleep(40);
      for (const clickCount of [1, 2]) {
        await web.mouse("mousePressed", wb.x, wb.y, { button: "left", buttons: 1, clickCount });
        await web.mouse("mouseReleased", wb.x, wb.y, { button: "left", buttons: 0, clickCount });
      }
      await sleep(150);
      assert.strictEqual(await web.ev("String(getSelection())"), "brown", "двойной щелчок выделил слово");
      await tapShift();
      const sc = await until(async () => { const x = await cardBox(); return x && x.texts.some((t) => /[а-яё]{3}/i.test(t) && !t.includes("→")) ? x : null; }, 15000);
      assert.ok(sc, "карточка с переводом выделенного: " + JSON.stringify(await cardBox()));
      assert.ok(sc.top >= wb.b && sc.top - wb.b < 24, "карточка под строкой слова: " + JSON.stringify(sc) + " / " + wb.b);
      assert.ok(!(await ru("#p1")), "абзац не заменён (режим замены)");
      assert.strictEqual(await web.ev("String(getSelection())"), "brown", "выделение на месте");
      await web.shot("live-selection.png", { clip: { x: 0, y: 0, width: 720, height: 260, scale: 1 } });
      await esc();
      assert.strictEqual(await cardBox(), null, "Esc закрыл карточку выделенного");
      // Пункт меню: разрешение есть, а сообщение, которое шлёт его обработчик, переводит выделенное в этой вкладке.
      assert.strictEqual(await sw.ev("chrome.permissions.contains({ permissions: ['contextMenus'] })"), true, "разрешение contextMenus");
      await sw.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "translateSelection", text: "brown" }, { frameId: 0 }).then(() => true)`);
      const mc = await until(async () => { const x = await cardBox(); return x && x.texts.some((t) => /[а-яё]{3}/i.test(t) && !t.includes("→")) ? x : null; }, 15000);
      assert.ok(mc, "карточка по сообщению пункта меню");
      await esc();
      await web.click(900, 700); await sleep(150);
      ok("перевод выделенного вживую: двойной щелчок по слову и Shift — карточка с переводом встроенного под строкой слова, абзац и выделение на месте, Esc закрывает; разрешение contextMenus есть, сообщение пункта меню переводит выделенное карточкой");
    }

    // ---- горячие клавиши (путь chrome.commands.onCommand) ----
    await away();
    await command("translate-page");
    assert.ok(await until(() => ru("#p3"), 10000), "команда «перевести страницу» перевела");
    const done = await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csPageDone")) ? t : null; }, 5000);
    console.log("      (уведомление после «перевести страницу»: " + JSON.stringify(done && done.texts) + ")");
    assert.ok(done && done.texts.includes(await msg("csShowOrig")) && done.texts.includes("Esc"), "«Страница переведена» с «Показать оригинал» или Esc");
    await sleep(500);
    await web.shot("live-page-done.png", { clip: { x: 0, y: 0, width: 1000, height: 380, scale: 1 } });
    await clickUi(web, "toast", await msg("csShowOrig"));
    await sleep(300);
    assert.ok(!(await ru("#p3")) && !(await ru("#p1")), "«Показать оригинал» в уведомлении вернул");
    // на переведённой странице сочетание — переключатель: второе нажатие возвращает оригинал
    await command("translate-page");
    assert.ok(await until(() => ru("#p1"), 10000));
    await sleep(300);
    await command("translate-page");
    assert.ok(await until(async () => !(await ru("#p1")), 3000), "второе нажатие — оригинал");
    assert.ok(await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csOrigShown")); }, 3000), "сказано, что показан оригинал");
    // вкл/выкл
    await command("toggle-enabled"); await sleep(300);
    assert.strictEqual((await get(["enabled"])).enabled, false);
    assert.strictEqual(await badge(), "off");
    const offT = await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csOffTitle")) ? t : null; }, 3000);
    assert.ok(offT && (KEY_TOGGLE ? offT.texts.includes(await msg("csOffKeys", KEY_TOGGLE)) : true), "уведомление «выключено» с сочетанием: " + JSON.stringify(offT && offT.texts));
    await web.shot("live-toggle-off.png", { clip: { x: 500, y: 0, width: 500, height: 160, scale: 1 } });
    await hover("#p1"); await tapShift(); await sleep(600);
    assert.ok(!(await ru("#p1")), "выключено — Shift не переводит");
    await command("translate-page"); await sleep(400);
    assert.ok(!(await ru("#p1")));
    const howOn = KEY_TOGGLE ? await msg("csOffPageKeys", KEY_TOGGLE) : await msg("csOffWindow");
    assert.ok(await until(async () => { const t = await toastNow(); return t && t.texts.includes(howOn); }, 3000), "«перевести страницу» при выключенном — подсказка, как включить: " + howOn);
    await command("toggle-enabled"); await sleep(300);
    assert.strictEqual(await badge(), "");
    assert.ok(await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csOnTitle")); }, 3000));
    ok("горячие клавиши (через chrome.commands.onCommand): «перевести страницу» → «Страница переведена» с «Показать оригинал» (работает) или Esc, повторное нажатие — оригинал; вкл/выкл → «off» на значке и уведомления, выключенное не переводит");
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
    // (до перевода заглушкой: сохранённый перевод абзаца DeepL отдал бы из кэша, без запроса)
    await store({ engine: "deepl", apiKey: FAKE_FREE_KEY, consent: { deepl: true, openai: false, anthropic: false } }); await sleep(300);
    await front(); await away();
    await hover("#p3"); await tapShift();
    const errT = await until(async () => { const t = await toastNow(); return t && t.texts.length ? t : null; }, 20000, 200);
    await sleep(400);
    await web.shot("live-error.png", { clip: { x: 500, y: 0, width: 500, height: 200, scale: 1 } });
    const p3now = await txt("#p3");
    console.log("      (DeepL с выдуманным ключом: " + (/[а-яё]{3}/i.test(p3now) ? "абзац переведён встроенным (сеть до DeepL недоступна → запасной путь)" : "показана ошибка") + "; уведомление " + JSON.stringify(errT && errT.texts) + ")");
    if (!/[а-яё]{3}/i.test(p3now)) {
      assert.ok(errT && errT.texts.includes(await msg("csBadKeyTitle", "DeepL")) && errT.texts.includes(await msg("openSettings")), "«DeepL не принял ключ» с «Открыть настройки»");
      assert.ok(errT.els.some((e) => e.attrs.role === "alert"), "role=alert");
      assert.strictEqual(await web.ev("document.querySelectorAll('#p3.ht-error').length"), 1, "абзац с красной меткой");
      await clickUi(web, "toast", await msg("openSettings"));
      const optT = await until(async () => (await targetsNow()).find((t) => t.type === "page" && t.url.startsWith(EXT + "options.html")), 6000, 150);
      assert.ok(optT, "настройки открылись");
      const o2 = await b.attach(optT.targetId);
      const f = await until(async () => { const x = await o2.ev("document.activeElement && document.activeElement.id").catch(() => ""); return x === "deepl-key" ? x : ""; }, 6000, 150);
      console.log("      («Открыть настройки»: " + optT.url + ", фокус #" + f + ")");
      assert.strictEqual(f, "deepl-key", "фокус в поле ключа DeepL");
      await b.cmd("Target.closeTarget", { targetId: optT.targetId });
      ok("настоящий ответ DeepL на выдуманный ключ: абзац с красной меткой, уведомление «DeepL не принял ключ» (role=alert) с «Открыть настройки»; щелчок открыл настройки с фокусом в поле ключа");
    } else {
      const fb = await Promise.all(["csFbNetwork", "csFbTimeout", "csFbServer"].map((k) => msg(k)));
      assert.ok(errT && errT.texts.some((t) => fb.includes(t)), "о запасном пути сказано: " + JSON.stringify(errT && errT.texts));
      ok("DeepL недоступен из этой сети: перевод ушёл встроенному переводчику, об этом сказано (запасной путь)");
    }
    await store({ engine: "chrome", apiKey: "" }); await sleep(300);
    await front(); await esc();

    // ---- перевод страницы из окна: «Перевожу… N из M», «Стоп», сегмент, смена языка (DeepL — заглушка) ----
    await store({ engine: "deepl", apiKey: MOCK_KEY, keyVerified: true, consent: { deepl: true, openai: false, anthropic: false } });
    await web.cmd("Page.navigate", { url: LIVE + "?page=1" }); await sleep(1500);
    const marked = (tag) => web.ev(`[...document.querySelectorAll("p, nav")].filter((e) => e.textContent.startsWith("[${tag}] ") || [...e.querySelectorAll("a")].some((a) => a.textContent.startsWith("[${tag}] "))).length`);
    const allCandidates = await web.ev("document.querySelectorAll('p:not(:empty), nav').length - 1");   // без <p><br></p>
    api.delay = 1500;
    // Chrome без интерфейса иногда закрывает окно, открытое через triggerAction, посреди перерисовок (окну
    // приходят события resize того же размера, затем оно теряет фокус) — расширение тут ни при чём. Окно — вид
    // состояния вкладки, поэтому такое окно просто открываем снова тем же нажатием на значок.
    p = null;
    let reopened = 0;
    const P = async () => {
      if (!p || !(await p.ev("!!window.HT_popup").catch(() => false))) { if (p) reopened++; p = await pop.open(web, onLive); }
      return p;
    };
    const pv = async () => popupView(await P());
    const pev = async (e) => (await P()).ev(e);
    const pclick = async (sel) => clickSel(await P(), sel);
    const tsNow = () => pev("JSON.stringify(HT_popup.facts.ts)").then(JSON.parse);
    assert.strictEqual((await pv()).n, 0);
    const n0 = api.translates();
    await pclick("button[data-k=translate]");
    const mid = await until(async () => { const v = await pv(); const t = await tsNow(); return v.n === 3 && t.done > 0 && t.done < t.total ? { v, t } : null; }, 12000, 60);
    assert.ok(mid, "окно показало ход перевода: " + JSON.stringify(await pv()));
    const busyN = await msg("ppBusyN", [String(mid.t.done), String(mid.t.total)]);
    console.log("      (идёт перевод: «" + mid.v.busy + "», hint «" + mid.v.hint + "»; видимых " + mid.t.total + " из " + allCandidates + " абзацев)");
    assert.ok(mid.v.busy.endsWith(busyN), mid.v.busy + " / " + busyN);
    assert.ok(mid.t.total < allCandidates, "счёт — по видимым абзацам");
    assert.strictEqual(mid.v.hint, await msg("ppRestLater"));
    await pclick("button[data-k=stop]");
    const part = await until(async () => { const v = await pv(); return v.n === 6 ? v : null; }, 4000, 60);
    assert.ok(part, "после «Стоп» — «Переведено N»: " + JSON.stringify(await pv()));
    const cnt = (await tsNow()).count;
    const onPage = await marked("RU");
    const pulsing = await web.ev("document.querySelectorAll('.ht-loading').length");
    assert.strictEqual(pulsing, 0, "после «Стоп» у отменённых пачек пульс «идёт перевод» снят сразу, не дожидаясь ответа");
    await sleep(api.delay + 700);                                  // пачки, отправленные до «Стоп», вернулись
    const onPage2 = await marked("RU");
    const partHint = (await pev(`HT_plural("ppPartDone", ${cnt})`)) + " · " + (await msg("ppShowOrig"));
    console.log("      (после «Стоп»: «" + part.hint + "»; переведено на странице " + onPage + ", через " + (api.delay + 700) + " мс " + onPage2 + "; запросов " + (api.translates() - n0) + "; сразу после «Стоп» с подложкой «идёт перевод» — " + pulsing + ", после ответа — " + await web.ev("document.querySelectorAll('.ht-loading').length") + ")");
    assert.ok(cnt > 0 && cnt === onPage && onPage2 === onPage, "переведённое остаётся, пачки в полёте на страницу не попали");
    assert.strictEqual(part.hint, partHint);
    assert.strictEqual((await tsNow()).count, cnt);
    await (await P()).shot("popup-part.png");
    await pclick("button[data-k=link-restore]");
    assert.ok(await until(async () => (await pv()).n === 0, 3000), "«Показать оригинал» — обычное состояние");
    assert.strictEqual(await marked("RU"), 0, "оригинал вернулся");
    ok(`перевод страницы из окна: «${mid.v.busy}» — только видимые (${mid.t.total} из ${allCandidates}); «Стоп» — переведённое (${cnt}) остаётся, пачки в полёте на страницу не попадают; «${part.hint}» — ссылка возвращает оригинал`);

    api.delay = 200;
    await pclick("button[data-k=translate]");
    let v = await until(async () => { const x = await pv(); return x.n === 4 ? x : null; }, 15000, 100);
    const pairTxt = await pev(`HT_ui.pair("en", "RU")`);
    assert.ok(v, "страница переведена — сегмент");
    assert.deepStrictEqual(v.seg, ["orig:false", "tr:true"]);
    assert.strictEqual(v.hint, await msg("ppEscHint", pairTxt));
    const nTr = await marked("RU");
    assert.ok(nTr >= mid.t.total, "видимое переведено: " + nTr);
    const req1 = api.translates();
    await pclick("button[data-k=orig]");
    v = await until(async () => { const x = await pv(); return x.n === 5 ? x : null; }, 3000, 60);
    assert.ok(v && v.hint === await msg("ppOrigHint", pairTxt), "«Оригинал»: " + JSON.stringify(v));
    assert.deepStrictEqual(v.seg, ["orig:true", "tr:false"]);
    assert.strictEqual(await marked("RU"), 0, "показан оригинал");
    await pclick("button[data-k=tr]");
    assert.ok(await until(async () => (await pv()).n === 4 && (await marked("RU")) >= nTr, 8000, 100), "«Перевод» — снова переведено");
    assert.strictEqual(api.translates(), req1, "«Перевод» в сегменте — из сохранённых, без запросов к DeepL");
    await (await P()).shot("popup-done.png");
    // смена языка на переведённой странице — переводит заново
    await pev("(() => { const s = document.querySelector('#target'); s.value = 'DE'; s.dispatchEvent(new Event('change')); return true; })()");
    assert.ok(await until(async () => (await marked("DE")) >= nTr && (await marked("RU")) === 0, 10000, 150), "переведено на немецкий");
    v = await until(async () => { const x = await pv(); return x.n === 4 ? x : null; }, 5000, 100);
    assert.strictEqual(v.hint, await msg("ppEscHint", await pev(`HT_ui.pair("en", "DE")`)));
    assert.ok((await get(["recentLangs"])).recentLangs.slice(0, 2).join() === "DE,RU", "недавние языки");
    // остальное — при прокрутке
    await web.ev("window.scrollTo(0, document.body.scrollHeight); true");
    assert.ok(await until(() => web.ev("document.querySelector('#f24').textContent.startsWith('[DE] ')"), 8000), "прокрутили — переведено и внизу");
    await web.ev("window.scrollTo(0, 0); true");
    // Esc на странице — оригинал; окно (открыто заново: щелчок по вкладке его закрывает) — сегмент на «Оригинал»
    await pop.close();
    await front(); await esc();
    assert.ok(await until(async () => (await pv()).n === 5, 3000), "Esc — окно показывает «Оригинал»");
    assert.strictEqual(await marked("DE"), 0);
    await pop.close();
    if (reopened) console.log("      (окно закрылось само и открыто снова: " + reopened + " раз)");
    await store({ engine: "chrome", apiKey: "", targetLang: "RU" }); await sleep(300);
    await web.cmd("Page.navigate", { url: LIVE }); await sleep(1500);
    ok("сегмент «Оригинал | Перевод»: «" + v.hint + "»; «Оригинал» возвращает страницу, «Перевод» — из сохранённых без запросов; смена языка на переведённой странице переводит заново (DE), прокрутка — остальное; Esc — окно на «Оригинале»");

    // ---- выключить на этом сайте (окно) ----
    p = await pop.open(web, onLive);
    await clickSel(p, ".srow");
    assert.ok(await until(async () => (await popupView(p)).n === 8, 3000), "окно — «На этом сайте выключено»");
    await pop.close();
    assert.deepStrictEqual((await get(["disabledSites"])).disabledSites, ["127.0.0.1"]);
    await sleep(300);
    assert.strictEqual(await badge(webTabId), "off", "значок этой вкладки — off");
    assert.strictEqual(await badge(), "", "общий значок чистый");
    await front();
    await hover("#p1"); await tapShift(); await sleep(800);
    assert.ok(!(await ru("#p1")), "на выключенном сайте Shift не переводит");
    await command("translate-page");
    assert.ok(await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csSiteOffTitle")); }, 3000), "сочетание «перевести страницу» на выключенном сайте — объяснение");
    assert.ok(!(await ru("#p3")));
    // переход на другой адрес того же сайта — значок «off» снова ставит новая страница
    await web.cmd("Page.navigate", { url: LIVE + "?again=1" }); await sleep(1500);
    const sameSite = await badge(webTabId);
    await web.cmd("Page.navigate", { url: srv.other + "/live.html" }); await sleep(1500);
    const otherSite = await badge(webTabId);
    console.log(`      (значок вкладки: тот же сайт после перехода — «${sameSite}», другой сайт — «${otherSite}»)`);
    assert.strictEqual(sameSite, "off");
    assert.strictEqual(otherSite, "", "Chrome сбрасывает значок вкладки при переходе — на другом сайте он общий");
    await web.cmd("Page.navigate", { url: LIVE }); await sleep(1500);
    p = await pop.open(web, onLive);
    v = await popupView(p);
    assert.ok(v.n === 8 && v.site && v.site.on === false, JSON.stringify(v));
    await clickSel(p, ".srow");
    assert.ok(await until(async () => (await popupView(p)).n === 0, 3000));
    await pop.close();
    await sleep(300);
    assert.strictEqual(await badge(webTabId), "");
    await front(); await hover("#p1"); await tapShift();
    assert.ok(await until(() => ru("#p1"), 8000), "включили — переводит");
    await esc();
    ok("выключить на этом сайте (строка сайта в окне): Shift и сочетание не переводят (объяснение на странице), «off» на значке только этой вкладки, переход по сайту — снова «off», на другом сайте — общий; включили — работает");

    // ---- плавающая кнопка ----
    p = await pop.open(web, onLive);
    await clickSel(p, ".p-foot button[aria-pressed]");
    assert.ok(await until(async () => (await popupView(p)).fab === true, 3000), "кнопка «Плавающая кнопка» в окне нажата");
    await pop.close();
    await front();
    const fabBox = async () => { const u = await fabUi(web); const r = u && u.fab && await centerOf(web, u.fab.nodeId);
      return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.w), h: Math.round(r.h), cx: Math.round(r.x), cy: Math.round(r.y) } : null; };
    // Кнопки над кружком (столбик #fk): главная, язык, «⋯». Щелчок по кружку их закрепляет; «⋯» — панель с пунктами.
    const barOpen = async () => { const u = await fabUi(web); return !!(u && u.open); };
    const openBar = async () => {
      if (await barOpen()) return;
      const q = await fabBox();
      await web.click(q.cx, q.cy);
      assert.ok(await until(barOpen, 2000), "щелчок по кружку показал кнопки над ним");
    };
    const openMore = async () => {
      await openBar();
      if ((await fabUi(web)).panel !== "more") await clickUi(web, "hud", await msg("csFkMore"));
      assert.ok(await until(async () => (await fabUi(web)).panel === "more", 2000), "«⋯» открыла панель с пунктами");
    };
    const mainIs = async (act) => { const u = await fabUi(web); return !!(u && u.open && u.main && u.main.attrs["data-act"] === act) && u.main; };
    let fb = await until(fabBox, 3000);
    const vp = JSON.parse(await web.ev("JSON.stringify([document.documentElement.clientWidth, document.documentElement.clientHeight])"));
    console.log("      (кружок: " + JSON.stringify(fb) + ", окно " + vp + ")");
    assert.ok(fb && Math.abs(vp[0] - (fb.x + fb.w) - 16) <= 1 && Math.abs(vp[1] - (fb.y + fb.h) - 16) <= 1 && fb.w === 44 && fb.h === 44, "справа внизу, отступ 16, 44 × 44");
    // перетащить к левому краю — настоящими событиями мыши
    await web.mouse("mouseMoved", fb.cx, fb.cy); await web.mouse("mousePressed", fb.cx, fb.cy, { button: "left", clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) { await web.mouse("mouseMoved", fb.cx - i * 80, fb.cy - i * 40, { button: "left", buttons: 1 }); await sleep(16); }
    await web.mouse("mouseReleased", fb.cx - 640, fb.cy - 320, { button: "left", clickCount: 1 }); await sleep(500);
    const moved = await fabBox();
    const savedPos = (await get(["hudPos"])).hudPos;
    assert.ok(moved && Math.abs(moved.x - 16) <= 1 && !(await barOpen()), "отпустили — у левого края в 16, кнопки над кружком не показались: " + JSON.stringify(moved));
    assert.ok(savedPos && savedPos.side === "left" && Math.abs(savedPos.top - moved.y) <= 1, "hudPos { side, top }: " + JSON.stringify(savedPos));
    await web.cmd("Page.navigate", { url: LIVE + "?next=1" }); await sleep(1500);
    fb = await until(fabBox, 3000);
    console.log(`      (кружок: после перетаскивания ${JSON.stringify(moved)}, на следующей странице ${JSON.stringify(fb)}; hudPos ${JSON.stringify(savedPos)})`);
    assert.ok(fb && fb.x === moved.x && fb.y === moved.y, "на новой странице кружок на том же месте");
    // щелчок — кнопки над кружком (страницу не переводит); главная «Перевести страницу» — кружок залит, главная
    // становится «Показать оригинал» (кнопки остаются); она — оригинал
    await openBar();
    await sleep(300);
    assert.ok(!(await ru("#p1")), "щелчок по кружку страницу не перевёл");
    let fu = await fabUi(web);
    assert.ok(fu.main && fu.main.attrs["aria-label"] === await msg("translatePage") && fu.lang && fu.lang.text === "RU"
      && fu.more && fu.more.attrs["aria-label"] === await msg("csFkMore"), "кнопки: «Перевести страницу», «RU», «⋯»: "
      + JSON.stringify([fu.main, fu.lang, fu.more].map((e) => e && [e.attrs["data-k"], e.attrs["aria-label"], e.text])));
    const mc = await centerOf(web, fu.main.nodeId);
    await web.mouse("mouseMoved", mc.x, mc.y);
    fu = await until(async () => { const u = await fabUi(web); return u.tipText ? u : null; }, 2000);
    assert.ok(fu && fu.tipText.t === await msg("translatePage") && fu.tipText.sub, "наведение на главную — подсказка: " + JSON.stringify(fu && fu.tipText));
    await web.shot("live-fab-menu.png", { clip: { x: 0, y: 0, width: 1000, height: 760, scale: 0.7 } });
    await clickUi(web, "hud", await msg("translatePage"));
    assert.ok(await until(() => ru("#p1"), 10000), "главная «Перевести страницу» перевела");
    assert.ok(await until(async () => hasCls((await fabUi(web)).fab, "on"), 5000), "кружок залит, пока страница переведена");
    const origBtn = await until(() => mainIs("orig"), 10000);
    assert.ok(origBtn && origBtn.attrs["aria-label"] === await msg("csShowOrig"), "кнопки не закрылись, главная — «Показать оригинал»: " + JSON.stringify(origBtn && origBtn.attrs));
    await web.shot("live-fab-on.png", { clip: { x: 0, y: 0, width: 1000, height: 760, scale: 0.7 } });
    await clickUi(web, "hud", await msg("csShowOrig"));
    assert.ok(await until(async () => !(await ru("#p1")), 3000), "главная «Показать оригинал» — оригинал");
    assert.ok(await until(async () => !hasCls((await fabUi(web)).fab, "on"), 3000), "заливки нет");
    assert.ok(await until(() => mainIs("tr"), 3000), "главная — «Показать перевод»");
    // «⋯» → «Выключить на 127.0.0.1»
    await openMore();
    await sleep(250);                                   // снимок — после перехода цвета кнопки (.is-open)
    await web.shot("live-fab-more.png", { clip: { x: 0, y: 0, width: 1000, height: 760, scale: 0.7 } });
    await clickUi(web, "hud", await msg("csFabSiteOff", "127.0.0.1"));
    assert.ok(await until(async () => JSON.stringify((await get(["disabledSites"])).disabledSites) === '["127.0.0.1"]', 3000), "сайт выключен");
    assert.ok(await until(async () => !(await fabBox()), 3000), "кружок скрыт на выключенном сайте");
    const offToast = await until(async () => { const t = await toastNow(); return t && t.texts.includes(await msg("csSiteDisabledTitle", "127.0.0.1")) ? t : null; }, 3000);
    assert.ok(offToast && offToast.texts.includes(await msg("turnBackOn")), "уведомление с «Включить снова»: " + JSON.stringify(offToast && offToast.texts));
    await web.shot("live-site-off-toast.png", { clip: { x: 500, y: 0, width: 500, height: 200, scale: 1 } });
    await clickUi(web, "toast", await msg("turnBackOn"));
    assert.ok(await until(async () => JSON.stringify((await get(["disabledSites"])).disabledSites) === "[]", 3000), "«Включить снова» включил сайт");
    assert.ok(await until(fabBox, 3000), "включили сайт — кружок вернулся");
    // «⋯» → «Скрыть кнопку» — кружок скрыт молча, без уведомления
    await openMore();
    await clickUi(web, "hud", await msg("csFabHide"));
    assert.ok(await until(async () => !(await fabBox()), 3000), "кружок скрыт");
    assert.strictEqual((await get(["hudShown"])).hudShown, false);
    await sleep(800);
    assert.strictEqual(await toastNow(), null, "«Скрыть кнопку» — без уведомления");
    ok("плавающая кнопка: из окна — справа внизу (16, 44); перетащили настоящей мышью — у левого края в 16, hudPos { side, top }, на следующей странице там же; щелчок показывает кнопки над кружком, не переводя (подсказка у главной); главная «Перевести страницу» — кружок залит, она становится «Показать оригинал» — оригинал; «⋯» → «Выключить на 127.0.0.1» (кружок скрыт, «Включить снова» возвращает), «Скрыть кнопку» — без уведомления");

    // ---- наведение с задержкой: прокрутка без движения мыши ----
    await store({ trigger: "dwell" }); await sleep(300);
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
    await hover("#navlink", 20); await sleep(1500);
    assert.ok(!(await ru("#navlink")), "ссылку наведением не переводим");
    ok("наведение (600 мс) вживую: прокрутка колесом под неподвижным курсором ничего не переводит, первое движение — переводит; ссылку — нет");

    // ---- Esc во встроенном окне той же вкладки ----
    await store({ trigger: "shift" }); await sleep(300);
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
    await api.close();
  }
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); process.exit(1); });
