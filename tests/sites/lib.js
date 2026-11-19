// Обвязка проверок на живых сайтах (tests/sites/run.js): Chrome через Playwright, расширение через CDP,
// сбор ошибок консоли, команды вкладке через service worker расширения, помощники для действий на сайте.
//
// ВАЖНО: page.evaluate / page.$ / locator у Playwright исполняются с userGesture: true — каждая такая проверка
// дала бы странице «действие пользователя» (transient activation, ~5 с), и встроенный переводчик Chrome начал
// бы качать модели там, где у человека он попросил бы щелчок. Поэтому все проверки на странице — через свой
// CDP-сеанс (Runtime.evaluate без жеста), а щелчки и клавиши — настоящие (Input.*), как у человека.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT_SRC = path.join(ROOT, "hover-translate");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- playwright-core ----------
// Пакетов npm в репозитории нет: берём playwright-core из PLAYWRIGHT_CORE, из кэша npx, из <HT_TMP>/node_modules
// (туда его можно поставить: cd ~/.cache/ht-tests && npm i playwright-core) или обычным require.
function loadPlaywright(tmpBase) {
  const tries = [
    process.env.PLAYWRIGHT_CORE,
    path.join(os.homedir(), ".npm/_npx/9833c18b2d85bc59/node_modules/playwright-core"),
    path.join(tmpBase, "node_modules/playwright-core"),
    "playwright-core",
  ].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch (e) { /* следующий */ }
  }
  throw new Error("нет playwright-core: поставьте его во временную папку — cd " + tmpBase + " && npm i playwright-core" +
    " (или укажите путь в PLAYWRIGHT_CORE)");
}

// ---------- запуск Chrome ----------
// Playwright по умолчанию ломает встроенный переводчик Chrome: --disable-component-update и
// --disable-background-networking вешают загрузку TranslateKit на 0 %, а OptimizationHints в его
// --disable-features делает LanguageDetector всегда «unavailable». Убираем эти флаги и ставим свой
// --disable-features без OptimizationHints (тот же список, что в playwright-core 1.66 — chromiumSwitches.ts).
const PW_DISABLED = ["AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "HttpsUpgrades",
  "HttpsFirstBalancedModeAutoEnable", "LensOverlay", "MediaRouter", "PaintHolding", "ThirdPartyStoragePartitioning",
  "AvoidCorsURLLoaderRestartOnRedirect", "TcpPortRandomizationWin", "OptimizationHints", "NetworkTimeServiceQuerying",
  "AimEnabled", "PreconnectToSearch", "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion"];
// Строка агента — как у обычного Chrome той же версии, без «HeadlessChrome»: расширением пользуются в обычном Chrome,
// и проверять надо ту страницу, что сайт отдаёт человеку (для «HeadlessChrome» часть сайтов отдаёт 403 или капчу).
// Больше ничего не подменяем; проверки ботов не обходим — сайт с 403 или Cloudflare помечается закрытым
// (sites.js → blockedPage).
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1280, height: 800 };

// extSrc — папка расширения (по умолчанию hover-translate рабочего дерева; run.js --ext — например, снимок из HEAD);
// patchExt(dir) — своя правка копии расширения перед загрузкой (отладка: console.log в content.js).
async function launchChrome(pw, { profile, withExt, headed, tmp, chromePath, acceptLang, patchExt, extSrc }) {
  const env = Object.assign({}, process.env, { LANG: "ru_RU.UTF-8", LANGUAGE: "ru", LC_ALL: "ru_RU.UTF-8", TMPDIR: tmp });
  const ctx = await pw.chromium.launchPersistentContext(profile, {
    executablePath: chromePath, headless: !headed,
    args: [
      "--no-first-run", "--no-default-browser-check", "--lang=ru", `--accept-lang=${acceptLang}`,
      "--disable-features=" + PW_DISABLED.filter((f) => f !== "OptimizationHints").join(","),
    ].concat(withExt ? ["--enable-unsafe-extension-debugging"] : []),
    ignoreDefaultArgs: ["--disable-component-update", "--disable-background-networking", "--disable-field-trial-config",
      "--disable-features=" + PW_DISABLED.join(",")]
      .concat(withExt ? ["--disable-extensions", "--disable-component-extensions-with-background-pages"] : []),
    env, viewport: VIEWPORT, colorScheme: "light", userAgent: UA,
    // locale не задаём: Playwright тогда подменил бы navigator.languages одним языком, и пара en → ru
    // стала бы «скрытой» (расширение просит щелчок на каждом сайте) — у людей так не бывает.
  });
  const out = { ctx, ext: null };
  if (!withExt) return out;
  // Расширение — копия папки hover-translate во временной папке: новый путь — новая установка; копию
  // удаляем в конце, иначе в сохранённом профиле (--profile) Chrome поднимал бы её и при следующем запуске.
  const extDir = fs.mkdtempSync(path.join(tmp, "ext-"));
  fs.cpSync(extSrc || EXT_SRC, extDir, { recursive: true });
  if (patchExt) await patchExt(extDir);
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extDir });
  const swUrl = `chrome-extension://${id}/background.js`;
  let sw = null;
  for (let i = 0; i < 100 && !sw; i++) { sw = ctx.serviceWorkers().find((w) => w.url() === swUrl) || null; if (!sw) await sleep(100); }
  if (!sw) throw new Error("service worker расширения не поднялся");
  // Приветствие открывается при установке — закрываем (готовность встроенного переводчика проверяем сами).
  for (let i = 0; i < 20; i++) {
    const w = ctx.pages().find((p) => p.url().startsWith(`chrome-extension://${id}/welcome.html`));
    if (w) { await w.close().catch(() => {}); break; }
    await sleep(150);
  }
  out.ext = { id, swUrl, cdp, extDir };
  return out;
}

// Service worker расширения: тот, что жив сейчас.
async function worker(run) {
  for (let i = 0; i < 50; i++) {
    const w = run.ctx.serviceWorkers().find((x) => x.url() === run.ext.swUrl);
    if (w) return w;
    await sleep(100);
  }
  throw new Error("нет service worker расширения");
}
async function swEval(run, fn, arg) {
  for (let i = 0; ; i++) {
    const w = await worker(run);
    try { return await w.evaluate(fn, arg); } catch (e) {
      if (i >= 3 || !/Target closed|destroyed|has been closed/i.test(e.message)) throw e;
      await sleep(300);
    }
  }
}
const storage = {
  get: (run, keys) => swEval(run, (k) => chrome.storage.local.get(k), keys || null),
  set: (run, obj) => swEval(run, (o) => chrome.storage.local.set(o).then(() => true), obj),
};

// id вкладки Chrome для страницы Playwright: окно по CDP → активная вкладка этого окна (у расширения нет
// разрешения tabs, адресов вкладок оно не видит).
async function tabIdOf(run, page) {
  await page.bringToFront();
  const s = await run.ctx.newCDPSession(page);
  const { targetInfo } = await s.send("Target.getTargetInfo");
  await s.detach().catch(() => {});
  const { windowId } = await run.ext.cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
  const tabs = await swEval(run, (wid) => chrome.tabs.query({ windowId: wid }).then((ts) => ts.map((t) => ({ id: t.id, active: t.active }))), windowId);
  const t = tabs.find((x) => x.active) || tabs[0];
  if (!t) throw new Error("не нашёл вкладку");
  return t.id;
}
// Сообщение content.js (как шлёт окно расширения): верхнему фрейму; restoreAll — всем фреймам.
async function tabSend(run, page, msg) {
  const tid = await tabIdOf(run, page);
  return swEval(run, ([t, m]) => chrome.tabs.sendMessage(t, m, m.type === "restoreAll" ? undefined : { frameId: 0 })
    .then((r) => ({ ok: true, r }), (e) => ({ ok: false, err: String(e && e.message || e) })), [tid, msg]);
}
const tabState = async (run, page) => { const x = await tabSend(run, page, { type: "getHudState" }).catch(() => null); return x && x.ok ? x.r : null; };

// Коды целевых языков из shared.js расширения (HT_TARGET_LANGS): настройка targetLang с другим кодом молча
// отвергается — перевод остаётся на RU. shared.js — в node через vm, chrome.i18n — заглушка (подписи не нужны).
function targetLangs(extDir) {
  const vm = require("vm");
  const ctx = { chrome: { i18n: { getMessage: () => "", getUILanguage: () => "ru" } }, console, Intl };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(extDir, "shared.js"), "utf8"), ctx, { filename: "shared.js" });
  return vm.runInContext("HT_TARGET_LANGS.map((r) => r[0])", ctx);
}

// ---------- страница: CDP-сеанс, проверки без жеста, ошибки консоли ----------
// В выражения для ev() подмешиваются помощники: dq(sel) — первый элемент по селектору и в открытых shadow
// root (селектор «A >>> B» — B в теневом корне элемента A), dqa(sel) — все такие, vis(el) — элемент виден.
const HELPERS = `
  const __roots = (root, out) => { out.push(root); for (const e of root.querySelectorAll("*")) if (e.shadowRoot) __roots(e.shadowRoot, out); return out; };
  const dqa = (sel, root) => {
    const parts = String(sel).split(/\\s*>>>\\s*/);
    let scope = [root || document];
    for (let i = 0; i < parts.length; i++) {
      const next = [];
      for (const s of scope) {
        const base = i === 0 ? s : (s.shadowRoot || s);
        for (const r of (i === 0 ? __roots(base, []) : [base])) next.push(...r.querySelectorAll(parts[i]));
      }
      scope = next;
    }
    return scope;
  };
  const dq = (sel, root) => dqa(sel, root)[0] || null;
  const vis = (e) => { if (!e || !e.isConnected) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05; };
  const deepHit = (x, y) => { let h = document.elementFromPoint(x, y); while (h && h.shadowRoot) { const d = h.shadowRoot.elementFromPoint(x, y); if (!d || d === h) break; h = d; } return h; };
  const desc = (e) => !e ? "null" : e.nodeType !== 1 ? "#text" : e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.getAttribute("data-ht-ui") ? "[data-ht-ui]" : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const within = (a, b) => { for (let e = a; e; e = e.parentNode || e.host) if (e === b) return true; return false; };
`;

async function pageKit(ctx, page, sink) {
  const cdp = await ctx.newCDPSession(page);
  const phase = () => sink.phase || "";
  const frames = (st) => (st && st.callFrames || []).slice(0, 6).map((f) => `${f.functionName || "?"}@${f.url}:${f.lineNumber + 1}`);
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
    const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "";
    sink.list.push({ kind: "exception", phase: phase(), text: String(text).slice(0, 600), url: d.url || "", stack: frames(d.stackTrace) });
  });
  cdp.on("Runtime.consoleAPICalled", (e) => {
    // run.js --trace-lang: язык каждого куска из отладочной копии content.js (console.debug("[ht-lang]", json)).
    if (e.type === "debug" && e.args[0] && e.args[0].value === "[ht-lang]") {
      try { (sink.trace = sink.trace || []).push(Object.assign({ phase: phase() }, JSON.parse(e.args[1].value))); } catch (x) { /* не наш формат */ }
      return;
    }
    if (e.type !== "error" && e.type !== "assert") return;
    const text = e.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
    sink.list.push({ kind: "console", phase: phase(), text: text.slice(0, 600), url: "", stack: frames(e.stackTrace) });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.level !== "error") return;
    sink.list.push({ kind: "log:" + entry.source, phase: phase(), text: String(entry.text).slice(0, 600), url: entry.url || "", stack: frames(entry.stackTrace) });
  });
  // Миры фреймов этой страницы (frameId → contextId): для проверок внутри iframe без «действия пользователя».
  const contexts = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.auxData && c.auxData.isDefault && c.auxData.frameId) contexts.set(c.auxData.frameId, c.id);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId: id }) => {
    for (const [f, c] of contexts) if (c === id) contexts.delete(f);
  });
  cdp.on("Runtime.executionContextsCleared", () => contexts.clear());
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  // Выражение или функция (fn(arg)) в главном мире страницы, без «действия пользователя».
  async function ev(fn, arg) {
    const body = typeof fn === "function" ? `(${fn})(${JSON.stringify(arg === undefined ? null : arg)})` : `(async () => { ${fn} })()`;
    const expression = `(async () => { ${HELPERS}; return await ${body}; })()`;
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false, timeout: 15000 });
    if (r.exceptionDetails) throw new Error("ev: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split("\n")[0]);
    return r.result.value;
  }
  // То же во фрейме, чей адрес подходит под urlRe (баннеры согласия в iframe). Фрейм того же процесса — через мир
  // фрейма в этом сеансе; фрейм в своём процессе (OOPIF) — через отдельный CDP-сеанс Playwright. Тоже без жеста.
  // Помощники dq/dqa/vis доступны. → значение или исключение «нет фрейма».
  async function evFrame(urlRe, fn, arg) {
    const expression = `(async () => { ${HELPERS}; return await (${fn})(${JSON.stringify(arg === undefined ? null : arg)}); })()`;
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const flat = [];
    const walk = (t) => { flat.push(t.frame); for (const c of t.childFrames || []) walk(c); };
    walk(frameTree);
    const f = flat.find((x) => urlRe.test(x.url || ""));
    let r;
    if (f && contexts.has(f.id)) {
      r = await cdp.send("Runtime.evaluate", { expression, contextId: contexts.get(f.id), awaitPromise: true, returnByValue: true, userGesture: false, timeout: 15000 });
    } else {
      const pf = page.frames().find((x) => urlRe.test(x.url()));
      if (!pf) throw new Error("нет фрейма " + urlRe);
      const s = await ctx.newCDPSession(pf);
      try {
        r = await s.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false, timeout: 15000 });
      } finally { await s.detach().catch(() => {}); }
    }
    if (r.exceptionDetails) throw new Error("evFrame: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split("\n")[0]);
    return r.result.value;
  }
  async function until(fn, arg, ms = 10000, step = 250) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await ev(fn, arg); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) return v;
      await sleep(step);
    }
  }
  async function shot(file) {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }
  // Точка для щелчка по элементу: прокрутить в середину, проверить, что в этой точке именно он
  // (не перекрыт шапкой сайта или нашим интерфейсом). → { x, y, hit, covered, ours } или null.
  async function pointOf(sel, { scroll = true, at = "center" } = {}) {
    return ev(([s, sc, a]) => {
      const all = typeof s === "string" ? dqa(s) : [];
      const el = all.find(vis) || all[0];   // первый видимый (у сайтов бывают копии для телефона)
      if (!el) return null;
      if (sc) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { hidden: true };
      const pts = a === "center" ? [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]] : [[0.15, 0.5], [0.5, 0.5]];
      let first = null;
      for (const [fx, fy] of pts) {
        const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = deepHit(x, y);
        const ok = hit && (within(hit, el) || within(el, hit) && hit !== document.body && hit !== document.documentElement);
        const res = { x, y, hit: desc(hit), ok: !!ok, ours: !!(hit && hit.closest && hit.closest("[data-ht-ui]")) };
        if (ok) return res;
        if (!first) first = res;
      }
      return first || { offscreen: true };
    }, [sel, scroll, at]);
  }
  // Настоящий щелчок по элементу. → { ok, note }
  async function click(sel, opts = {}) {
    let p = await pointOf(sel, opts);
    if (!p) { await sleep(800); p = await pointOf(sel, opts); }
    if (!p) return { ok: false, note: "нет элемента " + sel };
    if (p.hidden || p.offscreen) return { ok: false, note: "элемент не виден: " + sel };
    await sleep(150);
    await page.mouse.click(p.x, p.y);
    return { ok: true, covered: !p.ok, ours: p.ours, hit: p.hit, note: p.ok ? "" : (p.ours ? "перекрыт НАШИМ интерфейсом" : "в точке щелчка другой элемент: " + p.hit) };
  }
  const text = (sel) => ev((s) => { const e = dq(s); return e ? (e.innerText || e.textContent || "").trim() : null; }, sel);
  const visible = (sel) => ev((s) => vis(dq(s)), sel);
  const title = () => ev("return document.title");
  const url = () => page.url();
  // Наш интерфейс на странице (закрытый shadow root) — через tests/lib/live.js.
  const tab = { cmd: (m, p) => cdp.send(m, p), click: (x, y) => page.mouse.click(x, y) };
  return { page, cdp, ev, evFrame, until, shot, pointOf, click, text, visible, title, url, tab };
}

const isOurs = (e) => /chrome-extension:\/\//.test(e.url + " " + e.stack.join(" ") + " " + e.text);
// Ключ для сравнения с прогоном без расширения: без чисел, хэшей, параметров адресов.
function errKey(e) {
  const t = (e.text || "").split("\n")[0]
    .replace(/https?:\/\/([^/\s?#]+)[^\s)'"]*/g, "$1")
    .replace(/chrome-extension:\/\/[a-p]{32}/g, "ext")
    .replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+/g, "N").replace(/\s+/g, " ").trim();
  return e.kind + " " + t.slice(0, 160);
}

async function gotoSettled(page, url, ms = 2500) {
  let status = null, err = null;
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = r ? r.status() : null;
  } catch (e) { err = e.message.split("\n")[0]; }
  await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
  await sleep(ms);
  return { status, err };
}

// Точка над текстом элемента (для наведения): первый текстовый узел с буквами, который виден в этой точке.
// Текст везде перекрыт (ссылка-накладка на всю карточку новости) — первая точка над текстом с covered: что
// сверху; человек наводит туда же, и Shift должен перевести то, что он видит.
async function textPoint(k, sel) {
  return k.ev((s) => {
    const root = dq(s);
    if (!root) return null;
    root.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/\p{L}{2}/u.test(n.nodeValue) ? 1 : 3) });
    let first = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) {
        if (b.width < 6 || b.height < 6) continue;
        const x = Math.round(b.left + Math.min(b.width / 2, 24)), y = Math.round(b.top + b.height / 2);
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = deepHit(x, y);
        if (hit && (within(hit, n.parentElement) || within(n.parentElement, hit))) return { x, y };
        if (!first) first = { x, y, covered: desc(hit) };
      }
    }
    return first;
  }, sel);
}

// Наведение и короткое нажатие Shift (режим по умолчанию): настоящие события мыши и клавиатуры.
async function shiftAt(page, pt) {
  await page.bringToFront();
  await page.mouse.move(pt.x - 6, pt.y);
  await sleep(60);
  await page.mouse.move(pt.x, pt.y, { steps: 3 });
  await sleep(150);
  await page.keyboard.down("Shift");
  await sleep(60);
  await page.keyboard.up("Shift");
}

// Доля кириллицы (cyr) или латиницы (lat) среди букв.
function scriptShare(text, script) {
  const letters = (String(text).match(/\p{L}/gu) || []).length;
  if (!letters) return 0;
  const re = script === "cyr" ? /\p{Script=Cyrillic}/gu : /\p{Script=Latin}/gu;
  return (String(text).match(re) || []).length / letters;
}

// ---------- тексты, которые сайт меняет сам после перевода ----------
// Перед действиями после перевода страницы — MutationObserver в мире страницы: какие текстовые узлы сайт
// изменил или добавил. После возврата оригинала сверяем: у живых узлов должен остаться текст сайта.
// Запись узла: pre — текст до первого изменения (oldValue; у добавленного узла null), first — текст при первой
// записи (у добавленного — то, что вписал сайт, до перевода: MutationObserver расширения ждёт ~300 мс), site —
// текст на момент MUT_FREEZE (в новом содержимом это уже может быть наш перевод).
const MUT_START = () => {
  const st = { nodes: new Map(), obs: null };
  const add = (n, old) => { if (n.nodeType === 3 && /\p{L}/u.test(n.nodeValue || "") && !st.nodes.has(n)) st.nodes.set(n, { pre: old, first: n.nodeValue }); };
  st.obs = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === "characterData") add(r.target, r.oldValue);
      else for (const a of r.addedNodes) {
        if (a.nodeType === 3) add(a, null);
        else if (a.nodeType === 1) { const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) add(n, null); }
      }
    }
  });
  st.obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  window.__htSites = st;
  return true;
};
const MUT_FREEZE = () => {
  const st = window.__htSites;
  if (!st) return 0;
  st.obs.disconnect();
  for (const [n, rec] of st.nodes) rec.site = n.nodeValue;
  return st.nodes.size;
};
const MUT_CHECK = () => {
  const st = window.__htSites;
  if (!st) return null;
  const out = { total: st.nodes.size, alive: 0, kept: 0, reverted: 0, changedCount: 0, changed: [] };
  const cyr = (t) => /\p{Script=Cyrillic}/u.test(t);
  for (const [n, rec] of st.nodes) {
    if (!n.isConnected) continue;
    out.alive++;
    const now = n.nodeValue;
    if (now === rec.site) { out.kept++; continue; }
    // Откат нашего перевода — не затирание: к MUT_FREEZE в узле был наш перевод (сайт вписал текст или узел после
    // перевода страницы, MutationObserver расширения его перевёл), после Esc — снова текст сайта (pre — до
    // изменения, first — вписанный сайтом). Что в site был именно перевод, а не новый текст сайта, — по смене
    // письменности, как в RESID (цели сайтов — RU или EN): иначе Esc, вернувший устаревший текст поверх нового
    // текста сайта, тоже сошёл бы за откат.
    if ((now === rec.pre || now === rec.first) && cyr(now) !== cyr(rec.site)) { out.reverted++; continue; }
    out.changedCount++;
    if (out.changed.length < 12) out.changed.push({ pre: rec.pre && rec.pre.slice(0, 80), first: rec.first.slice(0, 80), site: rec.site.slice(0, 80), now: now.slice(0, 80), parent: n.parentElement && n.parentElement.tagName });
  }
  delete window.__htSites;
  return out;
};

// ---------- перевод, оставшийся после «Показать оригинал» ----------
// Снимок всех текстовых узлов до перевода; после Esc — узлы, чей текст сменил письменность (en → ru: появилась
// кириллица; ru → en: кириллица пропала, есть латиница). Свои изменения сайта (время, счётчики) письменность
// почти никогда не меняют, поэтому это почти наверняка наш перевод, который откат не вернул.
const SNAP = (tgt) => {
  const list = [], m = new WeakMap();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/\p{L}/u.test(n.nodeValue)) { list.push(n); m.set(n, n.nodeValue); }
  window.__htSnap = { list, m, tgt };
  return list.length;
};
const RESID = () => {
  const s = window.__htSnap;
  if (!s) return null;
  const cyr = /\p{Script=Cyrillic}/u, lat = /\p{Script=Latin}/u;
  const out = { count: 0, examples: [] };
  for (const n of s.list) {
    if (!n.isConnected) continue;
    const was = s.m.get(n), now = n.nodeValue;
    if (was === now) continue;
    const flipped = s.tgt === "RU" ? cyr.test(now) && !cyr.test(was) : cyr.test(was) && !cyr.test(now) && lat.test(now);
    if (!flipped) continue;
    out.count++;
    const p = n.parentElement;
    if (out.examples.length < 10) out.examples.push(`${desc(p)} < ${desc(p && p.parentElement)}: «${was.trim().slice(0, 40)}» → «${now.trim().slice(0, 40)}»`);
  }
  return out;
};
// ---------- видимый текст ----------
// Текст, который сейчас на экране (в окне): текстовые узлы с буквами, чей прямоугольник хоть краем в окне, у
// видимого родителя; без нашего интерфейса. sel — только внутри него (по умолчанию вся страница). До ~4000 знаков.
// По нему считаем долю перевода: «Перевести страницу» переводит видимое, а первые 4000 знаков основного текста
// могут быть вне экрана (MDN).
const VIS_TEXT = (sel) => {
  const root = sel ? dq(sel) : document.body;
  if (!root) return "";
  const out = [];
  let len = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/\p{L}/u.test(n.nodeValue) ? 1 : 3) });
  for (let n = w.nextNode(); n && len < 4000; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest("[data-ht-ui], script, style, noscript, template")) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
    if (p.checkVisibility && !p.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    out.push(n.nodeValue);
    len += n.nodeValue.length;
  }
  return out.join(" ");
};

// ---------- что content.js считает «открытым у сайта» (Esc — только сайту) ----------
// Повторяет siteOpen() из content.js (escRestore): модальное окно, поповер, видимое role=dialog/aria-modal, или
// видимый aria-expanded=true у всплывающего (aria-haspopup, либо то, чем он управляет, — меню/список/окно или
// absolute/fixed). → список таких элементов (пустой — Esc вне поля вернёт оригинал). Для разбора «Esc не откатил».
const SITE_OPEN = () => {
  const onScreen = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const ours = (el) => !!el.closest("[data-ht-ui]");
  const popup = (el) => {
    const hp = el.getAttribute("aria-haspopup");
    if (hp && hp !== "false") return "aria-haspopup=" + hp;
    const ids = (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
    const targets = ids.length ? ids.map((id) => document.getElementById(id)) : [el.nextElementSibling];
    for (const t of targets) {
      if (!t || ours(t) || !onScreen(t)) continue;
      const role = t.getAttribute("role") || "";
      if (/^(menu|menubar|listbox|dialog)$/.test(role)) return "управляет role=" + role + " " + desc(t);
      const pos = getComputedStyle(t).position;
      if (pos === "absolute" || pos === "fixed") return "управляет " + pos + " " + desc(t);
    }
    return "";
  };
  const sels = [":modal", ":popover-open", "[role=dialog]", "[role=alertdialog]", "[aria-modal=true]"]
    .filter((s) => { try { return CSS.supports("selector(" + s + ")"); } catch (e) { return false; } }).join(",");
  const out = [];
  if (sels) for (const el of document.querySelectorAll(sels)) if (!ours(el) && onScreen(el)) out.push(desc(el) + " (окно)");
  for (const el of document.querySelectorAll('[aria-expanded="true"]')) {
    if (ours(el) || !onScreen(el)) continue;
    const why = popup(el);
    if (why) out.push(desc(el) + " (aria-expanded, " + why + ")");
  }
  return out.slice(0, 8);
};

// Вложенные «владельцы» при переводе страницы: content.js (collectCandidates → isTopInlineContainer) берёт
// каждый элемент без блочных детей, чей родитель блочных детей имеет. В разметке <li><a><div>текст</div></a></li>
// подходят и li (его ребёнок <a> строчный), и div — до ea882e9 оба переводили один и тот же текстовый узел, и откат
// терял его (теперь вложенный пропускается). Считаем такие пары той же логикой (без проверок языка): где это
// встречается и, значит, где смотреть остатки перевода после Esc (RESID).
const NESTED = () => {
  const BLOCK = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
    "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
  const SKIP = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "PRE", "CODE", "NOSCRIPT", "SVG", "CANVAS", "IMG", "VIDEO", "AUDIO"]);
  const hb = (el) => { for (const c of el.children) if (BLOCK.has(c.tagName)) return true; return false; };
  const cands = new Set();
  for (const el of document.body.querySelectorAll("*")) {
    if (hb(el)) continue;
    const p = el.parentElement;
    if (!(!p || p.tagName === "BODY" || p.tagName === "HTML" || hb(p))) continue;
    if (SKIP.has(el.tagName) || el.isContentEditable || el.hasAttribute("data-ht-ui")) continue;
    const t = (el.textContent || "").trim();
    if (t.length < 2 || t.length > 2000 || !/\p{L}/u.test(t)) continue;
    cands.add(el);
  }
  let nested = 0;
  const ex = [];
  for (const el of cands) {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (cands.has(a)) { nested++; if (ex.length < 4) ex.push(`${desc(a)} ⊃ ${desc(el)}: «${el.textContent.trim().slice(0, 30)}»`); break; }
    }
  }
  return { candidates: cands.size, nested, examples: ex };
};

module.exports = {
  ROOT, EXT_SRC, sleep, loadPlaywright, launchChrome, worker, swEval, storage, tabIdOf, tabSend, tabState, targetLangs, pageKit,
  isOurs, errKey, gotoSettled, textPoint, shiftAt, scriptShare, MUT_START, MUT_FREEZE, MUT_CHECK, SNAP, RESID, NESTED, VIS_TEXT,
  SITE_OPEN, VIEWPORT,
};
