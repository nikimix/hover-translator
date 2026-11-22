// Подсказка поля и надпись кнопки по Shift: content.js в Chrome без интерфейса на тестовой странице с заглушкой
// chrome.* (fixtures/attrs.html). Чистое нажатие Shift над пустым полем не в фокусе переводит его placeholder, над
// кнопкой-<input> — value; второе нажатие — оригинал. Режим карточки — карточка у поля, атрибут прежний; переведённая
// страница — Shift возвращает оригинал поля, следующий — перевод; Esc и «Показать оригинал» — оригинал. Ничего не
// переводят: поле с текстом или в фокусе, value кнопки отправки с name (в режиме замены), нажатие над полем с
// отпусканием над другим элементом, режим задержки, события самой страницы (dispatchEvent). Настоящие события —
// Input.dispatch*.
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
const RU = (s) => "[RU] " + s;
const TA = "Write a short review here", QE = "Enter your email address", CITY = "Start typing a city name";
const GO = "Send the form", RS = "Clear all fields", BT = "Show more items", NAMED = "Delete forever";

(async () => {
  const srv = await serve();
  const PAGE = srv.base + "/attrs.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store) => {
      await t.cmd("Page.navigate", { url: PAGE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const attr = (sel, name) => ev(`document.querySelector(${JSON.stringify(sel)}).getAttribute(${JSON.stringify(name)})`);
    const ph = (sel) => attr(sel, "placeholder");
    const val = (sel) => attr(sel, "value");
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const calls = () => ev("trCalls().length");
    const resetCalls = () => ev("window.__calls.length = 0; true");
    const state = () => ev("sendCmd('getHudState')");
    const translatePage = async () => {
      await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
      assert.ok(await until(async () => (await state()).page === "done", 4000), "перевод страницы не дошёл до «done»: " + JSON.stringify(await state()));
    };
    // Курсор на элемент (dx — от левого края, иначе середина): два движения, как рука.
    const hover = async (sel, dx) => {
      const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
        return { x: Math.round(r.left + ${dx || "r.width / 2"}), y: Math.round(r.top + r.height / 2) }; })()`);
      await t.mouse("mouseMoved", r.x, r.y); await sleep(30); await t.mouse("mouseMoved", r.x + 2, r.y); await sleep(60);
    };
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const press = () => key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
    const release = () => key("keyUp", "Shift", "ShiftLeft", 0, 16);
    const tapShift = async () => { await press(); await sleep(30); await release(); await sleep(150); };
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    // Что из атрибутов страницы изменилось по сравнению с before (строки __attrs()).
    const changed = async (before) => (await ev("__attrs()")).filter((s, i) => s !== before[i]);

    // ---- 1. Пустое поле: Shift — перевод подсказки, второй — оригинал ----
    await load();
    const before = await ev("__attrs()");
    await hover("#ta");
    await tapShift();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA), 3000), "подсказка textarea переведена: " + await ph("#ta"));
    assert.deepStrictEqual(await ev("trCalls().map((c) => [c.items, c.by])"), [[[TA], "user-initiated"]], "переводчику ушла подсказка — по действию пользователя");
    assert.strictEqual(await ev("document.querySelector('#ta').value"), "", "в поле ничего не вписано");
    assert.strictEqual((await changed(before)).length, 1, "изменилась только подсказка поля: " + JSON.stringify(await changed(before)));
    await tapShift();
    assert.strictEqual(await ph("#ta"), TA, "второй Shift — оригинал");
    assert.deepStrictEqual(await ev("__attrs()"), before);
    await hover("#qe");
    await tapShift();
    assert.ok(await until(async () => (await ph("#qe")) === RU(QE), 3000), "подсказка input type=email переведена");
    await tapShift();
    assert.strictEqual(await ph("#qe"), QE);
    ok("Shift над пустым полем (textarea, input type=email) переводит подсказку, второй — оригинал; прочие атрибуты не тронуты");

    // ---- 2. Кнопки-<input>: value; кнопка отправки с name — нет ----
    await resetCalls();
    for (const [sel, v] of [["#go", GO], ["#rs", RS], ["#bt", BT]]) {
      await hover(sel);
      await tapShift();
      assert.ok(await until(async () => (await val(sel)) === RU(v), 3000), "надпись кнопки " + sel + " переведена: " + await val(sel));
    }
    assert.strictEqual(await ev("document.querySelector('#go').value"), RU(GO), "и на экране (свойство value)");
    await tapShift();
    assert.strictEqual(await val("#bt"), BT, "второй Shift над кнопкой — оригинал");
    const n0 = await calls();
    await hover("#named");
    await tapShift();
    await sleep(400);
    assert.strictEqual(await val("#named"), NAMED, "value кнопки отправки с name не меняется");
    assert.strictEqual(await calls(), n0, "переводчику ничего не ушло");
    ok("Shift над кнопкой submit, reset, button переводит надпись (value), второй — оригинал; submit с name — не меняется");

    // Esc и «Показать оригинал»
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before, "Esc вернул надписи кнопок");
    await hover("#ta"); await tapShift();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA), 3000));
    await ev("sendCmd('restoreAll'); true"); await sleep(100);
    assert.deepStrictEqual(await ev("__attrs()"), before, "«Показать оригинал» вернул подсказку");
    ok("Esc и «Показать оригинал» возвращают переведённые клавишей подсказки и надписи");

    // ---- 3. Подсказки не видно — ничего; поле посреди текста ----
    await resetCalls();
    await hover("#q");
    await tapShift();
    await sleep(400);
    assert.strictEqual(await ph("#q"), "Search the whole catalog", "в поле есть текст — подсказку не переводим");
    await t.click(...Object.values(await ev("(() => { const r = document.querySelector('#ta').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 10) }; })()")));
    await sleep(100);
    assert.strictEqual(await ev("document.activeElement.id"), "ta", "фокус в поле");
    await tapShift();
    await sleep(400);
    assert.strictEqual(await ph("#ta"), TA, "поле в фокусе — подсказку не переводим");
    assert.strictEqual(await calls(), 0, "переводчику ничего не ушло");
    await ev("document.activeElement.blur(); true");
    await tapShift();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA), 3000), "фокус ушёл — Shift снова переводит подсказку");
    await esc();
    ok("поле с текстом и поле в фокусе: Shift подсказку не переводит");

    await hover("#pf", 20);
    await tapShift();
    assert.ok(await until(async () => (await text("#pf")).startsWith("[RU]"), 3000), "Shift над текстом рядом с полем переводит текст");
    assert.strictEqual(await ph("#city"), CITY, "подсказка поля при этом не тронута");
    await tapShift();
    assert.ok(!(await text("#pf")).startsWith("[RU]"), "второй Shift — оригинал текста");
    await hover("#city");
    await tapShift();
    assert.ok(await until(async () => (await ph("#city")) === RU(CITY), 3000), "Shift над полем посреди текста переводит подсказку");
    assert.ok(!(await text("#pf")).startsWith("[RU]"), "а не текст вокруг");
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before);
    ok("поле посреди строки текста: Shift над полем — его подсказка, над текстом — текст");

    // ---- 4. Нажали над одним, отпустили над другим — ничего ----
    await resetCalls();
    for (const [from, to] of [["#ta", "#p1"], ["#p1", "#ta"], ["#ta", "#go"]]) {
      await hover(from, from === "#p1" ? 40 : 0);
      await press(); await sleep(30);
      await hover(to, to === "#p1" ? 40 : 0);
      await release(); await sleep(400);
    }
    assert.strictEqual(await calls(), 0, "переводчику ничего не ушло");
    assert.deepStrictEqual(await ev("__attrs()"), before, "подсказка и надпись — как были");
    assert.ok(!(await text("#p1")).startsWith("[RU]"), "текст — как был");
    ok("нажали Shift над полем, отпустили над текстом или кнопкой (и наоборот) — ничего не переводится");

    // ---- 5. Режим карточки ----
    await load({ displayMode: "popover" });
    await hover("#ta");
    await tapShift();
    const card = await until(() => ev("(() => { const r = cards()[0]; return r ? r.querySelector('.c-text').textContent : null; })()"), 3000);
    assert.strictEqual(card, RU(TA), "в карточке перевод подсказки");
    assert.deepStrictEqual(await ev("__attrs()"), before, "атрибут не меняется");
    await tapShift();
    assert.strictEqual(await ev("cards().length"), 0, "второй Shift снял карточку");
    await hover("#named");
    await tapShift();
    assert.strictEqual(await until(() => ev("(() => { const r = cards()[0]; return r ? r.querySelector('.c-text').textContent : null; })()"), 3000), RU(NAMED),
      "надпись кнопки отправки с name — в карточке");
    assert.strictEqual(await val("#named"), NAMED, "value не меняется");
    await esc();
    assert.strictEqual(await ev("cards().length"), 0, "Esc снял карточку");
    ok("режим карточки: Shift над полем или кнопкой — карточка с переводом, атрибут прежний; второй Shift и Esc — без карточки");

    // ---- 6. Переведённая страница: Shift — оригинал поля ----
    await load();
    await translatePage();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA) && (await val("#go")) === RU(GO), 3000), "страница переведена");
    await hover("#ta");
    await tapShift();
    assert.strictEqual(await ph("#ta"), TA, "Shift вернул оригинал подсказки");
    const n1 = await calls();
    await sleep(800);
    assert.strictEqual(await ph("#ta"), TA, "перевод страницы не переводит поле снова");
    assert.strictEqual(await calls(), n1, "и переводчику не уходит");
    await tapShift();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA), 3000), "следующий Shift — перевод снова");
    await hover("#go");
    await tapShift();
    assert.strictEqual(await val("#go"), GO, "и у кнопки — оригинал надписи");
    assert.strictEqual(await ph("#ta"), RU(TA), "у поля перевод остался");
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before, "Esc — все атрибуты как до перевода");
    ok("переведённая страница: Shift над полем или кнопкой возвращает оригинал, следующий — перевод; Esc — оригинал всего");

    // ---- 7. Режим задержки атрибуты не переводит ----
    await load({ trigger: "dwell", dwellMs: 250 });
    for (const sel of ["#ta", "#go", "#city"]) { await hover(sel); await sleep(700); await tapShift(); }
    await sleep(300);
    assert.deepStrictEqual(await ev("__attrs()"), before, "атрибуты — как были");
    // Поле посреди строки: задержка над ним переводит текст вокруг (как и раньше), подсказка и надписи переводчику не уходят.
    const sent = await ev("trCalls().flatMap((c) => c.items)");
    assert.ok(![TA, GO, CITY].some((s) => sent.includes(s)), "подсказки и надписи переводчику не ушли: " + JSON.stringify(sent));
    ok("режим задержки: наведение на поле и кнопку (и Shift) атрибуты не переводит");

    // ---- 8. События страницы (dispatchEvent) — ничего ----
    await load();
    await hover("#ta");
    await ev(`(() => {
      const fire = (el, type, init) => el.dispatchEvent(new (type.startsWith("key") ? KeyboardEvent : MouseEvent)(type, Object.assign({ bubbles: true, composed: true }, init)));
      const ta = document.querySelector("#ta"), go = document.querySelector("#go");
      for (const el of [ta, go]) {
        fire(el, "mouseover", { clientX: 5, clientY: 5 });
        fire(el, "keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
        fire(el, "keyup", { key: "Shift", code: "ShiftLeft" });
      }
      return true; })()`);
    await sleep(400);
    assert.deepStrictEqual(await ev("__attrs()"), before, "атрибуты — как были");
    assert.strictEqual(await calls(), 0, "переводчику ничего не ушло");
    await tapShift();
    assert.ok(await until(async () => (await ph("#ta")) === RU(TA), 3000), "настоящий Shift над тем же полем — переводит");
    ok("поддельные mouseover и Shift от страницы (dispatchEvent) ничего не переводят");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
