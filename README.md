# Hover Translator — Translate Text In Place

[Русская версия](README.ru.md)

A Chrome extension that translates text right where it is. Point at a paragraph, heading, list item or table cell
and press **Shift**: the text is replaced with its translation, and links, bold text and the page layout stay as they
were. Press Shift again for the original; **Esc** brings back the whole page.

It works right after installing — no account and no key. By default it uses the translator built into Google Chrome,
which runs on your computer, so your text isn’t sent anywhere. DeepL and AI (OpenAI, Anthropic) can be connected
with your own key.

![Text translated in place on a web page](store/images/en/screenshot-1.png)

![The extension window](store/images/en/screenshot-2.png)

## Features

- Translation in place, or in a card next to the text.
- **Selected text**: select a word, a phrase or a few sentences and press the same key with the cursor over the
  selection, or right-click it → **Translate “…”**. The translation appears in a card next to the selection; the
  page and the selection stay as they were.
- **Translate page**: what’s on screen first, the rest as you scroll; then switch between **Original** and
  **Translation** in one click.
- Choose how to trigger it: Shift, Alt, Ctrl, or no key at all — rest the cursor on the text (links, buttons and menus
  are skipped).
- Floating button on the page: point at it to switch the language, translate the page or show the original.
- Turn translation off on a particular site (email, bank).
- “Don’t translate these words” list for names and terms (DeepL and AI).
- 121 target languages (each translator supports its own set).
- English and Russian interface, light and dark theme.

## Install

**From the Chrome Web Store:** [install Hover Translator](https://chromewebstore.google.com/detail/hieognjnpfkndaedjclkdcclmekhmfoa).

**From source:**

1. Download the code: `git clone https://github.com/nikimix/hover-translator.git` (or “Code → Download ZIP”
   and unpack it).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `hover-translate` folder inside the repository.
4. A welcome page opens: choose the language to translate into and click **Download translator** — Chrome downloads
   it once; then try it on the sample text right there. Reload tabs that were open before installing.

Requirements: Chrome 116 or newer; the built-in translator needs **Chrome 138 or newer on a computer**. Without it,
use DeepL or AI with your own key.

## How to use

1. Point at some text and press and release **Shift** — it’s translated in place. Press again to bring back the
   original. To translate only part of the text, select it and press **Shift** with the cursor over the selection, or
   right-click it → **Translate “…”** (in the “No key” mode, this menu item is the way to translate a selection).
2. **Esc** brings back the original everywhere on the page.
3. Click the extension icon for a small window: translation on or off (**All sites**), the language and recently
   used ones, **Translate page**, “Translate on example.com” for the current site, showing or hiding the floating button.
4. Everything else is on the **settings page** (the gear in the window, or right-click the icon → **Options**): the
   translator and keys, how to trigger and show translations, highlighting, languages, sites and words, shortcuts,
   saved translations.

| Shortcut | What it does |
|---|---|
| Shift (or Alt / Ctrl, as chosen) | Translate the text under the cursor, or the selection if the cursor is over it (in a card); press again for the original |
| Esc | Show the original everywhere on the page |
| Alt+Shift+O (Mac: Ctrl+Shift+O) | Turn translation on or off |
| Alt+Shift+G (Mac: Ctrl+Shift+G) | Translate the page |

Shortcuts can be changed at `chrome://extensions/shortcuts`.

**Translators:**

- **Built into Chrome** (default) — free, runs on your computer, works offline once the models are downloaded.
- **DeepL** — your own API key; the free DeepL API plan includes 500,000 characters a month
  ([get a key](https://www.deepl.com/pro-api)).
- **Auto** (DeepL, with built-in as backup) — switches to the built-in translator if DeepL fails or the monthly limit
  runs out, and goes back to DeepL when it can.
- **AI** — your own OpenAI or Anthropic key; billed to your account.

DeepL and AI are connected on the settings page in three steps — **Consent → Key → Done**; the extension switches
to them only at “Done”, and until then the built-in translator keeps working.

Limitations: extensions can’t run on `chrome://` pages, the Chrome Web Store and some embedded frames; blocks and
selections longer than 2,000 characters aren’t translated; text selected in input fields and editors isn’t
translated yet; “Translate page” covers up to 500 blocks at once.

## Privacy

- With the built-in translator, nothing leaves your computer.
- DeepL, OpenAI or Anthropic receive text only if you select that service, click **Allow sending** and paste your
  own key. Only the text you translate is sent, directly from your browser to that service; the page address is not
  sent.
- Keys, settings and saved translations stay in your browser. Saved translations (DeepL and AI only) are kept for
  14 days; settings page → **Data** → **Delete** removes them at once.
- When you click the icon, the window reads the current tab’s address (the `activeTab` permission) only to tell
  whether translation can work there or the tab needs reloading. The address isn’t stored or sent.
- The `contextMenus` permission adds **Translate “…”** to the right-click menu when you select text. The selected
  text is translated like any other: by the built-in translator on your computer or by the service you chose.
- No server of our own, no analytics, no ads.

Full details: [privacy policy](https://nikimix.github.io/hover-translator/privacy.html)
([source](docs/privacy.html)).

## Project structure

```
hover-translate/        the extension itself (Manifest V3, no build step) — this folder goes into the store package
  manifest.json
  background.js         service worker: requests to DeepL / OpenAI / Anthropic, saved translations, limits, badge, shortcuts, menu item
  content.js            on every page: finds the text under the cursor or the selection, replaces it, card, floating button, notices
  shared.js             tables shared by all parts: languages, translators, default settings, consent, texts
  builtin.js            built-in translator status and download (no markup; used by the window, settings and welcome page)
  popup.html/.js/.css   the extension window (toolbar icon)
  options.html/.js/.css the settings page (opens in a tab)
  welcome.html/.js/.css welcome page shown once after installing
  ui.css, ui.js         styles, icons and building blocks shared by the window, settings and welcome page
  content.css           styles for text being translated on pages
  fonts/                Inter (woff2) for the extension’s own pages, with its license OFL.txt
  _locales/en, ru       all interface texts
  icons/
  README.md             detailed technical notes (in Russian)
docs/                   GitHub Pages site: project page and privacy policy (English and Russian)
store/                  Chrome Web Store texts, dashboard answers, screenshots and promo images
scripts/pack.sh         builds dist/hover-translator-<version>.zip for the store
tests/                  automated checks: tests/run.sh (see “Development”)
```

## Development

There is no build step: edit the files in `hover-translate/`, then press **Reload** on the extension’s card at
`chrome://extensions` (Chrome keeps the old service worker until then) and reload the tab you test on.

### Checks

Everything is in `tests/`; nothing to install from npm. You need **Node.js 18+** and **Google Chrome** (or
Chromium); the live checks need **Chrome 138+** on a computer and an internet connection — they download the
built-in translator’s language models (a few minutes the first time) and send one request to DeepL with a made-up
key.

```sh
tests/run.sh                  # everything (unit, page, live)
tests/run.sh --fast           # without the live checks, about 2 minutes
tests/run.sh --shots DIR      # also save the checks’ screenshots to DIR
tests/run.sh page live/popup  # only the suites whose path contains one of the words
```

| Folder | What it checks |
|---|---|
| `tests/unit/` | `background.js` and `shared.js` in Node (`vm` with a stubbed `chrome.*`): settings validation, spending limits, requests to DeepL / OpenAI / Anthropic, errors, consent, badge, install; and the `_locales` files — same keys in `en` and `ru`, no unused or missing messages, no Russian in code |
| `tests/page/` | `content.js` in headless Chrome on test pages with a stubbed `chrome.*`: only real key presses and clicks count, Shift / hover / Esc, card, notices, “Translate page”, turning off a site, floating button, consent, the built-in translator’s download hint |
| `tests/live/` | the real extension in headless Chrome with the real built-in translator: install and welcome page, the extension window in English and Russian (height, nothing cut off), the settings page (connecting DeepL and AI step by step, with stubbed services), notices on a site, shortcuts, extension update with an open tab |
| `tests/fixtures/` | test pages; `tests/lib/` — Chrome over CDP, a server for the test pages, a `chrome.i18n` stub |

`tests/run.sh` exits with 0 only if everything passed. The page server picks a free port (or `HT_PORT`); Chrome
is found via `CHROME_PATH`, otherwise `google-chrome` / `chromium` in `PATH`. Chrome profiles and extension copies
go to a temporary folder (`HT_TMP`, or the system one) that is deleted afterwards. The live suites of one run share
a profile, so the models are downloaded once; set `HT_PROFILE=<folder>` to keep them between runs. A single suite
can also be run on its own: `node tests/live/languages.test.js en`.

### Package for the store

```sh
bash scripts/pack.sh
```

It checks that `manifest.json` and the locale files are valid and that every file they refer to exists, then
writes `dist/hover-translator-<version>.zip` (the contents of `hover-translate/` without `*.md` files) and prints
its size and file list.

Store texts and answers for the Developer Dashboard are in `store/` (`listing-en.md`, `listing-ru.md`,
`dashboard.md`).

## Contributing and support

Questions, bugs and ideas: [GitHub Issues](https://github.com/nikimix/hover-translator/issues). Please don’t post
your API keys there — issues are public.

## License

[MIT](LICENSE) © 2026 nikimix

The extension’s own pages use the [Inter](https://github.com/rsms/inter) font (© The Inter Project Authors), bundled
in `hover-translate/fonts/` under the SIL Open Font License 1.1 — see
[`hover-translate/fonts/OFL.txt`](hover-translate/fonts/OFL.txt).

Google Chrome is a trademark of Google LLC. DeepL, OpenAI and Anthropic are trademarks of their owners. This project
is not affiliated with or endorsed by them.
