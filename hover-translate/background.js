// background.js — service worker.
// Делает запросы к движкам перевода (ключи не видны странице, нет проблем с CORS):
//   • DeepL (HTML с сохранением тегов, formality, source_lang),
//   • LLM (OpenAI/Anthropic) — контекстный перевод HTML по промпту.
// Кэширует переводы: L1 (память) + L2 (storage.session) + L3 (storage.local, TTL).
// Считает статистику расхода, ограничивает расход ключа и отвечает content-скрипту и popup.

importScripts("shared.js"); // общие таблицы языков, движков и настроек (HT_*)

const CACHE = new Map();              // L1: быстрый кэш в памяти
const CACHE_MAX = 1000;
const CACHE_PREFIX = "htc:";          // L2: chrome.storage.session — переживает перезапуск SW,
                                      // отдельная квота, не конфликтует с настройками в local.
const LCACHE_PREFIX = "htlc:";        // L3: chrome.storage.local — переживает перезапуск браузера.
const LCACHE_TTL = 14 * 24 * 3600 * 1000; // 14 дней
const LCACHE_MAX = 5000;
// storage.local делит ~10 МБ квоты с настройками (unlimitedStorage мы не просим), а LCACHE_MAX
// считает ЗАПИСИ, не байты. Без байтового бюджета кэш переполнял квоту, после чего реджектился
// любой set() — включая запись настроек из popup, и ключ/язык молча терялись.
const LCACHE_MAX_BYTES = 4 * 1024 * 1024;
const LCACHE_MAX_ENTRY = 8 * 1024;    // одиночные гигантские записи в L3 не кладём
// Чистим с запасом от планки: если вытеснять ровно до лимита, первая же следующая запись снова
// его превышает и снова перечитывает весь storage.local — на заполненном L3 это происходило
// практически на каждом промахе кэша.
const LCACHE_LOW_WATER = 0.8;
const PRUNE_MIN_INTERVAL = 6 * 3600 * 1000; // не перечитываем весь storage.local на каждом пробуждении

// Единственное определение «байта» в файле: и бюджет L3, и разбивка запросов считают UTF-8,
// иначе кириллица и CJK недосчитываются в 2–3 раза и лимиты означают разное в разных местах.
const utf8 = new TextEncoder();
function utf8Bytes(s) { return utf8.encode(s == null ? "" : String(s)).length; }

// storage.session появился в Chrome 102. Без проверки модуль не вычислялся бы на старых версиях
// и service worker вообще не зарегистрировал бы обработчик сообщений.
const sessionArea = (chrome.storage && chrome.storage.session) || null;

// Прогрев L1 из L2 — ЛЕНИВЫЙ: воркер MV3 просыпается почти на каждом наведении, в том числе
// ради getStats или checkUsage, где кэш переводов не нужен, а get(null) десериализует всю
// сессионную область. Оба потребителя (translateMany, clearCache) и так его await-ят.
let cacheReady = null;
function ensureCache() {
  if (!cacheReady) {
    cacheReady = sessionArea
      ? sessionArea.get(null).then((all) => {
          for (const k in all) if (k.startsWith(CACHE_PREFIX)) CACHE.set(k, all[k]);
        }).catch(() => {})
      : Promise.resolve();
  }
  return cacheReady;
}

// ---- статистика расхода ----
const stats = { chars: 0, hits: 0, saved: 0 }; // символов отправлено в API / попаданий кэша / символов из кэша
let statsTimer = null;
let statsLoaded = false;              // сохранённые значения уже учтены (или намеренно сброшены)

function persistStats() {
  if (statsTimer) return;             // троттлинг записи (раз в ~1.5 с)
  statsTimer = setTimeout(() => {
    statsTimer = null;
    chrome.storage.local.set({ statChars: stats.chars, statHits: stats.hits, statSaved: stats.saved }).catch(() => {});
  }, 1500);
}
function countHit(text) { stats.hits++; stats.saved += (text || "").length; persistStats(); }
function countMiss(len) { stats.chars += len; persistStats(); }

function cacheGet(key) {
  return CACHE.get(CACHE_PREFIX + key);
}

function cacheSet(key, value) {
  const k = CACHE_PREFIX + key;
  CACHE.set(k, value);
  if (sessionArea) sessionArea.set({ [k]: value }).catch(() => {});
  if (CACHE.size > CACHE_MAX) {        // вытесняем самый старый (FIFO)
    const oldest = CACHE.keys().next().value;
    CACHE.delete(oldest);
    if (sessionArea) sessionArea.remove(oldest).catch(() => {});
  }
}

// ---- L3: персистентный кэш (storage.local) — всегда включён: переводы переживают
// перезапуск браузера (TTL 14 дней). Бюджет — и по записям, и по байтам. ----
function lcacheKeyOf(key) { return LCACHE_PREFIX + key; }
// Объём записи: ключ + значение + обвязка JSON вокруг { v, t }.
function lcacheBytesOf(fullKey, value) { return utf8Bytes(fullKey) + utf8Bytes(value) + 32; }

let lcacheBytes = -1;                 // -1 — объём ещё не измерен (посчитает pruneLcache)
let lcachePausedUntil = 0;            // квота переполнена — временно не пишем в L3

// Пакетное чтение L3 по промаху L1/L2: ОДИН storage-вызов на весь батч. Поштучный await на
// каждый текст давал 100–200 последовательных IPC до того, как уйдёт первый сетевой запрос.
// Просроченное снимаем одним remove и считаем промахом.
async function lcacheGetMany(keys) {
  const out = new Map();
  if (!keys.length) return out;
  const full = keys.map(lcacheKeyOf);
  try {
    const obj = await chrome.storage.local.get(full);
    const now = Date.now();
    const stale = [];
    for (let i = 0; i < keys.length; i++) {
      const rec = obj[full[i]];
      if (!rec) continue;
      // битые записи без числового .t тоже считаем просроченными (иначе now-undefined=NaN их «вечнит»)
      if (typeof rec.t !== "number" || now - rec.t > LCACHE_TTL) { stale.push(full[i]); continue; }
      out.set(keys[i], rec.v);
    }
    if (stale.length) chrome.storage.local.remove(stale).catch(() => {});
  } catch (e) { /* L3 недоступен — считаем промахом */ }
  return out;
}

// Пакетная запись L3: один set на весь батч вместо N транзакций (каждая из которых ещё и могла
// дёрнуть чистку).
async function lcacheSetMany(pairs /* [[key, value]] */) {
  if (Date.now() < lcachePausedUntil || !pairs.length) return;
  const obj = {};
  const t = Date.now();
  let added = 0;
  for (const [key, value] of pairs) {
    const k = lcacheKeyOf(key);
    const bytes = lcacheBytesOf(k, value);
    if (bytes > LCACHE_MAX_ENTRY) continue;     // такие записи почти не переиспользуются
    obj[k] = { v: value, t };
    added += bytes;
  }
  if (!added) return;
  try {
    await chrome.storage.local.set(obj);
    if (lcacheBytes >= 0) lcacheBytes += added;
    if (lcacheBytes > LCACHE_MAX_BYTES) pruneLcache(); // чистим ПО ЗАПИСИ, а не только по будильнику
  } catch (e) {
    // Квота: пауза + немедленная чистка. Молча игнорировать нельзя — следом реджектится и
    // запись настроек из popup, и пользователь теряет ключ, не увидев ошибки.
    lcachePausedUntil = Date.now() + 60000;
    pruneLcache();
  }
}

// Чистка просроченных и лишних записей L3. Один прогон за раз (иначе параллельные вызовы
// читают весь storage.local одновременно).
let pruning = null;
function pruneLcache() {
  if (pruning) return pruning;
  pruning = (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(LCACHE_PREFIX));
      const now = Date.now();
      const remove = new Set(keys.filter((k) => !all[k] || typeof all[k].t !== "number" || now - all[k].t > LCACHE_TTL));
      // Живые — от старых к новым; вытесняем, пока не влезем И в лимит записей, И в байтовый бюджет.
      const live = keys.filter((k) => !remove.has(k)).sort((a, b) => all[a].t - all[b].t);
      let bytes = 0;
      for (const k of live) bytes += lcacheBytesOf(k, all[k].v);
      let count = live.length;
      const maxCount = Math.floor(LCACHE_MAX * LCACHE_LOW_WATER);
      const maxBytes = Math.floor(LCACHE_MAX_BYTES * LCACHE_LOW_WATER);
      for (let i = 0; i < live.length && (count > maxCount || bytes > maxBytes); i++) {
        remove.add(live[i]);
        bytes -= lcacheBytesOf(live[i], all[live[i]].v);
        count--;
      }
      if (remove.size) await chrome.storage.local.remove([...remove]);
      lcacheBytes = bytes;
      // Сохраняем и объём: следующий старт воркера возьмёт его отсюда и не станет обмерять
      // хранилище отдельным вызовом.
      await chrome.storage.local.set({ htPrunedAt: Date.now(), htLcacheBytes: bytes }).catch(() => {});
    } catch (e) { /* игнорируем */ }
    pruning = null;
  })();
  return pruning;
}

// Единственное чтение storage.local при старте воркера: статистика, объём L3 и отметка о
// последней чистке — тремя отдельными get это было три IPC на каждое пробуждение.
const startupReady = chrome.storage.local
  .get({ statChars: 0, statHits: 0, statSaved: 0, htPrunedAt: 0, htLcacheBytes: -1 })
  .then((s) => {
    // Прибавляем, а не присваиваем: счётчики, набежавшие до загрузки, иначе затирались бы
    // (а сброс статистики — наоборот, откатывался бы к прежним значениям).
    if (!statsLoaded) {
      statsLoaded = true;
      stats.chars += s.statChars || 0;
      stats.hits += s.statHits || 0;
      stats.saved += s.statSaved || 0;
    }
    if (lcacheBytes < 0) lcacheBytes = typeof s.htLcacheBytes === "number" ? s.htLcacheBytes : -1;
    // Чистка читает весь storage.local, поэтому не чаще раза в 6 часов.
    if (Date.now() - (s.htPrunedAt || 0) >= PRUNE_MIN_INTERVAL) pruneLcache();
  })
  .catch(() => {});

// alarms.create с тем же именем ЗАМЕНЯЕТ будильник и заново запускает отсчёт. Воркер стартует
// намного чаще, чем раз в 720 минут, поэтому периодический будильник так не срабатывал никогда —
// создаём его только если его ещё нет.
chrome.alarms?.get?.("htPruneLcache", (a) => {
  if (!a) chrome.alarms.create("htPruneLcache", { delayInMinutes: 60, periodInMinutes: 720 });
});
chrome.alarms?.onAlarm?.addListener?.((a) => { if (a.name === "htPruneLcache") pruneLcache(); });

// Бесплатные ключи DeepL оканчиваются на ":fx" (эндпоинт api-free), платные — api.deepl.com.
function deeplBase(key) {
  return key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}

// Ключ кэша: scope (движок|язык|формальность|источник|термины[|доп. поля движка]) + текст.
// Разные движки/настройки дают разный перевод → не путаем их в кэше.
function ckey(scope, s) {
  return `${scope}\n${s.replace(/\s+/g, " ").trim()}`;
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
// Хэшируем список «не переводить» РОВНО в том порядке, в котором из него собирается регексп
// wrapNoTranslate: альтернация — first-match-wins, порядок влияет на результат. Сортировка только
// внутри хэша давала один ключ кэша для двух разных переводов. Канонический порядок задаёт
// parseTerms, поэтому здесь просто join.
function termsKey(terms) {
  return terms && terms.length ? hashStr(terms.join("\n")) : "-";
}
function scopeOf(o) {
  // Имя ветки кэша и её дополнительные поля берём из таблицы движков (shared.js), а не из if-ов
  // по имени: auto переводит через DeepL, поэтому кэшируется как deepl (иначе один и тот же
  // текст хранился бы дважды); у LLM в scope дополнительно входят провайдер, модель и origin
  // страницы — провайдер с моделью меняют перевод, а origin разделяет ветки, потому что LLM
  // исполняет инструкции из переводимого текста и prompt-инъекция на одном сайте не должна
  // подменять перевод одноимённых строк на другом.
  const e = HT_engine(o.engine);
  const parts = [e.cacheAs || e.code, o.targetLang, o.formality || "default", o.sourceLang || "auto", termsKey(o.terms)];
  for (const f of e.scopeFields || []) parts.push(o[f] || "-");
  return parts.join("|");
}

// Retry-After: число секунд или HTTP-дата. Возвращает мс ожидания или fallback.
function retryAfterMs(header, fallback) {
  if (!header) return fallback;
  const secs = parseFloat(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? fallback : Math.max(0, date - Date.now());
}

// fetch с ретраями на 429/5xx и на брошенных сетевых ошибках (transient): учитываем Retry-After
// (секунды или HTTP-дата), иначе экспоненциальный backoff. Общий для DeepL и LLM — LLM-ветка
// раньше ходила голым fetch и падала на первом же 429.
async function fetchRetry(url, options, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      if (attempt >= maxRetries) throw e; // сеть так и не поднялась — пусть обработает вызывающий
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
      continue;
    }
    if ((res.status !== 429 && res.status < 500) || attempt >= maxRetries) return res;
    const waitMs = retryAfterMs(res.headers.get("Retry-After"), 600 * Math.pow(2, attempt));
    if (waitMs > 10000) return res; // ждать слишком долго — отдаём ответ как есть
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Настройки, нужные только service worker: ключи API и параметры LLM. Дефолты — из общей таблицы.
const ENGINE_SETTINGS = {
  apiKey: "", llmApiKey: "",
  llmProvider: HT_DEFAULTS.llmProvider, llmModel: HT_DEFAULTS.llmModel,
};
function getSettings() { return chrome.storage.local.get(ENGINE_SETTINGS); }

// ---- бюджет расхода: страница не должна уметь бесконечно тратить ключ пользователя ----
// Ось — КТО инициировал перевод (см. HT_BY_PAGE / HT_BY_USER в shared.js), а не «наведение или
// страница»: смена языка перетранслирует и hover-строки, но инициировал её пользователь.
// Считаем только фактические промахи кэша, то есть реально оплачиваемые символы.
const BUDGETS = {
  [HT_BY_PAGE]: { windowMs: 60000, maxChars: 60000, maxReqs: 60 },
  [HT_BY_USER]: { windowMs: 60000, maxChars: 800000, maxReqs: 300 },
};
const budgets = new Map(); // "origin|кто" -> { start, chars, reqs }

function budgetTake(origin, by, chars) {
  // Поле пришло сообщением, поэтому проверяем его, а не доверяем: неизвестное значение —
  // по строгому лимиту.
  const kind = BUDGETS[by] ? by : HT_BY_PAGE;
  const cfg = BUDGETS[kind];
  const now = Date.now();
  if (budgets.size > 200) {            // не даём карте расти бесконечно по числу посещённых сайтов
    for (const [key, b] of budgets) if (now - b.start > 3600000) budgets.delete(key);
  }
  const k = (origin || "-") + "|" + kind;
  let b = budgets.get(k);
  if (!b || now - b.start > cfg.windowMs) { b = { start: now, chars: 0, reqs: 0 }; budgets.set(k, b); }
  if (b.reqs >= cfg.maxReqs || b.chars + chars > cfg.maxChars) {
    return "Лимит перевода для этого сайта исчерпан — подождите минуту (защита от перерасхода ключа).";
  }
  b.reqs++; b.chars += chars;
  return null;
}

// ---- «не переводить»: оборачиваем слова в <x>…</x>, чтобы движок их не трогал ----
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Регексп поиска тегов — один на модуль: он строился заново на каждый текст батча, а батч это
// сотни узлов. Позицию сбрасываем перед проходом, так как флаг /g её запоминает.
const TAG_RE = /<!--[\s\S]*?-->|<[a-zA-Z!/][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;

// Применяем fn только к текстовым кускам HTML (вне тегов), чтобы не портить разметку.
// Кавычки в значениях атрибутов учитываем — иначе '>' внутри <a title="a>b"> рвал бы тег.
function mapHtmlText(html, fn) {
  TAG_RE.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = TAG_RE.exec(html))) {
    if (m.index > last) out += fn(html.slice(last, m.index)); // текст до тега
    out += m[0];                                              // сам тег — не трогаем
    last = TAG_RE.lastIndex;
  }
  if (last < html.length) out += fn(html.slice(last));        // хвост
  return out;
}

// Регексп собирается из пользовательского ввода, поэтому строим его в try: на предельных списках
// RegExp может не скомпилироваться, и раньше это исключение летело МИМО try вокруг fetch —
// обработчик сообщения не отвечал вообще, и content-скрипт зависал навсегда.
// Кэшируем ПО ССЫЛКЕ на массив: parseTerms возвращает новый массив на каждый запрос, поэтому
// сравнение точное и стоит O(1), а склейка списка (до ~20 КБ) больше не делается на каждый текст.
let reCache = { terms: null, re: null };
function noTranslateRe(terms) {
  if (!terms || !terms.length) return null;
  if (reCache.terms === terms) return reCache.re;
  let re = null;
  try {
    re = new RegExp("(?<![\\p{L}\\p{N}])(" + terms.map(escapeRe).join("|") + ")(?![\\p{L}\\p{N}])", "giu");
  } catch (e) { re = null; }           // не скомпилировался — просто не оборачиваем термины
  reCache = { terms, re };
  return re;
}

function wrapNoTranslate(html, terms) {
  const re = noTranslateRe(terms);
  if (!re) return html;
  return mapHtmlText(html, (t) => t.replace(re, "<x>$1</x>"));
}
function stripNoTranslate(s) { return typeof s === "string" ? s.replace(/<\/?x>/g, "") : s; }

const TERMS_MAX = 200;
const TERM_MAX_LEN = 100;             // «термин» длиннее строки — это не термин, а раздутый регексп

function parseTerms(raw) {
  // Отбрасываем термины с < > & — они ломают обёртку <x>…</x> и разбивку HTML по тегам;
  // в видимом тексте такие символы всё равно приходят экранированными сущностями.
  const seen = new Set();
  const out = [];
  for (const s of (raw || "").split(/[\n,]+/)) {
    const t = s.trim();
    if (!t || t.length > TERM_MAX_LEN || /[<>&]/.test(t)) continue;
    const low = t.toLowerCase();      // регексп регистронезависимый — дубли по регистру бесполезны
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(t);
    if (out.length >= TERMS_MAX) break;
  }
  // Длинные вперёд: альтернация берёт ПЕРВОЕ совпадение, поэтому «Node» раньше «Node.js» съедал
  // префикс (замыкающий lookahead проходит на точке) и «.js» уходило движку на перевод. Порядок
  // канонический, поэтому и ключ кэша не зависит от порядка ввода в textarea.
  out.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// ---- разбивка батча (общая для обоих сетевых движков) ----
// Меру размера задаёт вызывающий: DeepL ограничен байтами тела запроса, LLM — символами, от
// которых зависит max_tokens. Раньше у каждого движка был свой экземпляр этого цикла.
function chunkBy(texts, maxTexts, maxSize, sizeOf) {
  const groups = [];
  let cur = [], curSize = 0;
  for (const t of texts) {
    const n = sizeOf(t);
    if (cur.length && (cur.length >= maxTexts || curSize + n > maxSize)) {
      groups.push(cur); cur = []; curSize = 0;
    }
    cur.push(t); curSize += n;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Прогнать батч группами и склеить. При сбое отдаём и ошибку, И уже полученные переводы: они
// оплачены, вызывающий положит их в кэш — иначе повторная попытка заплатит за них второй раз.
async function runChunks(texts, maxTexts, maxSize, sizeOf, fn) {
  const groups = chunkBy(texts, maxTexts, maxSize, sizeOf);
  if (groups.length <= 1) return fn(texts);
  const outTexts = [], outSrc = [];
  for (const g of groups) {
    const r = await fn(g);
    if (!r.ok) return { ok: false, error: r.error, texts: outTexts, srcLangs: outSrc };
    outTexts.push(...r.texts);
    outSrc.push(...r.srcLangs);
  }
  return { ok: true, texts: outTexts, srcLangs: outSrc };
}

// ---- DeepL ----
function deeplBody(texts, o) {
  const body = { text: texts, target_lang: o.targetLang, tag_handling: "html" };
  if (o.sourceLang && o.sourceLang !== "auto") body.source_lang = o.sourceLang;
  if (o.formality && o.formality !== "default") body.formality = "prefer_" + o.formality; // more|less → prefer_more|prefer_less
  if (o.terms && o.terms.length) body.ignore_tags = ["x"];
  return body;
}

function deeplAuth(key) { return { "Authorization": `DeepL-Auth-Key ${key}` }; }

function deeplErr(status) {
  const hint =
    status === 403 ? " (неверный ключ?)" :
    status === 413 ? " (слишком большой запрос)" :
    status === 456 ? " (исчерпана квота символов)" :
    status === 429 ? " (слишком много запросов)" : "";
  return `DeepL ${status}${hint}`;
}

// DeepL принимает не более 50 параметров text И не более 128 KiB тела запроса. Узловой перевод
// даёт батчи крупнее, а для кириллицы/CJK символ занимает 2–3 байта, поэтому режем и по
// количеству, и по фактическому объёму.
const DEEPL_MAX_TEXTS = 45;
const DEEPL_MAX_BYTES = 96 * 1024;
const deeplSize = (t) => utf8Bytes(t) + 8;   // + обвязка JSON вокруг строки

function deeplTranslateChunked(texts, o, apiKey) {
  return runChunks(texts, DEEPL_MAX_TEXTS, DEEPL_MAX_BYTES, deeplSize, (g) => deeplTranslateMany(g, o, apiKey));
}

// Перевод массива текстов DeepL → { ok, texts:[], srcLangs:[] } | { ok:false, error }.
async function deeplTranslateMany(texts, o, apiKey) {
  const wrapped = texts.map((t) => wrapNoTranslate(t, o.terms));
  let res;
  try {
    res = await fetchRetry(`${deeplBase(apiKey)}/v2/translate`, {
      method: "POST",
      headers: Object.assign(deeplAuth(apiKey), { "Content-Type": "application/json" }),
      body: JSON.stringify(deeplBody(wrapped, o)),
    });
  } catch (e) {
    return { ok: false, error: `Сеть: ${e.message}` };
  }
  if (!res.ok) return { ok: false, error: deeplErr(res.status) };
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: "Не удалось разобрать ответ DeepL." }; }
  // Длину проверяем обязательно: короткий ответ сдвинул бы все последующие чанки и записал в L3
  // на 14 дней пары «исходник A ↔ перевод B». В LLM-ветке от этого защищает coerceArr.
  if (!data || !Array.isArray(data.translations) || data.translations.length !== texts.length) {
    return { ok: false, error: "Неожиданный ответ DeepL." };
  }
  // Снимаем обёртку <x> только если сами её ставили (есть термины) — иначе можно стереть
  // легитимные литералы <x>/</x> из исходного текста.
  const strip = o.terms && o.terms.length;
  return {
    ok: true,
    texts: data.translations.map((t) => { const v = t ? t.text : ""; return strip ? stripNoTranslate(v) : v; }),
    srcLangs: data.translations.map((t) => (t && t.detected_source_language ? t.detected_source_language.toLowerCase() : null)),
  };
}

// ---- LLM (OpenAI / Anthropic) ----
function langName(code) { return HT_LANG_NAMES[code] || code; }

const LLM_DEFAULT_MODEL = { openai: "gpt-4o-mini", anthropic: "claude-haiku-4-5-20251001" };
function llmModelOf(provider, model) { return model || LLM_DEFAULT_MODEL[provider] || LLM_DEFAULT_MODEL.openai; }
function llmErr(status) { return `LLM ${status}${status === 401 ? " (ключ?)" : ""}`; }
// Anthropic требует версию API и явное разрешение прямого доступа из браузерного контекста.
function llmHeaders(provider, key) {
  return provider === "anthropic"
    ? {
        "x-api-key": key, "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true", "Content-Type": "application/json",
      }
    : { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
}

function llmSystemPrompt(o) {
  const lines = [
    `You are a professional translation engine. Translate each HTML string from the input array into ${langName(o.targetLang)}.`,
    o.sourceLang && o.sourceLang !== "auto" ? `The source language is ${langName(o.sourceLang)}.` : "Auto-detect the source language of each string.",
    "Preserve ALL HTML tags, attributes and structure exactly; translate only the human-readable text.",
    "Translate naturally and idiomatically, keeping the original meaning and register.",
    "Do NOT translate: code, URLs, e-mail addresses, or text inside <x>…</x> tags (keep such text verbatim, but remove the <x> and </x> tags from the output).",
  ];
  if (o.terms && o.terms.length) lines.push(`Also keep these terms unchanged: ${o.terms.join(", ")}.`);
  lines.push('Return ONLY a JSON object of the form {"translations": ["...", "..."]} with exactly the same number of strings, in the same order. No commentary.');
  return lines.join(" ");
}

// Сбалансированный JSON-фрагмент, начинающийся с открывающей скобки на позиции start
// (учитывает строки и экранирование, поэтому скобки внутри строк не сбивают глубину).
function balancedSpan(str, start) {
  const open = str[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return str.slice(start, i + 1);
  }
  return null;
}

function coerceArr(parsed, expected) {
  const arr = Array.isArray(parsed) ? parsed : (parsed && (parsed.translations || parsed.result || parsed.texts));
  if (!Array.isArray(arr) || arr.length !== expected) return null;
  return arr.map((s) => (typeof s === "string" ? s : String(s == null ? "" : s)));
}

// Достаём валидный JSON из ответа LLM: пробуем прямой парс, затем перебираем каждый
// сбалансированный скобочный фрагмент (пропуская «прозу» и ложные скобки вроде "[см. ниже]").
function parseLlmJson(content, expected) {
  try { const direct = coerceArr(JSON.parse(content), expected); if (direct) return direct; } catch (e) { /* пробуем фрагменты */ }
  for (let from = 0; from < content.length; ) {
    const rel = content.slice(from).search(/[[{]/);
    if (rel < 0) break;
    const start = from + rel;
    const span = balancedSpan(content, start);
    if (!span) { from = start + 1; continue; }
    try { const got = coerceArr(JSON.parse(span), expected); if (got) return got; } catch (e) { /* следующий фрагмент */ }
    from = start + span.length;
  }
  return null;
}

// Ответ примерно той же длины, что и вход, а max_tokens ограничен (raw fetch без стриминга —
// большие значения рискуют таймаутом), поэтому батч режем по суммарной длине в символах.
const LLM_CHUNK_CHARS = 12000;
const LLM_MAX_TOKENS = 16000;
const llmSize = (t) => (t || "").length;

function llmTranslateMany(texts, o, key, provider, model) {
  return runChunks(texts, Infinity, LLM_CHUNK_CHARS, llmSize, (g) => llmTranslateChunk(g, o, key, provider, model));
}

async function llmTranslateChunk(texts, o, key, provider, model) {
  const sys = llmSystemPrompt(o);
  const user = JSON.stringify(texts);
  // Даём щедрый запас (≈1 токен на символ ввода — безопасно и для CJK/многословных целевых
  // языков). Если запас не влезает в потолок, ответ гарантированно обрежется и JSON не
  // распарсится: отказываем ДО вызова API, чтобы не платить за заведомо мусорный ответ.
  const want = Math.max(2048, user.length);
  if (want > LLM_MAX_TOKENS) {
    return { ok: false, error: "Фрагмент слишком велик для LLM — выберите DeepL или переводите частями." };
  }
  const anthropic = provider === "anthropic";
  const model_ = llmModelOf(provider, model);
  const body = anthropic
    ? { model: model_, max_tokens: want, system: sys, messages: [{ role: "user", content: user }] }
    : {
        model: model_, temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      };
  let d;
  try {
    const res = await fetchRetry(anthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: llmHeaders(provider, key),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: llmErr(res.status) };
    d = await res.json();
  } catch (e) {
    return { ok: false, error: `Сеть LLM: ${e.message}` };
  }
  const content = anthropic
    ? (d && d.content && d.content[0] ? d.content[0].text : "")
    : (d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : "");
  let arr = parseLlmJson(content || "", texts.length);
  if (!arr) return { ok: false, error: "LLM вернул неожиданный формат." };
  // Снимаем обёртку <x> только если сами её ставили (есть термины).
  if (o.terms && o.terms.length) arr = arr.map(stripNoTranslate);
  return { ok: true, texts: arr, srcLangs: texts.map(() => null) };
}

// ---- унифицированный батч-перевод с кэшем ----
async function translateMany(items, o, origin) {
  await ensureCache();
  o.terms = parseTerms(o.noTranslate);
  o.origin = origin || "";
  const e = HT_engine(o.engine);
  if (e.via === "local") return { ok: false, error: "Этот движок работает только на странице." };

  // Настройки, входящие в ключ кэша (для LLM — провайдер и модель), читаем ДО вычисления scope:
  // иначе смена модели 14 дней отдавала бы перевод прежней и настройка выглядела нерабочей.
  let s = null;
  const scopeSettings = (e.scopeFields || []).filter((f) => f in ENGINE_SETTINGS);
  if (scopeSettings.length) {
    s = await getSettings();
    for (const f of scopeSettings) o[f] = s[f] || HT_DEFAULTS[f] || "";
  }
  const scope = scopeOf(o);

  const results = new Array(items.length);
  const srcOut = new Array(items.length);
  const need = new Map();  // уникальный текст -> [индексы] (дедуп внутри батча)
  const keys = new Map();  // уникальный текст -> ключ кэша

  for (let i = 0; i < items.length; i++) {
    const clean = (items[i] || "").trim();
    if (!clean) { results[i] = ""; continue; }
    if (!need.has(clean)) { need.set(clean, []); keys.set(clean, ckey(scope, clean)); }
    need.get(clean).push(i);
  }

  const fill = (text, value) => { for (const i of need.get(text)) { results[i] = value; countHit(text); } };

  // L1/L2 — синхронно, из памяти. Всё, что не нашлось, добираем ОДНИМ чтением L3.
  let missTexts = [];
  for (const text of need.keys()) {
    const hit = cacheGet(keys.get(text));
    if (hit !== undefined) fill(text, hit); else missTexts.push(text);
  }
  if (missTexts.length) {
    const l3 = await lcacheGetMany(missTexts.map((t) => keys.get(t)));
    if (l3.size) {
      const still = [];
      for (const text of missTexts) {
        const hit = l3.get(keys.get(text));
        if (hit === undefined) { still.push(text); continue; }
        cacheSet(keys.get(text), hit);   // промоутим в L1/L2
        fill(text, hit);
      }
      missTexts = still;
    }
  }

  if (missTexts.length) {
    const denied = budgetTake(o.origin, o.by, missTexts.reduce((n, t) => n + t.length, 0));
    if (denied) return { ok: false, error: denied };
    if (!s) s = await getSettings();
    if (e.keyField && !s[e.keyField]) return { ok: false, error: HT_KEY_HINTS[e.keyField] };
    const r = e.via === "llm"
      ? await llmTranslateMany(missTexts, o, s.llmApiKey, s.llmProvider, s.llmModel)
      : await deeplTranslateChunked(missTexts, o, s.apiKey);
    // Пришедшие переводы раскладываем всегда, даже если часть чанков упала: они уже оплачены.
    if (Array.isArray(r.texts) && r.texts.length) {
      store(missTexts.slice(0, r.texts.length), r, keys, need, results, srcOut);
    }
    if (!r.ok) return { ok: false, error: r.error };
  }

  return { ok: true, texts: results, srcLangs: srcOut };
}

// Раскладываем ответ движка по кэшу и по слотам результата, считая фактический расход.
function store(texts, r, keys, need, results, srcOut) {
  const pairs = [];
  let billed = 0;
  for (let j = 0; j < texts.length; j++) {
    const text = texts[j];
    const out = r.texts[j] || "";
    const src = r.srcLangs ? r.srcLangs[j] : null;
    billed += text.length;
    if (out) { const key = keys.get(text); cacheSet(key, out); pairs.push([key, out]); }
    for (const idx of need.get(text)) { results[idx] = out; srcOut[idx] = src; }
  }
  lcacheSetMany(pairs);              // одна запись в L3 на весь батч
  if (billed) countMiss(billed);
}

// Полная очистка кэша переводов (память + storage.session + storage.local L3).
async function clearCache() {
  // Ждём прогрев L1 обязательно: на холодном воркере (а кнопка «Очистить кэш» его и поднимает)
  // CACHE.size был бы 0, CACHE.clear() — no-op, и загрузка тут же залила бы кэш обратно в память.
  await ensureCache();
  const cleared = CACHE.size;
  CACHE.clear();
  if (sessionArea) {
    try {
      const all = await sessionArea.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      if (keys.length) await sessionArea.remove(keys);
    } catch (e) { /* игнорируем */ }
  }
  try {
    const all = await chrome.storage.local.get(null);
    const lkeys = Object.keys(all).filter((k) => k.startsWith(LCACHE_PREFIX));
    if (lkeys.length) await chrome.storage.local.remove(lkeys);
    lcacheBytes = 0;
    lcachePausedUntil = 0;
    await chrome.storage.local.set({ htLcacheBytes: 0 }).catch(() => {});
  } catch (e) { /* игнорируем */ }
  return { ok: true, cleared };
}

// Проверка ключа и остаток квоты символов через /v2/usage.
async function checkUsage() {
  const { apiKey } = await getSettings();
  if (!apiKey) return { ok: false, error: "Нет ключа." };
  try {
    const res = await fetch(`${deeplBase(apiKey)}/v2/usage`, { headers: deeplAuth(apiKey) });
    if (!res.ok) {
      const hint = res.status === 403 ? " — проверьте ключ" : "";
      return { ok: false, error: `DeepL ${res.status}${hint}` };
    }
    const d = await res.json();
    return { ok: true, used: d.character_count, limit: d.character_limit };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Лёгкая проверка LLM-ключа (OpenAI — список моделей; Anthropic — короткий ответ).
async function checkLlm() {
  const { llmApiKey, llmProvider, llmModel } = await getSettings();
  if (!llmApiKey) return { ok: false, error: "Нет ключа LLM." };
  try {
    const res = llmProvider === "anthropic"
      ? await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: llmHeaders(llmProvider, llmApiKey),
          body: JSON.stringify({ model: llmModelOf(llmProvider, llmModel), max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        })
      : await fetch("https://api.openai.com/v1/models", { headers: llmHeaders(llmProvider, llmApiKey) });
    return res.ok ? { ok: true } : { ok: false, error: llmErr(res.status) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Порт держим открытым (return true), поэтому ЛЮБОЙ реджект обязан дойти до sendResponse:
// молчание подвешивает content-скрипт навсегда (ht-loading не снимается, owner остаётся в
// inFlight, перевод страницы встаёт посреди страницы и не создаёт IntersectionObserver).
function reply(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || "Внутренняя ошибка расширения" }));
  return true;
}

function originOf(sender) {
  if (sender && sender.origin) return sender.origin;
  try { return sender && sender.url ? new URL(sender.url).origin : ""; } catch (e) { return ""; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  // Одиночного пути нет намеренно: перевод одного элемента — это батч из одного элемента,
  // иначе вся политика движков (выбор, фолбэк, обработка ошибок) жила бы в двух копиях.
  if (msg.type === "translateBatch") {
    return reply(translateMany(msg.items || [], msg, originOf(sender)), sendResponse);
  }
  if (msg.type === "checkUsage") return reply(checkUsage(), sendResponse);
  if (msg.type === "checkLlm") return reply(checkLlm(), sendResponse);
  if (msg.type === "clearCache") return reply(clearCache(), sendResponse);
  if (msg.type === "getStats") {
    // Ждём загрузку счётчиков: на холодном воркере иначе уходят нули.
    return reply(startupReady.then(() => ({ ok: true, chars: stats.chars, hits: stats.hits, saved: stats.saved })), sendResponse);
  }
  if (msg.type === "resetStats") {
    statsLoaded = true;                 // не даём отложенной загрузке вернуть прежние значения
    stats.chars = 0; stats.hits = 0; stats.saved = 0;
    return reply(chrome.storage.local.set({ statChars: 0, statHits: 0, statSaved: 0 }).then(() => ({ ok: true })), sendResponse);
  }
});
