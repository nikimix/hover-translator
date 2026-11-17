// builtin.js — встроенный переводчик Chrome на страницах расширения: скачаны ли его модели и
// подготовка по кнопке с полосой загрузки. Общий для окна расширения (popup) и страницы
// приветствия; подключается после shared.js.
//
// Пока модель не скачана, Translator.create()/LanguageDetector.create() работают только по действию
// пользователя (щелчок, нажатие клавиши), а наведение на сайте таким действием не считается. Поэтому
// модели готовят здесь, кнопкой. Скачанная модель общая для всего браузера: подготовленная здесь,
// она работает и на сайтах. Готовим определение языка и пару «английский → язык перевода» (см.
// HT_prepPair) — остальные пары content скачивает на сайте после щелчка по странице.
//
// Почему не в service worker: в Chrome 157 Translator там есть, но с какой версии — не описано, а на
// страницах расширения он есть с Chrome 138 (как и на сайтах).

var HT_builtin = (function () {
  function hasApi() { return typeof self.Translator === "function"; }

  // Состояние моделей: { api:false } или { api, src, tgt, pair, det }, где pair/det — ответ
  // availability(): "available" | "downloadable" | "downloading" | "unavailable".
  async function status(targetLang) {
    if (!hasApi()) return { api: false };
    const { src, tgt } = HT_prepPair(targetLang);
    const pair = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt }).catch(() => "unavailable");
    const det = typeof self.LanguageDetector === "function"
      ? await LanguageDetector.availability().catch(() => "unavailable") : "unavailable";
    return { api: true, src, tgt, pair, det };
  }

  const needs = (a) => a === "downloadable" || a === "downloading";
  const pairLabel = (st) => `${HT_langLabel(st.src)} → ${HT_langLabel(st.tgt)}`;

  // «!» на значке ставит background, а есть ли встроенный переводчик, знает только окно — сообщаем.
  function rememberApi(api) {
    chrome.storage.local.get({ htBuiltinApi: null })
      .then((s) => { if (s.htBuiltinApi !== api) return chrome.storage.local.set({ htBuiltinApi: api }); })
      .catch(() => {});
  }

  // Скачать одну модель. report(доля 0..1, или null — идёт, сколько осталось, неизвестно).
  async function download(api, opts, report) {
    let inst;
    try {
      inst = await api.create(Object.assign({
        monitor(m) { m.addEventListener("downloadprogress", (e) => report(e.total ? e.loaded / e.total : e.loaded)); },
      }, opts));
    } catch (e) {
      if (e && e.name === "NotAllowedError") throw e;   // нужен ещё один щелчок
      // Chrome (замерено на 157) сразу после загрузки ещё ~3 с отказывает в create() с
      // NotSupportedError, хотя availability уже «available». Повторяем без щелчка (модель уже
      // есть), пока create() не пройдёт: «Готово» в окне должно значить, что перевод уже работает,
      // иначе та же заминка достанется первому переводу на сайте.
      report(null);
      for (let i = 0; !inst; i++) {
        const a = await api.availability(opts).catch(() => "unavailable");
        if (a === "available") inst = await api.create(opts).catch(() => null);
        else if (a !== "downloading") throw e;
        if (!inst && i >= 120) throw e;               // ~2 минуты — сдаёмся и показываем ошибку
        if (!inst) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (inst && inst.destroy) inst.destroy();   // сам экземпляр здесь не нужен — важна скачанная модель
  }

  // Блок «встроенный переводчик» в контейнере box. getTarget() — текущий язык перевода (код из
  // таблицы), onState(состояние) — необязательно: "none" | "ready" | "need" | "pair-unavailable".
  function mount(box, getTarget, onState) {
    box.textContent = "";
    const text = document.createElement("p");
    text.className = "bi-text";
    text.setAttribute("aria-live", "polite");
    const bar = document.createElement("div");
    bar.className = "bi-bar";
    bar.hidden = true;
    const fill = document.createElement("div");
    fill.className = "bi-fill";
    bar.appendChild(fill);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn bi-btn";
    btn.textContent = "Подготовить переводчик";
    btn.hidden = true;
    box.append(text, bar, btn);

    let busy = false, seq = 0;
    const say = (msg, kind) => { text.textContent = msg; text.className = "bi-text" + (kind ? " " + kind : ""); };
    const tell = (state) => { if (onState) onState(state); };

    function render(st) {
      bar.hidden = true;
      btn.hidden = true;
      if (!st.api) {
        say("Встроенный переводчик недоступен в этом браузере: нужен Google Chrome 138 или новее на компьютере. Подключите DeepL по своему ключу.", "warn");
        return tell("none");
      }
      if (st.pair === "unavailable") {
        say(`Встроенный переводчик не умеет переводить эту пару языков: ${pairLabel(st)}. Выберите другой язык или подключите DeepL.`, "warn");
        return tell("pair-unavailable");
      }
      const missing = [];
      if (needs(st.pair)) missing.push(pairLabel(st));
      if (needs(st.det)) missing.push("определение языка");
      if (!missing.length) {
        say(`✓ Готово: ${pairLabel(st)}. Перевод идёт на вашем компьютере.` +
          (st.det === "unavailable" ? " Определение языка недоступно — укажите исходный язык в настройках." : ""), "ok");
        return tell("ready");
      }
      const going = st.pair === "downloading" || st.det === "downloading";
      say(going
        ? `Модели уже скачиваются (${missing.join(", ")}). Нажмите кнопку, чтобы видеть ход загрузки.`
        : `Нужно один раз скачать языковые модели: ${missing.join(" и ")}. Это бесплатно, потом перевод работает и без интернета.`, "");
      btn.hidden = false;
      tell("need");
    }

    async function refresh() {
      const my = ++seq;
      if (!busy) say("Проверяю встроенный переводчик…", "");
      const st = await status(getTarget());
      rememberApi(st.api);
      if (my === seq && !busy) render(st);
      return st;
    }

    // Обе модели запускаем сразу, в одном щелчке: create() расходует «действие пользователя», и
    // к концу первой загрузки (секунды) его срок уже истёк бы. Если Chrome всё же отказал второй
    // модели (NotAllowedError) — просим нажать ещё раз.
    async function prepare() {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      const st = await status(getTarget());
      const jobs = [];
      if (needs(st.pair)) jobs.push([Translator, { sourceLanguage: st.src, targetLanguage: st.tgt }]);
      if (needs(st.det)) jobs.push([LanguageDetector, {}]);
      const parts = jobs.map(() => 0);
      const show = () => {
        const known = parts.every((p) => p !== null);
        bar.hidden = false;
        bar.classList.toggle("indeterminate", !known);
        const f = known ? parts.reduce((a, b) => a + b, 0) / (parts.length || 1) : 0;
        fill.style.width = known ? Math.round(f * 100) + "%" : "";
        say(known ? `Скачиваю языковые модели… ${Math.round(f * 100)}%` : "Скачиваю языковые модели…", "");
      };
      show();
      const results = await Promise.allSettled(jobs.map(([api, opts], i) =>
        download(api, opts, (f) => { parts[i] = f; show(); })));
      busy = false;
      btn.disabled = false;
      const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason);
      if (!failed.length) { refresh(); return; }
      bar.hidden = true;
      btn.hidden = false;
      if (failed.every((e) => e && e.name === "NotAllowedError")) {
        say("Осталось совсем немного — нажмите кнопку ещё раз.", "");
      } else {
        const e = failed.find((x) => !x || x.name !== "NotAllowedError");
        say(`Не удалось скачать модель${e && e.message ? ": " + e.message : ""}. Проверьте интернет и нажмите ещё раз.`, "err");
      }
    }

    btn.addEventListener("click", prepare);
    refresh();
    return { refresh };
  }

  return { hasApi, status, mount };
})();
