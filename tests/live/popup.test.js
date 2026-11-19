// Окно расширения вживую: настоящее расширение в Chrome без интерфейса (CDP Extensions.loadUnpacked), настоящий
// встроенный переводчик, страницы по HTTP (fixtures/live.html, свой сервер lib/server.js).
// Окно открывается как настоящее — нажатием на значок (CDP Extensions.triggerAction): так проверяется и
// разрешение activeTab (окно видит адрес вкладки). Chrome без triggerAction — окно вкладкой с подменой
// «активной вкладки» (адреса тогда нет, проверка activeTab пропускается).
// Проверяет: activeTab (адрес сайта, служебная страница → «Здесь перевод не работает»); вкладка, открытая до
// установки → «Обновить вкладку» → работает; «Скачать переводчик» (если модели ещё нет); обычное состояние и
// размеры (место действия 72, окно ≤ 600); «Везде», строка сайта, плавающая кнопка (кнопка подвала показывает и прячет
// кружок на вкладке; «Везде» выключено — кружка нет); согласие на отправку текста: без
// него ни одного запроса к DeepL/ИИ (наведение, «Перевести страницу», прямое сообщение из content-скрипта),
// «Разрешить отправку» в окне — согласие только на этот сервис, текст уходит; «Авто» без согласия — переводит
// встроенный; ИИ с согласием только на DeepL — 0 запросов; все 19 состояний окна (вид по модели) в светлой и тёмной
// теме: место действия 72, подсказки в одну строку, высоты рядов как на макете. Отзыв согласия — на странице
// настроек (не здесь). Скриншоты — с tests/run.sh --shots.
// Сеть считаем дважды: крючком на fetch в копии background.js и событиями Network service worker-а.
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
const { pageUi } = require("../lib/live");
// Ожидаемые тексты — из _locales, а не вписанные руками: тексты правят отдельно от проверок.
const MSG_RU = require(path.join(__dirname, "..", "..", "hover-translate", "_locales", "ru", "messages.json"));
// Сообщение, как его соберёт chrome.i18n: $имя$ → подстановка по номеру из placeholders.
function msg(key, subs) {
  const m = MSG_RU[key];
  assert.ok(m, "нет сообщения " + key);
  const ph = {};
  for (const [n, d] of Object.entries(m.placeholders || {})) ph[n.toLowerCase()] = Number(String(d.content).replace("$", "")) - 1;
  return m.message.replace(/\$(\w+)\$/g, (all, n) => (n.toLowerCase() in ph ? String([].concat(subs || [])[ph[n.toLowerCase()]] ?? "") : all));
}
const PROVIDERS = /api(-free)?\.deepl\.com|api\.openai\.com|api\.anthropic\.com/;
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 10000, step = 150) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const HOOK = `// крючок теста (только в копии): адреса всех запросов service worker-а
{ const f = self.fetch.bind(self); self.__htNet = []; self.fetch = (u, o) => { self.__htNet.push(String(u)); return f(u, o); }; }
`;
const FAKE_KEY = "00000000-0000-0000-0000-000000000000:fx";

// Факты для 19 состояний окна (HT_popup.show): вкладка medium.com, как на макете.
function stateFacts(tabId) {
  const now = Date.now();
  const S = { enabled: true, targetLang: "RU", sourceLang: "auto", engine: "chrome", trigger: "shift", llmProvider: "openai",
    apiKey: false, apiKeyFree: true, llmApiKey: false, consent: { deepl: false, openai: false, anthropic: false },
    recentLangs: ["RU", "DE", "FR", "ES"], disabledSites: [] };
  const TAB = { id: tabId, url: "https://medium.com/story", kind: "web", loading: false };
  const TS = { ok: true, hud: false, site: "medium.com", siteOff: false, lang: "en", page: "idle", done: 0, total: 0, count: 0, src: "" };
  const READY = { kind: "ready", src: "en", tgt: "ru" }, NEED = { kind: "need", src: "en", tgt: "ru" };
  const f = (o) => ({ s: Object.assign({}, S, o.s), tab: Object.assign({}, TAB, o.tab), ts: o.ts === null ? null : Object.assign({}, TS, o.ts),
    bi: o.bi || READY, dl: o.dl || null, net: o.net || null, hasApi: o.hasApi !== false, doing: "", keys: { toggle: "Alt+Shift+O", page: "Alt+Shift+G" } });
  const deepl = { engine: "deepl", apiKey: true, consent: { deepl: true } };
  const net = (code) => ({ code, via: "deepl", provider: "deepl", at: now });
  return [
    [1, "first-run", f({ s: { recentLangs: [] }, bi: NEED })],
    [2, "downloading", f({ s: { recentLangs: [] }, bi: NEED, dl: { run: true, pct: 42 } })],
    [3, "busy", f({ ts: { page: "busy", done: 8, total: 12 } })],
    [4, "done", f({ ts: { page: "done", src: "en" } })],
    [5, "orig", f({ ts: { page: "orig", src: "en" } })],
    [6, "part", f({ ts: { page: "part", count: 3 } })],
    [7, "already", f({ ts: { lang: "ru", site: "habr.com" } })],
    [8, "site-off", f({ s: { disabledSites: ["medium.com"] } })],
    [9, "all-off", f({ s: { enabled: false } })],
    [10, "closed", f({ tab: { url: "chrome://extensions/", kind: "closed" }, ts: null })],
    [11, "reload", f({ ts: null })],
    [12, "no-builtin", f({ hasApi: false, bi: { kind: "none" } })],
    [13, "lang", f({ s: { targetLang: "AF", recentLangs: ["AF", "DE", "FR", "ES"] }, bi: { kind: "no-lang" } })],
    [14, "dl-fail", f({ s: { recentLangs: [] }, bi: NEED, dl: { fail: true } })],
    [15, "consent", f({ s: { engine: "deepl", apiKey: true } })],
    [16, "no-key", f({ s: { engine: "deepl", consent: { deepl: true } } })],
    [17, "bad-key", f({ s: deepl, net: net("bad-key") })],
    [18, "quota", f({ s: deepl, net: net("quota") })],
    [19, "offline", f({ s: deepl, net: net("network") })],
  ];
}
// Высоты окна по макету PopupStates (без рамки макета 1 px): ряды одинаковые, проблемы — свои. 15 — 547, а не 567, как
// на макете: текст согласия после замены «абзацев» на «текст» стал на строку короче.
const HEIGHTS = { 1: 369, 2: 369, 3: 409, 4: 409, 5: 409, 6: 409, 7: 409, 8: 409, 9: 409, 10: 348, 11: 348,
  12: 515, 13: 547, 14: 435, 15: 547, 16: 547, 17: 475, 18: 515, 19: 527 };

(async () => {
  const srv = await serve();
  const LIVE = srv.base + "/live.html";
  const BEFORE = srv.base + "/live.html?before=1";
  const b = await launch({ lang: "ru", profile: process.env.HT_PROFILE || null });
  const popSessions = new Set();
  const popErrors = [];
  const swNet = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown" && popSessions.has(m.sessionId)) popErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === "Network.requestWillBeSent") swNet.push(m.params.request.url);
  });
  try {
    // вкладка, открытая ДО установки расширения: content-скрипта на ней нет
    const before = await b.openTab(BEFORE);
    await sleep(800);
    const ext = b.copyExt();   // новая папка — новое расширение (см. copyExt в lib/chrome.js)
    fs.writeFileSync(path.join(ext, "background.js"), fs.readFileSync(path.join(ext, "background.js"), "utf8").replace('importScripts("shared.js");', 'importScripts("shared.js");\n' + HOOK));
    const { id } = await b.cmd("Extensions.loadUnpacked", { path: ext });
    const EXT = `chrome-extension://${id}/`;
    await sleep(1500);
    let { targetInfos } = await b.cmd("Target.getTargets");
    // лишние вкладки (about:blank, приветствие) — закрываем; вкладку «до установки» оставляем
    for (const t of targetInfos) if (t.type === "page" && t.targetId !== before.targetId) await b.cmd("Target.closeTarget", { targetId: t.targetId });
    const sw = await b.attach(targetInfos.find((t) => t.type === "service_worker" && t.url === EXT + "background.js").targetId);
    await sw.cmd("Network.enable").catch(() => {});
    const net = async () => (await sw.ev("JSON.stringify(self.__htNet)").then(JSON.parse)).filter((u) => PROVIDERS.test(u));
    const store = (o) => sw.ev(`chrome.storage.local.set(${JSON.stringify(o)}).then(() => true)`);
    const badge = () => sw.ev("Promise.all([chrome.action.getBadgeText({}), chrome.action.getTitle({})]).then((r) => JSON.stringify(r))").then(JSON.parse);
    // профиль постоянный — начинаем с чистого хранилища расширения
    await sw.ev("chrome.storage.local.clear().then(() => true)");
    await store({ enabled: true, engine: "chrome", targetLang: "RU", sourceLang: "auto", trigger: "shift", dwellMs: 600, recentLangs: ["RU", "DE", "EN-US"] });

    const web = await b.openTab(LIVE);
    await web.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(1000);

    // ---- окно: нажатие на значок (или вкладкой, если Chrome не умеет triggerAction) ----
    let realPopup = true;
    const closePopups = async () => {
      for (const t of (await b.cmd("Target.getTargets")).targetInfos) {
        if (t.url.startsWith(EXT + "popup.html")) await b.cmd("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    };
    const chromeTabId = async (page) => {
      await b.cmd("Target.activateTarget", { targetId: page.targetId });
      await sleep(200);
      return sw.ev("chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t.id)");
    };
    async function openPopup(page, url) {
      await closePopups();
      await b.cmd("Target.activateTarget", { targetId: page.targetId });
      await sleep(200);
      let t = null;
      if (realPopup) {
        const tab = (await b.cmd("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos.find((x) => x.type === "tab" && x.url === url);
        try {
          await b.cmd("Extensions.triggerAction", { id, targetId: tab.targetId });
          t = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((x) => x.url === EXT + "popup.html"), 5000, 100);
        } catch (e) { console.log("      (Extensions.triggerAction недоступен: " + e.message.slice(0, 120) + " — окно вкладкой)"); }
        if (!t) realPopup = false;
      }
      let p;
      if (t) p = await b.attach(t.targetId);
      else {
        const tid = await chromeTabId(page);
        const { targetId } = await b.cmd("Target.createTarget", { url: "about:blank" });
        p = await b.attach(targetId);
        await p.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `if (self.chrome && chrome.tabs) { const q = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = (i, cb) => { if (i && i.active) { const pr = chrome.tabs.get(${tid}).then((x) => [x]); if (cb) { pr.then(cb); return; } return pr; } return q(i, cb); }; }` });
        await p.cmd("Page.navigate", { url: EXT + "popup.html" });
        await p.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
      }
      popSessions.add(p.sessionId);
      await until(() => p.ev("!!(window.HT_popup && HT_popup.view())").catch(() => false), 8000);
      await sleep(300);
      return p;
    }
    const view = (p) => p.ev(`JSON.stringify((() => { const v = HT_popup.view(); const f = HT_popup.facts;
      return { n: v.n, act: v.act.k, foot: v.foot.text, dot: v.foot.dot, fab: v.foot.mini, site: v.site, t: v.act.t || "",
        url: f.tab && f.tab.url, buttons: [...document.querySelectorAll(".p-act button, .p-prob button")].map((x) => x.textContent) }; })())`).then(JSON.parse);
    const clickSel = async (p, sel) => {
      const r = await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(r, "нет элемента " + sel);
      await p.click(r.x, r.y);
    };
    const theme = (p, dark) => p.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    // Снимок окна по размеру содержимого. Настоящее окно Chrome подгоняет под содержимое сам (размер ему задать нельзя).
    const shot = async (p, name) => {
      const h = await p.ev("Math.ceil(document.body.getBoundingClientRect().height)");
      const fixed = await p.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: h, deviceScaleFactor: 1, mobile: false }).then(() => true, () => false);
      await sleep(fixed ? 150 : 400);
      await p.shot(name, fixed ? {} : { clip: { x: 0, y: 0, width: 340, height: h, scale: 1 } });
      return h;
    };

    // ---- activeTab: окно по значку видит адрес вкладки; служебная страница — состояние 10 ----
    // До нажатия на значок адреса вкладки сайта не видно никому (выданный activeTab живёт до перехода на другой адрес).
    const webTabId = await chromeTabId(web);
    const plain = await b.openTab(EXT + "popup.html");   // та же страница вкладкой, без нажатия на значок
    await sleep(800);
    const noUrl = await plain.ev(`chrome.tabs.get(${webTabId}).then((t) => t.url || "")`);
    await b.cmd("Target.closeTarget", { targetId: plain.targetId });
    assert.strictEqual(noUrl, "", "без нажатия на значок адреса нет (activeTab не выдан)");
    let pop = await openPopup(web, LIVE);
    let v = await view(pop);
    console.log("      (окно по значку: " + (realPopup ? "настоящее" : "вкладкой") + "; адрес вкладки: " + v.url + "; состояние " + v.n + ")");
    if (realPopup) {
      assert.strictEqual(v.url, LIVE, "activeTab: окно видит адрес активной вкладки");
      const size = JSON.parse(await pop.ev("JSON.stringify([innerWidth, innerHeight, Math.ceil(document.body.getBoundingClientRect().height)])"));
      assert.ok(size[0] === 340 && size[1] === size[2] && size[2] <= 600, "окно по содержимому: " + size);
      const svc = await b.openTab("chrome://version/");
      await sleep(600);
      const ps = await openPopup(svc, "chrome://version/");
      const vs = await view(ps);
      assert.strictEqual(vs.n, 10, "служебная страница: " + JSON.stringify(vs));
      assert.deepStrictEqual([vs.dot, vs.fab, vs.site], ["off", null, null]);
      await closePopups();
      await b.cmd("Target.closeTarget", { targetId: svc.targetId });
      ok(`activeTab: окно по значку (CDP Extensions.triggerAction) видит адрес вкладки, вкладкой без значка — нет; окно ${size[0]}×${size[2]}; chrome://version → «Здесь перевод не работает», серая точка, без строки сайта и кнопки плавающей кнопки`);
    } else ok("activeTab не проверен: в этом Chrome нет Extensions.triggerAction (окно открыто вкладкой)");

    // ---- вкладка, открытая до установки: «Обновить вкладку» ----
    pop = await openPopup(before, BEFORE);
    v = await view(pop);
    if (realPopup) {
      assert.strictEqual(v.n, 11, "вкладка до установки: " + JSON.stringify(v));
      assert.deepStrictEqual(v.buttons, ["Обновить вкладку"]);
      await clickSel(pop, "button[data-k=reload]");
      v = await until(async () => { const x = await view(pop); return x.n !== 11 ? x : null; }, 20000, 250);
      assert.ok(v && v.n !== 10 && v.site && v.site.name === "127.0.0.1", "после обновления content-скрипт ответил: " + JSON.stringify(v));
      ok(`вкладка, открытая до установки: «Обновить вкладку» перезагрузила её и дождалась content-скрипта — окно в рабочем состоянии (${v.n})`);
    }
    await closePopups();
    await b.cmd("Target.closeTarget", { targetId: before.targetId });

    // ---- встроенный переводчик: «Скачать переводчик», если пары ещё нет ----
    pop = await openPopup(web, LIVE);
    v = await view(pop);
    console.log("      (встроенный при открытии окна: состояние " + v.n + ", подвал «" + v.foot + "»)");
    for (let round = 0; round < 3 && (v.n === 1 || v.n === 2); round++) {
      if (v.n === 1) {
        if (round === 0) await shot(pop, "download-light.png");
        await clickSel(pop, "button[data-k=download]");
      }
      v = await until(async () => { const x = await view(pop); return x.n !== 2 ? x : null; }, 300000, 500);
    }
    assert.strictEqual(v.n, 0, "встроенный готов: " + JSON.stringify(v));
    assert.strictEqual(v.foot, "Встроенный переводчик");
    ok("встроенный переводчик готов (если нужно было скачать — «Скачать переводчик» на месте действия, скриншот download-light.png)");

    // ---- обычное состояние: размеры и подписи ----
    const geo = JSON.parse(await pop.ev(`JSON.stringify((() => {
      const box = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      const hint = document.querySelector(".p-act > .hint");
      return { head: box(".p-head"), act: box(".p-act"), foot: box(".p-foot"), body: Math.ceil(document.body.getBoundingClientRect().height),
        width: Math.round(document.body.getBoundingClientRect().width), hint: hint.textContent, kbd: hint.querySelector(".kbd") && hint.querySelector(".kbd").textContent,
        scope: [document.querySelector(".p-scope span").textContent, document.querySelector(".p-scope .switch").getAttribute("aria-label"), document.querySelector(".p-scope").title],
        chips: [...document.querySelectorAll(".chip:not([hidden])")].map((c) => c.textContent),
        fab: (() => { const b = document.querySelector(".p-foot button[aria-pressed]"); return b && [b.getAttribute("aria-label"), b.title, b.getAttribute("aria-pressed"), !!b.querySelector("svg")]; })(),
        status: document.querySelector(".status").title, font: getComputedStyle(document.querySelector(".srow-t")).fontFamily.split(",")[0] };
    })())`));
    console.log("      (" + JSON.stringify(geo) + ")");
    assert.deepStrictEqual([geo.head, geo.act, geo.foot, geo.width], [56, 72, 52, 340]);
    assert.ok(geo.body <= 600, "окно ≤ 600: " + geo.body);
    assert.strictEqual(geo.hint, msg("ppHintKey", "Shift"));
    assert.strictEqual(geo.kbd, "Shift");
    assert.strictEqual(geo.scope[0], "Везде");
    assert.strictEqual(geo.scope[1], "Перевод везде");
    assert.ok(/^Перевод на всех сайтах, кроме выключенных/.test(geo.scope[2]), geo.scope[2]);
    assert.deepStrictEqual(geo.chips, ["Deutsch"], "недавние: без текущего и без языка страницы (английский)");
    assert.deepStrictEqual(geo.fab, [msg("ppFab"), msg("ppFab"), "false", true], "кнопка «Плавающая кнопка на странице» в подвале, не нажата");
    assert.strictEqual(geo.status, "Сменить переводчик");
    assert.strictEqual(geo.font, "Inter", "шрифт окна — Inter из расширения");
    ok(`обычное состояние: шапка 56, место действия 72, подвал 52, окно 340×${geo.body}; «Везде» с подписью и подсказкой; чипы без текущего и исходного языка; шрифт Inter`);

    // ---- «Везде», строка сайта, плавающая кнопка ----
    await clickSel(pop, ".srow");
    v = await until(async () => { const x = await view(pop); return x.n === 8 ? x : null; }, 3000);
    assert.ok(v, "выключено на сайте");
    assert.deepStrictEqual(JSON.parse(await sw.ev("chrome.storage.local.get('disabledSites').then((s) => JSON.stringify(s.disabledSites))")), ["127.0.0.1"]);
    assert.strictEqual(v.fab, null, "на выключенном сайте кнопки плавающей кнопки нет");
    await clickSel(pop, ".srow");
    await until(async () => (await view(pop)).n === 0, 3000);
    await clickSel(pop, ".p-scope");
    v = await until(async () => { const x = await view(pop); return x.n === 9 ? x : null; }, 3000);
    assert.ok(v && v.site.dis && v.dot === "off", "выключено везде: строка сайта видна, но недоступна " + JSON.stringify(v));
    assert.strictEqual(await sw.ev("chrome.storage.local.get('enabled').then((s) => s.enabled)"), false);
    assert.strictEqual(await pop.ev("Math.ceil(document.body.getBoundingClientRect().height)"), geo.body, "окно не меняет высоту");
    await clickSel(pop, ".p-scope");
    await until(async () => (await view(pop)).n === 0, 3000);
    ok("строка сайта выключает и включает сайт (без кнопки плавающей кнопки); «Везде» выключает всё, высота окна та же");
    // плавающая кнопка: кнопка подвала показывает кружок на вкладке и прячет его; подсказка — что будет, aria-pressed
    const fabBtn = () => pop.ev(`(() => { const b = document.querySelector(".p-foot button[aria-pressed]"); return b && !b.hidden ? { label: b.getAttribute("aria-label"), title: b.title, pressed: b.getAttribute("aria-pressed") } : null; })()`);
    const fabOnTab = async () => !!(await pageUi(web)).hud;
    const hudShown = () => sw.ev("chrome.storage.local.get('hudShown').then((s) => s.hudShown === true)");
    assert.deepStrictEqual(await fabBtn(), { label: msg("ppFab"), title: msg("ppFab"), pressed: "false" });
    assert.strictEqual(await fabOnTab(), false, "кружка на вкладке нет");
    await clickSel(pop, ".p-foot button[aria-pressed]");
    v = await until(async () => { const x = await view(pop); return x.fab ? x : null; }, 3000);
    assert.ok(v, "кнопка нажата");
    const fabOn = await fabBtn();
    assert.ok(fabOn.pressed === "true" && fabOn.title === msg("ppFabHide"), "нажата, подсказка «Скрыть плавающую кнопку»: " + JSON.stringify(fabOn));
    assert.strictEqual(await hudShown(), true, "hudShown = true");
    assert.ok(await until(fabOnTab, 3000), "кружок появился на вкладке");
    await web.shot("popup-fab-on-tab.png", { clip: { x: 500, y: 460, width: 500, height: 300, scale: 1 } });
    // «Везде» выключено — кружка нет (и кнопки в подвале); включили — кружок вернулся сам
    await clickSel(pop, ".p-scope");
    assert.ok(await until(async () => (await view(pop)).n === 9, 3000));
    assert.ok(await until(async () => !(await fabOnTab()), 3000), "перевод выключен везде — кружка на вкладке нет");
    assert.strictEqual((await view(pop)).fab, null, "и кнопки в подвале нет");
    await clickSel(pop, ".p-scope");
    assert.ok(await until(async () => (await view(pop)).fab === true, 3000), "включили — кнопка снова нажата");
    assert.ok(await until(fabOnTab, 3000), "включили — кружок вернулся");
    await clickSel(pop, ".p-foot button[aria-pressed]");
    assert.ok(await until(async () => (await view(pop)).fab === false, 3000), "отжата");
    assert.deepStrictEqual(await fabBtn(), { label: msg("ppFab"), title: msg("ppFab"), pressed: "false" });
    assert.strictEqual(await hudShown(), false, "hudShown = false");
    assert.ok(await until(async () => !(await fabOnTab()), 3000), "кружок исчез с вкладки");
    ok("плавающая кнопка: кнопка подвала (aria-pressed, подсказка «Плавающая кнопка на странице» / «Скрыть плавающую кнопку») пишет hudShown, кружок на вкладке появляется и исчезает; «Везде» выключено — кружка и кнопки нет, включили — кружок вернулся");
    await closePopups();

    // ---- DeepL с ключом без согласия: ни одного запроса ----
    await store({ engine: "deepl", apiKey: FAKE_KEY, keyVerified: true });
    await sleep(400);
    const bd = await badge();
    assert.strictEqual(bd[0], "!");
    assert.ok(/согласие/.test(bd[1]), bd[1]);
    pop = await openPopup(web, LIVE);
    v = await view(pop);
    assert.strictEqual(v.n, 15, JSON.stringify(v));
    assert.strictEqual(v.t, "Отправлять текст в DeepL?");
    assert.deepStrictEqual(v.buttons, ["Разрешить отправку", "Переводить встроенным"]);
    assert.strictEqual(v.foot, "DeepL: нужно согласие");
    const hConsent = await pop.ev("Math.ceil(document.body.getBoundingClientRect().height)");
    assert.ok(hConsent <= 600, "окно с согласием ≤ 600: " + hConsent);
    await closePopups();
    // сайт: клавиша — ничего не уходит, страница не тронута
    await web.cmd("Page.bringToFront"); await sleep(200);
    const pos = (sel) => web.ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
    const txt = (sel) => web.ev(`document.querySelector('${sel}').textContent`);
    const ru = async (sel) => /[а-яё]{3}/i.test(await txt(sel));
    const tapShift = async () => { await web.key("rawKeyDown", "Shift", "ShiftLeft", 8, 16); await sleep(30); await web.key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(100); };
    const hover = async (sel) => { const p = await pos(sel); await web.mouse("mouseMoved", p.x, p.y); await sleep(40); await web.mouse("mouseMoved", p.x + 2, p.y); await sleep(40); };
    const esc = async () => { await web.key("rawKeyDown", "Escape", "Escape", 0, 27); await web.key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    await hover("#p1"); await tapShift(); await sleep(800);
    assert.ok(!(await ru("#p1")), "абзац не переведён");
    // «Перевести страницу» — тем же сообщением, что шлёт кнопка окна
    await sw.ev(`chrome.tabs.sendMessage(${webTabId}, { type: "translatePage", via: "popup" }, { frameId: 0 }).then(() => true)`); await sleep(1200);
    assert.ok(!(await ru("#p2")) && !(await ru("#p3")), "страница не переведена");
    // старый или подменённый content-скрипт шлёт текст напрямую — background отказывает
    let direct = null;
    for (const c of web.isolated()) {
      const has = await web.ev("typeof HT_engine === 'function'", c.id).catch(() => false);
      if (!has) continue;
      direct = await web.ev(`chrome.runtime.sendMessage({ type: "translateBatch", engine: "deepl", targetLang: "RU", sourceLang: "auto", formality: "default", noTranslate: "", by: "user-initiated", items: ["Secret text straight from the content script"] }).then((r) => JSON.stringify(r))`, c.id);
      break;
    }
    console.log("      (сообщение из content-скрипта в обход проверок: " + direct + ")");
    assert.ok(direct && /"code":"no-consent"/.test(direct), direct);
    assert.deepStrictEqual(await net(), [], "ни одного запроса к DeepL/ИИ (крючок fetch)");
    assert.deepStrictEqual(swNet.filter((u) => PROVIDERS.test(u)), [], "ни одного запроса к DeepL/ИИ (Network)");
    ok(`DeepL с ключом без согласия: «!» на значке; окно — «Отправлять текст в DeepL?» с «Разрешить отправку» и «Переводить встроенным» (${hConsent} px); Shift, «Перевести страницу» и прямое сообщение из content-скрипта — 0 запросов`);

    // ---- проверка ключа без согласия — можно (уходит только ключ) ----
    pop = await openPopup(web, LIVE);
    const chk = await pop.ev(`chrome.runtime.sendMessage({ type: "checkUsage" }).then((r) => JSON.stringify(r))`).catch((e) => String(e));
    await closePopups();
    await until(async () => (await net()).length > 0, 20000);
    const n1 = await net();
    console.log("      (проверка ключа без согласия: запросы " + JSON.stringify(n1) + "; ответ " + String(chk).slice(0, 80) + ")");
    assert.ok(n1.length === 1 && /\/v2\/usage$/.test(n1[0]), "один запрос /v2/usage, без текста");
    ok("проверка ключа без согласия: один запрос /v2/usage (только ключ), текст страниц не уходил");

    // ---- «Авто» с ключом без согласия: переводит встроенный, без запросов; окно — обычное, подвал подсказывает ----
    await store({ engine: "auto" });
    await sleep(400);
    assert.strictEqual((await badge())[0], "", "«Авто» работает встроенным — значок чистый");
    pop = await openPopup(web, LIVE);
    v = await view(pop);
    assert.strictEqual(v.n, 0, "«Авто» без согласия — обычное состояние: " + JSON.stringify(v));
    assert.ok(/^Авто: /.test(v.foot) && v.dot !== "", "подвал: " + v.foot);
    await closePopups();
    await web.cmd("Page.reload"); await sleep(1500);   // страница с чистого листа: выше её выключали, переводили, просили согласие
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p1"); await tapShift();
    // в новом сеансе Chrome включает определение языка только по щелчку — страница просит «Щёлкните по тексту»
    if (!(await until(() => ru("#p1"), 2500))) {
      const p = await pos("#p1");
      await web.click(p.x, p.y);
      if (!(await until(() => ru("#p1"), 4000))) { await hover("#p1"); await tapShift(); }
    }
    if (!(await until(() => ru("#p1"), 10000))) await web.shot("auto-fail.png");
    assert.ok(await until(() => ru("#p1"), 1000), "«Авто» без согласия перевёл встроенным");
    await esc();
    assert.strictEqual((await net()).length, 1, "к DeepL ничего не ушло");
    ok(`«Авто» с ключом без согласия: переводит встроенный, 0 запросов к DeepL, значок чистый; окно в обычном состоянии, подвал «${v.foot}»`);

    // ---- «Разрешить отправку» в окне настоящим щелчком ----
    // Проверка ключа выше получила отказ, а отклонённый ключ background больше не отправляет (до смены ключа) —
    // поэтому, чтобы увидеть, что согласие открывает отправку, — другой выдуманный ключ.
    await store({ engine: "deepl", apiKey: FAKE_KEY.replace(/^0/, "1") });
    await sleep(400);
    pop = await openPopup(web, LIVE);
    assert.strictEqual((await view(pop)).n, 15);
    await clickSel(pop, "button[data-k=consent]");
    await sleep(500);
    assert.deepStrictEqual(JSON.parse(await sw.ev("chrome.storage.local.get('consent').then((s) => JSON.stringify(s.consent))")), { deepl: true, openai: false, anthropic: false });
    assert.strictEqual((await badge())[0], "", "согласились — «!» снят");
    v = await view(pop);
    assert.ok(v.n !== 15, "окно больше не просит согласия: " + JSON.stringify(v));
    await closePopups();
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p2"); await tapShift();
    const sent = await until(async () => (await net()).some((u) => /\/v2\/translate$/.test(u)), 20000);
    assert.ok(sent, "после согласия запрос в DeepL ушёл: " + JSON.stringify(await net()));
    await sleep(2500); await esc();
    // выдуманный ключ DeepL отклонил (или сети нет) — окно показывает это само (htNetErr)
    const err = JSON.parse(await sw.ev("chrome.storage.session.get('htNetErr').then((s) => JSON.stringify(s.htNetErr || null))"));
    pop = await openPopup(web, LIVE);
    v = await view(pop);
    console.log("      (ответ DeepL на выдуманный ключ: " + JSON.stringify(err) + " → состояние окна " + v.n + " «" + v.t + "»)");
    if (err && err.code === "bad-key") {
      assert.strictEqual(v.n, 17);
      assert.deepStrictEqual(v.buttons, ["Проверить ключ в настройках"]);
      assert.strictEqual(v.foot, "DeepL: ключ не принят");
    } else if (err && /network|timeout|server/.test(err.code)) assert.strictEqual(v.n, 19);
    await closePopups();
    ok(`«Разрешить отправку» (настоящий щелчок): согласие записано только для DeepL, «!» снят, текст ушёл в DeepL; сбой ответа — в окне состоянием ${v.n}`);

    // ---- ИИ: согласие на DeepL не открывает Anthropic ----
    await store({ engine: "llm", llmProvider: "anthropic", llmApiKey: "sk-ant-fake", consent: { deepl: true } });
    await sleep(400);
    assert.strictEqual((await badge())[0], "!");
    const n2 = (await net()).length;
    await web.cmd("Page.bringToFront"); await sleep(200);
    await hover("#p1"); await tapShift(); await sleep(1200);
    assert.strictEqual((await net()).length, n2, "к Anthropic ничего не ушло");
    pop = await openPopup(web, LIVE);
    v = await view(pop);
    assert.strictEqual(v.n, 15);
    assert.strictEqual(v.t, "Отправлять текст в Anthropic?");
    assert.strictEqual(v.foot, "Claude: нужно согласие");
    ok("ИИ (Anthropic) с ключом и согласием только на DeepL: «!», Shift — 0 запросов, окно — «Отправлять текст в Anthropic?», подвал «Claude: нужно согласие»");

    // ---- все 19 состояний (вид по модели) в обеих темах ----
    // Окно вкладкой шириной 340: вид задают факты (HT_popup.show), вкладка и хранилище тут ни при чём.
    const tid = await pop.ev("HT_popup.facts.tab.id");
    await closePopups();
    pop = await b.openTab(EXT + "popup.html");
    popSessions.add(pop.sessionId);
    await pop.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    await until(() => pop.ev("!!(window.HT_popup && HT_popup.view())").catch(() => false), 8000);
    const rows = [];
    for (const dark of [false, true]) {
      await theme(pop, dark);
      for (const [n, name, facts] of stateFacts(tid)) {
        const got = await pop.ev(`HT_popup.show(${JSON.stringify(facts)}).n`);
        assert.strictEqual(got, n, name);
        await pop.ev("document.fonts.ready.then(() => true)");
        const chk = JSON.parse(await pop.ev(`JSON.stringify((() => {
          const out = [];
          const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); const c = [...r.getClientRects()].filter((q) => q.height > 8).map((q) => q.top + q.height / 2).sort((a, b) => a - b); return c.filter((v, i) => i === 0 || v - c[i - 1] > 10).length; };
          for (const el of document.querySelectorAll(".p-act, .p-off")) if (Math.round(el.getBoundingClientRect().height) !== 72) out.push("не 72: " + el.className);
          for (const el of document.querySelectorAll(".p-act > .hint, .p-off-t, .p-off-d")) if (lines(el) > 1 || el.scrollWidth > el.clientWidth + 1) out.push("подсказка не в строку: " + el.textContent);
          for (const el of document.querySelectorAll(".btn, .chip:not([hidden]), .st-t, .seg button")) if (el.scrollWidth > el.clientWidth + 1) out.push("обрезано: " + el.textContent);
          if (document.querySelector(".st-t").getBoundingClientRect().width > 182.5) out.push("подвал шире 182: " + document.querySelector(".st-t").textContent);
          return { out, h: Math.ceil(document.body.getBoundingClientRect().height) };
        })())`));
        assert.deepStrictEqual(chk.out, [], name);
        assert.strictEqual(chk.h, HEIGHTS[n], `${n} ${name}: высота окна`);
        await shot(pop, `state-${String(n).padStart(2, "0")}-${name}-${dark ? "dark" : "light"}.png`);
        if (!dark) rows.push(n + ":" + chk.h);
      }
    }
    await theme(pop, false);
    ok("19 состояний окна в светлой и тёмной теме: место действия 72, подсказки в одну строку, подвал ≤ 182 px, высоты как на макете (" + rows.join(" ") + ")");

    assert.deepStrictEqual(popErrors, [], "исключения в окне");
    console.log("      (исключения в окне: нет)");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
