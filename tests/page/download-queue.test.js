// Загрузка языковой модели встроенного переводчика не держит перевод на других языках: пока качается модель
// одной пары, текст на языках с готовой моделью переводится сразу. Живой YouTube: блок рекламы по-итальянски
// запустил загрузку «Итальянский → русский», и заголовок видео, канал и лента висели в подсветке, пока она шла.
// Заглушка — fixtures/stub-builtin.html (file://); Translator и LanguageDetector подменены здесь: у каждой пары
// своя готовность, а «загрузка» (create при нескачанной модели) идёт, пока проверка сама её не отпустит.
// Новое содержимое (MutationObserver) моделей не качает: только по явной просьбе — Shift, «Перевести страницу», щелчок.
const assert = require("assert");
const { launch, filePage, sleep, until } = require("../lib/chrome");
const { rmDir } = require("../lib/env");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// Язык текста — по словам-приметам; переведённое ("[en>ru] …") — русский.
const FAKES = `
  window.__avail = { "en>ru": "available", "it>ru": "downloadable", "de>ru": "downloadable" };
  window.__release = {};
  window.__creates = [];
  Translator.availability = async (o) => __avail[o.sourceLanguage + ">" + o.targetLanguage] || "unavailable";
  Translator.create = async (o) => {
    const k = o.sourceLanguage + ">" + o.targetLanguage;
    __creates.push({ k, active: navigator.userActivation.isActive, monitor: !!o.monitor });
    if (__avail[k] !== "available") {
      if (!navigator.userActivation.isActive) throw new DOMException("Requires a user gesture", "NotAllowedError");
      await new Promise((r) => { __release[k] = r; });   // «качается», пока проверка не отпустит
      __avail[k] = "available";
    }
    return { translate: async (t) => "[" + k + "] " + t };
  };
  const lang = (t) => /^\\[/.test(t) ? "ru" : /\\b(questo|della|il)\\b/i.test(t) ? "it" : /\\b(der|und|ist)\\b/i.test(t) ? "de" : "en";
  LanguageDetector.create = async () => ({ detect: async (t) => [{ detectedLanguage: lang(t), confidence: 0.99 }] });
  for (const id of ["p1", "p2", "p3"]) document.getElementById(id).remove();
  const st = document.createElement("style");
  st.textContent = "p { margin: 0 0 6px; font-size: 13px; line-height: 18px; }";
  document.head.appendChild(st);
  window.addP = (id, text) => { const p = document.createElement("p"); p.id = id; p.textContent = text; document.body.appendChild(p); };
  true`;

const IT = (n) => `Questo è il testo italiano numero ${n} della pagina di prova per la coda.`;
const EN = (n) => `The quick brown fox number ${n} jumps over the lazy dog near the river bank.`;

(async () => {
  const page = filePage("stub-builtin.html");
  const b = await launch({ extraArgs: ["--allow-file-access-from-files"] });
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = (expr) => t.ev(expr);
    // Как щелчок в окне расширения, после которого у страницы есть действие пользователя.
    const gesture = (expr) => t.cmd("Runtime.evaluate", { expression: expr, userGesture: true, returnByValue: true });
    const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
    const creates = (k) => ev(`__creates.filter((c) => c.k === ${JSON.stringify(k)}).length`);

    await t.cmd("Page.navigate", { url: page.url + "?builtin=fake&store=" + encodeURIComponent(JSON.stringify({ engine: "chrome" })) });
    await until(() => ev("typeof HT_engineProblem === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
    await sleep(300);
    await ev(FAKES);

    // ---- 1. Страница на двух языках: модель итальянского качается — английский переведён, не дожидаясь ----
    // 9 видимых кусков — пачки по 2 (firstBatch), итальянский — в каждой из первых трёх: раньше все три
    // одновременных пачки ждали загрузку, а с ними и весь английский.
    const ids = [];
    for (let n = 1; n <= 3; n++) { await ev(`addP("it${n}", ${JSON.stringify(IT(n))}); addP("en${n}", ${JSON.stringify(EN(n))}); true`); ids.push("it" + n, "en" + n); }
    for (let n = 4; n <= 6; n++) { await ev(`addP("en${n}", ${JSON.stringify(EN(n))}); true`); ids.push("en" + n); }
    const orig = {};
    for (const id of ids) orig[id] = await text(id);
    const enIds = ids.filter((id) => id.startsWith("en")), itIds = ids.filter((id) => id.startsWith("it"));
    await gesture("sendCmd('translatePage'); true");
    const enDone = async () => { for (const id of enIds) if ((await text(id)) !== "[en>ru] " + orig[id]) return false; return true; };
    assert.ok(await until(enDone, 3000), "английский не дождался загрузки итальянского: " + JSON.stringify(await Promise.all(enIds.map(text))));
    assert.strictEqual(await creates("it>ru"), 1, "загрузка итальянского запущена один раз");
    assert.strictEqual(await ev("typeof __release['it>ru']"), "function", "итальянский ещё качается");
    for (const id of itIds) assert.strictEqual(await text(id), orig[id], "итальянский ждёт модель");
    ok("модель одного языка качается — куски на языке с готовой моделью переведены сразу");

    await ev("__release['it>ru'](); true");
    const itDone = async () => { for (const id of itIds) if ((await text(id)) !== "[it>ru] " + orig[id]) return false; return true; };
    assert.ok(await until(itDone, 3000), "итальянский после загрузки: " + JSON.stringify(await Promise.all(itIds.map(text))));
    assert.strictEqual(await ev("document.querySelectorAll('.ht-loading').length"), 0, "подсветка ожидания снята");
    assert.strictEqual(await creates("it>ru"), 1);
    const errs = (await ev("toasts()")).filter((s) => s.startsWith("err:"));
    assert.deepStrictEqual(errs, []);
    ok("модель докачалась — переведены и куски, которые её ждали");

    // ---- 2. Новое содержимое на языке без модели: не качаем, ни о чём не просим, узлы как есть ----
    // Страница переведена (п. 1) — наблюдатель нового содержимого включён. Модели «Немецкий → русский» нет.
    // Качать — только по явной просьбе (Shift, «Перевести страницу», щелчок), а не потому, что сайт что-то дописал.
    const DE = (n) => `Das ist der deutsche Text Nummer ${n} und er ist lang genug für die Probe.`;
    assert.ok(await until(async () => (await ev("toasts()")).length === 0, 6000), "уведомления п. 1 закрылись: " + JSON.stringify(await ev("toasts()")));
    assert.ok(await until(() => ev("!navigator.userActivation.isActive"), 8000), "действие пользователя из п. 1 истекло");
    // а) без действия пользователя — раньше уведомление «Щёлкните по тексту»
    await ev(`addP("de1", ${JSON.stringify(DE(1))}); true`);
    await sleep(1500);
    assert.deepStrictEqual(await ev("toasts()"), [], "без уведомлений о загрузке и щелчке");
    assert.strictEqual(await text("de1"), DE(1));
    // б) сразу после щелчка (у страницы есть действие пользователя) — раньше качалась модель; английский рядом переводится
    await gesture(`addP("de2", ${JSON.stringify(DE(2))}); addP("en7", ${JSON.stringify(EN(7))}); true`);
    assert.ok(await until(async () => (await text("en7")) === "[en>ru] " + EN(7), 3000), "английский в новом содержимом: " + await text("en7"));
    await sleep(800);
    assert.strictEqual(await creates("de>ru"), 0, "модель для нового содержимого не качается");
    assert.deepStrictEqual(await ev("toasts()"), [], "без уведомлений о загрузке и щелчке");
    for (const id of ["de1", "de2"]) assert.strictEqual(await text(id), DE(Number(id.slice(2))), id + " как есть");
    assert.strictEqual(await ev("document.querySelectorAll('.ht-loading, .ht-error').length"), 0, "без подсветки и отметки ошибки");
    ok("новое содержимое на языке без модели: без загрузки и уведомлений, узлы как есть");

    // в) модель уже есть (итальянский скачан в п. 1) — новое содержимое переводится, как раньше
    await ev(`addP("it4", ${JSON.stringify(IT(4))}); true`);
    assert.ok(await until(async () => (await text("it4")) === "[it>ru] " + IT(4), 3000), "итальянский в новом содержимом: " + await text("it4"));
    assert.strictEqual(await creates("it>ru"), 1, "готовый переводчик из кэша");
    ok("новое содержимое на языке с готовой моделью переводится");

    assert.deepStrictEqual(errors, [], "исключения на странице");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
