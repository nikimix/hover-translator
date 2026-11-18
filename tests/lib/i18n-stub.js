// Заглушка chrome.i18n для проверок вне настоящего расширения: читает _locales/<язык>/messages.json и
// подставляет как Chrome — $name$ → content плейсхолдера, затем $1…$9 → подстановки, $$ → $. Ключи и имена
// плейсхолдеров — без учёта регистра. Неизвестный ключ — пустая строка (как в Chrome), но имя ключа
// запоминается в missing: проверки требуют, чтобы их не было.
const fs = require("fs");
const path = require("path");
const { EXT } = require("./env");

function load(lang) {
  const raw = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", lang, "messages.json"), "utf8"));
  const out = {};
  for (const k in raw) out[k.toLowerCase()] = raw[k];
  return out;
}

// Тело функции getMessage для вставки в страницу (без require) — та же логика.
const GET_MESSAGE_SRC = `function (M, missing, key, subs) {
  const m = M[String(key).toLowerCase()];
  if (!m) { missing.push(String(key)); return ""; }
  const ph = {};
  for (const k in m.placeholders || {}) ph[k.toLowerCase()] = m.placeholders[k].content;
  const list = subs == null ? [] : [].concat(subs);
  const fill = (s) => s.replace(/\\$(\\$|[1-9])/g, (all, d) => d === "$" ? "$" : (list[d - 1] === undefined ? "" : String(list[d - 1])));
  return fill(m.message.replace(/\\$([a-z0-9_@]+)\\$/gi, (all, n) => ph[n.toLowerCase()] !== undefined ? ph[n.toLowerCase()] : all));
}`;

function makeI18n(lang = "ru") {
  const M = load(lang);
  const missing = [];
  const get = eval("(" + GET_MESSAGE_SRC + ")");
  return {
    missing,
    getMessage: (key, subs) => get(M, missing, key, subs),
    getUILanguage: () => lang,
  };
}

// Скрипт для тестовых страниц (i18n-ru.js): ставит chrome.i18n поверх заглушки chrome.* страницы.
// Собирается из текущих сообщений при каждом запросе — отдельного файла в репозитории нет.
function pageScript(lang = "ru") {
  return `// создано tests/lib/i18n-stub.js из _locales/${lang}/messages.json
(function () {
  const M = ${JSON.stringify(load(lang))};
  const missing = window.__i18nMissing = [];
  const get = (${GET_MESSAGE_SRC});
  window.chrome = window.chrome || {};
  window.chrome.i18n = { getMessage: (k, s) => get(M, missing, k, s), getUILanguage: () => ${JSON.stringify(lang)} };
})();
`;
}

module.exports = { makeI18n, pageScript, load };
