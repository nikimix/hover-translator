// Повседневное удобство: content.js в Chrome без интерфейса, страница по HTTP (у неё есть имя сайта
// 127.0.0.1) с заглушкой chrome.* (fixtures/stub.html). Настоящие события — Input.dispatch* (isTrusted = true).
// Страницы отдаёт свой сервер (lib/server.js) — запускать можно и без tests/run.sh.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let BASE = "", OTHER = "";
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;

(async () => {
  const srv = await serve();
  BASE = srv.base + "/stub.html";
  OTHER = srv.other;
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store, extra = "") => {
      await t.cmd("Page.navigate", { url: BASE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) + extra });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; })()`);
    const at = async (sel, dx = 40, dy) => { const r = await rect(sel); return { x: r.x + dx, y: dy == null ? r.y + Math.round(r.h / 2) : r.y + dy }; };
    const move = (x, y, modifiers = 0) => t.mouse("mouseMoved", x, y, { modifiers });
    const hover = async (sel, dx, dy) => { const p = await at(sel, dx, dy); await move(p.x, p.y); await sleep(30); return p; };
    const away = async () => { await move(990, 790); await sleep(60); };
    const click = async (x, y) => { await move(x, y); await t.mouse("mousePressed", x, y, { button: "left", clickCount: 1 }); await t.mouse("mouseReleased", x, y, { button: "left", clickCount: 1 }); };
    const wheel = (x, y, dy) => t.mouse("mouseWheel", x, y, { deltaX: 0, deltaY: dy });
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(120); };
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(80); };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const calls = () => ev("trCalls().length");
    const toastsNow = () => ev("toasts()");
    const tr = (sel) => text(sel).then((s) => /^\[(RU|ru)\]/.test(s));

    // ---- 1. Способ по умолчанию — Shift: неизвестное значение тоже становится Shift ----
    await load({ trigger: "bogus" });
    assert.strictEqual(await ev("HT_DEFAULTS.trigger + '/' + HT_DEFAULTS.dwellMs"), "shift/600");
    await hover("#p1"); await sleep(900);
    assert.strictEqual(await calls(), 0, "без Shift наведение не переводит");
    await tapShift();
    assert.ok(await tr("#p1"), "Shift переводит");
    ok("по умолчанию — Shift (неизвестный способ → Shift): наведение само не переводит, нажатие Shift — переводит");

    // ---- 2. Задержка 600 мс по умолчанию; прокрутка без движения мыши перевод не запускает ----
    await load({ trigger: "dwell" });
    await away();
    await hover("#p2");
    await sleep(400);
    assert.strictEqual(await calls(), 0, "через 400 мс ещё рано");
    assert.ok(await until(() => tr("#p2"), 1000), "к ~600 мс переведено");
    await away(); await sleep(100);
    assert.strictEqual(await text("#p2"), "Another paragraph with plain English text for the sweep test.");
    // прокрутка: курсор стоит над наполнителем, страница едет — под курсор приезжают другие абзацы
    await ev("document.querySelector('#f5').scrollIntoView({ block: 'center' }); true"); await sleep(100);
    const fp = await at("#f5");
    await move(fp.x, fp.y); await sleep(50);
    await move(fp.x + 1, fp.y); await sleep(100);     // настоящее движение — над f5 пошёл таймер
    await ev("window.__calls.length = 0; true");
    // тут же колесо: курсор не двигается, f5 уезжает, под курсором — f8, f9…
    for (let i = 0; i < 3; i++) { await wheel(fp.x + 1, fp.y, 120); await sleep(150); }
    await sleep(1200);
    const under = await ev(`(() => { const e = document.elementFromPoint(${fp.x + 1}, ${fp.y}); return e && e.id; })()`);
    assert.strictEqual(await calls(), 0, "после прокрутки без движения мыши — ни одного перевода (под курсором " + under + ")");
    await move(fp.x + 3, fp.y + 1);              // мышь сдвинулась
    assert.ok(await until(() => calls(), 1500), "сдвинули мышь — элемент под курсором переводится");
    assert.ok(await tr("#" + under), under);
    ok(`наведение: задержка 600 мс; mouseover от прокрутки (курсор стоит) перевод не запускает, первое же движение мыши — запускает (#${under})`);

    // ---- 3. Режим задержки не трогает ссылки, кнопки, роли, навигацию и короткие тексты ----
    await load({ trigger: "dwell", dwellMs: 150 });
    const skipped = [];
    for (const [sel, dx] of [["#navlink", 20], ["#alink", 20], ["#btn", 20], ["#rolebtn", 20], ["#tab1", 20], ["#short", 10], ["#zhshort", 10]]) {
      await away();
      await hover(sel, dx);
      await move((await at(sel, dx)).x + 2, (await at(sel, dx)).y);
      await sleep(400);
      skipped.push(sel + ":" + (await calls()));
    }
    assert.ok(skipped.every((s) => s.endsWith(":0")), "отсеяно: " + skipped.join(" "));
    // тот же абзац со ссылкой: курсор на обычном тексте — переводится
    const pl = await rect("#plink"), al = await rect("#alink");
    await away();
    await move(al.r + 60, pl.y + 10); await sleep(20); await move(al.r + 62, pl.y + 10);
    assert.ok(await until(() => tr("#plink"), 1000), "абзац со ссылкой, курсор на тексте — переводится");
    await away();
    await hover("#zhlong", 10); await move((await at("#zhlong", 12)).x, (await at("#zhlong", 12)).y);
    assert.ok(await until(() => tr("#zhlong"), 1000), "длинный текст без пробелов (китайский, 19 знаков) — переводится");
    ok("наведение не трогает ссылки, кнопки, role=button/tab, навигацию, тексты короче 3 слов и короткий китайский; абзац со ссылкой — по тексту, длинный китайский — переводятся");
    // режим клавиши: всё по просьбе
    await setTrigger("shift");
    async function setTrigger(v) { await ev(`setStore({ trigger: '${v}' }); true`); }
    for (const sel of ["#navlink", "#btn", "#rolebtn", "#short", "#zhshort"]) {
      await away(); await hover(sel, 10); await tapShift();
    }
    const keyed = await ev("['#navlink','#btn','#rolebtn','#short','#zhshort'].map((s) => document.querySelector(s).textContent.startsWith('[RU]'))");
    assert.deepStrictEqual(keyed, [true, true, true, true, true]);
    ok("режим клавиши переводит и ссылки, и кнопки, и короткие тексты — человек просит явно");

    // ---- 4. Петля на краю абзаца ----
    // Перевод короче оригинала: абзац сжимается, курсор на его последней строке оказывается снаружи.
    const edgeLoop = async (old) => {
      await load({ trigger: "dwell", dwellMs: 250 }, old ? "&old=1" : "");
      await ev(`window.__bgReply = (m) => ({ ok: true, texts: m.items.map(() => "Кратко."), srcLangs: m.items.map(() => "en") }); true`);
      const r = await rect("#edge");
      await away();
      await move(r.x + 300, r.b - 6); await sleep(20); await move(r.x + 302, r.b - 6);   // последняя строка, справа
      await sleep(3000);                                     // мышь не трогаем
      return { n: await calls(), text: await text("#edge"), r };
    };
    // Прежний код (из истории git) показывает, что сценарий по-прежнему воспроизводит петлю; без истории
    // (архив, неполный клон) проверяется только нынешний код.
    const old = srv.hasOld() ? await edgeLoop(true) : null;
    const now = await edgeLoop(false);
    console.log(`      (курсор стоит на последней строке 3 с: до исправления — ${old ? old.n + " запросов перевода" : "не проверялось, нет истории git"}, сейчас — ${now.n}; абзац сейчас: «${now.text}»)`);
    if (old) assert.ok(old.n >= 3, "петля воспроизводится на прежнем коде: " + old.n);
    assert.strictEqual(now.n, 1, "один перевод, без петли");
    assert.strictEqual(now.text, "Кратко.", "перевод остаётся, пока мышь не сдвинулась");
    // дрожание руки (< 16 px) не откатывает
    await move(now.r.x + 305, now.r.b - 4); await sleep(300);
    assert.strictEqual(await text("#edge"), "Кратко.");
    // увели мышь вниз — откат; вернули на место над (снова длинным) абзацем — повторного перевода нет
    await move(now.r.x + 302, now.r.b + 40); await sleep(200);
    assert.ok(/^Edge paragraph/.test(await text("#edge")), "ушли — оригинал");
    await move(now.r.x + 302, now.r.b - 6); await sleep(30); await move(now.r.x + 300, now.r.b - 8); await sleep(900);
    assert.strictEqual(await calls(), 1, "тот же абзац не переводится снова, пока курсор не ушёл на другой элемент");
    await hover("#p1"); await sleep(100); await hover("#edge", 20, 10); await move((await at("#edge", 22, 10)).x, (await at("#edge", 22, 10)).y);
    assert.ok(await until(async () => (await text("#edge")) === "Кратко.", 1500), "ушли на другой абзац и вернулись — переводится");
    ok(`петля на краю абзаца: ${old ? "до исправления " + old.n + " переводов за 3 с неподвижного курсора, " : ""}сейчас 1; перевод держится до движения мыши`);

    // ---- 5. Карточка ----
    await load({ trigger: "shift", displayMode: "popover" });
    await hover("#p2"); await tapShift();
    await until(() => ev("cards().length === 1 && !cards()[0].querySelector('.card').classList.contains('loading')"));
    let card = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) }; })()");
    const p2 = await rect("#p2");
    assert.ok(card.top >= p2.b && card.top - p2.b <= 10, `карточка под абзацем: ${JSON.stringify(card)} / абзац до ${p2.b}`);
    await t.shot("card.png", { clip: { x: 0, y: 0, width: 720, height: 260, scale: 1 } });
    // новая закрывает старую
    await hover("#p3"); await tapShift();
    await until(() => ev("cards().length === 1 && cards()[0].host.getBoundingClientRect().top > " + (p2.b + 20)));
    assert.strictEqual(await ev("cards().length"), 1, "одна карточка за раз");
    // ✕ — настоящий щелчок
    const x = await ev("uiPoint(cards()[0], '.close')");
    await click(x.x, x.y); await sleep(100);
    assert.strictEqual(await ev("cards().length"), 0, "✕ закрывает");
    // поддельный щелчок по хосту не закрывает, щелчок мимо — закрывает
    await hover("#p1"); await tapShift(); await until(() => ev("cards().length === 1"));
    await ev("cards()[0].host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
    await sleep(50);
    assert.strictEqual(await ev("cards().length"), 1, "поддельные события страницы карточку не трогают");
    const inCard = await ev("uiPoint(cards()[0], '.body')");
    await click(inCard.x, inCard.y); await sleep(80);
    assert.strictEqual(await ev("cards().length"), 1, "щелчок по самой карточке её не закрывает");
    await click(900, 700); await sleep(80);
    assert.strictEqual(await ev("cards().length"), 0, "щелчок мимо закрывает");
    // Esc
    await hover("#p1"); await tapShift(); await until(() => ev("cards().length === 1"));
    await esc();
    assert.strictEqual(await ev("cards().length"), 0, "Esc закрывает");
    // прокрутка: немного — карточка едет за абзацем, заметно — закрывается
    await hover("#p3"); await tapShift(); await until(() => ev("cards().length === 1"));
    await ev("window.scrollBy(0, 60); true"); await sleep(150);
    assert.strictEqual(await ev("cards().length"), 1, "60 px — остаётся");
    await ev("window.scrollBy(0, 200); true"); await sleep(150);
    assert.strictEqual(await ev("cards().length"), 0, "ещё 200 px — закрыта");
    await ev("window.scrollTo(0, 0); true"); await sleep(100);
    // снизу места нет — над абзацем
    await ev("document.querySelector('#f3').scrollIntoView({ block: 'end' }); true"); await sleep(100);
    const f3 = await rect("#f3");
    await hover("#f3"); await tapShift(); await until(() => ev("cards().length === 1 && !cards()[0].querySelector('.card').classList.contains('loading')"));
    card = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()");
    assert.ok(card.bottom <= f3.y && f3.y - card.bottom <= 10, `у нижнего края — над абзацем: ${JSON.stringify(card)} / абзац с ${f3.y}`);
    await esc();
    ok("карточка: под абзацем (над — только у нижнего края), одна за раз, ✕, Esc, щелчок мимо, заметная прокрутка; поддельные события её не трогают");
    // режим задержки: с абзаца можно дойти до карточки через зазор
    await ev("window.scrollTo(0, 0); setStore({ trigger: 'dwell', dwellMs: 150 }); true"); await sleep(100);
    await away();
    await hover("#p1"); await move((await at("#p1")).x + 2, (await at("#p1")).y);
    await until(() => ev("cards().length === 1 && !cards()[0].querySelector('.card').classList.contains('loading')"), 2000);
    const p1 = await rect("#p1");
    const c1 = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { x: Math.round(r.left + 30), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()");
    for (let y = p1.b - 2; y <= c1.top + 10; y += 2) { await move(c1.x, y); await sleep(15); }
    await sleep(500);
    assert.strictEqual(await ev("cards().length"), 1, "дошли с абзаца до карточки — она на месте");
    await move(c1.x, c1.bottom + 60); await sleep(150);
    assert.strictEqual(await ev("cards().length"), 0, "ушли с карточки — закрылась");
    ok("режим задержки: от абзаца до карточки можно дойти через зазор (закрытие через 300 мс), уход с карточки — закрывает");

    // ---- 6. Esc возвращает оригинал везде; preventDefault не делаем ----
    await load({ trigger: "shift" });
    await ev("window.__escSeen = []; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escSeen.push(e.defaultPrevented); }); true");
    await hover("#p1"); await tapShift(); await hover("#p2"); await tapShift();
    await ev("sendCmd('translatePage'); true"); await sleep(300);
    assert.ok((await tr("#p1")) && (await tr("#p2")) && (await tr("#f20")) === false);
    await esc();
    assert.ok(!(await tr("#p1")) && !(await tr("#p2")) && !(await tr("#p3")), "всё вернулось");
    assert.deepStrictEqual(await ev("window.__escSeen"), [false], "Esc дошёл до сайта, defaultPrevented = false");
    assert.strictEqual(await ev("typeCalls('restoreTab').length"), 0, "встроенных окон нет — background не беспокоим");
    // нечего возвращать — ничего не делаем; фокус в поле — Esc для поля
    await esc();
    await hover("#p1"); await tapShift();
    await ev("document.querySelector('#inp').focus(); true");
    await esc();
    assert.ok(await tr("#p1"), "Esc в поле ввода переводы не трогает");
    await ev("document.querySelector('#inp').blur(); true");
    await esc();
    assert.ok(!(await tr("#p1")));
    // поддельный Esc страницы — ничего
    await hover("#p2"); await tapShift();
    await ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true"); await sleep(50);
    assert.ok(await tr("#p2"), "поддельный Esc страницы не возвращает");
    ok("Esc: возвращает оригинал везде (и перевод страницы), не мешает сайту (defaultPrevented = false), не срабатывает в поле ввода и от поддельного события");
    // со встроенным окном — просим background разослать
    await load({ trigger: "shift" }, "&frame=" + encodeURIComponent(OTHER + "/stub-frame.html"));
    await hover("#p1"); await tapShift(); await esc();
    assert.strictEqual(await ev("typeCalls('restoreTab').length"), 1, "есть встроенное окно — просим вернуть оригинал и в нём");
    ok("Esc на странице со встроенным окном: просьба к background вернуть оригинал во всех фреймах вкладки");

    // ---- 7. Понятные ошибки с кнопкой; запасной встроенный переводчик ----
    await load({ trigger: "shift", engine: "deepl" });
    await ev(`window.__bgReply = () => ({ ok: false, code: "quota", error: "Лимит DeepL на этот месяц закончился.", detail: "код ответа 456" }); true`);
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ev("document.querySelector('#p1').textContent.startsWith('[ru]')")), "перевели встроенным");
    let ts = await toastsNow();
    assert.ok(ts.length === 1 && /^info:Переводчик при наведенииЛимит DeepL на этот месяц закончился — перевожу встроенным переводчиком Chrome\.Переключиться на встроенный/.test(ts[0]), JSON.stringify(ts));
    await t.shot("toast-fallback.png", { clip: { x: 150, y: 640, width: 700, height: 160, scale: 1 } });
    await hover("#p2"); await tapShift(); await sleep(200);
    assert.ok(await ev("document.querySelector('#p2').textContent.startsWith('[ru]')"));
    assert.strictEqual(await ev("typeCalls('noticeOnce').filter((c) => c.problem === 'deepl-quota').length"), 1, "сказали один раз");
    assert.ok(!(await ev("__sets.some((s) => 'engine' in s)")), "выбор переводчика не меняли");
    ok("DeepL 456 + встроенный есть: перевод встроенным, одно уведомление «Лимит DeepL… перевожу встроенным», настройка не тронута");
    // сеть
    await load({ trigger: "shift", engine: "deepl" });
    await ev(`window.__bgReply = () => ({ ok: false, code: "network", error: "Нет связи с DeepL — проверьте интернет.", detail: "Failed to fetch" }); true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    await hover("#p2"); await tapShift(); await sleep(200);
    assert.ok(await ev("['#p1','#p2'].every((s) => document.querySelector(s).textContent.startsWith('[ru]'))"));
    ts = await toastsNow();
    assert.ok(ts.length === 1 && /Нет связи с DeepL — перевожу встроенным/.test(ts[0]), JSON.stringify(ts));
    ok("нет связи с DeepL: перевод встроенным, уведомление один раз на страницу");
    // без встроенного — ошибка с кнопкой «Открыть настройки»; висит дольше и закрывается ✕
    await load({ trigger: "shift", engine: "deepl" }, "&builtin=none");
    await ev(`window.__bgReply = () => ({ ok: false, code: "quota", error: "Лимит DeepL на этот месяц закончился.", detail: "код ответа 456" }); true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    ts = await toastsNow();
    assert.ok(ts.length === 1 && ts[0] === "err:Переводчик при наведенииЛимит DeepL на этот месяц закончился.код ответа 456Открыть настройки", JSON.stringify(ts));
    await t.shot("toast-error-action.png", { clip: { x: 150, y: 660, width: 700, height: 140, scale: 1 } });
    const tr0 = await ev("toastRoot()");
    // поддельный щелчок по хосту — ничего; настоящий по кнопке — просьба открыть настройки
    await ev("toastRoot().host.click(); toastRoot().host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); true");
    assert.strictEqual(await ev("typeCalls('openSettings').length"), 0);
    await sleep(5000);
    assert.strictEqual((await toastsNow()).length, 1, "ошибка с действием через 5 с ещё на экране");
    const bt = await ev("uiPoint(toastRoot(), '.act')");
    await click(bt.x, bt.y); await sleep(350);     // 250 мс — исчезновение
    assert.strictEqual(await ev("typeCalls('openSettings').length"), 1, "настоящий щелчок — «Открыть настройки»");
    assert.strictEqual((await toastsNow()).length, 0, "после действия уведомление закрыто");
    ok("без встроенного: красная ошибка простыми словами + «код ответа 456» мелко + «Открыть настройки»; висит > 5 с; кнопка — только настоящим щелчком");
    // ключ не подошёл — тоже с кнопкой; простая ошибка (429) — без кнопки, исчезает сама
    await ev(`window.__bgReply = () => ({ ok: false, code: "rate", error: "Слишком много запросов к DeepL — подождите немного и попробуйте ещё раз.", detail: "код ответа 429" }); true`);
    await sleep(3100);
    await hover("#p2"); await tapShift(); await sleep(150);
    ts = await toastsNow();
    assert.ok(ts.length === 1 && /^err:Слишком много запросов к DeepL.*код ответа 429$/.test(ts[0]), JSON.stringify(ts));
    assert.strictEqual(await ev("toastRoot().host.style.pointerEvents"), "none", "без кнопок не мешает щёлкать по странице");
    await sleep(4500);
    assert.strictEqual((await toastsNow()).length, 0, "простая ошибка исчезла сама");
    // ✕ закрывает ошибку с действием
    await ev(`window.__bgReply = () => ({ ok: false, code: "bad-key", error: "DeepL не принял ключ — проверьте его в окне расширения.", detail: "код ответа 403" }); true`);
    await hover("#p3"); await tapShift(); await sleep(150);
    const xb = await ev("uiPoint(toastRoot(), '.x')");
    await click(xb.x, xb.y); await sleep(350);
    assert.strictEqual((await toastsNow()).length, 0, "✕ закрывает");
    ok("ключ не подошёл — с кнопкой и ✕; 429 — без кнопки, «прозрачно» для мыши, исчезает сама");
    // «Переключиться на встроенный» пишет engine через таблицу
    await load({ trigger: "shift", engine: "llm", llmApiKey: "x" });
    await ev(`window.__bgReply = () => ({ ok: false, code: "money", error: "На счёте OpenAI закончились деньги — пополните его или выберите другой переводчик.", detail: "код ответа 429: quota" }); true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    const sw = await ev("uiPoint(toastRoot(), '.act')");
    assert.ok(/Переключиться на встроенный/.test((await toastsNow())[0]));
    await click(sw.x, sw.y); await sleep(150);
    assert.deepStrictEqual(await ev("__sets.filter((s) => 'engine' in s)"), [{ engine: "chrome" }]);
    ok("«Переключиться на встроенный» (нет денег на счёте ИИ): записан engine=chrome — значение из таблицы");

    // ---- 8. «Перевести страницу»: Перевожу… → Готово · Вернуть оригинал; «нечего» — нейтрально ----
    await load({ trigger: "shift" });
    await ev("window.__bgDelay = 400; true");
    await ev("sendCmd('translatePage'); true"); await sleep(120);
    ts = await toastsNow();
    assert.ok(ts.length === 1 && ts[0] === "info:Переводчик при наведенииПеревожу страницу…", JSON.stringify(ts));
    await t.shot("page-translating.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.6 } });
    const pulse = await ev("(() => { const e = document.querySelector('.ht-loading'); return e ? getComputedStyle(e).animationName : 'нет'; })()");
    const pulseDark = await ev("document.querySelector('#dark').className");
    assert.strictEqual(pulse, "ht-pulse", "во время перевода — пульсация");
    assert.ok(/ht-loading-dark/.test(pulseDark), "на тёмном фоне — светлая пульсация: " + pulseDark);
    assert.ok(await until(async () => /Готово/.test((await toastsNow()).join()), 3000));
    ts = await toastsNow();
    assert.ok(/^info:Переводчик при наведенииГотово\. Остальное переведётся, когда вы до него докрутите\.Вернуть оригинал$/.test(ts[0]), JSON.stringify(ts));
    await t.shot("toast-done.png", { clip: { x: 150, y: 660, width: 700, height: 140, scale: 1 } });
    const rb = await ev("uiPoint(toastRoot(), '.act')");
    await click(rb.x, rb.y); await sleep(150);
    assert.ok(!(await tr("#p1")) && !(await tr("#p2")), "«Вернуть оригинал» вернул");
    assert.strictEqual(await ev("document.querySelectorAll('.ht-loading').length"), 0);
    // reduced motion — ровный фон вместо пульсации
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await hover("#p1"); await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(60);
    const still = await ev("(() => { const e = document.querySelector('.ht-loading'); return e ? getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationIterationCount : 'нет'; })()");
    assert.strictEqual(still, "ht-pulse-still 1", "prefers-reduced-motion: без пульсации");
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await sleep(500);
    ok("«Перевести страницу»: «Перевожу страницу…» → «Готово…» с «Вернуть оригинал» (работает); пульсация при переводе (светлая на тёмном), при reduced-motion — без неё");
    // нечего переводить — нейтрально, не зелёным
    await ev("window.__bgDelay = 0; document.querySelectorAll('p, button, [role], nav').forEach((e) => e.setAttribute('translate', 'no')); true");
    await ev("sendCmd('translatePage'); true"); await sleep(150);
    ts = await toastsNow();
    assert.ok(ts.length === 1 && ts[0].startsWith("info:") && /Переводить нечего/.test(ts[0]), JSON.stringify(ts));
    const bg = await ev("getComputedStyle(toastRoot().querySelector('.toast')).backgroundColor");
    assert.strictEqual(bg, "rgb(31, 36, 48)", "тёмный нейтральный фон, не зелёный");
    ok("«Переводить нечего» — нейтральная подсказка (тёмная), не зелёный «успех»");

    // ---- 9. Выключить на этом сайте ----
    await load({ trigger: "shift", disabledSites: ["127.0.0.1", 5, "<script>"], hudShown: true });
    assert.deepStrictEqual(await ev("sendCmd('getHudState')"), { ok: true, hud: false, site: "127.0.0.1", siteOff: true });
    await hover("#p1"); await tapShift();
    assert.strictEqual(await calls(), 0, "клавиша не переводит");
    await ev("setStore({ trigger: 'dwell', dwellMs: 100 }); true");
    await away(); await hover("#p2"); await move((await at("#p2")).x + 2, (await at("#p2")).y); await sleep(400);
    assert.strictEqual(await calls(), 0, "наведение не переводит");
    assert.strictEqual(await ev("hudRoot()"), null, "мини-панели нет (хотя она включена)");
    assert.strictEqual(await ev("sendCmd('toggleHud').hud"), false);
    await ev("sendCmd({ type: 'translatePage', via: 'command', keys: 'Alt+Shift+O' }); true"); await sleep(100);
    assert.ok(/На этом сайте перевод выключен/.test((await toastsNow()).join()), "«Перевести страницу» на выключенном сайте — объяснение, без перевода");
    assert.strictEqual(await calls(), 0);
    assert.deepStrictEqual(await ev("typeCalls('siteBadge')"), [{ type: "siteBadge", off: true }], "значок вкладки — «off»");
    // включили обратно (из окна расширения) — работает, панель вернулась
    await ev("setStore({ disabledSites: [], trigger: 'shift' }); true"); await sleep(100);
    assert.ok(await ev("!!hudRoot()"), "панель вернулась");
    assert.deepStrictEqual(await ev("typeCalls('siteBadge').pop()"), { type: "siteBadge", off: false });
    await hover("#p1"); await tapShift();
    assert.ok(await tr("#p1"));
    // кнопка ⊘ в мини-панели: оригиналы вернулись, панель скрылась, сайт в списке; «Включить снова»
    const off = await ev("uiPoint(hudRoot(), 'button[title^=\"Выключить\"]')");
    await click(off.x, off.y); await sleep(350);   // прежнее уведомление исчезает 250 мс
    assert.ok(!(await tr("#p1")), "оригинал вернулся");
    assert.strictEqual(await ev("hudRoot()"), null, "панель скрыта");
    assert.deepStrictEqual(await ev("__store.disabledSites"), ["127.0.0.1"]);
    ts = await toastsNow();
    assert.ok(/Перевод на сайте 127\.0\.0\.1 выключен/.test(ts[0]) && /Включить снова/.test(ts[0]), JSON.stringify(ts));
    await t.shot("toast-site-off.png", { clip: { x: 150, y: 660, width: 700, height: 140, scale: 1 } });
    const on = await ev("uiPoint(toastRoot(), '.act')");
    await click(on.x, on.y); await sleep(150);
    assert.deepStrictEqual(await ev("__store.disabledSites"), []);
    assert.ok(await ev("!!hudRoot()"), "панель снова на месте");
    ok("выключен сайт: ни клавиши, ни наведения, ни панели, «Перевести страницу» объясняет; ⊘ в панели выключает (с «Включить снова»); значок вкладки «off»; мусор в списке отброшен");
    // встроенное окно с другого адреса смотрит на сайт верхней страницы
    const frameRun = async (store) => {
      const fr = OTHER + "/stub-frame.html?store=" + encodeURIComponent(JSON.stringify(store));
      await load({ trigger: "dwell" }, "&frame=" + encodeURIComponent(fr));
      await sleep(500);
      const r = await rect("#fr");
      await away();
      await move(r.x + 60, r.y + 25); await sleep(30); await move(r.x + 62, r.y + 26); await sleep(600);
      return ev(`new Promise((res) => { addEventListener("message", (e) => res(e.data), { once: true }); document.querySelector("#fr").contentWindow.postMessage("report", "*"); })`);
    };
    const f1 = await frameRun({ disabledSites: ["127.0.0.1"] });
    const f2 = await frameRun({ disabledSites: ["localhost"] });
    console.log(`      (встроенное окно localhost внутри 127.0.0.1: ancestorOrigins=${JSON.stringify(f1.anc)}; выключен 127.0.0.1 → запросов ${f1.calls.filter((c) => c === "translateBatch").length}; выключен localhost → «${f2.text.slice(0, 30)}…»)`);
    assert.ok(f1.calls.filter((c) => c === "translateBatch").length === 0 && /^A paragraph/.test(f1.text));
    assert.ok(/^\[RU\]/.test(f2.text), "выключен только адрес самого окна — не считается: сайт определяется по верхней странице");
    ok("встроенное окно с другого адреса проверяет сайт верхней страницы (location.ancestorOrigins)");

    // ---- 10. Мини-панель: показ и место запоминаются ----
    await load({ trigger: "shift", hudShown: true, hudPos: { left: 120, top: 300 } });
    let hp = await ev("(() => { const r = hudRoot().host.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()");
    assert.deepStrictEqual(hp, [120, 300], "показана сразу и на сохранённом месте");
    const grip = await ev("uiPoint(hudRoot(), '.grip')");
    await move(grip.x, grip.y);
    await t.mouse("mousePressed", grip.x, grip.y, { button: "left", clickCount: 1 });
    for (let i = 1; i <= 5; i++) await t.mouse("mouseMoved", grip.x + i * 20, grip.y - i * 10, { button: "left", buttons: 1 });
    await t.mouse("mouseReleased", grip.x + 100, grip.y - 50, { button: "left", clickCount: 1 });
    await sleep(100);
    const posSets = await ev("__sets.filter((s) => 'hudPos' in s)");
    assert.ok(posSets.length === 1 && posSets[0].hudPos.left === 220 && posSets[0].hudPos.top === 250, "место записано один раз, при отпускании: " + JSON.stringify(posSets));
    // «другая страница»: перезагрузка с тем, что записано
    await load({ trigger: "shift", hudShown: true, hudPos: posSets[0].hudPos });
    hp = await ev("(() => { const r = hudRoot().host.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()");
    assert.deepStrictEqual(hp, [220, 250]);
    const close = await ev("uiPoint(hudRoot(), 'button[title=\"Скрыть панель\"]')");
    await click(close.x, close.y); await sleep(100);
    assert.strictEqual(await ev("hudRoot()"), null);
    assert.deepStrictEqual(await ev("__sets.filter((s) => 'hudShown' in s)"), [{ hudShown: false }]);
    // показали в другой вкладке — появляется и здесь; мусор в позиции — место по умолчанию
    await ev("setStore({ hudPos: { left: 'x', top: 1 }, hudShown: true }); true"); await sleep(80);
    hp = await ev("(() => { const r = hudRoot().host.getBoundingClientRect(); const d = document.documentElement; return [d.clientWidth - Math.round(r.right), d.clientHeight - Math.round(r.bottom)]; })()");
    assert.deepStrictEqual(hp, [16, 16], "неверная позиция — снизу справа (отступ 16 px от краёв окна без полосы прокрутки)");
    ok("мини-панель: показ и место (общие для сайтов) восстанавливаются на новой странице, место пишется один раз при отпускании, ✕ запоминает «скрыта»");

    // ---- 11. Горячая клавиша вкл/выкл: сказать на странице ----
    await ev("sendCmd({ type: 'say', what: 'disabled', keys: 'Alt+Shift+O' }); true"); await sleep(80);
    assert.ok(/Перевод выключен\. Включить снова — Alt\+Shift\+O\./.test((await toastsNow()).join()));
    await ev("setStore({ enabled: false }); sendCmd({ type: 'translatePage', via: 'command', keys: 'Alt+Shift+O' }); true"); await sleep(80);
    assert.ok(/Перевод выключен\. Включить: Alt\+Shift\+O или значок расширения\./.test((await toastsNow()).join()));
    ok("горячие клавиши: «Перевод выключен. Включить снова — Alt+Shift+O»; «перевести страницу» при выключенном переводе — подсказка");

    // ---- 12. Уведомление и мини-панель не накрывают друг друга ----
    // Прямоугольники хостов: [left, top, right, bottom]; пересекаются ли.
    const boxes = () => ev(`(() => { const b = (r) => r ? (({ left, top, right, bottom }) => [left, top, right, bottom].map(Math.round))(r.host.getBoundingClientRect()) : null;
      return { toast: b(toastRoot()), hud: b(hudRoot()), h: document.documentElement.clientHeight }; })()`);
    const cross = (a, c) => a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3];
    const pageDone = async () => {
      await ev("sendCmd('restoreAll'); sendCmd('translatePage'); true");
      assert.ok(await until(async () => /Готово/.test((await toastsNow()).join()), 3000), "уведомление «Готово»");
      return boxes();
    };
    // узкое окно, панель на месте по умолчанию (внизу справа): уведомление встаёт над панелью
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 640, height: 600, deviceScaleFactor: 1, mobile: false });
    await load({ trigger: "shift", hudShown: true, hudPos: null });
    let bx = await pageDone();
    console.log(`      (окно 640 px: уведомление ${JSON.stringify(bx.toast)}, панель ${JSON.stringify(bx.hud)})`);
    assert.ok(bx.toast && bx.hud && !cross(bx.toast, bx.hud), "уведомление не накрывает панель: " + JSON.stringify(bx));
    assert.strictEqual(bx.toast[3], bx.hud[1] - 8, "уведомление — над панелью с зазором 8 px");
    await t.shot("toast-over-hud-narrow.png");
    // уведомление уже на экране, а панель утащили наверх — уведомление возвращается вниз
    await ev("setStore({ hudPos: { left: 200, top: 10 } }); true"); await sleep(100);
    bx = await boxes();
    assert.ok(!cross(bx.toast, bx.hud) && bx.toast[3] === bx.h - 20, "панель ушла — уведомление снова внизу: " + JSON.stringify(bx));
    // панель утащили вниз посередине — уведомление над ней
    await load({ trigger: "shift", hudShown: true, hudPos: { left: 150, top: 560 } });
    bx = await pageDone();
    assert.ok(!cross(bx.toast, bx.hud) && bx.toast[3] <= bx.hud[1], "панель внизу посередине — уведомление над ней: " + JSON.stringify(bx));
    // скрыли панель — уведомление на обычном месте
    await ev("sendCmd('toggleHud'); true"); await sleep(100);
    bx = await boxes();
    assert.ok(bx.hud === null && bx.toast[3] === bx.h - 20, JSON.stringify(bx));
    // широкое окно: панель правее уведомления — уведомление на обычном месте, внизу посередине
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
    await load({ trigger: "shift", hudShown: true, hudPos: null });
    bx = await pageDone();
    assert.ok(!cross(bx.toast, bx.hud) && bx.toast[3] === bx.h - 20, "широкое окно — уведомление не сдвигается: " + JSON.stringify(bx));
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    ok("уведомление и мини-панель не накрывают друг друга: в узком окне уведомление над панелью, панель скрыли или увели — уведомление на обычном месте; в широком — не сдвигается");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
