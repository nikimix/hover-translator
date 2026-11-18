#!/usr/bin/env bash
# Builds the Chrome Web Store package: dist/hover-translator-<version>.zip.
#
# The archive holds the contents of hover-translate/ (manifest.json at the root of the zip), without
# documentation (*.md) and system junk. Before packing, it checks that:
#   - manifest.json and every _locales/*/messages.json are valid JSON;
#   - every file the manifest points to exists (icons, background worker, content scripts and styles,
#     popup, default locale);
#   - every __MSG_name__ used in the manifest exists in each locale;
#   - local files used by the extension's own pages (<script src>, <link href>, <img src/srcset>) and by importScripts()
#     in the background worker exist.
# Prints the archive size and the list of files.
#
# Usage: bash scripts/pack.sh        (needs python3; nothing to install)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/hover-translate"
DIST="$ROOT/dist"

command -v python3 >/dev/null || { echo "pack.sh: python3 is required" >&2; exit 1; }
[ -f "$SRC/manifest.json" ] || { echo "pack.sh: $SRC/manifest.json not found" >&2; exit 1; }
mkdir -p "$DIST"

python3 -I - "$SRC" "$DIST" <<'PY'
import json, os, re, sys, zipfile

src, dist = sys.argv[1], sys.argv[2]
errors = []

def load_json(rel):
    try:
        with open(os.path.join(src, rel), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        errors.append(f"missing file: {rel}")
    except (ValueError, UnicodeDecodeError) as e:
        errors.append(f"invalid JSON in {rel}: {e}")
    return None

man = load_json("manifest.json")
if man is None:
    sys.exit("pack.sh: " + "; ".join(errors))

version = str(man.get("version", ""))
if not re.fullmatch(r"\d+(\.\d+){0,3}", version):
    errors.append(f"manifest version {version!r} is not 1-4 dot-separated numbers")
if man.get("manifest_version") != 3:
    errors.append("manifest_version is not 3")

# --- files the manifest points to ---
refs = set()
def ref(path, what):
    if isinstance(path, str) and path:
        refs.add((path.lstrip("/"), what))

for size, p in (man.get("icons") or {}).items():
    ref(p, f"icons.{size}")
action = man.get("action") or {}
for size, p in (action.get("default_icon") or {}).items():
    ref(p, f"action.default_icon.{size}")
ref(action.get("default_popup"), "action.default_popup")
ref((man.get("background") or {}).get("service_worker"), "background.service_worker")
for i, cs in enumerate(man.get("content_scripts") or []):
    for p in cs.get("js", []):
        ref(p, f"content_scripts[{i}].js")
    for p in cs.get("css", []):
        ref(p, f"content_scripts[{i}].css")
for p in (man.get("options_ui") or {}).get("page", ""), man.get("options_page", ""):
    ref(p, "options page")

default_locale = man.get("default_locale")
locales_dir = os.path.join(src, "_locales")
locales = sorted(d for d in os.listdir(locales_dir) if os.path.isdir(os.path.join(locales_dir, d))) if os.path.isdir(locales_dir) else []
if default_locale:
    ref(f"_locales/{default_locale}/messages.json", "default_locale")
elif locales:
    errors.append("_locales/ exists but manifest has no default_locale")

for rel, what in sorted(refs):
    if not os.path.isfile(os.path.join(src, rel)):
        errors.append(f"{what} -> {rel}: file not found")

# --- locales: valid JSON, and every __MSG_x__ from the manifest is in each of them ---
msg_keys = sorted(set(re.findall(r"__MSG_(\w+)__", json.dumps(man))))
for loc in locales:
    rel = f"_locales/{loc}/messages.json"
    msgs = load_json(rel)
    if msgs is None:
        continue
    have = {k.lower() for k in msgs}
    for k in msg_keys:
        if k.lower() not in have and not k.startswith("@@"):
            errors.append(f"{rel}: no message {k!r} used in manifest.json")

# --- local files used by the extension's pages and by importScripts() ---
def local(url):
    return url and not re.match(r"^[a-z][a-z0-9+.-]*:|^//|^#", url, re.I)

for name in sorted(os.listdir(src)):
    path = os.path.join(src, name)
    if name.endswith(".html"):
        html = open(path, encoding="utf-8").read()
        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        found = re.findall(r"<(script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*[\"']([^\"']+)[\"']", html, re.I)
        for srcset in re.findall(r"<img\b[^>]*?\bsrcset\s*=\s*[\"']([^\"']+)[\"']", html, re.I):
            found += [("img", part.split()[0]) for part in srcset.split(",") if part.strip()]
        for tag, url in found:
            url = url.split("#")[0].split("?")[0]
            if local(url) and not os.path.isfile(os.path.join(src, url.lstrip("/"))):
                errors.append(f"{name}: <{tag}> -> {url}: file not found")
    elif name.endswith(".js"):
        js = open(path, encoding="utf-8").read()
        for args in re.findall(r"\bimportScripts\(([^)]*)\)", js):
            for url in re.findall(r"[\"']([^\"']+)[\"']", args):
                if local(url) and not os.path.isfile(os.path.join(src, url.lstrip("/"))):
                    errors.append(f"{name}: importScripts -> {url}: file not found")

if errors:
    print("pack.sh: the package was NOT built:", file=sys.stderr)
    for e in errors:
        print("  - " + e, file=sys.stderr)
    sys.exit(1)

# --- collect files: everything in hover-translate/ except docs and junk ---
SKIP_DIRS = {".git", ".idea", ".vscode", "node_modules", "__MACOSX"}
SKIP_FILES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_RE = re.compile(r"(\.md|~|\.swp|\.swo|\.orig|\.rej|\.log|\.zip|\.crx|\.pem)$", re.I)

files = []
for dirpath, dirnames, filenames in os.walk(src):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
    for fn in sorted(filenames):
        if fn in SKIP_FILES or fn.startswith(".") or SKIP_RE.search(fn):
            continue
        full = os.path.join(dirpath, fn)
        files.append((os.path.relpath(full, src).replace(os.sep, "/"), full))
files.sort()

# Everything the manifest points to must be in the archive (not filtered out above).
packed = {rel for rel, _ in files}
lost = sorted(rel for rel, _ in refs if rel not in packed)
if lost:
    sys.exit("pack.sh: referenced files would be left out of the archive: " + ", ".join(lost))

out = os.path.join(dist, f"hover-translator-{version}.zip")
tmp = out + ".tmp"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel, full in files:
        z.write(full, rel)
os.replace(tmp, out)

# --- report ---
with zipfile.ZipFile(out) as z:
    infos = z.infolist()
    bad = z.testzip()
if bad:
    sys.exit(f"pack.sh: archive is damaged at {bad}")

def human(n):
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.2f} MB"

print(f"Built {os.path.relpath(out, os.path.dirname(dist))}")
print(f"  version {version}, {len(infos)} files, "
      f"{human(sum(i.file_size for i in infos))} unpacked, {human(os.path.getsize(out))} zipped")
print(f"  checked: manifest.json, {len(locales)} locale(s), {len(refs)} manifest references, page scripts and styles")
print()
for i in infos:
    print(f"  {i.file_size:>9}  {i.filename}")
PY
