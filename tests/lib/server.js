// Сервер тестовых страниц. Поднимается внутри проверки и гасится ею же (srv.close()), поэтому любую
// проверку можно запустить и саму по себе. Порт — любой свободный; HT_PORT задаёт определённый.
//
//   /src/…       — файлы расширения (hover-translate/): страницы с заглушкой chrome.* подключают
//                  shared.js, content.js и content.css как content-скрипт;
//   /i18n-ru.js  — заглушка chrome.i18n с текстами _locales/ru (i18n-stub.js), собирается на лету;
//   /old/…       — content.js и shared.js до исправления петли на краю текста (из истории git, коммит
//                  OLD_COMMIT): на нём проверка показывает, что петля воспроизводится. Нет истории — 404;
//   остальное    — tests/fixtures/.
//
// Встроенным окнам «с другого сайта» нужен второй адрес того же сервера: base — http://127.0.0.1:порт,
// other — http://localhost:порт.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT, EXT, FIXTURES } = require("./env");
const { pageScript } = require("./i18n-stub");

const OLD_COMMIT = "463430c";   // «Этап 2а» — последний код до исправления петли
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

const oldCache = new Map();
function oldFile(name) {
  if (!oldCache.has(name)) {
    let src = null;
    try {
      src = execFileSync("git", ["-C", ROOT, "show", `${OLD_COMMIT}:hover-translate/${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { /* нет git или истории (архив, неполный клон) */ }
    oldCache.set(name, src);
  }
  return oldCache.get(name);
}

// Файл внутри base или null (запрос вида /../ наружу не выпускаем).
function inside(base, rel) {
  const f = path.resolve(base, "." + path.posix.normalize("/" + rel));
  return f.startsWith(base + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

function serve({ port = Number(process.env.HT_PORT) || 0 } = {}) {
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const send = (status, body, type) => {
      res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    };
    if (url === "/i18n-ru.js") return send(200, pageScript("ru"), TYPES[".js"]);
    if (url.startsWith("/old/")) {
      const name = url.slice(5);
      const src = /^(content|shared)\.js$/.test(name) ? oldFile(name) : null;
      return src == null ? send(404, "no git history") : send(200, src, TYPES[".js"]);
    }
    const f = url.startsWith("/src/") ? inside(EXT, url.slice(4)) : inside(FIXTURES, url);
    if (!f) return send(404, "not found");
    send(200, fs.readFileSync(f), TYPES[path.extname(f)] || "application/octet-stream");
  });
  return new Promise((resolve, reject) => {
    srv.once("error", (e) => {
      reject(e.code === "EADDRINUSE"
        ? new Error(`порт ${port} для тестовых страниц занят: освободите его или не задавайте HT_PORT — тогда возьмётся свободный`)
        : e);
    });
    srv.listen(port, "127.0.0.1", () => {
      const p = srv.address().port;
      resolve({
        port: p,
        base: `http://127.0.0.1:${p}`,
        other: `http://localhost:${p}`,
        hasOld: () => oldFile("content.js") != null && oldFile("shared.js") != null,
        close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
      });
    });
  });
}

module.exports = { serve };
