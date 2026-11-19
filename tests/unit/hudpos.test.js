// Место плавающей кнопки: HT_hudPos(v, vw) из shared.js в node через vm (без браузера).
// Проверяет: новый формат { side: "left" | "right", top } проходит как есть (лишние поля отброшены); старый формат
// мини-панели { left, top } переводится в новый — сторона по середине окна (vw), без ширины окна — справа, top
// прежний; всё остальное (мусор, неверная сторона, не число) — null, то есть место по умолчанию (справа внизу).
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { EXT } = require("../lib/env");
const { makeI18n } = require("../lib/i18n-stub");

let pass = 0;
const ok = (name) => { pass++; console.log("  ok  " + name); };

const ctx = { chrome: { i18n: makeI18n("ru") }, console, Intl };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, "shared.js"), "utf8"), ctx);
assert.strictEqual(typeof ctx.HT_hudPos, "function", "HT_hudPos есть в shared.js");
// Значение из vm — объект другого «мира»: сравниваем его копию.
const pos = (v, vw) => {
  const r = ctx.HT_hudPos(v, vw);
  return r === null || r === undefined ? r : JSON.parse(JSON.stringify(r));
};

// ---- 1. новый формат ----
assert.deepStrictEqual(pos({ side: "left", top: 100 }), { side: "left", top: 100 });
assert.deepStrictEqual(pos({ side: "right", top: 0 }, 1000), { side: "right", top: 0 });
assert.deepStrictEqual(pos({ side: "right", top: 12.5 }, 1000), { side: "right", top: 12.5 }, "дробный top — как есть");
assert.deepStrictEqual(pos({ side: "left", top: 5000 }, 800), { side: "left", top: 5000 }, "top не прижимается при чтении: прижимают при расстановке");
assert.deepStrictEqual(pos({ side: "right", top: 40, extra: 1 }, 1000), { side: "right", top: 40 }, "лишние поля отброшены");
ok("новый формат { side, top }: left/right и конечный top — как есть (top не прижимается при чтении), лишние поля отброшены");

// ---- 2. миграция старого { left, top } мини-панели ----
// side = (vw && left + 22 < vw / 2) ? "left" : "right"; top — прежний.
assert.deepStrictEqual(pos({ left: 120, top: 300 }, 1000), { side: "left", top: 300 }, "середина кружка левее середины окна — слева");
assert.deepStrictEqual(pos({ left: 800, top: 200 }, 1000), { side: "right", top: 200 }, "правее — справа");
assert.deepStrictEqual(pos({ left: 477, top: 10 }, 1000), { side: "left", top: 10 }, "477 + 22 = 499 < 500 — слева");
assert.deepStrictEqual(pos({ left: 478, top: 10 }, 1000), { side: "right", top: 10 }, "478 + 22 = 500, не меньше 500 — справа");
assert.deepStrictEqual(pos({ left: -50, top: -20 }, 1000), { side: "left", top: -20 }, "top прежний, даже за краем (прижмут при расстановке)");
assert.deepStrictEqual(pos({ left: 120, top: 300 }), { side: "right", top: 300 }, "без ширины окна — справа");
assert.deepStrictEqual(pos({ left: 120, top: 300 }, 0), { side: "right", top: 300 }, "ширина 0 — справа");
ok("миграция { left, top } → { side, top }: сторона по середине кружка (left + 22) против середины окна, на границе — справа; без ширины окна — справа; top прежний");

// ---- 3. мусор → null (место по умолчанию) ----
const junk = [
  null, undefined, 0, 1, "", "left", true, [], [16, 300], {},
  { side: "middle", top: 5 }, { side: "LEFT", top: 5 }, { side: "left" }, { side: "right", top: "5" }, { side: "left", top: NaN },
  { side: "right", top: Infinity }, { side: "left", top: null }, { side: 1, top: 5 },
  { left: "x", top: 1 }, { left: 10 }, { top: 10 }, { left: 10, top: NaN }, { left: Infinity, top: 10 }, { left: "120", top: "300" },
];
for (const v of junk) assert.strictEqual(pos(v, 1000), null, "мусор: " + JSON.stringify(v));
assert.strictEqual(pos({ left: "x", top: 1 }), null);
ok(`мусор — null, место по умолчанию (проверено значений: ${junk.length}; не объект, неизвестная сторона, top не число или бесконечность, старый формат с не-числами)`);

console.log(`\nВсе проверки пройдены: ${pass}`);
