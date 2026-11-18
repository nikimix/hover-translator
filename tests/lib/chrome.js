// Chrome без интерфейса, управление по CDP через pipe (--remote-debugging-pipe): только в этом режиме
// работает Extensions.loadUnpacked — флаг --load-extension фирменный Chrome с версии 137 не принимает.
// Без лишних портов: несколько проверок подряд не мешают друг другу.
//
// Где Chrome: переменная CHROME_PATH, иначе первый из google-chrome, google-chrome-stable, chromium,
// chromium-browser в PATH, иначе обычное место на macOS.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { EXT, FIXTURES, tmpDir, rmDir, shotPath } = require("./env");
const { pageScript } = require("./i18n-stub");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ждать, пока fn вернёт истинное значение (не дольше ms); возвращает последнее значение.
const until = async (fn, ms = 10000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};

function canRun(f) {
  try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch (e) { return false; }
}
let chromePath = null;
function findChrome() {
  if (chromePath) return chromePath;
  const env = process.env.CHROME_PATH;
  if (env) {
    if (!canRun(env)) throw new Error(`CHROME_PATH=${env}: такого файла нет или его нельзя запустить`);
    return (chromePath = env);
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const n of names) if (dir && canRun(path.join(dir, n))) return (chromePath = path.join(dir, n));
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (canRun(mac)) return (chromePath = mac);
  throw new Error("Chrome не найден: укажите путь в CHROME_PATH или поставьте google-chrome / chromium в PATH");
}
// «Google Chrome 157.0.8103.38» → { text, major: 157 }.
function chromeVersion() {
  const text = execFileSync(findChrome(), ["--version"], { encoding: "utf8" }).trim();
  const m = text.match(/(\d+)\.\d+\.\d+/);
  return { text, major: m ? Number(m[1]) : 0 };
}

// Язык интерфейса Chrome (и chrome.i18n расширения) на Linux берётся из переменных окружения, --lang там
// не действует. По умолчанию — русский: большинство проверок сверяет русские тексты.
const LANG_ENV = {
  ru: { LANG: "ru_RU.UTF-8", LANGUAGE: "ru", LC_ALL: "ru_RU.UTF-8" },
  en: { LANG: "en_US.UTF-8", LANGUAGE: "en_US", LC_ALL: "en_US.UTF-8" },
};

// profile — папка профиля, которую нужно сохранить (живые проверки: скачанные языковые модели остаются
// в ней, см. HT_PROFILE в env.js); без неё — новый временный профиль, удаляется в close().
async function launch({ lang = "ru", extraArgs = [], env = null, profile = null } = {}) {
  const temp = [];                        // что удалить в close(): временный профиль, копии расширения
  const userDir = profile || tmpDir("profile");
  if (!profile) temp.push(userDir);
  fs.mkdirSync(userDir, { recursive: true });
  const chrome = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${userDir}`, "--no-first-run", "--no-default-browser-check",
    `--lang=${lang}`, `--accept-lang=${lang}`, "--window-size=1100,900", ...extraArgs, "about:blank",
  ], { stdio: ["ignore", "ignore", process.env.HT_DEBUG ? "inherit" : "ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, LANG_ENV[lang] || {}, env || {}) });
  let exited = false;
  chrome.on("exit", () => { exited = true; });
  const out = chrome.stdio[3], inp = chrome.stdio[4];
  let buf = "", id = 0;
  const pending = new Map();
  const listeners = [];
  inp.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else for (const l of listeners) l(m);
    }
  });
  // Chrome не запустился или упал — ждущие команды не должны висеть вечно.
  inp.on("close", () => {
    for (const [, done] of pending) done({ error: { message: "Chrome закрылся" } });
    pending.clear();
  });
  out.on("error", () => {});
  const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (exited) { reject(new Error(method + ": Chrome закрылся")); return; }
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
    const msg = { id: i, method, params };
    if (sessionId) msg.sessionId = sessionId;
    out.write(JSON.stringify(msg) + "\0");
  });
  const contexts = [];
  listeners.push((m) => {
    if (m.method === "Runtime.executionContextCreated") contexts.push(Object.assign({ session: m.sessionId }, m.params.context));
    if (m.method === "Runtime.executionContextDestroyed") {
      const k = contexts.findIndex((c) => c.id === m.params.executionContextId && c.session === m.sessionId);
      if (k >= 0) contexts.splice(k, 1);
    }
  });
  // Открыть вкладку и подключиться к ней.
  async function openTab(url) {
    const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
    return attach(targetId, url);
  }
  async function attach(targetId, url) {
    const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
    await cmd("Page.enable", {}, sessionId).catch(() => {});
    await cmd("Runtime.enable", {}, sessionId);
    if (url) await cmd("Page.navigate", { url }, sessionId);
    const ev = async (expr, contextId) => {
      const p = { expression: expr, returnByValue: true, awaitPromise: true };
      if (contextId) p.contextId = contextId;
      const r = await cmd("Runtime.evaluate", p, sessionId);
      if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    };
    const isolated = () => contexts.filter((c) => c.session === sessionId && c.auxData && c.auxData.type === "isolated");
    const mainCtx = () => contexts.find((c) => c.session === sessionId && c.auxData && c.auxData.isDefault && c.auxData.frameId === targetId);
    // Скриншот — только если задана папка (HT_SHOTS); иначе ничего не снимаем. name — имя файла.
    const shot = async (name, opts = {}) => {
      const file = shotPath(name);
      if (!file) return null;
      const r = await cmd("Page.captureScreenshot", Object.assign({ format: "png" }, opts), sessionId);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    };
    const mouse = (type, x, y, extra = {}) => cmd("Input.dispatchMouseEvent", Object.assign({ type, x, y }, extra), sessionId);
    const click = async (x, y) => {
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
    };
    const key = (type, key, code, modifiers, vk) => cmd("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: vk }, sessionId);
    return { targetId, sessionId, ev, isolated, mainCtx, shot, mouse, click, key, cmd: (m, p) => cmd(m, p, sessionId) };
  }
  // Копия расширения в новой временной папке: новый путь — новое расширение (новая установка). Chrome
  // при загрузке по прежнему пути с той же версией оставлял старый service worker и проверялся бы
  // прежний background.js; к тому же в копию проверки дописывают свои крючки. Удаляется в close():
  // в общем профиле (HT_PROFILE) иначе при следующем запуске поднялись бы сразу два расширения.
  function copyExt() {
    const dst = tmpDir("ext");
    temp.push(dst);
    fs.cpSync(EXT, dst, { recursive: true });
    return dst;
  }
  async function close() {
    if (!exited) {
      chrome.kill("SIGTERM");
      await until(() => exited, 5000, 100);
      if (!exited) chrome.kill("SIGKILL");
    }
    await sleep(200);
    for (const d of temp.splice(0)) rmDir(d);
  }
  return { cmd, listeners, contexts, openTab, attach, close, copyExt, profile: userDir };
}

// Тестовая страница для file:// (у такой страницы нет имени сайта): страница из fixtures/ и заглушка
// chrome.i18n (i18n-ru.js) — во временной папке, скрипты расширения — по абсолютному адресу.
// Возвращает { url, dir }; dir удаляет вызывающий.
function filePage(name) {
  const dir = tmpDir("page");
  const html = fs.readFileSync(path.join(FIXTURES, name), "utf8")
    .replaceAll("../../hover-translate/", pathToFileURL(EXT).href + "/");
  fs.writeFileSync(path.join(dir, name), html);
  fs.writeFileSync(path.join(dir, "i18n-ru.js"), pageScript("ru"));
  return { url: pathToFileURL(path.join(dir, name)).href, dir };
}

module.exports = { launch, filePage, findChrome, chromeVersion, sleep, until };

// node tests/lib/chrome.js — какой Chrome будет запущен (для tests/run.sh).
if (require.main === module) {
  try {
    const v = chromeVersion();
    console.log(`${v.major}\t${findChrome()}\t${v.text}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
