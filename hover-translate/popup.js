// popup.js — окно расширения. Всё хранится в chrome.storage.local и подхватывается
// content.js/background.js на лету.
//
// Порядок — по задачам: выключатель и сайт, язык, способ включения, действия со страницей. Выбор
// переводчика («Качество перевода») и «Дополнительно» при открытии свёрнуты: в обычном состоянии окно
// помещается в 600 px, больше Chrome не показывает. Что сделать, если перевод не работает (ключ,
// согласие, скачать модели), — наверху, с кнопкой, а в заголовке «Качества перевода» — коротко, что
// выбрано и в каком оно состоянии.

// Общие с content.js значения берём из shared.js, к ним добавляем то, что нужно только окну: ключи,
// отметки «ключ проверен», недавние языки и согласие на отправку текста.
const DEFAULTS = Object.assign({}, HT_DEFAULTS, {
  apiKey: "", keyVerified: false,
  llmApiKey: "", llmVerified: false,
  recentLangs: [], consent: {},
});

// Статический текст разметки — из сообщений (_locales), до всего остального: ниже код читает и меняет
// уже подписанные элементы.
HT_localize(document);

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"), enabledText: $("enabledText"),
  siteRow: $("siteRow"), siteOn: $("siteOn"), siteName: $("siteName"),
  pageMsg: $("pageMsg"), reloadTab: $("reloadTab"),
  setup: $("setup"), setupText: $("setupText"), setupFix: $("setupFix"), setupGo: $("setupGo"), prepBox: $("prepBox"),
  targetLang: $("targetLang"), recentLangs: $("recentLangs"),
  trigger: $("trigger"), triggerHint: $("triggerHint"),
  dwellField: $("dwellField"), dwellMs: $("dwellMs"), dwellVal: $("dwellVal"),
  translatePage: $("translatePage"), resetPage: $("resetPage"), hudBtn: $("hudBtn"),
  qualityHead: $("qualityHead"), qualityBody: $("qualityBody"), qualitySum: $("qualitySum"),
  engine: $("engine"), builtinBox: $("builtinBox"),
  consentBox: $("consentBox"), consentText: $("consentText"), consentOk: $("consentOk"),
  consentGiven: $("consentGiven"), consentGivenText: $("consentGivenText"), consentRevoke: $("consentRevoke"),
  keyBlock: $("keyBlock"), apiKey: $("apiKey"), toggleKey: $("toggleKey"), check: $("check"),
  status: $("status"), quota: $("quota"),
  llmBlock: $("llmBlock"), llmProvider: $("llmProvider"), llmKeyLbl: $("llmKeyLbl"), llmApiKey: $("llmApiKey"),
  toggleLlmKey: $("toggleLlmKey"), llmCheck: $("llmCheck"),
  llmModelSel: $("llmModelSel"), llmModel: $("llmModel"), llmStatus: $("llmStatus"),
  moreHead: $("moreHead"), moreBody: $("moreBody"),
  sourceLang: $("sourceLang"),
  formalityField: $("formalityField"), formality: $("formality"),
  displayMode: $("displayMode"), displayNote: $("displayNote"), badgeRow: $("badgeRow"), showLangBadge: $("showLangBadge"),
  dispMode: $("dispMode"), dispCustom: $("dispCustom"),
  dispBg: $("dispBg"), dispOpacity: $("dispOpacity"), dispOpacityVal: $("dispOpacityVal"),
  dispBorder: $("dispBorder"), dispBorderColor: $("dispBorderColor"), dispBorderStyle: $("dispBorderStyle"),
  borderControls: $("borderControls"),
  noTranslate: $("noTranslate"),
  cacheRow: $("cacheRow"), stats: $("stats"), clearCache: $("clearCache"), cacheMsg: $("cacheMsg"),
  keysText: $("keysText"), keysEdit: $("keysEdit"),
};

const MAC = HT_isMac();
const CHECK_FAIL = HT_t("checkFail");
const NO_PAGE = HT_t("noPage");
const STORE_FULL = HT_t("storeFull");
const LANG_LABEL = Object.fromEntries(HT_TARGET_LANGS);
let recent = [];
let enabledOn = true;
let consent = HT_consent(null);
let builtinUi = null;                 // блок встроенного переводчика (builtin.js)
let builtinState = "";                // "" — ещё проверяем; "ready" | "need" | "none" | "pair-unavailable" | "no-lang"
let keyVerified = false, llmVerified = false;
let builtinOnTop = false;             // блок встроенного переводчика перенесён наверх (нужно скачать модели)
let site = null;                      // { name, off } — сайт активной вкладки (от её content-скрипта)
const keys = { toggle: "", page: "" };  // сочетания клавиш команд (chrome.commands)

// ---- списки ----
// Языки и переводчики строим из общих таблиц shared.js, а не держим копией в разметке. Заполняем
// СИНХРОННО, до чтения настроек: ниже им присваивается сохранённое значение.
HT_fillSelect(els.targetLang, HT_TARGET_LANGS);
HT_fillSelect(els.sourceLang, HT_SOURCE_LANGS);

// Переводчики — переключатели с пояснением: в выпадающем списке пояснение не поместилось бы.
for (const [code] of HT_ENGINES) {
  const row = document.createElement("label");
  row.className = "eng";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "engine";
  input.value = code;
  const text = document.createElement("span");
  const name = document.createElement("span");
  name.className = "eng-name";
  name.textContent = HT_engineLabel(code);
  const hint = document.createElement("span");
  hint.className = "eng-hint";
  hint.textContent = HT_engineHint(code);
  text.append(name, hint);
  row.append(input, text);
  els.engine.appendChild(row);
}

// Клавиши способа включения — как они подписаны на клавиатуре (на Mac — ⌥ Option, ⌘ Cmd).
for (const span of els.trigger.querySelectorAll("[data-key]")) span.textContent = HT_triggerKey(span.dataset.key, MAC);

function radioValue(name) {
  const r = document.querySelector(`input[name="${name}"]:checked`);
  return r ? r.value : "";
}
function setRadio(name, value) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === value;
}
const engineValue = () => HT_valid("engine", radioValue("engine"));
const triggerValue = () => HT_valid("trigger", radioValue("trigger"));

// Модели ИИ: первая строка списка — «по умолчанию» (пустое значение в настройках), последняя —
// «Другая…» с полем для точного названия.
const OTHER_MODEL = "other";
function fillModels(provider) {
  els.llmModelSel.textContent = "";
  HT_llmModels(provider).forEach((row, i) => {
    const o = document.createElement("option");
    o.value = i === 0 ? "" : row[0];
    o.textContent = HT_llmModelLabel(row);
    els.llmModelSel.appendChild(o);
  });
  const other = document.createElement("option");
  other.value = OTHER_MODEL;
  other.textContent = HT_t("modelOther");
  els.llmModelSel.appendChild(other);
}
function setModelUI(provider, model) {
  fillModels(provider);
  const row = model ? HT_llmModelRow(provider, model) : null;
  const custom = !!model && !row;
  els.llmModelSel.value = !model || model === HT_llmDefault(provider) ? "" : custom ? OTHER_MODEL : model;
  els.llmModel.value = custom ? model : "";
  els.llmModel.hidden = !custom;
}
function modelValue() {
  const v = els.llmModelSel.value;
  return v === OTHER_MODEL ? els.llmModel.value.trim() : v;
}

// ---- общие ----
function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = (el === els.quota ? "quota" : "status") + (kind ? " " + kind : "");
}
const setStatus = (text, kind) => setMsg(els.status, text, kind);
const setLlmStatus = (text, kind) => setMsg(els.llmStatus, text, kind);
// Сообщение о вкладке; offMsg — это просьба включить перевод (её убирает сам выключатель).
let offMsg = false;
const setPageMsg = (text, kind, off) => { offMsg = !!off; setMsg(els.pageMsg, text, kind); };

// Подпись кнопки: title и aria-label всегда ставятся вместе.
function setTip(el, text) {
  el.title = text;
  el.setAttribute("aria-label", text);
}

function setEnabledUI(on) {
  enabledOn = on;
  els.enabled.setAttribute("aria-checked", String(on));
  els.enabledText.textContent = HT_t(on ? "enabledOn" : "enabledOff");
  els.enabled.title = keys.toggle ? HT_t("hotkeyTip", keys.toggle) : "";
}

// «Мини-панель на странице»: нажата, пока панель показана на активной вкладке.
function setHudUI(on) {
  els.hudBtn.setAttribute("aria-pressed", String(!!on));
  els.hudBtn.title = HT_t(on ? "hudShownTip" : "hudHiddenTip");
}

// Сворачиваемый блок: кнопка-заголовок с aria-expanded и тело с hidden.
function setFold(head, body, open) {
  head.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
}
function openQuality() { setFold(els.qualityHead, els.qualityBody, true); }

// Спросить background, заблокировав кнопку на время запроса. Всегда возвращает объект, поэтому
// вызывающим не нужно повторять проверку `r && r.ok`.
async function ask(btn, type) {
  btn.disabled = true;
  try { return (await chrome.runtime.sendMessage({ type })) || { ok: false, error: CHECK_FAIL }; }
  catch (e) { return { ok: false, error: (e && e.message) || CHECK_FAIL }; }
  finally { btn.disabled = false; }
}

function save() {
  // storage.local делит квоту с сохранёнными переводами, поэтому set() может отказать. Без catch
  // это валило весь обработчик, из которого save() вызван: «Перевести страницу» молча не
  // срабатывала, а введённый ключ и смена языка терялись, хотя окно показывало новое значение.
  return chrome.storage.local.set({
    enabled: enabledOn,
    apiKey: els.apiKey.value.trim(),
    targetLang: els.targetLang.value,
    sourceLang: els.sourceLang.value,
    trigger: triggerValue(),
    dwellMs: HT_clampDwell(els.dwellMs.value),
    engine: engineValue(),
    displayMode: els.displayMode.value,
    showLangBadge: els.showLangBadge.checked,
    formality: els.formality.value,
    noTranslate: els.noTranslate.value,
    llmProvider: els.llmProvider.value,
    llmApiKey: els.llmApiKey.value.trim(),
    llmModel: modelValue(),
    dispMode: els.dispMode.value,
    dispBg: els.dispBg.value,
    dispOpacity: Number(els.dispOpacity.value),
    dispBorder: els.dispBorder.checked,
    dispBorderColor: els.dispBorderColor.value,
    dispBorderStyle: els.dispBorderStyle.value,
    recentLangs: recent,
  }).then(() => true).catch((e) => {
    setPageMsg(HT_t("settingsNotSaved", (e && e.message) || STORE_FULL), "err");
    return false;
  });
}

// ---- состояние переводчика ----
// То же, по чему background ставит «!» на значке (shared.js), но по значениям в окне: подсказка
// меняется сразу, как вставили ключ, согласились или сменили переводчик.
function netState() {
  return {
    apiKey: !!els.apiKey.value.trim(), llmApiKey: !!els.llmApiKey.value.trim(),
    llmProvider: els.llmProvider.value, consent,
    targetLang: els.targetLang.value, sourceLang: els.sourceLang.value,
  };
}
const currentProvider = () => HT_provider(engineValue(), els.llmProvider.value);
const problemNow = () => HT_engineProblem(engineValue(), netState(), HT_builtin.hasApi());
// Переводит ли сейчас встроенный: выбран он сам или «авто», которому DeepL пока недоступен.
function builtinPrimary() {
  const e = HT_engine(engineValue());
  return e.via === "local" || (e.fallback === "local" && !HT_canSend(e.code, netState()));
}
// Короткое имя сервиса для текста согласия.
const SEND_TO = { deepl: "DeepL", openai: "OpenAI", anthropic: "Anthropic" };
// Что именно человек разрешает — одними словами и наверху окна, и в «Качестве перевода» (сообщения
// disclosure*, setupNoConsent, setupAutoConsent повторяют одну и ту же фразу).
// «Авто» с ключом, но без согласия: работает, но только встроенным — сказать, что DeepL ждёт согласия.
function autoWaitsConsent() {
  const e = HT_engine(engineValue());
  const prov = currentProvider();
  return e.fallback === "local" && !!els.apiKey.value.trim() && !HT_agreed(consent, prov);
}

// Встроенному переводчику нужно скачать модели, а переводит сейчас он — блок с кнопкой «Подготовить
// переводчик» переезжает наверх: в свёрнутом «Качестве перевода» его никто бы не нашёл. Обратно до
// закрытия окна не возвращаем, чтобы «Готово» после загрузки осталось на виду. Язык, которого
// встроенный не знает («no-lang»), объясняет блок наверху окна (updateSetup) — сюда не переезжаем.
function placeBuiltin() {
  if (builtinOnTop || !builtinPrimary()) return;
  if (builtinState !== "need" && builtinState !== "pair-unavailable") return;
  builtinOnTop = true;
  els.prepBox.appendChild(els.builtinBox);
}

function updateEngineVisibility() {
  const e = HT_engine(engineValue());
  els.keyBlock.hidden = e.keyField !== "apiKey";
  els.llmBlock.hidden = e.keyField !== "llmApiKey";
  els.formalityField.hidden = !e.formality;
  els.cacheRow.hidden = e.via === "local";       // сохраняются переводы DeepL и ИИ, встроенного — нет
  els.builtinBox.hidden = !e.note;               // встроенный участвует в переводе
  placeBuiltin();
  els.prepBox.hidden = !builtinOnTop || els.builtinBox.hidden;
  updateConsent();
  updateSetup();
  updateQualitySum();
}

// Согласие на отправку текста: пока его нет — объяснение и «Согласен»; после — строка о том, что
// и куда уходит, с возможностью отозвать.
function updateConsent() {
  const prov = currentProvider();
  const agreed = HT_agreed(consent, prov);
  // Согласие — про выбранный сервис: у ИИ — после выбора сервиса, у DeepL — перед ключом.
  const llm = HT_engine(engineValue()).via === "llm";
  const anchor = llm ? els.llmKeyLbl : els.keyBlock;
  if (els.consentGiven.nextElementSibling !== anchor) anchor.before(els.consentBox, els.consentGiven);
  els.consentBox.hidden = !prov || agreed;
  els.consentGiven.hidden = !prov || !agreed;
  if (!prov) return;
  const auto = HT_engine(engineValue()).fallback === "local";
  els.consentText.textContent = HT_t(auto ? "disclosureAuto" : "disclosure", SEND_TO[prov]);
  els.consentGivenText.textContent = HT_t("consentGiven", SEND_TO[prov]);
}

async function setConsent(prov, value) {
  let stored = {};
  try { stored = (await chrome.storage.local.get({ consent: {} })).consent; } catch (e) { /* пустое */ }
  const next = HT_consent(stored);
  next[prov] = value;
  try { await chrome.storage.local.set({ consent: next }); }
  catch (e) { setPageMsg(HT_t("notSaved", STORE_FULL), "err"); return false; }
  consent = next;
  updateEngineVisibility();
  return true;
}

els.consentOk.addEventListener("click", async () => {
  const prov = currentProvider();
  if (!prov || !(await setConsent(prov, true))) return;
  // Следующий шаг — ключ, если его ещё нет; иначе фокус на строке «отправляется в …».
  const keyEl = prov === "deepl" ? els.apiKey : els.llmApiKey;
  if (!keyEl.value.trim()) keyEl.focus(); else els.consentRevoke.focus();
  if (prov === "deepl" && els.apiKey.value.trim()) fetchQuota();
});
els.consentRevoke.addEventListener("click", async () => {
  const prov = currentProvider();
  if (prov && (await setConsent(prov, false))) els.consentOk.focus();
});

// ---- перевод не работает: что сделать ----
// Кнопки: go — главное действие, fix — другой путь (обычно встроенный переводчик, он работает сразу).
const SETUP_GO = { key: "setupGoKey", agree: "agree", deepl: "setupGoDeepl", lang: "setupGoLang" };
const SETUP_FIX = { chrome: "setupFixChrome", keep: "setupFixKeep", deepl: "setupGoDeepl" };
let setupGo = null, setupFix = null, setupLangFrom = false;
function updateSetup() {
  const builtin = HT_builtin.hasApi();
  const p = problemNow();
  const prov = currentProvider();
  let text = "", info = false;
  setupGo = null; setupFix = null;
  if (p === "no-deepl-key") {
    text = HT_t(builtin ? "setupNoDeeplKeyBuiltin" : "setupNoDeeplKey");
    setupGo = "key"; setupFix = builtin ? "chrome" : null;
  } else if (p === "no-llm-key") {
    text = HT_t(builtin ? "setupNoLlmKeyBuiltin" : "setupNoLlmKey");
    setupGo = "key"; setupFix = builtin ? "chrome" : null;
  } else if (p === "no-consent") {
    text = HT_t("setupNoConsent", SEND_TO[prov]);
    setupGo = "agree"; setupFix = builtin ? "chrome" : null;
  } else if (p === "no-builtin") {
    text = HT_t("setupNoBuiltin");
    setupGo = "deepl";
  } else if (p === "deepl-lang" || p === "builtin-lang") {
    // Язык, которого выбранный переводчик не знает: выбрать другой язык или другой переводчик.
    const deepl = p === "deepl-lang";
    const gap = HT_langGap(deepl ? "deepl" : "local", netState()) || { dir: "to", code: els.targetLang.value };
    setupLangFrom = gap.dir === "from";
    const key = deepl ? (setupLangFrom ? "setupDeeplLangFrom" : "setupDeeplLangTo")
      : (setupLangFrom ? "setupBuiltinLangFrom" : "setupBuiltinLangTo");
    text = HT_t(key, HT_langLabel(gap.code));
    setupGo = "lang"; setupFix = deepl ? (builtin ? "chrome" : null) : "deepl";
  } else if (autoWaitsConsent()) {
    text = HT_t("setupAutoConsent", SEND_TO[prov]);
    setupGo = "agree"; setupFix = "keep"; info = true;
  }
  els.setup.hidden = !text;
  if (!text) return;
  els.setup.classList.toggle("info", info);
  els.setupText.textContent = text;
  els.setupGo.hidden = !setupGo;
  els.setupGo.textContent = setupGo ? HT_t(SETUP_GO[setupGo]) : "";
  els.setupGo.className = "btn";                 // главное действие — заметнее второго пути
  els.setupFix.hidden = !setupFix;
  els.setupFix.textContent = setupFix ? HT_t(SETUP_FIX[setupFix]) : "";
}

// Открыть «Качество перевода» и поставить фокус туда, где нужно действие: ключ или «Согласен».
function focusQualityTarget() {
  openQuality();
  const prov = currentProvider();
  if (prov && !HT_agreed(consent, prov)) { els.consentOk.focus(); return; }
  const keyEl = HT_engine(engineValue()).keyField === "llmApiKey" ? els.llmApiKey : els.apiKey;
  keyEl.focus();
}
els.setupGo.addEventListener("click", async () => {
  if (setupGo === "agree") {
    const prov = currentProvider();
    if (!prov || !(await setConsent(prov, true))) return;
    // Блок с кнопкой исчез — говорим, что вышло (строка состояния читается и с экрана), и не теряем фокус.
    setPageMsg(HT_t("setupAgreed", SEND_TO[prov]), "ok");
    els.qualityHead.focus();
    if (prov === "deepl" && els.apiKey.value.trim()) fetchQuota();
    return;
  }
  if (setupGo === "lang") {
    // Язык оригинала — в «Дополнительно», язык перевода — на виду.
    if (setupLangFrom) { setFold(els.moreHead, els.moreBody, true); els.sourceLang.focus(); } else els.targetLang.focus();
    return;
  }
  if (setupGo === "deepl") setEngine("deepl");
  focusQualityTarget();
});
els.setupFix.addEventListener("click", () => {
  if (!setupFix) return;
  if (setupFix === "deepl") { setEngine("deepl"); focusQualityTarget(); } else setEngine("chrome");
});

// ---- «Качество перевода»: что выбрано и в каком состоянии ----
// Заголовок узкий: когда всё в порядке — что выбрано («DeepL ✓»), когда нет — только что не так
// («нет согласия»): подробности и кнопка — в блоке наверху окна. Полный текст — во всплывающей подсказке.
const AI_NAME = { openai: "ChatGPT", anthropic: "Claude" };
function updateQualitySum() {
  const v = engineValue();
  const e = HT_engine(v);
  const p = problemNow();
  const name = e.via === "local" ? HT_t("sumBuiltin") : e.via === "llm" ? AI_NAME[currentProvider()]
    : v === "auto" ? HT_t("sumAuto") : "DeepL";
  let status = "", kind = "";
  if (p === "deepl-lang" || p === "builtin-lang") { status = HT_t("sumNoLang"); kind = "err"; }
  else if (e.via === "local" || (p === "no-builtin")) {
    if (p === "no-builtin" || builtinState === "none") { status = HT_t("sumUnavailable"); kind = "err"; }
    else if (builtinState === "need") { status = HT_t("sumDownload"); kind = "warn"; }
    else if (builtinState === "pair-unavailable" || builtinState === "no-lang") { status = HT_t("sumNoLang"); kind = "warn"; }
    else if (builtinState === "ready") kind = "ok";
  } else {
    const st = netState();
    if (!st[e.keyField]) { status = HT_t("sumNoKey"); kind = p ? "err" : "warn"; }
    else if (!HT_canSend(v, st)) { status = HT_t("sumNoConsent"); kind = p ? "err" : "warn"; }
    else if (e.via === "llm" ? llmVerified : keyVerified) kind = "ok";
  }
  els.qualitySum.textContent = status || name + (kind === "ok" ? " ✓" : "");
  els.qualitySum.title = status ? HT_t("sumTip", [name, status]) : "";
  els.qualitySum.className = "fold-sum" + (kind ? " " + kind : "");
}

els.qualityHead.addEventListener("click", () => {
  setFold(els.qualityHead, els.qualityBody, els.qualityHead.getAttribute("aria-expanded") !== "true");
});
els.moreHead.addEventListener("click", () => {
  setFold(els.moreHead, els.moreBody, els.moreHead.getAttribute("aria-expanded") !== "true");
});

function setEngine(code) {
  setRadio("engine", code);
  onEngineChange();
  save();
}

// ---- способ включения ----
function updateTrigger() {
  const t = triggerValue();
  els.dwellField.hidden = t !== "dwell";
  els.triggerHint.textContent = t === "dwell" ? HT_t("triggerHintDwell") : HT_t("triggerHintKey", HT_triggerKey(t, MAC));
}

// Задержка в секундах: «0,6 с» на экране, «0,6 секунды» — для чтения с экрана (число и форма слова — по
// языку интерфейса).
function updateDwell() {
  const sec = HT_clampDwell(els.dwellMs.value) / 1000;
  els.dwellVal.textContent = HT_t("dwellValue", HT_num(sec));
  els.dwellMs.setAttribute("aria-valuetext", HT_plural("seconds", sec));
}

// ---- недавние языки ----
// Названия, а не коды; текущий язык уже виден в списке — в чипах только остальные.
function pushRecent(code) {
  if (!LANG_LABEL[code]) return;
  recent = [code, ...recent.filter((c) => c !== code)].slice(0, 5);
}
function renderRecent() {
  els.recentLangs.textContent = "";
  const list = recent.filter((c) => c !== els.targetLang.value && LANG_LABEL[c]).slice(0, 4);
  if (!list.length) return;
  const lbl = document.createElement("span");
  lbl.className = "chips-lbl";
  lbl.textContent = HT_t("recentLabel");
  els.recentLangs.appendChild(lbl);
  for (const code of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = LANG_LABEL[code];
    b.lang = HT_langBase(code);
    b.title = HT_t("recentTip");
    // Чипы строятся заново — фокус с клавиатуры переносим на список языков, а не теряем.
    b.addEventListener("click", () => { setTargetLang(code); els.targetLang.focus(); });
    els.recentLangs.appendChild(b);
  }
}
let shownLang = "";
function setTargetLang(code) {
  // Прежний язык тоже попадает в недавние — иначе после первой смены вернуться было бы нечем.
  pushRecent(shownLang);
  if (els.targetLang.value !== code) els.targetLang.value = code;
  pushRecent(code);
  shownLang = code;
  save();
  renderRecent();
  updateEngineVisibility();             // выбранный переводчик может не знать этот язык
  if (builtinUi) builtinUi.refresh();   // пара «английский → язык» сменилась
}

// ---- отображение ----
function updateDispVisibility() {
  // Язык оригинала показывается только в карточке — при замене на месте галочка ни на что не влияет.
  const pop = els.displayMode.value === "popover";
  els.badgeRow.hidden = !pop;
  els.displayNote.hidden = !pop;
  els.dispCustom.hidden = els.dispMode.value !== "custom";
  els.borderControls.hidden = !els.dispBorder.checked;
  els.dispOpacityVal.textContent = els.dispOpacity.value + "%";
}

// ---- остаток DeepL и проверка ключей ----
function renderQuota(r) {
  if (!r || !r.ok || typeof r.limit !== "number") { setMsg(els.quota, "", ""); return; }
  const remaining = Math.max(0, r.limit - r.used);
  setMsg(els.quota, HT_plural("quotaLeft", r.limit, HT_num(remaining)), remaining < r.limit * 0.1 ? "warn" : "");
}
// Ошибка проверки ключа. В самом окне «проверьте его в окне расширения» звучало бы странно.
function checkError(r) {
  const text = r.code === "bad-key" ? HT_t("keyRejected") : (r.error || CHECK_FAIL);
  return r.detail ? HT_t("withDetail", [text, r.detail]) : text;
}

async function fetchQuota() {
  if (!els.apiKey.value.trim()) { renderQuota(null); return; }
  try { renderQuota(await chrome.runtime.sendMessage({ type: "checkUsage" })); } catch (e) { renderQuota(null); }
}

// Проверка ключа уходит только сам ключ — тому сервису, который его выдал, — без текста страниц,
// поэтому согласия не ждёт (см. checkUsage/checkLlm в background.js).
async function checkDeepl() {
  if (!els.apiKey.value.trim()) { setStatus(HT_t("pasteKeyFirst"), "err"); return; }
  if (!(await save())) return;      // иначе проверялся бы прежний ключ из storage
  setStatus(HT_t("checkingKey"), "");
  const r = await ask(els.check, "checkUsage");
  keyVerified = !!r.ok;
  if (r.ok) { setStatus(HT_t("keyWorks"), "ok"); renderQuota(r); }
  else { renderQuota(null); setStatus(checkError(r), "err"); }
  chrome.storage.local.set({ keyVerified }).catch(() => {});
  updateQualitySum();
}

async function checkLlm() {
  if (!els.llmApiKey.value.trim()) { setLlmStatus(HT_t("pasteKeyFirst"), "err"); return; }
  if (!(await save())) return;
  setLlmStatus(HT_t("checkingLlmKey"), "");
  const r = await ask(els.llmCheck, "checkLlm");
  llmVerified = !!r.ok;
  setLlmStatus(r.ok ? HT_t("keyWorks") : checkError(r), r.ok ? "ok" : "err");
  chrome.storage.local.set({ llmVerified }).catch(() => {});
  updateQualitySum();
}

// Вставили ключ (а не набирают по букве) — проверяем сразу, не дожидаясь кнопки.
const pasted = (e) => e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop";

// ---- статистика расхода ----
async function fetchStats() {
  if (HT_engine(engineValue()).via === "local") { els.stats.textContent = ""; return; }
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "getStats" }); } catch (e) { r = null; }
  if (!r || !r.ok) { els.stats.textContent = ""; return; }
  els.stats.textContent = [HT_plural("statsSent", r.chars), HT_plural("statsHits", r.hits, HT_plural("statsFree", r.saved)),
    HT_t("statsKept")].join(" ");
}

// ---- связь со страницей ----
// Команды адресуем ТОЛЬКО верхнему фрейму. Content-скрипт объявлен с all_frames:true, и без
// frameId каждая команда уходила в каждый iframe: свой бюджет PAGE_MAX на фрейм (на странице с
// десятком встроенных виджетов — кратный перерасход ключа на контент, который никто не читает),
// N+1 панелей HUD, и `ok` от произвольного фрейма — поэтому «Эта страница недоступна» не
// показывалось никогда, даже когда в верхнем фрейме скрипта нет.
const TOP_FRAME = { frameId: 0 };

// Отправить команду верхнему фрейму активной вкладки. map получает ответ и признак недоступности
// страницы (служебная страница, нет content-скрипта) и решает, что вернуть вызывающему.
// frames — адресат ({} — все фреймы: «Вернуть оригинал» касается и встроенных окон).
let activeTab = null;                 // вкладка последней команды — для подсказки «обновите вкладку»
function askTab(type, map, frames) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      activeTab = tab || null;
      if (!tab || tab.id == null) return resolve(map(null, true));
      chrome.tabs.sendMessage(tab.id, { type }, frames || TOP_FRAME, (resp) => resolve(map(resp, !!chrome.runtime.lastError)));
    });
  });
}

// ---- вкладка не отвечает ----
// Content-скрипта на вкладке нет в двух случаях: страница, куда Chrome расширения не пускает
// (chrome://, магазин расширений), или сайт, открытый до установки или обновления расширения, —
// туда новая версия попадает только после обновления вкладки. Адрес вкладки окну расширения виден
// лишь с разрешением "tabs" или "activeTab" (их нет), поэтому без адреса различаем по факту:
// предлагаем обновить вкладку и проверяем снова. Если адрес известен — сразу говорим как есть.
const WEBSTORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;
function tabKind(tab) {
  const url = tab && (tab.url || tab.pendingUrl);
  if (!url) return "unknown";
  if (url.startsWith(chrome.runtime.getURL(""))) return "own";   // своя страница (приветствие)
  return /^https?:/i.test(url) && !WEBSTORE.test(url) ? "web" : "closed";
}

// quiet — при открытии окна: без адреса это может быть и служебная страница, поэтому не красным.
function tabNotResponding(quiet) {
  const kind = tabKind(activeTab);
  els.reloadTab.hidden = kind === "own" || kind === "closed";
  if (kind === "own") { setPageMsg("", ""); return; }
  if (kind === "closed") { setPageMsg(NO_PAGE, "err"); return; }
  setPageMsg(HT_t(kind === "web" ? "tabReload" : "tabUnknown"), quiet ? "" : "err");
}

const pingTab = (tabId) => new Promise((resolve) => {
  chrome.tabs.sendMessage(tabId, { type: "getHudState" }, TOP_FRAME, (r) => resolve(!chrome.runtime.lastError && !!r));
});

// Обновить вкладку и дождаться content-скрипта: статус загрузки виден без разрешений, а скрипт
// запускается чуть позже (document_idle) — после «complete» даём ему до 2 с.
async function reloadAndPing(tabId) {
  try { await chrome.tabs.reload(tabId); } catch (e) { return false; }
  let completeAt = 0;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    let t;
    try { t = await chrome.tabs.get(tabId); } catch (e) { return false; }
    if (t.status !== "complete") { completeAt = 0; continue; }
    if (await pingTab(tabId)) return true;
    if (!completeAt) completeAt = Date.now();
    else if (Date.now() - completeAt > 2000) return false;
  }
  return false;
}

els.reloadTab.addEventListener("click", async () => {
  if (!activeTab || activeTab.id == null) return;
  els.reloadTab.disabled = true;
  setPageMsg(HT_t("tabReloading"), "");
  const ok = await reloadAndPing(activeTab.id);
  els.reloadTab.disabled = false;
  els.reloadTab.hidden = true;
  if (ok) { setPageMsg(HT_t("tabReloaded"), "ok"); refreshTabState(); }
  else setPageMsg(NO_PAGE, "err");
});

// true, если content-скрипт получил команду.
const sendToTab = (type) => askTab(type, (resp, failed) => !failed);
// Ответ content-скрипта или null, если страница недоступна.
const queryTab = (type) => askTab(type, (resp, failed) => (failed ? null : resp));

// ---- загрузка ----
chrome.storage.local.get(DEFAULTS, (s) => {
  // Неизвестное значение <select> не выберет (value станет ""), и первое же сохранение записало
  // бы пустую строку — сверяем с таблицами shared.js заранее.
  HT_validAll(s);
  consent = HT_consent(s.consent);
  keyVerified = s.keyVerified === true;
  llmVerified = s.llmVerified === true;
  setEnabledUI(s.enabled);
  els.apiKey.value = s.apiKey;
  els.targetLang.value = s.targetLang;
  shownLang = s.targetLang;
  els.sourceLang.value = s.sourceLang;
  setRadio("trigger", s.trigger);
  els.dwellMs.value = HT_clampDwell(s.dwellMs);
  setRadio("engine", s.engine);
  els.displayMode.value = s.displayMode === "inline" ? "replace" : s.displayMode; // режим «строка» убран → замена
  els.showLangBadge.checked = s.showLangBadge;
  els.formality.value = s.formality;
  els.noTranslate.value = s.noTranslate;
  els.llmProvider.value = s.llmProvider;
  els.llmApiKey.value = s.llmApiKey;
  setModelUI(s.llmProvider, typeof s.llmModel === "string" ? s.llmModel.trim() : "");
  if (keyVerified && s.apiKey) setStatus(HT_t("keyWorks"), "ok");
  if (llmVerified && s.llmApiKey) setLlmStatus(HT_t("keyWorks"), "ok");
  els.dispMode.value = s.dispMode;
  els.dispBg.value = s.dispBg;
  els.dispOpacity.value = s.dispOpacity;
  els.dispBorder.checked = s.dispBorder;
  els.dispBorderColor.value = s.dispBorderColor;
  els.dispBorderStyle.value = s.dispBorderStyle;
  recent = Array.isArray(s.recentLangs) ? s.recentLangs.filter((c) => LANG_LABEL[c]) : [];
  updateTrigger();
  updateDwell();
  updateDispVisibility();
  updateEngineVisibility();
  renderRecent();
  builtinUi = HT_builtin.mount(els.builtinBox, () => els.targetLang.value, (state) => {
    builtinState = state;
    updateEngineVisibility();
  });
  // Остаток DeepL — только для DeepL/«авто» и только после согласия: само по себе окно ничего не
  // отправляет, пока человек не разрешил (проверка ключа по его действию — можно и до согласия).
  if (HT_engine(s.engine).keyField === "apiKey" && s.apiKey && HT_agreed(consent, "deepl")) fetchQuota();
  if (HT_engine(s.engine).via !== "local") fetchStats();
});

// ---- вкладка: мини-панель и «Переводить на этом сайте» ----
// Нажатость кнопки мини-панели — по фактическому состоянию панели на активной вкладке, и имя её
// сайта. Заодно узнаём, есть ли на вкладке content-скрипт: нет — сразу подсказываем обновить вкладку.
function applyTabState(r) {
  setHudUI(r && r.hud);
  site = r && typeof r.site === "string" && HT_isSite(r.site) ? { name: r.site, off: !!r.siteOff } : null;
  els.siteRow.hidden = !site;            // страница без имени сайта (файл, служебная) — выключать нечего
  if (site) { els.siteName.textContent = site.name; els.siteName.title = site.name; els.siteOn.checked = !site.off; }
}
function refreshTabState() {
  return queryTab("getHudState").then((r) => { applyTabState(r); if (!r) tabNotResponding(true); });
}
refreshTabState();

// Список общий с мини-панелью на страницах — читаем свежий перед записью.
els.siteOn.addEventListener("change", async () => {
  if (!site) return;
  const off = !els.siteOn.checked;
  let list = [];
  try { list = HT_sites((await chrome.storage.local.get({ disabledSites: [] })).disabledSites); } catch (e) { /* пустой */ }
  list = list.filter((x) => x !== site.name);
  if (off) list.push(site.name);
  try { await chrome.storage.local.set({ disabledSites: list.slice(-HT_SITES_MAX) }); }
  catch (e) { els.siteOn.checked = !off; setPageMsg(HT_t("notSaved", STORE_FULL), "err"); return; }
  site.off = off;
  setPageMsg(off ? HT_t("siteOffNow") : "", "");
  if (off) setHudUI(false);
});

// ---- горячие клавиши ----
// Их можно сменить или снять на chrome://extensions/shortcuts; если сочетание занято другим
// расширением, Chrome его не назначает — тогда пишем «не назначено».
const KEYS_URL = "chrome://extensions/shortcuts";
function renderKeys() {
  const item = (k, what) => {
    const li = document.createElement("li");
    const key = document.createElement(k ? "kbd" : "span");
    key.textContent = k || HT_t("keyNotSet");
    if (!k) key.className = "muted";
    li.append(key, " — " + what);
    return li;
  };
  els.keysText.textContent = "";
  els.keysText.append(
    item(keys.toggle, HT_t("keysToggle")),
    item(keys.page, HT_t("keysPage")),
    item("Esc", HT_t("keysEsc")),
  );
  setEnabledUI(enabledOn);
  els.translatePage.title = keys.page ? HT_t("hotkeyTip", keys.page) : "";
}
if (chrome.commands && chrome.commands.getAll) {
  chrome.commands.getAll().then((all) => {
    for (const c of all) {
      if (c.name === "toggle-enabled") keys.toggle = c.shortcut || "";
      if (c.name === "translate-page") keys.page = c.shortcut || "";
    }
    renderKeys();
  }).catch(renderKeys);
} else renderKeys();
els.keysEdit.addEventListener("click", () => { chrome.tabs.create({ url: KEYS_URL }).catch(() => {}); });

// ---- автосохранение ----
// 'change' — сразу; 'input' (непрерывные: ползунки, выбор цвета, поля ввода) — с задержкой, иначе
// каждый шаг пишет весь объект настроек в storage.local (квота записей в минуту) и будит onChanged
// в content.js (сравнение и перерисовка) десятки раз за одно перетаскивание.
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }
// Подстраховка: при потере фокуса полем (в т.ч. перед закрытием окна) сбрасываем отложенную запись.
addEventListener("blur", () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save(); } }, true);
["change", "input"].forEach((ev) => {
  const handler = ev === "input" ? saveSoon : save;
  [els.trigger, els.dwellMs, els.engine, els.sourceLang, els.formality, els.noTranslate,
   els.displayMode, els.showLangBadge, els.llmModelSel, els.llmModel,
   els.dispMode, els.dispBg, els.dispOpacity, els.dispBorder, els.dispBorderColor, els.dispBorderStyle]
    .forEach((el) => el.addEventListener(ev, handler));
});
els.enabled.addEventListener("click", () => {
  setEnabledUI(!enabledOn);
  if (enabledOn && offMsg) setPageMsg("", "");
  save();
});
els.trigger.addEventListener("change", updateTrigger);
els.dwellMs.addEventListener("input", updateDwell);

function onEngineChange() {
  updateEngineVisibility();
  const v = engineValue();
  if (HT_engine(v).via === "local") { renderQuota(null); els.stats.textContent = ""; }
  else {
    if (els.apiKey.value.trim() && HT_engine(v).keyField === "apiKey" && HT_agreed(consent, "deepl")) fetchQuota();
    fetchStats();
  }
}
els.engine.addEventListener("change", onEngineChange);

els.llmProvider.addEventListener("change", () => {
  // Модель другого сервиса здесь не подойдёт — возвращаем «по умолчанию»; ключ — тоже другой.
  setModelUI(els.llmProvider.value, "");
  llmVerified = false;
  setLlmStatus("", "");
  chrome.storage.local.set({ llmVerified: false }).catch(() => {});
  save();
  updateEngineVisibility();
});
els.llmModelSel.addEventListener("change", () => {
  const other = els.llmModelSel.value === OTHER_MODEL;
  els.llmModel.hidden = !other;
  if (other) els.llmModel.focus();
  llmVerified = false;
  setLlmStatus("", "");
  chrome.storage.local.set({ llmVerified: false }).catch(() => {});
  updateQualitySum();
});
els.dispMode.addEventListener("change", updateDispVisibility);
els.displayMode.addEventListener("change", updateDispVisibility);
els.dispOpacity.addEventListener("input", updateDispVisibility);
els.dispBorder.addEventListener("change", updateDispVisibility);
els.targetLang.addEventListener("change", () => setTargetLang(els.targetLang.value));
els.sourceLang.addEventListener("change", updateEngineVisibility);   // переводчик может не знать этот язык

// ---- ключ DeepL ----
els.apiKey.addEventListener("input", (e) => {
  saveSoon();                          // запись всего объекта — с задержкой; отметку о проверке — сразу
  keyVerified = false;
  setStatus("", "");
  renderQuota(null);
  updateSetup();
  updateQualitySum();
  chrome.storage.local.set({ keyVerified: false }).catch(() => {});
  if (pasted(e)) checkDeepl();
});
els.apiKey.addEventListener("keydown", (e) => { if (e.key === "Enter") checkDeepl(); });
els.check.addEventListener("click", checkDeepl);

// ---- ключ ИИ ----
els.llmApiKey.addEventListener("input", (e) => {
  saveSoon();
  llmVerified = false;
  setLlmStatus("", "");
  updateSetup();
  updateQualitySum();
  chrome.storage.local.set({ llmVerified: false }).catch(() => {});
  if (pasted(e)) checkLlm();
});
els.llmApiKey.addEventListener("keydown", (e) => { if (e.key === "Enter") checkLlm(); });
els.llmCheck.addEventListener("click", checkLlm);

function bindReveal(btn, input) {
  btn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.classList.toggle("on", reveal);
    btn.setAttribute("aria-pressed", String(reveal));
    setTip(btn, HT_t(reveal ? "hideKey" : "showKey"));
  });
}
bindReveal(els.toggleKey, els.apiKey);
bindReveal(els.toggleLlmKey, els.llmApiKey);

// ---- действия со страницей ----
els.translatePage.addEventListener("click", async () => {
  if (!enabledOn) { setPageMsg(HT_t("offTurnOn"), "err", true); return; }
  if (site && site.off) { setPageMsg(HT_t("siteOffCheck"), "err"); return; }
  setPageMsg("", "");
  if (!(await save())) return;      // настройки не записались — сообщение уже показано, не закрываемся
  const ok = await sendToTab("translatePage");
  if (ok) window.close();           // закрываем окно, чтобы видеть страницу
  else tabNotResponding(false);
});
els.resetPage.addEventListener("click", async () => {
  const ok = await askTab("restoreAll", (resp, failed) => !failed, {});
  if (ok) setPageMsg("", ""); else tabNotResponding(false);
});
els.hudBtn.addEventListener("click", async () => {
  setPageMsg("", "");
  if (site && site.off) { setPageMsg(HT_t("siteOffHud"), "err"); return; }
  if (!(await save())) return;
  const r = await queryTab("toggleHud");
  if (r && r.ok) { applyTabState(r); setPageMsg("", ""); } // кнопка нажата, пока панель показана; окно не закрываем
  else tabNotResponding(false);
});

// ---- сохранённые переводы (заодно обнуляет статистику расхода) ----
els.clearCache.addEventListener("click", async () => {
  els.clearCache.disabled = true;
  els.cacheMsg.textContent = HT_t("deleting");
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "clearCache" }); } catch (e) { r = null; }
  if (r && r.ok) {
    try { await chrome.runtime.sendMessage({ type: "resetStats" }); } catch (e) { /* игнор */ }
    fetchStats(); // показываем обнулённые счётчики
  }
  els.clearCache.disabled = false;
  els.cacheMsg.textContent = HT_t(r && r.ok ? "deleted" : "tryAgainFailed");
  setTimeout(() => { els.cacheMsg.textContent = ""; }, 2500);
});
