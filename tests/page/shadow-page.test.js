// «Перевести страницу» и новое содержимое внутри веб-компонентов сайта (открытые shadow root, как у MDN на Lit,
// Reddit, YouTube): content.js в Chrome без интерфейса на fixtures/shadow-page.html с заглушкой chrome.*.
//   • текст в открытых root (и в root внутри root) переводится вместе со страницей, далёкий — при прокрутке;
//     закрытый root сайта, хост под notranslate и хост с пометкой нашего интерфейса не трогаются; текст light DOM
//     в <slot> уходит в перевод один раз;
//   • подложка «идёт перевод» внутри root действует так же, как в документе (лист в adoptedStyleSheets, свой лист
//     компонента остаётся, <style> в root не добавляется), «не перевелось» — тоже;
//   • компонент, добавленный после перевода (с компонентом внутри), и текст, изменённый внутри root, переводятся сами;
//   • Esc и «Показать оригинал» возвращают оригинал и в root; смена языка перепереводит и в root.
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 5000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const J = JSON.stringify;

(async () => {
  const srv = await serve();
  const URL = srv.base + "/shadow-page.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(J(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    // Текст элемента по пути через root: txt("#outer", "x-inner", "p").
    const txt = (...sels) => ev(`(deep(${sels.map((s) => J(s)).join(", ")}) || { textContent: null }).textContent`);
    // Что проверяем: в документе, в root, в root внутри root, light DOM через <slot>.
    const S = {
      p1: ["#p1"], slotted: ["#slotted"], card: ["#card", ".ttl"], sw: ["#switch", ".lbl"],
      outer: ["#outer", "h3"], inner: ["#outer", "x-inner", "p"],
    };
    const LATE = { late: ["#later x-late", "p"], leaf: ["#later x-late", "x-leaf", "span"] };
    const texts = async (map) => { const o = {}; for (const k in map) o[k] = await txt(...map[k]); return o; };
    const allAre = async (map, want) => {
      const now = await texts(map);
      return Object.keys(map).every((k) => now[k] === want[k]) ? true : null;
    };
    const prefixed = (orig, lang) => Object.fromEntries(Object.entries(orig).map(([k, v]) => [k, `[${lang}] ${v}`]));
    const esc = async () => { await t.key("rawKeyDown", "Escape", "Escape", 0, 27); await t.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    // Элементы с нашим классом в открытых root сайта (и в документе).
    const inRoots = (cls) => ev(`__roots.filter((r) => r.mode === "open").flatMap((r) => [...r.querySelectorAll(${J(cls)})]).length`);

    await t.cmd("Page.navigate", { url: URL });
    await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
    await sleep(300);
    const orig = await texts(S);
    assert.deepStrictEqual(Object.values(orig).filter((v) => typeof v !== "string"), [], J(orig));
    const farOrig = await txt("#far", "p");
    const closedText = () => ev("__roots.find((r) => r.host.id === 'closed').textContent");
    const closedOrig = await closedText();

    // ---- 1. Пока переводится: подложка в root — как в документе ----
    await ev("window.__bgDelay = 1200; sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(async () => (await inRoots(".ht-loading")) > 0, 3000), "в открытом root есть элемент с ht-loading");
    await sleep(300);   // подложка начинается с задержкой 0,15 с
    const look = await ev(`(() => {
      const st = (e) => { const c = getComputedStyle(e); return { anim: c.animationName, cursor: c.cursor, bg: c.backgroundColor }; };
      const inRoot = __roots.filter((r) => r.mode === "open").flatMap((r) => [...r.querySelectorAll(".ht-loading")])[0];
      const inDoc = document.querySelector(".ht-loading");
      return { root: inRoot && st(inRoot), doc: inDoc && st(inDoc) };
    })()`);
    assert.ok(look.root && look.doc, J(look));
    assert.strictEqual(look.root.anim, "ht-pulse", "анимация подложки в root: " + J(look));
    assert.strictEqual(look.root.anim, look.doc.anim);
    assert.strictEqual(look.root.cursor, "progress");
    assert.strictEqual(look.root.cursor, look.doc.cursor);
    assert.notStrictEqual(look.root.bg, "rgba(0, 0, 0, 0)", "подложка в root видна: " + J(look));
    ok("«идёт перевод» внутри root действует, как в документе: " + J(look.root));

    // ---- 2. Переведено: текст в открытых root и в root внутри root; закрытый, notranslate и наш — нет ----
    assert.ok(await until(() => allAre(S, prefixed(orig, "RU")), 8000), J(await texts(S)));
    await ev("window.__bgDelay = 0; true");
    const sent = await ev("sent()");
    const count = (s) => sent.filter((x) => x.includes(s)).length;
    assert.strictEqual(count("Slotted light text"), 1, "текст light DOM через <slot> — один раз: " + J(sent));
    assert.strictEqual(count("Card title inside"), 1, J(sent));
    assert.strictEqual(count("Closed component"), 0, "закрытый root сайта не переводится");
    assert.strictEqual(await closedText(), closedOrig);
    assert.strictEqual(count("Brand widget"), 0, "хост под notranslate: его root не переводится");
    assert.strictEqual(await txt("#brand", "p"), "Brand widget text that the author keeps");
    assert.strictEqual(count("Own interface"), 0, "хост с пометкой нашего интерфейса не переводится");
    assert.strictEqual(await txt("#ours", "p"), "Own interface text must stay");
    const ours = await ev("ourTexts()");
    for (const s of ours) assert.ok(!sent.some((x) => s.includes(x.trim())), "текст нашего интерфейса ушёл в перевод: " + s);
    assert.strictEqual(await txt("#far", "p"), farOrig, "компонент далеко внизу ждёт прокрутки");
    assert.strictEqual(count("Far component"), 0);
    assert.strictEqual(await inRoots(".ht-loading"), 0, "подложка снята");
    ok("«Перевести страницу» переводит текст в открытых root и во вложенном компоненте; <slot> — один раз; закрытый root, notranslate и наш хост — нет");

    // ---- 3. Свой лист компонента остаётся, <style> в root не появляется; «не перевелось» в root тоже действует ----
    const sheets = await ev(`(() => {
      const r = deep("#card").shadowRoot, h = deep("#outer", "h3");
      h.classList.add("ht-error");
      const a = getComputedStyle(h, "::after"), c = getComputedStyle(h);
      const out = { n: r.adoptedStyleSheets.length, own: getComputedStyle(r.querySelector(".ttl")).color,
        styles: __roots.filter((x) => x.mode === "open").reduce((s, x) => s + x.querySelectorAll("style").length, 0),
        after: a.content, bg: c.backgroundColor };
      h.classList.remove("ht-error");
      return out;
    })()`);
    assert.deepStrictEqual(sheets, { n: 2, own: "rgb(1, 2, 3)", styles: 0, after: '"!"', bg: "rgba(215, 40, 40, 0.1)" });
    ok("лист подключён к root рядом со своим листом компонента (adoptedStyleSheets), <style> не добавлен; «!» ошибки в root рисуется");

    // ---- 4. Ленивый перевод по видимости — и в root ----
    await ev("document.querySelector('#far').scrollIntoView({ block: 'center' }); true");
    assert.ok(await until(async () => (await txt("#far", "p")) === "[RU] " + farOrig, 5000), await txt("#far", "p"));
    ok("компонент далеко внизу переводится, когда его прокрутят");

    // ---- 5. Новое содержимое: компонент с компонентом внутри, текст заменён и переписан внутри root ----
    await ev("window.scrollTo(0, 0); true"); await sleep(100);
    await ev(`document.getElementById("later").appendChild(document.createElement("x-late"));
      deep("#outer", "h3").textContent = "Outer heading changed by the site";
      deep("#outer", "x-inner", "p").firstChild.nodeValue = "Nested text rewritten in place";
      true`);
    const lateOrig = await texts(LATE);
    assert.deepStrictEqual(lateOrig, { late: "Component added after the page was translated", leaf: "Leaf text inside a late component" });
    const changed = { outer: "Outer heading changed by the site", inner: "Nested text rewritten in place" };
    const NOW = { outer: S.outer, inner: S.inner, ...LATE };
    const nowOrig = { ...changed, ...lateOrig };
    assert.ok(await until(() => allAre(NOW, prefixed(nowOrig, "RU")), 5000), J(await texts(NOW)));
    ok("добавленный после перевода компонент (и компонент в нём) и текст, изменённый внутри root, переводятся сами");

    // ---- 6. Esc — оригинал везде, и в root ----
    await esc();
    const back = { ...orig, ...nowOrig };
    const ALL = { ...S, ...LATE };
    assert.ok(await until(() => allAre(ALL, back), 2000), J(await texts(ALL)));
    assert.strictEqual(await txt("#far", "p"), farOrig);
    // наблюдение снято: новый текст в root больше не переводится
    await ev(`deep("#switch", ".lbl").textContent = "Theme switch"; true`); await sleep(700);
    assert.strictEqual(await txt("#switch", ".lbl"), "Theme switch");
    assert.strictEqual(await ev("sent().filter((x) => x.includes('Theme switch')).length"), 0);
    await ev(`deep("#switch", ".lbl").textContent = "Theme"; true`);
    ok("Esc возвращает оригинал и внутри root (с текстом, который сайт поменял); после этого новое в root не переводится");

    // ---- 7. Смена языка перепереводит и в root; «Показать оригинал» возвращает ----
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true");
    assert.ok(await until(() => allAre(ALL, prefixed(back, "RU")), 8000), J(await texts(ALL)));
    await ev("setStore({ targetLang: 'DE' }); true");
    assert.ok(await until(() => allAre(ALL, prefixed(back, "DE")), 8000), J(await texts(ALL)));
    await ev("sendCmd('restoreAll'); true"); await sleep(150);
    assert.ok(await until(() => allAre(ALL, back), 2000), J(await texts(ALL)));
    assert.strictEqual(await inRoots(".ht-loading"), 0);
    ok("смена языка перепереводит текст в root; «Показать оригинал» возвращает его");

    assert.deepStrictEqual(errors, [], "исключения на странице");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
