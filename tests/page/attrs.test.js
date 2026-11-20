// Текст в атрибутах при переводе страницы: content.js в Chrome без интерфейса на тестовой странице с заглушкой
// chrome.* (fixtures/attrs.html). «Перевести страницу» переводит title, aria-label, placeholder, alt и надпись
// кнопки-<input> (value у button/submit/reset) — по видимости, как текст; откат возвращает исходные значения, а то,
// что сайт вписал сам, не трогает; наведение и Shift атрибутов не меняют. Настоящие события — Input.dispatch*.
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

// Что переводится: [элемент, атрибут, исходное значение].
const TR = [
  ["#p1", "title", "Opens the delivery calendar"],
  ["#help", "title", "Frequently asked questions"],
  ["#img", "alt", "A red bicycle leaning on a wall"],
  ["#imgbtn", "alt", "Submit your order now"],
  ["#icon", "aria-label", "Close the dialog window"],
  ["#q", "placeholder", "Search the whole catalog"],
  ["#ta", "placeholder", "Write a short review here"],
  ["#go", "value", "Send the form"],
  ["#rs", "value", "Clear all fields"],
  ["#bt", "value", "Show more items"],
  ["#mapimg", "alt", "Map of the regions"],
  ["#ar", "alt", "North region of the country"],
  ["#xVal", "aria-label", "Your name for the order"],
];
// Что не переводится: [элемент, атрибут, значение, почему].
const KEEP = [
  ["#help", "href", "/help/faq", "адрес ссылки"],
  ["#help", "data-tip", "Keep this data attribute", "data-*"],
  ["#q", "value", "running shoes", "value поля ввода"],
  ["#xVal", "value", "My own typed words", "value поля ввода"],
  ["#named", "value", "Delete forever", "value кнопки отправки с name уходит на сервер"],
  ["#xNum", "title", "12:30 — 14:45", "без букв"],
  ["#xFile", "title", "annual-report.pdf", "имя файла"],
  ["#xUrl", "title", "https://example.com/about/team", "адрес"],
  ["#xNo", "title", "Brand tooltip kept as is", "translate=\"no\""],
  ["#xNtImg", "alt", "Logo kept in the original", ".notranslate"],
  ["#xEd", "title", "Editable area for your notes", "contenteditable"],
  ["#xRu", "title", "Подсказка уже на русском", "уже на языке перевода"],
];

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
    const attrsOf = (list) => Promise.all(list.map(([sel, name]) => attr(sel, name)));
    const state = () => ev("sendCmd('getHudState')");
    const translatePage = async () => {
      await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
      assert.ok(await until(async () => (await state()).page === "done", 4000), "перевод страницы не дошёл до «done»: " + JSON.stringify(await state()));
    };
    const allTr = async (lang = "RU") => (await attrsOf(TR)).every((v, i) => v === `[${lang}] ` + TR[i][2]);
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(150); };
    const sentItems = () => ev("trCalls().flatMap((c) => c.items)");

    // ---- 1. «Перевести страницу» переводит атрибуты; исключения — нет ----
    await load();
    const before = await ev("__attrs()");
    await translatePage();
    const okAll = await until(() => allTr(), 3000);
    const got = await attrsOf(TR);
    assert.ok(okAll, "атрибуты не переведены: " + JSON.stringify(TR.map((x, i) => x[0] + "[" + x[1] + "]=" + got[i]).filter((s, i) => got[i] !== "[RU] " + TR[i][2])));
    ok(`«Перевести страницу» переводит title, aria-label, placeholder (input, textarea), alt (img, input[type=image], area карты), value кнопок button/submit/reset — ${TR.length} атрибутов`);
    const kept = await attrsOf(KEEP);
    assert.deepStrictEqual(KEEP.map((x, i) => x[0] + "[" + x[1] + "]=" + kept[i]), KEEP.map((x) => x[0] + "[" + x[1] + "]=" + x[2]));
    assert.strictEqual(await ev("document.querySelector('#q').value"), "running shoes", "введённое в поле не тронуто");
    assert.ok(!(await sentItems()).some((s) => s.includes("Подсказка")), "текст на языке перевода переводчику не отправлен");
    ok("не переводятся: " + KEEP.map((x) => x[3]).filter((s, i, a) => a.indexOf(s) === i).join(", "));
    assert.ok((await ev("trCalls().every((c) => c.by === 'user-initiated')")), "перевод страницы — действие пользователя");
    assert.strictEqual(await attr("#far", "title"), "Tooltip far below the fold", "вне экрана — ещё не переведено");
    await ev("document.querySelector('#far').scrollIntoView({ block: 'center' }); true");
    assert.ok(await until(async () => (await attr("#far", "title")) === "[RU] Tooltip far below the fold", 3000), "при прокрутке — переведено");
    await ev("scrollTo(0, 0); true");
    const n0 = await ev("trCalls().length");
    await sleep(800);
    assert.strictEqual(await ev("trCalls().length"), n0, "свои записи в атрибуты наблюдатель не принял за новое содержимое");
    ok("лениво, по видимости: атрибут вне экрана переводится при прокрутке; свои записи нового перевода не вызывают");
    const count = (await state()).count;
    assert.ok(count > 0 && count <= await ev("document.querySelectorAll('p, div.blk, a, button').length"), "count окна — по тексту: " + count);

    // Esc — исходные значения
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before, "после Esc атрибуты — как до перевода");
    ok("Esc возвращает все атрибуты как были");

    // ---- 2. «Показать оригинал»; «Стоп» — без отката ----
    await translatePage();
    assert.ok(await until(() => allTr(), 3000));
    await ev("sendCmd('restoreAll'); true"); await sleep(100);
    assert.deepStrictEqual(await ev("__attrs()"), before, "после «Показать оригинал» атрибуты — как до перевода");
    await translatePage();
    assert.ok(await until(() => allTr(), 3000));
    await ev("sendCmd('stopPage'); true"); await sleep(200);
    assert.ok(await allTr(), "«Стоп» перевод атрибутов не откатывает");
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before, "Esc после «Стопа» — как до перевода");
    ok("«Показать оригинал» возвращает исходные значения; «Стоп» — без отката, Esc после него — оригинал");

    // ---- 3. Сайт сам поменял переведённый атрибут ----
    await translatePage();
    assert.ok(await until(() => allTr(), 3000));
    await ev("document.querySelector('#p1').title = 'Calendar is closed today'; document.querySelector('#bt').value = '—'; true");
    assert.ok(await until(async () => (await attr("#p1", "title")) === "[RU] Calendar is closed today", 3000),
      "новое значение от сайта переведено: " + await attr("#p1", "title"));
    await sleep(400);
    assert.strictEqual(await attr("#bt", "value"), "—", "значение без букв не переводится");
    await ev("sendCmd('restoreAll'); true"); await sleep(100);
    assert.deepStrictEqual([await attr("#p1", "title"), await attr("#bt", "value"), await attr("#help", "title")],
      ["Calendar is closed today", "—", "Frequently asked questions"], "откат: у изменённых сайтом — значение сайта, у прочих — исходное");
    ok("атрибут, который сайт поменял после перевода, переводится заново, а откат оставляет значение сайта");

    // ---- 4. Новое содержимое ----
    await load();
    await translatePage();
    assert.ok(await until(() => allTr(), 3000));
    await ev(`(() => { const p = document.createElement("p"); p.id = "added"; p.title = "Freshly added tooltip";
      p.innerHTML = 'New paragraph added by the site <img id="addedImg" alt="Freshly added picture" width="40" height="20"> later on.';
      document.querySelector("#p1").after(p); return true; })()`);
    assert.ok(await until(async () => (await attr("#added", "title")) === "[RU] Freshly added tooltip" && (await attr("#addedImg", "alt")) === "[RU] Freshly added picture", 3000),
      "атрибуты добавленного элемента переведены: " + await attr("#added", "title") + " / " + await attr("#addedImg", "alt"));
    await ev("document.querySelector('#bt').setAttribute('value', 'Load the next page')");
    assert.ok(await until(async () => (await attr("#bt", "value")) === "[RU] Load the next page", 3000), "новая надпись кнопки переведена");
    await esc();
    assert.deepStrictEqual([await attr("#added", "title"), await attr("#addedImg", "alt"), await attr("#bt", "value")],
      ["Freshly added tooltip", "Freshly added picture", "Load the next page"]);
    ok("новое содержимое переведённой страницы: атрибуты добавленных элементов и новая надпись кнопки переводятся; Esc — их оригинал");

    // ---- 5. Смена языка — заново из оригинала ----
    await load();
    await translatePage();
    assert.ok(await until(() => allTr(), 3000));
    await ev("window.__calls.length = 0; setStore({ targetLang: 'DE' }); true");
    assert.ok(await until(() => allTr("DE"), 4000), "на новом языке: " + JSON.stringify(await attrsOf(TR)));
    assert.ok(!(await sentItems()).some((s) => s.includes("[RU]")), "переводчику ушёл оригинал, а не прежний перевод");
    await esc();
    assert.deepStrictEqual(await ev("__attrs()"), before, "Esc после смены языка — оригинал");
    await ev("setStore({ targetLang: 'RU' }); true"); await sleep(500);
    ok("смена языка на переведённой странице переводит атрибуты заново из оригинала; Esc — оригинал");

    // ---- 6. Shift по элементу с title атрибуты не трогает ----
    await load();
    const r = await ev("(() => { const r = document.querySelector('#p1').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()");
    await t.mouse("mouseMoved", r.x, r.y); await sleep(30); await t.mouse("mouseMoved", r.x + 2, r.y); await sleep(60);
    await tapShift();
    assert.ok(await until(() => ev("document.querySelector('#p1').textContent.startsWith('[RU]')"), 2000), "Shift переводит текст");
    await sleep(300);
    assert.deepStrictEqual(await ev("__attrs()"), before, "Shift не меняет ни одного атрибута");
    ok("Shift по элементу с title переводит текст, атрибуты не меняются");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
