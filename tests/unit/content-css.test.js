// Правила для элементов страницы — в двух местах: content.css (подключён к документу как CSS контент-скрипта) и
// константа PAGE_CSS в content.js (её лист подключается к открытым shadow root сайта, куда CSS документа не
// доходит). Здесь, без браузера, проверяется, что это одни и те же правила: без комментариев и с точностью до
// пробелов тексты совпадают, и в них есть оба наших состояния — «идёт перевод» и «не перевелось».
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { EXT } = require("../lib/env");

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

const js = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const css = fs.readFileSync(path.join(EXT, "content.css"), "utf8");

// Без комментариев, пробелы — одним, вокруг { } ; : , — никаких, «;}» — «}».
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};:,])\s*/g, "$1").replace(/;}/g, "}").trim();
// По правилам: первое расхождение видно в сообщении, а не два длинных текста целиком.
const rules = (s) => norm(s).split("}").map((r) => r.trim()).filter(Boolean);

// ---- 1. константа есть и подключается листом ----
const m = js.match(/const PAGE_CSS = `([^`]*)`;/);
assert.ok(m, "в content.js нет константы PAGE_CSS = `…`;");
const page = m[1];
assert.ok(!page.includes("${"), "PAGE_CSS — простой текст, без подстановок");
assert.ok(/\.replaceSync\(PAGE_CSS\)/.test(js), "PAGE_CSS подключается листом (replaceSync)");
ok("в content.js есть PAGE_CSS — простой текст правил, его лист подключается через replaceSync");

// ---- 2. те же правила, что в content.css ----
const a = rules(page), b = rules(css);
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  assert.strictEqual(a[i], b[i], `правило ${i + 1}: PAGE_CSS в content.js расходится с content.css`);
}
assert.strictEqual(norm(page), norm(css), "PAGE_CSS и content.css расходятся");
ok(`PAGE_CSS совпадает с content.css (без комментариев и пробелов; частей правил: ${b.length})`);

// ---- 3. оба состояния на месте ----
for (const sel of [".ht-loading{", ".ht-loading.ht-loading-dark{", "@keyframes ht-pulse{", "@keyframes ht-pulse-still{",
  "@media (prefers-reduced-motion:reduce){", ".ht-error{", ".ht-error::after{", ".ht-error.ht-error-dark::after{"]) {
  assert.ok(norm(css).includes(sel), "в правилах нет " + sel);
}
ok("в правилах есть «идёт перевод» (с тёмным вариантом и без движения) и «не перевелось» (с «!» и тёмным вариантом)");

console.log(`\nВсе проверки пройдены: ${pass}`);
