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
// Если выбранный переводчик не может работать (нет ключа, нет встроенного в браузере), страница не
// трогается вовсе; если расширение обновили или удалили, скрипт возвращает оригиналы и замолкает.
// На сайте из списка «выключено на этом сайте» скрипт ничего не переводит и не показывает панель.
// Esc возвращает оригинал везде на странице.
// Страница приветствия подключает этот файл напрямую (на страницах chrome-extension:// content
// scripts не запускаются), чтобы на ней можно было попробовать перевод.

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
  // owner -> таймер снятия красной подсветки ошибки. Сам текст ошибки на элемент страницы не
  // пишем (в title его прочитал бы скрипт сайта) — он только в нашем уведомлении в shadow root.
  const errors = new WeakMap();
  const translators = new Map();     // "src>tgt" -> Promise<{ inst } | { kind }> (встроенный движок)
  const pendingObserved = new Set(); // owner, вошедшие в зону видимости и ждущие перевода
  let pageObserver = null;
  let flushTimer = null;
  let pageGen = 0;                    // токен отмены перевода страницы (инкрементится при сбросе/новом запуске)
  let liveGen = 0;                    // токен отмены всех показов: сброс всех/выключение перевода во время await
  let hoverEl = null;
  let dwellTimer = null;
  let dwellFor = null;                // элемент, для которого взведён таймер задержки (или отсеян фильтром)
  let lastXY = null;                  // где был курсор при последнем mousemove — отличает движение от прокрутки
  let drift = null;                   // { line, x, y }: перевод, из-под которого курсор «уехал» без движения мыши
  let edgeOwner = null;               // элемент, который по задержке не переводим, пока курсор не уйдёт с него
  let popCloseTimer = 0;              // отложенное закрытие карточки (курсор идёт с абзаца на карточку)
  let popCloseOwner = null;
  let modPress = null;                // { key, el }: клавиша-триггер нажата, ждём её отпускания
  let modWheelUntil = 0;              // до этого времени модификатор занят жестом прокрутки/зума
  let lastToastAt = 0;
  let detector = null;
  let detectorPending = null;         // создание детектора в процессе (неудача не запоминается)
  let restylePending = false;
  let popScrollBound = false;
  let popPending = false;      // репозиция карточек уже запланирована на кадр
  let hud = null;
  let hudPos = null;                  // где стоит мини-панель (общее для всех сайтов, storage.local.hudPos)
  let hudWanted = false;              // показана ли мини-панель (общее для всех сайтов, storage.local.hudShown)
  let siteOff = false;                // этот сайт в списке «выключено на этом сайте»
  let pageToast = null;               // уведомление «Перевожу… / Готово» перевода страницы
  let retranslateTimer = null;

  // Подсветка — мгновенно (rAF), без перевода. Язык/движок/формальность/исключения — перетранслирование.
  // Способ показа и бейдж влияют на следующие переводы; уже показанное не перерисовываем: карточка
  // держит перевод абзаца одной строкой, а замене нужен перевод каждого текстового узла.
  const DISP_KEYS = ["dispMode", "dispBg", "dispOpacity", "dispBorder", "dispBorderColor", "dispBorderStyle"];
  const TX_KEYS = ["targetLang", "sourceLang", "engine", "formality", "noTranslate", "llmProvider", "llmModel"];
  // Сами ключи API в content не хранятся (и не должны), но их появление меняет результат перевода:
  // с engine=auto страница уже могла быть заполнена встроенным фолбэком, и после ввода ключа
  // DeepL её нужно перевести заново. В DEFAULTS этих полей нет, поэтому обрабатываем отдельно.
  const KEY_KEYS = ["apiKey", "llmApiKey"];
  // Есть ли ключи — только как факт (сами значения не держим): без ключа DeepL или ИИ наведение не
  // должно ничего делать на странице (см. blocked).
  const keyPresent = { apiKey: false, llmApiKey: false };
  // Согласие на отправку текста сервисам (deepl/openai/anthropic) — пишет только окно расширения.
  // Без согласия выбранный DeepL или ИИ — то же, что без ключа: текст никуда не уходит.
  let consent = HT_consent(null);
  // Состояние для HT_engineProblem/HT_canSend (shared.js): ключи как факт, провайдер ИИ, согласие, языки.
  function netState() {
    return Object.assign({ llmProvider: settings.llmProvider, consent,
      targetLang: settings.targetLang, sourceLang: settings.sourceLang }, keyPresent);
  }

  // Встроенный переводчик в этом окне: "none" — его нет в браузере (Chrome < 138, другие браузеры на
  // Chromium, телефон); "frame" — есть, но встроенному окну (iframe с другого адреса) его не
  // разрешили политикой сайта; "ok" — есть.
  const BUILTIN = (() => {
    if (!("Translator" in self)) return "none";
    try {
      const fp = document.featurePolicy;
      if (fp && fp.features().includes("translator") && !fp.allowsFeature("translator")) return "frame";
    } catch (e) { /* нет API политики — считаем, что можно */ }
    return "ok";
  })();

  // Своя страница расширения (приветствие подключает этот файл напрямую): её не выключить «на этом
  // сайте», на ней нет мини-панели и команд из окна расширения.
  const OWN_PAGE = location.origin === new URL(chrome.runtime.getURL("")).origin;
  const TOP = window === window.top;

  // Сайт вкладки — для списка «выключено на этом сайте». Во встроенном окне (iframe) — сайт верхней
  // страницы: выключили почту — не переводим и её встроенные окна. Пусто — у страницы нет имени
  // хоста (file://, своя страница расширения), выключить её нельзя.
  const SITE = (() => {
    if (OWN_PAGE) return "";
    let origin = location.origin;
    try {
      const a = location.ancestorOrigins;
      if (!TOP && a && a.length) origin = a[a.length - 1];
    } catch (e) { /* нет ancestorOrigins — берём свой адрес */ }
    try { return HT_siteKey(new URL(origin).hostname); } catch (e) { return ""; }
  })();
  function siteListed(list) { return !!SITE && HT_sites(list).includes(SITE); }

  // Переводить ли сейчас: настройки прочитаны, перевод включён и сайт не выключен. Пока хранилище не
  // ответило, не переводим вовсе: иначе ранний Shift на выключенном сайте успел бы отправить текст.
  let loaded = false;
  function active() { return loaded && settings.enabled && !siteOff; }

  // Все обработчики на странице вешаем через on(): после обновления или удаления расширения скрипт
  // остаётся жить на открытых вкладках, и тогда их надо снять разом (см. alive).
  const unbinders = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    unbinders.push(() => target.removeEventListener(type, fn, opts));
  }

  // Сообщение в background. После обновления расширения sendMessage бросает синхронно — сводим это
  // к отклонённому обещанию, чтобы у вызывающих был один путь ошибки.
  function send(msg) {
    try { return chrome.runtime.sendMessage(msg); } catch (e) { return Promise.reject(e); }
  }

  // Перечисления (язык, движок, тон, способ показа, клавиша) сверяем с таблицами shared.js при
  // каждом чтении: неизвестное значение становится значением по умолчанию. Список выключенных сайтов
  // и положение мини-панели тоже сверяем (shared.js): их пишет и мини-панель на странице.
  const EXTRA = { apiKey: "", llmApiKey: "", consent: {}, htBuiltinApi: null, disabledSites: [], hudShown: false, hudPos: null };
  chrome.storage.local.get(Object.assign({}, EXTRA, DEFAULTS), (s) => {
    for (const k of KEY_KEYS) keyPresent[k] = !!s[k];
    consent = HT_consent(s.consent);
    syncBuiltinFlag(s.htBuiltinApi);
    siteOff = siteListed(s.disabledSites);
    hudWanted = s.hudShown === true;
    hudPos = HT_hudPos(s.hudPos);
    for (const k in EXTRA) delete s[k];
    settings = HT_validAll(s);
    loaded = true;
    if (siteOff) tellSiteBadge();
    updateHud();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    let dispChanged = false, txChanged = false, enabledOff = false;
    for (const k in changes) {
      const ch = changes[k];
      if (KEY_KEYS.includes(k)) {           // значение не запоминаем — нужен только факт смены
        keyPresent[k] = !!ch.newValue;
        if (ch.oldValue !== ch.newValue) txChanged = true;
        continue;
      }
      // Согласие дали — с «авто» страница могла быть переведена встроенным, переводим заново (как при
      // появлении ключа); отозвали — следующие переводы не уйдут в сеть.
      if (k === "consent") {
        const next = HT_consent(ch.newValue);
        if (JSON.stringify(next) !== JSON.stringify(consent)) { consent = next; txChanged = true; }
        continue;
      }
      if (k === "disabledSites") {
        const off = siteListed(ch.newValue);
        if (off !== siteOff) { siteOff = off; siteChanged(); }
        continue;
      }
      if (k === "hudShown") { hudWanted = ch.newValue === true; updateHud(); continue; }
      if (k === "hudPos") {
        hudPos = HT_hudPos(ch.newValue);
        if (hud && hudPos) placeHud(hud.host, hudPos.left, hudPos.top);
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

  // Сайт выключили — возвращаем оригиналы, убираем панель и карточки; включили — панель возвращается,
  // если она была показана. Значок вкладки меняет верхний фрейм.
  function siteChanged() {
    if (siteOff) { restoreAll(); clearTimeout(dwellTimer); dwellFor = null; }
    updateHud();
    tellSiteBadge();
  }
  function tellSiteBadge() {
    if (TOP && SITE) send({ type: "siteBadge", off: siteOff }).catch(() => {});
  }

  // Есть ли встроенный переводчик в браузере, точно знает только окно, а «!» на значке ставит
  // background. Поэтому верхний фрейм записывает это в хранилище, если записанное расходится с
  // действительным (обычно — ни разу: значение пишут уже страница приветствия и окно расширения).
  function syncBuiltinFlag(stored) {
    if (window !== window.top) return;
    const has = BUILTIN !== "none";
    if (stored !== has) chrome.storage.local.set({ htBuiltinApi: has }).catch(() => {});
  }

  // ---- связь с расширением ----
  // После обновления, перезагрузки или удаления расширения этот скрипт продолжает жить на уже
  // открытых вкладках, но chrome.* больше не отвечает (chrome.runtime.id пропадает). Тогда
  // возвращаем странице оригиналы, снимаем свои обработчики и замолкаем — вместо красной ошибки на
  // каждом наведении. Новая версия заработает после обновления вкладки (окно расширения подскажет).
  let dead = false;
  function alive() {
    if (dead) return false;
    let id = null;
    try { id = chrome.runtime && chrome.runtime.id; } catch (e) { id = null; }
    if (id) return true;
    shutdown();
    return false;
  }

  function shutdown() {
    dead = true;
    restoreAll();
    hud = null;
    // Мини-панель и уведомления (они живут по своим таймерам) — тоже убираем: это интерфейс старой версии.
    for (const host of document.querySelectorAll("[data-ht-ui]")) host.remove();
    clearTimeout(dwellTimer);
    clearTimeout(retranslateTimer);
    clearTimeout(popCloseTimer);
    clearInterval(sweepTimer);
    hoverEl = null;
    modPress = null;
    drift = null;
    for (const off of unbinders.splice(0)) off();
  }

  // ---- может ли перевод работать ----
  // Выбранный переводчик не может работать (нет ключа или согласия, нет встроенного) — наведение ничего не
  // делает: ни красной подсветки, ни ошибки на каждом абзаце. Объяснение — «!» на значке и в окне
  // расширения, а на странице — одно спокойное уведомление за сессию браузера (решает background).
  // Явное действие («Перевести страницу») объясняем всегда.
  let problemAsked = false;
  function problem() { return HT_engineProblem(settings.engine, netState(), BUILTIN === "ok"); }
  function blocked(byUser) {
    const p = problem();
    if (!p) return false;
    // Во встроенном окне чужого сайта встроенный переводчик запрещён политикой этого сайта — это
    // не поломка, о которой стоит рассказывать.
    if (BUILTIN === "frame" && !HT_engineProblem(settings.engine, netState(), true)) return true;
    if (byUser) { problemNotice(p); return true; }
    if (!problemAsked) {
      problemAsked = true;
      send({ type: "noticeOnce", problem: p })
        .then((r) => { if (r && r.show && !dead) problemNotice(p); })
        .catch(() => {});
    }
    return true;
  }
  // Объяснение с кнопками: без ключа или согласия, с языком, которого нет у DeepL, — включить встроенный
  // (если он есть) или открыть настройки; встроенный недоступен или не знает язык — только настройки.
  function problemNotice(p) {
    const local = p === "no-builtin" || p === "builtin-lang" || BUILTIN !== "ok";
    notice(HT_problemText(p, "page", netState()), 12000, { actions: local ? [ACT.settings] : [ACT.builtin, ACT.settings], closable: true });
  }

  // ---- кнопки в уведомлениях ----
  // Нажимаются только настоящим щелчком (проверка isTrusted — в showToast). Записываемое значение —
  // только из таблицы shared.js.
  const ACT = {
    settings: { label: HT_t("openSettings"), run: () => { send({ type: "openSettings" }).catch(() => {}); } },
    builtin: { label: HT_t("switchToBuiltin"), run: useBuiltin },
  };
  function useBuiltin() {
    chrome.storage.local.set({ engine: HT_valid("engine", "chrome") })
      .then(() => notice(HT_t("builtinOn"), 5000))
      .catch(() => {});
  }
  // Какие кнопки предложить к ошибке перевода (коды ошибок — в background.js, failure()).
  function actionsFor(code) {
    if (code === "bad-key" || code === "no-key" || code === "model" || code === "lang") return [ACT.settings];
    if (code === "no-consent") return BUILTIN === "ok" ? [ACT.builtin, ACT.settings] : [ACT.settings];
    if (code === "quota" || code === "money" || code === "denied") return [BUILTIN === "ok" ? ACT.builtin : ACT.settings];
    return [];
  }

  // ---- наведение с задержкой: что не переводить ----
  // Задержка срабатывает сама, без просьбы, поэтому здесь осторожнее, чем в режиме клавиши (там
  // человек просит явно и переводится всё): не трогаем ссылки, кнопки, пункты меню и навигации —
  // курсор на них обычно по пути к щелчку, а перевод сдвинул бы текст под ним, — и тексты короче
  // трёх слов (подписи, кнопки «ОК», цены).
  const INTERACTIVE = "a[href], button, summary, [role=button], [role=link], [role=menuitem], " +
    "[role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option]";
  const NAVIGATION = "nav, [role=navigation], [role=menu], [role=menubar], [role=tablist], [role=toolbar]";
  // Письменности без пробелов между словами: слова там не посчитать, считаем знаки.
  const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;
  const MIN_WORDS = 3, MIN_NO_SPACE_CHARS = 6;
  function tooShort(text) {
    const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    if (words >= MIN_WORDS) return false;
    return (text.match(NO_SPACE) || []).length < MIN_NO_SPACE_CHARS;
  }
  // owner — что перевели бы, target — элемент прямо под курсором.
  function dwellSkip(owner, target) {
    if (target && target.nodeType === 1 && target.closest(INTERACTIVE)) return true;
    if (owner.closest(INTERACTIVE + ", " + NAVIGATION)) return true;
    return tooShort(owner.textContent || "");
  }

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
    // Курсор на пустом месте под содержимым — это <html>: его дети HEAD и BODY в BLOCK_TAGS нет, и на
    // короткой странице (до 2000 знаков) переводился бы весь документ вместе с <title>, а строки
    // вложенных абзацев потом делили бы с ним одни и те же текстовые узлы.
    if (start === document.documentElement) return null;
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
      if (popovers.has(owner)) removePopover(owner); else if (!blocked(false)) translatePopover(owner);
    } else {
      const line = lineByOwner.get(owner);
      if (line) restoreLine(line); else if (!blocked(false)) translateLine(owner, false);
    }
  }

  function startHover(owner) {
    if (blocked(false)) return;
    if (settings.displayMode === "popover") translatePopover(owner);
    else translateLine(owner, false);
  }

  // «Показ уже есть» — строка или карточка; isBusy добавляет «запрос уже в полёте».
  function isShown(owner) { return lineByOwner.has(owner) || popovers.has(owner); }
  function isBusy(owner) { return isShown(owner) || inFlight.has(owner); }

  function targetBase() { return HT_langBase(settings.targetLang || "RU").toUpperCase(); }
  function badgeText(src) { return `${src.toUpperCase()} → ${targetBase()}`; }
  // Тот же ли это язык, что язык перевода (детектор называет язык своим кодом: "no", "iw", "zh").
  function isTargetLang(code) { return HT_langKey(code) === HT_langKey(settings.targetLang || "RU"); }

  // Параметры перевода для background (движок/языки/формальность/исключения).
  function txOpts() {
    return {
      engine: settings.engine || HT_DEFAULTS.engine,
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
  const TX_FAIL = HT_t("txFail");
  // Неудача из ответа background: текст, код (по нему — встроенный вместо DeepL и кнопки), подробности.
  function failOf(r) {
    return { error: (r && r.error) || TX_FAIL, code: (r && r.code) || "", detail: (r && r.detail) || "" };
  }
  // Разбить строку на ведущие/конечные пробелы и «ядро» — пробелы сохраняем, ядро переводим.
  function splitWs(raw) {
    const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  // ---- встроенный переводчик и определение языка (на компьютере пользователя, бесплатно) ----
  // Пока модель не скачана (availability = "downloadable"/"downloading"), Chrome создаёт переводчик
  // и детектор только по действию пользователя — щелчку или нажатию обычной клавиши. Наведение им
  // не считается, одиночный Shift/Ctrl/Alt — тоже (проверено в Chrome 157). Без такого действия
  // create() не зовём: честно говорим, что модель не скачана и что сделать, и неудачу НЕ
  // запоминаем — после щелчка или подготовки в окне расширения следующий перевод сработает.
  function userActive() { return !!(navigator.userActivation && navigator.userActivation.isActive); }

  // Уведомление с ходом загрузки модели: create() с monitor сообщает долю скачанного. Подсказку
  // «нужно скачать» оно заменяет — оба стоят на одном месте внизу страницы.
  let downloadHint = null;
  function downloadNotice(what) {
    if (downloadHint) { downloadHint.close(); downloadHint = null; }
    const t = showToast({ message: HT_t("dlProgress", what), kind: "info", ms: 0, title: extName() });
    return {
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          t.set(HT_t("dlProgressPct", [what, Math.round(100 * (e.total ? e.loaded / e.total : e.loaded))]));
        });
      },
      done() { t.close(); },
    };
  }

  const CREATE_RETRY_MS = [300, 700, 1000, 1500, 2500];   // ~6 с в сумме

  // Создать экземпляр встроенного API (Translator / LanguageDetector) → { inst } либо
  // { kind: "unavailable" | "download" | "fail", state, error }. mayDownload=false — только если
  // модель уже есть (детектор как оптимизация для DeepL/ИИ не должен тратить щелчок пользователя).
  async function createModel(api, opts, what, mayDownload) {
    let state;
    try { state = await api.availability(opts); } catch (e) { return { kind: "fail", error: e }; }
    if (state === "unavailable") return { kind: "unavailable" };
    const ready = state === "available";
    if (!ready && !(mayDownload && userActive())) return { kind: "download", state };
    const n = ready ? null : downloadNotice(what);
    try {
      return { inst: await api.create(n ? Object.assign({ monitor: n.monitor }, opts) : opts) };
    } catch (e) {
      // Сразу после загрузки модели Chrome ещё несколько секунд (замерено на 157: ~3 с) отказывает
      // в create() с NotSupportedError, хотя availability уже «available» — в том числе когда модель
      // скачали в окне расширения только что. Повторяем с паузами, без действия пользователя.
      let err = e;
      for (const pause of CREATE_RETRY_MS) {
        if (err && err.name === "NotAllowedError") break;
        if ((await api.availability(opts).catch(() => "")) !== "available") break;
        await new Promise((r) => setTimeout(r, pause));
        try { return { inst: await api.create(opts) }; } catch (e2) { err = e2; }
      }
      // NotAllowedError — действие пользователя уже «потрачено» (например, на соседнюю модель).
      return err && err.name === "NotAllowedError" ? { kind: "download", state } : { kind: "fail", error: err };
    } finally {
      if (n) n.done();
    }
  }

  function getDetector(mayDownload) {
    if (detector) return Promise.resolve({ inst: detector });
    if (!("LanguageDetector" in self)) return Promise.resolve({ kind: "unavailable" });
    if (!detectorPending) {
      const p = createModel(LanguageDetector, {}, HT_t("dlDetector"), mayDownload)
        .catch((e) => ({ kind: "fail", error: e }))
        .then((r) => {
          if (r.inst) detector = r.inst;
          if (detectorPending === p) detectorPending = null;   // неудачу не запоминаем
          return r;
        });
      detectorPending = p;
    }
    return detectorPending;
  }

  async function isAlreadyTarget(text) {
    // Если источник задан вручную и совпадает с целью — переводить нечего.
    if (settings.sourceLang && settings.sourceLang !== "auto" && isTargetLang(settings.sourceLang)) return true;
    const det = (await getDetector(false)).inst;
    if (!det) return false;
    try {
      const res = await det.detect(text);
      const top = res && res[0];
      if (!top || top.confidence < 0.5) return false;
      return isTargetLang(top.detectedLanguage);
    } catch (e) {
      return false;
    }
  }

  // Язык текста → { lang } либо { kind, state } (детектора нет / модель не скачана), либо {}. Заданный
  // вручную язык — кодом встроенного переводчика (NB → "no"), если встроенный его знает.
  async function detectLang(text, mayDownload) {
    if (settings.sourceLang && settings.sourceLang !== "auto") {
      return { lang: HT_builtinCode(settings.sourceLang) || HT_langBase(settings.sourceLang) };
    }
    const d = await getDetector(mayDownload);
    if (!d.inst) return { kind: d.kind, state: d.state };
    try {
      const res = await d.inst.detect(text);
      const top = res && res[0];
      if (top && top.confidence >= 0.4) return { lang: top.detectedLanguage.toLowerCase() };
    } catch (e) { /* не определили */ }
    return {};
  }

  // ---- движки перевода ----

  // Встроенный Chrome Translator: экземпляры кэшируются по паре языков, неудача — нет.
  function getTranslator(src, tgt) {
    const key = src + ">" + tgt;
    if (!translators.has(key)) {
      const p = createModel(Translator, { sourceLanguage: src, targetLanguage: tgt },
        HT_t("dlPair", [HT_langLabel(src), HT_langLabel(tgt)]), true)
        .catch((e) => ({ kind: "fail", error: e }))
        .then((r) => {
          if (!r.inst && translators.get(key) === p) translators.delete(key);
          return r;
        });
      translators.set(key, p);
    }
    return translators.get(key);
  }

  // Модель не скачана: что сказать. key — что именно ждёт загрузки (одно уведомление на страницу).
  function needDownload(state, src, tgt) {
    const what = src ? HT_t("dlPair", [HT_langLabel(src), HT_langLabel(tgt)]) : HT_t("dlDetector");
    // Детектор и пару «английский → язык перевода» готовит кнопка в окне расширения.
    const prep = !src || src === HT_prepPair(settings.targetLang).src;
    // Щелчок нужен потому, что одиночный Shift (и наведение) Chrome действием пользователя не считает.
    // После щелчка абзац под курсором переводится сам (см. обработчик click).
    const error = HT_t(state === "downloading" ? "dlWait" : prep ? "dlClickPrep" : "dlClick", what);
    return { ok: false, kind: "download", key: src ? src + ">" + tgt : "detector", error };
  }

  // Перевод по тексту (без HTML) встроенным движком. Возвращает src для бейджа.
  // Язык перевода — кодом встроенного переводчика (ZH-HANT → "zh-Hant", NB → "no"); языка нет в его
  // списке — честная причина (сюда это доходит только через «авто» после сбоя DeepL).
  async function chromeTranslate(text, targetLang) {
    if (!("Translator" in self)) return { ok: false, error: HT_problemText("no-builtin", "page") };
    const tgt = HT_builtinCode(targetLang);
    if (!tgt) return { ok: false, code: "lang", error: HT_problemText("builtin-lang", "page", { targetLang }) };
    const d = await detectLang(text, true);
    if (d.kind === "download") return needDownload(d.state);
    const src = d.lang;
    if (!src) return { ok: false, code: "lang", error: HT_t("detectFail") };
    if (HT_langKey(src) === HT_langKey(tgt)) return { ok: true, value: "", src }; // уже на целевом — оставляем оригинал
    const t = await getTranslator(src, tgt);
    if (t.kind === "download") return needDownload(t.state, src, tgt);
    if (t.kind === "unavailable") {
      return { ok: false, error: HT_t("pairUnavailable", [HT_langLabel(src), HT_langLabel(tgt)]) };
    }
    try {
      if (!t.inst) throw t.error;
      return { ok: true, value: await t.inst.translate(text), src };
    } catch (e) {
      return { ok: false, error: HT_t("builtinFailed"), detail: e && e.message ? e.message : String(e) };
    }
  }

  // Встроенный движок для всего списка. Если не перевелось НИЧЕГО — отдаём error: все вызывающие
  // определяют сбой по этому полю, и без него встроенный движок падал абсолютно молча
  // (неподдерживаемая пара языков, Chrome < 138 — пользователь наводит, и не происходит ничего).
  // primary — неудача DeepL, из-за которой перевод пошёл сюда: она информативнее («ключ не подошёл»,
  // «лимит закончился»). Исключения: нескачанная модель — это не сбой, а шаг настройки, и подсказка,
  // что сделать, полезнее ошибки DeepL; «нет ключа» и «нет согласия» в режиме «авто» — не сбой, а
  // обычная работа встроенным, и настоящая причина — в ответе встроенного переводчика.
  async function localResults(texts, primary) {
    const results = await Promise.all(texts.map((t) => chromeTranslate(t, settings.targetLang)));
    if (results.some((r) => r && r.ok)) return { results };
    const dl = results.find((r) => r && r.kind === "download");
    if (dl) return { results: null, error: dl.error, kind: "download", key: dl.key };
    if (primary && primary.code !== "no-key" && primary.code !== "no-consent") return Object.assign({ results: null }, primary);
    return Object.assign({ results: null }, failOf(results.find((r) => r && r.error)));
  }

  // Сбои DeepL, при которых переводим встроенным, если он есть: лимит на месяц, нет сети, нет ответа,
  // сервис недоступен. Выбор переводчика в настройках не меняем — один раз говорим, что происходит.
  // Про лимит — раз за сессию браузера (он не вернётся до следующего месяца), про сеть — раз на
  // страницу (сеть может вернуться и пропасть снова).
  const FALLBACK_SAY = { quota: "fbQuota", network: "fbNetwork", timeout: "fbTimeout", server: "fbServer" };
  const fallbackTold = new Set();
  function fallbackSay(code) {
    if (fallbackTold.has(code)) return;
    fallbackTold.add(code);
    const show = () => notice(HT_t(FALLBACK_SAY[code]), 9000, code === "quota" ? { actions: [ACT.builtin], closable: true } : { closable: true });
    if (code !== "quota") { show(); return; }
    send({ type: "noticeOnce", problem: "deepl-quota" }).then((r) => { if (r && r.show && !dead) show(); }).catch(() => {});
  }

  // ЕДИНСТВЕННЫЙ путь к движку → { results:[{ok,value,src}] } либо { results:null, error[, kind] }.
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
    // Нет ключа или согласия — текст в сеть не уходит вовсе: «авто» сразу переводит встроенным, а
    // DeepL и ИИ сюда обычно не доходят (их останавливает blocked) — это страховка на гонку с
    // хранилищем. Background проверяет то же самое ещё раз перед запросом.
    if (!HT_canSend(e.code, netState())) {
      if (e.fallback === "local") return localResults(texts);
      const p = problem();
      return { results: null, error: p ? HT_problemText(p, "page", netState()) : TX_FAIL,
        code: p === "no-consent" ? "no-consent" : p === "deepl-lang" ? "lang" : "no-key", detail: "" };
    }
    let resp;
    try {
      resp = await send(Object.assign({ type: "translateBatch", items: texts.map(escapeHtml), by }, txOpts()));
    } catch (err) {
      // Почти всегда — пропавший контекст расширения (его обновили или удалили): тогда alive()
      // откатывает страницу и снимает обработчики, а все вызывающие видят отмену по liveGen/pageGen
      // раньше, чем пустую ошибку. Сообщение движка тут ни при чём.
      if (!alive()) return { results: null, error: "" };
      resp = { ok: false, error: TX_FAIL, detail: err && err.message };
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
    const fail = failOf(resp);
    // «Авто» переводит встроенным при любом сбое DeepL — так его и выбирали; обычный DeepL — только
    // при сбоях из FALLBACK_SAY и если встроенный в этом окне есть.
    const viaLocal = e.fallback === "local" ||
      (e.keyField === "apiKey" && BUILTIN === "ok" && Object.prototype.hasOwnProperty.call(FALLBACK_SAY, fail.code));
    if (!viaLocal) return Object.assign({ results: null }, fail);
    const out = await localResults(texts, fail);
    if (out.results && (e.fallback !== "local" || fail.code === "quota")) fallbackSay(fail.code);
    return out;
  }

  // Показать сбой перевода. Нескачанная модель — не ошибка: абзац не краснеет, а подсказка, что
  // сделать, — одна на страницу для каждой модели; следующий щелчок по странице повторяет перевод
  // элемента под курсором (у щелчка есть «действие пользователя», и загрузка начнётся).
  // Ошибка с действием («Открыть настройки», «Переключиться на встроенный») висит дольше и
  // закрывается ✕; простая — исчезает сама.
  const downloadTold = new Set();
  let retryOnClick = false;
  function showFail(owner, out) {
    if (out.kind === "download") {
      retryOnClick = true;
      if (!downloadTold.has(out.key)) { downloadTold.add(out.key); downloadHint = notice(out.error, 12000, { closable: true }); }
      return;
    }
    if (owner) failOwner(owner);
    const actions = actionsFor(out.code);
    // С кнопкой — и с именем расширения: на чужом сайте иначе непонятно, чьи это настройки.
    toast(out.error || TX_FAIL, "err", actions.length
      ? { title: extName(), detail: out.detail, actions, closable: true, ms: 8000 }
      : { detail: out.detail });
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

  // ---- карточка (плавающая под элементом, только при наведении) ----
  // Одна за раз; закрывается ✕, Esc, щелчком мимо и заметной прокруткой.
  const POPOVER_CSS = `
    .card {
      position: relative;
      border-radius: 8px;
      font: 14px/1.45 var(--ht-font-family);
      text-align: left;
      letter-spacing: normal;
      white-space: normal;
      color: var(--ht-fg);
      background: var(--ht-bg);
      box-shadow: var(--ht-shadow);
    }
    /* Длинный перевод (isTextTarget пропускает до 2000 символов) иначе не влезал бы в экран.
       Прокручивается только текст: ✕ остаётся на месте. */
    .scroll {
      max-height: min(60vh, 420px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 8px 34px 8px 10px;
    }
    .card.loading .scroll { color: #cbd5e1; font-style: italic; }
    .close {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 24px;
      height: 24px;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: rgba(255, 255, 255, .62);
      font: 15px/1 var(--ht-font-family);
      cursor: pointer;
    }
    .close:hover { color: #fff; background: rgba(255, 255, 255, .14); }
    .close:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
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

  // Карточка едет за абзацем при прокрутке, а когда абзац сдвинулся заметно (на четверть окна, но
  // не меньше 120 px) — закрывается: человек ушёл читать дальше. Мерим сдвиг самого абзаца, поэтому
  // прокрутка текста внутри карточки её не закрывает.
  function popScrollLimit() { return Math.max(120, innerHeight / 4); }
  function repositionPopovers() {
    popPending = false;
    for (const [owner, st] of Array.from(popovers)) {
      if (st && st.node && owner.isConnected) {
        const r = owner.getBoundingClientRect();
        if (st.anchor && (Math.abs(r.top - st.anchor.top) > popScrollLimit() || Math.abs(r.left - st.anchor.left) > popScrollLimit())) {
          removePopover(owner, st.node);
          continue;
        }
        positionPopover(st.node, owner);
        continue;
      }
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
    on(window, "scroll", schedulePopReposition, true);
    on(window, "resize", schedulePopReposition);
  }

  // Под абзацем: над ним карточка закрывала бы строку, которую только что прочитали. Над абзацем —
  // только если снизу не помещается, а если не помещается нигде — где места больше, в пределах окна.
  const POP_GAP = 6;
  function positionPopover(node, el) {
    const r = el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    const w = node.offsetWidth, h = node.offsetHeight;
    const below = vh - r.bottom - POP_GAP - 8, above = r.top - POP_GAP - 8;
    let top;
    if (h <= below || below >= above) top = r.bottom + POP_GAP;
    else top = r.top - POP_GAP - h;
    top = Math.max(8, Math.min(top, vh - h - 8));
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    node.style.setProperty("left", left + "px", "important");
    node.style.setProperty("top", top + "px", "important");
  }

  function showPopover(el, content, badge, stateClass) {
    // Одна карточка за раз: новая закрывает прежние (и те, что ещё ждут перевода).
    for (const owner of Array.from(popovers.keys())) if (owner !== el) removePopover(owner);
    const { host, root } = makeUiHost(POPOVER_CSS, Z_POPOVER);
    host.style.setProperty("max-width", "min(360px, 90vw)", "important");
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", HT_t("cardLabel"));
    const scroll = document.createElement("div");
    scroll.className = "scroll";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "✕";
    close.title = HT_t("cardClose");
    close.setAttribute("aria-label", HT_t("cardCloseAria"));
    close.addEventListener("click", (ev) => { if (ev.isTrusted) removePopover(el, host); });
    card.append(scroll, close);
    root.appendChild(card);
    fillPopover(host, content, badge, stateClass);
    // Карточку намеренно можно навести и прокрутить, поэтому pointer-events её не отключает.
    // Мерцание, от которого раньше спасал pointer-events:none, закрыто проверками relatedTarget
    // здесь и в обработчике mouseout.
    host.addEventListener("mouseenter", (ev) => {
      if (ev.isTrusted && popCloseOwner === el) popCloseCancel();   // дошли с абзаца до карточки
    });
    host.addEventListener("mouseleave", (ev) => {
      if (!ev.isTrusted) return;                          // хост лежит в DOM страницы — события сайта не слушаем
      if (settings.trigger !== "dwell") return;          // в режиме клавиши держим до повторного нажатия
      const to = ev.relatedTarget;
      if (to && (el === to || el.contains(to))) return;  // вернулись на сам элемент — карточку держим
      removePopover(el, host);
    });
    mountUi(host);
    const r = el.getBoundingClientRect();
    const state = { node: host, anchor: { top: r.top, left: r.left } };
    popovers.set(el, state);          // и маркер «занят», и состояние — одной записью
    ensurePopScroll();
    positionPopover(host, el);
    return state;
  }

  // Содержимое карточки. Только textContent: ответ движка недоверенный, в innerHTML не пишем.
  function fillPopover(host, content, badge, stateClass) {
    const root = uiRoots.get(host);
    const card = root.querySelector(".card");
    const box = root.querySelector(".scroll");
    card.className = "card" + (stateClass ? " " + stateClass : "");
    box.textContent = "";
    if (badge) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = badge;
      box.appendChild(b);
    }
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = content;
    box.appendChild(body);
  }

  function updatePopover(host, el, content, badge, stateClass) {
    fillPopover(host, content, badge, stateClass);
    positionPopover(host, el);
  }

  function removePopover(owner, node) {
    const st = popovers.get(owner);
    const n = node || (st && st.node);
    if (n && n.parentNode) n.remove();
    // Чужой узел (устаревшая карточка того же абзаца) не снимает с учёта текущую.
    if (!node || !st || st.node === node) popovers.delete(owner);
    if (popCloseOwner === owner) popCloseCancel();
  }

  // Режим задержки: курсор ушёл с абзаца — карточку закрываем не сразу, а через мгновение: между
  // абзацем и карточкой зазор, и иначе до длинной карточки (её можно прокрутить) было не дойти.
  const POP_CLOSE_MS = 300;
  function popCloseSoon(owner) {
    clearTimeout(popCloseTimer);
    popCloseOwner = owner;
    popCloseTimer = setTimeout(() => { popCloseOwner = null; removePopover(owner); }, POP_CLOSE_MS);
  }
  function popCloseCancel() { clearTimeout(popCloseTimer); popCloseOwner = null; }

  // ---- перевод наведением: поповер (элемент целиком) ----
  async function translatePopover(owner) {
    if (!owner || !owner.isConnected || isBusy(owner)) return;
    const gen = liveGen;   // токен отмены — ДО первого await, см. пояснение в translateLine
    inFlight.add(owner);
    try {
      const text = owner.textContent;
      if (await isAlreadyTarget(text)) return;
      if (gen !== liveGen || !active() || !owner.isConnected || isShown(owner)) return;
      const state = showPopover(owner, HT_t("cardLoading"), null, "loading");
      const node = state.node;
      const out = await translateItems([text], HT_BY_PAGE);
      if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== state) {
        removePopover(owner, node);
        return;
      }
      const res = out.results && out.results[0];
      if (res && res.ok && res.value && res.value.trim()) {
        let src = res.src || null;
        if (!src && settings.showLangBadge) src = (await detectLang(text, false)).lang || null;
        if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== state) { removePopover(owner, node); return; }
        const badge = (settings.showLangBadge && src && src.toLowerCase() !== targetBase().toLowerCase()) ? badgeText(src) : null;
        updatePopover(node, owner, res.value, badge, "");
      } else if (res) {
        removePopover(owner, node); // переводить нечего
      } else {
        removePopover(owner, node);
        showFail(null, out);
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
      if (gen !== liveGen || !active() || !owner.isConnected || lineByOwner.has(owner)) return;

      const nodes = collectTextNodes(owner);
      if (!nodes.length) return;

      line = { owner, nodes, persistent: !!persistent, gen, hlSaved: null };
      recs = nodes.map((n) => newEntry(n, line));
      lineByOwner.set(owner, line);          // маркер «занят» — закрывает гонку и ловит mouseout во время await
      loadingOn(owner);

      const out = await translateItems(recs.map((r) => r.core), HT_BY_PAGE);

      // отменён (сброс/выключение) или сброшен мышью/заменён за время ожидания
      if (gen !== liveGen || !owner.isConnected || lineByOwner.get(owner) !== line) return;
      if (out.error) { showFail(owner, out); return; }
      if (!writeLine(recs, out.results, line)) return;
      lines.add(line);
      applyHLLine(line);
      committed = true;
    } finally {
      inFlight.delete(owner);
      loadingOff(owner);
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
    if (revert) clearError(owner);     // таймер и класс ошибки
    loadingOff(owner);                  // ht-translated нигде не ставится — снимать нечего
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

  // Ошибка движка при наведении (замена): подсветить owner и сбросить через таймер. Текст ошибки на
  // элемент страницы не пишем — в title его прочитал бы скрипт сайта; он только в нашем уведомлении.
  function failOwner(owner) {
    clearTimeout(errors.get(owner));
    loadingOff(owner);
    owner.classList.add("ht-error");
    errors.set(owner, setTimeout(() => clearError(owner), 1800));
  }

  // Снять состояние ошибки. Единственная точка выхода из него: и по таймеру, и по повторному
  // наведению, и при откате строки.
  // Пока идёт перевод — лёгкая пульсация подсветки (content.css). На тёмном фоне — светлая, как и сама
  // подсветка перевода; при prefers-reduced-motion вместо пульсации ровный фон.
  function loadingOn(owner) {
    owner.classList.add("ht-loading");
    if (bgLuminance(owner.parentElement || owner) < 0.5) owner.classList.add("ht-loading-dark");
  }
  function loadingOff(owner) { owner.classList.remove("ht-loading", "ht-loading-dark"); }

  function clearError(owner) {
    owner.classList.remove("ht-error");
    clearTimeout(errors.get(owner));
    errors.delete(owner);
  }

  function restoreAll() {
    stopPageObserver();
    liveGen++; // отменяем переводы «в полёте»
    for (const line of Array.from(lines)) restoreLine(line);
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
    drift = null;
    // «Готово · Вернуть оригинал» после возврата оригинала уже ни к чему.
    if (pageToast) { pageToast.close(); pageToast = null; }
  }

  // Есть ли что возвращать: переводы, карточки, перевод страницы по прокрутке, перевод в полёте.
  function anythingShown() {
    return lines.size > 0 || popovers.size > 0 || !!pageObserver || !!document.querySelector(".ht-loading");
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
  on(document, "visibilitychange", () => {
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
    if (!active() || problem()) return;            // переводчик не может работать — прежнее остаётся
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
    const out = await translateItems(entries.map((e) => e.core), HT_BY_USER);
    if (out.error) { showFail(null, out); return; } // ошибка движка — прежние переводы остаются
    if (gen !== liveGen) return;
    const results = out.results;
    // Ожидаемое значение узла здесь — текущий ПЕРЕВОД (а не оригинал): меняем свой текст на новый.
    for (let i = 0; i < entries.length; i++) writeEntry(entries[i], results[i], entries[i].rec.translated);
  }

  // Периодически убираем мёртвые узлы (SPA) — против утечки памяти.
  const sweepTimer = setInterval(() => {
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

  // via — откуда просьба: "popup" (кнопка окна или панели) или "command" (горячая клавиша; keys —
  // её сочетание для подсказки). Окно расширения само говорит, что перевод выключен, а горячая
  // клавиша — только здесь.
  // На выключенном сайте не переводим и по явной просьбе: сайты выключают ради приватности (почта,
  // банк), и привычное сочетание клавиш не должно отправить такую страницу в DeepL. Включить сайт —
  // один щелчок в окне расширения.
  async function translatePage(via, keys) {
    if (!settings.enabled) {
      if (via === "command") notice(keys ? HT_t("offViaKeys", keys) : HT_t("offViaWindow"), 5000);
      return;
    }
    if (siteOff) {
      notice(HT_t("siteOffPage"), 7000, { closable: true });
      return;
    }
    if (blocked(true)) return;
    stopPageObserver();          // сбрасывает прошлый прогон и инкрементит pageGen
    const gen = pageGen;
    const fresh = collectCandidates();
    // Молчать нельзя: раньше при пустом списке не было ни тоста, ни observer-а, и пользователь
    // жал кнопку снова и снова, не понимая, почему ничего не происходит. Это не успех и не ошибка —
    // поэтому нейтральная подсказка.
    if (!fresh.length) { notice(HT_t("nothingOnPage"), 4000); return; }

    const vh = innerHeight, vw = innerWidth;
    const inView = [], rest = [];
    for (const el of fresh) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      (visible ? inView : rest).push(el);
    }

    const t = pageToast = showToast({ message: HT_t("translatingPage"), kind: "info", ms: 0, title: extName() });
    const done = await translatePageOwners(inView, gen); // видимое — сразу
    if (gen !== pageGen) { t.close(); return; }
    // Ошибку уже показали (она заняла место «Перевожу…») — «Готово» её бы спрятало.
    if (done.failed) { if (pageToast === t) pageToast = null; }
    else if (!done.wrote) {
      // Ничего не заменено — «Готово» было бы неправдой. Видимая часть уже на нужном языке (или на экране
      // нет текста для перевода); остальное, если оно есть, переведётся по прокрутке.
      t.update(rest.length
        ? { message: HT_t(inView.length ? "visibleInLang" : "scrollToTranslate"), closable: true, ms: 6000 }
        : { message: HT_t("alreadyInLang"), ms: 4000 });
      if (pageToast === t) pageToast = null;
    } else {
      t.update({
        message: HT_t(rest.length ? "doneScroll" : "donePage"),
        actions: [{ label: HT_t("showOriginal"), run: () => restoreAll() }],
        closable: true, ms: 8000,
      });
    }

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

  // Возвращает { wrote: сколько элементов переведено, failed: была ли ошибка }.
  async function translatePageOwners(owners, gen) {
    const sum = { wrote: 0, failed: false };
    for (let i = 0; i < owners.length; i += OWNER_BATCH) {
      if (gen !== pageGen) return sum;
      const r = await translatePageChunk(owners.slice(i, i + OWNER_BATCH), gen);
      sum.wrote += r.wrote;
      if (r.failed) sum.failed = true;
    }
    return sum;
  }

  async function translatePageChunk(chunk, gen) {
    const none = { wrote: 0, failed: false };
    const lgen = liveGen;   // токен отмены живых показов — ДО первого await
    // только свободные owner-ы, параллельная проверка «уже на целевом языке»
    const free = chunk.filter((el) => el.isConnected && !lineByOwner.has(el) && !inFlight.has(el));
    if (!free.length) return none;
    const skip = await Promise.all(free.map((el) => isAlreadyTarget(el.textContent)));
    if (gen !== pageGen || lgen !== liveGen) return none;
    const owners = free.filter((el, j) => !skip[j] && el.isConnected && !lineByOwner.has(el) && !inFlight.has(el));
    if (!owners.length) return none;

    const lineObjs = [];
    const entries = []; // плоский список узлов всех owner-ов чанка
    for (const owner of owners) {
      const nodes = collectTextNodes(owner);
      if (!nodes.length) continue;
      inFlight.add(owner);
      loadingOn(owner);
      const line = { owner, nodes, persistent: true, gen: lgen, hlSaved: null };
      lineByOwner.set(owner, line);
      lineObjs.push(line);
      for (const n of nodes) entries.push(newEntry(n, line));
    }
    if (!lineObjs.length) return none;

    let out;
    try {
      out = await translateItems(entries.map((e) => e.core), HT_BY_USER);
    } catch (e) {
      // Исключение раньше уходило наружу мимо уборки: owner-ы чанка навсегда оставались
      // в inFlight/lineByOwner, а перевод страницы вставал и не создавал IntersectionObserver.
      out = { results: null, error: TX_FAIL, detail: e && e.message };
    } finally {
      for (const line of lineObjs) loadingOff(line.owner);
    }
    const results = out.results;

    const cancelled = gen !== pageGen;
    if (cancelled || out.error || !results) {
      for (const line of lineObjs) { inFlight.delete(line.owner); dropLine(line); }
      if (out.error && !cancelled) { showFail(null, out); return { wrote: 0, failed: true }; }
      return none;
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
    return { wrote: wrote.size, failed: false };
  }

  // ---- события ----
  // Везде проверяем e.isTrusted: страница может сама разослать mouseover/keydown/wheel через
  // dispatchEvent и так запускать платные переводы за счёт ключа пользователя.
  // alive() — в обработчиках, с которых начинается перевод: первое же наведение после обновления
  // расширения снимает всё и возвращает оригиналы.
  //
  // Движение мыши отличаем от прокрутки и сдвига вёрстки: когда страница едет под неподвижным
  // курсором (колесо, клавиши, абзац сам сменил размер после перевода), Chrome шлёт mouseover и
  // mouseout с теми же координатами, что у последнего движения, и без mousemove (проверено в Chrome
  // 157). Такие события обновляют «элемент под курсором», но перевод не запускают.
  function pointerMoved(e) { return !lastXY || e.clientX !== lastXY.x || e.clientY !== lastXY.y; }

  on(document, "mouseover", (e) => {
    if (!e.isTrusted) return;
    if (!active() || !alive()) return;
    const target = pickTarget(e.target);
    hoverEl = (target && isTextTarget(target)) ? target : null;
    if (popCloseOwner && popCloseOwner === hoverEl) popCloseCancel();   // вернулись на абзац с карточкой
    if (!pointerMoved(e)) return;
    if (hoverEl !== edgeOwner) edgeOwner = null;   // курсор действительно ушёл на другой элемент
    // Клавишу держат и ведут курсор дальше — это жест «держу и навожу», а не одиночное нажатие:
    // переводим и элемент, над которым клавишу нажали, как все, над которыми проводят.
    if (modPress && modPress.el !== hoverEl && modHeld(e) && !modBusy()) {
      const start = modPress.el;
      modPress = null;
      if (start.isConnected && !isBusy(start)) startHover(start);
    }
    if (hoverEl && settings.trigger !== "dwell" && modHeld(e) && !modBusy() && !isBusy(hoverEl)) startHover(hoverEl);
  }, true);

  // Режим задержки: таймер взводит только настоящее движение мыши. Новый элемент под курсором — это
  // всегда mouseover и сразу за ним mousemove; после прокрутки mousemove нет, и элемент, приехавший
  // под курсор, ждёт, пока мышь сдвинется. Таймер — один раз на заход на элемент (dwellFor), так что
  // и фильтр dwellSkip считается один раз, а не на каждое движение.
  const DRIFT_PX = 16;
  on(document, "mousemove", (e) => {
    if (!e.isTrusted || !pointerMoved(e)) return;
    lastXY = { x: e.clientX, y: e.clientY };
    if (settings.trigger !== "dwell" || !active() || dead) return;
    if (drift && !settleDrift(e)) return;
    const el = hoverEl;
    if (!el || dwellFor === el || el === edgeOwner || isBusy(el)) return;
    dwellFor = el;
    clearTimeout(dwellTimer);
    if (dwellSkip(el, e.target)) return;
    dwellTimer = setTimeout(() => { if (hoverEl === el && dwellFor === el) startHover(el); }, HT_clampDwell(settings.dwellMs));
  }, { capture: true, passive: true });

  // Курсор оказался вне переведённого абзаца без движения мыши: страница прокрутилась или абзац сам
  // сменил размер. Второе — петля на краю абзаца: перевод короче оригинала → курсор снаружи → откат
  // → абзац снова длиннее → курсор внутри → перевод… Поэтому перевод не откатываем сразу, а ждём
  // движения мыши: вернулась на абзац — оставляем; ушла дальше чем на DRIFT_PX — откатываем и не
  // переводим этот абзац по задержке, пока курсор не перейдёт на другой элемент (edgeOwner).
  // Возвращает, продолжать ли обработку движения.
  function settleDrift(e) {
    const { line, x, y } = drift;
    if (lineByOwner.get(line.owner) !== line) { drift = null; return true; }   // уже снят
    if (line.owner.contains(e.target)) { drift = null; return true; }          // курсор снова на абзаце
    if (Math.abs(e.clientX - x) < DRIFT_PX && Math.abs(e.clientY - y) < DRIFT_PX) return false; // дрожание руки
    drift = null;
    restoreLine(line);
    edgeOwner = line.owner;
    return true;
  }

  // Жест колеса с зажатым модификатором: запоминаем, что клавишу держат не для нас. Слушатель
  // пассивный и только читает флаги события — прокрутку страницы он не задерживает.
  on(window, "wheel", (e) => {
    if (!e.isTrusted) return;
    if (settings.trigger !== "dwell" && modHeld(e)) {
      modWheelUntil = Date.now() + MOD_WHEEL_GRACE;
      modPress = null;                // и отменяем реакцию на само нажатие клавиши
    }
  }, { capture: true, passive: true });

  on(document, "mouseout", (e) => {
    if (!e.isTrusted) return;
    clearTimeout(dwellTimer);
    dwellFor = null;
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
    // Ушли на карточку этого абзаца: её можно навести и прокрутить, снимает её собственный
    // mouseleave. Событие ретаргетится на хост, поэтому проверки самого узла достаточно.
    const pop = popovers.get(owner);
    if (pop) { if (!to || pop.node !== to) popCloseSoon(owner); return; }
    const line = lineByOwner.get(owner);
    if (!line || line.persistent) return;            // закреплённые (страница) не откатываем мышью
    if (pointerMoved(e)) { restoreLine(line); return; }
    // Без движения мыши — см. settleDrift. Ждать может только один перевод: прежний откатываем.
    if (drift && drift.line !== line) restoreLine(drift.line);
    drift = { line, x: e.clientX, y: e.clientY };
  }, true);

  // Клавиша-триггер срабатывает на «чистое» нажатие: модификатор нажали и отпустили, и за это время
  // не было ни другой клавиши (заглавная буква, Ctrl+C/V/F), ни кнопки мыши (Shift+клик —
  // выделение, Ctrl+клик — ссылка в новой вкладке), ни колеса (Shift+колесо — прокрутка вбок,
  // Ctrl+колесо — масштаб). В момент нажатия этого ещё не знать, поэтому решаем при отпускании:
  // таймер после нажатия не спасает от сочетания, набранного чуть медленнее таймера.
  on(document, "keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.repeat) return;                 // автоповтор зажатой клавиши — не новое нажатие
    modPress = null;                      // любая клавиша обрывает ожидаемое нажатие…
    if (e.key === "Escape") { escRestore(); return; }
    if (!active() || settings.trigger === "dwell" || !alive()) return;
    if (!isTriggerKey(e) || !soloMod(e)) return;
    if (!hoverEl || modBusy() || typingFocus()) return;
    modPress = { key: e.key, el: hoverEl }; // …а одиночный модификатор над текстом начинает новое
  }, true);

  on(document, "keyup", (e) => {
    if (!e.isTrusted) return;
    const p = modPress;
    if (!p || e.key !== p.key) return;
    modPress = null;
    // hoverEl === p.el отсекает случай, когда за время нажатия курсор ушёл с элемента (в том числе
    // из окна) или под него при прокрутке приехал другой.
    if (!active() || settings.trigger === "dwell" || modBusy() || hoverEl !== p.el) return;
    toggle(p.el);
  }, true);

  // Esc возвращает оригинал везде на странице и закрывает карточку — если есть что возвращать.
  // preventDefault не зовём: Esc нужен и самому сайту (закрыть окно, меню). Фокус в поле ввода —
  // Esc для поля (закрыть подсказки поиска), переводы не трогаем. Встроенные окна вкладки (у
  // каждого свой скрипт и свои переводы) откатывает background по нашей просьбе.
  function escRestore() {
    if (typingFocus() || !anythingShown()) return;
    restoreAll();
    if (!TOP || document.querySelector("iframe, frame")) send({ type: "restoreTab" }).catch(() => {});
  }

  on(window, "mousedown", (e) => { if (e.isTrusted) modPress = null; }, true);

  // Щелчок мимо карточки закрывает её. Щелчок внутри приходит с хостом карточки в target (закрытый
  // shadow root наружу показывает только хост).
  on(window, "pointerdown", (e) => {
    if (!e.isTrusted || !popovers.size) return;
    for (const st of popovers.values()) if (st.node === e.target) return;
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
  }, true);

  // Модель встроенного переводчика ждёт загрузки (см. showFail): у щелчка есть «действие
  // пользователя», которого Chrome требует для загрузки, поэтому сразу повторяем перевод элемента
  // под курсором — щелчок по самому абзацу и начинает загрузку.
  on(window, "click", (e) => {
    if (!e.isTrusted || !retryOnClick || !active() || !alive()) return;
    retryOnClick = false;
    if (hoverEl && hoverEl.isConnected && !isBusy(hoverEl)) startHover(hoverEl);
  }, true);

  // Окно потеряло фокус (Alt+Tab, клик в адресную строку): отпускание клавиши придёт уже не нам,
  // а элемент под курсором неизвестен до следующего движения мыши.
  on(window, "blur", () => { hoverEl = null; modPress = null; clearTimeout(dwellTimer); dwellFor = null; });

  // Команды из popup и от горячих клавиш (через background). Обязательно отвечаем (sendResponse),
  // иначе на стороне popup взводится lastError «порт закрыт» и страница ошибочно считается
  // недоступной. Ответ на getHudState — заодно и состояние сайта для переключателя в окне.
  // На своей странице расширения (приветствие) не слушаем: туда долетают все runtime.sendMessage
  // окна настроек, и наш ответ «true» мог бы опередить ответ background.
  function tabState() { return { ok: true, hud: !!hud, site: SITE, siteOff }; }
  if (!OWN_PAGE) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "restoreAll") { restoreAll(); sendResponse(true); }
      else if (msg.type === "translatePage") { translatePage(msg.via, typeof msg.keys === "string" ? msg.keys : ""); sendResponse(true); }
      else if (msg.type === "toggleHud") { toggleHud(); sendResponse(tabState()); }
      else if (msg.type === "getHudState") { sendResponse(tabState()); }
      else if (msg.type === "say") { say(msg); sendResponse(true); }
      else sendResponse(true); // подтверждаем получение
    });
  }

  // Горячая клавиша вкл/выкл: значок покажет «off», но смотрят в этот момент на страницу.
  function say(msg) {
    const keys = typeof msg.keys === "string" && msg.keys ? msg.keys : "";
    if (msg.what === "enabled") notice(HT_t("toggledOn"), 2500);
    else if (msg.what === "disabled") notice(keys ? HT_t("toggledOffKeys", keys) : HT_t("toggledOff"), 3500);
  }

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
    select:focus-visible, button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
  `;

  function buildHud() {
    const { host, root } = makeUiHost(HUD_CSS, Z_HUD);
    const bar = document.createElement("div");
    bar.className = "bar";

    const grip = document.createElement("div");
    grip.className = "grip";
    grip.textContent = "⠿";
    grip.title = HT_t("hudDrag");

    const sel = document.createElement("select");
    sel.title = HT_t("targetLangAria");
    sel.setAttribute("aria-label", HT_t("targetLangAria"));
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
      hudButton("page", HT_t("translatePage"), () => translatePage("popup")),
      hudButton("undo", HT_t("showOriginalEsc"), () => restoreAll()),
    );
    if (SITE) bar.append(hudButton("ban", HT_t("hudSiteOff"), () => disableSiteFromHud()));
    bar.append(hudButton("close", HT_t("hudHide"), () => setHudWanted(false)));
    root.appendChild(bar);
    bindHudDrag(host, grip);
    return { host, sel };
  }

  // Иконки панели — те же, что на кнопках окна расширения: контуры 24×24 цветом текста. Строим через
  // DOM, а не разметкой: в нашем окне на странице не должно быть ни одной строки HTML.
  const HUD_ICONS = {
    page: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
    undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
    ban: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "m4.9 4.9 14.2 14.2"],
    close: ["M18 6 6 18", "m6 6 12 12"],
  };
  function hudIcon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const attrs = { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const k in attrs) svg.setAttribute(k, attrs[k]);
    for (const d of HUD_ICONS[name]) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }
  function hudButton(icon, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.appendChild(hudIcon(icon));
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => { if (e.isTrusted) onClick(); });
    return b;
  }

  // Панель закреплена снизу справа и там закрывает контент страницы — даём её перетащить
  // за ручку. Позицию запоминаем в хранилище, когда панель отпустили (не на каждом шаге — каждая
  // запись будит скрипты во всех вкладках), — она общая для всех сайтов.
  function bindHudDrag(host, grip) {
    grip.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      let last = null;
      const move = (ev) => { if (ev.isTrusted) last = placeHud(host, ev.clientX - dx, ev.clientY - dy); };
      const up = (ev) => {
        if (!ev.isTrusted) return;
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        if (last) { hudPos = last; chrome.storage.local.set({ hudPos: last }).catch(() => {}); }
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });
  }

  // Ставим панель по координатам, не давая уехать за пределы окна. Запомненное место (hudPos) не
  // меняем: в узком окне панель прижмётся к краю, а в прежнем — вернётся туда, куда её поставили.
  function placeHud(host, left, top) {
    const l = Math.max(0, Math.min(left, innerWidth - host.offsetWidth));
    const t = Math.max(0, Math.min(top, innerHeight - host.offsetHeight));
    const s = host.style;
    s.setProperty("left", l + "px", "important");
    s.setProperty("top", t + "px", "important");
    s.removeProperty("right");
    s.removeProperty("bottom");
    return { left: l, top: t };
  }

  on(window, "resize", () => { if (hud && hudPos) placeHud(hud.host, hudPos.left, hudPos.top); });

  function syncHud() { if (hud) hud.sel.value = settings.targetLang; }

  // Панель только в верхнем фрейме сайта и не на выключенном сайте. Показана ли она — общее для всех
  // сайтов (hudWanted), поэтому при переходе на другую страницу она появляется снова.
  function hudAllowed() { return TOP && !OWN_PAGE && !siteOff; }
  function updateHud() {
    const want = hudWanted && hudAllowed() && !dead;
    if (want && !hud) {
      if (!document.body) return;
      hud = buildHud();
      mountUi(hud.host);
      if (hudPos) placeHud(hud.host, hudPos.left, hudPos.top);
      else {
        hud.host.style.setProperty("right", HUD_MARGIN + "px", "important");
        hud.host.style.setProperty("bottom", HUD_MARGIN + "px", "important");
      }
    } else if (!want && hud) {
      hud.host.remove();
      hud = null;
    }
  }
  function setHudWanted(v) {
    hudWanted = v;
    chrome.storage.local.set({ hudShown: v }).catch(() => {});
    updateHud();
  }
  // Кнопка в окне расширения. На выключенном сайте панель не показываем — окно объяснит почему.
  function toggleHud() { if (hudAllowed()) setHudWanted(!hud); }

  // ---- выключить на этом сайте ----
  // Список общий с окном расширения; читаем свежий перед записью, чтобы не затереть чужое изменение.
  async function setSiteOff(off) {
    if (!SITE) return;
    const got = await chrome.storage.local.get({ disabledSites: [] });
    const list = HT_sites(got.disabledSites).filter((x) => x !== SITE);
    if (off) list.push(SITE);
    await chrome.storage.local.set({ disabledSites: list.slice(-HT_SITES_MAX) });
  }
  // Сайт выключаем сразу (не дожидаясь ответа хранилища): перевод, панель и карточки уходят тут же.
  // Кнопка «Включить снова» — на случай промаха.
  function disableSiteFromHud() {
    siteOff = true;
    siteChanged();
    setSiteOff(true).catch(() => {});
    notice(HT_t("siteDisabled", SITE), 8000, {
      closable: true,
      actions: [{ label: HT_t("turnBackOn"), run: () => { setSiteOff(false).catch(() => {}); } }],
    });
  }

  // ---- уведомление ----
  // Тоже через makeUiHost: это третье наше окно, и раньше единственное, оставшееся под правилами
  // страницы (инлайновый стиль перебивается её !important).
  // Два вида: ошибка (красная) и подсказка (тёмная, как карточка) — для шагов настройки, хода работы и
  // результата («Переводить нечего» — не успех и не ошибка, поэтому без зелёного). Уведомление на
  // экране одно: новое заменяет прежнее, иначе они ложились бы друг на друга.
  // Кнопки действий и ✕ — в закрытом shadow root и срабатывают только от настоящего щелчка; такое
  // уведомление принимает мышь и не исчезает, пока на нём курсор.
  const TOAST_CSS = `
    .toast {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      max-width: min(560px, 90vw);
      padding: 9px 10px 9px 14px;
      border-radius: 10px;
      font: 13px/1.45 var(--ht-font-family);
      text-align: left;
      color: var(--ht-fg);
      background: var(--ht-bg);
      box-shadow: 0 6px 24px rgba(0, 0, 0, .3);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity .15s, transform .15s;
    }
    .toast.show { opacity: 1; transform: none; }
    .toast.err { color: #fff; background: #c62828; }
    .main { flex: 1 1 auto; min-width: 0; padding: 1px 0; }
    .title { margin-bottom: 2px; font-weight: 600; }
    .detail { margin-top: 3px; font-size: 12px; opacity: .72; overflow-wrap: anywhere; }
    .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .acts:empty { display: none; }
    .act {
      margin: 0;
      padding: 5px 11px;
      border: 0;
      border-radius: 6px;
      font: 600 12px/1.25 var(--ht-font-family);
      color: #0b1220;
      background: #8ab4ff;
      cursor: pointer;
    }
    .act:hover { background: #a8c7ff; }
    .err .act { color: #b71c1c; background: #fff; }
    .err .act:hover { background: #ffe9e9; }
    .x {
      flex: none;
      width: 24px;
      height: 24px;
      margin: -3px -3px 0 0;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      opacity: .7;
      font: 15px/1 var(--ht-font-family);
      cursor: pointer;
    }
    .x:hover { opacity: 1; background: rgba(255, 255, 255, .16); }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .toast { transform: none; transition: none; } }
  `;

  // Показать уведомление. o: { message, kind: "info"|"err", ms (0 — пока не закроют), title (строка
  // над текстом: на чужом сайте видно, чьё это окно), detail (мелко: код ответа, текст сервиса),
  // actions: [{ label, run }], closable (✕) }. Возвращает { set(текст), update(o), close() }.
  let currentToast = null;
  function showToast(o) {
    if (currentToast) currentToast.close();
    const { host, root } = makeUiHost(TOAST_CSS, Z_TOAST);
    const s = host.style;
    s.setProperty("left", "50%", "important");
    s.setProperty("bottom", "20px", "important");
    s.setProperty("transform", "translateX(-50%)", "important");
    const card = document.createElement("div");
    const main = document.createElement("div");
    main.className = "main";
    const title = document.createElement("div");
    title.className = "title";
    const body = document.createElement("div");
    const detail = document.createElement("div");
    detail.className = "detail";
    const acts = document.createElement("div");
    acts.className = "acts";
    main.append(title, body, detail, acts);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "✕";
    x.title = HT_t("close");
    x.setAttribute("aria-label", HT_t("toastCloseAria"));
    card.append(main, x);
    root.appendChild(card);

    let timer = 0, ms = 0, closed = false, hovered = false;
    const t = {
      set(text) { body.textContent = text; },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (currentToast === t) currentToast = null;
        card.classList.remove("show");
        setTimeout(() => host.remove(), 250);
      },
      // Сменить содержимое на месте (например, «Перевожу…» → «Готово»), если уведомление ещё на
      // экране и его не заменило другое.
      update(p) { if (!closed && currentToast === t) fill(Object.assign({}, o, p)); },
    };
    const arm = (delay) => { clearTimeout(timer); if (delay && !hovered) timer = setTimeout(t.close, delay); };
    function fill(p) {
      o = p;
      card.className = "toast" + (p.kind ? " " + p.kind : "") + " show";
      card.setAttribute("role", p.kind === "err" ? "alert" : "status");
      title.textContent = p.title || "";
      title.hidden = !p.title;
      body.textContent = p.message;
      detail.textContent = p.detail || "";
      detail.hidden = !p.detail;
      acts.textContent = "";
      for (const a of p.actions || []) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "act";
        b.textContent = a.label;
        b.addEventListener("click", (ev) => { if (!ev.isTrusted) return; t.close(); a.run(); });
        acts.appendChild(b);
      }
      x.hidden = !p.closable;
      // Без кнопок уведомление «прозрачно» для мыши и не мешает щёлкать по странице под ним.
      const interactive = !!(p.closable || (p.actions && p.actions.length));
      s.setProperty("pointer-events", interactive ? "auto" : "none", "important");
      ms = p.ms || 0;
      arm(ms);
    }
    fill(o);
    card.classList.remove("show");
    x.addEventListener("click", (ev) => { if (ev.isTrusted) t.close(); });
    // Курсор на уведомлении — человек читает или тянется к кнопке: не убираем, пока он там.
    host.addEventListener("mouseenter", (ev) => { if (ev.isTrusted) { hovered = true; clearTimeout(timer); } });
    host.addEventListener("mouseleave", (ev) => { if (ev.isTrusted) { hovered = false; if (ms) arm(Math.min(ms, 3000)); } });
    mountUi(host);
    // Прозрачность анимируем на карточке, а не на хосте: у хоста opacity выставлен с !important,
    // чтобы правила страницы не могли нас спрятать.
    requestAnimationFrame(() => { if (!closed) card.classList.add("show"); });
    currentToast = t;
    return t;
  }

  // Результат действия или ошибка — не чаще раза в 3 с, чтобы серия сбоев не завалила страницу.
  // Текст теперь длиннее кода ответа, поэтому простая ошибка держится 4 с.
  function toast(message, kind, opts) {
    const now = Date.now();
    if (now - lastToastAt < 3000) return null;
    lastToastAt = now;
    return showToast(Object.assign({ message, kind, ms: 4000 }, opts));
  }

  // Подсказка о настройке или о ходе работы. Частоту ограничивают вызывающие (раз на страницу или на
  // сессию), поэтому общий интервал её не глушит: иначе единственная подсказка терялась бы за ошибкой
  // секундой раньше.
  function notice(message, ms, opts) {
    return showToast(Object.assign({ message, kind: "info", ms: ms || 9000, title: extName() }, opts));
  }
  // Короткое название — из сообщений (extShortName): полное, из manifest, для заголовка уведомления длинное.
  function extName() { return HT_t("extShortName"); }
})();
