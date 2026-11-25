// Перевод выделенного — сочетания частей: content.js в Chrome без интерфейса на тестовой странице с заглушкой chrome.*
// (fixtures/sel-card.html). Каждая часть проверена своим набором (sel-text, sel-key, sel-card, sel-highlight,
// sel-download, sel-menu); здесь — то, что видно только вместе: Shift над карточкой выделенного закрывает её; выделение
// расширили с клавиатуры — карточка закрылась, Shift переводит новое; пункт меню у второй строки выделения — карточка
// у неё, а не у последней; выделение в открытом shadow root — карточка у его строки; Esc, пока перевод в пути, —
// подсветки нет сразу, карточка не появляется; выделение в модальном окне сайта, сайт выключен — уведомление с кнопкой
// поверх окна, кнопка нажимается, карточка — тоже поверх окна. Ввод — настоящие события (Input.dispatch*).
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;
const RU = (s) => "[RU] " + s;
const near = (a, b, d = 2) => Math.abs(a - b) <= d;
const VW = 1000, VH = 700;

(async () => {
  const srv = await serve();
  const PAGE = srv.base + "/sel-card.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store) => {
      await t.cmd("Page.navigate", { url: PAGE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(150); };
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    const shiftRight = async (n) => {
      await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
      for (let i = 0; i < n; i++) { await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39); await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39); }
      await key("keyUp", "Shift", "ShiftLeft", 0, 16);
      await sleep(200);
    };
    const move = async (x, y) => { await t.mouse("mouseMoved", x, y); await sleep(30); await t.mouse("mouseMoved", x + 1, y); await sleep(60); };
    const trItems = () => ev("trCalls().map((c) => [c.items, c.by])");
    // Строки текста в элементе (или в элементе внутри открытого root: root — селектор хоста) по строкам, координаты окна.
    const phrase = (sel, text, host) => ev(`(() => {
      const scope = ${host ? `document.querySelector(${JSON.stringify(host)}).shadowRoot` : "document"};
      const el = scope.querySelector(${JSON.stringify(sel)});
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        const i = n.nodeValue.indexOf(${JSON.stringify(text)});
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${JSON.stringify(text)}.length);
        const out = [];
        for (const q of r.getClientRects()) {
          if (q.width < 1) continue;
          const s = out.find((o) => Math.abs(o.top - q.top) < q.height / 2);
          if (s) { s.right = Math.max(s.right, q.right); s.left = Math.min(s.left, q.left); continue; }
          out.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom });
        }
        return out;
      }
      return null; })()`);
    // Протяжка мышью от начала фразы a до конца фразы z (курсор остаётся у конца).
    const drag = async (a, z) => {
      const y1 = Math.round((a.top + a.bottom) / 2), y2 = Math.round((z.top + z.bottom) / 2);
      await move(Math.round(a.left + 1), y1);
      await t.mouse("mousePressed", Math.round(a.left + 1), y1, { button: "left", clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 4; i++) {
        await t.mouse("mouseMoved", Math.round(a.left + 1 + (z.right - 2 - a.left) * i / 4), Math.round(y1 + (y2 - y1) * i / 4), { button: "left", buttons: 1 });
        await sleep(20);
      }
      await t.mouse("mouseReleased", Math.round(z.right - 1), y2, { button: "left", clickCount: 1 });
      await sleep(150);
    };
    const selText = () => ev("String(document.getSelection())");
    const card = () => ev(`(() => {
      const r = cards()[0];
      if (!r) return null;
      const q = r.querySelector(".tcard").getBoundingClientRect(), h = r.host.getBoundingClientRect();
      return { l: q.left, t: q.top, r: q.right, b: q.bottom, x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2),
        up: r.querySelector(".tcard").classList.contains("up"), text: [...r.querySelectorAll(".c-text p")].map((p) => p.textContent).join("\\n"),
        top: r.host.matches(":popover-open"), parent: r.host.parentElement && r.host.parentElement.id };
    })()`);
    const cardText = async () => { const c = await card(); return c && c.text; };
    const noCard = async () => (await ev("cards().length")) === 0;

    // ---- 1. Shift над карточкой выделенного закрывает её (а2: курсор над карточкой — над выделением; б1: selCardRect) ----
    await load();
    const PH = "directamente sobre la tierra";
    const L1 = await phrase("#p1", PH);
    await drag(L1[0], L1[0]);
    assert.strictEqual(await selText(), PH);
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH));
    let c = await card();
    await move(c.x, c.y);                                   // курсор на карточку: над нашим окном блока под курсором нет
    await tapShift();
    assert.ok(await until(noCard, 1500), "Shift над карточкой закрыл её");
    assert.strictEqual((await trItems()).length, 1, "нового перевода нет");
    ok("Shift с курсором над карточкой выделенного закрывает её — нового перевода нет");

    // ---- 2. Выделение расширили с клавиатуры — карточка закрылась; Shift переводит новое выделение ----
    await move(Math.round(L1[0].right - 4), Math.round((L1[0].top + L1[0].bottom) / 2));
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH), "карточка снова есть");
    await shiftRight(4);
    assert.strictEqual(await selText(), PH + " y n", "выделение расширено");
    assert.ok(await until(noCard, 1500), "выделение сменилось — карточка закрылась");
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH + " y n"), "Shift перевёл новое выделение");
    assert.deepStrictEqual((await trItems()).slice(-1), [[[PH + " y n"], "user-initiated"]]);
    ok("выделение расширили Shift+→ — карточка прежнего закрылась; Shift (выделено с клавиатуры) переводит новое выделение");

    // ---- 3. Пункт меню: правый щелчок по второй строке выделения через два абзаца — карточка у неё ----
    await load();
    const A = (await phrase("#p1", "Riega por"))[0];
    const Z = (await phrase("#p2", "Los tomates necesitan"))[0];
    await drag(A, Z);
    const rows = await ev(`(() => { const out = []; for (const q of [...getSelection().getRangeAt(0).getClientRects()].sort((a, b) => a.top - b.top)) {
      if (q.width < 1) continue; const s = out.find((o) => Math.min(o.bottom, q.bottom) - Math.max(o.top, q.top) > q.height / 2);
      if (s) continue; out.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom }); } return out; })()`);
    assert.ok(rows.length >= 4, "выделение в несколько строк: " + rows.length);
    const r2 = rows[1];
    const px = Math.round(r2.left + 40), py = Math.round((r2.top + r2.bottom) / 2);
    await move(px, py);
    await t.mouse("mousePressed", px, py, { button: "right", clickCount: 1, buttons: 2 });
    await t.mouse("mouseReleased", px, py, { button: "right", clickCount: 1 });
    await sleep(100);
    await ev(`sendCmd({ type: "translateSelection", text: String(getSelection()) }); true`);
    assert.ok(await until(cardText, 3000), "карточка по пункту меню");
    c = await card();
    assert.ok(!c.up && near(c.t, r2.bottom + 10), `карточка под второй строкой (низ строки ${r2.bottom}, верх карточки ${c.t})`);
    assert.strictEqual((await trItems()).slice(-1)[0][0].length, 2, "два куска — по абзацам");
    ok("пункт меню после правого щелчка по второй строке выделения через два абзаца — карточка под этой строкой, два куска перевода");

    // ---- 4. Выделение в открытом shadow root — карточка под его строкой ----
    await load();
    await ev(`(() => { const h = document.createElement("div"); h.id = "sh"; document.querySelector("main").prepend(h);
      const r = h.attachShadow({ mode: "open" }); const p = document.createElement("p"); p.id = "sp";
      p.style.cssText = "margin: 0 0 16px; width: 640px; font: 18px/29px Georgia, serif";
      p.textContent = "Las semillas germinan mejor con calor suave y tierra siempre húmeda."; r.appendChild(p); return true; })()`);
    await sleep(100);
    const S = await phrase("#sp", "calor suave", "#sh");
    await drag(S[0], S[0]);
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU("calor suave"), "перевод выделенного в компоненте: " + JSON.stringify(await trItems()));
    c = await card();
    assert.ok(!c.up && near(c.t, S[0].bottom + 10), `карточка под строкой в компоненте (строка ${S[0].bottom}, карточка ${c.t})`);
    ok("выделение в открытом shadow root: Shift переводит его, карточка — под его строкой");

    // ---- 5. Esc, пока перевод в пути: подсветки нет сразу, карточка не появляется ----
    await load();
    await ev("window.__bgDelay = 1500; true");
    const E = await phrase("#p3", "primeras flores");
    await drag(E[0], E[0]);
    await tapShift();
    assert.ok(await until(() => ev("[...CSS.highlights.keys()].some((k) => k.startsWith('ht-sel'))"), 1000), "подсветка в пути");
    await esc();
    assert.ok(await until(() => ev("![...CSS.highlights.keys()].some((k) => k.startsWith('ht-sel'))"), 300), "Esc снял подсветку сразу");
    await sleep(1800);
    assert.ok(await noCard(), "пришедший перевод не показан");
    ok("Esc, пока перевод выделенного в пути, снимает подсветку сразу; пришедший перевод карточкой не показывается");

    // ---- 6. Модальное окно сайта, сайт выключен: уведомление с кнопкой поверх окна, кнопка нажимается ----
    await load();
    const site = await ev("HT_siteKey(location.hostname)");
    await ev(`setStore({ disabledSites: [${JSON.stringify(site)}] }); true`);
    await ev("document.querySelector('#dlg').showModal(); true");
    await sleep(150);
    const D = await phrase("#d1", "tres días hábiles");
    await drag(D[0], D[0]);
    const dx = Math.round(D[0].left + 20), dy = Math.round((D[0].top + D[0].bottom) / 2);
    await t.mouse("mousePressed", dx, dy, { button: "right", clickCount: 1, buttons: 2 });
    await t.mouse("mouseReleased", dx, dy, { button: "right", clickCount: 1 });
    await sleep(100);
    await ev(`sendCmd({ type: "translateSelection", text: String(getSelection()) }); true`);
    const note = await until(() => ev(`(() => { const r = __roots.find((x) => x.host.isConnected && x.querySelector(".toast .t-btn"));
      if (!r) return null; const b = r.querySelector(".t-btn").getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), top: r.host.matches(":popover-open"),
        parent: r.host.parentElement && r.host.parentElement.id, toastLeft: r.host.getBoundingClientRect().left }; })()`), 2000);
    assert.ok(note, "уведомление с кнопкой: " + JSON.stringify(await ev("toasts()")));
    assert.ok(note.top && note.parent === "dlg", "уведомление в верхнем слое, в окне сайта: " + JSON.stringify(note));
    assert.ok(note.toastLeft > VW / 2, "уведомление у правого края, как обычно: " + note.toastLeft);
    const hit = await ev(`(() => { const e = document.elementFromPoint(${note.x}, ${note.y}); return e && e.hasAttribute("data-ht-ui"); })()`);
    assert.ok(hit, "кнопка уведомления сверху — её не закрывает окно сайта");
    await t.click(note.x, note.y);
    assert.strictEqual(await until(cardText, 3000), RU("tres días hábiles"), "по кнопке — перевод");
    c = await card();
    assert.ok(c.top && c.parent === "dlg", "карточка — поверх окна сайта: " + JSON.stringify(c));
    assert.deepStrictEqual(await ev("__store.disabledSites"), [], "сайт включён");
    ok("выделение в модальном окне сайта, сайт выключен: уведомление с кнопкой — в верхнем слое у окна и нажимается; перевод — карточкой поверх окна");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
