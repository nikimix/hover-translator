// ui.js — общие детали интерфейса страниц расширения (окно, настройки, приветствие): построение элементов,
// иконки (lucide, обводка 2), значок расширения. Подключается после shared.js. Разметку из строк не разбираем
// (innerHTML не используем): элементы строятся через DOM, тексты — только textContent.

var HT_ui = (function () {
  const SVG = "http://www.w3.org/2000/svg";

  // Контуры иконок: строки — атрибут d у <path>, объекты — другие фигуры.
  const ICONS = {
    languages: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
    chevDown: ["m6 9 6 6 6-6"],
    chevRight: ["m9 18 6-6-6-6"],
    // не lucide, в его стиле: страница (рамка как у lucide square) и плавающая кнопка — залитый кружок в правом
    // нижнем углу, где кружок стоит по умолчанию
    fabPage: [{ rect: { width: 18, height: 18, x: 3, y: 3, rx: 2 } }, { circle: { cx: 15.5, cy: 15.5, r: 2.5, fill: "currentColor" } }],
    gear: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", { circle: { cx: 12, cy: 12, r: 3 } }],
    download: ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5"],
    refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
    shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
    key: ["m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4", "m21 2-9.6 9.6", { circle: { cx: 7.5, cy: 15.5, r: 5.5 } }],
    warn: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
    alert: [{ circle: { cx: 12, cy: 12, r: 10 } }, "M12 8v4", "M12 16h.01"],
    info: [{ circle: { cx: 12, cy: 12, r: 10 } }, "M12 16v-4", "M12 8h.01"],
    wifiOff: ["M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523", "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20"],
    gauge: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
    check: ["M20 6 9 17l-5-5"],
    checkCircle: [{ circle: { cx: 12, cy: 12, r: 10 } }, "m9 12 2 2 4-4"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    eye: ["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", { circle: { cx: 12, cy: 12, r: 3 } }],
    eyeOff: ["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242", "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "m2 2 20 20"],
    globe: [{ circle: { cx: 12, cy: 12, r: 10 } }, "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
    puzzle: ["M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"],
    pin: ["M12 17v5", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"],
    keyboard: ["M10 8h.01", "M12 12h.01", "M14 8h.01", "M16 12h.01", "M18 8h.01", "M6 8h.01", "M7 16h10", "M8 12h.01", { rect: { width: 20, height: 16, x: 2, y: 4, rx: 2 } }],
    database: [{ ellipse: { cx: 12, cy: 5, rx: 9, ry: 3 } }, "M3 5V19A9 3 0 0 0 21 19V5", "M3 12A9 3 0 0 0 21 12"],
    pointer: ["M12.586 12.586 19 19", "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"],
    ban: [{ circle: { cx: 12, cy: 12, r: 10 } }, "m4.9 4.9 14.2 14.2"],
    trash: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"],
    external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    plus: ["M5 12h14", "M12 5v14"],
    spin: ["M21 12a9 9 0 1 1-6.22-8.56"],
  };

  // h("div", { class: "x", onclick: fn, hidden: true }, "текст", элемент, [массив детей], null)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k in el && typeof v !== "string") el[k] = v;      // value, checked, disabled — свойствами
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else el.append(k.nodeType ? k : String(k));
    }
  }

  function svg(attrs) {
    const el = document.createElementNS(SVG, "svg");
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  function shape(name, attrs) {
    const el = document.createElementNS(SVG, name);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }

  // Иконка 24×24 цветом текста.
  function ic(name, size, cls) {
    const s = size || 18;
    const el = svg({ width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": name === "spin" ? 2.5 : 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    if (cls || name === "spin") el.setAttribute("class", cls || "spin");
    for (const p of ICONS[name] || []) {
      if (typeof p === "string") el.appendChild(shape("path", { d: p }));
      else for (const tag in p) el.appendChild(shape(tag, p[tag]));
    }
    return el;
  }
  // Квадрат «Стоп» залитый, 12 px.
  function stopIc() {
    const el = svg({ width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" });
    el.appendChild(shape("rect", { x: 1, y: 1, width: 10, height: 10, rx: 2, fill: "currentColor" }));
    return el;
  }

  // Значок расширения: синий квадрат, строки текста (одна — янтарная, переведённая), курсор.
  function logo(size, cls) {
    const el = svg({ width: size, height: size, viewBox: "16 16 96 96", "aria-hidden": "true", class: cls || "p-logo" });
    el.appendChild(shape("rect", { x: 16, y: 16, width: 96, height: 96, rx: 22, fill: "#2563eb" }));
    el.appendChild(shape("rect", { x: 32, y: 36, width: 62, height: 13, rx: 6.5, fill: "#ffffff" }));
    el.appendChild(shape("rect", { x: 32, y: 58, width: 44, height: 13, rx: 6.5, fill: "#ffcf4a" }));
    el.appendChild(shape("rect", { x: 32, y: 80, width: 28, height: 13, rx: 6.5, fill: "#ffffff" }));
    el.appendChild(shape("path", { d: "M66 62 L66 101.5 L75.6 92.4 L82.4 107.2 L89.1 104.4 L82.6 89.8 L95.1 89.8Z", fill: "#ffffff",
      stroke: "#0b1f4d", "stroke-width": 6, "stroke-linejoin": "round", "paint-order": "stroke" }));
    return el;
  }

  // Список выбора в обёртке со стрелкой (поле 40).
  function select(id, rows, value, attrs) {
    const sel = h("select", Object.assign({ id }, attrs || {}));
    HT_fillSelect(sel, rows);
    selValue(sel);
    if (value != null) sel.value = value;
    return { wrap: h("div", { class: "sel" }, sel, ic("chevDown", 16)), sel };
  }
  // Поле настраиваемого списка (Chrome 135+, ui.css) показывает выбранное через <button><selectedcontent> — так
  // длинное название обрезается многоточием перед стрелкой. Звать после HT_fillSelect (он очищает список). Где
  // настраиваемого списка нет, кнопка внутри select не рисуется и ни на что не влияет.
  function selValue(sel) {
    const first = sel.firstElementChild;
    if (first && first.tagName === "BUTTON") return sel;
    const b = document.createElement("button");
    b.type = "button";
    b.appendChild(document.createElement("selectedcontent"));
    sel.prepend(b);
    return sel;
  }

  // Ползунок (.range): пройденная часть дорожки — акцентом. CSS берёт долю 0…1 из --p; звать после каждой смены
  // значения из кода, а с bind — ещё и следить за перетаскиванием.
  function rangeFill(el, bind) {
    const min = Number(el.min) || 0, max = Number(el.max) || 100, v = Number(el.value);
    el.style.setProperty("--p", String(max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0));
    if (bind && !el.dataset.fill) { el.dataset.fill = "1"; el.addEventListener("input", () => rangeFill(el)); }
  }

  // Переключатель-кнопка (role=switch).
  function switchBtn(on, attrs) {
    return h("button", Object.assign({ type: "button", class: "switch", role: "switch", "aria-checked": String(!!on) }, attrs || {}));
  }

  // Полоса прогресса: pct — 0..100 или null (бегущая).
  function progress(pct, label, cls) {
    const fill = h("span");
    const bar = h("span", { class: "progress" + (cls ? " " + cls : ""), role: "progressbar", "aria-label": label || null,
      "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
    setProgress(bar, pct);
    return bar;
  }
  function setProgress(bar, pct) {
    const known = typeof pct === "number" && isFinite(pct);
    bar.classList.toggle("indet", !known);
    bar.firstChild.style.width = known ? Math.max(0, Math.min(100, pct)) + "%" : "";
    if (known) bar.setAttribute("aria-valuenow", String(Math.round(pct))); else bar.removeAttribute("aria-valuenow");
  }

  // «Английский → русский»: названия языков на языке интерфейса, первая буква заглавная.
  function cap(s) { s = String(s || ""); return s ? s[0].toLocaleUpperCase(HT_uiLang()) + s.slice(1) : s; }
  function pair(src, tgt) { return HT_t("pairArrow", [cap(HT_langLabel(src)), HT_langLabel(tgt)]); }

  return { h, ic, stopIc, logo, select, selValue, rangeFill, switchBtn, progress, setProgress, cap, pair };
})();
