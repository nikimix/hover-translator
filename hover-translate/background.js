// background.js — service worker.
// Делает запросы к движкам перевода (ключи не видны странице, нет проблем с CORS):
//   • DeepL (HTML с сохранением тегов, formality, source_lang),
//   • LLM (OpenAI/Anthropic) — контекстный перевод HTML по промпту.
// Текст отправляет только с согласия человека на этот сервис (storage.local.consent, см. shared.js).
// Кэширует переводы: L1 (память) + L2 (storage.session) + L3 (storage.local, TTL).
// Считает статистику расхода, ограничивает расход ключа и отвечает content-скрипту и popup.
// Показывает на значке, что перевод выключен или не может работать; при установке открывает
// страницу приветствия. Обрабатывает горячие клавиши (chrome.commands).

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
// Суточный счётчик лимита по инициативе страницы (см. PAGE_DAY_MAX): загружается в startupReady,
// пишется вместе со статистикой в persistStats.
let pageDay = { day: "", chars: 0 };

function persistStats() {
  if (statsTimer) return;             // троттлинг записи (раз в ~1.5 с)
  statsTimer = setTimeout(() => {
    statsTimer = null;
    const rec = { statChars: stats.chars, statHits: stats.hits, statSaved: stats.saved };
    // Суточный счётчик лимита (см. PAGE_DAY_MAX) пишем той же записью, а не отдельной: каждая
    // запись в storage.local будит onChanged во всех фреймах всех вкладок. Пустой day — счётчик
    // ещё не загружен и не трогался, затирать сохранённый нельзя.
    if (pageDay.day) rec.htPageDay = pageDay;
    chrome.storage.local.set(rec).catch(() => {});
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
  .get({ statChars: 0, statHits: 0, statSaved: 0, htPrunedAt: 0, htLcacheBytes: -1, htPageDay: null })
  .then((s) => {
    // Суточный счётчик лимита: translateMany ждёт startupReady до budgetTake, поэтому к этому
    // моменту в памяти он ещё не менялся и его можно просто подставить.
    const pd = s.htPageDay;
    if (pd && typeof pd.day === "string" && typeof pd.chars === "number" && !pageDay.day) pageDay = { day: pd.day, chars: pd.chars };
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

// Неудача для вызывающего: error — что сказать человеку простыми словами (на языке интерфейса); code — вид сбоя (по нему
// content решает, перевести ли встроенным переводчиком и какую кнопку предложить в уведомлении);
// detail — код ответа и текст сервиса, их показываем мелко под сообщением.
// Коды: no-key, no-consent (человек не разрешил отправлять текст этому сервису), bad-key, quota
// (месячный лимит DeepL), money (на счёте ИИ нет денег), rate (429), server (5xx), network, timeout,
// too-big, model, denied, cut, refused (ИИ отказался переводить), bad-response, lang (переводчик не знает
// выбранный язык), limit (наш лимит), other.
function failure(code, error, detail) { return { ok: false, code, error, detail: detail || "" }; }

// Retry-After: число секунд или HTTP-дата. Возвращает мс ожидания или fallback.
function retryAfterMs(header, fallback) {
  if (!header) return fallback;
  const secs = parseFloat(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? fallback : Math.max(0, date - Date.now());
}

// Тайм-ауты запросов. Без них подвисшее соединение навсегда оставило бы «загрузку» на странице и
// остановило перевод страницы на полпути. Предел — меньше 30 с: Chrome завершает service
// worker, если ответ на fetch идёт дольше. DeepL отвечает за секунды; ИИ генерирует ответ целиком
// (без потока), поэтому ему больше времени и меньше кусок текста (см. LLM_CHUNK_CHARS).
const DEEPL_TIMEOUT_MS = 15000;
const LLM_TIMEOUT_MS = 25000;

// Кроме тайм-аута запросы никто не обрывает, поэтому AbortError (старые версии Chrome отдают его
// вместо причины обрыва) — тоже тайм-аут.
function isTimeout(e) { return !!e && (e.name === "TimeoutError" || e.name === "AbortError"); }

// fetch с ретраями на 429/5xx и на брошенных сетевых ошибках (transient): учитываем Retry-After
// (секунды или HTTP-дата), иначе экспоненциальный backoff. Общий для DeepL и LLM — LLM-ветка
// раньше ходила голым fetch и падала на первом же 429.
// Тайм-аут не повторяем: запрос мог дойти до провайдера и быть оплачен, а повтор удвоил бы и
// плату, и ожидание. Пользователь видит ошибку и может навести ещё раз.
async function fetchRetry(url, options, timeoutMs, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      // Сигнал обрывает и чтение тела (res.json()), не только ожидание заголовков.
      res = await fetch(url, Object.assign({}, options, { signal: AbortSignal.timeout(timeoutMs) }));
    } catch (e) {
      if (isTimeout(e) || attempt >= maxRetries) throw e; // пусть обработает вызывающий
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
      continue;
    }
    if ((res.status !== 429 && res.status < 500) || attempt >= maxRetries) return res;
    const waitMs = retryAfterMs(res.headers.get("Retry-After"), 600 * Math.pow(2, attempt));
    if (waitMs > 10000) return res; // ждать слишком долго — отдаём ответ как есть
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Настройки, нужные только service worker: ключи API, параметры LLM и согласие на отправку текста.
// Дефолты — из общей таблицы.
const ENGINE_SETTINGS = {
  apiKey: "", llmApiKey: "",
  llmProvider: HT_DEFAULTS.llmProvider, llmModel: HT_DEFAULTS.llmModel,
  consent: {},
};
// Провайдер ИИ и согласие сверяем с таблицами (shared.js): хранилище могли записать не из окна.
function getSettings() {
  return chrome.storage.local.get(ENGINE_SETTINGS).then((s) => { HT_validAll(s); s.consent = HT_consent(s.consent); return s; });
}

// ---- бюджет расхода: страница не должна уметь бесконечно тратить ключ пользователя ----
// Ось — КТО инициировал перевод (см. HT_BY_PAGE / HT_BY_USER в shared.js), а не «наведение или
// страница»: смена языка перетранслирует и hover-строки, но инициировал её пользователь.
// Считаем только фактические промахи кэша, то есть реально оплачиваемые символы.
// Лимит по инициативе страницы: 10 000 знаков в минуту на вкладку — это 5 абзацев предельной
// длины (2000 знаков) или ~25 обычных (~400) в минуту, в несколько раз быстрее чтения даже
// бегло; повторное наведение берётся из кэша и лимит не тратит. Враждебная страница при этом
// выедает не больше 10 000 знаков в минуту, а суточный потолок ограничивает итог.
const BUDGETS = {
  [HT_BY_PAGE]: { windowMs: 60000, maxChars: 10000, maxReqs: 60 },
  [HT_BY_USER]: { windowMs: 60000, maxChars: 800000, maxReqs: 300 },
};
// Суточный потолок для переводов по инициативе страницы — общий на все вкладки: 100 000 знаков
// ≈ час чтения с переводом каждого абзаца и 1/5 месячной бесплатной квоты DeepL. Минутный лимит
// живёт в памяти и обнуляется вместе с воркером, суточный хранится в storage.local (htPageDay).
const PAGE_DAY_MAX = 100000;
const budgets = new Map(); // "вкладка|кто" -> { start, chars, reqs }

// Лимит считаем на вкладку, а не на фрейм: у каждого iframe свой origin, и страница с фреймами с
// разных поддоменов иначе получала бы по лимиту на каждый. Адрес верхней страницы (sender.tab.url) без
// разрешения "tabs" приходит только при правах на этот адрес — их нет, если пользователь
// ограничил доступ расширения к сайтам; номер вкладки приходит всегда, когда сообщение из вкладки.
function budgetKeyOf(sender) {
  return sender && sender.tab && sender.tab.id != null ? "tab:" + sender.tab.id : "origin:" + originOf(sender);
}

function budgetTake(key, by, chars) {
  // Поле пришло сообщением, поэтому проверяем его, а не доверяем: всё, кроме явного «по действию
  // пользователя», — по строгому лимиту.
  const kind = by === HT_BY_USER ? HT_BY_USER : HT_BY_PAGE;
  const cfg = BUDGETS[kind];
  const now = Date.now();
  if (budgets.size > 200) {            // не даём карте расти бесконечно по числу вкладок
    for (const [k, b] of budgets) if (now - b.start > 3600000) budgets.delete(k);
  }
  const k = (key || "-") + "|" + kind;
  let b = budgets.get(k);
  if (!b || now - b.start > cfg.windowMs) { b = { start: now, chars: 0, reqs: 0 }; budgets.set(k, b); }
  if (b.reqs >= cfg.maxReqs || b.chars + chars > cfg.maxChars) {
    return failure("limit", HT_t("limitMinute"));
  }
  if (kind === HT_BY_PAGE) {
    const day = new Date(now).toDateString();   // местные сутки: «до завтра» понятнее скользящих 24 ч
    if (pageDay.day !== day) pageDay = { day, chars: 0 };
    if (pageDay.chars + chars > PAGE_DAY_MAX) {
      return failure("limit", HT_plural("limitDay", PAGE_DAY_MAX));
    }
    pageDay.chars += chars;
    persistStats();
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
    if (!r.ok) return Object.assign({}, r, { texts: outTexts, srcLangs: outSrc });
    outTexts.push(...r.texts);
    outSrc.push(...r.srcLangs);
  }
  return { ok: true, texts: outTexts, srcLangs: outSrc };
}

// ---- DeepL ----
// Коды языков — из таблицы (shared.js): сейчас они совпадают с кодами настроек, но код настройки — наш, а
// код DeepL — его. Языков, которых DeepL не знает, здесь нет: их отсекает translateMany.
function deeplBody(texts, o) {
  const body = { text: texts, target_lang: HT_deeplCode(o.targetLang), tag_handling: "html" };
  if (o.sourceLang && o.sourceLang !== "auto") body.source_lang = HT_deeplCode(o.sourceLang);
  if (o.formality && o.formality !== "default") body.formality = "prefer_" + o.formality; // more|less → prefer_more|prefer_less
  if (o.terms && o.terms.length) body.ignore_tags = ["x"];
  return body;
}

function deeplAuth(key) { return { "Authorization": `DeepL-Auth-Key ${key}` }; }

// Ответ DeepL с ошибкой → неудача с понятным текстом (код ответа — мелко, в detail).
function deeplFail(status) {
  const d = HT_t("respCode", status);
  if (status === 401 || status === 403) return failure("bad-key", HT_t("deeplBadKey"), d);
  if (status === 456) return failure("quota", HT_t("deeplQuota"), d);
  if (status === 429) return failure("rate", HT_t("deeplRate"), d);
  if (status === 413) return failure("too-big", HT_t("deeplTooBig"), d);
  if (status >= 500) return failure("server", HT_t("deeplServer"), d);
  return failure("other", HT_t("deeplOther"), d);
}
// Запрос не дошёл или не дождался ответа. fetch бросает TypeError без подробностей («Failed to
// fetch»): нет сети, сайт сервиса недоступен или запрос заблокирован.
function deeplThrown(e) {
  if (isBadJson(e)) return failure("bad-response", HT_t("deeplBadResponse"));
  return isTimeout(e)
    ? failure("timeout", HT_plural("deeplTimeout", DEEPL_TIMEOUT_MS / 1000))
    : failure("network", HT_t("deeplNetwork"), e && e.message);
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
    }, DEEPL_TIMEOUT_MS);
  } catch (e) {
    return deeplThrown(e);
  }
  if (!res.ok) return deeplFail(res.status);
  let data;
  try { data = await res.json(); } catch (e) {
    return isTimeout(e) ? deeplThrown(e) : failure("bad-response", HT_t("deeplBadResponse"));
  }
  // Длину проверяем обязательно: короткий ответ сдвинул бы все последующие чанки и записал в L3
  // на 14 дней пары «исходник A ↔ перевод B». В LLM-ветке от этого защищает coerceArr.
  if (!data || !Array.isArray(data.translations) || data.translations.length !== texts.length) {
    return failure("bad-response", HT_t("deeplBadResponse"));
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
// В инструкцию для ИИ попадает только имя из таблицы, никогда не сам код: код пришёл сообщением,
// и произвольная строка на его месте стала бы prompt-инъекцией во все переводы на всех сайтах.
// Коды сверяются с таблицами ещё в translateMany, сюда неизвестный попасть не должен.
function langName(code) {
  return Object.prototype.hasOwnProperty.call(HT_LANG_NAMES, code)
    ? HT_LANG_NAMES[code] : HT_LANG_NAMES[HT_DEFAULTS.targetLang];
}

// Пустая модель — модель по умолчанию из списка в shared.js (общего с окном расширения).
function llmModelOf(provider, model) { return model || HT_llmDefault(provider); }
const LLM_NAMES = { openai: "OpenAI", anthropic: "Anthropic" };
function llmName(provider) { return LLM_NAMES[provider] || LLM_NAMES.openai; }

// Ответ ИИ с ошибкой → неудача с понятным текстом. По одному коду не всё понятно (нет такой
// модели, кончились деньги на счёте, неподдерживаемый параметр), поэтому смотрим и в тело: оба
// провайдера кладут туда error.message (а OpenAI ещё error.code). Текст сервиса — английский при любом
// языке интерфейса, он идёт мелко в detail. Показывается он и на странице, поэтому всё, похожее на ключ, вырезаем:
// OpenAI в ответе на 401 повторяет начало и конец ключа.
async function llmFail(res, provider, model) {
  let msg = "", kind = "";
  try {
    const d = await res.json();
    if (d && d.error && typeof d.error.message === "string") msg = d.error.message;
    if (d && d.error) kind = String(d.error.code || d.error.type || "");
  } catch (e) { /* тело не JSON или не дочиталось — хватит кода */ }
  msg = msg.replace(/\bsk-[\w*.-]+/g, "sk-…").replace(/\s+/g, " ").trim().slice(0, 200);
  const who = llmName(provider);
  const s = res.status;
  const d = msg ? HT_t("respCodeMsg", [s, msg]) : HT_t("respCode", s);
  if (s === 401) return failure("bad-key", HT_t("llmBadKey", who), d);
  if (/insufficient_quota|billing|credit balance/i.test(kind + " " + msg)) {
    return failure("money", HT_t("llmMoney", who), d);
  }
  if (s === 404 || /model_not_found/.test(kind)) {
    return failure("model", HT_t("llmModelUnknown", [who, String(model).slice(0, 60)]), d);
  }
  if (s === 403) return failure("denied", HT_t("llmDenied", who), d);
  if (s === 429) return failure("rate", HT_t("llmRate", who), d);
  if (s >= 500) return failure("server", HT_t("llmServer", who), d);
  return failure("other", HT_t("llmOther", who), d);
}
function llmThrown(e, provider) {
  const who = llmName(provider);
  if (isBadJson(e)) return failure("bad-response", HT_t("llmBadResponse"));
  return isTimeout(e)
    ? failure("timeout", HT_plural("llmTimeout", LLM_TIMEOUT_MS / 1000, who))
    : failure("network", HT_t("llmNetwork", who), e && e.message);
}
// Ответ пришёл, но это не JSON (страница-заглушка прокси, обрезанный ответ): связь есть, сервис ответил
// не тем. Без этой проверки res.json() попадал в «нет связи — проверьте интернет» с «Unexpected token '<'».
function isBadJson(e) { return !!e && e.name === "SyntaxError"; }

// Ключ не того сервиса не отправляем вовсе: ключи Anthropic начинаются с «sk-ant-», у OpenAI такого
// начала не бывает. Иначе после смены сервиса в окне ключ OpenAI уходил бы в Anthropic, и наоборот.
function llmKeyMismatch(provider, key) {
  const ant = /^sk-ant-/.test(String(key || "").trim());
  return provider === "anthropic" ? !ant : ant;
}

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

// Ответ примерно той же длины, что и вход, а приходит он целиком (без потока) и обязан успеть за
// LLM_TIMEOUT_MS, поэтому батч режем по суммарной длине в символах. 2500 знаков перевода — это
// ~1000–1500 токенов ответа, 10–20 с у быстрых моделей; абзац при наведении (до 2000 знаков)
// уходит одним запросом, перевод страницы — несколькими последовательными.
const LLM_CHUNK_CHARS = 2500;
const LLM_MAX_TOKENS = 16000;
// Нижняя граница потолка ответа. Платят за фактически выданные токены, а потолок важен, когда модель
// ведёт себя не так, как просили (текст на странице может содержать инструкцию «напиши 10 000
// слов»): на каждом коротком наведении она могла выдать до потолка. 512 токенов хватает с запасом на
// обёртку JSON и перевод короткого текста даже с иероглифов на русский (там перевод в 2–3 раза
// длиннее), а дальше потолок растёт вместе с текстом. Рассуждению моделей эта граница не мешает:
// им запас LLM_REASONING_TOKENS добавляется сверху.
const LLM_MIN_TOKENS = 512;
// Скрытое рассуждение модели (o-серия и GPT-5 и новее у OpenAI, Claude 5 и новее у Anthropic — там
// оно включено по умолчанию) входит в тот же потолок ответа: с потолком «по длине текста» модель могла
// бы потратить его на рассуждение и вернуть пустой ответ. Модели из списка в окне (HT_LLM_MODELS)
// получают в запросе «не рассуждать» и запас не нужен; вписанной вручную модели даём запас сверху.
// Больше не нужно: столько токенов модель всё равно не успеет выдать до тайм-аута. Без рассуждения —
// только семейства gpt-3.5/gpt-4 (gpt-4o, gpt-4.1…); неизвестную модель считаем рассуждающей — лишний
// запас безопаснее пустого ответа (платят только за выданное).
const LLM_REASONING_TOKENS = 4096;
function mayReason(provider, model) {
  return provider === "anthropic" || !/^(gpt-3\.5|gpt-4|chatgpt-4o)/i.test(model);
}
const llmSize = (t) => (t || "").length;

function llmTranslateMany(texts, o, key, provider, model) {
  return runChunks(texts, Infinity, LLM_CHUNK_CHARS, llmSize, (g) => llmTranslateChunk(g, o, key, provider, model));
}

// Текст ответа. У Anthropic с рассуждением первым идёт блок thinking (его содержимое — в поле
// thinking, а не text, и по умолчанию пустое), поэтому ищем первый блок с текстом, а не берём первый.
function llmContent(d, anthropic) {
  if (anthropic) {
    const blocks = d && Array.isArray(d.content) ? d.content : [];
    const b = blocks.find((x) => x && typeof x.text === "string");
    return b ? b.text : "";
  }
  const choice = d && d.choices && d.choices[0];
  return choice && choice.message ? choice.message.content : "";
}

async function llmTranslateChunk(texts, o, key, provider, model) {
  const sys = llmSystemPrompt(o);
  const user = JSON.stringify(texts);
  // Даём щедрый запас (≈1 токен на символ ввода — безопасно и для CJK/многословных целевых
  // языков). Если запас не влезает в потолок, ответ гарантированно обрежется и JSON не
  // распарсится: отказываем ДО вызова API, чтобы не платить за заведомо мусорный ответ.
  const want = Math.max(LLM_MIN_TOKENS, user.length);
  if (want > LLM_MAX_TOKENS) {
    return failure("too-big", HT_t("llmTooBig"));
  }
  const anthropic = provider === "anthropic";
  if (llmKeyMismatch(provider, key)) return failure("bad-key", HT_t("llmWrongKey", llmName(provider)));
  const model_ = llmModelOf(provider, model);
  const known = HT_llmModelRow(provider, model_);
  const cap = want + (!known && mayReason(provider, model_) ? LLM_REASONING_TOKENS : 0);
  // temperature не передаём: модели с рассуждением (GPT-5, o-серия) отвечают 400 на любое
  // значение, кроме значения по умолчанию, а Anthropic с версии API 2026-10-21 не принимает его вовсе.
  // Добавки из списка моделей (выключить рассуждение) — только известным моделям: вписанная вручную
  // может их не понимать и ответить 400.
  const body = Object.assign(anthropic
    ? { model: model_, max_tokens: cap, system: sys, messages: [{ role: "user", content: user }] }
    : {
        model: model_,
        max_completion_tokens: cap,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }, known ? known[2] : null);
  let d;
  try {
    const res = await fetchRetry(anthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: llmHeaders(provider, key),
      body: JSON.stringify(body),
    }, LLM_TIMEOUT_MS);
    if (!res.ok) return await llmFail(res, provider, model_);
    d = await res.json();
  } catch (e) {
    return llmThrown(e, provider);
  }
  // Модель отказалась переводить (правила безопасности провайдера): у Anthropic — stop_reason "refusal", у
  // OpenAI — поле refusal в ответе. Что-то вроде перевода в ответе при этом может быть, но верить ему нельзя.
  const choice0 = !anthropic && d && d.choices && d.choices[0];
  if (anthropic ? d && d.stop_reason === "refusal" : choice0 && choice0.message && choice0.message.refusal) {
    return failure("refused", HT_t("llmRefused"));
  }
  let arr = parseLlmJson(llmContent(d, anthropic) || "", texts.length);
  if (!arr) {
    // Упёрлись в потолок длины — говорим об этом прямо: у моделей с рассуждением это значит, что
    // рассуждение съело лимит, и «неожиданный формат» только запутал бы.
    const cut = anthropic ? d && d.stop_reason === "max_tokens" : choice0 && choice0.finish_reason === "length";
    return cut ? failure("cut", HT_t("llmCut")) : failure("bad-response", HT_t("llmBadResponse"));
  }
  // Снимаем обёртку <x> только если сами её ставили (есть термины).
  if (o.terms && o.terms.length) arr = arr.map(stripNoTranslate);
  return { ok: true, texts: arr, srcLangs: texts.map(() => null) };
}

// ---- унифицированный батч-перевод с кэшем ----
async function translateMany(items, o, origin, budgetKey) {
  await ensureCache();
  // Движок, языки и тон пришли сообщением — сверяем с таблицами (shared.js) до любого
  // использования: в ключ кэша, в запрос и в инструкцию для ИИ попадает только известное значение.
  HT_validAll(o);
  o.terms = parseTerms(o.noTranslate);
  o.origin = origin || "";
  const e = HT_engine(o.engine);
  if (e.via === "local") return failure("other", HT_t("builtinPageOnly"));
  // Язык, которого DeepL не знает: content сюда не шлёт (HT_canSend), «авто» переводит встроенным. Это
  // страховка — ответ с понятной причиной, а не 400 от DeepL.
  if (HT_langGap(e.via, o)) return failure("lang", HT_problemText("deepl-lang", "page", o));

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
    // Ключ проверяем ДО лимита: без ключа ничего не оплачивается, а наведения на первом запуске
    // (ключ ещё не вставлен) иначе съедали бы суточный лимит, который понадобится потом.
    if (!s) s = await getSettings();
    if (e.keyField && !s[e.keyField]) return failure("no-key", HT_t(HT_KEY_HINTS[e.keyField]));
    // Главная защита согласия: content тоже не шлёт текст без него, но проверка здесь — последняя
    // перед сетью и не зависит от того, что прислала страница. Сохранённые переводы (выше) отдаём и
    // без согласия: они уже на компьютере и никуда не уходят.
    const provider = HT_provider(e.code, s.llmProvider);
    if (!HT_agreed(s.consent, provider)) {
      return failure("no-consent", HT_t("bgNoConsent", HT_PROVIDER_NAMES[provider]));
    }
    // Ключ, который DeepL уже отклонил, не шлём с каждым абзацем заново — до смены ключа.
    if (e.via !== "llm" && s.apiKey && s.apiKey === deeplRejectedKey) {
      noteNetResult(e.via, s.llmProvider, { ok: false, code: "bad-key" });
      return failure("bad-key", HT_t("deeplBadKey"));
    }
    await startupReady;                 // суточный счётчик лимита должен быть уже загружен
    const denied = budgetTake(budgetKey, o.by, missTexts.reduce((n, t) => n + t.length, 0));
    if (denied) return denied;
    const r = e.via === "llm"
      ? await llmTranslateMany(missTexts, o, s.llmApiKey, s.llmProvider, s.llmModel)
      : await deeplTranslateChunked(missTexts, o, s.apiKey);
    if (e.via !== "llm") noteDeeplKey(s.apiKey, r);
    noteNetResult(e.via, s.llmProvider, r);
    // Пришедшие переводы раскладываем всегда, даже если часть чанков упала: они уже оплачены.
    if (Array.isArray(r.texts) && r.texts.length) {
      store(missTexts.slice(0, r.texts.length), r, keys, need, results, srcOut);
    }
    if (!r.ok) return failure(r.code, r.error, r.detail);
  }

  return { ok: true, texts: results, srcLangs: srcOut };
}

// Последний сбой DeepL или ИИ — для окна расширения (состояния «ключ отклонён», «лимит исчерпан», «нет связи»)
// и для «!» на значке, когда DeepL не принял ключ (problemNow).
// storage.session.htNetErr = { code, via: "deepl" | "llm", provider, at } — только коды, по которым окну есть что
// показать; успешный ответ того же сервиса запись снимает. Смена ключа, переводчика или сервиса — тоже (см. ниже).
const NET_ERR_CODES = new Set(["bad-key", "quota", "money", "network", "timeout", "server", "denied"]);
function noteNetResult(via, provider, r) {
  if (!sessionArea || !r) return;
  if (r.ok) {
    sessionArea.get("htNetErr").then((g) => {
      const x = g.htNetErr;
      if (x && x.via === via && (via !== "llm" || x.provider === provider)) return sessionArea.remove("htNetErr");
    }).catch(() => {});
    return;
  }
  if (!NET_ERR_CODES.has(r.code)) return;
  sessionArea.set({ htNetErr: { code: r.code, via, provider: via === "llm" ? provider : "deepl", at: Date.now() } }).catch(() => {});
}
chrome.storage.onChanged?.addListener?.((changes, area) => {
  if (area !== "local" || !sessionArea) return;
  if (["apiKey", "llmApiKey", "llmProvider", "engine"].some((k) => k in changes)) sessionArea.remove("htNetErr").catch(() => {});
});

// Ключ DeepL, который сервис отклонил (401/403). Пока в настройках он же, перевод сразу отвечает
// «ключ не подошёл» без запроса: в режиме «авто» иначе каждое наведение стучалось бы в DeepL впустую.
// Новый ключ или успешный ответ снимают отметку; после перезапуска воркера — один лишний запрос.
let deeplRejectedKey = "";
function noteDeeplKey(key, r) {
  if (r && r.ok) { if (deeplRejectedKey === key) deeplRejectedKey = ""; }
  else if (r && r.code === "bad-key") deeplRejectedKey = key;
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

// Проверка ключа и остаток квоты символов через /v2/usage. Согласия на отправку текста не требует:
// уходит только сам ключ — тому сервису, который его выдал, — и только по действию человека (вставил
// ключ или нажал «Проверить»). Текста страниц в этом запросе нет.
async function checkUsage() {
  const { apiKey } = await getSettings();
  if (!apiKey) return failure("no-key", HT_t("noKeyEntered"));
  try {
    const res = await fetch(`${deeplBase(apiKey)}/v2/usage`, { headers: deeplAuth(apiKey), signal: AbortSignal.timeout(DEEPL_TIMEOUT_MS) });
    if (!res.ok) { const f = deeplFail(res.status); noteDeeplKey(apiKey, f); noteNetResult("deepl", "", f); return f; }
    const d = await res.json();
    noteDeeplKey(apiKey, { ok: true });
    noteNetResult("deepl", "", { ok: true });
    // free — ключ бесплатного тарифа: только у него лимит — 500 000 знаков. У платного лимит задаёт сам
    // владелец ключа в DeepL, а без лимита DeepL присылает 1 000 000 000 000.
    return { ok: true, used: d.character_count, limit: d.character_limit, free: apiKey.trim().endsWith(":fx") };
  } catch (e) {
    const f = deeplThrown(e);
    noteNetResult("deepl", "", f);
    return f;
  }
}

// Проверка LLM-ключа настоящим переводом одного слова выбранной моделью — тем же запросом, что и
// при работе. Список моделей (GET /v1/models) подтвердил бы только ключ: модель с опечаткой или
// не принимающая параметры запроса прошла бы проверку, а каждый перевод потом падал бы с 400.
// Стоимость — пара сотен токенов инструкции. Согласия не требует, как и проверка ключа DeepL:
// переводится слово «Hello» из самого расширения, а не текст страниц.
// o — { provider, key, model } от страницы настроек: проверить сервис и ключ ДО того, как они станут настройками
// (иначе на время проверки переводил бы ещё не проверенный сервис). Без o — сохранённые настройки.
async function checkLlm(o) {
  const saved = await getSettings();
  const own = o && typeof o.key === "string" && o.key.trim();
  const llmApiKey = own ? o.key.trim() : saved.llmApiKey;
  const llmProvider = own ? HT_valid("llmProvider", o.provider) : saved.llmProvider;
  const llmModel = own ? (typeof o.model === "string" ? o.model.trim().slice(0, 100) : "") : saved.llmModel;
  if (!llmApiKey) return failure("no-key", HT_t("noKeyEntered"));
  const r = await llmTranslateChunk(["Hello"], { targetLang: HT_DEFAULTS.targetLang, terms: [] }, llmApiKey, llmProvider, llmModel);
  noteNetResult("llm", llmProvider, r);
  return r.ok ? { ok: true } : failure(r.code, r.error, r.detail);
}

// Сколько переводов сохранено в L3 и сколько они занимают — для раздела «Данные» на странице настроек.
async function savedInfo() {
  try {
    const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
    const entries = keys.filter((k) => k.startsWith(LCACHE_PREFIX)).length;
    if (lcacheBytes < 0 && entries) await pruneLcache();
    return { entries, bytes: entries ? Math.max(0, lcacheBytes) : 0 };
  } catch (e) { return { entries: 0, bytes: 0 }; }
}

// Порт держим открытым (return true), поэтому ЛЮБОЙ реджект обязан дойти до sendResponse:
// молчание подвешивает content-скрипт навсегда (ht-loading не снимается, owner остаётся в
// inFlight, перевод страницы встаёт посреди страницы и не создаёт IntersectionObserver).
function reply(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((e) => sendResponse(failure("other", HT_t("internalError"), e && e.message)));
  return true;
}

function ownPage(sender) {
  let base = "";
  try { base = chrome.runtime.getURL(""); } catch (e) { return false; }
  return !!base && !!sender && typeof sender.url === "string" && sender.url.startsWith(base);
}

function originOf(sender) {
  if (sender && sender.origin) return sender.origin;
  try { return sender && sender.url ? new URL(sender.url).origin : ""; } catch (e) { return ""; }
}

// ---- значок расширения ----
// «!» — выбранный переводчик не может работать (нет ключа или согласия на отправку текста, нет
// встроенного в браузере): content на страницах тогда ничего не делает, а объяснение — в подсказке
// значка и в окне расширения. «!» и тогда, когда переводчик ходит в DeepL, а DeepL не принял ключ
// (htNetErr): с запасным встроенным перевод идёт, но человек должен узнать, что ключ не работает.
// «off» — перевод выключен, он важнее «!». Состояние значка браузер не сохраняет между запусками,
// поэтому пересчитываем при каждом старте воркера, а дальше — по изменениям в хранилище.
const BADGE_KEYS = ["enabled", "engine", "apiKey", "llmApiKey", "llmProvider", "consent", "htBuiltinApi", "targetLang", "sourceLang"];
const BADGE_OFF_COLOR = "#6b7280";
const BADGE_PROBLEM_COLOR = "#d93025";

// { off, problem, badKey, st }: problem — причина из HT_engineProblem; badKey — DeepL не принял ключ, а
// выбранный переводчик (DeepL или DeepL с запасным встроенным) ходит в DeepL. В HT_PROBLEMS badKey не
// входит: по причинам оттуда content решает, что переводить нельзя, а с запасным встроенным можно.
// Отметку берём из storage.session (htNetErr), а не из памяти: воркер засыпает, а значок после
// пробуждения должен остаться тем же. Новый ключ или переводчик снимают htNetErr (см. выше), успешный
// ответ DeepL — тоже.
function deeplKeyRejected(x) { return !!x && x.code === "bad-key" && x.via === "deepl"; }
function problemNow() {
  return Promise.all([
    chrome.storage.local.get({
      enabled: HT_DEFAULTS.enabled, engine: HT_DEFAULTS.engine, apiKey: "", llmApiKey: "",
      llmProvider: HT_DEFAULTS.llmProvider, consent: {}, htBuiltinApi: null,
      targetLang: HT_DEFAULTS.targetLang, sourceLang: HT_DEFAULTS.sourceLang,
    }),
    sessionArea ? sessionArea.get("htNetErr").catch(() => ({})) : {},
  ]).then(([s, g]) => {
    // Встроенный переводчик есть в service worker не во всех версиях Chrome, поэтому «нет» берём
    // только из записи окна (htBuiltinApi пишут popup, страница приветствия и content), а «есть» —
    // и отсюда. Пока никто не проверял — считаем, что есть: иначе «!» горел бы ни за что.
    const builtin = "Translator" in self || s.htBuiltinApi !== false;
    const st = { apiKey: !!s.apiKey, llmApiKey: !!s.llmApiKey, llmProvider: s.llmProvider, consent: s.consent,
      targetLang: HT_valid("targetLang", s.targetLang), sourceLang: HT_valid("sourceLang", s.sourceLang) };
    const engine = HT_valid("engine", s.engine);
    const problem = HT_engineProblem(engine, st, builtin);
    const badKey = !!s.apiKey && HT_engine(engine).via === "deepl" && deeplKeyRejected(g && g.htNetErr);
    return { off: s.enabled === false, problem, badKey, st };
  });
}

// Подсказка значка: короткое название и что не так. Название — из сообщений (extShortName): полное
// (manifest name) для подсказки слишком длинное. b — от problemNow.
function badgeTitle(b) {
  const name = HT_t("extShortName");
  const why = b.problem ? HT_problemText(b.problem, "short", b.st) : b.badKey ? HT_t("probDeeplBadKey") : "";
  return b.off ? HT_t("badgeOff", name) : why ? HT_t("badgeProblem", [name, why]) : name;
}

async function updateBadge() {
  const a = chrome.action;
  if (!a || !a.setBadgeText) return;
  try {
    const b = await problemNow();
    const text = b.off ? "off" : b.problem || b.badKey ? "!" : "";
    if (text) await a.setBadgeBackgroundColor({ color: b.off ? BADGE_OFF_COLOR : BADGE_PROBLEM_COLOR });
    await a.setBadgeText({ text });
    await a.setTitle({ title: badgeTitle(b) });
    // Проблему решили — следующая (если появится) снова заслуживает уведомления на странице.
    if (!b.problem && sessionArea) sessionArea.remove(Object.keys(HT_PROBLEMS).map(noticeKey)).catch(() => {});
  } catch (e) { /* значок — не повод ронять воркер */ }
}

updateBadge();
chrome.runtime.onStartup?.addListener?.(updateBadge);
// htNetErr переписывается при каждом сбое (с отклонённым ключом — на каждый перевод), а значку важно
// только «DeepL не принял ключ» — да или нет.
chrome.storage.onChanged?.addListener?.((changes, area) => {
  const net = area === "session" && changes.htNetErr;
  if (area === "local" ? BADGE_KEYS.some((k) => k in changes)
    : net && deeplKeyRejected(net.oldValue) !== deeplKeyRejected(net.newValue)) updateBadge();
});

// Сайт выключен в окне расширения или в «⋯» у кружка — «off» на значке только этой вкладки. Сообщает
// верхний фрейм вкладки при загрузке и при смене. Значение для вкладки сильнее общего; null
// возвращает вкладке общий текст значка. Цвет и подсказку для вкладки так не снять, поэтому при
// включении сайта ставим их равными общим.
async function siteBadge(tabId, off) {
  const a = chrome.action;
  if (!a || !a.setBadgeText) return;
  try {
    if (off) {
      await a.setBadgeBackgroundColor({ tabId, color: BADGE_OFF_COLOR });
      await a.setBadgeText({ tabId, text: "off" });
      await a.setTitle({ tabId, title: HT_t("badgeSiteOff", HT_t("extShortName")) });
      return;
    }
    const b = await problemNow();
    await a.setBadgeText({ tabId, text: null });
    await a.setBadgeBackgroundColor({ tabId, color: b.off ? BADGE_OFF_COLOR : BADGE_PROBLEM_COLOR });
    await a.setTitle({ tabId, title: badgeTitle(b) });
  } catch (e) { /* вкладку закрыли — значок не нужен */ }
}

// Уведомление на странице о неработающем переводчике — одно за сессию браузера, а не по одному на
// каждой вкладке: дальше о проблеме напоминает «!» на значке. Так же — сообщение «лимит DeepL на
// месяц закончился, перевожу встроенным»: лимит не вернётся до следующего месяца, и повторять его
// на каждой странице незачем.
const ONCE_KEYS = new Set(Object.keys(HT_PROBLEMS).concat(["deepl-quota", "deepl-bad-key"]));
const noticed = new Set();
function noticeKey(problem) { return "htNoticed:" + problem; }
async function noticeOnce(problem) {
  if (!ONCE_KEYS.has(problem)) return { show: false };
  const k = noticeKey(problem);
  if (noticed.has(k)) return { show: false };
  noticed.add(k);
  if (sessionArea) {
    const got = await sessionArea.get(k).catch(() => ({}));
    if (got[k]) return { show: false };
    sessionArea.set({ [k]: true }).catch(() => {});
  }
  return { show: true };
}

// ---- установка ----
// Первая установка: язык перевода — по языку браузера (если он есть в таблице, иначе английский) и
// страница приветствия, где готовится встроенный переводчик. Способ включения записываем сразу:
// по его наличию в хранилище обновление отличает новых пользователей от прежних (см. ниже).
// При обновлении ничего не открываем.
chrome.runtime.onInstalled?.addListener?.(async (details) => {
  updateBadge();
  chrome.storage.local.remove(HT_OBSOLETE_KEYS).catch(() => {});   // обводка подсветки убрана
  if (details && details.reason === "update") { keepOldTrigger(); return; }
  if (!details || details.reason !== "install") return;
  try {
    const s = await chrome.storage.local.get(["targetLang", "trigger"]);
    const set = {};
    if (!s.targetLang) {
      const ui = chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : "";
      set.targetLang = HT_targetFromLocale(ui);
    }
    if (!s.trigger) set.trigger = HT_DEFAULTS.trigger;
    await chrome.storage.local.set(set);
  } catch (e) { /* останутся значения по умолчанию */ }
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

// Раньше по умолчанию перевод включался наведением с задержкой. Кто способ не выбирал (в хранилище
// его нет), тот привык к наведению: оставляем ему наведение, а не переключаем молча на Shift — иначе
// после обновления перевод «перестал бы работать». Сохранённый выбор не трогаем. Новым установкам
// способ записывается при установке, поэтому сюда они не попадают.
async function keepOldTrigger() {
  try {
    const s = await chrome.storage.local.get("trigger");
    if (!("trigger" in s)) await chrome.storage.local.set({ trigger: "dwell" });
  } catch (e) { /* не вышло — останется значение по умолчанию */ }
}

// ---- горячие клавиши (manifest.json → commands) ----
// Сменить их можно на chrome://extensions/shortcuts; там же видно, если сочетание занято другим
// расширением (тогда у команды пустой shortcut). Обе команды адресуем верхнему фрейму вкладки — как
// и окно расширения.
async function shortcutOf(name) {
  try {
    const all = await chrome.commands.getAll();
    const c = all.find((x) => x.name === name);
    return (c && c.shortcut) || "";
  } catch (e) { return ""; }
}
function toTab(tabId, msg, frameId) {
  if (tabId == null) return;
  // Вкладка без content-скрипта (служебная страница Chrome) — ответить некому, это не ошибка.
  chrome.tabs.sendMessage(tabId, msg, frameId == null ? {} : { frameId }).catch(() => {});
}

chrome.commands?.onCommand?.addListener?.(async (command, tab) => {
  const tabId = tab && tab.id;
  if (command === "toggle-enabled") {
    try {
      const { enabled } = await chrome.storage.local.get({ enabled: HT_DEFAULTS.enabled });
      const on = enabled === false;
      await chrome.storage.local.set({ enabled: on });
      // Значок покажет «off», но взгляд в этот момент на странице — говорим и там.
      toTab(tabId, { type: "say", what: on ? "enabled" : "disabled", keys: await shortcutOf("toggle-enabled") }, 0);
    } catch (e) { /* хранилище недоступно — состояние не изменилось */ }
  } else if (command === "translate-page") {
    toTab(tabId, { type: "translatePage", via: "command", keys: await shortcutOf("toggle-enabled") }, 0);
  }
});

// «Открыть настройки» (уведомление на странице, окно расширения): страница настроек во вкладке. Если она уже
// открыта, Chrome переключает на неё. focus — к чему её прокрутить и где поставить фокус (см. options.js):
// передаём через storage.session, адрес вкладки openOptionsPage не принимает.
async function openSettings(focus) {
  const f = typeof focus === "string" && /^[a-z-]{1,40}$/.test(focus) ? focus : "";
  if (sessionArea) await sessionArea.set({ htFocus: { to: f, at: Date.now() } }).catch(() => {});
  await chrome.runtime.openOptionsPage();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  // Одиночного пути нет намеренно: перевод одного элемента — это батч из одного элемента,
  // иначе вся политика движков (выбор, фолбэк, обработка ошибок) жила бы в двух копиях.
  if (msg.type === "translateBatch") {
    return reply(translateMany(msg.items || [], msg, originOf(sender), budgetKeyOf(sender)), sendResponse);
  }
  if (msg.type === "noticeOnce") return reply(noticeOnce(String(msg.problem)), sendResponse);
  if (msg.type === "openSettings") return reply(openSettings(msg.focus), sendResponse);
  // Подсказка «Перевести страницу» у кружка показывает настоящее сочетание ("" — не задано или занято).
  if (msg.type === "shortcut") return reply(shortcutOf(String(msg.name || "")), sendResponse);
  // Esc на странице: вернуть оригинал и во встроенных окнах той же вкладки (у каждого свой скрипт).
  if (msg.type === "restoreTab") {
    if (sender && sender.tab) toTab(sender.tab.id, { type: "restoreAll" });
    return;
  }
  if (msg.type === "siteBadge") {
    if (sender && sender.tab && sender.frameId === 0) siteBadge(sender.tab.id, msg.off === true);
    return;
  }
  if (msg.type === "checkUsage") return reply(checkUsage(), sendResponse);
  // Свой сервис и ключ на проверку принимаем только от страниц самого расширения, не от content-скриптов.
  if (msg.type === "checkLlm") return reply(checkLlm(ownPage(sender) ? msg : null), sendResponse);
  if (msg.type === "clearCache") return reply(clearCache(), sendResponse);
  if (msg.type === "getStats") {
    // Ждём загрузку счётчиков: на холодном воркере иначе уходят нули.
    return reply(startupReady.then(savedInfo).then((l3) => ({ ok: true, chars: stats.chars, hits: stats.hits, saved: stats.saved,
      entries: l3.entries, bytes: l3.bytes })), sendResponse);
  }
  if (msg.type === "resetStats") {
    statsLoaded = true;                 // не даём отложенной загрузке вернуть прежние значения
    stats.chars = 0; stats.hits = 0; stats.saved = 0;
    return reply(chrome.storage.local.set({ statChars: 0, statHits: 0, statSaved: 0 }).then(() => ({ ok: true })), sendResponse);
  }
});
