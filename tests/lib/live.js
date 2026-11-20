// Общие приёмы живых наборов (настоящее расширение в Chrome без интерфейса):
//   pageUi / clickUi — наш интерфейс на странице сайта (уведомление, плавающая кнопка, карточка). Он в закрытом
//     shadow root: странице не виден (host.shadowRoot === null), а CDP видит — DOM.getDocument с pierce.
//     Щелчок — настоящий (Input.dispatchMouseEvent по середине элемента): кнопки нашего интерфейса
//     нажимаются только при isTrusted;
//   popupOpener — окно расширения как настоящее: нажатие на значок (CDP Extensions.triggerAction с целью типа
//     tab), так окно получает activeTab и видит адрес вкладки;
//   prepareBuiltin — довести приветствие до «Готово» (встроенный переводчик скачан), без проверок текстов:
//     их проверяет live/welcome.test.js;
//   mockDeepl — заглушка DeepL (адрес подменяют в копии background.js).
const http = require("http");
const { sleep, until } = require("./chrome");

// Слои нашего интерфейса (z-index хоста, см. content.js): карточка < плавающая кнопка (кружок, кнопки над ним и их
// панели — один хост, слой зовётся hud со времён мини-панели) < уведомление.
const LAYERS = { 2147483644: "card", 2147483645: "hud", 2147483646: "toast" };

function attrsOf(n) {
  const a = {};
  for (let i = 0; n.attributes && i < n.attributes.length; i += 2) a[n.attributes[i]] = n.attributes[i + 1];
  return a;
}
function textOf(n) {
  if (n.nodeType === 3) return n.nodeValue;
  if (n.nodeName === "STYLE" || n.nodeName === "SCRIPT") return "";
  return (n.children || []).concat(n.shadowRoots || []).map(textOf).join("");
}

// { toast, hud, card } — каждый null или { hostId, els, texts }: els — элементы внутри хоста ({ nodeId, parent, tag,
// attrs, text, hidden }; parent — nodeId родителя), texts — видимые человеку строки (текстовые узлы, title,
// aria-label; без списков языков — это самоназвания: select и самоназвания в панели языка у кружка, #fk-lang .nm).
// Ещё all — все хосты по порядку.
async function pageUi(tab) {
  const { root } = await tab.cmd("DOM.getDocument", { depth: -1, pierce: true });
  const out = { toast: null, hud: null, card: null, all: [] };
  const visit = (n) => {
    const a = attrsOf(n);
    if (n.nodeType === 1 && "data-ht-ui" in a) {
      const z = ((a.style || "").match(/z-index:\s*(\d+)/) || [])[1];
      const host = { kind: LAYERS[z] || "other", hostId: n.nodeId, els: [], texts: [] };
      const walk = (m, hidden, skip, langs, parent) => {
        const ma = attrsOf(m);
        const hid = hidden || (m.nodeType === 1 && "hidden" in ma);
        const inLangs = langs || ma.id === "fk-lang";
        const sk = skip || m.nodeName === "OPTION" || m.nodeName === "SELECT" || m.nodeName === "STYLE"
          || (inLangs && String(ma.class || "").split(/\s+/).includes("nm"));
        if (m.nodeType === 1 && m !== n) host.els.push({ nodeId: m.nodeId, parent, tag: m.nodeName, attrs: ma, text: textOf(m).trim(), hidden: hid });
        if (!sk) {
          if (m.nodeType === 3 && m.nodeValue.trim()) host.texts.push(m.nodeValue.trim());
          for (const k of ["title", "aria-label"]) if (m !== n && ma[k]) host.texts.push(ma[k]);
        }
        for (const c of m.children || []) walk(c, hid, sk, inLangs, m.nodeId);
        for (const s of m.shadowRoots || []) walk(s, hid, sk, inLangs, m.nodeId);
      };
      walk(n, false, false, false, null);
      out.all.push(host);
      if (host.kind in out && !out[host.kind]) out[host.kind] = host;
      return;
    }
    for (const c of n.children || []) visit(c);
    for (const s of n.shadowRoots || []) visit(s);
    if (n.contentDocument) visit(n.contentDocument);
  };
  visit(root);
  return out;
}

// Элемент нашего интерфейса: label — текст кнопки, её aria-label или title (строка или RegExp), либо функция.
function findIn(host, label) {
  if (!host) return null;
  const test = typeof label === "function" ? label
    : (e) => [e.text, e.attrs["aria-label"], e.attrs.title].some((v) => v != null && (label instanceof RegExp ? label.test(v) : v === label));
  return host.els.find((e) => !e.hidden && (e.tag === "BUTTON" || e.tag === "SELECT" || e.tag === "SPAN") && test(e))
    || host.els.find((e) => !e.hidden && test(e)) || null;
}

// Середина элемента на экране (null — не нарисован).
async function centerOf(tab, nodeId) {
  const r = await tab.cmd("DOM.getContentQuads", { nodeId }).catch(() => null);
  const q = r && r.quads && r.quads[0];
  if (!q) return null;
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  if (w < 1 || h < 1) return null;
  return { x: Math.min(...xs) + w / 2, y: Math.min(...ys) + h / 2, w, h, left: Math.min(...xs), top: Math.min(...ys) };
}

// Есть ли у элемента (из pageUi) класс c — целым словом: «fab» не совпадает с «fab-w», «fk» — с «fk-btn».
const hasCls = (e, c) => !!e && String(e.attrs.class || "").split(/\s+/).includes(c);

// Плавающая кнопка на вкладке (элементы — из pageUi; null — кружка нет):
//   fab — кружок (button.fab); bar — столбик кнопок над ним (#fk, role=toolbar; menu — то же, прежнее имя), open —
//   показан ли он; main, lang, more — его кнопки (button.fk-btn[data-k]); tip — подсказка (#fk-tip) и tipText —
//   { t, kbd, sub } (null — скрыта); langPop, morePop — панели языка (#fk-lang) и «⋯» (#fk-more), panel — какая
//   открыта ("" | "lang" | "more").
async function fabUi(tab) {
  const h = (await pageUi(tab)).hud;
  if (!h) return null;
  const byId = (id) => h.els.find((e) => e.attrs.id === id) || null;
  const fab = h.els.find((e) => e.tag === "BUTTON" && hasCls(e, "fab")) || null;
  const bar = byId("fk"), tip = byId("fk-tip"), langPop = byId("fk-lang"), morePop = byId("fk-more");
  const key = (k) => h.els.find((e) => e.tag === "BUTTON" && hasCls(e, "fk-btn") && e.attrs["data-k"] === k) || null;
  const kid = (p, c) => (p && h.els.find((e) => e.parent === p.nodeId && hasCls(e, c))) || null;
  let tipText = null;
  if (tip && !tip.hidden) {
    const t = kid(tip, "t"), kbd = kid(t, "fk-kbd"), sub = kid(tip, "sub");
    const k = kbd ? kbd.text : "", tt = t ? t.text : "";
    tipText = { t: (k && tt.endsWith(k) ? tt.slice(0, -k.length) : tt).trim(), kbd: k, sub: sub && !sub.hidden ? sub.text : "" };
  }
  const shown = (e) => !!e && !e.hidden;
  return { host: h, fab, bar, menu: bar, open: shown(bar), main: key("main"), lang: key("lang"), more: key("more"), tip, tipText,
    langPop, morePop, panel: shown(langPop) ? "lang" : shown(morePop) ? "more" : "" };
}

// Настоящий щелчок по элементу нашего интерфейса. kind — toast | hud | card; ждёт до ms, пока элемент появится.
async function clickUi(tab, kind, label, ms = 3000) {
  let at = null, el = null;
  await until(async () => {
    el = findIn((await pageUi(tab))[kind], label);
    at = el && (await centerOf(tab, el.nodeId));
    return !!at;
  }, ms, 100);
  if (!at) throw new Error(`нет ${kind} → ${label}`);
  await tab.click(at.x, at.y);
  return el;
}

// Окно расширения по значку. Возвращает { open(page, match), close(), real }: page — вкладка (из b.openTab),
// match — адрес вкладки или функция от адреса цели типа tab. real = false — в этом Chrome нет triggerAction:
// окно открывается вкладкой с подменой «активной вкладки» (адреса тогда не видно).
function popupOpener(b, id, onAttach) {
  const EXT = `chrome-extension://${id}/`;
  const o = { real: true };
  o.close = async () => {
    for (const t of (await b.cmd("Target.getTargets")).targetInfos) {
      if (t.url.startsWith(EXT + "popup.html")) await b.cmd("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  };
  o.open = async (page, match) => {
    await o.close();
    await b.cmd("Target.activateTarget", { targetId: page.targetId });
    await sleep(200);
    const want = typeof match === "function" ? match : (u) => u === match;
    let t = null;
    if (o.real) {
      const tab = (await b.cmd("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos.find((x) => x.type === "tab" && want(x.url));
      try {
        if (!tab) throw new Error("нет цели tab");
        await b.cmd("Extensions.triggerAction", { id, targetId: tab.targetId });
        t = await until(async () => (await b.cmd("Target.getTargets")).targetInfos.find((x) => x.url === EXT + "popup.html"), 5000, 100);
      } catch (e) { console.log("      (Extensions.triggerAction недоступен: " + e.message.slice(0, 120) + " — окно вкладкой)"); }
      if (!t) o.real = false;
    }
    let p;
    if (t) p = await b.attach(t.targetId);
    else {
      // окно вкладкой: «активная вкладка» — вкладка page (её id узнаём, сделав её активной)
      const sw = (await b.cmd("Target.getTargets")).targetInfos.find((x) => x.type === "service_worker" && x.url === EXT + "background.js");
      const s = await b.attach(sw.targetId);
      const tid = await s.ev("chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([x]) => x.id)");
      const { targetId } = await b.cmd("Target.createTarget", { url: "about:blank" });
      p = await b.attach(targetId);
      await p.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `if (self.chrome && chrome.tabs) { const q = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = (i, cb) => { if (i && i.active) { const pr = chrome.tabs.get(${tid}).then((x) => [x]); if (cb) { pr.then(cb); return; } return pr; } return q(i, cb); }; }` });
      await p.cmd("Page.navigate", { url: EXT + "popup.html" });
      await p.cmd("Emulation.setDeviceMetricsOverride", { width: 340, height: 600, deviceScaleFactor: 1, mobile: false });
    }
    if (onAttach) onAttach(p);
    await until(() => p.ev("!!(window.HT_popup && HT_popup.view())").catch(() => false), 8000);
    await sleep(300);
    return p;
  };
  return o;
}

// Вид окна (модель HT_popup.view()) коротко: номер состояния, место действия, подвал, строка сайта, кнопки.
// fab — кнопка «Плавающая кнопка» в подвале (поле модели foot.mini): null — её нет, true — кружок на вкладке, false — скрыт.
const popupView = (p) => p.ev(`JSON.stringify((() => { const v = HT_popup.view(); const f = HT_popup.facts;
  return { n: v.n, act: v.act.k, t: v.act.t || "", d: v.act.d || "", foot: v.foot.text, dot: v.foot.dot, fab: v.foot.mini, site: v.site,
    url: f.tab && f.tab.url, hint: (document.querySelector(".p-act > .hint") || {}).textContent || "",
    busy: (document.querySelector(".p-busy") || {}).textContent || "",
    seg: [...document.querySelectorAll(".seg button")].map((b) => b.dataset.k + ":" + b.getAttribute("aria-checked")),
    buttons: [...document.querySelectorAll(".p-act button, .p-prob button")].map((x) => x.textContent) }; })())`).then(JSON.parse);

// Настоящий щелчок в окне по селектору.
async function clickSel(p, sel) {
  const r = await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!r) throw new Error("нет элемента " + sel);
  await p.click(r.x, r.y);
}

// Приветствие → «Готово» (встроенный скачан). w — вкладка приветствия. Возвращает этап шага 2.
async function prepareBuiltin(w, ms = 300000) {
  const stage = () => w.ev("document.querySelector('#step2').dataset.stage").catch(() => "");
  const click = async () => {
    await w.cmd("Page.bringToFront");
    const r = await w.ev(`(() => { const e = document.querySelector("#dlBtn"); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (r) await w.click(r.x, r.y);
  };
  const t0 = Date.now();
  let clicked = 0;
  for (;;) {
    const s = await stage();
    if (["ready", "ready-hover", "success", "problem", "no-builtin"].includes(s)) return s;
    if (Date.now() - t0 > ms) return s;
    // «Скачать переводчик» (или «Повторить», или Chrome просит щелчок ещё раз) — когда пары действительно нет:
    // первые секунды после запуска Chrome детектор отвечает «downloadable», и страница перепроверяет сама.
    if (s === "start" || s === "failed") {
      const pairOk = await w.ev(`(() => { const p = HT_prepPair(document.querySelector('#targetLang').value);
        return Translator.availability({ sourceLanguage: p.src, targetLanguage: p.tgt }); })()`).catch(() => "");
      const waited = Date.now() - t0;
      if (s === "failed" || pairOk !== "available" || waited > 12000) {
        if (clicked < 6) { clicked++; await click(); await sleep(1500); continue; }
      }
    }
    await sleep(400);
  }
}

// Заглушка DeepL: /deepl/v2/translate отвечает «[<язык перевода>] <текст>» через delay мс; /deepl/v2/usage —
// остаток. log — пути запросов. Адреса DeepL подменяют в копии background.js (base + "/deepl").
function mockDeepl() {
  const st = { delay: 0, log: [] };
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const send = (res, code, body) => { res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, cors)); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      st.log.push(u.pathname);
      if (u.pathname === "/deepl/v2/usage") return send(res, 200, { character_count: 1000, character_limit: 1000000 });
      if (u.pathname === "/deepl/v2/translate") {
        let j = {};
        try { j = JSON.parse(body); } catch (e) { const q = new URLSearchParams(body); j = { text: q.getAll("text"), target_lang: q.get("target_lang") }; }
        const tgt = String(j.target_lang || "RU").split("-")[0].toUpperCase();
        const out = { translations: [].concat(j.text || []).map((t) => ({ detected_source_language: "EN", text: `[${tgt}] ` + t })) };
        return setTimeout(() => send(res, 200, out), st.delay);
      }
      send(res, 404, { message: "unknown " + u.pathname });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(Object.assign(st, {
    base: `http://127.0.0.1:${srv.address().port}`,
    translates: () => st.log.filter((p) => p === "/deepl/v2/translate").length,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  }))));
}

module.exports = { pageUi, findIn, hasCls, fabUi, centerOf, clickUi, popupOpener, popupView, clickSel, prepareBuiltin, mockDeepl };
