// welcome.js — страница приветствия (welcome.html). Открывается при установке (background.js, onInstalled) и
// со страницы настроек («Как пользоваться»), поэтому всё берёт из настоящего: скачан ли переводчик, какой
// переводчик выбран, каким способом включается перевод.
// Всё, что здесь меняют, сразу пишется в chrome.storage.local — как из окна расширения.
//
// Шаг 2 — подготовка и проба в одном месте. Состояние — data-stage у #step2:
//   start        — «Скачать переводчик» + пара языков; абзац для пробы приглушён и выключен (translate="no");
//   downloading  — полоса загрузки (с процентом, когда Chrome его сообщает; до того — бегущая);
//   ready        — абзац обведён: «Наведите курсор на абзац и нажмите <клавиша>», «Ещё можно выделить слово…»
//                  (та же клавиша — перевод выделенного в карточке) + «Переводить наведением»;
//   ready-hover  — то же для наведения + «Вернуть <клавиша>»;
//   success      — текст абзаца сменился (его перевёл content.js) → «Работает! Так же — на любом сайте»;
//   failed       — загрузка не удалась → «Повторить»;
//   no-builtin   — выбран встроенный, а его нет в браузере → «Подключите переводчик» + «Открыть настройки»;
//   problem      — выбранный переводчик не может работать по другой причине (нет ключа, согласия, язык) —
//                  раскладка no-builtin со своим текстом (на макете такого нет).
// DeepL или ИИ выбраны и готовы — сразу ready: встроенный качать незачем.

HT_localize(document);   // статический текст разметки — из сообщений (_locales)

const { h, ic } = HT_ui;
const $ = (id) => document.getElementById(id);
const MAC = HT_isMac();
// Место клавиши в тексте подсказки: по нему текст делится, и на это место встаёт <span class="kbd">.
const KEY_MARK = "";

// Что нужно знать о выбранном переводчике (как для HT_engineProblem); ключи — только факт, что они есть.
const NET_KEYS = { engine: HT_DEFAULTS.engine, apiKey: "", llmApiKey: "", llmProvider: HT_DEFAULTS.llmProvider, consent: {}, sourceLang: HT_DEFAULTS.sourceLang };
const S = {
  target: HT_DEFAULTS.targetLang,
  trigger: HT_DEFAULTS.trigger,
  lastKey: "shift",           // клавиша для «Вернуть …» — какой переводили до наведения
  net: Object.assign({}, NET_KEYS),
  mode: null,                 // engineMode(): кто переведёт абзац для пробы
  stage: "",
  pct: null,                  // ход загрузки 0..100, null — пока неизвестен (бегущая полоса)
  again: false,               // Chrome не дал запустить вторую модель — нажать кнопку ещё раз
  failed: false,              // последняя загрузка не удалась
  worked: false,              // абзац для пробы перевёлся
};
let gen = 0;                  // поколение проверки: ответ прежней (до смены языка) не рисуем
let busy = false;             // идёт наша загрузка (HT_builtin.prepare)
let stopWatch = null;         // ждём, пока Chrome докачает начатое без нас
let prog = null;              // { bar, pct } — полоса на экране, обновляется на месте
let detRetries = 0;           // сколько раз перепроверили детектор языка (см. refresh)

// ---- статичные части: значок, иконки, список языков ----
$("logo").append(HT_ui.logo(56, "p-logo"));
$("num1").append(ic("check", 16));
$("langWrap").append(ic("chevDown", 16));
$("pinExt").prepend(ic("puzzle", 16));
$("pinArrow").append(ic("chevRight", 16));
$("pinOur").prepend(HT_ui.logo(18, "p-logo"));
$("pinOur").append(h("span", { class: "pin-mark" }, ic("pin", 16)));
const sel = $("targetLang");
HT_fillSelect(sel, HT_TARGET_LANGS);
$("moreBtn").addEventListener("click", () => openSettings("translator"));

// ---- абзац для пробы ----
// Три варианта в разметке (en, ru, es); виден один — на исходном языке пары (HT_prepPair): обычно английский,
// а если переводят на английский — русский при русском интерфейсе, иначе испанский.
const TRY = $("try");
const ORIG = new Map([...TRY.children].map((p) => [p, p.textContent.trim()]));
let tryP = null;
function pickTry() {
  const src = HT_prepPair(S.target).src;
  const want = TRY.querySelector(`p[lang="${src}"]`) || TRY.querySelector('p[lang="en"]');
  for (const p of TRY.children) p.hidden = p !== want;
  tryP = want;
}
// off — нет абзаца; wait — приглушён и не переводится; ready — обведён, переводится; okay — перевёлся.
function setTry(mode) {
  TRY.hidden = mode === "off";
  for (const m of ["wait", "ready", "okay"]) TRY.classList.toggle(m, m === mode);
  if (mode === "ready" || mode === "okay") TRY.removeAttribute("translate");
  else TRY.setAttribute("translate", "no");
}
// Перевёл ли content.js абзац: сменился текст видимого варианта. Обратно (Shift, Esc) — успех остаётся.
new MutationObserver(() => {
  if (S.worked || !tryP || (S.stage !== "ready" && S.stage !== "ready-hover")) return;
  const now = tryP.textContent.trim();
  if (now && now !== ORIG.get(tryP)) { S.worked = true; setStage("success"); }
}).observe(TRY, { characterData: true, childList: true, subtree: true });

// ---- кто переведёт абзац ----
function engineState() {
  return { apiKey: !!S.net.apiKey, llmApiKey: !!S.net.llmApiKey, llmProvider: S.net.llmProvider, consent: S.net.consent,
    targetLang: S.target, sourceLang: HT_valid("sourceLang", S.net.sourceLang) };
}
// { mode: "net" } — DeepL или ИИ готовы; "builtin" — встроенный (в том числе «Авто» без ключа или согласия);
// "no-builtin"; "problem" — с кодом причины p (HT_engineProblem или ответ HT_builtin.status).
function engineMode() {
  const engine = HT_valid("engine", S.net.engine);
  const st = engineState();
  const e = HT_engine(engine);
  if (e.via !== "local" && HT_canSend(engine, st)) return { mode: "net" };
  const p = HT_engineProblem(engine, st, HT_builtin.hasApi());
  if (p === "no-builtin") return { mode: "no-builtin" };
  if (p) return { mode: "problem", p, via: e.via };
  return { mode: "builtin" };
}

// Узнать состояние и нарисовать. Встроенный качается сейчас без нас (страницу открыли во время загрузки) —
// ждём его через HT_builtin.watch.
async function refresh() {
  const my = ++gen;
  if (stopWatch) { stopWatch(); stopWatch = null; }
  const m = engineMode();
  if (m.mode !== "builtin") { S.mode = m; setStage(m.mode === "net" ? readyStage() : m.mode); return; }
  if (busy) return;           // идёт наша загрузка — по её окончании refresh() позовут снова
  const st = await HT_builtin.status(S.target).catch(() => ({ kind: "need" }));
  if (my !== gen || busy) return;
  S.mode = m;
  if (st.kind === "ready") setStage(readyStage());
  else if (st.kind === "downloading") {
    S.pct = null;
    setStage("downloading");
    stopWatch = HT_builtin.watch(S.target, undefined, () => { stopWatch = null; refresh(); });
  } else if (st.kind === "need") {
    setStage(S.failed ? "failed" : "start");
    // Первые секунды после запуска Chrome детектор языка отвечает «downloadable», хотя модель уже на компьютере
    // (замерено на 157: ~2 с), — пара готова, ждём только его: проверяем ещё несколько раз, без щелчка.
    if (st.pair === "available" && detRetries++ < 5) setTimeout(() => { if (my === gen && !busy) refresh(); }, 1500);
  } else if (st.kind === "none") { S.mode = { mode: "no-builtin" }; setStage("no-builtin"); }
  else { S.mode = { mode: "problem", p: st.kind, via: "local" }; setStage("problem"); }   // no-lang, pair-unavailable
}
function readyStage() { return S.worked ? "success" : S.trigger === "dwell" ? "ready-hover" : "ready"; }

// «Скачать переводчик» / «Повторить» — из обработчика щелчка: create() расходует действие пользователя.
async function download() {
  if (busy) return;
  busy = true;
  gen++;
  if (stopWatch) { stopWatch(); stopWatch = null; }
  S.failed = false; S.again = false; S.pct = null;
  setStage("downloading");
  let r;
  try {
    r = await HT_builtin.prepare(S.target, undefined, (pct) => { S.pct = pct; showProgress(); });
  } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  busy = false;
  if (!r.ok && r.again) S.again = true;
  else if (!r.ok) S.failed = true;
  refresh();
}

// ---- рисование ----
function setStage(stage) { S.stage = stage; render(); }

function keyName() { return HT_triggerKey(S.trigger === "dwell" ? S.lastKey : S.trigger, MAC); }
// Пара для подписей: «Английский → русский» (с заглавной) или «английский → русский» (после «Готово:»).
function pairCodes() {
  const p = HT_prepPair(S.target);
  return { src: p.src, tgt: p.tgt || S.target };
}
function pairText(lower) {
  const { src, tgt } = pairCodes();
  return lower ? HT_t("pairArrow", [HT_langLabel(src), HT_langLabel(tgt)]) : HT_ui.pair(src, tgt);
}
// Текст с клавишей: KEY_MARK в сообщении → <span class="kbd">.
function withKey(msg, key) {
  const [a, b] = msg.split(KEY_MARK);
  return h("span", null, a, h("span", { class: "kbd" }, key), b || "");
}
function notice(kind, icon, title, text, role) {
  return h("div", { class: "notice notice-" + kind, role: role || null }, ic(icon),
    h("div", { class: "notice-b" }, h("p", { class: "notice-t" }, title), h("p", { class: "notice-d" }, text)));
}
const okLine = () => h("p", { class: "w-ok ok-t" }, ic("checkCircle", 18), h("span", null, HT_t("wlReady", pairText(true))));
const waitCap = () => h("p", { class: "w-cap muted" }, HT_t("wlWaitCap"));
const settingsBtn = (focus) => h("div", { class: "w-act" },
  h("button", { type: "button", class: "btn btn-primary", onclick: () => openSettings(focus) }, HT_t("wlOpenSettings")));

// Текст причины, по которой выбранный переводчик не работает, и куда вести в настройках.
function problemText(m) {
  const lang = m.p === "deepl-lang" || m.p === "builtin-lang" || m.p === "no-lang" || m.p === "pair-unavailable";
  const why = m.p === "pair-unavailable" ? HT_t("wlPairNo", pairText(true))
    : HT_problemText(m.p === "no-lang" ? "builtin-lang" : m.p, "short", engineState());
  return HT_t(lang ? "wlProbLang" : "wlProbFix", HT_ui.cap(why));
}
function problemFocus(m) {
  if (m.p === "no-deepl-key") return "deepl-key";
  if (m.p === "no-llm-key") return "llm-key";
  if (m.p === "no-consent") return m.via === "llm" ? "llm" : "deepl";
  return "translator";
}

function render() {
  const stage = S.stage;
  const step = $("step2");
  step.dataset.stage = stage;
  const done = stage === "success";
  step.classList.toggle("done", done);
  const num = $("num2");
  num.textContent = "";
  num.append(done ? ic("check", 16) : "2");
  const conn = stage === "no-builtin" || stage === "problem";
  $("t2").textContent = HT_t(conn ? "wlStep2Conn" : "wlStep2");
  $("d2").hidden = conn;
  // «Нужен перевод точнее?» — не там, где шаг 2 сам ведёт в настройки, и не когда DeepL или ИИ уже работают.
  $("more").hidden = conn || !!(S.mode && S.mode.mode === "net");
  $("lead").textContent = S.trigger === "dwell" ? HT_t("wlLeadDwell") : HT_t("wlLeadKey", keyName());

  const refocus = document.activeElement && document.activeElement.closest && document.activeElement.closest("#step2 .link-btn");
  const top = $("s2top"), bottom = $("s2bottom");
  top.textContent = "";
  bottom.textContent = "";
  prog = null;
  pickTry();

  if (stage === "start") {
    top.append(h("div", { class: "w-act" },
      h("button", { type: "button", class: "btn btn-primary", id: "dlBtn", onclick: download }, ic("download"), HT_t("wlDownload")),
      h("span", { class: "muted" }, S.again ? HT_t("wlOnceMore") : HT_t("wlOnce", pairText(false)))));
    setTry("wait");
    bottom.append(waitCap());
  } else if (stage === "downloading") {
    const label = HT_t("wlDlLabel");
    const bar = HT_ui.progress(S.pct, label);
    const pct = h("span", { class: "pct", "aria-hidden": "true" });
    top.append(h("div", { class: "prog w-prog", role: "status" }, h("div", { class: "prog-top" }, h("span", null, label), pct), bar));
    prog = { bar, pct };
    showProgress();
    setTry("wait");
    // Проверено в Chrome 157: закрыли страницу на ~10 % — Chrome докачал
    // переводчик сам, без единой страницы расширения.
    bottom.append(h("div", null, waitCap(), h("p", { class: "w-cap muted" }, HT_t("wlDlGoesOn"))));
  } else if (stage === "ready" || stage === "ready-hover") {
    const hover = stage === "ready-hover";
    top.append(okLine());
    setTry("ready");
    // С клавишей — ещё строка о выделенном: та же клавиша переводит его в карточке. Только до успеха: после него
    // текст для пробы уже переведён, а клавиша над переведённым возвращает оригинал, а не переводит выделенное.
    bottom.append(h("div", null,
      h("p", { class: "w-cap" }, hover ? h("span", null, HT_t("wlTryDwell")) : withKey(HT_t("wlTryKey", KEY_MARK), keyName())),
      hover ? null : h("p", { class: "w-cap muted", id: "trySel" }, HT_t("wlTrySel")),
      h("p", { class: "w-cap muted" },
        h("span", null, hover ? HT_t("wlIsHover") : HT_t("wlNoKey")),
        h("button", { type: "button", class: "link-btn", onclick: () => setTrigger(hover ? S.lastKey : "dwell") },
          hover ? HT_t("wlBackKey", HT_triggerKey(S.lastKey, MAC)) : HT_t("wlToHover")))));
  } else if (stage === "success") {
    top.append(okLine());
    setTry("okay");
    // «Для других языков Chrome скачает переводчик…» — только когда переводит встроенный.
    const back = S.trigger === "dwell" ? HT_t("wlWorksDwell") : HT_t("wlWorksKey", keyName());
    const local = !(S.mode && S.mode.mode === "net");
    bottom.append(notice("ok", "checkCircle", HT_t("wlWorks"), local ? back + " " + HT_t("wlWorksMore") : back, "status"));
  } else if (stage === "failed") {
    top.append(notice("err", "alert", HT_t("wlFailT"), HT_t("wlFailD"), "alert"));
    top.append(h("div", { class: "w-act" },
      h("button", { type: "button", class: "btn btn-primary", id: "dlBtn", onclick: download }, ic("refresh"), HT_t("wlRetry"))));
    setTry("wait");
    bottom.append(waitCap());
  } else if (stage === "no-builtin") {
    top.append(notice("warn", "puzzle", HT_t("wlNoT"), HT_t("wlNoD"), "status"));
    top.append(settingsBtn("translator"));
    setTry("off");
  } else if (stage === "problem") {
    top.append(notice("warn", "warn", HT_t("probTitle"), problemText(S.mode), "status"));
    top.append(settingsBtn(problemFocus(S.mode)));
    setTry("off");
  } else {
    setTry("off");            // состояние ещё не известно (первые миллисекунды)
  }
  // «Переводить наведением» ↔ «Вернуть Shift» — та же ссылка на том же месте: фокус остаётся на ней.
  if (refocus) { const l = bottom.querySelector(".link-btn"); if (l) l.focus(); }
}

function showProgress() {
  if (!prog) return;
  HT_ui.setProgress(prog.bar, S.pct);
  prog.pct.textContent = typeof S.pct === "number" ? Math.round(S.pct) + "%" : "";
}

// ---- действия ----
function setTrigger(t) {
  if (S.trigger !== "dwell") S.lastKey = S.trigger;
  S.trigger = t;
  setStage(S.stage === "ready" || S.stage === "ready-hover" ? readyStage() : S.stage);
  chrome.storage.local.set({ trigger: t }).catch(() => {});
}

function setTarget(v) {
  S.target = v;
  S.worked = false; S.failed = false; S.again = false;
  refresh();
}

// Страница настроек с прокруткой к разделу (background: openSettings); не ответил — просто открыть её.
function openSettings(focus) {
  chrome.runtime.sendMessage({ type: "openSettings", focus }).catch(() => chrome.runtime.openOptionsPage());
}

sel.addEventListener("change", () => {
  setTarget(sel.value);
  chrome.storage.local.set({ targetLang: sel.value }).catch(() => {});
});

// ---- начало и изменения из других мест (окно расширения, настройки) ----
chrome.storage.local.get(Object.assign({ targetLang: HT_DEFAULTS.targetLang, trigger: HT_DEFAULTS.trigger }, NET_KEYS), (s) => {
  HT_validAll(s);
  S.target = s.targetLang;
  sel.value = s.targetLang;
  S.trigger = s.trigger;
  if (s.trigger !== "dwell") S.lastKey = s.trigger;
  for (const k in NET_KEYS) S.net[k] = s[k];
  render();
  refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let again = false;
  if (changes.targetLang) {
    const v = HT_valid("targetLang", changes.targetLang.newValue);
    if (v !== S.target) { sel.value = v; S.target = v; S.worked = false; S.failed = false; S.again = false; again = true; }
  }
  for (const k in NET_KEYS) {
    if (!changes[k]) continue;
    S.net[k] = changes[k].newValue === undefined ? NET_KEYS[k] : changes[k].newValue;
    again = true;
  }
  if (changes.trigger) {
    const t = HT_valid("trigger", changes.trigger.newValue);
    if (t !== S.trigger) {
      if (S.trigger !== "dwell") S.lastKey = S.trigger;
      S.trigger = t;
      if (!again) setStage(S.stage === "ready" || S.stage === "ready-hover" ? readyStage() : S.stage);
    }
  }
  if (again) refresh();
});

// Вернулись на вкладку — переводчик могли скачать в другом месте (окно расширения, сайт).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy && S.stage !== "success") refresh();
});
