// welcome.js — страница приветствия. Открывается один раз, при установке (background.js,
// runtime.onInstalled): язык перевода, подготовка встроенного переводчика, способ включения,
// текст для пробы. Всё сохраняется сразу в chrome.storage.local — как из окна расширения.

HT_localize(document);   // статический текст разметки — из сообщений (_locales)

const $ = (id) => document.getElementById(id);
const sel = $("targetLang");
const radios = Array.from(document.querySelectorAll('input[name="trigger"]'));
const MAC = HT_isMac();

let trigger = HT_DEFAULTS.trigger;
let builtinState = "";
let builtinUi = null;
// Что нужно, чтобы понять, работает ли выбранный переводчик (HT_engineProblem): переводчик, ключи (только
// факт), сервис ИИ, согласие, язык оригинала. Переводчик выбирают в окне расширения, а не здесь.
const NET_KEYS = { engine: HT_DEFAULTS.engine, apiKey: "", llmApiKey: "", llmProvider: HT_DEFAULTS.llmProvider, consent: {}, sourceLang: HT_DEFAULTS.sourceLang };
let net = Object.assign({}, NET_KEYS);

HT_fillSelect(sel, HT_TARGET_LANGS);
$("shiftName").textContent = HT_t("shiftName", HT_triggerKey("shift", MAC));

// Текст для пробы — на языке, с которого готовится встроенный переводчик (HT_prepPair): обычно на
// английском, а если переводим на английский — на русском или испанском. Подсказка под ним говорит, что
// сделать сейчас: подготовить переводчик, вставить ключ, согласиться или навести курсор выбранным способом.
function renderTrainer() {
  const src = HT_prepPair(sel.value).src;
  for (const p of document.querySelectorAll(".trainer")) p.hidden = p.lang !== src;
  for (const r of radios) r.checked = r.value === trigger;

  const key = HT_triggerKey(trigger, MAC);
  const how = trigger === "dwell" ? HT_t("trainerDwell") : HT_t("trainerKey", key);
  // Подзаголовок — тем способом, который сейчас выбран (его могли сменить и в окне расширения).
  $("heroText").textContent = trigger === "dwell" ? HT_t("heroDwell") : HT_t("heroKey", key);

  // Выбранный переводчик не может работать — сначала об этом; иначе, если переводит встроенный, —
  // о его состоянии (скачать модели, нет пары языков).
  const engine = HT_valid("engine", net.engine);
  const st = {
    apiKey: !!net.apiKey, llmApiKey: !!net.llmApiKey, llmProvider: net.llmProvider, consent: net.consent,
    targetLang: sel.value, sourceLang: HT_valid("sourceLang", net.sourceLang),
  };
  const problem = HT_engineProblem(engine, st, HT_builtin.hasApi());
  const e = HT_engine(engine);
  const usesBuiltin = e.via === "local" || (e.fallback === "local" && !HT_canSend(engine, st));
  let text = "";
  if (problem === "no-deepl-key") text = HT_t("trainerNoDeeplKey", how);
  else if (problem === "no-llm-key") text = HT_t("trainerNoLlmKey", how);
  else if (problem === "no-consent") text = HT_t("trainerNoConsent", [HT_PROVIDER_NAMES[HT_provider(engine, st.llmProvider)], how]);
  else if (problem === "no-builtin" || (usesBuiltin && builtinState === "none")) text = HT_t("trainerNoBuiltin", how);
  else if (problem === "deepl-lang" || problem === "builtin-lang") text = HT_t("trainerLang", how);
  else if (usesBuiltin && builtinState === "need") text = HT_t("trainerPrep", how);
  else if (usesBuiltin && (builtinState === "pair-unavailable" || builtinState === "no-lang")) text = HT_t("trainerLang", how);
  $("trainerHint").textContent = text || how;
}

// Горячие клавиши (их можно сменить на chrome://extensions/shortcuts) и Esc.
function renderKeys(all) {
  const k = (name) => { const c = (all || []).find((x) => x.name === name); return (c && c.shortcut) || ""; };
  const parts = [HT_t("keysEscHint")];
  if (k("toggle-enabled")) parts.push(HT_t("keysToggleHint", k("toggle-enabled")));
  if (k("translate-page")) parts.push(HT_t("keysPageHint", k("translate-page")));
  parts.push(HT_t("keysChangeHint"));
  $("keysHint").textContent = parts.join(" ");
}
renderKeys([]);
if (chrome.commands && chrome.commands.getAll) chrome.commands.getAll().then(renderKeys).catch(() => {});

chrome.storage.local.get(Object.assign({ targetLang: HT_DEFAULTS.targetLang, trigger: HT_DEFAULTS.trigger }, NET_KEYS), (s) => {
  HT_validAll(s);
  sel.value = s.targetLang;
  trigger = s.trigger;
  for (const k in NET_KEYS) net[k] = s[k];
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
  for (const k in NET_KEYS) {
    if (!changes[k]) continue;
    net[k] = changes[k].newValue === undefined ? NET_KEYS[k] : changes[k].newValue;
    changed = true;
  }
  if (changed) renderTrainer();
});
