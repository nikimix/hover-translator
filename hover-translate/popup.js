// popup.js — окно расширения (редизайн «А»). Шапка с «Везде» → язык перевода и недавние →
// место действия (всегда 72 px) → строка «Переводить на <сайт>» → подвал (переводчик, мини-панель,
// настройки). Переводчик, ключи, согласия, способ показа — на странице настроек (options.html); отсюда туда
// ведут кнопки (сообщение openSettings в background).
//
// Вид окна — функция от модели: факты (хранилище, вкладка и её content-скрипт, встроенный переводчик, сбой
// сервиса) → derive() → модель вида (простые данные: номер состояния 0…19, тексты, кнопки с именами
// действий) → render(). Любое состояние можно нарисовать для проверки: HT_popup.render(модель) или
// HT_popup.show(факты) — после этого окно больше не перерисовывается само.
//
// Порядок, в котором выбирается состояние (первое подходящее):
//   вкладка недоступна (10 служебная, 11 открыта до установки) → выключено везде (9) → выключено на сайте (8)
//   → переводчик не может работать (12–16, по HT_engineProblem) → сбой сервиса (17–19, storage.session.htNetErr)
//   → загрузка встроенного не удалась (14) → состояние страницы (3 перевод, 4 переведена, 5 оригинал, 6 часть)
//   → встроенный надо скачать (1, 2) → обычное (0) или «страница уже на языке перевода» (7).

HT_localize(document);

const TOP = { frameId: 0 };
const RECENT_MAX = 6;                    // недавних языков храним с запасом: в чипах нет текущего и исходного
const NET_FRESH_MS = 10 * 60 * 1000;     // временный сбой сети старше 10 минут не показываем
const LLM_SHORT = { openai: "ChatGPT", anthropic: "Claude" };
const SERVICE = { deepl: "DeepL", openai: "OpenAI", anthropic: "Anthropic" };
const WEBSTORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i;
const LANG_LABEL = Object.fromEntries(HT_TARGET_LANGS);
const { h, ic } = HT_ui;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- факты ----------
// s — настройки (ключи — только факт, есть ли они); tab — активная вкладка: { id, url, kind: "web" | "closed" |
// "unknown", loading, pending (ответа content ещё ждём) }; ts — tabState от content-скрипта (null — не ответил);
// bi — HT_builtin.status() (только когда переводит встроенный); dl — загрузка встроенного из окна: { run, pct } |
// { fail } | { again }; net — htNetErr; keys — сочетания команд; doing — действие, которое сейчас выполняется.
const F = { s: null, tab: null, ts: null, bi: null, dl: null, net: null, keys: { toggle: "", page: "" },
  hasApi: HT_builtin.hasApi(), mac: HT_isMac(), doing: "", now: 0 };

async function readSettings() {
  const d = Object.assign({}, HT_DEFAULTS, { apiKey: "", llmApiKey: "", recentLangs: [], consent: {}, disabledSites: [] });
  let s = d;
  try { s = await chrome.storage.local.get(d); } catch (e) { /* хранилище недоступно — значения по умолчанию */ }
  HT_validAll(s);
  const key = typeof s.apiKey === "string" ? s.apiKey.trim() : "";
  return {
    enabled: s.enabled !== false, targetLang: s.targetLang, sourceLang: s.sourceLang, engine: s.engine,
    trigger: s.trigger, llmProvider: s.llmProvider,
    apiKey: !!key, apiKeyFree: key.endsWith(":fx"), llmApiKey: !!(typeof s.llmApiKey === "string" && s.llmApiKey.trim()),
    consent: HT_consent(s.consent),
    recentLangs: Array.isArray(s.recentLangs) ? s.recentLangs.filter((c) => LANG_LABEL[c]) : [],
    disabledSites: HT_sites(s.disabledSites),
  };
}

async function readNet() {
  try { return (chrome.storage.session && (await chrome.storage.session.get("htNetErr")).htNetErr) || null; }
  catch (e) { return null; }
}

// Что за вкладка — по адресу. Адрес окну виден благодаря activeTab (окно открыли значком или сочетанием клавиш).
function tabKind(url) {
  if (!url) return "unknown";
  if (/^https?:/i.test(url) && !WEBSTORE.test(url)) return "web";
  return "closed";   // chrome://, магазин Chrome, страницы расширений, file:// без доступа, about:
}

async function queryTab() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) { /* нет вкладки */ }
  if (!tab || tab.id == null) return { id: null, url: "", kind: "unknown", loading: false };
  const url = tab.url || tab.pendingUrl || "";
  return { id: tab.id, url, kind: tabKind(url), loading: tab.status === "loading" };
}

// Сообщение верхнему фрейму вкладки; null — content-скрипта нет (или не ответил).
async function ask(msg, frames) {
  if (!F.tab || F.tab.id == null) return null;
  try { const r = await chrome.tabs.sendMessage(F.tab.id, msg, frames || TOP); return r == null ? null : r; }
  catch (e) { return null; }
}
const okState = (r) => (r && r.ok && typeof r === "object" ? r : null);

async function readCommands() {
  const keys = { toggle: "", page: "" };
  try {
    for (const c of await chrome.commands.getAll()) {
      if (c.name === "toggle-enabled") keys.toggle = c.shortcut || "";
      if (c.name === "translate-page") keys.page = c.shortcut || "";
    }
  } catch (e) { /* без сочетаний */ }
  return keys;
}

// ---------- производные ----------
const netSt = (s) => ({ apiKey: s.apiKey, llmApiKey: s.llmApiKey, llmProvider: s.llmProvider, consent: s.consent,
  targetLang: s.targetLang, sourceLang: s.sourceLang });
// Язык страницы: по ответам переводчика, иначе атрибут lang.
const pageLangOf = (ts) => (ts ? String(ts.src || ts.lang || "") : "");

// Сбой сервиса, который относится к выбранному переводчику (DeepL — и для «Авто»), или null.
function netFor(s, net, now) {
  if (!net || typeof net !== "object" || !net.code) return null;
  const e = HT_engine(s.engine);
  if (net.via !== e.via) return null;
  if (net.via === "llm" && net.provider !== HT_valid("llmProvider", s.llmProvider)) return null;
  const temp = net.code === "network" || net.code === "timeout" || net.code === "server";
  if (temp && net.at && now - net.at > NET_FRESH_MS) return null;
  return net;
}

// Переводит ли сейчас встроенный (он сам или «Авто», которому DeepL недоступен).
function usesBuiltin(s, net) {
  const e = HT_engine(s.engine);
  if (e.via === "local") return true;
  return e.fallback === "local" && (!HT_canSend(e.code, netSt(s)) || !!net);
}

// Короткое имя переводчика для подвала: «Встроенный», «DeepL», «Авто», «ChatGPT», «Claude».
function shortName(s) {
  if (s.engine === "chrome") return HT_t("ppNameBuiltin");
  if (s.engine === "auto") return HT_t("ppNameAuto");
  if (s.engine === "deepl") return "DeepL";
  return LLM_SHORT[HT_valid("llmProvider", s.llmProvider)];
}
const footText = (name, status) => HT_t("ppFoot", [name, status]);
// Имя без состояния — там, где перевод не работает вовсе (8–11): серая точка и просто имя.
const plainName = (s) => (s.engine === "chrome" ? HT_t("ppNameBuiltinFull") : shortName(s));

// Подвал, когда всё работает: имя переводчика. У «Авто» — ещё коротко, почему он сейчас без DeepL.
function footNormal(s, net) {
  if (s.engine === "chrome") return { dot: "", text: HT_t("ppNameBuiltinFull") };
  if (s.engine !== "auto") return { dot: "", text: shortName(s) };
  const name = HT_t("ppNameAuto");
  if (net) {
    if (net.code === "bad-key") return { dot: "err", text: footText(name, HT_t("ppStBadKey")) };
    if (net.code === "quota") return { dot: "warn", text: footText(name, HT_t("ppStAutoQuota")) };
    if (net.code === "server") return { dot: "warn", text: footText(name, HT_t("ppStServer")) };
    return { dot: "warn", text: footText(name, HT_t("ppStNet")) };
  }
  if (!s.apiKey) return { dot: "warn", text: footText(name, HT_t("ppStNoKey")) };
  if (!HT_agreed(s.consent, "deepl")) return { dot: "warn", text: footText(name, HT_t("ppStConsent")) };
  if (HT_langGap("deepl", netSt(s))) return { dot: "warn", text: footText(name, HT_t("ppStLang")) };
  return { dot: "", text: name };
}

// Недавние языки для чипов: без текущего и без языка страницы. Кандидатов — до 5: показываются первые 3,
// которые влезают в строку (fit), — длинное «Español (Latinoamérica)» не вытесняет остальные.
function chipsOf(recent, target, pageLang) {
  const page = pageLang ? HT_langKey(pageLang) : "";
  return recent.filter((c) => c !== target && LANG_LABEL[c] && (!page || HT_langKey(c) !== page)).slice(0, 5);
}

// «Английский → русский»; язык оригинала неизвестен или совпадает — «На русский».
function pairText(src, target) {
  if (!src || HT_langKey(src) === HT_langKey(target)) return HT_t("intoLang", HT_langLabel(target));
  return HT_ui.pair(src, target);
}

// Имя сайта: от content-скрипта, иначе по адресу вкладки.
function siteOf(tab, ts) {
  if (ts && HT_isSite(ts.site)) return ts.site;
  if (ts) return "";                     // content есть, но сайта нет (файл) — выключать нечего
  if (tab && tab.kind === "web") {
    try { const s = HT_siteKey(new URL(tab.url).hostname); return HT_isSite(s) ? s : ""; } catch (e) { return ""; }
  }
  return "";
}

const btn = (label, run, o) => Object.assign({ label, run, primary: true }, o || {});
const sec = (label, run, o) => Object.assign({ label, run, primary: false }, o || {});

// ---------- факты → модель вида ----------
function derive(f) {
  const s = f.s, t = f.tab || { kind: "unknown" }, ts = okState(f.ts);
  const target = s.targetLang;
  const pageLang = pageLangOf(ts);
  const net = netFor(s, f.net, f.now || Date.now());
  const v = {
    n: 0, on: s.enabled, target,
    chips: chipsOf(s.recentLangs, target, pageLang),
    scopeTip: f.keys.toggle ? HT_t("ppScopeTipKey", f.keys.toggle) : HT_t("ppScopeTip"),
    act: null, site: null,
    foot: Object.assign({ mini: null }, footNormal(s, net)),
  };
  const off = () => { v.foot = { dot: "off", text: plainName(s), mini: null }; };

  // 10/11 — на вкладке нет content-скрипта. Пока вкладка грузится или ответа ещё ждём — считаем, что есть.
  const live = !!ts || (t.kind === "web" && (t.loading || t.pending));
  if (!live) {
    off();
    if (t.kind === "web") {
      v.n = 11;
      const busy = f.doing === "reload";
      v.act = { k: "btn", icon: busy ? "spin" : "refresh", label: HT_t(busy ? "ppReloading" : "ppReload"), run: "reload", busy,
        hint: [HT_t("ppReloadHint")] };
    } else {
      v.n = 10;
      v.act = { k: "off", t: HT_t("ppClosedT"), d: HT_t("ppClosedD") };
    }
    return v;
  }
  const site = siteOf(t, ts);
  const siteOff = !!site && s.disabledSites.includes(site);
  if (site) v.site = { name: site, on: !siteOff, dis: !s.enabled };

  if (!s.enabled) { v.n = 9; off(); v.act = { k: "off", t: HT_t("ppAllOffT"), d: HT_t("ppAllOffD") }; return v; }
  if (siteOff) { v.n = 8; off(); v.act = { k: "off", t: HT_t("ppSiteOffT"), d: HT_t("ppSiteOffD") }; return v; }
  v.foot.mini = !!(ts && ts.hud);

  // 12, 13, 15, 16 — выбранный переводчик не может работать
  const prob = HT_engineProblem(s.engine, netSt(s), f.hasApi);
  if (prob) return problem(v, prob, s);
  // 17–19 — последний ответ сервиса был ошибкой («Авто» в это время переводит встроенным — только подвал)
  if (net && s.engine !== "auto") return netProblem(v, net, s, f.doing);
  const local = usesBuiltin(s, net);
  // 14 — загрузка встроенного из окна не удалась
  if (local && f.dl && f.dl.fail) {
    v.n = 14;
    v.act = { k: "prob", kind: "err", icon: "alert", t: HT_t("ppDlFailT"), d: HT_t("ppDlFailD"),
      buttons: [btn(HT_t("ppRetry"), "download", { icon: "refresh" })] };
    v.foot.dot = "err"; v.foot.text = footText(HT_t("ppNameBuiltin"), HT_t("ppStFail"));
    return v;
  }

  // 3–6 — что с переводом страницы
  const page = ts ? ts.page : "idle";
  const pair = pairText(pageLang, target);
  if (page === "busy") {
    v.n = 3;
    v.act = { k: "busy", done: Math.max(0, Number(ts.done) || 0), total: Math.max(0, Number(ts.total) || 0), hint: [HT_t("ppRestLater")] };
    return v;
  }
  if (page === "done" || page === "orig") {
    v.n = page === "done" ? 4 : 5;
    v.act = { k: "seg", tr: page === "done", hint: [HT_t(page === "done" ? "ppEscHint" : "ppOrigHint", pair)] };
    return v;
  }
  const translate = { k: "btn", icon: "languages", label: HT_t("translatePage"), run: "translate", title: f.keys.page || "" };
  if (page === "part" && Number(ts.count) > 0) {
    v.n = 6;
    v.act = Object.assign(translate, { hint: [HT_plural("ppPartDone", Number(ts.count)) + " · ", { link: HT_t("ppShowOrig"), run: "restore" }] });
    return v;
  }

  // 1, 2 — встроенный переводчик ещё не скачан
  if (local) {
    const bi = f.bi || {};
    const pp = bi.src ? { src: bi.src, tgt: bi.tgt } : HT_prepPair(target, pageLang);
    const biPair = pp.tgt ? HT_ui.pair(pp.src, pp.tgt) : "";
    if ((f.dl && f.dl.run) || bi.kind === "downloading") {
      const pct = f.dl && f.dl.run && typeof f.dl.pct === "number" ? f.dl.pct : null;
      v.n = 2;
      v.act = { k: "prog", pct, label: HT_t(pct == null ? "ppDownloadingWait" : "ppDownloading"), hint: [biPair] };
      v.foot.dot = "busy"; v.foot.text = footText(HT_t("ppNameBuiltin"), HT_t("ppStDl"));
      return v;
    }
    if (bi.kind === "need") {
      v.n = 1;
      v.act = { k: "btn", icon: "download", label: HT_t("ppDownload"), run: "download",
        hint: [f.dl && f.dl.again ? HT_t("ppDlAgain") : HT_t("ppOffline", biPair)] };
      v.foot.dot = "warn"; v.foot.text = footText(HT_t("ppNameBuiltin"), HT_t("ppStNeed"));
      return v;
    }
  }

  // 0 / 7 — обычное; страница уже на языке перевода (по атрибуту lang) — кнопка всё равно активна
  const already = !!(ts && ts.lang && HT_langKey(ts.lang) === HT_langKey(target));
  v.n = already ? 7 : 0;
  const key = HT_triggerKey(s.trigger, f.mac);
  v.act = Object.assign(translate, { hint: already ? [HT_t("ppAlready")] : key ? keyHint(key) : [HT_t("ppHintDwell")] });
  return v;
}

// «Абзац — наведите курсор и нажмите [Shift]»: клавиша — отдельной плашкой, порядок слов — из сообщения.
function keyHint(key) {
  const MARK = "";
  const parts = HT_t("ppHintKey", MARK).split(MARK);
  return [parts[0] || "", { kbd: key }, parts[1] || ""];
}

// 12, 13, 15, 16 — причина из HT_engineProblem.
function problem(v, p, s) {
  const prov = HT_provider(s.engine, s.llmProvider);
  const name = shortName(s);
  const llm = HT_engine(s.engine).via === "llm";
  const settings = (label, focus, o) => btn(label, "settings", Object.assign({ arg: focus }, o || {}));
  if (p === "no-builtin") {
    v.n = 12;
    v.act = { k: "prob", kind: "warn", icon: "puzzle", t: HT_t("ppNoBuiltinT"), d: HT_t("ppNoBuiltinD"),
      buttons: [settings(HT_t("ppOpenSettings"), "translator")] };
    v.foot.dot = "warn"; v.foot.text = footText(HT_t("ppNameBuiltin"), HT_t("ppStNone"));
  } else if (p === "builtin-lang" || p === "deepl-lang") {
    const bi = p === "builtin-lang";
    const gap = HT_langGap(bi ? "local" : "deepl", netSt(s)) || { dir: "to", code: s.targetLang };
    const lang = HT_ui.cap(HT_langLabel(gap.code));
    v.n = 13;
    if (gap.dir === "from") {
      v.act = { k: "prob", kind: "warn", icon: "languages", t: HT_t(bi ? "ppBiLangFromT" : "ppDlLangFromT"),
        d: HT_t("ppLangFromD", lang), buttons: [settings(HT_t("ppOpenSettings"), "source-lang")] };
    } else {
      const d = bi ? (HT_deeplCode(gap.code) ? HT_t("ppLangDeeplAiD", lang) : HT_t("ppLangAiD", lang))
        : (HT_builtinCode(gap.code) ? HT_t("ppLangBiAiD", lang) : HT_t("ppLangAiD", lang));
      v.act = { k: "prob", kind: "warn", icon: "languages", t: HT_t(bi ? "ppBiLangT" : "ppDlLangT"), d,
        buttons: [btn(HT_t("ppPickLang"), "pickLang"), sec(HT_t("ppOpenSettings"), "settings", { arg: "translator" })] };
    }
    v.foot.dot = "warn"; v.foot.text = footText(bi ? HT_t("ppNameBuiltin") : "DeepL", HT_t("ppStLang"));
  } else if (p === "no-consent") {
    v.n = 15;
    v.act = { k: "prob", kind: "info", icon: "shield", t: HT_t("ppConsentT", SERVICE[prov] || name),
      d: HT_t("ppConsentD", HT_PROVIDER_NAMES[prov] || name),
      buttons: [btn(HT_t("ppAllowSend"), "consent"), sec(HT_t("useBuiltin"), "builtin")] };
    v.foot.dot = "warn"; v.foot.text = footText(name, HT_t("ppStConsent"));
  } else {   // no-deepl-key, no-llm-key
    v.n = 16;
    v.act = { k: "prob", kind: "warn", icon: "key", t: HT_t("ppNoKeyT", SERVICE[prov] || name),
      d: llm ? HT_t("ppNoKeyLlmD", [name, SERVICE[prov]]) : HT_t("ppNoKeyDeeplD"),
      buttons: [settings(HT_t("ppAddKey"), llm ? "llm-key" : "deepl-key"), sec(HT_t("useBuiltin"), "builtin")] };
    v.foot.dot = "warn"; v.foot.text = footText(name, HT_t("ppStNoKey"));
  }
  return v;
}

// 17–19 — последний сбой сервиса (storage.session.htNetErr).
function netProblem(v, x, s, doing) {
  const llm = x.via === "llm";
  const svc = llm ? SERVICE[x.provider] || "" : "DeepL";
  const name = shortName(s);
  const keyFocus = llm ? "llm-key" : "deepl-key";
  const toBuiltin = sec(HT_t("useBuiltin"), "builtin");
  const set = (n, kind, icon, t, d, buttons, dot, status) => {
    v.n = n;
    v.act = { k: "prob", kind, icon, t, d, buttons };
    v.foot.dot = dot; v.foot.text = footText(name, status);
    return v;
  };
  const checking = doing === "recheck";
  const recheck = btn(HT_t(checking ? "ppChecking" : "ppRecheck"), "recheck", { icon: checking ? "spin" : "refresh", busy: checking });
  switch (x.code) {
    case "bad-key":
      return set(17, "err", "alert", HT_t("ppBadKeyT", svc), HT_t("ppBadKeyD", svc),
        [btn(HT_t("ppCheckKey"), "settings", { arg: keyFocus })], "err", HT_t("ppStBadKey"));
    case "denied":
      return set(17, "err", "alert", HT_t("ppDeniedT", svc), HT_t("ppDeniedD"),
        [btn(HT_t("useBuiltin"), "builtin"), sec(HT_t("ppOpenSettings"), "settings", { arg: "translator" })], "err", HT_t("ppStDenied"));
    case "quota":
      if (!llm) {
        return set(18, "warn", "gauge", HT_t("ppQuotaT"), HT_t(s.apiKeyFree ? "ppQuotaD" : "ppQuotaOwnD"),
          [btn(HT_t("ppAuto"), "auto")], "warn", HT_t("ppStQuota"));
      }
    // falls through — у ИИ «quota» значит то же, что пустой счёт
    case "money":
      return set(18, "warn", "gauge", HT_t("ppMoneyT", svc), HT_t("ppMoneyD"),
        [btn(HT_t("useBuiltin"), "builtin"), sec(HT_t("ppOpenSettings"), "settings", { arg: "translator" })], "warn", HT_t("ppStMoney"));
    case "server":
      return set(19, "warn", "wifiOff", HT_t("ppServerT", svc), HT_t("ppServerD"), [recheck, toBuiltin], "warn", HT_t("ppStServer"));
    default:   // network, timeout
      return set(19, "warn", "wifiOff", HT_t("ppNetT", svc), HT_t("ppNetD"), [recheck, toBuiltin], "warn", HT_t("ppStNet"));
  }
}

// ---------- модель вида → DOM ----------
let el = null;          // постоянные части окна
let last = null;        // последняя нарисованная модель
let frozen = false;     // нарисовано руками (HT_popup.render/show) — живые обновления не перерисовывают

function build() {
  const root = document.getElementById("popup");
  const sw = HT_ui.switchBtn(true, { "aria-label": HT_t("ppScopeAria"), onclick: () => act("scope") });
  const scope = h("label", { class: "p-scope" }, h("span", null, HT_t("ppScope")), sw);
  const sel = HT_ui.select("target", HT_TARGET_LANGS, null, { onchange: (e) => act("lang", e.target.value) });
  const chips = h("div", { class: "chips", role: "group", "aria-label": HT_t("ppRecent") });
  const body = h("div", { class: "p-body" },
    h("div", { class: "field" }, h("label", { class: "lbl", for: "target" }, HT_t("ppLang")), sel.wrap, chips));
  const dot = h("span", { class: "dot" });
  const stT = h("span", { class: "st-t" });
  const status = h("button", { type: "button", class: "status", title: HT_t("ppStatusTip"), onclick: () => act("settings", "translator") },
    dot, stT, ic("chevRight", 16, "chev"));
  const mini = h("button", { type: "button", class: "icon-btn", "aria-label": HT_t("ppMini"), onclick: () => act("mini") }, ic("panel"));
  const gear = h("button", { type: "button", class: "icon-btn", "aria-label": HT_t("ppSettings"), title: HT_t("ppSettings"),
    onclick: () => act("settings", "") }, ic("gear"));
  const foot = h("div", { class: "p-foot" }, status, mini, gear);
  const siteSlot = h("div", { class: "p-site" });
  root.textContent = "";
  root.append(h("div", { class: "p-head" }, HT_ui.logo(24), h("span", { class: "p-title" }, HT_t("extShortName")), scope), body, siteSlot, foot);
  el = { root, sw, scope, sel: sel.sel, chips, body, actEl: null, siteSlot, dot, stT, mini, foot };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function render(v) {
  if (!el) build();
  const prev = last;
  last = v;
  // шапка
  el.sw.setAttribute("aria-checked", String(!!v.on));
  el.scope.title = v.scopeTip;
  // язык и недавние
  if (el.sel.value !== v.target) el.sel.value = v.target;
  if (!prev || !same(prev.chips, v.chips)) {
    const had = el.chips.contains(document.activeElement);
    el.chips.textContent = "";
    for (const c of v.chips) {
      el.chips.append(h("button", { type: "button", class: "chip", lang: HT_langBase(c), onclick: () => { act("lang", c); el.sel.focus(); } }, LANG_LABEL[c]));
    }
    el.chips.hidden = !v.chips.length;
    if (had) el.sel.focus();
  }
  // место действия
  if (!prev || !same(prev.act, v.act)) {
    if (prev && prev.act && prev.act.k === "busy" && v.act.k === "busy" && same(prev.act.hint, v.act.hint)) patchBusy(v.act);
    else {
      const had = el.actEl && el.actEl.contains(document.activeElement);
      const focusKey = had && document.activeElement.dataset ? document.activeElement.dataset.k : "";
      const node = actNode(v.act);
      if (el.actEl) el.actEl.replaceWith(node); else el.body.append(node);
      el.actEl = node;
      if (had) {
        const t = (focusKey && node.querySelector(`[data-k="${focusKey}"]`)) || node.querySelector("button:not([disabled]), [tabindex='0']");
        if (t) t.focus();
      }
    }
  }
  // строка сайта: нет сайта (служебная вкладка, файл) — полосы нет совсем
  if (!prev || !same(prev.site, v.site)) {
    el.siteSlot.textContent = "";
    el.siteSlot.hidden = !v.site;
    if (v.site) el.siteSlot.append(siteRow(v.site));
  }
  // подвал
  el.dot.className = "dot" + (v.foot.dot ? " " + v.foot.dot : "");
  el.stT.textContent = v.foot.text;
  el.mini.hidden = v.foot.mini == null;
  el.mini.setAttribute("aria-pressed", String(!!v.foot.mini));
  el.mini.title = HT_t(v.foot.mini ? "ppMiniHide" : "ppMini");
  fit();
  return v;
}

// Подсказка — одна строка: текст, плашки клавиш и кнопки-ссылки.
function hintNode(parts) {
  const p = h("p", { class: "hint" });
  for (const x of parts || []) {
    if (typeof x === "string") p.append(x);
    else if (x.kbd) p.append(h("span", { class: "kbd" }, x.kbd));
    else if (x.link) p.append(h("button", { type: "button", class: "link-btn", "data-k": "link-" + x.run, onclick: () => act(x.run) }, x.link));
  }
  p.title = p.textContent;   // обрезанную многоточием строку можно прочитать целиком
  return p;
}

function actNode(a) {
  if (a.k === "off") {
    return h("div", { class: "p-off", role: "status" }, h("p", { class: "p-off-t" }, a.t), h("p", { class: "p-off-d" }, a.d));
  }
  if (a.k === "prob") {
    return h("div", { class: "p-prob" },
      h("div", { class: "notice notice-" + a.kind, role: a.kind === "err" ? "alert" : "status" }, ic(a.icon),
        h("div", { class: "notice-b" }, h("p", { class: "notice-t" }, a.t), h("p", { class: "notice-d" }, a.d))),
      a.buttons.map(buttonNode));
  }
  let main;
  if (a.k === "btn") main = buttonNode(Object.assign({ primary: true }, a));
  else if (a.k === "prog") {
    const known = typeof a.pct === "number";
    main = h("div", { class: "prog", role: "status" },
      h("div", { class: "prog-top" }, h("span", null, a.label), h("span", { class: "pct" }, known ? HT_num(Math.round(a.pct)) + "%" : "")),
      HT_ui.progress(known ? a.pct : null, a.label));
  } else if (a.k === "busy") {
    const n = h("span", { class: "n" });
    const bar = h("span", { class: "progress", role: "progressbar", "aria-label": HT_t("ppBusyAria"), "aria-valuemin": "0" }, h("span"));
    main = h("div", { class: "p-act-row" },
      h("div", { class: "p-busy", role: "status", "aria-live": "polite" },
        h("span", { class: "p-busy-t" }, ic("spin", 16), h("span", null, HT_t("ppBusy") + " ", n)), bar),
      h("button", { type: "button", class: "btn btn-secondary", "data-k": "stop", onclick: () => act("stop") }, HT_ui.stopIc(), HT_t("ppStop")));
    fillBusy(main, a);
  } else if (a.k === "seg") {
    const opt = (tr) => h("button", { type: "button", role: "radio", "aria-checked": String(a.tr === tr), tabindex: a.tr === tr ? "0" : "-1",
      "data-k": tr ? "tr" : "orig", onclick: () => act(tr ? "tr" : "orig"), onkeydown: segKey }, HT_t(tr ? "ppTr" : "ppOrig"));
    main = h("div", { class: "seg", role: "radiogroup", "aria-label": HT_t("ppSegAria") }, opt(false), opt(true));
  }
  return h("div", { class: "p-act" }, main, hintNode(a.hint));
}

// «Перевожу… N из M» обновляем на месте: спиннер не перезапускается, фокус на «Стоп» не теряется.
function patchBusy(a) { if (el && el.actEl) fillBusy(el.actEl, a); }
function fillBusy(root, a) {
  const box = root.querySelector(".p-busy");
  if (!box) return;
  box.querySelector(".n").textContent = a.total ? HT_t("ppBusyN", [HT_num(a.done), HT_num(a.total)]) : "";
  const bar = box.querySelector(".progress");
  if (a.total) {
    bar.setAttribute("aria-valuemax", String(a.total));
    HT_ui.setProgress(bar, Math.min(100, (100 * a.done) / a.total));
    bar.setAttribute("aria-valuenow", String(a.done));
  } else HT_ui.setProgress(bar, null);
}

// Сегмент — radiogroup: стрелки переключают и сразу применяют выбор.
function segKey(e) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const other = [...e.currentTarget.parentNode.children].find((b) => b !== e.currentTarget);
  if (other && other.getAttribute("aria-checked") !== "true") other.click();
  if (other) other.focus();
}

function buttonNode(b) {
  const cls = "btn btn-block " + (b.primary ? "btn-primary" : "btn-secondary");
  return h("button", { type: "button", class: cls, title: b.title || null, disabled: !!b.busy, "aria-busy": b.busy ? "true" : null,
    "data-k": b.run + (b.arg ? "-" + b.arg : ""), onclick: () => act(b.run, b.arg) }, b.icon ? ic(b.icon) : null, b.label);
}

function siteRow(st) {
  const MARK = "";
  const parts = HT_t("ppSiteRow", MARK).split(MARK);
  const b = h("b", null, st.name);
  const text = h("span", { class: "srow-t" }, parts[0] || "", b, parts[1] || "");
  const sw = HT_ui.switchBtn(st.on, { disabled: st.dis, class: "switch" + (st.dis ? " is-disabled" : ""), onclick: () => act("site") });
  return h("label", { class: "srow" + (st.dis ? " is-disabled" : ""), title: st.name, "data-full": st.name }, text, sw);
}

// После разметки: длинный домен режем с начала («…example-news-site.co.uk»), чипы, которые не влезли, убираем.
function fit() {
  const row = el.siteSlot.querySelector(".srow-t");
  if (row) {
    const b = row.querySelector("b");
    const full = row.parentNode.dataset.full;
    b.textContent = full;
    // самый длинный хвост имени, который влезает (видна узнаваемая часть: сайт и зона)
    // (ширину текста меряем точно: scrollWidth округлён, а многоточие CSS появляется от любой доли пикселя)
    const range = document.createRange();
    const over = () => { range.selectNodeContents(row); return range.getBoundingClientRect().width > row.getBoundingClientRect().width + 0.01; };
    for (let i = 1; over() && i < full.length - 4; i++) b.textContent = "\u2026" + full.slice(i);
  }
  const box = el.chips;
  if (!box.hidden) {
    for (const c of box.children) c.hidden = true;
    const right = box.getBoundingClientRect().right;
    let shown = 0;
    for (const c of box.children) {
      if (shown >= 3) break;
      c.hidden = false;
      if (c.getBoundingClientRect().right > right + 0.5) c.hidden = true; else shown++;
    }
  }
}

// ---------- действия ----------
const ACTIONS = {
  scope: () => store({ enabled: !F.s.enabled }),
  site: toggleSite,
  lang: setTarget,
  translate: () => ask({ type: "translatePage", via: "popup" }).then((r) => { if (r == null) refreshTab(); }),
  tr: () => ACTIONS.translate(),
  stop: () => ask({ type: "stopPage" }).then((r) => { if (okState(r)) { F.ts = r; update(); } }),
  orig: restoreAll,
  restore: restoreAll,
  mini: () => ask({ type: "toggleHud" }).then((r) => { if (okState(r)) { F.ts = r; update(); } }),
  settings: (focus) => {
    chrome.runtime.sendMessage({ type: "openSettings", focus: focus || "" }).catch(() => {});
  },
  pickLang: () => {
    el.sel.focus();
    try { el.sel.showPicker(); } catch (e) { /* без раскрытия — фокус на списке */ }
  },
  consent: allowSend,
  builtin: () => store({ engine: "chrome" }),
  auto: () => store({ engine: "auto" }),
  download,
  reload: reloadTab,
  recheck,
};
function act(name, arg) {
  if (frozen) return;
  const fn = ACTIONS[name];
  if (fn) return fn(arg);
}

// Запись настроек: сразу в факты (окно отвечает без задержки), затем в хранилище.
function store(o) {
  Object.assign(F.s, o);
  update();
  return chrome.storage.local.set(o).catch(async () => { F.s = await readSettings(); update(); });
}

function setTarget(code) {
  if (!LANG_LABEL[code] || code === F.s.targetLang) return;
  const prev = F.s.targetLang;
  const recent = [code, prev].concat(F.s.recentLangs.filter((c) => c !== code && c !== prev)).filter((c) => LANG_LABEL[c]).slice(0, RECENT_MAX);
  F.dl = null;
  store({ targetLang: code, recentLangs: recent });
}

// Список выключенных сайтов общий с мини-панелью на страницах — читаем свежий перед записью.
async function toggleSite() {
  const v = last;
  if (!v || !v.site || v.site.dis) return;
  const name = v.site.name;
  let list = [];
  try { list = HT_sites((await chrome.storage.local.get({ disabledSites: [] })).disabledSites); } catch (e) { /* пустой */ }
  const off = !list.includes(name);
  list = list.filter((x) => x !== name);
  if (off) list.push(name);
  store({ disabledSites: list.slice(-HT_SITES_MAX) });
}

// «Оригинал» и «Показать оригинал» — всем фреймам вкладки (во встроенных окнах свой content-скрипт).
function restoreAll() {
  return ask({ type: "restoreAll" }, {}).then((r) => { if (r == null) refreshTab(); });
}

// «Разрешить отправку» — согласие на сервис выбранного переводчика, только на него.
async function allowSend() {
  const prov = HT_provider(F.s.engine, F.s.llmProvider);
  if (!prov) return;
  let cur = {};
  try { cur = (await chrome.storage.local.get({ consent: {} })).consent; } catch (e) { /* пустое */ }
  const next = Object.assign(HT_consent(cur), { [prov]: true });
  store({ consent: next });
}

// «Скачать переводчик» / «Повторить»: prepare() — сразу из обработчика щелчка (нужно действие пользователя).
function download() {
  if (F.dl && F.dl.run) return;
  const pl = pageLangOf(okState(F.ts));
  const target = F.s.targetLang;
  F.dl = { run: true, pct: null };
  const job = HT_builtin.prepare(target, pl, (pct) => { if (F.dl && F.dl.run) { F.dl = { run: true, pct }; update(); } });
  update();
  return job.then(async (r) => {
    if (r.ok) { F.dl = null; await refreshBuiltin(true); }
    else F.dl = r.again ? { again: true } : { fail: true };
    update();
  }, () => { F.dl = { fail: true }; update(); });
}

// «Обновить вкладку»: перезагрузить и дождаться content-скрипта (он запускается по document_idle, после
// «complete» даём ему до 2 с). Не дождались — значит, сюда расширения не пускают (состояние 10).
async function reloadTab() {
  if (F.doing === "reload" || !F.tab || F.tab.id == null) return;
  F.doing = "reload"; update();
  const id = F.tab.id;
  let ok = false;
  try {
    await chrome.tabs.reload(id);
    let completeAt = 0;
    for (let i = 0; i < 80 && !ok; i++) {
      await sleep(250);
      const t = await chrome.tabs.get(id);
      if (t.status !== "complete") { completeAt = 0; continue; }
      const r = okState(await ask({ type: "getHudState" }));
      if (r) { F.ts = r; ok = true; break; }
      if (!completeAt) completeAt = Date.now();
      else if (Date.now() - completeAt > 2000) break;
    }
  } catch (e) { /* вкладку закрыли */ }
  F.doing = "";
  if (!ok) F.tab = Object.assign({}, F.tab, { kind: "closed", loading: false, pending: false });
  update();
}

// «Проверить снова»: ключ DeepL (usage) или ИИ (одно слово); успешный ответ снимает htNetErr в background.
async function recheck() {
  if (F.doing === "recheck" || !F.net) return;
  F.doing = "recheck"; update();
  try { await chrome.runtime.sendMessage({ type: F.net.via === "llm" ? "checkLlm" : "checkUsage" }); } catch (e) { /* ниже — что записано */ }
  F.net = await readNet();
  F.doing = "";
  update();
}

// ---------- обновление ----------
let biKey = "";
let stopWatch = null;
// Состояние встроенного переводчика — только когда он переводит; пара зависит от языка перевода и страницы.
async function refreshBuiltin(force) {
  const s = F.s;
  if (!s || !usesBuiltin(s, netFor(s, F.net, Date.now())) || !F.hasApi) { biKey = ""; F.bi = null; return; }
  const pl = pageLangOf(okState(F.ts));
  const key = s.targetLang + "|" + pl;
  if (!force && key === biKey) return;
  biKey = key;
  const st = await HT_builtin.status(s.targetLang, pl).catch(() => null);
  if (key !== biKey) return;           // за это время сменили язык — ответ устарел
  F.bi = st;
  if (stopWatch) { stopWatch(); stopWatch = null; }
  // Загрузку начали без окна (на сайте или на приветствии) — ждём, пока Chrome докачает.
  if (st && st.kind === "downloading" && !(F.dl && F.dl.run)) {
    stopWatch = HT_builtin.watch(s.targetLang, pl, (done) => { stopWatch = null; if (biKey === key) { F.bi = done; update(); } });
  }
}

function update() {
  if (!F.s || !F.tab || frozen) return;
  F.now = Date.now();
  render(derive(F));
  refreshBuiltin(false).then(() => { if (!frozen) render(derive(F)); });
}

// Вкладка и её content-скрипт. Ответа нет, а вкладка ещё грузится — ждём content до конца загрузки + 2 с.
let tabTimer = null;
async function refreshTab() {
  const tab = await queryTab();
  F.tab = tab;
  const r = okState(await ask({ type: "getHudState" }));
  F.ts = r;
  update();
  clearTimeout(tabTimer);
  if (!r && tab.kind === "web") waitContent(tab.id, 0);
}
function waitContent(id, completeAt) {
  tabTimer = setTimeout(async () => {
    let t = null;
    try { t = await chrome.tabs.get(id); } catch (e) { return; }
    const r = okState(await ask({ type: "getHudState" }));
    if (r) { F.ts = r; F.tab.loading = false; update(); return; }
    const loading = t.status !== "complete";
    if (!loading && completeAt && Date.now() - completeAt > 2000) { F.tab.loading = false; update(); return; }
    F.tab.loading = true;
    waitContent(id, loading ? 0 : completeAt || Date.now());
  }, 300);
}

// ---------- запуск ----------
(async () => {
  // Ответ content ждём недолго: на тяжёлой странице он может задержаться — тогда рисуем окно как для
  // рабочей вкладки и дорисовываем, когда ответ придёт.
  const tabP = queryTab().then(async (tab) => {
    F.tab = tab;
    const r = ask({ type: "getHudState" }).then(okState);
    const first = await Promise.race([r, sleep(400).then(() => undefined)]);
    if (first === undefined) {
      tab.pending = true;
      r.then((x) => {
        tab.pending = false;
        F.ts = x;
        if (!x && tab.kind === "web") { tab.loading = true; waitContent(tab.id, 0); }
        update();
      });
      return;
    }
    F.ts = first;
    if (!first && tab.kind === "web" && tab.loading) waitContent(tab.id, 0);
  });
  const [s, net, keys] = await Promise.all([readSettings(), readNet(), readCommands(), tabP]);
  F.s = s; F.net = net; F.keys = keys;
  await Promise.race([refreshBuiltin(false), sleep(300)]);
  update();
})();

// Пуши от вкладки: «Перевожу… N из M», переведено, оригинал, мини-панель.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "pageState" || !F.tab || !sender || !sender.tab) return;
  if (sender.tab.id !== F.tab.id || (sender.frameId != null && sender.frameId !== 0)) return;
  if (!okState(msg.state)) return;
  F.ts = msg.state;
  if (F.tab.kind !== "web" || F.tab.loading || F.tab.pending) F.tab = Object.assign({}, F.tab, { loading: false, pending: false });
  update();
});

// Вкладка перезагрузилась, пока окно открыто, — спросить её заново.
chrome.tabs.onUpdated.addListener((id, info) => {
  if (F.tab && id === F.tab.id && info.status === "complete" && F.doing !== "reload") {
    ask({ type: "getHudState" }).then((r) => { r = okState(r); if (r) { F.ts = r; update(); } });
  }
});

const WATCH = ["enabled", "targetLang", "sourceLang", "engine", "trigger", "llmProvider", "apiKey", "llmApiKey", "consent", "recentLangs", "disabledSites"];
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && "htNetErr" in changes) { F.net = changes.htNetErr.newValue || null; update(); return; }
  if (area !== "local" || !WATCH.some((k) => k in changes)) return;
  F.s = await readSettings();
  update();
});

// Отладка и проверки: нарисовать любое состояние. show(факты) — через derive(), render(модель) — как есть.
window.HT_popup = {
  facts: F,
  derive,
  view: () => last,
  render: (v) => { frozen = true; return render(v); },
  show: (f) => {
    frozen = true;
    const x = Object.assign({}, F, { now: Date.now() }, f, { s: Object.assign({}, F.s, f && f.s), keys: Object.assign({}, F.keys, f && f.keys) });
    return render(derive(x));
  },
  live: () => { frozen = false; update(); },
};
