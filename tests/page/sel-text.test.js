// Перевод выделенного — что переводится: content.js в Chrome без интерфейса на тестовой странице с заглушкой chrome.*
// (fixtures/sel-text.html). Выделение мышью и чистое нажатие Shift над ним (настоящие события Input.dispatch*).
// Переводчику уходит видимый текст выделения по абзацам: без текста для экранных дикторов, скрытого, подсказок
// чтения <rt>; выделение в открытом веб-компоненте (getComposedRanges) — тоже, в закрытом и без getComposedRanges
// (Chrome до 137) — нет. Не в счёт: без букв, в редакторе и поле ввода, в наших окнах. Язык для встроенного:
// по выделению, короткий отрывок — по абзацу той же письменности. Выделенное уже на языке перевода — уведомление
// «Переводить нечего», переводчику ничего не уходит.
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
const COMP = (id) => `document.getElementById("comp").shadowRoot.getElementById(${JSON.stringify(id)})`;
const BY = (id) => `document.getElementById(${JSON.stringify(id)})`;

(async () => {
  const srv = await serve();
  const PAGE = srv.base + "/sel-text.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store, extra) => {
      await t.cmd("Page.navigate", { url: PAGE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) + (extra || "") });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const items = () => ev("trCalls().map((c) => c.items)");
    // Точки для выделения мышью: левый край первого знака sub (без sub — первого видимого знака элемента) и правый край
    // последнего. el — выражение, дающее элемент (и внутри открытого shadow root).
    const pts = (el, sub) => ev(`(() => {
      const el = ${el}, sub = ${JSON.stringify(sub || "")};
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = []; for (let n; (n = w.nextNode());) if (n.nodeValue.trim()) nodes.push(n);
      let a, ai, z, zi;
      if (sub) { a = z = nodes.find((n) => n.nodeValue.includes(sub)); ai = a.nodeValue.indexOf(sub); zi = ai + sub.length - 1; }
      else { a = nodes[0]; ai = a.nodeValue.search(/\\S/); z = nodes[nodes.length - 1]; zi = z.nodeValue.trimEnd().length - 1; }
      const box = (n, i) => { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect(); };
      const ra = box(a, ai), rz = box(z, zi);
      return { x1: Math.round(ra.left + 1), y1: Math.round((ra.top + ra.bottom) / 2), x2: Math.round(rz.right - 1), y2: Math.round((rz.top + rz.bottom) / 2) };
    })()`);
    // Выделить мышью: нажать, вести с зажатой кнопкой, отпустить — курсор остаётся над концом выделения.
    const drag = async (x1, y1, x2, y2) => {
      await t.mouse("mouseMoved", x1, y1); await sleep(30);
      await t.mouse("mousePressed", x1, y1, { button: "left", clickCount: 1 });
      for (let i = 1; i <= 6; i++) { await t.mouse("mouseMoved", Math.round(x1 + (x2 - x1) * i / 6), Math.round(y1 + (y2 - y1) * i / 6), { button: "left", buttons: 1 }); await sleep(15); }
      await t.mouse("mouseReleased", x2, y2, { button: "left", clickCount: 1 });
      await sleep(80);
    };
    const select = async (el, sub) => { const p = await pts(el, sub); await drag(p.x1, p.y1, p.x2, p.y2); };
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(150); };
    // Выделить и нажать Shift — что ушло переводчику (первый вызов translateBatch).
    const sent = async (el, sub) => {
      await select(el, sub);
      await tapShift();
      await until(async () => (await ev("trCalls().length")) > 0, 3000);
      return (await items())[0] || null;
    };
    const quiet = async (ms = 500) => { await sleep(ms); return ev("trCalls().length"); };

    // Каждый пункт — со своей страницы: не прошёл — пишем и идём дальше (видно, какие пункты падают), итог — в конце.
    const failed = [];
    const step = async (name, fn) => {
      try { await fn(); ok(name); } catch (e) { failed.push(name); console.log("  FAIL " + name + "\n       " + String(e && e.message || e).split("\n").join("\n       ")); }
    };
    const sentAfter = async () => {
      await tapShift();
      assert.ok(await until(async () => (await ev("trCalls().length")) > 0, 3000), "перевод не ушёл: " + JSON.stringify(await ev("toasts()")));
      return (await items())[0];
    };

    // ---- 8. Видимый текст по абзацам ----
    await step("8: без текста для экранных дикторов (.sr-only: clip: rect, 1×1 px)", async () => {
      await load();
      assert.deepStrictEqual(await sent(BY("sr")), ["Press the green button to continue with your order."]);
      assert.ok(await until(() => ev("cards().length === 1"), 2000), "карточка у выделения");
    });
    await step("8: без скрытого: clip-path: inset(50%), display: none, visibility: hidden, за левым краем страницы", async () => {
      await load();
      assert.deepStrictEqual(await sent(BY("hid")), ["Visible words here and the end of line."]);
    });
    await step("8: без подсказок чтения над иероглифами (<rt>, <rp>)", async () => {
      await load();
      assert.deepStrictEqual(await sent(BY("ruby")), ["The word 漢字 means Chinese characters in Japanese writing."]);
    });
    await step("8: абзацы, перенос <br>, пункт списка и строки white-space: pre-line — отдельными кусками", async () => {
      await load();
      const a = await pts(BY("m1")), z = await pts(BY("m3"));
      await drag(a.x1, a.y1, z.x2, z.y2);
      assert.deepStrictEqual(await sentAfter(), ["First paragraph of the selected passage is here.", "Second paragraph follows it",
        "and has a line break inside.", "A list item that ends the passage."]);
      await load();
      assert.deepStrictEqual(await sent(BY("poem")), ["Roses are red in the garden,", "violets are blue near the fence."], "перевод строки в white-space: pre-line");
    });
    await step("8: блоки — по вычисленному display: <span> во flex-строке — отдельные куски", async () => {
      await load();
      const a = await pts(BY("fa")), z = await pts(BY("fb"));
      await drag(a.x1, a.y1, z.x2, z.y2);
      assert.deepStrictEqual(await sentAfter(), ["Left column text", "Right column text"]);
    });

    // ---- 9. Веб-компоненты ----
    await step("9: выделенное в открытом веб-компоненте (getComposedRanges); в нашей карточке — не в счёт (4)", async () => {
      await load();
      assert.deepStrictEqual(await sent(COMP("c1"), "inside an open web"), ["inside an open web"], "выделенное в открытом shadow root");
      assert.ok(await until(() => ev("cards().length === 1"), 2000), "карточка у выделения в компоненте");
      // Выделить текст в нашей карточке и нажать Shift над ним — ничего нового
      const p = await ev(`(() => { const r = cards()[0]; const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode());) if (n.nodeValue.includes("inside an open")) { const g = document.createRange(); g.selectNodeContents(n);
          const b = g.getBoundingClientRect(); return { x1: Math.round(b.left + 1), x2: Math.round(b.right - 1), y: Math.round((b.top + b.bottom) / 2) }; }
        return null; })()`);
      assert.ok(p, "в карточке есть перевод");
      await drag(p.x1, p.y, p.x2, p.y);
      await tapShift();
      assert.strictEqual(await quiet(), 1, "выделенное в нашей карточке не переводится: " + JSON.stringify(await items()));
    });
    await step("9: выделение из компонента на страницу — начало в shadow root, конец снаружи; закрытый компонент и textarea — без текста", async () => {
      await load();
      const a = await pts(COMP("c2"), "line of"), z = await pts(BY("tail"), "Last paragraph");
      await drag(a.x1, a.y1, z.x2, z.y2);
      const got = await sentAfter();
      assert.strictEqual(got[0], "line of the component.", "начало — в компоненте: " + JSON.stringify(got));
      assert.strictEqual(got[got.length - 1], "Last paragraph", "конец — на странице: " + JSON.stringify(got));
      assert.ok(!got.some((s) => /closed web component|textarea box/.test(s)), "без текста закрытого компонента и textarea: " + JSON.stringify(got));
    });
    await step("9: закрытый компонент и Chrome без getComposedRanges — выделенное в компоненте не переводится", async () => {
      await load();
      // в закрытый root обходом не попасть — по коробке хоста: текст в его первой строке
      const r = await ev(`(() => { const b = ${BY("lock")}.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top + 10) }; })()`);
      await drag(r.x + 2, r.y, r.x + 260, r.y);
      assert.ok(/closed web/.test(await ev("getSelection().toString()")), "выделено в закрытом компоненте");
      await tapShift();
      await sleep(400);
      assert.ok(!(await items()).some((x) => x.some((s) => /closed web/.test(s))), "текст закрытого компонента не уходит: " + JSON.stringify(await items()));
      await load({}, "&nocomposed=1");
      await select(COMP("c1"), "inside an open web");
      await tapShift();
      await sleep(400);
      assert.ok(!(await items()).some((x) => x.length === 1 && x[0] === "inside an open web"), "без getComposedRanges — не выделенное: " + JSON.stringify(await items()));
    });

    // ---- 4. Что не в счёт ----
    await step("4: выделение без букв и в редакторе (Shift) — ничего", async () => {
      await load();
      await select(BY("digits"));
      await tapShift();
      assert.strictEqual(await quiet(), 0, "без букв — ничего");
      await select(BY("editor"), "notes written");
      assert.strictEqual(await ev("document.activeElement.id"), "editor", "фокус в редакторе");
      await tapShift();
      assert.strictEqual(await quiet(), 0, "Shift в редакторе — ничего");
    });
    // пункт меню переводит выделенное и без клавиши — выделенное в редакторе и поле всё равно не в счёт
    await step("4: выделенное в редакторе (contenteditable) и поле ввода не переводится и пунктом меню", async () => {
      await load();
      await select(BY("editor"), "notes written");
      await ev("sendCmd({ type: 'translateSelection', text: 'notes written' }); true");
      assert.strictEqual(await quiet(), 0, "редактор: " + JSON.stringify(await items()));
      await ev("document.getElementById('field').focus(); document.getElementById('field').setSelectionRange(0, 10); true");
      await ev("sendCmd({ type: 'translateSelection', text: 'Text typed' }); true");
      assert.strictEqual(await quiet(), 0, "поле: " + JSON.stringify(await items()));
    });

    // ---- 11. Язык для встроенного переводчика ----
    // С какой пары языков создавался встроенный переводчик (перевод на английский).
    const lang = async (el, sub) => {
      await load({ engine: "chrome", targetLang: "EN-US" });
      await select(el, sub);
      await tapShift();
      await until(() => ev("__created.length > 0"), 3000);
      return [await ev("__created.slice()"), JSON.stringify(await ev("({ toasts: toasts(), sel: getSelection().toString() })"))];
    };
    await step("11: встроенный — короткий отрывок на другой письменности, чем абзац, — по нему самому", async () => {
      const [got, why] = await lang(BY("quote"), "большое спасибо");
      assert.deepStrictEqual(got, ["ru>en"], why);
    });
    await step("11: встроенный — короткий отрывок по абзацу той же письменности; длинное выделение — по нему самому", async () => {
      let [got, why] = await lang(BY("dePara"), "Wetter");
      assert.deepStrictEqual(got, ["de>en"], why);
      [got, why] = await lang(BY("dePara"));
      assert.deepStrictEqual(got, ["de>en"], why);
      assert.ok(await until(() => ev("cards().length === 1"), 2000), "карточка");
    });

    // ---- 12. Уже на языке перевода ----
    const same = async (el, sub, store) => {
      await load(store);
      await select(el, sub);
      await tapShift();
      const tx = await until(async () => (await ev("toasts()")).find((s) => /Выделенное уже на языке перевода/.test(s)), 3000);
      assert.ok(tx, "уведомление: " + JSON.stringify(await ev("toasts()")) + ", ушло: " + JSON.stringify(await items()));
      assert.ok(/Переводить нечего/.test(tx) && /\(русский\)/.test(tx), "заголовок и язык: " + tx);
      assert.strictEqual(await quiet(200), 0, "переводчику ничего не ушло");
      assert.strictEqual(await ev("cards().length"), 0, "карточки нет");
    };
    await step("12: выделенное уже на языке перевода — «Переводить нечего», переводчику ничего не уходит", async () => {
      await same(BY("ruLong"), "написан по-русски и достаточно длинный");
      await same(BY("ruPara"), "хороший код");            // короткий — по абзацу
      await same(BY("quote"), "большое спасибо");         // короткий на другой письменности — по нему самому
      await same(BY("enShort"), "good code", { sourceLang: "RU" });   // язык оригинала из настроек
      await load();
      assert.deepStrictEqual(await sent(BY("enWord"), "good code"), ["good code"], "английский отрывок в английском абзаце переводится");
    });

    assert.deepStrictEqual(failed, [], "не прошли: " + failed.length);
    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
