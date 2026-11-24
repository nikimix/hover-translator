// Страница приветствия вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked)
// и настоящий встроенный переводчик. Установка → приветствие → «Скачать переводчик» настоящим щелчком (модели качаются
// из сети; если в профиле HT_PROFILE они уже есть — страница сразу в «Готово») → «Переводить наведением» / «Вернуть
// Shift» → Shift на абзаце для пробы → «Работает!» → повторное открытие страницы → смена языка → выбранный переводчик
// без ключа и с ключом → «Открыть настройки». Состояния, которые трудно получить честно (встроенного нет, загрузка не
// удалась, полоса с процентом), — с подменой Translator/LanguageDetector до загрузки скриптов страницы. Английский
// интерфейс — отдельный запуск. Скриншоты — с tests/run.sh --shots.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { launch, sleep, until } = require("../lib/chrome");
const EXT_DIR = path.join(__dirname, "..", "..", "hover-translate");
// Ожидаемые тексты — из _locales и из самой страницы, а не вписанные руками: тексты правят отдельно от проверок.
const MSG = { ru: require(path.join(EXT_DIR, "_locales/ru/messages.json")), en: require(path.join(EXT_DIR, "_locales/en/messages.json")) };
// Сообщение, как его соберёт chrome.i18n: $имя$ → подстановка по номеру из placeholders.
function msg(lang, key, subs) {
  const m = MSG[lang][key];
  assert.ok(m, "нет сообщения " + key);
  const ph = {};
  for (const [n, d] of Object.entries(m.placeholders || {})) ph[n.toLowerCase()] = Number(String(d.content).replace("$", "")) - 1;
  return m.message.replace(/\$(\w+)\$/g, (all, n) => (n.toLowerCase() in ph ? String([].concat(subs || [])[ph[n.toLowerCase()]] ?? "") : all));
}
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

// Подмена встроенного API в странице (до её скриптов): mode — none | need | downloading | ready | fail; tr — чем
// «переводит» подменный переводчик; det — какой язык «определяет» детектор.
const MOCK = (mode, tr, det) => `(() => {
  const mode = ${JSON.stringify(mode)};
  if (mode === "none") { delete self.Translator; delete self.LanguageDetector; return; }
  let avail = mode === "ready" ? "available" : "downloadable";
  const create = (inst) => async (o) => {
    if (avail === "available") return inst;
    if (o && o.monitor) { const t = new EventTarget(); o.monitor(t); setTimeout(() => t.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 0.42, total: 1 })), 50); }
    if (mode === "downloading") return new Promise(() => {});
    await new Promise((r) => setTimeout(r, 300));
    if (mode === "fail") throw new DOMException("Network error", "NetworkError");
    avail = "available";
    return inst;
  };
  class T { static async availability() { return avail; } }
  T.create = create({ translate: async () => ${JSON.stringify(tr || "")}, destroy() {} });
  class D { static async availability() { return avail; } }
  D.create = create({ detect: async () => [{ detectedLanguage: ${JSON.stringify(det || "en")}, confidence: 0.99 }], destroy() {} });
  Object.defineProperty(self, "Translator", { value: T, configurable: true, writable: true });
  Object.defineProperty(self, "LanguageDetector", { value: D, configurable: true, writable: true });
})();`;
// Английский текст для пробы — как на странице (welcome.html).
const EN_TRY = fs.readFileSync(path.join(EXT_DIR, "welcome.html"), "utf8").match(/<p lang="en" hidden>([^<]+)<\/p>/)[1].trim();

// Обвязка вкладки приветствия: этап шага 2, координаты, клавиши, скриншоты обеих тем во всю высоту.
function page(tab) {
  const ev = tab.ev;
  return {
    tab, ev,
    stage: () => ev("document.querySelector('#step2').dataset.stage"),
    text: (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null; })()`),
    visible: (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !!e.getClientRects().length; })()`),
    tryP: () => ev("(() => { const p = document.querySelector('#try p:not([hidden])'); return p ? { lang: p.lang, text: p.textContent.trim() } : null; })()"),
    store: (k) => ev(`chrome.storage.local.get(${JSON.stringify(k)}).then((s) => s[${JSON.stringify(k)}])`),
    async center(sel, dx) {
      return ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + ${dx == null ? "r.width / 2" : dx}, y: r.top + Math.min(r.height / 2, 20) }; })()`);
    },
    async click(sel) { await tab.cmd("Page.bringToFront"); const p = await this.center(sel); await tab.click(p.x, p.y); },
    async shift() {
      await tab.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await tab.key("keyUp", "Shift", "ShiftLeft", 0, 16);
    },
    async shiftOn(sel) {
      await tab.cmd("Page.bringToFront");
      const p = await this.center(sel, 80);
      await tab.mouse("mouseMoved", 5, 5); await sleep(100);
      await tab.mouse("mouseMoved", p.x, p.y); await sleep(80);
      await this.shift();
    },
    async waitStage(want, ms = 8000) {
      const ws = [].concat(want);
      return until(async () => { const s = await this.stage(); return ws.includes(s) ? s : ""; }, ms, 100);
    },
    async shots(name, width = 1100) {
      for (const dark of [false, true]) {
        await tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
        const h = await ev("Math.ceil(document.documentElement.scrollHeight)");
        await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(200);
        await tab.shot(`${name}-${dark ? "dark" : "light"}.png`);
      }
      await tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await tab.cmd("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    },
  };
}

(async () => {
  // ошибки страниц приветствия: в своих файлах (welcome, ui, builtin, shared) — провал; в content.js — в журнал
  const errors = [];
  const watchErrors = (b) => b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push({ url: d.url || (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || "", text: (d.exception && d.exception.description || d.text || "").slice(0, 200) });
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const f = m.params.stackTrace && m.params.stackTrace.callFrames[0];
      errors.push({ url: (f && f.url) || "", text: "console.error " + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 200) });
    }
  });

  // ================= русский интерфейс, настоящий встроенный переводчик =================
  let b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  watchErrors(b);
  let EXT = "";
  const openWelcome = async (mock) => {
    const { targetId } = await b.cmd("Target.createTarget", { url: "about:blank" });
    const tab = await b.attach(targetId);
    await tab.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    if (mock) await tab.cmd("Page.addScriptToEvaluateOnNewDocument", { source: mock });
    await tab.cmd("Page.navigate", { url: EXT + "welcome.html" });
    const w = page(tab);
    await until(() => w.stage().catch(() => ""), 8000, 100);
    return w;
  };
  try {
    const ext = b.copyExt();
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    const wt = targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html");
    assert.ok(wt, "приветствие открылось при установке");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const w = page(await b.attach(wt.targetId));
    await w.tab.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    const st0 = await until(() => w.stage(), 8000, 100);

    // ---- шаг 1 и статичное ----
    assert.strictEqual(await w.ev("document.querySelector('#targetLang').value"), "RU");
    assert.strictEqual(await w.text("label[for=targetLang]"), "На какой язык переводить");
    assert.strictEqual(await w.ev("document.querySelector('.wstep').classList.contains('done') && !!document.querySelector('#num1 svg')"), true, "шаг 1 сразу с ✓");
    assert.strictEqual(await w.text(".wl-h1"), await w.ev("chrome.i18n.getMessage('extShortName')"));
    assert.ok(/нажмите Shift — перевод появится прямо на странице/.test(await w.text("#lead")), await w.text("#lead"));
    assert.strictEqual(await w.text("#step2 ~ .wstep .muted"), "Уже открытые вкладки обновите — до этого перевод на них не работает.");
    assert.ok(/DeepL и ИИ доступны не во всех странах/.test(await w.text("#more")));
    // всё, кроме абзаца для пробы, — под translate="no" (content.js не переводит подписи страницы)
    const notNo = await w.ev(`[...document.querySelectorAll(".wl-col > *, #step2 .wstep-b > *, #step2 > .num")].filter((e) => e.id !== "try" && e.id !== "step2" && e.closest("[translate=no]") === null).map((e) => e.id || e.className)`);
    assert.deepStrictEqual(notNo, [], "без translate=no");
    console.log(`      (при открытии: ${st0}; заголовок: ${await w.text(".wl-h1")})`);
    ok("приветствие при установке: язык = язык браузера (RU), шаг 1 с ✓, вступление с клавишей Shift, подписи страницы под translate=\"no\"");

    // ---- шаг 2: скачать → готово (или сразу готово, если модели уже в профиле) ----
    const pairNow = await w.ev("Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' })");
    if (st0 === "start" && pairNow === "available") {
      // модели уже в профиле, а детектор языка первые секунды после запуска Chrome отвечает «downloadable» —
      // страница перепроверяет сама и переходит в «Готово» без щелчка
      const st1 = await w.waitStage("ready", 12000);
      console.log(`      (пара уже скачана, детектор «просыпается»: ${st0} → ${st1 || await w.stage()})`);
      assert.strictEqual(st1, "ready", "сама перешла в «Готово»");
      ok("модели уже в профиле: «Скачать переводчик» сменяется на «Готово» без щелчка, когда Chrome признаёт детектор языка");
    } else if (st0 === "start" || st0 === "failed") {
      assert.strictEqual(await w.text("#dlBtn"), "Скачать переводчик");
      assert.strictEqual(await w.text("#s2top .w-act .muted"), "Английский → русский · один раз, дальше без интернета");
      assert.strictEqual(await w.ev("document.querySelector('#try').getAttribute('translate') + ' ' + document.querySelector('#try').className"), "no try wait");
      assert.strictEqual(await w.text("#s2bottom .w-cap"), "Попробовать можно будет сразу после загрузки.");
      await w.shots("welcome-start");
      await w.click("#dlBtn");
      let seen = "";
      const end = await until(async () => {
        const s = await w.stage();
        if (s === "downloading" && !seen) {
          seen = (await w.text(".prog")) + " | " + (await w.text("#s2bottom"));
          await w.tab.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
          await w.tab.shot("welcome-downloading-light.png");
        }
        if (s === "start" && /ещё раз/.test(await w.text("#s2top"))) { await w.click("#dlBtn"); return ""; }
        return s === "ready" || s === "failed" ? s : "";
      }, 240000, 100);
      console.log(`      (во время загрузки: ${seen || "не застали"}; после: ${end})`);
      assert.strictEqual(end, "ready", "загрузка закончилась «Готово»");
      if (seen) assert.ok(/Скачивание переводчика/.test(seen) && /Можно не ждать на этой странице — загрузка продолжится сама\./.test(seen), seen);
      ok("«Скачать переводчик» настоящим щелчком: полоса «Скачивание переводчика» + «загрузка продолжится сама», затем «Готово»");
    } else if (st0 === "downloading") {
      assert.ok(await w.waitStage("ready", 240000), "Chrome докачал начатое — страница сама перешла в «Готово»");
    } else assert.strictEqual(st0, "ready");

    // ---- готово: абзац обведён и включён, подсказка клавишей ----
    assert.strictEqual(await w.text(".w-ok"), "Готово: английский → русский");
    assert.strictEqual(await w.ev("document.querySelector('#try').getAttribute('translate') + ' ' + document.querySelector('#try').className"), "null try ready");
    assert.deepStrictEqual(await w.tryP(), { lang: "en", text: EN_TRY });
    assert.strictEqual(await w.text("#s2bottom .w-cap"), msg("ru", "wlTryKey", "Shift"));
    assert.strictEqual(await w.text("#s2bottom .w-cap .kbd"), "Shift");
    assert.strictEqual(await w.text("#trySel"), msg("ru", "wlTrySel"));
    assert.strictEqual(await w.text("#s2bottom .link-btn"), "Переводить наведением");
    assert.strictEqual(await w.visible("#more"), true);
    await w.shots("welcome-ready");
    ok("«Готово: английский → русский»: абзац для пробы обведён и без translate=\"no\", «Наведите курсор на текст для пробы и нажмите [Shift]», строка о выделенном, «Переводить наведением»");

    // ---- «Переводить наведением» ↔ «Вернуть Shift» ----
    await w.click("#s2bottom .link-btn");
    await w.waitStage("ready-hover", 3000);
    assert.strictEqual(await w.store("trigger"), "dwell");
    assert.strictEqual(await w.text("#s2bottom .w-cap"), msg("ru", "wlTryDwell"));
    assert.strictEqual(await w.text("#s2bottom .link-btn"), "Вернуть Shift");
    assert.strictEqual(await w.ev("!!document.querySelector('#trySel')"), false, "без клавиши строки о выделенном нет");
    assert.strictEqual(await w.ev("document.activeElement.textContent"), "Вернуть Shift", "фокус остался на ссылке");
    assert.strictEqual(await w.text("#lead"), msg("ru", "wlLeadDwell"));
    await w.shots("welcome-ready-hover");
    await w.click("#s2bottom .link-btn");
    await w.waitStage("ready", 3000);
    assert.strictEqual(await w.store("trigger"), "shift");
    // способ сменили в другом месте (окно расширения) — страница следует за хранилищем, подсказки — клавишей
    await w.ev("chrome.storage.local.set({ trigger: 'alt' })");
    await sleep(300);
    assert.strictEqual(await w.text("#s2bottom .w-cap .kbd"), "Alt");
    assert.ok(/нажмите Alt/.test(await w.text("#lead")));
    await w.ev("chrome.storage.local.set({ trigger: 'shift' })");
    await sleep(300);
    assert.strictEqual(await w.text("#s2bottom .w-cap .kbd"), "Shift");
    ok("«Переводить наведением» → trigger=dwell и «Вернуть Shift» (фокус на месте) → trigger=shift; клавиша из настроек (Alt) — в подсказках");

    // ---- проба: Shift на абзаце → «Работает!» ----
    await w.shiftOn("#try p:not([hidden])");
    const okStage = await w.waitStage("success", 20000);
    const tr = await w.tryP();
    console.log(`      (абзац для пробы: ${tr.text.slice(0, 80)}…)`);
    assert.strictEqual(okStage, "success", "абзац перевёлся");
    assert.ok(/[а-яё]{3,}/i.test(tr.text), tr.text);
    assert.strictEqual(await w.ev("document.querySelector('#step2').classList.contains('done') && !!document.querySelector('#num2 svg')"), true, "шаг 2 отмечен ✓");
    assert.strictEqual(await w.text("#s2bottom .notice-t"), "Работает! Так же — на любом сайте");
    assert.strictEqual(await w.ev("!!document.querySelector('#trySel')"), false, "после успеха строки о выделенном нет");
    assert.strictEqual(await w.text("#s2bottom .notice-d"), "Ещё раз Shift или Esc — вернётся оригинал. Для других языков Chrome скачает переводчик при первом переводе — понадобится щелчок по тексту.");
    assert.strictEqual(await w.ev("document.querySelectorAll('.ht-error').length"), 0);
    await until(() => w.ev("!document.querySelector('.ht-loading')"), 5000);
    await w.tab.mouse("mouseMoved", 5, 5);
    await w.shots("welcome-success");
    await w.shiftOn("#try p:not([hidden])");
    assert.ok(await until(async () => (await w.tryP()).text === EN_TRY, 5000), "Shift ещё раз — оригинал");
    assert.strictEqual(await w.stage(), "success", "успех остаётся");
    // подписи страницы не переводятся
    const d2 = await w.text("#d2");
    await w.shiftOn("#d2");
    await sleep(1500);
    assert.strictEqual(await w.text("#d2"), d2);
    ok("Shift на абзаце: перевод встроенным → «Работает! Так же — на любом сайте», шаг 2 с ✓; Shift ещё раз — оригинал, «Работает» остаётся; подписи не переводятся");

    // ---- повторное открытие («Как пользоваться» со страницы настроек): модели уже скачаны ----
    const w2 = await openWelcome();
    assert.strictEqual(await w2.stage(), "ready", "сразу «Готово»");
    assert.strictEqual(await w2.text(".w-ok"), "Готово: английский → русский");
    // смена языка: на английский — абзац на русском (исходный язык пары при русском интерфейсе)
    await w2.ev("(() => { const s = document.querySelector('#targetLang'); s.value = 'EN-US'; s.dispatchEvent(new Event('change')); })()");
    const stEn = await until(async () => { const s = await w2.stage(); return s === "ready" || s === "start" ? s : ""; }, 5000, 100);
    assert.strictEqual(await w2.store("targetLang"), "EN-US");
    assert.strictEqual((await w2.tryP()).lang, "ru");
    console.log(`      (русский → английский: ${stEn}; ${await w2.text(stEn === "ready" ? ".w-ok" : "#s2top .w-act .muted")})`);
    assert.ok(/[Рр]усский → английский/.test(await w2.text("#s2top")), await w2.text("#s2top"));
    await w2.ev("(() => { const s = document.querySelector('#targetLang'); s.value = 'RU'; s.dispatchEvent(new Event('change')); })()");
    await until(async () => (await w2.tryP()).lang === "en" && (await w2.stage()) === "ready", 5000, 100);
    assert.strictEqual((await w2.tryP()).lang, "en");
    assert.strictEqual(await w.ev("document.querySelector('#targetLang').value"), "RU", "первая вкладка следует за хранилищем");
    ok("повторное открытие с уже скачанными моделями — сразу «Готово»; смена языка на английский — абзац на русском, обратно — на английском");

    // ---- выбранный переводчик: DeepL без ключа → «Подключите переводчик»; с ключом и согласием → сразу «Готово» ----
    await w2.ev("chrome.storage.local.set({ engine: 'deepl' })");
    await w2.waitStage("problem", 3000);
    assert.strictEqual(await w2.text("#t2"), "Подключите переводчик");
    assert.strictEqual(await w2.text("#s2top .notice-t"), "Перевод не работает");
    assert.ok(/^(Нужно ваше согласие на отправку текста|Не задан ключ DeepL)\. Исправить можно в настройках\.$/.test(await w2.text("#s2top .notice-d")), await w2.text("#s2top .notice-d"));
    assert.strictEqual(await w2.visible("#try"), false);
    assert.strictEqual(await w2.visible("#more"), false);
    await w2.shots("welcome-problem");
    await w2.ev("chrome.storage.local.set({ apiKey: 'test-key:fx', consent: { deepl: true } })");
    await w2.waitStage("ready", 3000);
    assert.strictEqual(await w2.visible("#more"), false, "DeepL уже подключён — «Нужен перевод точнее?» не нужен");
    assert.strictEqual(await w2.text(".w-ok"), "Готово: английский → русский");
    // «Открыть настройки» (в «Подключите переводчик») — страница настроек во вкладке
    await w2.ev("chrome.storage.local.remove(['apiKey', 'consent'])");
    await w2.waitStage("problem", 3000);
    await w2.click("#s2top .w-act .btn");
    const opt = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.startsWith(EXT + "options.html")), 5000);
    assert.ok(opt, "открылась options.html");
    await b.cmd("Target.closeTarget", { targetId: opt.targetId });
    await w2.ev("chrome.storage.local.set({ engine: 'chrome' })");
    await w2.waitStage("ready", 3000);
    ok("DeepL без ключа — «Подключите переводчик» + причина, без абзаца и «Нужен перевод точнее?»; с ключом и согласием — сразу «Готово»; «Открыть настройки» → options.html");

    // ---- подменённый встроенный: нет в браузере, загрузка не удалась, полоса с процентом ----
    const wn = await openWelcome(MOCK("none"));
    assert.strictEqual(await wn.stage(), "no-builtin");
    assert.strictEqual(await wn.text("#t2"), "Подключите переводчик");
    assert.strictEqual(await wn.text("#s2top .notice-t"), "Встроенного переводчика нет в этом браузере");
    assert.strictEqual(await wn.text("#s2top .w-act .btn"), "Открыть настройки");
    assert.strictEqual(await wn.visible("#try"), false);
    assert.strictEqual(await wn.visible("#more"), false);
    assert.strictEqual(await wn.visible("#d2"), false);
    await wn.shots("welcome-no-builtin");
    const wf = await openWelcome(MOCK("fail"));
    assert.strictEqual(await wf.stage(), "start");
    await wf.click("#dlBtn");
    assert.strictEqual(await wf.waitStage("failed", 5000), "failed");
    assert.strictEqual(await wf.text("#s2top .notice-err .notice-t"), "Не удалось скачать переводчик");
    assert.strictEqual(await wf.ev("document.querySelector('#s2top .notice-err').getAttribute('role')"), "alert");
    assert.strictEqual(await wf.text("#dlBtn"), "Повторить");
    assert.strictEqual(await wf.ev("document.querySelector('#try').getAttribute('translate') + ' ' + document.querySelector('#try').className"), "no try wait");
    await wf.shots("welcome-failed");
    const wd = await openWelcome(MOCK("downloading"));
    await wd.click("#dlBtn");
    await wd.waitStage("downloading", 3000);
    assert.ok(await until(async () => (await wd.text(".prog .pct")) === "42%", 3000), "процент на полосе");
    assert.strictEqual(await wd.ev("document.querySelector('.prog .progress').getAttribute('aria-valuenow')"), "42");
    assert.strictEqual(await wd.text("#s2bottom"), "Попробовать можно будет сразу после загрузки.Можно не ждать на этой странице — загрузка продолжится сама.");
    await wd.shots("welcome-downloading");
    for (const x of [wn, wf, wd]) await x.tab.cmd("Page.close").catch(() => {});
    ok("подменённый встроенный: нет в браузере — «Подключите переводчик» + «Открыть настройки»; сбой — красная плашка (role=alert) и «Повторить»; загрузка — «42%»");
  } finally {
    await b.close();
  }

  // ================= английский интерфейс (подменённый переводчик): абзац на испанском =================
  b = await launch({ lang: "en" });
  watchErrors(b);
  try {
    const ext = b.copyExt();
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    EXT = `chrome-extension://${id}/`;
    await sleep(1200);
    const { targetInfos } = await b.cmd("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page" && t.url === EXT + "welcome.html") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const ws = await openWelcome(MOCK("need", EN_TRY, "es"));
    assert.strictEqual(await ws.ev("document.querySelector('#targetLang').value"), "EN-US");
    assert.strictEqual(await ws.stage(), "start");
    assert.strictEqual(await ws.text("#t2"), "Download the translator and try it");
    assert.strictEqual(await ws.text("#s2top .w-act .muted"), "Spanish → English · once, then it works offline");
    assert.strictEqual((await ws.tryP()).lang, "es");
    await ws.shots("welcome-en-start");
    await ws.click("#dlBtn");
    assert.strictEqual(await ws.waitStage("ready", 5000), "ready");
    assert.strictEqual(await ws.text(".w-ok"), "Ready: Spanish → English");
    assert.strictEqual(await ws.text("#s2bottom .w-cap"), msg("en", "wlTryKey", "Shift"));
    assert.strictEqual(await ws.text("#trySel"), msg("en", "wlTrySel"));
    const es = (await ws.tryP()).text;
    await ws.shiftOn("#try p:not([hidden])");
    assert.strictEqual(await ws.waitStage("success", 8000), "success");
    assert.strictEqual((await ws.tryP()).text, EN_TRY, "испанский абзац переведён (подменой) на английский: " + es.slice(0, 30));
    assert.strictEqual(await ws.text("#s2bottom .notice-t"), "It works! Same on any website");
    await until(() => ws.ev("!document.querySelector('.ht-loading')"), 5000);
    await ws.tab.mouse("mouseMoved", 5, 5);
    await ws.shots("welcome-en-success");
    ok("английский интерфейс: язык EN-US, абзац для пробы на испанском, «Spanish → English», «Ready» → Shift → «It works! Same on any website»");
  } finally {
    await b.close();
  }

  const mine = errors.filter((e) => /\/(welcome|ui|builtin|shared)\.js/.test(e.url));
  const other = errors.filter((e) => !mine.includes(e));
  if (other.length) console.log("      (прочие ошибки на страницах: " + JSON.stringify(other.slice(0, 5)) + ")");
  assert.deepStrictEqual(mine, [], "ошибки в коде приветствия");
  ok("в коде приветствия (welcome.js, ui.js, builtin.js, shared.js) ошибок нет");
  console.log(`\nВсе проверки пройдены: ${pass}`);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
