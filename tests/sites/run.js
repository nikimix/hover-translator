#!/usr/bin/env node
// Живые сайты: не ломаются ли интерактивные элементы после перевода.
// Не входит в tests/run.sh — сеть и сайты нестабильны. Как запускать — tests/sites/README.md.
//
//   node tests/sites/run.js                     все сайты из tests/sites/sites.js
//   node tests/sites/run.js --only wikipedia,mdn
//   node tests/sites/run.js --profile DIR       свой тестовый профиль Chrome (не копируется и не удаляется; cookies
//                                               в нём очищаются перед каждым сайтом — профиль человека не годится)
//   node tests/sites/run.js --src DIR           откуда копировать профиль со скачанными моделями
//                                               (по умолчанию ~/.cache/ht-tests/profile-store)
//   node tests/sites/run.js --ext DIR           откуда брать расширение (по умолчанию hover-translate рабочего
//                                               дерева). Снимок коммита, пока рабочее дерево правят:
//                                               git archive HEAD hover-translate tests/lib | tar -x -C DIR/..
//                                               (tests/lib/live.js рядом со снимком берётся вместо рабочего)
//   node tests/sites/run.js --shots DIR         куда класть скриншоты (по умолчанию tests/shots/sites)
//   node tests/sites/run.js --json FILE         подробные результаты в JSON
//   node tests/sites/run.js --no-baseline       без прогона без расширения (ошибки не с чем сравнить)
//   node tests/sites/run.js --base-only         только прогон без расширения (отладка селекторов сайта)
//   node tests/sites/run.js --trace-lang        в копию content.js — console.debug языка каждого куска
//                                               (chromeTranslate): какой язык детектор дал коротким подписям
//   node tests/sites/run.js --keep              не удалять временную папку (профиль-копию и журналы)
//   node tests/sites/run.js --headed            Chrome с окном (по умолчанию без интерфейса)
//   node tests/sites/run.js --list              список сайтов
//
// По каждому сайту два прогона с одинаковыми действиями мыши и клавиатуры:
//   base — Chrome без расширения (чистый временный профиль): какие ошибки консоли у сайта и так есть;
//   ext  — Chrome с расширением (копия профиля с моделями встроенного переводчика).
// Шаги: загрузка → [prepare: баннер cookie] → key: наведение + Shift на элемент site.key → действия сайта →
// page: «Перевести страницу» (сообщение translatePage, как из окна; уведомления за время перевода — все, что
// показались) → скриншоты светлой и тёмной темы → действия → [scroll: подгрузка ленты] → orig: Esc (перед ним —
// что content.js счёл бы «открытым у сайта») → действия, проверка, что текст, вписанный сайтом после перевода, не
// затёрт → nav: «Перевести страницу» ещё раз (состояние перед переходом — navPage) и переход по ссылке; после
// перехода (у SPA — без перезагрузки) — переводится ли новое содержимое само и на месте ли плавающая кнопка.
// Доля перевода — по первым 4000 знакам основного текста (main) и по тексту, видимому на экране.
// Перед каждым сайтом — cookies браузера и хранилище сайта очищаются (баннеры согласия — как в первый раз, и в
// сохранённом профиле --profile тоже).
// Новые ошибки консоли — те, которых нет в прогоне base (ключ без чисел и адресов); у наших в стеке
// chrome-extension://.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib");
const SITES = require("./sites");

// ---------- аргументы ----------
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (flag("--help") || flag("-h")) {
  const src = fs.readFileSync(__filename, "utf8").split("\n");
  console.log(src.slice(1, src.findIndex((l, i) => i > 0 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
if (flag("--list")) {
  for (const s of SITES) console.log(`${s.id.padEnd(12)} ${s.url}  (${s.lang} → ${s.target || "RU"})  ${s.title}`);
  process.exit(0);
}
const only = opt("--only", "") ? opt("--only").split(",").map((s) => s.trim()) : null;
const sites = SITES.filter((s) => !only || only.includes(s.id));
if (!sites.length) { console.error("нет сайтов: " + (only || []).join(",") + " (см. --list)"); process.exit(2); }

const CACHE = process.env.HT_TMP || path.join(os.homedir(), ".cache", "ht-tests");
const SRC_PROFILE = opt("--src", path.join(os.homedir(), ".cache", "ht-tests", "profile-store"));
const SHOTS = path.resolve(opt("--shots", path.join(L.ROOT, "tests", "shots", "sites")));
const JSON_OUT = opt("--json", "");
// Расширение: папка hover-translate (по умолчанию — рабочего дерева). Если рядом со снимком лежит tests/lib/live.js
// (git archive HEAD hover-translate tests/lib), берём его: слой нашего интерфейса на странице — того же коммита.
const EXT_DIR = path.resolve(opt("--ext", L.EXT_SRC));
if (!fs.existsSync(path.join(EXT_DIR, "manifest.json"))) { console.error("нет расширения: " + EXT_DIR + "/manifest.json (--ext)"); process.exit(2); }
// Цель перевода сайта — код из таблицы целевых языков shared.js (не "EN": это только язык оригинала).
{
  let codes;
  try { codes = L.targetLangs(EXT_DIR); } catch (e) { console.error("не прочитал целевые языки из " + path.join(EXT_DIR, "shared.js") + ": " + e.message); process.exit(2); }
  const bad = sites.filter((s) => !codes.includes(s.target || "RU"));
  if (bad.length) {
    for (const s of bad) {
      const near = codes.filter((c) => c.split("-")[0] === String(s.target).toUpperCase().split("-")[0]);
      console.error(`${s.id}: target ${JSON.stringify(s.target)} — не целевой язык расширения (HT_TARGET_LANGS в shared.js)` +
        (near.length ? `; годится ${near.join(" / ")}` : ""));
    }
    process.exit(2);
  }
}
const LIVE_FILE = [path.join(EXT_DIR, "..", "tests", "lib", "live.js")].find((f) => EXT_DIR !== L.EXT_SRC && fs.existsSync(f)) || require.resolve("../lib/live");
const { pageUi, fabUi, centerOf } = require(LIVE_FILE);
// --profile: перед каждым сайтом cookies браузера очищаются целиком (Network.clearBrowserCookies) — годится только
// тестовый профиль, не профиль Chrome человека.
if (opt("--profile", "")) {
  const own = path.resolve(opt("--profile"));
  const real = [".config/google-chrome", ".config/google-chrome-beta", ".config/google-chrome-unstable", ".config/chromium"]
    .map((d) => path.join(os.homedir(), d));
  if (real.some((d) => own === d || own.startsWith(d + path.sep))) {
    console.error(`--profile ${own}: это профиль Chrome человека — скрипт очищает в профиле cookies. Нужен тестовый профиль.`);
    process.exit(2);
  }
}
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
// Языки браузера: английский первым (сайты отдают английский интерфейс — его и переводим), русский в списке —
// иначе пара en → ru для встроенного переводчика «скрыта» и на каждом сайте нужен щелчок.
const ACCEPT_LANG = "en-US,en,ru";

fs.mkdirSync(CACHE, { recursive: true });
const RUN_TMP = fs.mkdtempSync(path.join(CACHE, "ht-sites-"));
process.env.TMPDIR = RUN_TMP;
let cleaned = false;
const browsers = [];
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const b of browsers) {
    await b.ctx.close().catch(() => {});
  }
  if (!flag("--keep")) fs.rmSync(RUN_TMP, { recursive: true, force: true });
  else console.log("временная папка оставлена: " + RUN_TMP);
}
process.on("SIGINT", () => { console.log("\nпрервано"); cleanup().then(() => process.exit(130)); });
process.on("SIGTERM", () => { cleanup().then(() => process.exit(143)); });

const BASE_ONLY = flag("--base-only");
const TRACE_LANG = flag("--trace-lang");
const sleep = L.sleep;
const log = (...a) => console.log(...a);

// ---------- профиль ----------
function prepareProfile() {
  const own = opt("--profile", "");
  if (own) {
    if (!fs.existsSync(own)) {
      log(`профиль ${own} не найден — копирую ${SRC_PROFILE}`);
      copyProfile(SRC_PROFILE, own);
    }
    return path.resolve(own);
  }
  const dst = path.join(RUN_TMP, "profile");
  log(`копия профиля с моделями: ${SRC_PROFILE} → ${dst}`);
  copyProfile(SRC_PROFILE, dst);
  return dst;
}
function copyProfile(src, dst) {
  if (!fs.existsSync(src)) throw new Error("нет профиля-источника " + src + " (--src): в нём должны быть скачаны модели встроенного переводчика en↔ru");
  const skip = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache"]);
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !skip.has(path.basename(p)), verbatimSymlinks: true });
}

// ---------- --trace-lang: какой язык получил каждый кусок ----------
// Отладочная копия content.js: после определения языка в chromeTranslate — console.debug("[ht-lang]", json).
// Сам код расширения не меняется: правится только временная копия (patchExt в lib.js → launchChrome).
const TRACE_ANCHOR = "    const src = d.lang;\n";
function patchTrace(dir) {
  const f = path.join(dir, "content.js");
  const src = fs.readFileSync(f, "utf8");
  if (src.split(TRACE_ANCHOR).length !== 2) throw new Error("--trace-lang: в content.js нет ровно одной строки «const src = d.lang;» (chromeTranslate изменился)");
  fs.writeFileSync(f, src.replace(TRACE_ANCHOR, TRACE_ANCHOR +
    `    try { console.debug("[ht-lang]", JSON.stringify({ text: String(text).slice(0, 80), src: d.lang || null, kind: d.kind || null, guess: !!d.guess, byBlock: !!block })); } catch (e) { /* отладка */ }\n`));
}
// Сводка: сколько кусков на каком языке; куски с языком не страницы — примерами (guess — язык угадан по паре слов:
// модель для него не качается, см. langOf в content.js).
function langSummary(trace, pageLang) {
  const by = {};
  const odd = [];
  for (const t of trace) {
    const k = t.src || (t.kind ? "kind:" + t.kind : "не определён");
    by[k] = (by[k] || 0) + 1;
    if (t.src !== pageLang && odd.length < 40) odd.push(`«${t.text.trim().slice(0, 40)}» → ${k}${t.guess ? " (угадан)" : ""}${t.byBlock ? "" : " (без блока)"}`);
  }
  return { total: trace.length, byLang: by, notPageLang: odd };
}

// ---------- наш интерфейс на странице ----------
async function uiTexts(k) {
  try {
    const ui = await pageUi(k.tab);
    return ui.all.map((h) => h.kind + ": " + h.texts.filter((t) => t.length < 200).join(" | ")).filter((s) => !/^hud:/.test(s));
  } catch (e) { return ["(не прочитать: " + e.message.slice(0, 80) + ")"]; }
}
// Плавающая кнопка: есть ли хост на странице, нарисован ли кружок (где) и его классы (точка состояния, кольцо).
async function fabInfo(k) {
  try {
    const f = await fabUi(k.tab);
    if (!f) return { present: false };
    const c = f.fab ? await centerOf(k.tab, f.fab.nodeId) : null;
    const cls = f.host.els.filter((e) => /\bfab(-dot|-ring|-pill)?\b/.test(e.attrs.class || "")).map((e) => e.attrs.class).slice(0, 4);
    return { present: true, drawn: !!c, at: c ? [Math.round(c.x), Math.round(c.y)] : null, cls };
  } catch (e) { return { err: e.message.slice(0, 80) }; }
}
const fabStr = (f) => !f ? "?" : f.err ? "не прочитать" : !f.present ? "НЕТ" : f.drawn ? "есть" : "есть, не нарисован";

// ---------- сценарий одного сайта ----------
async function scenario(run, mode, site) {
  const ext = mode === "ext";
  const R = { mode, steps: [], errors: [], notes: [] };
  const sink = { list: R.errors, phase: "load" };
  const page = await run.ctx.newPage();
  for (const p of run.ctx.pages()) if (p !== page && !p.url().startsWith("chrome-extension://")) await p.close().catch(() => {});
  const k = await L.pageKit(run.ctx, page, sink);
  const shotNo = { key: 1, page: 2, orig: 3, nav: 4 };
  const H = {
    page, k, mode, ext, site, phase: "load", sleep,
    click: (sel, o) => k.click(sel, o),
    until: (fn, arg, ms, step) => k.until(fn, arg, ms, step),
    ev: (fn, arg) => k.ev(fn, arg),
    text: (sel) => k.text(sel),
    visible: (sel) => k.visible(sel),
    type: (s) => page.keyboard.type(s, { delay: 40 }),
    press: (key) => page.keyboard.press(key),
    ok: (cond, note) => ({ ok: !!cond, note: note || "" }),
    shot: async (name) => {
      if (!ext) return null;
      const f = path.join(SHOTS, `${site.id}-${shotNo[H.phase] || 0}-${name}.png`);
      await k.shot(f);
      (R.shots = R.shots || []).push(path.relative(L.ROOT, f));
      return f;
    },
    note: (s) => R.notes.push(`[${H.phase}] ${s}`),
    evFrame: (re, fn, arg) => k.evFrame(re, fn, arg),
    // Состояние вкладки у расширения (getHudState: page — orig/part/busy/done, count — переведённых строк); без
    // расширения — null.
    state: () => ext ? L.tabState(run, page) : Promise.resolve(null),
    // Esc при открытом меню сайта, фокус не в поле (content.js: siteOpen → Esc только сайту): меню закрывает сайт,
    // перевод остаётся. trigger — что открывает меню (щелчок), isOpen — функция для страницы (dq/vis доступны):
    // меню открыто. Не закрылось по Esc — закрываем повторным щелчком; ok — закрылось по Esc и перевод не откатился.
    // opts.siteKeepsOpen — сайт сам по Esc это меню не закрывает (проверено без расширения): тогда проверяем только,
    // что Esc ушёл сайту и перевод остался.
    escMenu: async (trigger, isOpen, arg, opts = {}) => {
      const c = await k.click(trigger);
      if (!c.ok) return c;
      if (!await k.until(isOpen, arg, 5000)) return { ok: false, note: "меню не открылось" + (c.note ? ": " + c.note : "") };
      const before = await H.state();
      const seen = ext ? await k.ev(L.SITE_OPEN).catch(() => null) : null;
      await page.keyboard.press("Escape");
      const closed = await k.until(`return !(await (${isOpen})(${JSON.stringify(arg === undefined ? null : arg)}));`, null, 3000);
      await sleep(500);
      const after = await H.state();
      if (!closed) { await k.click(trigger); await sleep(500); }
      const lost = before && after && before.count > 0 && after.count < before.count;
      return {
        ok: (!!closed || !!opts.siteKeepsOpen) && !lost,
        note: [closed ? "Esc закрыл меню" : opts.siteKeepsOpen ? "сайт по Esc меню не закрывает (и без расширения) — закрыто щелчком" : "Esc меню НЕ закрыл (закрыто щелчком)",
          before ? `перевод ${before.page}/${before.count} → ${after ? after.page + "/" + after.count : "?"}${lost ? " — ОТКАТИЛСЯ" : ""}` : "",
          seen ? "открыто для content.js: " + (seen.length ? seen.join("; ").slice(0, 160) : "ничего") : ""].filter(Boolean).join("; "),
      };
    },
  };
  const step = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await Promise.race([fn(H), sleep(90000).then(() => ({ ok: false, note: "тайм-аут 90 с" }))]);
    } catch (e) { res = { ok: false, note: "исключение: " + e.message.split("\n")[0].slice(0, 200) }; }
    res = Object.assign({ ok: true }, res || {});
    const rec = { phase: H.phase, name, ok: !!res.ok, note: res.note || "", ms: Date.now() - t0 };
    if (res.data) rec.data = res.data;
    R.steps.push(rec);
    log(`    ${mode} ${H.phase.padEnd(5)} ${res.ok ? "ok  " : "FAIL"} ${name}${res.note ? " — " + res.note : ""}`);
    return res;
  };
  const setPhase = (p) => { H.phase = p; sink.phase = p; };
  // Действие с полем phases выполняется только в этих фазах (баннер cookie: принять один раз — в фазе key).
  const runActions = async () => { for (const a of site.actions || []) if (!a.phases || a.phases.includes(H.phase)) await step(a.name, a.run); };
  const sample = async (sel = site.main) => {
    if (!sel) return null;
    const t = await k.ev((s) => { const e = dq(s); return e ? (e.innerText || "").slice(0, 4000) : ""; }, sel).catch(() => "");
    return Math.round(100 * L.scriptShare(t, (site.target || "RU") === "RU" ? "cyr" : "lat"));
  };
  // Доля перевода в тексте, видимом на экране (вся страница, без нашего интерфейса).
  const visShare = async () => {
    const t = await k.ev(L.VIS_TEXT, null).catch(() => "");
    return Math.round(100 * L.scriptShare(t, (site.target || "RU") === "RU" ? "cyr" : "lat"));
  };
  // Ждать конца перевода страницы (не busy; первые 2,5 с — не верим idle: перевод мог ещё не начаться) и собрать все
  // уведомления, что показались за это время («Страница переведена» висит 3 с — после конца его уже может не быть).
  const waitPage = async (maxMs) => {
    const t0 = Date.now(), seen = new Set();
    let st = null, timeout = false;
    for (;;) {
      await sleep(700);
      st = await L.tabState(run, page);
      for (const s of await uiTexts(k)) seen.add(s);
      if (st && st.page !== "busy" && Date.now() - t0 > 2500) break;
      if (Date.now() - t0 > maxMs) { timeout = true; break; }
    }
    return { st, ms: Date.now() - t0, seen: [...seen], timeout };
  };

  try {
    // ---- загрузка ----
    // Как в первый раз: без cookies (согласие, выбранная страна) и без хранилища сайта.
    await k.cdp.send("Network.clearBrowserCookies").catch(() => {});
    await k.cdp.send("Storage.clearDataForOrigin", { origin: new URL(site.url).origin, storageTypes: "local_storage,indexeddb,cache_storage,service_workers" }).catch(() => {});
    R.load = await L.gotoSettled(page, site.url, 3500);
    R.load.url = page.url();
    R.load.title = await k.title().catch(() => "");
    H.load = R.load;
    log(`  ${mode}: ${R.load.status} ${R.load.title.slice(0, 70)}`);
    if (site.blocked) {
      const b = await site.blocked(H).catch(() => null);
      if (b) { R.blocked = b; log(`  ${mode}: закрыто — ${b}`); return R; }
    }
    if (site.prepare) await step("подготовка: " + (site.prepareName || "баннер"), site.prepare);
    if (ext) {
      // Детектор языка первые секунды после запуска Chrome отвечает «downloadable», хотя модель есть.
      const det = await k.until(() => LanguageDetector.availability().then((a) => a === "available" ? a : null), null, 40000, 1500);
      R.builtin = await k.ev((p) => Promise.all([LanguageDetector.availability(), Translator.availability({ sourceLanguage: p[0], targetLanguage: p[1] })]),
        [site.lang, (site.target || "RU").toLowerCase()]).catch((e) => e.message);
      if (!det) R.notes.push("детектор языка так и не стал available: " + JSON.stringify(R.builtin));
    }
    // Щелчок по баннеру дал странице «действие пользователя» (~5 с): ждём, чтобы перевод начинался как у
    // человека, который не щёлкал только что.
    await sleep(6000);
    R.snap = await k.ev(L.SNAP, site.target || "RU").catch(() => null);
    if (ext) R.nested = await k.ev(L.NESTED).catch((e) => ({ err: e.message }));

    // ---- key: один элемент клавишей ----
    setPhase("key");
    // site.key — селектор или функция-поиск для страницы (её текст вставляется в выражение): найденный элемент
    // помечаем data-ht-sites=key и дальше работаем с ним по этой метке.
    let keySel = site.key;
    if (typeof site.key === "function") {
      keySel = "[data-ht-sites~=key]";
      const found = await k.ev(`const e = (${site.key})(); if (!e) return null; e.setAttribute("data-ht-sites", "key"); return desc(e);`).catch((e) => "ошибка: " + e.message);
      R.key = { sel: "fn → " + found };
    } else R.key = { sel: site.key };
    H.keySel = keySel;
    const before = await k.text(keySel).catch(() => null);
    R.key.before = before && before.slice(0, 160);
    const pt = before != null ? await L.textPoint(k, keySel) : null;
    if (!pt) {
      R.key.note = before == null ? "нет элемента" : "нет точки над текстом";
      log(`    ${mode} key   FAIL наведение — ${R.key.note}`);
    } else {
      // Текст перекрыт (ссылка-накладка на карточку): наводим туда же, куда навёл бы человек.
      if (pt.covered) { R.key.covered = pt.covered; log(`    ${mode} key   текст перекрыт: ${pt.covered}`); }
      const t0 = Date.now();
      await L.shiftAt(page, pt);
      if (ext) {
        const changed = (a) => { const e = dq(a.sel); const t = e && (e.innerText || e.textContent || "").trim(); return t && t !== a.before ? t : null; };
        let after = await k.until(changed, { sel: keySel, before }, 30000, 400);
        if (!after) {
          const ui = await uiTexts(k);
          R.key.ui = ui;
          if (ui.some((s) => /Щёлкните/.test(s)) && !pt.covered) {   // по накладке-ссылке щёлкать нельзя — уйдём со страницы
            // Модель есть, но Chrome просит «действие пользователя» (язык не из языков браузера, детектор
            // после запуска): настоящий щелчок по тексту, как просит наше уведомление.
            R.key.clicked = true;
            await page.mouse.click(pt.x, pt.y);
            after = await k.until(changed, { sel: keySel, before }, 45000, 500);
          }
        }
        R.key.ok = !!after;
        R.key.after = after && after.slice(0, 160);
        R.key.ms = Date.now() - t0;
        R.key.state = await L.tabState(run, page);
        log(`    ext key   ${after ? "ok  " : "FAIL"} Shift → ${after ? after.slice(0, 70).replace(/\s+/g, " ") : "не перевелось"} (${R.key.ms} мс)`);
        await sleep(800);
        R.key.uiAfter = await uiTexts(k);
        await H.shot("key");
      } else await sleep(1500);
    }
    await runActions();

    // ---- page: «Перевести страницу» ----
    setPhase("page");
    await page.mouse.move(5, 5);
    if (ext) {
      R.page = { sent: await L.tabSend(run, page, { type: "translatePage", via: "popup" }) };
      const w = await waitPage(120000);
      const st = w.st;
      Object.assign(R.page, { ms: w.ms, state: st, uiSeen: w.seen }, w.timeout ? { timeout: true } : {});
      R.page.share = await sample();
      R.page.vis = await visShare();
      R.page.ui = await uiTexts(k);
      R.page.fab = await fabInfo(k);
      if (TRACE_LANG) R.page.langs = langSummary(sink.trace || [], site.lang);
      log(`    ext page  ${st && st.page === "done" ? "ok  " : "FAIL"} перевод страницы: ${st ? st.page + ", строк " + st.count : "нет ответа"}, кириллица/латиница: основной текст ${R.page.share}%, видимое ${R.page.vis}% (${R.page.ms} мс)`);
      for (const s of w.seen) log(`              уведомление: ${s.slice(0, 150)}`);
      await H.shot("page-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await sleep(1200);
      await H.shot("page-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await sleep(600);
    } else await sleep(5000);
    await k.ev(L.MUT_START).catch(() => {});
    await runActions();
    if (site.scroll) await step("прокрутка ленты", site.scroll);
    await sleep(1500);
    R.mutFrozen = await k.ev(L.MUT_FREEZE).catch(() => null);

    // ---- orig: Esc ----
    setPhase("orig");
    await k.ev(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return true; }).catch(() => {});
    await page.mouse.move(5, 5);
    // Что у сайта открыто на взгляд content.js: если не пусто, Esc достанется сайту и оригинал не вернётся.
    const siteOpen = ext ? await k.ev(L.SITE_OPEN).catch((e) => ["(ошибка: " + e.message.slice(0, 60) + ")"]) : null;
    await page.keyboard.press("Escape");
    await sleep(1500);
    if (ext) {
      R.orig = { state: await L.tabState(run, page), siteOpen };
      if (siteOpen && siteOpen.length) log(`    ext orig  у сайта открыто (Esc — сайту): ${siteOpen.join("; ").slice(0, 200)}`);
      if (R.orig.state && (R.orig.state.page === "done" || R.orig.state.page === "busy" || R.orig.state.count > 0)) {
        R.orig.escFailed = true;
        R.orig.restoreAll = await L.tabSend(run, page, { type: "restoreAll" });
        await sleep(1000);
        R.orig.stateAfterRestore = await L.tabState(run, page);
      }
      const now = await k.text(keySel).catch(() => null);
      // Без учёта пробелов: у скрытого элемента (баннер cookie после «Accept») innerText — это textContent с
      // исходными пробелами и переводами строк.
      const sp = (t) => t.replace(/\s+/g, " ").trim();
      R.orig.keyBack = before != null && now != null && sp(now) === sp(before);
      if (!R.orig.keyBack) R.orig.keyNow = now && now.slice(0, 160);
      R.orig.mut = await k.ev(L.MUT_CHECK).catch((e) => ({ err: e.message }));
      R.orig.resid = await k.ev(L.RESID).catch((e) => ({ err: e.message }));
      R.orig.share = await sample();
      log(`    ext orig  ${!R.orig.escFailed && R.orig.keyBack && !(R.orig.resid && R.orig.resid.count) ? "ok  " : "FAIL"} Esc: ${R.orig.state ? R.orig.state.page + ", строк " + R.orig.state.count : "?"}; элемент key ${R.orig.keyBack ? "вернулся" : "НЕ вернулся"}; тексты сайта после перевода: ${R.orig.mut && R.orig.mut.alive != null ? `${R.orig.mut.kept}/${R.orig.mut.alive} целы, ${R.orig.mut.reverted} — наш перевод откачен, ${R.orig.mut.changedCount} изменились` : "?"}; осталось переведённым узлов: ${R.orig.resid ? R.orig.resid.count : "?"}`);
      if (R.orig.resid && R.orig.resid.count) for (const x of R.orig.resid.examples.slice(0, 4)) log(`              ${x}`);
      await H.shot("orig");
    }
    await runActions();

    // ---- nav: перевод и переход ----
    setPhase("nav");
    if (site.nav) {
      if (ext) {
        await page.mouse.move(5, 5);
        await L.tabSend(run, page, { type: "translatePage", via: "popup" });
        const w = await waitPage(90000);
        R.navPage = { state: w.st, ms: w.ms, uiSeen: w.seen, share: await sample(), vis: await visShare() };
        log(`    ext nav   перед переходом: ${w.st ? w.st.page + ", строк " + w.st.count : "нет ответа"}, основной текст ${R.navPage.share}%, видимое ${R.navPage.vis}%`);
      } else await sleep(4000);
      const urlBefore = page.url();
      // Перезагрузка страницы или переход без неё (SPA): у SPA не меняется navigation id документа.
      const docBefore = await k.ev("return performance.timeOrigin").catch(() => null);
      await step(site.navName || "переход", site.nav);
      await sleep(3000);
      const docAfter = await k.ev("return performance.timeOrigin").catch(() => null);
      R.final = { url: page.url(), title: await k.title().catch(() => ""), share: await sample(site.navMain || site.main),
        spa: page.url() !== urlBefore && docBefore != null && docBefore === docAfter };
      if (ext) {
        R.final.state = await L.tabState(run, page);
        R.final.vis = await visShare();
        R.final.fab = await fabInfo(k);
        R.final.ui = await uiTexts(k);
        await H.shot("nav");
        // Новое содержимое переведённой страницы (SPA) переводится само (content.js: watchPage) — ждём ещё.
        if (R.final.spa) {
          await sleep(9000);
          R.final.later = { state: await L.tabState(run, page), share: await sample(site.navMain || site.main), vis: await visShare(), fab: await fabInfo(k) };
          await H.shot("nav-later");
        }
        const L2 = R.final.later;
        log(`    ext nav   после перехода${R.final.spa ? " (SPA, без перезагрузки)" : " (новая страница)"}: ${R.final.state ? R.final.state.page + ", строк " + R.final.state.count : "?"}, основной текст ${R.final.share}%, видимое ${R.final.vis}%, кружок ${fabStr(R.final.fab)}` +
          (L2 ? `; через 12 с: ${L2.state ? L2.state.page + ", строк " + L2.state.count : "?"}, основной текст ${L2.share}%, видимое ${L2.vis}%, кружок ${fabStr(L2.fab)}` : ""));
      }
    }
  } catch (e) {
    R.crash = e.message.split("\n")[0];
    log(`  ${mode}: СБОЙ сценария — ${R.crash}`);
  } finally {
    await sleep(500);
    await page.close().catch(() => {});
  }
  return R;
}

// Ошибки ext, которых нет в base (по ключу без чисел и адресов).
function compareErrors(base, ext) {
  const baseKeys = new Set((base ? base.errors : []).map(L.errKey));
  const seen = new Map();
  for (const e of ext.errors) {
    const key = L.errKey(e);
    if (baseKeys.has(key)) continue;
    const s = seen.get(key);
    if (s) { s.count++; continue; }
    seen.set(key, { key, count: 1, phase: e.phase, ours: L.isOurs(e), text: e.text.slice(0, 300), url: e.url, stack: e.stack.slice(0, 3) });
  }
  return [...seen.values()];
}

// ---------- главное ----------
(async () => {
  const pw = L.loadPlaywright(CACHE);
  const profile = BASE_ONLY ? null : prepareProfile();
  const results = [];
  const writeJson = () => { if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1)); };
  let baseRun = null;
  if (!flag("--no-baseline")) {
    const baseProfile = fs.mkdtempSync(path.join(RUN_TMP, "base-profile-"));
    baseRun = await L.launchChrome(pw, { profile: baseProfile, withExt: false, headed: flag("--headed"), tmp: RUN_TMP, chromePath: CHROME, acceptLang: ACCEPT_LANG });
    browsers.push(baseRun);
  }
  let extRun = null;
  if (!BASE_ONLY) {
    extRun = await L.launchChrome(pw, { profile, withExt: true, headed: flag("--headed"), tmp: RUN_TMP, chromePath: CHROME, acceptLang: ACCEPT_LANG, extSrc: EXT_DIR, patchExt: TRACE_LANG ? patchTrace : null });
    browsers.push(extRun);
    log(`расширение ${extRun.ext.id} из ${EXT_DIR}${TRACE_LANG ? " (отладочная копия: --trace-lang)" : ""}; слой интерфейса — ${LIVE_FILE}; скриншоты → ${path.relative(L.ROOT, SHOTS) || SHOTS}`);
    // Плавающая кнопка показана: проверяем, не перекрывает ли она сайт и остаётся ли после переходов (уведомления
    // показываются и так).
    await L.storage.set(extRun, { hudShown: true });
  }

  for (const site of sites) {
    log(`\n== ${site.id}: ${site.title} — ${site.url}`);
    const res = { id: site.id, title: site.title, url: site.url };
    if (baseRun) res.base = await scenario(baseRun, "base", site);
    if (BASE_ONLY) {
      const f = res.base.steps.filter((s) => !s.ok).map((s) => `${s.phase}:${s.name}`);
      log(`  без расширения: ${res.base.blocked ? "закрыт — " + res.base.blocked : "шагов с ошибкой " + f.length}, ошибок консоли ${res.base.errors.length}`);
      results.push(res);
      writeJson();
      continue;
    }
    await L.storage.set(extRun, { targetLang: site.target || "RU" });
    res.ext = await scenario(extRun, "ext", site);
    res.newErrors = compareErrors(res.base, res.ext);
    const ours = res.newErrors.filter((e) => e.ours);
    log(`  ошибки консоли: base ${res.base ? res.base.errors.length : "—"}, ext ${res.ext.errors.length}, новых ${res.newErrors.length}` +
      (ours.length ? `, из них с chrome-extension:// ${ours.length}` : ""));
    for (const e of res.newErrors.slice(0, 8)) log(`    + [${e.phase}] ${e.ours ? "(НАША) " : ""}${e.key}`);
    results.push(res);
    writeJson();
  }
  if (extRun) await L.storage.set(extRun, { targetLang: "RU" }).catch(() => {});

  // Кратко по сайтам.
  log("\n== итог");
  for (const r of results) {
    const e = r.ext;
    if (!e) continue;
    if (e.blocked) { log(`${r.id.padEnd(12)} закрыт: ${e.blocked}`); continue; }
    const fails = e.steps.filter((s) => !s.ok).map((s) => `${s.phase}:${s.name}`);
    const baseFails = new Set(r.base ? r.base.steps.filter((s) => !s.ok).map((s) => `${s.phase}:${s.name}`) : []);
    const extOnly = fails.filter((f) => !baseFails.has(f));
    const o = e.orig;
    const esc = !o ? "?" : (o.escFailed ? "FAIL" : "ok") + (o.resid && o.resid.count ? ` (осталось переведённым ${o.resid.count})` : "") + (o.keyBack ? "" : " (key не вернулся)");
    const f = e.final;
    const nav = !f ? "" : ` · переход${f.spa ? " (SPA)" : ""}: ${e.navPage && e.navPage.state ? e.navPage.state.page + "/" + e.navPage.state.count : "?"} → ` +
      `${(f.later || f).state ? (f.later || f).state.page + "/" + (f.later || f).state.count : "?"}, видимое ${(f.later || f).vis}%, кружок ${fabStr((f.later || f).fab)}`;
    log(`${r.id.padEnd(12)} key ${e.key && e.key.ok ? "ok" : "FAIL"}${e.key && e.key.covered ? " (перекрыт " + e.key.covered + ")" : ""} · page ${e.page && e.page.state ? e.page.state.page + "/" + e.page.state.count : "?"}` +
      `${e.page && e.page.share != null ? " " + e.page.share + "% (видимое " + e.page.vis + "%)" : ""} · Esc ${esc}${nav}` +
      ` · шаги с ошибкой только с расширением: ${extOnly.length ? extOnly.join(", ") : "нет"} · новых ошибок консоли ${r.newErrors.length}`);
  }
  writeJson();
  if (JSON_OUT) log("подробно: " + JSON_OUT);
  await cleanup();
})().catch(async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});
