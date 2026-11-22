// Перевод наведением по тексту внутри открытых shadow root сайта (веб-компоненты: Lit, Polymer): content.js в Chrome
// без интерфейса на fixtures/shadow-hover.html с заглушкой chrome.*. Настоящие события — Input.dispatch* (isTrusted =
// true), поддельные — dispatchEvent из Runtime.evaluate.
// Слушателю на document цель события из root перенацелена на хост компонента, а переход курсора между элементами одного
// root до document не доходит вовсе. Проверяет: Shift (по отпусканию) над текстом в root переводит этот текст, а не
// соседний и не компонент целиком, второй Shift — оригинал; курсор перешёл внутри компонента на соседний текст — Shift
// переводит его; Shift зажали над пустым местом компонента и отпустили над текстом (или над одним текстом и отпустили
// над другим) — ничего; вложенный компонент; поле ввода в root — Shift для поля; закрытый root сайта не трогаем;
// абзац документа рядом — как прежде; Esc — оригинал; карточка — у текста в root; режим задержки — перевод после
// задержки, уход (и внутри компонента) — оригинал; поддельные события страницы — ничего.
// Текст прямо в root без элемента-обёртки (Lit: html`Hello ${name}`; x-text, x-mixed): Shift — перевод этого текста
// одной строкой вместе со строчными элементами и light DOM, показанным через <slot> (наведение и на <b>, и на light
// DOM), второй — оригинал; подложка «идёт перевод» видна; Esc; карточка; режим задержки (переход на <b> внутри — не
// уход); перевод страницы берёт такой текст одной строкой хоста; поддельные события — ничего.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;

(async () => {
  const srv = await serve();
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const open = async (store) => {
      await t.cmd("Page.navigate", { url: srv.base + "/shadow-hover.html?store=" + encodeURIComponent(JSON.stringify(store)) });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      // deep("#c1", "#a") — элемент внутри открытых root по цепочке селекторов; "z" — текст закрытого компонента.
      await ev(`window.deep = (...s) => s[0] === "z" ? window.__closed.querySelector("#z") : s.reduce((n, x, i) => (i ? n.shadowRoot : n).querySelector(x), document); true`);
      await prepRoot();
      await sleep(400);
    };

    const A = ["#c1", "#a"], B = ["#c1", "#b"], N = ["#c1", "#c2", "#n"], DOC = ["#doc"], Z = ["z"], BOX = ["#c1", ".box"];
    const js = (path) => `deep(...${JSON.stringify(path)})`;
    const text = (path) => ev(`${js(path)}.textContent`);
    const tr = async (path) => /^\[RU\] /.test(await text(path));
    const calls = () => ev("window.__calls.length");
    // точка над текстом: 40 px от левого края, середина по высоте; у рамки компонента — её верхний отступ (пусто)
    const at = (path) => ev(`(({ left, top, height }) => ({ x: Math.round(left) + 40, y: Math.round(top + height / 2) }))(${js(path)}.getBoundingClientRect())`);
    const empty = () => ev(`(({ left, top }) => ({ x: Math.round(left) + 40, y: Math.round(top) + 15 }))(${js(BOX)}.getBoundingClientRect())`);
    const move = (x, y, modifiers = 0) => t.mouse("mouseMoved", x, y, { modifiers });
    const to = async (p, modifiers = 0) => { await move(p.x, p.y, modifiers); await sleep(30); await move(p.x + 2, p.y + 1, modifiers); await sleep(80); };
    const hover = async (path, modifiers = 0) => to(await at(path), modifiers);
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const shiftDown = () => key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
    const shiftUp = () => key("keyUp", "Shift", "ShiftLeft", 0, 16);
    const tapShift = async () => { await shiftDown(); await sleep(30); await shiftUp(); await sleep(250); };
    const away = async () => { await move(990, 790); await sleep(50); };
    const ORIG = {};
    // Текст прямо в root: T — строчный хост x-text в <div>, M — x-mixed (MB — <b> в его root, ML — light DOM хоста,
    // показанный через <slot>). vis — текст хоста, как он виден на экране (root без <style>, на месте <slot> — light
    // DOM); atN — точка над текстовым узлом; loose — текстовые узлы прямо в root.
    const T = ["#t1"], M = ["#m1"], MB = ["#m1", "#mb"], ML = ["#ml"];
    const prepRoot = () => ev(`window.vis = (h) => { let s = ""; const walk = (ns) => { for (const n of ns) {
        if (n.nodeType === 3) { if (!n.parentElement || n.parentElement.tagName !== "STYLE") s += n.nodeValue; }
        else if (n.nodeType === 1) { const a = n.tagName === "SLOT" ? n.assignedNodes({ flatten: true }) : []; walk(a.length ? a : n.childNodes); } } };
        walk(h.shadowRoot.childNodes); return s; };
      window.loose = (h) => Array.from(h.shadowRoot.childNodes).filter((n) => n.nodeType === 3 && n.nodeValue.trim());
      window.atN = (n) => { const r = document.createRange(); r.selectNodeContents(n); const b = r.getClientRects()[0];
        return { x: Math.round(b.left) + 12, y: Math.round(b.top + b.height / 2) }; }; true`);
    const vis = (path) => ev(`vis(${js(path)})`);
    const looseAt = (path, i = 0) => ev(`atN(loose(${js(path)})[${i}])`);
    const mlAt = () => ev(`atN(${js(ML)}.firstChild)`);
    const ru = (s) => (s.match(/\[RU\] /g) || []).length;

    // ================= клавиша Shift, замена текста =================
    await open({ trigger: "shift", displayMode: "replace" });
    for (const [k, p] of Object.entries({ A, B, N, DOC, Z })) ORIG[k] = await text(p);
    assert.ok(/^First line/.test(ORIG.A) && /^Closed/.test(ORIG.Z), "компоненты на месте: " + JSON.stringify(ORIG));
    ORIG.T = await vis(T); ORIG.M = await vis(M);
    assert.strictEqual(ORIG.T, "Loose text right inside the shadow root of a component.");
    assert.strictEqual(ORIG.M, "Hello from the mixed component, bold words inside and light words shown through the slot at the end of it.");

    // ---- 1. Поддельные события страницы внутри root — ничего ----
    await hover(DOC); await away();
    await ev(`(() => { const a = ${js(A)};
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true, clientX: 100, clientY: 100 }));
      a.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true, clientX: 101, clientY: 100 }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      return true; })()`);
    await sleep(300);
    assert.strictEqual(await calls(), 0, "поддельные события — ни одного запроса");
    assert.ok(!(await tr(A)));
    ok("поддельные mouseover/mousemove внутри root и keydown/keyup Shift от страницы — ни одного запроса");

    // ---- 2. Shift над текстом в root: переводится этот текст, а не соседний и не компонент целиком ----
    await hover(A);
    await shiftDown(); await sleep(150);
    assert.strictEqual(await calls(), 0, "пока Shift держат, ничего не переводится");
    await shiftUp(); await sleep(250);
    assert.ok(await tr(A), "Shift над текстом в открытом root переводит его: " + await text(A));
    assert.strictEqual(await text(A), "[RU] " + ORIG.A);
    assert.strictEqual(await text(B), ORIG.B, "соседний текст того же компонента не тронут");
    assert.strictEqual(await text(N), ORIG.N, "вложенный компонент не тронут");
    const sent = await ev("window.__calls.map((c) => c.items)");
    assert.deepStrictEqual(sent, [[ORIG.A]], "в запросе только текст под курсором");
    await tapShift();
    assert.strictEqual(await text(A), ORIG.A, "второй Shift — оригинал");
    ok("Shift по отпусканию над текстом в открытом root переводит только этот текст (пока держат — ничего), второй — оригинал");

    // ---- 3. Курсор перешёл внутри компонента на соседний текст — Shift переводит его ----
    await hover(A);
    await hover(B);
    await tapShift();
    assert.ok(await tr(B), "Shift переводит текст, на который курсор перешёл внутри компонента: " + await text(B));
    assert.strictEqual(await text(A), ORIG.A, "а не тот, с которого ушёл");
    await tapShift();
    assert.strictEqual(await text(B), ORIG.B);
    ok("переход курсора между текстами одного компонента (до document не доходит) замечен: Shift переводит текст под курсором");

    // ---- 4. Нажали над пустым местом компонента, отпустили над текстом — ничего; над одним текстом — над другим — ничего ----
    const n0 = await calls();
    await to(await empty());
    await shiftDown(); await sleep(30);
    await hover(A, SHIFT); await sleep(150);
    assert.ok(!(await tr(A)), "пока держат — ничего");
    await shiftUp(); await sleep(250);
    assert.ok(!(await tr(A)), "нажали над пустым местом, отпустили над текстом — не перевод");
    await hover(A);
    await shiftDown(); await sleep(30);
    await hover(B, SHIFT);
    await shiftUp(); await sleep(250);
    assert.ok(!(await tr(A)) && !(await tr(B)), "нажали над одним текстом, отпустили над другим — не перевод");
    assert.strictEqual(await calls(), n0);
    await tapShift();
    assert.ok(await tr(B), "чистое нажатие над текстом — перевод");
    await tapShift();
    assert.strictEqual(await text(B), ORIG.B);
    ok("Shift над пустым местом компонента (или над одним текстом) и отпускание над текстом — ничего, как щелчок");

    // ---- 5. Вложенный компонент ----
    await hover(N);
    await tapShift();
    assert.strictEqual(await text(N), "[RU] " + ORIG.N, "текст вложенного компонента переведён");
    assert.ok(!(await tr(A)) && !(await tr(B)), "внешний компонент не тронут");
    await hover(A);
    await hover(N);
    await tapShift();
    assert.strictEqual(await text(N), ORIG.N, "второй Shift — оригинал (курсор уходил и вернулся внутри компонентов)");
    ok("текст вложенного компонента (root в root) переводится сам по себе, второй Shift — оригинал");

    // ---- 6. Фокус в поле ввода внутри root — Shift для поля ----
    await ev(`${js(["#c1", "#field"])}.focus(); true`);
    const n1 = await calls();
    await hover(A);
    await tapShift();
    assert.ok(!(await tr(A)), "фокус в поле ввода компонента — Shift не переводит");
    assert.strictEqual(await calls(), n1);
    await ev(`${js(["#c1", "#field"])}.blur(); true`);
    await hover(B); await hover(A);
    await tapShift();
    assert.ok(await tr(A), "без фокуса в поле — снова переводит");
    await tapShift();
    ok("фокус в поле ввода внутри открытого root — Shift для поля; после снятия фокуса — переводит");

    // ---- 7. Закрытый root сайта не трогаем; абзац документа — как прежде ----
    const n2 = await calls();
    await hover(Z);
    await tapShift();
    assert.strictEqual(await text(Z), ORIG.Z, "закрытый root сайта не тронут");
    assert.strictEqual(await calls(), n2, "и ни одного запроса");
    const NT = ["#c4", "#n"];
    await hover(NT);
    await tapShift();
    assert.ok(!(await tr(NT)) && (await calls()) === n2, "компонент под notranslate — запрет автора и на текст в его root (как у перевода страницы)");
    await hover(DOC);
    await tapShift();
    assert.strictEqual(await text(DOC), "[RU] " + ORIG.DOC, "абзац документа переводится");
    assert.ok(!(await tr(A)) && !(await tr(B)) && !(await tr(N)), "компоненты рядом не тронуты");
    await tapShift();
    assert.strictEqual(await text(DOC), ORIG.DOC);
    ok("текст в закрытом root сайта и в компоненте под notranslate — ничего; обычный абзац документа рядом переводится и возвращается как прежде");

    // ---- 8. Esc — оригинал ----
    await hover(A);
    await tapShift();
    await hover(N);
    await tapShift();
    assert.ok(await tr(A) && await tr(N));
    await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27);
    await sleep(200);
    assert.strictEqual(await text(A), ORIG.A, "Esc вернул оригинал");
    assert.strictEqual(await text(N), ORIG.N, "и во вложенном компоненте");
    ok("Esc возвращает оригинал текстов в компонентах");

    // ================= текст прямо в root, без элемента-обёртки =================
    // ---- 9. Поддельные события страницы над текстом в root — ничего ----
    const r0 = await calls();
    await ev(`(() => { for (const el of [${js(T)}, ${js(MB)}]) {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true, clientX: 100, clientY: 100 }));
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true, clientX: 101, clientY: 100 })); }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
      return true; })()`);
    await sleep(300);
    assert.strictEqual(await calls(), r0, "поддельные события над текстом в root — ни одного запроса");
    assert.strictEqual(await vis(T), ORIG.T);
    ok("поддельные mouseover/mousemove над текстом прямо в root и keydown/keyup Shift от страницы — ничего");

    // ---- 10. Shift над текстом прямо в root: переводится он, а не соседний абзац и не документ; подложка видна ----
    await to(await looseAt(T));
    await ev("window.__hold = true");
    await shiftDown(); await sleep(150);
    assert.strictEqual(await calls(), r0, "пока Shift держат, ничего не переводится");
    await shiftUp(); await sleep(400);
    const ld = await ev(`(() => { const h = ${js(T)}, cs = getComputedStyle(h); return { cls: h.classList.contains("ht-loading"), anim: cs.animationName, bg: cs.backgroundColor }; })()`);
    assert.ok(ld.cls && ld.anim === "ht-pulse" && !/rgba\(0, 0, 0, 0\)|transparent/.test(ld.bg), "подложка «идёт перевод» у хоста видна: " + JSON.stringify(ld));
    await ev("window.__release()");
    assert.ok(await until(async () => (await vis(T)) === "[RU] " + ORIG.T, 2000), "Shift над текстом в root переводит его: " + await vis(T));
    assert.ok(!(await ev(`${js(T)}.classList.contains("ht-loading")`)), "подложка снята");
    assert.deepStrictEqual(await ev(`window.__calls.slice(${r0}).map((c) => c.items)`), [[ORIG.T]], "в запросе только текст этого компонента");
    assert.strictEqual(await text(DOC), ORIG.DOC, "абзац документа не тронут");
    assert.strictEqual(await vis(M), ORIG.M, "соседний компонент не тронут");
    assert.strictEqual(await text(A), ORIG.A);
    await tapShift();
    assert.strictEqual(await vis(T), ORIG.T, "второй Shift — оригинал");
    ok("Shift над текстом прямо в root (строчный хост в <div>) переводит только его, пока идёт перевод — подложка у хоста; второй — оригинал");

    // ---- 11. Строчные элементы и <slot> вперемешку с текстом: одна строка на весь верхний уровень root ----
    const r1 = await calls();
    await hover(MB);
    await tapShift();
    const mt = await vis(M);
    assert.strictEqual(ru(mt), 5, "Shift над <b> переводит весь верхний уровень root вместе с light DOM в <slot>: " + mt);
    assert.ok(mt.startsWith("[RU] Hello from") && /\[RU\] bold words inside/.test(mt) && /\[RU\] light words/.test(mt), mt);
    assert.deepStrictEqual(await ev(`window.__calls.slice(${r1}).map((c) => c.items)`),
      [["Hello from the mixed component,", "bold words inside", "and", "light words shown through the slot", "at the end of it."]], "один запрос, одна строка");
    assert.strictEqual(await vis(T), ORIG.T, "другой компонент с текстом в root не тронут");
    await to(await looseAt(M));
    await tapShift();
    assert.strictEqual(await vis(M), ORIG.M, "второй Shift над текстом рядом (та же строка) — оригинал");
    ok("строчные элементы и <slot> вперемешку с текстом в root: Shift над <b> — одна строка на весь верхний уровень, второй над текстом — оригинал");

    // ---- 12. Light DOM хоста, показанный через <slot>, — та же строка ----
    await to(await mlAt());
    await tapShift();
    assert.strictEqual(ru(await vis(M)), 5, "Shift над light DOM в <slot> переводит строку хоста целиком: " + await vis(M));
    await hover(MB);
    await tapShift();
    assert.strictEqual(await vis(M), ORIG.M, "второй Shift (над <b>) — оригинал");
    ok("light DOM хоста, показанный через <slot>: Shift — та же строка хоста целиком, второй (над <b>) — оригинал");

    // ---- 13. Esc — оригинал ----
    await to(await looseAt(T));
    await tapShift();
    await hover(MB);
    await tapShift();
    assert.ok((await vis(T)).startsWith("[RU] ") && ru(await vis(M)) === 5);
    await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27);
    await sleep(200);
    assert.strictEqual(await vis(T), ORIG.T, "Esc вернул оригинал текста в root");
    assert.strictEqual(await vis(M), ORIG.M, "и строки с <b> и <slot>");
    ok("Esc возвращает оригинал текста прямо в root");

    // ================= карточка =================
    await open({ trigger: "shift", displayMode: "popover" });
    await hover(B);
    await tapShift();
    const card = await until(() => ev(`(() => { const r = cards()[0]; if (!r) return null; const h = r.host.getBoundingClientRect(), b = ${js(B)}.getBoundingClientRect();
      return { text: r.querySelector(".c-text").textContent, left: Math.round(h.left), top: Math.round(h.top), bottom: Math.round(h.bottom),
        bLeft: Math.round(b.left), bTop: Math.round(b.top), bBottom: Math.round(b.bottom) }; })()`), 3000);
    assert.ok(card, "карточка появилась");
    assert.strictEqual(card.text, "[RU] " + ORIG.B, "в карточке перевод текста под курсором");
    assert.ok(Math.abs(card.left - card.bLeft) <= 2, "карточка у текста по горизонтали: " + JSON.stringify(card));
    assert.ok(card.top >= card.bBottom && card.top - card.bBottom <= 40 || card.bottom <= card.bTop && card.bTop - card.bottom <= 40,
      "карточка прямо под текстом или над ним: " + JSON.stringify(card));
    assert.strictEqual(await text(B), ORIG.B, "сам текст не заменён");
    await tapShift();
    assert.strictEqual(await ev("cards().length"), 0, "второй Shift закрыл карточку");
    ok("карточка: Shift над текстом в root — карточка с его переводом у этого текста, второй Shift — закрыта");

    // ---- карточка у текста прямо в root: перевод того, что видно (без <style>), сам текст не заменён ----
    for (const [path, at0] of [[T, () => looseAt(T)], [M, () => hover(MB).then(() => null)]]) {
      const p0 = await at0();
      if (p0) await to(p0);
      await tapShift();
      const ct = await until(() => ev("(() => { const r = cards()[0]; return r ? r.querySelector('.c-text').textContent : null; })()"), 3000);
      const want = path === T ? ORIG.T : ORIG.M;
      assert.strictEqual(ct, "[RU] " + want, "в карточке перевод текста в root целиком, без <style>: " + ct);
      assert.strictEqual(await vis(path), want, "сам текст не заменён");
      await tapShift();
      assert.strictEqual(await ev("cards().length"), 0, "второй Shift закрыл карточку");
    }
    ok("карточка у текста прямо в root (и строки с <b> и <slot>): перевод видимого текста целиком, без <style>; второй Shift — закрыта");

    // ================= режим задержки =================
    await open({ trigger: "dwell", displayMode: "replace", dwellMs: 250 });
    await away();
    await hover(A);
    assert.ok(await until(() => tr(A), 3000), "после задержки текст в root переведён");
    assert.strictEqual(await text(B), ORIG.B);
    await hover(B);
    assert.ok(await until(async () => (await text(A)) === ORIG.A, 2000), "ушли на соседний текст компонента — оригинал");
    assert.ok(await until(() => tr(B), 3000), "и соседний переведён после задержки");
    await hover(DOC);
    assert.ok(await until(async () => (await text(B)) === ORIG.B, 2000), "ушли из компонента — оригинал");
    await away();
    await sleep(500);
    const n3 = await calls();
    await ev(`(() => { const a = ${js(A)};
      for (let i = 0; i < 3; i++) a.dispatchEvent(new MouseEvent(i ? "mousemove" : "mouseover", { bubbles: true, composed: true, clientX: 100 + i, clientY: 100 }));
      return true; })()`);
    await sleep(700);
    assert.strictEqual(await calls(), n3, "поддельные mouseover/mousemove страницы — ничего");
    assert.ok(!(await tr(A)));
    ok("режим задержки: текст в root переводится после задержки, уход (и на соседний текст компонента) — оригинал; поддельные события — ничего");

    // ---- режим задержки у текста прямо в root: переход на <b> и light DOM в <slot> — не уход ----
    await to(await looseAt(T));
    assert.ok(await until(async () => (await vis(T)) === "[RU] " + ORIG.T, 3000), "после задержки текст прямо в root переведён");
    await to(await looseAt(M));
    assert.ok(await until(async () => (await vis(T)) === ORIG.T, 2000), "ушли на другой компонент — оригинал");
    assert.ok(await until(async () => ru(await vis(M)) === 5, 3000), "строка с <b> и <slot> переведена после задержки");
    const n5 = await calls();
    await hover(MB); await sleep(500);
    await to(await mlAt()); await sleep(500);
    await to(await looseAt(M, 1)); await sleep(500);
    assert.strictEqual(ru(await vis(M)), 5, "курсор ходит по <b>, light DOM в <slot> и тексту той же строки — перевод на месте");
    assert.strictEqual(await calls(), n5, "и без новых запросов");
    await hover(DOC);
    assert.ok(await until(async () => (await vis(M)) === ORIG.M, 2000), "ушли из компонента — оригинал");
    await away();
    await sleep(500);
    const n6 = await calls();
    await ev(`(() => { for (const el of [${js(T)}, ${js(MB)}]) for (let i = 0; i < 3; i++)
      el.dispatchEvent(new MouseEvent(i ? "mousemove" : "mouseover", { bubbles: true, composed: true, clientX: 100 + i, clientY: 100 }));
      return true; })()`);
    await sleep(700);
    assert.strictEqual(await calls(), n6, "поддельные события над текстом в root — ничего");
    ok("режим задержки у текста прямо в root: перевод после задержки, переход на <b>/light DOM в <slot> той же строки — не уход, уход — оригинал; поддельные — ничего");

    // ---- карточка в режиме задержки: с текста в root на карточку и обратно — карточка остаётся ----
    await open({ trigger: "dwell", displayMode: "popover", dwellMs: 250 });
    await away();
    await hover(B);
    assert.ok(await until(() => ev("cards().length === 1"), 3000), "после задержки — карточка");
    const n4 = await calls();
    const onCard = await ev(`(({ left, top, height }) => ({ x: Math.round(left) + 60, y: Math.round(top + height / 2) }))(cards()[0].host.getBoundingClientRect())`);
    await to(onCard); await sleep(400);
    assert.strictEqual(await ev("cards().length"), 1, "курсор на карточке — карточка на месте");
    await hover(B); await sleep(700);
    assert.strictEqual(await ev("cards().length"), 1, "вернулись с карточки на текст — карточка на месте");
    assert.strictEqual(await calls(), n4, "и не закрывалась и не запрашивалась заново");
    await away();
    assert.ok(await until(() => ev("cards().length === 0"), 2000), "ушли из компонента на пустое место — карточка закрыта");
    ok("карточка в режиме задержки: с текста в root на карточку и обратно — остаётся (без повторного запроса), уход — закрыта");

    // ================= перевод страницы =================
    await open({ trigger: "shift", displayMode: "replace" });
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await vis(T)) === "[RU] " + ORIG.T && ru(await vis(M)) === 5 && await tr(A), 4000),
      "перевод страницы берёт текст прямо в root: " + await vis(T) + " / " + await vis(M));
    const items = (await ev("window.__calls.map((c) => c.items)")).flat();
    for (const x of [ORIG.T, "Hello from the mixed component,", "bold words inside", "light words shown through the slot"]) {
      assert.strictEqual(items.filter((y) => y === x).length, 1, "каждый кусок — один раз: " + x + " в " + JSON.stringify(items));
    }
    assert.strictEqual(ru(await vis(M)), 5, "<b> в строке хоста не переведён второй раз отдельной строкой");
    await ev("sendCmd('restoreAll'); true"); await sleep(200);
    assert.strictEqual(await vis(T), ORIG.T, "«Показать оригинал» — оригинал текста в root");
    assert.strictEqual(await vis(M), ORIG.M);
    ok("перевод страницы: текст прямо в root (и строка с <b> и <slot>) — одной строкой хоста, каждый кусок один раз; «Показать оригинал» — оригинал");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
