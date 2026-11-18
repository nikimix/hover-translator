// builtin.js — встроенный переводчик Chrome на страницах расширения: скачаны ли его модели и загрузка по кнопке.
// Общий для окна расширения, страницы настроек и приветствия; подключается после shared.js. Своей разметки нет:
// каждая страница рисует состояние сама (окно — состояния 1, 2, 12–14; приветствие — шаг 2; настройки — метка
// у карточки «Встроенный»).
//
// Пока модель не скачана, Translator.create()/LanguageDetector.create() работают только по действию
// пользователя (щелчок, нажатие клавиши), а наведение на сайте таким действием не считается. Поэтому модели
// готовят здесь, кнопкой. Скачанная модель общая для всего браузера: подготовленная здесь, она работает и на
// сайтах. Готовим определение языка и пару «язык страницы (или английский) → язык перевода» (HT_prepPair) —
// остальные пары content скачивает на сайте после щелчка по странице.
//
// Почему не в service worker: в Chrome 157 Translator там есть, но с какой версии — не описано, а на
// страницах расширения он есть с Chrome 138 (как и на сайтах).

var HT_builtin = (function () {
  function hasApi() { return typeof self.Translator === "function"; }
  const needs = (a) => a === "downloadable" || a === "downloading";

  // Состояние: { kind, src, tgt, pair, det }:
  //   kind — "none" (встроенного нет в браузере) | "no-lang" (не знает язык перевода) | "pair-unavailable"
  //          (не умеет эту пару) | "need" (нужно скачать) | "downloading" (Chrome уже качает) | "ready";
  //   pair, det — ответ availability() для пары и для определения языка.
  async function status(targetLang, pageLang) {
    if (!hasApi()) { rememberApi(false); return { kind: "none" }; }
    rememberApi(true);
    const { src, tgt } = HT_prepPair(targetLang, pageLang);
    if (!tgt) return { kind: "no-lang", target: targetLang };
    const pair = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt }).catch(() => "unavailable");
    const det = typeof self.LanguageDetector === "function"
      ? await LanguageDetector.availability().catch(() => "unavailable") : "unavailable";
    let kind = "ready";
    if (pair === "unavailable") kind = "pair-unavailable";
    else if (pair === "downloading" || det === "downloading") kind = "downloading";
    else if (needs(pair) || needs(det)) kind = "need";
    return { kind, src, tgt, pair, det };
  }

  // «!» на значке ставит background, а есть ли встроенный переводчик, знает только страница — сообщаем.
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
      // Chrome (замерено на 157) сразу после загрузки ещё ~3 с отказывает в create() с NotSupportedError, хотя
      // availability уже «available». Повторяем без щелчка (модель уже есть), пока create() не пройдёт: «Готово»
      // должно значить, что перевод уже работает, иначе та же заминка достанется первому переводу на сайте.
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

  // Скачать то, чего не хватает (вызывать из обработчика щелчка: create() расходует «действие пользователя»,
  // поэтому обе модели запускаем сразу, в одном щелчке). onProgress(pct) — 0..100 или null (сколько скачано,
  // ещё неизвестно: бегущая полоса). Результат: { ok: true } | { ok: false, again: true } (Chrome не дал
  // запустить вторую модель — нажать ещё раз) | { ok: false, error } (не скачалось).
  async function prepare(targetLang, pageLang, onProgress) {
    const st = await status(targetLang, pageLang);
    const jobs = [];
    if (needs(st.pair)) jobs.push([Translator, { sourceLanguage: st.src, targetLanguage: st.tgt }]);
    if (needs(st.det)) jobs.push([LanguageDetector, {}]);
    const parts = jobs.map(() => null);
    const show = () => {
      const known = parts.every((p) => p !== null);
      if (onProgress) onProgress(known ? Math.round(100 * parts.reduce((a, b) => a + b, 0) / (parts.length || 1)) : null);
    };
    show();
    const results = await Promise.allSettled(jobs.map(([api, opts], i) =>
      download(api, opts, (f) => { if (f > 0 || parts[i] !== null) { parts[i] = f; show(); } })));
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (!failed.length) return { ok: true };
    if (failed.every((e) => e && e.name === "NotAllowedError")) return { ok: false, again: true };
    const e = failed.find((x) => !x || x.name !== "NotAllowedError");
    return { ok: false, error: (e && e.message) || "" };
  }

  // Ждать, пока Chrome докачает начатое без нас (окно открыли, когда загрузка уже шла): onDone(status) — когда
  // состояние сменилось с «downloading». Возвращает функцию остановки.
  function watch(targetLang, pageLang, onDone, ms) {
    let stopped = false;
    (async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, ms || 1500));
        if (stopped) return;
        const st = await status(targetLang, pageLang);
        if (st.kind !== "downloading") { if (!stopped) onDone(st); return; }
      }
    })();
    return () => { stopped = true; };
  }

  return { hasApi, status, prepare, watch };
})();
