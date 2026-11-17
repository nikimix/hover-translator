// content.js — выполняется на каждой странице/фрейме (isolated world).
// Перевод элемента под курсором (наведение/клавиша) и всей страницы.
//
// Применение перевода: меняем ТОЛЬКО значения текстовых узлов (Text.nodeValue) — не создаём,
// не удаляем и не оборачиваем узлы-элементы. Так сохраняются обработчики событий и структура
// DOM, и каркас веб-приложений (React/Vue/Angular) не ломается. Поэтому интерактивные элементы
// (кнопки/ссылки) тоже можно переводить безопасно.
// Способы показа (displayMode): «замена на месте» (узлы) и «поповер» (плавающая карточка —
// только при наведении; страницу всегда переводим заменой). Опционально — бейдж исходного языка
// (только в поповере) и мини-HUD смены языка на странице.
// Движки: DeepL, LLM (OpenAI/Anthropic) — через background; встроенный Chrome — on-device.

(function () {
  if (!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && chrome.runtime)) {
    return;
  }

  const DEFAULTS = HT_DEFAULTS;   // общая таблица (shared.js) — раньше эти 18 пар лежали
  let settings = Object.assign({}, DEFAULTS);   // посимвольно совпадающей копией и в popup.js

  // Состояние переводов на уровне текстовых узлов.
  const nodeRecs = new WeakMap();    // Text -> { orig, translated }  (orig — исходный nodeValue)
  const lines = new Set();           // активные «строки»: { owner, nodes:[Text], persistent, gen, hlSaved }
  const lineByOwner = new WeakMap(); // owner Element -> Line (маркер «переведён/в работе» и для отката)
  const inFlight = new WeakSet();    // owner, для которого перевод уже идёт (мьютекс против гонки)
  // owner с активным поповером -> { node }. Один Map, а не Set + WeakMap: Set всё равно
  // держал owner-а сильной ссылкой, так что WeakMap ничего не экономил, зато два хранилища
  // расходились — именно на этом и держалась «осиротевшая карточка» (владельца убрали из Set,
  // а узел и запись состояния остались).
  const popovers = new Map();
  // owner -> { timer, title }: таймер сброса и его собственный title до показа текста ошибки.
  // Одна карта, а не две: писались и удалялись они всегда вместе (тот же аргумент, что и для
  // popovers ниже).
  const errors = new WeakMap();
  const translators = new Map();     // "src>tgt" -> Promise<Translator|null> (встроенный движок)
  const pendingObserved = new Set(); // owner, вошедшие в зону видимости и ждущие перевода
  let pageObserver = null;
  let flushTimer = null;
  let pageGen = 0;                    // токен отмены перевода страницы (инкрементится при сбросе/новом запуске)
  let liveGen = 0;                    // токен отмены всех показов: сброс всех/выключение перевода во время await
  let hoverEl = null;
  let dwellTimer = null;
  let modPress = null;                // { key, el }: клавиша-триггер нажата, ждём её отпускания
  let modWheelUntil = 0;              // до этого времени модификатор занят жестом прокрутки/зума
  let lastToastAt = 0;
  let detector = null;
  let detectorInit = null;
  let restylePending = false;
  let popScrollBound = false;
  let popPending = false;      // репозиция карточек уже запланирована на кадр
  let hud = null;
  let hudPos = null;                  // запомненная позиция панели после перетаскивания
  let retranslateTimer = null;

  // Подсветка — мгновенно (rAF), без перевода. Язык/движок/формальность/исключения — перетранслирование.
  // Режим показа/бейдж влияют только на будущие наведения, уже показанное не перерисовываем.
  const DISP_KEYS = ["dispMode", "dispBg", "dispOpacity", "dispBorder", "dispBorderColor", "dispBorderStyle"];
  const TX_KEYS = ["targetLang", "sourceLang", "engine", "formality", "noTranslate", "llmProvider", "llmModel"];
  // Сами ключи API в content не хранятся (и не должны), но их появление меняет результат перевода:
  // с engine=auto страница уже могла быть заполнена встроенным фолбэком, и после ввода ключа
  // DeepL её нужно перевести заново. В DEFAULTS этих полей нет, поэтому обрабатываем отдельно.
  const KEY_KEYS = ["apiKey", "llmApiKey"];

  // Перечисления (язык, движок, тон, способ показа, клавиша) сверяем с таблицами shared.js при
  // каждом чтении: неизвестное значение становится значением по умолчанию.
  chrome.storage.local.get(DEFAULTS, (s) => { settings = HT_validAll(s); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let dispChanged = false, txChanged = false, enabledOff = false;
    for (const k in changes) {
      const ch = changes[k];
      if (KEY_KEYS.includes(k)) {           // значение не запоминаем — нужен только факт смены
        if (ch.oldValue !== ch.newValue) txChanged = true;
        continue;
      }
      if (!(k in DEFAULTS)) continue;       // игнорируем чужие ключи (записи кэша, статистика, служебные popup)
      settings[k] = HT_valid(k, ch.newValue);
      // Значение не поменялось (popup пишет все ключи разом). Сравниваем уже сверенные значения:
      // замена неизвестного значения на значение по умолчанию ничего не меняет.
      if (HT_valid(k, ch.oldValue) === settings[k]) continue;
      if (DISP_KEYS.includes(k)) dispChanged = true;
      else if (TX_KEYS.includes(k)) txChanged = true;
      if (k === "targetLang" && hud) syncHud();
      if (k === "enabled" && ch.newValue === false) enabledOff = true;
    }
    // Применяем изменения к уже показанным переводам сразу.
    if (enabledOff) { restoreAll(); return; }       // выключили перевод — откатываем всё
    if (dispChanged) scheduleRestyle();              // тема подсветки — мгновенный предпросмотр
    if (txChanged) {
      // Отменяем переводы «в полёте»: они вернутся на ПРЕЖНЕМ языке и попали бы в lines уже
      // после того, как retranslateAll по ним прошёл — то есть остались бы навсегда старыми.
      liveGen++;
      scheduleRetranslate();                         // перевод изменится — перезапрашиваем (debounce)
    }
    // displayMode/showLangBadge — только вид; влияют на будущие наведения, ничего не перерисовываем.
  });

  const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "PRE", "CODE", "NOSCRIPT", "SVG", "CANVAS", "IMG", "VIDEO", "AUDIO"]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
    "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  // Языки для HUD (мини-панель смены целевого языка на странице) — из общей таблицы shared.js,
  // чтобы список не расходился с popup и с именами языков в промпте LLM.
  const LANGS = HT_TARGET_LANGS;

  function isBlockEl(el) { return el && el.nodeType === 1 && BLOCK_TAGS.has(el.tagName); }

  // memo (необязательный Map) нужен обходу всего документа: там список детей контейнера
  // пересканировался столько раз, сколько у него детей — на панели из 1000 инлайновых ссылок
  // это ~10^6 проверок синхронно по клику «Перевести страницу».
  function hasBlockChild(el, memo) {
    if (memo) { const hit = memo.get(el); if (hit !== undefined) return hit; }
    const kids = el.children;
    let found = false;
    for (let i = 0; i < kids.length; i++) if (isBlockEl(kids[i])) { found = true; break; }
    if (memo) memo.set(el, found);
    return found;
  }

  // Верхний строчный контейнер (эквивалент pickTarget(el)===el, но без подъёма по дереву).
  function isTopInlineContainer(el, memo) {
    if (hasBlockChild(el, memo)) return false;
    const p = el.parentElement;
    return !p || p.tagName === "BODY" || p.tagName === "HTML" || hasBlockChild(p, memo);
  }

  // Самый крупный «строчный» контейнер вокруг точки: поднимаемся, пока у родителя нет блочных детей.
  function pickTarget(start) {
    if (!start || start.nodeType !== 1) return null;
    if (hasBlockChild(start)) return null;
    let el = start;
    while (
      el.parentElement &&
      el.parentElement.tagName !== "BODY" &&
      el.parentElement.tagName !== "HTML" &&
      !hasBlockChild(el.parentElement)
    ) {
      el = el.parentElement;
    }
    return el;
  }

  // Наш UI: хост помечен data-ht-ui, а всё его содержимое живёт в shadow root, поэтому детей-
  // элементов в light DOM у него нет и подниматься по предкам не нужно. closest() здесь стоил
  // сопоставления селектора с каждым предком — на каждый текстовый узел батча и на каждый
  // mouseover, то есть десятки тысяч раз за один перевод страницы.
  function isOurUi(el) { return !!el && el.nodeType === 1 && el.hasAttribute("data-ht-ui"); }

  // Автор страницы просит не переводить элемент и всё внутри него: translate="no" (стандарт HTML)
  // или класс notranslate (соглашение Google Переводчика) — код, имена, тексты для изучения языка.
  function authorNoTranslate(el) {
    if (el.classList && el.classList.contains("notranslate")) return true;
    const t = el.getAttribute("translate");
    return t !== null && t.toLowerCase() === "no";
  }

  // Запрет на элементе или его предках. Запрет на <html>/<body> не учитываем: так SPA защищаются
  // от Google Переводчика, который перестраивает DOM и ломает каркас, — мы меняем только текст
  // узлов, а запрет на весь документ молча выключал бы расширение на таких сайтах целиком.
  function insideNoTranslate(el) {
    const root = document.documentElement, body = document.body;
    for (let e = el; e && e !== body && e !== root; e = e.parentElement) {
      if (authorNoTranslate(e)) return true;
    }
    return false;
  }

  function isTextTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    // SVG/MathML и прочий foreign-content переводить не беремся (графика/формулы).
    if (el.namespaceURI && el.namespaceURI !== XHTML_NS) return false;
    if (el.isContentEditable) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (isOurUi(el)) return false;
    if (insideNoTranslate(el)) return false;
    const text = (el.textContent || "").trim();
    if (text.length < 2 || text.length > 2000) return false;
    if (!/\p{L}/u.test(text)) return false;
    return true;
  }

  // Можно ли переводить этот текстовый узел внутри owner-контейнера.
  function acceptTextNode(node, owner) {
    const v = node.nodeValue;
    if (!v || !v.trim() || !/\p{L}/u.test(v)) return false;
    const p = node.parentElement;
    if (!p) return false;
    if (p.isContentEditable) return false;           // contentEditable наследуется — покрывает предков
    if (isOurUi(p)) return false;                    // наша собственная разметка
    for (let el = p; el; el = el.parentElement) {     // вверх до owner: пропускаем code/pre/svg и т.п.
      if (el.namespaceURI && el.namespaceURI !== XHTML_NS) return false;
      if (SKIP_TAGS.has(el.tagName)) return false;
      if (authorNoTranslate(el)) return false;         // предков owner-а уже проверил isTextTarget
      if (el === owner) break;
    }
    return true;
  }

  // Текстовые узлы внутри owner, пригодные для перевода (в порядке обхода).
  function collectTextNodes(owner) {
    const out = [];
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => acceptTextNode(node, owner) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  function modHeld(e) {
    if (settings.trigger === "shift") return e.shiftKey;
    if (settings.trigger === "alt") return e.altKey;
    if (settings.trigger === "ctrl") return e.ctrlKey || e.metaKey;
    return false;
  }

  // Модификатор — не только наш триггер: Shift+колесо прокручивает по горизонтали, Ctrl+колесо
  // меняет масштаб страницы, Alt+колесо в некоторых сборках листает историю. Пока идёт такой жест
  // (и короткое время после), зажатую клавишу НЕ считаем запросом на перевод — иначе прокрутка
  // карусели или широкой таблицы переводила всё, что проехало под курсором, и тратила ключ.
  const MOD_WHEEL_GRACE = 500;
  function modBusy() { return Date.now() < modWheelUntil; }

  function isTriggerKey(e) {
    if (settings.trigger === "shift") return e.key === "Shift";
    if (settings.trigger === "alt") return e.key === "Alt";
    if (settings.trigger === "ctrl") return e.key === "Control" || e.key === "Meta";
    return false;
  }

  // Нажат ровно один модификатор — сама клавиша-триггер (её флаг в событии уже стоит).
  // Alt+Shift (смена раскладки), Ctrl+Shift+… — это сочетания, а не наш жест.
  function soloMod(e) { return e.shiftKey + e.ctrlKey + e.altKey + e.metaKey === 1; }

  // Фокус в поле ввода: нажатый модификатор там — набор текста (заглавная буква, Ctrl+C/V),
  // а не просьба перевести абзац под курсором. Заходим и в открытые shadow root веб-компонентов.
  // Флажки и кнопки-<input> текст не принимают — после клика по ним режим клавиши не глушим.
  const NO_TYPING_INPUTS = /^(button|checkbox|radio|submit|reset|range|color|file|image)$/;
  function typingFocus() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "INPUT") return !NO_TYPING_INPUTS.test(el.type);
    return el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
  }

  // Запустить/снять перевод owner-а под курсором (по клавише-триггеру).
  function toggle(owner) {
    if (!owner) return;
    if (settings.displayMode === "popover") {
      if (popovers.has(owner)) removePopover(owner); else translatePopover(owner);
    } else {
      const line = lineByOwner.get(owner);
      if (line) restoreLine(line); else translateLine(owner, false);
    }
  }

  function startHover(owner) {
    if (settings.displayMode === "popover") translatePopover(owner);
    else translateLine(owner, false);
  }

  // «Показ уже есть» — строка или карточка; isBusy добавляет «запрос уже в полёте».
  function isShown(owner) { return lineByOwner.has(owner) || popovers.has(owner); }
  function isBusy(owner) { return isShown(owner) || inFlight.has(owner); }

  function targetBase() { return HT_langBase(settings.targetLang || "RU").toUpperCase(); }
  function badgeText(src) { return `${src.toUpperCase()} → ${targetBase()}`; }

  // Параметры перевода для background (движок/языки/формальность/исключения).
  function txOpts() {
    return {
      engine: settings.engine || "deepl",
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang || "auto",
      formality: settings.formality || "default",
      noTranslate: settings.noTranslate || "",
    };
  }

  // Текстовый узел отдаём движку как HTML-строку: экранируем спецсимволы (сырой nodeValue может
  // содержать «<»/«&»), затем результат раскодируем обратно перед записью в узел.
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Инертно (без выполнения кода и загрузки ресурсов) снимаем HTML-сущности и любые теги —
  // получаем чистый текст для записи в nodeValue. Безопасно даже для недоверенного вывода LLM.
  // Парсер дорогой (полный Document на каждую строку, а батч страницы — это тысячи строк),
  // а в ответе движка разбирать обычно нечего. Символы в проверке — РОВНО те, которые парсинг
  // текста меняет: & (сущности), < (теги), CR (нормализуется в LF), NUL (в U+FFFD) и ведущий
  // пробел (парсер отбрасывает пробельные символы перед первым содержимым body).
  const NEEDS_PARSE = /^\s|[&<\r\u0000]/;
  let htmlParser = null;
  function decodeHtmlText(s) {
    const str = String(s);
    if (!NEEDS_PARSE.test(str)) return str;
    try {
      if (!htmlParser) htmlParser = new DOMParser();
      const doc = htmlParser.parseFromString(str, "text/html");
      return doc.body ? doc.body.textContent : str;
    } catch (e) { return str; }
  }
  const TX_FAIL = "Ошибка перевода";
  function errOf(r) { return (r && r.error) || TX_FAIL; }
  // Разбить строку на ведущие/конечные пробелы и «ядро» — пробелы сохраняем, ядро переводим.
  function splitWs(raw) {
    const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  // ---- определение языка (on-device, бесплатно) ----
  function ensureDetector() {
    if (detector) return Promise.resolve(detector);
    if (!("LanguageDetector" in self)) return Promise.resolve(null);
    if (!detectorInit) {
      detectorInit = (async () => {
        try {
          if ((await LanguageDetector.availability()) === "unavailable") return null;
          detector = await LanguageDetector.create();
        } catch (e) { /* без оптимизации */ }
        return detector || null;
      })();
    }
    return detectorInit;
  }

  async function isAlreadyTarget(text) {
    // Если источник задан вручную и совпадает с целью — переводить нечего.
    if (settings.sourceLang && settings.sourceLang !== "auto" &&
        HT_langBase(settings.sourceLang) === targetBase().toLowerCase()) return true;
    const det = await ensureDetector();
    if (!det) return false;
    try {
      const res = await det.detect(text);
      const top = res && res[0];
      if (!top || top.confidence < 0.5) return false;
      return top.detectedLanguage.toLowerCase() === targetBase().toLowerCase();
    } catch (e) {
      return false;
    }
  }

  async function detectLang(text) {
    if (settings.sourceLang && settings.sourceLang !== "auto") return HT_langBase(settings.sourceLang);
    const det = await ensureDetector();
    if (!det) return null;
    try {
      const res = await det.detect(text);
      const top = res && res[0];
      if (top && top.confidence >= 0.4) return top.detectedLanguage.toLowerCase();
    } catch (e) { /* нет детектора */ }
    return null;
  }

  // ---- движки перевода ----

  // Встроенный Chrome Translator (on-device): инстансы кэшируются по паре языков.
  async function getTranslator(src, tgt) {
    const key = src + ">" + tgt;
    if (!translators.has(key)) {
      translators.set(key, (async () => {
        try {
          if ((await Translator.availability({ sourceLanguage: src, targetLanguage: tgt })) === "unavailable") return null;
          return await Translator.create({ sourceLanguage: src, targetLanguage: tgt });
        } catch (e) { return null; }
      })());
    }
    const inst = await translators.get(key);
    if (!inst) translators.delete(key); // не закрепляем неудачу — дадим шанс пересоздать
    return inst;
  }

  // Перевод по тексту (без HTML) встроенным движком. Возвращает src для бейджа.
  async function chromeTranslate(text, targetLang) {
    if (!("Translator" in self)) return { ok: false, error: "Встроенный переводчик недоступен (Chrome 138+, desktop)." };
    const tgt = HT_langBase(targetLang);
    const src = await detectLang(text);
    if (!src) return { ok: false, error: "Не удалось определить язык (встроенный переводчик)." };
    if (src === tgt) return { ok: true, value: "", src }; // уже на целевом — оставляем оригинал
    try {
      const tr = await getTranslator(src, tgt);
      if (!tr) return { ok: false, error: `Пара ${src}→${tgt} недоступна для встроенного переводчика.` };
      return { ok: true, value: await tr.translate(text), src };
    } catch (e) {
      return { ok: false, error: "Встроенный переводчик: " + (e && e.message ? e.message : e) };
    }
  }

  // Встроенный движок для всего списка. Если не перевелось НИЧЕГО — отдаём error: все вызывающие
  // определяют сбой по этому полю, и без него встроенный движок падал абсолютно молча
  // (неподдерживаемая пара языков, Chrome < 138 — пользователь наводит, и не происходит ничего).
  // primaryError — ошибка основного движка в режиме auto: она информативнее («не задан ключ»).
  async function localResults(texts, primaryError) {
    const results = await Promise.all(texts.map((t) => chromeTranslate(t, settings.targetLang)));
    if (results.some((r) => r && r.ok)) return { results };
    const own = (results.find((r) => r && r.error) || {}).error;
    return { results: null, error: primaryError || own || TX_FAIL };
  }

  // ЕДИНСТВЕННЫЙ путь к движку → { results:[{ok,value,src}] } либо { results:null, error }.
  // Перевод одного элемента — это батч из одного элемента: пока для него был отдельный путь,
  // политика движков (выбор, фолбэк, обработка ошибок) жила в двух копиях и они уже разошлись —
  // правило «не перевелось ничего → error» было только в одной.
  // Движку уходит экранированный ТЕКСТ, а не разметка страницы: иначе в платный движок и в ключ
  // кэша попадала бы вся span-обвязка каркаса (кратная переплата и промах кэша на каждом
  // ре-рендере). Ответ раскодируется обратно в чистый текст. `by` — кто инициировал перевод
  // (HT_BY_PAGE / HT_BY_USER), от этого зависит бюджет расхода в background.
  async function translateItems(texts, by) {
    const e = HT_engine(settings.engine);
    if (e.via === "local") return localResults(texts);
    let resp;
    try {
      resp = await chrome.runtime.sendMessage(Object.assign(
        { type: "translateBatch", items: texts.map(escapeHtml), by }, txOpts()));
    } catch (err) {
      // Реджект здесь означает только одно: контекст расширения инвалидирован (его перезагрузили
      // или обновили). Сообщение движка тут ни при чём.
      resp = { ok: false, error: "Расширение перезагружено — обновите страницу." };
    }
    if (resp && resp.ok && Array.isArray(resp.texts)) {
      return {
        results: resp.texts.map((t, i) => ({
          ok: true,
          value: decodeHtmlText(t),
          src: resp.srcLangs ? resp.srcLangs[i] : null,
        })),
      };
    }
    const err = errOf(resp);
    if (e.fallback === "local") return localResults(texts, err); // основной движок не смог
    return { results: null, error: err };
  }

  // ---- подсветка ----
  function hexToRgba(hex, alpha) {
    const m = String(hex).replace("#", "");
    const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    const r = parseInt(n.slice(0, 2), 16) || 0;
    const g = parseInt(n.slice(2, 4), 16) || 0;
    const b = parseInt(n.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Яркость цвета rgb()/rgba(); null — прозрачный или нераспознанный формат.
  function colorLum(c) {
    const m = c && c.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a <= 0.1) return null;
    return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  }

  // Яркость ближайшего непрозрачного фона (для адаптивной подсветки).
  function bgLuminance(el) {
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 30; i++, node = node.parentElement) {
      const lum = colorLum(getComputedStyle(node).backgroundColor);
      if (lum !== null) return lum;
    }
    const b = document.body ? colorLum(getComputedStyle(document.body).backgroundColor) : null;
    if (b != null) return b;
    const h = colorLum(getComputedStyle(document.documentElement).backgroundColor);
    return h == null ? 1 : h;
  }

  const BORDER_OFFSET = 3;   // отступ границы от текста, px
  const BORDER_WIDTH = 2;    // толщина границы, px

  function highlightFor(el) {
    if (settings.dispMode === "none") return { bg: "", outline: "", offset: "" };
    if (settings.dispMode === "custom") {
      const bg = hexToRgba(settings.dispBg, (Number(settings.dispOpacity) || 0) / 100);
      const outline = settings.dispBorder
        ? `${BORDER_WIDTH}px ${settings.dispBorderStyle || "solid"} ${settings.dispBorderColor}`
        : "";
      return { bg, outline, offset: outline ? `${BORDER_OFFSET}px` : "" };
    }
    // auto — адаптивно к фону сайта (фон родителя — подложка под полупрозрачной подсветкой).
    const lum = bgLuminance(el.parentElement || el);
    return { bg: lum < 0.5 ? "rgba(255,255,255,0.18)" : "rgba(0,120,215,0.12)", outline: "", offset: "" };
  }

  // Подсветка owner-а. Перед записью снимаем СНИМОК собственного inline-style элемента
  // (значение + priority) и при откате возвращаем именно его. Раньше откат делал removeProperty,
  // то есть одно наведение на <span style="background-color:#ffe58f;border-radius:6px"> (бейдж,
  // тег, кнопка — обычное дело в веб-приложениях) навсегда стирало эти свойства страницы,
  // а restyleAll стирал их сразу у всех переведённых строк при смене темы подсветки.
  function applyHLLine(line) {
    const owner = line.owner;
    const h = highlightFor(owner);
    line.hlSaved = null;
    if (!h.bg && !h.outline) return; // «без подсветки» — не трогаем стиль
    const want = [["border-radius", "3px", ""]];
    if (h.bg) want.unshift(["background-color", h.bg, ""]);
    if (h.outline) want.push(["outline", h.outline, "important"], ["outline-offset", h.offset, "important"]);
    line.hlSaved = want.map(([name]) => [name, owner.style.getPropertyValue(name), owner.style.getPropertyPriority(name)]);
    for (const [name, value, prio] of want) owner.style.setProperty(name, value, prio);
  }

  function clearHLLine(line) {
    const saved = line.hlSaved;
    if (!saved) return;
    line.hlSaved = null;
    const st = line.owner.style;
    for (const [name, value, prio] of saved) {
      if (value) st.setProperty(name, value, prio); // возвращаем собственный inline-style страницы
      else st.removeProperty(name);                 // своего значения не было — просто снимаем наше
    }
  }

  // Наш UI (карточка перевода и HUD) живёт в shadow root. Это обычный DOM страницы, а CSS
  // контент-скрипта попадает в author origin ПЕРЕД таблицами страницы, поэтому её собственные
  // правила (.site select { height:44px }, .card span { color:#000 }) перебивали наши по
  // специфичности. Внутри shadow root правила страницы недоступны; наследуемые свойства
  // (шрифт, цвет, выравнивание) задаём явно, а позицию и слой хоста — инлайново с !important.
  // Побочная польза: document.body.querySelectorAll("*") в shadow root не заглядывает, так что
  // наша разметка вообще не попадает в кандидаты на перевод.
  // Общая часть оформления: токенами на :host, чтобы конкретный CSS переопределял только своё.
  const UI_BASE_CSS = `
    :host {
      --ht-bg: #1f2430;
      --ht-fg: #f3f4f6;
      --ht-shadow: 0 6px 24px rgba(0, 0, 0, .35);
      --ht-font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
  `;

  // Shadow root закрытый: в открытый сайт может зайти через host.shadowRoot и выбрать в списке
  // мини-панели любое значение, а оно пишется в настройки и действует на всех сайтах.
  // host.shadowRoot у закрытого — null, поэтому ссылку на root держим сами.
  const uiRoots = new WeakMap();      // host -> его закрытый shadow root

  function makeUiHost(css, zIndex) {
    const host = document.createElement("div");
    host.setAttribute("data-ht-ui", "1");
    const s = host.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("z-index", zIndex, "important");
    s.setProperty("margin", "0", "important");
    s.setProperty("padding", "0", "important");
    s.setProperty("border", "0", "important");
    s.setProperty("width", "max-content", "important");
    s.setProperty("visibility", "visible", "important");
    s.setProperty("opacity", "1", "important");
    const root = host.attachShadow({ mode: "closed" });
    uiRoots.set(host, root);
    const style = document.createElement("style");
    style.textContent = UI_BASE_CSS + css;
    root.appendChild(style);
    return { host, root };
  }

  // Смонтировать наше окно на страницу.
  function mountUi(node) { (document.body || document.documentElement).appendChild(node); }

  // Слои: карточка < HUD < тост. Раньше HUD и тост стояли на 2147483647, а карточка — на
  // 2147483646, поэтому карточка накрывала панель смены языка.
  const Z_POPOVER = "2147483644";
  const Z_HUD = "2147483645";
  const Z_TOAST = "2147483646";

  // Внимание: расширение НИГДЕ не пишет в innerHTML. Ответ движка — недоверенный HTML: LLM можно
  // prompt-инъекцией заставить вернуть живой <img onerror=…>, а DeepL в режиме tag_handling:html
  // отдаёт разметку как есть. Поэтому единственная точка вставки — textContent, а decodeHtmlText
  // инертно снимает сущности и теги через DOMParser. Санитайзер-денилист, стоявший здесь раньше,
  // применялся только к движку llm (для дефолтного deepl не применялся вообще), пропускал
  // фреймворковые директивы (hx-*, x-*, v-on:/@click) и не спускался во вложенный <template>.

  // ---- поповер (плавающая карточка над/под элементом, только при наведении) ----
  const POPOVER_CSS = `
    .card {
      /* Длинный перевод (isTextTarget пропускает до 2000 символов) не влезал в экран: карточка
         прижималась к top:8px, а хвост обрезался и доскроллить до него было нельзя. */
      max-height: min(60vh, 420px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 8px 10px;
      border-radius: 8px;
      font: 14px/1.45 var(--ht-font-family);
      text-align: left;
      letter-spacing: normal;
      white-space: normal;
      color: var(--ht-fg);
      background: var(--ht-bg);
      box-shadow: var(--ht-shadow);
    }
    .card.loading { color: #cbd5e1; font-style: italic; }
    /* Бейдж исходного языка (EN → RU) — маленькая «таблетка» перед переводом. */
    .badge {
      display: inline-block;
      margin-right: 6px;
      padding: 0 5px;
      border-radius: 999px;
      font: 600 10px/1.6 var(--ht-font-family);
      letter-spacing: .2px;
      vertical-align: middle;
      color: #fff;
      background: rgba(255, 255, 255, .18);
      white-space: nowrap;
      user-select: none;
    }
    .body { display: inline; }
  `;

  function repositionPopovers() {
    popPending = false;
    for (const [owner, st] of Array.from(popovers)) {
      if (st && st.node && owner.isConnected) { positionPopover(st.node, owner); continue; }
      // Владелец отвалился (SPA перерисовала DOM) — снимаем и САМ узел карточки. Раньше здесь
      // владелец просто удалялся из коллекции: узел оставался в DOM навсегда, а все пути
      // очистки (restoreAll, sweeper, mouseout, toggle) ходят по этой же коллекции и до него
      // уже не доставали.
      removePopover(owner, st && st.node);
    }
  }

  // Слушатели висят до конца жизни страницы, а scroll с capture приходит со всех прокручиваемых
  // контейнеров. Без флага K событий в одном кадре давали K полных проходов с принудительным
  // layout на каждую карточку — и это работало даже когда ни одной карточки нет.
  function schedulePopReposition() {
    if (popPending || !popovers.size) return;
    popPending = true;
    requestAnimationFrame(repositionPopovers);
  }

  function ensurePopScroll() {
    if (popScrollBound) return;
    popScrollBound = true;
    addEventListener("scroll", schedulePopReposition, true);
    addEventListener("resize", schedulePopReposition);
  }

  function positionPopover(node, el) {
    const r = el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const w = node.offsetWidth, h = node.offsetHeight;
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - h - 8); // не влезает сверху — снизу
    let left = Math.max(8, Math.min(r.left, vw - w - 8));
    node.style.setProperty("left", left + "px", "important");
    node.style.setProperty("top", Math.max(8, top) + "px", "important");
  }

  function showPopover(el, content, badge, stateClass) {
    const { host, root } = makeUiHost(POPOVER_CSS, Z_POPOVER);
    host.style.setProperty("max-width", "min(360px, 90vw)", "important");
    const card = document.createElement("div");
    card.className = "card";
    root.appendChild(card);
    fillPopover(host, content, badge, stateClass);
    // Карточку намеренно можно навести и прокрутить, поэтому pointer-events её не отключает.
    // Мерцание, от которого раньше спасал pointer-events:none, закрыто проверками relatedTarget
    // здесь и в обработчике mouseout.
    host.addEventListener("mouseleave", (ev) => {
      if (!ev.isTrusted) return;                          // хост лежит в DOM страницы — события сайта не слушаем
      if (settings.trigger !== "dwell") return;          // в режиме клавиши держим до повторного нажатия
      const to = ev.relatedTarget;
      if (to && (el === to || el.contains(to))) return;  // вернулись на сам элемент — карточку держим
      removePopover(el, host);
    });
    mountUi(host);
    const state = { node: host };
    popovers.set(el, state);          // и маркер «занят», и состояние — одной записью
    ensurePopScroll();
    positionPopover(host, el);
    return state;
  }

  // Содержимое карточки. Только textContent: ответ движка недоверенный, в innerHTML не пишем.
  function fillPopover(host, content, badge, stateClass) {
    const card = uiRoots.get(host).querySelector(".card");
    card.className = "card" + (stateClass ? " " + stateClass : "");
    card.textContent = "";
    if (badge) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = badge;
      card.appendChild(b);
    }
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = content;
    card.appendChild(body);
  }

  function updatePopover(host, el, content, badge, stateClass) {
    fillPopover(host, content, badge, stateClass);
    positionPopover(host, el);
  }

  function removePopover(owner, node) {
    const st = popovers.get(owner);
    const n = node || (st && st.node);
    if (n && n.parentNode) n.remove();
    popovers.delete(owner);
  }

  // ---- перевод наведением: поповер (элемент целиком) ----
  async function translatePopover(owner) {
    if (!owner || !owner.isConnected || isBusy(owner)) return;
    const gen = liveGen;   // токен отмены — ДО первого await, см. пояснение в translateLine
    inFlight.add(owner);
    try {
      const text = owner.textContent;
      if (await isAlreadyTarget(text)) return;
      if (gen !== liveGen || !settings.enabled || !owner.isConnected || isShown(owner)) return;
      const state = showPopover(owner, "Перевод…", null, "loading");
      const node = state.node;
      const out = await translateItems([text], HT_BY_PAGE);
      if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== state) {
        removePopover(owner, node);
        return;
      }
      const res = out.results && out.results[0];
      if (res && res.ok && res.value && res.value.trim()) {
        let src = res.src || null;
        if (!src && settings.showLangBadge) src = await detectLang(text);
        if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== state) { removePopover(owner, node); return; }
        const badge = (settings.showLangBadge && src && src.toLowerCase() !== targetBase().toLowerCase()) ? badgeText(src) : null;
        updatePopover(node, owner, res.value, badge, "");
      } else if (res) {
        removePopover(owner, node); // переводить нечего
      } else {
        removePopover(owner, node);
        toast(out.error || TX_FAIL, true);
      }
    } finally {
      inFlight.delete(owner);
    }
  }
  // ---- перевод наведением/страницы: замена текстовых узлов ----
  async function translateLine(owner, persistent) {
    if (!owner || !owner.isConnected || lineByOwner.has(owner) || inFlight.has(owner)) return;
    // Токен отмены снимаем ДО первого await. Раньше он брался после await isAlreadyTarget (а тот
    // ждёт создания on-device LanguageDetector — секунды при первом вызове): сброс или выключение
    // перевода за это время не замечались, потому что захватывался уже инкрементированный liveGen,
    // и текст заменялся спустя секунды после того, как пользователь перевод выключил.
    const gen = liveGen;
    inFlight.add(owner);
    let line = null, recs = null, committed = false;
    try {
      clearError(owner);

      if (await isAlreadyTarget(owner.textContent)) return;
      if (gen !== liveGen || !settings.enabled || !owner.isConnected || lineByOwner.has(owner)) return;

      const nodes = collectTextNodes(owner);
      if (!nodes.length) return;

      line = { owner, nodes, persistent: !!persistent, gen, hlSaved: null };
      recs = nodes.map((n) => newEntry(n, line));
      lineByOwner.set(owner, line);          // маркер «занят» — закрывает гонку и ловит mouseout во время await
      owner.classList.add("ht-loading");

      const { results, error } = await translateItems(recs.map((r) => r.core), HT_BY_PAGE);

      // отменён (сброс/выключение) или сброшен мышью/заменён за время ожидания
      if (gen !== liveGen || !owner.isConnected || lineByOwner.get(owner) !== line) return;
      if (error) { failOwner(owner, error); toast(error, true); return; }
      if (!writeLine(recs, results, line)) return;
      lines.add(line);
      applyHLLine(line);
      committed = true;
    } finally {
      inFlight.delete(owner);
      owner.classList.remove("ht-loading");
      // Уборка на любом выходе, включая исключение из translateItems: без неё owner навсегда
      // оставался «занятым» и выпадал и из hover, и из перевода страницы.
      if (!committed && line) dropLine(line);
    }
  }

  // Запись о текстовом узле для батча: ссылка на узел, его rec и разбивка на пробелы + «ядро».
  // Одна фабрика на все три пути — раньше этот блок был скопирован в каждый из них.
  function entryOf(node, rec, raw) { return Object.assign({ node, rec, line: rec.line }, splitWs(raw)); }
  function newEntry(node, line) {
    const raw = node.nodeValue;
    const rec = { orig: raw, translated: null, line };
    nodeRecs.set(node, rec);
    return entryOf(node, rec, raw);
  }

  // Единственная точка записи перевода в текстовый узел: пишем только если узел жив и всё ещё
  // держит РОВНО ожидаемое значение (иначе каркас приложения его уже подменил). Все три пути
  // записи — наведение, страница, перетранслирование — проходят здесь, раньше каждый проверял
  // это по-своему.
  function writeEntry(e, res, expect) {
    if (!res || !res.ok || !res.value || !res.value.trim()) return false;
    if (!e.node.isConnected || e.node.nodeValue !== expect) return false;
    const full = e.lead + res.value + e.trail;
    e.node.nodeValue = full;
    e.rec.translated = full;
    return true;
  }

  // Записать перевод в узлы строки. Возвращает, записали ли хоть что-то.
  function writeLine(recs, results, line) {
    let wrote = false;
    for (let i = 0; i < recs.length; i++) {
      if (line.gen !== liveGen) return wrote;            // глобальный сброс во время записи
      if (writeEntry(recs[i], results && results[i], recs[i].rec.orig)) wrote = true;
    }
    return wrote;
  }

  // ЕДИНСТВЕННАЯ точка снятия строки с учёта. revert=true — вернуть узлам исходный текст (откат
  // по мыши, по сбросу, перед повторным переводом); иначе только снять маркеры (владелец мёртв,
  // отмена, ошибка, пустой ответ). Раньше это были четыре почти одинаковых блока — restoreLine,
  // dropLine, cleanupPending и finally в translateLine — и условия владения в них разошлись:
  // два удаляли nodeRecs без проверки, третий только при translated == null, четвёртый не снимал
  // подсветку.
  function releaseLine(line, revert) {
    const owner = line.owner;
    for (const n of line.nodes) {
      const rec = nodeRecs.get(n);
      if (!rec || rec.line !== line) continue; // узел перехвачен другим переводом — не трогаем
      if (revert && n.isConnected && rec.translated != null && n.nodeValue === rec.translated) n.nodeValue = rec.orig;
      nodeRecs.delete(n);
    }
    if (lineByOwner.get(owner) === line) lineByOwner.delete(owner);
    lines.delete(line);
    clearHLLine(line);                 // и при keep-alive: иначе наш inline-style остался бы навсегда
    if (revert) clearError(owner);     // таймер, класс ошибки и исходный title
    owner.classList.remove("ht-loading"); // ht-translated нигде не ставится — снимать нечего
  }

  function restoreLine(line) { releaseLine(line, true); }  // с откатом текста к оригиналу
  function dropLine(line) { releaseLine(line, false); }    // без отката: текст уже не наш или узла нет

  // Жив ли перевод: хоть один узел ещё держит наше значение (каркас не перетёр).
  function lineAlive(line) {
    for (const n of line.nodes) {
      const rec = nodeRecs.get(n);
      if (rec && rec.line === line && n.isConnected && rec.translated != null && n.nodeValue === rec.translated) return true;
    }
    return false;
  }

  // Ошибка движка при наведении (замена): подсветить owner и сбросить через таймер.
  // Исходный title держим в WeakMap, а НЕ в замыкании таймера: повторное наведение таймер
  // отменяло, и текст ошибки оставался в title навсегда — а при повторном сбое failOwner
  // перечитывал title и сохранял уже саму ошибку как «оригинал», уничтожая тултип ссылки.
  // Снимок берём только первый раз, пока состояние ошибки не снято.
  function failOwner(owner, err) {
    const st = errors.get(owner);
    if (st) clearTimeout(st.timer);
    const title = st ? st.title : owner.getAttribute("title"); // снимок берём только первый раз
    owner.classList.remove("ht-loading");
    owner.classList.add("ht-error");
    owner.setAttribute("title", err);
    errors.set(owner, { title, timer: setTimeout(() => clearError(owner), 1800) });
  }

  // Снять состояние ошибки и вернуть элементу его собственный title. Единственная точка выхода
  // из состояния ошибки: и по таймеру, и по повторному наведению, и при откате строки.
  function clearError(owner) {
    owner.classList.remove("ht-error");
    const st = errors.get(owner);
    if (!st) return;
    clearTimeout(st.timer);
    errors.delete(owner);
    if (st.title == null) owner.removeAttribute("title"); else owner.setAttribute("title", st.title);
  }

  function restoreAll() {
    stopPageObserver();
    liveGen++; // отменяем переводы «в полёте»
    for (const line of Array.from(lines)) restoreLine(line);
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
  }

  // Перерисовать подсветку всех переведённых строк под текущую тему.
  function restyleAll() {
    for (const line of Array.from(lines)) {
      if (!line.owner.isConnected) { dropLine(line); continue; }
      clearHLLine(line);
      applyHLLine(line);
    }
  }

  function scheduleRestyle() {
    if (restylePending) return;
    restylePending = true;
    requestAnimationFrame(() => { restylePending = false; restyleAll(); });
  }

  // Смена настроек будит content-скрипт во всех фреймах всех вкладок, и каждый заново оплатил бы
  // всё, что в нём показано, — хотя видна одна вкладка. Скрытая вкладка перепереводит при первом
  // показе (iframe видим вместе со своей вкладкой).
  let retranslateOnShow = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && retranslateOnShow) {
      retranslateOnShow = false;
      scheduleRetranslate();
    }
  });

  function scheduleRetranslate() {
    clearTimeout(retranslateTimer);
    if (document.visibilityState !== "visible") { retranslateOnShow = true; return; }
    retranslateTimer = setTimeout(retranslateAll, 350); // коалесинг (ввод в «не переводить» и т.п.)
  }

  // Сменились язык/движок/формальность/исключения — перевод изменится. Переводим из СОХРАНЁННОГО
  // оригинала и заменяем только при успехе: при сбое движка прежние переводы остаются на месте.
  const LINE_BATCH = 20;
  async function retranslateAll() {
    if (!settings.enabled) return;
    // Вкладку могли скрыть за время задержки — тогда тоже ждём её показа.
    if (document.visibilityState !== "visible") { retranslateOnShow = true; return; }
    const list = [];
    for (const line of lines) {
      if (!line.owner.isConnected || inFlight.has(line.owner)) continue;
      inFlight.add(line.owner);
      list.push(line);
    }
    if (!list.length) return;
    const gen = liveGen;
    try {
      for (let i = 0; i < list.length; i += LINE_BATCH) {
        if (gen !== liveGen) return;
        await retranslateLines(list.slice(i, i + LINE_BATCH), gen);
      }
    } finally {
      for (const line of list) inFlight.delete(line.owner);
    }
  }

  async function retranslateLines(chunkLines, gen) {
    const entries = [];
    for (const line of chunkLines) {
      if (!line.owner.isConnected) continue;
      for (const n of line.nodes) {
        const rec = nodeRecs.get(n);
        if (!rec || rec.line !== line) continue; // узел перехвачен другим переводом — не трогаем
        entries.push(entryOf(n, rec, rec.orig));
      }
    }
    if (!entries.length) return;
    const { results, error } = await translateItems(entries.map((e) => e.core), HT_BY_USER);
    if (error) { toast(error, true); return; } // ошибка движка — прежние переводы остаются
    if (gen !== liveGen) return;
    // Ожидаемое значение узла здесь — текущий ПЕРЕВОД (а не оригинал): меняем свой текст на новый.
    for (let i = 0; i < entries.length; i++) writeEntry(entries[i], results[i], entries[i].rec.translated);
  }

  // Периодически убираем мёртвые узлы (SPA) — против утечки памяти.
  setInterval(() => {
    for (const line of Array.from(lines)) if (!line.owner.isConnected) dropLine(line);
    for (const owner of Array.from(popovers.keys())) if (!owner.isConnected) removePopover(owner);
  }, 30000);

  // ---- перевод всей страницы (батчами, с учётом кэша на стороне background) ----
  const PAGE_MAX = 500;
  const OWNER_BATCH = 20; // owner-ов на один сетевой батч (узлы внутри дочанкуются в background)

  // Кандидаты на перевод страницы. Уже переведённые owner-ы бюджет PAGE_MAX НЕ занимают: раньше
  // лимит применялся до фильтрации, поэтому повторный запуск снова упирался в те же первые 500
  // элементов (переведённый owner всё ещё проходит isTopInlineContainer и isTextTarget), фильтр
  // выбрасывал их все, и хвост длинной страницы не переводился никогда — сколько ни жми кнопку.
  function collectCandidates() {
    const all = document.body ? document.body.querySelectorAll("*") : [];
    const out = [];
    const memo = new Map();   // живёт только этот обход: структура DOM за него не меняется
    for (const el of all) {
      if (!isTopInlineContainer(el, memo)) continue; // дешёвая структурная проверка раньше textContent
      const line = lineByOwner.get(el);
      if (line) {
        if (inFlight.has(el) || lineAlive(line)) continue; // в работе или действительно переведён
        restoreLine(line);                                 // каркас перетёр перевод — чистим и переводим заново
      }
      if (!isTextTarget(el)) continue;
      out.push(el);
      if (out.length >= PAGE_MAX) break;
    }
    return out;
  }

  function stopPageObserver() {
    pageGen++; // отменяем всё, что в полёте по переводу страницы
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    pendingObserved.clear();
    clearTimeout(flushTimer);
  }

  function flushObserved() {
    const batch = Array.from(pendingObserved);
    pendingObserved.clear();
    if (batch.length) translatePageOwners(batch, pageGen);
  }

  async function translatePage() {
    if (!settings.enabled) return;
    stopPageObserver();          // сбрасывает прошлый прогон и инкрементит pageGen
    const gen = pageGen;
    const fresh = collectCandidates();
    // Молчать нельзя: раньше при пустом списке не было ни тоста, ни observer-а, и пользователь
    // жал кнопку снова и снова, не понимая, почему ничего не происходит.
    if (!fresh.length) { toast("Переводить нечего", false); return; }

    const vh = innerHeight, vw = innerWidth;
    const inView = [], rest = [];
    for (const el of fresh) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      (visible ? inView : rest).push(el);
    }

    await translatePageOwners(inView, gen); // видимое — сразу
    if (gen !== pageGen) return;

    if (rest.length) {                   // остальное — по мере появления в зоне видимости
      pageObserver = new IntersectionObserver((entries, observer) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          if (!lineByOwner.has(e.target)) pendingObserved.add(e.target);
        }
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushObserved, 150);
      }, { rootMargin: "300px" });
      for (const el of rest) pageObserver.observe(el);
    }
  }

  async function translatePageOwners(owners, gen) {
    for (let i = 0; i < owners.length; i += OWNER_BATCH) {
      if (gen !== pageGen) return;
      await translatePageChunk(owners.slice(i, i + OWNER_BATCH), gen);
    }
  }

  async function translatePageChunk(chunk, gen) {
    const lgen = liveGen;   // токен отмены живых показов — ДО первого await
    // только свободные owner-ы, параллельная проверка «уже на целевом языке»
    const free = chunk.filter((el) => el.isConnected && !lineByOwner.has(el) && !inFlight.has(el));
    if (!free.length) return;
    const skip = await Promise.all(free.map((el) => isAlreadyTarget(el.textContent)));
    if (gen !== pageGen || lgen !== liveGen) return;
    const owners = free.filter((el, j) => !skip[j] && el.isConnected && !lineByOwner.has(el) && !inFlight.has(el));
    if (!owners.length) return;

    const lineObjs = [];
    const entries = []; // плоский список узлов всех owner-ов чанка
    for (const owner of owners) {
      const nodes = collectTextNodes(owner);
      if (!nodes.length) continue;
      inFlight.add(owner);
      owner.classList.add("ht-loading");
      const line = { owner, nodes, persistent: true, gen: lgen, hlSaved: null };
      lineByOwner.set(owner, line);
      lineObjs.push(line);
      for (const n of nodes) entries.push(newEntry(n, line));
    }
    if (!lineObjs.length) return;

    let results = null, error = null;
    try {
      const out = await translateItems(entries.map((e) => e.core), HT_BY_USER);
      results = out.results; error = out.error;
    } catch (e) {
      // Исключение раньше уходило наружу мимо уборки: owner-ы чанка навсегда оставались
      // в inFlight/lineByOwner, а перевод страницы вставал и не создавал IntersectionObserver.
      error = (e && e.message) || TX_FAIL;
    } finally {
      for (const line of lineObjs) line.owner.classList.remove("ht-loading");
    }

    const cancelled = gen !== pageGen;
    if (cancelled || error || !results) {
      for (const line of lineObjs) { inFlight.delete(line.owner); dropLine(line); }
      if (error && !cancelled) toast(error, true);
      return;
    }

    const wrote = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.line.gen !== liveGen || lineByOwner.get(e.line.owner) !== e.line) continue;
      if (writeEntry(e, results[i], e.rec.orig)) wrote.add(e.line);
    }

    for (const line of lineObjs) {
      inFlight.delete(line.owner);
      if (wrote.has(line)) { lines.add(line); applyHLLine(line); }
      else dropLine(line);           // ничего не записали — снять маркеры
    }
  }

  // ---- события ----
  // Везде проверяем e.isTrusted: страница может сама разослать mouseover/keydown/wheel через
  // dispatchEvent и так запускать платные переводы за счёт ключа пользователя.
  document.addEventListener("mouseover", (e) => {
    if (!e.isTrusted) return;
    if (!settings.enabled) return;
    const target = pickTarget(e.target);
    hoverEl = (target && isTextTarget(target)) ? target : null;
    // Клавишу держат и ведут курсор дальше — это жест «держу и навожу», а не одиночное нажатие:
    // переводим и элемент, над которым клавишу нажали, как все, над которыми проводят.
    if (modPress && modPress.el !== hoverEl && modHeld(e) && !modBusy()) {
      const start = modPress.el;
      modPress = null;
      if (start.isConnected && !isBusy(start)) startHover(start);
    }
    if (!hoverEl) return;

    if (settings.trigger === "dwell") {
      if (isBusy(hoverEl)) return;
      clearTimeout(dwellTimer);
      dwellTimer = setTimeout(() => startHover(hoverEl), HT_clampDwell(settings.dwellMs));
    } else if (modHeld(e) && !modBusy() && !isBusy(hoverEl)) {
      startHover(hoverEl);
    }
  }, true);

  // Жест колеса с зажатым модификатором: запоминаем, что клавишу держат не для нас. Слушатель
  // пассивный и только читает флаги события — прокрутку страницы он не задерживает.
  addEventListener("wheel", (e) => {
    if (!e.isTrusted) return;
    if (settings.trigger !== "dwell" && modHeld(e)) {
      modWheelUntil = Date.now() + MOD_WHEEL_GRACE;
      modPress = null;                // и отменяем реакцию на само нажатие клавиши
    }
  }, { capture: true, passive: true });

  document.addEventListener("mouseout", (e) => {
    if (!e.isTrusted) return;
    clearTimeout(dwellTimer);
    // Курсор ушёл из окна (или из этого фрейма): элемента под курсором больше нет. Иначе нажатие
    // клавиши-триггера потом переводило бы абзац, с которого курсор давно ушёл.
    if (!e.relatedTarget) hoverEl = null;
    if (settings.trigger !== "dwell") return; // в режиме клавиши перевод остаётся
    const owner = pickTarget(e.target);
    if (!owner) return;
    // Переход курсора на собственного потомка owner-а — это НЕ уход с элемента. mouseout
    // всплывает и с внутренних inline-узлов (<b>, <a>, <span>), а pickTarget сводит их к тому же
    // owner-у, поэтому без этой проверки перевод откатывался и запрашивался заново на КАЖДОМ
    // пересечении внутренней границы — то есть почти в любом реальном абзаце, по одному
    // оплаченному запросу на пересечение.
    const to = e.relatedTarget;
    if (to && (owner === to || owner.contains(to))) return;
    // Ушли в нашу же карточку перевода: её можно навести и прокрутить, снимает её собственный
    // mouseleave. Событие ретаргетится на хост, поэтому проверки самого узла достаточно.
    if (isOurUi(to)) return;
    if (popovers.has(owner)) { removePopover(owner); return; }
    const line = lineByOwner.get(owner);
    if (line && !line.persistent) restoreLine(line); // закреплённые (страница) не откатываем мышью
  }, true);

  // Клавиша-триггер срабатывает на «чистое» нажатие: модификатор нажали и отпустили, и за это время
  // не было ни другой клавиши (заглавная буква, Ctrl+C/V/F), ни кнопки мыши (Shift+клик —
  // выделение, Ctrl+клик — ссылка в новой вкладке), ни колеса (Shift+колесо — прокрутка вбок,
  // Ctrl+колесо — масштаб). В момент нажатия этого ещё не знать, поэтому решаем при отпускании:
  // таймер после нажатия не спасает от сочетания, набранного чуть медленнее таймера.
  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.repeat) return;                 // автоповтор зажатой клавиши — не новое нажатие
    modPress = null;                      // любая клавиша обрывает ожидаемое нажатие…
    if (!settings.enabled || settings.trigger === "dwell") return;
    if (!isTriggerKey(e) || !soloMod(e)) return;
    if (!hoverEl || modBusy() || typingFocus()) return;
    modPress = { key: e.key, el: hoverEl }; // …а одиночный модификатор над текстом начинает новое
  }, true);

  document.addEventListener("keyup", (e) => {
    if (!e.isTrusted) return;
    const p = modPress;
    if (!p || e.key !== p.key) return;
    modPress = null;
    // hoverEl === p.el отсекает случай, когда за время нажатия курсор ушёл с элемента (в том числе
    // из окна) или под него при прокрутке приехал другой.
    if (!settings.enabled || settings.trigger === "dwell" || modBusy() || hoverEl !== p.el) return;
    toggle(p.el);
  }, true);

  addEventListener("mousedown", (e) => { if (e.isTrusted) modPress = null; }, true);

  // Окно потеряло фокус (Alt+Tab, клик в адресную строку): отпускание клавиши придёт уже не нам,
  // а элемент под курсором неизвестен до следующего движения мыши.
  addEventListener("blur", () => { hoverEl = null; modPress = null; });

  // Команды из popup. Обязательно отвечаем (sendResponse), иначе на стороне popup
  // взводится lastError «порт закрыт» и страница ошибочно считается недоступной.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "restoreAll") { restoreAll(); sendResponse(true); }
    else if (msg.type === "translatePage") { translatePage(); sendResponse(true); }
    else if (msg.type === "toggleHud") { toggleHud(); sendResponse({ ok: true, hud: !!hud }); }
    else if (msg.type === "getHudState") { sendResponse({ ok: true, hud: !!hud }); }
    else sendResponse(true); // подтверждаем получение
  });

  // ---- мини-HUD: смена целевого языка и действия прямо на странице ----
  const HUD_MARGIN = 16;
  const HUD_CSS = `
    .bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px;
      border-radius: 10px;
      background: #1f2430;
      color: #f3f4f6;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
      font: 13px/1.2 system-ui, -apple-system, sans-serif;
    }
    .grip {
      width: 14px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, .45);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .grip:active { cursor: grabbing; }
    select, button {
      box-sizing: border-box;
      margin: 0;
      height: 28px;
      border: 1px solid rgba(255, 255, 255, .18);
      border-radius: 6px;
      background: #2a3142;
      color: #f3f4f6;
      font: 13px/1.2 system-ui, -apple-system, sans-serif;
      cursor: pointer;
    }
    select { max-width: 160px; padding: 0 6px; }
    button {
      width: 28px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: background .12s, border-color .12s;
    }
    button:hover { background: #39435a; border-color: rgba(255, 255, 255, .35); }
  `;

  function buildHud() {
    const { host, root } = makeUiHost(HUD_CSS, Z_HUD);
    const bar = document.createElement("div");
    bar.className = "bar";

    const grip = document.createElement("div");
    grip.className = "grip";
    grip.textContent = "⠿";
    grip.title = "Перетащить панель";

    const sel = document.createElement("select");
    sel.title = "Целевой язык";
    for (const [code, label] of LANGS) {
      const o = document.createElement("option");
      o.value = code; o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = settings.targetLang;
    // Панель живёт на странице, а запись действует на всех сайтах — пишем только настоящий выбор
    // пользователя и только значение из таблицы языков.
    sel.addEventListener("change", (e) => {
      if (!e.isTrusted || HT_valid("targetLang", sel.value) !== sel.value) return;
      chrome.storage.local.set({ targetLang: sel.value });
    });

    bar.append(
      grip, sel,
      hudButton("🌐", "Перевести страницу", () => translatePage()),
      hudButton("↺", "Сбросить переводы", () => restoreAll()),
      hudButton("✕", "Скрыть панель", () => toggleHud()),
    );
    root.appendChild(bar);
    bindHudDrag(host, grip);
    return { host, sel };
  }

  function hudButton(text, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", (e) => { if (e.isTrusted) onClick(); });
    return b;
  }

  // Панель закреплена снизу справа и там закрывает контент страницы — даём её перетащить
  // за ручку. Позицию помним на время жизни страницы.
  function bindHudDrag(host, grip) {
    grip.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { if (ev.isTrusted) placeHud(host, ev.clientX - dx, ev.clientY - dy); };
      const up = (ev) => {
        if (!ev.isTrusted) return;
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });
  }

  // Ставим панель по координатам, не давая уехать за пределы окна.
  function placeHud(host, left, top) {
    const l = Math.max(0, Math.min(left, innerWidth - host.offsetWidth));
    const t = Math.max(0, Math.min(top, innerHeight - host.offsetHeight));
    hudPos = { left: l, top: t };
    const s = host.style;
    s.setProperty("left", l + "px", "important");
    s.setProperty("top", t + "px", "important");
    s.removeProperty("right");
    s.removeProperty("bottom");
  }

  addEventListener("resize", () => { if (hud && hudPos) placeHud(hud.host, hudPos.left, hudPos.top); });

  function syncHud() { if (hud) hud.sel.value = settings.targetLang; }

  function toggleHud() {
    if (hud) { hud.host.remove(); hud = null; return; }
    hud = buildHud();
    mountUi(hud.host);
    if (hudPos) placeHud(hud.host, hudPos.left, hudPos.top);
    else {
      hud.host.style.setProperty("right", HUD_MARGIN + "px", "important");
      hud.host.style.setProperty("bottom", HUD_MARGIN + "px", "important");
    }
  }

  // ---- уведомление ----
  // Тоже через makeUiHost: это третье наше окно, и раньше единственное, оставшееся под правилами
  // страницы (инлайновый стиль перебивается её !important).
  const TOAST_CSS = `
    .toast {
      max-width: 80vw;
      padding: 8px 12px;
      border-radius: 8px;
      font: 13px/1.4 var(--ht-font-family);
      color: #fff;
      background: #178a3f;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .25);
      opacity: 0;
      transition: opacity .15s;
    }
    .toast.err { background: #c62828; }
    .toast.show { opacity: 1; }
  `;

  function toast(message, isError) {
    const now = Date.now();
    if (now - lastToastAt < 3000) return;
    lastToastAt = now;
    const { host, root } = makeUiHost(TOAST_CSS, Z_TOAST);
    const s = host.style;
    s.setProperty("left", "50%", "important");
    s.setProperty("bottom", "20px", "important");
    s.setProperty("transform", "translateX(-50%)", "important");
    s.setProperty("pointer-events", "none", "important");
    const card = document.createElement("div");
    card.className = "toast" + (isError ? " err" : "");
    card.textContent = message;
    root.appendChild(card);
    mountUi(host);
    // Прозрачность анимируем на карточке, а не на хосте: у хоста opacity выставлен с !important,
    // чтобы правила страницы не могли нас спрятать.
    requestAnimationFrame(() => card.classList.add("show"));
    setTimeout(() => { card.classList.remove("show"); setTimeout(() => host.remove(), 250); }, 2200);
  }
})();
