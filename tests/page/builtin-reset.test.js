// Испорченный встроенный переводчик: в Chrome 157 после загрузки другой языковой модели уже созданные
// экземпляры Translator отвечают UnknownError «Other generic failures occurred» до перезагрузки страницы,
// а новый экземпляр той же пары работает. content.js должен выбросить такой экземпляр из кэша и
// повторить один раз с новым. Заглушка — fixtures/stub-builtin.html (file://), Translator.create обёрнут здесь.
const assert = require("assert");
const { launch, filePage, sleep, until } = require("../lib/chrome");
const { rmDir } = require("../lib/env");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// «Событие» (__tr.gen++) портит все уже созданные экземпляры; __tr.fail — ошибка, которую бросают все, и новые тоже.
const BREAKABLE = `__tr.gen = 0; __tr.fail = ''; __tr.inputs = [];
  { const c0 = Translator.create; Translator.create = async (o) => { await c0(o); const born = __tr.gen;
    return { translate: async (s) => {
      __tr.inputs.push(s);
      if (__tr.fail) throw new DOMException('Other generic failures occurred.', __tr.fail);
      if (born < __tr.gen) throw new DOMException('Other generic failures occurred.', 'UnknownError');
      return '[ru] ' + s; } }; }; }`;

(async () => {
  const page = filePage("stub-builtin.html");
  const PAGE = page.url;
  const b = await launch({ extraArgs: ["--allow-file-access-from-files"] });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const cmd = t.cmd;
    const ev = (expr) => t.ev(expr);
    const SHIFT = 8;
    const center = async (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    const move = (x, y, modifiers = 0) => cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    const hover = async (sel) => { const c = await center(sel); await move(c.x, c.y); await sleep(30); return c; };
    const tapShift = async () => {
      await cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: SHIFT, windowsVirtualKeyCode: 16 });
      await sleep(40);
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 0, windowsVirtualKeyCode: 16 });
      await sleep(120);
    };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const creates = () => ev("__tr.creates.length");
    const errClass = () => ev("[...document.querySelectorAll('.ht-error')].length");
    const errToasts = async () => (await ev("toasts()")).filter((s) => s.startsWith("err:"));
    await cmd("Page.enable");
    await cmd("Runtime.enable");

    await cmd("Page.navigate", { url: PAGE + "?builtin=fake&store=" + encodeURIComponent(JSON.stringify({ engine: "chrome" })) });
    await sleep(700);
    assert.strictEqual(await ev("typeof HT_engineProblem"), "function");
    await ev(`__tr.avail = 'available'; ${BREAKABLE}; true`);
    const P = {};
    for (const id of ["#p1", "#p2", "#p3"]) P[id] = await text(id);

    // 1. Переводчик создан и переводит; затем «событие» — тот же абзац другим узлом переводится, экземпляр пересоздан один раз
    await hover("#p1"); await tapShift();
    assert.ok(await until(async () => (await text("#p1")) === "[ru] " + P["#p1"]), await text("#p1"));
    assert.strictEqual(await creates(), 1);
    await ev("__tr.gen++; true");
    await hover("#p2"); await tapShift();
    assert.ok(await until(async () => (await text("#p2")) === "[ru] " + P["#p2"]), await text("#p2") + " " + JSON.stringify(await ev("toasts()")));
    assert.strictEqual(await creates(), 2, "испорченный экземпляр пересоздан ровно один раз");
    assert.strictEqual(await errClass(), 0);
    assert.deepStrictEqual(await errToasts(), []);
    ok("после «загрузки другой модели» (UnknownError у прежнего экземпляра) перевод продолжается с новым экземпляром");

    // 2. «Перевести страницу» после нового «события»: узлы падают разом, а переводчик пересоздаётся один раз
    await ev("sendCmd('restoreAll'); true"); await sleep(150);
    await ev("__tr.gen++; sendCmd('translatePage'); true");
    assert.ok(await until(async () => {
      for (const id of Object.keys(P)) if ((await text(id)) !== "[ru] " + P[id]) return false;
      return true;
    }, 4000), JSON.stringify([await text("#p1"), await text("#p2"), await text("#p3"), await ev("toasts()")]));
    assert.strictEqual(await creates(), 3, "один новый экземпляр на все узлы страницы");
    assert.strictEqual(await errClass(), 0);
    assert.deepStrictEqual(await errToasts(), []);
    ok("«Перевести страницу»: одновременные отказы — один новый экземпляр, переведено всё");

    // 3. Новый экземпляр тоже отказывает — один повтор и честная ошибка, без бесконечного цикла
    await ev("sendCmd('restoreAll'); true"); await sleep(150);
    await ev("__tr.fail = 'UnknownError'; __tr.inputs = []; true");
    await hover("#p3"); await tapShift();
    assert.ok(await until(async () => (await errClass()) > 0), "абзац отмечен ошибкой");
    await sleep(300);
    assert.strictEqual(await text("#p3"), P["#p3"]);
    assert.strictEqual(await creates(), 4, "ровно один повтор");
    assert.strictEqual(await ev("__tr.inputs.length"), 2, "translate(): прежний экземпляр и один новый");
    const t3 = await errToasts();
    assert.ok(t3.length === 1 && /Other generic failures occurred/.test(t3[0]), JSON.stringify(t3));
    ok("новый экземпляр тоже отказывает — ровно один повтор и уведомление с причиной");

    // 4. Другие ошибки переводчика экземпляр не сбрасывают
    await ev("__tr.fail = 'NotReadableError'; true");
    await sleep(3200);   // уведомление из п. 3 закрылось
    await hover("#p1"); await tapShift();
    assert.ok(await until(async () => (await errToasts()).length > 0), JSON.stringify(await ev("toasts()")));
    assert.strictEqual(await creates(), 4, "не UnknownError — без пересоздания");
    // и после этого всё снова работает с тем же экземпляром
    await ev("__tr.fail = ''; true");
    await hover("#p2"); await tapShift();
    assert.ok(await until(async () => (await text("#p2")) === "[ru] " + P["#p2"]), await text("#p2"));
    assert.strictEqual(await creates(), 4);
    ok("другая ошибка переводчика экземпляр не пересоздаёт");

    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
