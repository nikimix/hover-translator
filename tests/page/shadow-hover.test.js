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

    // ================= клавиша Shift, замена текста =================
    await open({ trigger: "shift", displayMode: "replace" });
    for (const [k, p] of Object.entries({ A, B, N, DOC, Z })) ORIG[k] = await text(p);
    assert.ok(/^First line/.test(ORIG.A) && /^Closed/.test(ORIG.Z), "компоненты на месте: " + JSON.stringify(ORIG));

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

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
