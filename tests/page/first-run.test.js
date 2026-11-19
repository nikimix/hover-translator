// Первый запуск: content.js в Chrome без интерфейса на странице с заглушкой chrome.* и поддельным
// встроенным переводчиком (fixtures/stub-builtin.html, file://). Настоящие события — Input.dispatch*
// (isTrusted = true, щелчок даёт «действие пользователя»).
const assert = require("assert");
const { launch, filePage, sleep } = require("../lib/chrome");
const { rmDir } = require("../lib/env");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};

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
    assert.ok(t1.length === 1 && t1[0].startsWith("err:Перевод не работает") && /не задан ключ DeepL/i.test(t1[0]), JSON.stringify(t1));
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
    assert.ok(t1b.length >= 1 && /не задан ключ DeepL/i.test(t1b[t1b.length - 1]), JSON.stringify(t1b));
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
    assert.ok(await until(async () => (await errClass()) === 0, 6000), "подсветка ошибки снимается");
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
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "плавающая кнопка и уведомления убраны");
    await hover("#p1"); await tapShift(); await sleep(100);
    await ev("setStore({ trigger: 'dwell' }); true");
    await hover("#p2"); await sleep(400);
    assert.strictEqual(await ev("__calls.length"), before, "больше ни одного обращения к расширению");
    assert.strictEqual(await errClass(), 0);
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "никаких красных уведомлений");
    ok("пропал контекст расширения: оригиналы возвращены, плавающая кнопка убрана, обработчики сняты, ни одной ошибки");

    // 4. Встроенный: модель не скачана — честная подсказка, не красное; щелчок — загрузка с прогрессом
    await load("fake", { engine: "chrome" });
    await hover("#p1"); await tapShift(); await sleep(150);
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.strictEqual(await errClass(), 0);
    assert.strictEqual(await text("#p1"), P1);
    const t4 = await ev("toasts()");
    assert.deepStrictEqual(t4, ["info:Щёлкните по текстуСкачаю переводчик для этой пары"]);
    assert.strictEqual(await ev("__tr.creates.length"), 0, "без действия пользователя create() не зовём");
    // Shift сам по себе активацией не является
    assert.strictEqual(await ev("navigator.userActivation.isActive"), false);
    ok("модель не скачана: подсказка «Щёлкните по тексту / Скачаю переводчик для этой пары» одна на страницу, абзац не краснеет, create() не зовётся");
    // щелчок по абзацу: повтор перевода с действием пользователя → загрузка с прогрессом → перевод
    await hover("#p1");
    await click("#p1");
    await sleep(80);
    const mid = await ev("toasts()");
    await sleep(500);
    assert.strictEqual(await text("#p1"), "[ru] " + P1);
    assert.deepStrictEqual(await ev("__tr.creates.map((c) => [c.src, c.tgt, c.active, c.monitor])"), [["en", "ru", true, true]]);
    console.log("      (уведомления во время загрузки: " + JSON.stringify(mid) + ")");
    assert.ok(mid.some((t) => /^info:Скачиваю переводчикАнглийский → русский/.test(t)), JSON.stringify(mid));
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
    assert.deepStrictEqual(t4b, ["info:Щёлкните по текстуЯзыка «испанский» нет в языках Chrome, поэтому щелчок нужен на каждом сайте"]);
    await hover("#p1"); await click("#p1"); await sleep(600);
    assert.strictEqual(await text("#p1"), "[ru] " + P1, "после щелчка — перевод");
    ok("язык не из языков браузера: подсказка «Языка «испанский» нет в языках Chrome, поэтому щелчок нужен на каждом сайте», щелчок переводит");

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
    assert.deepStrictEqual(t6, ["info:Щёлкните по текстуChrome включит определение языка"]);
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
    assert.ok(t7.length === 1 && /встроенный переводчик недоступен в этом браузере/i.test(t7[0]), JSON.stringify(t7));
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

    // 9. Встроенный переводчик Chrome теряет знаки на краях текстового узла (ru→en: «<b>сорт</b>, например черри» →
    //    «variety</b>eg Cherry»). Поддельный здесь теряет так же; знаки на стыке с соседним узлом ему не отдаём и
    //    возвращаем как были, «?» и точку в конце — отдаём (часть предложения), узел из одних знаков — не отдаём.
    const lossy = `__tr.inputs = []; { const c0 = Translator.create; Translator.create = async (o) => { await c0(o);
      return { translate: async (s) => { __tr.inputs.push(s); return '[ru] ' + s.replace(/^[\\s,;:—]+|[\\s,;:—]+$/g, ''); } }; }; }`;
    const P9 = "<b>Choose a small variety</b>, for example cherry tomatoes. Is it ripe? <i>Yes</i>, <i>water it</i>; then wait — <i>a week</i>.";
    await load("fake", { engine: "chrome" });
    await ev(`__tr.avail = 'available'; ${lossy}; document.body.insertAdjacentHTML('beforeend', '<p id="p9">${P9}</p>'); true`);
    const O9 = await text("#p9");
    await hover("#p9"); await tapShift(); await sleep(300);
    assert.strictEqual(await text("#p9"), "[ru] Choose a small variety, [ru] for example cherry tomatoes. Is it ripe? [ru] Yes, [ru] water it; [ru] then wait — [ru] a week.");
    assert.deepStrictEqual(await ev("__tr.inputs"), ["Choose a small variety", "for example cherry tomatoes. Is it ripe?", "Yes", "water it", "then wait", "a week"]);
    assert.strictEqual(await ev("document.querySelector('#p9 b').textContent"), "[ru] Choose a small variety", "разметка на месте");
    await hover("#p9"); await tapShift(); await sleep(150);
    assert.strictEqual(await text("#p9"), O9, "откат возвращает оригинал со всеми знаками");
    ok("встроенный: знаки на краях узла (, ; — и пробел) переводчику не отдаются и остаются на месте; «?» и точка внутри — у переводчика");
    // «Перевести страницу» — тот же путь
    await ev("__tr.inputs = []; sendCmd('translatePage'); true");
    assert.ok(await until(async () => /^\[ru\] Choose a small variety, \[ru\] for example/.test(await text("#p9")), 3000), await text("#p9"));
    assert.ok(!(await ev("__tr.inputs")).some((s) => /^[\s,;:—]|[\s,;:—]$/.test(s)), JSON.stringify(await ev("__tr.inputs")));
    ok("«Перевести страницу» встроенным — те же знаки на месте");
    // Модель не скачана: блок «Hello there» + «, » — подсказка «Щёлкните по тексту», а не тишина из-за «переведённой» запятой
    await load("fake", { engine: "chrome" });
    await ev(`document.body.insertAdjacentHTML('beforeend', '<p id="p10"><b>Hello there</b>, <i>friend</i></p>'); true`);
    await hover("#p10"); await tapShift(); await sleep(150);
    assert.deepStrictEqual(await ev("toasts()"), ["info:Щёлкните по текстуСкачаю переводчик для этой пары"]);
    ok("узел из одних знаков не считается удачей: при нескачанной модели — подсказка «Щёлкните по тексту»");

    // 10. Детектор Chrome на коротком куске уверенно ошибается («прямо под корень» → uk 0,58, «Abono» → it 0,76):
    //     язык узла — язык его блока, иначе ссылка или выделенное слово оставались непереведёнными посреди перевода.
    //     Здесь короткое (< 25 знаков) «определяется» как украинский, а пары uk→ru нет.
    const misdetect = `__tr.pairs = []; { const c0 = Translator.create; Translator.create = async (o) => {
        __tr.pairs.push(o.sourceLanguage + '>' + o.targetLanguage);
        if (o.sourceLanguage !== 'es') throw new DOMException('x', 'NotSupportedError');
        await c0(o); return { translate: async (s) => '[es>ru] ' + s }; }; }
      LanguageDetector.create = async () => ({ detect: async (t) => [t.length < 25 ? { detectedLanguage: 'uk', confidence: 0.58 } : { detectedLanguage: 'es', confidence: 0.99 }] });`;
    const P10 = "Riega por la mañana, <a href=\"#x\">directamente</a> sobre la tierra y no sobre las hojas. <b>Abono</b>: cada dos semanas.";
    await load("fake", { engine: "chrome" });
    await ev(`__tr.avail = 'available'; ${misdetect}; document.body.insertAdjacentHTML('beforeend', '<p id="p10">${P10.replace(/'/g, "\\'")}</p>'); true`);
    await hover("#p10"); await tapShift(); await sleep(300);
    assert.strictEqual(await text("#p10"), "[es>ru] Riega por la mañana, [es>ru] directamente [es>ru] sobre la tierra y no sobre las hojas. [es>ru] Abono: [es>ru] cada dos semanas.");
    assert.ok((await ev("__tr.pairs")).every((p) => p === "es>ru"), JSON.stringify(await ev("__tr.pairs")));
    assert.strictEqual(await errClass(), 0);
    await hover("#p10"); await tapShift(); await sleep(150);
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => /^\[es>ru\] Riega/.test(await text("#p10")), 3000), await text("#p10"));
    await sleep(200);
    assert.strictEqual(await text("#p10"), "[es>ru] Riega por la mañana, [es>ru] directamente [es>ru] sobre la tierra y no sobre las hojas. [es>ru] Abono: [es>ru] cada dos semanas.");
    ok("встроенный: язык короткого узла (ссылка, выделенное слово) — по всему блоку, и клавишей, и «Перевести страницу»");

    // 10б. У пункта меню, оглавления, заголовка блок — сама подпись из 1–3 слов, и язык по блоку не спасает: детектор
    //      уверенно называет чужой язык (Википедия: «Main menu» → ro 0,61, «Contents» → ca), и по действию
    //      пользователя Chrome начинал качать модель этого языка. Короткое получает язык страницы (детектор по всему
    //      её тексту), длинный абзац на другом языке — свой. Модели пар не из ready — «скачивание» (__tr.downloads).
    const shortMis = (pageOk) => `__tr.pairs = []; __tr.downloads = []; __tr.ready = ['en>ru', 'fr>ru'];
      Translator.availability = async (o) => __tr.ready.includes(o.sourceLanguage + '>' + o.targetLanguage) ? 'available' : 'downloadable';
      Translator.create = async (o) => { const p = o.sourceLanguage + '>' + o.targetLanguage; __tr.pairs.push(p);
        if (!__tr.ready.includes(p)) { __tr.downloads.push(p); __tr.ready.push(p); }
        return { translate: async (s) => '[' + p + '] ' + s }; };
      const WRONG = { 'Main menu': 'ro', 'Main page': 'fr', 'Contents': 'ca', 'Wikidata item': 'pl', 'Naming': 'nl' };
      LanguageDetector.create = async () => ({ detect: async (t) => [
        t.length < 25 ? { detectedLanguage: WRONG[t.trim()] || 'nl', confidence: 0.61 }
        : !${pageOk} && t.length > 150 ? { detectedLanguage: 'en', confidence: 0.2 }
        : /^Le jardin/.test(t) ? { detectedLanguage: 'fr', confidence: 0.99 } : { detectedLanguage: 'en', confidence: 0.99 }] });
      document.body.insertAdjacentHTML('beforeend', '<ul id="menu10"><li><a href="#m">Main menu</a></li><li><a href="#c">Contents</a></li>'
        + '<li><a href="#p">Main page</a></li><li><a href="#w">Wikidata item</a></li></ul><h3 id="h10">Naming</h3>'
        + '<p id="fr10">Le jardin potager demande de l\\'eau chaque matin, surtout pendant les semaines chaudes.</p>'); true`;
    const FR10 = "Le jardin potager demande de l'eau chaque matin, surtout pendant les semaines chaudes.";
    const menu10 = () => ev("[...document.querySelectorAll('#menu10 a, #h10')].map((e) => e.textContent)");
    await load("fake", { engine: "chrome" });
    await ev(shortMis(true));
    await hover("#menu10 a"); await tapShift(); await sleep(300);
    assert.strictEqual(await ev("document.querySelector('#menu10 a').textContent"), "[en>ru] Main menu", "клавишей");
    await hover("#p1"); await click("#p1"); await sleep(50);         // действие пользователя: модели качать можно
    assert.strictEqual(await ev("navigator.userActivation.isActive"), true);
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await text("#fr10")).startsWith("[fr>ru] ") && (await menu10()).every((s) => s.startsWith("[en>ru] ")), 3000),
      JSON.stringify([await menu10(), await text("#fr10")]));
    await sleep(200);
    assert.deepStrictEqual(await menu10(), ["[en>ru] Main menu", "[en>ru] Contents", "[en>ru] Main page", "[en>ru] Wikidata item", "[en>ru] Naming"]);
    assert.strictEqual(await text("#fr10"), "[fr>ru] " + FR10, "длинный абзац по-французски — со своего языка");
    assert.deepStrictEqual(await ev("__tr.downloads"), [], "ни одной загрузки модели");
    assert.ok((await ev("__tr.pairs")).every((p) => p === "en>ru" || p === "fr>ru"), JSON.stringify(await ev("__tr.pairs")));
    assert.ok(!(await ev("toasts()")).some((t) => /Скачиваю|Щёлкните/.test(t)), JSON.stringify(await ev("toasts()")));
    ok("встроенный: короткие подписи (меню, заголовок) — с языка страницы, не со своего, и модели чужих языков не качаются; длинный абзац по-французски — с французского");
    // Язык страницы не известен (нет <html lang>, текст страницы детектор не определил): язык подписи — догадка по паре
    // слов; уже скачанная модель годится («Main page» → fr), а ради остальных модель не качаем даже после щелчка.
    await load("fake", { engine: "chrome" });
    await ev(`document.documentElement.removeAttribute('lang'); ${shortMis(false)}`);
    await hover("#p1"); await click("#p1"); await sleep(50);
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await text("#fr10")).startsWith("[fr>ru] "), 3000), await text("#fr10"));
    await sleep(300);
    assert.deepStrictEqual(await menu10(), ["Main menu", "Contents", "[fr>ru] Main page", "Wikidata item", "Naming"]);
    assert.strictEqual(await text("#p1"), "[en>ru] " + P1);
    assert.deepStrictEqual(await ev("__tr.downloads"), [], "ради догадки по паре слов модель не качается");
    assert.ok(!(await ev("toasts()")).some((t) => /Скачиваю|Щёлкните/.test(t)), JSON.stringify(await ev("toasts()")));
    ok("язык страницы не известен: догадка по короткой подписи переводит только уже скачанной моделью, загрузок нет");

    // 10в. Детектор Chrome путает близкие языки: русский абзац Хабра → bg 0,55, ru 0,4. При переводе на русский текст
    //      шёл в перевод «с болгарского» («Страница переведена · Болгарский → русский»), при переводе на английский
    //      Chrome качал модель bg → en. Язык перевода или страницы среди вероятных у детектора — это он. __tr.asked —
    //      о каких парах спрашивали Chrome; уверенный болгарский (bg 0,9) остаётся болгарским.
    const RU10 = "Мы переписали сборку проекта и почти вдвое сократили время проверки изменений.";
    const BG10 = "Новата версия на програмата вече е достъпна за всички потребители.";
    const kinMis = `__tr.asked = []; __tr.downloads = []; __tr.ready = ['en>ru', 'ru>en'];
      Translator.availability = async (o) => { const p = o.sourceLanguage + '>' + o.targetLanguage; __tr.asked.push(p);
        return __tr.ready.includes(p) ? 'available' : 'downloadable'; };
      Translator.create = async (o) => { const p = o.sourceLanguage + '>' + o.targetLanguage;
        if (!__tr.ready.includes(p)) { __tr.downloads.push(p); __tr.ready.push(p); }
        return { translate: async (s) => '[' + p + '] ' + s }; };
      LanguageDetector.create = async () => ({ detect: async (t) => !/[а-яё]/i.test(t) ? [{ detectedLanguage: 'en', confidence: 0.99 }]
        : /^\\s*Новата/.test(t) ? [{ detectedLanguage: 'bg', confidence: 0.9 }, { detectedLanguage: 'ru', confidence: 0.05 }]
        : [{ detectedLanguage: 'bg', confidence: 0.55 }, { detectedLanguage: 'ru', confidence: 0.4 }] });
      document.body.insertAdjacentHTML('beforeend', '<p id="ru10">${RU10}</p>'); true`;
    const noBg = async () => !(await ev("toasts()")).some((t) => /Скачиваю|Щёлкните|болгарск/i.test(t));
    // перевод на русский: русский абзац не трогаем, ни клавишей, ни «Перевести страницу» (после щелчка — качать можно)
    await load("fake", { engine: "chrome" });
    await ev(kinMis);
    await hover("#ru10"); await tapShift(); await sleep(300);
    assert.strictEqual(await text("#ru10"), RU10, "клавишей — не переводится");
    assert.deepStrictEqual(await ev("__tr.asked"), [], "ни одной пары не спрашивали");
    assert.ok(await noBg(), JSON.stringify(await ev("toasts()")));
    await hover("#p1"); await click("#p1"); await sleep(50);
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await text("#p1")).startsWith("[en>ru] ")), await text("#p1"));
    await sleep(300);
    assert.strictEqual(await text("#ru10"), RU10, "«Перевести страницу» — не переводится");
    assert.ok(!(await ev("__tr.asked")).some((p) => p.startsWith("bg>")), JSON.stringify(await ev("__tr.asked")));
    assert.deepStrictEqual(await ev("__tr.downloads"), [], "ни одной загрузки модели");
    assert.ok(await noBg(), JSON.stringify(await ev("toasts()")));
    await ev(`sendCmd('restoreAll'); __tr.asked = []; document.body.insertAdjacentHTML('beforeend', '<p id="bg10">${BG10}</p>'); true`);
    await hover("#bg10"); await tapShift(); await sleep(300);
    assert.deepStrictEqual(await ev("__tr.asked"), ["bg>ru"], "уверенный болгарский — с болгарского");
    ok("близкие языки: русский абзац с bg 0,55 / ru 0,4 при переводе на русский не переводится, модель bg не качается; уверенный болгарский — болгарский");
    // перевод на английский, <html lang="ru">: с русского, модель bg → en не нужна
    await load("fake", { engine: "chrome", targetLang: "EN-US" });
    await ev(`document.documentElement.lang = 'ru'; ${kinMis}`);
    await hover("#ru10"); await tapShift(); await sleep(300);
    assert.strictEqual(await text("#ru10"), "[ru>en] " + RU10, "клавишей — с русского");
    await ev("sendCmd('restoreAll'); true");
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await text("#ru10")).startsWith("[ru>en] ") && (await ev("toasts()")).some((t) => /Русский → английский/.test(t))),
      JSON.stringify([await text("#ru10"), await ev("toasts()")]));
    assert.deepStrictEqual(await ev("__tr.asked.filter((p) => p !== 'ru>en')"), [], "только пара ru → en");
    assert.deepStrictEqual(await ev("__tr.downloads"), []);
    assert.ok(await noBg(), JSON.stringify(await ev("toasts()")));
    ok("близкие языки: при переводе на английский на странице lang=ru — с русского (Русский → английский), не с болгарского");
    // 10г. Детектор бывает и уверен в ошибке: подпись на ленте Хабра «Забирайте записи воркшопов по ИИ» → bg 0,95, ru 0,03
    //      (отдельно — bg 0,99, русского среди вероятных нет). Правило 10в (язык страницы ≥ 0,2) её не ловит, и «Перевести
    //      страницу» на английский качала модель bg → en. На русской странице текст, который по буквам может быть русским, —
    //      русский; болгарский с «ъ» перед согласной («достъпна» — в русском так не пишут) остаётся болгарским.
    const RU10G = "Забирайте записи воркшопов по ИИ";
    await load("fake", { engine: "chrome", targetLang: "EN-US" });
    await ev(`document.documentElement.lang = 'ru'; ${kinMis}`);
    await ev(`LanguageDetector.create = async () => ({ detect: async (t) => !/[а-яё]/i.test(t) ? [{ detectedLanguage: 'en', confidence: 0.99 }]
        : /^\\s*(Забирайте|Новата)/.test(t) ? [{ detectedLanguage: 'bg', confidence: 0.95 }, { detectedLanguage: 'ru', confidence: 0.03 }]
        : [{ detectedLanguage: 'ru', confidence: 0.9 }] });
      document.body.insertAdjacentHTML('beforeend', '<p id="ru10g">${RU10G}</p>'); true`);
    await ev("sendCmd('translatePage'); true");
    assert.ok(await until(async () => (await text("#ru10")).startsWith("[ru>en] ") && (await ev("toasts()")).some((t) => /Русский → английский/.test(t))),
      JSON.stringify([await text("#ru10"), await ev("toasts()")]));
    await sleep(300);
    assert.strictEqual(await text("#ru10g"), "[ru>en] " + RU10G, "с русского: " + JSON.stringify(await ev("__tr.asked")));
    assert.ok(!(await ev("__tr.asked")).some((p) => p.startsWith("bg>")), JSON.stringify(await ev("__tr.asked")));
    assert.ok(await noBg(), JSON.stringify(await ev("toasts()")));
    await ev(`sendCmd('restoreAll'); __tr.asked = []; document.body.insertAdjacentHTML('beforeend', '<p id="bg10">${BG10}</p>'); true`);
    await hover("#bg10"); await tapShift(); await sleep(300);
    assert.deepStrictEqual(await ev("__tr.asked"), ["bg>en"], "болгарский с «ъ» перед согласной — с болгарского");
    ok("близкие языки: русская подпись, которую детектор уверенно счёл болгарской (bg 0,95 / ru 0,03), на странице lang=ru — с русского; «достъпна» — болгарский");

    // 11. Точки на плавающей кнопке — те же условия, что у уведомлений: «Щёлкните по тексту» — янтарная (warn),
    //     «Перевод не работает» — красная (err); причину устранили — точки нет. Одновременно — не больше одной.
    const dotShot = (name) => ev("(() => { const r = fabRoot().host.getBoundingClientRect(); return { x: Math.max(0, r.right - 300), y: Math.max(0, r.bottom - 150) }; })()")
      .then((o) => t.shot(name, { clip: { x: o.x, y: o.y, width: 300, height: 150, scale: 1 } }));
    await load("fake", { engine: "chrome", hudShown: true });
    await hover("#p1"); await tapShift(); await sleep(150);
    assert.deepStrictEqual(await ev("toasts()"), ["info:Щёлкните по текстуСкачаю переводчик для этой пары"]);
    assert.strictEqual(await ev("fabDot()"), "warn", "ждём щелчка по тексту — янтарная точка");
    await dotShot("fab-dot-warn.png");
    await hover("#p1"); await click("#p1"); await sleep(700);
    assert.strictEqual(await text("#p1"), "[ru] " + P1);
    assert.strictEqual(await ev("fabDot()"), null, "щелчок — переводчик скачан, перевели: точки нет");
    await load("real", { engine: "deepl", hudShown: true });
    await hover("#p1"); await tapShift(); await sleep(200);
    const t11 = await ev("toasts()");
    assert.ok(t11.length === 1 && t11[0].startsWith("err:Перевод не работает"), JSON.stringify(t11));
    assert.strictEqual(await ev("fabDot()"), "err", "перевод не работает — красная точка");
    await dotShot("fab-dot-err.png");
    await ev("setStore({ apiKey: 'k:fx' }); true"); await sleep(300);
    assert.strictEqual(await ev("fabDot()"), null, "ключ вставили — точки нет");
    await hover("#p2"); await tapShift(); await sleep(150);
    assert.ok((await text("#p2")).startsWith("[RU] "), "и переводит");
    assert.strictEqual(await ev("fabDot()"), null);
    ok("точки на плавающей кнопке: «Щёлкните по тексту» — янтарная (после щелчка и перевода — нет), «Перевод не работает» — красная (ключ вставили — нет); не больше одной");

    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
