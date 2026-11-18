// Съёмка настоящего расширения для картинок магазина: Chrome без интерфейса, расширение загружается
// через Extensions.loadUnpacked (флаг --load-extension в Chrome 137+ не работает), перевод — встроенный
// переводчик Chrome. Демо-страница из demo/ отдаётся встроенным сервером под вымышленным адресом в
// зарезервированной зоне .test (garden.test; для русского — sad.test: длинное имя сайта окно расширения
// обрезает многоточием). Сеть не нужна, кроме однократной загрузки языковых моделей.
//
//   node assets/store/capture.js [en|ru ...] [--profile DIR]
//
// en — интерфейс на английском, статья на испанском, перевод на английский;
// ru — интерфейс на русском, статья на английском, перевод на русский.
// --profile — папка профиля Chrome, где модели уже скачаны (иначе — новый профиль, и модели скачиваются
// по кнопке на странице приветствия, как у пользователя: 1–5 минут).
// Результат — shots/<lang>/*.png и shots/<lang>/layout.js (координаты для курсора на картинках).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const HERE = __dirname;
const EXT_SRC = path.resolve(HERE, "../../hover-translate");
const DEMO = path.join(HERE, "demo");
const PORT = 8777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const args = process.argv.slice(2);
const pi = args.indexOf("--profile");
const PROFILE = pi >= 0 ? path.resolve(args[pi + 1]) : null;
const LANGS = args.filter((a, i) => /^(en|ru)$/.test(a) && args[i - 1] !== "--profile");

const CASE = {
  en: { env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" }, host: "garden.test", page: "article-es.html", target: "EN-US", recent: ["EN-US", "ES", "DE"] },
  ru: { env: { LANG: "ru_RU.UTF-8", LANGUAGE: "ru", LC_ALL: "ru_RU.UTF-8" }, host: "sad.test", page: "article-en.html", target: "RU", recent: ["RU", "EN-US", "DE"] },
};

// ---------- статический сервер демо-страницы ----------
function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml" };
  const srv = http.createServer((req, res) => {
    const f = path.join(DEMO, path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
    if (!f.startsWith(DEMO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}

// ---------- Chrome по CDP через pipe ----------
async function launch(lang, profile) {
  const HOST = CASE[lang].host;
  const chrome = spawn("google-chrome", [
    "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--lang=${lang}`, `--accept-lang=${lang}`, "--window-size=1400,1000",
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${PORT}`,   // встроенному переводчику нужен защищённый адрес
    "about:blank",
  ], { stdio: ["ignore", "ignore", process.env.HT_DEBUG ? "inherit" : "ignore", "pipe", "pipe"], env: Object.assign({}, process.env, CASE[lang].env) });
  const out = chrome.stdio[3], inp = chrome.stdio[4];
  let buf = "", id = 0;
  const pending = new Map();
  inp.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
    out.write(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }) + "\0");
  });
  async function attach(targetId, url) {
    const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
    const c = (m, p) => cmd(m, p, sessionId);
    await c("Page.enable").catch(() => {});
    await c("Runtime.enable");
    if (url) await c("Page.navigate", { url });
    const ev = async (expression) => {
      const r = await c("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result.value;
    };
    const mouse = (type, x, y) => c("Input.dispatchMouseEvent", { type, x, y });
    const key = (type, k, code, modifiers, vk) => c("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    return { targetId, cmd: c, ev, mouse, key };
  }
  const openTab = async (url) => attach((await cmd("Target.createTarget", { url: "about:blank" })).targetId, url);
  const close = async () => { chrome.kill("SIGTERM"); await sleep(700); };
  return { cmd, attach, openTab, close };
}

// Снимок: clip — в CSS-пикселях, картинка — в пикселях устройства (×dpr).
async function shot(tab, file, clip) {
  const p = { format: "png", captureBeyondViewport: false };
  if (clip) p.clip = Object.assign({ scale: 1 }, clip);
  const r = await tab.cmd("Page.captureScreenshot", p);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("   " + path.relative(HERE, file));
}

// Тексты нашего интерфейса на странице (карточка и уведомления — в закрытом shadow root).
async function uiTexts(tab) {
  const { root } = await tab.cmd("DOM.getDocument", { depth: -1, pierce: true });
  const out = [];
  const walk = (n, ui) => {
    const isUi = ui || !!(n.attributes && n.attributes.includes("data-ht-ui"));
    if (n.nodeName === "STYLE" || n.nodeName === "OPTION") return;
    if (isUi && n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
    for (const ch of n.children || []) walk(ch, isUi);
    for (const s of n.shadowRoots || []) walk(s, isUi);
  };
  walk(root, false);
  return out;
}

async function run(lang) {
  const C = CASE[lang], HOST = C.host;
  const OUT = path.join(HERE, "shots", lang);
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(process.env.HT_TMP || os.tmpdir(), "ht-capture-"));   // HT_TMP — где держать копию расширения
  const extDir = path.join(tmp, "ext");                      // новая папка — новая установка (старый service worker не мешает)
  fs.cpSync(EXT_SRC, extDir, { recursive: true });
  const profile = PROFILE || path.join(tmp, "profile");
  console.log(`== ${lang}: профиль ${profile}`);
  const b = await launch(lang, profile);
  const layout = {};
  try {
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: extDir });
    const EXT = `chrome-extension://${id}/`;
    // Приветствие: подготовить встроенный переводчик (пара по языку интерфейса: es→en или en→ru).
    const wt = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html"), 10000);
    if (!wt) throw new Error("не открылось приветствие");
    const w = await b.attach(wt.targetId);
    await until(() => w.ev("!!document.querySelector('.bi-text') && !/…$/.test(document.querySelector('.bi-text').textContent)"), 15000);
    for (let round = 0; round < 3 && !(await w.ev("document.querySelector('.bi-btn').hidden")); round++) {
      console.log("   скачиваю языковые модели…");
      const r = await w.ev("(() => { const r = document.querySelector('.bi-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await w.mouse("mouseMoved", r.x, r.y);
      await w.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await w.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await until(async () => !(await w.ev("document.querySelector('.bi-btn').disabled")) && !/\d%|…$/.test(await w.ev("document.querySelector('.bi-text').textContent")), 400000, 500);
    }
    console.log("   встроенный: " + await w.ev("document.querySelector('.bi-text').textContent"));
    // Вкладка сайта и вкладка окна расширения (через неё — настройки и команды странице); прочие закрыть.
    const web = await b.openTab(`http://${HOST}:${PORT}/${C.page}`);
    const pt = await b.openTab(EXT + "popup.html");
    for (const t of (await b.cmd("Target.getTargets")).targetInfos) {
      if (t.type === "page" && t.targetId !== web.targetId && t.targetId !== pt.targetId) await b.cmd("Target.closeTarget", { targetId: t.targetId });
    }
    await sleep(1000);
    const store = (o) => pt.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    await store({ enabled: true, engine: "chrome", sourceLang: "auto", trigger: "shift", displayMode: "replace", dispMode: "auto",
      targetLang: C.target, recentLangs: C.recent, showLangBadge: true, apiKey: "", llmApiKey: "", consent: {}, hudShown: false });
    // Адрес чужой вкладки расширению без разрешения tabs не виден: вкладка сайта — та, у которой его нет.
    const tabId = JSON.parse(await pt.ev(`chrome.tabs.query({}).then((ts) => JSON.stringify(ts.filter((t) => !t.url || /${HOST}/.test(t.url)).map((t) => t.id)))`))[0];
    const send = (msg) => pt.ev(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(msg)}, { frameId: 0 }).then(() => true, () => false)`);

    await web.cmd("Page.bringToFront");
    const view = async (width, height, dpr) => { await web.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }); await sleep(300); };
    const rect = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const text = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    // Конец последней строки текста элемента — туда на картинке ставится курсор (не поверх слов).
    const lineEnd = (sel) => web.ev(`(() => { const rg = document.createRange(); rg.selectNodeContents(document.querySelector('${sel}'));
      const rs = [...rg.getClientRects()].filter((r) => r.width > 1); const r = rs[rs.length - 1]; return { x: r.right, y: r.top + r.height / 2 }; })()`);
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(40); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(120); };
    const hover = async (sel, dx = 60) => { const r = await rect(sel); const x = r.x + Math.min(dx, r.w - 10), y = r.y + Math.min(14, r.h / 2); await web.mouse("mouseMoved", x, y); await sleep(50); await web.mouse("mouseMoved", x + 2, y); await sleep(60); return { x: x + 2, y }; };
    const translateEl = async (sel) => {
      const before = await text(sel);
      await hover(sel); await tapShift();
      const ok = await until(async () => (await text(sel)) !== before && !(await web.ev(`document.querySelector('${sel}').classList.contains('ht-loading')`)), 30000);
      if (!ok) throw new Error("не перевелось: " + sel + " " + JSON.stringify({ vis: await web.ev("document.visibilityState + ' ' + document.hasFocus()"), secure: await web.ev("isSecureContext"), ui: await uiTexts(web), cls: await web.ev(`document.querySelector('${sel}').className`) }));
      await sleep(250);
      console.log(`   ${sel}: «${(await text(sel)).slice(0, 70)}…»`);
    };
    const scrollTo = async (y) => { await web.ev(`window.scrollTo(0, ${y}); true`); await sleep(250); };
    const park = () => web.mouse("mouseMoved", 2, 2);   // курсор в угол, чтобы не было подсветки наведения

    // ---- разогрев: для нового адреса встроенный переводчик сначала ждёт щелчка (действие пользователя
    // нужно Chrome для «загрузки» модели, даже если она уже на диске) — как у пользователя: Shift,
    // уведомление, щелчок по тексту. Потом адрес помнит разрешение.
    await view(860, 440, 2);
    await web.cmd("Page.reload"); await sleep(1500);
    {
      const before = await text("#p1");
      const at = await hover("#p1"); await tapShift();
      if (!(await until(async () => (await text("#p1")) !== before, 2500))) {
        console.log("   первый перевод на адресе: " + JSON.stringify(await uiTexts(web)).slice(0, 140) + " — щелчок по тексту");
        await web.cmd("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
        await web.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
        if (!(await until(async () => (await text("#p1")) !== before, 60000))) throw new Error("разогрев: не перевелось");
      }
      await send({ type: "restoreAll" });
    }

    // ---- 1. До и после: заголовок, вступление и абзац со ссылкой и выделением ----
    await view(600, 540, 2);
    await web.cmd("Page.reload"); await sleep(1500); await scrollTo(0); await park();
    await shot(web, path.join(OUT, "s1-before.png"));
    for (const sel of ["#title", "p.meta", "#lead", "#p1"]) await translateEl(sel);
    layout.s1 = { view: [600, 540], p1: await rect("#p1"), link: await rect("#p1 a"), bold: await rect("#p1 b"), end: await lineEnd("#p1") };
    await park(); await sleep(200);
    await shot(web, path.join(OUT, "s1-after.png"));
    await send({ type: "restoreAll" }); await sleep(400);

    // ---- 2. Карточка с переводом под текстом ----
    await store({ displayMode: "popover" }); await sleep(400);
    await view(860, 440, 2);
    await web.cmd("Page.reload"); await sleep(1500);
    const yH2 = (await rect("#h2a")).y; await scrollTo(yH2 - 28);
    const pos = await hover("#p2", 250); await tapShift();
    const card = await until(async () => { const t = await uiTexts(web); return t.some((s) => s.length > 60) ? t : null; }, 30000);
    if (!card) throw new Error("карточка не появилась");
    await sleep(500);
    console.log("   карточка: " + JSON.stringify(card).slice(0, 160));
    layout.s2 = { view: [860, 440], p2: await rect("#p2"), cursor: pos, end: await lineEnd("#p2") };
    await shot(web, path.join(OUT, "s2-card.png"));
    await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(300);
    await store({ displayMode: "replace" }); await sleep(300);

    // ---- 4. Перевести страницу (с мини-панелью языка) ----
    // Высота 480: уведомление внизу окна не закрывает первый абзац.
    await view(860, 480, 2);
    await web.cmd("Page.reload"); await sleep(1500); await scrollTo(0); await park();
    await store({ hudPos: { left: 5000, top: 6 } });   // панель — справа в шапке сайта, чтобы не легла под уведомление
    await send({ type: "toggleHud" }); await sleep(500);
    await send({ type: "translatePage", via: "popup" });
    const done = await until(async () => { const t = await uiTexts(web); return t.some((x) => /^(Done|Готово)/.test(x)) ? t : null; }, 60000, 300);
    if (!done) throw new Error("перевод страницы не закончился");
    await sleep(1200);
    console.log("   страница: " + JSON.stringify(done).slice(0, 160));
    await shot(web, path.join(OUT, "s4-page.png"));
    layout.s4 = { view: [860, 480] };
    await send({ type: "restoreAll" }); await send({ type: "toggleHud" }); await sleep(300);

    // ---- 3 и 5. Окно расширения ----
    const DPR = 3;
    await pt.cmd("Page.bringToFront");
    await pt.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    const popup = async (after) => {
      await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 1800, deviceScaleFactor: DPR, mobile: false });
      await pt.cmd("Page.reload"); await sleep(1200);
      // Окно ищет активную вкладку сайта; здесь «активна» само окно — показываем ему вкладку статьи.
      await pt.ev(`chrome.tabs.query = (q, cb) => chrome.tabs.get(${tabId}).then((t) => cb([t])); refreshTabState().then(() => true)`);
      await until(async () => !/…$/.test(await pt.ev("document.querySelector('.bi-text') ? document.querySelector('.bi-text').textContent : ''")), 8000);
      if (after) { await pt.ev(after + "; true"); }
      await sleep(500);
      const h = await pt.ev("Math.ceil(document.body.getBoundingClientRect().height)");
      await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: DPR, mobile: false });
      await sleep(300);
      return h;
    };
    const elRect = (sel) => pt.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    await store({ engine: "chrome", apiKey: "", consent: {} });
    layout.s3 = { h: await popup() };
    await shot(pt, path.join(OUT, "s3-popup.png"));
    const acts = await elRect(".actions");
    await shot(pt, path.join(OUT, "s4-actions.png"), { x: acts.x - 6, y: acts.y - 6, width: acts.width + 12, height: acts.height + 12 });
    // переводчик: встроенный выбран, видны DeepL и ИИ
    await popup("setFold(els.qualityHead, els.qualityBody, true)");
    const q = await elRect("#qualityBlock"), eng = await elRect("#engine"), bi = await elRect("#builtinBox");
    layout.s5 = { quality: q };
    await shot(pt, path.join(OUT, "s5-engines.png"), { x: q.x, y: q.y, width: q.width, height: Math.ceil(Math.max(eng.y + eng.height, bi.y + bi.height) - q.y + 14) });
    // DeepL выбран, согласия нет: просьба о согласии внутри «Качества перевода»
    await store({ engine: "deepl", apiKey: "00000000-0000-0000-0000-000000000000:fx", consent: {} });
    await popup("setFold(els.qualityHead, els.qualityBody, true)");
    const cb = await elRect("#consentBox");
    await shot(pt, path.join(OUT, "s5-consent.png"), { x: cb.x - 6, y: cb.y - 6, width: cb.width + 12, height: cb.height + 12 });
    await store({ engine: "chrome", apiKey: "", consent: {} });

    fs.writeFileSync(path.join(OUT, "layout.js"), `// Записано capture.js: координаты (CSS-пиксели снимка) для курсора на картинках.\nwindow.LAYOUT = ${JSON.stringify(layout, null, 1)};\n`);
  } finally {
    await b.close();
    fs.rmSync(tmp, { recursive: true, force: true });   // копия расширения (и новый профиль, если не задан свой)
  }
}

(async () => {
  const srv = await serve();
  try { for (const l of LANGS.length ? LANGS : ["en", "ru"]) await run(l); }
  finally { srv.close(); }
  console.log("готово");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
