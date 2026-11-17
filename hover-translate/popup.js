// popup.js — настройки расширения. Всё хранится в chrome.storage.local
// и подхватывается content.js/background.js на лету.

// Общие с content.js значения берём из shared.js (раньше все 18 лежали здесь второй посимвольно
// совпадающей копией), к ним добавляем то, что нужно только popup: ключи и состояние раскрытых
// блоков.
const DEFAULTS = Object.assign({}, HT_DEFAULTS, {
  apiKey: "", keyVerified: false, keyCollapsed: false,
  llmApiKey: "", llmVerified: false, llmCollapsed: true,
  noTrCollapsed: true, dispCollapsed: true,
  recentLangs: [],
});

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  translatePage: $("translatePage"),
  hudBtn: $("hudBtn"),
  resetPage: $("resetPage"),
  keyBlock: $("keyBlock"), keyHeader: $("keyHeader"), keyState: $("keyState"),
  apiKey: $("apiKey"), toggleKey: $("toggleKey"), check: $("check"), status: $("status"), quota: $("quota"),
  pageMsg: $("pageMsg"), reloadTab: $("reloadTab"), clearCache: $("clearCache"), cacheMsg: $("cacheMsg"),
  setup: $("setup"), setupText: $("setupText"), setupFix: $("setupFix"), setupLink: $("setupLink"),
  statsRow: $("statsRow"), stats: $("stats"),
  targetLang: $("targetLang"), recentLangs: $("recentLangs"), sourceLang: $("sourceLang"),
  formalityField: $("formalityField"), formality: $("formality"), formalityNote: $("formalityNote"),
  engine: $("engine"), builtinBox: $("builtinBox"), cacheRow: $("cacheRow"),
  llmBlock: $("llmBlock"), llmHeader: $("llmHeader"), llmState: $("llmState"),
  llmProvider: $("llmProvider"), llmApiKey: $("llmApiKey"), toggleLlmKey: $("toggleLlmKey"),
  llmCheck: $("llmCheck"), llmModel: $("llmModel"), llmStatus: $("llmStatus"),
  trigger: $("trigger"), dwellField: $("dwellField"), dwellMs: $("dwellMs"),
  dispBlock: $("dispBlock"), dispHeader: $("dispHeader"),
  displayMode: $("displayMode"), showLangBadge: $("showLangBadge"),
  dispMode: $("dispMode"), dispCustom: $("dispCustom"),
  dispBg: $("dispBg"), dispOpacity: $("dispOpacity"), dispOpacityVal: $("dispOpacityVal"),
  dispBorder: $("dispBorder"), dispBorderColor: $("dispBorderColor"), dispBorderStyle: $("dispBorderStyle"),
  borderControls: $("borderControls"),
  noTrBlock: $("noTrBlock"), noTrHeader: $("noTrHeader"), noTranslate: $("noTranslate"),
  siteRow: $("siteRow"), siteOn: $("siteOn"), siteName: $("siteName"), badgeRow: $("badgeRow"),
  keysText: $("keysText"), keysEdit: $("keysEdit"),
};

const nf = new Intl.NumberFormat("ru-RU");
const CHECK_FAIL = "Не удалось проверить ключ";
const NO_PAGE = "На этой странице расширения не работают — это служебная страница Chrome или магазин расширений.";
let recent = [];
let enabledOn = true;
let builtinUi = null;                 // блок встроенного переводчика (builtin.js)
let site = null;                      // { name, off } — сайт активной вкладки (от её content-скрипта)
const keys = { toggle: "", page: "" };  // сочетания клавиш команд (chrome.commands)

// Списки языков и движков строим из общих таблиц shared.js, а не держим третьей копией в
// разметке — раньше они разъезжались (у исходного «PT» не было английского имени для промпта
// LLM). Заполняем СИНХРОННО, до чтения настроек: ниже им присваивается сохранённое значение.
HT_fillSelect(els.targetLang, HT_TARGET_LANGS);
HT_fillSelect(els.sourceLang, HT_SOURCE_LANGS);
HT_fillSelect(els.engine, HT_ENGINES);

// Сочетание клавиш в подсказке кнопки: « (Alt+Shift+O)».
function keyTip(k) { return k ? ` (${k})` : ""; }

// Иконка-переключатель «перевод вкл/выкл».
function setEnabledUI(on) {
  enabledOn = on;
  els.enabled.classList.toggle("active", on);
  setTip(els.enabled, (on ? "Перевод включён — выключить" : "Перевод выключен — включить") + keyTip(keys.toggle));
}

// Иконка «языковая панель на странице»: подсвечена, пока панель показана (на активной вкладке).
function setHudUI(on) {
  els.hudBtn.classList.toggle("active", !!on);
  setTip(els.hudBtn, on ? "Языковая панель показана — скрыть" : "Языковая панель на странице");
}

// ---- общие ----
// Три строки состояния (DeepL, LLM, страница) и две галочки «ключ проверен» отличались только
// элементом — держим по одному хелперу на вид.
function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}
const setStatus = (text, kind) => setMsg(els.status, text, kind);
const setLlmStatus = (text, kind) => setMsg(els.llmStatus, text, kind);
const setPageMsg = (text, kind) => setMsg(els.pageMsg, text, kind);

function setKeyState(el, v) {
  el.textContent = v ? "✓" : "";
  el.className = "key-state" + (v ? " ok" : "");
}
const setVerified = (v) => setKeyState(els.keyState, v);
const setLlmVerified = (v) => setKeyState(els.llmState, v);

// Подпись иконки: title и aria-label всегда ставятся вместе.
function setTip(el, text) {
  el.title = text;
  el.setAttribute("aria-label", text);
}

function collapse(block, collapsed) { block.classList.toggle("collapsed", collapsed); }

// Спросить background, заблокировав кнопку на время запроса. Всегда возвращает объект, поэтому
// вызывающим не нужно повторять проверку `r && r.ok`.
async function ask(btn, type) {
  btn.disabled = true;
  try { return (await chrome.runtime.sendMessage({ type })) || { ok: false, error: CHECK_FAIL }; }
  catch (e) { return { ok: false, error: (e && e.message) || CHECK_FAIL }; }
  finally { btn.disabled = false; }
}

function save() {
  // storage.local делит квоту с кэшем переводов (L3), поэтому set() может РЕДЖЕКТИТЬСЯ. Без
  // catch это валило весь обработчик, из которого save() вызван: `await save()` бросал, до
  // sendToTab дело не доходило — кнопка «Перевести страницу» молча не срабатывала, а введённый
  // ключ и смена языка терялись, хотя UI показывал новое значение.
  return chrome.storage.local.set({
    enabled: enabledOn,
    apiKey: els.apiKey.value.trim(),
    targetLang: els.targetLang.value,
    sourceLang: els.sourceLang.value,
    trigger: els.trigger.value,
    dwellMs: HT_clampDwell(els.dwellMs.value),
    engine: els.engine.value,
    displayMode: els.displayMode.value,
    showLangBadge: els.showLangBadge.checked,
    formality: els.formality.value,
    noTranslate: els.noTranslate.value,
    llmProvider: els.llmProvider.value,
    llmApiKey: els.llmApiKey.value.trim(),
    llmModel: els.llmModel.value.trim(),
    dispMode: els.dispMode.value,
    dispBg: els.dispBg.value,
    dispOpacity: Number(els.dispOpacity.value),
    dispBorder: els.dispBorder.checked,
    dispBorderColor: els.dispBorderColor.value,
    dispBorderStyle: els.dispBorderStyle.value,
    recentLangs: recent,
  }).then(() => true).catch((e) => {
    setPageMsg("Настройки не сохранены: " + ((e && e.message) || "хранилище переполнено") +
      ". Нажмите «Очистить кэш».", "err");
    return false;
  });
}

// Что показывать для выбранного движка — из его описания в shared.js, а не из сравнений с
// именами: иначе добавление движка требует правок в нескольких местах и промах молчаливый.
function usesDeepl(engine) { return HT_engine(engine).keyField === "apiKey"; }

// ---- видимость зависимых полей ----
function updateDwellVisibility() { els.dwellField.style.display = els.trigger.value === "dwell" ? "" : "none"; }

function updateEngineVisibility() {
  const v = els.engine.value;
  const e = HT_engine(v);
  const isChrome = e.via === "local";
  const isLlm = e.keyField === "llmApiKey";
  const isDeepl = usesDeepl(v);
  els.keyBlock.style.display = isDeepl ? "" : "none";
  els.quota.style.display = isDeepl ? "" : "none";
  els.llmBlock.style.display = isLlm ? "" : "none";
  els.formalityField.style.display = isDeepl ? "" : "none";
  els.formalityNote.style.display = isDeepl ? "" : "none";
  els.cacheRow.style.display = isChrome ? "none" : "";   // кэш есть у deepl/auto/llm
  els.statsRow.style.display = isChrome ? "none" : "";
  els.builtinBox.style.display = e.note ? "" : "none";   // встроенный участвует в переводе
  updateSetup();
}

// ---- выбранный переводчик не может работать ----
// Та же проверка, по которой background ставит «!» на значке (shared.js), но по значениям в окне:
// подсказка меняется сразу, как вставили ключ или сменили переводчик.
const SETUP = {
  "no-deepl-key": "Перевод не работает: не задан ключ DeepL. Вставьте его ниже",
  "no-llm-key": "Перевод не работает: не задан ключ ИИ. Вставьте его ниже",
  "no-builtin": "Встроенный переводчик недоступен в этом браузере (нужен Chrome 138 или новее на компьютере). " +
    "Подключите DeepL по своему ключу — бесплатно 500 000 знаков в месяц.",
};
let setupFix = null;
function updateSetup() {
  const builtin = HT_builtin.hasApi();
  const p = HT_engineProblem(els.engine.value,
    { apiKey: !!els.apiKey.value.trim(), llmApiKey: !!els.llmApiKey.value.trim() }, builtin);
  els.setup.hidden = !p;
  if (!p) return;
  const keyMissing = p !== "no-builtin";
  els.setupText.textContent = SETUP[p] + (keyMissing ? (builtin
    ? " или включите встроенный переводчик — он бесплатный и работает без ключа."
    : ".") : "");
  // Что предложить одной кнопкой: без ключа — встроенный (если он есть), без встроенного — DeepL.
  setupFix = keyMissing ? (builtin ? "chrome" : null) : "deepl";
  els.setupFix.hidden = !setupFix;
  els.setupFix.textContent = setupFix === "chrome" ? "Включить встроенный переводчик" : "Выбрать DeepL";
  els.setupLink.hidden = p === "no-llm-key";
}

els.setupFix.addEventListener("click", () => {
  if (!setupFix) return;
  els.engine.value = setupFix;
  els.engine.dispatchEvent(new Event("change"));     // сохранение и видимость полей — как при выборе
  if (setupFix === "deepl") { collapse(els.keyBlock, false); els.apiKey.focus(); }
});

function updateDispVisibility() {
  // Исходный язык показывается только в карточке — при замене на месте галочка ни на что не влияет.
  els.badgeRow.hidden = els.displayMode.value !== "popover";
  els.dispCustom.style.display = els.dispMode.value === "custom" ? "" : "none";
  els.borderControls.style.display = els.dispBorder.checked ? "" : "none";
  els.dispOpacityVal.textContent = els.dispOpacity.value + "%";
}

// ---- недавние языки ----
function pushRecent(code) {
  recent = [code, ...recent.filter((c) => c !== code)].slice(0, 5);
}
function renderRecent() {
  els.recentLangs.textContent = "";
  for (const code of recent) {
    const b = document.createElement("button");
    b.className = "chip" + (code === els.targetLang.value ? " active" : "");
    b.textContent = code;
    b.addEventListener("click", () => {
      els.targetLang.value = code;
      pushRecent(code);
      save();
      renderRecent();
      if (builtinUi) builtinUi.refresh();   // пара «английский → язык» сменилась
    });
    els.recentLangs.appendChild(b);
  }
}

// ---- квота ----
function renderQuota(r) {
  if (!r || !r.ok || typeof r.limit !== "number") { els.quota.textContent = ""; els.quota.className = "quota"; return; }
  const remaining = Math.max(0, r.limit - r.used);
  els.quota.textContent = `DeepL: осталось ${nf.format(remaining)} из ${nf.format(r.limit)} символов`;
  els.quota.className = "quota" + (remaining < r.limit * 0.1 ? " warn" : "");
}
// Ошибка проверки ключа. В самом окне «проверьте его в окне расширения» звучало бы странно.
function checkError(r) {
  if (r.code === "bad-key") return "Ключ не подошёл — проверьте, что он скопирован целиком." + (r.detail ? ` (${r.detail})` : "");
  return (r.error || CHECK_FAIL) + (r.detail ? ` (${r.detail})` : "");
}

async function fetchQuota() {
  if (!els.apiKey.value.trim()) { renderQuota(null); return; }
  try { renderQuota(await chrome.runtime.sendMessage({ type: "checkUsage" })); } catch (e) { renderQuota(null); }
}

// ---- статистика расхода ----
async function fetchStats() {
  if (HT_engine(els.engine.value).via === "local") { els.stats.textContent = ""; return; }
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "getStats" }); } catch (e) { r = null; }
  if (!r || !r.ok) { els.stats.textContent = ""; return; }
  els.stats.textContent = `Переведено: ${nf.format(r.chars)} симв · из кэша: ${nf.format(r.hits)} (≈${nf.format(r.saved)} симв)`;
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
  setPageMsg(kind === "web"
    ? "Обновите вкладку, чтобы перевод заработал."
    : "Перевод на этой вкладке пока не работает. Если это обычный сайт — обновите вкладку.", quiet ? "" : "err");
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
  setPageMsg("Обновляю вкладку…", "");
  const ok = await reloadAndPing(activeTab.id);
  els.reloadTab.disabled = false;
  els.reloadTab.hidden = true;
  if (ok) { setPageMsg("Готово — перевод на этой вкладке работает.", "ok"); refreshTabState(); }
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
  setEnabledUI(s.enabled);
  els.apiKey.value = s.apiKey;
  els.targetLang.value = s.targetLang;
  els.sourceLang.value = s.sourceLang;
  els.trigger.value = s.trigger;
  els.dwellMs.value = s.dwellMs;
  els.engine.value = s.engine;
  els.displayMode.value = s.displayMode === "inline" ? "replace" : s.displayMode; // режим «строка» убран → замена
  els.showLangBadge.checked = s.showLangBadge;
  els.formality.value = s.formality;
  els.noTranslate.value = s.noTranslate;
  els.llmProvider.value = s.llmProvider;
  els.llmApiKey.value = s.llmApiKey;
  els.llmModel.value = s.llmModel;
  setVerified(s.keyVerified);
  setLlmVerified(s.llmVerified);
  collapse(els.keyBlock, s.keyCollapsed);
  collapse(els.llmBlock, s.llmCollapsed);
  collapse(els.noTrBlock, s.noTrCollapsed);
  els.dispMode.value = s.dispMode;
  els.dispBg.value = s.dispBg;
  els.dispOpacity.value = s.dispOpacity;
  els.dispBorder.checked = s.dispBorder;
  els.dispBorderColor.value = s.dispBorderColor;
  els.dispBorderStyle.value = s.dispBorderStyle;
  collapse(els.dispBlock, s.dispCollapsed);
  recent = Array.isArray(s.recentLangs) ? s.recentLangs : [];
  updateDwellVisibility();
  updateDispVisibility();
  updateEngineVisibility();
  renderRecent();
  builtinUi = HT_builtin.mount(els.builtinBox, () => els.targetLang.value);
  if (usesDeepl(s.engine) && s.apiKey) fetchQuota(); // квота DeepL — только для DeepL/auto
  if (HT_engine(s.engine).via !== "local") fetchStats();
});

// ---- вкладка: мини-панель и «Переводить на этом сайте» ----
// Подсветка кнопки HUD по фактическому состоянию панели на активной вкладке и имя её сайта. Заодно
// узнаём, есть ли на вкладке content-скрипт: нет — сразу подсказываем обновить вкладку.
function applyTabState(r) {
  setHudUI(r && r.hud);
  site = r && typeof r.site === "string" && HT_isSite(r.site) ? { name: r.site, off: !!r.siteOff } : null;
  els.siteRow.hidden = !site;            // страница без имени сайта (файл, служебная) — выключать нечего
  if (site) { els.siteName.textContent = site.name; els.siteOn.checked = !site.off; }
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
  catch (e) { els.siteOn.checked = !off; setPageMsg("Не удалось сохранить: хранилище переполнено. Нажмите «Очистить кэш».", "err"); return; }
  site.off = off;
  setPageMsg(off ? "На этом сайте перевод выключен: ни наведения, ни клавиши, ни панели." : "", "");
  if (off) setHudUI(false);
});

// ---- горячие клавиши ----
// Их можно сменить или снять на chrome://extensions/shortcuts; если сочетание занято другим
// расширением, Chrome его не назначает — тогда пишем «не назначено».
const KEYS_URL = "chrome://extensions/shortcuts";
function renderKeys() {
  const part = (k, what) => {
    const span = document.createElement("span");
    if (k) { const kbd = document.createElement("kbd"); kbd.textContent = k; span.append(kbd, " — " + what); }
    else span.textContent = what + ": сочетание не назначено";
    return span;
  };
  els.keysText.textContent = "";
  const esc = document.createElement("span");
  const kbd = document.createElement("kbd");
  kbd.textContent = "Esc";
  esc.append(kbd, " — вернуть оригинал");
  els.keysText.append(part(keys.toggle, "включить или выключить перевод"), "; ",
    part(keys.page, "перевести страницу"), "; ", esc, ".");
  setEnabledUI(enabledOn);
  setTip(els.translatePage, "Перевести страницу" + keyTip(keys.page));
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
// 'change' — сразу; 'input' (непрерывные: ползунок прозрачности, color-picker, textarea) — с
// дебаунсом, иначе каждый тик пишет весь объект настроек в storage.local (квота записей/мин) и
// будит onChanged в content.js (дифф + restyle) десятки раз за одно перетаскивание.
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }
// Подстраховка: при потере фокуса полем (в т.ч. перед закрытием popup) сбрасываем отложенную запись.
addEventListener("blur", () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save(); } }, true);
["change", "input"].forEach((ev) => {
  const handler = ev === "input" ? saveSoon : save;
  [els.trigger, els.dwellMs, els.engine, els.sourceLang, els.formality, els.noTranslate,
   els.displayMode, els.showLangBadge, els.llmProvider, els.llmModel,
   els.dispMode, els.dispBg, els.dispOpacity, els.dispBorder, els.dispBorderColor, els.dispBorderStyle]
    .forEach((el) => el.addEventListener(ev, handler));
});
els.enabled.addEventListener("click", () => { setEnabledUI(!enabledOn); save(); });
els.trigger.addEventListener("change", updateDwellVisibility);
els.engine.addEventListener("change", () => {
  updateEngineVisibility();
  if (HT_engine(els.engine.value).via === "local") { renderQuota(null); els.stats.textContent = ""; }
  else { if (els.apiKey.value.trim() && usesDeepl(els.engine.value)) fetchQuota(); fetchStats(); }
});
els.dispMode.addEventListener("change", updateDispVisibility);
els.displayMode.addEventListener("change", updateDispVisibility);
els.dispOpacity.addEventListener("input", updateDispVisibility);
els.dispBorder.addEventListener("change", updateDispVisibility);

els.targetLang.addEventListener("change", () => {
  pushRecent(els.targetLang.value);
  save();
  renderRecent();
  if (builtinUi) builtinUi.refresh();     // пара «английский → язык» сменилась
});

// ---- ключ DeepL ----
els.apiKey.addEventListener("input", () => {
  saveSoon(); // дебаунс полного объекта; флаги пишем сразу (2 ключа)
  setVerified(false);
  setStatus("", "");
  updateSetup();
  renderQuota(null);
  collapse(els.keyBlock, false);
  chrome.storage.local.set({ keyVerified: false, keyCollapsed: false });
});

els.check.addEventListener("click", async () => {
  if (!(await save())) return;      // иначе проверялся бы прежний ключ из storage
  setStatus("Проверяю…", "");
  const r = await ask(els.check, "checkUsage");
  if (r.ok) {
    setVerified(true);
    setStatus("", "");
    renderQuota(r);
    collapse(els.keyBlock, true);
    chrome.storage.local.set({ keyVerified: true, keyCollapsed: true });
  } else {
    setVerified(false);
    renderQuota(null);
    setStatus(checkError(r), "err");
    chrome.storage.local.set({ keyVerified: false });
  }
});

// ---- ключ LLM ----
els.llmApiKey.addEventListener("input", () => {
  saveSoon(); // дебаунс полного объекта; флаг пишем сразу
  setLlmVerified(false);
  setLlmStatus("", "");
  updateSetup();
  chrome.storage.local.set({ llmVerified: false });
});

els.llmCheck.addEventListener("click", async () => {
  if (!(await save())) return;      // иначе проверялся бы прежний ключ из storage
  setLlmStatus("Проверяю…", "");
  const r = await ask(els.llmCheck, "checkLlm");
  if (r.ok) {
    setLlmVerified(true);
    setLlmStatus("Ключ работает", "ok");
    collapse(els.llmBlock, true);
    chrome.storage.local.set({ llmVerified: true, llmCollapsed: true });
  } else {
    setLlmVerified(false);
    setLlmStatus(checkError(r), "err");
    chrome.storage.local.set({ llmVerified: false });
  }
});

// Четыре раскрывающихся блока и две кнопки-глаза различались только элементами.
function bindCollapse(header, block, key) {
  header.addEventListener("click", () => {
    const collapsed = !block.classList.contains("collapsed");
    collapse(block, collapsed);
    chrome.storage.local.set({ [key]: collapsed });
  });
}
bindCollapse(els.keyHeader, els.keyBlock, "keyCollapsed");
bindCollapse(els.llmHeader, els.llmBlock, "llmCollapsed");
bindCollapse(els.noTrHeader, els.noTrBlock, "noTrCollapsed");
bindCollapse(els.dispHeader, els.dispBlock, "dispCollapsed");

function bindReveal(btn, input) {
  btn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.classList.toggle("on", reveal);
    setTip(btn, reveal ? "Скрыть ключ" : "Показать ключ");
  });
}
bindReveal(els.toggleKey, els.apiKey);
bindReveal(els.toggleLlmKey, els.llmApiKey);

// ---- действия со страницей ----
els.translatePage.addEventListener("click", async () => {
  if (!enabledOn) { setPageMsg("Перевод выключен — включите ⏻", "err"); return; }
  if (site && site.off) { setPageMsg("На этом сайте перевод выключен — поставьте галочку «Переводить на сайте».", "err"); return; }
  setPageMsg("", "");
  if (!(await save())) return;      // настройки не записались — сообщение уже показано, не закрываемся
  const ok = await sendToTab("translatePage");
  if (ok) window.close(); // закрываем popup, чтобы видеть страницу
  else tabNotResponding(false);
});
els.resetPage.addEventListener("click", async () => {
  const ok = await askTab("restoreAll", (resp, failed) => !failed, {});
  if (ok) setPageMsg("", ""); else tabNotResponding(false);
});
els.hudBtn.addEventListener("click", async () => {
  setPageMsg("", "");
  if (site && site.off) { setPageMsg("На этом сайте перевод выключен — панель не показывается.", "err"); return; }
  if (!(await save())) return;
  const r = await queryTab("toggleHud");
  if (r && r.ok) { applyTabState(r); setPageMsg("", ""); } // подсвечиваем кнопку, popup не закрываем
  else tabNotResponding(false);
});

// ---- очистка кэша переводов (заодно обнуляет статистику расхода) ----
els.clearCache.addEventListener("click", async () => {
  els.clearCache.disabled = true;
  els.cacheMsg.textContent = "…";
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "clearCache" }); } catch (e) { r = null; }
  if (r && r.ok) {
    try { await chrome.runtime.sendMessage({ type: "resetStats" }); } catch (e) { /* игнор */ }
    fetchStats(); // показываем обнулённые счётчики
  }
  els.clearCache.disabled = false;
  els.cacheMsg.textContent = r && r.ok ? `Очищено: ${nf.format(r.cleared)}` : "Ошибка";
  setTimeout(() => { els.cacheMsg.textContent = ""; }, 2500);
});
