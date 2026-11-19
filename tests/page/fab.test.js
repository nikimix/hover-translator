// Плавающая кнопка (кружок + кнопки над ним): content.js в Chrome без интерфейса, страница по HTTP (у неё есть имя
// сайта 127.0.0.1) с заглушкой chrome.* (fixtures/stub.html). Настоящие события — Input.dispatch* (isTrusted = true).
// Панель языка изнутри — page/fab-lang.test.js.
// Проверяет: вид и место по умолчанию (справа внизу в 16, 44, закрытый root, слой 2147483645, разметка столбика);
// состояния кружка (заливка «переведена», кольцо и «Перевожу… N из M» — к середине экрана); кнопки над кружком:
// наведение — сразу (появление: прозрачность и сдвиг 4 px), уход — через 300 мс, зазоры 8 px — свои, щелчок
// закрепляет и не переводит, щелчок мимо / повторный / Esc скрывают; главная кнопка во всех состояниях (idle с
// клавишей из chrome.commands, busy — «Стоп» при видимой подписи, part, done, orig, needClick, сбой) меняется на
// месте; подсказки (сразу, одна, по центру своей кнопки в 8 от столбика); «RU» — код по targetLang и панель языка;
// «⋯» — «Выключить на <сайт>», «Скрыть кнопку» (+ «Вернуть»), «Настройки»; где кнопки, подсказки и панели (вверх,
// вниз .down, слева, окно 320); перетаскивание (≤ 4 px — щелчок, больше — прилипание к краю в 16, кнопок нет,
// hudPos пишется один раз, место переживает перезагрузку, миграция { left, top }, мусор, узкое и низкое окно);
// клавиатура (Tab — последним, Tab по кнопкам, Enter / пробел, ↑↓ Home End по направлению столбика, Esc по
// цепочке); где кружка нет (hudShown, выключенный сайт, enabled = false, iframe); уведомление обходит кружок
// с кнопками и панелью; цвета кружка и кнопок на светлом и тёмном сайте; поддельные события страницы ничего не делают.
// Скриншоты — с tests/run.sh --shots.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 40) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;
// Прямоугольники fabInfo(): { l, t, r, b, w, h }.
const mid = (q) => ({ x: Math.round(q.l + q.w / 2), y: Math.round(q.t + q.h / 2) });
const cross = (a, c) => a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
const inside = (q, v) => q.l >= 0 && q.t >= 0 && q.r <= v.w && q.b <= v.h;

(async () => {
  const srv = await serve();
  const BASE = srv.base + "/stub.html";
  const OTHER = srv.other;
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    const viewport = (w, h) => t.cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await viewport(1000, 800);
    const ev = t.ev;
    const load = async (store, extra = "") => {
      await t.cmd("Page.navigate", { url: BASE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) + extra });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const F = () => ev("fabInfo()");
    const vp = () => ev("({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })");
    const T = (k, subs) => ev(`HT_t(${JSON.stringify(k)}${subs != null ? ", " + JSON.stringify([].concat(subs).map(String)) : ""})`);
    const state = () => ev("sendCmd('getHudState')");
    const move = (x, y, extra = {}) => t.mouse("mouseMoved", x, y, extra);
    const down = (x, y) => t.mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
    const up = (x, y) => t.mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
    const click = async (x, y) => { await move(x, y); await down(x, y); await up(x, y); };
    const EMPTY = { x: 850, y: 300 };                 // пустое место (тексты страницы — 600 px слева), окно 1000 × 800
    const away = async (p = EMPTY) => { await move(p.x, p.y); await sleep(40); };
    const clickFab = async () => { const c = mid((await F()).fab); await click(c.x, c.y); await sleep(100); };
    const point = (sel) => ev(`uiPoint(fabRoot(), ${JSON.stringify(sel)})`);
    const clickIn = async (sel) => { const p = await point(sel); assert.ok(p, "нет " + sel); await click(p.x, p.y); await sleep(100); };
    const key = (type, k, code, vk, extra = {}) => t.cmd("Input.dispatchKeyEvent", Object.assign({ type, key: k, code, windowsVirtualKeyCode: vk, modifiers: 0 }, extra));
    const press = async (k, code, vk, modifiers = 0) => { await key("rawKeyDown", k, code, vk, { modifiers }); await key("keyUp", k, code, vk, { modifiers }); await sleep(80); };
    const enter = async () => { await key("keyDown", "Enter", "Enter", 13, { text: "\r", unmodifiedText: "\r" }); await key("keyUp", "Enter", "Enter", 13); await sleep(100); };
    const space = async () => { await key("keyDown", " ", "Space", 32, { text: " ", unmodifiedText: " " }); await key("keyUp", " ", "Space", 32); await sleep(100); };
    const tab = (back) => press("Tab", "Tab", 9, back ? SHIFT : 0);
    const esc = () => press("Escape", "Escape", 27);
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", 16, { modifiers: SHIFT }); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 16); await sleep(120); };
    const tr = (sel) => ev(`/^\\[(RU|ru)\\]/.test(document.querySelector(${JSON.stringify(sel)}).textContent)`);
    const toastsNow = () => ev("toasts()");
    const posSets = () => ev("__sets.filter((s) => 'hudPos' in s).map((s) => s.hudPos)");
    // Цвета кружка: фон, рамка, иконка (color).
    const look = () => ev("(() => { const g = getComputedStyle(fabRoot().querySelector('.fab')); return [g.backgroundColor, g.borderTopColor, g.color]; })()");
    // Цвета столбика (фон, рамка, цвет) без наведения на кнопки: главная, «RU» (и цвет кода), «⋯»; подсказка у «⋯»
    // (курсор на неё и обратно на кружок) и панель «⋯» — фон, рамка, класс dk.
    const barLook = async () => {
      const g = (sel) => ev(`(() => { const e = fabRoot().querySelector(${JSON.stringify(sel)}), c = getComputedStyle(e); return [c.backgroundColor, c.borderTopColor, c.color, e.classList.contains('dk')]; })()`);
      const fc = mid((await F()).fab);
      await move(fc.x, fc.y); await sleep(250);
      const out = { main: await g("[data-k=main]"), lang: await g("[data-k=lang]"), code: (await g("[data-k=lang] .code"))[2], more: await g("[data-k=more]"), bar: (await g(".fk"))[3] };
      await tipAt("more"); out.tip = await g("#fk-tip");
      await clickIn("[data-k=more]"); out.panel = await g("#fk-more");
      await clickIn("[data-k=more]"); await move(fc.x, fc.y); await sleep(250);
      return out;
    };
    const BAR_LIGHT = { main: ["rgb(37, 99, 235)", "rgb(37, 99, 235)", "rgb(255, 255, 255)", false], lang: ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(75, 82, 90)", false],
      code: "rgb(23, 25, 28)", more: ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(75, 82, 90)", false], bar: false,
      tip: ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(23, 25, 28)", false], panel: ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(23, 25, 28)", false] };
    const BAR_DARK = { main: ["rgb(143, 176, 255)", "rgb(143, 176, 255)", "rgb(11, 18, 32)", false], lang: ["rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(212, 215, 220)", false],
      code: "rgb(232, 233, 235)", more: ["rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(212, 215, 220)", false], bar: true,
      tip: ["rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(232, 233, 235)", true], panel: ["rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(232, 233, 235)", true] };
    // Кнопка столбика по data-k из fabInfo(); подсказка у кнопки k после наведения на неё.
    const btn = (x, k) => x.btns.find((q) => q.k === k);
    const tipAt = async (k) => { const p = await point(`[data-k=${k}]`); assert.ok(p, "нет кнопки " + k); await move(p.x, p.y); await sleep(40); return (await F()).tip; };
    // Подсказка — по центру кнопки k по вертикали и в 8 от столбика к середине экрана (right — кружок справа).
    const tipBeside = (x, k, right) => {
      const bb = btn(x, k).box, tb = x.tip.box;
      return Math.abs((tb.t + tb.b) / 2 - (bb.t + bb.b) / 2) <= 1 && (right ? bb.l - tb.r : tb.l - bb.r) === 8;
    };
    const PAIR = "Английский → русский";            // пара языков в подсказках (страница lang=en, перевод — RU)
    // Журнал показов кнопок со временем страницы: [мс, показаны, прозрачность и сдвиг столбика в этот миг].
    // mark() — начало отсчёта (до события).
    const watch = () => ev(`(() => { const r = fabRoot(); window.__fl = []; let last = fabInfo().open;
      new MutationObserver(() => { const o = fabInfo() && fabInfo().open; if (o !== last) { last = o; const g = getComputedStyle(r.querySelector('.fk'));
        __fl.push([performance.now(), o, +g.opacity, g.transform]); } })
        .observe(r, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style"] }); return true; })()`);
    const mark = () => ev("window.__fl.length = 0; performance.now()");
    const firstAt = async (t0, open) => { const e = (await ev("__fl")).find(([, o]) => o === open); return e ? Math.round(e[0] - t0) : null; };

    // ---- 1. Вид и место по умолчанию ----
    await load({ hudShown: true });
    let f = await F();
    let v = await vp();
    assert.ok(f, "hudShown — кружок на странице");
    assert.deepStrictEqual([f.fab.w, f.fab.h, v.w - f.fab.r, v.h - f.fab.b], [44, 44, 16, 16], "кружок 44, справа внизу в 16 (от краёв окна без полосы прокрутки): " + JSON.stringify(f.fab));
    const host = await ev(`(() => { const h = fabRoot().host, g = getComputedStyle(h); return { ui: h.getAttribute('data-ht-ui'), pos: g.position, z: g.zIndex, closed: h.shadowRoot === null }; })()`);
    assert.deepStrictEqual(host, { ui: "1", pos: "fixed", z: "2147483645", closed: true }, "хост: data-ht-ui, fixed, слой между карточкой и уведомлением, закрытый root");
    // разметка: кружок управляет столбиком #fk (toolbar), кнопки по порядку Tab — главная, «RU», «⋯»
    const a11y = await ev(`(() => { const r = fabRoot(), b = r.querySelector('.fab'), k = r.querySelector('.fk');
      const at = (e, ...n) => n.map((x) => e.getAttribute(x)), el = (id) => r.getElementById(id);
      return { tag: b.tagName, type: b.type, fab: at(b, 'aria-label', 'aria-haspopup', 'aria-expanded', 'aria-controls'), svg: !!b.querySelector('svg'),
        bar: [k.id, ...at(k, 'role', 'aria-orientation', 'aria-label'), k.hidden, k.parentNode === b.closest('.ui')],
        btns: [...k.children].map((x) => [x.tagName, x.type, x.classList.contains('fk-btn'), ...at(x, 'data-k', 'aria-haspopup', 'aria-controls')].join(':')),
        tip: [...at(el('fk-tip'), 'class', 'role'), el('fk-tip').hidden], lang: [...at(el('fk-lang'), 'class', 'role'), el('fk-lang').hidden],
        more: [...at(el('fk-more'), 'class', 'role'), el('fk-more').hidden], old: r.querySelectorAll('.fm, [class^="fm-"]').length }; })()`);
    assert.deepStrictEqual(a11y, { tag: "BUTTON", type: "button", fab: [await T("csFabAria", await T("extShortName")), null, "false", "fk"], svg: true,
      bar: ["fk", "toolbar", "vertical", await T("extShortName"), true, true],
      btns: ["BUTTON:button:true:main::", "BUTTON:button:true:lang:dialog:fk-lang", "BUTTON:button:true:more:menu:fk-more"],
      tip: ["fk-tip", "tooltip", true], lang: ["fk-pop", "dialog", true], more: ["fk-pop menu", "menu", true], old: 0 });
    assert.deepStrictEqual([f.on, f.ring, f.pill, f.dot, f.open, f.dk], [false, false, null, null, false, false], "ничего не переведено: без заливки, кольца, подписи и точки; кнопок нет");
    assert.deepStrictEqual(await look(), ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(37, 99, 235)"], "светлый сайт: белый, рамка #c9ced5, иконка #2563eb");
    assert.deepStrictEqual(await state(), { ok: true, hud: true, site: "127.0.0.1", siteOff: false, lang: "en", page: "idle", done: 0, total: 0, count: 0, src: "" });
    await t.shot("fab-default.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    ok(`кружок: справа внизу в 16, 44 × 44, хост fixed со слоем 2147483645 и закрытым root; button «${a11y.fab[0]}», aria-expanded=false, aria-controls=fk; столбик #fk role=toolbar (главная, «RU» → #fk-lang, «⋯» → #fk-more) скрыт, старого меню нет; белый с рамкой #c9ced5; tabState.hud = true`);

    // ---- 2. Состояния: перевод идёт — кольцо и подпись; переведена — заливка ----
    const busyNow = () => ev(`(() => { const s = sendCmd('getHudState'), f = fabInfo(); return { s, f, want: HT_t('ppBusy') + ' ' + HT_t('ppBusyN', [String(s.done), String(s.total)]) }; })()`);
    await away();
    await ev("window.__bgDelay = 500; sendCmd({ type: 'translatePage', via: 'popup' }); true");
    await sleep(120);
    let bz = await busyNow();
    assert.ok(bz.s.page === "busy" && bz.f.ring && bz.f.pill === bz.want && !bz.f.on, "идёт перевод — кольцо и «Перевожу… N из M»: " + JSON.stringify(bz));
    v = await vp();
    assert.ok(bz.f.pillBox.r <= bz.f.fab.l && inside(bz.f.pillBox, v), "кружок справа — подпись слева от него, в окне: " + JSON.stringify([bz.f.pillBox, bz.f.fab]));
    await t.shot("fab-busy.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    const counted = await until(async () => { const x = await busyNow(); return x.s.page === "busy" && x.s.done > 0 && x.f.pill === x.want ? x : null; }, 3000, 30);
    assert.ok(counted, "счёт на подписи растёт вместе с переводом");
    assert.ok(await until(async () => (await state()).page === "done", 4000), "перевод закончен");
    await sleep(250);
    f = await F();
    assert.deepStrictEqual([f.on, f.ring, f.pill], [true, false, null], "переведена — заливка, кольца и подписи нет");
    assert.deepStrictEqual(await look(), ["rgb(37, 99, 235)", "rgb(37, 99, 235)", "rgb(255, 255, 255)"], "заливка #2563eb, иконка белая");
    await t.shot("fab-on.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    await esc(); await sleep(250);
    assert.strictEqual((await state()).page, "orig");
    assert.strictEqual((await F()).on, false, "Esc — оригинал, заливки нет");
    // клавишей переведён кусок — это не «страница переведена»
    await ev("window.__bgDelay = 0; true");
    const p1 = await ev("(() => { const r = document.querySelector('#p1').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()");
    await move(p1.x, p1.y); await sleep(30); await tapShift();
    assert.ok(await tr("#p1"));
    assert.deepStrictEqual([(await state()).page, (await F()).on], ["part", false], "переведено клавишей — без заливки");
    await esc(); await away();
    // кружок слева — подпись справа от него
    await load({ hudShown: true, hudPos: { side: "left", top: 300 } });
    await ev("window.__bgDelay = 500; sendCmd({ type: 'translatePage', via: 'popup' }); true");
    await sleep(120);
    bz = await busyNow();
    assert.ok(bz.f.ring && bz.f.pill === bz.want && bz.f.pillBox.l >= bz.f.fab.r && inside(bz.f.pillBox, v), "кружок слева — подпись справа от него: " + JSON.stringify([bz.f.pillBox, bz.f.fab]));
    await t.shot("fab-busy-left.png", { clip: { x: 0, y: 220, width: 400, height: 200, scale: 1 } });
    await until(async () => (await state()).page === "done", 4000);
    await ev("window.__bgDelay = 0; true");
    ok(`состояния: идёт перевод — кольцо и подпись «${bz.want}» со стороны середины экрана (счёт растёт), закончен — кольца и подписи нет, заливка #2563eb; Esc — без заливки; перевод клавишей (part) — без заливки`);

    // ---- 3. Наведение — кнопки сразу, уход — 300 мс, зазоры свои; щелчок закрепляет и не переводит ----
    await load({ hudShown: true });
    await away();
    await watch();
    let c = mid((await F()).fab);
    let t0 = await mark();
    await move(c.x, c.y);
    assert.ok(await until(async () => (await F()).open, 1000, 10), "наведение показало кнопки");
    const openedAt = await firstAt(t0, true);
    f = await F();
    assert.ok(openedAt !== null && openedAt <= 120, "кнопки — сразу при наведении, без задержки 200 мс: " + openedAt);
    assert.deepStrictEqual([f.expanded, f.down, f.tip, f.panel], ["true", false, null, ""], "aria-expanded=true, столбик вверх, подсказки и панели нет");
    // появление: в миг показа столбик прозрачен и сдвинут на 4 px к кружку, через 120 мс — на месте
    const appear = (await ev("__fl")).find((e) => e[1]);
    assert.ok(appear[2] < 0.5 && /matrix\(1, 0, 0, 1, 0, 4\)/.test(appear[3]), "появление: прозрачность от 0 и сдвиг 4 px от кружка: " + JSON.stringify(appear));
    await sleep(200);
    assert.deepStrictEqual(await ev("(() => { const g = getComputedStyle(fabRoot().querySelector('.fk')); return [g.opacity, g.transform]; })()"), ["1", "none"], "через 200 мс — непрозрачный, на месте");
    // уход — скрыть через 300 мс
    t0 = await mark();
    await away();
    assert.ok(await until(async () => !(await F()).open, 2000), "ушли — кнопки скрылись");
    const closedAt = await firstAt(t0, false);
    assert.ok(closedAt >= 280 && closedAt <= 460, "скрылись через 300 мс (не раньше и не позже): " + closedAt);
    assert.strictEqual((await F()).expanded, "false");
    // вернулся до 300 мс — отмена
    await move(c.x, c.y); await sleep(40); await away(); await sleep(150);
    let lp = await point("[data-k=lang]");
    await move(lp.x, lp.y); await sleep(450);
    assert.ok((await F()).open, "ушёл и вернулся на кнопку до 300 мс — кнопки остались");
    // зазоры 8 px между кнопками и до кружка — часть столбика: курсор, стоящий в зазоре, не «ушёл»
    await move(c.x, c.y); await sleep(40);
    t0 = await mark();
    for (let y = c.y; y >= c.y - 150; y -= 4) { await move(c.x, y); await sleep(8); }
    f = await F();
    const gaps = [f.fab.t - 4, btn(f, "main").box.t - 4, btn(f, "lang").box.t - 4];          // середины трёх зазоров
    for (const gy of gaps) { await move(c.x, gy); await sleep(450); }
    f = await F();
    assert.ok(f.open && (await ev("__fl.length")) === 0, "путь кружок → главная → язык → «⋯» и по 450 мс в каждом зазоре — кнопки не мигали: " + JSON.stringify({ gaps, fl: await ev("__fl") }));
    assert.ok(f.tip === null, "в зазоре подсказки нет");
    await away();
    assert.ok(await until(async () => !(await F()).open, 2000), "ушли со столбика — скрылись");
    // щелчок: закрепляет, страницу не переводит
    await ev("window.__calls.length = 0; true");
    await clickFab();
    assert.ok((await F()).open, "щелчок — кнопки показаны");
    await away(); await sleep(600);
    assert.ok((await F()).open, "закреплены: курсор ушёл — кнопки на месте");
    assert.strictEqual(await ev("trCalls().length"), 0, "щелчок по кружку страницу не переводит");
    assert.strictEqual((await state()).page, "idle");
    await t.shot("bar-pinned.png", { clip: { x: 600, y: 500, width: 400, height: 300, scale: 1 } });
    await click(EMPTY.x, EMPTY.y); await sleep(120);
    assert.ok(!(await F()).open, "щелчок мимо — скрыты");
    // повторный щелчок по кружку скрывает (и курсор, оставшийся на кружке, не показывает снова)
    await clickFab();
    assert.ok((await F()).open);
    await clickFab();
    assert.ok(!(await F()).open, "повторный щелчок — скрыты");
    await sleep(500);
    assert.ok(!(await F()).open, "курсор стоит на кружке — кнопки сами не показались снова");
    // Esc скрывает закреплённые кнопки и не трогает перевод; Esc без кнопок — оригинал
    await away();
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await clickFab();
    assert.ok((await F()).open);
    await esc();
    f = await F();
    assert.ok(!f.open && f.focus === "fab" && f.expanded === "false", "Esc скрыл кнопки, фокус на кружке: " + JSON.stringify(f));
    assert.ok(await tr("#p1"), "Esc скрыл кнопки — перевод страницы на месте");
    await away(); await sleep(400);
    await esc();
    assert.ok(!(await tr("#p1")), "Esc без кнопок — оригинал");
    // «меньше движения» в системе — появление без сдвига
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await load({ hudShown: true });
    await away();
    await watch();
    await move(c.x, c.y);
    assert.ok(await until(async () => (await F()).open, 1000, 10));
    const calm = (await ev("__fl")).find((e) => e[1]);
    assert.strictEqual(calm[3], "none", "prefers-reduced-motion — без сдвига: " + JSON.stringify(calm));
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await away();
    ok(`кнопки над кружком: наведение — сразу (${openedAt} мс), появление — прозрачность и сдвиг 4 px (без сдвига при «меньше движения»); уход — через 300 мс (${closedAt}), вернулся — отмена; зазоры 8 px — свои; щелчок закрепляет и не переводит; щелчок мимо, повторный щелчок, Esc (фокус на кружок, перевод цел) скрывают; Esc без кнопок — оригинал`);

    // ---- 4. Главная кнопка во всех состояниях, подсказки, «RU», «⋯» ----
    await load({ hudShown: true });
    await away();
    await clickFab();
    f = await F();
    assert.deepStrictEqual(f.btns.map((x) => `${x.k}:${x.act}:${x.cls}`), ["main:translate:pri", "lang:null:", "more:null:"], "главная (залита — перевести), «RU», «⋯»");
    assert.deepStrictEqual(await ev("typeCalls('shortcut')"), [{ type: "shortcut", name: "translate-page" }], "при показе кнопок спросили у background сочетание «Перевести страницу»");
    // idle: подсказка у главной — «Перевести страницу» (без клавиши: в chrome.commands пусто) + второй способ
    let tp = await tipAt("main");
    assert.deepStrictEqual([tp.t, tp.kbd, tp.sub, tp.of], [await T("translatePage"), null, await T("csFkOrKey", "Shift"), "main"], "idle: " + JSON.stringify(tp));
    f = await F();
    assert.ok(tipBeside(f, "main", true), "подсказка — по центру главной, в 8 слева от столбика: " + JSON.stringify({ tip: f.tip.box, main: btn(f, "main").box }));
    assert.strictEqual(await ev("fabRoot().querySelectorAll('.fk-tip:not([hidden])').length"), 1);
    assert.deepStrictEqual(await ev("[...fabRoot().querySelector('[data-k=main]').querySelectorAll('svg')].length"), 1, "иконка");
    await t.shot("bar-idle.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    // подсказки сразу и одна за раз: «RU» и «⋯»
    tp = await tipAt("lang");
    const ruName = await ev("(() => { const s = HT_langLabel('RU'); return s[0].toUpperCase() + s.slice(1); })()");
    assert.deepStrictEqual([tp.t, tp.kbd, tp.sub, tp.of], [await T("csFkLang", ruName), null, null, "lang"], "«RU»: «Язык перевода: Русский», одна строка");
    f = await F();
    assert.ok(tipBeside(f, "lang", true) && btn(f, "lang").box && (await ev("fabRoot().querySelector('[data-k=lang]').textContent")) === "RU", "«RU» — код и подсказка по центру своей кнопки");
    tp = await tipAt("more");
    assert.deepStrictEqual([tp.t, tp.sub, tp.of], [await T("csFkMore"), null, "more"], "«⋯»: «Ещё»");
    assert.ok(tipBeside(await F(), "more", true));
    // клавиша есть — чип у заголовка; способ — задержка
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await ev("window.__shortcut = 'Alt+Shift+G'; setStore({ trigger: 'dwell' }); true");
    await clickFab(); await sleep(100);
    tp = await tipAt("main");
    assert.deepStrictEqual([tp.t, tp.kbd, tp.sub], [await T("translatePage"), "Alt+Shift+G", await T("csFkOrDwell")], "клавиша из chrome.commands — чип; способ — задержка: " + JSON.stringify(tp));
    await t.shot("bar-tip-key.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    await ev("setStore({ trigger: 'shift' }); true");
    // busy: «Стоп» на месте главной, подпись «Перевожу… N из M» у кружка — и при показанных кнопках
    await ev("window.__bgDelay = 600; window.__calls.length = 0; fabRoot().querySelector('[data-k=main]').__ht = 1; true");
    const mainBox0 = btn(await F(), "main").box;
    await clickIn("[data-k=main]");
    f = await F();
    let s = await state();
    tp = f.tip;
    assert.ok(s.page === "busy" && f.open && btn(f, "main").act === "stop" && btn(f, "main").cls === "" && f.focus === "main"
      && await ev("fabRoot().querySelector('[data-k=main]').__ht === 1") && JSON.stringify(btn(f, "main").box) === JSON.stringify(mainBox0),
      "перевожу: главная — «Стоп» на том же месте, та же кнопка, фокус на ней: " + JSON.stringify({ s, b: f.btns, focus: f.focus }));
    assert.deepStrictEqual([tp.t, tp.kbd, tp.sub, tp.of], [await T("csFkStop"), null, await T("csFkStopSub"), "main"], "подсказка обновилась на месте: " + JSON.stringify(tp));
    assert.ok(f.pill && f.pill.startsWith(await T("ppBusy")) && f.ring && !cross(f.pillBox, f.bar) && !cross(f.pillBox, f.tip.box) && inside(f.pillBox, await vp()),
      "подпись «Перевожу… N из M» и кольцо — у кружка, кнопки и подсказку не закрывают: " + JSON.stringify({ pill: f.pill, pb: f.pillBox, bar: f.bar, tip: f.tip.box }));
    await t.shot("bar-busy.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    // «Стоп» после первых пачек — part: «Перевести страницу» с числом переведённого
    assert.ok(await until(async () => (await state()).count > 0, 3000), "первые пачки пришли");
    await clickIn("[data-k=main]");
    s = await state();
    f = await F();
    assert.ok(s.page === "part" && btn(f, "main").act === "translate" && btn(f, "main").cls === "pri" && f.tip.t === await T("translatePage")
      && f.tip.sub === await T("ppEscHint", await ev(`HT_plural('ppPartDone', ${s.count})`)), "после «Стопа» — part: " + JSON.stringify({ s, tip: f.tip }));
    await t.shot("bar-part.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    // done: «Показать оригинал» с чипом Esc и парой языков
    await ev("window.__bgDelay = 0; true");
    await clickIn("[data-k=main]");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await sleep(100);
    f = await F();
    assert.deepStrictEqual([f.open, btn(f, "main").act, btn(f, "main").cls, f.tip.t, f.tip.kbd, f.tip.sub, f.focus], [true, "orig", "", await T("csShowOrig"), "Esc", PAIR, "main"], "done: " + JSON.stringify(f.tip));
    await t.shot("bar-done.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    // orig: «Показать перевод»
    await clickIn("[data-k=main]");
    assert.ok(await until(async () => (await state()).page === "orig", 1500) && !(await tr("#p1")), "«Показать оригинал» — оригинал");
    f = await F();
    assert.deepStrictEqual([f.open, btn(f, "main").act, btn(f, "main").cls, f.tip.t, f.tip.kbd, f.tip.sub], [true, "tr", "pri", await T("csFkShowTr"), null, await T("ppOrigHint", PAIR)], "orig: " + JSON.stringify(f.tip));
    await t.shot("bar-orig.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    await clickIn("[data-k=main]");
    assert.ok(await until(async () => (await state()).page === "done", 3000) && await tr("#p1"), "«Показать перевод» — снова перевод");
    assert.ok((await F()).open && await ev("fabRoot().querySelector('[data-k=main]').__ht === 1"), "кнопки остаются, главная — та же кнопка");
    // needClick: встроенный переводчик ждёт щелчка — подсказка об этом; щелчок по главной (действие пользователя) переводит
    await load({ hudShown: true, engine: "chrome" });
    await away();
    await ev("Translator.availability = async () => 'downloadable'; sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await F()).dot === "warn", 3000), "ждём щелчка — янтарная точка");
    await move(c.x, c.y); await sleep(60);
    tp = await tipAt("main");
    f = await F();
    assert.deepStrictEqual([btn(f, "main").act, btn(f, "main").cls, tp.t, tp.sub], ["translate", "pri", await T("translatePage"), await T("csClickPair")], "needClick: " + JSON.stringify(tp));
    await clickIn("[data-k=main]");
    assert.ok(await until(async () => (await state()).page === "done", 4000) && await tr("#p1"), "щелчок по главной — страница переведена");
    // сбой: нет ключа DeepL — «!» (.bad), щелчок — уведомление с причиной и что делать; страницу не переводит
    await load({ hudShown: true, apiKey: "" });
    await away();
    await ev("window.__calls.length = 0; true");
    await move(c.x, c.y); await sleep(60);
    tp = await tipAt("main");
    f = await F();
    const errTail = (await T("csFkErrSub", "\u0001")).split("\u0001")[1];
    assert.ok(btn(f, "main").act === "err" && btn(f, "main").cls === "bad" && f.dot === "err" && tp.t === await T("probTitle") && !tp.kbd
      && tp.sub.endsWith(errTail) && tp.sub.length > errTail.length + 3, "сбой — «!», подсказка «Перевод не работает · <причина> · щёлкните — что делать»: " + JSON.stringify({ b: f.btns[0], tp }));
    await t.shot("bar-err.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    await clickIn("[data-k=main]"); await sleep(150);
    const errToast = (await toastsNow()).find((x) => x.startsWith("err:"));
    assert.ok(errToast && errToast.startsWith("err:" + await T("probTitle")), "щелчок по «!» — уведомление «Перевод не работает»: " + JSON.stringify(await toastsNow()));
    assert.strictEqual(await ev("trCalls().length"), 0, "без ключа текст никуда не ушёл");
    ok(`главная кнопка меняется на месте (та же кнопка, фокус на ней): idle — залита, «${await T("translatePage")}» + клавиша из chrome.commands (если есть) + «наведите… Shift» / «задержите…»; busy — «Стоп» (подпись «Перевожу… N из M» у кружка видна); part — число переведённого; done — «Показать оригинал» с Esc и парой; orig — «Показать перевод»; needClick — подсказка о щелчке, щелчок переводит; сбой — «!», щелчок — уведомление; подсказки сразу, одна, по центру своей кнопки в 8 от столбика`);

    // «RU»: код — по targetLang; щелчок — панель языка (#fk-lang), повторный — закрыть; при панели подсказок нет
    await load({ hudShown: true, targetLang: "EN-US" });
    await away();
    await clickFab();
    tp = await tipAt("main");
    assert.strictEqual(tp.sub, await T("ppAlready"), "страница уже на языке перевода (lang=en, EN-US) — честно об этом");
    tp = await tipAt("lang");
    const enName = await ev("(() => { const s = HT_langLabel('EN-US'); return s[0].toUpperCase() + s.slice(1); })()");
    assert.deepStrictEqual([await ev("fabRoot().querySelector('[data-k=lang]').textContent"), tp.t], ["EN", await T("csFkLang", enName)], "EN-US → «EN»");
    await ev("setStore({ targetLang: 'PT-BR' }); true");
    await click(EMPTY.x, EMPTY.y); await sleep(100); await clickFab();
    assert.strictEqual(await ev("fabRoot().querySelector('[data-k=lang]').textContent"), "PT", "PT-BR → «PT»");
    const langA = () => ev("[fabRoot().querySelector('[data-k=lang]').getAttribute('aria-expanded'), fabRoot().querySelector('[data-k=more]').getAttribute('aria-expanded')]");
    await clickIn("[data-k=lang]");
    f = await F();
    assert.deepStrictEqual([f.panel, await langA(), btn(f, "lang").cls, f.tip, f.open], ["lang", ["true", "false"], "is-open", null, true], "щелчок по «RU» — панель языка, кнопка нажата, подсказки нет");
    lp = await point("[data-k=more]");
    await move(lp.x, lp.y); await sleep(80);
    assert.strictEqual((await F()).tip, null, "при открытой панели подсказок нет и у других кнопок");
    await t.shot("bar-lang-open.png", { clip: { x: 500, y: 400, width: 500, height: 400, scale: 1 } });
    await away(); await sleep(500);
    assert.strictEqual((await F()).panel, "lang", "открыта панель — уход курсора не скрывает");
    await clickIn("[data-k=lang]");
    f = await F();
    assert.deepStrictEqual([f.panel, await langA(), btn(f, "lang").cls, f.open], ["", ["false", "false"], "", true], "повторный щелчок по «RU» — панель закрыта, кнопки остались");
    // «⋯» при открытой панели языка — одна панель за раз
    await clickIn("[data-k=lang]");
    await clickIn("[data-k=more]");
    f = await F();
    assert.deepStrictEqual([f.panel, await langA(), f.btns.map((x) => x.cls).join()], ["more", ["false", "true"], "pri,,is-open"], "«⋯» при панели языка — панель «⋯», языка — закрыта");
    ok("«RU»: код по targetLang (EN-US → EN, PT-BR → PT), подсказка «Язык перевода: …»; щелчок — панель #fk-lang (aria-expanded, кнопка нажата, подсказок нет, уход курсора не скрывает), повторный — закрыть; панели — по одной");

    // «⋯»: пункты
    await load({ hudShown: true });
    await away();
    await clickFab();
    await clickIn("[data-k=more]");
    const items = await ev(`[...fabRoot().querySelectorAll('#fk-more [role=menuitem].fk-opt')].map((x) => x.getAttribute('data-act') + ':' + x.textContent.trim() + ':' + !!x.querySelector('svg'))`);
    assert.deepStrictEqual(items, [`site-off:${await T("csFabSiteOff", "127.0.0.1")}:true`, `hide:${await T("csFabHide")}:true`, `settings:${await T("ppSettings")}:true`]);
    await t.shot("bar-more-open.png", { clip: { x: 500, y: 400, width: 500, height: 400, scale: 1 } });
    await clickIn('#fk-more [data-act="settings"]');
    assert.deepStrictEqual(await ev("typeCalls('openSettings')"), [{ type: "openSettings", focus: "page" }], "«Настройки» — к разделу «На странице»");
    assert.ok(!(await F()).open && (await F()).panel === "", "выбор пункта скрывает всё");
    // «Выключить на 127.0.0.1»: оригинал, кружка нет, уведомление с «Включить снова»
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await clickFab();
    await clickIn("[data-k=more]");
    await clickIn('#fk-more [data-act="site-off"]'); await sleep(250);
    assert.deepStrictEqual(await ev("__store.disabledSites"), ["127.0.0.1"]);
    assert.ok(!(await tr("#p1")), "оригинал вернулся");
    assert.strictEqual(await F(), null, "кружок скрыт на выключенном сайте");
    assert.deepStrictEqual(await toastsNow(), ["info:" + await T("csSiteDisabledTitle", "127.0.0.1") + await T("csSiteDisabledText") + await T("turnBackOn")]);
    await t.shot("toast-site-off.png", { clip: { x: 500, y: 0, width: 500, height: 200, scale: 1 } });
    const on = await ev("uiPoint(toastRoot(), '.t-btn')");
    await click(on.x, on.y); await sleep(250);
    assert.deepStrictEqual(await ev("__store.disabledSites"), []);
    assert.ok(await F(), "«Включить снова» — кружок на месте");
    // «Скрыть кнопку»: hudShown = false, «Кнопка скрыта» с «Вернуть» (8 с)
    await ev("window.__sets.length = 0; true");
    await clickFab();
    await clickIn("[data-k=more]");
    await clickIn('#fk-more [data-act="hide"]'); await sleep(250);
    assert.strictEqual(await F(), null, "кружок скрыт");
    assert.deepStrictEqual(await ev("__sets"), [{ hudShown: false }]);
    const hiddenToast = ["info:" + await T("csFabHiddenTitle") + await T("csFabHiddenText") + await T("csFabBack")];
    assert.deepStrictEqual(await toastsNow(), hiddenToast);
    await t.shot("toast-fab-hidden.png", { clip: { x: 500, y: 0, width: 500, height: 200, scale: 1 } });
    await sleep(6000);
    assert.deepStrictEqual(await toastsNow(), hiddenToast, "через 6 с уведомление ещё на экране (живёт 8 с)");
    const back = await ev("uiPoint(toastRoot(), '.t-btn')");
    await click(back.x, back.y); await sleep(250);
    assert.deepStrictEqual(await ev("__sets"), [{ hudShown: false }, { hudShown: true }], "«Вернуть» — hudShown = true");
    assert.ok(await F(), "кружок вернулся");
    assert.deepStrictEqual(await toastsNow(), [], "после «Вернуть» уведомление закрыто");
    ok("«⋯»: «Выключить на 127.0.0.1» — оригинал, кружок скрыт, «Перевод на 127.0.0.1 выключен» + «Включить снова» (возвращает); «Скрыть кнопку» — hudShown = false, «Кнопка скрыта» с «Вернуть» (> 6 с на экране), «Вернуть» — hudShown = true; «Настройки» → openSettings { focus: page }; выбор пункта скрывает всё");

    // ---- 5. Где кнопки, подсказки и панели ----
    // Столбик — по оси кружка, кнопки 36 через 8, в 8 от кружка: вверх (главная ближе всех) или вниз (.down), если
    // над кружком нет 8 + 124 + 16. Подсказки — в 8 от кнопок к середине экрана; панели: язык — вровень с низом
    // кружка (вниз — с верхом), «⋯» — вровень с дальним краем своей кнопки. Всё — в окне.
    const placeBar = async (pos, name, w = 1000, h = 800) => {
      await viewport(w, h);
      await load({ hudShown: true, hudPos: pos });
      await move(w > 700 ? 650 : 10, Math.round(h / 2)); await sleep(40);
      await clickFab();
      const vv = await vp(), x = await F(), right = pos ? pos.side === "right" : true;
      const B = x.btns.map((q) => q.box), fb = x.fab, axis = Math.round(fb.l + fb.w / 2);
      assert.ok(x.open && x.btns.length === 3, name + ": кнопки показаны");
      assert.ok(B.every((q) => q.w === 36 && q.h === 36 && Math.abs(q.l + 18 - axis) <= 1 && inside(q, vv)), name + ": кнопки 36 по оси кружка, в окне: " + JSON.stringify({ B, fb }));
      const gapsNow = x.down ? [B[0].t - fb.b, B[1].t - B[0].b, B[2].t - B[1].b] : [fb.t - B[0].b, B[0].t - B[1].b, B[1].t - B[2].b];
      assert.deepStrictEqual(gapsNow, [8, 8, 8], name + ": зазоры 8 — до кружка и между кнопками, главная ближе всех: " + JSON.stringify({ B, fb, down: x.down }));
      const tips = [];
      for (const k of ["main", "lang", "more"]) {
        await tipAt(k);
        const y = await F();
        assert.ok(y.tip && inside(y.tip.box, vv) && (vv.w < 360 || tipBeside(y, k, right)), `${name}: подсказка «${k}» — по центру кнопки, в 8 ${right ? "слева" : "справа"}, в окне: ` + JSON.stringify({ tip: y.tip.box, b: btn(y, k).box }));
        // в окне уже 360 длинная подсказка (до 320) сдвигается внутрь окна и может лечь на кнопки — здесь только кружок
        assert.ok(!(vv.w < 360 ? [fb] : B.concat([fb])).some((q) => cross(q, y.tip.box)), `${name}: подсказка «${k}» кнопки и кружок не закрывает: ` + JSON.stringify({ tip: y.tip.box, B, fb, vv }));
        tips.push(y.tip.box);
      }
      const panels = {};
      for (const k of ["more", "lang"]) {
        await clickIn(`[data-k=${k}]`);
        const y = await F(), P = y.panelBox, kb = btn(y, k).box;
        assert.ok(y.panel === k && inside(P, vv) && P.l >= 8 && P.r <= vv.w - 8 && !B.concat([fb]).some((q) => cross(q, P)), `${name}: панель «${k}» в окне (поле 8), кнопки и кружок не закрывает: ` + JSON.stringify({ P, B, fb, vv }));
        if (vv.w >= 360) {
          assert.strictEqual(right ? B[0].l - P.r : P.l - B[0].r, 8, `${name}: панель «${k}» — в 8 от кнопок к середине экрана`);
          const edge = k === "lang" ? (x.down ? P.t - fb.t : P.b - fb.b) : (x.down ? P.b - kb.b : P.t - kb.t);
          assert.ok(Math.abs(edge) <= 1, `${name}: панель «${k}» вровень с ${k === "lang" ? (x.down ? "верхом" : "низом") + " кружка" : "дальним краем «⋯»"}: ` + JSON.stringify({ P, kb, fb }));
        }
        panels[k] = P;
        if (k === "more") await t.shot(`bar-at-${name}.png`, { clip: { x: 0, y: 0, width: w, height: h, scale: w > 700 ? 0.5 : 1 } });
      }
      await esc(); await esc();
      return { x, vv, tips, panels };
    };
    const where = [];
    for (const [pos, name] of [[null, "right-bottom"], [{ side: "right", top: 100 }, "right-top"], [{ side: "left", top: 400 }, "left-middle"], [{ side: "left", top: 16 }, "left-top"]]) {
      const { x } = await placeBar(pos, name);
      assert.strictEqual(x.down, name.endsWith("top"), name + ": " + (name.endsWith("top") ? "над кружком мало места — вниз (.down)" : "вверх"));
      where.push(`${name}: ${x.down ? "вниз" : "вверх"}`);
    }
    // граница: над кружком ровно 8 + 124 + 16 — ещё вверх, на 1 меньше — вниз
    assert.strictEqual((await placeBar({ side: "right", top: 148 }, "edge-148")).x.down, false, "top 148 — вверх");
    assert.strictEqual((await placeBar({ side: "right", top: 147 }, "edge-147")).x.down, true, "top 147 — вниз");
    // узкое окно 320: кнопки, подсказки и панели — в окне; панели налезают на текст, но не на кнопки
    const narrow = await placeBar(null, "narrow-320", 320, 600);
    await viewport(1000, 800);
    ok(`кнопки — по оси кружка через 8 (${where.join("; ")}; граница — top 148/147), подсказки — по центру своей кнопки в 8 к середине экрана, панели языка и «⋯» — вровень с кружком / дальним краем «⋯» в 8 от кнопок; окно 320 — всё в окне, кнопки не закрыты (панель «⋯» ${narrow.panels.more.w} px)`);

    // ---- 6. Перетаскивание ----
    await load({ hudShown: true });
    await away();
    v = await vp();
    let f0 = await F();
    c = mid(f0.fab);
    // сдвиг 3 px — это щелчок
    await move(c.x, c.y); await down(c.x, c.y);
    await move(c.x - 3, c.y, { button: "left", buttons: 1 });
    await up(c.x - 3, c.y); await sleep(250);
    f = await F();
    assert.ok(f.open && f.fab.l === f0.fab.l && f.fab.t === f0.fab.t && (await posSets()).length === 0, "сдвиг 3 px — щелчок: кнопки закреплены, кружок на месте, ничего не записано: " + JSON.stringify(f));
    await click(EMPTY.x, EMPTY.y); await sleep(120);
    // настоящее перетаскивание: к (300, 300)
    const drag = async (from, to, hold = 350) => {
      await move(from.x, from.y); await down(from.x, from.y);
      const n = 10;
      for (let i = 1; i <= n; i++) { await move(Math.round(from.x + (to.x - from.x) * i / n), Math.round(from.y + (to.y - from.y) * i / n), { button: "left", buttons: 1 }); await sleep(16); }
      await sleep(hold);
      const during = await F();
      await up(to.x, to.y);
      await sleep(450);
      return during;
    };
    await ev("window.__calls.length = 0; true");
    const to = { x: 300, y: 300 };
    let during = await drag(c, to);
    assert.ok(during.drag && !during.open, "тащат: is-drag, кнопок нет (курсор держали на кружке 350 мс): " + JSON.stringify(during));
    assert.ok(Math.abs(mid(during.fab).x - to.x) <= 2 && Math.abs(mid(during.fab).y - to.y) <= 2, "кружок едет за курсором: " + JSON.stringify(during.fab));
    await t.shot("fab-drag.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.5 } });
    f = await F();
    const wantTop = f0.fab.t + (to.y - c.y);
    assert.ok(!f.drag && !f.open && f.fab.l === 16 && Math.abs(f.fab.t - wantTop) <= 1, `отпустили — у левого края в 16, по высоте где отпустили (${wantTop}): ` + JSON.stringify(f.fab));
    let ps = await posSets();
    assert.ok(ps.length === 1 && ps[0].side === "left" && Math.abs(ps[0].top - wantTop) <= 1 && Object.keys(ps[0]).sort().join() === "side,top", "hudPos записан один раз, { side, top }: " + JSON.stringify(ps));
    assert.strictEqual(await ev("trCalls().length"), 0, "перетаскивание ничего не перевело");
    await sleep(400);
    assert.ok(!(await F()).open, "после перетаскивания кнопки не показались");
    await t.shot("fab-dropped-left.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.5 } });
    // тащат вверх вдоль края: показанные наведением кнопки скрываются; отпустили — курсор на кружке, но кнопки — только
    // когда он уйдёт и вернётся
    f = await F();
    let fc = mid(f.fab);
    await move(fc.x, fc.y); await sleep(60);
    assert.ok((await F()).open, "наведение — кнопки");
    await down(fc.x, fc.y);
    for (let i = 1; i <= 5; i++) { await move(fc.x, fc.y - i * 30, { button: "left", buttons: 1 }); await sleep(30); }
    assert.ok((await F()).drag && !(await F()).open, "тащат — кнопок нет");
    await up(fc.x, fc.y - 150); await sleep(400);
    fc = mid((await F()).fab);
    await move(fc.x + 2, fc.y + 2); await sleep(400);
    assert.ok(!(await F()).open, "отпустили, курсор на кружке — кнопки не показались");
    await away(); await move(fc.x, fc.y); await sleep(60);
    assert.ok((await F()).open, "ушёл и вернулся — кнопки показаны");
    await away(); await sleep(400);
    ps = await posSets();
    assert.ok(ps.length === 2 && ps[1].side === "left", "второе перетаскивание — вторая запись: " + JSON.stringify(ps));
    const saved = ps[1];
    // «другая страница»: место то же
    await load({ hudShown: true, hudPos: saved });
    f = await F();
    assert.ok(f.fab.l === 16 && Math.abs(f.fab.t - saved.top) <= 1, "перезагрузка — то же место: " + JSON.stringify(f.fab));
    assert.deepStrictEqual(await posSets(), [], "при загрузке место не переписывается");
    // к правому краю у самого верха: top не ближе 16
    during = await drag(mid(f.fab), { x: 800, y: 5 });
    f = await F();
    assert.deepStrictEqual([v.w - f.fab.r, f.fab.t], [16, 16], "отпустили у верха справа — у правого края, top 16: " + JSON.stringify(f.fab));
    assert.deepStrictEqual(await posSets(), [{ side: "right", top: 16 }]);
    // у самого низа: не ближе 16 к низу
    await ev("window.__sets.length = 0; true");
    await drag(mid(f.fab), { x: 700, y: 795 });
    f = await F();
    assert.deepStrictEqual([v.w - f.fab.r, v.h - f.fab.b], [16, 16], "отпустили у низа — низ кружка в 16 от низа: " + JSON.stringify(f.fab));
    assert.deepStrictEqual(await posSets(), [{ side: "right", top: v.h - 60 }]);
    ok(`перетаскивание: сдвиг 3 px — щелчок; дальше 4 px — тащат (is-drag, кнопок нет, показанные — скрываются), отпустили — у ближайшего края в 16 по высоте отпускания (не ближе 16 к верху и низу); hudPos { side, top } пишется один раз; после перезагрузки место то же (${JSON.stringify(saved)})`);
    // миграция старого { left, top } и мусор
    await load({ hudShown: true, hudPos: { left: 120, top: 300 } });
    f = await F();
    assert.deepStrictEqual([f.fab.l, f.fab.t], [16, 300], "старое место левее середины — слева, высота прежняя");
    await load({ hudShown: true, hudPos: { left: 800, top: 200 } });
    f = await F();
    assert.deepStrictEqual([v.w - f.fab.r, f.fab.t], [16, 200], "правее середины — справа");
    assert.deepStrictEqual(await posSets(), [], "миграция в хранилище не пишет");
    for (const junk of [{ left: "x", top: 1 }, { side: "middle", top: 5 }, { side: "left", top: "7" }, "bottom", 42]) {
      await load({ hudShown: true, hudPos: junk });
      f = await F();
      assert.deepStrictEqual([v.w - f.fab.r, v.h - f.fab.b], [16, 16], "мусор " + JSON.stringify(junk) + " — справа внизу в 16");
    }
    // низкое окно прижимает, записанное не меняется; вернули высоту — прежнее место
    await load({ hudShown: true, hudPos: { side: "right", top: 700 } });
    assert.strictEqual((await F()).fab.t, 700);
    await viewport(1000, 500); await sleep(300);
    f = await F();
    assert.deepStrictEqual([f.fab.t, 1000 - f.fab.r >= 16], [440, true], "окно 500 — прижат: top = 500 − 44 − 16: " + JSON.stringify(f.fab));
    await viewport(1000, 800); await sleep(300);
    assert.strictEqual((await F()).fab.t, 700, "окно снова 800 — прежнее место");
    assert.deepStrictEqual(await posSets(), [], "прижатие ничего не записывает");
    // по умолчанию — следует за низом окна; узкое окно — кружок слева на месте
    await load({ hudShown: true });
    await viewport(1000, 500); await sleep(300);
    v = await vp();
    f = await F();
    assert.strictEqual(v.h - f.fab.b, 16, "по умолчанию — низ в 16 и при низком окне");
    await viewport(1000, 800);
    await load({ hudShown: true, hudPos: { side: "left", top: 100 } });
    await viewport(420, 800); await sleep(300);
    f = await F();
    assert.deepStrictEqual([f.fab.l, f.fab.t], [16, 100], "узкое окно — у левого края на месте");
    await viewport(1000, 800); await sleep(200);
    v = await vp();
    ok("место: старое { left, top } — к своему краю с прежней высотой (без записи); мусор — справа внизу в 16; низкое окно прижимает (440 при 500), записанное не меняется и возвращается; по умолчанию — за низом окна");

    // ---- 7. Клавиатура ----
    await load({ hudShown: true });
    await away();
    await ev("document.querySelector('#inp').focus(); true");
    await tab();
    let k = await ev("({ host: document.activeElement === fabRoot().host, f: fabInfo().focus })");
    assert.deepStrictEqual(k, { host: true, f: "fab" }, "Tab с последнего поля страницы — на кружок");
    f = await F();
    assert.ok(f.open && f.expanded === "true" && f.tip === null, "Tab до кружка — кнопки показаны, фокус остался на кружке: " + JSON.stringify(f));
    await sleep(600);
    assert.ok((await F()).open, "фокус на кружке — кнопки не скрываются сами (курсор не над ними)");
    const ringFocus = await ev("(() => { const g = getComputedStyle(fabRoot().querySelector('.fab')); return [g.borderTopColor, g.boxShadow]; })()");
    assert.ok(ringFocus[0] === "rgb(37, 99, 235)" && /rgba\(37, 99, 235, 0\.35\) 0px 0px 0px 3px/.test(ringFocus[1]), "фокус — рамка акцентом и ореол 3 px: " + JSON.stringify(ringFocus));
    await t.shot("fab-focus.png", { clip: { x: 600, y: 500, width: 400, height: 300, scale: 1 } });
    await tab(true);
    assert.ok(await ev("document.activeElement.id === 'inp'") && !(await F()).open, "Shift+Tab — обратно на страницу (кружок последний в обходе), кнопки скрыты");
    // Tab — по кнопкам от кружка наружу: главная → язык → «⋯», у каждой подсказка; из «⋯» — дальше, кнопки скрыты
    await tab();
    const seq = [];
    for (const want of ["main", "lang", "more"]) {
      await tab();
      const x = await F();
      seq.push(x.focus);
      assert.ok(x.open && x.focus === want && x.tip && x.tip.of === want && tipBeside(x, want, true), `Tab — «${want}» с подсказкой по центру: ` + JSON.stringify({ focus: x.focus, tip: x.tip }));
    }
    assert.strictEqual(await ev("fabRoot().querySelectorAll('[aria-describedby]').length"), 1, "подсказка одна");
    await t.shot("bar-kb-more.png", { clip: { x: 500, y: 500, width: 500, height: 300, scale: 1 } });
    await tab(true); await tab(true);
    assert.strictEqual((await F()).focus, "main", "Shift+Tab — обратно к главной");
    await tab(); await tab(); await tab();
    f = await F();
    assert.ok(!f.open && await ev("document.activeElement !== fabRoot().host"), "Tab из «⋯» — дальше, ловушки нет, кнопки скрыты: " + JSON.stringify(f));
    // Enter на кружке — закрепить + фокус на главную; ↑ ↓ Home End — по направлению столбика (вверх — дальше от кружка)
    await ev("document.querySelector('#inp').focus(); true");
    await tab();
    await ev("window.__calls.length = 0; true");
    await enter();
    f = await F();
    assert.ok(f.open && f.expanded === "true" && f.focus === "main" && f.tip && f.tip.of === "main", "Enter на кружке — кнопки, фокус на главной с подсказкой: " + JSON.stringify(f));
    assert.strictEqual(await ev("trCalls().length"), 0, "Enter на кружке страницу не переводит");
    const keyTo = async (k2, code, vk) => { await press(k2, code, vk); return (await F()).focus; };
    const UP = ["ArrowUp", "ArrowUp", 38], DOWN = ["ArrowDown", "ArrowDown", 40], HOME = ["Home", "Home", 36], END = ["End", "End", 35];
    const nav = [];
    for (const kk of [UP, UP, UP, DOWN, HOME, DOWN, END, HOME]) nav.push(await keyTo(...kk));
    assert.deepStrictEqual(nav, ["lang", "more", "more", "lang", "main", "main", "more", "main"], "↑ ↑ ↑ ↓ Home ↓ End Home (вверх — от кружка, на краях стоп)");
    f = await F();
    assert.ok(f.open && f.tip.of === "main" && (await ev("trCalls().length")) === 0);
    // главная с клавиатуры: меняется на месте, фокус остаётся на ней
    await ev("window.__bgDelay = 400; true");
    await enter(); await sleep(60);
    f = await F();
    assert.ok((await state()).page === "busy" && btn(f, "main").act === "stop" && f.focus === "main" && f.tip.t === await T("csFkStop"), "Enter на главной — «Стоп», фокус на ней: " + JSON.stringify(f));
    assert.ok(await until(async () => (await state()).page === "done", 5000));
    await sleep(100);
    f = await F();
    assert.ok(f.open && btn(f, "main").act === "orig" && f.focus === "main" && f.tip.t === await T("csShowOrig") && f.tip.kbd === "Esc", "переведена — «Показать оригинал», фокус на ней: " + JSON.stringify(f));
    await ev("window.__bgDelay = 0; true");
    // «⋯» с клавиатуры: фокус на первом пункте, ↓ ↑ по кругу; Esc по цепочке: панель → кнопки (фокус на кружок) → оригинал
    await press(...END);
    await enter();
    f = await F();
    assert.ok(f.panel === "more" && f.focus === "site-off" && f.tip === null && btn(f, "more").cls === "is-open", "Enter на «⋯» — панель, фокус на первом пункте: " + JSON.stringify(f));
    const navMore = [await keyTo(...DOWN), await keyTo(...DOWN), await keyTo(...DOWN), await keyTo(...UP), await keyTo(...END), await keyTo(...HOME)];
    assert.deepStrictEqual(navMore, ["hide", "settings", "site-off", "settings", "settings", "site-off"], "пункты «⋯»: ↓ ↓ ↓ (по кругу) ↑ End Home");
    await t.shot("bar-kb-menu.png", { clip: { x: 500, y: 400, width: 500, height: 400, scale: 1 } });
    await esc();
    f = await F();
    assert.ok(f.open && f.panel === "" && f.focus === "more" && f.tip && f.tip.of === "more" && await tr("#p1"), "Esc — панель закрыта, фокус на «⋯» с подсказкой, перевод цел: " + JSON.stringify(f));
    await esc();
    f = await F();
    assert.ok(!f.open && f.focus === "fab" && f.expanded === "false" && await tr("#p1"), "ещё Esc — кнопки скрыты, фокус на кружке, перевод цел: " + JSON.stringify(f));
    await sleep(400);
    assert.ok(!(await F()).open, "фокус вернулся на кружок — кнопки сами не показались");
    await esc();
    assert.ok(await until(async () => (await state()).page === "orig", 1500) && !(await tr("#p1")), "ещё Esc — оригинал");
    // пробел на кружке — то же, что Enter; «RU» — панель языка с фокусом в поле поиска, Esc — фокус на «RU»
    await space();
    f = await F();
    assert.ok(f.open && f.focus === "main", "пробел на кружке — кнопки, фокус на главной: " + JSON.stringify(f));
    await press(...UP);
    await space();
    f = await F();
    assert.ok(f.panel === "lang" && f.focus === "fk-q" && await ev("fabRoot().querySelector('[data-k=lang]').getAttribute('aria-expanded') === 'true'"), "пробел на «RU» — панель языка, фокус в поле поиска: " + JSON.stringify(f));
    await esc();
    f = await F();
    assert.ok(f.open && f.panel === "" && f.focus === "lang", "Esc в панели языка — фокус на «RU»: " + JSON.stringify(f));
    await esc();
    assert.ok(!(await F()).open && (await F()).focus === "fab");
    // столбик вниз (.down): ↓ — дальше от кружка
    await load({ hudShown: true, hudPos: { side: "right", top: 100 } });
    await away();
    await ev("document.querySelector('#inp').focus(); true");
    await tab(); await enter();
    f = await F();
    assert.ok(f.down && f.focus === "main", "кружок вверху — столбик вниз, фокус на главной");
    const navDown = [];
    for (const kk of [DOWN, DOWN, DOWN, UP, HOME, END]) navDown.push(await keyTo(...kk));
    assert.deepStrictEqual(navDown, ["lang", "more", "more", "lang", "main", "more"], "в .down: ↓ ↓ ↓ ↑ Home End");
    await esc();
    ok(`клавиатура: Tab с последнего поля — на кружок (рамка и ореол 3 px), кнопки показаны; Shift+Tab — обратно (скрыты); Tab по кнопкам (${seq.join(" → ")}) с подсказками, из «⋯» — дальше без ловушки; Enter и пробел на кружке — закрепить, фокус на главную, не переводят; ↑ ↓ Home End по направлению столбика (вверх и в .down), на краях стоп; главная с клавиатуры меняется на месте, фокус на ней; «⋯» — фокус на пункт, по кругу; «RU» — фокус в поле; Esc: панель (фокус на её кнопку) → кнопки (фокус на кружок) → оригинал`);

    // ---- 8. Где кружка нет ----
    await load({ hudShown: false });
    assert.deepStrictEqual([await F(), (await state()).hud], [null, false], "hudShown = false — кружка нет");
    await load({ hudShown: true, disabledSites: ["127.0.0.1"] });
    assert.deepStrictEqual([await F(), (await state()).hud], [null, false], "выключенный сайт — кружка нет");
    await ev("setStore({ disabledSites: [] }); true"); await sleep(150);
    assert.ok(await F(), "включили сайт — кружок появился");
    await load({ hudShown: true, enabled: false });
    assert.deepStrictEqual([await F(), (await state()).hud], [null, false], "перевод выключен везде — кружка нет");
    await ev("setStore({ enabled: true }); true"); await sleep(150);
    assert.ok(await F() && (await state()).hud === true, "включили — кружок появился сам");
    await ev("setStore({ enabled: false }); true"); await sleep(150);
    assert.strictEqual(await F(), null, "выключили — исчез");
    const fr = OTHER + "/stub-frame.html?store=" + encodeURIComponent(JSON.stringify({ hudShown: true }));
    await load({ hudShown: true }, "&frame=" + encodeURIComponent(fr));
    await sleep(700);
    const frameRep = await ev(`new Promise((res) => { addEventListener("message", (e) => res(e.data), { once: true }); document.querySelector("#fr").contentWindow.postMessage("report", "*"); })`);
    assert.ok(await F(), "на самой странице кружок есть");
    assert.strictEqual(frameRep.ui, 0, "во встроенном окне (hudShown = true) кружка нет: " + JSON.stringify(frameRep));
    ok("кружка нет: hudShown = false, выключенный сайт (включили — появился), перевод выключен везде (включили — появился сам, выключили — исчез), встроенное окно");

    // ---- 9. Уведомление над кружком ----
    const say = async () => { await ev("sendCmd({ type: 'say', what: 'disabled', keys: 'Alt+Shift+O' }); true"); await sleep(150); };
    const toastBox = () => ev("(() => { const r = toastRoot(); if (!r) return null; const q = r.host.getBoundingClientRect(); return { l: Math.round(q.left), t: Math.round(q.top), r: Math.round(q.right), b: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) }; })()");
    const p1Box = () => ev("(() => { const q = document.querySelector('#p1').getBoundingClientRect(); return { l: Math.round(q.left), t: Math.round(q.top), r: Math.round(q.right), b: Math.round(q.bottom) }; })()");
    await viewport(640, 600);
    await load({ hudShown: true });
    v = await vp();
    const pr = await p1Box();
    await move(pr.l + 560, Math.round((pr.t + pr.b) / 2)); await sleep(40);   // текст справа — под местом уведомления вверху
    await say();
    let tb = await toastBox();
    f = await F();
    assert.ok(tb && !cross(tb, pr) && !cross(tb, f.fab), "уведомление не закрывает ни текст под курсором, ни кружок: " + JSON.stringify({ tb, pr, fab: f.fab }));
    assert.deepStrictEqual([v.h - tb.b, f.fab.t - tb.b, v.w - tb.r, v.h - f.fab.b], [72, 12, 16, 16], "внизу справа над кружком: низ на 12 выше кружка (bottom 72 = 16 + 44 + 12)");
    await t.shot("toast-over-fab.png");
    // показали кнопки, пока уведомление внизу: уведомление обходит кружок вместе со столбиком (и открытой панелью)
    await clickFab();
    f = await F();
    tb = await toastBox();
    const barAll = f.btns.map((q) => q.box);
    assert.ok(f.open && tb && !barAll.some((q) => cross(tb, q)) && !cross(tb, f.fab) && inside(tb, v), "кнопки уведомление не закрывает: " + JSON.stringify({ tb, btns: barAll, fab: f.fab }));
    await t.shot("toast-and-bar.png");
    await clickIn("[data-k=more]");
    f = await F();
    tb = await toastBox();
    assert.ok(f.panel === "more" && tb && !cross(tb, f.panelBox) && !barAll.some((q) => cross(tb, q)) && !cross(tb, f.fab) && inside(tb, v),
      "открытую панель «⋯» уведомление не закрывает: " + JSON.stringify({ tb, panel: f.panelBox }));
    await t.shot("toast-and-more.png");
    await clickIn("[data-k=lang]");
    f = await F();
    tb = await toastBox();
    assert.ok(f.panel === "lang" && tb && !cross(tb, f.panelBox) && !cross(tb, f.fab) && inside(tb, v), "открытую панель языка — тоже: " + JSON.stringify({ tb, panel: f.panelBox }));
    // кнопки скрыли — уведомление снова над кружком. Щелчок мимо — в левый нижний угол: панель языка в окне 640 × 600
    // высокая (≈ 260, вровень с низом кружка) и закрывает середину окна справа.
    const corner = { x: 8, y: v.h - 8 };
    assert.ok(![f.panelBox, f.fab, tb, ...barAll].some((q) => q && corner.x >= q.l && corner.x <= q.r && corner.y >= q.t && corner.y <= q.b), "точка щелчка мимо — вне наших элементов");
    await click(corner.x, corner.y); await sleep(150);
    tb = await toastBox();
    f = await F();
    assert.ok(!f.open && tb && f.fab.t - tb.b === 12, "кнопки скрыты — уведомление снова в 12 над кружком: " + JSON.stringify({ tb, fab: f.fab }));
    // кружок слева — уведомление внизу справа в 16
    await load({ hudShown: true, hudPos: { side: "left", top: 540 } });
    await move(pr.l + 560, Math.round((pr.t + pr.b) / 2)); await sleep(40);
    await say();
    tb = await toastBox();
    f = await F();
    assert.ok(tb && !cross(tb, f.fab) && !cross(tb, pr) && v.h - tb.b === 16 && v.w - tb.r === 16, "кружок слева — уведомление внизу справа в 16: " + JSON.stringify({ tb, fab: f.fab }));
    await t.shot("toast-fab-left.png");
    await viewport(1000, 800);
    ok("уведомление внизу (закрыло бы текст) — над кружком: низ на 12 выше кружка, bottom 72; показанные кнопки и открытые панели («⋯», язык) обходит, кружок не закрывает; кнопки скрыты — снова над кружком; кружок слева — внизу справа в 16");

    // ---- 10. Цвета: тёмная тема системы на светлом сайте, тёмный сайт ----
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await load({ hudShown: true });
    await away();
    assert.deepStrictEqual([(await F()).dk, ...(await look())], [false, "rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(37, 99, 235)"], "светлый сайт при тёмной теме системы — светлый кружок");
    await clickFab();
    assert.deepStrictEqual(await barLook(), BAR_LIGHT, "кнопки на светлом сайте: главная #2563eb, обычные белые с рамкой #c9ced5, подсказка и панели светлые");
    await t.shot("bar-light.png", { clip: { x: 500, y: 400, width: 500, height: 400, scale: 1 } });
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    // сайт сменил тему своим переключателем, без перезагрузки (класс у <html>, как у Википедии) — кружок вслед за ним
    await ev(`(() => { const st = document.createElement("style"); st.textContent = "html.night, html.night body { background: #121316 !important; color: #e6e6e6 !important; }";
      document.head.appendChild(st); document.documentElement.classList.add("night"); return true; })()`);
    await sleep(400);
    assert.deepStrictEqual([(await F()).dk, ...(await look())], [true, "rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(143, 176, 255)"], "сайт стал тёмным без перезагрузки — кружок тёмный без наведения");
    await ev(`document.documentElement.classList.remove("night"), true`);
    await sleep(400);
    assert.strictEqual((await F()).dk, false, "сайт снова светлый — кружок светлый");
    // Полоса другого цвета через центр окна (The Guardian: тёмно-синяя шапка посреди светлого сайта) — тема по большинству
    // точек, а не по центру. Класс у <html> — чтобы кружок перекрасился сразу, без наведения.
    const band = (bg) => ev(`(() => { const d = document.createElement("div"); d.id = "band";
      d.style.cssText = "position: fixed; left: 0; right: 0; top: 300px; height: 200px; z-index: 1; background: ${bg}";
      document.body.appendChild(d); document.documentElement.classList.toggle("band"); return document.elementFromPoint(500, 400) === d; })()`);
    const unband = () => ev(`(() => { document.getElementById("band").remove(); document.documentElement.classList.toggle("band"); return true; })()`);
    assert.ok(await band("#052962"), "полоса не в центре окна");
    await sleep(400);
    assert.strictEqual((await F()).dk, false, "светлый сайт с тёмной полосой через центр окна — кружок светлый");
    await load({ hudShown: true }, "&dark=1");
    await away();
    f = await F();
    assert.deepStrictEqual([f.dk, ...(await look())], [true, "rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(143, 176, 255)"], "тёмный сайт — #2a2d33, рамка .4, иконка #8fb0ff");
    assert.ok(await band("#ffffff"), "полоса не в центре окна");
    await sleep(400);
    assert.strictEqual((await F()).dk, true, "тёмный сайт со светлой полосой через центр окна — кружок тёмный");
    await unband(); await sleep(400);
    await t.shot("fab-dark.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    await clickFab();
    assert.deepStrictEqual(await barLook(), BAR_DARK, "кнопки на тёмном сайте: главная #8fb0ff, обычные #2a2d33 с рамкой rgba(255,255,255,.4), подсказка и панели тёмные");
    await t.shot("bar-dark.png", { clip: { x: 500, y: 400, width: 500, height: 400, scale: 1 } });
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await away(); await sleep(250);
    assert.deepStrictEqual((await look()).slice(0, 1).concat((await F()).on), ["rgb(143, 176, 255)", true], "переведена на тёмном — заливка #8fb0ff");
    await t.shot("fab-dark-on.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    ok("цвета по фону сайта: светлый — белый с рамкой #c9ced5 (и при тёмной теме системы), тёмный — #2a2d33, рамка rgba(255,255,255,.4), иконка #8fb0ff, «переведена» — #8fb0ff; кнопки: главная #2563eb / #8fb0ff, обычные белые / #2a2d33 с рамкой, подсказка и панели — по теме; полоса другого цвета через центр окна тему не меняет");

    // ---- 10а. Сайт сменил тему вслед за системой плавно (Хабр: @media в CSS, transition фона .2s) ----
    // В миг события matchMedia фон ещё прежний, а DOM не меняется — кружок и уведомление перепроверяют тему чуть позже.
    const toastDk = () => ev("(() => { const r = toastRoot(); return r ? r.querySelector('.toast').classList.contains('dk') : null; })()");
    await load({ hudShown: true }, "&mqdark=1");
    await away();
    await say();
    assert.deepStrictEqual([(await F()).dk, await toastDk()], [false, false], "светлый сайт — кружок и уведомление светлые");
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(1000);
    assert.deepStrictEqual([(await F()).dk, await toastDk()], [true, true], "сайт плавно потемнел вслед за системой — кружок и уведомление тёмные");
    await say();                                             // новое уведомление — чтобы прежнее не ушло по времени
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await sleep(1000);
    assert.deepStrictEqual([(await F()).dk, await toastDk()], [false, false], "сайт плавно посветлел — кружок и уведомление светлые");
    ok("сайт плавно сменил тему вслед за системой (@media, transition фона .2s) — кружок и уведомление вслед за ним, в обе стороны");

    // ---- 11. Поддельные события страницы ничего не делают ----
    await load({ hudShown: true });
    await away();
    f0 = await F();
    const nSets = await ev("__sets.length");                 // при загрузке content сам пишет htBuiltinApi — это не от событий
    await ev(`(() => { const h = fabRoot().host, r = h.getBoundingClientRect(), x = r.left + 22, y = r.top + 22;
      for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) h.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y }));
      h.click();
      h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      for (let i = 1; i <= 5; i++) document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - i * 40, clientY: y - i * 40, buttons: 1 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 200, clientY: y - 200 }));
      h.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      return true; })()`);
    await sleep(500);
    f = await F();
    assert.ok(!f.open && f.fab.l === f0.fab.l && f.fab.t === f0.fab.t && (await ev(`__sets.length`)) === nSets && (await ev("trCalls().length")) === 0,
      "поддельные наведение, щелчок, перетаскивание и Enter по хосту — ничего: " + JSON.stringify({ f, sets: await ev("__sets"), calls: await ev("__calls.map((c) => c.type)") }));
    await clickFab();
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.click(); true");
    await sleep(150);
    assert.ok((await F()).open, "поддельные Esc и щелчок мимо закреплённые кнопки не скрывают");
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    ok("поддельные события страницы (наведение, щелчок, перетаскивание, Enter по хосту; Esc и щелчок мимо) кружок и кнопки не трогают, ничего не пишут");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
