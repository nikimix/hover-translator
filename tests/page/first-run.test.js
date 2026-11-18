// Первый запуск: content.js в Chrome без интерфейса на странице с заглушкой chrome.* и поддельным
// встроенным переводчиком (fixtures/stub-builtin.html, file://). Настоящие события — Input.dispatch*
// (isTrusted = true, щелчок даёт «действие пользователя»).
const assert = require("assert");
const { launch, filePage, sleep } = require("../lib/chrome");
const { rmDir } = require("../lib/env");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

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
    const click = async (sel) => {
      const c = await center(sel);
      await move(c.x, c.y);
      await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const load = async (builtin, store) => {
      await cmd("Page.navigate", { url: PAGE + "?builtin=" + builtin + "&store=" + encodeURIComponent(JSON.stringify(store || {})) });
      await sleep(700);
      assert.strictEqual(await ev("typeof HT_engineProblem"), "function");
    };
    const errClass = () => ev("[...document.querySelectorAll('.ht-error')].length");
    await cmd("Page.enable");
    await cmd("Runtime.enable");

    // 1. Первый запуск без ключа (DeepL выбран, ключа нет): ни запроса, ни красного, одно спокойное уведомление
    await load("real", { engine: "deepl" });
    const P1 = await text("#p1");
    await hover("#p1"); await tapShift();
    await hover("#p2"); await tapShift();
    await hover("#p1"); await tapShift();
    await sleep(200);
    assert.strictEqual(await ev("trCalls().length"), 0, "ни одного запроса перевода");
    assert.strictEqual(await errClass(), 0, "ни одного красного абзаца");
    assert.strictEqual(await text("#p1"), P1);
    const t1 = await ev("toasts()");
    assert.ok(t1.length === 1 && t1[0].startsWith("info:") && /не задан ключ DeepL/.test(t1[0]), JSON.stringify(t1));
    assert.strictEqual(await ev("__calls.filter((c) => c.type === 'noticeOnce').length"), 1, "background спрошен один раз за страницу");
    // режим задержки — то же самое
    await ev("setStore({ trigger: 'dwell' }); true");
    await move(5, 790); await sleep(50);
    await hover("#p2"); await sleep(400);
    await hover("#p3"); await sleep(400);
    assert.strictEqual(await ev("trCalls().length"), 0);
    assert.strictEqual(await errClass(), 0);
    ok("без ключа DeepL: наведение (клавиша и задержка) — ни запроса, ни красного, одно спокойное уведомление");
    // «Перевести страницу» — явное действие: объясняем каждый раз
    await sleep(100);
    await ev("sendCmd('translatePage'); true"); await sleep(100);
    const t1b = await ev("toasts()");
    assert.ok(t1b.length >= 1 && /не задан ключ DeepL/.test(t1b[t1b.length - 1]), JSON.stringify(t1b));
    assert.strictEqual(await ev("trCalls().length"), 0);
    ok("«Перевести страницу» без ключа — объяснение, без запросов");
    // ключ вставили — заработало сразу
    await ev("setStore({ apiKey: 'k:fx', trigger: 'shift' }); true");
    await move(5, 790); await sleep(50);
    await hover("#p1"); await tapShift(); await sleep(100);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    ok("после ввода ключа перевод работает без перезагрузки страницы");
    await ev("sendCmd('restoreAll'); true");

    // 2. Ошибка движка: красная подсветка есть, но текст ошибки НЕ в title элемента
    await ev("window.__bgReply = () => ({ ok: false, error: 'DeepL 403 (неверный ключ?)' }); true");
    await hover("#p3"); await tapShift(); await sleep(150);
    assert.strictEqual(await ev("document.querySelector('#p3').getAttribute('title')"), "own title");
    assert.strictEqual(await ev("document.querySelector('#p3').classList.contains('ht-error')"), true);
    await sleep(3100);
    await hover("#p1"); await tapShift(); await sleep(150);
    assert.strictEqual(await ev("document.querySelector('#p1').hasAttribute('title')"), false);
    const t2 = await ev("toasts()");
    assert.ok(t2.some((t) => t.startsWith("err:") && /403/.test(t)), JSON.stringify(t2));
    await sleep(2000);
    assert.strictEqual(await errClass(), 0, "подсветка ошибки снимается");
    assert.strictEqual(await ev("document.querySelector('#p3').getAttribute('title')"), "own title");
    ok("ошибка движка: текст только в уведомлении (shadow root), title элемента не трогается");
    await ev("window.__bgReply = null; true");

    // 3. Контекст расширения пропал (обновили расширение): оригиналы вернулись, обработчики сняты, тишина
    await load("real", { engine: "deepl", apiKey: "k:fx" });
    await hover("#p1"); await tapShift(); await sleep(100);
    assert.strictEqual(await text("#p1"), "[RU] " + P1);
    await ev("sendCmd('toggleHud'); true");
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 1);
    const before = await ev("__calls.length");
    await ev("chrome.runtime.id = undefined; chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); }; true");
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.strictEqual(await text("#p1"), P1, "перевод откатан к оригиналу");
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "панель и уведомления убраны");
    await hover("#p1"); await tapShift(); await sleep(100);
    await ev("setStore({ trigger: 'dwell' }); true");
    await hover("#p2"); await sleep(400);
    assert.strictEqual(await ev("__calls.length"), before, "больше ни одного обращения к расширению");
    assert.strictEqual(await errClass(), 0);
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "никаких красных уведомлений");
    ok("пропал контекст расширения: оригиналы возвращены, мини-панель убрана, обработчики сняты, ни одной ошибки");

    // 4. Встроенный: модель не скачана — честная подсказка, не красное; щелчок — загрузка с прогрессом
    await load("fake", { engine: "chrome" });
    await hover("#p1"); await tapShift(); await sleep(150);
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.strictEqual(await errClass(), 0);
    assert.strictEqual(await text("#p1"), P1);
    const t4 = await ev("toasts()");
    assert.ok(t4.length === 1 && t4[0].startsWith("info:") && /Щёлкните мышью по тексту — и он переведётся/.test(t4[0])
      && /запускает языковую модель \(английский → русский\) только после щелчка/.test(t4[0]) && /Подготовить переводчик/.test(t4[0])
      && !/каждом новом сайте/.test(t4[0]), JSON.stringify(t4));
    assert.strictEqual(await ev("__tr.creates.length"), 0, "без действия пользователя create() не зовём");
    // Shift сам по себе активацией не является
    assert.strictEqual(await ev("navigator.userActivation.isActive"), false);
    ok("модель не скачана: подсказка «щёлкните… / Подготовить переводчик» одна на страницу, абзац не краснеет, create() не зовётся");
    // щелчок по абзацу: повтор перевода с действием пользователя → загрузка с прогрессом → перевод
    await hover("#p1");
    await click("#p1");
    await sleep(80);
    const mid = await ev("toasts()");
    await sleep(500);
    assert.strictEqual(await text("#p1"), "[ru] " + P1);
    assert.deepStrictEqual(await ev("__tr.creates.map((c) => [c.src, c.tgt, c.active, c.monitor])"), [["en", "ru", true, true]]);
    console.log("      (уведомления во время загрузки: " + JSON.stringify(mid) + ")");
    assert.ok(mid.some((t) => /Скачиваю языковую модель \(английский → русский\)/.test(t)), JSON.stringify(mid));
    await sleep(300);
    assert.ok(!(await ev("toasts()")).some((t) => /Скачиваю/.test(t)), "уведомление о загрузке закрыто");
    // дальше — без щелчков
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.strictEqual(await text("#p2"), "[ru] Another paragraph with plain English text for the sweep test.");
    ok("щелчок по абзацу запускает загрузку (monitor, прогресс в уведомлении), затем перевод; дальше — без щелчков");

    // 4б. Язык не из языков браузера (navigator.languages): Chrome скрывает, скачана ли модель, и просит щелчок
    // на каждом новом сайте — подсказка говорит именно это, без «Подготовить переводчик» (окно расширения —
    // другой сайт) и без «нужно один раз».
    await load("fake", { engine: "chrome" });
    const langs = await ev("JSON.stringify(navigator.languages)");
    await ev("__ld.lang = 'es'; true");
    await hover("#p1"); await tapShift(); await sleep(150);
    const t4b = await ev("toasts()");
    console.log("      (языки браузера: " + langs + "; подсказка: " + JSON.stringify(t4b) + ")");
    assert.ok(t4b.length === 1 && /Языка «испанский» нет в списке языков Chrome/.test(t4b[0]) && /на каждом новом сайте/.test(t4b[0])
      && /языковую модель \(испанский → русский\)/.test(t4b[0]) && /настройки Chrome → «Языки»/.test(t4b[0])
      && !/Подготовить переводчик|один раз/.test(t4b[0]), JSON.stringify(t4b));
    await hover("#p1"); await click("#p1"); await sleep(600);
    assert.strictEqual(await text("#p1"), "[ru] " + P1, "после щелчка — перевод");
    ok("язык не из языков браузера: подсказка «на каждом новом сайте… добавьте язык в настройки Chrome», щелчок переводит");

    // 5. Особенность Chrome: create() сразу после загрузки отказал, а модель уже есть — повтор проходит
    await load("fake", { engine: "chrome" });
    await ev("__tr.quirk = true; true");
    await hover("#p1"); await click("#p1"); await sleep(50); await tapShift(); await sleep(600);
    // tapShift после щелчка переключил бы перевод обратно — проверяем по вызовам
    const cr = await ev("__tr.creates.map((c) => c.monitor)");
    assert.deepStrictEqual(cr.slice(0, 2), [true, false], JSON.stringify(cr));
    assert.strictEqual(await errClass(), 0);
    ok("create() отказал сразу после загрузки (NotSupportedError), availability = available → повтор без щелчка");

    // 6. Детектор не скачан: подсказка про модель определения языка; пара недоступна — честная ошибка
    await load("fake", { engine: "chrome" });
    await ev("__ld.avail = 'downloadable'; true");
    await hover("#p1"); await tapShift(); await sleep(150);
    const t6 = await ev("toasts()");
    assert.ok(t6.length === 1 && /модель определения языка/.test(t6[0]) && t6[0].startsWith("info:"), JSON.stringify(t6));
    await ev("__ld.avail = 'available'; __tr.avail = 'unavailable'; true");
    await sleep(3100);
    await hover("#p2"); await tapShift(); await sleep(150);
    const t6b = await ev("toasts()");
    assert.ok(t6b.some((t) => t.startsWith("err:") && /не умеет переводить эту пару языков: английский → русский/.test(t)), JSON.stringify(t6b));
    ok("детектор не скачан — подсказка; пара не поддерживается — честная ошибка без ложного «пара недоступна»");

    // 7. Встроенного нет в браузере (Chrome < 138, другой браузер): тишина на странице, флаг для значка
    await load("none", { engine: "chrome" });
    assert.strictEqual(await ev("typeof Translator"), "undefined");
    await hover("#p1"); await tapShift(); await sleep(150);
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.strictEqual(await errClass(), 0);
    const t7 = await ev("toasts()");
    assert.ok(t7.length === 1 && /встроенный переводчик недоступен в этом браузере/.test(t7[0]), JSON.stringify(t7));
    assert.ok(await ev("__sets.some((s) => s.htBuiltinApi === false)"), "верхний фрейм записал htBuiltinApi=false для значка");
    // «авто» без ключа и без встроенного — тоже нельзя
    await ev("setStore({ engine: 'auto' }); true");
    await hover("#p3"); await tapShift(); await sleep(150);
    assert.strictEqual(await ev("trCalls().length"), 0);
    ok("встроенного нет в браузере: страница не трогается, одно уведомление, флаг htBuiltinApi=false записан");

    // 8. Выключен (⏻) — ничего, даже уведомления
    await load("real", { engine: "deepl", enabled: false });
    await hover("#p1"); await tapShift(); await sleep(150);
    assert.strictEqual(await ev("__calls.length"), 0);
    assert.strictEqual((await ev("toasts()")).length, 0);
    ok("перевод выключен — на странице ни запросов, ни уведомлений");

    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
