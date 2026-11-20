// Клавиша-триггер, окно в окне и окно того же сайта: content.js в Chrome без интерфейса на fixtures/stub.html.
// Как в page/frames.test.js: у каждого фрейма своя заглушка chrome.*, сообщения «всем фреймам вкладки» (hoverFrame,
// frameKey) рассылают заглушки через postMessage — среднее окно передаёт их и вверх, и вложенному
// (stub-frame.html?frame=…). Настоящие события — Input.dispatch* (isTrusted = true): клавиши получает фрейм с фокусом,
// мышь — фрейм под курсором.
// Проверяет. Окно в окне (три разных сайта: 127.0.0.1, localhost, third.test): фокус на странице, курсор с абзаца
// страницы через текст среднего окна ушёл на текст вложенного — Shift переводит текст вложенного окна (не среднего и не
// абзац страницы), второй Shift возвращает оригинал; фокус во вложенном окне — Shift над текстом страницы переводит его,
// над текстом среднего окна — текст среднего. Окно того же сайта (страница при заходе курсора в него видит mouseout с
// абзаца и mouseover на <iframe>): Shift переводит текст окна один раз и не трогает страницу; Shift сразу после захода
// курсора, раньше, чем дошло сообщение окна (hoverFrame), — тоже текст окна; обратно — фокус в окне, курсор над текстом
// страницы — текст страницы; окно без нашего скрипта (about:blank, srcdoc) — Shift над ним не переводит абзац страницы,
// с которого курсор ушёл.
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
const RU = /^\[RU\]/;

(async () => {
  const srv = await serve();
  // Третий сайт для вложенного окна: имя, которое Chrome отправит на тот же сервер.
  const third = srv.base.replace("127.0.0.1", "third.test");
  const b = await launch({ extraArgs: ["--host-resolver-rules=MAP third.test 127.0.0.1"] });
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1200, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const store = { trigger: "shift" };
    const S = encodeURIComponent(JSON.stringify(store));
    const frameUrl = (origin, inner) => origin + "/stub-frame.html?store=" + S + (inner ? "&frame=" + encodeURIComponent(inner) : "");
    // отчёт встроенного окна: { calls, text, fp, fr2, act, inner: отчёт вложенного }
    const frame = () => ev(`new Promise((res) => { const h = (e) => { if (e.data && e.data.calls) { removeEventListener("message", h); res(e.data); } };
      addEventListener("message", h); document.querySelector("#fr").contentWindow.postMessage("report", "*"); })`);
    // report: false — в окне нет заглушки (и нашего скрипта), отчёта не будет
    const load = async (url, height, report = true) => {
      await t.cmd("Page.navigate", { url: srv.base + "/stub.html?store=" + S + "&frame=" + encodeURIComponent(url) });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await ev(`document.querySelector("#fr").style.height = "${height}px"; true`);
      if (report) await until(async () => { const r = await frame().catch(() => null); return r && (!r.fr2 || r.inner); }, 5000);
      await sleep(400);
    };
    const move = (x, y) => t.mouse("mouseMoved", x, y);
    const key = (type, modifiers) => t.cmd("Input.dispatchKeyEvent", { type, key: "Shift", code: "ShiftLeft", modifiers, windowsVirtualKeyCode: 16 });
    const tapShift = async () => { await key("rawKeyDown", SHIFT); await sleep(30); await key("keyUp", 0); await sleep(300); };
    const click = async (x, y) => { await move(x, y); await sleep(30); await t.mouse("mousePressed", x, y, { button: "left", clickCount: 1 }); await t.mouse("mouseReleased", x, y, { button: "left", clickCount: 1 }); await sleep(100); };
    const hover = async (p) => { await move(p.x, p.y); await sleep(30); await move(p.x + 2, p.y + 1); await sleep(80); };
    const topPoint = (sel) => ev(`(({ left, top, height }) => ({ x: Math.round(left) + 40, y: Math.round(top + height / 2) }))(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`);
    const topText = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const count = (calls, type) => calls.filter((c) => c === type).length;

    // ---- 1–2. Окно в окне: страница (127.0.0.1) → среднее окно (localhost) → вложенное (third.test) ----
    await load(frameUrl(srv.other, frameUrl(third)), 320);
    let r = await frame();
    assert.ok(r.inner && r.inner.anc.length === 2 && r.inner.anc[0] === srv.other && r.inner.anc[1] === srv.base, "вложенное окно с третьего сайта внутри среднего: " + JSON.stringify(r.inner && r.inner.anc));
    // точки в координатах страницы: у #fr рамка в 1px, у #fr2 рамки нет
    const fr = await ev(`(({ left, top }) => ({ x: Math.round(left) + 1, y: Math.round(top) + 1 }))(document.querySelector("#fr").getBoundingClientRect())`);
    const midText = { x: fr.x + r.fp.x + 40, y: fr.y + r.fp.y + Math.round(r.fp.h / 2) };
    const inner0 = { x: fr.x + r.fr2.x, y: fr.y + r.fr2.y };
    const innerText = { x: inner0.x + r.inner.fp.x + 40, y: inner0.y + r.inner.fp.y + Math.round(r.inner.fp.h / 2) };
    const innerEmpty = { x: inner0.x + r.inner.fp.x + 40, y: inner0.y + r.inner.fp.y + r.inner.fp.h + 40 };
    assert.ok(innerEmpty.y < inner0.y + r.fr2.h - 10, "под текстом вложенного окна есть пустое место");

    await move(990, 1190); await sleep(50);
    await hover(await topPoint("#p2"));
    await hover(midText);
    await hover(innerText);
    await tapShift();
    r = await frame();
    assert.ok(RU.test(r.inner.text), "Shift над текстом вложенного окна переводит его: " + JSON.stringify(r.inner));
    assert.strictEqual(count(r.inner.calls, "translateBatch"), 1, "один запрос перевода");
    assert.ok(!RU.test(r.text) && count(r.calls, "translateBatch") === 0, "текст среднего окна не переводится");
    assert.strictEqual(await ev("trCalls().length"), 0, "абзац страницы не переводится");
    assert.strictEqual(await ev("typeCalls('frameKey').length"), 1, "страница (фокус у неё) переслала нажатие");
    await tapShift();
    r = await frame();
    assert.ok(!RU.test(r.inner.text) && count(r.inner.calls, "translateBatch") === 1, "второй Shift возвращает оригинал");
    ok("окно в окне (три сайта), фокус на странице, курсор над текстом вложенного окна: Shift переводит его (не среднее окно и не абзац страницы), второй Shift — оригинал");

    await click(innerEmpty.x, innerEmpty.y);
    r = await frame();
    assert.ok(await ev("document.activeElement && document.activeElement.id") === "fr" && r.act === "fr2" && r.inner.focus, "фокус во вложенном окне: " + JSON.stringify({ act: r.act, inner: r.inner.focus }));
    await hover(await topPoint("#p1"));
    await tapShift();
    r = await frame();
    assert.ok(RU.test(await topText("#p1")), "Shift переводит текст страницы под курсором");
    assert.strictEqual(count(r.inner.calls, "frameKey"), 1, "вложенное окно (фокус у него) переслало нажатие");
    assert.ok(!RU.test(r.text) && !RU.test(r.inner.text), "в окнах ничего не переведено");
    await hover(midText);
    await tapShift();
    r = await frame();
    assert.ok(RU.test(r.text), "курсор над текстом среднего окна — Shift переводит его: " + JSON.stringify(r));
    assert.ok(!RU.test(r.inner.text) && count(r.inner.calls, "translateBatch") === 1, "вложенное окно не тронуто");
    assert.strictEqual(await ev("trCalls().length"), 1, "на странице — только прежний перевод #p1");
    ok("фокус во вложенном окне: Shift над текстом страницы переводит его, над текстом среднего окна — текст среднего окна");

    // ---- 3–5. Встроенное окно того же сайта ----
    await load(frameUrl(srv.base), 120);
    r = await frame();
    assert.strictEqual(r.anc[0], srv.base, "окно того же сайта");
    const fr1 = await ev(`(({ left, top }) => ({ x: Math.round(left) + 1, y: Math.round(top) + 1 }))(document.querySelector("#fr").getBoundingClientRect())`);
    const sameText = { x: fr1.x + r.fp.x + 40, y: fr1.y + r.fp.y + Math.round(r.fp.h / 2) };
    const sameEmpty = { x: fr1.x + r.fp.x + 40, y: fr1.y + r.fp.y + r.fp.h + 30 };
    await ev(`window.__seen = []; for (const ty of ["mouseout", "mouseover"]) document.addEventListener(ty, (e) => __seen.push(ty + ":" + (e.target.id || e.target.tagName)), true); true`);
    await move(990, 1190); await sleep(50);
    await hover(await topPoint("#p2"));
    await ev("__seen.length = 0; true");
    await hover(sameText);
    assert.deepStrictEqual(await ev("__seen"), ["mouseout:p2", "mouseover:fr"], "страница видит уход курсора в окно того же сайта");
    await tapShift();
    r = await frame();
    assert.ok(RU.test(r.text) && count(r.calls, "translateBatch") === 1, "Shift переводит текст окна один раз: " + JSON.stringify(r));
    assert.strictEqual(await ev("trCalls().length"), 0, "абзац страницы не переводится");
    await tapShift();
    r = await frame();
    assert.ok(!RU.test(r.text) && count(r.calls, "translateBatch") === 1, "второй Shift — оригинал");
    ok("окно того же сайта (страница видит mouseout с абзаца и mouseover на <iframe>): Shift переводит текст окна один раз, абзац страницы не трогает; второй Shift — оригинал");

    // Сообщение окна о курсоре (hoverFrame) идёт через background и может опоздать: Shift нажали и отпустили сразу.
    await hover(await topPoint("#p2"));
    await ev("__tabDelay = 150; true");
    await move(sameText.x, sameText.y);
    await key("rawKeyDown", SHIFT); await sleep(30); await key("keyUp", 0);
    await sleep(700);
    r = await frame();
    assert.strictEqual(await ev("trCalls().length"), 0, "абзац страницы, с которого курсор ушёл, не переводится");
    assert.ok(RU.test(r.text) && count(r.calls, "translateBatch") === 2, "Shift сразу после захода курсора в окно того же сайта переводит текст окна: " + JSON.stringify(r));
    await tapShift(); await sleep(300);
    assert.ok(!RU.test((await frame()).text), "и обратно");
    await ev("__tabDelay = 0; true");
    ok("окно того же сайта: Shift сразу после захода курсора, раньше сообщения окна, переводит текст окна, а не абзац страницы");

    await click(sameEmpty.x, sameEmpty.y);
    assert.strictEqual(await ev("document.activeElement && document.activeElement.id"), "fr", "фокус в окне");
    await hover(await topPoint("#p1"));
    await tapShift();
    r = await frame();
    assert.ok(RU.test(await topText("#p1")) && await ev("trCalls().length") === 1, "Shift переводит текст страницы под курсором");
    assert.ok(!RU.test(r.text) && count(r.calls, "translateBatch") === 2 && count(r.calls, "frameKey") === 1, "окно переслало нажатие, у себя ничего не перевело: " + JSON.stringify(r.calls));
    ok("окно того же сайта, фокус в нём, курсор над текстом страницы: Shift переводит текст страницы");

    // ---- 6. Окно того же сайта без нашего скрипта: about:blank и srcdoc (у расширения нет match_about_blank) ----
    // Сообщения о курсоре от такого окна не будет никогда; mouseover на <iframe> — единственное, что знает страница.
    await load(srv.base + "/index.html", 120, false);
    const fr3 = await ev(`(({ left, top }) => ({ x: Math.round(left) + 1, y: Math.round(top) + 1 }))(document.querySelector("#fr").getBoundingClientRect())`);
    await hover(await topPoint("#p2"));
    await hover({ x: fr3.x + 60, y: fr3.y + 32 });   // над первым абзацем index.html (отступ 20px)
    await sleep(300);
    await tapShift();
    assert.strictEqual(await ev("trCalls().length"), 0, "абзац страницы, с которого курсор ушёл в окно, не переводится");
    assert.ok(!RU.test(await topText("#p2")));
    ok("окно того же сайта без нашего скрипта (about:blank, srcdoc): Shift над ним не переводит абзац страницы, с которого курсор ушёл");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
