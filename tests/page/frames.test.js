// Клавиша-триггер и встроенное окно (iframe): content.js в Chrome без интерфейса на fixtures/stub.html со встроенным
// окном с другого адреса (fixtures/stub-frame.html). У каждого фрейма своя заглушка chrome.*; «как background»
// (всем фреймам вкладки) сообщения hoverFrame и frameKey рассылают заглушки через postMessage, саму пересылку
// в background.js проверяет unit/background-errors.test.js. Настоящие события — Input.dispatch* (isTrusted = true):
// клавиши получает фрейм с фокусом, мышь — фрейм под курсором.
// Проверяет: фокус на странице, курсор с абзаца страницы ушёл на текст встроенного окна — Shift переводит текст окна
// (а не абзац, с которого курсор ушёл: страница ухода не видит), второй Shift возвращает оригинал; Shift зажали над
// пустым местом окна и повели курсор на текст — ничего ни пока держат, ни по отпусканию (как щелчок); поддельные
// клавиши и postMessage страницы ничего не переводят; фокус в поле ввода страницы — Shift для поля; обратный случай:
// фокус во встроенном окне, курсор над текстом страницы — Shift переводит текст страницы.
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
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const store = { trigger: "shift" };
    const frameUrl = srv.other + "/stub-frame.html?store=" + encodeURIComponent(JSON.stringify(store));
    await t.cmd("Page.navigate", { url: srv.base + "/stub.html?store=" + encodeURIComponent(JSON.stringify(store)) + "&frame=" + encodeURIComponent(frameUrl) });
    await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
    await sleep(500);

    const move = (x, y, modifiers = 0) => t.mouse("mouseMoved", x, y, { modifiers });
    const key = (type, modifiers) => t.cmd("Input.dispatchKeyEvent", { type, key: "Shift", code: "ShiftLeft", modifiers, windowsVirtualKeyCode: 16 });
    const tapShift = async () => { await key("rawKeyDown", SHIFT); await sleep(30); await key("keyUp", 0); await sleep(300); };
    // что во встроенном окне: { calls: типы сообщений в background, text: текст #fp }
    const frame = () => ev(`new Promise((res) => { const h = (e) => { if (e.data && e.data.calls) { removeEventListener("message", h); res(e.data); } };
      addEventListener("message", h); document.querySelector("#fr").contentWindow.postMessage("report", "*"); })`);
    const frameTr = async () => /^\[RU\]/.test((await frame()).text);
    const frameCalls = async (type) => (await frame()).calls.filter((c) => c === type).length;
    // встроенное окно целиком в окне (высота 1000): точки ниже края окна до встроенного окна не доходят
    const fr = await ev(`(({ left, top }) => ({ x: Math.round(left), y: Math.round(top) }))(document.querySelector("#fr").getBoundingClientRect())`);
    const onFrameText = { x: fr.x + 60, y: fr.y + 25 };     // над #fp во встроенном окне
    const onFrameEmpty = { x: fr.x + 60, y: fr.y + 95 };    // во встроенном окне, под текстом
    const toFrameText = async (modifiers = 0) => { await move(onFrameText.x, onFrameText.y, modifiers); await sleep(30); await move(onFrameText.x + 2, onFrameText.y + 1, modifiers); await sleep(80); };

    // ---- 1. Фокус на странице, курсор с абзаца страницы ушёл на текст встроенного окна ----
    // (страница ухода курсора во встроенное окно не видит: без сообщения от окна Shift перевёл бы #p2)
    const p2 = await ev(`(({ left, top, height }) => ({ x: Math.round(left) + 40, y: Math.round(top + height / 2) }))(document.querySelector("#p2").getBoundingClientRect())`);
    await move(990, 990); await sleep(50);
    await move(p2.x, p2.y); await sleep(30); await move(p2.x + 2, p2.y + 1); await sleep(50);
    await toFrameText();
    await tapShift();
    assert.strictEqual(await ev("trCalls().length"), 0, "абзац страницы, с которого курсор ушёл, не переводится");
    assert.ok(await frameTr(), "Shift над текстом встроенного окна переводит его: " + JSON.stringify(await frame()));
    assert.strictEqual(await frameCalls("translateBatch"), 1);
    assert.strictEqual(await ev("typeCalls('frameKey').length"), 1, "страница попросила background переслать нажатие");
    await tapShift();
    assert.ok(!(await frameTr()), "второй Shift возвращает оригинал");
    ok("фокус на странице, курсор с абзаца страницы ушёл на текст встроенного окна: Shift переводит текст окна, а не абзац страницы (hoverFrame, frameKey через background), второй Shift возвращает оригинал");

    // ---- 2. Пока Shift держат, текст окна не переводится; нажали над пустым местом и повели на текст — отпускание
    //         тоже ничего (как щелчок: нажали над одним, отпустили над другим) ----
    await move(onFrameEmpty.x, onFrameEmpty.y); await sleep(80);
    await key("rawKeyDown", SHIFT); await sleep(30);
    await toFrameText(SHIFT); await sleep(200);
    assert.ok(!(await frameTr()), "зажатый Shift и курсор на текст окна — пока держат, перевода нет");
    await key("keyUp", 0); await sleep(300);
    assert.ok(!(await frameTr()), "нажали над пустым местом, отпустили над текстом — не перевод");
    assert.strictEqual(await frameCalls("translateBatch"), 1);
    await tapShift();
    assert.ok(await frameTr(), "чистое нажатие над текстом окна — перевод");
    assert.strictEqual(await frameCalls("translateBatch"), 2);
    await tapShift();
    assert.ok(!(await frameTr()), "ещё раз — оригинал");
    ok("Shift зажали над пустым местом окна и повели на текст — ничего ни пока держат, ни по отпусканию; чистое нажатие над текстом — перевод");

    // ---- 3. Поддельные клавиши и postMessage страницы — ничего ----
    const keysBefore = await ev("typeCalls('frameKey').length");
    await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true })); true`);
    await ev(`document.querySelector("#fr").contentWindow.postMessage({ type: "frameKey", at: Date.now() - 50 }, "*"); true`);
    await sleep(300);
    assert.strictEqual(await ev("typeCalls('frameKey').length"), keysBefore, "поддельное нажатие страницы background не беспокоит");
    assert.ok(!(await frameTr()) && (await frameCalls("translateBatch")) === 2, "и ничего не переводит");
    ok("поддельные keydown/keyup страницы (isTrusted = false) и postMessage { type: frameKey } во встроенное окно ничего не переводят");

    // ---- 4. Фокус в поле ввода страницы — Shift для поля ----
    await ev("document.querySelector('#inp').focus(); true");
    await toFrameText();
    await tapShift();
    assert.ok(!(await frameTr()), "фокус в поле ввода — Shift не переводит");
    assert.strictEqual(await ev("typeCalls('frameKey').length"), keysBefore);
    await ev("document.querySelector('#inp').blur(); true");
    ok("фокус в поле ввода страницы, курсор над текстом встроенного окна — Shift для поля, не для перевода");

    // ---- 5. Обратно: фокус во встроенном окне, курсор над текстом страницы ----
    await move(onFrameEmpty.x, onFrameEmpty.y); await sleep(30);
    await t.mouse("mousePressed", onFrameEmpty.x, onFrameEmpty.y, { button: "left", clickCount: 1 });
    await t.mouse("mouseReleased", onFrameEmpty.x, onFrameEmpty.y, { button: "left", clickCount: 1 });
    await sleep(100);
    assert.strictEqual(await ev("document.activeElement && document.activeElement.id"), "fr", "фокус во встроенном окне");
    const p1 = await ev(`(({ left, top, height }) => ({ x: Math.round(left) + 40, y: Math.round(top + height / 2) }))(document.querySelector("#p1").getBoundingClientRect())`);
    await move(p1.x, p1.y); await sleep(30); await move(p1.x + 2, p1.y + 1); await sleep(80);
    await tapShift();
    assert.strictEqual(await frameCalls("frameKey"), 1, "встроенное окно (с фокусом) попросило background переслать нажатие");
    assert.ok(/^\[RU\]/.test(await ev("document.querySelector('#p1').textContent")), "Shift переводит текст страницы под курсором");
    assert.ok(!(await frameTr()), "во встроенном окне ничего не переведено");
    ok("фокус во встроенном окне, курсор над текстом страницы: Shift переводит текст страницы");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
