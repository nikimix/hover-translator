// shared.js — ЕДИНСТВЕННОЕ место для данных и мелких хелперов, нужных сразу нескольким
// контекстам расширения. Подключается везде: content_scripts (перед content.js), service worker
// (importScripts), popup.html и welcome.html (первым скриптом).
//
// Сборки у расширения нет, три контекста изолированы и общаются сообщениями, поэтому любой
// общий факт живёт либо здесь, либо в трёх копиях. Копии уже расходились: у исходного языка
// «PT» не было английского имени и в промпт LLM уходило «into PT»; список движков лежал
// в popup.html, а знание об их поведении — в четырёх if-ах в двух файлах.

// ---- тексты интерфейса ----
// Все видимые строки — в _locales/<язык>/messages.json. Язык выбирает Chrome по языку браузера; для языка
// без своего файла берётся английский (default_locale). Подстановки — строки: числа форматирует
// вызывающий (HT_num). Пустая строка — такого сообщения нет или связь с расширением пропала (старый
// скрипт на вкладке после обновления расширения): там лучше промолчать, чем упасть.
function HT_t(key, subs) {
  try {
    return chrome.i18n.getMessage(key, subs == null ? undefined : [].concat(subs).map(String)) || "";
  } catch (e) { return ""; }
}

// Язык файла сообщений, который Chrome выбрал на самом деле (сообщение uiLocale есть в каждом файле), а
// не язык браузера: при немецком браузере тексты английские, и числа, формы множественного числа и
// названия языков в них тоже должны быть английскими.
var HT_uiLangCache = "";
function HT_uiLang() { return HT_uiLangCache || (HT_uiLangCache = HT_t("uiLocale") || "en"); }

var HT_numFormat = null;
function HT_num(n) {
  try {
    if (!HT_numFormat) HT_numFormat = new Intl.NumberFormat(HT_uiLang());
    return HT_numFormat.format(n);
  } catch (e) { return String(n); }
}

// Текст с числом: у такого сообщения в каждом файле четыре формы — key_one, key_few, key_many, key_other
// («1 знак, 2 знака, 5 знаков, 1,5 знака»; в английском нужны две, остальные повторяют other). Число —
// первая подстановка, остальные — следом. Формы zero/two (в других языках) — запасная other.
var HT_PLURAL_FORMS = ["one", "few", "many", "other"];
function HT_plural(key, n, subs) {
  let form = "other";
  try { form = new Intl.PluralRules(HT_uiLang()).select(n); } catch (e) { /* остаётся other */ }
  if (!HT_PLURAL_FORMS.includes(form)) form = "other";
  return HT_t(key + "_" + form, [HT_num(n)].concat(subs == null ? [] : subs));
}

// Статический текст страниц расширения (окно, приветствие): data-i18n — текст элемента,
// data-i18n-title / -aria-label / -placeholder — атрибуты. Подстановка $1 в таких текстах — всегда
// короткое название расширения, чтобы оно жило в одном месте (сообщение extShortName; полное, extName, —
// только для manifest и магазина). Ссылка или выделение внутри фразы: в сообщении — {a}…{/a}, в разметке —
// дочерний элемент с data-part="a": адрес и атрибуты остаются в разметке, а слова и их порядок — в
// сообщении. Вставляем только textContent, разметку из сообщений не разбираем. В service worker и на
// сайтах не вызывается.
function HT_localize(root) {
  const name = [HT_t("extShortName")];
  document.documentElement.lang = HT_uiLang();
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const msg = HT_t(el.dataset.i18n, name);
    const parts = {};
    for (const p of el.querySelectorAll("[data-part]")) parts[p.dataset.part] = p;
    el.textContent = "";
    const re = /\{(\w+)\}([\s\S]*?)\{\/\1\}/g;
    let last = 0, m;
    while ((m = re.exec(msg))) {
      el.append(msg.slice(last, m.index));
      const p = parts[m[1]];
      if (p) { p.textContent = m[2]; el.append(p); } else el.append(m[2]);
      last = re.lastIndex;
    }
    el.append(msg.slice(last));
  }
  for (const attr of ["title", "aria-label", "placeholder"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, HT_t(el.getAttribute("data-i18n-" + attr), name));
  }
}

// ---- языки ----
// Один список на всё расширение. Поля строки:
//   код настройки — для языков DeepL это его код (target_lang, у вариантов — с регионом или письменностью),
//     для остальных — код того же вида; сохранённые настройки прежних версий остаются верными;
//   самоназвание — так язык подписан в списках: свой язык человек находит по его собственному названию;
//   английское имя — для инструкции ИИ (в инструкцию никогда не попадает сам код, см. background.js);
//   код DeepL ("" — DeepL этот язык не знает);
//   код встроенного переводчика Chrome ("" — встроенный этот язык не знает).
// По документации на 18.11.2026: DeepL переводит со 114 языков и на 120 (языки и варианты: американский и
// британский английский, бразильский и европейский португальский, латиноамериканский испанский, канадский
// французский, швейцарский немецкий, традиционный китайский); встроенный переводчик Chrome знает 39 языков
// (все они есть и у DeepL, кроме каннада). ИИ переводит на любой язык из списка.
// Варианты (код с «-») — только языки перевода: язык оригинала у DeepL указывается без варианта. EN и PT —
// наоборот, только языки оригинала: переводить на «английский вообще» DeepL предлагает через EN-US/EN-GB.
// Порядок — по самоназванию: сначала латиница, потом другие письменности, как в списках языков Википедии.
var HT_LANGS = [
  ["OM", "Afaan Oromoo", "Oromo", "OM", ""],
  ["AF", "Afrikaans", "Afrikaans", "AF", ""],
  ["AN", "Aragonés", "Aragonese", "AN", ""],
  ["GN", "Avañeʼẽ", "Guarani", "GN", ""],
  ["AY", "Aymar aru", "Aymara", "AY", ""],
  ["AZ", "Azərbaycan", "Azerbaijani", "AZ", ""],
  ["ID", "Bahasa Indonesia", "Indonesian", "ID", "id"],
  ["MS", "Bahasa Melayu", "Malay", "MS", ""],
  ["ACE", "Bahsa Acèh", "Acehnese", "ACE", ""],
  ["JV", "Basa Jawa", "Javanese", "JV", ""],
  ["SU", "Basa Sunda", "Sundanese", "SU", ""],
  ["BS", "Bosanski", "Bosnian", "BS", ""],
  ["BR", "Brezhoneg", "Breton", "BR", ""],
  ["CA", "Català", "Catalan", "CA", ""],
  ["CEB", "Cebuano", "Cebuano", "CEB", ""],
  ["CS", "Čeština", "Czech", "CS", "cs"],
  ["CY", "Cymraeg", "Welsh", "CY", ""],
  ["DA", "Dansk", "Danish", "DA", "da"],
  ["DE", "Deutsch", "German", "DE", "de"],
  ["DE-CH", "Deutsch (Schweiz)", "Swiss Standard German", "DE-CH", "de"],
  ["ET", "Eesti", "Estonian", "ET", ""],
  ["EN", "English", "English", "EN", "en"],
  ["EN-GB", "English (UK)", "English (UK)", "EN-GB", "en"],
  ["EN-US", "English (US)", "English (US)", "EN-US", "en"],
  ["ES", "Español", "Spanish", "ES", "es"],
  ["ES-419", "Español (Latinoamérica)", "Latin American Spanish", "ES-419", "es"],
  ["EO", "Esperanto", "Esperanto", "EO", ""],
  ["EU", "Euskara", "Basque", "EU", ""],
  ["FR", "Français", "French", "FR", "fr"],
  ["FR-CA", "Français (Canada)", "Canadian French", "FR-CA", "fr"],
  ["GA", "Gaeilge", "Irish", "GA", ""],
  ["GL", "Galego", "Galician", "GL", ""],
  ["HA", "Hausa", "Hausa", "HA", ""],
  ["HR", "Hrvatski", "Croatian", "HR", "hr"],
  ["IG", "Igbo", "Igbo", "IG", ""],
  ["XH", "isiXhosa", "Xhosa", "XH", ""],
  ["ZU", "isiZulu", "Zulu", "ZU", ""],
  ["IS", "Íslenska", "Icelandic", "IS", ""],
  ["IT", "Italiano", "Italian", "IT", "it"],
  ["PAM", "Kapampangan", "Kapampangan", "PAM", ""],
  ["SW", "Kiswahili", "Swahili", "SW", ""],
  ["HT", "Kreyòl ayisyen", "Haitian Creole", "HT", ""],
  ["KMR", "Kurdî (Kurmancî)", "Kurdish (Kurmanji)", "KMR", ""],
  ["LA", "Latina", "Latin", "LA", ""],
  ["LV", "Latviešu", "Latvian", "LV", ""],
  ["LB", "Lëtzebuergesch", "Luxembourgish", "LB", ""],
  ["LT", "Lietuvių", "Lithuanian", "LT", "lt"],
  ["LN", "Lingála", "Lingala", "LN", ""],
  ["LMO", "Lombard", "Lombard", "LMO", ""],
  ["HU", "Magyar", "Hungarian", "HU", "hu"],
  ["MG", "Malagasy", "Malagasy", "MG", ""],
  ["MT", "Malti", "Maltese", "MT", ""],
  ["MI", "Māori", "Maori", "MI", ""],
  ["NL", "Nederlands", "Dutch", "NL", "nl"],
  ["NB", "Norsk bokmål", "Norwegian (Bokmål)", "NB", "no"],
  ["OC", "Occitan", "Occitan", "OC", ""],
  ["UZ", "Oʻzbekcha", "Uzbek", "UZ", ""],
  ["PAG", "Pangasinan", "Pangasinan", "PAG", ""],
  ["PL", "Polski", "Polish", "PL", "pl"],
  ["PT", "Português", "Portuguese", "PT", "pt"],
  ["PT-BR", "Português (Brasil)", "Brazilian Portuguese", "PT-BR", "pt"],
  ["PT-PT", "Português (Portugal)", "European Portuguese", "PT-PT", "pt"],
  ["RO", "Română", "Romanian", "RO", "ro"],
  ["QU", "Runa Simi", "Quechua", "QU", ""],
  ["ST", "Sesotho", "Sesotho", "ST", ""],
  ["TN", "Setswana", "Tswana", "TN", ""],
  ["SQ", "Shqip", "Albanian", "SQ", ""],
  ["SCN", "Sicilianu", "Sicilian", "SCN", ""],
  ["SK", "Slovenčina", "Slovak", "SK", "sk"],
  ["SL", "Slovenščina", "Slovenian", "SL", "sl"],
  ["FI", "Suomi", "Finnish", "FI", "fi"],
  ["SV", "Svenska", "Swedish", "SV", "sv"],
  ["TL", "Tagalog", "Tagalog", "TL", ""],
  ["VI", "Tiếng Việt", "Vietnamese", "VI", "vi"],
  ["TR", "Türkçe", "Turkish", "TR", "tr"],
  ["TK", "Türkmençe", "Turkmen", "TK", ""],
  ["WO", "Wolof", "Wolof", "WO", ""],
  ["TS", "Xitsonga", "Tsonga", "TS", ""],
  ["EL", "Ελληνικά", "Greek", "EL", "el"],
  ["BA", "Башҡортса", "Bashkir", "BA", ""],
  ["BE", "Беларуская", "Belarusian", "BE", ""],
  ["BG", "Български", "Bulgarian", "BG", "bg"],
  ["KY", "Кыргызча", "Kyrgyz", "KY", ""],
  ["KK", "Қазақ тілі", "Kazakh", "KK", ""],
  ["MK", "Македонски", "Macedonian", "MK", ""],
  ["MN", "Монгол", "Mongolian", "MN", ""],
  ["RU", "Русский", "Russian", "RU", "ru"],
  ["SR", "Српски", "Serbian", "SR", ""],
  ["TT", "Татарча", "Tatar", "TT", ""],
  ["TG", "Тоҷикӣ", "Tajik", "TG", ""],
  ["UK", "Українська", "Ukrainian", "UK", "uk"],
  ["KA", "ქართული", "Georgian", "KA", ""],
  ["HY", "Հայերեն", "Armenian", "HY", ""],
  ["YI", "ייִדיש", "Yiddish", "YI", ""],
  ["HE", "עברית", "Hebrew", "HE", "he"],
  ["UR", "اردو", "Urdu", "UR", ""],
  ["AR", "العربية", "Arabic", "AR", "ar"],
  ["PS", "پښتو", "Pashto", "PS", ""],
  ["PRS", "دری", "Dari", "PRS", ""],
  ["FA", "فارسی", "Persian", "FA", ""],
  ["CKB", "کوردی (سۆرانی)", "Kurdish (Sorani)", "CKB", ""],
  ["GOM", "कोंकणी", "Konkani", "GOM", ""],
  ["NE", "नेपाली", "Nepali", "NE", ""],
  ["BHO", "भोजपुरी", "Bhojpuri", "BHO", ""],
  ["MR", "मराठी", "Marathi", "MR", "mr"],
  ["MAI", "मैथिली", "Maithili", "MAI", ""],
  ["SA", "संस्कृतम्", "Sanskrit", "SA", ""],
  ["HI", "हिन्दी", "Hindi", "HI", "hi"],
  ["AS", "অসমীয়া", "Assamese", "AS", ""],
  ["BN", "বাংলা", "Bengali", "BN", "bn"],
  ["PA", "ਪੰਜਾਬੀ", "Punjabi", "PA", ""],
  ["GU", "ગુજરાતી", "Gujarati", "GU", ""],
  ["TA", "தமிழ்", "Tamil", "TA", "ta"],
  ["TE", "తెలుగు", "Telugu", "TE", "te"],
  ["KN", "ಕನ್ನಡ", "Kannada", "", "kn"],
  ["ML", "മലയാളം", "Malayalam", "ML", ""],
  ["TH", "ไทย", "Thai", "TH", "th"],
  ["MY", "မြန်မာ", "Burmese", "MY", ""],
  ["KO", "한국어", "Korean", "KO", "ko"],
  ["ZH", "中文 (简体)", "Chinese", "ZH", "zh"],
  ["ZH-HANT", "中文 (繁體)", "Traditional Chinese", "ZH-HANT", "zh-Hant"],
  ["JA", "日本語", "Japanese", "JA", "ja"],
  ["YUE", "粵語", "Cantonese", "YUE", ""],
];
var HT_SOURCE_ONLY = ["EN", "PT"];

var HT_LANG = {};
for (var i = 0; i < HT_LANGS.length; i++) {
  HT_LANG[HT_LANGS[i][0]] = { name: HT_LANGS[i][1], english: HT_LANGS[i][2], deepl: HT_LANGS[i][3], builtin: HT_LANGS[i][4] };
}
function HT_lang(code) { return Object.prototype.hasOwnProperty.call(HT_LANG, code) ? HT_LANG[code] : null; }

// Списки для полей выбора: [код, самоназвание]. Первая строка языков оригинала — «определять сам».
var HT_TARGET_LANGS = HT_LANGS.filter((r) => !HT_SOURCE_ONLY.includes(r[0])).map((r) => [r[0], r[1]]);
var HT_SOURCE_LANGS = [["auto", HT_t("srcAuto")]].concat(HT_LANGS.filter((r) => !r[0].includes("-")).map((r) => [r[0], r[1]]));

// Английские имена для системного промпта LLM — для КАЖДОГО кода из обоих списков.
var HT_LANG_NAMES = {};
for (var j = 0; j < HT_LANGS.length; j++) HT_LANG_NAMES[HT_LANGS[j][0]] = HT_LANGS[j][2];

// Код языка для DeepL и для встроенного переводчика ("" — этот переводчик язык не знает).
function HT_deeplCode(code) { const l = HT_lang(code); return l ? l.deepl : ""; }
function HT_builtinCode(code) { const l = HT_lang(code); return l ? l.builtin : ""; }

// Базовый код языка: "EN-US" → "en". Сравнение языков идёт только по базе.
function HT_langBase(code) { return String(code || "").split("-")[0].toLowerCase(); }
// То же для сравнения языков между собой: у некоторых языков два кода, и определитель языка может
// вернуть старый (iw — иврит, no/nb — норвежский, fil — тагальский).
var HT_LANG_SAME = { iw: "he", nb: "no", nn: "no", fil: "tl", in: "id", ji: "yi", jw: "jv" };
function HT_langKey(code) { const b = HT_langBase(code); return HT_LANG_SAME[b] || b; }

// Название языка на языке интерфейса для подсказок: "en" → «английский» / "English". Через Intl, а не
// таблицей: детектор языка возвращает и коды, которых в таблице нет. Если Intl языка не знает (вернул
// сам код), — английское имя из таблицы.
var HT_langNames = null;
function HT_langLabel(code) {
  const c = String(code);
  try {
    if (!HT_langNames) HT_langNames = new Intl.DisplayNames([HT_uiLang()], { type: "language" });
    const s = HT_langNames.of(c);
    if (s && s.toLowerCase() !== c.toLowerCase()) return s;
  } catch (e) { /* ниже — запасной вариант */ }
  const l = HT_lang(c.toUpperCase());
  return l ? l.english : c;
}

// Язык перевода по языку интерфейса браузера ("ru", "en-GB", "pt-BR", "zh-TW"): точный код из списка,
// иначе вариант по региону, иначе язык с той же базой, иначе английский (американский).
function HT_targetFromLocale(locale) {
  const l = String(locale || "").replace(/_/g, "-").toLowerCase();
  const base = l.split("-")[0];
  const codes = HT_TARGET_LANGS.map((r) => r[0]);
  const exact = codes.find((c) => c.toLowerCase() === l);
  if (exact) return exact;
  if (base === "en") return /^en-(gb|au|nz|ie|za|in)\b/.test(l) ? "EN-GB" : "EN-US";
  if (base === "zh") return /^zh-(tw|hk|mo|hant)\b/.test(l) ? "ZH-HANT" : "ZH";
  if (base === "es") return l === "es" || l === "es-es" ? "ES" : "ES-419";
  if (base === "pt") return "PT-PT";
  const same = (HT_LANG_SAME[base] || base).toUpperCase();
  if (codes.includes(same)) return same;
  return codes.find((c) => HT_langKey(c) === HT_langKey(base)) || "EN-US";
}

// Пара, которую встроенному переводчику готовят заранее (страница приветствия, окно расширения), и язык
// абзаца для пробы на приветствии: английский → язык перевода; а если переводят на английский — с языка
// интерфейса (русского), при английском интерфейсе — с испанского. Остальные пары скачиваются на сайте
// при первом переводе. tgt пустой — встроенный не знает язык перевода.
// pageLang — язык открытой вкладки (атрибут lang страницы), если окно его знает: тогда готовим именно
// его → язык перевода. Иначе на испанской странице готовилась пара «английский → русский», окно писало
// «Готово», а на странице всё равно начиналась загрузка испанской модели.
function HT_prepPair(targetLang, pageLang) {
  const tgt = HT_builtinCode(targetLang);
  const page = HT_builtinOf(pageLang);
  if (tgt && page && HT_langKey(page) !== HT_langKey(tgt)) return { src: page, tgt };
  return { src: HT_langKey(tgt) !== "en" ? "en" : HT_uiLang() === "ru" ? "ru" : "es", tgt };
}
// Код встроенного переводчика для языка из атрибута lang («es-ES» → «es»); "" — не знаем такого.
function HT_builtinOf(lang) {
  const key = HT_langKey(lang);
  if (!key || !/^[a-z]{2,3}$/.test(key)) return "";
  const row = HT_LANGS.find((r) => r[4] && HT_langKey(r[4]) === key);
  return row ? row[4] : "";
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
//   hint       — сообщение с пояснением под названием в окне расширения.
// Второй элемент строки — сообщение с названием (messages.json); подписи берёт HT_engineLabel/HT_engineHint.
// Порядок строк — порядок в окне: встроенный первым, он по умолчанию.
var HT_ENGINES = [
  ["chrome", "engChrome", { via: "local", note: true, hint: "engChromeHint" }],
  ["deepl", "engDeepl", { via: "deepl", keyField: "apiKey", formality: true, hint: "engDeeplHint" }],
  ["auto", "engAuto",
    { via: "deepl", keyField: "apiKey", formality: true, cacheAs: "deepl", fallback: "local", note: true, hint: "engAutoHint" }],
  ["llm", "engLlm",
    { via: "llm", keyField: "llmApiKey", scopeFields: ["llmProvider", "llmModel", "origin"], hint: "engLlmHint" }],
];

// Что показать, если ключа нет (сообщение). Ключуем ПОЛЕМ настроек, а не движком: deepl и auto делят
// один ключ, и одинаковая подсказка иначе лежала бы в таблице дважды.
var HT_KEY_HINTS = {
  apiKey: "keyHintDeepl",
  llmApiKey: "keyHintLlm",
};

var HT_ENGINE = {};
for (var i = 0; i < HT_ENGINES.length; i++) {
  HT_ENGINE[HT_ENGINES[i][0]] = Object.assign({ code: HT_ENGINES[i][0], labelKey: HT_ENGINES[i][1] }, HT_ENGINES[i][2]);
}
function HT_engineLabel(code) { return HT_t(HT_engine(code).labelKey); }
function HT_engineHint(code) { return HT_t(HT_engine(code).hint); }

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

// Какой язык выбранный путь перевода не знает: { dir: "to" | "from", code } или null. via — "deepl" или
// "local" (встроенный); ИИ переводит любой язык из списка. st — { targetLang, sourceLang }: без них
// (старые вызовы, проверка ключа) язык не проверяется.
function HT_langGap(via, st) {
  if (via !== "deepl" && via !== "local") return null;
  const has = via === "deepl" ? HT_deeplCode : HT_builtinCode;
  const tgt = st && st.targetLang, src = st && st.sourceLang;
  if (tgt && !has(tgt)) return { dir: "to", code: tgt };
  if (src && src !== "auto" && !has(src)) return { dir: "from", code: src };
  return null;
}

// Можно ли выбранному переводчику отправлять текст в сеть: есть ключ, согласие на его сервис и DeepL
// знает выбранные языки. st — { apiKey, llmApiKey (есть ли ключ — только факт), llmProvider, consent,
// targetLang, sourceLang }.
function HT_canSend(engine, st) {
  const e = HT_engine(engine);
  if (e.via === "local") return false;
  if (e.keyField && !(st && st[e.keyField])) return false;
  if (HT_langGap(e.via, st)) return false;
  return HT_agreed(st && st.consent, HT_provider(engine, st && st.llmProvider));
}

// ---- может ли выбранный переводчик работать ----
// Код причины, по которой выбранный переводчик сейчас не может работать, или null. st — как у
// HT_canSend; builtin — есть ли встроенный переводчик в браузере. Одна функция на три контекста:
// по ней background ставит «!» на значке, content не трогает страницу, а окно расширения объясняет,
// что сделать. Нет согласия — то же, что нет ключа: отправлять нельзя. Язык, которого переводчик не
// знает, — тоже причина: честное объяснение вместо ошибки на каждом абзаце.
// «Авто» без ключа DeepL, без согласия или с языком, которого нет у DeepL, работает встроенным
// переводчиком, поэтому проблемой не считается — если встроенный этот язык знает.
function HT_engineProblem(engine, st, builtin) {
  const e = HT_engine(engine);
  const hasKey = !e.keyField || !!(st && st[e.keyField]);
  // Язык — первым: без него ни ключ, ни согласие не помогут. Затем согласие, потом ключ — в том же порядке,
  // что и шаги подключения на странице настроек («Согласие → Ключ → Готово»).
  const agreed = HT_agreed(st && st.consent, HT_provider(engine, st && st.llmProvider));
  const why = HT_langGap(e.via, st) ? "deepl-lang"
    : !agreed ? "no-consent" : !hasKey ? (e.keyField === "apiKey" ? "no-deepl-key" : "no-llm-key") : "no-consent";
  const net = e.via !== "local" && HT_canSend(engine, st);
  if (e.via !== "local" && !net && e.fallback !== "local") return why;
  const needLocal = e.via === "local" || !net;
  if (needLocal && !builtin) return e.via === "local" ? "no-builtin" : why;
  if (needLocal && HT_langGap("local", st)) return "builtin-lang";
  return null;
}

// Тексты к причинам (сообщения): short — для подсказки значка, page — для уведомления на странице. У
// причин про язык via — чей это язык, а у текстов есть вариант «с этого языка» (…From), подстановка —
// название языка (HT_problemText).
var HT_PROBLEMS = {
  "no-deepl-key": { short: "probNoDeeplKey", page: "probNoDeeplKeyPage" },
  "no-llm-key": { short: "probNoLlmKey", page: "probNoLlmKeyPage" },
  "no-consent": { short: "probNoConsent", page: "probNoConsentPage" },
  "no-builtin": { short: "probNoBuiltin", page: "probNoBuiltinPage" },
  "deepl-lang": { via: "deepl", short: "probDeeplLangTo", page: "probDeeplLangToPage",
    shortFrom: "probDeeplLangFrom", pageFrom: "probDeeplLangFromPage" },
  "builtin-lang": { via: "local", short: "probBuiltinLangTo", page: "probBuiltinLangToPage",
    shortFrom: "probBuiltinLangFrom", pageFrom: "probBuiltinLangFromPage" },
};
// Текст причины p: kind — "short" | "page"; st — состояние, по которому её нашли (языки).
function HT_problemText(p, kind, st) {
  const d = Object.prototype.hasOwnProperty.call(HT_PROBLEMS, p) ? HT_PROBLEMS[p] : null;
  if (!d) return "";
  if (!d.via) return HT_t(d[kind]);
  const gap = HT_langGap(d.via, st) || { dir: "to", code: st && st.targetLang };
  return HT_t(gap.dir === "from" ? d[kind + "From"] : d[kind], HT_langLabel(gap.code));
}

// ---- модели ИИ ----
// Недорогие быстрые модели для списка в окне (по документации провайдеров на ноябрь 2026). Первая —
// по умолчанию: пустое llmModel в настройках значит «модель по умолчанию», поэтому при смене списка
// в новой версии такие пользователи переходят на новую модель сами. req — что добавить к запросу:
// перевод абзаца не требует скрытого рассуждения, а с ним ответ медленнее, дороже и может не
// уложиться в потолок длины. У Claude Haiku 5.5 рассуждение выключается, у Sonnet 5.5 — нет
// (ответ 400), там «between_tools» убирает рассуждение перед ответом. Последнее поле — во сколько раз
// дороже первой (0 — сама быстрая и дешёвая), из него собирается подпись в списке (HT_llmModelLabel).
var HT_LLM_MODELS = {
  openai: [
    ["gpt-6-luna", "GPT-6 Luna", { reasoning_effort: "none" }, 0],
    ["gpt-6.1-terra", "GPT-6.1 Terra", { reasoning_effort: "none" }, 10],
  ],
  anthropic: [
    ["claude-haiku-5-5", "Claude Haiku 5.5", { thinking: { type: "disabled" } }, 0],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5", { thinking: { type: "between_tools" } }, 20],
  ],
};
function HT_llmModelLabel(row) {
  return row[3] ? HT_t("modelPrecise", [row[1], HT_num(row[3])]) : HT_t("modelFast", row[1]);
}
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
  // Подсветка переведённого: «auto» — янтарная, подстраивается под фон страницы; «custom» — свой цвет
  // (dispBg) и насыщенность в процентах (dispOpacity, 10–60); «none» — без подсветки. Обводка прежних
  // версий (dispBorder*) убрана: её ключи стирает background при обновлении (HT_OBSOLETE_KEYS).
  dispMode: "auto", dispBg: "#ffcf4a", dispOpacity: 35,
};
var HT_OBSOLETE_KEYS = ["dispBorder", "dispBorderColor", "dispBorderStyle"];
// Шесть цветов подсветки на выбор (страница настроек): код, сообщение с названием.
var HT_SWATCHES = [["#ffcf4a", "swAmber"], ["#7ed6a5", "swGreen"], ["#8fb8ff", "swBlue"], ["#f5a3c7", "swPink"], ["#c4b5fd", "swLilac"], ["#c9ced5", "swGray"]];

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
// Ползунок задержки на странице настроек: 300–1500 мс, шаг 100 (сохранённые значения вне диапазона не трогаем).
var HT_DWELL_UI = { min: 300, max: 1500, step: 100 };
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

// Плавающая кнопка: показана ли она и где стоит — общие для всех сайтов значения (hudShown, hudPos), чтобы
// кнопка не пропадала при переходе на другую страницу. Место — { side: "left" | "right", top }: у какого края
// окна кружок и сколько px от верха окна до его верха (как отпустили); null — место по умолчанию (справа внизу).
// Сверяем при чтении. Старое место мини-панели { left, top } переводим в новое: край — та половина окна, где была
// середина кружка (vw — ширина окна; без неё — справа), высота прежняя. Обратно в хранилище при чтении не пишем:
// перепишется, когда кружок перетащат. Всё остальное — null.
function HT_hudPos(v, vw) {
  if (!v || typeof v !== "object") return null;
  if ((v.side === "left" || v.side === "right") && Number.isFinite(v.top)) return { side: v.side, top: v.top };
  if (Number.isFinite(v.left) && Number.isFinite(v.top)) {
    return { side: vw && v.left + 22 < vw / 2 ? "left" : "right", top: v.top };
  }
  return null;
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
// Заполнить <select> парами [значение, подпись] (лишние элементы строк игнорируются). В service worker не
// вызывается — там нет document.
function HT_fillSelect(sel, rows) {
  sel.textContent = "";
  for (const row of rows) {
    const o = document.createElement("option");
    o.value = row[0];
    o.textContent = row[1];
    sel.appendChild(o);
  }
}
