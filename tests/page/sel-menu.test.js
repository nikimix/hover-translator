// Пункт контекстного меню «Перевести «…»» на странице: content.js в Chrome без интерфейса на тестовой странице с
// заглушкой chrome.* (fixtures/stub.html). Выделение — настоящей мышью (двойной щелчок, протяжка), правый щелчок —
// настоящий (Input.dispatchMouseEvent, button "right"), затем сообщение translateSelection, как от background.
// Проверяет: перевод выделенного карточкой у места правого щелчка в режиме замены и в режиме «Без клавиши» (текст
// страницы не меняется); выделение страница сняла — переводится присланный текст, карточка там же; поддельный
// contextmenu от страницы место не сдвигает; сайт выключен — уведомление «Включить на этом сайте», по кнопке перевод
// сразу; выделено в поле ввода — уведомление; выделено в нашей карточке, перевод выключен — ничего; длиннее 2000
// знаков — уведомление.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const RU = (s) => "[RU] " + s;
const P1 = "The quick brown fox jumps over the lazy dog near the river bank.";
const P2 = "Another paragraph with plain English text for the sweep test.";

(async () => {
  const srv = await serve();
  const PAGE = srv.base + "/stub.html";
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
      // Сколько contextmenu дошло до страницы: правый щелчок через CDP — настоящий.
      await ev("window.__cm = 0; addEventListener('contextmenu', (e) => { if (e.isTrusted) __cm++; }); true");
    };
    // Середина слова word в элементе sel и прямоугольник его строки (элемент — в одну строку).
    const word = (sel, w) => ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes(${JSON.stringify(w)}));
      const i = tn.data.indexOf(${JSON.stringify(w)}), r = document.createRange();
      r.setStart(tn, i); r.setEnd(tn, i + ${w.length});
      const b = r.getBoundingClientRect(), l = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), left: Math.round(b.left), right: Math.round(b.right),
        top: l.top, bottom: l.bottom };
    })()`);
    const dbl = async (p) => {
      await t.mouse("mouseMoved", p.x, p.y);
      for (const n of [1, 2]) {
        await t.mouse("mousePressed", p.x, p.y, { button: "left", clickCount: n });
        await t.mouse("mouseReleased", p.x, p.y, { button: "left", clickCount: n });
      }
      await sleep(60);
    };
    const drag = async (a, z) => {
      await t.mouse("mouseMoved", a.x, a.y);
      await t.mouse("mousePressed", a.x, a.y, { button: "left", clickCount: 1 });
      await t.mouse("mouseMoved", Math.round((a.x + z.x) / 2), Math.round((a.y + z.y) / 2), { button: "left", buttons: 1 });
      await t.mouse("mouseMoved", z.x, z.y, { button: "left", buttons: 1 });
      await t.mouse("mouseReleased", z.x, z.y, { button: "left", clickCount: 1 });
      await sleep(60);
    };
    const rclick = async (p) => {
      const n = await ev("__cm");
      await t.mouse("mouseMoved", p.x, p.y);
      await t.mouse("mousePressed", p.x, p.y, { button: "right", clickCount: 1 });
      await t.mouse("mouseReleased", p.x, p.y, { button: "right", clickCount: 1 });
      assert.ok(await until(async () => (await ev("__cm")) > n, 2000), "правый щелчок дал contextmenu");
      await sleep(30);
    };
    const selText = () => ev("String(getSelection())");
    const menu = (text) => ev(`sendCmd({ type: "translateSelection", text: ${JSON.stringify(text)} })`);
    // Текст карточки: куски перевода — отдельными абзацами карточки, через перевод строки.
    const cardText = () => ev("(() => { const r = cards()[0]; if (!r) return null; const t = r.querySelector('.c-text'); const ps = t.querySelectorAll('p'); return ps.length ? Array.from(ps, (p) => p.textContent).join('\\n') : t.textContent; })()");
    const cardBox = () => ev("(() => { const r = cards()[0]; if (!r) return null; const b = r.querySelector('.tcard').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; })()");
    // Карточка у строки line: над ней или под ней с зазором до 50 px.
    const nearLine = async (line, what) => {
      const c = await cardBox();
      assert.ok(c, what + ": карточки нет");
      const below = c.top - line.bottom, above = line.top - c.bottom;
      assert.ok((below >= 0 && below <= 50) || (above >= 0 && above <= 50),
        what + ": карточка не у строки щелчка: карточка " + JSON.stringify(c) + ", строка " + JSON.stringify(line));
    };
    const trItems = () => ev("trCalls().map((c) => [c.items, c.by])");
    const reset = () => ev("window.__calls.length = 0; true");
    // Щелчок мимо: закрывает карточку и снимает выделение.
    const away = async () => { await t.click(960, 780); await sleep(100); };

    // ---- 1. Режим замены: двойной щелчок по слову, правый щелчок по нему, пункт меню ----
    await load();
    let w = await word("#p1", "brown");
    await dbl(w);
    assert.strictEqual(await selText(), "brown", "двойной щелчок выделил слово");
    await rclick(w);
    assert.strictEqual(await selText(), "brown", "правый щелчок по выделенному его не снял");
    assert.strictEqual(await menu("brown"), true, "сообщение принято");
    assert.strictEqual(await until(cardText, 3000), RU("brown"), "карточка с переводом выделенного");
    assert.deepStrictEqual(await trItems(), [[["brown"], "user-initiated"]], "переводчику ушло выделенное — по действию пользователя");
    await nearLine(w, "замена");
    assert.strictEqual(await ev("document.querySelector('#p1').textContent"), P1, "текст страницы не заменён — перевод в карточке");
    assert.strictEqual(await ev("cards().length"), 1);
    ok("режим замены: выделенное слово по пункту меню — карточка у места правого щелчка, текст страницы прежний");

    // Выделение на два элемента, щелчок по первому: карточка у строки щелчка, а не у последней строки.
    await away(); await reset();
    const a1 = await word("#p1", "quick"), z2 = await word("#p2", "plain");
    await drag({ x: a1.left + 1, y: a1.y }, { x: z2.right - 1, y: z2.y });
    const two = await selText();
    assert.ok(/^quick[\s\S]*plain$/.test(two), "протяжка выделила от quick до plain: " + JSON.stringify(two));
    const w1 = await word("#p1", "fox");
    await rclick(w1);
    await menu(two);
    assert.ok(await until(async () => (await cardText()) !== null, 3000), "карточка есть");
    assert.deepStrictEqual((await trItems())[0][0].length, 2, "два куска — по элементам");
    await nearLine(w1, "два элемента, щелчок по первому");
    ok("выделение через два элемента, правый щелчок по первому — карточка у его строки");

    // ---- 2. Режим «Без клавиши» (задержка): то же ----
    await load({ trigger: "dwell", dwellMs: 2000 });
    w = await word("#p2", "plain");
    await dbl(w);
    assert.strictEqual(await selText(), "plain");
    await rclick(w);
    await menu("plain");
    assert.strictEqual(await until(cardText, 1500), RU("plain"), "карточка в режиме «Без клавиши»");
    await nearLine(w, "задержка");
    assert.strictEqual(await ev("document.querySelector('#p2').textContent"), P2, "текст страницы не заменён");
    ok("режим «Без клавиши»: пункт меню переводит выделенное карточкой у места щелчка");

    // ---- 3. Страница сняла выделение, пока было открыто меню: переводится присланный текст ----
    await load();
    w = await word("#p2", "English");
    await dbl(w);
    await rclick(w);
    // Поддельный contextmenu страницы в другом месте не сдвигает место карточки.
    await ev("document.querySelector('#p1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 500, clientY: 600 })); true");
    await ev("getSelection().removeAllRanges(); true");
    assert.strictEqual(await selText(), "");
    await menu("English text\n\nfor the sweep");
    assert.strictEqual(await until(cardText, 3000), RU("English text") + "\n" + RU("for the sweep"), "переведён присланный текст, куски — по строкам");
    assert.deepStrictEqual(await trItems(), [[["English text", "for the sweep"], "user-initiated"]]);
    await nearLine(w, "выделение снято");
    ok("страница сняла выделение — переводится текст из сообщения, карточка у места правого щелчка (поддельный contextmenu не в счёт)");

    // Без буквы — ничего.
    await away(); await reset();
    await rclick(await word("#p1", "lazy"));
    await ev("getSelection().removeAllRanges(); true");
    await menu("  12 345  ");
    await sleep(300);
    assert.deepStrictEqual(await trItems(), [], "в присланном тексте нет буквы — не переводится");
    assert.strictEqual(await ev("cards().length"), 0);

    // Длиннее 2000 знаков — уведомление, без перевода.
    await menu("word ".repeat(500));
    assert.ok(await until(async () => (await ev("toasts()")).some((s) => s.includes("Слишком длинный отрывок")), 2000), "уведомление о длине: " + JSON.stringify(await ev("toasts()")));
    assert.deepStrictEqual(await trItems(), []);
    ok("присланный текст без буквы — ничего; длиннее 2000 знаков — уведомление, переводчику ничего не ушло");

    // ---- 4. Сайт выключен: уведомление, по кнопке — перевод сразу ----
    await load();
    const site = await ev("HT_siteKey(location.hostname)");
    await ev(`setStore({ disabledSites: [${JSON.stringify(site)}] }); true`);
    await sleep(100);
    w = await word("#p1", "river");
    await dbl(w);
    await rclick(w);
    await menu("river");
    const note = await until(async () => (await ev("toasts()")).find((s) => s.includes("Включить на этом сайте")), 2000);
    assert.ok(note, "уведомление: " + JSON.stringify(await ev("toasts()")));
    assert.ok(note.includes("На этом сайте перевод выключен") && note.includes("Включите его, чтобы переводить выделенное."), note);
    await sleep(200);
    assert.deepStrictEqual(await trItems(), [], "пока сайт выключен, переводчику ничего не ушло");
    assert.strictEqual(await ev("cards().length"), 0);
    const btn = await ev("uiPoint(toastRoot(), '.t-btn')");
    await t.click(btn.x, btn.y);
    assert.strictEqual(await until(cardText, 3000), RU("river"), "по кнопке — перевод сразу");
    assert.deepStrictEqual(await trItems(), [[["river"], "user-initiated"]]);
    assert.deepStrictEqual(await ev("__store.disabledSites"), [], "сайт включён в настройках");
    assert.strictEqual((await ev("sendCmd('getHudState')")).siteOff, false);
    await nearLine(w, "после включения сайта");
    ok("сайт выключен: уведомление «Включить на этом сайте»; по кнопке сайт включается и перевод показывается сразу у места щелчка");

    // ---- 5. Выделено в поле ввода: уведомление ----
    await load();
    const inp = await ev("(() => { const r = document.querySelector('#inp').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()");
    await dbl(inp);
    assert.strictEqual(await ev("document.activeElement.id"), "inp", "фокус в поле");
    assert.ok(await ev("(() => { const f = document.querySelector('#inp'); return f.selectionEnd > f.selectionStart; })()"), "в поле выделено слово");
    await rclick(inp);
    await menu("search");
    assert.ok(await until(async () => (await ev("toasts()")).some((s) => s.includes("Выделенное в поле ввода пока не переводится.")), 2000),
      "уведомление про поле: " + JSON.stringify(await ev("toasts()")));
    await sleep(200);
    assert.deepStrictEqual(await trItems(), [], "переводчику ничего не ушло");
    assert.strictEqual(await ev("cards().length"), 0);
    assert.strictEqual(await ev("document.querySelector('#inp').value"), "search here", "поле не тронуто");
    ok("выделено в поле ввода — уведомление «пока не переводится», без перевода");

    // ---- 6. Выделено в нашей карточке; перевод выключен — ничего ----
    w = await word("#p1", "dog");
    await away();
    await dbl(w); await rclick(w); await menu("dog");
    assert.strictEqual(await until(cardText, 3000), RU("dog"));
    await reset();
    const inCard = await ev("uiPoint(cards()[0], '.c-text')");
    await dbl(inCard);
    await rclick(inCard);
    await ev("getSelection().removeAllRanges(); true");
    await menu("[RU] dog");
    await sleep(300);
    assert.deepStrictEqual(await trItems(), [], "текст нашей карточки не переводится");
    await away();
    await ev("setStore({ enabled: false }); true");
    w = await word("#p2", "sweep");
    await dbl(w); await rclick(w); await menu("sweep");
    await sleep(300);
    assert.deepStrictEqual(await trItems(), [], "перевод выключен — ничего");
    assert.strictEqual(await ev("cards().length"), 0);
    ok("выделено в нашей карточке или перевод выключен везде — пункт ничего не делает");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
