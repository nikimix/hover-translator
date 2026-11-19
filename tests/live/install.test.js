// Установка вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked), настоящий встроенный
// переводчик. Окно расширения — как настоящее, нажатием на значок (CDP Extensions.triggerAction, activeTab).
// Установка → приветствие (готовим встроенный; тексты приветствия проверяет live/welcome.test.js) → окно при открытом
// приветствии → DeepL без ключа: значок, окно, сайт (одно спокойное уведомление, ни одного красного абзаца) →
// «Переводить встроенным» в окне → «Везде» и значок → обновление расширения при открытой вкладке (старый скрипт
// возвращает оригиналы и замолкает) → «Обновить вкладку» на устаревшей вкладке → вкладка, куда расширение не
// пускают и после обновления (страница ошибки загрузки) → «Здесь перевод не работает».
// Скриншоты — с tests/run.sh --shots.
const http = require("http");
const assert = require("assert");
const { launch, sleep, until } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { pageUi, popupOpener, popupView, clickSel, prepareBuiltin } = require("../lib/live");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const EN_P1 = "The quick brown fox jumps over the lazy dog near the river bank.";

(async () => {
  const srv = await serve();
  const WEB = srv.base + "/index.html";
  // адрес, по которому никто не отвечает: Chrome покажет свою страницу ошибки (content-скрипты туда не попадают)
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const DEAD = `http://127.0.0.1:${dead.address().port}/gone.html`;
  await new Promise((r) => dead.close(r));

  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const pageErrors = [];
  const popSessions = new Set();
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.sessionId + " " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageErrors.push(m.sessionId + " console.error: " + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 300));
  });
  const theme = (tab, dark) => tab.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  // Снимок окна в обеих темах (настоящее окно подгоняет размер под содержимое само — тогда снимаем по клипу).
  const popShots = async (p, name) => {
    if (!process.env.HT_SHOTS) return;
    for (const dark of [false, true]) {
      await theme(p, dark); await sleep(150);
      const h = await p.ev("Math.ceil(document.body.getBoundingClientRect().height)");
      const fixed = await p.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false }).then(() => true, () => false);
      await sleep(150);
      await p.shot(`${name}-${dark ? "dark" : "light"}.png`, fixed ? {} : { clip: { x: 0, y: 0, width: 340, height: h, scale: 1 } });
    }
    await theme(p, false);
  };
  try {
    const ext = b.copyExt();
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    const wt = targetInfos.find((t) => t.type === "page" && t.url === EXT + "welcome.html");
    assert.ok(wt, "страница приветствия открылась при установке");
    for (const t of targetInfos) if (t.type === "page" && t.url === "about:blank") await b.cmd("Target.closeTarget", { targetId: t.targetId });
    // service worker расширения (после обновления расширения — новый)
    const swNow = async () => {
      const t = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((x) => x.type === "service_worker" && x.url === EXT + "background.js"), 8000, 200);
      return b.attach(t.targetId);
    };
    let sw = await swNow();
    const store = (o) => sw.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    const get = async (keys) => JSON.parse(await sw.ev(`chrome.storage.local.get(${JSON.stringify(keys)}).then((s) => JSON.stringify(s))`));
    const badge = async (tabId) => JSON.parse(await sw.ev(`Promise.all([chrome.action.getBadgeText(${tabId ? `{ tabId: ${tabId} }` : "{}"}), chrome.action.getTitle({})]).then((r) => JSON.stringify(r))`));
    // текст из _locales — проверки сверяются с ключами, а не с фразами (тексты правят)
    const msg = (key, subs) => sw.ev(`chrome.i18n.getMessage(${JSON.stringify(key)}${subs ? ", " + JSON.stringify(subs) : ""})`);
    const NAME = await msg("extShortName");

    // ---- установка: приветствие, записанные настройки, значок ----
    const st0 = await get(["targetLang", "trigger", "engine", "enabled"]);
    const b0 = await badge();
    console.log("      (записано при установке: " + JSON.stringify(st0) + "; значок: " + JSON.stringify(b0) + ")");
    assert.deepStrictEqual(st0, { targetLang: "RU", trigger: "shift" }, "язык перевода — язык браузера, способ — Shift, остальное — по умолчанию");
    assert.deepStrictEqual(b0, ["", NAME], "значок без «!», подсказка — короткое название");
    ok("установка: открыто приветствие, записаны язык перевода (RU — язык браузера) и способ (Shift); значок без «!», подсказка — «" + NAME + "»");

    // встроенный переводчик — на приветствии (скачать, если в профиле его ещё нет)
    const w = await b.attach(wt.targetId);
    await w.cmd("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    const ws = await prepareBuiltin(w);
    console.log("      (приветствие: " + ws + ")");
    assert.ok(/^(ready|ready-hover|success)$/.test(ws), "встроенный переводчик готов: " + ws);

    // ---- окно по значку, пока открыто приветствие ----
    const web = await b.openTab(WEB);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    const pop = popupOpener(b, id, (p) => popSessions.add(p.sessionId));
    let p = await pop.open(web, WEB);
    let v = await popupView(p);
    // content.js подключён и к приветствию — его обработчик сообщений не должен отвечать вместо background
    const stats = JSON.parse(await p.ev("chrome.runtime.sendMessage({ type: 'getStats' }).then((r) => JSON.stringify(r))"));
    console.log("      (окно: " + (pop.real ? "по значку" : "вкладкой") + ", состояние " + v.n + ", подвал «" + v.foot + "»; getStats: " + JSON.stringify(stats) + ")");
    assert.ok(stats && stats.ok === true && "chars" in stats && "entries" in stats, "ответ background, а не content.js приветствия: " + JSON.stringify(stats));
    assert.strictEqual(v.n, 0, "обычное состояние: " + JSON.stringify(v));
    assert.strictEqual(v.foot, await msg("ppNameBuiltinFull"));
    if (pop.real) assert.strictEqual(v.url, WEB, "activeTab: окно видит адрес вкладки");
    await popShots(p, "popup-normal");
    await pop.close();
    ok("окно по значку при открытом приветствии: обычное состояние, подвал «встроенный»; на сообщения окна отвечает background, а не content.js приветствия");

    // ---- DeepL без ключа (согласие уже дано): значок и окно ----
    await store({ engine: "deepl", consent: { deepl: true, openai: false, anthropic: false } });
    await sleep(500);
    const st = JSON.stringify({ apiKey: false, llmApiKey: false, llmProvider: "openai", consent: { deepl: true }, targetLang: "RU", sourceLang: "auto" });
    const wantTitle = await sw.ev(`HT_t("badgeProblem", [HT_t("extShortName"), HT_problemText("no-deepl-key", "short", ${st})])`);
    const b1 = await badge();
    console.log("      (значок, DeepL без ключа: " + JSON.stringify(b1) + ")");
    assert.deepStrictEqual(b1, ["!", wantTitle], "«!» и причина — нет ключа DeepL");
    p = await pop.open(web, WEB);
    v = await popupView(p);
    console.log("      (окно, DeepL без ключа: " + v.n + " «" + v.t + "» " + JSON.stringify(v.buttons) + ", подвал «" + v.foot + "»)");
    assert.strictEqual(v.n, 16, JSON.stringify(v));
    assert.deepStrictEqual(v.buttons, [await msg("ppAddKey"), await msg("useBuiltin")]);
    assert.strictEqual(v.foot, await msg("ppFoot", ["DeepL", await msg("ppStNoKey")]));
    await popShots(p, "popup-nokey");
    // «Добавить ключ в настройках» — страница настроек с фокусом в поле ключа DeepL
    await clickSel(p, "button[data-k='settings-deepl-key']");
    const optT = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.startsWith(EXT + "options.html")), 6000, 150);
    assert.ok(optT, "открылась страница настроек");
    const opt = await b.attach(optT.targetId);
    const focus = await until(async () => { const f = await opt.ev("document.activeElement && document.activeElement.id").catch(() => ""); return f === "deepl-key" ? f : ""; }, 6000, 150);
    assert.strictEqual(focus, "deepl-key", "фокус в поле ключа DeepL");
    await b.cmd("Target.closeTarget", { targetId: optT.targetId });
    await pop.close();
    ok(`DeepL без ключа: «!» на значке с причиной; окно — состояние 16 «${v.t}» с «${v.buttons.join("» и «")}»; первая кнопка открывает настройки с фокусом в поле ключа`);

    // ---- сайт, DeepL без ключа: Shift на четырёх абзацах — ни одного красного, одно спокойное уведомление ----
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await web.cmd("Page.bringToFront"); await sleep(300);
    const pos = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    const txt = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const hover = async (sel) => { const q = await pos(sel); await web.mouse("mouseMoved", q.x, q.y); await sleep(40); await web.mouse("mouseMoved", q.x + 2, q.y); await sleep(40); };
    const away = async () => { await web.mouse("mouseMoved", 5, 690); await sleep(150); };
    for (const sel of ["#p1", "#p2", "#p3", "#p1"]) { await hover(sel); await tapShift(); await sleep(500); }
    assert.strictEqual(await web.ev("document.querySelectorAll('.ht-error, .ht-loading').length"), 0, "ни одного красного абзаца");
    assert.strictEqual(await txt("#p1"), EN_P1, "абзац не тронут");
    const ui1 = await pageUi(web);
    const toasts = ui1.all.filter((x) => x.kind === "toast");
    console.log("      (сайт, DeepL без ключа: уведомлений " + toasts.length + (toasts[0] ? " — " + JSON.stringify(toasts[0].texts) : "") + ")");
    assert.strictEqual(toasts.length, 1, "одно уведомление на четыре нажатия");
    const t1 = toasts[0].texts;
    assert.ok(t1.includes(await msg("probTitle")) && t1.includes(await msg("openSettings")) && t1.includes(await msg("useBuiltin")), "«Перевод не работает» с «Открыть настройки» и «Переводить встроенным»: " + JSON.stringify(t1));
    await web.shot("page-nokey.png");
    ok("сайт, DeepL без ключа: Shift на четырёх абзацах — ни одного красного, страница не тронута; одно уведомление «Перевод не работает» с «Открыть настройки» и «Переводить встроенным»");

    // ---- «Переводить встроенным» в окне ----
    p = await pop.open(web, WEB);
    assert.strictEqual((await popupView(p)).n, 16);
    await clickSel(p, "button[data-k=builtin]");
    assert.ok(await until(async () => (await get(["engine"])).engine === "chrome", 3000), "переводчик — встроенный");
    v = await until(async () => { const x = await popupView(p); return x.n === 0 ? x : null; }, 3000);
    assert.ok(v, "окно — обычное состояние");
    await sleep(300);
    assert.deepStrictEqual(await badge(), ["", NAME], "значок чистый");
    await pop.close();
    // причину устранили — уведомление «Перевод не работает» закрылось само
    assert.ok(await until(async () => !(await pageUi(web)).toast, 3000), "уведомление о проблеме закрылось");
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await web.cmd("Page.bringToFront"); await sleep(200);
    await away(); await hover("#p1"); await tapShift();
    const ru1 = await until(async () => { const t = await txt("#p1"); return /[а-яё]{3}/i.test(t) ? t : ""; }, 10000);
    console.log("      (сайт, встроенный: " + ru1 + ")");
    assert.ok(ru1, "встроенный перевёл абзац без щелчков (модель уже скачана)");
    await web.shot("page-builtin.png");
    ok("«Переводить встроенным» (настоящий щелчок в окне): переводчик — встроенный, значок чистый, уведомление о проблеме закрылось само; сайт переводит встроенным без щелчков");

    // ---- «Везде»: «off» на значке ----
    p = await pop.open(web, WEB);
    await clickSel(p, ".p-scope");
    assert.ok(await until(async () => (await get(["enabled"])).enabled === false, 3000), "перевод выключен");
    await sleep(300);
    assert.deepStrictEqual(await badge(), ["off", await msg("badgeOff", NAME)]);
    assert.strictEqual((await popupView(p)).n, 9);
    assert.strictEqual(await txt("#p1"), EN_P1, "выключили — переведённое вернулось к оригиналу");
    await clickSel(p, ".p-scope");
    assert.ok(await until(async () => (await get(["enabled"])).enabled === true, 3000));
    await sleep(300);
    assert.deepStrictEqual(await badge(), ["", NAME]);
    await pop.close();
    ok("«Везде» (настоящий щелчок): выключил — на значке «off» (подсказка — «выключен»), переведённое вернулось к оригиналу; включил — значок чистый");

    // ---- обновление расширения при открытой вкладке ----
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await web.cmd("Page.bringToFront"); await sleep(200);
    await away(); await hover("#p1"); await tapShift();
    assert.ok(await until(async () => /[а-яё]{3}/i.test(await txt("#p1")), 8000), "перевод по Shift до обновления");
    await sleep(600);
    const isoBefore = web.isolated().length;
    await web.ev("window.__overs = 0; document.addEventListener('mouseover', () => { window.__overs++; }, true); true", web.isolated()[0].id);
    pageErrors.length = 0;
    // Обновление: повторная загрузка той же папки (chrome.runtime.reload() в этом режиме выгружает расширение
    // насовсем). Старый content-скрипт на вкладке остаётся без связи с расширением.
    await b.cmd("Extensions.loadUnpacked", { path: ext });
    await sleep(2500);
    ({ targetInfos } = await b.cmd("Target.getTargets"));
    assert.ok(!targetInfos.some((t) => t.type === "page" && t.url === EXT + "welcome.html" && t.targetId !== wt.targetId), "при обновлении приветствие не открывается");
    sw = await swNow();
    const iso = web.isolated();
    console.log(`      (изолированных миров на вкладке: до ${isoBefore}, после ${iso.length}; chrome.runtime.id в старом: ${iso[0] ? await web.ev("String(chrome.runtime.id)", iso[0].id) : "—"})`);
    await hover("#p2"); await tapShift();
    await sleep(600);
    console.log("      (mouseover в старом мире после обновления: " + await web.ev("window.__overs", web.isolated()[0].id) + "; наших окон на странице: " + await web.ev("document.querySelectorAll('[data-ht-ui]').length") + ")");
    assert.strictEqual(await txt("#p1"), EN_P1, "старый скрипт вернул оригинал");
    assert.ok(!/[а-яё]{3}/i.test(await txt("#p2")), "старый скрипт больше не переводит");
    assert.strictEqual(await web.ev("document.querySelectorAll('.ht-error, .ht-loading').length"), 0);
    assert.strictEqual(await web.ev("document.querySelectorAll('[data-ht-ui]').length"), 0, "ни одного нашего окна");
    assert.deepStrictEqual(pageErrors.filter((e) => e.startsWith(web.sessionId)), [], "на вкладке нет ошибок в консоли");
    ok("расширение обновили при открытой вкладке: старый скрипт вернул оригиналы и замолчал (без ошибок и уведомлений); приветствие не открылось");

    // ---- окно на устаревшей вкладке: «Обновить вкладку» ----
    p = await pop.open(web, WEB);
    v = await popupView(p);
    console.log("      (окно на устаревшей вкладке: " + v.n + " " + JSON.stringify(v.buttons) + ", подвал «" + v.foot + "»)");
    assert.strictEqual(v.n, 11, JSON.stringify(v));
    assert.deepStrictEqual(v.buttons, [await msg("ppReload")]);
    await popShots(p, "popup-stale");
    await clickSel(p, "button[data-k=reload]");
    v = await until(async () => { const x = await popupView(p); return x.n !== 11 ? x : null; }, 25000, 250);
    console.log("      (после «Обновить вкладку»: " + JSON.stringify(v && { n: v.n, site: v.site }) + ")");
    assert.ok(v && v.n === 0 && v.site && v.site.name === "127.0.0.1", "после обновления content-скрипт ответил: " + JSON.stringify(v));
    await pop.close();
    await b.cmd("Target.activateTarget", { targetId: web.targetId });
    await web.cmd("Page.bringToFront"); await sleep(300);
    await away(); await hover("#p1"); await tapShift();
    assert.ok(await until(async () => /[а-яё]{3}/i.test(await txt("#p1")), 8000), "после обновления вкладки перевод работает");
    ok("окно на вкладке со старым скриптом: «Обновить вкладку» → вкладка перезагружена, окно в рабочем состоянии (сайт 127.0.0.1), перевод работает");

    // ---- вкладка, куда расширение не пускают и после обновления: страница ошибки загрузки ----
    const bad = await b.openTab(DEAD);
    await sleep(1200);
    p = await pop.open(bad, DEAD);
    v = await popupView(p);
    assert.strictEqual(v.n, 11, "адрес http, content-скрипта нет — «Обновить вкладку»: " + JSON.stringify(v));
    await clickSel(p, "button[data-k=reload]");
    v = await until(async () => { const x = await popupView(p); return x.n !== 11 ? x : null; }, 30000, 250);
    console.log("      (страница ошибки после «Обновить вкладку»: " + JSON.stringify(v && { n: v.n, t: v.t, d: v.d, foot: v.foot, dot: v.dot }) + ")");
    assert.ok(v && v.n === 10, JSON.stringify(v));
    assert.deepStrictEqual([v.t, v.d, v.dot, v.site], [await msg("ppClosedT"), await msg("ppClosedD"), "off", null]);
    await popShots(p, "popup-closed");
    await pop.close();
    ok("вкладка, где content-скрипт не появляется и после обновления (страница ошибки загрузки): «Обновить вкладку» → «Здесь перевод не работает», серая точка, без строки сайта");

    const popErr = pageErrors.filter((e) => popSessions.has(e.split(" ")[0]));
    console.log("      (ошибки в окне: " + (popErr.length ? JSON.stringify(popErr) : "нет") + ")");
    assert.deepStrictEqual(popErr, [], "исключения в окне");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); process.exit(1); });
