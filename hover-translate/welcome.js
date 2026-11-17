// welcome.js — страница приветствия. Открывается один раз, при установке (background.js,
// runtime.onInstalled): язык перевода, подготовка встроенного переводчика, способ включения,
// абзац для пробы. Всё сохраняется сразу в chrome.storage.local — как из окна расширения.

const $ = (id) => document.getElementById(id);
const sel = $("targetLang");
const radios = Array.from(document.querySelectorAll('input[name="trigger"]'));
const MAC = HT_isMac();

let trigger = HT_DEFAULTS.trigger;
let engine = HT_DEFAULTS.engine;
let builtinState = "";
let builtinUi = null;

HT_fillSelect(sel, HT_TARGET_LANGS);
$("shiftName").textContent = "Клавишей " + HT_triggerKey("shift", MAC);

// Абзац для пробы — на английском, а если переводим на английский — на русском. Подсказка под ним
// говорит, что сделать сейчас: подготовить переводчик или навести курсор выбранным способом.
function renderTrainer() {
  const toEnglish = HT_langBase(sel.value) === "en";
  $("trainerEn").hidden = toEnglish;
  $("trainerRu").hidden = !toEnglish;
  for (const r of radios) r.checked = r.value === trigger;

  const key = HT_triggerKey(trigger, MAC);
  const how = trigger === "dwell"
    ? "Задержите курсор на абзаце выше. Уберёте курсор — вернётся оригинал."
    : `Наведите курсор на абзац выше, нажмите и отпустите ${key}. Нажмёте ещё раз — вернётся оригинал.`;
  // Подзаголовок — тем способом, который сейчас выбран (его могли сменить и в окне расширения).
  $("heroText").textContent = (trigger === "dwell"
    ? "Задержите курсор на абзаце — он переведётся прямо на странице."
    : `Наведите курсор на абзац и нажмите ${key} — он переведётся прямо на странице.`) +
    " Работает сразу: без ключей и регистрации.";
  // Состояние встроенного переводчика важно, только если перевод идёт через него.
  const usesBuiltin = HT_engine(engine).note;
  let before = "";
  if (usesBuiltin && builtinState === "need") before = "Сначала подготовьте переводчик (шаг 2). ";
  else if (usesBuiltin && builtinState === "pair-unavailable") before = "Сначала выберите другой язык (шаг 1). ";
  else if (usesBuiltin && builtinState === "none") before = "Встроенный переводчик в этом браузере недоступен — подключите DeepL (см. ниже). ";
  $("trainerHint").textContent = before + how;
}

// Горячие клавиши (их можно сменить на chrome://extensions/shortcuts) и Esc.
function renderKeys(all) {
  const k = (name) => { const c = (all || []).find((x) => x.name === name); return (c && c.shortcut) || ""; };
  const parts = ["Esc возвращает оригинал везде на странице."];
  if (k("toggle-enabled")) parts.push(`${k("toggle-enabled")} — включить или выключить перевод.`);
  if (k("translate-page")) parts.push(`${k("translate-page")} — перевести страницу целиком.`);
  parts.push("Сочетания можно сменить на странице chrome://extensions/shortcuts.");
  $("keysHint").textContent = parts.join(" ");
}
renderKeys([]);
if (chrome.commands && chrome.commands.getAll) chrome.commands.getAll().then(renderKeys).catch(() => {});

chrome.storage.local.get({ targetLang: HT_DEFAULTS.targetLang, trigger: HT_DEFAULTS.trigger, engine: HT_DEFAULTS.engine }, (s) => {
  HT_validAll(s);
  sel.value = s.targetLang;
  trigger = s.trigger;
  engine = s.engine;
  builtinUi = HT_builtin.mount($("builtinBox"), () => sel.value, (state) => { builtinState = state; renderTrainer(); });
  renderTrainer();
});

sel.addEventListener("change", () => {
  chrome.storage.local.set({ targetLang: sel.value }).catch(() => {});
  if (builtinUi) builtinUi.refresh();   // пара «английский → язык» сменилась
  renderTrainer();
});

for (const r of radios) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    trigger = r.value;
    chrome.storage.local.set({ trigger }).catch(() => {});
    renderTrainer();
  });
}

// Настройки могли поменять и в окне расширения, пока страница открыта.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let changed = false;
  if (changes.targetLang) {
    const v = HT_valid("targetLang", changes.targetLang.newValue);
    if (v !== sel.value) { sel.value = v; if (builtinUi) builtinUi.refresh(); }
    changed = true;
  }
  if (changes.trigger) { trigger = HT_valid("trigger", changes.trigger.newValue); changed = true; }
  if (changes.engine) { engine = HT_valid("engine", changes.engine.newValue); changed = true; }
  if (changed) renderTrainer();
});
