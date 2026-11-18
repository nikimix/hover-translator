#!/usr/bin/env bash
# Все автоматические проверки расширения. Нужны Node.js 18+ и Chrome (для живых — 138+); пакеты npm не нужны.
#
#   tests/run.sh                  всё: unit, page, live
#   tests/run.sh --fast           без живых проверок (live)
#   tests/run.sh --shots DIR      сохранить скриншоты проверок в DIR (по папке на набор)
#   tests/run.sh page live/popup  только наборы, в пути которых есть одно из слов
#
# unit/  — background.js, shared.js и тексты _locales в Node (vm, заглушка chrome.*), без браузера;
# page/  — content.js в Chrome без интерфейса на тестовых страницах с заглушкой chrome.*;
# live/  — настоящее расширение в Chrome без интерфейса, настоящий встроенный переводчик: языковые модели
#          качаются из сети (первый раз — минуты), проверка ключа DeepL ходит в сеть.
#
# Временные профили Chrome, копии расширения и журналы — в одной временной папке (HT_TMP или системная),
# она удаляется в конце. Живые наборы одного прогона делят профиль, поэтому модели качаются один раз;
# HT_PROFILE=папка — свой профиль, который остаётся между прогонами. CHROME_PATH — какой Chrome запускать.
# Код выхода: 0 — всё прошло, 1 — есть ошибки.
set -u -o pipefail

TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$TESTS")"
EXT="$ROOT/hover-translate"

fast=0
shots=""
filters=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) fast=1 ;;
    --shots) shift; [ $# -gt 0 ] || { echo "--shots: нужна папка" >&2; exit 2; }; shots="$1" ;;
    --shots=*) shots="${1#--shots=}" ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "неизвестный ключ: $1 (см. --help)" >&2; exit 2 ;;
    *) filters+=("$1") ;;
  esac
  shift
done

command -v node >/dev/null || { echo "нужен Node.js 18 или новее" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || { echo "нужен Node.js 18 или новее, сейчас $(node --version)" >&2; exit 1; }

if [ -n "$shots" ]; then
  mkdir -p "$shots" && export HT_SHOTS="$(cd "$shots" && pwd)" || { echo "не могу создать папку $shots" >&2; exit 2; }
fi

base="${HT_TMP:-${TMPDIR:-/tmp}}"
mkdir -p "$base" || exit 1
RUN_TMP="$(mktemp -d "$base/hover-translate-tests.XXXXXX")" || exit 1
cleanup() { rm -rf "$RUN_TMP"; }
trap cleanup EXIT
trap 'echo; echo "прервано"; exit 130' INT TERM
export HT_TMP="$RUN_TMP"
export HT_PROFILE="${HT_PROFILE:-$RUN_TMP/profile}"

# ---- быстрые проверки файлов расширения: синтаксис и JSON ----
for f in "$EXT"/*.js; do node --check "$f" || { echo "синтаксическая ошибка: $f" >&2; exit 1; }; done
node -e 'for (const f of process.argv.slice(1)) { try { JSON.parse(require("fs").readFileSync(f, "utf8")); } catch (e) { console.error("битый JSON: " + f + ": " + e.message); process.exit(1); } }' \
  "$EXT/manifest.json" "$EXT"/_locales/*/messages.json || exit 1

# ---- какие наборы запускать ----
want() {
  local rel="$1" f
  [ ${#filters[@]} -eq 0 ] && return 0
  for f in "${filters[@]}"; do [[ "$rel" == *"$f"* ]] && return 0; done
  return 1
}
suites=()
for group in unit page live; do
  [ "$group" = live ] && [ $fast = 1 ] && continue
  for f in "$TESTS/$group"/*.test.js; do
    [ -e "$f" ] || continue
    rel="${f#"$TESTS/"}"
    want "$rel" && suites+=("$rel")
  done
done
[ ${#suites[@]} -gt 0 ] || { echo "нет наборов по заданным словам: ${filters[*]}" >&2; exit 2; }

# ---- Chrome ----
need_chrome=0; need_live=0
for s in "${suites[@]}"; do
  case "$s" in page/*) need_chrome=1 ;; live/*) need_chrome=1; need_live=1 ;; esac
done
page_error=""; live_error=""
if [ $need_chrome = 1 ]; then
  if info="$(node "$TESTS/lib/chrome.js" 2>&1)"; then
    major="${info%%$'\t'*}"
    echo "Chrome: ${info#*$'\t'}" | tr '\t' ' '
    if [ $need_live = 1 ] && [ "$major" -lt 138 ]; then
      live_error="живым проверкам нужен Chrome 138 или новее (встроенный переводчик), найден $major"
    fi
  else
    page_error="$info"; live_error="$info"
  fi
fi
[ -n "${HT_SHOTS:-}" ] && echo "Скриншоты: $HT_SHOTS"
echo

# ---- прогон ----
TIMEOUT=""
command -v timeout >/dev/null && TIMEOUT="timeout"
total=0; checks=0; failed=()
start=$(date +%s)
for s in "${suites[@]}"; do
  case "$s" in unit/*) limit=180 ;; page/*) limit=420 ;; *) limit=1200 ;; esac
  log="$RUN_TMP/$(echo "$s" | tr '/' '-').log"
  total=$((total + 1))
  printf '%-36s ' "$s"
  skip=""
  case "$s" in page/*) skip="$page_error" ;; live/*) skip="$live_error" ;; esac
  if [ -n "$skip" ]; then
    echo "НЕ ЗАПУЩЕН: $skip"
    failed+=("$s")
    continue
  fi
  t0=$(date +%s)
  ( cd "$ROOT" && ${TIMEOUT:+$TIMEOUT $limit} node "$TESTS/$s" ) >"$log" 2>&1
  code=$?
  dt=$(( $(date +%s) - t0 ))
  n="$(sed -n 's/^Все проверки пройдены: \([0-9]*\).*/\1/p' "$log" | tail -1)"
  if [ $code = 0 ] && [ -n "$n" ]; then
    checks=$((checks + n))
    echo "ok  ($n, ${dt} с)"
  else
    [ $code = 124 ] && why="не уложился в $limit с" || why="код выхода $code"
    [ $code = 0 ] && why="не дошёл до конца"
    echo "ОШИБКА ($why, ${dt} с)"
    tail -40 "$log" | sed 's/^/    /'
    failed+=("$s")
  fi
done
el=$(( $(date +%s) - start ))

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "Итог: всё прошло — наборов $total, проверок $checks, $((el / 60)) мин $((el % 60)) с"
  exit 0
fi
echo "Итог: есть ошибки — ${#failed[@]} из $total наборов: ${failed[*]} ($((el / 60)) мин $((el % 60)) с)"
exit 1
