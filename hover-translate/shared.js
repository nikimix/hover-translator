// shared.js — ЕДИНСТВЕННОЕ место для данных и мелких хелперов, нужных сразу нескольким
// контекстам расширения. Подключается везде: content_scripts (перед content.js), service worker
// (importScripts), popup.html и welcome.html (первым скриптом).
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

// Название языка по-русски для подсказок: "en" → «английский». Через Intl, а не таблицей: детектор
// языка возвращает и коды, которых в таблицах нет.
var HT_langNames = null;
function HT_langLabel(code) {
  try {
    if (!HT_langNames) HT_langNames = new Intl.DisplayNames(["ru"], { type: "language" });
    return HT_langNames.of(code) || String(code);
  } catch (e) { return String(code); }
}

// Язык перевода по языку интерфейса браузера ("ru", "en-GB", "pt-BR", "zh-TW"): точный код из
// таблицы, иначе первый с той же базой, иначе английский.
function HT_targetFromLocale(locale) {
  const l = String(locale || "").replace(/_/g, "-").toUpperCase();
  const codes = HT_TARGET_LANGS.map((r) => r[0]);
  if (codes.includes(l)) return l;
  const base = l.split("-")[0];
  return codes.find((c) => c.split("-")[0] === base) || "EN-US";
}

// Пара, которую встроенному переводчику готовят заранее (страница приветствия, окно расширения):
// английский → язык перевода, а если переводят на английский — русский → английский (интерфейс
// расширения пока русский). Остальные пары скачиваются на сайте при первом переводе.
function HT_prepPair(targetLang) {
  const tgt = HT_langBase(targetLang);
  return { src: tgt === "en" ? "ru" : "en", tgt };
}

// ---- движки ----
// Поведение движка описано данными, а не if-ами по имени. Поля:
//   via        — куда уходит запрос: "deepl" | "llm" (через background) либо "local" (на компьютере);
//   keyField   — ключ настроек с ключом сервиса (нет — движку ключ не нужен);
//   cacheAs    — под каким именем движка кэшировать (alias: auto даёт тот же результат, что deepl);
//   scopeFields— какие ещё поля запроса входят в ключ кэша (для ИИ — провайдер/модель/origin);
//   fallback   — на что переключиться, если основной путь не смог;
//   formality  — поддерживает ли параметр «обращение»;
//   note       — показывать ли в окне состояние встроенного переводчика (он участвует в переводе);
//   hint       — пояснение под названием в окне расширения.
// Порядок строк — порядок в окне: встроенный первым, он по умолчанию.
var HT_ENGINES = [
  ["chrome", "Встроенный в Chrome",
    { via: "local", note: true, hint: "бесплатно, текст не уходит в интернет" }],
  ["deepl", "DeepL",
    { via: "deepl", keyField: "apiKey", formality: true, hint: "точнее; по своему ключу, бесплатно 500\u00a0000 знаков в месяц" }],
  ["auto", "DeepL, а если не вышло — встроенный",
    { via: "deepl", keyField: "apiKey", formality: true, cacheAs: "deepl", fallback: "local", note: true,
      hint: "перевод не прервётся, когда кончится лимит DeepL или пропадёт связь" }],
  ["llm", "ИИ (ChatGPT / Claude)",
    { via: "llm", keyField: "llmApiKey", scopeFields: ["llmProvider", "llmModel", "origin"], hint: "по своему ключу, платно" }],
];

// Что показать, если ключа нет. Ключуем ПОЛЕМ настроек, а не движком: deepl и auto делят один
// ключ, и одинаковая подсказка иначе лежала бы в таблице дважды.
var HT_KEY_HINTS = {
  apiKey: "Не задан ключ DeepL — нажмите на значок расширения и вставьте ключ.",
  llmApiKey: "Не задан ключ ИИ — нажмите на значок расширения и вставьте ключ.",
};

var HT_ENGINE = {};
for (var i = 0; i < HT_ENGINES.length; i++) {
  HT_ENGINE[HT_ENGINES[i][0]] = Object.assign({ code: HT_ENGINES[i][0], label: HT_ENGINES[i][1] }, HT_ENGINES[i][2]);
}

// Неизвестное значение настройки трактуем как движок по умолчанию. Только собственные ключи
// таблицы: HT_ENGINE["constructor"] иначе вернул бы функцию Object вместо описания движка.
function HT_engine(code) {
  return Object.prototype.hasOwnProperty.call(HT_ENGINE, code) ? HT_ENGINE[code] : HT_ENGINE[HT_DEFAULTS.engine];
}

// ---- куда уходит текст и согласие на это ----
// Сервис, которому выбранный переводчик отправляет текст абзацев: "deepl" | "openai" | "anthropic",
// или "" — встроенный, он ничего не отправляет. Для ИИ — выбранный провайдер (сверенный с таблицей).
var HT_PROVIDER_NAMES = { deepl: "DeepL", openai: "OpenAI (ChatGPT)", anthropic: "Anthropic (Claude)" };
function HT_provider(engine, llmProvider) {
  const e = HT_engine(engine);
  if (e.via === "deepl") return "deepl";
  if (e.via === "llm") return HT_valid("llmProvider", llmProvider);
  return "";
}

// Согласие на отправку текста — по сервису: storage.local.consent = { deepl, openai, anthropic }
// (true — человек нажал «Согласен» в окне расширения). Магазин Chrome требует заметного раскрытия и
// явного согласия ДО первой отправки содержимого страниц. Пишет согласие только окно расширения;
// читают все три контекста, поэтому значение сверяем: в счёт идёт только true у известного сервиса.
function HT_consent(v) {
  const out = { deepl: false, openai: false, anthropic: false };
  if (v && typeof v === "object") for (const k in out) out[k] = v[k] === true;
  return out;
}
function HT_agreed(consent, provider) { return !provider || HT_consent(consent)[provider] === true; }

// Можно ли выбранному переводчику отправлять текст в сеть: есть ключ и согласие на его сервис.
// st — { apiKey, llmApiKey (есть ли ключ — только факт), llmProvider, consent }.
function HT_canSend(engine, st) {
  const e = HT_engine(engine);
  if (e.via === "local") return false;
  if (e.keyField && !(st && st[e.keyField])) return false;
  return HT_agreed(st && st.consent, HT_provider(engine, st && st.llmProvider));
}

// ---- может ли выбранный переводчик работать ----
// Код причины, по которой выбранный переводчик сейчас не может работать, или null. st — как у
// HT_canSend; builtin — есть ли встроенный переводчик в браузере. Одна функция на три контекста:
// по ней background ставит «!» на значке, content не трогает страницу, а окно расширения объясняет,
// что сделать. Нет согласия — то же, что нет ключа: отправлять нельзя.
// «Авто» без ключа DeepL или без согласия работает встроенным переводчиком, поэтому проблемой не считается.
function HT_engineProblem(engine, st, builtin) {
  const e = HT_engine(engine);
  const hasKey = !e.keyField || !!(st && st[e.keyField]);
  const why = !hasKey ? (e.keyField === "apiKey" ? "no-deepl-key" : "no-llm-key") : "no-consent";
  const net = e.via !== "local" && HT_canSend(engine, st);
  if (e.via !== "local" && !net && e.fallback !== "local") return why;
  const needLocal = e.via === "local" || !net;
  if (needLocal && !builtin) return e.via === "local" ? "no-builtin" : why;
  return null;
}

// Тексты к причинам: short — для подсказки значка, page — для уведомления на странице.
var HT_PROBLEMS = {
  "no-deepl-key": {
    short: "не задан ключ DeepL",
    page: "Перевод не работает: не задан ключ DeepL. Нажмите на значок расширения, чтобы вставить ключ или включить встроенный переводчик.",
  },
  "no-llm-key": {
    short: "не задан ключ ИИ",
    page: "Перевод не работает: не задан ключ ИИ. Нажмите на значок расширения, чтобы вставить ключ или включить встроенный переводчик.",
  },
  "no-consent": {
    short: "нужно ваше согласие на отправку текста",
    page: "Перевод не работает: нужно ваше согласие на отправку текста выбранному переводчику. Нажмите на значок расширения, чтобы согласиться или включить встроенный переводчик.",
  },
  "no-builtin": {
    short: "встроенный переводчик недоступен в этом браузере",
    page: "Перевод не работает: встроенный переводчик недоступен в этом браузере (нужен Chrome 138 или новее на компьютере). Нажмите на значок расширения, чтобы подключить DeepL.",
  },
};

// ---- модели ИИ ----
// Недорогие быстрые модели для списка в окне (по документации провайдеров на ноябрь 2026). Первая —
// по умолчанию: пустое llmModel в настройках значит «модель по умолчанию», поэтому при смене списка
// в новой версии такие пользователи переходят на новую модель сами. req — что добавить к запросу:
// перевод абзаца не требует скрытого рассуждения, а с ним ответ медленнее, дороже и может не
// уложиться в потолок длины. У Claude Haiku 5.5 рассуждение выключается, у Sonnet 5.5 — нет
// (ответ 400), там «between_tools» убирает рассуждение перед ответом.
var HT_LLM_MODELS = {
  openai: [
    ["gpt-6-luna", "GPT-6 Luna — быстрая и дешёвая", { reasoning_effort: "none" }],
    ["gpt-6.1-terra", "GPT-6.1 Terra — точнее, примерно в 10 раз дороже", { reasoning_effort: "none" }],
  ],
  anthropic: [
    ["claude-haiku-5-5", "Claude Haiku 5.5 — быстрая и дешёвая", { thinking: { type: "disabled" } }],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5 — точнее, примерно в 20 раз дороже", { thinking: { type: "between_tools" } }],
  ],
};
function HT_llmModels(provider) { return HT_LLM_MODELS[HT_valid("llmProvider", provider)]; }
function HT_llmDefault(provider) { return HT_llmModels(provider)[0][0]; }
// Строка модели из списка или null (модель, вписанная вручную).
function HT_llmModelRow(provider, model) {
  return HT_llmModels(provider).find((r) => r[0] === model) || null;
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
// Переводчик по умолчанию — встроенный: работает сразу, без ключа и регистрации, и это единственный
// доступный из России (DeepL, OpenAI и Anthropic её не обслуживают). Язык перевода при установке
// выставляет background по языку браузера; "RU" здесь — запасное значение.
// Способ включения по умолчанию — Shift: наведение с задержкой переводит и то, над чем курсор
// просто проезжает (меню, кнопки, абзацы при прокрутке). Задержка для тех, кто выберет наведение, —
// 600 мс: при 250 мс абзац переводился, пока курсор шёл мимо него к ссылке.
var HT_DEFAULTS = {
  enabled: true, targetLang: "RU", sourceLang: "auto", dwellMs: 600, trigger: "shift", engine: "chrome",
  displayMode: "replace", showLangBadge: true, formality: "default", noTranslate: "",
  // llmProvider/llmModel сам content не использует (их читает background), но держит в DEFAULTS,
  // чтобы их смена тоже триггерила живое перетранслирование уже показанных переводов.
  // Пустая модель — «по умолчанию» (первая в HT_LLM_MODELS для провайдера).
  llmProvider: "openai", llmModel: "",
  dispMode: "auto", dispBg: "#0078d7", dispOpacity: 12,
  dispBorder: false, dispBorderColor: "#0078d7", dispBorderStyle: "solid",
};

// Допустимые значения настроек-перечислений. Хранилище общее для всех сайтов, а писать в него
// может не только popup (мини-панель живёт на странице), поэтому значение сверяется со списком
// при каждом чтении: неизвестное становится значением по умолчанию и не попадает ни в запрос
// к движку, ни в инструкцию для ИИ. Списки formality/llmProvider/displayMode/trigger обязаны
// совпадать со значениями полей выбора в popup.html (<option> и переключателей).
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
  // включило бы перевод без задержки. Не `|| DEFAULTS` — иначе валидный 0 стал бы значением по умолчанию.
  const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.max(0, Math.min(HT_DWELL_MAX, n)) : HT_DEFAULTS.dwellMs;
}

// ---- сайты, где перевод выключен ----
// storage.local.disabledSites — список имён хостов (без «www.», в нижнем регистре). Пишут туда окно
// расширения и мини-панель на странице, поэтому при каждом чтении сверяем тип и вид записей: в
// список попадают только строки, похожие на имя хоста. «www.» отбрасываем, чтобы example.com и
// www.example.com были одним сайтом; поддомены — разные сайты (mail.example.com ≠ example.com).
var HT_SITES_MAX = 2000;
function HT_siteKey(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}
function HT_isSite(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 253 &&
    (/^[a-z0-9_.-]+$/.test(s) || /^\[[0-9a-f:.]+\]$/.test(s));
}
function HT_sites(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const s of v) {
    if (HT_isSite(s) && !out.includes(s)) out.push(s);
    if (out.length >= HT_SITES_MAX) break;
  }
  return out;
}

// Мини-панель: показана ли она и где стоит — общие для всех сайтов значения (hudShown, hudPos), чтобы
// панель не пропадала при переходе на другую страницу. Позицию тоже сверяем при чтении.
function HT_hudPos(v) {
  return v && typeof v === "object" && Number.isFinite(v.left) && Number.isFinite(v.top)
    ? { left: v.left, top: v.top } : null;
}

// ---- названия клавиш ----
// Клавиша способа включения — так, как она подписана на клавиатуре: на Mac Alt называется Option, а
// вместо Ctrl обычно жмут Cmd (content принимает и Ctrl, и Cmd). Для окна и страницы приветствия.
function HT_isMac() {
  try {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    return /mac/i.test(p);
  } catch (e) { return false; }
}
var HT_TRIGGER_KEYS = { shift: ["Shift", "⇧ Shift"], alt: ["Alt", "⌥ Option"], ctrl: ["Ctrl", "⌘ Cmd"] };
function HT_triggerKey(trigger, mac) {
  const k = Object.prototype.hasOwnProperty.call(HT_TRIGGER_KEYS, trigger) ? HT_TRIGGER_KEYS[trigger] : null;
  return k ? k[mac ? 1 : 0] : "";
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
