// Пути и временные папки проверок. Ничего не пишется в репозиторий: профили Chrome, копии расширения
// и страницы для file:// — во временной папке системы (или в HT_TMP), скриншоты — только в HT_SHOTS.
//
// Переменные окружения (их выставляет tests/run.sh, но каждую проверку можно запустить и саму по себе):
//   HT_TMP     — где создавать временные папки (по умолчанию — системная временная папка);
//   HT_SHOTS   — куда сохранять скриншоты (без неё скриншоты не снимаются);
//   HT_PROFILE — профиль Chrome для живых проверок: в нём остаются скачанные языковые модели, поэтому
//                следующая живая проверка их не качает. Не задан — у каждой проверки свой новый профиль;
//   HT_PORT    — порт для тестовых страниц (по умолчанию — любой свободный).
const fs = require("fs");
const os = require("os");
const path = require("path");

const TESTS = path.resolve(__dirname, "..");
const ROOT = path.resolve(TESTS, "..");
const EXT = path.join(ROOT, "hover-translate");
const FIXTURES = path.join(TESTS, "fixtures");

// Имя набора для папки скриншотов: tests/live/popup.test.js → live-popup.
const SUITE = require.main && require.main.filename.startsWith(TESTS)
  ? path.relative(TESTS, require.main.filename).replace(/\.test\.js$/, "").replace(/[\\/]/g, "-")
  : "tests";

// Новая временная папка; убирает её тот, кто создал (обычно — close() браузера), а tests/run.sh в конце
// прогона удаляет и всю свою папку целиком — на случай, если проверка упала посреди работы.
function tmpDir(prefix) {
  const base = process.env.HT_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "ht-" + prefix + "-"));
}

function rmDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

// Путь для скриншота или null, если скриншоты не нужны.
function shotPath(name) {
  const dir = process.env.HT_SHOTS;
  if (!dir) return null;
  const out = path.join(path.resolve(dir), SUITE);
  fs.mkdirSync(out, { recursive: true });
  return path.join(out, path.basename(name));
}

module.exports = { TESTS, ROOT, EXT, FIXTURES, SUITE, tmpDir, rmDir, shotPath };
