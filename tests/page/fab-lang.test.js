// Панель языка у кнопок кружка (щелчок по «RU»): content.js в Chrome без интерфейса, страница по HTTP с заглушкой
// chrome.* (fixtures/stub.html). Настоящие события — Input.dispatch* и Input.insertText (isTrusted = true).
// Проверяет: щелчок по «RU» — панель (кнопка «нажата», aria-expanded), фокус в поле — только с клавиатуры; без
// набора — «Недавние»: текущий (галочка) и до 4 недавних из recentLangs, без недавних — языки браузера и английский;
// самоназвание и серым название на языке интерфейса (если отличается); поиск по началу слова самоназвания, названия
// по-русски и кода (без регистра и диакритики), совпавшее — <mark>; нет совпадений — «Ничего не нашлось» (не
// кнопка); поле не прыгает при наборе; ↑ ↓ Enter — запись targetLang и recentLangs как в окне расширения, панель
// закрыта, на кнопке новый код, фокус на «RU»; щелчок по строке — то же; Esc — панель, второй Esc — столбик; Tab —
// к «⋯», Shift+Tab — к «RU»; Shift в поле (курсор над абзацем) — набор, абзац не переводится; щелчок мимо —
// закрыть; поддельные события ничего не пишут; панель не выходит за окно и не закрывает капсулу с кнопками
// (справа внизу, слева вверху, окно 360), стоит в 8 от капсулы. Скриншоты в обеих темах — с tests/run.sh --shots.
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
const mid = (q) => ({ x: Math.round(q.l + q.w / 2), y: Math.round(q.t + q.h / 2) });
const cross = (a, c) => a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;

// Что сейчас на кружке и в панели языка (закрытый root перехвачен заглушкой: fabRoot()). Ставится на страницу после
// каждой загрузки. rows: code, nm, cd (текст), mk — выделенное («nm:Po», «cd:по»), sel, focus (.is-focus), tag.
const HELPERS = `window.langInfo = () => {
  const r = fabRoot();
  if (!r) return null;
  const pop = r.querySelector("#fk-lang"), fk = r.querySelector("#fk"), btn = r.querySelector(".fk-btn[data-k=lang]"), q = pop.querySelector("input");
  const shown = (e) => !!e && !e.closest("[hidden]") && e.getClientRects().length > 0;
  const box = (e) => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
  const btns = [...fk.querySelectorAll(".fk-btn")].filter(shown).map(box), cap = shown(fk) ? box(fk) : null;
  const a = r.activeElement;
  const none = pop.querySelector(".fk-none");
  return {
    bar: shown(fk), open: shown(pop), code: btn.textContent.trim(), exp: btn.getAttribute("aria-expanded"), pressed: btn.classList.contains("is-open"),
    gl: shown(pop) ? pop.querySelector(".fk-gl").textContent : null,
    rows: [...pop.querySelectorAll(".fk-opt")].map((o) => ({ code: o.getAttribute("data-code"), nm: o.querySelector(".nm").textContent,
      cd: o.querySelector(".cd") ? o.querySelector(".cd").textContent : null,
      mk: [...o.querySelectorAll("mark")].map((m) => m.parentElement.className + ":" + m.textContent).join(" "),
      sel: o.classList.contains("sel") && !!o.querySelector("svg.ck"), focus: o.classList.contains("is-focus"), tag: o.tagName, role: o.getAttribute("role"),
      id: o.id, shown: shown(o) })),
    none: shown(none) ? none.textContent : null, noneTag: none ? none.tagName : null,
    ad: q.getAttribute("aria-activedescendant"), qv: q.value,
    focus: !a ? null : a === btn ? "lang" : a === q ? "q" : a.classList.contains("fab") ? "fab" : a.getAttribute("data-k") || a.className,
    fab: box(r.querySelector(".fab")), pop: shown(pop) ? box(pop) : null, find: shown(pop) ? box(pop.querySelector(".fk-find")) : null,
    list: shown(pop) ? (() => { const l = pop.querySelector(".fk-list"); return { h: l.clientHeight, sh: l.scrollHeight, st: l.scrollTop }; })() : null,
    btns, cap, down: fk.classList.contains("down"), dk: pop.classList.contains("dk"),
  };
}; true`;

(async () => {
  const srv = await serve();
  const BASE = srv.base + "/stub.html";
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
      await ev(HELPERS);
    };
    const L = () => ev("langInfo()");
    const vp = () => ev("({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })");
    const T = (k, subs) => ev(`HT_t(${JSON.stringify(k)}${subs != null ? ", " + JSON.stringify([].concat(subs).map(String)) : ""})`);
    const nameOf = (code) => ev(`HT_lang(${JSON.stringify(code)}).name`);
    const labelOf = (code) => ev(`HT_langLabel(${JSON.stringify(code)})`);
    const move = (x, y) => t.mouse("mouseMoved", x, y);
    const down = (x, y) => t.mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
    const up = (x, y) => t.mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
    const click = async (x, y) => { await move(x, y); await down(x, y); await up(x, y); };
    const EMPTY = { x: 850, y: 300 };
    const point = (sel) => ev(`uiPoint(fabRoot(), ${JSON.stringify(sel)})`);
    const clickIn = async (sel) => { const p = await point(sel); assert.ok(p, "нет " + sel); await click(p.x, p.y); await sleep(120); };
    const key = (type, k, code, vk, extra = {}) => t.cmd("Input.dispatchKeyEvent", Object.assign({ type, key: k, code, windowsVirtualKeyCode: vk, modifiers: 0 }, extra));
    const press = async (k, code, vk, modifiers = 0) => { await key("rawKeyDown", k, code, vk, { modifiers }); await key("keyUp", k, code, vk, { modifiers }); await sleep(80); };
    const enter = async () => { await key("keyDown", "Enter", "Enter", 13, { text: "\r", unmodifiedText: "\r" }); await key("keyUp", "Enter", "Enter", 13); await sleep(120); };
    const tab = (back) => press("Tab", "Tab", 9, back ? SHIFT : 0);
    const esc = () => press("Escape", "Escape", 27);
    const arrow = (d) => press(d === "down" ? "ArrowDown" : "ArrowUp", d === "down" ? "ArrowDown" : "ArrowUp", d === "down" ? 40 : 38);
    const type = async (s) => { await t.cmd("Input.insertText", { text: s }); await sleep(120); };
    // Стереть поле: Ctrl+A и Backspace — настоящими клавишами.
    const clear = async () => {
      await key("rawKeyDown", "a", "KeyA", 65, { modifiers: 2, commands: ["selectAll"] }); await key("keyUp", "a", "KeyA", 65, { modifiers: 2 });
      await press("Backspace", "Backspace", 8); await sleep(60);
    };
    const langSets = () => ev("__sets.filter((s) => 'targetLang' in s || 'recentLangs' in s)");
    // Открыть панель мышью: навести на кружок (кнопки — сразу), щёлкнуть «RU».
    const openByMouse = async () => {
      const f = await L();
      await move(mid(f.fab).x, mid(f.fab).y); await sleep(150);
      assert.ok((await L()).bar, "наведение на кружок — кнопки");
      await clickIn(".fk-btn[data-k=lang]");
      return L();
    };
    // Клавиатурой: с поля страницы Tab — на кружок, Tab, Tab — «RU», Enter.
    const openByKeys = async () => {
      await ev("document.querySelector('#inp').focus(); true");
      await tab(); await tab(); await tab();
      assert.strictEqual((await L()).focus, "lang", "Tab, Tab, Tab с последнего поля — кружок, главная, «RU»");
      await enter();
      return L();
    };
    // Панель на месте: в окне (поле 8), не закрывает кружок и капсулу с кнопками; в 8 от капсулы — к середине экрана.
    const placed = async (what) => {
      const x = await L(), v = await vp();
      assert.ok(x.open && x.pop, what + ": панель открыта");
      assert.ok(x.pop.l >= 8 && x.pop.t >= 8 && x.pop.r <= v.w - 8 && x.pop.b <= v.h - 8, what + ": панель в окне с полем 8: " + JSON.stringify({ pop: x.pop, v }));
      assert.ok(x.cap && !cross(x.pop, x.fab) && !cross(x.pop, x.cap) && !x.btns.some((q) => cross(x.pop, q)), what + ": не закрывает кружок и капсулу: " + JSON.stringify(x));
      assert.ok(x.pop.r === x.cap.l - 8 || x.pop.l === x.cap.r + 8, what + ": в 8 от капсулы: " + JSON.stringify({ pop: x.pop, cap: x.cap }));
      return x;
    };
    const names = async (codes) => { const o = []; for (const c of codes) o.push(await nameOf(c)); return o; };

    // ---- 1. Щелчок по «RU»: панель, недавние ----
    const RECENT = ["RU", "DE", "ES", "UK", "FR", "IT"];
    await load({ hudShown: true, recentLangs: RECENT });
    let x = await openByMouse();
    assert.ok(x.open && x.exp === "true" && x.pressed && x.bar, "щелчок по «RU» — панель; кнопка «нажата», aria-expanded: " + JSON.stringify(x));
    assert.notStrictEqual(x.focus, "q", "мышью фокус в поле не уходит (как на макете)");
    assert.strictEqual(x.gl, await T("csFkRecent"));
    assert.deepStrictEqual(x.rows.map((r) => r.code), ["RU", "DE", "ES", "UK", "FR"], "текущий и 4 недавних (без текущего), по порядку recentLangs");
    assert.deepStrictEqual(x.rows.map((r) => r.nm), await names(["RU", "DE", "ES", "UK", "FR"]), "строка — самоназвание");
    assert.deepStrictEqual(x.rows.map((r) => r.cd), [null, await labelOf("DE"), await labelOf("ES"), await labelOf("UK"), await labelOf("FR")],
      "справа — название на языке интерфейса; у «Русский» его нет (совпадает без учёта регистра)");
    assert.deepStrictEqual(x.rows.map((r) => r.sel), [true, false, false, false, false], "текущий — .sel с галочкой");
    assert.ok(x.rows.every((r) => r.tag === "BUTTON" && r.role === "option" && r.shown), "строки — кнопки role=option");
    assert.ok(x.rows.every((r) => !r.focus) && !x.ad, "без набора строки под фокусом нет");
    assert.ok(!x.down && x.pop.b === x.fab.b && x.pop.r === x.cap.l - 8 && x.pop.w === 240,
      "кружок справа внизу: панель 240 вровень с низом кружка, в 8 от капсулы: " + JSON.stringify({ pop: x.pop, fab: x.fab, cap: x.cap }));
    await placed("справа внизу");
    await t.shot("lang-light.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    ok(`щелчок по «RU» — панель (кнопка «нажата», aria-expanded=true), фокус мышью не в поле; «${x.gl}»: ${x.rows.map((r) => r.nm + (r.cd ? " · " + r.cd : "") + (r.sel ? " ✓" : "")).join(", ")}; вровень с низом кружка, 240, в окне`);

    // ---- 2. Поиск ----
    const findTop = x.find.t;
    await clickIn(".fk-find input");
    assert.strictEqual((await L()).focus, "q", "щелчок по полю — фокус в поле");
    await type("по");
    x = await L();
    assert.strictEqual(x.gl, await T("csFkAll"));
    assert.deepStrictEqual(x.rows.map((r) => r.code), ["PL", "PT-BR", "PT-PT"], "«по» — польский и португальские: " + JSON.stringify(x.rows));
    assert.deepStrictEqual(x.rows.map((r) => r.mk), ["cd:по", "cd:по", "cd:по"], "совпавшее — <mark> в названии по-русски");
    assert.ok(x.rows[0].focus && x.ad === x.rows[0].id && x.rows.filter((r) => r.focus).length === 1, "первая строка — под фокусом (aria-activedescendant)");
    assert.strictEqual(x.find.t, findTop, "поле при наборе не прыгает: список сократился — верх панели на месте");
    await placed("поиск «по»");
    await t.shot("lang-find-light.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    const found = async (q) => { await clear(); await type(q); return L(); };
    x = await found("ZH");
    assert.deepStrictEqual(x.rows.map((r) => r.code), ["ZH", "ZH-HANT"], "по коду: «ZH» — ZH, ZH-HANT: " + JSON.stringify(x.rows.map((r) => r.code)));
    x = await found("pt-b");
    assert.deepStrictEqual(x.rows.map((r) => r.code), ["PT-BR"], "по коду с дефисом: «pt-b» — PT-BR");
    x = await found("немец");
    assert.ok(x.rows.length && x.rows[0].code === "DE" && x.rows[0].mk === "cd:немец", "по названию на языке интерфейса: «немец» — Deutsch: " + JSON.stringify(x.rows));
    x = await found("POL");
    assert.ok(x.rows.length && x.rows[0].code === "PL" && x.rows[0].mk === "nm:Pol", "по самоназванию без учёта регистра: «POL» — Polski: " + JSON.stringify(x.rows));
    x = await found("portugues");
    assert.deepStrictEqual(x.rows.map((r) => r.code + " " + r.mk), ["PT-BR nm:Português", "PT-PT nm:Português"], "без диакритики: «portugues» — Português");
    x = await found("brasil");
    assert.ok(x.rows.some((r) => r.code === "PT-BR" && r.mk === "nm:Brasil"), "начало любого слова: «brasil» — Português (Brasil): " + JSON.stringify(x.rows));
    x = await found("rtugal");
    assert.ok(!x.rows.some((r) => /^PT/.test(r.code)), "середина слова — не совпадение");
    x = await found("а");
    assert.ok(x.rows.length > 6 && x.list.h === 216 && x.list.sh > x.list.h, "много совпадений — видно 6 строк, дальше прокрутка: " + JSON.stringify(x.list));
    await placed("много совпадений");
    for (let i = 0; i < 7; i++) await arrow("down");
    x = await L();
    const fi = x.rows.findIndex((r) => r.focus);
    assert.ok(fi === 7 && x.list.st > 0, "↓ за край — список прокручивается к строке под фокусом: " + JSON.stringify({ fi, list: x.list }));
    x = await found("qqq");
    assert.ok(!x.rows.length && x.none === await T("csFkNone") && x.noneTag === "P" && !x.ad, "нет совпадений — строка «Ничего не нашлось» (не кнопка): " + JSON.stringify(x));
    assert.strictEqual(x.gl, await T("csFkAll"));
    await placed("нет совпадений");
    await t.shot("lang-none-light.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    await clear();
    x = await L();
    assert.deepStrictEqual([x.gl, x.rows.map((r) => r.code)], [await T("csFkRecent"), ["RU", "DE", "ES", "UK", "FR"]], "поле стёрли — снова недавние");
    ok("поиск: «по» — Polski, Português ×2 (<mark> в «польский», «португальский»), первая строка под фокусом; по коду (ZH, pt-b), по-русски (немец), без регистра и диакритики (POL, portugues), начало любого слова (brasil), не середина; 6 строк и прокрутка; «Ничего не нашлось» — не кнопка; поле не прыгает");

    // ---- 3. Щелчок по строке — запись, как в окне ----
    await ev("window.__sets.length = 0; true");
    await clickIn('.fk-opt[data-code="ES"]');
    x = await L();
    let sets = await langSets();
    assert.deepStrictEqual(sets, [{ targetLang: "ES", recentLangs: ["ES", "RU", "DE", "UK", "FR", "IT"] }], "щелчок по строке — targetLang и recentLangs [новый, прежний, …] до 6: " + JSON.stringify(sets));
    assert.ok(!x.open && x.code === "ES" && x.focus === "lang" && x.exp === "false" && !x.pressed && x.bar, "панель закрыта, на кнопке «ES», фокус на «RU», кнопки на месте: " + JSON.stringify(x));
    await clickIn(".fk-btn[data-k=lang]");
    x = await L();
    assert.deepStrictEqual(x.rows.map((r) => r.code + (r.sel ? "✓" : "")), ["ES✓", "RU", "DE", "UK", "FR"], "снова открыли — выбранный первым с галочкой, прежний — следом");
    await ev("window.__sets.length = 0; true");
    await clickIn('.fk-opt[data-code="ES"]');
    assert.ok(!(await L()).open && (await langSets()).length === 0, "выбрали текущий — панель закрыта, ничего не пишется");
    ok("щелчок по строке: targetLang = ES, recentLangs = [ES, RU, DE, UK, FR, IT]; панель закрыта, на кнопке «ES», фокус на «RU»; текущий язык — без записи");

    // ---- 3б. Переведённая страница — заново на выбранном языке; клавиши поля сайту не достаются ----
    await load({ hudShown: true, recentLangs: RECENT });
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await ev("sendCmd('getHudState')")).page === "done", 4000), "страница переведена");
    assert.ok(await ev("/^\\[RU\\]/.test(document.querySelector('#p1').textContent)"));
    await ev("window.__calls.length = 0; true");
    await openByMouse();
    await clickIn('.fk-opt[data-code="DE"]');
    assert.ok(await until(() => ev("trCalls().some((c) => c.targetLang === 'DE') && /^\\[DE\\]/.test(document.querySelector('#p1').textContent)"), 4000),
      "переведённая страница — заново на немецком: " + JSON.stringify(await ev("trCalls().map((c) => c.targetLang)")));
    await ev("window.__keys = []; for (const k of ['keydown', 'keypress', 'keyup']) window.addEventListener(k, (e) => __keys.push(e.type + ':' + e.key)); true");
    await openByMouse();
    await clickIn(".fk-find input");
    await key("keyDown", "j", "KeyJ", 74, { text: "j", unmodifiedText: "j" }); await key("keyUp", "j", "KeyJ", 74); await sleep(120);
    x = await L();
    assert.ok(x.qv === "j" && x.open && (await ev("__keys.length")) === 0, "клавиша в поле — в поле, обработчики сайта её не слышат: " + JSON.stringify({ qv: x.qv, keys: await ev("__keys") }));
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    ok("переведённая страница при выборе языка переводится заново (DE); буквы в поле не доходят до сочетаний клавиш сайта");

    // ---- 4. Клавиатура ----
    await load({ hudShown: true, recentLangs: RECENT });
    await move(EMPTY.x, EMPTY.y);
    x = await openByKeys();
    assert.ok(x.open && x.focus === "q" && x.ad == null, "Enter на «RU» — панель, фокус в поле: " + JSON.stringify(x));
    await t.shot("lang-keys-light.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    await arrow("down");
    x = await L();
    assert.ok(x.rows[0].focus && x.ad === x.rows[0].id, "↓ — первая строка");
    await arrow("down"); await arrow("down"); await arrow("up");
    x = await L();
    assert.ok(x.rows[1].focus && x.rows[1].code === "DE" && x.focus === "q", "↓ ↓ ↑ — вторая (DE), фокус остаётся в поле");
    await ev("window.__sets.length = 0; true");
    await enter();
    x = await L();
    sets = await langSets();
    assert.deepStrictEqual(sets, [{ targetLang: "DE", recentLangs: ["DE", "RU", "ES", "UK", "FR", "IT"] }], "Enter — запись: " + JSON.stringify(sets));
    assert.ok(!x.open && x.code === "DE" && x.focus === "lang" && x.bar, "Enter — панель закрыта, на кнопке «DE», фокус на «RU»: " + JSON.stringify(x));
    await enter();
    assert.strictEqual((await L()).focus, "q", "Enter на «RU» ещё раз — снова панель и фокус в поле");
    await type("по");
    await arrow("down");
    await enter();
    x = await L();
    assert.ok(!x.open && x.code === "PT" && (await ev("__store.targetLang")) === "PT-BR" &&
      JSON.stringify(await ev("__store.recentLangs")) === JSON.stringify(["PT-BR", "DE", "RU", "ES", "UK", "FR"]), "набрали «по», ↓, Enter — PT-BR, на кнопке «PT»: " + JSON.stringify(x));
    // Esc — панель, второй Esc — столбик
    await enter();
    assert.ok((await L()).open);
    await esc();
    x = await L();
    assert.ok(!x.open && x.bar && x.focus === "lang", "Esc — панель закрыта, кнопки на месте, фокус на «RU»: " + JSON.stringify(x));
    await esc();
    x = await L();
    assert.ok(!x.open && !x.bar && x.focus === "fab", "второй Esc — кнопки скрыты, фокус на кружке: " + JSON.stringify(x));
    // Tab — к «⋯», Shift+Tab — к «RU» (Enter на кружке — кнопки и фокус на главной, Tab — «RU»)
    await enter(); await tab();
    assert.strictEqual((await L()).focus, "lang");
    await enter();
    await tab();
    x = await L();
    assert.ok(!x.open && x.focus === "more" && x.bar, "Tab из поля — панель закрыта, фокус на «⋯»: " + JSON.stringify(x));
    await tab(true);
    await enter();
    assert.strictEqual((await L()).focus, "q");
    await tab(true);
    x = await L();
    assert.ok(!x.open && x.focus === "lang" && x.bar, "Shift+Tab из поля — панель закрыта, фокус на «RU»: " + JSON.stringify(x));
    assert.strictEqual(await ev("trCalls().length"), 0, "клавиши в панели страницу не переводят");
    ok("клавиатура: Enter на «RU» — фокус в поле; ↓ ↓ ↓ ↑ — по строкам (aria-activedescendant); Enter — DE записан, «DE» на кнопке, фокус на «RU»; «по» ↓ Enter — PT-BR («PT»); Esc — панель (фокус на «RU»), второй Esc — кнопки (фокус на кружке); Tab — к «⋯», Shift+Tab — к «RU»");

    // ---- 4б. Shift в поле поиска — набор текста, а не перевод абзаца под курсором ----
    // Root кружка закрытый: снаружи фокус в поле виден как фокус на хосте — typingFocus() должна заглянуть внутрь.
    await load({ hudShown: true, recentLangs: RECENT });
    await openByMouse();
    await clickIn(".fk-find input");
    assert.strictEqual((await L()).focus, "q", "щелчок по полю — фокус в поле");
    const p1 = await ev("(() => { const r = document.querySelector('#p1').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()");
    const p1Text = await ev("document.querySelector('#p1').textContent");
    await move(p1.x, p1.y); await sleep(150);
    await ev("window.__calls.length = 0; true");
    const shiftDown = () => key("rawKeyDown", "Shift", "ShiftLeft", 16, { modifiers: SHIFT });
    const shiftUp = () => key("keyUp", "Shift", "ShiftLeft", 16);
    await shiftDown(); await sleep(30); await shiftUp(); await sleep(600);
    x = await L();
    const still = async () => ({ same: (await ev("document.querySelector('#p1').textContent")) === p1Text,
      page: (await ev("sendCmd('getHudState')")).page, calls: await ev("trCalls().length") });
    let st = await still();
    assert.ok(x.open && x.focus === "q", "Shift в поле — панель открыта, фокус в поле: " + JSON.stringify(x));
    assert.deepStrictEqual(st, { same: true, page: "idle", calls: 0 }, "Shift в поле поиска, курсор над абзацем — абзац не переводится");
    await shiftDown();
    await key("keyDown", "D", "KeyD", 68, { modifiers: SHIFT, text: "D", unmodifiedText: "d" }); await key("keyUp", "D", "KeyD", 68, { modifiers: SHIFT });
    await shiftUp(); await sleep(600);
    x = await L();
    st = await still();
    assert.ok(x.qv === "D" && x.open && x.focus === "q", "Shift+D в поле — в поле «D»: " + JSON.stringify({ qv: x.qv, open: x.open, focus: x.focus }));
    assert.deepStrictEqual(st, { same: true, page: "idle", calls: 0 }, "Shift+D в поле — абзац не переводится");
    // Контроль: панель закрыли (фокус ушёл с поля на «RU») — тот же Shift над тем же абзацем переводит.
    await esc();
    x = await L();
    assert.ok(!x.open && x.focus === "lang", "Esc — панель закрыта, фокус на «RU»: " + JSON.stringify(x));
    await shiftDown(); await sleep(30); await shiftUp();
    assert.ok(await until(() => ev("/^\\[RU\\]/.test(document.querySelector('#p1').textContent)"), 3000), "фокус не в поле — Shift над абзацем переводит его");
    assert.strictEqual((await ev("sendCmd('getHudState')")).page, "part");
    ok("Shift в поле поиска языка (курсор над абзацем) — абзац не переводится, Shift+D — «D» в поле; панель закрыли (Esc) — тот же Shift переводит");

    // ---- 5. Без недавних — языки браузера и английский ----
    const ua = await ev("navigator.userAgent");
    const noRecent = async (accept) => {
      await t.cmd("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: accept });
      await load({ hudShown: true });
      const langs = await ev("navigator.languages.join()");
      const y = await openByMouse();
      await click(EMPTY.x, EMPTY.y); await sleep(100);
      return { langs, codes: y.rows.map((r) => r.code), sel: y.rows.map((r) => r.sel), gl: y.gl };
    };
    let nr = await noRecent("de-DE,fr,ru");
    assert.deepStrictEqual(nr.codes, ["RU", "DE", "FR", "EN-US"], "без недавних: текущий, языки браузера (de-DE → DE, fr → FR, ru — текущий) и английский: " + JSON.stringify(nr));
    assert.deepStrictEqual(nr.sel, [true, false, false, false]);
    nr = await noRecent("en-GB,pt-BR");
    assert.deepStrictEqual(nr.codes, ["RU", "EN-GB", "PT-BR"], "английский браузера (en-GB) — второго английского нет: " + JSON.stringify(nr));
    await t.cmd("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "ru-RU,ru" });
    await load({ hudShown: true, recentLangs: ["RU", "XX", 5, "EN"] });
    x = await openByMouse();
    assert.deepStrictEqual(x.rows.map((r) => r.code), ["RU", "EN-US"], "в recentLangs только текущий и мусор (XX, 5, EN — не язык перевода) — как без недавних: " + JSON.stringify(x.rows));
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    ok(`без недавних: языки браузера по таблице и английский (${nr.langs} → ${nr.codes.join(", ")}); мусор в recentLangs не показывается`);

    // ---- 6. Щелчок мимо и поддельные события ----
    await load({ hudShown: true, recentLangs: RECENT });
    x = await openByMouse();
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    x = await L();
    assert.ok(!x.open && !x.bar, "щелчок мимо — панель и кнопки закрыты");
    x = await openByMouse();
    await clickIn(".fk-find input");
    await type("de");
    await ev("window.__sets.length = 0; true");
    await ev(`(() => { const r = fabRoot(), q = r.querySelector('#fk-lang input');
      r.querySelector('.fk-opt[data-code="DE"]').click();
      for (const k of ["ArrowDown", "Enter"]) q.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));
      r.querySelector('.fk-btn[data-k=lang]').click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      return true; })()`);
    await sleep(200);
    x = await L();
    assert.ok(x.open && x.rows[0].focus && (await langSets()).length === 0 && (await ev("__store.targetLang")) === "RU",
      "поддельные щелчок по строке, ↓ и Enter в поле, щелчок по «RU», Esc и щелчок мимо — ничего не пишут и панель не трогают: " + JSON.stringify({ x, sets: await langSets() }));
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    ok("щелчок мимо — закрыть; поддельные события (щелчок по строке, ↓/Enter в поле, «RU», Esc, щелчок мимо) ничего не пишут");

    // ---- 7. Место: слева вверху, узкое окно ----
    await load({ hudShown: true, recentLangs: RECENT, hudPos: { side: "left", top: 16 } });
    x = await openByMouse();
    assert.ok(x.down && x.pop.t === x.fab.t && x.pop.l === x.cap.r + 8, "слева вверху: кнопки вниз, панель вровень с верхом кружка, в 8 справа от капсулы: " + JSON.stringify({ pop: x.pop, fab: x.fab, cap: x.cap }));
    await placed("слева вверху");
    await clickIn(".fk-find input"); await type("а");
    await placed("слева вверху, много совпадений");
    await t.shot("lang-lt-light.png", { clip: { x: 0, y: 0, width: 360, height: 360, scale: 2 } });
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await viewport(360, 640);
    for (const pos of [null, { side: "left", top: 16 }, { side: "left", top: 560 }, { side: "right", top: 16 }]) {
      await load(Object.assign({ hudShown: true, recentLangs: RECENT }, pos ? { hudPos: pos } : {}));
      x = await openByMouse();
      const what = "окно 360, " + (pos ? pos.side + " " + pos.top : "справа внизу");
      await placed(what);
      await clickIn(".fk-find input"); await type("а");
      await placed(what + ", поиск");
      if (!pos) await t.shot("lang-360-light.png", { clip: { x: 0, y: 240, width: 360, height: 400, scale: 2 } });
      await click(10, 10); await sleep(100);
    }
    await viewport(1000, 800);
    ok("место: слева вверху — вниз, вровень с верхом кружка; окно 360 в четырёх углах — панель в окне, кнопки и кружок не закрывает (и с длинным списком)");

    // ---- 8. Тёмный сайт ----
    await load({ hudShown: true, recentLangs: RECENT }, "&dark=1");
    x = await openByMouse();
    assert.ok(x.dk, "тёмный сайт — панель тёмная (.dk)");
    const look = await ev(`(() => { const p = fabRoot().querySelector('#fk-lang'), g = getComputedStyle(p); return [g.backgroundColor, getComputedStyle(p.querySelector('.fk-opt .cd')).color]; })()`);
    assert.deepStrictEqual(look, ["rgb(42, 45, 51)", "rgb(154, 160, 168)"], "тёмная панель #2a2d33, название серым #9aa0a8");
    await t.shot("lang-dark.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    await clickIn(".fk-find input"); await type("по");
    await t.shot("lang-find-dark.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    await click(EMPTY.x, EMPTY.y); await sleep(100);
    await move(EMPTY.x, EMPTY.y);
    await openByKeys();
    await t.shot("lang-keys-dark.png", { clip: { x: 640, y: 440, width: 360, height: 360, scale: 2 } });
    ok("тёмный сайт: панель #2a2d33, названия серым #9aa0a8");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
