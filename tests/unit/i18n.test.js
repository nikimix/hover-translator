// Локализация без браузера (_locales en и ru против кода, разметки и manifest).
//   • en и ru: одинаковый набор ключей, одинаковые плейсхолдеры (имя → $N), $N только через placeholders,
//     каждый объявленный плейсхолдер используется, у плюральных — все четыре формы;
//   • каждый ключ, на который ссылаются код (HT_t/HT_plural, таблицы shared.js и popup/content), разметка
//     (data-i18n*) и manifest (__MSG_…__), существует; неиспользуемых ключей нет;
//   • таблицы shared.js (переводчики, причины, подсказки, модели) дают непустые тексты на обоих языках;
//   • кириллицы в коде и разметке больше нет (кроме абзаца для пробы на русском); в английских текстах её
//     нет, в русских — нет английских слов, кроме названий сервисов, моделей и клавиш;
//   • название — только в extName (полное) и extShortName (короткое): в остальных сообщениях, разметке и
//     коде его нет; прежнего «Cursor Translate» нет нигде в папке расширения, включая README;
//   • в видимых текстах (сообщения, абзацы для пробы) нет слов «абзац» и «paragraph»: переводится любой
//     текстовый блок, а не только абзацы;
//   • manifest: default_locale, minimum_chrome_version 116, описание ≤ 132 знаков.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { makeI18n } = require("../lib/i18n-stub");

const { EXT } = require("../lib/env");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
const MSG = { en: JSON.parse(read("_locales/en/messages.json")), ru: JSON.parse(read("_locales/ru/messages.json")) };
const FORMS = ["one", "few", "many", "other"];
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// Плейсхолдеры сообщения: { имя: "$N" } и что из них использовано в тексте.
function phOf(m) {
  const out = {};
  for (const k in m.placeholders || {}) out[k.toLowerCase()] = m.placeholders[k].content;
  return out;
}

// ---- 1. одинаковые ключи и плейсхолдеры ----
{
  const ke = Object.keys(MSG.en).sort(), kr = Object.keys(MSG.ru).sort();
  assert.deepStrictEqual(kr.filter((k) => !MSG.en[k]), [], "есть в ru, нет в en");
  assert.deepStrictEqual(ke.filter((k) => !MSG.ru[k]), [], "есть в en, нет в ru");
  const lower = new Set(ke.map((k) => k.toLowerCase()));
  assert.strictEqual(lower.size, ke.length, "ключи, совпадающие без учёта регистра (Chrome их не различает)");
  for (const k of ke) {
    assert.ok(/^[A-Za-z0-9_]+$/.test(k), "имя ключа: " + k);
    assert.deepStrictEqual(phOf(MSG.en[k]), phOf(MSG.ru[k]), "плейсхолдеры расходятся: " + k);
    for (const lang of ["en", "ru"]) {
      const m = MSG[lang][k];
      assert.ok(typeof m.message === "string" && m.message.trim(), `${lang}:${k} пустое`);
      const ph = phOf(m);
      const used = [...m.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((x) => x[1].toLowerCase());
      for (const u of used) assert.ok(u in ph, `${lang}:${k}: $${u}$ не объявлен`);
      for (const p in ph) {
        assert.ok(used.includes(p), `${lang}:${k}: $${p}$ объявлен, но не используется`);
        assert.ok(/^\$[1-9]$/.test(ph[p]), `${lang}:${k}: содержимое плейсхолдера ${ph[p]}`);
      }
      assert.ok(!/\$[1-9]/.test(m.message), `${lang}:${k}: $N прямо в тексте — только через placeholders`);
      const nums = Object.values(ph).map((c) => Number(c[1])).sort();
      assert.deepStrictEqual(nums, nums.map((_, i) => i + 1), `${lang}:${k}: подстановки должны идти $1…$${nums.length} без пропусков`);
    }
  }
  // плюральные группы — все четыре формы
  const bases = new Set(ke.filter((k) => /_(one|few|many|other)$/.test(k)).map((k) => k.replace(/_(one|few|many|other)$/, "")));
  for (const b of bases) for (const f of FORMS) assert.ok(MSG.en[b + "_" + f], `нет формы ${b}_${f}`);
  ok(`en и ru: одинаковые ${ke.length} ключей и плейсхолдеры; $N только через placeholders; ${bases.size} текстов с числом — по 4 формы`);
}

// ---- 2. ссылки на ключи: существуют, неиспользуемых нет ----
const JS = ["shared.js", "background.js", "content.js", "popup.js", "welcome.js", "builtin.js"];
const HTML = ["popup.html", "welcome.html"];
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const refs = new Map();          // ключ -> где
const addRef = (k, where) => { if (!refs.has(k)) refs.set(k, where); };
{
  for (const f of JS) {
    const src = strip(read(f));
    // Первый аргумент HT_t/HT_plural: строка или тернарный выбор строк (cond ? "a" : "b"); строки-ветки и есть ключи.
    for (const m of src.matchAll(/\b(HT_t|HT_plural)\(/g)) {
      let depth = 0, i = m.index + m[0].length, arg = "";
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) break; depth--; }
        else if (ch === "," && depth === 0) break;
        arg += ch;
      }
      for (const piece of arg.split(/[?:]/)) {
        const lit = piece.trim().match(/^"([A-Za-z0-9_]+)"$/);
        if (!lit) continue;
        if (m[1] === "HT_plural") for (const fm of FORMS) addRef(lit[1] + "_" + fm, f);
        else addRef(lit[1], f);
      }
    }
  }
  // Ключи в таблицах (подписи и тексты выбираются по коду): значения-строки этих объектов и массивов.
  const tables = [
    ["shared.js", /var HT_ENGINES = \[([\s\S]*?)\n\];/], ["shared.js", /var HT_KEY_HINTS = \{([\s\S]*?)\};/],
    ["shared.js", /var HT_PROBLEMS = \{([\s\S]*?)\n\};/], ["content.js", /const FALLBACK_SAY = \{([\s\S]*?)\};/], ["content.js", /const FALLBACK_TELL = Object\.assign\(\{([\s\S]*?)\}/],
    ["popup.js", /const SETUP_GO = \{([\s\S]*?)\};/], ["popup.js", /const SETUP_FIX = \{([\s\S]*?)\};/],
    ["popup.js", /const key = deepl \?([\s\S]*?);\n/],
  ];
  for (const [f, re] of tables) {
    const m = read(f).match(re);
    assert.ok(m, "таблица не найдена: " + re);
    for (const v of m[1].matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)) if (MSG.en[v[1]]) addRef(v[1], f + " (таблица)");
  }
  for (const f of HTML) {
    const src = read(f).replace(/<!--[\s\S]*?-->/g, "");
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) addRef(m[1], f);
  }
  for (const m of read("manifest.json").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) addRef(m[1], "manifest.json");

  const missing = [...refs.keys()].filter((k) => !MSG.en[k]).map((k) => k + " (" + refs.get(k) + ")");
  assert.deepStrictEqual(missing, [], "ссылки на несуществующие ключи");
  const unused = Object.keys(MSG.en).filter((k) => !refs.has(k));
  assert.deepStrictEqual(unused, [], "неиспользуемые ключи");
  ok(`каждый из ${refs.size} ключей, на которые ссылаются код, таблицы, разметка и manifest, существует; неиспользуемых нет`);
}

// ---- 3. таблицы shared.js дают тексты на обоих языках ----
for (const lang of ["ru", "en"]) {
  const i18n = makeI18n(lang);
  const ctx = { chrome: { i18n }, console, Intl };
  vm.createContext(ctx);
  vm.runInContext(read("shared.js"), ctx);
  const r = (e) => vm.runInContext(e, ctx);
  const texts = r(`(() => {
    const out = [];
    for (const [code] of HT_ENGINES) out.push(HT_engineLabel(code), HT_engineHint(code));
    for (const f in HT_KEY_HINTS) out.push(HT_t(HT_KEY_HINTS[f]));
    for (const p in HT_PROBLEMS) for (const kind of ["short", "page"]) {
      out.push(HT_problemText(p, kind, { targetLang: "TT" }));
      out.push(HT_problemText(p, kind, { targetLang: "RU", sourceLang: "KN" }));
    }
    for (const p in HT_LLM_MODELS) for (const row of HT_LLM_MODELS[p]) out.push(HT_llmModelLabel(row));
    out.push(HT_SOURCE_LANGS[0][1]);
    return out;
  })()`);
  assert.ok(texts.every((t) => typeof t === "string" && t.trim()), lang + ": пустой текст в таблицах");
  assert.deepStrictEqual(i18n.missing, [], lang + ": запрошены несуществующие ключи");
  assert.strictEqual(r("HT_uiLang()"), lang);
  // проблема языка: «на» — для языка перевода, «с» — для языка оригинала
  const to = r(`HT_problemText("builtin-lang", "page", { targetLang: "TT" })`), from = r(`HT_problemText("deepl-lang", "short", { targetLang: "RU", sourceLang: "KN" })`);
  if (lang === "ru") assert.ok(/на этот язык \(татарский\)/.test(to) && /с этого языка: каннада/.test(from), to + " | " + from);
  else assert.ok(/into Tatar/.test(to) && /from Kannada/.test(from), to + " | " + from);
}
ok("таблицы shared.js (переводчики, подсказки о ключе, причины — и про язык «на»/«с», модели ИИ) дают непустые тексты на ru и en");

// ---- 4. кириллица осталась только в сообщениях ----
{
  const bad = [];
  for (const f of JS) {
    // самоназвания языков (таблица HT_LANGS) — не текст интерфейса: «Русский» так и пишется в любом интерфейсе
    const src = strip(read(f)).replace(/var HT_LANGS = \[[\s\S]*?\n\];/, "");
    const strings = src.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*[А-Яа-яЁё](?:(?!\1)[^\\\n]|\\.)*\1/g) || [];
    for (const s of strings) bad.push(f + ": " + s);
  }
  for (const f of HTML) {
    const vis = read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/<p class="trainer" id="trainerRu"[^>]*>[^<]*<\/p>/, "");
    for (const line of vis.split("\n")) if (/[А-Яа-яЁё]/.test(line)) bad.push(f + ": " + line.trim().slice(0, 80));
  }
  if (/[А-Яа-яЁё]/.test(read("manifest.json"))) bad.push("manifest.json");
  assert.deepStrictEqual(bad, [], "кириллица в коде или разметке");
  ok("в коде (строки), разметке и manifest кириллицы нет — кроме абзаца для пробы на русском (он не перевод интерфейса)");
}

// ---- 5. английские тексты — без кириллицы, русские — без английских слов, кроме названий ----
// Допустимые английские слова в русских текстах: сервисы, модели, клавиши, адреса, раздел «API Keys» на
// сайте DeepL, тариф «Free», примеры кодов языков, название расширения.
const RU_ALLOWED = new Set(["DeepL", "OpenAI", "Anthropic", "ChatGPT", "Claude", "Chrome", "Google", "Shift", "Esc",
  "API", "Keys", "Free", "fx", "deepl", "com", "pro", "api", "chrome", "extensions", "shortcuts", "EN", "RU"]);
{
  const enCyr = Object.entries(MSG.en).filter(([, m]) => /[А-Яа-яЁё]/.test(m.message)).map(([k]) => k);
  assert.deepStrictEqual(enCyr, [], "кириллица в английских текстах");
  const names = [MSG.ru.extShortName.message, MSG.en.extShortName.message];
  const ruEng = [];
  for (const [k, m] of Object.entries(MSG.ru)) {
    if (k === "extName" || k === "extShortName" || k === "uiLocale") continue;
    const words = m.message.replace(/\$[A-Za-z0-9_]+\$/g, "").replace(/\{\/?\w+\}/g, "").match(/[A-Za-z]{2,}/g) || [];
    const extra = words.filter((w) => !RU_ALLOWED.has(w));
    if (extra.length) ruEng.push(k + ": " + extra.join(","));
    // название — только в extName/extShortName (в остальных текстах оно подставляется плейсхолдером)
    for (const lang of ["ru", "en"]) for (const n of names) assert.ok(!MSG[lang][k].message.includes(n), `${lang}:${k} содержит название — нужна подстановка`);
  }
  assert.deepStrictEqual(ruEng, [], "английские слова в русских текстах");
  // в коде и разметке название не встречается; прежнего названия нет нигде
  for (const f of JS.concat(HTML, ["manifest.json"])) for (const n of names) assert.ok(!strip(read(f)).includes(n), f + " содержит название");
  const all = fs.readdirSync(EXT, { recursive: true }).filter((f) => /\.(js|html|css|json|md)$/.test(f));
  const old = all.filter((f) => read(f).includes("Cursor Translate"));
  assert.deepStrictEqual(old, [], "осталось прежнее название");
  ok(`английские тексты без кириллицы; в русских из английских слов — только ${[...RU_ALLOWED].slice(0, 8).join(", ")}…; название — только в extName/extShortName (4 строки в 2 файлах), «Cursor Translate» не осталось нигде (${all.length} файлов)`);
}

// ---- 5а. «абзац» и «paragraph» ----
{
  const bad = [];
  for (const lang of ["ru", "en"]) for (const [k, m] of Object.entries(MSG[lang])) if (/абзац|paragraph/i.test(m.message)) bad.push(lang + ":" + k);
  for (const f of HTML) {
    const vis = read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
    for (const m of vis.match(/>[^<]*(абзац|paragraph|párrafo)[^<]*</gi) || []) bad.push(f + ": " + m.slice(1, 60));
  }
  assert.deepStrictEqual(bad, [], "«абзац»/«paragraph» в видимых текстах");
  ok("в видимых текстах (сообщения ru/en, абзацы для пробы на трёх языках) нет «абзац», «paragraph», «párrafo»");
}

// ---- 6. manifest ----
{
  const man = JSON.parse(read("manifest.json"));
  assert.strictEqual(man.default_locale, "en");
  assert.strictEqual(man.minimum_chrome_version, "116");
  assert.strictEqual(man.name, "__MSG_extName__");
  assert.strictEqual(man.short_name, "__MSG_extShortName__");
  assert.strictEqual(man.action.default_title, "__MSG_extShortName__");
  for (const lang of ["en", "ru"]) assert.ok(MSG[lang].extName.message.length <= 75, lang + ": полное название длиннее 75");
  assert.ok(/^__MSG_\w+__$/.test(man.description) && Object.values(man.commands).every((c) => /^__MSG_\w+__$/.test(c.description)));
  for (const lang of ["en", "ru"]) assert.ok(MSG[lang].extDescription.message.length <= 132, lang + ": описание длиннее 132");
  assert.ok(fs.existsSync(path.join(EXT, "_locales/en/messages.json")) && fs.existsSync(path.join(EXT, "_locales/ru/messages.json")));
  ok(`manifest: default_locale en, minimum_chrome_version 116, name (полное, ≤ 75) / short_name / подсказка значка (короткое) / описание / команды — __MSG_…__; описание ${MSG.en.extDescription.message.length}/${MSG.ru.extDescription.message.length} знаков (≤ 132)`);
}

// ---- 7. языки ----
{
  const ctx = { chrome: { i18n: makeI18n("ru") }, console, Intl };
  vm.createContext(ctx);
  vm.runInContext(read("shared.js"), ctx);
  const r = (e) => vm.runInContext(e, ctx);
  const st = JSON.parse(r(`JSON.stringify((() => {
    const tgt = HT_TARGET_LANGS.map((x) => x[0]), src = HT_SOURCE_LANGS.map((x) => x[0]);
    const bad = [];
    for (const c of tgt.concat(src)) if (c !== "auto" && !HT_LANG_NAMES[c]) bad.push("нет английского имени: " + c);
    for (const c of tgt) if (!HT_deeplCode(c) && !HT_builtinCode(c)) bad.push("язык без переводчика: " + c);
    for (const c of src) if (c.includes("-")) bad.push("вариант в языках оригинала: " + c);
    if (JSON.stringify(HT_CHOICES.targetLang) !== JSON.stringify(tgt)) bad.push("HT_CHOICES.targetLang");
    if (JSON.stringify(HT_CHOICES.sourceLang) !== JSON.stringify(src)) bad.push("HT_CHOICES.sourceLang");
    for (const old of ["RU","EN-US","EN-GB","DE","FR","ES","IT","PT-PT","PT-BR","NL","PL","UK","TR","ZH","JA","KO"]) if (!tgt.includes(old)) bad.push("пропал прежний код " + old);
    for (const old of ["auto","EN","RU","DE","FR","ES","IT","PT","NL","PL","UK","TR","ZH","JA","KO"]) if (!src.includes(old)) bad.push("пропал прежний код оригинала " + old);
    const builtin = [...new Set(tgt.map(HT_builtinCode).filter(Boolean))].sort();
    return { bad, tgt: tgt.length, src: src.length - 1, deepl: tgt.filter(HT_deeplCode).length, builtin, both: tgt.filter((c) => HT_deeplCode(c) && HT_builtinCode(c)).length };
  })())`));
  assert.deepStrictEqual(st.bad, []);
  const CHROME_DOC = "ar bg bn cs da de el en es fi fr he hi hr hu id it ja kn ko lt mr nl no pl pt ro ru sk sl sv ta te th tr uk vi zh zh-Hant".split(" ").sort();
  assert.deepStrictEqual(st.builtin, CHROME_DOC, "коды встроенного — как в документации Chrome");
  ok(`языки: ${st.tgt} языков перевода (DeepL — ${st.deepl}, встроенный — ${st.builtin.length} кодов, оба — ${st.both}), ${st.src} языков оригинала; у каждого английское имя; HT_CHOICES совпадает со списками; прежние коды на месте`);
}

console.log(`\nВсе проверки пройдены: ${pass}`);
