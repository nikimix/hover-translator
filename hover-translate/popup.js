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
  pageMsg: $("pageMsg"), clearCache: $("clearCache"), cacheMsg: $("cacheMsg"),
  statsRow: $("statsRow"), stats: $("stats"),
  targetLang: $("targetLang"), recentLangs: $("recentLangs"), sourceLang: $("sourceLang"),
  formalityField: $("formalityField"), formality: $("formality"), formalityNote: $("formalityNote"),
  engine: $("engine"), engineNote: $("engineNote"), cacheRow: $("cacheRow"),
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
};

const nf = new Intl.NumberFormat("ru-RU");
const CHECK_FAIL = "Не удалось проверить ключ";
const NO_PAGE = "Эта страница недоступна";
let recent = [];
let enabledOn = true;

// Списки языков и движков строим из общих таблиц shared.js, а не держим третьей копией в
// разметке — раньше они разъезжались (у исходного «PT» не было английского имени для промпта
// LLM). Заполняем СИНХРОННО, до чтения настроек: ниже им присваивается сохранённое значение.
HT_fillSelect(els.targetLang, HT_TARGET_LANGS);
HT_fillSelect(els.sourceLang, HT_SOURCE_LANGS);
HT_fillSelect(els.engine, HT_ENGINES);

// Иконка-переключатель «перевод вкл/выкл».
function setEnabledUI(on) {
  enabledOn = on;
  els.enabled.classList.toggle("active", on);
  setTip(els.enabled, on ? "Перевод включён — выключить" : "Перевод выключен — включить");
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
  els.engineNote.style.display = e.note ? "" : "none";
}

function updateDispVisibility() {
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
function askTab(type, map) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || tab.id == null) return resolve(map(null, true));
      chrome.tabs.sendMessage(tab.id, { type }, TOP_FRAME, (resp) => resolve(map(resp, !!chrome.runtime.lastError)));
    });
  });
}

// true, если content-скрипт получил команду.
const sendToTab = (type) => askTab(type, (resp, failed) => !failed);
// Ответ content-скрипта или null, если страница недоступна.
const queryTab = (type) => askTab(type, (resp, failed) => (failed ? null : resp));

// ---- загрузка ----
chrome.storage.local.get(DEFAULTS, (s) => {
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
  if (usesDeepl(s.engine) && s.apiKey) fetchQuota(); // квота DeepL — только для DeepL/auto
  if (HT_engine(s.engine).via !== "local") fetchStats();
});

// Подсветка кнопки HUD по фактическому состоянию панели на активной вкладке.
queryTab("getHudState").then((r) => setHudUI(r && r.hud));

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
els.dispOpacity.addEventListener("input", updateDispVisibility);
els.dispBorder.addEventListener("change", updateDispVisibility);

els.targetLang.addEventListener("change", () => {
  pushRecent(els.targetLang.value);
  save();
  renderRecent();
});

// ---- ключ DeepL ----
els.apiKey.addEventListener("input", () => {
  saveSoon(); // дебаунс полного объекта; флаги пишем сразу (2 ключа)
  setVerified(false);
  setStatus("", "");
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
    setStatus(r.error || CHECK_FAIL, "err");
    chrome.storage.local.set({ keyVerified: false });
  }
});

// ---- ключ LLM ----
els.llmApiKey.addEventListener("input", () => {
  saveSoon(); // дебаунс полного объекта; флаг пишем сразу
  setLlmVerified(false);
  setLlmStatus("", "");
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
    setLlmStatus(r.error || CHECK_FAIL, "err");
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
  setPageMsg("", "");
  if (!(await save())) return;      // настройки не записались — сообщение уже показано, не закрываемся
  const ok = await sendToTab("translatePage");
  if (ok) window.close(); // закрываем popup, чтобы видеть страницу
  else setPageMsg(NO_PAGE + " для перевода", "err");
});
els.resetPage.addEventListener("click", async () => {
  const ok = await sendToTab("restoreAll");
  setPageMsg(ok ? "" : NO_PAGE, ok ? "" : "err");
});
els.hudBtn.addEventListener("click", async () => {
  setPageMsg("", "");
  if (!(await save())) return;
  const r = await queryTab("toggleHud");
  if (r && r.ok) { setHudUI(r.hud); setPageMsg("", ""); } // подсвечиваем кнопку, popup не закрываем
  else setPageMsg(NO_PAGE, "err");
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
