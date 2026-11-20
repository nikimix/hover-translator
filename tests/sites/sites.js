// Сайты и сценарии для tests/sites/run.js.
//
// Поля сайта:
//   id, title, url, lang (язык страницы), target (язык перевода: "RU" по умолчанию, коды как в shared.js);
//   main — селектор основного текста (по нему считаем долю кириллицы/латиницы после перевода);
//   key — элемент, который переводим наведением + Shift (по возможности — тот, с которым потом работает действие):
//     селектор или функция-поиск для страницы (её текст вставляется в выражение; dq/dqa/vis доступны) → элемент;
//   blocked(H) → строка, если сайт закрыт для автоматического браузера (403, капча), иначе null;
//   prepare(H) — подготовка (принять баннер cookie), выполняется и без расширения;
//   actions — обратимые действия сайта [{ name, phases?, run(H) → { ok, note } }]: выполняются после перевода
//     клавишей (фаза key), после «Перевести страницу» (page) и после Esc (orig); phases — только в этих фазах
//     (баннер cookie: перевести клавишей и нажать «Accept» в переведённом — один раз, в key).
//     Esc в действиях — только в поле ввода сайта (escInField: так и проверяем, что Esc в поле не возвращает
//     оригинал); Esc вне поля — это «вернуть оригинал»;
//   scroll(H) — подгрузка ленты после перевода страницы; nav(H) — переход (ссылка, отправка поиска) в конце;
//   navMain — основной текст страницы после перехода (по умолчанию main).
// H (см. run.js): click(sel) — настоящий щелчок (сначала проверяет, что элемент не перекрыт), until(fn, arg, ms),
//   ev(fn, arg), evFrame(urlRe, fn, arg) — то же во фрейме, text(sel), visible(sel), type(s), press(key), sleep(ms),
//   shot(name) (только с расширением), state() — состояние вкладки у расширения (без него null), load — статус
//   загрузки, ok(cond, note), note(s); селекторы «A >>> B» — B внутри открытого shadow root элемента A.
// Селекторы — по структуре и атрибутам, не по тексту: текст переводится.
"use strict";

// Щелчок → ждать условие → { ok, note }. cond — функция для страницы (dq/vis доступны), arg — её аргумент.
async function clickWait(H, sel, cond, arg, ms = 5000) {
  const c = await H.click(sel);
  if (!c.ok) return c;
  const v = await H.until(cond, arg, ms);
  return { ok: !!v, note: (c.note ? c.note + "; " : "") + (v ? (typeof v === "string" ? v : "") : "не сработало") };
}
// Открыть и закрыть (повторным щелчком) выпадающее меню; shot — снимок открытого меню (в фазе page).
async function toggleMenu(H, trigger, panel, shotName) {
  const a = await clickWait(H, trigger, (p) => vis(dq(p)), panel);
  if (!a.ok) return { ok: false, note: "не открылось" + (a.note ? ": " + a.note : "") };
  if (shotName && H.phase === "page") await H.shot(shotName);
  await H.sleep(300);
  const b = await clickWait(H, trigger, (p) => !vis(dq(p)), panel);
  return { ok: b.ok, note: b.ok ? a.note : "не закрылось повторным щелчком" };
}
// Ввести текст в поле поиска и дождаться подсказок; затем очистить поле.
async function typeSuggest(H, input, items, query) {
  const c = await H.click(input);
  if (!c.ok) return c;
  await H.sleep(300);
  await H.type(query);
  const n = await H.until((s) => dqa(s).filter(vis).length, items, 8000);
  const sample = n ? await H.ev((s) => dqa(s).filter(vis).slice(0, 3).map((e) => e.innerText.trim().split("\n")[0]).join(" | "), items) : "";
  await H.press("Control+A");
  await H.press("Backspace");
  await H.sleep(300);
  await H.ev(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true; });
  return { ok: !!n, note: n ? `${n} подсказок: ${sample.slice(0, 120)}` : "подсказок нет" };
}

// Кнопка с aria-expanded: щелчок открывает (aria-expanded=true и panel видна), повторный — закрывает.
async function toggleExpanded(H, trigger, panel, shotName) {
  const state = (a) => { const b = dqa(a[0]).find(vis); if (!b) return null; const e = b.getAttribute("aria-expanded"); const p = a[1] ? vis(dq(a[1])) : null;
    return a[2] ? e === "true" && p !== false : e === "false" && !p; };
  const a = await clickWait(H, trigger, state, [trigger, panel, true]);
  if (!a.ok) return { ok: false, note: "не открылось" + (a.note && a.note !== "не сработало" ? ": " + a.note : "") };
  if (shotName && H.phase === "page") await H.shot(shotName);
  await H.sleep(300);
  const b = await clickWait(H, trigger, state, [trigger, panel, false]);
  return { ok: b.ok, note: b.ok ? a.note : "не закрылось повторным щелчком" };
}
// Esc в поле ввода сайта: сайт закрывает подсказки/окно, а перевод страницы остаётся (content.js: typingFocus).
async function escInField(H) {
  const before = await H.state();
  const focus = await H.ev(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? a.tagName.toLowerCase() : null; });
  await H.press("Escape");
  await H.sleep(700);
  const after = await H.state();
  const lost = before && after && before.count > 0 && after.count < before.count;
  return { ok: !lost, note: lost ? `Esc в поле сайта (${focus}) вернул оригинал: ${before.page}/${before.count} → ${after.page}/${after.count}` : "" };
}
// Сайт закрыт для автоматического браузера: 403/429/503 или проверка Cloudflare. Обходить не пробуем (правила).
async function blockedPage(H) {
  const st = H.load && H.load.status;
  const ch = await H.ev(() => {
    const t = (document.title + " " + (document.body ? document.body.innerText.slice(0, 1500) : "")).replace(/\s+/g, " ");
    const cf = /__cf_chl|challenge-platform/.test(location.href + document.documentElement.innerHTML.slice(0, 20000)) || !!dq("#challenge-form, [name=cf-turnstile-response], iframe[src*='challenges.cloudflare.com']");
    return cf || /Just a moment|Verify you are human|blocked by network security|Access denied/i.test(t) ? (cf ? "проверка Cloudflare; " : "") + t.trim().slice(0, 90) : null;
  }).catch(() => null);
  if (st === 403 || st === 429 || st === 503 || ch) return `статус ${st}${ch ? ": " + ch : ""}`;
  return null;
}

// Щелчок по ссылке (find — функция для страницы, возвращает элемент <a>): адрес после перехода тот же, что в href.
// param — сравнивать и этот параметр адреса (YouTube: /watch?v=…; остальные параметры сайт меняет сам).
async function followLink(H, find, param) {
  // find вставляется в текст выражения (eval на сайтах со строгим CSP не работает).
  const href = await H.ev(`const a = (${find})(); if (!a) return null; a.setAttribute("data-ht-sites", "nav"); return a.href;`);
  if (!href) return { ok: false, note: "ссылка не найдена" };
  const label = await H.text("[data-ht-sites=nav]");
  const c = await H.click("[data-ht-sites=nav]");
  const want = new URL(href);
  const key = (u) => u.pathname + (param ? `?${param}=${u.searchParams.get(param)}` : "");
  await H.page.waitForURL((u) => key(u) === key(want), { timeout: 15000 }).catch(() => {});
  await H.sleep(1500);
  const got = new URL(H.page.url());
  return H.ok(key(got) === key(want), `«${(label || "").replace(/\s+/g, " ").slice(0, 40)}» → ${key(got)}${key(got) === key(want) ? "" : " (ждали " + key(want) + ")"}${c.note ? "; " + c.note : ""}`);
}

const SITES = [
  {
    id: "wikipedia",
    title: "Википедия (en): Vector 2022 — выпадашки на чекбоксах, радио с label, поиск на Vue/Codex, раскрытие оглавления",
    url: "https://en.wikipedia.org/wiki/Tomato",
    lang: "en",
    main: "#mw-content-text",
    key: "#mw-content-text p:not(.mw-empty-elt)",
    actions: [
      {
        name: "label «Large» переключает размер текста (и обратно «Standard»)",
        run: async (H) => {
          const a = await clickWait(H, 'label[for="skin-client-pref-vector-feature-custom-font-size-value-2"]',
            () => document.documentElement.classList.contains("vector-feature-custom-font-size-clientpref-2"));
          const b = await clickWait(H, 'label[for="skin-client-pref-vector-feature-custom-font-size-value-1"]',
            () => document.documentElement.classList.contains("vector-feature-custom-font-size-clientpref-1"));
          return H.ok(a.ok && b.ok, [a.note, b.note].filter(Boolean).join("; "));
        },
      },
      {
        name: "раздел оглавления раскрывается и сворачивается",
        run: async (H) => {
          const a = await clickWait(H, "#toc-History .vector-toc-toggle", () => dq("#toc-History .vector-toc-toggle").getAttribute("aria-expanded") === "true" && vis(dq("#toc-History-sublist")));
          const b = await clickWait(H, "#toc-History .vector-toc-toggle", () => dq("#toc-History .vector-toc-toggle").getAttribute("aria-expanded") === "false");
          return H.ok(a.ok && b.ok, a.ok ? b.note : "не раскрылся: " + a.note);
        },
      },
      {
        name: "меню «Инструменты» (⋮) открывается и закрывается",
        run: (H) => toggleMenu(H, "#vector-page-tools-dropdown-label", "#vector-page-tools-dropdown .vector-dropdown-content", "tools-menu"),
      },
      {
        // Само меню Википедия по Esc больше не закрывает (ноябрь 2026, и без расширения) — проверяем, что Esc ушёл сайту.
        name: "Esc при открытом меню «Инструменты»: Esc — сайту, перевод остаётся",
        phases: ["page"],
        run: (H) => H.escMenu("#vector-page-tools-dropdown-label", (p) => vis(dq(p)), "#vector-page-tools-dropdown .vector-dropdown-content", { siteKeepsOpen: true }),
      },
      {
        name: "навбокс show/hide раскрывается (сайт сам меняет надпись)",
        run: async (H) => {
          const sel = ".navbox .mw-collapsible-toggle";
          const a = await clickWait(H, sel, (s) => { const b = dq(s); return b.getAttribute("aria-expanded") === "true" ? b.innerText.trim() : null; }, sel);
          const b = await clickWait(H, sel, (s) => { const b = dq(s); return b.getAttribute("aria-expanded") === "false" ? b.innerText.trim() : null; }, sel);
          return H.ok(a.ok && b.ok, `надпись: «${a.note}» → «${b.note}»`);
        },
      },
      {
        name: "поиск: ввод «Potato» даёт подсказки (Vue)",
        run: (H) => typeSuggest(H, "#p-search input[type=search]", "#p-search .cdx-menu-item", "Potato"),
      },
    ],
    navName: "ссылка в переведённом абзаце ведёт куда вела",
    nav: (H) => followLink(H, () => dqa("#mw-content-text p:not(.mw-empty-elt) a[href*='/wiki/']")
      .find((a) => /^\/wiki\/[^:]+$/.test(new URL(a.href).pathname) && !/_English$/.test(a.href))),
  },
  {
    id: "github",
    title: "GitHub (React/Primer, Turbo): «Code», выбор ветки с полем фильтра, меню шапки, вкладка Issues",
    url: "https://github.com/expressjs/express",
    lang: "en",
    main: "article.markdown-body",
    key: () => dqa("article.markdown-body p").find((p) => vis(p) && p.innerText.trim().length > 40),
    actions: [
      {
        name: "«Code» открывает панель клонирования, повторный щелчок закрывает",
        run: (H) => toggleExpanded(H, "button[data-variant=primary][aria-haspopup=true]", "[class*=AnchoredOverlay]", "code-menu"),
      },
      {
        name: "Esc при открытой панели «Code»: панель закрывается, перевод остаётся",
        phases: ["page"],
        run: (H) => H.escMenu("button[data-variant=primary][aria-haspopup=true]", () => vis(dq("[class*=AnchoredOverlay]"))),
      },
      {
        name: "выбор ветки: панель с полем, ввод «4.» фильтрует, Esc в поле закрывает",
        run: async (H) => {
          // Кнопку ищем по значку ветки, а не по aria-label: перевод страницы переводит и aria-label.
          const a = await clickWait(H, "button[data-testid=anchor-button]:has(svg.octicon-git-branch)",
            () => { const f = document.activeElement; return f && f.tagName === "INPUT" && vis(dq("[class*=AnchoredOverlay]")); });
          if (!a.ok) return { ok: false, note: "панель не открылась (или фокус не в поле): " + a.note };
          await H.press("Control+A");   // панель помнит прошлый фильтр
          await H.press("Backspace");
          await H.type("4.");
          const items = await H.until(() => { const t = dqa("[class*=AnchoredOverlay] [role=option], [class*=AnchoredOverlay] li").filter(vis).map((e) => e.innerText.trim()).filter(Boolean);
            return t.some((x) => /^4\./.test(x)) ? t.slice(0, 3).join(" | ") : null; }, null, 6000);
          if (H.phase === "page") await H.shot("branch-filter");
          const esc = await escInField(H);
          const closed = await H.until(() => !vis(dq("[class*=AnchoredOverlay]")), null, 4000);
          return H.ok(items && closed && esc.ok, [items ? "список: " + items : "фильтр не сработал", closed ? "" : "Esc не закрыл панель", esc.note].filter(Boolean).join("; "));
        },
      },
      {
        name: "меню шапки «Products» открывается и закрывается",
        run: (H) => toggleExpanded(H, "header button[aria-expanded][aria-controls]", null, "header-menu"),
      },
    ],
    navName: "вкладка Issues (переход без перезагрузки)",
    nav: (H) => followLink(H, () => dq("nav a[href='/expressjs/express/issues']")),
    navMain: "main",
  },
  {
    id: "youtube",
    title: "YouTube (Polymer): описание «…more», сортировка комментариев, подгрузка комментариев, переход к видео",
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    lang: "en",
    main: "#below",
    prepareName: "согласие на cookie: «Reject all»",
    prepare: async (H) => {
      const sel = 'tp-yt-paper-dialog button[aria-label^="Reject"]';
      if (!(await H.until((s) => vis(dq(s)), sel, 8000))) return H.ok(true, "окна согласия нет");
      const c = await H.click(sel);
      const gone = await H.until(() => !dqa("tp-yt-paper-dialog").some(vis), null, 10000);
      await H.sleep(2500);
      return H.ok(c.ok && gone, gone ? "" : "окно не закрылось");
    },
    key: "#description-inline-expander",
    actions: [
      {
        name: "описание: «…more» раскрывает, «Show less» сворачивает",
        run: async (H) => {
          const a = await clickWait(H, "#description-inline-expander #expand", () => dq("#description-inline-expander").hasAttribute("is-expanded"));
          if (!a.ok) return { ok: false, note: "не раскрылось: " + a.note };
          if (H.phase === "page") await H.shot("description");
          const b = await clickWait(H, "#description-inline-expander #collapse", () => !dq("#description-inline-expander").hasAttribute("is-expanded"));
          return H.ok(b.ok, b.ok ? "" : "не свернулось: " + b.note);
        },
      },
      {
        name: "комментарии: сортировка «Newest» и обратно «Top»",
        run: async (H) => {
          await H.ev(() => { dq("#comments").scrollIntoView({ block: "start", behavior: "instant" }); return true; });
          await H.page.mouse.move(640, 400);
          await H.page.mouse.wheel(0, 200);
          // Сортировка ленты комментариев (вторая такая же — скрытая, в боковой панели).
          const menu = "ytd-comments-header-renderer yt-sort-filter-sub-menu-renderer";
          const trig = menu + " tp-yt-paper-button#label";
          const lb = menu + " tp-yt-paper-listbox";
          if (!(await H.until((s) => vis(dq(s)), trig, 15000))) return { ok: false, note: "комментарии не загрузились" };
          await H.sleep(2000);   // шапку комментариев YouTube перерисовывает сразу после появления
          const pick = async (n) => {
            const o = await clickWait(H, trig, (l) => dqa(l).some(vis), lb);
            if (!o.ok) return { ok: false, note: "меню не открылось" + (o.note && o.note !== "не сработало" ? ": " + o.note : "") };
            // Щелчок во время анимации открытия iron-dropdown меню не выбирает пункт (с паузой на снимок — выбирало).
            await H.sleep(700);
            if (n === 2 && H.phase === "page") await H.shot("comments-sort");
            const item = `${lb} a:nth-of-type(${n})`;
            // Пункт ищем среди всех копий меню (dq брал бы первую — может быть скрытой).
            const r = await clickWait(H, item, (p) => dqa(p[0]).some((e) => e.getAttribute("aria-selected") === "true") && !dqa(p[1]).some(vis), [item, lb], 8000);
            if (r.ok) return r;
            const diag = await H.ev((p) => `пунктов ${dqa(p[0]).length}, selected [${dqa(p[0]).map((e) => e.getAttribute("aria-selected") + (vis(e) ? "/вид" : "")).join(",")}], меню видно ${dqa(p[1]).filter(vis).length}`, [item, lb]);
            // Меню осталось открытым — закрыть повторным щелчком: открытый iron-dropdown держит прокрутку и щелчки.
            if (await H.ev((l) => dqa(l).some(vis), lb)) await H.click(trig);
            return { ok: false, note: `${r.note}; ${diag}` };
          };
          const a = await pick(2);
          await H.sleep(1500);
          const b = a.ok ? await pick(1) : { ok: false };
          return H.ok(a.ok && b.ok, a.ok ? (b.ok ? "" : "обратно «Top» — " + b.note) : "«Newest» — " + a.note);
        },
      },
    ],
    // Для страницы: сколько из видимых элементов sel (комментарий — его #content-text) по-русски (> 50 % букв —
    // кириллица); onlyNew — без помеченных data-ht-old (были до прокрутки).
    ytShare: (p) => {
      const els = dqa(p.sel).filter((e) => { if (!vis(e) || (p.onlyNew && e.hasAttribute("data-ht-old"))) return false;
        const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      const txt = els.map((e) => ((e.querySelector("#content-text") || e).innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      const ru = txt.filter((t) => { const l = (t.match(/\p{L}/gu) || []).length; return l && (t.match(/\p{Script=Cyrillic}/gu) || []).length / l > 0.5; });
      return { n: txt.length, ru: ru.length, en: txt.filter((t) => !ru.includes(t)).slice(0, 2).map((t) => t.slice(0, 50)) };
    },
    // Плавающая кнопка (кружок): класс, подпись, точка — из закрытого shadow root через CDP.
    ytHud: async (H) => {
      if (!H.ext) return "";
      const hud = (await require("../lib/live").pageUi(H.k.tab).catch(() => ({}))).hud;
      if (!hud) return "кружка нет";
      const b = hud.els.find((e) => /\bfab\b/.test(e.attrs.class || "") && e.tag === "BUTTON");
      const d = hud.els.find((e) => /\bfab-dot\b/.test(e.attrs.class || ""));
      return `кружок: ${b ? `class="${b.attrs.class}" «${b.attrs["aria-label"] || b.attrs.title || ""}»` : "?"}${d ? `, точка ${d.attrs.class}${d.hidden ? " (скрыта)" : ""}` : ""}`;
    },
    // Подгрузка комментариев после перевода страницы: переводятся ли новые сами (MutationObserver).
    scroll: async (H) => {
      const n0 = await H.ev(() => { const a = dqa("ytd-comment-thread-renderer"); a.forEach((e) => e.setAttribute("data-ht-old", "")); return a.length; });
      await H.page.mouse.move(640, 400);
      for (let i = 0; i < 6; i++) { await H.page.mouse.wheel(0, 1500); await H.sleep(1300); }
      const n1 = await H.ev(() => dqa("ytd-comment-thread-renderer").length);
      await H.sleep(6000);
      const s = await H.ev(H.site.ytShare, { sel: "ytd-comment-thread-renderer", onlyNew: true });
      if (H.phase === "page") await H.shot("comments-new");
      const st = await H.state();
      return H.ok(n1 > n0, `комментариев ${n0} → ${n1}; новых на экране через 6 с: ${s.n}, по-русски ${s.ru}${s.en.length ? " (не по-русски: «" + s.en.join("», «") + "»)" : ""}${st ? `; вкладка ${st.page}/${st.count}` : ""}; ${await H.site.ytHud(H)}`);
    },
    navName: "похожее видео (переход без перезагрузки)",
    nav: async (H) => {
      const r = await followLink(H, () => dqa("yt-lockup-view-model a[href^='/watch'], ytd-compact-video-renderer a#thumbnail").find((a) => vis(a) && !/jNQXAC9IVRw/.test(a.href)), "v");
      // Боковую ленту YouTube перерисовывает между пометкой и щелчком: другое видео — тоже переход SPA.
      const v = new URL(H.page.url()).searchParams.get("v");
      if (!r.ok && !(v && v !== "jNQXAC9IVRw" && /\/watch$/.test(new URL(H.page.url()).pathname))) return r;
      if (!r.ok) r.note = "другое видео: " + r.note;
      await H.sleep(6000);
      const top = await H.ev(H.site.ytShare, { sel: "ytd-watch-metadata h1, #description-inline-expander" });
      const st1 = await H.state();
      const hud1 = await H.site.ytHud(H);
      await H.shot("nav-top");
      await H.ev(() => { dq("#comments").scrollIntoView({ block: "start", behavior: "instant" }); return true; });
      await H.page.mouse.move(640, 400);
      for (let i = 0; i < 3; i++) { await H.page.mouse.wheel(0, 800); await H.sleep(1500); }
      await H.sleep(6000);
      const com = await H.ev(H.site.ytShare, { sel: "ytd-comment-thread-renderer" });
      const st2 = await H.state();
      return H.ok(true, `${r.note}; через 6 с — заголовок/описание: ${top.ru}/${top.n} по-русски${top.en.length ? " («" + top.en.join("», «") + "»)" : ""}${st1 ? `, вкладка ${st1.page}/${st1.count}` : ""}, ${hud1}; комментарии на экране: ${com.ru}/${com.n} по-русски${st2 ? `, вкладка ${st2.page}/${st2.count}` : ""}, ${await H.site.ytHud(H)}`);
    },
    navMain: "#below",
  },
  {
    id: "mdn",
    title: "MDN (Lit, открытый shadow DOM): <details> боковой панели, мега-меню, меню темы и поиск в shadow DOM",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details",
    lang: "en",
    main: ".reference-layout__body",
    key: ".reference-layout__header .content-section p",
    actions: [
      {
        name: "<details> в боковой панели раскрывается и сворачивается",
        run: async (H) => {
          const m = await H.ev(() => { const d = dqa("li > details:not([open]) > summary").find(vis); if (!d) return false; dqa("[data-ht-sites=det]").forEach((e) => e.removeAttribute("data-ht-sites")); d.setAttribute("data-ht-sites", "det"); return true; });
          if (!m) return { ok: false, note: "нет закрытого <details>" };
          const a = await clickWait(H, "[data-ht-sites=det]", () => dq("[data-ht-sites=det]").parentElement.open);
          const b = await clickWait(H, "[data-ht-sites=det]", () => !dq("[data-ht-sites=det]").parentElement.open);
          return H.ok(a.ok && b.ok, a.ok ? (b.ok ? "" : "не свернулся") : "не раскрылся: " + a.note);
        },
      },
      {
        name: "мега-меню «HTML» открывается и закрывается",
        run: (H) => toggleExpanded(H, "button.menu__tab-button", null, "mega-menu"),
      },
      {
        name: "Esc при открытом мега-меню «HTML»: меню закрывается, перевод остаётся",
        phases: ["page"],
        run: (H) => H.escMenu("button.menu__tab-button", (s) => { const b = dqa(s).find(vis); return !!b && b.getAttribute("aria-expanded") === "true"; }, "button.menu__tab-button"),
      },
      {
        name: "меню темы (shadow DOM) открывается и закрывается",
        run: (H) => toggleExpanded(H, "mdn-color-theme >>> button.color-theme__button", "mdn-color-theme >>> ul.color-theme__list", "theme-menu"),
      },
      {
        name: "поиск (shadow DOM): «summary» даёт подсказки, Esc в поле очищает, второй Esc закрывает",
        run: async (H) => {
          const o = await clickWait(H, "mdn-search-button >>> button", () => { const d = dq("mdn-search-modal >>> dialog"); return !!(d && d.open); });
          if (!o.ok) return { ok: false, note: "окно поиска не открылось" + (o.note ? ": " + o.note : "") };
          await H.sleep(300);
          await H.type("summary");
          const n = await H.until(() => dqa("mdn-search-modal >>> a").filter(vis).length || null, null, 8000);
          if (H.phase === "page") await H.shot("search");
          const e1 = await escInField(H);
          const e2 = await escInField(H);
          const closed = await H.until(() => { const d = dq("mdn-search-modal >>> dialog"); return !d || !d.open; }, null, 4000);
          return H.ok(n && e1.ok && e2.ok && closed, [n ? n + " подсказок" : "подсказок нет", closed ? "" : "окно не закрылось", e1.note, e2.note].filter(Boolean).join("; "));
        },
      },
    ],
    navName: "ссылка в переведённом абзаце",
    nav: (H) => followLink(H, () => dqa(".reference-layout__header .content-section p a[href^='/en-US/docs/']").find(vis)),
    navMain: ".reference-layout__body",
  },
  {
    id: "docusaurus",
    title: "Docusaurus (React, SPA): вкладки npm/Yarn, свёртка категории, DocSearch, переход «Next»",
    url: "https://docusaurus.io/docs/installation",
    lang: "en",
    main: "article .markdown",
    key: () => dqa("article .markdown p").find((p) => vis(p) && p.innerText.trim().length > 30),
    actions: [
      {
        name: "вкладки: вторая («Yarn») и обратно первая",
        run: async (H) => {
          const m = await H.ev(() => { const t = dqa("article [role=tablist]").find(vis); if (!t) return false; t.setAttribute("data-ht-sites", "tabs"); return true; });
          if (!m) return { ok: false, note: "нет вкладок" };
          const tab = (n) => `[data-ht-sites=tabs] [role=tab]:nth-child(${n})`;
          const a = await clickWait(H, tab(2), (s) => dq(s).getAttribute("aria-selected") === "true", tab(2));
          if (H.phase === "page") await H.shot("tabs");
          const b = await clickWait(H, tab(1), (s) => dq(s).getAttribute("aria-selected") === "true", tab(1));
          return H.ok(a.ok && b.ok, a.ok ? (b.ok ? "" : "обратно не переключилось") : "не переключилось: " + a.note);
        },
      },
      {
        name: "категория боковой панели сворачивается и раскрывается",
        run: async (H) => {
          const sel = "button.menu__caret[aria-expanded=true]";
          const m = await H.ev((s) => { const b = dqa(s).find(vis); if (!b) return false; b.setAttribute("data-ht-sites", "caret"); return true; }, sel);
          if (!m) return { ok: false, note: "нет раскрытой категории" };
          const a = await clickWait(H, "[data-ht-sites=caret]", () => dq("[data-ht-sites=caret]").getAttribute("aria-expanded") === "false");
          const b = await clickWait(H, "[data-ht-sites=caret]", () => dq("[data-ht-sites=caret]").getAttribute("aria-expanded") === "true");
          return H.ok(a.ok && b.ok, a.ok ? (b.ok ? "" : "не раскрылась обратно") : "не свернулась: " + a.note);
        },
      },
      {
        name: "DocSearch: «plugin» даёт подсказки, Esc в поле закрывает окно",
        run: async (H) => {
          const o = await clickWait(H, ".DocSearch-Button", () => vis(dq(".DocSearch-Modal")) && document.activeElement && document.activeElement.tagName === "INPUT");
          if (!o.ok) return { ok: false, note: "окно поиска не открылось" + (o.note ? ": " + o.note : "") };
          await H.type("plugin");
          const n = await H.until(() => dqa(".DocSearch-Hit").filter(vis).length || null, null, 8000);
          if (H.phase === "page") await H.shot("search");
          const e = await escInField(H);
          const closed = await H.until(() => !vis(dq(".DocSearch-Modal")), null, 4000);
          return H.ok(n && e.ok && closed, [n ? n + " подсказок" : "подсказок нет", closed ? "" : "окно не закрылось", e.note].filter(Boolean).join("; "));
        },
      },
    ],
    navName: "«Next» внизу статьи (переход без перезагрузки)",
    nav: (H) => followLink(H, () => dq(".pagination-nav__link--next")),
    navMain: "article .markdown",
  },
  {
    id: "habr",
    title: "Хабр (Vue, ru → en): «Настройки ленты» (радио в label), «Поделиться» (окно), меню-бургер",
    url: "https://habr.com/ru/feed/",
    lang: "ru",
    // "EN" — только язык оригинала (HT_SOURCE_ONLY в shared.js): как цель настройки его отвергают, остаётся RU.
    target: "EN-US",
    main: ".tm-articles-list",
    // Окно согласия Google (Funding Choices) закрывает страницу целиком: без него ни один щелчок не доходит до сайта.
    // Отказаться с первого экрана нельзя (только «Manage options»), поэтому — «Consent».
    prepareName: "согласие на cookie (Funding Choices): «Consent»",
    prepare: async (H) => {
      const sel = ".fc-consent-root button.fc-cta-consent";
      if (!(await H.until((s) => vis(dq(s)), sel, 8000))) return H.ok(true, "окна согласия нет");
      const c = await H.click(sel);
      const gone = await H.until(() => !dqa(".fc-consent-root .fc-dialog-overlay, .fc-consent-root .fc-dialog").some(vis), null, 8000);
      await H.sleep(1000);
      return H.ok(c.ok && gone, gone ? "" : "окно согласия не закрылось");
    },
    key: "article .article-formatted-body",
    actions: [
      {
        name: "«Настройки ленты»: радио через label выбирается и обратно; повторный щелчок сворачивает",
        run: async (H) => {
          const sp = "button.tm-navigation-filters-spoiler__button";
          const form = "form.my-feed-filter__form";
          // Свёрнутая форма остаётся в DOM с размером (обрезана родителем): видна — если в её точке она сама.
          const shown = (f) => { const e = dq(f); if (!vis(e)) return false; const r = e.getBoundingClientRect();
            const x = r.left + Math.min(40, r.width / 2), y = r.top + Math.min(20, r.height / 2); return y >= 0 && y < innerHeight && within(deepHit(x, y), e); };
          const a = await clickWait(H, sp, shown, form);
          if (!a.ok) return { ok: false, note: "форма не открылась" + (a.note && a.note !== "не сработало" ? ": " + a.note : "") };
          const lab = (v) => `${form} label:has(input[type=radio][name=score][value="${v}"])`;
          const checked = (v) => dq(`input[type=radio][name=score][value="${v}"]`).checked;
          const r1 = await clickWait(H, lab("10"), checked, "10");
          if (H.phase === "page") await H.shot("feed-settings");
          const r2 = await clickWait(H, lab("all"), checked, "all");
          const c = await clickWait(H, sp, (f) => { const e = dq(f); if (!vis(e)) return true; const r = e.getBoundingClientRect();
            const x = r.left + Math.min(40, r.width / 2), y = r.top + Math.min(20, r.height / 2); return !(y >= 0 && y < innerHeight && within(deepHit(x, y), e)); }, form);
          return H.ok(r1.ok && r2.ok && c.ok, [r1.ok ? "" : "«≥10» не выбралось", r2.ok ? "" : "«Все» не выбралось", c.ok ? "" : "форма не свернулась"].filter(Boolean).join("; "));
        },
      },
      {
        name: "«Поделиться»: окно открывается, «Закрыть» закрывает",
        run: async (H) => {
          const win = ".tm-overlay .modal-window";
          const a = await clickWait(H, "article button.sharing-button", (w) => vis(dq(w)), win);
          if (!a.ok) return { ok: false, note: "окно не открылось" + (a.note ? ": " + a.note : "") };
          if (H.phase === "page") await H.shot("share");
          const b = await clickWait(H, win + " button.btn_transparent", (w) => !vis(dq(w)), win);
          return H.ok(b.ok, b.ok ? "" : "не закрылось: " + b.note);
        },
      },
      {
        name: "меню (бургер) открывается и закрывается",
        run: async (H) => {
          const a = await clickWait(H, "button.burger-button", () => dq("button.burger-button").classList.contains("opened"));
          if (!a.ok) return { ok: false, note: "не открылось" + (a.note ? ": " + a.note : "") };
          if (H.phase === "page") await H.shot("burger");
          const b = await clickWait(H, "button.burger-button", () => !dq("button.burger-button").classList.contains("opened"));
          return H.ok(b.ok, b.ok ? "" : "не закрылось: " + b.note);
        },
      },
    ],
    navName: "заголовок статьи в ленте",
    nav: (H) => followLink(H, () => dqa("article h2 a").find(vis)),
    navMain: ".tm-article-body",
  },
  {
    id: "allbirds",
    title: "Магазин Allbirds (Shopify): переведённые баннер cookie и окно страны, фильтр с label, FAQ",
    url: "https://www.allbirds.com/collections/mens",
    lang: "en",
    main: "main",
    // Баннер cookie (переводим клавишей и жмём «Accept» в переведённом); без баннера — абзац страницы.
    key: () => {
      const b = document.querySelector("#shopify-pc__banner");
      if (b && vis(b)) { const e = [...b.querySelectorAll("p, div, span")].find((x) => vis(x) && !x.querySelector("p, div") && x.textContent.trim().length > 80); if (e) return e; }
      return dqa("main p").find((p) => vis(p) && p.innerText.trim().length > 40);
    },
    actions: [
      {
        name: "окно «Where are we shipping to?»: ✕ закрывает",
        phases: ["key"],
        run: async (H) => {
          const x = '[id$="__geofencing"] button.absolute';
          if (!(await H.visible(x))) return H.ok(true, "окна нет");
          return clickWait(H, x, () => !vis(dq('[id$="__geofencing"] h3')));
        },
      },
      {
        // Окно страны уже закрыто; баннер cookie виден (section role=alertdialog aria-modal=false, Esc сайт не ловит).
        name: "Esc при видимом баннере cookie: перевод клавишей откатывается",
        phases: ["key"],
        run: async (H) => {
          if (!H.ext) return H.ok(true, "без расширения — нечего откатывать");
          if (!(await H.visible("#shopify-pc__banner"))) return H.ok(true, "баннера нет");
          const s0 = await H.state();
          await H.page.mouse.move(5, 5);
          await H.press("Escape");
          await H.sleep(1000);
          const s1 = await H.state();
          const back = s0 && s1 && s1.count < s0.count;
          const still = await H.visible("#shopify-pc__banner");
          return H.ok(back, `баннер ${still ? "виден" : "закрыт"}; перевод ${s0.page}/${s0.count} → ${s1.page}/${s1.count}` + (back ? "" : " — Esc НЕ откатил (баннер считается открытым окном сайта)"));
        },
      },
      {
        name: "cookie: «Accept» в переведённом баннере",
        phases: ["key"],
        run: async (H) => {
          if (!(await H.visible("#shopify-pc__banner__btn-accept"))) return H.ok(true, "баннера нет");
          return clickWait(H, "#shopify-pc__banner__btn-accept", () => !vis(dq("#shopify-pc__banner")));
        },
      },
      {
        name: "фильтры: панель, label «до $75» фильтрует (без перезагрузки), снять, свернуть",
        run: async (H) => {
          // Кнопка панели — со счётчиком «(36 products)»; после выбора рядом появляется ещё кнопка-«пилюля» фильтра.
          const tg = "button.flex.flex-shrink-0:has(span.text-gray-600)";
          const lab = 'label[for="Filter-filter.v.price-range-1"]';
          const cb = '[id="Filter-filter.v.price-range-1"]';
          const count = () => H.ev((s) => { const m = (dq(s) || {}).innerText; const d = m && m.match(/\((\d+)/); return d ? +d[1] : null; }, tg);
          // Полоса фильтров прячется при прокрутке (после FAQ внизу страницы) — начинаем сверху.
          await H.ev(() => { window.__htNoReload = 1; scrollTo(0, 0); return true; });
          await H.sleep(800);
          const n0 = await count();
          const a = await clickWait(H, tg, (s) => vis(dq(s)), lab);
          if (!a.ok) return { ok: false, note: "панель не открылась" + (a.note ? ": " + a.note : "") };
          const b = await clickWait(H, lab, (s) => dq(s).checked, cb, 6000);
          const n1 = await H.until((n) => { const m = (dq("button.flex.flex-shrink-0:has(span.text-gray-600)") || {}).innerText; const d = m && m.match(/\((\d+)/); return d && +d[1] !== n ? +d[1] : null; }, n0, 8000);
          if (H.phase === "page") await H.shot("filter");
          const c = await clickWait(H, lab, (s) => !dq(s).checked, cb, 6000);
          const n2 = await H.until((n) => { const m = (dq("button.flex.flex-shrink-0:has(span.text-gray-600)") || {}).innerText; const d = m && m.match(/\((\d+)/); return d && +d[1] === n ? n : null; }, n0, 8000);
          await H.sleep(500);
          const d = await clickWait(H, tg, (s) => !vis(dq(s)), lab);
          const same = await H.ev(() => window.__htNoReload === 1);
          return H.ok(b.ok && n1 && c.ok && n2 && d.ok && same, `товаров ${n0} → ${n1 || "?"} → ${n2 || "?"}` +
            [b.ok ? "" : "галочка не встала", c.ok ? "" : "галочка не снялась", d.ok ? "" : "панель не свернулась", same ? "" : "страница перезагрузилась"].filter(Boolean).map((x) => "; " + x).join(""));
        },
      },
      {
        name: "сортировка select#SortBy (стрелкой, список закрыт, фокус на нём): Shift над текстом переводит, второй Shift возвращает",
        phases: ["key"],
        run: async (H) => {
          // content.js typingFocus: закрытый <select> в фокусе не глушит клавишу-триггер (раньше глушил).
          const L = require("./lib");
          const sel = "select#SortBy";
          if (!(await H.ev((s) => { const e = dqa(s).find(vis); if (!e) return false; e.setAttribute("data-ht-sites", "sort"); return true; }, sel))) return { ok: false, note: "нет видимого select#SortBy" };
          const s0 = await H.ev(() => { const e = dq("[data-ht-sites=sort]"); return { v: e.value, i: e.selectedIndex, n: e.options.length, href: location.href }; });
          // Как человек с клавиатуры: фокус на списке и стрелка вниз — на Linux/Windows закрытый список меняет пункт сразу.
          await H.ev(() => { window.__htNoReloadSort = 1; dq("[data-ht-sites=sort]").focus(); return true; });
          await H.press("ArrowDown");
          const changed = await H.until((v) => { const e = dq("[data-ht-sites=sort]"); return e && e.value !== v ? e.value : null; }, s0.v, 4000);
          await H.sleep(2500);
          const after = await H.ev(() => { const e = dq("[data-ht-sites=sort]"); let a = document.activeElement; return { same: window.__htNoReloadSort === 1, v: e && e.value, focus: a ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") : null, open: (() => { try { return e.matches(":open"); } catch (x) { return null; } })(), href: location.href }; });
          const notes = [`${s0.v} → ${changed || "не сменилась"}`, after.same ? "без перезагрузки" : "страница перезагрузилась", `фокус: ${after.focus}`, `:open ${after.open}`];
          if (!changed) return { ok: false, note: notes.join("; ") };
          // Allbirds после смены сортировки перерисовывает сетку вместе со списком — фокус уходит на body. Проверяем
          // сам случай «закрытый select в фокусе»: ставим фокус на новый список (без жеста, как Tab).
          if (!/^select/.test(after.focus || "")) {
            const re = await H.ev(() => { const e = dqa("select#SortBy").find(vis); if (!e) return false; e.setAttribute("data-ht-sites", "sort"); e.focus(); return document.activeElement === e; });
            notes.push(re ? "сайт перерисовал список — фокус на новый select" : "новый select не найден");
          }
          // Текст для Shift: абзац или название товара, не элемент key.
          const t = await H.ev(() => { const e = dqa("main p, main h1, main h2, main h3").find((x) => vis(x) && !x.closest("[data-ht-sites~=key]") && !x.closest("button, a, label") && x.innerText.trim().length > 12 && x.innerText.trim().split(/\s+/).length >= 3);
            if (!e) return null; e.setAttribute("data-ht-sites", "sort-t"); return desc(e) + " «" + e.innerText.trim().slice(0, 60) + "»"; });
          if (!t) return { ok: false, note: notes.concat("нет текста для Shift").join("; ") };
          let tr = null, back = null;
          if (H.ext) {
            const before = await H.text("[data-ht-sites~=sort-t]");
            const pt = await L.textPoint(H.k, "[data-ht-sites~=sort-t]");
            if (!pt) return { ok: false, note: notes.concat("нет точки над текстом " + t).join("; ") };
            const focus = await H.ev(() => { const a = document.activeElement; let o = null; try { o = a.matches(":open"); } catch (x) { /* старый Chrome */ } return a && a.tagName === "SELECT" ? "select" + (o ? " (раскрыт)" : " (закрыт)") : (a ? a.tagName.toLowerCase() : null); });
            notes.push("Shift при фокусе: " + focus);
            await L.shiftAt(H.page, pt);
            tr = await H.until((b) => { const e = dq("[data-ht-sites~=sort-t]"); const x = e && e.innerText.trim(); return x && x !== b ? x : null; }, before, 20000, 400);
            notes.push(tr ? `Shift → «${tr.slice(0, 50)}»` : "Shift НЕ перевёл " + t);
            if (tr) {
              await H.sleep(800);
              await L.shiftAt(H.page, pt);
              back = await H.until((b) => { const e = dq("[data-ht-sites~=sort-t]"); return e && e.innerText.trim() === b; }, before, 8000);
              if (!back) notes.push("второй Shift не вернул оригинал");
            }
          }
          // Вернуть сортировку стрелкой вверх (если страница не перезагрузилась — фокус там же).
          await H.ev(() => { const e = dq("select#SortBy"); if (e) e.focus(); return true; });
          await H.press("ArrowUp");
          const restored = await H.until((v) => { const e = dq("select#SortBy"); return e && e.value === v; }, s0.v, 4000);
          await H.sleep(2000);
          await H.ev(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true; });
          if (!restored) notes.push("сортировка не вернулась");
          return { ok: !!changed && (!H.ext || (!!tr && !!back)), note: notes.join("; ") };
        },
      },
      {
        name: "FAQ: вопрос раскрывается и сворачивается",
        run: async (H) => {
          // Аккордеон без aria-expanded: ответ — следующий за кнопкой блок.
          const m = await H.ev(() => { const b = dqa("button.group.flex").find((x) => vis(x) && x.nextElementSibling); if (!b) return false; b.setAttribute("data-ht-sites", "faq"); return true; });
          if (!m) return { ok: false, note: "нет вопроса FAQ" };
          const open = () => vis(dq("[data-ht-sites=faq]").nextElementSibling);
          const was = await H.ev(open);
          const a = await clickWait(H, "[data-ht-sites=faq]", (w) => vis(dq("[data-ht-sites=faq]").nextElementSibling) !== w, was);
          // Переведённая страница: ответ был скрыт при переводе — переведётся ли он, когда его раскрыли.
          let tn = "";
          if (a.ok && H.ext && H.phase === "page") {
            const t0 = Date.now();
            const tr = await H.until(() => { const n = dq("[data-ht-sites=faq]").nextElementSibling; const t = (n && n.innerText) || ""; return /\p{Script=Cyrillic}/u.test(t) ? t.trim().slice(0, 40) : null; }, null, 8000, 250);
            tn = tr ? `раскрытый ответ переведён через ~${Date.now() - t0} мс: «${tr}»` : "раскрытый ответ НЕ переведён за 8 с";
          }
          if (a.ok && H.phase === "page") await H.shot("faq");
          const b = await clickWait(H, "[data-ht-sites=faq]", (w) => vis(dq("[data-ht-sites=faq]").nextElementSibling) === w, was);
          return H.ok(a.ok && b.ok, [a.ok ? (b.ok ? "" : "не вернулся") : "не раскрылся", tn].filter(Boolean).join("; "));
        },
      },
      {
        name: "Esc при открытой панели фильтров: перевод страницы остаётся (Esc — сайту)",
        phases: ["page"],
        run: async (H) => {
          const tg = "button.flex.flex-shrink-0:has(span.text-gray-600)";
          const lab = 'label[for="Filter-filter.v.price-range-1"]';
          await H.ev(() => { scrollTo(0, 0); return true; });
          await H.sleep(800);
          const a = await clickWait(H, tg, (s) => vis(dq(s)), lab);
          if (!a.ok) return { ok: false, note: "панель не открылась" };
          const s0 = await H.state();
          await H.press("Escape");
          await H.sleep(1000);
          const s1 = await H.state();
          const closed = await H.ev((s) => !vis(dq(s)), lab);
          if (!closed) await clickWait(H, tg, (s) => !vis(dq(s)), lab);
          const lost = s0 && s1 && s1.count < s0.count;
          return H.ok(!lost, `сайт по Esc ${closed ? "закрыл" : "не закрыл"} панель` + (s0 ? `; перевод ${s0.page}/${s0.count} → ${s1.page}/${s1.count}` : "") + (lost ? " — Esc ВЕРНУЛ ОРИГИНАЛ при открытой панели" : ""));
        },
      },
    ],
    navName: "карточка товара",
    nav: (H) => followLink(H, () => dqa("main a[href*='/products/']").find((a) => vis(a) && a.innerText.trim().length > 3)),
    navMain: "main",
  },
  {
    id: "guardian",
    title: "The Guardian (React): согласие Sourcepoint в iframe, «Edition», меню (label + checkbox), переход к статье",
    url: "https://www.theguardian.com/international",
    lang: "en",
    main: "main",
    prepareName: "согласие Sourcepoint в iframe: «Accept all»",
    prepare: async (H) => {
      const re = /sourcepoint|sp_message|privacy-mgmt/;
      let b = null;
      for (let i = 0; i < 12 && !b; i++) {
        b = await H.evFrame(re, () => { const x = dqa("button").find((e) => vis(e) && /accept/i.test(e.title + " " + e.innerText)); if (!x) return null; const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).catch(() => null);
        if (!b) await H.sleep(700);
      }
      if (!b) return H.ok(true, "окна согласия нет");
      const f = await H.ev(() => { const e = dqa("iframe[id^=sp_message_iframe]").find(vis); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
      if (!f) return { ok: false, note: "iframe согласия не виден" };
      await H.page.mouse.click(Math.round(f.x + b.x), Math.round(f.y + b.y));
      const gone = await H.until(() => !dqa("iframe[id^=sp_message_iframe]").some(vis), null, 8000);
      await H.sleep(1500);
      return H.ok(gone, gone ? "" : "окно согласия не закрылось");
    },
    key: () => dqa("main h3.card-headline").find(vis),
    actions: [
      {
        name: "«Edition» открывает список изданий и закрывает",
        run: (H) => toggleExpanded(H, 'button[data-link-name*="edition-picker"]', null, "edition"),
      },
      {
        name: "меню (label + checkbox) открывается и закрывается",
        run: async (H) => {
          const lab = "label#header-veggie-burger";
          // Ссылки, видимые до открытия, — помечаем: новые видимые после щелчка — пункты меню.
          await H.ev(() => { dqa("a").filter(vis).forEach((x) => x.setAttribute("data-ht-sites-pre", "1")); return true; });
          const a = await clickWait(H, lab, () => dq("#header-nav-input-checkbox").checked);
          if (!a.ok) return { ok: false, note: "не открылось" + (a.note ? ": " + a.note : "") };
          // Переведённая страница: меню было скрыто (display) при переводе — переведётся ли, когда его открыли.
          let tn = "";
          if (H.ext && H.phase === "page") {
            const t0 = Date.now();
            const share = () => { const l = dqa("a:not([data-ht-sites-pre])").filter(vis); const t = l.map((x) => x.innerText).join(" "); const c = (t.match(/\p{Script=Cyrillic}/gu) || []).length, all = (t.match(/\p{L}/gu) || []).length; return { n: l.length, p: all ? Math.round(100 * c / all) : 0 }; };
            // Текст функции вставляется в выражение (без eval: у сайта CSP).
            const tr = await H.until(`const r = (${share})(); return r.p >= 50 ? r : null;`, null, 8000, 250);
            const last = tr || await H.ev(`return (${share})();`);
            tn = tr ? `пункты меню переведены через ~${Date.now() - t0} мс (${tr.n} ссылок, кириллица ${tr.p} %)` : `пункты меню НЕ переведены за 8 с (${last.n} ссылок, кириллица ${last.p} %)`;
          }
          if (H.phase === "page") await H.shot("menu");
          await H.sleep(400);
          const b = await clickWait(H, lab, () => !dq("#header-nav-input-checkbox").checked);
          return H.ok(b.ok, [b.ok ? a.note : "не закрылось: " + b.note, tn].filter(Boolean).join("; "));
        },
      },
      {
        name: "Esc при открытом «Edition»: перевод страницы остаётся (Esc — сайту)",
        phases: ["page"],
        run: async (H) => {
          const tg = 'button[data-link-name*="edition-picker"]';
          const isOpen = (t) => { const b = dqa(t).find(vis); return b ? b.getAttribute("aria-expanded") === "true" : null; };
          const a = await clickWait(H, tg, isOpen, tg);
          if (!a.ok) return { ok: false, note: "не открылось" };
          const s0 = await H.state();
          await H.press("Escape");
          await H.sleep(1000);
          const s1 = await H.state();
          const closed = !(await H.ev(isOpen, tg));
          if (!closed) await clickWait(H, tg, (t) => { const b = dqa(t).find(vis); return b && b.getAttribute("aria-expanded") === "false"; }, tg);
          const lost = s0 && s1 && s1.count < s0.count;
          return H.ok(!lost, `сайт по Esc ${closed ? "закрыл" : "не закрыл"} список` + (s0 ? `; перевод ${s0.page}/${s0.count} → ${s1.page}/${s1.count}` : "") + (lost ? " — Esc ВЕРНУЛ ОРИГИНАЛ при открытом списке" : ""));
        },
      },
    ],
    navName: "статья с главной",
    nav: (H) => followLink(H, () => dqa("main a[href]").find((a) => vis(a) && /\/20\d\d\/[a-z]{3}\/\d\d\/[^/]+$/.test(a.pathname))),
    navMain: "main",
  },
  {
    id: "reddit",
    title: "Reddit (веб-компоненты) — закрыт для автоматического браузера (403)",
    url: "https://www.reddit.com/r/AskReddit/",
    lang: "en",
    main: "main",
    key: "main p",
    blocked: blockedPage,
  },
  {
    id: "stackoverflow",
    title: "Stack Overflow — проверка Cloudflare для автоматического браузера",
    url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
    lang: "en",
    main: "#mainbar",
    key: ".s-prose p",
    blocked: blockedPage,
  },
];

module.exports = SITES;
