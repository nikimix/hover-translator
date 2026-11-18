// options.js — страница настроек (options_ui, open_in_tab). Всё сохраняется сразу в chrome.storage.local и
// подхватывается content.js, background.js и окном расширения на лету; изменения оттуда (окно, мини-панель,
// приветствие) страница тоже подхватывает (storage.onChanged).
//
// Переводчик. Выбор карточки DeepL, ИИ или «Авто» (без подключённого DeepL) раскрывает шаги «Согласие → Ключ →
// Готово», а сам переводчик (engine в хранилище) меняется только на «Готово»: согласие на этот сервис есть и ключ
// проверен. До этого под шагами — кто переводит сейчас («Пока переводит встроенный»), «Отмена» на шаге согласия
// возвращает прежнюю карточку. Выбранная карточка (ui.sel) поэтому может отличаться от переводчика (st.engine).
// Если переводчиком уже стоит DeepL или ИИ, а согласие отозвали или ключ стёрли, карточка показывает нужный шаг —
// без «Пока переводит…»: ничего другого и не переводит.
// ИИ: сервис, ключ и модель на карточке — черновик; в хранилище они попадают только после успешной проверки
// (checkLlm с {provider, key, model} проверяет переданное и ничего не пишет) и при согласии на этот сервис. До того
// переводит то, что записано.
//
// Фокус от окна расширения и уведомлений: background кладёт storage.session.htFocus = { to, at } и открывает эту
// страницу; к чему прокрутить и куда поставить фокус — applyFocus().

HT_localize(document);

const { h, ic } = HT_ui;
const $ = (id) => document.getElementById(id);
const MAC = HT_isMac();
const DEFAULTS = Object.assign({}, HT_DEFAULTS, {
  apiKey: "", keyVerified: false, llmApiKey: "", llmVerified: false, llmKeyBy: {},
  recentLangs: [], consent: {}, disabledSites: [],
});
const DEEPL_KEYS_URL = "https://www.deepl.com/your-account/keys";
const LLM_KEYS_URL = { openai: "https://platform.openai.com/api-keys", anthropic: "https://console.anthropic.com/settings/keys" };
const SERVICE = { deepl: "DeepL", openai: "OpenAI", anthropic: "Anthropic" };       // кому уходит текст
const AI_NAME = { openai: "ChatGPT", anthropic: "Claude" };                        // как называется в сегменте
const DEEPL_NO_LIMIT = 1e12;              // платный ключ без лимита: DeepL присылает 10^12
const LANG_LABEL = Object.fromEntries(HT_TARGET_LANGS);
const SECTIONS = ["translator", "page", "langs", "sites", "keys", "data"];

let st = null;                            // настройки (DEFAULTS + сохранённое)
const ui = {
  sel: "chrome",                          // выбранная карточка переводчика
  dl: { busy: false, err: null },         // проверка ключа DeepL: err = { code, text }
  llm: { busy: false, err: null },        // то же для ИИ
  quota: null, quotaBusy: false,          // остаток DeepL (ответ checkUsage)
  bi: { kind: "", src: "", tgt: "", busy: false, pct: null, fail: false, again: false },
  net: null,                              // storage.session.htNetErr — последний сбой сервиса
  keyEdited: { deepl: false, llm: false }, // ключ правили после этого сбоя — сбой уже не про него
  reveal: { deepl: false, llm: false },   // ключ показан открытым текстом
  modelOther: false,                      // выбрана «Другая…» модель
  // ИИ, ещё не проверенное: сервис в сегменте (если не тот, что записан), вставленные ключи по сервисам, модель.
  prov: null, llmDraft: {}, modelDraft: null,
  ver: 0,                                 // ключи сменились не здесь — перестроить поля
};

// ---------- запись ----------
// storage.local делит квоту с сохранёнными переводами — запись может не пройти; тогда говорим об этом наверху.
async function put(obj) {
  Object.assign(st, obj);
  try {
    await chrome.storage.local.set(obj);
    showSaveErr("");
    return true;
  } catch (e) {
    const why = e && e.message && !/quota/i.test(e.message) ? e.message : HT_t("opStoreFull");
    showSaveErr(HT_t("opNotSaved", why));
    return false;
  }
}
function showSaveErr(text) {
  const box = $("saveErr");
  box.hidden = !text;
  box.replaceChildren();
  if (text) box.append(ic("alert"), h("div", { class: "notice-b" }, h("p", { class: "notice-d" }, text)));
}
// Поля, которые меняются по букве (ключи, слова, ползунки), пишем с задержкой: иначе каждая буква будит
// storage.onChanged во всех вкладках. Пока запись ждёт, эхо прежнего значения из onChanged не применяем.
const pending = {};
function putSoon(k, v, ms) {
  st[k] = v;
  clearTimeout(pending[k]);
  pending[k] = setTimeout(() => { delete pending[k]; put({ [k]: v }); }, ms || 300);
}
// Записать отложенное сейчас.
function flush(k) {
  if (!pending[k]) return;
  clearTimeout(pending[k]);
  delete pending[k];
  put({ [k]: st[k] });
}
addEventListener("pagehide", () => { for (const k of Object.keys(pending)) flush(k); });

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

// ---------- состояние переводчиков ----------
const consentOf = (p) => HT_consent(st.consent)[p] === true;
function netBad(via, provider) {
  const n = ui.net;
  return !!n && n.code === "bad-key" && n.via === via && (via !== "llm" || n.provider === provider) && !ui.keyEdited[via];
}
// Шаг DeepL: "consent" | "key" | "error" (ключ не принят) | "ready".
function deeplStep() {
  if (!consentOf("deepl")) return "consent";
  if ((ui.dl.err && ui.dl.err.code === "bad-key") || netBad("deepl")) return "error";
  if (!st.apiKey || !st.keyVerified) return "key";
  return "ready";
}
// ИИ: сервис на карточке (выбранный в сегменте) и его ключ и модель.
const llmProv = () => ui.prov || st.llmProvider;
const pendingProv = () => !!ui.prov && ui.prov !== st.llmProvider;
const llmByOf = () => Object.assign({}, st.llmKeyBy && typeof st.llmKeyBy === "object" ? st.llmKeyBy : {});
// Записанный ключ сервиса p: у записанного сервиса — llmApiKey, у другого — из llmKeyBy.
function savedLlmKey(p) {
  if (p === st.llmProvider) return String(st.llmApiKey || "");
  const by = llmByOf();
  return typeof by[p] === "string" ? by[p] : "";
}
const llmKeyOf = (p) => (typeof ui.llmDraft[p] === "string" ? ui.llmDraft[p] : savedLlmKey(p));
const llmModelOf = (p) => String((ui.modelDraft != null ? ui.modelDraft : p === st.llmProvider ? st.llmModel : "") || "").trim();
// На карточке ИИ есть непроверенное: другой сервис, другой ключ или другая модель.
function llmDirty() {
  const p = llmProv();
  return pendingProv() || llmKeyOf(p).trim() !== savedLlmKey(p).trim() || (ui.modelDraft != null && ui.modelDraft !== String(st.llmModel || "").trim());
}
function llmStep() {
  const p = llmProv();
  if (!consentOf(p)) return "consent";
  if ((ui.llm.err && ui.llm.err.code === "bad-key") || netBad("llm", p)) return "error";
  if (llmDirty() || !st.llmApiKey || !st.llmVerified) return "key";
  return "ready";
}
// Работает ли ИИ так, как он записан в хранилище (а не как выбран на карточке).
const llmStoredReady = () => consentOf(st.llmProvider) && !!st.llmApiKey && st.llmVerified === true && !netBad("llm", st.llmProvider);
const deeplReady = () => deeplStep() === "ready";
const llmReady = () => llmStep() === "ready";
const builtinOk = () => HT_builtin.hasApi() && ui.bi.kind !== "none";

// Кто переводит, пока выбранная карточка не готова. Пусто — сама выбранная карточка и есть переводчик (тогда
// сейчас не переводит никто, и «пока переводит…» было бы неправдой).
function waitText() {
  const e = st.engine;
  if (e === ui.sel && e !== "auto" && !(e === "llm" && llmDirty())) return "";
  if (e === "chrome" || (e === "auto" && !deeplReady())) return builtinOk() ? HT_t("opWaitBuiltin") : "";
  if (e === "deepl" || e === "auto") return deeplReady() ? HT_t("opWaitOther", "DeepL") : "";
  if (e === "llm") return llmStoredReady() ? HT_t("opWaitOther", AI_NAME[st.llmProvider]) : "";
  return "";
}

// «Готово»: выбранная карточка становится переводчиком. Только по действию человека на этой странице.
function maybeSwitch() {
  const want = ui.sel === "deepl" || ui.sel === "auto" ? deeplReady() : ui.sel === "llm" ? llmReady() : false;
  if (want && st.engine !== ui.sel) put({ engine: ui.sel });
}

function select(code) {
  if (code === ui.sel) return;
  ui.sel = code;
  ui.prov = null; ui.modelDraft = null;
  if (code === "chrome") put({ engine: "chrome" });
  else maybeSwitch();
  if ((code === "deepl" || code === "auto") && deeplReady() && !ui.quota) fetchQuota();
  render();
}
// «Отмена» на шаге согласия — вернуть прежнюю карточку (переводчик не менялся), у ИИ — прежний сервис. Если эта
// карточка уже и есть переводчик, вернуть нечего — вместо «Отмены» «Переводить встроенным».
const canCancel = () => ui.sel !== st.engine || (ui.sel === "llm" && pendingProv());
function cancel() {
  if (ui.sel === "llm" && pendingProv()) {
    ui.prov = null; ui.modelDraft = null; ui.llm.err = null;
    render();
    focusFk("svc-" + st.llmProvider);
    return;
  }
  ui.sel = st.engine;
  render();
  focusFk("eng-" + ui.sel);
}
function useBuiltin() {
  ui.sel = "chrome";
  put({ engine: "chrome" });
  render();
  focusFk("eng-chrome");
}

async function setConsent(p, value) {
  let cur = {};
  try { cur = (await chrome.storage.local.get({ consent: {} })).consent; } catch (e) { /* пустое */ }
  const next = HT_consent(cur);
  next[p] = value;
  return put({ consent: next });
}
async function allow(p) {
  if (!(await setConsent(p, true))) return;
  maybeSwitch();
  if (p === "deepl" && deeplReady()) fetchQuota();
  render();
  // Следующий шаг — ключ; если ключ уже проверен, шагов больше нет — фокус на поле ключа. Ключ вставлен раньше,
  // но не проверен — проверяем сразу.
  focusFk(p === "deepl" ? "deepl-key" : "llm-key");
  if (p === "deepl" && deeplStep() === "key" && st.apiKey) checkDeepl();
  if (p !== "deepl" && llmStep() === "key" && llmKeyOf(p).trim()) checkLlm();
}
async function revoke(p) {
  if (!(await setConsent(p, false))) return;
  if (p === "deepl") ui.quota = null;
  render();
  focusFk("allow-" + p);
}

// ---------- проверка ключей ----------
// Уходит только сам ключ (у ИИ — ещё слово «Hello» из расширения) тому сервису, который его выдал; текста
// страниц нет. До проверки ключ записываем: background проверяет то, что в хранилище.
function checkText(r, llm) {
  if (r.code === "bad-key") {
    if (!llm) return HT_t("opKeyBad");
    const wrong = HT_t("llmWrongKey", SERVICE[llmProv()]);
    return r.error === wrong ? wrong : HT_t("opLlmKeyBad", SERVICE[llmProv()]);
  }
  const text = r.error || HT_t("checkFail");
  return r.detail ? HT_t("withDetail", [text, r.detail]) : text;
}
async function checkDeepl() {
  if (ui.dl.busy) return;
  const key = String(st.apiKey || "").trim();
  if (!key) { ui.dl.err = { code: "empty", text: HT_t("pasteKeyFirst") }; render(); return; }
  flush("apiKey");
  ui.dl.busy = true; ui.dl.err = null;
  render();
  await put({ apiKey: key, keyVerified: false });
  const r = (await send({ type: "checkUsage" })) || { ok: false, error: HT_t("checkFail") };
  ui.dl.busy = false;
  if (String(st.apiKey || "").trim() !== key) { render(); return; }   // ключ сменили, пока проверяли
  if (r.ok) {
    ui.dl.err = null; ui.keyEdited.deepl = true; ui.quota = r;
    await put({ keyVerified: true });
    maybeSwitch();
  } else {
    ui.dl.err = { code: r.code, text: checkText(r, false) };
    ui.quota = null;
  }
  render();
}
// Проверка ключа ИИ: background проверяет переданные сервис, ключ и модель и ничего не записывает. Прошла и
// согласие на сервис есть — это «Готово»: сервис, ключ и модель записываются (ключ прежнего сервиса — в llmKeyBy).
async function checkLlm() {
  if (ui.llm.busy) return;
  const p = llmProv();
  const key = llmKeyOf(p).trim();
  if (!key) { ui.llm.err = { code: "empty", text: HT_t("pasteKeyFirst") }; render(); return; }
  const model = llmModelOf(p);
  ui.llm.busy = true; ui.llm.err = null;
  render();
  const r = (await send({ type: "checkLlm", provider: p, key, model })) || { ok: false, error: HT_t("checkFail") };
  ui.llm.busy = false;
  if (llmProv() !== p || llmKeyOf(p).trim() !== key || llmModelOf(p) !== model) { render(); return; }   // сменили, пока проверяли
  if (!r.ok) { ui.llm.err = { code: r.code, text: checkText(r, true) }; render(); return; }
  ui.llm.err = null; ui.keyEdited.llm = true;
  if (consentOf(p)) {
    const by = llmByOf();
    if (p !== st.llmProvider && st.llmApiKey) by[st.llmProvider] = String(st.llmApiKey).trim();
    by[p] = key;
    ui.prov = null; ui.modelDraft = null; delete ui.llmDraft[p];
    await put({ llmProvider: p, llmApiKey: key, llmModel: model, llmVerified: true, llmKeyBy: by });
    maybeSwitch();
  }
  render();
}
// Остаток DeepL — только когда DeepL подключён (согласие есть, ключ проверен).
async function fetchQuota() {
  if (ui.quotaBusy || !deeplReady()) return;
  ui.quotaBusy = true;
  const r = await send({ type: "checkUsage" });
  ui.quotaBusy = false;
  if (r && r.ok) ui.quota = r;
  else if (r && r.code === "bad-key") { ui.dl.err = { code: "bad-key", text: HT_t("opKeyBad") }; put({ keyVerified: false }); }
  render();
}
// Вставили ключ (а не набирают по букве) — проверяем сразу.
const pasted = (e) => e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop";

function onKeyInput(which, e) {
  const v = e.target.value.trim();
  const again = pasted(e);
  if (which === "deepl") {
    if (v === st.apiKey && !again) return;
    ui.dl.err = null; ui.keyEdited.deepl = true; ui.quota = null;
    if (st.keyVerified) put({ keyVerified: false });
    putSoon("apiKey", v);
    if (again) checkDeepl(); else render();
    return;
  }
  // ИИ: вставленный ключ — черновик до успешной проверки. Стёрли ключ записанного сервиса — стираем и в хранилище
  // (человек убирает свой ключ из браузера).
  const p = llmProv();
  if (v === llmKeyOf(p).trim() && !again) return;
  ui.llm.err = null; ui.keyEdited.llm = true;
  ui.llmDraft[p] = v;
  if (!v && p === st.llmProvider && st.llmApiKey) { delete ui.llmDraft[p]; put({ llmApiKey: "", llmVerified: false }); }
  if (again) checkLlm(); else render();
}

// ---------- ИИ: сервис и модель ----------
// Ключ у каждого сервиса свой: в llmApiKey — ключ записанного сервиса, ключи других ждут в llmKeyBy (иначе ключ
// OpenAI ушёл бы в Anthropic). Сегмент меняет сервис только на карточке; в хранилище — на «Готово» (checkLlm).
// Модель другого сервиса не подойдёт — у нового сервиса «по умолчанию».
function setProvider(p) {
  if (p === llmProv()) return;
  ui.llm.err = null; ui.modelOther = false; ui.keyEdited.llm = true; ui.modelDraft = null;
  ui.prov = p === st.llmProvider ? null : p;
  render();
  if (consentOf(p) && llmKeyOf(p).trim() && llmDirty()) checkLlm();
}
function onModelSelect(e) {
  const v = e.target.value;
  if (v === "other") { ui.modelOther = true; render(); focusFk("llm-model-name"); return; }
  ui.modelOther = false;
  setModel(v);
}
function setModel(model) {
  const p = llmProv();
  if (model === llmModelOf(p)) { render(); return; }
  ui.llm.err = null;
  ui.modelDraft = model;
  if (llmKeyOf(p).trim() && consentOf(p)) checkLlm(); else render();
}

// ---------- встроенный переводчик ----------
let stopWatch = null;
async function refreshBuiltin() {
  const s = await HT_builtin.status(st.targetLang, "");
  ui.bi.kind = s.kind; ui.bi.src = s.src || ""; ui.bi.tgt = s.tgt || "";
  if (stopWatch) { stopWatch(); stopWatch = null; }
  if (s.kind === "downloading") stopWatch = HT_builtin.watch(st.targetLang, "", () => { stopWatch = null; refreshBuiltin(); });
  render();
}
const needsDl = () => ui.bi.busy || ui.bi.fail || ui.bi.again || ui.bi.kind === "need" || ui.bi.kind === "downloading";
// Скачать модели — только из обработчика щелчка (Chrome требует действия пользователя).
async function download() {
  if (ui.bi.busy) return;
  const hadFocus = document.activeElement && document.activeElement.dataset.fk;
  ui.bi.busy = true; ui.bi.pct = null; ui.bi.fail = false; ui.bi.again = false;
  render();
  if (hadFocus) focusFk(ui.sel === "auto" ? "eng-auto" : "eng-chrome");
  const r = await HT_builtin.prepare(st.targetLang, "", (pct) => { ui.bi.pct = pct; render(); });
  ui.bi.busy = false;
  if (r.ok) await refreshBuiltin();
  else { if (r.again) ui.bi.again = true; else ui.bi.fail = true; render(); }
}
// Пара встроенного, как её видит человек: «английский → русский» (в метке) и «Английский → русский».
function biPair(capital) {
  const p = ui.bi.src ? ui.bi : HT_prepPair(st.targetLang, "");
  if (!p.tgt) return "";
  return capital ? HT_ui.pair(p.src, p.tgt) : HT_t("pairArrow", [HT_langLabel(p.src), HT_langLabel(p.tgt)]);
}

// ---------- построение карточек ----------
const tag = (cls, text) => h("span", { class: "tag" + (cls ? " " + cls : "") }, text);
function biTag() {
  const b = ui.bi;
  if (b.busy) return tag("tag-acc", b.pct != null ? HT_t("opBiDownloadingPct", String(b.pct)) : HT_t("opBiDownloading"));
  if (b.fail) return tag("tag-err", HT_t("opBiFailed"));
  if (b.kind === "ready") return tag("tag-ok", HT_t("opBiReady", biPair(false)));
  if (b.kind === "need") return tag("tag-warn", HT_t("opBiNeed"));
  if (b.kind === "downloading") return tag("tag-acc", HT_t("opBiDownloading"));
  if (b.kind === "none") return tag("", HT_t("opTagNoBrowser"));
  if (b.kind === "no-lang" || b.kind === "pair-unavailable") return tag("tag-warn", HT_t("opBiNoLang"));
  return null;
}

// Карточка переводчика. Закрытая — щелчок по любому месту выбирает её; открытая — выбор в заголовке, ниже шаги.
function card(code, o) {
  const on = ui.sel === code;
  const radio = h("input", { type: "radio", name: "engine", value: code, checked: on, disabled: !!o.disabled,
    "data-fk": "eng-" + code, onchange: () => select(code) });
  const head = h("label", { class: "rc-head" }, radio,
    h("span", { class: "rc-main" }, h("span", { class: "rc-t" }, o.title, o.tag || null), h("span", { class: "rc-d" }, o.desc)));
  const el = h("div", { class: "rcard" + (on && !o.disabled ? " on" : "") + (o.open ? " open" : "") + (o.disabled ? " is-disabled" : ""),
    "data-card": code }, head, o.open ? h("div", { class: "rc-more" }, o.more) : null);
  if (!o.open && !o.disabled) el.addEventListener("click", (e) => { if (!e.target.closest(".rc-head")) radio.click(); });
  return el;
}

function steps(k) {
  const step = (cls, n, text) => h("span", { class: "step" + (cls ? " " + cls : ""), "aria-current": cls === "cur" || cls === "err" ? "step" : null },
    h("span", { class: "n" }, n), text);
  const line = () => h("span", { class: "step-line", "aria-hidden": "true" });
  return h("div", { class: "steps", role: "group", "aria-label": HT_t("opStepsAria") },
    k === "consent" ? step("cur", "1", HT_t("opStepConsent")) : step("done", ic("check", 14), HT_t("opStepConsent")),
    line(),
    k === "consent" ? step("", "2", HT_t("opStepKey")) : k === "error" ? step("err", "!", HT_t("opStepKey")) : step("cur", "2", HT_t("opStepKey")),
    line(),
    step("", "3", HT_t("opStepDone")));
}
function stepsBlock(k) {
  const w = waitText();
  return h("div", { class: "stack", style: "gap: 8px;" }, steps(k),
    w ? h("p", { class: "rc-wait" }, ic("info", 16), h("span", null, w)) : null);
}

function consentBlock(p) {
  const d = p === "deepl" ? HT_t("opConsentDeepl") : p === "openai" ? HT_t("opConsentOpenai") : HT_t("opConsentAnthropic");
  const second = canCancel() ? h("button", { type: "button", class: "btn btn-ghost", "data-fk": "cancel", onclick: cancel }, HT_t("opCancel"))
    : builtinOk() ? h("button", { type: "button", class: "btn btn-ghost", "data-fk": "use-builtin", onclick: useBuiltin }, HT_t("useBuiltin")) : null;
  return h("div", { class: "stack" },
    h("div", { class: "notice notice-info" }, ic("shield"),
      h("div", { class: "notice-b" }, h("p", { class: "notice-t" }, HT_t("opConsentQ", SERVICE[p])), h("p", { class: "notice-d" }, d))),
    h("div", { class: "rc-acts" },
      h("button", { type: "button", class: "btn btn-primary", "data-fk": "allow-" + p, onclick: () => allow(p) }, HT_t("opAllow")), second));
}
function consentLine(p) {
  return h("p", { class: "consent-line" }, ic("shield", 16), h("span", null, HT_t("opConsentLine", SERVICE[p])),
    h("button", { type: "button", class: "link-btn", "data-fk": "revoke-" + p, onclick: () => revoke(p) }, HT_t("opRevoke")));
}
const howTo = (href) => h("a", { class: "link-ext", href, target: "_blank", rel: "noopener" }, HT_t("opHowGetKey"), ic("external", 14));

// Поле ключа: type=password + глаз; проверка — сама при вставке, по Enter и кнопкой «Проверить».
function keyField(o) {
  const which = o.which, reveal = ui.reveal[which];
  const input = h("input", { id: o.id, class: "inp mono" + (o.state === "err" ? " is-err" : o.state === "ok" ? " is-ok" : ""),
    type: reveal ? "text" : "password", placeholder: o.ph, value: o.value || "", autocomplete: "off", spellcheck: "false",
    "aria-invalid": o.state === "err" ? "true" : null, "aria-describedby": o.msg ? o.id + "-msg" : null, "data-fk": o.id,
    oninput: (e) => onKeyInput(which, e),
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); o.check(); } } });
  const eye = h("button", { type: "button", class: "icon-btn", "aria-pressed": String(reveal), "data-fk": o.id + "-eye",
    "aria-label": HT_t(reveal ? "opHideKey" : "opShowKey"), title: HT_t(reveal ? "opHideKey" : "opShowKey"),
    onclick: () => { ui.reveal[which] = !reveal; render(); } }, ic(reveal ? "eyeOff" : "eye", 16));
  const btn = o.busy
    ? h("button", { type: "button", class: "btn btn-secondary", "aria-busy": "true", "aria-disabled": "true", "data-fk": o.id + "-check" }, ic("spin", 16), HT_t("opChecking"))
    : h("button", { type: "button", class: "btn btn-secondary", "data-fk": o.id + "-check", onclick: o.check }, HT_t("opCheck"));
  const msg = o.msg ? h("p", { class: "inp-msg " + (o.msg.ok ? "ok-t" : "err-t"), id: o.id + "-msg", role: o.msg.ok ? null : "alert" },
    ic(o.msg.ok ? "checkCircle" : "alert", 16), h("span", null, o.msg.text)) : null;
  return h("div", { class: "field" }, h("label", { class: "lbl", for: o.id }, o.label),
    h("div", { class: "inp-row" }, h("div", { class: "inp-wrap" }, input, eye), btn), msg);
}
// «…4f2a:fx» — сколько видно от ключа: у бесплатного DeepL — последние 4 знака и «:fx», у ИИ — 3.
function deeplKeyField(k) {
  const key = String(st.apiKey || "");
  const free = key.endsWith(":fx");
  let msg = null;
  if (k === "error") msg = { text: HT_t("opKeyBad") };
  else if (k === "ready") msg = { ok: true, text: free ? HT_t("opKeyOkFree", key.slice(-7)) : HT_t("opKeyOkPro", key.slice(-4)) };
  else if (ui.dl.err) msg = { text: ui.dl.err.text };
  return keyField({ which: "deepl", id: "deepl-key", label: HT_t("opDeeplKey"), ph: HT_t("opDeeplKeyPh"), value: key,
    state: k === "error" ? "err" : k === "ready" ? "ok" : "", msg, busy: ui.dl.busy, check: checkDeepl });
}
function llmKeyField(k) {
  const p = llmProv();
  const key = llmKeyOf(p);
  let msg = null;
  if (k === "error") msg = { text: ui.llm.err ? ui.llm.err.text : HT_t("opLlmKeyBad", SERVICE[p]) };
  else if (k === "ready") msg = { ok: true, text: HT_t("opKeyOk", key.slice(-3)) };
  else if (ui.llm.err) msg = { text: ui.llm.err.text };
  return keyField({ which: "llm", id: "llm-key", label: HT_t("opLlmKey", SERVICE[p]), ph: HT_t("opLlmKeyPh", SERVICE[p]),
    value: key, state: k === "error" ? "err" : k === "ready" ? "ok" : "", msg, busy: ui.llm.busy, check: checkLlm });
}

// Остаток DeepL: бесплатный ключ — из 500 000; платный с лимитом, заданным в DeepL, — с пояснением; без лимита —
// сколько переведено в этом месяце.
function quotaBlock() {
  const q = ui.quota;
  if (!q || !q.ok || typeof q.limit !== "number" || typeof q.used !== "number") return null;
  const lbl = h("span", { class: "lbl" }, HT_t("opQuotaLbl"));
  if (!q.free && (q.limit <= 0 || q.limit >= DEEPL_NO_LIMIT)) {
    return h("div", { class: "field" }, lbl, h("p", { class: "muted fs13" }, HT_plural("quotaUsed", q.used)));
  }
  const left = Math.max(0, q.limit - q.used);
  const leftT = HT_num(left);
  const text = q.free ? HT_plural("opQuotaLeft", q.limit, leftT) : HT_plural("opQuotaOwn", q.limit, leftT);
  const i = text.indexOf(leftT);
  const low = left < q.limit * 0.1;
  const p = h("p", { class: "quota-t fs13 " + (low ? "warn-t" : "muted") },
    i >= 0 ? [text.slice(0, i), h("b", null, leftT), text.slice(i + leftT.length)] : text);
  return h("div", { class: "field" }, lbl, HT_ui.progress(q.limit ? (100 * left) / q.limit : 0, HT_t("opQuotaAria")), p);
}

function deeplParts(k) {
  if (k === "consent") return [stepsBlock(k), consentBlock("deepl")];
  if (k === "key" || k === "error") return [stepsBlock(k), h("div", { class: "stack", style: "gap: 12px;" }, deeplKeyField(k), howTo(DEEPL_KEYS_URL))];
  return [deeplKeyField(k), quotaBlock(), consentLine("deepl")];
}

function biDownloadBlock() {
  const pair = biPair(true);
  if (ui.bi.busy || ui.bi.kind === "downloading") {
    const pct = ui.bi.busy ? ui.bi.pct : null;
    return h("div", { class: "bi-dl" },
      h("div", { class: "prog" }, h("div", { class: "prog-top" }, h("span", null, HT_t("opBiProgress")), h("span", { class: "pct" }, pct != null ? pct + "%" : "")),
        HT_ui.progress(pct, HT_t("opBiProgress"))),
      h("p", { class: "hint left" }, pair));
  }
  const btn = h("button", { type: "button", class: "btn btn-primary", "data-fk": "bi-dl", onclick: download },
    ic(ui.bi.fail ? "refresh" : "download", 16), ui.bi.fail ? HT_t("opRetry") : HT_t("opBiDownload"));
  const note = ui.bi.fail ? h("p", { class: "inp-msg err-t m0", role: "alert" }, ic("alert", 16), h("span", null, HT_t("biFailed")))
    : h("p", { class: "hint left" }, ui.bi.again ? HT_t("biOnceMore") : HT_t("opBiOffline", pair));
  return h("div", { class: "bi-dl" }, h("div", null, btn), note);
}

function builtinCard() {
  const none = ui.bi.kind === "none";
  const open = ui.sel === "chrome" && !none && needsDl();
  return card("chrome", { title: HT_t("opEngBuiltin"), tag: biTag(), desc: none ? HT_t("opEngBuiltinNoneD") : HT_t("opEngBuiltinD"),
    disabled: none, open, more: open ? biDownloadBlock() : null });
}
function deeplCard() {
  const open = ui.sel === "deepl";
  const k = deeplStep();
  const t = !open ? null : k === "ready" ? tag("tag-ok", HT_t("opTagReady")) : k === "error" ? tag("tag-err", HT_t("opTagKeyBad")) : null;
  return card("deepl", { title: "DeepL", tag: t, desc: HT_t("opEngDeeplD"), open, more: open ? deeplParts(k) : null });
}
function autoCard() {
  if (ui.bi.kind === "none") {
    return card("auto", { title: HT_t("opEngAuto"), tag: tag("", HT_t("opTagNeedBuiltin")), desc: HT_t("opEngAutoNoneD"), disabled: true });
  }
  const open = ui.sel === "auto";
  return card("auto", { title: HT_t("opEngAuto"), desc: HT_t("opEngAutoD"), open, more: open ? autoParts() : null });
}
function autoParts() {
  const k = deeplStep();
  const n = ui.net;
  let t1;
  if (k === "error") t1 = tag("tag-err", HT_t("opTagKeyBad"));
  else if (k !== "ready") t1 = tag("tag-warn", HT_t("opAutoConnect"));
  else if ((ui.quota && ui.quota.ok && ui.quota.limit > 0 && ui.quota.limit < DEEPL_NO_LIMIT && ui.quota.used >= ui.quota.limit) ||
    (n && n.via === "deepl" && n.code === "quota")) t1 = tag("tag-warn", HT_t("opAutoQuotaOut"));
  else if (ui.quota && ui.quota.ok && ui.quota.limit > 0 && ui.quota.limit < DEEPL_NO_LIMIT) t1 = tag("tag-ok", HT_plural("opAutoLeft", Math.max(0, ui.quota.limit - ui.quota.used)));
  else t1 = tag("tag-ok", HT_t("opTagReady"));
  const fb = (n2, t, tg, extra) => h("div", { class: "fb-row" }, h("span", { class: "n" }, n2), h("span", { class: "t" }, t), tg, extra || null);
  const dl = needsDl() && !ui.bi.busy && ui.bi.kind !== "downloading"
    ? h("button", { type: "button", class: "btn btn-secondary btn-sm", "data-fk": "bi-dl", onclick: download }, HT_t("opBiDownloadShort")) : null;
  const parts = [h("div", null, fb("1", "DeepL", t1), fb("2", HT_t("opEngBuiltin"), biTag(), dl))];
  if (k !== "ready") parts.push(...deeplParts(k));
  parts.push(h("p", { class: "muted fs13" }, HT_t("opAutoNote")));
  return parts;
}

function serviceSeg() {
  const b = (p) => h("button", { type: "button", role: "radio", "aria-checked": String(llmProv() === p), tabindex: llmProv() === p ? "0" : "-1",
    "data-fk": "svc-" + p, onclick: () => setProvider(p) }, AI_NAME[p]);
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-labelledby": "llm-svc", style: "max-width: 320px;" }, b("openai"), b("anthropic"));
  segKeys(seg);
  return h("div", { class: "field" }, h("span", { class: "lbl", id: "llm-svc" }, HT_t("opService")), seg);
}
// Модель: первая строка — «по умолчанию» (пустое llmModel), последняя — «Другая…» с полем для точного названия.
function modelField() {
  const p = llmProv();
  const model = llmModelOf(p);
  const rows = HT_llmModels(p).map((r, i) => [i === 0 ? "" : r[0], HT_llmModelLabel(r)]).concat([["other", HT_t("modelOther")]]);
  const custom = ui.modelOther || (!!model && !HT_llmModelRow(p, model));
  const value = custom ? "other" : !model || model === HT_llmDefault(p) ? "" : model;
  const { wrap, sel } = HT_ui.select("llm-model", rows, value, { "data-fk": "llm-model" });
  wrap.classList.add("rc-sel");
  sel.addEventListener("change", onModelSelect);
  const name = custom ? h("input", { id: "llm-model-name", class: "inp rc-sel", value: model && !HT_llmModelRow(p, model) ? model : "",
    placeholder: HT_t("llmModelPlaceholder"), "aria-label": HT_t("llmModelAria"), spellcheck: "false", "data-fk": "llm-model-name",
    onchange: (e) => setModel(e.target.value.trim()),
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); setModel(e.target.value.trim()); } } }) : null;
  return h("div", { class: "field" }, h("label", { class: "lbl", for: "llm-model" }, HT_t("opModel")), wrap, name);
}
function llmCard() {
  const open = ui.sel === "llm";
  const k = llmStep();
  const t = !open ? null : k === "ready" ? tag("tag-ok", HT_t("opTagReady")) : k === "error" ? tag("tag-err", HT_t("opTagKeyBad")) : null;
  let more = null;
  if (open) {
    const p = llmProv();
    more = [serviceSeg()];
    if (k === "consent") more.push(stepsBlock(k), consentBlock(p));
    else if (k === "ready") more.push(modelField(), llmKeyField(k), consentLine(p));
    else more.push(stepsBlock(k), modelField(), h("div", { class: "stack", style: "gap: 12px;" }, llmKeyField(k), howTo(LLM_KEYS_URL[p])));
  }
  return card("llm", { title: HT_t("opEngLlm"), tag: t, desc: HT_t("opEngLlmD"), open, more });
}

// Карточки перестраиваются целиком, но только когда меняется то, что на них видно (набор ключа по буквам их
// не трогает); фокус и курсор в поле возвращаются на место по data-fk.
let lastSig = "";
function engineSig() {
  const q = ui.quota;
  return JSON.stringify([ui.sel, st.engine, deeplStep(), llmStep(), st.llmProvider, st.llmModel, ui.prov, ui.modelDraft, ui.modelOther, ui.dl, ui.llm,
    q && [q.used, q.limit, q.free], ui.bi, ui.reveal, waitText(), ui.ver, HT_consent(st.consent), ui.net && ui.net.code,
    st.keyVerified && st.apiKey.slice(-7), st.llmVerified && st.llmApiKey.slice(-3), st.targetLang]);
}
function renderEngines(force) {
  const sig = engineSig();
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const a = document.activeElement;
  const fk = a && a.dataset ? a.dataset.fk : "";
  let range = null;
  if (fk && a.tagName === "INPUT" && a.type !== "radio") { try { range = [a.selectionStart, a.selectionEnd]; } catch (e) { range = null; } }
  $("engines").replaceChildren(builtinCard(), deeplCard(), autoCard(), llmCard());
  if (fk) focusFk(fk, range);
}
function focusFk(fk, range) {
  const el = document.querySelector(`[data-fk="${fk}"]`);
  if (!el) return null;
  focusEl(el);
  if (range && range[0] != null) { try { el.setSelectionRange(range[0], range[1]); } catch (e) { /* не текстовое поле */ } }
  return el;
}
// Фокус, который страница ставит сама (после перерисовки, после «Отмены», после «Включить»): кольцо — только если
// человек работает с клавиатуры. Иначе Chrome считал такой фокус видимым и после щелчка мышью: у выбранной карточки
// переводчика появлялась вторая рамка. Поле ввода — как обычно (у него кольцо есть всегда: там курсор).
let byKeys = false;
addEventListener("keydown", (e) => { if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") byKeys = true; }, true);
addEventListener("pointerdown", () => { byKeys = false; }, true);
function focusEl(el) {
  const typing = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(radio|checkbox|range|color|button)$/.test(el.type));
  el.focus(typing ? { preventScroll: true } : { preventScroll: true, focusVisible: byKeys });
}

// ---------- на странице ----------
const segBtns = (seg) => [...seg.querySelectorAll('[role="radio"]')];
// Стрелки внутри сегмента (role=radiogroup из кнопок): переходят и выбирают, как у обычных переключателей.
function segKeys(seg) {
  seg.addEventListener("keydown", (e) => {
    const btns = segBtns(seg);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns.length;
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    btns[j].focus();
    btns[j].click();
  });
}
function markSeg(seg, value, attr) {
  for (const b of segBtns(seg)) {
    const on = b.dataset[attr || "v"] === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function renderPage() {
  const t = HT_valid("trigger", st.trigger);
  markSeg($("trigger"), t);
  $("trigD").textContent = t === "dwell" ? HT_t("opTrigDwellD") : HT_t("opTrigKeyD", HT_triggerKey(t, MAC));
  $("altWarn").hidden = t !== "alt" || MAC;
  $("dwellField").hidden = t !== "dwell";
  renderDwell();
  const disp = HT_valid("displayMode", st.displayMode === "inline" ? "replace" : st.displayMode);
  for (const r of document.querySelectorAll('input[name="displayMode"]')) {
    r.checked = r.value === disp;
    r.closest(".rcard").classList.toggle("on", r.checked);
  }
  const mode = ["auto", "custom", "none"].includes(st.dispMode) ? st.dispMode : "auto";
  $("dispMode").value = mode;
  $("hlD").textContent = mode === "custom" ? HT_t("opHlCustomD") : mode === "none" ? HT_t("opHlNoneD") : HT_t("opHlAutoD");
  $("hlMore").hidden = mode !== "custom";
  renderSwatches();
  $("showLangBadge").setAttribute("aria-checked", String(st.showLangBadge !== false));
  $("badgeD").textContent = HT_t("opBadgeD", biPair(true));
}
function renderDwell() {
  const r = $("dwellMs");
  const v = HT_clampDwell(st.dwellMs);
  if (document.activeElement !== r) r.value = String(Math.max(HT_DWELL_UI.min, Math.min(HT_DWELL_UI.max, v)));
  HT_ui.rangeFill(r);
  $("dwellVal").textContent = HT_t("opMs", HT_num(v));
  r.setAttribute("aria-valuetext", HT_plural("opMsLong", v));
}

const hexOk = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const opacityOf = () => Math.max(10, Math.min(60, Math.round((Number(st.dispOpacity) || HT_DEFAULTS.dispOpacity) / 5) * 5));
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 1000) / 1000})`;
}
let swatchesBuilt = false;
function renderSwatches() {
  const box = $("swatches");
  const color = hexOk(st.dispBg) ? st.dispBg.toLowerCase() : HT_DEFAULTS.dispBg;
  if (!swatchesBuilt) {
    swatchesBuilt = true;
    for (const [c, key] of HT_SWATCHES) {
      const name = HT_t(key);
      box.append(h("button", { type: "button", class: "swatch", role: "radio", "data-c": c, "aria-label": name, title: name,
        style: { background: c }, onclick: () => put({ dispBg: c }).then(renderPage) }));
    }
    const other = HT_t("opColorOther");
    const inp = h("input", { type: "color", id: "dispBgOther", "aria-label": other,
      oninput: (e) => { putSoon("dispBg", e.target.value.toLowerCase(), 150); renderSwatches(); },
      onchange: (e) => { flush("dispBg"); put({ dispBg: e.target.value.toLowerCase() }).then(renderPage); } });
    box.append(h("label", { class: "swatch custom", title: other }, ic("plus", 16), inp));
    segKeys(box);
  }
  const known = HT_SWATCHES.some(([c]) => c === color);
  for (const b of box.querySelectorAll("button.swatch")) {
    const on = b.dataset.c === color;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on || (!known && b === box.firstElementChild) ? 0 : -1;
  }
  const custom = box.querySelector(".swatch.custom");
  custom.classList.toggle("has-color", !known);
  custom.style.background = known ? "" : color;
  custom.style.boxShadow = known ? "" : "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)";
  const inp = $("dispBgOther");
  if (document.activeElement !== inp) inp.value = color;
  const op = opacityOf();
  const r = $("dispOpacity");
  if (document.activeElement !== r) r.value = String(op);
  HT_ui.rangeFill(r);
  $("opacityVal").textContent = op + "%";
  // Образец: на тёмном сайте та же подложка слабее (как янтарная по умолчанию: .34 → .20).
  const [l, d] = document.querySelectorAll(".hl-demo .mk");
  l.style.setProperty("--hl", rgba(color, op / 100));
  d.style.setProperty("--hl", rgba(color, (op / 100) * 0.6));
}

// ---------- языки ----------
function netState() {
  return { apiKey: !!st.apiKey, llmApiKey: !!st.llmApiKey, llmProvider: st.llmProvider, consent: st.consent,
    targetLang: st.targetLang, sourceLang: st.sourceLang };
}
function renderLangs() {
  if (document.activeElement !== $("targetLang")) $("targetLang").value = st.targetLang;
  if (document.activeElement !== $("sourceLang")) $("sourceLang").value = st.sourceLang;
  $("formality").value = HT_valid("formality", st.formality);
  // Выбранный переводчик не знает язык — сказать об этом у самого списка.
  const p = HT_engineProblem(st.engine, netState(), HT_builtin.hasApi());
  const gap = p === "deepl-lang" ? HT_langGap("deepl", st) : p === "builtin-lang" ? HT_langGap("local", st) : null;
  const text = gap ? HT_ui.cap(HT_problemText(p, "short", st)) : "";
  $("targetWarn").hidden = !(gap && gap.dir === "to");
  $("targetWarn").textContent = gap && gap.dir === "to" ? text : "";
  $("sourceWarn").hidden = !(gap && gap.dir === "from");
  $("sourceWarn").textContent = gap && gap.dir === "from" ? text : "";
}
function pushRecent(list, code) {
  if (!LANG_LABEL[code]) return list;
  return [code, ...list.filter((c) => c !== code)].slice(0, 5);
}

// ---------- сайты и слова ----------
let sitesSig = null;
function renderSites() {
  const list = HT_sites(st.disabledSites);
  if (document.activeElement !== $("noTranslate") && !pending.noTranslate) $("noTranslate").value = st.noTranslate || "";
  const sig = list.join(" ");
  if (sig === sitesSig) return;
  sitesSig = sig;
  const ul = $("siteList");
  const had = document.activeElement && document.activeElement.closest && document.activeElement.closest("#siteList");
  ul.replaceChildren(...list.map((s) => h("li", null, h("span", { class: "sl-ic" }, ic("globe", 16)), h("span", { class: "sl-t", title: s }, s),
    h("button", { type: "button", class: "btn btn-secondary btn-sm", "data-site": s, "aria-label": HT_t("opSiteOnAria", s),
      onclick: () => enableSite(s) }, HT_t("opSiteOn")))));
  $("siteNone").hidden = list.length > 0;
  if (had && !ul.contains(document.activeElement)) focusEl(ul.querySelector("button") || $("noTranslate"));
}
// Список общий с окном и мини-панелью — читаем свежий перед записью.
async function enableSite(site) {
  let list = [];
  try { list = HT_sites((await chrome.storage.local.get({ disabledSites: [] })).disabledSites); } catch (e) { /* пустой */ }
  const i = list.indexOf(site);
  const next = list.filter((x) => x !== site);
  if (!(await put({ disabledSites: next }))) return;
  renderSites();
  const btns = $("siteList").querySelectorAll("button");
  const to = btns[Math.min(Math.max(0, i), btns.length - 1)];
  focusEl(to || $("noTranslate"));
}

// ---------- горячие клавиши ----------
function renderKeys() {
  const put1 = (el, k) => el.replaceChildren(k ? h("span", { class: "kbd kbd-lg" }, k) : h("span", { class: "kbd-none" }, HT_t("keyNotSet")));
  const done = (all) => {
    const by = {};
    for (const c of all || []) by[c.name] = c.shortcut || "";
    put1($("keyPage"), by["translate-page"]);
    put1($("keyToggle"), by["toggle-enabled"]);
  };
  if (chrome.commands && chrome.commands.getAll) chrome.commands.getAll().then(done).catch(() => done([]));
  else done([]);
}

// ---------- данные ----------
// Объём: «340 КБ», «2,1 МБ» (числа — по языку интерфейса).
function sizeText(bytes) {
  const mb = bytes >= 1024 * 1024;
  return mb ? HT_t("opSizeMb", HT_num(Math.round((bytes / (1024 * 1024)) * 10) / 10)) : HT_t("opSizeKb", HT_num(Math.max(1, Math.round(bytes / 1024))));
}
let savedCount = 0;
async function fetchStats() {
  const r = await send({ type: "getStats" });
  savedCount = r && r.ok && r.entries > 0 ? r.entries : 0;
  $("savedD").textContent = savedCount ? HT_plural("opSavedD", savedCount, sizeText(r.bytes || 0)) : HT_t("opSavedNone");
  if (!$("clearCache").getAttribute("aria-busy")) $("clearCache").disabled = !savedCount;
}
async function clearSaved() {
  const btn = $("clearCache");
  btn.setAttribute("aria-busy", "true");
  btn.disabled = true;
  $("clearT").textContent = HT_t("deleting");
  const r = await send({ type: "clearCache" });
  if (r && r.ok) await send({ type: "resetStats" });
  btn.removeAttribute("aria-busy");
  $("clearT").textContent = r && r.ok ? HT_t("deleted") : HT_t("tryAgainFailed");
  await fetchStats();
  setTimeout(() => { $("clearT").textContent = HT_t("opDelete"); }, 2500);
}

// ---------- сбросить настройки ----------
// Всё, что человек выбирал, — к значениям новой установки: HT_DEFAULTS (переводчик, язык оригинала, способ перевода и
// показа, подсветка, метка языка, слова-исключения, включён ли перевод), язык перевода — по языку браузера, как при
// установке (background, onInstalled); согласия на отправку текста, выключенные сайты, недавние языки окна, мини-панель
// (скрыта, на месте по умолчанию). Остаются ключи DeepL и ИИ и то, что проверено вместе с ними: keyVerified, у ИИ —
// сервис, модель и проверенность (llmVerified проверялась для этой пары сервиса и ключа с этой моделью), ключи других
// сервисов (llmKeyBy). Сохранённые переводы и счётчики — свои кнопки. Сочетания клавиш задаёт Chrome — их расширение
// не меняет. Подтверждение — на месте: «Сбросить» (danger) и «Отмена».
const RESET_KEEP = ["llmProvider", "llmModel"];
function resetValues() {
  const v = Object.assign({}, HT_DEFAULTS, { consent: {}, disabledSites: [], recentLangs: [], hudShown: false });
  for (const k of RESET_KEEP) delete v[k];
  let locale = "";
  try { locale = chrome.i18n.getUILanguage(); } catch (e) { /* запасное — из HT_DEFAULTS */ }
  if (locale) v.targetLang = HT_targetFromLocale(locale);
  return v;
}
let resetAsk = false;                     // идёт подтверждение
let resetNote = {};                       // { text, ok }: «Готово…» / ошибка — на 3 с вместо пояснения
let resetTimer = null;
function renderReset() {
  $("resetT").textContent = HT_t(resetAsk ? "opResetQ" : "opResetT");
  $("resetD").textContent = resetNote.text || HT_t("opResetD");
  $("resetD").className = "cr-d" + (resetNote.text ? (resetNote.ok ? " ok-t" : " err-t") : "");
  $("resetBtn").hidden = resetAsk;
  $("resetYes").hidden = !resetAsk;
  $("resetNo").hidden = !resetAsk;
}
function askReset(on) {
  resetAsk = on;
  resetNote = {};
  renderReset();
  focusEl(on ? $("resetNo") : $("resetBtn"));
}
async function resetAll() {
  const btn = $("resetYes");
  if (btn.getAttribute("aria-busy")) return;
  btn.setAttribute("aria-busy", "true");
  for (const k of Object.keys(pending)) { clearTimeout(pending[k]); delete pending[k]; }
  let done = true;
  try {
    await chrome.storage.local.remove(["hudPos"].concat(HT_OBSOLETE_KEYS));
    await chrome.storage.local.set(resetValues());
    showSaveErr("");
  } catch (e) {
    done = false;
    showSaveErr(HT_t("opNotSaved", e && e.message && !/quota/i.test(e.message) ? e.message : HT_t("opStoreFull")));
  }
  btn.removeAttribute("aria-busy");
  // Перерисовать из хранилища, черновики карточек — забыть.
  Object.assign(ui, { prov: null, llmDraft: {}, modelDraft: null, modelOther: false, quota: null,
    dl: { busy: false, err: null }, llm: { busy: false, err: null }, reveal: { deepl: false, llm: false } });
  ui.ver++;
  ui.bi.fail = false; ui.bi.again = false;
  sitesSig = null;
  await loadSettings();
  render(true);
  refreshBuiltin();
  resetAsk = false;
  resetNote = { text: done ? HT_t("opResetDone") : HT_t("tryAgainFailed"), ok: done };
  renderReset();
  focusEl($("resetBtn"));
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { resetNote = {}; renderReset(); }, 3000);
}

// ---------- меню разделов: подсветка текущего ----------
const navLinks = [...document.querySelectorAll("#nav .nav-a")];
let forcedSec = null;                     // щёлкнули в меню — до следующей прокрутки человеком горит он
function spy() {
  let cur = SECTIONS[0];
  if (forcedSec) cur = forcedSec;
  else {
    const root = document.documentElement;
    if (scrollY > 0 && innerHeight + scrollY >= root.scrollHeight - 2) cur = SECTIONS[SECTIONS.length - 1];
    else {
      const line = Math.min(160, innerHeight * 0.3);
      for (const id of SECTIONS) if ($(id).getBoundingClientRect().top <= line) cur = id;
    }
  }
  const nav = $("nav");
  for (const a of navLinks) {
    const on = a.hash === "#" + cur;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    // узкое окно: полоса вкладок прокручивается вбок, текущая вкладка видна
    if (on && nav.scrollWidth > nav.clientWidth + 1) {
      const pad = 24;
      if (a.offsetLeft - pad < nav.scrollLeft) nav.scrollLeft = a.offsetLeft - pad;
      else if (a.offsetLeft + a.offsetWidth + pad > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = a.offsetLeft + a.offsetWidth + pad - nav.clientWidth;
    }
  }
}
let spyQueued = false;
const spySoon = () => { if (!spyQueued) { spyQueued = true; requestAnimationFrame(() => { spyQueued = false; spy(); }); } };
addEventListener("scroll", spySoon, { passive: true });
addEventListener("resize", spySoon);
for (const ev of ["wheel", "touchstart"]) addEventListener(ev, () => { forcedSec = null; }, { passive: true });
addEventListener("keydown", (e) => { if (/^(Page|Arrow|Home|End| )/.test(e.key) && !e.target.closest("input, select, textarea, .seg, [role=radiogroup]")) forcedSec = null; });
for (const a of navLinks) a.addEventListener("click", () => { forcedSec = a.hash.slice(1); spy(); });

// ---------- фокус по просьбе окна расширения и уведомлений ----------
function applyFocus(f) {
  if (!f || typeof f.to !== "string" || !(Date.now() - (Number(f.at) || 0) < 10000)) return;
  chrome.storage.session.remove("htFocus").catch(() => {});
  const to = f.to;
  // Страницу открыли щелчком в окне расширения — кольцо фокуса не нужно (у выбранной карточки оно выглядело второй
  // рамкой); с клавиатуры оно появится, как только человек нажмёт клавишу (focusEl).
  const show = (el, block) => {
    if (!el) return;
    focusEl(el);
    el.scrollIntoView({ block: block || "center", behavior: "instant" });
  };
  const sec = (id) => { const s = $(id); if (s) s.scrollIntoView({ block: "start", behavior: "instant" }); forcedSec = id; spy(); };
  // Следующее действие в открытой карточке: согласие, иначе ключ, иначе сам переключатель.
  const next = (code, p) => document.querySelector(`[data-fk="allow-${p}"]`) || document.querySelector(`[data-fk="${p === "deepl" ? "deepl-key" : "llm-key"}"]`)
    || document.querySelector(`[data-fk="eng-${code}"]`);
  const openCard = (code) => {
    if (code !== ui.sel) select(code);
    renderEngines(true);
  };
  if (to === "deepl" || to === "deepl-key") {
    const code = st.engine === "auto" && builtinOk() ? "auto" : "deepl";
    openCard(code);
    sec("translator");
    show(to === "deepl-key" ? next(code, "deepl") : document.querySelector(`[data-fk="eng-${code}"]`));
  } else if (to === "llm" || to === "llm-key") {
    openCard("llm");
    sec("translator");
    show(to === "llm-key" ? next("llm", llmProv()) : document.querySelector('[data-fk="eng-llm"]'));
  } else if (to === "auto") {
    if (builtinOk()) openCard("auto");
    sec("translator");
    show(document.querySelector('[data-fk="eng-auto"]'));
  } else if (to === "builtin") {
    sec("translator");
    show(document.querySelector('[data-fk="bi-dl"]') || document.querySelector('[data-fk="eng-chrome"]'));
  } else if (to === "translator") {
    sec("translator");
    show(document.querySelector(`[data-fk="eng-${ui.sel}"]`) || document.querySelector('#engines input:not(:disabled)'), "nearest");
  } else if (to === "page") { sec("page"); show(segBtns($("trigger")).find((b) => b.tabIndex === 0), "nearest"); }
  else if (to === "langs" || to === "target-lang") { sec("langs"); show($("targetLang"), "nearest"); }
  else if (to === "source-lang") { sec("langs"); show($("sourceLang"), "nearest"); }
  else if (to === "sites") { sec("sites"); show($("siteList").querySelector("button") || $("noTranslate"), "nearest"); }
  else if (to === "keys") { sec("keys"); show($("keysEdit"), "nearest"); }
  else if (to === "data") { sec("data"); show($("clearCache").disabled ? $("h-data") : $("clearCache"), "nearest"); }
}

// ---------- общая отрисовка ----------
function render(force) {
  if (!st) return;
  renderEngines(force);
  renderPage();
  renderLangs();
  renderSites();
}

// ---------- статичная разметка ----------
function initStatic() {
  $("logo").replaceWith(HT_ui.logo(28, "p-logo"));
  for (const el of document.querySelectorAll("[data-ic]")) {
    const svg = ic(el.dataset.ic, Number(el.dataset.icSize) || 18);
    if (el.tagName === "SPAN" && !el.childNodes.length) el.replaceWith(svg); else el.prepend(svg);
  }
  for (const b of segBtns($("trigger"))) if (b.dataset.v !== "dwell") b.textContent = HT_triggerKey(b.dataset.v, MAC);
  HT_fillSelect($("targetLang"), HT_TARGET_LANGS);
  HT_fillSelect($("sourceLang"), [["auto", HT_t("opSrcAuto")]].concat(HT_SOURCE_LANGS.slice(1)));
  for (const s of document.querySelectorAll(".sel select")) HT_ui.selValue(s);
  const dw = $("dwellMs");
  dw.min = String(HT_DWELL_UI.min); dw.max = String(HT_DWELL_UI.max); dw.step = String(HT_DWELL_UI.step);
  for (const r of document.querySelectorAll(".range")) HT_ui.rangeFill(r, true);

  // способ включения
  segKeys($("trigger"));
  for (const b of segBtns($("trigger"))) b.addEventListener("click", () => { put({ trigger: b.dataset.v }); renderPage(); });
  dw.addEventListener("input", () => { putSoon("dwellMs", HT_clampDwell(dw.value)); renderDwell(); });
  dw.addEventListener("change", () => { flush("dwellMs"); put({ dwellMs: HT_clampDwell(dw.value) }); });
  // способ показа
  for (const r of document.querySelectorAll('input[name="displayMode"]')) r.addEventListener("change", () => { put({ displayMode: r.value }); renderPage(); });
  // подсветка
  $("dispMode").addEventListener("change", (e) => { put({ dispMode: e.target.value }); renderPage(); });
  $("dispOpacity").addEventListener("input", (e) => { putSoon("dispOpacity", Number(e.target.value), 150); renderSwatches(); });
  $("dispOpacity").addEventListener("change", (e) => { flush("dispOpacity"); put({ dispOpacity: Number(e.target.value) }); });
  $("showLangBadge").addEventListener("click", () => { put({ showLangBadge: st.showLangBadge === false }); renderPage(); });
  // языки
  $("targetLang").addEventListener("change", (e) => {
    const code = e.target.value;
    let recent = Array.isArray(st.recentLangs) ? st.recentLangs.filter((c) => LANG_LABEL[c]) : [];
    recent = pushRecent(pushRecent(recent, st.targetLang), code);
    put({ targetLang: code, recentLangs: recent });
    ui.bi.fail = false; ui.bi.again = false;
    refreshBuiltin();
    render();
  });
  $("sourceLang").addEventListener("change", (e) => { put({ sourceLang: e.target.value }); render(); });
  $("formality").addEventListener("change", (e) => put({ formality: e.target.value }));
  // слова
  $("noTranslate").addEventListener("input", (e) => putSoon("noTranslate", e.target.value, 400));
  $("noTranslate").addEventListener("blur", (e) => { if (pending.noTranslate) { flush("noTranslate"); put({ noTranslate: e.target.value }); } });
  // клавиши и данные
  $("keysEdit").addEventListener("click", () => { chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {}); });
  $("clearCache").addEventListener("click", clearSaved);
  $("resetBtn").addEventListener("click", () => askReset(true));
  $("resetNo").addEventListener("click", () => askReset(false));
  $("resetYes").addEventListener("click", resetAll);
  $("resetRow").addEventListener("keydown", (e) => { if (e.key === "Escape" && resetAsk) { e.preventDefault(); askReset(false); } });
  renderReset();
}

// ---------- изменения из других мест ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (!st) return;
  if (area === "session") {
    if (changes.htNetErr) { ui.net = changes.htNetErr.newValue || null; ui.keyEdited = { deepl: false, llm: false }; render(); }
    if (changes.htFocus && changes.htFocus.newValue) applyFocus(changes.htFocus.newValue);
    return;
  }
  if (area !== "local") return;
  let touched = false;
  for (const k in changes) {
    if (k === "htLcacheBytes" || k === "statChars") { fetchStatsSoon(); continue; }
    if (!(k in DEFAULTS) || pending[k]) continue;
    const v = changes[k].newValue === undefined ? DEFAULTS[k] : changes[k].newValue;
    if (JSON.stringify(st[k]) === JSON.stringify(v)) continue;
    st[k] = v;
    touched = true;
    if (k === "engine") { ui.sel = HT_valid("engine", v); ui.prov = null; }
    if (k === "llmProvider") { ui.prov = null; ui.modelDraft = null; }
    if (k === "apiKey" || k === "llmApiKey" || k === "llmProvider" || k === "llmKeyBy") { ui.ver++; ui.dl.err = null; ui.llm.err = null; }
    if (k === "apiKey" || k === "keyVerified") ui.quota = null;
    if (k === "targetLang") refreshBuiltin();
  }
  if (touched) { HT_validAll(st); render(); }
});
let statsTimer = null;
function fetchStatsSoon() { clearTimeout(statsTimer); statsTimer = setTimeout(fetchStats, 1000); }

// ---------- загрузка ----------
async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  HT_validAll(s);
  s.consent = HT_consent(s.consent);
  s.llmModel = typeof s.llmModel === "string" ? s.llmModel.trim() : "";
  st = s;
  ui.sel = st.engine;
}
(async () => {
  initStatic();
  await loadSettings();
  try { ui.net = (await chrome.storage.session.get("htNetErr")).htNetErr || null; } catch (e) { ui.net = null; }
  render(true);
  spy();
  renderKeys();
  fetchStats();
  if ((ui.sel === "deepl" || ui.sel === "auto") && deeplReady()) fetchQuota();
  await refreshBuiltin();
  let f = null;
  try { f = (await chrome.storage.session.get("htFocus")).htFocus; } catch (e) { f = null; }
  if (f) applyFocus(f);
})();
