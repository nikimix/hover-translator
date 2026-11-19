// Отрисовка картинок магазина из HTML/SVG в PNG через Chrome без интерфейса (расширение не нужно).
//
//   node assets/store/build.js [screens] [promo] [icons]   (без аргументов — всё)
//
// screens  — store/images/<lang>/screenshot-1..5.png (1280×800) из screens.html и снимков shots/<lang>/;
// promo    — store/images/<lang>/promo-small-440x280.png и promo-marquee-1400x560.png из promo.html;
// icons    — hover-translate/icons/16, 32, 48, 128.png из assets/icon-*.svg и assets/icon.svg.
// Картинки магазина без прозрачности (фон страницы непрозрачный — Chrome пишет PNG без альфа-канала).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "../..");
const ASSETS = path.join(ROOT, "assets");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const what = process.argv.slice(2);
const want = (k) => !what.length || what.includes(k);

async function chrome() {
  const prof = fs.mkdtempSync(path.join(process.env.HT_TMP || require("os").tmpdir(), "ht-build-"));
  const p = spawn("google-chrome", ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${prof}`, "--no-first-run",
    "--hide-scrollbars", "--allow-file-access-from-files", "--force-color-profile=srgb", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const out = p.stdio[3], inp = p.stdio[4];
  let buf = "", id = 0;
  const pending = new Map();
  inp.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
    out.write(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }) + "\0");
  });
  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cmd("Target.attachToTarget", { targetId, flatten: true });
  const c = (m, pr) => cmd(m, pr, sessionId);
  await c("Page.enable");
  const ev = async (expression) => (await c("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  // file — HTML/SVG; width×height — CSS-пиксели; transparent — прозрачный фон (значки).
  async function render(file, query, width, height, outFile, { transparent = false, dpr = 1 } = {}) {
    await c("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    await c("Emulation.setDefaultBackgroundColorOverride", transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    await c("Page.navigate", { url: "file://" + file + (query ? "?" + query : "") });
    const t0 = Date.now();
    for (;;) {
      const st = await ev("document.readyState === 'complete' && (!document.body || !document.body.hasAttribute('data-wait') || document.body.dataset.ready === '1')").catch(() => false);
      if (st) break;
      if (Date.now() - t0 > 15000) throw new Error("не дождался отрисовки: " + file + "?" + query);
      await sleep(100);
    }
    await ev("document.fonts ? document.fonts.ready.then(() => true) : true");
    await sleep(120);
    const r = await c("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, Buffer.from(r.data, "base64"));
    console.log("  " + path.relative(ROOT, outFile) + `  ${width * dpr}×${height * dpr}`);
  }
  const close = async () => { p.kill("SIGTERM"); await sleep(500); fs.rmSync(prof, { recursive: true, force: true }); };
  return { render, close };
}

(async () => {
  const b = await chrome();
  try {
    if (want("icons")) {
      for (const s of [16, 32, 48, 128]) {
        const src = path.join(ASSETS, s === 128 ? "icon.svg" : `icon-${s}.svg`);
        await b.render(src, "", s, s, path.join(ROOT, "hover-translate/icons", `${s}.png`), { transparent: true });
      }
    }
    for (const lang of ["en", "ru"]) {
      const out = path.join(ROOT, "store/images", lang);
      if (want("screens")) {
        for (let n = 1; n <= 5; n++) await b.render(path.join(HERE, "screens.html"), `n=${n}&lang=${lang}`, 1280, 800, path.join(out, `screenshot-${n}.png`));
      }
      if (want("promo")) {
        await b.render(path.join(HERE, "promo.html"), `size=small&lang=${lang}`, 440, 280, path.join(out, "promo-small-440x280.png"));
        await b.render(path.join(HERE, "promo.html"), `size=marquee&lang=${lang}`, 1400, 560, path.join(out, "promo-marquee-1400x560.png"));
      }
    }
  } finally { await b.close(); }
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
