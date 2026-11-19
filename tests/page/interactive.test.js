// Интерактивные элементы сайта после перевода. content.js в Chrome без интерфейса на
// странице с заглушкой chrome.* и «мини-сайтом» (fixtures/interactive.html): кнопки, ссылки, форма с label,
// select, contenteditable, details, вкладки, аккордеон, меню, окна, веб-компонент с открытым shadow DOM,
// подсказка, мини-каркас, который сам перерисовывает свои узлы, бесконечная лента.
//
// Один и тот же набор действий (exercise) делается настоящими событиями (Input.dispatch*, isTrusted = true)
// до перевода, после перевода клавишей, после Esc, после «Перевести страницу» и после «Показать оригинал»;
// что сделал в ответ сайт (его обработчики пишут в __log), должно совпадать с ожидаемым. Ошибки страницы —
// Runtime.exceptionThrown и console.error/assert. Блоки независимы: каждый начинается с новой загрузки
// страницы, упавший не останавливает остальные (итог и код выхода — в конце).
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");

let pass = 0;
const failed = [];
const ok = (name) => { pass++; console.log("  ok  " + name); };
const note = (s) => console.log("      (" + s + ")");
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;

// Что сайт делает в ответ на exercise() — одинаково до перевода, после него и после отката.
const EXPECTED = [
  "cartBtn", "btnA", "iconBtn", "iconBtn", "iconBtn", "toggle:open", "toggle:closed", "hash:#shipping",
  "nav:/products/running-shoes", "focus:email", "agree:true", "focus:size", "size:m",
  'submit:{"email":"reader@example.com","agree":"yes","size":"m","note":"Please ring the bell twice","action":"subscribe"}',
  "editor:input", "details:open", "details:closed", "tab:2", "tab:1", "acc:open", "acc:closed",
  "dd:open", "dd:item:#orders", "dd:closed", "ka:B", "ka:A", "modal:open", "modal:closed",
  "dialog:open", "dialog:close:ok", "rate", "tip:show", "tip:hide",
];

// Элементы, которые переводятся целиком (owner в терминах content.js), и куда для этого навести курсор.
const OWNERS = ["#topNav", "#cartBtn", "#btnA", "#iconBtn", "#toggleBtn", "#linkP", "#spaP", "#emailRow", "#agreeRow",
  "#sizeRow", "#submitRow", "#sum", "#tablist", "#panel1P", "#accH", "#ddBtn", "#kaBar", "#kaPanelA", "#openModal",
  "#openDialog", "#rating", "#tipRow"];
const HOVER = { "#topNav": "#navHome", "#iconBtn": "#iconSvg", "#linkP": "#hashLink", "#spaP": "#spaLink",
  "#emailRow": "#emailLabel", "#agreeRow": "#agree", "#sizeRow": "#sizeLabel", "#submitRow": "#submitBtn", "#tablist": "#tab1",
  "#accH": "#accBtn", "#kaBar": "#kaA", "#rating": "#rating >>> #q", "#tipRow": "#tipTrigger" };

// Помощники внутри страницы (main world). «a >>> b» — элемент b в открытом shadow root элемента a.
function pageHelpers() {
  const SKIP = /^(SCRIPT|STYLE)$/;
  window.__q = (sel) => { const [a, b] = sel.split(" >>> "); const e = document.querySelector(a); return b ? e && e.shadowRoot.querySelector(b) : e; };
  const textNodes = (root) => {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentNode;
      if (p && p.nodeType === 1 && SKIP.test(p.tagName)) continue;
      if (n.nodeValue.trim()) out.push(n);
    }
    return out;
  };
  // Все непустые тексты страницы, вместе с открытыми shadow root сайта (наши — закрытые — не в счёт).
  window.__texts = () => {
    const out = textNodes(document.body).map((n) => n.nodeValue);
    for (const r of window.__roots) if (r.mode === "open" && r.host.isConnected) out.push(...textNodes(r).map((n) => n.nodeValue));
    return out;
  };
  window.__textsIn = (sel) => textNodes(__q(sel)).map((n) => n.nodeValue);
  window.__ru = (sel) => (sel ? __textsIn(sel) : __texts()).filter((s) => s.includes("[RU]"));
  // Переведены все тексты элемента (кроме полей ввода, списка и редактора — их не переводят).
  window.__allTr = (sel) => {
    const e = __q(sel);
    if (!e) return false;
    const ns = textNodes(e).filter((n) => /\p{L}/u.test(n.nodeValue) && !n.parentElement.closest("select, textarea, [contenteditable]"));
    return ns.length > 0 && ns.every((n) => n.nodeValue.trim().startsWith("[RU] "));
  };
  // Строение DOM: теги, атрибуты, число детей. Пустые class/style и наши классы ht-* не в счёт (их снимают,
  // оставляя пустой атрибут); наш интерфейс и подсказка сайта — тоже.
  window.__struct = () => [...document.body.querySelectorAll("*")].filter((e) => e.tagName !== "SCRIPT" && !e.closest("[data-ht-ui], [data-site]")).map((e) => {
    const attrs = [...e.attributes].map((a) => [a.name, a.name === "class" ? a.value.replace(/\bht-[\w-]+/g, "").trim() : a.value])
      .filter(([n, v]) => !((n === "class" || n === "style") && !v.trim())).map(([n, v]) => n + "=" + v).join(" ");
    return e.tagName + "#" + e.id + " [" + attrs + "] " + e.childNodes.length;
  });
  // Текстовые узлы сайта: те же ли объекты на тех же местах (перевод не создаёт, не удаляет и не оборачивает узлы).
  window.__keep = () => {
    window.__kept = textNodes(document.body).filter((n) => !n.parentElement.closest("#editor, #fw, #feed, [data-site]")).map((n) => ({ n, p: n.parentNode }));
    return __kept.length;
  };
  window.__moved = () => __kept.filter(({ n, p }) => !n.isConnected || n.parentNode !== p).map(({ n }) => n.nodeValue);
  // Что меняется в DOM, пока идёт перевод: узлы (кроме нашего интерфейса и подсказки сайта), атрибуты
  // (кроме class/style — подсветка и «идёт перевод»), текст.
  window.__watch = () => {
    const muts = { list: [], text: 0 };
    const own = (x) => x.nodeType === 1 && (x.hasAttribute("data-ht-ui") || x.hasAttribute("data-site"));
    const handle = (records) => {
      for (const m of records) {
        if (m.type === "characterData") muts.text++;
        else if (m.type === "childList") {
          const ns = [...m.addedNodes, ...m.removedNodes].filter((x) => !own(x));
          if (ns.length) muts.list.push("узлы в " + (m.target.id || m.target.nodeName) + ": " + ns.map((x) => x.nodeName).join(","));
        } else if (m.attributeName !== "class" && m.attributeName !== "style" && !own(m.target)) {
          muts.list.push("атрибут " + m.attributeName + " у " + (m.target.id || m.target.nodeName));
        }
      }
    };
    const mo = new MutationObserver(handle);
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__unwatch = () => { handle(mo.takeRecords()); mo.disconnect(); return muts; };
    return true;
  };
  // То, что по замыслу не переводится: поля, плейсхолдеры, пункты списка, редактор, атрибуты, заголовок вкладки.
  window.__fixed = () => ({
    emailPh: __q("#email").placeholder, notePh: __q("#note").placeholder, note: __q("#note").value, noteDefault: __q("#note").defaultValue,
    options: [...__q("#size").options].map((o) => o.text).join("|"), editor: __q("#editor").textContent,
    attrs: [__q("#hashLink").title, __q("#hashLink").getAttribute("href"), __q("#spaLink").getAttribute("href"), __q("#tipTrigger").title,
      __q("#tipTrigger").getAttribute("aria-label"), __q("#tablist").getAttribute("aria-label"), __q("#rating >>> #why").placeholder].join("|"),
    title: document.title,
  });
  return true;
}

(async () => {
  const srv = await serve();
  const PAGE = srv.base + "/interactive.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push("исключение: " + ((d.exception && d.exception.description) || d.text || JSON.stringify(d)).split("\n")[0]);
    }
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "assert")) {
      errors.push("console." + m.params.type + ": " + m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(" "));
    }
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store) => {
      await ev("window.__old = true").catch(() => {});
      await t.cmd("Page.navigate", { url: PAGE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) });
      const ready = await until(() => ev("!window.__old && typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 8000);
      assert.ok(ready, "страница не загрузилась");
      await sleep(300);
      await ev(`(${pageHelpers})()`);
      await t.mouse("mouseMoved", 820, 450);
      await sleep(50);
    };
    // Точка на элементе (элемент сначала прокручивается к середине окна): слева — в начале текста, справа — у правого края.
    const pt = (sel, where) => ev(`(() => { const e = __q(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" });
      const r = e.getBoundingClientRect(); const x = ${where === "right" ? "r.right - Math.min(20, r.width / 2)" : "r.left + Math.min(24, r.width / 2)"};
      return { x: Math.round(x), y: Math.round(r.top + r.height / 2) }; })()`);
    const move = (x, y, modifiers = 0) => t.mouse("mouseMoved", x, y, { modifiers });
    const clickAt = async (x, y, count = 1) => {
      await move(x, y); await sleep(20);
      await t.mouse("mousePressed", x, y, { button: "left", clickCount: count });
      await t.mouse("mouseReleased", x, y, { button: "left", clickCount: count });
      await sleep(70);
    };
    const click = async (sel, where) => { const p = await pt(sel, where); await sleep(20); await clickAt(p.x, p.y); };
    const hover = async (sel, where) => { const p = await pt(sel, where); await sleep(20); await move(p.x, p.y); await sleep(40); return p; };
    const away = async () => { await move(820, 450); await sleep(50); };
    const clickEmpty = () => clickAt(820, 450);       // пустое место справа от колонки сайта: фокус уходит на body
    const key = (type, k, code, modifiers, vk, text) => t.cmd("Input.dispatchKeyEvent",
      Object.assign({ type, key: k, code, modifiers, windowsVirtualKeyCode: vk }, text ? { text, unmodifiedText: text } : {}));
    const press = async (k, code, vk, text) => { await key(text ? "keyDown" : "rawKeyDown", k, code, 0, vk, text); await key("keyUp", k, code, 0, vk); await sleep(70); };
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(120); };
    const esc = () => press("Escape", "Escape", 27);
    const type = async (s) => { await t.cmd("Input.insertText", { text: s }); await sleep(50); };
    const shiftOn = async (sel, where) => { await hover(sel, where); await tapShift(); };
    const text = (sel) => ev(`__q(${JSON.stringify(sel)}).textContent`);
    const allTr = (sel) => ev(`__allTr(${JSON.stringify(sel)})`);
    const state = () => ev("sendCmd('getHudState')");
    const translatePage = async () => {
      await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
      assert.ok(await until(async () => (await state()).page === "done", 5000), "перевод страницы не дошёл до «done»: " + JSON.stringify(await state()));
    };
    // Прокрутить страницу сверху донизу: остальное после «Перевести страницу» переводится по мере появления.
    const scrollThrough = async () => {
      const H = await ev("document.documentElement.scrollHeight");
      for (let y = 0; y <= H; y += 350) { await ev(`scrollTo(0, ${y}); true`); await sleep(220); }
      await ev("scrollTo(0, 0); true");
      await sleep(250);
      await until(() => ev("!document.querySelector('.ht-loading')"), 3000);
    };
    const closeToast = async () => {
      const x = await ev("toastRoot() && uiPoint(toastRoot(), '.x-btn')");
      if (x) { await clickAt(x.x, x.y); await sleep(300); }
    };
    const untranslated = async (sel) => (await ev(`__ru(${JSON.stringify(sel)})`)).length === 0;

    // Набор действий с элементами сайта. Возвращает, что сделал сайт, и состояние полей.
    const exercise = async () => {
      await ev("__log.length = 0; history.replaceState(null, '', location.pathname + location.search); __q('#form').reset(); true");
      await clickEmpty();
      await click("#cartBtn");
      await click("#btnA");
      await press("Tab", "Tab", 9);                    // клавиатура: фокус на следующую кнопку…
      const tabbed = await ev("document.activeElement.id");
      await press("Enter", "Enter", 13, "\r");         // …и Enter её нажимает
      await click("#iconSvg");                         // «значок + текст»: по значку
      await click("#iconBtn", "right");                // и по тексту
      await click("#toggleBtn"); await click("#toggleBtn");
      await click("#hashLink");
      await click("#spaLink");
      await click("#emailLabel");                      // label for — фокус в поле
      const focusEmail = await ev("document.activeElement.id");
      await type("reader@example.com");
      await click("#agreeLabel", "right");             // флажок внутри label — по тексту
      await click("#sizeLabel");                       // label for у select
      await press("ArrowDown", "ArrowDown", 40);
      await click("#submitBtn");
      await clickEmpty();
      await click("#editorP", "right");
      await press("End", "End", 35);
      await type(" Very comfy.");
      const editor = await text("#editor");
      await ev("resetEditor(); true");
      await clickEmpty();
      await click("#sum"); await click("#sum");
      await click("#tab2");
      const tab2 = await ev("!__q('#panel2').hidden && __q('#panel2').getBoundingClientRect().height > 0");
      await click("#tab1");
      await click("#accBtn"); await click("#accBtn");
      await click("#ddBtn"); await click("#ddOrders");
      await click("#kaB"); await click("#kaA");
      await click("#openModal"); await click("#closeModal");
      await click("#openDialog"); await click("#dlgOk");
      await click("#rating >>> #rate");
      await hover("#tipTrigger"); await away();
      await sleep(80);
      return { log: await ev("__log.slice()"), tabbed, focusEmail, editor, tab2, path: await ev("location.pathname") };
    };
    const checkExercise = (r, when) => {
      assert.deepStrictEqual(r.log, EXPECTED, when + ": сайт ответил не так");
      assert.deepStrictEqual([r.tabbed, r.focusEmail, r.editor, r.tab2, r.path],
        ["iconBtn", "email", "Write your comment about this product here Very comfy.", true, "/interactive.html"], when);
    };

    // Блок: своя загрузка страницы, свои ошибки; падение записывается, остальные блоки идут дальше.
    const block = async (title, fn) => {
      const e0 = errors.length;
      console.log("\n" + title);
      try {
        await fn();
        const site = await ev("__siteErrors").catch(() => []);
        const mine = errors.slice(e0).concat(site.map((s) => "window.onerror: " + s));
        assert.deepStrictEqual(mine, [], "ошибки на странице");
        ok("в консоли страницы нет ошибок и исключений");
      } catch (e) {
        failed.push(title);
        console.log("  ОШИБКА  " + String(e && e.message || e).split("\n").join("\n          "));
        const extra = errors.slice(e0);
        if (extra.length) console.log("          ошибки страницы: " + JSON.stringify(extra));
      }
    };

    let BASE = null;   // как выглядит страница до перевода: тексты, строение, то, что не переводится

    // ---- 1. До перевода ----
    await block("1. До перевода: действия с элементами сайта", async () => {
      await load();
      BASE = { texts: await ev("__texts()"), struct: await ev("__struct()"), fixed: await ev("__fixed()") };
      checkExercise(await exercise(), "до перевода");
      ok(`до перевода все отклики сайта на месте (${EXPECTED.length}): кнопки (мышью и Tab + Enter), «значок + текст», ссылки, label, флажок, select, отправка формы, редактор, details, вкладки, аккордеон, меню, вкладки с отсоединением, окна, веб-компонент, подсказка`);
      assert.deepStrictEqual(await ev("__texts()"), BASE.texts, "действия ничего не оставили на странице");
      assert.deepStrictEqual(await ev("__struct()"), BASE.struct);
      ok("после действий страница в исходном виде (тексты и строение DOM) — дальше с ней сравниваем откат");
    });

    // ---- 2–3. Перевод клавишей, потом Esc ----
    await block("2. Перевод клавишей (наведение + Shift на каждый элемент или рядом), затем Esc", async () => {
      await load();
      await ev("__keep(); __watch()");
      for (const owner of OWNERS) { await shiftOn(HOVER[owner] || owner); await away(); }
      await shiftOn("#editorP");                       // редактор — не переводится
      await shiftOn("#note");                          // в textarea тоже нечего переводить
      await away();
      const missed = [];
      for (const owner of OWNERS) if (!(await until(() => allTr(owner), 1500))) missed.push(owner + " «" + (await text(owner)).trim() + "»");
      assert.deepStrictEqual(missed, [], "не переведены клавишей");
      ok(`клавишей переведены все элементы (${OWNERS.length}): кнопки, ссылки (наведение на ссылку), подписи полей (наведение на label, на сам флажок), «значок + текст» (наведение на значок), summary, вкладки, меню, текст веб-компонента в слоте, подсказка`);
      const dom = await ev("__unwatch()");
      assert.deepStrictEqual(dom.list, [], "перевод клавишей изменил DOM сайта");
      assert.ok(dom.text >= OWNERS.length, "менялись тексты: " + dom.text);
      assert.deepStrictEqual(await ev("__moved()"), [], "текстовые узлы сайта на своих местах");
      assert.deepStrictEqual(await ev("[__q('#iconBtn').childNodes.length, __q('#iconBtn').firstChild.id]"), [2, "iconSvg"], "кнопка «значок + текст»: значок на месте");
      ok(`DOM сайта не менялся: ни одного добавленного или удалённого узла, ни одного атрибута, кроме class/style (изменено текстов: ${dom.text}); те же текстовые узлы на тех же местах`);
      assert.deepStrictEqual(await ev("__fixed()"), BASE.fixed);
      assert.ok(await untranslated("#editor") && await untranslated("#noteRow"));
      const sh = await ev("[__q('#rating >>> #q').textContent, __q('#rating >>> #rate').textContent]");
      note("текст внутри shadow DOM веб-компонента клавишей: «" + sh.join("», «") + "» — " + (sh.every((s) => !s.includes("[RU]")) ? "не переводится (REVIEW.md «Позже»)" : "переведён"));
      ok("не переводятся по замыслу: плейсхолдеры, значение и текст по умолчанию textarea, пункты select, contenteditable, title/aria-label/href, заголовок вкладки");
      checkExercise(await exercise(), "после перевода клавишей");
      ok("после перевода клавишей сайт отвечает так же: все обработчики живы, ссылки ведут туда же, label фокусирует поле, форма уходит с теми же значениями, select, details, вкладки, аккордеон, меню, окна, shadow DOM, подсказка");
      // Esc при открытом меню сайта — только сайту: меню закрывает его же обработчик, перевод на месте;
      // следующий Esc (ничего не открыто) возвращает оригинал
      await ev("__log.length = 0; true");
      await click("#ddBtn");
      const ruOpen = (await ev("__ru()")).length;
      await esc();
      assert.deepStrictEqual(await ev("__log.slice()"), ["dd:open", "dd:closed:esc"], "Esc дошёл до сайта");
      assert.ok(ruOpen > 0 && (await ev("__ru()")).length === ruOpen, "меню сайта было открыто — Esc перевод не трогает");
      await esc();
      assert.deepStrictEqual(await ev("__ru()"), [], "после Esc перевода не осталось");
      assert.deepStrictEqual(await ev("__texts()"), BASE.texts, "тексты — как до перевода");
      assert.deepStrictEqual(await ev("__struct()"), BASE.struct, "строение DOM — как до перевода");
      assert.deepStrictEqual(await ev("__moved()"), []);
      ok("Esc: при открытом меню сайта — закрыл меню его обработчиком (Esc дошёл до сайта), перевод на месте; следующий Esc — все тексты, строение DOM и текстовые узлы как до перевода");
      checkExercise(await exercise(), "после Esc");
      ok("после Esc сайт отвечает так же");
    });

    // ---- 4–5. «Перевести страницу», потом «Показать оригинал» ----
    await block("3. «Перевести страницу», затем «Показать оригинал»", async () => {
      await load();
      await ev("__keep(); __watch()");
      await translatePage();
      assert.ok((await ev("toasts()")).some((s) => s.startsWith("info:Страница переведена")));
      // Уведомление встаёт вверху справа — там, где в липкой шапке сайта кнопка корзины.
      const cart = await pt("#cartBtn");
      const covered = await ev(`(() => { const e = document.elementFromPoint(${cart.x}, ${cart.y}); return !!e && e.hasAttribute("data-ht-ui"); })()`);
      await ev("__log.length = 0; true");
      if (covered) await clickAt(cart.x, cart.y);
      note(covered ? `уведомление «Страница переведена» закрывает кнопку в липкой шапке сайта справа: щелчок по ней достался уведомлению, обработчик сайта ${(await ev("__log.includes('cartBtn')")) ? "сработал" : "не сработал"}` : "уведомление не закрывает кнопку в шапке");
      await closeToast();
      await scrollThrough();
      const missed = [];
      for (const owner of OWNERS.concat(["#feed > li", "#loadMore", "#fwStatus", "#fwWhole"])) if (!(await allTr(owner))) missed.push(owner + " «" + (await text(owner)).trim() + "»");
      assert.deepStrictEqual(missed, [], "не переведены страницей");
      ok("«Перевести страницу» перевела всё видимое, остальное — при прокрутке (шапка, кнопки, ссылки, подписи полей, вкладки, меню, слот веб-компонента, лента, каркас)");
      const dom = await ev("__unwatch()");
      assert.deepStrictEqual(dom.list, [], "перевод страницы изменил DOM сайта");
      assert.deepStrictEqual(await ev("__moved()"), []);
      ok(`DOM сайта не менялся (изменено только текстов: ${dom.text}); текстовые узлы те же и на тех же местах`);
      assert.deepStrictEqual(await ev("__fixed()"), BASE.fixed);
      assert.ok(await untranslated("#editor") && await untranslated("#noteRow"));
      const sh = await ev("[__q('#rating >>> #q').textContent, __q('#rating >>> #rate').textContent]");
      assert.ok(sh.every((s) => !s.includes("[RU]") || s.startsWith("[RU] ")), "текст в shadow DOM не испорчен: " + sh);
      note("текст внутри shadow DOM при переводе страницы — " + (sh.every((s) => !s.includes("[RU]")) ? "не переводится (REVIEW.md «Позже»)" : "переведён"));
      ok("не переводятся по замыслу: плейсхолдеры, textarea, пункты select, contenteditable, атрибуты, заголовок вкладки");
      // Скрытое при переводе переводится, когда его показывают (IntersectionObserver)
      const shown = [];
      for (const [open, sel, close] of [["#tab2", "#panel2P", "#tab1"], ["#accBtn", "#accP", "#accBtn"], ["#sum", "#detBody", "#sum"],
        ["#toggleBtn", "#toggleBody", "#toggleBtn"], ["#openModal", "#modalText", "#closeModal"], ["#openDialog", "#dlgText", "#dlgOk"],
        ["#ddBtn", "#ddLi1", "#ddBtn"]]) {
        await click(open);
        shown.push(sel + ":" + !!(await until(() => allTr(sel), 2000)));
        await click(close);
      }
      assert.deepStrictEqual(shown.filter((s) => s.endsWith(":false")), [], "скрытое при переводе не перевелось, когда его показали");
      ok("скрытое при переводе (вкладка, аккордеон, details, «Show more», своё окно, <dialog>, меню) переводится, когда сайт его показывает");
      checkExercise(await exercise(), "после «Перевести страницу»");
      ok("после «Перевести страницу» сайт отвечает так же (все обработчики, ссылки, label, форма с теми же значениями, select, details, вкладки, окна, shadow DOM, подсказка)");
      await ev("sendCmd('restoreAll'); true");
      await sleep(300);
      assert.deepStrictEqual(await ev("__ru()"), [], "после «Показать оригинал» перевода не осталось");
      assert.deepStrictEqual(await ev("__texts()"), BASE.texts, "тексты — как до перевода");
      assert.deepStrictEqual(await ev("__struct()"), BASE.struct, "строение DOM — как до перевода");
      assert.deepStrictEqual(await ev("__moved()"), []);
      ok("«Показать оригинал»: все тексты, строение DOM и текстовые узлы — как до перевода");
      checkExercise(await exercise(), "после «Показать оригинал»");
      ok("после «Показать оригинал» сайт отвечает так же");
    });

    // ---- 6. Каркас перерисовывает свои узлы после перевода клавишей ----
    const FW_SITE = { state: "shipped to your address", fresh: "The framework rendered this new label", whole: "This sentence was replaced by the framework" };
    const fwAfterRestore = async () => {
      assert.deepStrictEqual(await ev("__ru('#fw')"), [], "в каркасе не осталось перевода");
      assert.deepStrictEqual(await ev("[__q('#fwStatus').textContent, __q('#fwNew').textContent, __q('#fwWhole').textContent, [...__q('#fwKeyed').children].map((li) => li.textContent)]"),
        ["Order status: shipped to your address (tracking enabled) for delivery today", FW_SITE.fresh, FW_SITE.whole,
          ["Third keyed row of the list", "First keyed row of the list", "Second row now has emphasis"]], "откат не тронул того, что сайт вписал сам");
    };
    await block("4. Мини-каркас перерисовывает узлы через 0,5 с после перевода клавишей; Esc", async () => {
      await load();
      for (const sel of ["#fwStatus", "#fwSwap", "#fwRow1", "#fwRow2", "#fwRow3", "#fwWhole"]) { await shiftOn(sel); await away(); }
      for (const sel of ["#fwStatus", "#fwSwap", "#fwRow1", "#fwRow2", "#fwRow3", "#fwWhole"]) assert.ok(await until(() => allTr(sel), 1500), sel);
      await ev("fw.updateIn(500); true");
      assert.ok(await until(() => ev("__log.includes('fw:update')"), 2000), "каркас перерисовал");
      await sleep(100);
      const now = await ev("[__q('#fwState').textContent, __q('#fwStatus').textContent, __q('#fwNew').textContent, __q('#fwWhole').textContent, [...__q('#fwKeyed').children].map((li) => li.textContent)]");
      assert.deepStrictEqual(now, [FW_SITE.state, "[RU] Order status: shipped to your address (tracking enabled) [RU] for delivery today", FW_SITE.fresh, FW_SITE.whole,
        ["[RU] Third keyed row of the list", "[RU] First keyed row of the list", "Second row now has emphasis"]]);
      ok("каркас после перевода: insertBefore перед переведённым узлом, removeChild переведённого узла, replaceChild, перестановка строк ключевого списка, nodeValue и textContent — без исключений; его новые тексты — ровно те, что он вписал, переведённые соседние узлы целы");
      await esc();
      await fwAfterRestore();
      ok("Esc вернул оригинал только нашим узлам: то, что каркас вписал после перевода, осталось как есть (не затёрто старым оригиналом)");
    });

    // ---- 7. То же при переводе страницы ----
    await block("5. Мини-каркас перерисовывает узлы через 0,5 с после «Перевести страницу»; «Показать оригинал»", async () => {
      await load();
      await ev("__q('#fw').scrollIntoView({ block: 'center' }); true"); await sleep(100);
      await translatePage();
      for (const sel of ["#fwStatus", "#fwSwap", "#fwKeyed > li", "#fwWhole"]) assert.ok(await until(() => allTr(sel), 1500), sel);
      await ev("fw.updateIn(500); true");
      assert.ok(await until(() => ev("__log.includes('fw:update')"), 2000));
      await sleep(1500);
      const site = await ev("[__q('#fwState').textContent, __q('#fwStatus').childNodes[2].nodeValue, __q('#fwNew').textContent, __q('#fwWhole').textContent, __q('#fwRow2').textContent]");
      // новое при переведённой странице переводится само (наблюдатель нового содержимого): целиком, без смеси с оригиналом
      assert.deepStrictEqual(site, ["[RU] " + FW_SITE.state, " [RU] (tracking enabled)", "[RU] " + FW_SITE.fresh, "[RU] " + FW_SITE.whole, "[RU] Second row now has emphasis"],
        "новые тексты каркаса не переведены или испорчены");
      assert.deepStrictEqual(await ev("[__q('#fwStatus').firstChild.nodeValue, __q('#fwStatus').lastChild.nodeValue, __q('#fwRow3').textContent, __q('#fwRow1').textContent]"),
        ["[RU] Order status: ", " [RU] for delivery today", "[RU] Third keyed row of the list", "[RU] First keyed row of the list"], "переведённые узлы, которые каркас не трогал, целы");
      ok("перерисовка при переведённой странице: новые тексты каркаса переведены сами, перевод и оригинал не смешаны внутри узла, нетронутые каркасом переводы на месте");
      await ev("sendCmd('restoreAll'); true"); await sleep(200);
      await fwAfterRestore();
      ok("«Показать оригинал» не затёр того, что каркас вписал после перевода");
    });

    // ---- 8. Каркас перерисовал узел, пока перевод ещё шёл ----
    await block("6. Перерисовка, пока перевод в пути: поздний ответ не затирает новый текст сайта", async () => {
      await load();
      await ev("window.__bgDelay = 1000; true");
      await shiftOn("#fwStatus"); await shiftOn("#fwWhole"); await away();
      await ev("fw.updateIn(200); true");
      assert.ok(await until(() => ev("__log.includes('fw:update')"), 2000));
      assert.ok(await until(() => ev("!document.querySelector('.ht-loading')"), 3000));
      await sleep(150);
      assert.deepStrictEqual(await ev("[__q('#fwStatus').textContent, __q('#fwWhole').textContent]"),
        ["[RU] Order status: shipped to your address (tracking enabled) [RU] for delivery today", FW_SITE.whole]);
      ok("клавишей: ответ пришёл после перерисовки — новый текст сайта не затёрт, остальные узлы элемента переведены");
      await esc();
      assert.deepStrictEqual(await ev("[__q('#fwStatus').textContent, __q('#fwWhole').textContent]"),
        ["Order status: shipped to your address (tracking enabled) for delivery today", FW_SITE.whole]);
      // то же при переводе страницы: пачки идут по 3 параллельно, и пачка с узлами каркаса может уйти и до
      // перерисовки, и после неё. Поэтому проверяем не точный текст, а то, что перевод СТАРОГО текста нигде
      // не лёг поверх нового: новый текст сайта — как есть или переведён целиком.
      await load();
      await ev("__q('#fw').scrollIntoView({ block: 'center' }); window.__bgDelay = 700; true"); await sleep(100);
      await ev("sendCmd({ type: 'translatePage', via: 'popup' }); fw.updateIn(250); true");
      assert.ok(await until(async () => (await state()).page === "done", 8000));
      await sleep(150);
      const stale = ["being prepared", "This label will be replaced by the framework", "This sentence is rendered again from scratch", "Second keyed row of the list"];
      const inFw = await ev("__textsIn('#fw')");
      assert.deepStrictEqual(inFw.filter((s) => stale.some((x) => s.includes(x))), [], "перевод старого текста лёг поверх нового: " + JSON.stringify(inFw));
      const st = await ev("[__q('#fwState').textContent, __q('#fwNew').textContent, __q('#fwWhole').textContent]");
      const whole = (s, site) => s === site || s === "[RU] " + site;
      assert.ok(whole(st[0], FW_SITE.state) && whole(st[1], FW_SITE.fresh) && whole(st[2], FW_SITE.whole), "новый текст сайта испорчен: " + JSON.stringify(st));
      await ev("sendCmd('restoreAll'); true"); await sleep(200);
      await fwAfterRestore();
      ok("при переводе страницы: перевод старого текста нигде не лёг поверх нового, откат после этого чистый");
    });

    // ---- 9. Подпись кнопки — часть логики сайта ----
    await block("7. Кнопка, подпись которой меняет сам сайт", async () => {
      await load();
      await shiftOn("#toggleBtn");
      assert.ok(await until(() => allTr("#toggleBtn"), 1500));
      await click("#toggleBtn");
      assert.deepStrictEqual([await text("#toggleBtn"), await ev("__q('#toggleBody').hidden")], ["Hide product details", false], "обработчик сработал и вписал свою подпись");
      await clickEmpty();
      await esc();
      assert.strictEqual(await text("#toggleBtn"), "Hide product details", "Esc не вернул старую подпись поверх новой");
      await click("#toggleBtn");
      assert.deepStrictEqual([await text("#toggleBtn"), await ev("__q('#toggleBody').hidden")], ["Show more product details", true]);
      ok("переведённая кнопка «Show more»: щелчок работает, подпись сайта вписывается как есть, Esc не возвращает старую подпись поверх новой");
    });

    // ---- 10. Бесконечная лента ----
    await block("8. Бесконечная лента при переведённой странице", async () => {
      await load();
      await translatePage();
      await closeToast();
      await ev("__q('#feed').scrollIntoView({ block: 'center' }); true");
      assert.ok(await until(() => allTr("#feed > li"), 2000) && await until(() => allTr("#loadMore"), 2000), "лента переведена при прокрутке");
      await click("#loadMore");
      assert.ok(await ev("__log.includes('feed:more:button')"), "переведённая кнопка «ещё» работает");
      await ev("scrollTo(0, 0); true"); await sleep(200);          // «маяк» ленты вне окна — его вход сайт заметит
      await ev("window.feedAuto = true; __q('#sentinel').scrollIntoView({ block: 'end' }); true");
      assert.ok(await until(() => ev("__log.includes('feed:more:scroll')"), 2000), "прокрутка до низа подгрузила ещё");
      await ev("window.feedAuto = false; true");
      await sleep(1500);
      const fresh = await ev("[...document.querySelectorAll('#feed li.fresh')].map((li) => li.textContent)");
      assert.ok(fresh.length >= 6 && fresh.every((s) => /^\[RU\] Review from page \d+, number \d: comfortable and light shoes$/.test(s)), "новые пункты не переведены сами или испорчены: " + JSON.stringify(fresh));
      ok(`лента: переведена при прокрутке, кнопка «ещё» и подгрузка прокруткой работают, подгруженные пункты (${fresh.length}) переведены сами`);
      await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
      assert.ok(await until(() => ev("[...document.querySelectorAll('#feed li.fresh')].every((li) => li.textContent.startsWith('[RU] '))"), 3000), "повторное «Перевести страницу» переводит новые пункты");
      ok("повторное «Перевести страницу» переводит пункты, подгруженные после перевода");
      await ev("sendCmd('restoreAll'); true"); await sleep(200);
      assert.deepStrictEqual(await ev("__ru()"), [], "после отката перевода не осталось");
      ok("«Показать оригинал» возвращает и старые, и подгруженные пункты");
    });

    // ---- 11. Веб-компонент, фокус, выделение ----
    await block("9. Shadow DOM, клавиатурный фокус и выделение текста", async () => {
      await load();
      await click("#rating >>> #why");                // фокус в поле внутри открытого shadow root
      assert.strictEqual(await ev("document.activeElement.id + '/' + document.activeElement.shadowRoot.activeElement.id"), "rating/why");
      await shiftOn("#btnA");
      await sleep(200);
      assert.ok(await untranslated("#btnA"), "Shift, пока фокус в поле веб-компонента, — набор текста, не перевод");
      await type("Light");
      assert.strictEqual(await ev("__q('#rating >>> #why').value"), "Light");
      ok("фокус в поле внутри shadow DOM сайта: Shift не переводит (это набор текста), ввод работает");
      await clickEmpty();
      await shiftOn("#rating >>> #q");
      assert.ok(await until(() => allTr("#rating"), 1500), "текст веб-компонента в слоте переведён");
      await ev("__log.length = 0; true");
      await click("#rating >>> #rate");
      assert.deepStrictEqual(await ev("__log.slice()"), ["rate"]);
      ok("веб-компонент: Shift над его текстом переводит текст в слоте (light DOM), кнопка внутри shadow root работает");
      // выделение: двойной щелчок по переведённому слову, Shift+стрелка расширяет — перевод от этого не снимается
      await shiftOn("#panel1P");
      assert.ok(await until(() => allTr("#panel1P"), 1500));
      const w = await pt("#panel1P");
      await clickAt(w.x + 30, w.y, 1); await t.mouse("mousePressed", w.x + 30, w.y, { button: "left", clickCount: 2 }); await t.mouse("mouseReleased", w.x + 30, w.y, { button: "left", clickCount: 2 });
      await sleep(80);
      const sel1 = await ev("getSelection().toString()");
      await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
      await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39); await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39);
      await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39); await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39);
      await key("keyUp", "Shift", "ShiftLeft", 0, 16);
      await sleep(150);
      const sel2 = await ev("getSelection().toString()");
      assert.ok(sel1.trim().length > 0 && sel2.length === sel1.length + 2 && (await text("#panel1P")).includes(sel2) && await allTr("#panel1P"),
        `выделение: «${sel1}» → «${sel2}», текст: «${await text("#panel1P")}»`);
      ok(`выделение переведённого текста работает (двойной щелчок — «${sel1}», Shift+→ расширяет), Shift+стрелка — не наш жест: перевод на месте`);
      // фокус в select: Shift — ничего (по замыслу typingFocus), спорно — в отчёте
      await ev("sendCmd('restoreAll'); true");
      await click("#sizeLabel");
      await shiftOn("#btnA"); await sleep(200);
      note("фокус в <select> (после выбора размера): Shift над кнопкой " + ((await allTr("#btnA")) ? "переводит" : "не переводит, пока фокус не уйдёт из списка (typingFocus считает SELECT полем ввода)"));
      await clickEmpty();
    });

    // ---- Найденные ошибки: проверки падают, пока они не исправлены ----
    await block("10. Сайт перерисовал переведённый элемент — Shift переводит его с первого нажатия", async () => {
      await load();
      // кнопка: сайт вписал новую подпись в тот же узел (nodeValue)
      await shiftOn("#toggleBtn");
      assert.ok(await until(() => allTr("#toggleBtn"), 1500));
      await click("#toggleBtn");
      assert.strictEqual(await text("#toggleBtn"), "Hide product details");
      await shiftOn("#toggleBtn"); await sleep(200);
      const btn1 = await text("#toggleBtn");
      await tapShift(); await sleep(200);
      const btn2 = await text("#toggleBtn");
      // абзац: сайт заменил содержимое целиком (textContent — новый узел)
      await shiftOn("#fwWhole");
      assert.ok(await until(() => allTr("#fwWhole"), 1500));
      await ev("fw.update(); true");
      assert.strictEqual(await text("#fwWhole"), FW_SITE.whole);
      await shiftOn("#fwWhole"); await sleep(200);
      const whole1 = await text("#fwWhole");
      note(`после перерисовки: кнопка — 1-е нажатие «${btn1}», 2-е «${btn2}»; абзац — 1-е нажатие «${whole1}»`);
      assert.deepStrictEqual([btn1, whole1], ["[RU] Hide product details", "[RU] " + FW_SITE.whole],
        "первое нажатие Shift ничего не делает: toggle() снимает «мёртвую» строку (content.js, toggle)");
      ok("Shift после перерисовки сайтом переводит с первого нажатия");
    });

    await block("11. Панель, которую сайт временно отсоединил (KeepAlive), после «Показать оригинал» — на языке оригинала", async () => {
      const ORIG = "This overview panel is detached while the other tab is open.";
      // «Перевести страницу» → другая вкладка (панель A отсоединена) → «Показать оригинал» → обратно на A
      await load();
      await ev("__q('#ka').scrollIntoView({ block: 'center' }); true"); await sleep(100);
      await translatePage();
      assert.ok(await allTr("#kaPanelA"));
      await closeToast();
      await click("#kaB");
      await ev("sendCmd('restoreAll'); true"); await sleep(150);
      await click("#kaA");
      const viaPage = await text("#kaPanelA");
      await esc();
      const afterEsc = await text("#kaPanelA");
      // клавишей: Shift → другая вкладка → Esc → обратно
      await load();
      await shiftOn("#kaPanelA");
      assert.ok(await until(() => allTr("#kaPanelA"), 1500));
      await click("#kaB");
      await esc();
      await click("#kaA");
      const viaKey = await text("#kaPanelA");
      note(`вернувшаяся панель: после «Показать оригинал» — «${viaPage}» (и после ещё одного Esc — «${afterEsc}»); после Esc при переводе клавишей — «${viaKey}»`);
      assert.deepStrictEqual([viaPage, viaKey], [ORIG, ORIG], "откат пропускает отсоединённые узлы (content.js, releaseLine: n.isConnected), и перевод возвращается вместе с панелью");
      ok("панель, которую сайт отсоединял, возвращается на языке оригинала");
    });

    // ---- 12. Вложенные элементы ----
    // В <li><a><div>(Top)</div></a></li> верхним строчным контейнером считаются и li, и div. Страница переводила оба
    // на одних и тех же текстовых узлах, и после отката часть текста оставалась переведённой: «(Top)» на Википедии,
    // «Docusaurus» в шапке, пункты мега-меню MDN.
    await block("12. Вложенные элементы (оглавление Википедии, шапка Docusaurus, мега-меню MDN): «Перевести страницу», затем Esc", async () => {
      await load();
      const NESTED = ["#toc", "#navbar", "#mega"];
      const TEXTS = ["(Top)", "Introduction to running", "Caring for your shoes", "Docusaurus", "Documentation", "References",
        "Elements", "HTML: Markup language", "See all…"];
      const before = await ev("__texts()");
      await ev("__keep()");
      await translatePage();
      await ev("__q('#s-nested').scrollIntoView({ block: 'center' }); true");
      const done = async () => { for (const s of NESTED) if (!(await allTr(s))) return false; return true; };
      assert.ok(await until(done, 3000), "не переведены: " + JSON.stringify(await ev(`${JSON.stringify(NESTED)}.map((s) => __textsIn(s))`)));
      const sent = await ev("trCalls().flatMap((c) => c.items)");
      const times = TEXTS.map((s) => s + ": " + sent.filter((x) => x === s).length).filter((s) => !s.endsWith(": 1"));
      await esc();
      await sleep(300);
      assert.deepStrictEqual(await ev("__ru()"), [], "после Esc перевода не осталось");
      assert.deepStrictEqual(await ev("__texts()"), before, "тексты — как до перевода");
      assert.deepStrictEqual(await ev("__moved()"), []);
      ok("Esc: ни одного переведённого узла, все тексты и текстовые узлы — как до перевода");
      assert.deepStrictEqual(times, [], "каждый текст вложенных элементов отправлен на перевод ровно один раз");
      ok("вложенные элементы переводятся один раз — внешним элементом, внутренний второй строкой не переводится");
    });

    // ---- 13. Новое содержимое при переведённой странице (MutationObserver) ----
    await block("13. Новое содержимое при переведённой странице переводится само; Esc; сайт заменил <body>", async () => {
      await load({ hudShown: true });
      await ev("__q('#feed').scrollIntoView({ block: 'center' }); true"); await sleep(100);
      await translatePage();
      await closeToast();
      assert.ok(await until(() => allTr("#feed > li"), 2000), "лента переведена");
      const calls = () => ev("trCalls().length");
      const sentSince = (n) => ev(`trCalls().slice(${n}).flatMap((c) => c.items)`);
      await sleep(1000);
      const c0 = await calls();
      // сайт: три новых пункта ленты, пункт с разметкой, новый текст в переведённом пункте (весь узел) и ещё один
      // узел в другом переведённом пункте (часть элемента: прежний перевод в нём остаётся)
      await ev(`(() => { loadMore("mo"); const f = __q("#feed");
        const li = document.createElement("li"); li.id = "rich"; li.innerHTML = "Review <b>number four</b> mentions the price"; f.appendChild(li);
        f.children[0].firstChild.nodeValue = "Review number one was edited by its author";
        f.children[1].appendChild(document.createTextNode(" and it was updated today"));
        return true; })()`);
      assert.ok(await until(() => allTr("#feed > li"), 1500), "новое не переведено: " + JSON.stringify(await ev("__textsIn('#feed')")));
      const second = await ev("__q('#feed').children[1].firstChild.nodeValue");
      const c1 = await calls();
      const sent1 = await sentSince(c0);
      assert.ok(c1 - c0 <= 3, "запросов к переводчику на новое: " + (c1 - c0));
      assert.ok(!sent1.includes("Review number two: the sole is soft and durable") && second.startsWith("[RU] "),
        "у пункта, куда сайт дописал узел, заново переведён и прежний текст: " + JSON.stringify(sent1));
      ok(`через ~1 с переведены новые пункты ленты, переписанный пункт и дописанный узел (запросов: ${c1 - c0}, прежний перевод не отправлялся заново)`);
      // сайт переписал один узел из нескольких в переведённом элементе
      await ev("__q('#rich b').firstChild.nodeValue = 'number five'; true");
      assert.ok(await until(() => allTr("#rich"), 1500), "переписанный узел не переведён: " + JSON.stringify(await ev("__textsIn('#rich')")));
      const c2 = await calls();
      assert.deepStrictEqual(await sentSince(c1), ["number five"], "доперевод: отправлен только переписанный узел");
      ok("сайт переписал один узел из трёх — переведён только он, остальной перевод на месте");
      await sleep(1000);
      assert.strictEqual(await calls(), c2, "свои записи вызвали новый перевод");
      ok("свои записи перевода не вызывают повторного перевода (за 1 с — ни одного запроса)");
      // «часы»: сайт переписывает текст элемента каждые 100 мс — заново переводится ограниченное число раз
      await ev(`(() => { const n = __q("#feed").children[2].firstChild; let i = 0;
        window.__clock = setInterval(() => { n.nodeValue = "Updated " + (++i) + " seconds ago by the shop"; }, 100); return true; })()`);
      await sleep(3000);
      await ev("clearInterval(__clock); true");
      await sleep(800);
      const clock = (await sentSince(c2)).filter((s) => s.startsWith("Updated "));
      assert.ok(clock.length >= 1 && clock.length <= 5, "элемент, который сайт переписывает постоянно, переведён заново " + clock.length + " раз");
      ok(`текст, который сайт переписывает каждые 0,1 с, переведён заново ${clock.length} раз за 3 с — не больше 5`);
      // Esc: наблюдатель снят, новое не переводится
      await esc(); await sleep(200);
      assert.deepStrictEqual(await ev("__ru()"), [], "после Esc перевода не осталось");
      const c3 = await calls();
      await ev(`(() => { loadMore("after-esc"); __q("#feed").children[0].firstChild.nodeValue = "Review number one was edited again"; return true; })()`);
      await sleep(1000);
      assert.deepStrictEqual([await ev("__ru()"), await calls()], [[], c3], "после Esc новое переведено");
      ok("после Esc новое содержимое не переводится и запросов нет");

      // SPA заменил <body> (Turbo): кружок и уведомление на месте, новое тело переводится
      await load({ hudShown: true });
      await translatePage();
      const ui = () => ev(`(() => { const fab = __roots.find((r) => r.querySelector(".fab")); return { fab: !!fab && document.body.contains(fab.host), toasts: toasts() }; })()`);
      const before = await ui();
      assert.ok(before.fab && before.toasts.some((s) => s.startsWith("info:Страница переведена")), JSON.stringify(before));
      await ev(`(() => { const nb = document.createElement("body");
        nb.innerHTML = '<main><h1 id="nbH">Order history and saved addresses</h1><p id="nbP">This paragraph arrived with the new body of the page.</p></main>';
        document.body.replaceWith(nb); return true; })()`);
      assert.ok(await until(async () => await allTr("#nbH") && await allTr("#nbP"), 2000), "новое <body> не переведено: " + JSON.stringify(await ev("__texts()")));
      const after = await ui();
      assert.ok(after.fab && after.toasts.some((s) => s.startsWith("info:Страница переведена")), "кружок или уведомление пропали: " + JSON.stringify(after));
      await ev(`(() => { const p = document.createElement("p"); p.id = "nbMore"; p.textContent = "Another note added to the new page later"; document.querySelector("main").appendChild(p); return true; })()`);
      assert.ok(await until(() => allTr("#nbMore"), 1500), "добавленное в новое <body> не переведено");
      ok("сайт заменил <body>: кружок и уведомление вернулись на страницу, новое тело и добавленное в него переведены");
      // не Esc: обработчик Esc у «сайта» ищет своё меню, а его в новом <body> нет
      await ev("sendCmd('restoreAll'); true"); await sleep(200);
      assert.deepStrictEqual(await ev("__ru()"), [], "после «Показать оригинал» в новом <body> перевода не осталось");
      ok("«Показать оригинал» в новом <body> возвращает оригинал");
    });

    await block("14. Накладка на всю карточку (The Guardian, BBC): Shift и задержка над заголовком под ней; над пустой накладкой — ничего", async () => {
      await load();
      const calls = () => ev("trCalls().length");
      const topId = (p) => ev(`document.elementFromPoint(${p.x}, ${p.y}).id`);
      const p = await hover("#cardHead");
      assert.strictEqual(await topId(p), "cardLink", "под курсором не ссылка-накладка");
      await tapShift();
      assert.ok(await until(() => allTr("#cardTitle"), 1500), "Shift над заголовком под ссылкой-накладкой его не перевёл: «" + (await text("#cardTitle")) + "»");
      await tapShift();
      assert.ok(await until(() => untranslated("#card"), 1500), "второй Shift не вернул оригинал");
      ok("Shift над заголовком под пустой ссылкой-накладкой переводит его, второй Shift возвращает оригинал");
      // Под накладкой без текста: поле внизу карточки и картинка (курсор движется по самой накладке — mouseover нет)
      const c0 = await calls();
      const empty = await ev(`(() => { const r = __q("#card").getBoundingClientRect(), m = __q("#card .card__media").getBoundingClientRect();
        return [{ x: Math.round(r.left + 120), y: Math.round(r.bottom - 15) }, { x: Math.round(r.left + 120), y: Math.round(m.top + m.height / 2) }]; })()`);
      for (const q of empty) {
        assert.strictEqual(await topId(q), "cardLink");
        await move(q.x, q.y); await sleep(40);
        await tapShift();
      }
      await sleep(300);
      assert.deepStrictEqual([await ev(`__ru("#card")`), await calls()], [[], c0], "Shift над накладкой без текста под ней что-то перевёл");
      ok("Shift над накладкой там, где под ней текста нет (поле, картинка), ничего не переводит и не запрашивает");

      await load({ trigger: "dwell", dwellMs: 300 });
      const d = await hover("#promoTitle");
      assert.strictEqual(await topId(d), "promoCover", "под курсором не накладка");
      assert.ok(await until(() => allTr("#promoTitle"), 2000), "задержка над заголовком под накладкой его не перевела");
      await away();
      assert.ok(await until(() => untranslated("#promo"), 1500), "курсор ушёл с накладки — оригинал не вернулся");
      ok("задержка курсора над заголовком под накладкой переводит его, уход с накладки возвращает оригинал");
    });

    // ---- 15–17. Esc при открытом у сайта без привычной разметки ----
    // Меню «Edition» The Guardian (кнопка aria-expanded без aria-haspopup/aria-controls, список — absolute-ребёнок
    // обёртки без позиции) и панель фильтров Allbirds (кнопка без aria, слой fixed на всё окно с затемнением и
    // размытием, без role). Оба сайта Esc не слышат: открытое остаётся, и перевод под ним должен остаться. Чего
    // открытым не считать: раскрытые разделы оглавления, шапку fixed, прозрачные и pointer-events: none слои во всё
    // окно, фон страницы под содержимым; баннер cookie (role=alertdialog) — как раньше: Esc сначала сайту, через 250 мс наш.
    const ru = async () => (await ev("__ru()")).length;
    const tr = async () => {               // перевести страницу; раздел — посередине окна, его тексты переведены
      await translatePage();
      await ev("__q('#s-esc').scrollIntoView({ block: 'center' }); true");
      assert.ok(await until(async () => await allTr("#edBtn") && await allTr("#docNav")), "раздел s-esc не переведён");
    };
    // Esc вернул оригинал сразу (через 250 мс — значит, показанное посчитано открытым у сайта)
    const escReverts = async (what) => {
      await esc();
      assert.deepStrictEqual(await ev("__ru()"), [], what + ": Esc не вернул оригинал сразу");
    };
    await block("15. Esc, когда у сайта ничего не открыто: раскрытое оглавление, шапка и слои fixed на всё окно; баннер cookie", async () => {
      await load();
      const before = await ev("__texts()");
      await tr();
      await escReverts("ничего не открыто, на экране раскрытые разделы оглавления и уведомление «Страница переведена»");
      assert.deepStrictEqual(await ev("__texts()"), before, "тексты — как до перевода");
      for (const [id, what] of [["fxHeader", "шапка fixed во всю ширину высотой 60 px"],
        ["fxPass", "почти прозрачный слой fixed на всё окно с pointer-events: none (уведомление посередине щелчки ловит)"],
        ["fxClear", "слой fixed на всё окно без фона и без backdrop-filter"],
        ["fxBg", "фон страницы fixed на всё окно под содержимым (z-index: -1)"]]) {
        await ev(`__q("#${id}").hidden = false, true`);
        await tr();
        await escReverts(what);
        await ev(`__q("#${id}").hidden = true, true`);
      }
      ok("Esc сразу возвращает оригинал: ничего не открыто (раскрытые разделы оглавления, в том числе со значком absolute, наше уведомление — не открытое); шапка fixed, слой с pointer-events: none, прозрачный слой и фон страницы на всё окно — не окно сайта");
      // Баннер cookie: role=alertdialog, сайт его по Esc не закрывает — Esc сначала сайту, через 250 мс оригинал вернулся
      await ev(`__q("#cookie").hidden = false, true`);
      await tr();
      await esc();
      assert.ok(await ru() > 0, "баннер cookie: сразу после Esc перевод на месте (Esc сначала сайту)");
      await sleep(400);
      assert.deepStrictEqual(await ev("__ru()"), [], "баннер cookie: сайт его не закрыл — через 250 мс Esc наш, оригинал вернулся");
      await ev(`__q("#cookie").hidden = true, true`);
      ok("баннер cookie (role=alertdialog, aria-modal=false) сайт по Esc не закрыл — оригинал вернулся через 250 мс, как раньше");
    });

    // «Edition»: открыли щелчком (фокус на кнопке), Esc — меню остаётся (сайт Esc не слышит), перевод тоже
    await block("16. Esc при открытом меню «Edition» (The Guardian): кнопка без aria-haspopup, список absolute внутри обёртки", async () => {
      await load();
      await tr();
      await click("#edBtn");
      assert.ok(await until(() => allTr("#edList")), "список «Edition» не переведён");
      const nEd = await ru();
      await esc();
      await sleep(400);
      assert.ok(await ev("!__q('#edWrap').hidden"), "сайт меню по Esc не закрывает");
      assert.strictEqual(await ru(), nEd, "открыто меню «Edition» (список — absolute-ребёнок обёртки) — Esc перевод не трогает, и через 0,4 с тоже");
      await click("#edBtn");
      await escReverts("меню «Edition» закрыто");
      ok("меню «Edition» (aria-expanded без aria-haspopup/aria-controls, список absolute внутри обёртки): Esc только сайту, перевод на месте и через 0,4 с; меню закрыли — Esc возвращает оригинал");
    });

    // Панель фильтров: слой fixed на всё окно с затемнением и размытием, без role и aria
    await block("17. Esc при открытой панели фильтров (Allbirds): слой fixed на всё окно с затемнением, без ARIA", async () => {
      await load();
      const before = await ev("__texts()");
      await tr();
      await click("#filterBtn");
      assert.ok(await until(() => allTr("#filterPanel")), "панель фильтров не переведена");
      const nF = await ru();
      await esc();
      await sleep(400);
      assert.ok(await ev("!__q('#takeover').hidden"), "сайт панель по Esc не закрывает");
      assert.strictEqual(await ru(), nF, "открыта панель фильтров (слой на всё окно) — Esc перевод не трогает, и через 0,4 с тоже");
      await click("#filterClose");
      await escReverts("панель фильтров закрыта");
      assert.deepStrictEqual(await ev("__texts()"), before, "тексты — как до перевода");
      ok("панель фильтров (слой fixed на всё окно с затемнением и размытием, без ARIA): Esc только сайту, перевод на месте и через 0,4 с; панель закрыли — Esc возвращает оригинал");
    });

    console.log("");
    if (failed.length) {
      console.log(`Не пройдено блоков: ${failed.length} — ${failed.join("; ")}`);
      console.log(`Пройдено проверок: ${pass}`);
      process.exitCode = 1;
    } else {
      console.log(`Все проверки пройдены: ${pass}`);
    }
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
