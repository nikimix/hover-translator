// Съёмка настоящего расширения для картинок магазина: Chrome без интерфейса, расширение загружается
// через Extensions.loadUnpacked (флаг --load-extension в Chrome 137+ не работает), перевод — встроенный
// переводчик Chrome. Демо-страница из demo/ отдаётся встроенным сервером под вымышленным адресом в
// зарезервированной зоне .test (garden.test; для русского — sad.test). Сеть не нужна, кроме однократной
// загрузки языковых моделей.
//
//   node assets/store/capture.js [en|ru ...] [--profile DIR]
//
// en — интерфейс на английском, статья на испанском, перевод на английский;
// ru — интерфейс на русском, статья на английском, перевод на русский.
// --profile — папка профиля Chrome, где модели уже скачаны (иначе — новый профиль, и модели скачиваются:
// 1–5 минут, нужен интернет).
// Результат — shots/<lang>/*.png и shots/<lang>/layout.js (координаты для курсора и рамок на картинках):
//   s1-before.png, s1-after.png — абзацы до и после перевода клавишей (600×540, ×2);
//   s2-card.png                 — перевод карточкой рядом с абзацем (860×440, ×2);
//   s3-settings.png             — страница настроек, раздел «На странице»: способ перевода и показа (×3);
//   s4-popup.png, s4-page.png   — окно расширения с кнопкой «Перевести страницу» (×3) и переведённая
//                                 страница с мини-панелью (860×480, ×2);
//   s5-translator.png           — страница настроек, раздел «Переводчик»: выбран DeepL, шаг согласия (×3).
//
// Окно расширения: Extensions.triggerAction открывает настоящее окно по значку — так расширение получает
// activeTab (адрес вкладки). Самому окну в Chrome без интерфейса нельзя задать плотность пикселей (и снимок
// за пределами окна там размножает кадр), поэтому снимается копия popup.html в обычной вкладке: ей
// подменяется chrome.tabs.query (до скриптов окна), чтобы «активной» была вкладка статьи — её адрес после
// triggerAction виден. Высота — как у настоящего окна.
// Настройки, чтение вкладок и команды странице — из service worker расширения.
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

// pair — пара встроенного переводчика (язык статьи → язык перевода); recent — недавние языки: окно
// показывает до трёх чипов без текущего и исходного (украинский в видные места не ставить).
const CASE = {
  en: { env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" }, host: "garden.test", page: "article-es.html", target: "EN-US",
    pair: ["es", "en"], recent: ["EN-US", "DE", "FR", "IT"] },
  ru: { env: { LANG: "ru_RU.UTF-8", LANGUAGE: "ru", LC_ALL: "ru_RU.UTF-8" }, host: "sad.test", page: "article-en.html", target: "RU",
    pair: ["en", "ru"], recent: ["RU", "DE", "FR", "ES"] },
};

// Разметка нового интерфейса (окно — popup.js, настройки — options.html, общие классы — ui.css). Если в кадре
// чего-то нет, capture.js пишет предупреждение «!» и в конце выходит с кодом 2 — смотреть картинки.
const SEL = {
  popupPrimary: ".p-act .btn-primary",            // «Перевести страницу» на месте действия окна
  optSection: ".sec",                              // раздел страницы настроек (id: translator, page, langs, …)
  optSectionTitle: ".sec-h",
  optRow: ".card-row",                             // строка карточки раздела
  optPage: ".pg",                                  // корень страницы настроек (цвет фона — для подложки на картинке)
};
// Разделы настроек: id по макету, запасной путь — по заголовку, затем по порядку.
const SECTIONS = {
  translator: { id: "translator", title: /^(Переводчик|Translator|Translation)$/i, index: 0 },
  page: { id: "page", title: /^(На странице|On the page|On pages?)$/i, index: 1 },
};

// Предупреждения: кадр снят, но что-то не так (в конце — список и код выхода 2).
const WARN = [];
const warn = (m) => { WARN.push(m); console.log("   ! " + m); };
// Проблемные состояния, которых не должно быть в кадре: ошибки, «нужно скачать», «обновить вкладку».
const BAD = /Перевод не работает|Translation isn.t working|нужно скачать|download needed|Скачать переводчик|Download translator|Скачивание|Downloading|не скачался|download failed|Не удалось|Couldn.t|Обновить вкладку|Reload tab|Ключ не принят|нет связи|Проверяю|Checking/i;
const checkState = (where, text) => { const m = BAD.exec(text || ""); if (m) warn(`${where}: «${m[0]}» — проблемное состояние в кадре`); };

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
    await c("Page.enable").catch(() => {});        // у service worker домена Page нет
    await c("Runtime.enable");
    if (url) await c("Page.navigate", { url });
    // gesture — с действием пользователя (Translator.create при скачивании модели без него не работает)
    const ev = async (expression, gesture = false) => {
      const r = await c("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
      if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result.value;
    };
    const mouse = (type, x, y) => c("Input.dispatchMouseEvent", { type, x, y });
    const click = async (x, y) => { await mouse("mouseMoved", x, y); await c("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await c("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); };
    const key = (type, k, code, modifiers, vk) => c("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    return { targetId, cmd: c, ev, mouse, click, key };
  }
  const openTab = async (url) => attach((await cmd("Target.createTarget", { url: "about:blank" })).targetId, url);
  const targets = async (filter) => (await cmd("Target.getTargets", filter ? { filter } : {})).targetInfos;
  const close = async () => { chrome.kill("SIGTERM"); await sleep(700); };
  return { cmd, attach, openTab, targets, close };
}

// Снимок: clip — в CSS-пикселях, картинка — в пикселях устройства (×dpr).
async function shot(tab, file, clip) {
  const p = { format: "png", captureBeyondViewport: false };
  if (clip) p.clip = Object.assign({ scale: 1 }, clip);
  const r = await tab.cmd("Page.captureScreenshot", p);
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log("   " + path.relative(HERE, file));
}

// Наш интерфейс на странице (уведомления, карточка, мини-панель) — в закрытом shadow root под хостом
// с атрибутом data-ht-ui; CDP видит его через pierce. visit(node) — для каждого узла внутри.
async function walkUi(tab, visit) {
  const { root } = await tab.cmd("DOM.getDocument", { depth: -1, pierce: true });
  const walk = (n, ui) => {
    const isUi = ui || !!(n.attributes && n.attributes.includes("data-ht-ui"));
    if (n.nodeName === "STYLE" || n.nodeName === "OPTION") return;
    if (isUi) visit(n);
    for (const ch of n.children || []) walk(ch, isUi);
    for (const s of n.shadowRoots || []) walk(s, isUi);
  };
  walk(root, false);
}
async function uiTexts(tab) {
  const out = [];
  await walkUi(tab, (n) => { if (n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim()); });
  return out;
}
// Закрыть уведомления на странице (кнопка ✕: aria-label «Закрыть уведомление»/«Close notification», toastCloseAria).
async function uiClose(tab) {
  const ids = [];
  await walkUi(tab, (n) => {
    if (n.nodeName !== "BUTTON" || !n.attributes) return;
    const i = n.attributes.indexOf("aria-label");
    if (i >= 0 && /^(Закрыть|Close)/i.test(n.attributes[i + 1])) ids.push(n.nodeId);
  });
  for (const nodeId of ids) {
    try {
      const q = (await tab.cmd("DOM.getBoxModel", { nodeId })).model.border;
      await tab.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2); await sleep(250);
    } catch { /* уже скрыто */ }
  }
  return ids.length;
}

// Раздел страницы настроек (выражение для страницы): по id, иначе по заголовку, иначе по порядку.
const findSection = (key) => `(() => {
  const S = ${JSON.stringify(SECTIONS[key], (k, v) => (v instanceof RegExp ? v.source : v))};
  const all = [...document.querySelectorAll(${JSON.stringify(SEL.optSection)})];
  const re = new RegExp(S.title, "i");
  return document.getElementById(S.id) || all.find((s) => re.test(((s.querySelector(${JSON.stringify(SEL.optSectionTitle)}) || {}).textContent || "").trim())) || all[S.index] || null;
})()`;
const sectionText = (key) => `((s) => (s ? s.innerText : ""))(${findSection(key)})`;
// Рамка раздела в CSS-пикселях — без заголовка раздела (его роль на картинке играет подпись).
// keepRows — оставить в карточке раздела только первые N строк (остальные скрыть: карточка тогда кончается
// своим краем, а не обрывается посередине).
const sectionClip = (key, keepRows = 0) => `((sec) => {
  if (!sec) return null;
  if (${keepRows}) [...sec.querySelectorAll(${JSON.stringify(SEL.optRow)})].slice(${keepRows}).forEach((r) => { r.style.display = "none"; });
  const T = ${JSON.stringify(SEL.optSectionTitle)};
  const kids = [...sec.children], head = kids.find((k) => k.matches(T) || k.querySelector(T));
  const rs = (kids.length > 1 ? kids.filter((k) => k !== head) : [sec]).map((k) => k.getBoundingClientRect()).filter((r) => r.width && r.height);
  const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
  return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y };
})(${findSection(key)})`;

// Видимый текст страницы для журнала (без списков выбора: в окне это сотня названий языков).
const PAGE_TEXT = `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT,
  { acceptNode: (n) => (n.parentElement && n.parentElement.closest("select, style, script") ? 2 : 1) });
  let s = ""; while (w.nextNode()) s += " " + w.currentNode.nodeValue; return s.replace(/\\s+/g, " ").trim().slice(0, 200); })()`;

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

    // Service worker расширения: через него — настройки, вкладки и сообщения странице.
    const swt = await until(async () => (await b.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(EXT)), 10000);
    if (!swt) throw new Error("не запустился service worker расширения");
    const sw = await b.attach(swt.targetId);
    const store = (values) => sw.ev(`chrome.storage.local.set(${JSON.stringify(values)}).then(() => true)`);

    // Языковые модели встроенного переводчика — в странице расширения (её открывает установка: приветствие).
    const wt = await until(async () => (await b.targets()).find((t) => t.type === "page" && t.url.startsWith(EXT)), 10000);
    if (!wt) throw new Error("не открылась страница расширения после установки");
    const w = await b.attach(wt.targetId);
    await until(() => w.ev("document.readyState === 'complete'"), 10000);
    const [src, tgt] = C.pair;
    const avail = await w.ev(`self.Translator ? Translator.availability({ sourceLanguage: "${src}", targetLanguage: "${tgt}" }) : "no-api"`);
    console.log(`   встроенный ${src} → ${tgt}: ${avail}`);
    if (avail === "no-api" || avail === "unavailable") throw new Error("встроенного переводчика нет или пара не поддерживается: " + avail);
    if (avail !== "available") {
      console.log("   скачиваю языковые модели…");
      await w.ev(`Translator.create({ sourceLanguage: "${src}", targetLanguage: "${tgt}" }).then((t) => { t.destroy && t.destroy(); return true; })`, true);
    }
    if (await w.ev(`self.LanguageDetector ? LanguageDetector.availability().then((a) => a !== "available") : false`)) {
      await w.ev(`LanguageDetector.create().then((d) => { d.destroy && d.destroy(); return true; })`, true);
    }
    console.log("   встроенный: " + await w.ev(`Translator.availability({ sourceLanguage: "${src}", targetLanguage: "${tgt}" })`));

    await store({ enabled: true, engine: "chrome", sourceLang: "auto", trigger: "shift", displayMode: "replace", dispMode: "auto",
      targetLang: C.target, recentLangs: C.recent, showLangBadge: true, apiKey: "", llmApiKey: "", consent: {}, hudShown: false, hudPos: null });

    // Вкладка сайта; прочие страницы закрыть.
    const web = await b.openTab(`http://${HOST}:${PORT}/${C.page}`);
    for (const t of await b.targets()) if (t.type === "page" && t.targetId !== web.targetId) await b.cmd("Target.closeTarget", { targetId: t.targetId });
    await sleep(1000);

    // Значок расширения на панели: настоящее окно (даёт activeTab до следующей загрузки вкладки) — его
    // состояние в журнал, само окно закрыть. Возвращает высоту окна.
    const grant = async () => {
      const tab = (await b.targets([{ type: "tab" }])).find((t) => t.url.includes(HOST));
      const before = new Set((await b.targets()).map((t) => t.targetId));
      await b.cmd("Extensions.triggerAction", { id, targetId: tab.targetId });
      const pt = await until(async () => (await b.targets()).find((t) => t.type === "page" && t.url.startsWith(EXT + "popup.html") && !before.has(t.targetId)), 8000);
      if (!pt) throw new Error("значок не открыл окно расширения");
      const p = await b.attach(pt.targetId);
      await until(() => p.ev("document.readyState === 'complete'"), 8000);
      await sleep(1200);
      const info = await p.ev(`JSON.stringify({ h: innerHeight, text: ${PAGE_TEXT} })`);
      console.log("   окно по значку: " + info);
      await b.cmd("Target.closeTarget", { targetId: pt.targetId });
      return JSON.parse(info).h;
    };
    await grant();
    const tabId = await sw.ev(`chrome.tabs.query({}).then((ts) => (ts.find((t) => (t.url || "").includes("${HOST}")) || {}).id)`);
    if (!tabId) throw new Error("не нашёл вкладку сайта");
    const send = (msg) => sw.ev(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(msg)}, { frameId: 0 }).then((r) => JSON.stringify(r === undefined ? null : r), () => "null")`).then(JSON.parse);

    await web.cmd("Page.bringToFront");
    const view = async (width, height, dpr) => { await web.cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false }); await sleep(300); };
    const rect = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const text = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    // Конец последней строки текста элемента — туда на картинке ставится курсор (не поверх слов).
    const lineEnd = (sel) => web.ev(`(() => { const rg = document.createRange(); rg.selectNodeContents(document.querySelector('${sel}'));
      const rs = [...rg.getClientRects()].filter((r) => r.width > 1); const r = rs[rs.length - 1]; return { x: r.right, y: r.top + r.height / 2 }; })()`);
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(40); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(120); };
    const hover = async (sel, dx = 60) => { const r = await rect(sel); const x = r.x + Math.min(dx, r.w - 10), y = r.y + Math.min(14, r.h / 2); await web.mouse("mouseMoved", x, y); await sleep(50); await web.mouse("mouseMoved", x + 2, y); await sleep(60); return { x: x + 2, y }; };
    const busy = (sel) => web.ev(`/(^|\\s)ht-loading/.test(document.querySelector('${sel}').className)`);   // блок пульсирует, пока идёт перевод (content.js)
    const translateEl = async (sel) => {
      const before = await text(sel);
      await hover(sel); await tapShift();
      const ok = await until(async () => (await text(sel)) !== before && !(await busy(sel)), 30000);
      if (!ok) throw new Error("не перевелось: " + sel + " " + JSON.stringify({ vis: await web.ev("document.visibilityState + ' ' + document.hasFocus()"), secure: await web.ev("isSecureContext"), ui: await uiTexts(web), cls: await web.ev(`document.querySelector('${sel}').className`) }));
      await sleep(250);
      console.log(`   ${sel}: «${(await text(sel)).slice(0, 70)}…»`);
    };
    const scrollTo = async (y) => { await web.ev(`window.scrollTo(0, ${y}); true`); await sleep(250); };
    const park = () => web.mouse("mouseMoved", 2, 2);   // курсор в угол, чтобы не было подсветки наведения
    const restore = async () => {                        // вся страница — к оригиналу
      if (!(await send({ type: "restoreAll" }))) { await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); }
      await sleep(400);
    };

    // ---- разогрев: для нового адреса встроенный переводчик сначала ждёт щелчка (действие пользователя
    // нужно Chrome для «загрузки» модели, даже если она уже на диске) — как у пользователя: Shift,
    // уведомление «Щёлкните по тексту», щелчок. Потом адрес помнит разрешение.
    await view(860, 440, 2);
    await web.cmd("Page.reload"); await sleep(1500);
    {
      const before = await text("#p1");
      const at = await hover("#p1"); await tapShift();
      if (!(await until(async () => (await text("#p1")) !== before, 2500))) {
        console.log("   первый перевод на адресе: " + JSON.stringify(await uiTexts(web)).slice(0, 140) + " — щелчок по тексту");
        await web.click(at.x, at.y);
        if (!(await until(async () => (await text("#p1")) !== before, 60000))) throw new Error("разогрев: не перевелось");
      }
      await restore();
    }

    // ---- 1. До и после: заголовок, вступление и абзац со ссылкой и выделением ----
    await view(600, 540, 2);
    await web.cmd("Page.reload"); await sleep(1500); await scrollTo(0); await park();
    await shot(web, path.join(OUT, "s1-before.png"));
    for (const sel of ["#title", "p.meta", "#lead", "#p1"]) await translateEl(sel);
    layout.s1 = { view: [600, 540], p1: await rect("#p1"), link: await rect("#p1 a"), bold: await rect("#p1 b"), end: await lineEnd("#p1") };
    await park(); await uiClose(web); await sleep(200);
    await shot(web, path.join(OUT, "s1-after.png"));
    await restore();

    // ---- 2. Карточка с переводом под текстом ----
    await store({ displayMode: "popover" }); await sleep(400);
    await view(860, 440, 2);
    await web.cmd("Page.reload"); await sleep(1500);
    const yH2 = (await rect("#h2a")).y; await scrollTo(yH2 - 28);
    const pos = await hover("#p2", 250); await tapShift();
    const card = await until(async () => { const t = await uiTexts(web); return t.join(" ").length > 80 ? t : null; }, 30000);   // перевод в карточке
    if (!card) throw new Error("карточка не появилась");
    await sleep(500);
    console.log("   карточка: " + JSON.stringify(card).slice(0, 160));
    layout.s2 = { view: [860, 440], p2: await rect("#p2"), cursor: pos, end: await lineEnd("#p2") };
    await shot(web, path.join(OUT, "s2-card.png"));
    await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(300);
    await store({ displayMode: "replace" }); await sleep(300);

    // ---- 4. Окно расширения и переведённая страница с мини-панелью ----
    // Сначала окно (страница только что загружена — на месте действия «Перевести страницу»), потом перевод.
    await store({ hudShown: true, hudPos: null }); await sleep(300);   // мини-панель — на своём месте (внизу справа)
    await view(860, 480, 2);
    await web.cmd("Page.reload"); await sleep(1500); await scrollTo(0); await park();
    const popupH = await grant();
    const pt = await b.openTab("about:blank");
    // «Активная вкладка» для окна — вкладка статьи (адрес виден после grant: activeTab).
    await pt.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (o, cb) => { const p = o && o.active ? chrome.tabs.get(${tabId}).then((t) => [t]) : q(o || {}); if (!cb) return p; p.then(cb); };
    })();` });
    await pt.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: popupH || 600, deviceScaleFactor: 3, mobile: false });
    await pt.cmd("Page.navigate", { url: EXT + "popup.html" });
    await until(() => pt.ev("document.readyState === 'complete'"), 8000);
    await pt.ev("document.fonts.ready.then(() => true)"); await sleep(1200);
    const ph = popupH || await pt.ev("Math.ceil(Math.max(...[...document.body.children].map((e) => e.getBoundingClientRect().bottom)))");
    await pt.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: ph, deviceScaleFactor: 3, mobile: false }); await sleep(300);
    const popupText = await pt.ev(PAGE_TEXT);
    console.log("   окно во вкладке: " + popupText);
    checkState("окно расширения", popupText);
    const btn = await pt.ev(`(() => { const e = document.querySelector(${JSON.stringify(SEL.popupPrimary)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    if (!btn) warn("нет кнопки «Перевести страницу» (" + SEL.popupPrimary + ") — рамки на картинке не будет");
    await shot(pt, path.join(OUT, "s4-popup.png"));
    await b.cmd("Target.closeTarget", { targetId: pt.targetId });
    // перевод страницы — той же командой, что шлёт кнопка окна
    await web.cmd("Page.bringToFront"); await park();
    await send({ type: "translatePage", via: "popup" });
    const done = await until(async () => {
      const st = await send({ type: "getHudState" });
      if (st && st.page === "done") return true;
      return (await uiTexts(web)).some((x) => /^(Страница переведена|Page translated|Done|Готово)/.test(x));
    }, 60000, 300);
    if (!done) throw new Error("перевод страницы не закончился");
    await sleep(1200);
    await uiClose(web);   // уведомление «Страница переведена» на картинке закрыло бы окно расширения
    await park(); await sleep(400);
    await shot(web, path.join(OUT, "s4-page.png"));
    layout.s4 = { view: [860, 480], popup: { w: 340, h: ph, btn } };
    await restore(); await store({ hudShown: false });

    // ---- 3 и 5. Страница настроек ----
    // Ширина 620 (кадр 5): меню разделов — полосой сверху, колонка разделов ~570 — крупнее на картинке; кадр 3 — 660.
    const OPT_W = 620;
    const op = await b.openTab("about:blank");
    await op.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await op.cmd("Emulation.setDeviceMetricsOverride", { width: OPT_W, height: 2600, deviceScaleFactor: 3, mobile: false });
    await op.cmd("Page.navigate", { url: EXT + "options.html" });
    await until(() => op.ev("document.readyState === 'complete'"), 8000);
    await op.ev("document.fonts.ready.then(() => true)"); await sleep(1500);
    // состояние встроенного («Проверяю…» → «Готов · пара»)
    await until(async () => { const t = await op.ev(sectionText("translator")); return t && !/…/.test(t); }, 8000);
    const bg = await op.ev(`getComputedStyle(document.querySelector(${JSON.stringify(SEL.optPage)}) || document.body).backgroundColor`);
    const pad = 16;
    const grow = (r) => ({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + 2 * pad, height: r.height + 2 * pad });

    // 3: «На странице» — строки «Как переводить» и «Как показывать перевод». Ширина 660: уже 640 превью
    // способа показа встают одно под другим, а на макете (и в обычном окне) они рядом.
    await op.cmd("Emulation.setDeviceMetricsOverride", { width: 660, height: 2600, deviceScaleFactor: 3, mobile: false }); await sleep(400);
    const s3 = await op.ev(sectionClip("page", 2));
    checkState("раздел «На странице»", await op.ev(sectionText("page")));
    if (!s3) throw new Error("на странице настроек нет раздела «На странице»");
    await shot(op, path.join(OUT, "s3-settings.png"), grow(s3));
    layout.s3 = { bg };
    await op.cmd("Emulation.setDeviceMetricsOverride", { width: OPT_W, height: 2600, deviceScaleFactor: 3, mobile: false }); await sleep(400);

    // 5: «Переводчик»: встроенный готов, выбран DeepL — раскрыт шаг согласия (перевод ещё встроенный).
    // Карточка DeepL: переключатель value="deepl" (настоящий input или role=radio), иначе — заголовок карточки,
    // который начинается с «DeepL» (не «Авто: DeepL…»).
    const picked = await op.ev(`((sec) => {
      if (!sec) return false;
      const r = sec.querySelector('input[type="radio"][value="deepl"], [role="radio"][value="deepl"], [role="radio"][data-value="deepl"]')
        || [...sec.querySelectorAll('label, [role="radio"], .rc-head')].find((e) => /^DeepL\\b/.test((e.textContent || "").trim()));
      if (!r) return false; r.click(); return true; })(${findSection("translator")})`);
    if (!picked) warn("не нашёл карточку DeepL — раздел «Переводчик» снят как есть");
    const consentShown = await until(async () => /Разрешить отправку|Allow sending/i.test(await op.ev(sectionText("translator"))), 4000);
    if (picked && !consentShown) warn("у DeepL не раскрылся шаг согласия («Разрешить отправку»)");
    await sleep(500);
    checkState("раздел «Переводчик»", await op.ev(sectionText("translator")));
    const s5 = await op.ev(sectionClip("translator"));
    await shot(op, path.join(OUT, "s5-translator.png"), grow(s5));
    layout.s5 = { bg };
    await b.cmd("Target.closeTarget", { targetId: op.targetId });
    await store({ engine: "chrome", apiKey: "", consent: {} });

    fs.writeFileSync(path.join(OUT, "layout.js"), `// Записано capture.js: координаты (CSS-пиксели снимка) для курсора и рамок на картинках.\nwindow.LAYOUT = ${JSON.stringify(layout, null, 1)};\n`);
  } finally {
    await b.close();
    fs.rmSync(tmp, { recursive: true, force: true });   // копия расширения (и новый профиль, если не задан свой)
  }
}

(async () => {
  const srv = await serve();
  try { for (const l of LANGS.length ? LANGS : ["en", "ru"]) await run(l); }
  finally { srv.close(); }
  if (WARN.length) { console.log(`готово, но с предупреждениями (${WARN.length}):\n  ! ` + WARN.join("\n  ! ")); process.exit(2); }
  console.log("готово");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
