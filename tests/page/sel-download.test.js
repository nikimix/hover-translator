// Перевод выделенного, когда встроенному переводчику нужно действие пользователя: модель не скачана, язык не из
// языков Chrome (разрешение на каждом сайте), не скачан детектор языка. Абзацу в таком случае говорят «Щёлкните по
// тексту» и повторяют перевод после щелчка, но щелчок по тексту снял бы выделение, а следующий щелчок по странице
// перевёл бы абзац под курсором. Поэтому отрывок запоминается, а в уведомлении — кнопка («Скачать» или «Перевести»):
// щелчок по ней (у него есть действие пользователя) переводит запомненный отрывок, выделение на месте. Модель уже
// качается — прежнее «Переводчик ещё скачивается», без кнопки; уведомление — на каждую явную просьбу.
// Во встроенном окне чужого сайта, где встроенный переводчик запрещён, — не молчание, а объяснение.
// Заглушки: fixtures/stub-builtin.html (file://, поддельный встроенный переводчик) и fixtures/stub.html со
// встроенным окном stub-frame.html с другого адреса (lib/server.js). Ввод — только настоящие события CDP.
// Каждый пункт — на свежей странице; упавший пункт не останавливает остальные (видно, что именно не так).
const assert = require("assert");
const { launch, filePage, sleep, until } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { rmDir } = require("../lib/env");
let pass = 0;
const fails = [];
const ok = (name) => { pass++; console.log("  ok  " + name); };
const SHIFT = 8;

const P1 = "The quick brown fox jumps over the lazy dog near the river bank.";
const P2 = "Another paragraph with plain English text for the sweep test.";

// Запоминаем, что именно отдали переводчику (переводится отрывок, а не абзац).
const SPY = `
  window.__tx = [];
  const c0 = Translator.create;
  Translator.create = async function (o) { const t = await c0.call(this, o); return { translate: async (x) => { __tx.push(x); return t.translate(x); } }; };
  // Уведомления по порядку показа (свои shadow root — по одному на уведомление).
  window.toastRoots = () => window.__roots.filter((r) => r.querySelector(".toast"));
  // Наше окно, кроме уведомлений и кружка, — карточка перевода.
  window.cardText = () => window.__roots.filter((r) => r.host.isConnected && !r.querySelector(".toast") && !r.querySelector(".fab")).map((r) => r.textContent).join("|");
  window.btnAt = () => { const b = window.__roots.filter((r) => r.host.isConnected).map((r) => r.querySelector(".toast .t-btn.pri")).filter(Boolean).pop();
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: b.textContent }; };
  true`;

(async () => {
  const page = filePage("stub-builtin.html");
  const srv = await serve();
  const b = await launch({ extraArgs: ["--allow-file-access-from-files"] });
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = (expr) => t.ev(expr);
    const mouse = (type, x, y, extra) => t.mouse(type, x, y, extra);
    const tapShift = async () => {
      await t.cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: SHIFT, windowsVirtualKeyCode: 16 });
      await sleep(40);
      await t.cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 0, windowsVirtualKeyCode: 16 });
      await sleep(150);
    };
    const clickAt = async (x, y) => {
      await mouse("mouseMoved", x, y); await sleep(30);
      await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(50);
    };
    // Нажатие кнопки мыши — действие пользователя (живёт ~5 с): выделили и сразу нажали Shift — модель качается сама.
    // Кнопка в уведомлении нужна, когда его уже нет: ждём, пока истечёт.
    const idle = async (on = ev) => assert.ok(await until(() => on("!navigator.userActivation.isActive"), 8000), "действие пользователя истекло");
    const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
    // Уведомления на экране; прежнее, которое сменило новое, ещё 0,2 с гаснет — ждём, пока останется одно.
    const toasts = async () => { await until(async () => (await ev("toasts()")).length <= 1, 1000); return ev("toasts()"); };
    const sel = () => ev("String(getSelection())");
    // Выделить мышью слова from…to (включительно) первого текстового узла #id: нажатие у первой буквы, протяжка
    // до последней, отпускание — курсор остаётся над выделением.
    const select = async (id, from, to) => {
      const p = await ev(`(() => { const n = document.getElementById(${JSON.stringify(id)}).firstChild, s = n.data;
        const a = s.indexOf(${JSON.stringify(from)}), z = s.indexOf(${JSON.stringify(to)}, a) + ${to.length};
        const box = (i) => { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect(); };
        const f = box(a), l = box(z - 1);
        return { x1: Math.round(f.left + 1), y1: Math.round(f.top + f.height / 2), x2: Math.round(l.right - 1), y2: Math.round(l.top + l.height / 2) }; })()`);
      await mouse("mouseMoved", p.x1, p.y1); await sleep(30);
      await mouse("mousePressed", p.x1, p.y1, { button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 4; i++) { await mouse("mouseMoved", Math.round(p.x1 + (p.x2 - p.x1) * i / 4), p.y2, { button: "left", buttons: 1 }); await sleep(20); }
      await mouse("mouseReleased", p.x2, p.y2, { button: "left", buttons: 0, clickCount: 1 });
      await sleep(30);
      await mouse("mouseMoved", p.x2 - 3, p.y2); await sleep(60);
      await idle();
      return p;
    };
    const load = async (setup) => {
      await t.cmd("Page.navigate", { url: page.url + "?builtin=fake&store=" + encodeURIComponent(JSON.stringify({ engine: "chrome", trigger: "shift" })) });
      await until(() => ev("typeof HT_engineProblem === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
      await ev(SPY);
      if (setup) await ev(setup + "; true");
    };
    // На экране уведомление с кнопкой label: щелчок по ней переводит запомненный отрывок word — карточка, выделение
    // на месте, абзац как был; want — ход загрузки в уведомлении. Возвращает уведомления, замеченные после щелчка.
    const viaButton = async (word, label, want) => {
      const btn = await ev("btnAt()");
      assert.ok(btn, "в уведомлении есть кнопка");
      assert.strictEqual(btn.label, label);
      const seen = new Set();
      await clickAt(btn.x, btn.y);
      const done = await until(async () => { for (const s of await ev("toasts()")) seen.add(s); return (await ev("cardText()")).includes("[ru] " + word); }, 4000, 20);
      assert.ok(done, "после щелчка по кнопке — карточка с переводом отрывка: " + JSON.stringify(await ev("cardText()")));
      assert.deepStrictEqual(await ev("__tx"), [word], "переводчику ушёл запомненный отрывок, а не абзац");
      assert.strictEqual(await text("p1"), P1, "абзац не заменён");
      assert.strictEqual(await sel(), word, "выделение страницы на месте после щелчка по кнопке уведомления");
      if (want) assert.ok([...seen].some((s) => want.test(s)), "ход загрузки в уведомлении: " + JSON.stringify([...seen]));
      return [...seen];
    };
    const step = async (name, fn) => {
      try { await fn(); ok(name); } catch (e) { fails.push(name); console.log("  FAIL " + name + "\n       " + String(e && e.message || e).split("\n").join("\n       ")); }
    };

    // ---- 1. Модели нет: «Нужен переводчик для этой пары» и «Скачать»; щелчок по кнопке качает и переводит отрывок ----
    await step("модели нет: уведомление «Нужен переводчик для этой пары / Английский → русский…» с кнопкой «Скачать»", async () => {
      await load();
      await select("p1", "quick", "fox");
      assert.strictEqual(await sel(), "quick brown fox");
      await tapShift();
      assert.deepStrictEqual(await toasts(), ["info:Нужен переводчик для этой парыАнглийский → русский. Скачивается один раз, бесплатно.Скачать"]);
      assert.strictEqual(await ev("__tr.creates.length"), 0, "без действия пользователя create() не зовём");
      assert.strictEqual(await text("p1"), P1);
    });
    await step("щелчок по «Скачать»: загрузка с ходом в уведомлении, переведён запомненный отрывок, выделение на месте", async () => {
      const seen = await viaButton("quick brown fox", "Скачать", /^info:Скачиваю переводчикАнглийский → русский/);
      console.log("      (уведомления во время загрузки: " + JSON.stringify(seen) + ")");
      assert.deepStrictEqual(await ev("__tr.creates.map((c) => [c.src, c.tgt, c.active, c.monitor])"), [["en", "ru", true, true]]);
    });

    // ---- 2. Щелчок по тексту страницы после уведомления абзац не переводит; уведомление — на каждую просьбу ----
    await step("после уведомления щелчок по тексту страницы абзац под курсором не переводит", async () => {
      await load();
      await select("p1", "quick", "fox");
      await tapShift();
      // какое именно уведомление — п. 1; здесь — что после него щелчок по тексту не переводит абзац
      assert.strictEqual((await toasts()).length, 1, "уведомление о загрузке: " + JSON.stringify(await toasts()));
      const p2 = await ev(`(({ left, top, height }) => ({ x: Math.round(left + 40), y: Math.round(top + height / 2) }))(document.getElementById("p2").getBoundingClientRect())`);
      await clickAt(p2.x, p2.y);
      await sleep(600);
      assert.strictEqual(await text("p2"), P2, "абзац под курсором не переведён");
      assert.strictEqual(await ev("__tr.creates.length"), 0, "загрузка не запускалась");
      assert.deepStrictEqual(await ev("__tx"), []);
    });
    await step("повторная просьба (Shift над новым выделением) — уведомление с кнопкой снова", async () => {
      const before = await ev("toastRoots().length");
      await select("p1", "quick", "fox");
      await tapShift();
      assert.strictEqual(await ev("toastRoots().length"), before + 1, "новое уведомление: " + JSON.stringify(await toasts()));
      assert.deepStrictEqual(await toasts(), ["info:Нужен переводчик для этой парыАнглийский → русский. Скачивается один раз, бесплатно.Скачать"]);
      await viaButton("quick brown fox", "Скачать");
    });

    // ---- 3. Язык не из языков Chrome: «Chrome просит подтвердить» и «Перевести» ----
    await step("язык не из языков Chrome: уведомление «Chrome просит подтвердить» с кнопкой «Перевести», щелчок переводит отрывок", async () => {
      await load("__ld.lang = 'es'");
      const langs = await ev("JSON.stringify(navigator.languages)");
      assert.ok(!/"es/.test(langs), "испанского нет в языках браузера: " + langs);
      await select("p1", "quick", "fox");
      await tapShift();
      assert.deepStrictEqual(await toasts(), ["info:Chrome просит подтвердитьЯзыка «испанский» нет в языках Chrome, поэтому на каждом сайте перевод начинается кнопкой.Перевести"]);
      await viaButton("quick brown fox", "Перевести");
      assert.deepStrictEqual(await ev("__tr.creates.map((c) => [c.src, c.tgt, c.active])"), [["es", "ru", true]]);
    });

    // ---- 4. Детектор языка не скачан (отрывок длинный — язык по нему самому, а не по странице) ----
    await step("детектор не скачан: «Нужно определение языка» с кнопкой «Скачать», щелчок качает детектор и переводит отрывок", async () => {
      await load("__ld.avail = 'downloadable'; __tr.avail = 'available'");
      await select("p1", "quick", "dog");
      const word = "quick brown fox jumps over the lazy dog";
      assert.strictEqual(await sel(), word);
      await tapShift();
      assert.deepStrictEqual(await toasts(), ["info:Нужно определение языкаChrome скачает его один раз, бесплатно.Скачать"]);
      await viaButton(word, "Скачать", /^info:Скачиваю переводчикОпределение языка/);
      assert.strictEqual(await ev("__ld.avail"), "available", "детектор скачан");
    });

    // ---- 5. Модель уже качается: прежнее уведомление без кнопки — на каждую просьбу; щелчок по тексту не переводит ----
    await step("модель уже качается: «Переводчик ещё скачивается» без кнопки, на каждую просьбу", async () => {
      await load("__tr.avail = 'downloading'");
      await select("p1", "quick", "fox");
      await tapShift();
      const wait = "info:Переводчик ещё скачиваетсяАнглийский → русский · попробуйте через минуту";
      assert.deepStrictEqual(await toasts(), [wait]);
      assert.strictEqual(await ev("btnAt()"), null, "без кнопки");
      const before = await ev("toastRoots().length");
      await tapShift();
      assert.strictEqual(await ev("toastRoots().length"), before + 1, "уведомление и на повторную просьбу");
      assert.deepStrictEqual(await toasts(), [wait]);
    });
    await step("модель уже качается: щелчок по тексту страницы абзац не переводит", async () => {
      const p2 = await ev(`(({ left, top, height }) => ({ x: Math.round(left + 40), y: Math.round(top + height / 2) }))(document.getElementById("p2").getBoundingClientRect())`);
      await clickAt(p2.x, p2.y);
      await sleep(600);
      assert.strictEqual(await text("p2"), P2, "абзац под курсором не переведён");
      assert.strictEqual(await ev("__tr.creates.length"), 0);
    });

    // ---- 6. Встроенное окно чужого сайта, где встроенный переводчик запрещён политикой ----
    // Окно с другого адреса без allow="translator": встроенный в нём недоступен (BUILTIN "frame"), выбран он.
    await step("встроенное окно с запретом встроенного переводчика: абзац — молча, выделенное — уведомление с объяснением", async () => {
      const S = encodeURIComponent(JSON.stringify({ trigger: "shift", engine: "chrome" }));
      await t.cmd("Page.navigate", { url: srv.base + "/stub.html?store=" + S + "&frame=" + encodeURIComponent(srv.other + "/stub-frame.html?store=" + S) });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(500);
      // Окно с другого сайта — отдельная цель CDP (своя страница в своём процессе): читаем его уведомления изнутри.
      let fr = null;
      await until(async () => { fr = ((await b.cmd("Target.getTargets")).targetInfos || []).find((i) => i.type === "iframe" && /stub-frame/.test(i.url)); return fr; }, 3000);
      assert.ok(fr, "встроенное окно — отдельная цель");
      const f = await b.attach(fr.targetId);
      const fev = (expr) => f.ev(expr);
      assert.strictEqual(await fev("document.featurePolicy.allowsFeature('translator')"), false, "встроенный переводчик окну запрещён");
      await fev(`window.__roots = []; const a0 = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (o) { const r = a0.call(this, o); window.__roots.push(r); return r; };
        window.toasts = () => window.__roots.filter((r) => r.host.isConnected).map((r) => { const c = r.querySelector(".toast"); return c ? (c.getAttribute("role") === "alert" ? "err" : "info") + ":" + c.querySelector(".t-b").textContent : null; }).filter(Boolean);
        true`);
      const box = await ev(`(({ left, top }) => ({ x: Math.round(left), y: Math.round(top) }))(frEl().getBoundingClientRect())`);
      const word = await fev(`(() => { const n = document.getElementById("fp").firstChild, a = n.data.indexOf("embedded");
        const r = document.createRange(); r.setStart(n, a); r.setEnd(n, a + 8); const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      const x = box.x + 1 + word.x, y = box.y + 1 + word.y;   // + рамка окна (1 px)
      // а) без выделения: щелчок по тексту окна (фокус — в окне), Shift — путь абзаца: как и раньше, молча
      await clickAt(x, y);
      await mouse("mouseMoved", x + 2, y + 1); await sleep(60);
      await idle(fev);
      await tapShift();
      await sleep(300);
      assert.deepStrictEqual(await fev("toasts()"), [], "абзац во встроенном окне — без уведомления");
      // б) выделили слово двойным щелчком, Shift — уведомление с объяснением и кнопкой в настройки
      await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
      await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 2 });
      await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 2 });
      await sleep(60);
      await mouse("mouseMoved", x + 2, y + 1); await sleep(60);
      assert.strictEqual(await fev("String(getSelection())"), "embedded", "выделено слово во встроенном окне");
      await idle(fev);
      await tapShift();
      await sleep(300);
      assert.deepStrictEqual(await fev("toasts()"),
        ["err:Встроенный переводчик здесь недоступенСайт не разрешает его во встроенном окне. Здесь может переводить DeepL или ИИ — выберите в настройках.Открыть настройки"]);
      assert.deepStrictEqual(await ev("toasts()"), [], "у страницы своих уведомлений нет");
    });

    assert.deepStrictEqual(errors, [], "исключения на странице");
    if (fails.length) { console.error(`\nНе прошли (${fails.length}): ` + fails.join("; ")); process.exitCode = 1; }
    else console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    srv.close();
    rmDir(page.dir);
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
