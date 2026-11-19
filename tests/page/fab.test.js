// Плавающая кнопка (кружок + меню): content.js в Chrome без интерфейса, страница по HTTP (у неё есть имя сайта
// 127.0.0.1) с заглушкой chrome.* (fixtures/stub.html). Настоящие события — Input.dispatch* (isTrusted = true).
// Проверяет: вид и место по умолчанию (справа внизу в 16, 44, закрытый root, слой 2147483645, подписи); состояния
// (заливка «переведена», кольцо и «Перевожу… N из M» во время перевода — к середине экрана); наведение 200 мс,
// уход 400 мс, путь кружок → меню, щелчок закрепляет и не переводит, щелчок мимо / повторный / Esc закрывают;
// меню — место действия во всех состояниях (data-page), язык, пункты «Выключить на <сайт>», «Скрыть кнопку»
// (+ «Вернуть»), «Настройки»; куда раскрывается меню и что оно не выходит за окно; перетаскивание (≤ 4 px — щелчок,
// больше — прилипание к краю в 16, hudPos пишется один раз, место переживает перезагрузку, миграция { left, top },
// мусор, узкое и низкое окно); клавиатура (Tab — последним, Enter / пробел, фокус не уходит из меню, ↑↓ Home End,
// Esc); где кружка нет (hudShown, выключенный сайт, enabled = false, iframe); уведомление над кружком и с открытым
// меню; цвета на светлом и тёмном сайте; поддельные события страницы ничего не делают.
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
    // Место действия меню (.fm-act): что в нём сейчас.
    const act = () => ev(`(() => { const r = fabRoot(), m = r.querySelector('.fm'), a = m.querySelector('.fm-act'); const q = (s) => a.querySelector(s);
      const tx = (e) => e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; const seg = q('.fm-seg');
      return { page: m.getAttribute('data-page'), h: Math.round(a.getBoundingClientRect().height), btn: tx(q('.fm-btn')), btn2: tx(q('.fm-btn2')), busy: tx(q('.fm-busy')),
        prog: !!q('.fm-prog'), seg: seg ? [...seg.querySelectorAll('[role=radio]')].map((x) => tx(x) + ':' + x.getAttribute('aria-checked')) : null,
        segRole: seg ? seg.getAttribute('role') : null, hint: tx(q('.fm-hint')), lnk: tx(q('.fm-hint .lnk')),
        labels: [...a.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')) }; })()`);
    // Журнал открытий меню со временем страницы: [мс, открыто]. mark() — начало отсчёта (до события).
    const watch = () => ev(`(() => { const r = fabRoot(); window.__fl = []; let last = fabInfo().open;
      new MutationObserver(() => { const o = fabInfo() && fabInfo().open; if (o !== last) { last = o; __fl.push([performance.now(), o]); } })
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
    const a11y = await ev(`(() => { const r = fabRoot(), b = r.querySelector('.fab'), m = r.querySelector('.fm');
      return { tag: b.tagName, type: b.type, label: b.getAttribute('aria-label'), pop: b.getAttribute('aria-haspopup'), exp: b.getAttribute('aria-expanded'),
        svg: !!b.querySelector('svg'), role: m.getAttribute('role'), mlabel: m.getAttribute('aria-label'), hidden: m.hidden }; })()`);
    assert.deepStrictEqual(a11y, { tag: "BUTTON", type: "button", label: await T("csFabAria", await T("extShortName")), pop: "dialog", exp: "false",
      svg: true, role: "dialog", mlabel: await T("extShortName"), hidden: true });
    assert.deepStrictEqual([f.on, f.ring, f.pill, f.dot, f.open, f.dk], [false, false, null, null, false, false], "ничего не переведено: без заливки, кольца, подписи и точки; меню закрыто");
    assert.deepStrictEqual(await look(), ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(37, 99, 235)"], "светлый сайт: белый, рамка #c9ced5, иконка #2563eb");
    assert.deepStrictEqual(await state(), { ok: true, hud: true, site: "127.0.0.1", siteOff: false, lang: "en", page: "idle", done: 0, total: 0, count: 0, src: "" });
    await t.shot("fab-default.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    ok(`кружок: справа внизу в 16, 44 × 44, хост fixed со слоем 2147483645 и закрытым root; button «${a11y.label}», aria-haspopup=dialog, aria-expanded=false; меню role=dialog скрыто (hidden); белый с рамкой #c9ced5; tabState.hud = true`);

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

    // ---- 3. Наведение 200 мс, уход 400 мс, путь к меню; щелчок закрепляет и не переводит ----
    await load({ hudShown: true });
    await away();
    await watch();
    let c = mid((await F()).fab);
    // пролетел над кружком
    let t0 = await mark();
    await move(c.x, c.y); await sleep(60); await away(); await sleep(700);
    assert.deepStrictEqual(await ev("__fl.length"), 0, "курсор пробыл на кружке 60 мс — меню не открывалось");
    // задержался — открылось через 200 мс
    t0 = await mark();
    await move(c.x, c.y);
    assert.ok(await until(async () => (await F()).open, 1500), "наведение открыло меню");
    const openedAt = await firstAt(t0, true);
    f = await F();
    assert.ok(openedAt >= 190 && openedAt <= 700, "меню — через 200 мс наведения: " + openedAt);
    assert.strictEqual(f.expanded, "true");
    // ушёл — закрылось через 400 мс
    t0 = await mark();
    await away();
    assert.ok(await until(async () => !(await F()).open, 2000), "ушли — меню закрылось");
    const closedAt = await firstAt(t0, false);
    assert.ok(closedAt >= 380 && closedAt <= 1100, "закрылось через 400 мс: " + closedAt);
    assert.strictEqual((await F()).expanded, "false");
    // путь от кружка к меню меню не закрывает
    await move(c.x, c.y);
    await until(async () => (await F()).open, 1500);
    const mc = mid((await F()).menu);
    const steps = Math.ceil(Math.hypot(mc.x - c.x, mc.y - c.y) / 15);
    t0 = await mark();
    for (let i = 1; i <= steps; i++) { await move(Math.round(c.x + (mc.x - c.x) * i / steps), Math.round(c.y + (mc.y - c.y) * i / steps)); await sleep(16); }
    await move(mc.x + 20, mc.y + 10); await sleep(800);
    assert.ok((await F()).open && (await ev("__fl.length")) === 0, "кружок → меню → по меню: открыто, не мигало " + JSON.stringify(await ev("__fl")));
    await away();
    assert.ok(await until(async () => !(await F()).open, 2000), "ушли с меню — закрылось");
    await sleep(200);
    // щелчок: сразу открывает и закрепляет, страницу не переводит
    await ev("window.__calls.length = 0; true");
    t0 = await mark();
    await clickFab();
    assert.ok((await F()).open, "щелчок открыл меню сразу, не дожидаясь 200 мс наведения: " + JSON.stringify(await ev("__fl")));
    await away(); await sleep(900);
    assert.ok((await F()).open, "закреплено: курсор ушёл — меню открыто");
    assert.strictEqual(await ev("trCalls().length"), 0, "щелчок по кружку страницу не переводит");
    assert.strictEqual((await state()).page, "idle");
    await t.shot("menu-pinned.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    await click(EMPTY.x, EMPTY.y); await sleep(120);
    assert.ok(!(await F()).open, "щелчок мимо закрыл");
    // повторный щелчок по кружку закрывает (и курсор, оставшийся на кружке, не открывает снова)
    await clickFab();
    assert.ok((await F()).open);
    await clickFab();
    assert.ok(!(await F()).open, "повторный щелчок закрыл");
    await sleep(600);
    assert.ok(!(await F()).open, "курсор стоит на кружке — меню само не открылось снова");
    // Esc закрывает закреплённое меню и не трогает перевод; Esc без меню — оригинал
    await away();
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await clickFab();
    assert.ok((await F()).open);
    await esc();
    f = await F();
    assert.ok(!f.open && f.focus === "fab" && f.expanded === "false", "Esc закрыл меню, фокус на кружке: " + JSON.stringify(f));
    assert.ok(await tr("#p1"), "Esc закрыл меню — перевод страницы на месте");
    await away(); await sleep(450);
    await esc();
    assert.ok(!(await tr("#p1")), "Esc без меню — оригинал");
    ok(`меню: наведение — через 200 мс (${openedAt}), пролёт 60 мс не открывает; уход — закрытие через 400 мс (${closedAt}); путь кружок → меню не закрывает; щелчок открывает сразу и закрепляет, страницу не переводит; щелчок мимо, повторный щелчок, Esc (фокус на кружок, перевод цел) закрывают; Esc без меню — оригинал`);

    // ---- 4. Меню: место действия во всех состояниях, язык, пункты ----
    await load({ hudShown: true });
    await away();
    await clickFab();
    const struct = await ev(`(() => { const r = fabRoot(), m = r.querySelector('.fm'), s = r.querySelector('.fm-sel select');
      const byIds = (ids) => (ids || '').split(/\\s+/).filter(Boolean).map((id) => (r.getElementById(id) || {}).textContent || '').join(' ').trim();
      return { head: (r.querySelector('.fm-head .fm-name') || {}).textContent, lbl: (r.querySelector('.fm-lbl') || {}).textContent,
        selName: s.getAttribute('aria-label') || byIds(s.getAttribute('aria-labelledby')) || (s.labels && s.labels[0] ? s.labels[0].textContent : ''),
        value: s.value, codes: [...s.options].map((o) => o.value), want: HT_TARGET_LANGS.map((x) => x[0]), w: Math.round(m.getBoundingClientRect().width),
        items: [...r.querySelectorAll('[role=menu] .fm-item[role=menuitem]')].map((x) => x.getAttribute('data-act') + ':' + x.textContent.trim() + ':' + !!x.querySelector('svg')),
        sep: !!r.querySelector('.fm-sep') }; })()`);
    assert.deepStrictEqual([struct.head, struct.lbl, struct.selName, struct.value, struct.w, struct.sep], [await T("extShortName"), await T("targetLangAria"), await T("targetLangAria"), "RU", 320, true]);
    assert.deepStrictEqual(struct.codes, struct.want, "языки — таблица shared.js (HT_TARGET_LANGS)");
    assert.deepStrictEqual(struct.items, [`site-off:${await T("csFabSiteOff", "127.0.0.1")}:true`, `hide:${await T("csFabHide")}:true`, `settings:${await T("ppSettings")}:true`]);
    // idle
    let a = await act();
    assert.deepStrictEqual([a.page, a.h, a.btn, a.hint], ["idle", 64, await T("translatePage"), await T("ppHintKey", "Shift")]);
    await t.shot("menu-idle.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    await ev("setStore({ trigger: 'dwell' }); true"); await sleep(100);
    await esc(); await clickFab();
    assert.strictEqual((await act()).hint, await T("ppHintDwell"), "способ — задержка: подсказка «Задержите курсор на тексте»");
    await ev("setStore({ trigger: 'shift' }); true"); await sleep(100);
    // busy: «Перевести страницу» в меню
    await ev("window.__bgDelay = 600; window.__calls.length = 0; true");
    await clickIn(".fm-act .fm-btn");
    a = await act();
    let s = await state();
    assert.ok(a.page === "busy" && a.h === 64 && a.prog && a.btn2 === await T("ppStop") && a.hint === await T("ppRestLater")
      && a.busy.includes(await T("ppBusy")) && a.busy.includes(await T("ppBusyN", [s.done, s.total])) && a.labels.includes(await T("ppBusyAria")),
      "перевожу: «Перевожу… N из M» с полосой, «Стоп», «Остальное переведётся при прокрутке»: " + JSON.stringify(a));
    assert.ok((await F()).open, "меню открыто, пока идёт перевод");
    await t.shot("menu-busy.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    // «Стоп» после первых пачек — part с числом и «Показать оригинал»
    assert.ok(await until(async () => (await state()).count > 0, 3000), "первые пачки пришли");
    await clickIn(".fm-act .fm-btn2");
    s = await state();
    a = await act();
    assert.ok(s.page === "part" && a.page === "part" && a.h === 64 && a.btn === await T("translatePage")
      && a.hint.startsWith(await ev(`HT_plural('ppPartDone', ${s.count})`)) && a.lnk === await T("ppShowOrig"), "после «Стопа»: " + JSON.stringify({ s, a }));
    await t.shot("menu-part.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    await clickIn(".fm-act .fm-hint .lnk");
    assert.ok(await until(async () => (await state()).page === "idle", 1500) && !(await tr("#p1")), "«Показать оригинал» вернул оригинал");
    // done: сегмент «Оригинал | Перевод»
    await ev("window.__bgDelay = 0; true");
    if (!(await F()).open) await clickFab();
    await clickIn(".fm-act .fm-btn");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await sleep(100);
    a = await act();
    const [orig, trn] = [await T("ppOrig"), await T("ppTr")];
    assert.deepStrictEqual([a.page, a.h, a.segRole, a.seg, a.hint], ["done", 64, "radiogroup", [orig + ":false", trn + ":true"], await T("ppEscHint", "Английский → русский")]);
    await t.shot("menu-done.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    await clickIn(".fm-seg [role=radio][aria-checked=false]");
    assert.ok(await until(async () => (await state()).page === "orig", 1500) && !(await tr("#p1")), "«Оригинал» — оригинал");
    a = await act();
    assert.deepStrictEqual([a.page, a.seg], ["orig", [orig + ":true", trn + ":false"]]);
    await clickIn(".fm-seg [role=radio][aria-checked=false]");
    assert.ok(await until(async () => (await state()).page === "done", 3000) && await tr("#p1"), "«Перевод» — снова перевод");
    assert.ok((await F()).open, "место действия меню не закрывает");
    ok("меню 320: шапка, «Язык перевода» (подпись списка), языки из shared.js, место действия 64 во всех состояниях (data-page): idle — «Перевести страницу» + подсказка клавиши/задержки, busy — «Перевожу… N из M» с полосой и «Стоп», part — «Перевод в N местах · Показать оригинал», done/orig — сегмент «Оригинал | Перевод»; кнопки работают, меню остаётся открытым");
    // пункты: «Настройки»
    await clickIn('[data-act="settings"]');
    assert.deepStrictEqual(await ev("typeCalls('openSettings')"), [{ type: "openSettings", focus: "page" }], "«Настройки» — к разделу «На странице»");
    assert.ok(!(await F()).open, "выбор пункта закрывает меню");
    // «Выключить на 127.0.0.1»: оригинал, кружка нет, уведомление с «Включить снова»
    await clickFab();
    await clickIn('[data-act="site-off"]'); await sleep(250);
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
    await clickIn('[data-act="hide"]'); await sleep(250);
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
    ok("пункты: «Настройки» → openSettings { focus: page }; «Выключить на 127.0.0.1» — оригинал, кружок скрыт, «Перевод на 127.0.0.1 выключен» + «Включить снова» (возвращает); «Скрыть кнопку» — hudShown = false, «Кнопка скрыта» с «Вернуть» (> 6 с на экране), «Вернуть» — hudShown = true; выбор пункта закрывает меню");

    // ---- 5. Куда раскрывается меню ----
    const placeMenu = async (pos, name, w = 1000, h = 800) => {
      await viewport(w, h);
      await load({ hudShown: true, hudPos: pos });
      await move(650, Math.round(h / 2)); await sleep(40);        // пустое место справа от текстов
      await clickFab();
      const x = await F(), vv = await vp();
      await t.shot(`menu-at-${name}.png`, { clip: { x: 0, y: 0, width: w, height: h, scale: 0.5 } });
      return { f: x, v: vv };
    };
    const where = [];
    for (const [pos, name] of [[null, "right-bottom"], [{ side: "right", top: 100 }, "right-top"], [{ side: "left", top: 100 }, "left-top"], [{ side: "left", top: 700 }, "left-bottom"]]) {
      const { f: x, v: vv } = await placeMenu(pos, name);
      const right = name.startsWith("right"), low = name.endsWith("bottom");
      const m = x.menu, fb = x.fab;
      assert.ok(x.open && m, name + ": меню открыто");
      const gap = right ? fb.l - m.r : m.l - fb.r;
      assert.ok(gap >= 0 && gap <= 24, `${name}: меню вбок к середине экрана, рядом с кружком (зазор ${gap}): ` + JSON.stringify({ m, fb }));
      assert.ok(Math.abs(low ? m.b - fb.b : m.t - fb.t) <= 1, `${name}: ${low ? "низ меню = низ кружка" : "верх меню = верх кружка"}: ` + JSON.stringify({ m, fb }));
      assert.ok(inside(m, vv) && !cross(m, fb) && m.w === 320, name + ": в окне, кружок не закрыт: " + JSON.stringify({ m, fb, vv }));
      where.push(`${name}: зазор ${gap}`);
    }
    // не влезает по высоте — сдвиг внутрь окна, кружок не закрыт
    for (const [pos, name] of [[{ side: "right", top: 200 }, "low-window-bottom-half"], [{ side: "left", top: 150 }, "low-window-top-half"]]) {
      const { f: x, v: vv } = await placeMenu(pos, name, 1000, 420);
      assert.ok(x.open && inside(x.menu, vv) && !cross(x.menu, x.fab), name + ": сдвинуто внутрь окна, кружок не закрыт: " + JSON.stringify({ m: x.menu, fb: x.fab, vv }));
      assert.ok(pos.side === "right" ? x.menu.r <= x.fab.l : x.menu.l >= x.fab.r, name + ": по-прежнему сбоку");
    }
    await viewport(1000, 800);
    ok(`меню раскрывается вбок к середине экрана: внизу — по низу кружка, вверху — по верху; справа и слева (${where.join("; ")}); окно 420 по высоте — меню сдвинуто внутрь, кружок не закрыт`);

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
    assert.ok(f.open && f.fab.l === f0.fab.l && f.fab.t === f0.fab.t && (await posSets()).length === 0, "сдвиг 3 px — щелчок: меню открыто, кружок на месте, ничего не записано: " + JSON.stringify(f));
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
    assert.ok(during.drag && !during.open, "тащат: is-drag, меню не открывается (курсор держали на кружке 350 мс): " + JSON.stringify(during));
    assert.ok(Math.abs(mid(during.fab).x - to.x) <= 2 && Math.abs(mid(during.fab).y - to.y) <= 2, "кружок едет за курсором: " + JSON.stringify(during.fab));
    await t.shot("fab-drag.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.5 } });
    f = await F();
    const wantTop = f0.fab.t + (to.y - c.y);
    assert.ok(!f.drag && !f.open && f.fab.l === 16 && Math.abs(f.fab.t - wantTop) <= 1, `отпустили — у левого края в 16, по высоте где отпустили (${wantTop}): ` + JSON.stringify(f.fab));
    let ps = await posSets();
    assert.ok(ps.length === 1 && ps[0].side === "left" && Math.abs(ps[0].top - wantTop) <= 1 && Object.keys(ps[0]).sort().join() === "side,top", "hudPos записан один раз, { side, top }: " + JSON.stringify(ps));
    assert.strictEqual(await ev("trCalls().length"), 0, "перетаскивание ничего не перевело");
    await sleep(400);
    assert.ok(!(await F()).open, "после перетаскивания меню не открылось");
    await t.shot("fab-dropped-left.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.5 } });
    // «другая страница»: место то же
    const saved = ps[0];
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
    ok(`перетаскивание: сдвиг 3 px — щелчок; дальше 4 px — тащат (is-drag, меню не открывается), отпустили — у ближайшего края в 16 по высоте отпускания (не ближе 16 к верху и низу); hudPos { side, top } пишется один раз; после перезагрузки место то же (${JSON.stringify(saved)})`);
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
    await sleep(250);
    const ringFocus = await ev("(() => { const g = getComputedStyle(fabRoot().querySelector('.fab')); return [g.borderTopColor, g.boxShadow]; })()");
    assert.ok(ringFocus[0] === "rgb(37, 99, 235)" && /rgba\(37, 99, 235, 0\.35\) 0px 0px 0px 3px/.test(ringFocus[1]), "фокус — рамка акцентом и ореол 3 px: " + JSON.stringify(ringFocus));
    await t.shot("fab-focus.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    await tab(true);
    assert.strictEqual(await ev("document.activeElement.id"), "inp", "Shift+Tab — обратно на страницу: кружок последний в обходе");
    await tab();
    await ev("window.__calls.length = 0; true");
    await enter();
    f = await F();
    assert.ok(f.open && f.expanded === "true" && f.focus === "select", "Enter — меню, фокус на списке языка: " + JSON.stringify(f));
    assert.strictEqual(await ev("trCalls().length"), 0, "Enter не переводит страницу");
    // Tab и Shift+Tab — по кругу внутри меню
    const seq = [];
    for (let i = 0; i < 8; i++) {
      await tab();
      const x = await F();
      seq.push(x.focus);
      assert.ok(x.open && x.focus && await ev("document.activeElement === fabRoot().host"), "Tab: фокус остался в меню: " + JSON.stringify(seq));
    }
    const ITEMS = ["site-off", "hide", "settings"];
    assert.ok(seq.includes("select") && seq.some((x) => /fm-btn/.test(x)) && seq.some((x) => ITEMS.includes(x)), "Tab обходит язык → действие → пункты и возвращается на язык: " + JSON.stringify(seq));
    for (let i = 0; i < 8 && (await F()).focus !== "select"; i++) await tab();
    assert.strictEqual((await F()).focus, "select");
    await tab(true);
    f = await F();
    assert.ok(f.open && ITEMS.includes(f.focus), "Shift+Tab с языка — на последний пункт, не на страницу: " + JSON.stringify(f));
    // ↑↓ Home End — по пунктам
    const keyTo = async (k2, code, vk) => { await press(k2, code, vk); return (await F()).focus; };
    const nav = [await keyTo("Home", "Home", 36), await keyTo("ArrowDown", "ArrowDown", 40), await keyTo("ArrowDown", "ArrowDown", 40),
      await keyTo("ArrowUp", "ArrowUp", 38), await keyTo("End", "End", 35), await keyTo("Home", "Home", 36)];
    assert.deepStrictEqual(nav, ["site-off", "hide", "settings", "hide", "settings", "site-off"], "Home ↓ ↓ ↑ End Home");
    assert.ok((await F()).open && (await ev("trCalls().length")) === 0);
    await press("ArrowDown", "ArrowDown", 40);
    await t.shot("menu-keys.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    // Esc — закрыть, фокус на кружок
    await esc();
    f = await F();
    assert.ok(!f.open && f.focus === "fab" && f.expanded === "false", "Esc — меню закрыто, фокус на кружке: " + JSON.stringify(f));
    // пробел — тоже меню; язык с клавиатуры — запись targetLang
    await space();
    f = await F();
    assert.ok(f.open && f.focus === "select", "пробел — меню, фокус на списке: " + JSON.stringify(f));
    await ev("window.__sets.length = 0; true");
    const selNow = () => ev("(() => { const s = fabRoot().querySelector('.fm-sel select'); let open = false; try { open = s.matches(':open'); } catch (e) {} return { v: s.value, open }; })()");
    await press("ArrowDown", "ArrowDown", 40);
    let sv = await selNow();
    const picker = sv.open;                          // настраиваемый список (appearance: base-select) раскрывается по ↓
    if (picker) { await press("ArrowDown", "ArrowDown", 40); await enter(); }
    sv = await selNow();
    const langSets = await ev("__sets.filter((x) => 'targetLang' in x).map((x) => x.targetLang)");
    assert.ok(sv.v !== "RU" && !sv.open && langSets.length === 1 && langSets[0] === sv.v && await ev(`HT_valid('targetLang', ${JSON.stringify(sv.v)}) === ${JSON.stringify(sv.v)}`),
      "язык в списке меню: записан targetLang = выбранный: " + JSON.stringify({ sv, langSets }));
    assert.strictEqual(await ev("__store.targetLang"), sv.v);
    if ((await F()).open) await esc();
    assert.ok(!(await F()).open, "меню закрыто");
    await ev("fabRoot().querySelector('.fab').focus(); true");
    // Esc без меню (фокус на кружке) — оригинал страницы
    await ev(`setStore({ targetLang: 'RU' }); sendCmd({ type: 'translatePage', via: 'popup' }); true`);
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await esc();
    assert.ok(await until(async () => (await state()).page === "orig", 1500) && !(await tr("#p1")), "Esc без меню — оригинал");
    ok(`клавиатура: Tab с последнего поля — на кружок (фокус: рамка и ореол 3 px), Shift+Tab — обратно; Enter и пробел — меню с фокусом на языке, страницу не переводят; Tab/Shift+Tab по кругу внутри меню (${seq.join(" → ")}); Home ↓ ↑ End по пунктам; Esc — закрыть и фокус на кружок; язык с клавиатуры (${picker ? "раскрывающийся список" : "стрелкой"}) пишет targetLang = ${sv.v}; Esc без меню — оригинал`);

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
    // открыли меню, пока уведомление внизу: меню им не закрыто
    await clickFab();
    f = await F();
    tb = await toastBox();
    assert.ok(f.open && tb && !cross(tb, f.menu) && !cross(tb, f.fab) && inside(tb, v), "открытое меню уведомление не закрывает: " + JSON.stringify({ tb, menu: f.menu, fab: f.fab }));
    await t.shot("toast-and-menu.png");
    // кружок слева — уведомление внизу справа в 16
    await load({ hudShown: true, hudPos: { side: "left", top: 540 } });
    await move(pr.l + 560, Math.round((pr.t + pr.b) / 2)); await sleep(40);
    await say();
    tb = await toastBox();
    f = await F();
    assert.ok(tb && !cross(tb, f.fab) && !cross(tb, pr) && v.h - tb.b === 16 && v.w - tb.r === 16, "кружок слева — уведомление внизу справа в 16: " + JSON.stringify({ tb, fab: f.fab }));
    await t.shot("toast-fab-left.png");
    await viewport(1000, 800);
    ok("уведомление внизу (закрыло бы текст) — над кружком: низ на 12 выше кружка, bottom 72; открытое меню и кружок не закрывает; кружок слева — внизу справа в 16");

    // ---- 10. Цвета: тёмная тема системы на светлом сайте, тёмный сайт ----
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await load({ hudShown: true });
    await away();
    assert.deepStrictEqual([(await F()).dk, ...(await look())], [false, "rgb(255, 255, 255)", "rgb(201, 206, 213)", "rgb(37, 99, 235)"], "светлый сайт при тёмной теме системы — светлый кружок");
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await load({ hudShown: true }, "&dark=1");
    await away();
    f = await F();
    assert.deepStrictEqual([f.dk, ...(await look())], [true, "rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(143, 176, 255)"], "тёмный сайт — #2a2d33, рамка .4, иконка #8fb0ff");
    await t.shot("fab-dark.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    await clickFab();
    const menuDark = await ev("(() => { const m = fabRoot().querySelector('.fm'), g = getComputedStyle(m); return [m.classList.contains('dk'), g.backgroundColor, g.borderTopColor]; })()");
    assert.deepStrictEqual(menuDark, [true, "rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)"], "меню на тёмном сайте — тёмное");
    await t.shot("menu-dark.png", { clip: { x: 500, y: 380, width: 500, height: 420, scale: 1 } });
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await away(); await sleep(250);
    assert.deepStrictEqual((await look()).slice(0, 1).concat((await F()).on), ["rgb(143, 176, 255)", true], "переведена на тёмном — заливка #8fb0ff");
    await t.shot("fab-dark-on.png", { clip: { x: 600, y: 600, width: 400, height: 200, scale: 1 } });
    ok("цвета по фону сайта: светлый — белый с рамкой #c9ced5 (и при тёмной теме системы), тёмный — #2a2d33, рамка rgba(255,255,255,.4), иконка #8fb0ff, меню тёмное, «переведена» — #8fb0ff");

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
    assert.ok((await F()).open, "поддельные Esc и щелчок мимо закреплённое меню не закрывают");
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    ok("поддельные события страницы (наведение, щелчок, перетаскивание, Enter по хосту; Esc и щелчок мимо) кружок и меню не трогают, ничего не пишут");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
