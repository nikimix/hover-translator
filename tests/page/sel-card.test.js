// Карточка перевода выделенного: content.js в Chrome без интерфейса на тестовой странице с заглушкой chrome.*
// (fixtures/sel-card.html, колонка текста Georgia 18/29, как на макете). Выделение — мышью (нажатие, протяжка,
// отпускание; двойной щелчок), клавиша — чистое нажатие Shift, Esc, щелчки и колесо — настоящие события
// (Input.dispatch*). Проверяется: карточка под строкой выделения у курсора (не под всем блоком), с хвостиком к
// строке, над строкой — у низа окна, в пределах окна, ширина по переводу от 280 до 480; несколько абзацев —
// отдельными абзацами через пустую строку; шрифт — как у выделенного; модальное окно сайта — карточка поверх него и
// нажимается; одна карточка за раз (и с карточкой абзаца в обе стороны); ошибка — уведомление; подпись и живая
// область для экранного диктора; та же клавиша над тем же выделением или карточкой закрывает, над другим — переводит
// заново, во время перевода — отменяет; Esc закрывает только карточку; щелчок мимо и новое выделение клавиатурой
// закрывают, выделение текста в карточке — нет; в режиме задержки уход курсора с карточки её не закрывает;
// прокрутка — карточка едет за строкой, заметная — закрывает; тёмный сайт и смена темы сайта.
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
    const load = async (store, extra) => {
      await t.cmd("Page.navigate", { url: PAGE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) + (extra || "") });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const calls = () => ev("trCalls().length");
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const tapShift = async () => {
      await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30);
      await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(150);
    };
    const esc = async () => { await key("rawKeyDown", "Escape", "Escape", 0, 27); await key("keyUp", "Escape", "Escape", 0, 27); await sleep(150); };
    // Shift+→: выделение на знак длиннее (нажатие с другой клавишей — не «чистое», не переводит)
    const shiftRight = async () => {
      await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16);
      await key("rawKeyDown", "ArrowRight", "ArrowRight", SHIFT, 39);
      await key("keyUp", "ArrowRight", "ArrowRight", SHIFT, 39);
      await key("keyUp", "Shift", "ShiftLeft", 0, 16);
      await sleep(200);
    };
    const move = async (x, y) => { await t.mouse("mouseMoved", x, y); await sleep(30); await t.mouse("mouseMoved", x + 1, y); await sleep(60); };
    const click = async (x, y) => { await t.click(x, y); await sleep(120); };
    // Колесо; ждём, пока прокрутка (окна и коробки) встанет — она плавная.
    const wheel = async (x, y, dy) => {
      await t.mouse("mouseWheel", x, y, { deltaX: 0, deltaY: dy });
      const pos = () => ev("scrollY + ',' + document.querySelector('#box').scrollTop");
      let last = await pos();
      for (let i = 0; i < 40; i++) { await sleep(80); const p = await pos(); if (p === last && i > 1) break; last = p; }
      await sleep(80);
    };
    // Строки фразы в элементе (координаты окна): прямоугольники Range по тексту, по строкам.
    const phrase = (sel, text) => ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
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
    // Выделить фразу мышью: нажать у её начала, протянуть, отпустить у конца (курсор остаётся над выделением).
    const select = async (sel, text, upTo) => {
      const L = await phrase(sel, text);
      assert.ok(L && L.length, "фраза на странице: " + text);
      const a = L[0], z = (upTo ? await phrase(upTo[0], upTo[1]) : L).slice(-1)[0];
      const y1 = Math.round((a.top + a.bottom) / 2), y2 = Math.round((z.top + z.bottom) / 2);
      await move(Math.round(a.left + 1), y1);
      await t.mouse("mousePressed", Math.round(a.left + 1), y1, { button: "left", clickCount: 1, buttons: 1 });
      for (let i = 1; i <= 4; i++) {
        await t.mouse("mouseMoved", Math.round(a.left + 1 + (z.right - 1 - a.left - 1) * i / 4), Math.round(y1 + (y2 - y1) * i / 4), { button: "left", buttons: 1 });
        await sleep(20);
      }
      await t.mouse("mouseReleased", Math.round(z.right - 1), y2, { button: "left", clickCount: 1 });
      await sleep(120);
      return L;
    };
    // Двойной щелчок по слову (выделяет его).
    const dbl = async (sel, word) => {
      const L = await phrase(sel, word);
      const x = Math.round((L[0].left + L[0].right) / 2), y = Math.round((L[0].top + L[0].bottom) / 2);
      await move(x, y);
      for (const n of [1, 2]) {
        await t.mouse("mousePressed", x, y, { button: "left", clickCount: n, buttons: 1 });
        await t.mouse("mouseReleased", x, y, { button: "left", clickCount: n });
      }
      await sleep(150);
      return L;
    };
    const selText = () => ev("String(document.getSelection())");
    // Строки выделения страницы (координаты окна), сверху вниз.
    const selRows = () => ev(`(() => {
      const out = [];
      for (const q of [...document.getSelection().getRangeAt(0).getClientRects()].sort((a, b) => a.top - b.top)) {
        if (q.width < 1) continue;
        const s = out.find((o) => Math.min(o.bottom, q.bottom) - Math.max(o.top, q.top) > q.height / 2);
        if (s) { s.left = Math.min(s.left, q.left); s.right = Math.max(s.right, q.right); continue; }
        out.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom });
      }
      return out; })()`);
    // Карточка (любая — абзаца или выделенного): место, хвостик, тексты, подписи. null — карточки нет.
    const card = () => ev(`(() => {
      const r = cards()[0];
      if (!r) return null;
      const box = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom, w: q.width, h: q.height }; };
      const c = r.querySelector(".tcard"), tx = r.querySelector(".c-text"), caret = r.querySelector(".caret"), sr = r.querySelector(".sr");
      const cs = getComputedStyle(tx);
      const ps = [...tx.querySelectorAll("p")];
      return { n: cards().length, host: box(r.host), card: box(c), caret: box(caret), up: c.classList.contains("up"), flat: c.classList.contains("flat"),
        dk: c.classList.contains("dk"), text: tx.textContent, paras: ps.map((p) => p.textContent), gap: ps.length > 1 ? ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom : 0,
        lh: parseFloat(cs.lineHeight), font: cs.fontFamily, size: parseFloat(cs.fontSize), label: c.getAttribute("aria-label"), role: c.getAttribute("role"),
        hidden: tx.getAttribute("aria-hidden"), say: sr ? sr.textContent : null, sayRole: sr ? sr.getAttribute("role") : null,
        top: r.host.matches(":popover-open"), parent: r.host.parentElement && r.host.parentElement.id };
    })()`);
    const cardText = async () => { const c = await card(); return c && c.text; };
    // Карточка под строкой (хвостик сверху) или над ней (хвостик снизу), её текст — под началом строки, хвостик —
    // над/под строкой, всё в пределах окна.
    const below = (c, line, what) => {
      assert.ok(!c.up && !c.flat, what + ": карточка под строкой, с хвостиком: " + JSON.stringify(c));
      assert.ok(near(c.card.t, line.bottom + 10), what + `: верх карточки ${c.card.t} — на 10 ниже строки (${line.bottom})`);
    };
    const above = (c, line, what) => {
      assert.ok(c.up && !c.flat, what + ": карточка над строкой, хвостик снизу: " + JSON.stringify(c));
      assert.ok(near(c.card.b, line.top - 10), what + `: низ карточки ${c.card.b} — на 10 выше строки (${line.top})`);
    };
    const placed = (c, line, what) => {
      assert.ok(near(c.card.l, Math.max(8, Math.min(line.left - 16, VW - 8 - c.card.w))), what + `: текст карточки под началом строки (карточка ${c.card.l}, строка ${line.left})`);
      const cx = (c.caret.l + c.caret.r) / 2;
      assert.ok(cx >= line.left - 1 && cx <= line.right + 1, what + `: хвостик (${cx}) — над строкой ${line.left}…${line.right}`);
      assert.ok(c.card.l >= 8 && c.card.r <= VW - 8 && c.card.t >= 8 && c.card.b <= VH - 8, what + ": карточка в пределах окна " + JSON.stringify(c.card));
      assert.ok(c.card.w >= 280 - 0.5 && c.card.w <= 480 + 0.5, what + ": ширина от 280 до 480: " + c.card.w);
    };

    // ---- 1. Фраза в первой строке блока: карточка под этой строкой ----
    await load();
    const PH = "directamente sobre la tierra";
    const L1 = await select("#p1", PH);
    assert.strictEqual(await selText(), PH, "выделена фраза");
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH), "в карточке перевод выделенного");
    assert.deepStrictEqual(await ev("trCalls().map((c) => [c.items, c.by])"), [[[PH], "user-initiated"]], "переводчику ушла фраза — по действию пользователя");
    let c = await card();
    const p1 = await ev("(() => { const r = document.querySelector('#p1').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()");
    assert.ok(p1.bottom - L1[0].bottom > 40, "блок ниже строки выделения ещё на строки");
    below(c, L1[0], "фраза");
    placed(c, L1[0], "фраза");
    assert.ok(near(c.card.w, 280, 0.5), "короткий перевод — карточка наименьшей ширины, 280: " + c.card.w);
    assert.strictEqual(await selText(), PH, "выделение страницы на месте");
    await t.shot("1-below-light.png");
    ok("фраза в первой строке блока: карточка под строкой выделения (на 10 px), текст — под её началом, хвостик — над ней, ширина 280");

    // ---- 2. Шрифт — как у выделенного текста ----
    assert.ok(/Georgia/.test(c.font) && c.size === 18, "шрифт перевода — Georgia 18, как у выделенного: " + c.font + " " + c.size);
    ok("шрифт перевода — как у выделенного текста (Georgia 18)");

    // ---- 3. Подпись карточки и живая область для экранного диктора ----
    assert.strictEqual(c.role, "dialog");
    assert.strictEqual(c.label, "Перевод выделенного", "подпись карточки — «Перевод выделенного»");
    assert.strictEqual(await until(async () => (await card()).say, 1500), RU(PH), "живая область получила перевод");
    c = await card();
    assert.strictEqual(c.sayRole, "status", "живая область — role=status");
    assert.strictEqual(c.hidden, "true", "видимый текст от диктора скрыт — не читается дважды");
    const ax = await t.cmd("Accessibility.getFullAXTree", {});
    const axv = (n, k) => n[k] && n[k].value;
    const dlgAx = ax.nodes.find((n) => axv(n, "role") === "dialog" && axv(n, "name") === "Перевод выделенного");
    assert.ok(dlgAx, "в дереве доступности — окно «Перевод выделенного»");
    const live = ax.nodes.find((n) => axv(n, "role") === "status" && (n.properties || []).some((p) => p.name === "live" && p.value.value === "polite"));
    assert.ok(live, "в дереве доступности — живая область (polite)");
    ok("экранный диктор: окно «Перевод выделенного», перевод — в живой области (role=status), видимый текст не дублируется");

    // ---- 4. Та же клавиша над тем же выделением закрывает ----
    // (Нажатие над самой карточкой разбирает обработчик клавиш — его проверяет набор клавиши.)
    await tapShift();
    assert.strictEqual(await card(), null, "Shift над тем же выделением закрыл карточку");
    assert.strictEqual(await calls(), 1, "и ничего не перевёл");
    await tapShift();
    assert.ok(await until(card, 3000), "следующий Shift — карточка снова");
    assert.strictEqual(await calls(), 2);
    ok("та же клавиша над тем же выделением закрывает карточку, следующая — открывает снова");

    // ---- 5. Выделение изменилось — переводит заново ----
    const PH2 = "comprueba la humedad cada tarde";
    await select("#p1", PH2);
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH2), "в карточке перевод нового выделения");
    const n5 = await calls();
    const PH3 = "En los días de calor";
    await select("#p1", PH3);
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(PH3), "иное выделение — перевод заново");
    assert.strictEqual(await calls(), n5 + 1);
    assert.strictEqual((await card()).n, 1, "карточка одна");
    ok("выделение изменилось — та же клавиша переводит его заново (карточка одна)");

    // ---- 6. Выделение текста в карточке её не закрывает; щелчок мимо — закрывает ----
    c = await card();
    const ty = Math.round(c.card.b - 20);
    await t.mouse("mouseMoved", Math.round(c.card.l + 18), ty);
    await t.mouse("mousePressed", Math.round(c.card.l + 18), ty, { button: "left", clickCount: 1, buttons: 1 });
    await t.mouse("mouseMoved", Math.round(c.card.l + 120), ty, { button: "left", buttons: 1 });
    await t.mouse("mouseReleased", Math.round(c.card.l + 120), ty, { button: "left", clickCount: 1 });
    await sleep(300);
    assert.ok((await selText()).length > 0, "в карточке выделен текст");
    assert.ok(await card(), "выделение в карточке её не закрыло");
    await click(VW - 60, VH - 60);
    assert.strictEqual(await card(), null, "щелчок мимо карточки закрыл её");
    ok("выделение текста в самой карточке её не закрывает; щелчок мимо — закрывает");

    // ---- 7. Новое выделение клавиатурой (Shift+→) закрывает ----
    await select("#p1", PH2);
    await tapShift();
    assert.ok(await until(card, 3000));
    const n7 = await calls();
    await shiftRight();
    assert.strictEqual(await selText(), PH2 + ":", "выделение стало на знак длиннее");
    assert.strictEqual(await card(), null, "новое выделение закрыло карточку");
    await sleep(300);
    assert.strictEqual(await calls(), n7, "Shift с другой клавишей ничего не перевёл");
    ok("выделение сменили клавиатурой (Shift+→) — карточка прежнего закрыта, ничего не переводится");

    // ---- 8. Перевод в пути: та же клавиша, Esc и щелчок мимо отменяют — карточка не появляется ----
    await ev("window.__bgDelay = 600; true");
    await select("#p2", "seis horas de sol");
    await tapShift();
    await tapShift();
    await sleep(900);
    assert.strictEqual(await card(), null, "Shift во время перевода — отмена, карточка не появилась");
    await tapShift();
    await esc();
    await sleep(900);
    assert.strictEqual(await card(), null, "Esc во время перевода — отмена");
    await tapShift();
    await click(VW - 60, VH - 60);
    await sleep(900);
    assert.strictEqual(await card(), null, "щелчок мимо во время перевода — отмена");
    await ev("window.__bgDelay = 0; true");
    ok("пока идёт перевод: та же клавиша, Esc и щелчок мимо отменяют — карточка не появляется");

    // ---- 9. Esc закрывает только карточку: переводы на странице остаются ----
    const P3 = await ev("document.querySelector('#p3').textContent");
    const p3l = await phrase("#p3", "potasio");
    await move(Math.round(p3l[0].left + 10), Math.round((p3l[0].top + p3l[0].bottom) / 2));
    await tapShift();
    assert.ok(await until(async () => (await ev("document.querySelector('#p3').textContent")) === RU(P3), 3000), "блок переведён клавишей");
    await select("#p1", PH);
    await tapShift();
    assert.ok(await until(card, 3000));
    await esc();
    assert.strictEqual(await card(), null, "Esc закрыл карточку");
    assert.strictEqual(await ev("document.querySelector('#p3').textContent"), RU(P3), "перевод блока на странице остался");
    await esc();
    assert.strictEqual(await ev("document.querySelector('#p3').textContent"), P3, "следующий Esc — оригинал страницы, как раньше");
    ok("Esc закрывает только карточку выделенного (перевод блока остаётся), следующий Esc — оригинал страницы");

    // ---- 10. Прокрутка: немного — карточка едет за строкой, заметно — закрывается ----
    await select("#p2", "elige plantas de hoja");
    await tapShift();
    assert.ok(await until(card, 3000));
    let before = await card();
    await wheel(VW - 100, 300, 60);
    let L10 = await phrase("#p2", "elige plantas de hoja");
    c = await card();
    assert.ok(c, "небольшая прокрутка карточку не закрыла");
    assert.ok(c.card.t < before.card.t - 30, `карточка уехала вверх вместе со строкой (${before.card.t} → ${c.card.t})`);
    below(c, L10[L10.length - 1], "после прокрутки");   // курсор — у конца фразы: якорь — её последняя строка
    await wheel(VW - 100, 300, 300);
    assert.strictEqual(await card(), null, "заметная прокрутка (больше четверти окна) закрыла карточку");
    await ev("scrollTo(0, 0); true"); await sleep(150);
    // Внутри прокручиваемой коробки — так же: карточка едет за строкой.
    await select("#b2", "entre el tallo y las hojas");
    await tapShift();
    assert.ok(await until(card, 3000));
    before = await card();
    const bx = await ev("(() => { const r = document.querySelector('#box').getBoundingClientRect(); return { x: Math.round(r.left + 100), y: Math.round(r.top + 30) }; })()");
    await wheel(bx.x, bx.y, 40);
    L10 = await phrase("#b2", "entre el tallo y las hojas");
    c = await card();
    const b10 = L10[L10.length - 1].bottom;
    assert.ok(c && near(c.card.t, b10 + 10) && c.card.t < before.card.t - 20, "прокрутка коробки — карточка едет за строкой: " + JSON.stringify([before.card.t, c && c.card.t, b10]));
    await click(VW - 60, VH - 60);
    ok("прокрутка: немного — карточка едет за строкой (и в прокручиваемой коробке), больше четверти окна — закрывается");

    // ---- 11. Внизу окна — над строкой; несколько абзацев — через пустую строку ----
    await ev("scrollTo(0, document.querySelector('#p6').getBoundingClientRect().bottom + scrollY - innerHeight + 12); true");
    await sleep(200);
    const L11 = await dbl("#p6", "compost");
    assert.strictEqual(await selText(), "compost", "двойной щелчок выделил слово");
    await tapShift();
    assert.ok(await until(card, 3000));
    c = await card();
    above(c, L11[0], "слово у низа окна");
    placed(c, L11[0], "слово у низа окна");
    await t.shot("2-above-light.png");
    await click(VW - 60, 40);
    const W1 = "Retira los brotes que salen entre el tallo y las hojas. Así la planta dedica su energía a los frutos.";
    const W2 = "Evita el exceso de nitrógeno: la planta crecerá mucho, pero dará pocos frutos.";
    await select("#p4", "Así la planta dedica", ["#p5", "pocos frutos."]);
    await tapShift();
    assert.ok(await until(card, 3000));
    c = await card();
    const rows = await selRows();
    assert.ok(rows.length >= 3, "выделено несколько строк: " + rows.length);
    assert.deepStrictEqual(c.paras, [RU("Así la planta dedica su energía a los frutos."), RU(W2)], "два абзаца — два куска, каждый отдельным абзацем");
    assert.deepStrictEqual((await ev("trCalls().slice(-1)[0].items")), ["Así la planta dedica su energía a los frutos.", W2], "переводчику — два куска");
    assert.ok(near(c.gap, c.lh, 1), `между абзацами — пустая строка (${c.gap} ≈ ${c.lh})`);
    assert.ok(c.card.w > 400 && c.card.w <= 480.5, "длинный перевод — карточка шире, до 480: " + c.card.w);
    // Курсор у конца выделения — якорь в последней строке; под ней места нет — карточка над выделением (над его
    // первой строкой), не закрывая выделенное.
    above(c, rows[0], "два абзаца у низа окна");
    placed(c, rows[0], "два абзаца у низа окна");
    assert.ok(c.card.b <= rows[0].top, "карточка не закрывает выделенное");
    assert.ok(W1.includes("Así"));
    await t.shot("3-paras-light.png");
    await click(VW - 60, 40);
    ok("у низа окна — карточка над строкой (хвостик снизу); два абзаца — два куска, в карточке через пустую строку, шире");

    // ---- 12. Одна карточка за раз — и с карточкой абзаца в обе стороны (режим карточки) ----
    await load({ displayMode: "popover" });
    const p3w = await phrase("#p3", "fertilizante");
    await move(Math.round(p3w[0].left + 5), Math.round((p3w[0].top + p3w[0].bottom) / 2));
    await tapShift();
    assert.ok(await until(async () => (await cardText()) === RU(P3), 3000), "карточка блока");
    await select("#p1", PH);
    await tapShift();
    assert.strictEqual(await until(async () => { const x = await cardText(); return x === RU(PH) && x; }, 3000), RU(PH), "карточка выделенного");
    assert.strictEqual((await card()).n, 1, "карточка блока закрыта — карточка одна");
    // Shift над тем же блоком, но не над выделением: переводится блок, карточка выделенного закрывается.
    const pend = await phrase("#p1", "y no sobre las hojas");
    await move(Math.round(pend[0].right - 10), Math.round((pend[0].top + pend[0].bottom) / 2));
    await tapShift();
    const P1 = await ev("document.querySelector('#p1').textContent");
    assert.strictEqual(await until(async () => { const x = await cardText(); return x === RU(P1) && x; }, 3000), RU(P1), "Shift над блоком вне выделения — карточка блока");
    assert.strictEqual((await card()).n, 1, "карточка выделенного закрыта — карточка одна");
    ok("одна карточка за раз: карточка выделенного закрывает карточку блока, карточка блока (того же) — карточку выделенного");

    // ---- 13. Ошибка — уведомление, карточки нет ----
    await load();
    // встроенного переводчика нет — запасного пути тоже: ошибка сервиса доходит до человека
    await ev(`Translator.availability = async () => 'unavailable'; window.__bgReply = () => ({ ok: false, code: "network", error: "Нет связи с DeepL — проверьте интернет.", detail: "Failed to fetch" }); true`);
    await select("#p2", "seis horas de sol");
    await tapShift();
    assert.ok(await until(async () => (await ev("toasts()")).some((s) => s.startsWith("err:") && s.includes("Нет связи с DeepL")), 3000), "уведомление об ошибке: " + JSON.stringify(await ev("toasts()")));
    assert.strictEqual(await card(), null, "карточки нет");
    await ev("window.__bgReply = null; true");
    ok("ошибка перевода — уведомление, как у блока; карточки нет");

    // ---- 14. Модальное окно сайта: карточка поверх окна и нажимается ----
    await load();
    await ev("document.querySelector('#dlg').showModal(); true");
    await sleep(150);
    const DP = "las semillas llegarán en tres días";
    const L14 = await select("#d1", DP);
    assert.strictEqual(await selText(), DP, "выделено в модальном окне");
    await tapShift();
    assert.strictEqual(await until(cardText, 3000), RU(DP));
    const hit = await ev(`(() => { const r = cards()[0]; const q = r.querySelector(".tcard").getBoundingClientRect();
      return document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) === r.host; })()`);
    assert.ok(hit, "карточка поверх модального окна (в точке карточки — она, а не окно и не фон за ним)");
    c = await card();
    below(c, L14[0], "в модальном окне");
    placed(c, L14[0], "в модальном окне");
    // кнопка «Закрыть» карточки нажимается (окно сайта не делает её inert)
    const xb = await ev(`(() => { const q = cards()[0].querySelectorAll(".c-btn")[1].getBoundingClientRect(); return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) }; })()`);
    await t.shot("4-dialog-light.png");
    await click(xb.x, xb.y);
    assert.strictEqual(await card(), null, "щелчок по ✕ карточки закрыл её");
    assert.ok(await ev("document.querySelector('#dlg').open"), "окно сайта открыто");
    await select("#d1", DP);
    await tapShift();
    assert.ok(await until(card, 3000));
    await esc();
    assert.strictEqual(await card(), null, "Esc закрыл карточку");
    ok("выделение в модальном окне сайта: карточка поверх окна, нажимается (✕), Esc закрывает");

    // ---- 15. Режим задержки: уход курсора с карточки выделенного её не закрывает ----
    // задержка подольше: пока выделяют мышью, блок под курсором не должен успеть перевестись (это разбирает набор клавиши)
    await load({ trigger: "dwell", dwellMs: 2000 });
    const PH15 = "seis horas de sol";
    const L15 = await select("#p2", PH15);
    await move(VW - 60, Math.round(L15[0].bottom));          // в сторону от текста — задержке нечего переводить
    await ev(`sendCmd({ type: "translateSelection", text: ${JSON.stringify(PH15)} }); true`);
    assert.strictEqual(await until(cardText, 3000), RU(PH15), "пункт меню — карточка выделенного: " + JSON.stringify([await selText(), await ev("trCalls().map((c) => c.items)"), await ev("document.querySelector('#p2').textContent")]));
    c = await card();
    await move(Math.round(c.card.l + 30), Math.round(c.card.b - 14));
    await move(VW - 60, VH - 40);
    await sleep(800);
    assert.ok(await card(), "курсор ушёл с карточки — карточка на месте");
    ok("режим задержки: уход курсора с карточки выделенного её не закрывает");

    // ---- 16. Тёмный сайт; сайт сменил тему — карточка следом ----
    await load({}, "&dark=1");
    await select("#p1", PH);
    await tapShift();
    assert.ok(await until(card, 3000));
    assert.ok((await card()).dk, "тёмный сайт — тёмная карточка");
    await t.shot("1-below-dark.png");
    await ev("document.documentElement.style.cssText = ''; true");
    assert.ok(await until(async () => { const x = await card(); return x && !x.dk; }, 2000), "сайт стал светлым — карточка светлая");
    await ev("document.documentElement.style.cssText = 'background: #121316; color: #d7dade;'; true");
    assert.ok(await until(async () => { const x = await card(); return x && x.dk; }, 2000), "и снова тёмным");
    await click(VW - 60, 40);
    await ev("scrollTo(0, document.querySelector('#p6').getBoundingClientRect().bottom + scrollY - innerHeight + 12); true");
    await sleep(200);
    await dbl("#p6", "compost");
    await tapShift();
    assert.ok(await until(card, 3000));
    await t.shot("2-above-dark.png");
    await click(VW - 60, 40);
    await select("#p4", "Así la planta dedica", ["#p5", "pocos frutos."]);
    await tapShift();
    assert.ok(await until(card, 3000));
    await t.shot("3-paras-dark.png");
    await click(VW - 60, 40);
    await ev("scrollTo(0, 0); document.querySelector('#dlg').showModal(); true");
    await sleep(150);
    await select("#d1", DP);
    await tapShift();
    assert.ok(await until(card, 3000));
    await t.shot("4-dialog-dark.png");
    ok("тёмный сайт — тёмная карточка; сайт сменил тему — карточка вслед за ним");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
