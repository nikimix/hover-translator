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
    // Пока идёт перевод, карточки нет (абзац пульсирует); пришёл перевод — карточка под абзацем с хвостиком,
    // абзац обведён 2 px акцентом, сверху «Английский → русский», копировать и ✕.
    await load({ trigger: "shift", displayMode: "popover" });
    await ev("document.querySelector('#p2').style.setProperty('outline', '1px dotted rgb(1, 2, 3)'); true");
    const p2 = await rect("#p2");
    await hover("#p2"); await tapShift();
    await until(() => ev("cards().length === 1"));
    let card = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width) }; })()");
    assert.ok(card.top - p2.b >= 16 && card.top - p2.b <= 28, `карточка под абзацем с зазором под обводку и хвостик: ${JSON.stringify(card)} / абзац до ${p2.b}`);
    assert.ok(card.left === p2.x && card.w === 560, "по левому краю абзаца, ширина 560 (абзац 600): " + JSON.stringify(card));
    const cardInfo = await ev(`(() => { const r = cards()[0]; const c = r.querySelector('.tcard'); const t = r.querySelector('.c-text');
      return { lang: r.querySelector('.c-lang').textContent, text: t.textContent, font: getComputedStyle(t).fontSize, bg: getComputedStyle(c).backgroundColor,
        border: getComputedStyle(c).borderTopColor, caret: !!r.querySelector('.caret') && !c.classList.contains('up'),
        btns: [...r.querySelectorAll('.c-btn')].map((b) => b.getAttribute('aria-label')) }; })()`);
    assert.deepStrictEqual(cardInfo, { lang: "Английский → русский", text: "[RU] Another paragraph with plain English text for the sweep test.",
      font: "16px", bg: "rgb(255, 255, 255)", border: "rgb(201, 206, 213)", caret: true, btns: ["Копировать", "Закрыть перевод"] });
    const ring = () => ev("(() => { const s = document.querySelector('#p2').style; return s.getPropertyValue('outline') + ' ' + s.getPropertyPriority('outline') + ' / ' + s.getPropertyValue('outline-offset'); })()");
    assert.strictEqual(await ring(), "rgb(37, 99, 235) solid 2px important / 6px", "абзац обведён 2 px акцентом");
    await t.shot("card.png", { clip: { x: 0, y: 0, width: 720, height: 300, scale: 1 } });
    // новая закрывает старую и снимает обводку прежнего абзаца (его собственный inline-стиль возвращается);
    // берём абзац выше: текст под карточкой p2 ею накрыт
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ev("cards().length === 1 && cards()[0].host.getBoundingClientRect().top < " + p2.y)), "карточка первого абзаца");
    assert.strictEqual(await ev("cards().length"), 1, "одна карточка за раз");
    assert.strictEqual(await ring(), "rgb(1, 2, 3) dotted 1px  / ", "обводка снята, свой стиль абзаца на месте");
    // ✕ — настоящий щелчок
    const x = await ev("uiPoint(cards()[0], '.c-btn[aria-label=\"Закрыть перевод\"]')");
    await click(x.x, x.y); await sleep(100);
    assert.strictEqual(await ev("cards().length"), 0, "✕ закрывает");
    assert.strictEqual(await ev("document.querySelector('#p1').getAttribute('style')"), "", "обводка снята, у абзаца без своего стиля ничего не осталось");
    // поддельный щелчок по хосту не закрывает, щелчок мимо — закрывает
    await hover("#p1"); await tapShift(); await until(() => ev("cards().length === 1"));
    await ev("cards()[0].host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
    await sleep(50);
    assert.strictEqual(await ev("cards().length"), 1, "поддельные события страницы карточку не трогают");
    const inCard = await ev("uiPoint(cards()[0], '.c-text')");
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
    // снизу места нет — над абзацем, хвостик снизу
    await ev("document.querySelector('#f3').scrollIntoView({ block: 'end' }); true"); await sleep(100);
    const f3 = await rect("#f3");
    await hover("#f3"); await tapShift(); await until(() => ev("cards().length === 1"));
    card = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), up: cards()[0].querySelector('.tcard').classList.contains('up') }; })()");
    assert.ok(card.up && card.bottom <= f3.y && f3.y - card.bottom <= 28, `у нижнего края — над абзацем: ${JSON.stringify(card)} / абзац с ${f3.y}`);
    await esc();
    // пары языков нет, если выключен «Язык оригинала на карточке»; тёмный фон абзаца — тёмная карточка
    await ev("window.scrollTo(0, 0); setStore({ showLangBadge: false }); true"); await sleep(100);
    await hover("#dark"); await tapShift(); await until(() => ev("cards().length === 1"));
    const dk = await ev("(() => { const r = cards()[0]; const c = r.querySelector('.tcard'); return [r.querySelector('.c-lang').textContent, getComputedStyle(c).backgroundColor, getComputedStyle(c).borderTopColor, document.querySelector('#dark').style.getPropertyValue('outline')]; })()");
    assert.deepStrictEqual(dk, ["", "rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "rgb(122, 162, 255) solid 2px"]);
    await t.shot("card-dark.png", { clip: { x: 0, y: 0, width: 720, height: 800, scale: 1 } });
    await esc();
    ok("карточка: под абзацем с хвостиком (над — только у нижнего края), абзац обведён и обводка снимается с возвратом своего стиля; «Английский → русский» (если включено), копировать, ✕; тёмная на тёмном фоне; одна за раз, ✕, Esc, щелчок мимо, заметная прокрутка; поддельные события её не трогают");
    // режим задержки: с абзаца можно дойти до карточки через зазор
    await ev("window.scrollTo(0, 0); setStore({ trigger: 'dwell', dwellMs: 150, showLangBadge: true }); true"); await sleep(100);
    await away();
    await hover("#p1"); await move((await at("#p1")).x + 2, (await at("#p1")).y);
    await until(() => ev("cards().length === 1"), 2000);
    const p1 = await rect("#p1");
    const c1 = await ev("(() => { const r = cards()[0].host.getBoundingClientRect(); return { x: Math.round(r.left + 30), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()");
    for (let y = p1.b - 2; y <= c1.top + 10; y += 2) { await move(c1.x, y); await sleep(15); }
    await sleep(500);
    assert.strictEqual(await ev("cards().length"), 1, "дошли с абзаца до карточки — она на месте");
    await move(900, c1.bottom - 10); await sleep(150);   // вбок, на пустое место справа от текста
    assert.strictEqual(await ev("cards().length"), 0, "ушли с карточки — закрылась");
    // ушли с абзаца, пока перевод шёл, — карточка не появляется
    await ev("window.__bgDelay = 400; true");
    await away();
    await hover("#p2"); await move((await at("#p2")).x + 2, (await at("#p2")).y);
    await sleep(250); await away(); await sleep(700);
    assert.strictEqual(await ev("cards().length"), 0, "курсор ушёл до ответа — карточки нет");
    await ev("window.__bgDelay = 0; true");
    ok("режим задержки: от абзаца до карточки можно дойти через зазор (закрытие через 300 мс), уход с карточки — закрывает; ушли до ответа — карточки нет");

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
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "quota", error: "Лимит DeepL на этот месяц закончился.", detail: "код ответа 456" }) : { ok: true }; true`);
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => ev("document.querySelector('#p1').textContent.startsWith('[ru]')")), "перевели встроенным");
    let ts = await until(async () => { const v = await toastsNow(); return v.length ? v : null; }, 2000) || [];
    assert.deepStrictEqual(ts, ["info:Лимит DeepL закончился — перевожу встроенным.Открыть настройки"]);
    await t.shot("toast-fallback.png", { clip: { x: 600, y: 0, width: 400, height: 140, scale: 1 } });
    await hover("#p2"); await tapShift(); await sleep(200);
    assert.ok(await ev("document.querySelector('#p2').textContent.startsWith('[ru]')"));
    assert.strictEqual(await ev("typeCalls('noticeOnce').filter((c) => c.problem === 'deepl-quota').length"), 1, "сказали один раз");
    assert.ok(!(await ev("__sets.some((s) => 'engine' in s)")), "выбор переводчика не меняли");
    const fbBtn = await ev("uiPoint(toastRoot(), '.t-btn')");
    await click(fbBtn.x, fbBtn.y); await sleep(100);
    assert.deepStrictEqual(await ev("typeCalls('openSettings')"), [{ type: "openSettings", focus: "deepl" }], "«Открыть настройки» — к DeepL");
    ok("DeepL 456 + встроенный есть: перевод встроенным, одно уведомление «Лимит DeepL закончился — перевожу встроенным» с «Открыть настройки», настройка не тронута");
    // сеть
    await load({ trigger: "shift", engine: "deepl" });
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "network", error: "Нет связи с DeepL — проверьте интернет.", detail: "Failed to fetch" }) : { ok: true }; true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    await hover("#p2"); await tapShift(); await sleep(200);
    assert.ok(await ev("['#p1','#p2'].every((s) => document.querySelector(s).textContent.startsWith('[ru]'))"));
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["info:Нет связи с DeepL — перевожу встроенным."]);
    ok("нет связи с DeepL: перевод встроенным, уведомление одной строкой один раз на страницу");
    // без встроенного — ошибка: заголовок с красным «!», что случилось, мелко код ответа, «Открыть настройки»
    await load({ trigger: "shift", engine: "deepl" }, "&builtin=none");
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "quota", error: "Лимит DeepL на этот месяц закончился.", detail: "код ответа 456" }) : { ok: true }; true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["err:Не удалось перевестиЛимит DeepL на этот месяц закончился.код ответа 456Открыть настройки"]);
    const errLook = await ev(`(() => { const r = toastRoot(); const st = (sel, p) => getComputedStyle(r.querySelector(sel))[p];
      return [st(".t-t .err", "color"), st(".t-btn", "borderTopColor"), st(".t-btn", "height"), st(".x-btn", "width"), r.querySelectorAll(".t-ic").length,
        Math.round(r.host.getBoundingClientRect().width)]; })()`);
    assert.deepStrictEqual(errLook, ["rgb(180, 35, 24)", "rgb(133, 139, 148)", "32px", "32px", 1, 360], "! красный, кнопка 32 с рамкой #858b94, ✕ 32, значок расширения, ширина 360");
    assert.ok(await ev("document.querySelector('#p1').classList.contains('ht-error')"), "абзац отмечен ошибкой");
    assert.strictEqual(await ev("getComputedStyle(document.querySelector('#p1'), '::after').content"), '"!"', "«!» после текста — псевдоэлементом");
    assert.strictEqual(await ev("document.querySelector('#p1').childNodes.length"), 1, "в DOM абзаца ничего не добавлено");
    await t.shot("toast-error-action.png", { clip: { x: 0, y: 0, width: 1000, height: 160, scale: 1 } });
    // поддельный щелчок по хосту — ничего; настоящий по кнопке — просьба открыть настройки
    await ev("toastRoot().host.click(); toastRoot().host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); true");
    assert.strictEqual(await ev("typeCalls('openSettings').length"), 0);
    await sleep(5000);
    assert.strictEqual((await toastsNow()).length, 1, "ошибка с действием через 5 с ещё на экране");
    const bt = await ev("uiPoint(toastRoot(), '.t-btn')");
    await click(bt.x, bt.y); await sleep(300);     // 200 мс — исчезновение
    assert.deepStrictEqual(await ev("typeCalls('openSettings')"), [{ type: "openSettings", focus: "translator" }], "настоящий щелчок — «Открыть настройки»");
    assert.strictEqual((await toastsNow()).length, 0, "после действия уведомление закрыто");
    ok("без встроенного: ошибка — «Не удалось перевести» с красным «!», текст + «код ответа 456» мелко + «Открыть настройки»; абзац — красный с «!» (псевдоэлемент); висит > 5 с; кнопка — только настоящим щелчком");
    // простая ошибка (429) — без кнопки, исчезает сама
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "rate", error: "Слишком много запросов к DeepL — подождите немного и попробуйте ещё раз.", detail: "код ответа 429" }) : { ok: true }; true`);
    await sleep(3100);
    await hover("#p2"); await tapShift(); await sleep(150);
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["err:Не удалось перевестиСлишком много запросов к DeepL — подождите немного и попробуйте ещё раз.код ответа 429"]);
    await sleep(5400);
    assert.strictEqual((await toastsNow()).length, 0, "простая ошибка исчезла сама");
    // ключ не подошёл — свой заголовок, подсказка и главная кнопка; ✕ закрывает
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "bad-key", error: "DeepL не принял ключ — проверьте его в окне расширения.", detail: "код ответа 403" }) : { ok: true }; true`);
    await hover("#p3"); await tapShift(); await sleep(150);
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["err:DeepL не принял ключПроверьте ключ в настройках. Пока ничего не переводится.код ответа 403Открыть настройки"]);
    assert.deepStrictEqual(await ev("[...toastRoot().querySelectorAll('.t-btn')].map((b) => b.className + '|' + getComputedStyle(b).backgroundColor)"), ["t-btn pri|rgb(37, 99, 235)"], "главная — синяя");
    await t.shot("toast-bad-key.png", { clip: { x: 600, y: 0, width: 400, height: 160, scale: 1 } });
    const xb = await ev("uiPoint(toastRoot(), '.x-btn')");
    await click(xb.x, xb.y); await sleep(300);
    assert.strictEqual((await toastsNow()).length, 0, "✕ закрывает");
    ok("ключ не подошёл — «DeepL не принял ключ / Проверьте ключ в настройках…» с главной синей кнопкой и ✕; 429 — без кнопки, исчезает сама");
    // «Переводить встроенным» пишет engine через таблицу
    await load({ trigger: "shift", engine: "llm", llmApiKey: "x" });
    await ev(`window.__bgReply = (m) => m.type === "translateBatch" ? ({ ok: false, code: "money", error: "На счёте OpenAI закончились деньги — пополните его или выберите другой переводчик.", detail: "код ответа 429: quota" }) : { ok: true }; true`);
    await hover("#p1"); await tapShift(); await sleep(200);
    const sw = await ev("uiPoint(toastRoot(), '.t-btn')");
    assert.ok(/Переводить встроенным$/.test((await toastsNow())[0]));
    await click(sw.x, sw.y); await sleep(350);
    assert.deepStrictEqual(await ev("__sets.filter((s) => 'engine' in s)"), [{ engine: "chrome" }]);
    assert.deepStrictEqual(await toastsNow(), ["info:Переводит встроенныйЕму не нужен ключ. Сменить переводчик можно в настройках."]);
    ok("«Переводить встроенным» (нет денег на счёте ИИ): записан engine=chrome — значение из таблицы, и об этом сказано");

    // ---- 8. «Перевести страницу»: без «Перевожу…»; «Страница переведена» с парой и «Показать оригинал»; без заливки ----
    await load({ trigger: "shift" });
    await ev("window.__bgDelay = 400; true");
    assert.strictEqual(await ev("sendCmd({ type: 'translatePage', via: 'popup' })"), true, "ответ сразу — окно не закрывается");
    await sleep(250);
    assert.deepStrictEqual(await toastsNow(), [], "пока переводится — без уведомления");
    await t.shot("page-translating.png", { clip: { x: 0, y: 0, width: 1000, height: 800, scale: 0.6 } });
    const pulse = await ev("(() => { const e = document.querySelector('.ht-loading'); return e ? [getComputedStyle(e).animationName, getComputedStyle(e).animationDuration, getComputedStyle(e).animationDelay] : 'нет'; })()");
    assert.deepStrictEqual(pulse, ["ht-pulse", "1.2s", "0.15s"], "во время перевода — синий пульс 1,2 с с задержкой 0,15 с");
    const ldBg = await ev("getComputedStyle(document.querySelector('#p1')).backgroundColor");
    assert.ok(/^rgba\(37, 99, 235, 0\.(1[0-4]|0[7-9])/.test(ldBg), "синяя подложка .14 ↔ .07: " + ldBg);
    // #dark — во второй волне пачек (по 3 пачки по 4 одновременно)
    assert.ok(await until(() => ev("document.querySelector('#dark').classList.contains('ht-loading')"), 1500), "очередь дошла до #dark");
    assert.ok(/ht-loading-dark/.test(await ev("document.querySelector('#dark').className")), "на тёмном фоне — светлый пульс");
    await sleep(200);
    const ldDark = await ev("getComputedStyle(document.querySelector('#dark')).backgroundColor");
    assert.ok(/^rgba\(120, 160, 255, 0\.(1[4-9]|2[0-8])/.test(ldDark), "на тёмном — .28 ↔ .14: " + ldDark);
    assert.ok(await until(async () => /Страница переведена/.test((await toastsNow()).join()), 3000));
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["info:Страница переведенаАнглийский → русскийПоказать оригиналилиEsc"]);
    assert.strictEqual(await ev("getComputedStyle(toastRoot().querySelector('.t-t .ok')).color"), "rgb(21, 122, 60)", "✓ зелёная");
    const fill = await ev("['#p1', '#p2', '#dark'].map((s) => document.querySelector(s).getAttribute('style') || '')");
    assert.deepStrictEqual(fill, ["", "", ""], "страница целиком — без заливки блоков");
    assert.ok(await tr("#p1") && await tr("#p2"));
    await t.shot("toast-done.png", { clip: { x: 600, y: 0, width: 400, height: 160, scale: 1 } });
    const rb = await ev("uiPoint(toastRoot(), '.t-btn')");
    await click(rb.x, rb.y); await sleep(150);
    assert.ok(!(await tr("#p1")) && !(await tr("#p2")), "«Показать оригинал» вернул");
    assert.strictEqual(await ev("document.querySelectorAll('.ht-loading').length"), 0);
    // reduced motion — ровная подложка вместо пульсации
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await hover("#p1"); await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(60);
    const still = await ev("(() => { const e = document.querySelector('.ht-loading'); return e ? getComputedStyle(e).animationName + ' ' + getComputedStyle(e).animationIterationCount : 'нет'; })()");
    assert.strictEqual(still, "ht-pulse-still 1", "prefers-reduced-motion: без пульсации");
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await sleep(500);
    ok("«Перевести страницу»: без «Перевожу…», пульс у переводимых блоков (светлый на тёмном, без движения при reduced-motion); «Страница переведена / Английский → русский / Показать оригинал или Esc» (работает); блоки без заливки");
    // нечего переводить — нейтрально, без значка
    await ev("window.__bgDelay = 0; sendCmd('restoreAll'); document.querySelectorAll('p, button, [role], nav').forEach((e) => e.setAttribute('translate', 'no')); true");
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true"); await sleep(150);
    ts = await toastsNow();
    assert.deepStrictEqual(ts, ["info:Переводить нечегоНа странице нет текста для перевода."]);
    assert.strictEqual(await ev("toastRoot().querySelectorAll('.t-t svg').length"), 0, "без значка смысла");
    ok("«Переводить нечего» — нейтральное уведомление без значка");

    // ---- 8а. Подсветка переведённого клавишей ----
    await load({ trigger: "shift" });
    const hl = async (sel) => { await hover(sel, 10); await tapShift(); await sleep(60); return ev(`(() => { const s = document.querySelector(${JSON.stringify(sel)}).style; return ['background-color', 'box-shadow', 'text-decoration-line', 'text-decoration-color', 'text-decoration-thickness'].map((p) => s.getPropertyValue(p)).join(' | '); })()`); };
    assert.strictEqual(await hl("#p1"), "rgba(255, 207, 74, 0.34) | rgba(255, 207, 74, 0.34) 0px 0px 0px 3px |  |  | ", "янтарь .34 с ореолом 3 px");
    assert.strictEqual(await hl("#dark"), "rgba(255, 207, 74, 0.2) | rgba(255, 207, 74, 0.2) 0px 0px 0px 3px |  |  | ", "на тёмном — .20");
    await ev("document.querySelector('#p2').parentElement.insertBefore(Object.assign(document.createElement('div'), { id: 'cream' }), document.querySelector('#p2')); const c = document.querySelector('#cream'); c.style.background = '#fff8dc'; c.appendChild(document.querySelector('#p2')); true");
    assert.strictEqual(await hl("#p2"), " |  | underline | rgb(176, 122, 0) | 2px", "на кремовом фоне — подчёркивание #b07a00");
    await t.shot("marks.png", { clip: { x: 0, y: 0, width: 700, height: 160, scale: 1 } });
    await ev("setStore({ dispMode: 'custom', dispBg: '#7ed6a5', dispOpacity: 40 }); true"); await sleep(100);
    assert.strictEqual(await ev("document.querySelector('#p1').style.backgroundColor"), "rgba(126, 214, 165, 0.4)", "свой цвет с насыщенностью — сразу у показанного");
    await ev("setStore({ dispMode: 'none' }); true"); await sleep(100);
    assert.strictEqual(await ev("document.querySelector('#p1').getAttribute('style')"), "", "без подсветки — стиль снят");
    await ev("setStore({ dispMode: 'auto' }); true"); await sleep(100);
    await ev("document.querySelector('#p3').style.backgroundColor = 'rgb(1, 2, 3)'; true");
    await hl("#p3"); await tapShift(); await sleep(60);
    assert.strictEqual(await ev("document.querySelector('#p3').getAttribute('style')"), "background-color: rgb(1, 2, 3);", "свой inline-стиль страницы вернулся");
    ok("подсветка: янтарь .34 / .20 с ореолом, на кремовом — подчёркивание #b07a00, свой цвет с насыщенностью, «без подсветки»; свой стиль страницы возвращается");

    // ---- 9. Выключить на этом сайте ----
    await load({ trigger: "shift", disabledSites: ["127.0.0.1", 5, "<script>"], hudShown: true });
    assert.deepStrictEqual(await ev("sendCmd('getHudState')"), { ok: true, hud: false, site: "127.0.0.1", siteOff: true, lang: "en", page: "idle", done: 0, total: 0, count: 0, src: "" });
    await hover("#p1"); await tapShift();
    assert.strictEqual(await calls(), 0, "клавиша не переводит");
    await ev("setStore({ trigger: 'dwell', dwellMs: 100 }); true");
    await away(); await hover("#p2"); await move((await at("#p2")).x + 2, (await at("#p2")).y); await sleep(400);
    assert.strictEqual(await calls(), 0, "наведение не переводит");
    assert.strictEqual(await ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "нашего интерфейса на странице нет (плавающая кнопка включена, но сайт выключен)");
    assert.strictEqual(await ev("sendCmd('toggleHud').hud"), false);
    await ev("sendCmd({ type: 'translatePage', via: 'command', keys: 'Alt+Shift+O' }); true"); await sleep(100);
    assert.deepStrictEqual(await toastsNow(), ["info:На этом сайте перевод выключенВключить можно в окне расширения: «Переводить на 127.0.0.1»."], "«Перевести страницу» на выключенном сайте — объяснение, без перевода");
    assert.strictEqual(await calls(), 0);
    assert.deepStrictEqual(await ev("typeCalls('siteBadge')"), [{ type: "siteBadge", off: true }], "значок вкладки — «off»");
    // включили обратно (из окна расширения) — работает, плавающая кнопка вернулась (сама она — в page/fab.test.js)
    await ev("setStore({ disabledSites: [], trigger: 'shift' }); true"); await sleep(100);
    assert.strictEqual(await ev("sendCmd('getHudState').hud"), true, "плавающая кнопка вернулась");
    assert.deepStrictEqual(await ev("typeCalls('siteBadge').pop()"), { type: "siteBadge", off: false });
    await hover("#p1"); await tapShift();
    assert.ok(await tr("#p1"));
    ok("выключен сайт: ни клавиши, ни наведения, ни плавающей кнопки, «Перевести страницу» объясняет; значок вкладки «off»; включили обратно — работает, кнопка вернулась; мусор в списке отброшен");
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

    // ---- 11. Горячая клавиша вкл/выкл: сказать на странице ----
    await ev("sendCmd({ type: 'say', what: 'disabled', keys: 'Alt+Shift+O' }); true"); await sleep(80);
    assert.deepStrictEqual(await toastsNow(), ["info:Перевод выключенВключить снова — Alt+Shift+O"]);
    await ev("setStore({ enabled: false }); sendCmd({ type: 'translatePage', via: 'command', keys: 'Alt+Shift+O' }); true"); await sleep(80);
    assert.ok((await toastsNow()).includes("info:Перевод выключенВключить: Alt+Shift+O или «Везде» в окне расширения"), JSON.stringify(await toastsNow()));
    await ev("setStore({ enabled: true }); sendCmd({ type: 'say', what: 'enabled' }); true"); await sleep(80);
    assert.ok((await toastsNow()).includes("info:Перевод включён"));
    ok("горячие клавиши: «Перевод выключен / Включить снова — Alt+Shift+O», «Перевод включён»; «перевести страницу» при выключенном переводе — подсказка");

    // ---- 12. Где встаёт уведомление: вверху справа; закрыло бы текст под курсором — внизу справа ----
    // (над плавающей кнопкой — в page/fab.test.js). Прямоугольники: [left, top, right, bottom]; пересекаются ли.
    const boxes = () => ev(`(() => { const b = (r) => r ? (({ left, top, right, bottom }) => [left, top, right, bottom].map(Math.round))(r.host.getBoundingClientRect()) : null;
      const d = document.documentElement; return { toast: b(toastRoot()), w: d.clientWidth, h: d.clientHeight }; })()`);
    const elBox = (sel) => ev(`(({ left, top, right, bottom }) => [left, top, right, bottom].map(Math.round))(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`);
    const cross = (a, c) => a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3];
    const say = async () => { await ev("sendCmd({ type: 'say', what: 'disabled', keys: 'Alt+Shift+O' }); true"); await sleep(120); return boxes(); };
    // широкое окно, курсор слева на тексте (600 px) — вверху справа с отступом 16
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await load({ trigger: "shift" });
    await hover("#p1", 10);
    let bx = await say();
    assert.deepStrictEqual([bx.toast[1], bx.w - bx.toast[2], bx.toast[2] - bx.toast[0]], [16, 16, 360], "вверху справа, отступ 16, ширина 360: " + JSON.stringify(bx));
    await t.shot("toast-top.png");
    // узкое окно: текст под курсором ушёл бы под уведомление — оно внизу справа, отступ 16 (кружка нет)
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 640, height: 600, deviceScaleFactor: 1, mobile: false });
    await load({ trigger: "shift" });
    await hover("#p1", 560);
    bx = await say();
    const p1box = await elBox("#p1");
    assert.ok(!cross(bx.toast, p1box) && bx.h - bx.toast[3] === 16 && bx.w - bx.toast[2] === 16, "внизу справа, не закрывает текст: " + JSON.stringify({ bx, p1box }));
    await t.shot("toast-low.png");
    // текст, который начали переводить, не закрывается: уведомление уже вверху — уходит вниз
    await away(); await sleep(50);
    bx = await say();
    assert.strictEqual(bx.toast[1], 16, "курсора над текстом нет — вверху: " + JSON.stringify(bx));
    await ev("window.__bgDelay = 300; true");
    await hover("#p1", 10); await tapShift(); await sleep(60);   // курсор слева, правый край абзаца — под уведомлением
    bx = await boxes();
    assert.strictEqual(bx.h - bx.toast[3], 16, "переводимый текст под уведомлением — оно ушло вниз: " + JSON.stringify(bx));
    await ev("window.__bgDelay = 0; true");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    ok("уведомление: вверху справа (16, 360); закрыло бы текст под курсором или переводимый — внизу справа в 16");

    // ---- 12а. Свои цвета — по фону сайта, а не по теме системы (кружок — в page/fab.test.js) ----
    await load({ trigger: "shift" });
    const look = () => ev(`(() => { const c = toastRoot().querySelector('.toast'); const g = getComputedStyle;
      return [g(c).backgroundColor, g(c).borderTopColor, g(c).fontFamily.split(',')[0]]; })()`);
    await t.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await ev("sendCmd({ type: 'say', what: 'enabled' }); true"); await sleep(100);
    assert.deepStrictEqual(await look(), ["rgb(255, 255, 255)", "rgb(201, 206, 213)", "system-ui"], "светлый сайт при тёмной теме системы — белое");
    await t.cmd("Emulation.setEmulatedMedia", { features: [] });
    await load({ trigger: "shift" }, "&dark=1");
    await ev("sendCmd({ type: 'say', what: 'enabled' }); true"); await sleep(100);
    assert.deepStrictEqual(await look(), ["rgb(42, 45, 51)", "rgba(255, 255, 255, 0.4)", "system-ui"], "тёмный сайт — #2a2d33 с рамкой .4");
    await t.shot("dark-site.png");
    ok("уведомление: на светлом сайте белое с рамкой #c9ced5 (и при тёмной теме системы), на тёмном — #2a2d33 с рамкой rgba(255,255,255,.4); шрифт системный");

    // ---- 13. Состояние страницы для окна: tabState, stopPage, pageState ----
    const state = () => ev("sendCmd('getHudState')");
    const pick = (st) => [st.page, st.done, st.total, st.count, st.src];
    const pushed = () => ev("typeCalls('pageState').map((c) => c.state.page + ':' + c.state.done + '/' + c.state.total + ':' + c.state.count)");
    await load({ trigger: "shift" });
    assert.deepStrictEqual(pick(await state()), ["idle", 0, 0, 0, ""]);
    // клавишей — «part» с числом абзацев
    await hover("#p1"); await tapShift(); await hover("#p2"); await tapShift(); await sleep(100);
    assert.deepStrictEqual(pick(await state()), ["part", 0, 0, 2, "en"]);
    await esc();
    assert.deepStrictEqual(pick(await state()), ["idle", 0, 0, 0, "en"], "Esc после перевода клавишей — снова ничего");
    // страница: «busy» со счётом видимых абзацев → «done»; Esc → «orig»
    await ev("window.__calls.length = 0; window.__bgDelay = 300; true");
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true"); await sleep(60);
    const busy = await state();
    assert.ok(busy.page === "busy" && busy.done === 0 && busy.total > 8, "идёт перевод видимого: " + JSON.stringify(busy));
    assert.ok(await until(async () => (await state()).page === "done", 3000), "видимое готово — сразу «done»");
    const doneSt = await state();
    assert.ok(doneSt.count >= busy.total - 2 && doneSt.src === "en", JSON.stringify(doneSt));
    await sleep(100);
    const seq = await pushed();
    console.log(`      (pageState окну: ${JSON.stringify(seq)})`);
    assert.ok(seq[0].startsWith("busy:0/" + busy.total) && seq.some((x) => /^busy:([1-9]\d*)\//.test(x)) && seq[seq.length - 1].startsWith("done:"), "окну пришло «busy 0 из M», промежуточный счёт и «done»");
    const nCalls = await ev("trCalls().length");
    assert.ok(nCalls >= Math.ceil(busy.total / 4), `видимое — пачками по 4 абзаца: ${nCalls} запросов на ${busy.total} абзацев`);
    await ev("window.__bgDelay = 0; true");
    await esc();
    assert.deepStrictEqual(pick(await state()).slice(0, 4), ["orig", 0, 0, 0], "Esc на переведённой целиком странице — «orig»");
    // «Перевод» (translatePage) снова — «done»; смена языка — перевод заново с «busy»
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    await ev("window.__calls.length = 0; window.__bgDelay = 200; setStore({ targetLang: 'DE' }); true");
    assert.ok(await until(async () => (await state()).page === "busy", 2000), "смена языка на переведённой странице — «busy»");
    assert.ok(await until(async () => (await state()).page === "done", 3000));
    assert.ok(await until(() => text("#p1").then((v) => v.startsWith("[DE]")), 2000), "переведено заново: " + await text("#p1"));
    assert.ok((await pushed()).some((x) => x.startsWith("busy:")), "окну сообщили «busy»");
    await ev("window.__bgDelay = 0; sendCmd('restoreAll'); setStore({ targetLang: 'RU' }); true"); await sleep(500);
    // «Стоп»: перевод останавливается, переведённое остаётся
    await load({ trigger: "shift" });
    await ev("window.__bgDelay = 300; true");
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await state()).count > 0, 2000), "первые пачки пришли");
    const stopped = await ev("sendCmd('stopPage')");
    assert.ok(stopped.page === "part" && stopped.count > 0, "«Стоп» — «part» с переведённым: " + JSON.stringify(stopped));
    const kept = stopped.count;
    const n0 = await calls();
    await sleep(700);
    assert.strictEqual((await state()).count, kept, "пачки в полёте на страницу не попали");
    assert.ok(await tr("#p1"), "переведённое осталось (без отката)");
    await ev("window.scrollTo(0, document.body.scrollHeight); true"); await sleep(700);
    assert.strictEqual(await calls(), n0, "по прокрутке больше не переводится");
    assert.deepStrictEqual(await toastsNow(), [], "после «Стопа» — без «Страница переведена»");
    await ev("window.scrollTo(0, 0); window.__bgDelay = 0; true");
    // Стоп сразу — «idle», ничего не записано
    await load({ trigger: "shift" });
    await ev("window.__bgDelay = 300; sendCmd({ type: 'translatePage', via: 'popup' }); true"); await sleep(60);
    assert.deepStrictEqual(pick(await ev("sendCmd('stopPage')")).slice(0, 4), ["idle", 0, 0, 0]);
    await sleep(500);
    assert.ok(!(await tr("#p1")) && (await state()).count === 0, "ответы после «Стопа» отброшены");
    await ev("window.__bgDelay = 0; true");
    // toggleHud отвечает тем же состоянием
    const tg = await ev("sendCmd('toggleHud')");
    assert.ok(tg.hud === true && tg.page === "idle" && "count" in tg && "src" in tg, JSON.stringify(tg));
    ok("окну: tabState { page, done, total, count, src } — idle → part (клавишей) → busy N из M по видимым пачками по 4 → done → orig (Esc); pageState при каждом изменении; смена языка — busy заново; stopPage — без отката, пачки в полёте отброшены, прокрутка больше не переводит");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
