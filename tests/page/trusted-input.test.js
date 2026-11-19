// content.js в Chrome без интерфейса на странице с заглушкой chrome.* (fixtures/stub-basic.html, file:// —
// у страницы нет имени сайта). Настоящие события мыши/клавиш — Input.dispatch*, у них isTrusted = true;
// события страницы — dispatchEvent из Runtime.evaluate.
const assert = require("assert");
const { launch, filePage, sleep } = require("../lib/chrome");
const { rmDir } = require("../lib/env");

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

(async () => {
  const page = filePage("stub-basic.html");
  const PAGE = page.url;
  const b = await launch({ extraArgs: ["--allow-file-access-from-files"] });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const cmd = t.cmd;
    const ev = (expr) => t.ev(expr);
    const SHIFT = 8, CTRL = 2, ALT = 1;
    const center = async (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    const move = async (x, y, modifiers = 0) => cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    const hover = async (sel, modifiers = 0) => { const c = await center(sel); await move(c.x, c.y, modifiers); await sleep(30); return c; };
    const keyDown = (key, code, modifiers, extra = {}) => cmd("Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: extra.vk || 0 }, extra.k || {}));
    const keyUp = (key, code, modifiers, extra = {}) => cmd("Input.dispatchKeyEvent", Object.assign({ type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: extra.vk || 0 }, extra.k || {}));
    const shiftDown = () => keyDown("Shift", "ShiftLeft", SHIFT, { vk: 16 });
    const shiftUp = () => keyUp("Shift", "ShiftLeft", 0, { vk: 16 });
    const tapShift = async () => { await shiftDown(); await sleep(40); await shiftUp(); await sleep(80); };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const calls = () => ev("window.__calls.length");
    const reset = async () => { await ev("sendCmd('restoreAll'); window.__calls.length = 0; document.activeElement && document.activeElement.blur && document.activeElement.blur(); true"); await sleep(30); };

    await cmd("Page.enable");
    await cmd("Runtime.enable");
    await cmd("Page.navigate", { url: PAGE });
    await sleep(800);
    assert.strictEqual(await ev("typeof HT_validAll"), "function");
    const P1 = await text("#p1");

    // 1. Поддельные события страницы не запускают перевод (режим клавиши)
    await ev(`(() => {
      const p = document.querySelector("#p1");
      p.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, shiftKey: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      return true; })()`);
    await sleep(300);
    assert.strictEqual(await calls(), 0);
    assert.strictEqual(await text("#p1"), P1);
    ok("режим клавиши: поддельные mouseover + keydown/keyup Shift от страницы — ни одного запроса");

    // 2. Настоящее «чистое» нажатие Shift над абзацем переводит, повторное — возвращает оригинал
    await hover("#p1");
    await tapShift();
    await sleep(100);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    assert.strictEqual(await calls(), 1);
    const msg = await ev("window.__calls[0]");
    assert.strictEqual(msg.by, "page-initiated");
    await tapShift();
    assert.strictEqual(await text("#p1"), P1);
    ok("настоящее нажатие-отпускание Shift над абзацем переводит, повторное — возвращает оригинал");
    await reset();

    // 3. Набор: Shift + буква — не переводит
    await hover("#p1");
    await shiftDown(); await sleep(250);    // держим дольше прежних 160 мс
    await keyDown("A", "KeyA", SHIFT, { vk: 65, k: { text: "A", unmodifiedText: "a" } });
    await keyUp("A", "KeyA", SHIFT, { vk: 65 });
    await shiftUp(); await sleep(200);
    assert.strictEqual(await calls(), 0);
    assert.strictEqual(await text("#p1"), P1);
    ok("Shift (зажат 250 мс) + буква — заглавная при наборе не переводит");

    // 4. Shift + клик (выделение) — не переводит
    await hover("#p1");
    const c1 = await center("#p1");
    await shiftDown(); await sleep(50);
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: c1.x, y: c1.y, button: "left", clickCount: 1, modifiers: SHIFT });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: c1.x, y: c1.y, button: "left", clickCount: 1, modifiers: SHIFT });
    await shiftUp(); await sleep(200);
    assert.strictEqual(await calls(), 0);
    ok("Shift + клик мышью — не переводит");

    // 5. Shift + колесо — не переводит (защита сохранена)
    await hover("#p1");
    await shiftDown(); await sleep(30);
    await cmd("Input.dispatchMouseEvent", { type: "mouseWheel", x: c1.x, y: c1.y, deltaX: 0, deltaY: 50, modifiers: SHIFT });
    await sleep(30);
    await shiftUp(); await sleep(200);
    assert.strictEqual(await calls(), 0);
    ok("Shift + колесо — не переводит");

    // 6. Ctrl+Shift (другой модификатор зажат) — не «чистое» нажатие
    await hover("#p1");
    await keyDown("Control", "ControlLeft", CTRL, { vk: 17 });
    await keyDown("Shift", "ShiftLeft", CTRL | SHIFT, { vk: 16 });
    await keyUp("Shift", "ShiftLeft", CTRL, { vk: 16 });
    await keyUp("Control", "ControlLeft", 0, { vk: 17 });
    await sleep(200);
    assert.strictEqual(await calls(), 0);
    ok("Ctrl+Shift — сочетание, не переводит");

    // 7. Фокус в поле ввода — нажатие не переводит
    await ev("document.querySelector('#inp').focus(); true");
    await hover("#p1");
    await tapShift(); await sleep(100);
    assert.strictEqual(await calls(), 0);
    await ev("document.querySelector('#inp').blur(); document.body.setAttribute('contenteditable', 'false'); true");
    // и contenteditable
    await ev("const d = document.createElement('div'); d.id = 'ce'; d.contentEditable = 'true'; d.textContent = 'x'; document.body.appendChild(d); d.focus(); true");
    await hover("#p1");
    await tapShift(); await sleep(100);
    assert.strictEqual(await calls(), 0);
    await ev("document.querySelector('#ce').blur(); document.querySelector('#ce').remove(); true");
    await hover("#p1");
    await tapShift(); await sleep(100);
    assert.strictEqual(await calls(), 1, "без фокуса в поле — снова работает");
    ok("фокус в input / contenteditable — нажатие не переводит; после снятия фокуса — переводит");
    await reset();

    // 7б. Выпадающий список сайта: закрытый — не поле ввода, Shift переводит; раскрытый (настраиваемый select
    //     раскрывается прямо на странице, клавиши доходят до неё; фокус на нём или на пункте) — не переводит.
    await ev(`(() => { const st = document.createElement("style"); st.id = "selcss"; st.textContent = "#sel, #sel::picker(select) { appearance: base-select; }";
      document.head.appendChild(st); const s = document.createElement("select"); s.id = "sel"; s.innerHTML = "<option>One</option><option>Two</option>";
      s.style.cssText = "position: fixed; top: 8px; right: 8px"; document.body.appendChild(s); return true; })()`);
    await ev("document.querySelector('#sel').focus(); true");
    await hover("#p1");
    await tapShift(); await sleep(100);
    assert.strictEqual(await text("#p1"), "[RU] " + P1, "фокус на закрытом <select> — Shift переводит");
    await reset();
    const sc = await ev("(() => { const r = document.querySelector('#sel').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
    await move(sc.x, sc.y);
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: sc.x, y: sc.y, button: "left", clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: sc.x, y: sc.y, button: "left", clickCount: 1 });
    await sleep(200);
    const selOpen = await ev("(() => { const a = document.activeElement; return { open: document.querySelector('#sel').matches(':open'), focus: a && a.tagName }; })()");
    assert.ok(selOpen.open && /^(SELECT|OPTION)$/.test(selOpen.focus), "список раскрыт, фокус в нём: " + JSON.stringify(selOpen));
    await hover("#p1");
    await tapShift(); await sleep(100);
    assert.strictEqual(await calls(), 0, "раскрытый список — Shift не переводит");
    assert.strictEqual(await text("#p1"), P1);
    await ev("document.querySelector('#sel').remove(); document.querySelector('#selcss').remove(); true");
    ok(`<select>: закрытый (фокус на нём) — Shift переводит; раскрытый (фокус: ${selOpen.focus}) — не переводит`);
    await reset();

    // 8. Держу Shift и веду курсор: переводится и стартовый абзац, и пройденный; отпускание ничего не откатывает
    const P2 = await text("#p2");
    await hover("#p1");
    await shiftDown(); await sleep(30);
    await hover("#p2", SHIFT);
    await sleep(150);
    await shiftUp(); await sleep(150);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    assert.strictEqual(await text("#p2"), "[RU] " + P2);
    ok("держу Shift и веду курсор: переведены и стартовый, и пройденный абзацы, отпускание не откатывает");
    await reset();

    // 9. Курсор ушёл из окна — hoverEl сброшен
    await ev(`window.__outs = []; document.addEventListener("mouseout", (e) => window.__outs.push((e.target.id || e.target.tagName) + "->" + (e.relatedTarget ? (e.relatedTarget.id || e.relatedTarget.tagName) : "null")), true);
      window.__overs = []; document.addEventListener("mouseover", (e) => window.__overs.push(e.target.id || e.target.tagName), true); true`);
    await hover("#p1");
    await ev("window.__outs.length = 0; window.__overs.length = 0; true");
    await move(-5, -5); await sleep(50);
    console.log("      (события при уходе за окно: mouseout " + JSON.stringify(await ev("window.__outs")) + ", mouseover " + JSON.stringify(await ev("window.__overs")) + ")");
    await tapShift(); await sleep(100);
    const c9 = await calls();
    // и blur окна
    await hover("#p1");
    await ev("window.dispatchEvent(new FocusEvent('blur')); true"); // blur только сбрасывает — проверим, что сброс работает
    await tapShift(); await sleep(100);
    const c9b = await calls();
    console.log(`      (уход курсора за окно: запросов ${c9}; после blur окна: ${c9b})`);
    assert.strictEqual(c9b, 0, "после blur окна нажатие не переводит");
    // окно вернуло фокус (закрыли окно расширения), курсор на том же абзаце — mouseover не придёт; первое же
    // движение мыши возвращает «элемент под курсором», и Shift снова переводит
    const c9c = await center("#p1");
    await move(c9c.x + 3, c9c.y); await sleep(30);
    await tapShift(); await sleep(100);
    assert.strictEqual(await text("#p1"), "[RU] " + P1, "после потери фокуса и движения мыши в пределах абзаца — переводит");
    await reset();
    ok("blur окна сбрасывает элемент под курсором" + (c9 === 0 ? "; уход курсора за окно тоже" : " (уход за окно в headless не воспроизвёлся — см. отчёт)") + "; первое движение мыши после возврата фокуса его восстанавливает");
    await reset();

    // 10. translate="no" и .notranslate: наведение и «Перевести страницу»
    await hover("#p4"); await tapShift(); await sleep(100);
    await hover("#p5"); await tapShift(); await sleep(100);
    assert.strictEqual(await calls(), 0);
    await hover("#p3"); await tapShift(); await sleep(150);
    const p3 = await ev("[document.querySelector('#p3').textContent, document.querySelector('#brand').textContent, JSON.stringify(window.__calls[0] && window.__calls[0].items)]");
    assert.strictEqual(p3[1], "MegaBrand");
    assert.ok(!p3[2].includes("MegaBrand"), p3[2]);
    await reset();
    await ev("sendCmd('translatePage'); true"); await sleep(400);
    const after = await ev("['#p1','#p2','#p3','#p4','#p5','#brand'].map((s) => document.querySelector(s).textContent)");
    assert.ok(after[0].startsWith("[RU]") && after[1].startsWith("[RU]"), JSON.stringify(after));
    assert.strictEqual(after[3], "This paragraph must never be translated by anyone.");
    assert.strictEqual(after[4], "Nested inside a translate no container, keep it.");
    assert.strictEqual(after[5], "MegaBrand");
    const pageMsgs = await ev("window.__calls.map((c) => c.by + ':' + c.items.join('|'))");
    assert.ok(pageMsgs.every((m) => m.startsWith("user-initiated") && !/never|Nested|MegaBrand/.test(m)), JSON.stringify(pageMsgs));
    ok("translate=\"no\" и .notranslate не уходят в перевод ни при наведении, ни при «Перевести страницу»");
    await reset();
    // запрет на <html> не выключает расширение
    await ev("document.documentElement.setAttribute('translate', 'no'); true");
    await hover("#p1"); await tapShift(); await sleep(150);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    await ev("document.documentElement.removeAttribute('translate'); true");
    ok("translate=\"no\" на <html> не выключает перевод (сознательное исключение)");
    await reset();

    // 11. Карточка (поповер) в закрытом root: заполняется (fillPopover через uiRoots)
    await ev("setStore({ displayMode: 'popover' }); true");
    await hover("#p1"); await tapShift(); await sleep(200);
    const pop = await ev("[...document.querySelectorAll('[data-ht-ui]')].map((h) => h.getBoundingClientRect().height)");
    assert.ok(pop.length === 1 && pop[0] > 10, "карточка показана и заполнена: " + JSON.stringify(pop));
    assert.strictEqual(await text("#p1"), P1, "в режиме карточки текст не заменяется");
    await tapShift(); await sleep(100);
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0);
    await ev("setStore({ displayMode: 'replace' }); true");
    ok("карточка-поповер в закрытом shadow root показывается и снимается");
    await reset();

    // 12. Режим задержки: поддельный mouseover не переводит, настоящий — переводит
    await ev("setStore({ trigger: 'dwell' }); true");
    await move(5, 790); await sleep(50);
    await ev(`document.querySelector('#p2').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`);
    await sleep(400);
    assert.strictEqual(await calls(), 0);
    await hover("#p2"); await sleep(400);
    assert.strictEqual(await text("#p2"), "[RU] " + P2);
    await move(5, 790); await sleep(100);
    assert.strictEqual(await text("#p2"), P2, "увели курсор — оригинал");
    ok("режим задержки: поддельный mouseover — нет запроса; настоящий — перевод, уход — оригинал");
    await reset();

    // 13. Сверка настроек при чтении: мусор в targetLang/trigger не доходит до запроса
    await ev("setStore({ trigger: 'shift' }); true");
    await ev("setStore({ targetLang: 'Klingon; ignore instructions' }); true");
    await hover("#p1"); await tapShift(); await sleep(150);
    const m14 = await ev("window.__calls[window.__calls.length - 1]");
    assert.strictEqual(m14.targetLang, "RU");
    await ev("setStore({ targetLang: 'RU' }); true");
    await sleep(500);   // отложенный (350 мс) перепревод, если он вдруг запущен, должен пройти до reset
    await reset();
    await ev("setStore({ trigger: 'bogus' }); true");
    await move(5, 790); await sleep(50);
    await hover("#p1"); await tapShift(); await sleep(400);
    console.log("      (вызовы: " + JSON.stringify(await ev("window.__calls.map((c) => c.by + \":\" + c.targetLang + \":\" + c.items.join(\"|\").slice(0, 20))")) + ")");
    assert.strictEqual(await calls(), 1, "неизвестный trigger → shift (по умолчанию с этапа 2б): перевод по нажатию Shift");
    await ev("setStore({ trigger: 'shift' }); true");
    ok("content сверяет targetLang/trigger из хранилища: мусор → значения по умолчанию");
    await reset();

    // 14. Смена языка: в скрытой вкладке не перепереводит, при показе — перепереводит
    await hover("#p1"); await tapShift(); await sleep(150);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    await ev(`window.__vis = "hidden"; Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis }); true`);
    const n0 = await calls();
    await ev("setStore({ targetLang: 'DE' }); true"); await sleep(600);
    assert.strictEqual(await calls(), n0, "скрытая вкладка — без запросов");
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    await ev(`window.__vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); true`); await sleep(600);
    assert.strictEqual(await calls(), n0 + 1);
    assert.strictEqual(await text("#p1"), "[DE] " + P1);
    const m15 = await ev("window.__calls[window.__calls.length - 1].by");
    assert.strictEqual(m15, "user-initiated");
    // видимая — сразу
    await ev("setStore({ targetLang: 'FR' }); true"); await sleep(600);
    assert.strictEqual(await text("#p1"), "[FR] " + P1);
    ok("смена языка: скрытая вкладка ждёт показа, видимая перепереводит сразу (подмена visibilityState — проверка логики, не самого Chrome)");
    await ev("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); setStore({ targetLang: 'RU' }); true"); await sleep(600);
    await reset();

    // 15. Плавающая кнопка в закрытом shadow root (страница file:// — у неё нет сайта): поддельные события по хосту
    //     ничего не делают и не пишут; настоящий щелчок по кружку открывает меню, но не переводит; настоящий щелчок по
    //     действию страницы в меню («Перевести страницу» или «Перевод») — переводит; пункта «Выключить на <сайт>» нет.
    const trCalls = () => ev("window.__calls.filter((c) => c.type === 'translateBatch').length");
    assert.strictEqual(await ev("sendCmd('toggleHud').hud"), true);
    const sr = await ev("[...document.querySelectorAll('[data-ht-ui]')].map((h) => h.shadowRoot === null)");
    assert.ok(sr.length === 1 && sr[0], "один хост, shadowRoot снаружи — null: " + JSON.stringify(sr));
    await ev("window.__sets = []; true");
    await ev(`(() => { const h = document.querySelector('[data-ht-ui]'); h.dispatchEvent(new Event('change', { bubbles: true, composed: true })); h.click();
      h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); return true; })()`);
    await sleep(300);
    assert.deepStrictEqual(await ev("window.__sets"), [], "поддельные change/click/Enter по хосту ничего не пишут");
    assert.strictEqual(await ev("fabRoot().querySelector('.fm').hidden"), true, "и меню не открывают");
    const fc = await ev("uiPoint(fabRoot(), '.fab')");
    await move(fc.x, fc.y);
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: fc.x, y: fc.y, button: "left", clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: fc.x, y: fc.y, button: "left", clickCount: 1 });
    await sleep(300);
    assert.strictEqual(await ev("fabRoot().querySelector('.fm').hidden"), false, "настоящий щелчок по кружку открыл меню");
    assert.strictEqual(await trCalls(), 0, "щелчок по кружку не переводит");
    assert.deepStrictEqual(await ev("[...fabRoot().querySelectorAll('[role=menu] .fm-item')].map((x) => x.getAttribute('data-act'))"), ["hide", "settings"], "у страницы нет сайта — нет «Выключить на …»");
    // страницу уже переводили целиком (п. 10) и вернули оригинал — на месте действия сегмент «Оригинал | Перевод»
    const pb = await ev("uiPoint(fabRoot(), '.fm-act .fm-btn') || uiPoint(fabRoot(), '.fm-act .fm-seg [role=radio][aria-checked=false]')");
    assert.ok(pb, "в меню есть «Перевести страницу» или «Перевод»: " + JSON.stringify(await ev("[sendCmd('getHudState'), fabRoot().querySelector('.fm').getAttribute('data-page'), fabRoot().querySelector('.fm-act').innerHTML.slice(0, 400)]")));
    await move(pb.x, pb.y);
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: pb.x, y: pb.y, button: "left", clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: pb.x, y: pb.y, button: "left", clickCount: 1 });
    await sleep(400);
    const viaFab = await text("#p1");
    console.log(`      (настоящий щелчок по действию страницы в меню кружка: #p1 = ${JSON.stringify(viaFab.slice(0, 30))})`);
    assert.ok(viaFab.startsWith("[RU]"), "настоящий щелчок по кнопке внутри закрытого root работает");
    assert.ok(await ev("window.__sets.every((x) => 'hudShown' in x)"), "кроме показа кружка ничего не записано: " + JSON.stringify(await ev("window.__sets")));
    ok("плавающая кнопка в закрытом shadow root: shadowRoot снаружи — null; поддельные change/click/Enter по хосту ничего не делают; настоящий щелчок по кружку открывает меню (без перевода), по действию страницы в меню — переводит; без сайта нет «Выключить на …»");
    await ev("sendCmd('toggleHud'); true");

    // 16. Esc на переведённой странице: открыто окно или меню сайта — Esc закрывает его, перевод на месте; ничего не
    //     открыто — Esc возвращает оригинал. Настоящий Esc (Input.dispatchKeyEvent): окно и поповер закрывает сам Chrome.
    const esc = async () => { await keyDown("Escape", "Escape", 0, { vk: 27 }); await keyUp("Escape", "Escape", 0, { vk: 27 }); await sleep(150); };
    const ru1 = async () => (await text("#p1")).startsWith("[RU] ");
    await reset();
    await ev("sendCmd('translatePage'); true"); await sleep(400);
    assert.ok(await ru1(), "страница переведена");
    assert.strictEqual(await ev(`(() => { const d = document.createElement("dialog"); d.id = "sdlg"; d.textContent = "Site dialog";
      document.body.appendChild(d); d.showModal(); return d.matches(":modal"); })()`), true);
    await esc();
    assert.strictEqual(await ev("document.querySelector('#sdlg').open"), false, "Esc закрыл окно сайта");
    assert.ok(await ru1(), "открытый <dialog> — Esc только сайту, перевод на месте");
    assert.strictEqual(await ev(`(() => { const p = document.createElement("div"); p.id = "spop"; p.popover = "auto"; p.textContent = "Site popover";
      document.body.appendChild(p); p.showPopover(); return p.matches(":popover-open"); })()`), true);
    await esc();
    assert.strictEqual(await ev("document.querySelector('#spop').matches(':popover-open')"), false, "Esc закрыл поповер сайта");
    assert.ok(await ru1(), "открытый поповер — перевод на месте");
    // раскрытое меню: у кнопки aria-expanded=true, по Esc сайт закрывает меню своим обработчиком (после нашего)
    await ev(`(() => { const b = document.createElement("button"); b.id = "smenu"; b.textContent = "Menu"; b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "true");
      b.style.cssText = "position: fixed; top: 8px; right: 8px"; document.body.appendChild(b);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") b.setAttribute("aria-expanded", "false"); }); return true; })()`);
    await esc();
    assert.strictEqual(await ev("document.querySelector('#smenu').getAttribute('aria-expanded')"), "false", "сайт закрыл меню");
    assert.ok(await ru1(), "раскрытое меню (aria-expanded) — перевод на месте");
    // спрятанные окна и меню в разметке сайта не мешают; наш кружок (хост [data-ht-ui]) — тоже
    await ev(`(() => { const w = document.createElement("div"); w.hidden = true; w.innerHTML = '<div role="dialog" aria-modal="true">Hidden dialog</div><button aria-expanded="true">Hidden menu</button>';
      document.body.appendChild(w);
      // раскрытый раздел оглавления / аккордеон (на сайтах документации раскрыты всегда) — не «открытое меню»
      const a = document.createElement("div"); a.innerHTML = '<button aria-expanded="true" aria-controls="sacc">Section</button><div id="sacc">Panel</div>'
        + '<button aria-expanded="true">Show less</button><div>More details</div>';
      document.body.appendChild(a); return true; })()`);
    await move(5, 790); await sleep(50);
    assert.strictEqual(await ev("sendCmd('toggleHud').hud"), true);
    await sleep(100);
    assert.ok(await ev("!!fabRoot() && fabRoot().querySelector('.fm').hidden"), "кружок на странице, меню закрыто");
    await esc();
    assert.strictEqual(await text("#p1"), P1, "ничего не открыто — Esc возвращает оригинал");
    await ev("sendCmd('toggleHud'); true");
    ok("Esc: открыт <dialog>, поповер или меню сайта (aria-expanded) — Esc сайту, перевод на месте; закрыли — Esc возвращает оригинал; спрятанные окна сайта, раскрытые аккордеоны и наш кружок не мешают");

    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
