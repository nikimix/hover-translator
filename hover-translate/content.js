// content.js — выполняется на каждой странице/фрейме (isolated world).
// Перевод элемента под курсором (наведение/клавиша) и всей страницы.
//
// Применение перевода: меняем ТОЛЬКО значения текстовых узлов (Text.nodeValue) — не создаём,
// не удаляем и не оборачиваем узлы-элементы. Так сохраняются обработчики событий и структура
// DOM, и каркас веб-приложений (React/Vue/Angular) не ломается. Поэтому интерактивные элементы
// (кнопки/ссылки) тоже можно переводить безопасно.
// Способы показа (displayMode): «замена на месте» (узлы) и «поповер» (плавающая карточка —
// только при наведении; страницу всегда переводим заменой). Опционально — пара языков на карточке
// и плавающая кнопка на странице. Всё своё (уведомления, карточка, кнопка с меню) — в закрытом shadow root,
// системным шрифтом и своими цветами по фону сайта (светлый сайт — белое, тёмный — #2a2d33).
// Окну расширения скрипт верхнего фрейма сообщает, что со страницей (tabState, сообщение pageState).
// Движки: DeepL, LLM (OpenAI/Anthropic) — через background; встроенный Chrome — on-device.
// Если выбранный переводчик не может работать (нет ключа, нет встроенного в браузере), страница не
// трогается вовсе; если расширение обновили или удалили, скрипт возвращает оригиналы и замолкает.
// На сайте из списка «выключено на этом сайте» скрипт ничего не переводит и не показывает кнопку.
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
  const pageWait = new Set();        // видимое, что не перевелось: первое «виден» от pageObserver пропускаем
  let pageObserver = null;
  let flushTimer = null;
  // Новое содержимое переведённой страницы (см. watchPage).
  const ownText = new WeakMap();     // Text -> что мы сами записали в него последним (перевод или откат)
  const mutStarts = new Set();       // где сайт что-то поменял с прошлой пачки (элементы)
  let mutObserver = null;
  let mutTimer = 0;
  let mutTries = new WeakMap();      // owner -> { n, at }: сколько раз подряд его переводили заново
  let mutTopUp = new WeakSet();      // owner с живым переводом, в котором сайт добавил или переписал текст
  let keepOrig = new WeakSet();      // owner, которому человек вернул оригинал клавишей: новое в нём не переводим
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
  let fab = null;                     // плавающая кнопка с меню (см. buildFab) или null — её нет на странице
  let fabPos = null;                  // где стоит кнопка: { side, top } или null — справа внизу (storage.local.hudPos)
  let hudWanted = false;              // показывать ли кнопку (общее для всех сайтов, storage.local.hudShown)
  // Для точек на кружке (см. showFail). needClick — ждём щелчка по тексту (то же, что уведомление «Щёлкните по
  // тексту»: модель не скачана, а не «подождите, скачивается»); failErr — код сбоя, после которого без действия
  // человека дальше не переводится (ключ, лимит, язык…): снимается первым удачным переводом или сменой настроек.
  let needClick = false;
  let failErr = "";
  let siteOff = false;                // этот сайт в списке «выключено на этом сайте»
  let lastOverTarget = null;          // последний элемент под курсором — и при выключенном переводе
  let pageActive = false;             // страницу переводили целиком, и оригинал с тех пор не возвращали
  let pageToast = null;               // уведомление «Страница переведена» (его закрывает возврат оригинала)
  let retranslateTimer = null;
  // Для окна расширения: что сейчас со страницей (pageNow). pageBusy — идёт перевод видимой части:
  // { done, total } — сколько видимых абзацев готово из скольких; pageWas — страницу переводили целиком и
  // вернули оригинал (окно показывает сегмент на «Оригинал»); pageSrc — язык оригинала по ответам переводчика.
  let pageBusy = null;
  let pageWas = false;
  let pageSrc = "";
  const srcCount = new Map();         // язык оригинала -> сколько абзацев на нём пришло (pageSrc — самый частый)
  let stateTimer = 0;                 // отложенная отправка pageState окну (несколько изменений — одно сообщение)
  let stateSent = "";                 // что отправили последним (одинаковое не шлём)

  // Подсветка — мгновенно (rAF), без перевода. Язык/движок/формальность/исключения — перетранслирование.
  // Способ показа и бейдж влияют на следующие переводы; уже показанное не перерисовываем: карточка
  // держит перевод абзаца одной строкой, а замене нужен перевод каждого текстового узла.
  const DISP_KEYS = ["dispMode", "dispBg", "dispOpacity"];
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
  // сайте», на ней нет плавающей кнопки и команд из окна расширения.
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
  // и место плавающей кнопки тоже сверяем (shared.js): их пишет и кнопка на странице.
  const EXTRA = { apiKey: "", llmApiKey: "", consent: {}, htBuiltinApi: null, disabledSites: [], hudShown: false, hudPos: null };
  chrome.storage.local.get(Object.assign({}, EXTRA, DEFAULTS), (s) => {
    for (const k of KEY_KEYS) keyPresent[k] = !!s[k];
    consent = HT_consent(s.consent);
    syncBuiltinFlag(s.htBuiltinApi);
    siteOff = siteListed(s.disabledSites);
    hudWanted = s.hudShown === true;
    fabPos = HT_hudPos(s.hudPos, innerWidth);
    for (const k in EXTRA) delete s[k];
    settings = HT_validAll(s);
    loaded = true;
    if (siteOff) tellSiteBadge();
    updateFab();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    let dispChanged = false, txChanged = false, enabledOff = false, enabledChanged = false;
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
      if (k === "hudShown") { hudWanted = ch.newValue === true; updateFab(); pushState(); continue; }
      // Кружок перетащили в другой вкладке (место одно на все сайты) — встаёт туда же и здесь.
      if (k === "hudPos") {
        fabPos = HT_hudPos(ch.newValue, innerWidth);
        if (fab && !fab.drag) placeFab();
        continue;
      }
      if (!(k in DEFAULTS)) continue;       // игнорируем чужие ключи (записи кэша, статистика, служебные popup)
      settings[k] = HT_valid(k, ch.newValue);
      // Значение не поменялось (popup пишет все ключи разом). Сравниваем уже сверенные значения:
      // замена неизвестного значения на значение по умолчанию ничего не меняет.
      if (HT_valid(k, ch.oldValue) === settings[k]) continue;
      if (DISP_KEYS.includes(k)) dispChanged = true;
      else if (TX_KEYS.includes(k)) txChanged = true;
      if (k === "enabled") { enabledChanged = true; if (ch.newValue === false) enabledOff = true; }
    }
    // Перевод выключили везде — кружка нет (как на выключенном сайте); включили — он появляется сам.
    if (enabledChanged) { updateFab(); pushState(); }
    // Язык, переводчик, ключ, согласие — меню и точка на кружке говорят о новом (что бы ни было ниже).
    if (txChanged) failErr = "";
    syncFab();
    // Применяем изменения к уже показанным переводам сразу.
    if (enabledOff) { restoreAll(); return; }       // выключили перевод — откатываем всё
    // Причину «Перевод не работает» устранили (дали согласие, вставили ключ, сменили переводчик) —
    // уведомление о ней больше не правда.
    if (problemToast && problemToast.alive() && !problem()) { problemToast.close(); problemToast = null; }
    if (dispChanged) scheduleRestyle();              // тема подсветки — мгновенный предпросмотр
    if (txChanged) {
      // Отменяем переводы «в полёте»: они вернутся на ПРЕЖНЕМ языке и попали бы в lines уже
      // после того, как retranslateAll по ним прошёл — то есть остались бы навсегда старыми.
      liveGen++;
      scheduleRetranslate();                         // перевод изменится — перезапрашиваем (debounce)
    }
    // displayMode/showLangBadge — только вид; влияют на будущие наведения, ничего не перерисовываем.
  });

  // Сайт выключили — возвращаем оригиналы, убираем кнопку и карточки; включили — кнопка возвращается,
  // если она была показана. Значок вкладки меняет верхний фрейм.
  function siteChanged() {
    if (siteOff) { restoreAll(); clearTimeout(dwellTimer); dwellFor = null; }
    updateFab();
    tellSiteBadge();
    pushState();
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
    dropFab();
    // Уведомления и карточки (они живут по своим таймерам) — тоже убираем: это интерфейс старой версии.
    for (const host of document.querySelectorAll("[data-ht-ui]")) host.remove();
    clearTimeout(dwellTimer);
    clearTimeout(retranslateTimer);
    clearTimeout(popCloseTimer);
    clearTimeout(stateTimer);
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
  // Объяснение с кнопками: без ключа или согласия, с языком, которого нет у DeepL, — открыть настройки
  // (главная кнопка) или переводить встроенным (если он есть); встроенный недоступен или не знает язык —
  // только настройки. Заголовок «Перевод не работает», под ним причина — короткий текст из shared.js
  // (тот же, что в подсказке значка) с заглавной буквы.
  function problemNotice(p) {
    const local = p === "no-builtin" || p === "builtin-lang" || BUILTIN !== "ok";
    const main = settingsAct(problemFocus(p), true);
    problemToast = notice(problemDesc(p), 12000, {
      title: HT_t("probTitle"), icon: "err", kind: "err",
      actions: local ? [main] : [main, ACT.builtin], closable: true,
    });
  }
  let problemToast = null;            // уведомление «Перевод не работает»: причину устранили — закрываем
  function problemDesc(p) { return sentence(HT_problemText(p, "short", netState())); }
  // Куда вести на странице настроек по причине (значения focus — см. openSettings в background).
  function problemFocus(p) {
    if (p === "no-deepl-key") return "deepl-key";
    if (p === "no-llm-key") return "llm-key";
    if (p === "no-consent") return HT_engine(settings.engine).via === "llm" ? "llm" : "deepl";
    if (p === "deepl-lang" || p === "builtin-lang") return "langs";
    return "translator";
  }
  function sentence(s) { s = capFirst(String(s || "").trim()); return s && !/[.!?…]$/.test(s) ? s + "." : s; }

  // ---- кнопки в уведомлениях ----
  // Нажимаются только настоящим щелчком (проверка isTrusted — в showToast). Записываемое значение —
  // только из таблицы shared.js. Главная (залитая) кнопка — когда без настроек дальше никак.
  function openSettings(focus) { send({ type: "openSettings", focus: focus || "" }).catch(() => {}); }
  function settingsAct(focus, primary) { return { label: HT_t("openSettings"), run: () => openSettings(focus), primary: !!primary }; }
  const ACT = {
    settings: settingsAct(""),
    settingsMain: settingsAct("", true),
    builtin: { label: HT_t("useBuiltin"), run: useBuiltin },
  };
  function useBuiltin() {
    chrome.storage.local.set({ engine: HT_valid("engine", "chrome") })
      .then(() => notice(HT_t("csBuiltinOnText"), 6000, { title: HT_t("csBuiltinOnTitle"), icon: "ok" }))
      .catch(() => {});
  }
  // Какие кнопки предложить к ошибке перевода (коды ошибок — в background.js, failure()). focus — куда
  // вести на странице настроек (у ошибок встроенного — свой: язык оригинала или перевода).
  function actionsFor(code, focus) {
    const ai = HT_engine(settings.engine).via === "llm";
    if (code === "bad-key") return [settingsAct(ai ? "llm-key" : "deepl-key", true)];
    if (code === "no-key") return [settingsAct(focus || (ai ? "llm-key" : "deepl-key"), true)];
    if (code === "model") return [settingsAct("llm", true)];
    if (code === "lang") return [settingsAct(focus || "langs", true)];
    if (code === "no-consent") return BUILTIN === "ok" ? [settingsAct("translator", true), ACT.builtin] : [settingsAct("translator", true)];
    if (code === "quota" || code === "money" || code === "denied") return [BUILTIN === "ok" ? ACT.builtin : settingsAct("translator")];
    return [];
  }
  // Подпись под заголовком ошибки — что делать, если по коду это понятно (иначе — текст ошибки).
  const FAIL_HINT = { "bad-key": "badKeyHint" };
  // Имя сервиса для «… не принял ключ».
  const SERVICE_NAMES = { deepl: "DeepL", openai: "OpenAI", anthropic: "Anthropic" };
  function serviceName() { return SERVICE_NAMES[HT_provider(settings.engine, settings.llmProvider)] || "DeepL"; }

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

  // Языки для меню плавающей кнопки (смена языка перевода на странице) — из общей таблицы shared.js,
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
    return !looksLikeName(node, owner);
  }

  // Имя, а не слова (GitHub: «.gitignore» → «.Гигнор», «lib» → «Либ», «History.md» → «История.MD»):
  // 1) одно «слово» вида имени файла или адреса: .gitignore, History.md, example.com («e.g.» — нет: точка в конце);
  // 2) текст ссылки равен последнему сегменту её адреса из строчных латинских букв, цифр и ._- (lib → …/tree/master/lib),
  //    и ссылка не внутри фразы: у владельца нет текста с буквами вне ссылок. Иначе «follow the <a href="/docs/install">
  //    install</a> guide» оставил бы слово посреди переведённого предложения. Ссылки Википедии (/wiki/Mexico)
  //    начинаются в адресе с заглавной — сюда не попадают.
  const FILE_NAME_RE = /^\.?[\w@+-]+(\.[\w-]+)+$|^\.[\w-]+$/;
  const NAME_SEG_RE = /^[a-z0-9][a-z0-9._-]*$/;
  function looksLikeName(node, owner) {
    const t = node.nodeValue.trim();
    if (FILE_NAME_RE.test(t)) return true;
    if (!NAME_SEG_RE.test(t)) return false;
    const a = node.parentElement.closest("a[href]");
    if (!a) return false;
    let seg;
    try { seg = decodeURIComponent(new URL(a.href).pathname.split("/").filter(Boolean).pop() || ""); } catch (e) { return false; }
    if (seg !== t) return false;
    const w = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (/\p{L}/u.test(n.nodeValue) && !n.parentElement.closest("a[href]")) return false;
    }
    return true;
  }

  // Узел уже держит живая строка: вложенный владелец переведён наведением, а страница берёт внешний, или наоборот.
  function heldByLine(node) {
    const rec = nodeRecs.get(node);
    return !!rec && lineByOwner.get(rec.line.owner) === rec.line;
  }

  // Текстовые узлы внутри owner, пригодные для перевода (в порядке обхода). Узлы чужой живой строки не берём:
  // newEntry перезаписал бы её запись, и откат той строки этот узел пропустил бы — перевод остался бы навсегда.
  function collectTextNodes(owner) {
    const out = [];
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => acceptTextNode(node, owner) && !heldByLine(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
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
    // Закрытый выпадающий список текст не принимает (как флажок): выбрали пункт — Shift снова переводит. Раскрытый
    // и OPTION — пункт открытого списка (настраиваемый select Chrome 135+ раскрывается прямо на странице, и клавиши
    // доходят сюда; системный список забирал их себе) — клавиши для списка.
    if (el.tagName === "SELECT") return selectOpen(el);
    return el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "OPTION";
  }
  // :open у select — с Chrome 133; раньше список системный, и клавиши до страницы не доходят.
  function selectOpen(sel) {
    try { return sel.matches(":open"); } catch (e) { return false; }
  }

  // Запустить/снять перевод owner-а под курсором (по клавише-триггеру).
  function toggle(owner) {
    if (!owner) return;
    if (settings.displayMode === "popover") {
      if (popovers.has(owner)) removePopover(owner); else if (!blocked(false)) translatePopover(owner);
    } else {
      const line = lineOf(owner);
      if (line) { restoreLine(line); if (pageActive) keepOrig.add(owner); }
      else { keepOrig.delete(owner); if (!blocked(false)) translateLine(owner, false); }
    }
  }

  function startHover(owner) {
    if (blocked(false)) return;
    if (settings.displayMode === "popover") translatePopover(owner);
    else translateLine(owner, false);
  }

  // Запись о переводе элемента — если перевод ещё на экране или в пути. Сайт мог перерисовать элемент после
  // перевода (React/Vue вписали свой текст, textContent заменил узлы): нашего перевода уже нет, а «мёртвая» запись
  // мешала — первый Shift «снимал» невидимый перевод и ничего не делал, наведение и жест «держу и веду» считали
  // элемент занятым. Такую запись снимаем (откатывать нечего) — элемент переводится заново.
  function lineOf(owner) {
    const line = lineByOwner.get(owner);
    if (line && !inFlight.has(owner) && !lineAlive(line)) { dropLine(line); return null; }
    return line || null;
  }
  // Переводов на экране (для окна: «Перевод в N местах»): мёртвые записи не в счёт.
  function shownCount() {
    let n = 0;
    for (const line of lines) if (lineAlive(line)) n++;
    return n;
  }

  // «Показ уже есть» — строка или карточка; isBusy добавляет «запрос уже в полёте».
  function isShown(owner) { return !!lineOf(owner) || popovers.has(owner); }
  function isBusy(owner) { return isShown(owner) || inFlight.has(owner); }

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
    return { error: (r && r.error) || TX_FAIL, code: (r && r.code) || "", detail: (r && r.detail) || "", focus: (r && r.focus) || "" };
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
  // «щёлкните по тексту» оно заменяет на том же месте и той же высоты: заголовок, пара языков, полоса.
  // what — «Испанский → русский» (пара) или «Определение языка» (детектор).
  let downloadHint = null;
  function downloadNotice(what) {
    const opts = { title: HT_t("dlTitle"), icon: "", text: what, progress: "indet", ms: 0 };
    const t = downloadHint && downloadHint.alive() ? downloadHint : null;
    downloadHint = null;
    const n = t ? (t.update(opts), t) : showToast(opts);
    return {
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round(100 * (e.total ? e.loaded / e.total : e.loaded));
          n.update({ text: HT_t("dlPct", [what, String(pct)]), progress: pct });
        });
      },
      done() { n.close(); },
    };
  }
  // «Английский → русский» — названия языков на языке интерфейса, первая буква заглавная.
  function capFirst(s) { s = String(s || ""); return s ? s[0].toLocaleUpperCase(HT_uiLang()) + s.slice(1) : s; }
  function pairText(src, tgt) { return HT_t("pairArrow", [capFirst(HT_langLabel(HT_langBase(src))), HT_langLabel(HT_langBase(tgt))]); }

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
      const p = createModel(LanguageDetector, {}, HT_t("dlDetectorName"), mayDownload)
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
      return isTargetLang((await pickLang(res)).detectedLanguage);
    } catch (e) {
      return false;
    }
  }

  // Детектор Chrome путает близкие языки: русский абзац Хабра → bg 0,55, ru 0,4. Русский текст при переводе на
  // русский шёл в перевод «с болгарского», а при переводе на английский Chrome качал модель «болгарский →
  // английский». Поэтому язык из ответа детектора выбираем так: первым назван язык, близкий к языку страницы или
  // перевода, а тот тоже в числе вероятных (≥ 0,2), — значит, он. Язык страницы — первым (<html lang="ru">, а
  // детектор колеблется между bg и ru — верим странице); страница сама на названном первым языке — его и берём.
  // Порог уверенности по-прежнему у первого варианта: здесь выбираем только, какой из близких языков.
  // page — язык страницы, если уже известен (иначе спросим pageLang; для неё самой — "").
  const KIN = [["ru", "uk", "be", "bg", "mk", "sr"], ["hr", "bs", "sr", "sl"], ["cs", "sk"], ["da", "no", "sv"], ["id", "ms"], ["gl", "pt", "es"]];
  const KIN_MIN = 0.2;
  async function pickLang(res, page) {
    const top = res[0];
    const k0 = HT_langKey(top.detectedLanguage);
    if (!KIN.some((g) => g.includes(k0))) return top;
    page = HT_langKey(page == null ? await pageLang() : page);
    if (page === k0) return top;
    for (const e of [page, HT_langKey(settings.targetLang || "RU")]) {
      if (!e || !KIN.some((g) => g.includes(k0) && g.includes(e))) continue;
      const alt = res.find((r) => HT_langKey(r.detectedLanguage) === e && r.confidence >= KIN_MIN);
      if (alt) return alt;
    }
    return top;
  }

  // Язык текста → { lang } либо { kind, state } (детектора нет / модель не скачана), либо {}. Заданный
  // вручную язык — кодом встроенного переводчика (NB → "no"), если встроенный его знает. Близкие языки — см. pickLang.
  async function detectLang(text, mayDownload, page) {
    if (settings.sourceLang && settings.sourceLang !== "auto") {
      return { lang: HT_builtinCode(settings.sourceLang) || HT_langBase(settings.sourceLang) };
    }
    const d = await getDetector(mayDownload);
    if (!d.inst) return { kind: d.kind, state: d.state };
    try {
      const res = await d.inst.detect(text);
      const top = res && res[0];
      if (top && top.confidence >= 0.4) return { lang: (await pickLang(res, page)).detectedLanguage.toLowerCase() };
    } catch (e) { /* не определили */ }
    return {};
  }

  // Короткий кусок — меньше 4 слов или меньше 25 букв. На таком детектор Chrome уверенно ошибается (Википедия:
  // «Main menu» → румынский 0,61, «Main page» → французский, «Contents» → каталанский, «Wikidata item» → польский,
  // «Solanum lycopersicum» — 2 слова, 19 букв — → латынь), а у пункта меню, оглавления, кнопки весь блок — это и
  // есть подпись, язык по блоку не спасает. Все замеченные ошибки — на 1–3 словах до 20 букв; порог с запасом, а
  // обычная фраза из 4+ слов и 25+ букв уже определяется. В письме без пробелов (китайский, японский, тайский…)
  // знак — почти слово: считаем его словом и тремя буквами («主菜单» — короткое, фраза из 10 знаков — нет).
  const NOSPACE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/gu;
  function shortText(s) {
    const ns = (s.match(NOSPACE) || []).length;
    const words = s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length + ns;
    const letters = (s.match(/\p{L}/gu) || []).length + 2 * ns;
    return words < 4 || letters < 25;
  }

  // Язык страницы для коротких кусков: детектор по большому видимому тексту страницы (на нём он не ошибается и
  // не верит неправильному <html lang> шаблона), иначе — <html lang>. Детектор назвал язык перевода — это может
  // быть наш же перевод на странице: тогда <html lang>, если он есть. Считаем раз на адрес (без #); детектор
  // не ответил (ещё не скачан) — спросим снова через 5 с, а пока <html lang>.
  let pageLangMemo = null;            // { url, until, det } — det: обещание языка по тексту страницы ("" — нет)
  // Из близких языков (см. pickLang) детектор по тексту страницы выбирает тот, что в <html lang>.
  async function pageLang() {
    const url = location.href.split("#")[0];
    const html = HT_langKey(document.documentElement.lang || "");
    const own = /^[a-z]{2,3}$/.test(html) ? html : "";
    if (!pageLangMemo || pageLangMemo.url !== url || pageLangMemo.until < Date.now()) {
      const sample = String((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 5000);
      const memo = { url, until: Infinity, det: null };
      memo.det = (shortText(sample) ? Promise.resolve({}) : detectLang(sample, true, own)).then((d) => {
        if (!d.lang) memo.until = Date.now() + 5000;
        return d.lang || "";
      });
      pageLangMemo = memo;
    }
    const det = await pageLangMemo.det;
    return det && (!isTargetLang(det) || !own) ? det : own;
  }

  // Язык куска для встроенного переводчика — как detectLang, но короткий кусок получает язык страницы.
  // Страница без языка — свой язык куска с пометкой guess: ради догадки по паре слов модель не качаем.
  async function langOf(text) {
    if ((settings.sourceLang && settings.sourceLang !== "auto") || !shortText(text)) return detectLang(text, true);
    const page = await pageLang();
    if (page) return { lang: page };
    const d = await detectLang(text, true);
    return d.lang ? Object.assign(d, { guess: true }) : d;
  }

  // ---- движки перевода ----

  // Встроенный Chrome Translator: экземпляры кэшируются по паре языков, неудача — нет.
  // mayDownload=false — только уже скачанная модель (язык короткого куска угадан, см. langOf).
  function getTranslator(src, tgt, mayDownload = true) {
    const key = src + ">" + tgt;
    if (!translators.has(key)) {
      const p = createModel(Translator, { sourceLanguage: src, targetLanguage: tgt }, pairText(src, tgt), mayDownload)
        .catch((e) => ({ kind: "fail", error: e }))
        .then((r) => {
          if (!r.inst && translators.get(key) === p) translators.delete(key);
          return r;
        });
      translators.set(key, p);
    }
    return translators.get(key);
  }

  // Язык пары, которого нет среди языков браузера, или "". Для таких пар Chrome скрывает от сайта, скачана
  // ли модель: availability() отвечает «downloadable» на КАЖДОМ сайте, пока этот сайт сам не создаст
  // переводчик для пары, а создать его можно только по щелчку (если модель уже на компьютере — мгновенно,
  // без загрузки). Языки браузера — navigator.languages (Настройки Chrome → Языки); английский Chrome не
  // скрывает. Проверено в Chrome 157: пара английский → русский на новом сайте при русском браузере —
  // «available», при английском — «downloadable», после добавления русского в языки — снова «available».
  function hiddenLang(src, tgt) {
    const mine = new Set(["en"].concat([...(navigator.languages || [])].map(HT_langKey)));
    return [src, tgt].find((l) => !mine.has(HT_langKey(l))) || "";
  }

  // Модель не готова: что сказать. key — что именно ждёт щелчка (одно уведомление на страницу).
  // Щелчок нужен потому, что одиночный Shift (и наведение) Chrome действием пользователя не считает.
  // После щелчка абзац под курсором переводится сам (см. обработчик click), а уведомление «Щёлкните по
  // тексту» на том же месте становится «Скачиваю переводчик» (downloadNotice). Когда именно нужен щелчок:
  //   • модели нет на компьютере — щелчок запускает загрузку, она нужна один раз для всех сайтов;
  //   • пара с языком не из языков браузера — на каждом новом сайте (см. hiddenLang);
  //   • детектор языка первые секунды после запуска Chrome тоже отвечает «downloadable», хотя модель есть.
  // Возвращает неудачу с готовым уведомлением (note): заголовок, строка и пустая полоса загрузки.
  function needDownload(state, src, tgt) {
    const key = src ? src + ">" + tgt : "detector";
    const fail = (note) => ({ ok: false, kind: "download", key, error: note.text, note });
    if (state === "downloading") {
      return fail({ title: HT_t("csDlWaitTitle"), text: HT_t("csDlWaitText", src ? pairText(src, tgt) : HT_t("dlDetectorName")), progress: "indet" });
    }
    const hidden = src ? hiddenLang(src, tgt) : "";
    const text = hidden ? HT_t("csClickSite", HT_langLabel(hidden)) : HT_t(src ? "csClickPair" : "csClickDetector");
    return fail({ title: HT_t("csClickTitle"), icon: "pointer", text, progress: "empty" });
  }

  // Перевод по тексту (без HTML) встроенным движком. Возвращает src для бейджа.
  // Язык перевода — кодом встроенного переводчика (ZH-HANT → "zh-Hant", NB → "no"); языка нет в его
  // списке — честная причина (сюда это доходит только через «авто» после сбоя DeepL).
  // block — обещание detectLang для всего блока, в котором этот узел (см. localResults), или null.
  async function chromeTranslate(text, targetLang, block) {
    if (!("Translator" in self)) return { ok: false, error: problemDesc("no-builtin") };
    const tgt = HT_builtinCode(targetLang);
    if (!tgt) return { ok: false, code: "lang", focus: "target-lang", error: sentence(HT_problemText("builtin-lang", "short", { targetLang })) };
    let d = block ? await block : null;
    if (!d || !(d.lang || d.kind)) d = await langOf(text);
    if (d.kind === "download") return needDownload(d.state);
    const src = d.lang;
    const noLang = { ok: false, code: "lang", focus: "source-lang", error: HT_t("csDetectFail") };
    if (!src) return noLang;
    if (HT_langKey(src) === HT_langKey(tgt)) return { ok: true, value: "", src }; // уже на целевом — оставляем оригинал
    const tp = getTranslator(src, tgt, !d.guess);
    const t = await tp;
    // Язык угадан по паре слов, а модели для него нет — не качаем и щелчка не просим: язык не определён.
    if (d.guess && (t.kind === "download" || t.kind === "unavailable")) return noLang;
    if (t.kind === "download") return needDownload(t.state, src, tgt);
    if (t.kind === "unavailable") {
      return { ok: false, error: HT_t("pairUnavailable", [HT_langLabel(src), HT_langLabel(tgt)]) };
    }
    try {
      if (!t.inst) throw t.error;
      try {
        return { ok: true, value: await t.inst.translate(text), src };
      } catch (e) {
        // Chrome 157: когда скачивается другая языковая модель (щелчок по цитате на другом языке; замерено —
        // в момент, когда она докачалась), уже созданные экземпляры отвечают UnknownError «Other generic
        // failures occurred» — до перезагрузки страницы, а новый экземпляр той же пары работает. Выбрасываем
        // из кэша и повторяем один раз. Соседние узлы падают разом: убирает только первый (сравниваем
        // обещание — без await между проверкой и удалением), остальные получают уже новый экземпляр.
        if (!e || e.name !== "UnknownError") throw e;
        const key = src + ">" + tgt;
        if (translators.get(key) === tp) translators.delete(key);
        const t2 = await getTranslator(src, tgt, !d.guess);
        if (t2.kind === "download") return needDownload(t2.state, src, tgt);
        if (!t2.inst) throw e;
        return { ok: true, value: await t2.inst.translate(text), src };
      }
    } catch (e) {
      return { ok: false, error: HT_t("builtinFailed"), detail: e && e.message ? e.message : String(e) };
    }
  }

  // Встроенный переводчик теряет знаки препинания на краях текстового узла (проверено в Chrome 157, ru→en):
  // «<b>Выбирайте мелкий сорт</b>, например черри» → «<b>Choose a small variety</b>eg Cherry» — узел «, например
  // черри» вернулся без запятой и пробела, а «сорт,» — без запятой. Узел — кусок предложения, поэтому знаки на
  // стыке с соседним узлом переводчику не отдаём и возвращаем как были, по образцу пробелов в splitWs. В начале —
  // закрывающие и разделительные (, . ; : ! ? … ) ] » —); в конце — только разделительные и открывающие (, ; : ( [ « —):
  // точка, «?» и «!» в конце — часть предложения, без «?» переводчик теряет вопрос («Это важно?» → «This is
  // important»). Апострофа и кавычек “ ” ‘ ’ нет: «’s» после <b>John</b> — часть слова, а “ в немецком закрывает.
  const EDGE_LEAD = /^[\s,.;:!?…)\]}»\p{Pd}]+/u;
  const EDGE_TRAIL = /[\s,;:(\[{«\p{Pd}]+$/u;
  async function chromeTranslateEdges(text, targetLang, block) {
    const lead = (text.match(EDGE_LEAD) || [""])[0];
    const rest = text.slice(lead.length);
    const trail = (rest.match(EDGE_TRAIL) || [""])[0];
    const core = rest.slice(0, rest.length - trail.length);
    // Одни знаки (запятая между двумя <b>) — переводить нечего: value "" оставляет узел как был.
    if (!/[\p{L}\p{N}]/u.test(core)) return { ok: true, value: "", src: null, bare: true };
    const r = await chromeTranslate(core, targetLang, block);
    // value "" — «уже на языке перевода, оставить оригинал»: знаки к нему не приклеиваем.
    if (r && r.ok && r.value) r.value = lead + r.value + trail;
    return r;
  }

  // Встроенный движок для всего списка. Если не перевелось НИЧЕГО — отдаём error: все вызывающие
  // определяют сбой по этому полю, и без него встроенный движок падал абсолютно молча
  // (неподдерживаемая пара языков, Chrome < 138 — пользователь наводит, и не происходит ничего).
  // primary — неудача DeepL, из-за которой перевод пошёл сюда: она информативнее («ключ не подошёл»,
  // «лимит закончился»). Исключения: нескачанная модель — это не сбой, а шаг настройки, и подсказка,
  // что сделать, полезнее ошибки DeepL; «нет ключа» и «нет согласия» в режиме «авто» — не сбой, а
  // обычная работа встроенным, и настоящая причина — в ответе встроенного переводчика.
  // Язык узла — язык его блока (lines[i] — строка перевода, у всех узлов одного блока одна): детектор Chrome на
  // коротком куске уверенно ошибается — «прямо под корень» → украинский 0,58, «Abono» → итальянский 0,76, «Да» →
  // сербский 0,38, — и ссылка или выделенное слово внутри блока оставались непереведёнными посреди перевода.
  // Блок определяем один раз по всему его тексту; свой язык узла — только если по блоку не определился.
  // Короткий блок (пункт меню, кнопка, подпись) — язык страницы (см. langOf).
  async function localResults(texts, primary, lines) {
    const blocks = new Map();
    const blockLang = (i) => {
      const line = lines && lines[i];
      if (!line || !line.nodes) return null;
      if (!blocks.has(line)) blocks.set(line, langOf(lineText(line)));
      return blocks.get(line);
    };
    const results = await Promise.all(texts.map((t, i) => chromeTranslateEdges(t, settings.targetLang, blockLang(i))));
    // Текст из одних знаков (bare) переводчику не отдавали — это не удача: иначе блок «Hello» + «, » с
    // нескачанной моделью молча не переводился бы, а подсказку «Щёлкните по тексту» глушил бы «перевод» запятой.
    const real = results.filter((r) => !(r && r.bare));
    if (!real.length || real.some((r) => r && r.ok)) return { results };
    const dl = results.find((r) => r && r.kind === "download");
    if (dl) return { results: null, error: dl.error, kind: "download", key: dl.key, note: dl.note };
    if (primary && primary.code !== "no-key" && primary.code !== "no-consent") return Object.assign({ results: null }, primary);
    return Object.assign({ results: null }, failOf(results.find((r) => r && r.error)));
  }

  // Сбои DeepL, при которых переводим встроенным, если он есть: лимит на месяц, нет сети, нет ответа,
  // сервис недоступен. Выбор переводчика в настройках не меняем — один раз говорим, что происходит.
  // Про лимит — раз за сессию браузера (он не вернётся до следующего месяца), про сеть — раз на
  // страницу (сеть может вернуться и пропасть снова).
  const FALLBACK_SAY = { quota: "csFbQuota", network: "csFbNetwork", timeout: "csFbTimeout", server: "csFbServer" };
  // О чём сказать, когда перевели встроенным: сбои выше и — для «авто» — отклонённый ключ. Без этого
  // «авто» с неверным ключом молча переводил встроенным, и человек думал, что работает DeepL.
  const FALLBACK_TELL = Object.assign({ "bad-key": "csFbBadKey" }, FALLBACK_SAY);
  const FALLBACK_ONCE = { quota: "deepl-quota", "bad-key": "deepl-bad-key" };
  const fallbackTold = new Set();
  function fallbackSay(code) {
    if (!FALLBACK_TELL[code] || fallbackTold.has(code)) return;
    fallbackTold.add(code);
    // Одной строкой; лимит и отклонённый ключ — с кнопкой в настройки (переводит уже встроенный).
    const opts = code === "quota" ? { actions: [settingsAct("deepl")] }
      : code === "bad-key" ? { actions: [settingsAct("deepl-key")] } : {};
    const show = () => notice(HT_t(FALLBACK_TELL[code]), 9000, opts);
    if (!FALLBACK_ONCE[code]) { show(); return; }
    send({ type: "noticeOnce", problem: FALLBACK_ONCE[code] }).then((r) => { if (r && r.show && !dead) show(); }).catch(() => {});
  }

  // ЕДИНСТВЕННЫЙ путь к движку → { results:[{ok,value,src}] } либо { results:null, error[, kind] }.
  // Перевод одного элемента — это батч из одного элемента: пока для него был отдельный путь,
  // политика движков (выбор, фолбэк, обработка ошибок) жила в двух копиях и они уже разошлись —
  // правило «не перевелось ничего → error» было только в одной.
  // Движку уходит экранированный ТЕКСТ, а не разметка страницы: иначе в платный движок и в ключ
  // кэша попадала бы вся span-обвязка каркаса (кратная переплата и промах кэша на каждом
  // ре-рендере). Ответ раскодируется обратно в чистый текст. `by` — кто инициировал перевод
  // (HT_BY_PAGE / HT_BY_USER), от этого зависит бюджет расхода в background.
  // lines — для встроенного: строка перевода каждого текста (язык определяется по блоку целиком), можно без них.
  // Что-то перевелось — прежняя ошибка и ожидание щелчка (точки на кружке) больше не правда.
  async function translateItems(texts, by, lines) {
    const out = await translateVia(texts, by, lines);
    if (out.results && (failErr || needClick)) { failErr = ""; needClick = false; syncFab(); }
    return out;
  }
  async function translateVia(texts, by, lines) {
    const e = HT_engine(settings.engine);
    if (e.via === "local") return localResults(texts, null, lines);
    // Нет ключа или согласия — текст в сеть не уходит вовсе: «авто» сразу переводит встроенным, а
    // DeepL и ИИ сюда обычно не доходят (их останавливает blocked) — это страховка на гонку с
    // хранилищем. Background проверяет то же самое ещё раз перед запросом.
    if (!HT_canSend(e.code, netState())) {
      if (e.fallback === "local") return localResults(texts, null, lines);
      const p = problem();
      return { results: null, error: p ? problemDesc(p) : TX_FAIL,
        code: p === "no-consent" ? "no-consent" : p === "deepl-lang" ? "lang" : "no-key", detail: "", focus: p ? problemFocus(p) : "" };
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
    const out = await localResults(texts, fail, lines);
    // Выбран именно DeepL, а встроенный сразу не смог (модель не скачана, пара не поддерживается):
    // говорим о сбое DeepL — подсказка «скачиваю модель» без слова о DeepL только путала.
    if (!out.results && e.fallback !== "local") return Object.assign({ results: null }, fail);
    if (out.results && (e.fallback !== "local" || fail.code === "quota" || fail.code === "bad-key")) fallbackSay(fail.code);
    return out;
  }

  // Показать сбой перевода. Нескачанная модель — не ошибка: абзац не краснеет, а подсказка «Щёлкните по
  // тексту» — одна на страницу для каждой модели; следующий щелчок по странице повторяет перевод элемента
  // под курсором (у щелчка есть «действие пользователя», и загрузка начнётся).
  // Ошибка — заголовок с красным «!» и что случилось; с действием («Открыть настройки», «Переводить
  // встроенным») висит дольше, простая исчезает сама. ✕ — у всех.
  const downloadTold = new Set();
  let retryOnClick = false;
  let retryPage = false;              // повторить после щелчка перевод всей страницы, а не абзаца
  function showFail(owner, out, fromPage) {
    if (out.kind === "download") {
      retryOnClick = true;
      retryPage = !!fromPage;
      const n = out.note || { text: out.error };
      if (n.icon === "pointer" && !needClick) { needClick = true; syncFab(); }
      if (!downloadTold.has(out.key)) {
        downloadTold.add(out.key);
        downloadHint = notice(n.text, 15000, Object.assign({ anchor: owner || hoverEl }, n));
      }
      return;
    }
    if (owner) failOwner(owner);
    const actions = actionsFor(out.code, out.focus);
    if (actions.length && out.code && failErr !== out.code) { failErr = out.code; syncFab(); }
    // Отклонённый ключ — своим заголовком и подсказкой, что делать; остальное — «Не удалось перевести»
    // и текст ошибки (мелко — код ответа сервиса).
    const hint = FAIL_HINT[out.code];
    toast({
      title: hint ? HT_t("csBadKeyTitle", serviceName()) : HT_t("csFailTitle"), icon: "err", kind: "err",
      text: hint ? HT_t(hint) : out.error || TX_FAIL, detail: out.detail, actions, anchor: owner,
      ms: actions.length ? 10000 : 5000,
    });
  }

  // ---- фон сайта и подсветка ----
  function hexToRgba(hex, alpha) {
    const m = String(hex).replace("#", "");
    const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    const r = parseInt(n.slice(0, 2), 16) || 0;
    const g = parseInt(n.slice(2, 4), 16) || 0;
    const b = parseInt(n.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Цвет rgb()/rgba() → [r, g, b, a]; null — нераспознанный формат.
  function parseColor(c) {
    const m = c && c.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : parseFloat(m[4])] : null;
  }

  // Жёлтый или кремовый фон (#fff8dc, #fffde7, #ffeb3b): янтарная подложка на нём теряется, поэтому там
  // переведённое подчёркивается.
  function isCream(p) {
    const r = p[0] / 255, g = p[1] / 255, b = p[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 0.06 || l < 0.6) return false;      // почти белый «бумажный» фон (#faf8f0) — янтарь на нём виден
    const s = d / (1 - Math.abs(2 * l - 1));
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
    return s >= 0.25 && hue >= 35 && hue <= 70;
  }

  // Холст окна без своего фона у страницы: тёмный, если страница объявила только тёмную схему
  // (color-scheme: dark — свойством или <meta name="color-scheme">) или «light dark» при тёмной теме системы.
  function canvasDark() {
    try {
      let cs = getComputedStyle(document.documentElement).colorScheme || "";
      if (!/dark|light/.test(cs)) {
        const m = document.querySelector('meta[name="color-scheme"]');
        cs = m ? String(m.getAttribute("content") || "") : "";
      }
      if (!/dark/.test(cs)) return false;
      return !/light/.test(cs) || matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) { return false; }
  }

  // Фон под элементом — ближайший непрозрачный у него или предков: { dark, cream }.
  function bgOf(el) {
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 40; i++, node = node.parentElement) {
      const p = parseColor(getComputedStyle(node).backgroundColor);
      if (p && p[3] > 0.1) {
        const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
        return { dark: lum < 0.5, cream: lum >= 0.5 && isCream(p) };
      }
    }
    return { dark: canvasDark(), cream: false };
  }

  // Тёмный ли сайт — для уведомлений, плавающей кнопки и её меню: фон посередине окна (там основной текст),
  // а не тема системы: светлый сайт при тёмной теме Chrome — всё равно светлый.
  function siteDark() {
    let el = null;
    try {
      const all = document.elementsFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      el = all.find((e) => !isOurUi(e)) || null;
    } catch (e) { el = null; }
    return bgOf(el || document.body || document.documentElement).dark;
  }

  // Подсветка переведённого наведением или клавишей (замена на месте). «Подстраивать под страницу» —
  // янтарь с ореолом 3 px (.34 на светлом фоне, .20 на тёмном), на жёлтом и кремовом — подчёркивание
  // #b07a00; «Свой цвет» — dispBg с насыщенностью dispOpacity %; «Без подсветки» — ничего. Страницу,
  // переведённую целиком, не подсвечиваем: она должна выглядеть как оригинал на другом языке.
  // Список [свойство, значение] для inline-стиля владельца или null.
  function highlightFor(line) {
    if (settings.dispMode === "none") return null;
    const fill = (c) => [["background-color", c], ["box-shadow", "0 0 0 3px " + c], ["border-radius", "2px"]];
    const bg = line.bg || bgOf(line.owner.parentElement || line.owner);
    if (settings.dispMode === "custom") {
      // На тёмном фоне — слабее (×0,6), как янтарь .34 → .20: яркая заливка там режет глаз.
      const pct = Math.max(0, Math.min(100, Number(settings.dispOpacity) || 0));
      return fill(hexToRgba(settings.dispBg, Math.round(pct * (bg.dark ? 0.6 : 1)) / 100));
    }
    if (bg.cream) {
      return [["text-decoration-line", "underline"], ["text-decoration-style", "solid"], ["text-decoration-color", "#b07a00"],
        ["text-decoration-thickness", "2px"], ["text-underline-offset", "3px"]];
    }
    return fill(bg.dark ? "rgba(255,207,74,0.2)" : "rgba(255,207,74,0.34)");
  }

  // Подсветка owner-а. Перед записью снимаем СНИМОК собственного inline-style элемента
  // (значение + priority) и при откате возвращаем именно его. Раньше откат делал removeProperty,
  // то есть одно наведение на <span style="background-color:#ffe58f;border-radius:6px"> (бейдж,
  // тег, кнопка — обычное дело в веб-приложениях) навсегда стирало эти свойства страницы,
  // а restyleAll стирал их сразу у всех переведённых строк при смене темы подсветки.
  function applyHLLine(line) {
    const owner = line.owner;
    line.hlSaved = null;
    if (line.page) return;              // страница целиком — без заливки блоков
    const want = highlightFor(line);
    if (!want) return;                  // «без подсветки» — не трогаем стиль
    line.hlSaved = saveStyle(owner, want);
    for (const [name, value] of want) owner.style.setProperty(name, value);
  }

  function clearHLLine(line) {
    const saved = line.hlSaved;
    if (!saved) return;
    line.hlSaved = null;
    restoreStyle(line.owner, saved);
  }

  // Снимок inline-свойств элемента страницы и возврат к нему (подсветка, обводка абзаца под карточкой).
  function saveStyle(el, want) {
    return want.map(([name]) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
  }
  function restoreStyle(el, saved) {
    const st = el.style;
    for (const [name, value, prio] of saved) {
      if (value) st.setProperty(name, value, prio); // возвращаем собственный inline-style страницы
      else st.removeProperty(name);                 // своего значения не было — просто снимаем наше
    }
  }

  // ---- свой интерфейс на странице ----
  // Наш UI (уведомление, карточка перевода, плавающая кнопка) живёт в shadow root. Это обычный DOM страницы,
  // а CSS контент-скрипта попадает в author origin ПЕРЕД таблицами страницы, поэтому её собственные
  // правила (.site select { height:44px }, .card span { color:#000 }) перебивали наши по
  // специфичности. Внутри shadow root правила страницы недоступны; наследуемые свойства (шрифт, цвет,
  // выравнивание, межбуквенный интервал) задаём явно на корневом элементе (.ui), а позицию и слой
  // хоста — инлайново с !important.
  // Побочная польза: document.body.querySelectorAll("*") в shadow root не заглядывает, так что
  // наша разметка вообще не попадает в кандидаты на перевод.
  // Цвета — свои, по фону сайта, а не по теме системы: на светлом сайте белое с рамкой
  // #c9ced5, на тёмном (.dk) — #2a2d33 с рамкой rgba(255,255,255,.4). Шрифт — системный: @font-face
  // внутри shadow root Chrome не применяет, а грузить шрифт с чужого сайта незачем.
  // Сбросы — только через :where(), чтобы не перебить цвета кнопок.
  const UI_CSS = `
    :where(*) { box-sizing: border-box; }
    :where(p) { margin: 0; }
    :where(button, select) { margin: 0; font: inherit; color: inherit; }
    :where(svg) { display: block; flex: none; }
    .ui {
      --bg: #ffffff; --line: #c9ced5; --fg: #17191c; --muted: #4b525a; --muted-2: #5d646d; --hover: #eef0f3;
      --sep: #e4e7eb; --btn-bg: #ffffff; --btn-line: #858b94; --btn-line-h: #5d646d; --pri: #2563eb; --pri-h: #1d4ed8;
      --pri-fg: #ffffff; --ok: #157a3c; --err: #b42318; --track: #e3e6ea; --bar: #2563eb; --kbd-bg: #f5f6f8;
      --kbd-line: #c9ced5; --shadow: 0 12px 32px rgba(15, 20, 25, 0.16); --focus: #2563eb; --halo: rgba(37, 99, 235, 0.35);
      --hi-fg: #17191c; --link: #1d4ed8; --seg-bg: #f5f6f8; --seg-on: #ffffff; --seg-on-line: #858b94;
      --pick: #eef3fe; --pick-press: #dbe6fe; --pick-fg: #1d4ed8;
      color-scheme: light;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; line-height: 20px; font-weight: 400; font-style: normal; font-variant: normal;
      letter-spacing: normal; word-spacing: normal; text-transform: none; text-align: left; text-indent: 0;
      text-shadow: none; white-space: normal; direction: ltr; writing-mode: horizontal-tb; cursor: auto;
      visibility: visible; color: var(--fg); -webkit-text-fill-color: currentColor; -webkit-font-smoothing: antialiased;
    }
    .ui.dk {
      --bg: #2a2d33; --line: rgba(255, 255, 255, 0.4); --fg: #e8e9eb; --muted: #b9bec5; --muted-2: #b9bec5; --hover: #363a41;
      --sep: rgba(255, 255, 255, 0.16); --btn-bg: transparent; --btn-line: rgba(255, 255, 255, 0.4);
      --btn-line-h: rgba(255, 255, 255, 0.55); --pri: #8fb0ff; --pri-h: #a9c2ff; --pri-fg: #0b1220; --ok: #4ccf86;
      --err: #ff8a80; --track: rgba(255, 255, 255, 0.16); --bar: #8fb0ff; --kbd-bg: rgba(255, 255, 255, 0.08);
      --kbd-line: rgba(255, 255, 255, 0.4); --shadow: 0 12px 32px rgba(0, 0, 0, 0.6); --focus: #8fb0ff; --halo: rgba(143, 176, 255, 0.45);
      --hi-fg: #ffffff; --link: #8fb0ff; --seg-bg: #222429; --seg-on: #3a3e46; --seg-on-line: rgba(255, 255, 255, 0.55);
      --pick: rgba(143, 176, 255, 0.16); --pick-press: rgba(143, 176, 255, 0.26); --pick-fg: #8fb0ff;
      color-scheme: dark;
    }
    .ui :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .ok { color: var(--ok); }
    .err { color: var(--err); }

    /* уведомление: 360, вверху справа или внизу над плавающей кнопкой (место — placeToast) */
    .toast {
      display: flex; align-items: flex-start; gap: 12px; width: 360px; max-width: calc(100vw - 32px);
      padding: 12px 8px 12px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg);
      box-shadow: var(--shadow); opacity: 0; transform: translateY(-6px); transition: opacity 0.15s, transform 0.15s;
    }
    .toast.low { transform: translateY(6px); }
    .toast.show { opacity: 1; transform: none; }
    .t-b { flex: 1; min-width: 0; }
    .t-t { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .t-d { margin-top: 2px; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
    .t-m { overflow-wrap: anywhere; }
    .t-dt { margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; }
    .t-a { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
    .t-btn {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--btn-line);
      border-radius: 8px; background: var(--btn-bg); color: var(--fg); font-size: 13px; line-height: 20px; font-weight: 500;
      white-space: nowrap; cursor: pointer;
    }
    .t-btn:hover { background: var(--hover); border-color: var(--btn-line-h); }
    .t-btn.pri { background: var(--pri); border-color: var(--pri); color: var(--pri-fg); }
    .t-btn.pri:hover { background: var(--pri-h); border-color: var(--pri-h); }
    .t-hint { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
    .t-kbd {
      display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border: 1px solid var(--kbd-line);
      border-bottom-width: 2px; border-radius: 4px; background: var(--kbd-bg); color: var(--fg); font-size: 12px;
      font-weight: 500; line-height: 1;
    }
    .t-prog { display: block; height: 4px; margin-top: 8px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .t-prog > span { display: block; width: 0; height: 100%; border-radius: 2px; background: var(--bar); transition: width 0.2s; }
    .t-prog.indet > span { width: 40%; animation: ht-indet 1.2s ease-in-out infinite; }
    @keyframes ht-indet { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
    .x-btn, .c-btn {
      flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
      padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--muted-2); cursor: pointer;
    }
    .x-btn { margin-top: -6px; }
    .x-btn:hover, .c-btn:hover { background: var(--hover); color: var(--hi-fg); }

    /* карточка перевода: хвостик к абзацу, шрифт текста — как у абзаца (задаётся инлайново) */
    .tcard {
      position: relative; padding: 8px 8px 16px 16px; border: 1px solid var(--line); border-radius: 12px;
      background: var(--bg); box-shadow: var(--shadow);
    }
    .caret {
      position: absolute; top: -7px; left: 28px; width: 12px; height: 12px; background: var(--bg);
      border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg);
    }
    .tcard.up .caret { top: auto; bottom: -7px; border: 0; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .tcard.flat .caret { display: none; }
    .c-top { display: flex; align-items: center; gap: 4px; }
    .c-lang {
      flex: 1; min-width: 0; font-size: 13px; font-weight: 500; color: var(--muted-2); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .c-text {
      margin-top: 4px; padding-right: 8px; max-height: min(60vh, 420px); overflow-y: auto; overscroll-behavior: contain;
      overflow-wrap: anywhere;
    }

    /* плавающая кнопка: кружок 44 у края окна, меню 320 вбок от него (к середине экрана). Цвета — по фону сайта, как у
       уведомлений: светлый — белое и рамка #c9ced5, тёмный (.dk) — #2a2d33 и рамка rgba(255,255,255,.4); акцент — #2563eb
       и #8fb0ff (текст на нём #0b1220). Кольцо, подпись и точка мышь не ловят: щёлкнуть можно только сам кружок. */
    [hidden] { display: none !important; }
    .fab-box { position: relative; width: 44px; height: 44px; }
    .fab-w { position: absolute; left: 0; top: 0; width: 44px; height: 44px; }
    .fab {
      display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
      border: 1px solid #c9ced5; border-radius: 50%; background: #ffffff; color: #2563eb; cursor: pointer;
      box-shadow: 0 1px 2px rgba(15, 20, 25, 0.08), 0 6px 20px rgba(15, 20, 25, 0.16);
      touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
      transition: background-color 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.15s;
    }
    .fab:hover, .fab[aria-expanded="true"] {
      background: #eef3fe; border-color: #c3d4fb; color: #1d4ed8;
      box-shadow: 0 1px 2px rgba(15, 20, 25, 0.08), 0 8px 24px rgba(15, 20, 25, 0.2);
    }
    .fab:not(.on):active { background: #dbe6fe; border-color: #a9c2f8; }
    .ui .fab:focus-visible { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.35), 0 6px 20px rgba(15, 20, 25, 0.16); }
    .fab.is-drag { cursor: grabbing; transform: scale(1.08); box-shadow: 0 2px 4px rgba(15, 20, 25, 0.1), 0 16px 36px rgba(15, 20, 25, 0.26); }
    .fab.is-drag:not(.on) { background: #ffffff; border-color: #c9ced5; color: #2563eb; }
    .fab.on { background: #2563eb; border-color: #2563eb; color: #ffffff; }
    .fab.on:hover, .fab.on[aria-expanded="true"] { background: #1d4ed8; border-color: #1d4ed8; color: #ffffff; }
    .dk .fab { background: #2a2d33; border-color: rgba(255, 255, 255, 0.4); color: #8fb0ff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 20px rgba(0, 0, 0, 0.55); }
    .dk .fab:hover, .dk .fab[aria-expanded="true"] { background: #363a41; border-color: rgba(255, 255, 255, 0.55); color: #a9c2ff; }
    .dk .fab:not(.on):active { background: #40444c; }
    .ui.dk .fab:focus-visible { border-color: #8fb0ff; box-shadow: 0 0 0 3px rgba(143, 176, 255, 0.45), 0 6px 20px rgba(0, 0, 0, 0.55); }
    .dk .fab.is-drag { box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35), 0 16px 36px rgba(0, 0, 0, 0.7); }
    .dk .fab.is-drag:not(.on) { background: #2a2d33; border-color: rgba(255, 255, 255, 0.4); color: #8fb0ff; }
    .dk .fab.on { background: #8fb0ff; border-color: #8fb0ff; color: #0b1220; }
    .dk .fab.on:hover, .dk .fab.on[aria-expanded="true"] { background: #a9c2ff; border-color: #a9c2ff; color: #0b1220; }
    /* идёт перевод: кольцо 3 px в 1,5 px от кружка — дорожка и доля готового (начало — сверху) */
    .fab-ring { position: absolute; left: -5px; top: -5px; width: 54px; height: 54px; pointer-events: none; transform: rotate(-90deg); }
    .fab-ring .tr { stroke: #dbe1e8; }
    .fab-ring .bar { stroke: #2563eb; transition: stroke-dasharray 0.2s; }
    .dk .fab-ring .tr { stroke: rgba(255, 255, 255, 0.18); }
    .dk .fab-ring .bar { stroke: #8fb0ff; }
    /* точка 12 с кольцом 2 px цвета кружка: янтарная — ждём щелчка по тексту, красная — перевод не работает */
    .fab-dot { position: absolute; right: 0; top: 0; width: 12px; height: 12px; border: 2px solid #ffffff; border-radius: 50%; pointer-events: none; }
    .fab-dot.warn { background: #b07a00; }
    .fab-dot.err { background: #d92d20; }
    .fab.on ~ .fab-dot { border-color: #2563eb; }
    .dk .fab-dot { border-color: #2a2d33; }
    .dk .fab-dot.warn { background: #f0b84a; }
    .dk .fab-dot.err { background: #ff6b5f; }
    .dk .fab.on ~ .fab-dot { border-color: #8fb0ff; }
    /* подпись «Перевожу… N из M» рядом с кружком — со стороны середины экрана (.left — слева от кружка) */
    .fab-pill {
      position: absolute; top: 8px; left: 54px; display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
      border: 1px solid var(--line); border-radius: 14px; background: var(--bg); color: var(--fg);
      box-shadow: 0 4px 12px rgba(15, 20, 25, 0.12); font-size: 13px; line-height: 20px; font-weight: 500;
      white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: none;
    }
    .fab-pill.left { left: auto; right: 54px; }
    .dk .fab-pill { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); }

    /* меню 320: шапка → язык перевода → место действия 64 (как в окне расширения) → черта → пункты 36 */
    .fm {
      position: absolute; left: 0; top: 0; width: 320px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
      overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 16px 16px 8px;
      border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--fg);
      box-shadow: 0 12px 32px rgba(15, 20, 25, 0.18);
    }
    .dk .fm { box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6); }
    .fm-head { display: flex; align-items: center; gap: 8px; height: 20px; }
    .fm-name { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fm-lbl { display: block; margin-top: 16px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--muted); }
    .fm-sel { position: relative; margin-top: 6px; }
    .fm-sel select {
      appearance: none; -webkit-appearance: none; display: block; width: 100%; height: 36px; padding: 0 36px 0 12px;
      border: 1px solid var(--btn-line); border-radius: 8px; background: var(--bg); color: var(--fg);
      font-size: 14px; line-height: 20px; font-weight: 400; cursor: pointer; text-overflow: ellipsis;
    }
    .fm-sel select:hover { border-color: var(--btn-line-h); }
    .ui .fm-sel select:focus-visible { border-color: var(--focus); outline: 3px solid var(--halo); outline-offset: 0; }
    .fm-sel > svg { position: absolute; right: 10px; top: 10px; pointer-events: none; color: var(--muted-2); transition: transform 0.15s; }
    /* Раскрытый список языка — свой (настраиваемый select, Chrome 135+): поверхность и рамка меню, радиус 12,
       отступ 4, пункты 36; наведение и пункт под фокусом — мягкий фон акцента, выбранный — цвет акцента и галочка
       справа. Цвета — по фону сайта (.dk). Старее — системный список. */
    @supports (appearance: base-select) {
      .fm-sel select, .fm-sel select::picker(select) { appearance: base-select; }
      .fm-sel select { display: flex; align-items: center; white-space: nowrap; overflow: clip; overflow-clip-margin: content-box; }
      .fm-sel select > button {
        display: block; flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit;
        text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: inherit;
      }
      .fm-sel select::picker-icon { display: none; }
      .fm-sel select:open { border-color: var(--btn-line-h); }
      .fm-sel:has(select:open) > svg { transform: rotate(180deg); }
      .fm-sel select::picker(select) {
        box-sizing: border-box; min-inline-size: max(200px, anchor-size(self-inline)); max-inline-size: min(320px, 100vw - 16px);
        max-block-size: min(360px, 100% - 16px); margin: 4px 0; padding: 4px; border: 1px solid var(--line); border-radius: 12px;
        background: var(--bg); color: var(--fg); box-shadow: 0 12px 32px rgba(15, 20, 25, 0.18); overflow-y: auto;
        overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent;
      }
      .dk .fm-sel select::picker(select) { box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6); }
      .fm-sel option {
        display: flex; align-items: center; gap: 12px; min-block-size: 36px; padding: 8px 12px; border-radius: 8px;
        font-size: 14px; line-height: 20px; font-weight: 400; color: var(--fg); white-space: nowrap; cursor: pointer;
      }
      .fm-sel option:hover, .fm-sel option:focus-visible { background: var(--pick); outline: none; }
      .fm-sel option:active { background: var(--pick-press); }
      .fm-sel option:checked { color: var(--pick-fg); font-weight: 500; }
      /* галочка — рамкой, без картинки: картинки на чужом сайте может запретить его CSP */
      .fm-sel option::checkmark {
        order: 1; flex: none; content: ""; box-sizing: border-box; width: 12px; height: 7px; margin: 0 2px 3px auto;
        border: solid currentColor; border-width: 0 0 2px 2px; transform: rotate(-45deg);
      }
    }
    /* место действия — всегда 64 (кнопка или сегмент 36 + 8 + подсказка 20): меню не прыгает */
    .fm-act { height: 64px; margin-top: 12px; }
    .fm-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 36px; padding: 0 12px;
      border: 1px solid var(--pri); border-radius: 8px; background: var(--pri); color: var(--pri-fg); font-weight: 500;
      white-space: nowrap; cursor: pointer;
    }
    .fm-btn:hover { background: var(--pri-h); border-color: var(--pri-h); }
    .fm-btn2 {
      display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 12px;
      border: 1px solid var(--btn-line); border-radius: 8px; background: var(--btn-bg); color: var(--fg); font-weight: 500;
      white-space: nowrap; cursor: pointer;
    }
    .fm-btn2:hover { background: var(--hover); border-color: var(--btn-line-h); }
    .fm-hint {
      height: 20px; margin-top: 8px; font-size: 13px; line-height: 20px; color: var(--muted); text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fm-kbd {
      display: inline-block; height: 18px; padding: 0 5px; border: 1px solid var(--kbd-line); border-bottom-width: 2px;
      border-radius: 4px; background: var(--kbd-bg); color: var(--fg); font-size: 12px; line-height: 15px; font-weight: 500;
      vertical-align: 1px;
    }
    .lnk {
      display: inline; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--link); font: inherit;
      font-weight: 500; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; cursor: pointer;
    }
    .fm-busy { display: flex; align-items: center; gap: 12px; height: 36px; }
    .fm-busy-b { flex: 1; min-width: 0; }
    .fm-busy-t { display: flex; align-items: center; gap: 8px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
    .fm-busy-t svg { color: var(--muted-2); }
    .fm-prog { display: block; height: 4px; margin-top: 8px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .fm-prog > span { display: block; width: 0; height: 100%; border-radius: 2px; background: var(--bar); transition: width 0.2s; }
    .spin { animation: ht-spin 0.9s linear infinite; }
    @keyframes ht-spin { to { transform: rotate(360deg); } }
    .fm-seg { display: flex; gap: 2px; height: 36px; padding: 3px; border: 1px solid var(--sep); border-radius: 8px; background: var(--seg-bg); }
    .fm-seg button {
      flex: 1; min-width: 0; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: var(--muted);
      font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
    }
    .fm-seg button:hover { background: var(--hover); color: var(--hi-fg); }
    .fm-seg button[aria-checked="true"] {
      background: var(--seg-on); color: var(--hi-fg); font-weight: 600; box-shadow: 0 0 0 1px var(--seg-on-line), 0 1px 2px rgba(16, 24, 40, 0.08);
    }
    .fm-sep { height: 1px; margin: 16px -16px 8px; background: var(--sep); }
    .fm-item {
      display: flex; align-items: center; gap: 12px; width: calc(100% + 16px); height: 36px; margin: 0 -8px; padding: 0 8px;
      border: 0; border-radius: 8px; background: transparent; color: var(--fg); text-align: left; white-space: nowrap; cursor: pointer;
    }
    .fm-item svg { color: var(--muted-2); }
    .fm-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .fm-item:hover { background: var(--hover); }
    .ui .fm-item:focus-visible { outline: none; background: var(--hover); box-shadow: inset 0 0 0 2px var(--focus); }

    @media (prefers-reduced-motion: reduce) {
      .toast, .toast.low { transform: none; transition: none; }
      .t-prog > span, .fm-prog > span, .fab, .fab-ring .bar, .fm-sel > svg { transition: none; }
      .t-prog.indet > span { width: 100%; opacity: 0.5; animation: none; }
      .spin { animation: none; }
    }
  `;

  // Shadow root закрытый: в открытый сайт может зайти через host.shadowRoot и выбрать в списке
  // меню плавающей кнопки любое значение, а оно пишется в настройки и действует на всех сайтах.
  // host.shadowRoot у закрытого — null, поэтому ссылку на root держим сами.
  const uiRoots = new WeakMap();      // host -> его закрытый shadow root

  function makeUiHost(zIndex) {
    const host = document.createElement("div");
    host.setAttribute("data-ht-ui", "1");
    const s = host.style;
    s.setProperty("position", "fixed", "important");
    s.setProperty("z-index", zIndex, "important");
    s.setProperty("margin", "0", "important");
    s.setProperty("padding", "0", "important");
    s.setProperty("border", "0", "important");
    s.setProperty("width", "max-content", "important");
    s.setProperty("max-width", "none", "important");
    s.setProperty("height", "auto", "important");
    s.setProperty("transform", "none", "important");
    s.setProperty("visibility", "visible", "important");
    s.setProperty("opacity", "1", "important");
    s.setProperty("display", "block", "important");
    const root = host.attachShadow({ mode: "closed" });
    uiRoots.set(host, root);
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    root.appendChild(style);
    return { host, root };
  }

  // Смонтировать наше окно на страницу.
  function mountUi(node) { (document.body || document.documentElement).appendChild(node); }

  // Слои: карточка < плавающая кнопка с меню < уведомление. Раньше панель и тост стояли на 2147483647, а
  // карточка — на 2147483646, поэтому карточка накрывала панель смены языка.
  const Z_POPOVER = "2147483644";
  const Z_HUD = "2147483645";
  const Z_TOAST = "2147483646";

  // Внимание: расширение НИГДЕ не пишет в innerHTML. Ответ движка — недоверенный HTML: LLM можно
  // prompt-инъекцией заставить вернуть живой <img onerror=…>, а DeepL в режиме tag_handling:html
  // отдаёт разметку как есть. Поэтому единственная точка вставки — textContent, а decodeHtmlText
  // инертно снимает сущности и теги через DOMParser. Санитайзер-денилист, стоявший здесь раньше,
  // применялся только к движку llm (для дефолтного deepl не применялся вообще), пропускал
  // фреймворковые директивы (hx-*, x-*, v-on:/@click) и не спускался во вложенный <template>.

  // Элемент: h("div", { class: "x", title: "…" }, "текст", ребёнок…). Только textContent и setAttribute.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids) if (k != null && k !== false) el.append(k);
    return el;
  }

  // Иконки — lucide (обводка 2), те же, что в окне расширения. Строим через DOM: в нашем окне на странице
  // не должно быть ни одной строки разметки. Строки — атрибут d у <path>, объекты — другие фигуры.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    languages: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    copy: [{ rect: { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 } }, "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
    check: ["M20 6 9 17l-5-5"],
    checkCircle: [{ circle: { cx: 12, cy: 12, r: 10 } }, "m9 12 2 2 4-4"],
    alert: [{ circle: { cx: 12, cy: 12, r: 10 } }, "M12 8v4", "M12 16h.01"],
    pointer: ["M12.586 12.586 19 19", "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"],
    ban: [{ circle: { cx: 12, cy: 12, r: 10 } }, "m4.9 4.9 14.2 14.2"],
    chevDown: ["m6 9 6 6 6-6"],
    eyeOff: ["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242",
      "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "m2 2 20 20"],
    gear: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      { circle: { cx: 12, cy: 12, r: 3 } }],
    spin: ["M21 12a9 9 0 1 1-6.22-8.56"],
  };
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function icon(name, size) {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", width: size || 18, height: size || 18, fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    for (const part of ICONS[name]) {
      if (typeof part === "string") svg.appendChild(svgEl("path", { d: part }));
      else for (const tag in part) svg.appendChild(svgEl(tag, part[tag]));
    }
    // Крутилка «идёт перевод» — дуга потолще и вращается (как в окне расширения).
    if (name === "spin") { svg.setAttribute("stroke-width", "2.5"); svg.setAttribute("class", "spin"); }
    return svg;
  }
  // «Стоп» — залитый квадрат 12 (как в окне расширения).
  function stopIcon() {
    const svg = svgEl("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" });
    svg.appendChild(svgEl("rect", { x: 1, y: 1, width: 10, height: 10, rx: 2, fill: "currentColor" }));
    return svg;
  }
  // Значок расширения: синий квадрат, строки текста (янтарная — переведённая) и курсор.
  function logo(size, cls) {
    const svg = svgEl("svg", { class: cls || "", width: size, height: size, viewBox: "16 16 96 96", "aria-hidden": "true" });
    svg.appendChild(svgEl("rect", { x: 16, y: 16, width: 96, height: 96, rx: 22, fill: "#2563eb" }));
    for (const [y, w, c] of [[36, 62, "#ffffff"], [58, 44, "#ffcf4a"], [80, 28, "#ffffff"]]) {
      svg.appendChild(svgEl("rect", { x: 32, y, width: w, height: 13, rx: 6.5, fill: c }));
    }
    svg.appendChild(svgEl("path", { d: "M66 62 L66 101.5 L75.6 92.4 L82.4 107.2 L89.1 104.4 L82.6 89.8 L95.1 89.8Z", fill: "#ffffff",
      stroke: "#0b1f4d", "stroke-width": 6, "stroke-linejoin": "round", "paint-order": "stroke" }));
    return svg;
  }
  // Кнопка нашего окна: срабатывает только от настоящего щелчка (сайт мог бы нажать её сам).
  function uiButton(cls, attrs, kids, onClick) {
    const b = h("button", Object.assign({ type: "button", class: cls }, attrs), ...kids);
    b.addEventListener("click", (e) => { if (e.isTrusted) onClick(e); });
    return b;
  }

  // ---- карточка (под абзацем, только при наведении) ----
  // Одна за раз; закрывается ✕, Esc, щелчком мимо и заметной прокруткой. Пока идёт перевод, карточки ещё
  // нет — абзац пульсирует синим, как при замене на месте; когда перевод пришёл, абзац обводится 2 px
  // акцентом, а карточка встаёт под ним с хвостиком к нему. Обводка — inline-стилем абзаца со снимком
  // прежних значений (см. saveStyle), при закрытии возвращается то, что было.

  // Карточка едет за абзацем при прокрутке, а когда абзац сдвинулся заметно (на четверть окна, но
  // не меньше 120 px) — закрывается: человек ушёл читать дальше. Мерим сдвиг самого абзаца, поэтому
  // прокрутка текста внутри карточки её не закрывает.
  function popScrollLimit() { return Math.max(120, innerHeight / 4); }
  function repositionPopovers() {
    popPending = false;
    for (const [owner, st] of Array.from(popovers)) {
      if (!st.node) continue;               // перевод ещё идёт — карточки пока нет
      if (owner.isConnected) {
        const r = owner.getBoundingClientRect();
        if (st.anchor && (Math.abs(r.top - st.anchor.top) > popScrollLimit() || Math.abs(r.left - st.anchor.left) > popScrollLimit())) {
          removePopover(owner, st.node);
          continue;
        }
        positionPopover(st, owner);
        continue;
      }
      // Владелец отвалился (SPA перерисовала DOM) — снимаем и САМ узел карточки. Раньше здесь
      // владелец просто удалялся из коллекции: узел оставался в DOM навсегда, а все пути
      // очистки (restoreAll, sweeper, mouseout, toggle) ходят по этой же коллекции и до него
      // уже не доставали.
      removePopover(owner, st.node);
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
  // POP_GAP — от края абзаца до карточки: обводка (отступ 6 + 2) и хвостик.
  const POP_GAP = 22;
  function positionPopover(st, el) {
    const node = st.node, card = st.card;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
    const w = node.offsetWidth, hgt = node.offsetHeight;
    const below = vh - r.bottom - POP_GAP - 8, above = r.top - POP_GAP - 8;
    const up = !(hgt <= below || below >= above);
    let top = up ? r.top - POP_GAP - hgt : r.bottom + POP_GAP;
    const clamped = Math.max(8, Math.min(top, vh - hgt - 8));
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    node.style.setProperty("left", left + "px", "important");
    node.style.setProperty("top", clamped + "px", "important");
    // Хвостик смотрит на абзац; карточку пришлось прижать к краю окна и она легла на абзац — без хвостика.
    card.classList.toggle("up", up);
    card.classList.toggle("flat", Math.abs(clamped - top) > 4);
    const caret = Math.max(16, Math.min(r.left - left + 28, w - 28));
    st.caret.style.setProperty("left", Math.round(caret) + "px");
  }

  // Шрифт текста карточки — как у абзаца (семейство, начертание, размер, интервал строк), но размер — в
  // разумных пределах: заголовок в 40 px в карточке был бы громоздким.
  function cardFont(owner, box) {
    const cs = getComputedStyle(owner);
    const size = parseFloat(cs.fontSize) || 16;
    const fit = Math.max(13, Math.min(22, size));
    const lh = parseFloat(cs.lineHeight);
    box.style.setProperty("font-family", cs.fontFamily);
    box.style.setProperty("font-weight", cs.fontWeight);
    box.style.setProperty("font-style", cs.fontStyle);
    box.style.setProperty("font-size", fit + "px");
    box.style.setProperty("line-height", Number.isFinite(lh) ? Math.round(lh * fit / size) + "px" : "1.5");
  }

  // Обводка абзаца под карточкой: 2 px акцентом с отступом 6 (на тёмном фоне — светлее).
  function ringOn(owner, dark) {
    const want = [["outline", "2px solid " + (dark ? "#7aa2ff" : "#2563eb")], ["outline-offset", "6px"]];
    if (parseFloat(getComputedStyle(owner).borderTopLeftRadius) === 0) want.push(["border-radius", "4px"]);
    const saved = saveStyle(owner, want);
    for (const [name, value] of want) owner.style.setProperty(name, value, "important");
    return saved;
  }

  // Показать карточку с готовым переводом. st — запись в popovers (поставлена, пока шёл перевод).
  function showCard(owner, st, value, src) {
    const { host, root } = makeUiHost(Z_POPOVER);
    const r = owner.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    host.style.setProperty("width", Math.round(Math.max(280, Math.min(560, r.width, vw - 16))) + "px", "important");
    const dark = bgOf(owner).dark;
    const caret = h("span", { class: "caret", "aria-hidden": "true" });
    const lang = settings.showLangBadge && src && !isTargetLang(src) ? pairText(src, settings.targetLang) : "";
    const copyBtn = uiButton("c-btn", { title: HT_t("csCopy"), "aria-label": HT_t("csCopy") }, [icon("copy", 16)], () => copyText(value, copyBtn));
    const closeBtn = uiButton("c-btn", { title: HT_t("csCloseTip"), "aria-label": HT_t("cardCloseAria") }, [icon("x", 16)], () => removePopover(owner, host));
    const text = h("p", { class: "c-text" }, value);
    cardFont(owner, text);
    const card = h("div", { class: "ui tcard" + (dark ? " dk" : ""), role: "dialog", "aria-label": HT_t("cardLabel") },
      caret, h("div", { class: "c-top" }, h("span", { class: "c-lang" }, lang), copyBtn, closeBtn), text);
    root.appendChild(card);
    // Карточку намеренно можно навести и прокрутить, поэтому pointer-events её не отключает.
    // Мерцание, от которого раньше спасал pointer-events:none, закрыто проверками relatedTarget
    // здесь и в обработчике mouseout.
    host.addEventListener("mouseenter", (ev) => {
      if (ev.isTrusted && popCloseOwner === owner) popCloseCancel();   // дошли с абзаца до карточки
    });
    host.addEventListener("mouseleave", (ev) => {
      if (!ev.isTrusted) return;                          // хост лежит в DOM страницы — события сайта не слушаем
      if (settings.trigger !== "dwell") return;          // в режиме клавиши держим до повторного нажатия
      const to = ev.relatedTarget;
      if (to && (owner === to || owner.contains(to))) return;  // вернулись на сам элемент — карточку держим
      removePopover(owner, host);
    });
    mountUi(host);
    Object.assign(st, { node: host, card, caret, anchor: { top: r.top, left: r.left }, ring: ringOn(owner, dark) });
    ensurePopScroll();
    positionPopover(st, owner);
  }

  // Копировать перевод: Clipboard API (нужен защищённый адрес), иначе — выделением в своём поле.
  function copyText(value, btn) {
    const done = () => {
      btn.replaceChildren(icon("check", 16));
      btn.title = HT_t("csCopied");
      setTimeout(() => { btn.replaceChildren(icon("copy", 16)); btn.title = HT_t("csCopy"); }, 1500);
    };
    const legacy = () => {
      const root = btn.getRootNode();
      const ta = h("textarea", { "aria-hidden": "true", style: "position:fixed;left:-9999px;top:0;opacity:0" });
      ta.value = value;
      root.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      btn.focus();
      if (ok) done();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(done, legacy);
    else legacy();
  }

  function removePopover(owner, node) {
    const st = popovers.get(owner);
    const n = node || (st && st.node);
    if (n && n.parentNode) n.remove();
    // Чужой узел (устаревшая карточка того же абзаца) не снимает с учёта текущую.
    if (!node || !st || st.node === node) {
      popovers.delete(owner);
      if (st && st.ring) { restoreStyle(owner, st.ring); st.ring = null; }
    }
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

  // ---- перевод наведением: карточка (элемент целиком) ----
  async function translatePopover(owner) {
    if (!owner || !owner.isConnected || isBusy(owner)) return;
    const gen = liveGen;   // токен отмены — ДО первого await, см. пояснение в translateLine
    inFlight.add(owner);
    let st = null;
    try {
      const text = owner.textContent;
      if (await isAlreadyTarget(text)) return;
      if (gen !== liveGen || !active() || !owner.isConnected || isShown(owner)) return;
      // Одна карточка за раз: новая закрывает прежние (и те, что ещё ждут перевода).
      for (const o of Array.from(popovers.keys())) if (o !== owner) removePopover(o);
      st = { node: null };
      popovers.set(owner, st);          // маркер «занят»: mouseout, Esc и щелчок мимо снимают и ожидание
      loadingOn(owner);
      placeToast(owner);
      const out = await translateItems([text], HT_BY_PAGE);
      loadingOff(owner);
      if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== st) return;
      const res = out.results && out.results[0];
      if (res && res.ok && res.value && res.value.trim()) {
        let src = res.src || null;
        if (!src && settings.showLangBadge) src = (await detectLang(text, false)).lang || null;
        if (gen !== liveGen || !owner.isConnected || popovers.get(owner) !== st) return;
        noteSrc(src);
        showCard(owner, st, res.value, src);
      } else {
        removePopover(owner);
        if (!res) showFail(owner, out);   // нет ответа — ошибка; пустой ответ — переводить нечего
      }
    } finally {
      inFlight.delete(owner);
      loadingOff(owner);
      // Не дождались (отмена, сбой): ожидание без карточки не должно занимать абзац.
      if (st && !st.node && popovers.get(owner) === st) removePopover(owner);
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

      // Фон под абзацем — до своих классов: пульсация «идёт перевод» меняет его цвет.
      line = { owner, nodes, persistent: !!persistent, gen, hlSaved: null, bg: bgOf(owner) };
      recs = nodes.map((n) => newEntry(n, line));
      lineByOwner.set(owner, line);          // маркер «занят» — закрывает гонку и ловит mouseout во время await
      loadingOn(owner, line.bg.dark);
      placeToast(owner);                     // уведомление не должно закрывать то, что переводится

      const out = await translateItems(recs.map((r) => r.core), HT_BY_PAGE, recs.map((r) => r.line));

      // отменён (сброс/выключение) или сброшен мышью/заменён за время ожидания
      if (gen !== liveGen || !owner.isConnected || lineByOwner.get(owner) !== line) return;
      if (out.error) { showFail(owner, out); return; }
      if (!writeLine(recs, out.results, line)) return;
      // Страницу переводят целиком — переведённое клавишей остаётся и при уходе курсора.
      if (pageActive) line.persistent = true;
      lines.add(line);
      applyHLLine(line);
      for (const res of out.results) noteSrc(res && res.src);
      committed = true;
      pushState();
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
  // Текст блока целиком — по оригиналам его узлов (узел уже мог быть переведён), для определения языка.
  function lineText(line) {
    let s = "";
    for (const n of line.nodes) {
      const r = nodeRecs.get(n);
      s += r && r.line === line ? r.orig : n.nodeValue || "";
      if (s.length > 2000) break;
    }
    return s.slice(0, 2000);
  }
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
    ownText.set(e.node, full);         // своя запись: наблюдатель нового содержимого её пропустит
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
      // Отсоединённый узел тоже возвращаем: сайт мог убрать его на время (вкладки с KeepAlive во Vue, порталы, кэш
      // строк виртуального списка) и вернуть тем же узлом — тогда показался бы перевод, который уже ничем не снять.
      // Свой новый текст сайт пишет другим значением — его проверка nodeValue не тронет.
      if (revert && rec.translated != null && n.nodeValue === rec.translated) { ownText.set(n, rec.orig); n.nodeValue = rec.orig; }
      nodeRecs.delete(n);
    }
    if (lineByOwner.get(owner) === line) lineByOwner.delete(owner);
    const counted = lines.delete(line);
    clearHLLine(line);                 // и при keep-alive: иначе наш inline-style остался бы навсегда
    if (revert) clearError(owner);     // таймер и класс ошибки
    loadingOff(owner);                  // ht-translated нигде не ставится — снимать нечего
    if (counted) pushState();           // окну: «Переведено N» изменилось
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

  // Ошибка движка при наведении: красная подложка .10 и «!» 20 после текста (псевдоэлементом —
  // content.css, в DOM страницы ничего не добавляем), снимается по таймеру. Текст ошибки на элемент
  // страницы не пишем — в title его прочитал бы скрипт сайта; он только в нашем уведомлении.
  const ERROR_MS = 4000;
  function failOwner(owner) {
    clearTimeout(errors.get(owner));
    loadingOff(owner);
    owner.classList.add("ht-error");
    owner.classList.toggle("ht-error-dark", bgOf(owner).dark);
    errors.set(owner, setTimeout(() => clearError(owner), ERROR_MS));
  }

  // Пока идёт перевод — синяя подложка с пульсом 1,2 с (content.css; на тёмном фоне — светлее, при
  // prefers-reduced-motion — ровная). Появляется с задержкой 0,15 с: перевод из сохранённых приходит
  // мгновенно и мигать не должен. dark — тёмный ли фон (если уже известен).
  function loadingOn(owner, dark) {
    owner.classList.add("ht-loading");
    if (dark === undefined ? bgOf(owner).dark : dark) owner.classList.add("ht-loading-dark");
  }
  function loadingOff(owner) { owner.classList.remove("ht-loading", "ht-loading-dark"); }
  // «Стоп» и возврат оригинала: у отменённых переводов пульс снимаем сразу, а не когда придёт (и будет
  // отброшен) ответ — на медленной сети это до тайм-аута сервиса. pageOnly — только перевод страницы.
  function loadingOffCancelled(pageOnly) {
    for (const el of document.querySelectorAll(".ht-loading")) {
      const line = lineByOwner.get(el);
      if (!pageOnly || (line && line.page)) loadingOff(el);
    }
  }

  // Снять состояние ошибки. Единственная точка выхода из него: и по таймеру, и по повторному
  // наведению, и при откате строки.
  function clearError(owner) {
    owner.classList.remove("ht-error", "ht-error-dark");
    clearTimeout(errors.get(owner));
    errors.delete(owner);
  }

  // Вернуть оригинал везде. Страницу переводили целиком — окно покажет сегмент на «Оригинал» (pageWas).
  function restoreAll() {
    if (pageActive) pageWas = true;
    pageActive = false;
    pageBusy = null;
    stopPageObserver();
    liveGen++; // отменяем переводы «в полёте»
    loadingOffCancelled(false);
    for (const line of Array.from(lines)) restoreLine(line);
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
    drift = null;
    // «Страница переведена · Показать оригинал» после возврата оригинала уже ни к чему.
    if (pageToast) { pageToast.close(); pageToast = null; }
    pushState();
  }

  // «Стоп» в окне: перевод страницы останавливается, переведённое остаётся (окно покажет «Переведено N»).
  // Пачки в полёте отменяются (pageGen) и на страницу не попадают.
  function stopPage() {
    if (!pageActive) return;
    stopPageObserver();
    loadingOffCancelled(true);
    pageActive = false;
    pageBusy = null;
    pushState();
  }

  // Есть ли что возвращать: переводы, карточки, перевод страницы по прокрутке, перевод в полёте.
  function anythingShown() {
    return lines.size > 0 || popovers.size > 0 || !!pageObserver || !!mutObserver || !!document.querySelector(".ht-loading");
  }

  // Перерисовать подсветку всех переведённых строк под текущую тему.
  function restyleAll() {
    for (const line of Array.from(lines)) {
      if (!line.owner.isConnected) { restoreLine(line); continue; }   // откат: сайт может вернуть узел (см. releaseLine)
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
    if (pageActive) return retranslatePage();
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

  // Страница переведена целиком, а язык (переводчик, тон) сменили: переводим заново, и окно на это время
  // видит «Перевожу… N из M» по видимым абзацам. Видимое — маленькими пачками параллельно, затем
  // невидимое уже переведённое — в фоне, а непереведённое — по прокрутке, как при первом переводе.
  async function retranslatePage() {
    stopPageObserver();
    const gen = pageGen, lgen = liveGen;
    const vis = [], hid = [];
    for (const line of lines) {
      if (line.owner.isConnected) (inView(line.owner) ? vis : hid).push(line);
    }
    const fresh = collectCandidates();
    watchPage();                                   // что сайт добавит дальше — уже на новом языке
    const freshVis = fresh.filter(inView), freshRest = fresh.filter((el) => !freshVis.includes(el));
    const jobs = [];
    const size = firstBatch(vis.length + freshVis.length);
    for (let i = 0; i < vis.length; i += size) jobs.push({ lines: vis.slice(i, i + size) });
    for (let i = 0; i < freshVis.length; i += size) jobs.push({ owners: freshVis.slice(i, i + size) });
    pageBusy = { done: 0, total: vis.length + freshVis.length };
    pushState();
    const still = () => gen === pageGen && lgen === liveGen;
    await runParallel(jobs, async (j) => {
      if (j.lines) await retranslateLines(j.lines, lgen);
      else await translatePageChunk(j.owners, gen);
      if (still() && pageBusy) { pageBusy.done = Math.min(pageBusy.total, pageBusy.done + (j.lines || j.owners).length); pushState(); }
      return still();
    });
    if (gen !== pageGen) return;                   // остановили или запустили заново — состояние у них
    pageBusy = null;
    pushState();
    if (freshRest.length) observeRest(freshRest);
    for (let i = 0; i < hid.length && still(); i += LINE_BATCH) await retranslateLines(hid.slice(i, i + LINE_BATCH), lgen);
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
    const out = await translateItems(entries.map((e) => e.core), HT_BY_USER, entries.map((e) => e.line));
    if (out.error) { showFail(null, out); return; } // ошибка движка — прежние переводы остаются
    if (gen !== liveGen) return;
    const results = out.results;
    // Ожидаемое значение узла здесь — текущий ПЕРЕВОД (а не оригинал): меняем свой текст на новый.
    for (let i = 0; i < entries.length; i++) writeEntry(entries[i], results[i], entries[i].rec.translated);
  }

  // Периодически убираем мёртвые узлы (SPA) — против утечки памяти. С откатом: элемент, которого сейчас нет в DOM,
  // сайт может вернуть тем же узлом (KeepAlive, порталы) — пусть вернётся с оригиналом, а не с переводом без записи,
  // который уже ничем не снять.
  const sweepTimer = setInterval(() => {
    for (const line of Array.from(lines)) if (!line.owner.isConnected) restoreLine(line);
    for (const owner of Array.from(popovers.keys())) if (!owner.isConnected) removePopover(owner);
  }, 30000);

  // ---- перевод всей страницы (батчами, с учётом кэша на стороне background) ----
  const PAGE_MAX = 500;
  const OWNER_BATCH = 20; // owner-ов на один сетевой батч при прокрутке (узлы внутри дочанкуются в background)
  // Видимое при первом проходе — маленькими пачками (по 1–2 абзаца) по нескольку параллельно: окно
  // показывает «Перевожу… N из M», и счётчик должен двигаться, а не прыгать с 0 сразу на M.
  const FIRST_PARALLEL = 3;
  function firstBatch(total) { return total <= 8 ? 1 : 2; }

  // Кандидаты на перевод страницы. Уже переведённые owner-ы бюджет PAGE_MAX НЕ занимают: раньше
  // лимит применялся до фильтрации, поэтому повторный запуск снова упирался в те же первые 500
  // элементов (переведённый owner всё ещё проходит isTopInlineContainer и isTextTarget), фильтр
  // выбрасывал их все, и хвост длинной страницы не переводился никогда — сколько ни жми кнопку.
  //
  // Владельцы бывают вложенными: в <li><a><div>(Top)</div></a></li> (оглавление Википедии) верхним строчным
  // контейнером считается и li (его ребёнок <a> строчный), и div (у его родителя <a> блочный ребёнок). Берём
  // внешний — его строка переводит и узлы внутреннего. Раньше брали оба: две строки на одних узлах, и после
  // «Показать оригинал» часть текста оставалась переведённой. Обход идёт в порядке документа, поэтому потомки
  // взятого (или уже переведённого) владельца идут сразу за ним.
  function collectCandidates() {
    const all = document.body ? document.body.querySelectorAll("*") : [];
    const out = [];
    const memo = new Map();   // живёт только этот обход: структура DOM за него не меняется
    let taken = null;         // последний взятый или уже переведённый владелец
    for (const el of all) {
      if (taken && taken.contains(el)) continue;     // вложенный: его узлы переводит строка внешнего
      if (!isTopInlineContainer(el, memo)) continue; // дешёвая структурная проверка раньше textContent
      const line = lineByOwner.get(el);
      if (line) {
        if (inFlight.has(el) || lineAlive(line)) { taken = el; continue; } // в работе или действительно переведён
        restoreLine(line);                                 // каркас перетёр перевод — чистим и переводим заново
      }
      if (!isTextTarget(el)) continue;
      out.push(el);
      taken = el;
      if (out.length >= PAGE_MAX) break;
    }
    return out;
  }

  // Виден ли элемент в окне сейчас (хотя бы частично).
  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function stopPageObserver() {
    pageGen++; // отменяем всё, что в полёте по переводу страницы
    if (pageObserver) { pageObserver.disconnect(); pageObserver = null; }
    pendingObserved.clear();
    pageWait.clear();
    clearTimeout(flushTimer);
    unwatchPage();
  }

  // Вошедшее в зону видимости: без перевода — переводим, с переводом, в который сайт дописал текст, — доводим.
  // Сбой, общий для всех (сеть, ключ, лимит), выключает слежение за новым: иначе болтливый сайт с каждой
  // пачкой показывал бы ту же ошибку. Новое подберёт повторное «Перевести страницу».
  function flushObserved() {
    const fresh = [], more = [];
    for (const el of pendingObserved) (lineByOwner.has(el) ? more : fresh).push(el);
    pendingObserved.clear();
    const gen = pageGen;
    const stopOnFail = (r) => { if (r && r.stop && gen === pageGen) unwatchPage(); };
    if (fresh.length) translatePageOwners(fresh, gen).then(stopOnFail);
    if (more.length) topUpOwners(more, gen).then(stopOnFail);
  }

  // Остальное — по мере появления в зоне видимости (с запасом 300 px).
  // later — видимое, что не перевелось из-за сбоя или не дошло до очереди: его пробуем снова, когда его
  // прокрутят с экрана и обратно (или по новому «Перевести страницу»), а не сразу — сразу та же пачка
  // упала бы так же. Первое сообщение observer-а о таком элементе («виден») пропускаем.
  function observeRest(rest, later) {
    for (const el of later || []) pageWait.add(el);
    const io = pageIO();
    for (const el of rest.concat(later || [])) io.observe(el);
  }
  // Один observer на прогон перевода страницы: его наполняют и первый проход (observeRest), и новое содержимое.
  function pageIO() {
    if (!pageObserver) pageObserver = new IntersectionObserver(onPageIO, { rootMargin: "300px" });
    return pageObserver;
  }
  function onPageIO(entries, observer) {
    for (const e of entries) {
      if (pageWait.delete(e.target) && e.isIntersecting) continue;
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      if (!lineByOwner.has(e.target) || mutTopUp.has(e.target)) pendingObserved.add(e.target);
    }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushObserved, 150);
  }

  // ---- новое содержимое при переведённой странице ----
  // Пока страница переведена целиком (pageActive), то, что сайт добавит или перепишет (ленты, комментарии,
  // подгрузка, переходы SPA), переводится само. Изменившиеся места собираем пачкой раз в MUT_MS и сводим к
  // верхним строчным контейнерам — тем же владельцам, что у перевода страницы. Владелец без перевода (или с
  // мёртвым: каркас перетёр) переводится заново, а в живом переводе — только узлы, которые сайт добавил или
  // переписал. Переводится видимое: всё идёт через pageObserver, вне экрана — при прокрутке, как остальное.
  // Свои записи пропускаем по ownText. Элемент, который меняется снова и снова (часы, счётчики, «5 минут
  // назад»), переводим заново не больше MUT_TRIES раз подряд; затишье MUT_CALM начинает счёт заново.
  // Esc, «Показать оригинал», «Стоп», смена языка — stopPageObserver снимает наблюдатель (а перевод на новый
  // язык ставит его снова). Наблюдаем <html>, а не <body>: SPA, заменивший <body> (Turbo), тоже виден.
  const MUT_MS = 300;
  const MUT_TRIES = 5;
  const MUT_CALM = 10000;
  // Сюда изменения не ведут: служебные элементы и <head>.
  const MUT_SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME"]);
  const hasLetter = (s) => /\p{L}/u.test(s || "");

  function watchPage() {
    if (mutObserver || dead || !pageActive) return;
    mutTries = new WeakMap();
    mutTopUp = new WeakSet();
    keepOrig = new WeakSet();
    mutObserver = new MutationObserver(onMutations);
    mutObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  }
  function unwatchPage() {
    if (mutObserver) { mutObserver.disconnect(); mutObserver = null; }
    mutStarts.clear();
    clearTimeout(mutTimer);
    mutTimer = 0;
  }

  // Записи наблюдателя — только запомнить место: разбор раз в MUT_MS (flushMut). Пачка, а не «после
  // затишья»: на сайте, который меняет что-то постоянно, затишья может не быть вовсе.
  function onMutations(records) {
    for (const m of records) {
      if (m.type === "characterData") {
        const n = m.target;
        if (n.nodeType !== 3 || n.nodeValue === ownText.get(n) || !hasLetter(n.nodeValue)) continue;
        const p = n.parentElement;
        if (p && !MUT_SKIP.has(p.tagName)) mutStarts.add(p);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) {
          if (hasLetter(n.nodeValue) && m.target.nodeType === 1 && !MUT_SKIP.has(m.target.tagName)) mutStarts.add(m.target);
        } else if (n.nodeType === 1 && !MUT_SKIP.has(n.tagName) && !isOurUi(n)) mutStarts.add(n);
      }
    }
    if (mutStarts.size && !mutTimer) mutTimer = setTimeout(flushMut, MUT_MS);
  }

  // Владельцы для изменившегося места: верхний строчный контейнер вокруг него (как pickTarget), а в
  // добавленном блоке — верхние строчные контейнеры внутри (как collectCandidates).
  function ownersOf(start, out, memo) {
    const body = document.body;
    if (!body || !body.contains(start) || isOurUi(start)) return;
    if (start !== body && !hasBlockChild(start, memo)) {
      let el = start;
      while (el.parentElement && el.parentElement !== body && !hasBlockChild(el.parentElement, memo)) el = el.parentElement;
      out.add(el);
      return;
    }
    let taken = null;
    for (const el of start.querySelectorAll("*")) {
      if (taken && taken.contains(el)) continue;
      if (!isTopInlineContainer(el, memo)) continue;
      if (!lineByOwner.has(el) && !isTextTarget(el)) continue;
      out.add(el);
      taken = el;
    }
  }

  // Текстовые узлы владельца с живым переводом, которых в этом переводе нет: сайт их добавил или переписал.
  // Узел, который не перевёлся (пустой ответ) и так и стоит в оригинале, не берём — иначе повторяли бы его.
  function siteNodes(owner, line) {
    const out = [];
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => acceptTextNode(node, owner) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const rec = nodeRecs.get(n);
      if (rec && rec.line === line) {
        if (n.nodeValue === (rec.translated != null ? rec.translated : rec.orig)) continue;
      } else if (heldByLine(n)) continue;           // узел вложенного перевода — его ведёт своя строка
      out.push(n);
    }
    return out;
  }

  function flushMut() {
    mutTimer = 0;
    if (!mutObserver) return;
    if (!pageActive) { unwatchPage(); return; }
    const memo = new Map(), found = new Set();
    const starts = Array.from(mutStarts);
    mutStarts.clear();
    for (const s of starts) if (s.isConnected) ownersOf(s, found, memo);
    // Вложенные владельцы сводим к внешнему — к тому, что уже переведён или тоже в этой пачке (как collectCandidates).
    const body = document.body, owners = new Set();
    for (const el of found) {
      let o = el;
      for (let a = el.parentElement; a && a !== body; a = a.parentElement) if (found.has(a) || lineByOwner.has(a)) o = a;
      owners.add(o);
    }
    const now = Date.now();
    for (const o of owners) {
      if (keepOrig.has(o)) continue;
      if (inFlight.has(o)) { mutStarts.add(o); continue; }   // перевод в пути — посмотрим, когда вернётся
      let line = lineByOwner.get(o);
      if (line && !lineAlive(line)) { restoreLine(line); line = null; }   // каркас перетёр перевод целиком
      if (line ? !siteNodes(o, line).length : !isTextTarget(o)) continue;
      const t = mutTries.get(o) || { n: 0, at: 0 };
      if (now - t.at > MUT_CALM) t.n = 0;
      t.at = now;
      mutTries.set(o, t);
      if (t.n >= MUT_TRIES) continue;
      t.n++;
      if (line) mutTopUp.add(o);
      pageIO().observe(o);       // виден — переведётся сразу (onPageIO), нет — при прокрутке
    }
    if (mutStarts.size) mutTimer = setTimeout(flushMut, MUT_MS);
  }

  // Довести живые переводы: перевести только узлы, которые сайт добавил или переписал, — остальной перевод
  // не мигает оригиналом и не оплачивается заново. Возвращает { stop } — сбой, общий для всех (pageWide).
  async function topUpOwners(owners, gen) {
    const lgen = liveGen, jobs = [], gone = [];
    for (const o of owners) {
      mutTopUp.delete(o);
      const line = lineByOwner.get(o);
      if (!line || !o.isConnected || inFlight.has(o)) continue;
      if (!lineAlive(line)) { restoreLine(line); gone.push(o); continue; }
      const nodes = siteNodes(o, line);
      if (!nodes.length) continue;
      inFlight.add(o);
      jobs.push({ o, line, nodes });
    }
    const res = { stop: false };
    if (gone.length) translatePageOwners(gone, gen);
    if (!jobs.length) return res;
    try {
      const skip = await Promise.all(jobs.map((j) => isAlreadyTarget(j.nodes.map((n) => n.nodeValue).join(" "))));
      if (gen !== pageGen || lgen !== liveGen) return res;
      const entries = [];
      jobs.forEach((j, k) => {
        if (skip[k] || lineByOwner.get(j.o) !== j.line) return;
        for (const n of j.nodes) {
          if (!j.line.nodes.includes(n)) j.line.nodes.push(n);   // откат строки вернёт и его
          entries.push(newEntry(n, j.line));
        }
      });
      if (!entries.length) return res;
      const out = await translateItems(entries.map((e) => e.core), HT_BY_USER, entries.map((e) => e.line));
      if (gen !== pageGen || lgen !== liveGen) return res;
      if (out.error || !out.results) {
        if (out.error) { showFail(null, out, true); res.stop = pageWide(out); }
        return res;
      }
      let wrote = false;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (lineByOwner.get(e.line.owner) !== e.line) continue;
        if (writeEntry(e, out.results[i], e.rec.orig)) { wrote = true; noteSrc(out.results[i].src); }
      }
      if (wrote) pushState();
    } catch (e) {
      // как при сбое сервиса: прежний перевод на месте, новые узлы остаются в оригинале
    } finally {
      for (const j of jobs) inFlight.delete(j.o);
    }
    return res;
  }

  // Выполнить задания по FIRST_PARALLEL одновременно; run(job) → продолжать ли (false — остановиться).
  async function runParallel(jobs, run) {
    let next = 0, go = true;
    const worker = async () => {
      while (go && next < jobs.length) {
        const job = jobs[next++];
        if (!(await run(job))) go = false;
      }
    };
    await Promise.all(Array.from({ length: Math.min(FIRST_PARALLEL, jobs.length) }, worker));
  }

  // «Страница переведена» с парой языков, «Показать оригинал» и подсказкой «или Esc».
  function showPageDone() {
    const tgt = settings.targetLang;
    // Язык оригинала — по ответам переводчика; сохранённые переводы приходят без него — тогда по атрибуту
    // lang страницы (так же делает окно), а если и его нет — «На русский».
    const lang = HT_langKey(document.documentElement.lang || "");
    const src = pageSrc || (/^[a-z]{2,3}$/.test(lang) && !isTargetLang(lang) ? lang : "");
    const text = src ? pairText(src, tgt) : HT_t("intoLang", HT_langLabel(HT_langBase(tgt)));
    if (pageToast) pageToast.close();
    pageToast = notice(text, 3000, {
      title: HT_t("csPageDone"), icon: "ok", esc: true,
      actions: [{ label: HT_t("csShowOrig"), run: () => restoreAll() }],
    });
  }

  // via — откуда просьба: "popup" (кнопка окна или меню плавающей кнопки) или "command" (горячая клавиша; keys —
  // её сочетание для подсказки). Окно расширения само говорит, что перевод выключен, а горячая
  // клавиша — только здесь.
  // На выключенном сайте не переводим и по явной просьбе: сайты выключают ради приватности (почта,
  // банк), и привычное сочетание клавиш не должно отправить такую страницу в DeepL. Включить сайт —
  // один щелчок в окне расширения.
  // Ход работы — окну (pageState): «busy» с числом готовых видимых абзацев, затем «done». Уведомления
  // «Перевожу…» нет; когда видимое готово — «Страница переведена», остальное — при прокрутке.
  async function translatePage(via, keys) {
    if (!settings.enabled) {
      if (via === "command") notice(keys ? HT_t("csOffPageKeys", keys) : HT_t("csOffWindow"), 5000, { title: HT_t("csOffTitle") });
      return;
    }
    if (siteOff) {
      notice(HT_t("csSiteOffText", SITE || location.hostname), 7000, { title: HT_t("csSiteOffTitle") });
      return;
    }
    if (blocked(true)) return;
    // Горячая клавиша на переведённой странице — переключатель: возвращает оригинал, как и ожидают от
    // повторного нажатия. Окно и меню плавающей кнопки показывают оригинал своими кнопками.
    if (pageActive && via === "command") {
      restoreAll();
      notice(HT_t("csOrigShown"), 3000);
      return;
    }
    if (pageBusy) return;          // видимое уже переводится — второе нажатие ничего не добавляет
    const wasActive = pageActive;
    stopPageObserver();          // сбрасывает прошлый прогон и инкрементит pageGen
    const gen = pageGen;
    const fresh = collectCandidates();
    if (!fresh.length) {
      // Всё уже переведено — целиком или наведением: страница считается переведённой.
      if (wasActive || lines.size) {
        const was = wasActive;
        for (const l of lines) l.persistent = true;
        pageActive = true; pageWas = false;
        watchPage();
        pushState();
        if (!was) showPageDone();
        return;
      }
      // Молчать нельзя: раньше при пустом списке не было ни уведомления, ни observer-а, и человек
      // жал кнопку снова и снова. Это не успех и не ошибка — поэтому нейтрально, без значка.
      notice(HT_t("csNothingText"), 5000, { title: HT_t("csNothingTitle") });
      return;
    }

    const visible = fresh.filter(inView);
    const rest = fresh.filter((el) => !visible.includes(el));
    // Переведённое наведением остаётся, пока страница переведена (уход курсора его не откатывает).
    for (const l of lines) l.persistent = true;
    pageActive = true;
    pageWas = false;
    watchPage();                 // что сайт добавит с этой минуты, переводится само
    pageBusy = { done: 0, total: visible.length };
    if (pageToast) { pageToast.close(); pageToast = null; }
    pushState();

    const sum = { wrote: 0, failed: false };
    const jobs = [];
    const size = firstBatch(visible.length);
    for (let i = 0; i < visible.length; i += size) jobs.push(visible.slice(i, i + size));
    const left = new Set(jobs);    // пачки, до которых очередь не дошла
    const missed = [];             // видимое, что не перевелось: доберём при прокрутке или повторе
    await runParallel(jobs, async (chunk) => {
      left.delete(chunk);
      const r = await translatePageChunk(chunk, gen);
      sum.wrote += r.wrote;
      if (r.failed) { sum.failed = true; missed.push(...chunk); }
      if (gen === pageGen && pageBusy) { pageBusy.done = Math.min(pageBusy.total, pageBusy.done + chunk.length); pushState(); }
      // Сбой одной пачки («не определил язык», «нужна модель пары») остальным не мешает; общий для всех (сеть,
      // ключ, лимит) — дальше не шлём.
      return gen === pageGen && !r.stop;
    });
    if (gen !== pageGen) return;   // «Стоп», Esc, новый запуск или смена языка — состояние ведут они
    for (const chunk of left) missed.push(...chunk);

    pageBusy = null;
    if (sum.failed && !sum.wrote) {
      // Ошибку (или «Щёлкните по тексту») уже показали; страница не переведена.
      pageActive = false;
      stopPageObserver();
      pushState();
      return;
    }
    if (rest.length || missed.length) observeRest(rest, missed);
    if (sum.wrote || wasActive) {
      // Что-то не перевелось — «Страница переведена» было бы неправдой: остаётся уведомление о сбое (или
      // «Щёлкните по тексту») от этой пачки.
      if (sum.wrote && !sum.failed) showPageDone();
    } else if (rest.length) {
      // Видимая часть уже на нужном языке (или на экране нет текста); остальное — при прокрутке.
      notice(HT_t(visible.length ? "csVisibleInLang" : "csScrollToTranslate"), 6000);
    } else {
      // Ничего не заменено — «Страница переведена» было бы неправдой.
      pageActive = false;
      unwatchPage();
      notice(HT_t("csAlreadyText"), 5000, { title: HT_t("csNothingTitle") });
    }
    pushState();
  }

  // Сбой, общий для всех пачек: следующая упала бы так же — нет ключа или согласия, ключ отклонён, лимит,
  // деньги, частые запросы, сервис или сеть недоступны, модель ИИ, переводчик не знает выбранный язык.
  // Прочее — беда одной пачки: язык не определился, нужна модель этой пары, сервис не принял именно этот текст.
  const PAGE_WIDE = new Set(["no-key", "no-consent", "bad-key", "quota", "money", "rate", "server", "network",
    "timeout", "model", "denied", "limit", "lang"]);
  function pageWide(out) {
    return PAGE_WIDE.has(out.code) && !(out.code === "lang" && out.focus === "source-lang");
  }

  // Возвращает { wrote: сколько элементов переведено, failed: была ли ошибка, stop: сбой общий для всех }.
  async function translatePageOwners(owners, gen) {
    const sum = { wrote: 0, failed: false, stop: false };
    for (let i = 0; i < owners.length; i += OWNER_BATCH) {
      if (gen !== pageGen) return sum;
      const r = await translatePageChunk(owners.slice(i, i + OWNER_BATCH), gen);
      sum.wrote += r.wrote;
      if (r.failed) sum.failed = true;
      if (r.stop) sum.stop = true;
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
      // page — переведено вместе со страницей: без подсветки (applyHLLine).
      const line = { owner, nodes, persistent: true, page: true, gen: lgen, hlSaved: null };
      lineByOwner.set(owner, line);
      lineObjs.push(line);
      for (const n of nodes) entries.push(newEntry(n, line));
    }
    if (!lineObjs.length) return none;

    let out;
    try {
      out = await translateItems(entries.map((e) => e.core), HT_BY_USER, entries.map((e) => e.line));
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
      if (out.error && !cancelled) { showFail(null, out, true); return { wrote: 0, failed: true, stop: pageWide(out) }; }
      return none;
    }

    const wrote = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.line.gen !== liveGen || lineByOwner.get(e.line.owner) !== e.line) continue;
      if (writeEntry(e, results[i], e.rec.orig)) { wrote.add(e.line); noteSrc(results[i].src); }
    }

    for (const line of lineObjs) {
      inFlight.delete(line.owner);
      if (wrote.has(line)) { lines.add(line); applyHLLine(line); }
      else dropLine(line);           // ничего не записали — снять маркеры
    }
    if (wrote.size) pushState();
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
    lastOverTarget = e.target;            // и при выключенном переводе: см. keydown
    hoverLost = false;
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
  let hoverLost = false;              // элемент под курсором сброшен потерей фокуса окна
  on(document, "mousemove", (e) => {
    if (!e.isTrusted || !pointerMoved(e)) return;
    lastXY = { x: e.clientX, y: e.clientY };
    // Окно теряло фокус (открыли окно расширения, Alt+Tab): «элемент под курсором» тогда сброшен, а
    // mouseover после возврата не приходит, если курсор остался на том же элементе. Без этого клавиша
    // и щелчок по абзацу (повтор для загрузки переводчика) после закрытия окна расширения не работали.
    if (hoverLost) {
      hoverLost = false;
      lastOverTarget = e.target;
      if (active() && !dead) { const t = pickTarget(e.target); hoverEl = t && isTextTarget(t) ? t : null; }
    }
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
    if (!e.relatedTarget) { hoverEl = null; lastOverTarget = null; }
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
    // Перевод только что включили (Alt+Shift+O, галочка сайта), а курсор с тех пор не двигался: пока
    // перевод был выключен, mouseover элемент не запоминал — берём его из последнего наведения.
    if (lastOverTarget && (!hoverEl || !hoverEl.contains(lastOverTarget))) {
      const t = lastOverTarget.isConnected ? pickTarget(lastOverTarget) : null;
      hoverEl = t && isTextTarget(t) ? t : null;
    }
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

  // У сайта сейчас что-то открыто: модальное окно (<dialog> через showModal), поповер, видимое окно с role=dialog
  // или aria-modal, раскрытое всплывающее меню или список (см. popupOpen). Наши хосты [data-ht-ui] не в счёт: меню
  // кружка, карточка и уведомления живут в закрытом shadow root, их Esc разбирает escRestore.
  // Селекторы, которых этот Chrome не знает, отбрасываем: одна ошибка в списке сломала бы весь querySelectorAll.
  const SITE_OPEN = [":modal", ":popover-open", "[role=dialog]", "[role=alertdialog]", "[aria-modal=true]"]
    .filter((s) => { try { return CSS.supports("selector(" + s + ")"); } catch (e) { return false; } }).join(",");
  // Что у сайта открыто сейчас (элементы); пусто — ничего.
  function siteOpenEls() {
    const out = [];
    if (SITE_OPEN) for (const el of document.querySelectorAll(SITE_OPEN)) if (!isOurUi(el) && onScreen(el)) out.push(el);
    for (const el of document.querySelectorAll('[aria-expanded="true"]')) if (!isOurUi(el) && onScreen(el) && popupOpen(el)) out.push(el);
    return out;
  }
  // Открытое так и осталось открытым: на месте, видно, у кнопки по-прежнему aria-expanded=true.
  function stillOpen(el) {
    return el.isConnected && onScreen(el) && (!el.hasAttribute("aria-expanded") || el.getAttribute("aria-expanded") === "true");
  }
  // aria-expanded=true — это и раскрытое меню, и раскрытый раздел оглавления или аккордеон (на сайтах документации
  // они раскрыты всегда). Открытым считаем только всплывающее: у кнопки aria-haspopup, или то, чем она управляет
  // (aria-controls, иначе соседний элемент), — меню, список или окно, либо лежит поверх страницы (absolute, fixed).
  function popupOpen(el) {
    const hp = el.getAttribute("aria-haspopup");
    if (hp && hp !== "false") return true;
    const ids = (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
    // Без ссылки — соседний элемент, но только с текстом: значок в поле ввода (лупа, absolute) меню не делает.
    const sib = el.nextElementSibling;
    const targets = ids.length ? ids.map((id) => document.getElementById(id)) : (sib && /\p{L}/u.test(sib.textContent) ? [sib] : []);
    for (const t of targets) {
      if (!t || isOurUi(t) || !onScreen(t)) continue;
      if (/^(menu|menubar|listbox|dialog)$/.test(t.getAttribute("role") || "")) return true;
      const pos = getComputedStyle(t).position;
      if (pos === "absolute" || pos === "fixed") return true;
    }
    return false;
  }
  // Элемент виден: не спрятан (display, visibility, прозрачность) и хоть краем в окне. Окна и меню, которые сайт
  // держит в разметке скрытыми или унёс за край экрана, открытыми не считаем.
  function onScreen(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }

  // Esc возвращает оригинал везде на странице и закрывает карточку — если есть что возвращать.
  // preventDefault не зовём: Esc нужен и самому сайту (закрыть окно, меню). Фокус в поле ввода —
  // Esc для поля (закрыть подсказки поиска), переводы не трогаем. Встроенные окна вкладки (у
  // каждого свой скрипт и свои переводы) откатывает background по нашей просьбе.
  function escRestore() {
    // Открыт список языка в меню кружка — Esc закрывает только его (это делает сам Chrome).
    if (pickerOpen()) return;
    // Открыто меню кружка — Esc закрывает только его; фокус был в меню — возвращается на кружок (меню, открытое
    // наведением, фокус со страницы не забирает).
    if (menuOpen()) { closeMenu(focusInFab()); return; }
    if (typingFocus()) return;
    // Esc закрывает и уведомление расширения на странице (раньше оно висело до таймера или ✕).
    if (currentToast) currentToast.close();
    // У сайта открыто окно или меню — Esc закрывает его (это делает сайт), перевод остаётся. Наша карточка
    // закрывается, как и раньше: её абзац мог быть в этом окне. Сайт Esc не услышал и открытое не закрыл
    // (подсказки поиска Википедии без фокуса в поле) — через 250 мс Esc наш: возвращаем оригинал.
    const open = siteOpenEls();
    if (!open.length) { escBack(); return; }
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
    setTimeout(() => { if (!dead && open.every(stillOpen)) escBack(); }, 250);
  }
  function escBack() {
    if (!anythingShown()) return;
    restoreAll();
    if (!TOP || document.querySelector("iframe, frame")) send({ type: "restoreTab" }).catch(() => {});
  }

  on(window, "mousedown", (e) => { if (e.isTrusted) modPress = null; }, true);

  // Щелчок мимо карточки закрывает её, мимо плавающей кнопки — её меню. Щелчок внутри приходит с хостом в
  // target (закрытый shadow root наружу показывает только хост).
  on(window, "pointerdown", (e) => {
    if (!e.isTrusted) return;
    if (menuOpen() && e.target !== fab.host) closeMenu(false);
    if (!popovers.size) return;
    for (const st of popovers.values()) if (st.node === e.target) return;
    for (const owner of Array.from(popovers.keys())) removePopover(owner);
  }, true);

  // Модель встроенного переводчика ждёт загрузки (см. showFail): у щелчка есть «действие
  // пользователя», которого Chrome требует для загрузки, поэтому сразу повторяем перевод элемента
  // под курсором — щелчок по самому абзацу и начинает загрузку.
  on(window, "click", (e) => {
    if (!e.isTrusted || !retryOnClick || !active() || !alive()) return;
    // Щелчок по плавающей кнопке открывает меню и ничего не переводит («Перевести страницу» в меню
    // переводит сама — у её щелчка то же действие пользователя).
    if (fab && e.target === fab.host) return;
    retryOnClick = false;
    if (needClick) { needClick = false; syncFab(); }
    // Просили перевести страницу (кнопка, Alt+Shift+G) — после щелчка переводим страницу, а не только абзац.
    if (retryPage) { retryPage = false; translatePage("popup"); return; }
    if (hoverEl && hoverEl.isConnected && !isBusy(hoverEl)) startHover(hoverEl);
  }, true);

  // Окно потеряло фокус (Alt+Tab, клик в адресную строку): отпускание клавиши придёт уже не нам,
  // а элемент под курсором неизвестен до следующего движения мыши.
  on(window, "blur", () => {
    hoverEl = null; lastOverTarget = null; modPress = null; clearTimeout(dwellTimer); dwellFor = null;
    hoverLost = true;                    // вернуть при первом движении мыши (см. mousemove)
    if (menuOpen()) closeMenu(false);
  });

  // ---- состояние страницы для окна расширения ----
  // page: "idle" — ничего не переведено; "busy" — идёт перевод видимой части (done из total видимых
  // абзацев первого прохода); "done" — видимое переведено, остальное переводится при прокрутке; "orig" —
  // страницу переводили целиком и вернули оригинал (окно ставит сегмент на «Оригинал»); "part" —
  // переведено count абзацев наведением или клавишей (или перевод страницы остановили «Стопом»).
  // src — язык оригинала по ответам переводчика ("" — неизвестен); lang — атрибут lang страницы:
  // окно готовит встроенному переводчику именно эту пару.
  function pageNow() {
    if (pageActive) return pageBusy ? "busy" : "done";
    if (shownCount()) return "part";
    return pageWas ? "orig" : "idle";
  }
  function tabState() {
    return {
      ok: true, hud: !!fab, site: SITE, siteOff, lang: String(document.documentElement.lang || "").slice(0, 20),
      page: pageNow(), done: pageBusy ? pageBusy.done : 0, total: pageBusy ? pageBusy.total : 0, count: shownCount(), src: pageSrc,
    };
  }
  // Окно открыто и ждёт: верхний фрейм сам сообщает каждое изменение (несколько подряд — одним
  // сообщением, одинаковое — не повторяет). Плавающая кнопка и её меню — тоже по этому состоянию (hud — кружок
  // сейчас на странице).
  function pushState() {
    syncFab();
    if (!TOP || OWN_PAGE || dead || stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = 0;
      if (dead) return;
      themeFab();                       // сайт мог сменить тему (свои цвета кружка — по фону сайта)
      const st = tabState();
      const json = JSON.stringify(st);
      if (json === stateSent) return;
      stateSent = json;
      send({ type: "pageState", state: st }).catch(() => {});
    }, 30);
  }
  // Язык оригинала страницы — самый частый среди ответов переводчика (на целевом языке не считаем).
  function noteSrc(src) {
    const k = HT_langKey(src || "");
    if (!/^[a-z]{2,3}$/.test(k) || isTargetLang(k)) return;
    srcCount.set(k, (srcCount.get(k) || 0) + 1);
    let best = "", n = 0;
    for (const [code, m] of srcCount) if (m > n) { best = code; n = m; }
    if (best !== pageSrc) { pageSrc = best; pushState(); }
  }

  // Команды из окна и от горячих клавиш (через background). Обязательно отвечаем (sendResponse),
  // иначе на стороне окна взводится lastError «порт закрыт» и страница ошибочно считается
  // недоступной. Ответ на getHudState, toggleHud и stopPage — состояние вкладки (tabState).
  // translatePage отвечает сразу: окно не закрывается, ход перевода приходит сообщениями pageState.
  // На своей странице расширения (приветствие) не слушаем: туда долетают все runtime.sendMessage
  // окна настроек, и наш ответ «true» мог бы опередить ответ background.
  if (!OWN_PAGE) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "restoreAll") { restoreAll(); sendResponse(true); }
      else if (msg.type === "translatePage") { translatePage(msg.via, typeof msg.keys === "string" ? msg.keys : ""); sendResponse(true); }
      else if (msg.type === "stopPage") { stopPage(); sendResponse(tabState()); }
      else if (msg.type === "toggleHud") { toggleHud(); sendResponse(tabState()); }
      else if (msg.type === "getHudState") { sendResponse(tabState()); }
      else if (msg.type === "say") { say(msg); sendResponse(true); }
      else sendResponse(true); // подтверждаем получение
    });
  }

  // Горячая клавиша вкл/выкл: значок покажет «off», но смотрят в этот момент на страницу.
  function say(msg) {
    const keys = typeof msg.keys === "string" && msg.keys ? msg.keys : "";
    if (msg.what === "enabled") notice("", 2500, { title: HT_t("csOnTitle"), icon: "ok" });
    else if (msg.what === "disabled") notice(keys ? HT_t("csOffKeys", keys) : "", 3500, { title: HT_t("csOffTitle") });
  }

  // ---- плавающая кнопка: кружок 44 у края окна и меню 320 вбок от него ----
  // Кружок показывает, что со страницей: переведена — залит акцентом; идёт перевод —
  // кольцо с долей готового и подпись «Перевожу… N из M» со стороны середины экрана; янтарная точка — ждём щелчка
  // по тексту; красная — перевод не работает (что делать, говорит уведомление). Наведение 200 мс раскрывает меню,
  // уход с кружка и меню закрывает его через 400 мс; щелчок открывает и закрепляет (до щелчка мимо, Esc, выбора
  // пункта или повторного щелчка). Страницу щелчок по кружку не переводит. В меню — язык перевода, главное действие
  // страницы теми же словами, что в окне расширения, и редкое: выключить на сайте, скрыть кнопку, настройки.
  // Кружок тащат за него самого: сдвиг больше 4 px — перетаскивание; отпустили — за 200 мс прилипает к ближайшему
  // краю (16 px), по высоте где отпустили. Место одно на все сайты (hudPos), пишется один раз — при отпускании:
  // каждая запись будит скрипты во всех вкладках.
  const FAB = 44, FAB_EDGE = 16, FAB_GAP = 8;            // кружок, отступ от края окна, зазор до меню
  const FAB_OPEN_MS = 200, FAB_CLOSE_MS = 400, FAB_SNAP_MS = 200, FAB_DRAG_PX = 4;
  const RING_C = 2 * Math.PI * 25;                      // длина кольца r 25 (в квадрате 54)

  function buildFab() {
    const { host, root } = makeUiHost(Z_HUD);
    // open: "" — меню закрыто, "hover" — открыто наведением, "pin" — закреплено щелчком или клавиатурой.
    // press — нажали на кружок (может стать перетаскиванием), drag — тащат; noClick — щелчок после
    // перетаскивания не считается; actKey — что сейчас нарисовано в месте действия.
    const f = { host, root, open: "", press: null, drag: null, noClick: false, actKey: "", timers: { open: 0, close: 0, snap: 0 } };
    f.btn = h("button", { type: "button", class: "fab", "aria-label": HT_t("csFabAria", extName()), "aria-haspopup": "dialog",
      "aria-expanded": "false", "aria-controls": "fm" }, icon("languages", 20));
    f.ring = svgEl("svg", { class: "fab-ring", width: 54, height: 54, viewBox: "0 0 54 54", "aria-hidden": "true" });
    f.ring.appendChild(svgEl("circle", { class: "tr", cx: 27, cy: 27, r: 25, fill: "none", "stroke-width": 3 }));
    f.bar = svgEl("circle", { class: "bar", cx: 27, cy: 27, r: 25, fill: "none", "stroke-width": 3, "stroke-linecap": "round",
      "stroke-dasharray": "0 " + RING_C.toFixed(1) });
    f.ring.appendChild(f.bar);
    f.pill = h("span", { class: "fab-pill", "aria-hidden": "true" });
    f.dot = h("span", { class: "fab-dot", "aria-hidden": "true" });
    f.w = h("div", { class: "fab-w" }, f.btn);           // подпись, кольцо и точка — только пока они нужны

    // Список языка: запись действует на всех сайтах — пишем только настоящий выбор и только значение из таблицы.
    f.sel = h("select", { id: "fm-lang" });
    for (const [code, label] of LANGS) {
      const o = h("option", {}, label);
      o.value = code;
      f.sel.appendChild(o);
    }
    // Поле настраиваемого списка (Chrome 135+) показывает выбранное через <button><selectedcontent>: длинное название
    // обрезается многоточием перед стрелкой. Без поддержки кнопка внутри select не рисуется.
    f.sel.prepend(h("button", { type: "button" }, document.createElement("selectedcontent")));
    f.sel.value = settings.targetLang;
    f.sel.addEventListener("change", (e) => {
      if (!e.isTrusted || HT_valid("targetLang", f.sel.value) !== f.sel.value) return;
      chrome.storage.local.set({ targetLang: f.sel.value }).catch(() => {});
    });
    f.act = h("div", { class: "fm-act" });
    const item = (act, ic, label, run) => uiButton("fm-item", { role: "menuitem", "data-act": act, title: act === "site-off" ? label : null },
      [icon(ic, 16), h("span", {}, label)], () => { closeMenu(false); run(); });
    f.items = h("div", { role: "menu" });
    if (SITE) f.items.appendChild(item("site-off", "ban", HT_t("csFabSiteOff", SITE), disableSiteFromFab));
    f.items.appendChild(item("hide", "eyeOff", HT_t("csFabHide"), hideFab));
    f.items.appendChild(item("settings", "gear", HT_t("ppSettings"), () => openSettings("page")));
    f.menu = h("div", { class: "fm", id: "fm", role: "dialog", "aria-label": extName(), hidden: true },
      h("div", { class: "fm-head" }, logo(20), h("span", { class: "fm-name" }, extName())),
      h("label", { class: "fm-lbl", for: "fm-lang" }, HT_t("targetLangAria")),
      h("div", { class: "fm-sel" }, f.sel, icon("chevDown", 16)),
      f.act,
      h("div", { class: "fm-sep", "aria-hidden": "true" }),
      f.items);
    f.ui = h("div", { class: "ui fab-box" }, f.w, f.menu);
    root.appendChild(f.ui);

    // Наведение: на сам кружок — открыть через 200 мс; ушли с кружка и меню — закрыть через 400 мс (путь от
    // кружка к меню прощается: вернулись на меню — закрытие отменяется). Палец (сенсорный экран) наведения не
    // знает — у него только щелчок.
    f.btn.addEventListener("pointerenter", (e) => { if (e.isTrusted && e.pointerType !== "touch") fabHoverIn(); });
    f.btn.addEventListener("pointerleave", (e) => { if (e.isTrusted) clearTimeout(f.timers.open); });
    host.addEventListener("pointerenter", (e) => { if (e.isTrusted) { clearTimeout(f.timers.close); themeFab(); } });
    host.addEventListener("pointerleave", (e) => { if (e.isTrusted && e.pointerType !== "touch") fabHoverOut(); });
    f.btn.addEventListener("pointerdown", fabDown);
    f.btn.addEventListener("pointermove", fabMove);
    f.btn.addEventListener("pointerup", fabUp);
    f.btn.addEventListener("pointercancel", fabUp);
    f.btn.addEventListener("lostpointercapture", fabUp);
    f.btn.addEventListener("click", fabClick);
    f.menu.addEventListener("keydown", menuKey);
    // Фокус пришёл в меню с клавиатуры — меню закрепляется: иначе уход мыши закрыл бы его вместе с фокусом.
    f.menu.addEventListener("focusin", (e) => {
      let kb = false;
      try { kb = e.target.matches(":focus-visible"); } catch (err) { kb = false; }
      if (kb && f.open === "hover") { f.open = "pin"; clearTimeout(f.timers.close); }
    });
    return f;
  }

  function fabHoverIn() {
    if (!fab) return;
    clearTimeout(fab.timers.close);
    if (fab.open || fab.drag || fab.press) return;
    clearTimeout(fab.timers.open);
    fab.timers.open = setTimeout(() => {
      if (fab && !fab.open && !fab.drag && !fab.press) openMenu("hover", false);
    }, FAB_OPEN_MS);
  }
  function fabHoverOut() {
    if (!fab) return;
    clearTimeout(fab.timers.open);
    if (fab.open !== "hover") return;
    clearTimeout(fab.timers.close);
    fab.timers.close = setTimeout(() => {
      // Курсор уже снова над нами — не закрываем. Раскрыт список языка (он в верхнем слое и может выходить за меню) —
      // ждём ещё: выбрали язык, а курсор остался вне меню — закроется следом.
      if (!fab || fab.open !== "hover" || hovered(fab.host)) return;
      if (pickerOpen()) { fabHoverOut(); return; }
      closeMenu(false);
    }, FAB_CLOSE_MS);
  }
  function hovered(el) { try { return el.matches(":hover"); } catch (e) { return false; } }

  // Щелчок (мышь, палец, Enter или пробел): открыть и закрепить; закреплённое — закрыть. С клавиатуры (detail 0)
  // фокус уходит в меню, на список языка.
  function fabClick(e) {
    if (!e.isTrusted || !fab) return;
    if (fab.noClick) { fab.noClick = false; return; }        // это было перетаскивание
    clearTimeout(fab.timers.open);
    const kb = e.detail === 0;
    if (fab.open === "pin") closeMenu(kb);
    else openMenu("pin", kb);
  }

  // ---- перетаскивание ----
  // Захват указателя: движения приходят кружку, даже когда курсор над встроенным окном сайта (iframe).
  function fabDown(e) {
    if (!e.isTrusted || !fab || e.button !== 0 || !e.isPrimary) return;
    clearTimeout(fab.timers.open);
    const r = fab.host.getBoundingClientRect();
    fab.press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, x: r.left, y: r.top, on: false };
    try { fab.btn.setPointerCapture(e.pointerId); } catch (err) { /* указатель уже отпущен */ }
  }
  function fabMove(e) {
    const d = fab && fab.press;
    if (!e.isTrusted || !d || e.pointerId !== d.id) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) <= FAB_DRAG_PX) return;
      d.on = true;
      fab.drag = d;
      closeMenu(false);
      clearTimeout(fab.timers.snap);
      fab.w.style.transition = "";
      fab.w.style.transform = "";
      fab.btn.classList.add("is-drag");
    }
    const vs = viewSize();
    d.x = Math.max(0, Math.min(e.clientX - d.dx, vs.w - FAB));
    d.y = Math.max(0, Math.min(e.clientY - d.dy, vs.h - FAB));
    const s = fab.host.style;
    s.setProperty("left", Math.round(d.x) + "px", "important");
    s.setProperty("top", Math.round(d.y) + "px", "important");
    s.removeProperty("right");
    s.removeProperty("bottom");
    sideFab();
  }
  function fabUp(e) {
    const d = fab && fab.press;
    if (!e.isTrusted || !d || e.pointerId !== d.id) return;
    fab.press = null;
    if (!d.on) return;                                     // не сдвинули — это щелчок, он придёт следом
    fab.drag = null;
    fab.btn.classList.remove("is-drag");
    // Щелчок после перетаскивания приходит в той же задаче, что и отпускание: его не считаем.
    if (e.type === "pointerup") { fab.noClick = true; setTimeout(() => { if (fab) fab.noClick = false; }, 0); }
    snapFab(d.x, d.y);
  }

  // Отпустили: к ближайшему краю (левому или правому) на той же высоте, но не ближе 16 к верху и низу окна.
  // Место пишем один раз. Едет к краю за 200 мс (сдвиг обёртки: хост уже стоит на новом месте); без анимаций — сразу.
  function snapFab(x, y) {
    const vs = viewSize();
    fabPos = { side: x + FAB / 2 < vs.w / 2 ? "left" : "right", top: Math.round(clampTop(y, vs.h)) };
    chrome.storage.local.set({ hudPos: fabPos }).catch(() => {});
    placeFab();
    if (!fab || reducedMotion()) return;
    const r = fab.host.getBoundingClientRect();
    const dx = Math.round(x - r.left), dy = Math.round(y - r.top);
    if (!dx && !dy) return;
    const w = fab.w.style;
    w.transition = "none";
    w.transform = `translate(${dx}px, ${dy}px)`;
    fab.w.getBoundingClientRect();                         // зафиксировать начальную точку до перехода
    w.transition = `transform ${FAB_SNAP_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    w.transform = "";
    clearTimeout(fab.timers.snap);
    fab.timers.snap = setTimeout(() => { if (fab) fab.w.style.transition = ""; }, FAB_SNAP_MS + 50);
  }
  function reducedMotion() { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }

  // Размер окна без полос прокрутки: от него отсчитываются right/bottom у position: fixed.
  function viewSize() {
    const de = document.documentElement;
    return document.compatMode === "CSS1Compat" && de ? { w: de.clientWidth, h: de.clientHeight } : { w: innerWidth, h: innerHeight };
  }
  function clampTop(top, h) { return Math.max(FAB_EDGE, Math.min(top, h - FAB - FAB_EDGE)); }

  // Поставить кружок на его место. Окно стало ниже — прижимаем, но записанное место не трогаем: в прежнем окне
  // кружок вернётся туда, куда его поставили. Место по умолчанию — справа внизу (следует за низом окна).
  function placeFab() {
    if (!fab || fab.drag) return;
    const s = fab.host.style;
    const side = fabPos ? fabPos.side : "right";
    s.setProperty(side, FAB_EDGE + "px", "important");
    s.removeProperty(side === "left" ? "right" : "left");
    if (fabPos) {
      s.setProperty("top", Math.round(clampTop(fabPos.top, viewSize().h)) + "px", "important");
      s.removeProperty("bottom");
    } else {
      s.setProperty("bottom", FAB_EDGE + "px", "important");
      s.removeProperty("top");
    }
    sideFab();
    placeMenu();
    placeToast();                       // кружок сдвинулся — уведомление не должно оказаться под ним
  }
  // Кружок в правой половине окна? Подпись и меню — со стороны середины экрана.
  function fabOnRight() {
    const r = fab.host.getBoundingClientRect();
    return r.left + FAB / 2 > viewSize().w / 2;
  }
  function sideFab() { if (fab) fab.pill.classList.toggle("left", fabOnRight()); }

  // Меню — вбок к середине экрана; кружок в нижней половине — низ меню на уровне низа кружка, в верхней — верх на
  // уровне верха. Не хватает места по высоте — сдвиг внутрь окна. Вбок не помещается (узкое окно) — над кружком
  // или под ним: кружок меню не закрывает никогда.
  function placeMenu() {
    if (!fab || !fab.open) return;
    const m = fab.menu, r = fab.host.getBoundingClientRect(), vs = viewSize();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const right = fabOnRight(), low = r.top + FAB / 2 > vs.h / 2;
    const M = mh + 2 * FAB_EDGE <= vs.h ? FAB_EDGE : 8;
    let x = right ? r.left - FAB_GAP - mw : r.right + FAB_GAP;
    let y = low ? r.bottom - mh : r.top;
    if (x < 8 || x + mw > vs.w - 8) {
      x = Math.max(8, Math.min(right ? r.right - mw : r.left, vs.w - 8 - mw));
      y = low ? r.top - FAB_GAP - mh : r.bottom + FAB_GAP;
    }
    y = Math.max(M, Math.min(y, vs.h - M - mh));
    m.style.left = Math.round(x - r.left) + "px";
    m.style.top = Math.round(y - r.top) + "px";
  }

  function menuOpen() { return !!(fab && fab.open); }
  // Раскрыт список языка в меню (до Chrome 133 список системный, и Esc сюда не доходит).
  function pickerOpen() { return !!fab && selectOpen(fab.sel); }
  function openMenu(mode, byKeyboard) {
    if (!fab) return;
    clearTimeout(fab.timers.open);
    clearTimeout(fab.timers.close);
    const was = !!fab.open;
    fab.open = mode;
    if (!was) {
      themeFab();
      fab.menu.hidden = false;
      fab.btn.setAttribute("aria-expanded", "true");
      syncFab();                        // место действия — по состоянию страницы; подпись у кружка прячется
      placeMenu();
      placeToast();                     // уведомление не должно закрыть меню
    }
    if (byKeyboard) fab.sel.focus();
  }
  function closeMenu(refocus) {
    if (!fab || !fab.open) return;
    clearTimeout(fab.timers.open);
    clearTimeout(fab.timers.close);
    fab.open = "";
    fab.menu.hidden = true;
    fab.btn.setAttribute("aria-expanded", "false");
    syncFab();
    placeToast();
    if (refocus) fab.btn.focus();
  }
  // Фокус в нашем кружке или меню (закрытый shadow root наружу показывает только хост).
  function focusInFab() { return !!fab && document.activeElement === fab.host; }

  // Клавиатура в меню: Tab и Shift+Tab — по кругу (фокус из открытого меню не уходит); ↑ ↓ Home End — по пунктам.
  function menuKey(e) {
    if (!e.isTrusted || !fab) return;
    const cur = fab.root.activeElement;
    if (e.key === "Tab") {
      const all = Array.from(fab.menu.querySelectorAll("select, button, [tabindex]")).filter((el) =>
        (el.tagName === "SELECT" || !el.closest("select")) && !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      if (!all.length) return;
      const i = all.indexOf(cur);
      if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && i === all.length - 1) { e.preventDefault(); all[0].focus(); }
      return;
    }
    const items = Array.from(fab.items.querySelectorAll(".fm-item"));
    const i = items.indexOf(cur);
    if (i < 0) return;
    const n = items.length;
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null) return;
    e.preventDefault();
    items[(to + n) % n].focus();
  }

  // Цвета кружка и меню — по фону сайта (сайт мог сменить тему, пока кружок на экране).
  function themeFab() {
    if (!fab) return;
    const dk = siteDark();
    for (const el of [fab.ui, fab.w, fab.menu]) el.classList.toggle("dk", dk);
  }

  // «Перевожу… 5 из 12» — те же слова и числа, что в окне расширения.
  function busyText(done, total) {
    return HT_t("ppBusy") + (total ? " " + HT_t("ppBusyN", [HT_num(done), HT_num(total)]) : "");
  }

  // Кружок и меню — по состоянию страницы (зовётся из pushState и при каждой смене того, что они показывают).
  function syncFab() {
    if (!fab) return;
    const page = pageNow();
    fab.btn.classList.toggle("on", page === "done");
    const busy = page === "busy" && pageBusy ? pageBusy : null;
    if (busy) {
      const frac = busy.total ? Math.min(1, busy.done / busy.total) : 0;
      fab.bar.setAttribute("stroke-dasharray", (RING_C * frac).toFixed(1) + " " + RING_C.toFixed(1));
      fab.bar.style.opacity = frac > 0 ? "" : "0";       // круглый конец штриха нулевой длины рисовал бы точку
      if (!fab.ring.isConnected) fab.btn.after(fab.ring);
      fab.pill.textContent = busyText(busy.done, busy.total);
    } else fab.ring.remove();
    // Подпись — пока меню закрыто: открытое меню говорит то же самое и стоит на её месте.
    if (busy && !fab.open) { if (!fab.pill.isConnected) fab.btn.before(fab.pill); sideFab(); } else fab.pill.remove();
    // Точка: красная (перевод не работает) важнее янтарной (ждём щелчка по тексту); одна за раз.
    const dot = problem() || failErr ? "err" : needClick ? "warn" : "";
    if (dot) { fab.dot.className = "fab-dot " + dot; if (!fab.dot.isConnected) fab.w.appendChild(fab.dot); } else fab.dot.remove();
    if (fab.open) syncMenu(page);
  }

  // Меню: язык и место действия (как в окне расширения: «Перевести страницу» → «Перевожу… N из M» + «Стоп» →
  // сегмент «Оригинал | Перевод»; после «Стопа» — «Перевести страницу» и «Перевод в N местах · Показать оригинал»).
  // Место действия перерисовываем, только когда меняется его вид; ход перевода — на месте, чтобы фокус на «Стопе»
  // не терялся. Перерисовали, а фокус был в нём — фокус на тот же контрол (или на первый).
  function syncMenu(page) {
    if (!pickerOpen()) fab.sel.value = settings.targetLang;
    fab.menu.setAttribute("data-page", page);
    const spec = actSpec(page);
    if (spec.key !== fab.actKey) {
      const had = fab.root.activeElement;
      const k = had && fab.act.contains(had) ? had.getAttribute("data-k") || "" : null;
      fab.actKey = spec.key;
      fab.act.replaceChildren(...spec.build());
      if (k !== null) {
        // Тот же контрол, иначе первый доступный с Tab (в сегменте — выбранный, у невыбранного tabindex −1).
        const to = (k && fab.act.querySelector(`[data-k="${k}"]`)) || fab.act.querySelector('button:not([tabindex="-1"])');
        if (to) to.focus();
      }
    }
    if (page === "busy" && pageBusy) {
      const { done, total } = pageBusy;
      const n = fab.act.querySelector(".fm-busy-t span");
      if (n) n.textContent = busyText(done, total);
      const bar = fab.act.querySelector(".fm-prog");
      if (bar) {
        bar.firstChild.style.width = (total ? Math.min(100, (100 * done) / total) : 0) + "%";
        bar.setAttribute("aria-valuemax", String(total));
        bar.setAttribute("aria-valuenow", String(done));
      }
    }
  }

  // Что показать в месте действия: { key, build() → [узлы] }.
  function actSpec(page) {
    const hint = (parts) => {
      const p = h("p", { class: "fm-hint" }, ...parts);
      p.title = p.textContent;          // обрезанную многоточием строку можно прочитать целиком
      return p;
    };
    const translateBtn = () => uiButton("fm-btn", { "data-k": "translate" }, [icon("languages", 16), HT_t("translatePage")], () => translatePage("popup"));
    if (page === "busy") {
      return { key: "busy", build: () => {
        const bar = h("span", { class: "fm-prog", role: "progressbar", "aria-label": HT_t("ppBusyAria"), "aria-valuemin": "0" }, h("span", {}));
        const stop = uiButton("fm-btn2", { "data-k": "stop" }, [stopIcon(), HT_t("ppStop")], () => stopPage());
        return [h("div", { class: "fm-busy" },
          h("div", { class: "fm-busy-b", role: "status" }, h("span", { class: "fm-busy-t" }, icon("spin", 16), h("span", {})), bar), stop),
        hint([HT_t("ppRestLater")])];
      } };
    }
    if (page === "done" || page === "orig") {
      const pair = menuPair();
      return { key: "seg:" + page + ":" + pair, build: () => {
        const tr = page === "done";
        const run = (toTr) => { if (toTr && pageNow() !== "done") translatePage("popup"); else if (!toTr && pageNow() === "done") restoreAll(); };
        const opt = (isTr) => {
          const b = uiButton("", { role: "radio", "aria-checked": String(tr === isTr), tabindex: tr === isTr ? "0" : "-1",
            "data-k": isTr ? "tr" : "orig" }, [HT_t(isTr ? "ppTr" : "ppOrig")], () => run(isTr));
          // Сегмент — radiogroup: стрелки переключают и сразу применяют выбор (как в окне расширения).
          b.addEventListener("keydown", (e) => {
            if (!e.isTrusted || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            if (b.getAttribute("aria-checked") === "true") run(!isTr); else run(isTr);
          });
          return b;
        };
        return [h("div", { class: "fm-seg", role: "radiogroup", "aria-label": HT_t("ppSegAria") }, opt(false), opt(true)),
          hint([HT_t(tr ? "ppEscHint" : "ppOrigHint", pair)])];
      } };
    }
    const count = shownCount();
    if (page === "part" && count > 0) {
      return { key: "part:" + count, build: () => [translateBtn(),
        hint([HT_plural("ppPartDone", count) + " · ",
          uiButton("lnk", { "data-k": "restore", title: HT_t("csShowOrigEsc") }, [HT_t("ppShowOrig")], () => restoreAll())])] };
    }
    // Можно переводить: подсказка — как в окне (страница уже на языке перевода — честно об этом).
    const lang = String(document.documentElement.lang || "");
    const already = !!lang && HT_langKey(lang) === HT_langKey(settings.targetLang);
    const key = HT_triggerKey(settings.trigger, HT_isMac());
    let parts;
    if (already) parts = [HT_t("ppAlready")];
    else if (key) {
      const MARK = "";
      const s = HT_t("ppHintKey", MARK).split(MARK);
      parts = [s[0] || "", h("span", { class: "fm-kbd" }, key), s[1] || ""];
    } else parts = [HT_t("ppHintDwell")];
    return { key: "idle:" + (already ? "a" : key || "d"), build: () => [translateBtn(), hint(parts)] };
  }

  // Пара языков для сегмента — как в окне: язык оригинала по ответам переводчика или по атрибуту lang страницы;
  // неизвестен или совпадает с языком перевода — «На русский».
  function menuPair() {
    const tgt = settings.targetLang;
    const src = pageSrc || String(document.documentElement.lang || "");
    if (!src || HT_langKey(src) === HT_langKey(tgt)) return HT_t("intoLang", HT_langLabel(tgt));
    return HT_t("pairArrow", [capFirst(HT_langLabel(src)), HT_langLabel(tgt)]);
  }

  on(window, "resize", () => { if (fab) placeFab(); else placeToast(); });
  // Сайт следует теме системы — свои цвета вслед за ним.
  try {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    on(mq, "change", () => { themeFab(); if (currentToast) currentToast.retheme(); });
  } catch (e) { /* без matchMedia — тема по фону при показе */ }
  // Сайт сменил тему своим переключателем, без перезагрузки (Википедия — класс у <html>, GitHub — data-color-mode):
  // следим за class, style и data-* у <html> и <body> и перекрашиваемся, когда что-то наше на экране.
  let themeTimer = 0;
  const themeObs = new MutationObserver(() => {
    if (dead) { themeObs.disconnect(); return; }
    if (themeTimer || !(fab || currentToast)) return;
    themeTimer = setTimeout(() => {
      themeTimer = 0;
      if (dead) return;
      themeFab();
      if (currentToast) currentToast.retheme();
    }, 150);
  });
  function watchTheme() {
    themeObs.disconnect();
    if (dead) return;
    for (const el of [document.documentElement, document.body]) if (el) themeObs.observe(el, { attributes: true });
  }
  watchTheme();
  if (!document.body) on(document, "DOMContentLoaded", watchTheme);

  // Кружок только в верхнем фрейме сайта, когда перевод включён и сайт не выключен; на своих страницах
  // расширения его нет. Показан ли он — общее для всех сайтов (hudWanted), поэтому на другой странице он снова тут.
  function fabAllowed() { return loaded && TOP && !OWN_PAGE && !siteOff && !!settings.enabled; }
  function updateFab() {
    const want = hudWanted && fabAllowed() && !dead;
    if (want && !fab) {
      if (!document.body) return;
      fab = buildFab();
      themeFab();
      syncFab();
      mountUi(fab.host);
      placeFab();
    } else if (!want && fab) dropFab();
  }
  function dropFab() {
    if (!fab) return;
    const f = fab;
    fab = null;
    for (const k in f.timers) clearTimeout(f.timers[k]);
    f.host.remove();
    placeToast();
  }
  // SPA заменил <body> целиком (Turbo на GitHub): кружок, уведомление и карточки остались в старом — переносим в
  // новый. Следим только за детьми <html> — это дёшево, и кружок нужен и без перевода страницы. Перевод нового
  // <body> ведёт наблюдатель нового содержимого (watchPage).
  const bodyWatch = new MutationObserver(() => {
    if (dead || !document.body) return;
    if (fab && !fab.host.isConnected) { mountUi(fab.host); themeFab(); placeFab(); }
    if (currentToast && currentToast.alive() && !currentToast.host.isConnected) { mountUi(currentToast.host); placeToast(); }
    for (const [owner, st] of Array.from(popovers)) {
      if (st.node && !st.node.isConnected) { if (owner.isConnected) mountUi(st.node); else removePopover(owner); }
    }
  });
  bodyWatch.observe(document.documentElement, { childList: true });
  unbinders.push(() => bodyWatch.disconnect());
  function setHudWanted(v) {
    hudWanted = v;
    chrome.storage.local.set({ hudShown: v }).catch(() => {});
    updateFab();
    pushState();
  }
  // Кнопка в окне расширения. Где кружку нельзя быть, не показываем — окно объяснит почему.
  function toggleHud() { if (fabAllowed()) setHudWanted(!fab); }
  // «Скрыть кнопку» — на всех сайтах; вернуть — кнопкой в уведомлении, в окне расширения или в настройках.
  function hideFab() {
    setHudWanted(false);
    notice(HT_t("csFabHiddenText"), 8000, {
      title: HT_t("csFabHiddenTitle"),
      actions: [{ label: HT_t("csFabBack"), run: () => setHudWanted(true) }],
    });
  }

  // ---- выключить на этом сайте ----
  // Список общий с окном расширения; читаем свежий перед записью, чтобы не затереть чужое изменение.
  async function setSiteOff(off) {
    if (!SITE) return;
    const got = await chrome.storage.local.get({ disabledSites: [] });
    const list = HT_sites(got.disabledSites).filter((x) => x !== SITE);
    if (off) list.push(SITE);
    await chrome.storage.local.set({ disabledSites: list.slice(-HT_SITES_MAX) });
  }
  // Пункт меню плавающей кнопки. Сайт выключаем сразу (не дожидаясь ответа хранилища): перевод, кружок и
  // карточки уходят тут же. Кнопка «Включить снова» — на случай промаха.
  function disableSiteFromFab() {
    siteOff = true;
    siteChanged();
    setSiteOff(true).catch(() => {});
    notice(HT_t("csSiteDisabledText"), 8000, {
      title: HT_t("csSiteDisabledTitle", SITE),
      actions: [{ label: HT_t("turnBackOn"), run: () => { setSiteOff(false).catch(() => {}); } }],
    });
  }

  // ---- уведомление ----
  // 360 px, вверху справа с отступом 16. Если там оно закрыло бы абзац под курсором или тот, что
  // переводится, — внизу справа над плавающей кнопкой: низ уведомления на 12 выше верха кружка (кружок справа
  // внизу — bottom 72; без кружка или он у левого края — 16; кружок утащили наверх — не накрывает его, открытое
  // меню — тоже). Значок расширения 20 — во всех уведомлениях (видно, что это не сайт); смысл —
  // иконкой 16 в заголовке: ✓ зелёная, ! красная, курсор. Кнопки 32 (главная — синяя), ✕ 32, полоса
  // загрузки 4. Уведомление на экране одно: новое заменяет прежнее.
  // Кнопки и ✕ — в закрытом shadow root и срабатывают только от настоящего щелчка; пока на уведомлении
  // курсор, оно не исчезает.
  let currentToast = null;
  const TOAST_EDGE = 16, TOAST_GAP = 12;

  // Пересекаются ли прямоугольники (DOMRect).
  function cross(a, b) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }

  // Поставить уведомление. work — абзац, который только что начали переводить: если уведомление его
  // закрывает, оно уходит вниз и остаётся там до закрытия (не прыгает туда-обратно).
  function placeToast(work) {
    const t = currentToast;
    if (!t || !t.host.isConnected) return;
    const s = t.host.style;
    // Кружок вместе с открытым меню: меню — внутри его хоста, а уведомление лежит слоем выше и не должно его закрыть.
    let hr = fab && fab.host.isConnected ? fab.host.getBoundingClientRect() : null;
    if (hr && menuOpen()) {
      const m = fab.menu.getBoundingClientRect();
      hr = { left: Math.min(hr.left, m.left), top: Math.min(hr.top, m.top), right: Math.max(hr.right, m.right), bottom: Math.max(hr.bottom, m.bottom) };
    }
    const avoid = [t.anchor, hoverEl, work].filter((el) => el && el.nodeType === 1 && el.isConnected).map((el) => el.getBoundingClientRect());
    const hits = (r) => avoid.some((a) => a.width && a.height && cross(r, a));
    s.setProperty("right", TOAST_EDGE + "px", "important");
    // Вверху справа (кружок утащили наверх — под ним).
    const atTop = () => {
      s.removeProperty("bottom");
      s.setProperty("top", TOAST_EDGE + "px", "important");
      let r = t.host.getBoundingClientRect();
      if (hr && cross(r, hr)) { s.setProperty("top", Math.round(hr.bottom + TOAST_GAP) + "px", "important"); r = t.host.getBoundingClientRect(); }
      return r;
    };
    // Внизу справа, над кружком, если он там. Нижний край окна — от самого уведомления: innerHeight
    // включает горизонтальную полосу прокрутки, а bottom у fixed отсчитывается от края без неё.
    const atLow = () => {
      s.removeProperty("top");
      s.setProperty("bottom", TOAST_EDGE + "px", "important");
      let r = t.host.getBoundingClientRect();
      if (hr && cross(r, hr)) {
        const vb = r.bottom + TOAST_EDGE;
        s.setProperty("bottom", Math.round(Math.min(vb - hr.top + TOAST_GAP, vb - r.height - TOAST_EDGE)) + "px", "important");
        r = t.host.getBoundingClientRect();
      }
      return r;
    };
    let low = t.low;
    if (!low && hits(atTop())) low = true;
    if (low && hits(atLow()) && !hits(atTop())) low = false;
    if (low) atLow(); else atTop();
    t.low = low;
    t.card.classList.toggle("low", low);
  }

  // Показать уведомление. o: { title (жирная строка), icon: "ok" | "err" | "pointer", text (под заголовком —
  // мельче и серым; без заголовка — основная строка), detail (ещё мельче: код ответа, текст сервиса),
  // progress: "empty" | "indet" | 0–100 (полоса 4 px), actions: [{ label, run, primary }], esc (подсказка
  // «или Esc» после кнопок), ms (0 — пока не закроют), kind: "err" (role=alert), anchor (элемент, который
  // нельзя закрывать) }. Возвращает { host, update(o), close(), alive(), retheme() }.
  function showToast(o) {
    if (currentToast) currentToast.close();
    const { host, root } = makeUiHost(Z_TOAST);
    const s = host.style;
    s.setProperty("top", TOAST_EDGE + "px", "important");
    s.setProperty("right", TOAST_EDGE + "px", "important");
    const body = h("div", { class: "t-b" });
    const x = uiButton("x-btn", { title: HT_t("csCloseTip"), "aria-label": HT_t("toastCloseAria") }, [icon("x", 16)], () => t.close());
    const card = h("div", { class: "ui toast" }, logo(20, "t-ic"), body, x);
    root.appendChild(card);

    let timer = 0, ms = 0, closed = false, hovered = false;
    const t = {
      host, card, anchor: o.anchor || null, low: false,
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (currentToast === t) currentToast = null;
        if (downloadHint === t) downloadHint = null;
        card.classList.remove("show");
        setTimeout(() => host.remove(), 200);
      },
      alive() { return !closed && currentToast === t; },
      // Сменить содержимое на месте (например, «Щёлкните по тексту» → «Скачиваю переводчик»), если
      // уведомление ещё на экране и его не заменило другое.
      update(p) { if (t.alive()) { fill(Object.assign({}, o, p)); placeToast(); } },
      retheme() { card.classList.toggle("dk", siteDark()); },
    };
    const arm = (delay) => { clearTimeout(timer); if (delay && !hovered) timer = setTimeout(t.close, delay); };
    function fill(p) {
      o = p;
      if (p.anchor) t.anchor = p.anchor;
      card.setAttribute("role", p.kind === "err" ? "alert" : "status");
      const kids = [];
      if (p.title) {
        const ic = p.icon === "ok" ? h("span", { class: "ok" }, icon("checkCircle", 16))
          : p.icon === "err" ? h("span", { class: "err" }, icon("alert", 16))
            : p.icon === "pointer" ? icon("pointer", 16) : null;
        kids.push(h("p", { class: "t-t" }, ic, h("span", {}, p.title)));
        if (p.text) kids.push(h("p", { class: "t-d" }, p.text));
      } else if (p.text) kids.push(h("p", { class: "t-m" }, p.text));
      if (p.detail) kids.push(h("p", { class: "t-dt" }, p.detail));
      if (p.progress != null) {
        const pct = typeof p.progress === "number" ? Math.max(0, Math.min(100, p.progress)) : 0;
        const bar = h("span", { class: "t-prog" + (p.progress === "indet" ? " indet" : ""), role: "progressbar",
          "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": p.title || p.text || "" }, h("span", {}));
        if (typeof p.progress === "number") { bar.setAttribute("aria-valuenow", String(pct)); bar.firstChild.style.width = pct + "%"; }
        kids.push(bar);
      }
      const acts = (p.actions || []).map((a) => uiButton("t-btn" + (a.primary ? " pri" : ""), {}, [a.label], () => { t.close(); a.run(); }));
      if (p.esc) acts.push(h("span", { class: "t-hint" }, HT_t("csOr"), h("span", { class: "t-kbd" }, "Esc")));
      if (acts.length) kids.push(h("div", { class: "t-a" }, ...acts));
      body.replaceChildren(...kids);
      ms = p.ms || 0;
      arm(ms);
    }
    t.retheme();
    themeFab();
    fill(o);
    // Курсор на уведомлении — человек читает или тянется к кнопке: не убираем, пока он там.
    host.addEventListener("mouseenter", (ev) => { if (ev.isTrusted) { hovered = true; clearTimeout(timer); } });
    host.addEventListener("mouseleave", (ev) => { if (ev.isTrusted) { hovered = false; if (ms) arm(Math.min(ms, 3000)); } });
    mountUi(host);
    currentToast = t;
    placeToast();
    // Прозрачность анимируем на карточке, а не на хосте: у хоста opacity выставлен с !important,
    // чтобы правила страницы не могли нас спрятать.
    requestAnimationFrame(() => { if (!closed) card.classList.add("show"); });
    return t;
  }

  // Ошибка — не чаще раза в 3 с, чтобы серия сбоев не завалила страницу.
  function toast(o) {
    const now = Date.now();
    if (now - lastToastAt < 3000) return null;
    lastToastAt = now;
    return showToast(o);
  }

  // Подсказка о настройке или о ходе работы. Частоту ограничивают вызывающие (раз на страницу или на
  // сессию), поэтому общий интервал её не глушит: иначе единственная подсказка терялась бы за ошибкой
  // секундой раньше.
  function notice(text, ms, opts) {
    return showToast(Object.assign({ text, ms: ms == null ? 9000 : ms }, opts));
  }
  // Короткое название — из сообщений (extShortName), в коде его не пишем.
  function extName() { return HT_t("extShortName"); }
})();
