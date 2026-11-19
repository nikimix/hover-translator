// Согласие на отправку текста: content.js в Chrome без интерфейса, страница по HTTP с заглушкой chrome.*
// (fixtures/stub.html). Проверяет: без согласия на отправку текста — ни одного translateBatch (наведение,
// клавиша, «Перевести страницу», перепревод после смены языка); «авто» без согласия или без ключа
// переводит встроенным и при сбое называет настоящую причину; согласие на другой сервис не считается;
// значки и подписи плавающей кнопки. Страницы отдаёт свой сервер (lib/server.js).
const assert = require("assert");
const { launch, sleep } = require("../lib/chrome");
const { serve } = require("../lib/server");
let BASE = "";
let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };
const until = async (fn, ms = 4000, step = 50) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); }
};
const SHIFT = 8;
const NONE = {};

(async () => {
  const srv = await serve();
  BASE = srv.base + "/stub.html";
  const b = await launch();
  const errors = [];
  b.listeners.push((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  try {
    const t = await b.openTab("about:blank");
    await t.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    const ev = t.ev;
    const load = async (store, extra = "") => {
      await t.cmd("Page.navigate", { url: BASE + "?store=" + encodeURIComponent(JSON.stringify(store || {})) + extra });
      await until(() => ev("typeof HT_siteKey === 'function' && document.readyState === 'complete'").catch(() => false), 5000);
      await sleep(300);
    };
    const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height) }; })()`);
    const move = (x, y) => t.mouse("mouseMoved", x, y, {});
    const hover = async (sel) => { const r = await rect(sel); await move(r.x + 40, r.y + Math.round(r.h / 2)); await sleep(30); };
    const key = (type, k, code, modifiers, vk) => t.cmd("Input.dispatchKeyEvent", { type, key: k, code, modifiers, windowsVirtualKeyCode: vk });
    const tapShift = async () => { await key("rawKeyDown", "Shift", "ShiftLeft", SHIFT, 16); await sleep(30); await key("keyUp", "Shift", "ShiftLeft", 0, 16); await sleep(150); };
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).textContent`);
    const calls = () => ev("trCalls().length");
    const toastsNow = () => ev("toasts()");

    // ---- 1. DeepL с ключом, но без согласия: ничего не уходит ----
    await load({ engine: "deepl", apiKey: "k:fx", consent: NONE });
    assert.strictEqual(await ev("HT_engineProblem('deepl', { apiKey: true, consent: {} }, true)"), "no-consent");
    const p1 = await text("#p1");
    await hover("#p1"); await tapShift();
    await hover("#p2"); await tapShift();
    await sleep(200);
    assert.strictEqual(await calls(), 0, "ни одного translateBatch");
    assert.strictEqual(await text("#p1"), p1, "абзац не тронут");
    let ts = await toastsNow();
    assert.ok(ts.length === 1 && /^err:Перевод не работает/.test(ts[0]) && /нужно ваше согласие на отправку текста/i.test(ts[0]) && /Переводить встроенным/.test(ts[0]) && /Открыть настройки/.test(ts[0]), JSON.stringify(ts));
    assert.deepStrictEqual(await ev("typeCalls('noticeOnce').map((c) => c.problem)"), ["no-consent"]);
    await ev("sendCmd({ type: 'translatePage', via: 'popup' }); true"); await sleep(300);
    assert.strictEqual(await calls(), 0, "«Перевести страницу» тоже ничего не отправила");
    assert.ok(/нужно ваше согласие/i.test((await toastsNow()).join()), "и объяснила почему");
    // смена языка при уже показанном… здесь показанного нет; смена языка не должна ничего отправлять
    await ev("setStore({ targetLang: 'DE' }); true"); await sleep(600);
    assert.strictEqual(await calls(), 0);
    // согласие дали — уведомление «Перевод не работает» больше не правда и закрывается
    await ev("setStore({ consent: { deepl: true } }); true"); await sleep(300);
    assert.deepStrictEqual(await toastsNow(), [], "причину устранили — уведомление закрыто");
    ok("DeepL с ключом без согласия: клавиша, «Перевести страницу», смена языка — 0 запросов; одно уведомление «нужно ваше согласие» с кнопками; дали согласие — уведомление закрылось");

    // ---- 2. согласие на другой сервис не считается; мусор в согласии не считается ----
    await load({ engine: "llm", llmApiKey: "sk-x", llmProvider: "anthropic", consent: { openai: true, deepl: true } });
    await hover("#p1"); await tapShift(); await sleep(200);
    assert.strictEqual(await calls(), 0, "ИИ Anthropic: согласия на Anthropic нет");
    await load({ engine: "deepl", apiKey: "k:fx", consent: { deepl: "true" } });
    await hover("#p1"); await tapShift(); await sleep(200);
    assert.strictEqual(await calls(), 0, "строка «true» — не согласие");
    ok("согласие — по сервису: на OpenAI и DeepL не открывает Anthropic; «true» строкой не считается");

    // ---- 3. дали согласие — пошло; отозвали — снова ничего ----
    await load({ engine: "deepl", apiKey: "k:fx", consent: NONE });
    await ev("setStore({ consent: { deepl: true } }); true"); await sleep(100);
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => text("#p1").then((s) => s.startsWith("[RU]"))), "после согласия переводит DeepL");
    assert.strictEqual(await calls(), 1);
    await ev("setStore({ consent: { deepl: false } }); true"); await sleep(500);
    await hover("#p2"); await tapShift(); await sleep(200);
    assert.strictEqual(await calls(), 1, "после отзыва — ни одного нового запроса (и перепревода тоже)");
    ok("согласие дали в окне — перевод пошёл в DeepL; отозвали — новых запросов нет");

    // ---- 4. «авто» с ключом без согласия — встроенный, без запросов; после согласия — DeepL ----
    await load({ engine: "auto", apiKey: "k:fx", consent: NONE });
    await hover("#p1"); await tapShift();
    assert.ok(await until(() => text("#p1").then((s) => s.startsWith("[ru]"))), "перевёл встроенный: " + await text("#p1"));
    assert.strictEqual(await calls(), 0);
    assert.deepStrictEqual(await toastsNow(), [], "это не поломка — без уведомлений");
    await ev("setStore({ consent: { deepl: true } }); true");
    assert.ok(await until(() => text("#p1").then((s) => s.startsWith("[RU]")), 3000), "согласились — показанное переведено заново через DeepL: " + await text("#p1"));
    assert.strictEqual(await calls(), 1);
    ok("«авто» с ключом без согласия: переводит встроенный, 0 запросов, без уведомлений; согласились — показанное переведено DeepL");

    // ---- 5. «авто»: настоящая причина, если и встроенный не смог (было: «не задан ключ DeepL») ----
    for (const [store, label] of [[{ engine: "auto", apiKey: "" }, "без ключа"], [{ engine: "auto", apiKey: "k:fx", consent: NONE }, "без согласия"]]) {
      await load(store);
      await ev("Translator.availability = async () => 'unavailable'; true");
      await hover("#p1"); await tapShift(); await sleep(300);
      ts = await toastsNow();
      assert.strictEqual(await calls(), 0);
      assert.ok(ts.length === 1 && /не умеет переводить эту пару языков: английский → русский/.test(ts[0]) && !/ключ|соглас/.test(ts[0]), label + ": " + JSON.stringify(ts));
    }
    // и если background всё же ответил «нет ключа» (ключ стёрли, пока шёл запрос)
    await load({ engine: "auto", apiKey: "k:fx" });
    await ev(`Translator.availability = async () => 'unavailable'; window.__bgReply = () => ({ ok: false, code: "no-key", error: HT_KEY_HINTS.apiKey }); true`);
    await hover("#p1"); await tapShift(); await sleep(300);
    ts = await toastsNow();
    assert.ok(ts.length === 1 && /не умеет переводить эту пару/.test(ts[0]) && !/ключ/.test(ts[0]), JSON.stringify(ts));
    // а настоящая ошибка DeepL по-прежнему важнее (ключ не подошёл)
    await load({ engine: "auto", apiKey: "k:fx" });
    await ev(`Translator.availability = async () => 'unavailable'; window.__bgReply = () => ({ ok: false, code: "bad-key", error: "DeepL не принял ключ — проверьте его в окне расширения.", detail: "код ответа 403" }); true`);
    await hover("#p1"); await tapShift(); await sleep(300);
    assert.ok(/DeepL не принял ключ/.test((await toastsNow()).join()), JSON.stringify(await toastsNow()));
    ok("«авто» без ключа или согласия, встроенный не смог: показана настоящая причина («не умеет переводить эту пару»), а не «не задан ключ DeepL»; ошибка ключа DeepL — по-прежнему она");

    // ---- 6. плавающая кнопка: значки — SVG; у кружка, списка языка и кнопок меню — подписи для чтения с экрана ----
    await load({ engine: "chrome", hudShown: true });
    assert.strictEqual(await ev("fabRoot().querySelector('.fm').hidden"), true, "меню закрыто, пока его не открыли");
    const fc = await ev("uiPoint(fabRoot(), '.fab')");
    await t.click(fc.x, fc.y); await sleep(150);       // меню — настоящим щелчком (содержимое может строиться при открытии)
    const fab = await ev(`(() => { const r = fabRoot(), b = r.querySelector('.fab'), s = r.querySelector('.fm-sel select');
      const byIds = (ids) => (ids || '').split(/\\s+/).filter(Boolean).map((id) => (r.getElementById(id) || {}).textContent || '').join(' ').trim();
      const name = (e) => e.getAttribute('aria-label') || byIds(e.getAttribute('aria-labelledby')) || (e.labels && e.labels[0] ? e.labels[0].textContent.trim() : '') || e.textContent.trim();
      return { fab: (b.querySelector('svg') ? 'svg' : '-') + ':' + name(b), sel: name(s), open: !r.querySelector('.fm').hidden,
        buttons: [...r.querySelectorAll('.fm button')].filter((x) => !x.closest('select')).map((x) => (x.querySelector('svg') ? 'svg' : '-') + ':' + name(x)) }; })()`);
    const want = await ev(`({ fab: 'svg:' + HT_t('csFabAria', [HT_t('extShortName')]), sel: HT_t('targetLangAria'), open: true,
      buttons: ['svg:' + HT_t('translatePage'), 'svg:' + HT_t('csFabSiteOff', ['127.0.0.1']), 'svg:' + HT_t('csFabHide'), 'svg:' + HT_t('ppSettings')] })`);
    assert.deepStrictEqual(fab, want);
    ok("плавающая кнопка: у кружка — значок SVG и подпись «" + want.fab.slice(4) + "», у списка — «" + want.sel + "», у кнопок меню — значки SVG и подписи; меню закрыто, пока его не открыли щелчком");

    assert.deepStrictEqual(errors, [], "ошибок на странице нет");
    console.log(`\nВсе проверки пройдены: ${pass}`);
  } finally {
    await b.close();
    await srv.close();
  }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
