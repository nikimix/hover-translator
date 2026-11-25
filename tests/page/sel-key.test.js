// Перевод выделенного клавишей-триггером: content.js в Chrome без интерфейса на fixtures/stub.html (заглушка chrome.*,
// перевод — «[RU] текст»). Настоящие события — Input.dispatch*: выделение мышью (двойной щелчок, протяжка), с
// клавиатуры (Shift+стрелки, Ctrl+A), клавиша — нажатие и отпускание.
// Проверяет: чистое нажатие Shift с курсором над выделенным словом переводит слово (по действию пользователя), абзац
// и выделение на месте; курсор в запасе 8 px у строки выделения, между абзацами, — тоже; курсор не над выделением —
// блок под курсором. Выделили с клавиатуры и мышь не двигалась — переводится выделенное, где бы ни был курсор;
// мышь сдвинулась — снова блок под курсором. Ctrl+A: курсор над абзацем (он целиком внутри выделения) — абзац, над
// пустым местом — «Слишком длинный отрывок» с числом знаков. Выделение в переведённом на месте абзаце — клавиша
// возвращает оригинал. Как щелчок: нажали над выделением, отпустили не над ним (и наоборот) — ничего; пока Shift
// держат — ничего; Shift+щелчок, Shift+стрелки, Ctrl+C (и при клавише Ctrl) — ничего; поддельные события страницы —
// ничего. Способ показа «карточка» — то же. Встроенное окно: решает фрейм под курсором (выделение страницы при
// фокусе в окне; курсор над текстом окна при выделении на странице), выделенное с клавиатуры — где бы ни был курсор.
// Режим «Без клавиши»: под курсором выделение или зажата кнопка мыши — абзац по задержке не переводится.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8, CTRL = 2;
// Разделы не зависят друг от друга (у каждого своя загрузка страницы). HT_SEL_ALL=1 — пройти все разделы и
// перечислить упавшие (проверка, что набор ловит отсутствие правки), иначе — до первой ошибки.
const ALL = !!process.env.HT_SEL_ALL;
const failed = [];
const section = async (fn) => {
  try { await fn(); } catch (e) { if (!ALL) throw e; failed.push(e); console.log("  FAIL " + String(e && e.message).split("\n")[0]); }
};
const RU = (s) => "[RU] " + s;

(async () => {
  const srv = await serve();
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store, extra = "") => {
      await t.cmd("Page.navigate", { url: srv.base + "/stub.html?store=" + encodeURIComponent(JSON.stringify(store || {})) + extra });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(400);
    };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const tr = () => ev("trCalls().map((c) => [c.items, c.by])");
    const nCalls = () => ev("trCalls().length");
    const selText = () => ev("String(document.getSelection())");
    // Слово в элементе: рамка в координатах окна и середина.
    const word = (sel, w) => ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        const i = n.nodeValue.indexOf(${JSON.stringify(w)});
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${w.length});
        const q = r.getBoundingClientRect();
        return { l: q.left, t: q.top, r: q.right, b: q.bottom, x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
      }
      return null; })()`);
    const box = (sel) => ev(`(({ left, top, right, bottom, width, height }) => ({ l: left, t: top, r: right, b: bottom,
      x: Math.round(left + Math.min(width / 2, 200)), y: Math.round(top + height / 2) }))(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`);
    const move = (x, y, extra) => t.mouse("mouseMoved", x, y, extra);
    // Курсор в точку: два движения, как рука.
    const moveTo = async (p, modifiers = 0) => { await move(p.x - 2, p.y, { modifiers }); await sleep(30); await move(p.x, p.y, { modifiers }); await sleep(60); };
    const dbl = async (p) => {
      await move(p.x, p.y); await sleep(20);
      for (const clickCount of [1, 2]) {
        await t.mouse("mousePressed", p.x, p.y, { button: "left", buttons: 1, clickCount });
        await t.mouse("mouseReleased", p.x, p.y, { button: "left", buttons: 0, clickCount });
      }
      await sleep(100);
    };
    const key = (type, k, code, modifiers, vk, extra) => t.cmd("Input.dispatchKeyEvent", Object.assign({ type, key: k, code, modifiers, windowsVirtualKeyCode: vk }, extra));
    const shiftDown = () => key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
    const shiftUp = () => key("keyUp", "Shift", "ShiftLeft", 0, 16);
    const tapShift = async () => { await shiftDown(); await sleep(30); await shiftUp(); await sleep(250); };
    const tapCtrl = async () => { await key("rawKeyDown", "Control", "ControlLeft", CTRL, 17); await sleep(30); await key("keyUp", "Control", "ControlLeft", 0, 17); await sleep(250); };
    // Shift+→ n раз: Shift зажат, стрелки, Shift отпущен.
    const shiftRight = async (n) => {
      await shiftDown(); await sleep(20);
      for (let i = 0; i < n; i++) { await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39); await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39); await sleep(20); }
      await shiftUp(); await sleep(150);
    };
    const ctrlKey = async (k, vk, commands) => {
      await key("rawKeyDown", "Control", "ControlLeft", CTRL, 17); await sleep(20);
      await key("rawKeyDown", k, "Key" + k.toUpperCase(), CTRL, vk, commands ? { commands } : {}); await key("keyUp", k, "Key" + k.toUpperCase(), CTRL, vk);
      await sleep(20); await key("keyUp", "Control", "ControlLeft", 0, 17); await sleep(150);
    };
    const ctrlA = () => ctrlKey("a", 65, ["selectAll"]);
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(100); };
    // Перевели выделенное: переводчику ушёл ровно этот текст, по действию пользователя. Карточку закрываем (Esc),
    // чтобы она не легла на соседний абзац, к которому потом ведём курсор.
    const sentSel = async (n0, s, what) => {
      assert.ok(await until(async () => (await nCalls()) > n0, 2000), what + ": переводчику ничего не ушло");
      assert.deepStrictEqual((await tr()).slice(n0), [[[s], "user-initiated"]], what);
      await sleep(100); await esc();
    };
    const P1 = "The quick brown fox jumps over the lazy dog near the river bank.";
    const P2 = "Another paragraph with plain English text for the sweep test.";
    const P3 = "Third paragraph has its own title attribute that must survive.";

    let n0;
    // ---- 1. Курсор над выделенным словом — переводится слово; абзац и выделение на месте ----
    await section(async () => {
      await load();
      await dbl(await word("#p1", "brown"));
      assert.strictEqual(await selText(), "brown", "двойной щелчок выделил слово");
      await tapShift();
      await sentSel(0, "brown", "Shift над выделенным словом");
      assert.strictEqual(await text("#p1"), P1, "абзац не заменён");
      assert.strictEqual(await selText(), "brown", "выделение на месте");
      ok("Shift с курсором над выделенным словом переводит слово (по действию пользователя), абзац и выделение на месте");
    });

    // ---- 2. Запас 8 px: курсор между абзацами под строкой выделения (блока под курсором нет) ----
    await section(async () => {
      await load();
      const wb = await word("#p1", "brown");
      await dbl(wb);
      n0 = await nCalls();
      const gap = { x: wb.x, y: Math.round(wb.b + 5) };
      assert.ok(gap.y < (await box("#p2")).t && gap.y > (await box("#p1")).b, "точка — между абзацами");
      await moveTo(gap);
      await tapShift();
      await sentSel(n0, "brown", "курсор в 5 px под строкой выделения");
      // дальше запаса — ничего (и блока там нет)
      n0 = await nCalls();
      await moveTo({ x: wb.x, y: Math.round(wb.b + 11) });
      await tapShift(); await sleep(150);
      assert.strictEqual(await nCalls(), n0, "в 11 px под строкой — не над выделением");
      ok("курсор в запасе 8 px у строки выделения (между абзацами, где блока под курсором нет) — переводится выделенное; дальше — ничего");
    });

    // ---- 3. Курсор не над выделением — блок под курсором, выделение не тронуто ----
    await section(async () => {
      await load();
      await dbl(await word("#p1", "brown"));
      n0 = await nCalls();
      await moveTo(await box("#p2"));
      await tapShift();
      assert.ok(await until(async () => (await text("#p2")) === RU(P2), 2000), "абзац под курсором переведён: " + await text("#p2"));
      assert.deepStrictEqual((await tr()).slice(n0), [[[P2], "user-initiated"]]);
      assert.strictEqual(await text("#p1"), P1);
      assert.strictEqual(await selText(), "brown", "выделение в другом абзаце не тронуто");
      await tapShift();
      assert.strictEqual(await text("#p2"), P2, "второй Shift — оригинал");
      ok("курсор не над выделением — Shift переводит блок под курсором, как без выделения; второй — оригинал");
    });

    // ---- 4. Выделили с клавиатуры, мышь не двигалась — выделенное, где бы ни был курсор ----
    await section(async () => {
      await load();
      await dbl(await word("#p1", "brown"));
      n0 = await nCalls();
      await moveTo(await box("#p3"));
      await shiftRight(6);                          // «brown» → «brown fox j»: Shift+стрелки сами ничего не переводят
      assert.strictEqual(await selText(), "brown fox j", "Shift+→ расширили выделение");
      assert.strictEqual(await nCalls(), n0, "Shift+стрелки не переводят");
      await tapShift();
      await sentSel(n0, "brown fox j", "выделили с клавиатуры, курсор над другим абзацем");
      assert.strictEqual(await text("#p3"), P3, "абзац под курсором не переведён");
      // мышь сдвинулась — снова решает курсор: над другим абзацем — он
      n0 = await nCalls();
      await moveTo(await box("#p3"));
      await tapShift();
      assert.ok(await until(async () => (await text("#p3")) === RU(P3), 2000), "мышь сдвинулась — абзац под курсором");
      assert.deepStrictEqual((await tr()).slice(n0), [[[P3], "user-initiated"]]);
      await tapShift();
      ok("выделили с клавиатуры (Shift+→), мышь не двигалась — Shift переводит выделенное, хотя курсор над другим абзацем; мышь сдвинулась — снова абзац под курсором");
    });

    // ---- 5. Ctrl+A: абзац под курсором целиком внутри выделения — он; над пустым местом — «слишком длинный» ----
    await section(async () => {
      await load();
      n0 = await nCalls();
      await moveTo(await box("#p2"));
      await ctrlA();
      const all = await ev("String(document.getSelection()).length");
      assert.ok(all > 2000, "Ctrl+A выделил всю страницу: " + all);
      await tapShift();
      assert.ok(await until(async () => (await text("#p2")) === RU(P2), 2000), "Ctrl+A, курсор над абзацем — абзац: " + await text("#p2"));
      assert.deepStrictEqual((await tr()).slice(n0), [[[P2], "user-initiated"]]);
      assert.deepStrictEqual(await ev("toasts()"), [], "уведомлений нет");
      await tapShift();
      assert.strictEqual(await text("#p2"), P2);
      n0 = await nCalls();
      await moveTo({ x: 900, y: (await box("#p2")).y });   // справа от абзацев: пусто
      await ctrlA();
      await tapShift();
      const long = await until(async () => (await ev("toasts()")).find((s) => /Слишком длинный отрывок/.test(s)), 2000);
      assert.ok(long, "уведомление «Слишком длинный отрывок»: " + JSON.stringify(await ev("toasts()")));
      // число знаков — выделенного текста (без пустых строк и отступов): больше 2000 и не больше String(selection)
      const m = /(\d[\d\s]*)\s+знак/.exec(long), count = m ? Number(m[1].replace(/\s/g, "")) : 0;
      assert.ok(count > 2000 && count <= all, "с числом знаков (" + all + " вместе с переводами строк): " + long);
      assert.strictEqual(await nCalls(), n0, "переводчику ничего не ушло");
      ok("Ctrl+A: курсор над абзацем (он целиком внутри выделения) — Shift переводит абзац; над пустым местом — «Слишком длинный отрывок» с числом знаков (" + count + "), без перевода");
    });

    // ---- 5а. Абзац целиком в коротком выделении (тройной щелчок, протяжка через два абзаца) — карточка, не замена ----
    await section(async () => {
      await load();
      const b1 = await box("#p1");
      await move(b1.x, b1.y); await sleep(20);
      for (const clickCount of [1, 2, 3]) {
        await t.mouse("mousePressed", b1.x, b1.y, { button: "left", buttons: 1, clickCount });
        await t.mouse("mouseReleased", b1.x, b1.y, { button: "left", buttons: 0, clickCount });
      }
      await sleep(100);
      assert.strictEqual((await selText()).trim(), P1, "тройной щелчок выделил абзац");
      n0 = await nCalls();
      await tapShift();
      await sentSel(n0, P1, "тройной щелчок и Shift");
      assert.strictEqual(await text("#p1"), P1, "абзац не заменён (режим замены): перевод — в карточке");
      // протяжка от начала первого абзаца до конца второго: два куска, абзацы не заменены. Сначала щелчок по пустому
      // месту: нажатие внутри выделенного начинало бы перетаскивание текста, а не новое выделение
      const b2 = await box("#p2");
      await move(900, b1.y); await sleep(20);
      await t.mouse("mousePressed", 900, b1.y, { button: "left", buttons: 1, clickCount: 1 });
      await t.mouse("mouseReleased", 900, b1.y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(400);
      await move(b1.l + 1, b1.y); await sleep(20);
      await t.mouse("mousePressed", b1.l + 1, b1.y, { button: "left", buttons: 1, clickCount: 1 });
      for (const [x, y] of [[b1.x, b1.y], [b2.x, b2.y], [b2.r - 1, b2.y]]) { await move(x, y, { button: "left", buttons: 1 }); await sleep(30); }
      await t.mouse("mouseReleased", b2.r - 1, b2.y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      n0 = await nCalls();
      await moveTo({ x: b2.x, y: b2.y });
      await tapShift();
      assert.ok(await until(async () => (await nCalls()) > n0, 2000), "протяжка через два абзаца: переводчику ничего не ушло");
      const sent = (await tr()).slice(n0);
      assert.strictEqual(sent.length, 1, "один перевод: " + JSON.stringify(sent));
      assert.ok(sent[0][0].length === 2 && sent[0][0][0].startsWith("The quick") && sent[0][0][1] === P2, "два куска — по абзацам: " + JSON.stringify(sent[0][0]));
      assert.strictEqual(await text("#p2"), P2, "абзац под курсором не заменён");
      ok("абзац целиком в коротком выделении (тройной щелчок; протяжка через два абзаца, курсор над вторым) — Shift переводит выделенное в карточку, абзацы не заменены");
    });

    // ---- 6. Выделение в переведённом на месте абзаце — Shift возвращает оригинал ----
    await section(async () => {
      await load();
      await moveTo(await box("#p2"));
      await tapShift();
      assert.ok(await until(async () => (await text("#p2")) === RU(P2), 2000));
      n0 = await nCalls();
      await dbl(await word("#p2", "plain"));
      assert.strictEqual(await selText(), "plain");
      await tapShift();
      assert.strictEqual(await text("#p2"), P2, "Shift над выделением в переводе вернул оригинал");
      await sleep(200);
      assert.strictEqual(await nCalls(), n0, "переводчику ничего не ушло");
      ok("выделение внутри переведённого на месте абзаца клавишей не переводится: Shift возвращает оригинал абзаца");
    });

    // ---- 7. Как щелчок; сочетания; поддельные события ----
    await section(async () => {
      await load();
      await dbl(await word("#p1", "lazy"));
      n0 = await nCalls();
      const lz = await word("#p1", "lazy");
      // а) пока держат — ничего; нажали над выделением, отпустили над другим абзацем — ничего
      await shiftDown(); await sleep(300);
      assert.strictEqual(await nCalls(), n0, "зажатый Shift над выделением сам по себе не переводит");
      await moveTo(await box("#p3"), SHIFT); await sleep(100);
      await shiftUp(); await sleep(250);
      // б) нажали над другим местом абзаца, отпустили над выделением — ничего
      await moveTo(await word("#p1", "quick"));
      await shiftDown(); await sleep(30);
      await moveTo(lz, SHIFT);
      await shiftUp(); await sleep(250);
      assert.strictEqual(await nCalls(), n0, "нажали и отпустили не над одним и тем же — ничего");
      assert.deepStrictEqual([await text("#p1"), await text("#p3")], [P1, P3]);
      // в) Shift+щелчок расширяет выделение — без перевода
      await shiftDown(); await sleep(20);
      const dg = await word("#p1", "dog");
      await move(dg.r - 1, dg.y, { modifiers: SHIFT });
      await t.mouse("mousePressed", dg.r - 1, dg.y, { button: "left", buttons: 1, clickCount: 1, modifiers: SHIFT });
      await t.mouse("mouseReleased", dg.r - 1, dg.y, { button: "left", buttons: 0, clickCount: 1, modifiers: SHIFT });
      await sleep(20); await shiftUp(); await sleep(250);
      assert.strictEqual((await selText()).trim(), "lazy dog", "Shift+щелчок расширил выделение (по словам)");
      // г) Ctrl+C — без перевода
      await ctrlKey("c", 67);
      assert.strictEqual(await nCalls(), n0, "Shift+щелчок и Ctrl+C не переводят");
      // д) поддельные события страницы
      await ev(`(() => {
        const p = document.querySelector("#p1");
        p.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }));
        document.dispatchEvent(new Event("selectionchange"));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
        return true; })()`);
      await sleep(300);
      assert.strictEqual(await nCalls(), n0, "поддельные события страницы не переводят");
      // чистое нажатие над выделением — перевод
      await tapShift();
      await sentSel(n0, "lazy dog", "чистое нажатие после всего этого");
      ok("как щелчок: пока Shift держат — ничего; нажали над выделением, отпустили не над ним (и наоборот) — ничего; Shift+щелчок, Shift+→ (п. 4), Ctrl+C и поддельные события — ничего; чистое нажатие — перевод");
    });

    // клавиша Ctrl: Ctrl+C над выделением — не перевод, чистый Ctrl — перевод
    await section(async () => {
      await load({ trigger: "ctrl" });
      await dbl(await word("#p1", "river"));
      await ctrlKey("c", 67); await sleep(100);
      assert.strictEqual(await nCalls(), 0, "Ctrl+C не переводит");
      await tapCtrl();
      await sentSel(0, "river", "чистый Ctrl над выделением");
      assert.strictEqual(await text("#p1"), P1);
      // Ctrl+A — выделение, а не перевод: ни над абзацем, ни над пустым местом (там нет и «слишком длинного»)
      await esc();
      const n1 = await nCalls();
      await moveTo(await box("#p2"));
      await ctrlA(); await sleep(300);
      assert.ok((await ev("String(document.getSelection()).length")) > 2000, "Ctrl+A выделил всю страницу");
      await moveTo({ x: 900, y: (await box("#p2")).y });
      await ctrlA(); await sleep(300);
      assert.strictEqual(await nCalls(), n1, "Ctrl+A не переводит");
      assert.deepStrictEqual(await ev("toasts()"), [], "Ctrl+A без уведомлений");
      assert.strictEqual(await text("#p2"), P2);
      ok("клавиша Ctrl: Ctrl+C над выделением не переводит, чистое нажатие Ctrl — переводит выделенное; Ctrl+A ничего не переводит");
    });

    // ---- 8. Способ показа «карточка» ----
    await section(async () => {
      await load({ displayMode: "popover" });
      await dbl(await word("#p1", "jumps"));
      await tapShift();
      await sentSel(0, "jumps", "карточка: Shift над выделенным словом");
      assert.strictEqual(await text("#p1"), P1);
      n0 = await nCalls();
      await moveTo(await box("#p3"));
      await tapShift();
      assert.ok(await until(async () => (await nCalls()) > n0, 2000));
      assert.deepStrictEqual((await tr()).slice(n0), [[[P3], "user-initiated"]], "курсор не над выделением — карточка абзаца под курсором");
      await moveTo(await box("#p2"));
      await shiftDown(); await sleep(20);
      await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39); await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39);
      await sleep(20); await shiftUp(); await sleep(150);
      assert.strictEqual(await selText(), "jumps ");
      n0 = await nCalls();
      await tapShift();
      await sentSel(n0, "jumps", "карточка: выделили с клавиатуры, курсор над другим абзацем");
      n0 = await nCalls();
      await moveTo(await box("#p2"));
      await ctrlA();
      await tapShift();
      assert.ok(await until(async () => (await nCalls()) > n0, 2000));
      assert.deepStrictEqual((await tr()).slice(n0), [[[P2], "user-initiated"]], "карточка: Ctrl+A, курсор над абзацем — абзац");
      ok("способ показа «карточка»: выделенное слово, блок не под выделением, выделенное с клавиатуры, Ctrl+A над абзацем — как при замене");
    });

    // ---- 9. Встроенное окно: решает фрейм под курсором ----
    await section(async () => {
      const frameStore = encodeURIComponent(JSON.stringify({ trigger: "shift" }));
      await load({}, "&frame=" + encodeURIComponent(srv.other + "/stub-frame.html?store=" + frameStore));
      await sleep(300);
      const frame = () => ev(`new Promise((res) => { const h = (e) => { if (e.data && e.data.calls) { removeEventListener("message", h); res(e.data); } };
        addEventListener("message", h); frEl().contentWindow.postMessage("report", "*"); })`);
      const frameTr = async () => /^\[RU\]/.test((await frame()).text);
      const fr = await ev("(({ left, top }) => ({ x: Math.round(left), y: Math.round(top) }))(frEl().getBoundingClientRect())");
      const onFrameText = { x: fr.x + 60, y: fr.y + 25 }, onFrameEmpty = { x: fr.x + 60, y: fr.y + 95 };
      // а) выделение на странице, фокус во встроенном окне (щелчок по нему), курсор над выделением страницы
      await dbl(await word("#p1", "fox"));
      await moveTo(onFrameEmpty);
      await t.mouse("mousePressed", onFrameEmpty.x, onFrameEmpty.y, { button: "left", buttons: 1, clickCount: 1 });
      await t.mouse("mouseReleased", onFrameEmpty.x, onFrameEmpty.y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(150);
      assert.strictEqual(await ev("document.activeElement && document.activeElement.id"), "fr", "фокус во встроенном окне");
      assert.strictEqual(await selText(), "fox", "выделение страницы на месте");
      await moveTo(await word("#p1", "fox")); await sleep(100);
      await tapShift(); await sleep(150);
      assert.ok((await frame()).calls.includes("frameKey"), "окно с фокусом переслало нажатие");
      await sentSel(0, "fox", "фокус в окне, курсор над выделением страницы");
      assert.strictEqual(await text("#p1"), P1, "абзац страницы не заменён");
      assert.ok(!(await frameTr()));
      // б) выделение на странице, курсор над текстом окна — текст окна
      await dbl(await word("#p1", "fox"));                  // фокус снова на странице
      await moveTo(onFrameText); await sleep(150);
      n0 = await nCalls();
      await tapShift(); await sleep(150);
      assert.ok(await until(frameTr, 2000), "курсор над текстом окна — переводится он");
      assert.strictEqual(await nCalls(), n0, "выделение страницы не переводится");
      await tapShift(); await sleep(150);
      assert.ok(!(await frameTr()));
      // в) выделили с клавиатуры на странице, курсор так и стоит над текстом окна — выделенное страницы
      await shiftRight(4);
      assert.strictEqual(await selText(), "fox jum");
      const fc = (await frame()).calls.filter((c) => c === "translateBatch").length;
      await tapShift(); await sleep(150);
      await sentSel(n0, "fox jum", "выделили с клавиатуры на странице, курсор над окном");
      assert.ok(!(await frameTr()) && (await frame()).calls.filter((c) => c === "translateBatch").length === fc, "окно ничего не переводит");
      ok("встроенное окно: фокус в окне, курсор над выделением страницы — выделенное страницы; курсор над текстом окна — он, а не выделение страницы; выделили с клавиатуры — выделенное, хотя курсор над окном");
    });

    // ---- 10. Режим «Без клавиши»: под курсором выделение или зажата кнопка — абзац по задержке не переводится ----
    await section(async () => {
      await load({ trigger: "dwell", dwellMs: 150 });
      const qk = await word("#p1", "quick");
      await dbl(qk);                                        // курсор пришёл и сразу двойной щелчок: таймер уже взведён
      await sleep(500);
      assert.strictEqual(await selText(), "quick", "слово выделено, абзац не заменён переводом по задержке");
      assert.strictEqual(await nCalls(), 0, "курсор над выделением — абзац не переводится");
      await move(qk.x + 2, qk.y + 1); await sleep(400);
      assert.strictEqual(await nCalls(), 0, "и при движении над выделением");
      await tapShift(); await sleep(200);
      assert.strictEqual(await nCalls(), 0, "Shift в этом режиме выделенное не переводит");
      // кнопка зажата: протяжка с пустого места на абзац и задержка на нём
      const p3 = await box("#p3");
      await move(p3.l - 10, p3.t - 8); await sleep(50);
      await t.mouse("mousePressed", p3.l - 10, p3.t - 8, { button: "left", buttons: 1, clickCount: 1 });
      for (const dx of [20, 60, 100, 140]) { await move(p3.l + dx, p3.y, { button: "left", buttons: 1 }); await sleep(30); }
      await sleep(500);
      assert.strictEqual(await text("#p3"), P3, "кнопка зажата — абзац не переводится");
      assert.strictEqual(await nCalls(), 0);
      await t.mouse("mouseReleased", p3.l + 140, p3.y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(400);
      assert.strictEqual(await nCalls(), 0, "отпустили над выделенным — тоже нет");
      // курсор ушёл с выделения — задержка снова работает
      await moveTo({ x: Math.round(p3.l + 400), y: p3.y });
      assert.ok(await until(async () => (await text("#p3")) === RU(P3), 2000), "курсор ушёл с выделения — абзац по задержке: " + await text("#p3"));
      ok("режим «Без клавиши»: курсор над выделенным (и сразу после двойного щелчка) или зажата кнопка мыши — абзац по задержке не переводится, Shift выделенное не переводит; курсор ушёл с выделения — задержка работает");
    });

    if (failed.length) throw new Error("упало разделов: " + failed.length + ", прошло: " + pass);
    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
