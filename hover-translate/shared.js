// shared.js — ЕДИНСТВЕННОЕ место для данных и мелких хелперов, нужных сразу нескольким
// контекстам расширения. Подключается во все три: content_scripts (перед content.js),
// service worker (importScripts) и popup.html (перед popup.js).
//
// Сборки у расширения нет, три контекста изолированы и общаются сообщениями, поэтому любой
// общий факт живёт либо здесь, либо в трёх копиях. Копии уже расходились: у исходного языка
// «PT» не было английского имени и в промпт LLM уходило «into PT»; список движков лежал
// в popup.html, а знание об их поведении — в четырёх if-ах в двух файлах.

// ---- языки ----

// Целевые языки — коды DeepL target_lang (с региональными вариантами).
var HT_TARGET_LANGS = [
  ["RU", "Русский"],
  ["EN-US", "English (US)"],
  ["EN-GB", "English (UK)"],
  ["DE", "Deutsch"],
  ["FR", "Français"],
  ["ES", "Español"],
  ["IT", "Italiano"],
  ["PT-PT", "Português"],
  ["PT-BR", "Português (BR)"],
  ["NL", "Nederlands"],
  ["PL", "Polski"],
  ["UK", "Українська"],
  ["TR", "Türkçe"],
  ["ZH", "中文"],
  ["JA", "日本語"],
  ["KO", "한국어"],
];

// Исходные языки — коды DeepL source_lang (без региональных вариантов) плюс автоопределение.
var HT_SOURCE_LANGS = [
  ["auto", "Определять автоматически"],
  ["EN", "English"],
  ["RU", "Русский"],
  ["DE", "Deutsch"],
  ["FR", "Français"],
  ["ES", "Español"],
  ["IT", "Italiano"],
  ["PT", "Português"],
  ["NL", "Nederlands"],
  ["PL", "Polski"],
  ["UK", "Українська"],
  ["TR", "Türkçe"],
  ["ZH", "中文"],
  ["JA", "日本語"],
  ["KO", "한국어"],
];

// Английские имена для системного промпта LLM. Нужны для КАЖДОГО кода из обоих списков выше —
// иначе в промпт уходит сам код и модель угадывает язык по нему.
var HT_LANG_NAMES = {
  RU: "Russian",
  EN: "English", "EN-US": "English (US)", "EN-GB": "English (UK)",
  DE: "German",
  FR: "French",
  ES: "Spanish",
  IT: "Italian",
  PT: "Portuguese", "PT-PT": "Portuguese", "PT-BR": "Brazilian Portuguese",
  NL: "Dutch",
  PL: "Polish",
  UK: "Ukrainian",
  TR: "Turkish",
  ZH: "Chinese",
  JA: "Japanese",
  KO: "Korean",
};

// Базовый код языка: "EN-US" → "en". Сравнение языков идёт только по базе.
function HT_langBase(code) { return String(code || "").split("-")[0].toLowerCase(); }

// ---- движки ----
// Поведение движка описано данными, а не if-ами по имени. Поля:
//   via        — куда уходит запрос: "deepl" | "llm" (через background) либо "local" (on-device);
//   keyField   — ключ настроек с API-ключом (нет — движку ключ не нужен);
//   cacheAs    — под каким именем движка кэшировать (alias: auto даёт тот же результат, что deepl);
//   scopeFields— какие ещё поля запроса входят в ключ кэша (для LLM — провайдер/модель/origin);
//   fallback   — на что переключиться, если основной путь не смог;
//   formality  — поддерживает ли параметр «тон»;
//   note       — показывать ли в popup пояснение про встроенный движок.
var HT_ENGINES = [
  ["deepl", "DeepL",
    { via: "deepl", keyField: "apiKey", formality: true }],
  ["auto", "DeepL → встроенный (фолбэк)",
    { via: "deepl", keyField: "apiKey", formality: true, cacheAs: "deepl", fallback: "local", note: true }],
  ["chrome", "Встроенный Chrome (on-device, приватно)",
    { via: "local", note: true }],
  ["llm", "LLM (OpenAI / Anthropic) — контекстный",
    { via: "llm", keyField: "llmApiKey", scopeFields: ["llmProvider", "llmModel", "origin"] }],
];

// Что показать, если ключа нет. Ключуем ПОЛЕМ настроек, а не движком: deepl и auto делят один
// ключ, и одинаковая подсказка иначе лежала бы в таблице дважды.
var HT_KEY_HINTS = {
  apiKey: "Не задан API-ключ DeepL — откройте popup расширения и вставьте ключ.",
  llmApiKey: "Не задан API-ключ LLM — откройте popup расширения.",
};

var HT_ENGINE = {};
for (var i = 0; i < HT_ENGINES.length; i++) {
  HT_ENGINE[HT_ENGINES[i][0]] = Object.assign({ code: HT_ENGINES[i][0], label: HT_ENGINES[i][1] }, HT_ENGINES[i][2]);
}

// Неизвестное значение настройки трактуем как движок по умолчанию. Только собственные ключи
// таблицы: HT_ENGINE["constructor"] иначе вернул бы функцию Object вместо описания движка.
function HT_engine(code) {
  return Object.prototype.hasOwnProperty.call(HT_ENGINE, code) ? HT_ENGINE[code] : HT_ENGINE.deepl;
}

// ---- кто инициировал перевод ----
// От этого зависит бюджет расхода в background: страница может инициировать перевод САМА, просто
// подсовывая новый текст под курсор, — такому потоку нужен строгий лимит. Пользователь
// инициирует перевод только явным действием (кнопка, смена языка), там лимит щедрый.
// Имена лежат здесь, а не литералами на местах, чтобы обе стороны сообщения ссылались на одно.
var HT_BY_PAGE = "page-initiated";
var HT_BY_USER = "user-initiated";

// ---- настройки ----
// Значения по умолчанию, общие для content.js и popup.js (background берёт отсюда же свой срез).
// Раньше эти 18 пар лежали двумя посимвольно совпадающими копиями, и добавление настройки
// требовало правки в обеих.
var HT_DEFAULTS = {
  enabled: true, targetLang: "RU", sourceLang: "auto", dwellMs: 250, trigger: "dwell", engine: "deepl",
  displayMode: "replace", showLangBadge: true, formality: "default", noTranslate: "",
  // llmProvider/llmModel сам content не использует (их читает background), но держит в DEFAULTS,
  // чтобы их смена тоже триггерила живое перетранслирование уже показанных переводов.
  llmProvider: "openai", llmModel: "",
  dispMode: "auto", dispBg: "#0078d7", dispOpacity: 12,
  dispBorder: false, dispBorderColor: "#0078d7", dispBorderStyle: "solid",
};

// Допустимые значения настроек-перечислений. Хранилище общее для всех сайтов, а писать в него
// может не только popup (мини-панель живёт на странице), поэтому значение сверяется со списком
// при каждом чтении: неизвестное становится значением по умолчанию и не попадает ни в запрос
// к движку, ни в инструкцию для ИИ. Списки formality/llmProvider/displayMode/trigger обязаны
// совпадать с <option> в popup.html.
var HT_CHOICES = {
  targetLang: HT_TARGET_LANGS.map((r) => r[0]),
  sourceLang: HT_SOURCE_LANGS.map((r) => r[0]),
  engine: HT_ENGINES.map((r) => r[0]),
  formality: ["default", "more", "less"],
  llmProvider: ["openai", "anthropic"],
  displayMode: ["replace", "popover"],
  trigger: ["dwell", "shift", "alt", "ctrl"],
};
// Значение настройки k, сверенное со списком; у настроек без списка — как есть.
function HT_valid(k, v) {
  if (!Object.prototype.hasOwnProperty.call(HT_CHOICES, k)) return v;
  return HT_CHOICES[k].includes(v) ? v : HT_DEFAULTS[k];
}
// То же для всех перечислений, которые есть в объекте настроек (меняет и возвращает его).
function HT_validAll(s) {
  for (const k in HT_CHOICES) if (k in s) s[k] = HT_valid(k, s[k]);
  return s;
}

// Задержка наведения. Клэмп общий: popup пишет уже нормализованное значение, а content
// перепроверяет прочитанное — раньше две проверки расходились (в content не было верхней границы).
var HT_DWELL_MAX = 2000;
function HT_clampDwell(v) {
  // Пустое поле — это «не задано», а не 0: Number("") === 0, и стёртое поле «Задержка» иначе молча
  // включило бы перевод без задержки. Не `|| 250` — иначе валидный 0 стал бы 250.
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.max(0, Math.min(HT_DWELL_MAX, n)) : HT_DEFAULTS.dwellMs;
}

// ---- DOM ----
// Заполнить <select> парами [значение, подпись] (лишние элементы строк игнорируются, поэтому
// подходит и для HT_ENGINES). В service worker не вызывается — там нет document.
function HT_fillSelect(sel, rows) {
  sel.textContent = "";
  for (const row of rows) {
    const o = document.createElement("option");
    o.value = row[0];
    o.textContent = row[1];
    sel.appendChild(o);
  }
}
