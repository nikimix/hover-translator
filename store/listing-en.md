# Chrome Web Store listing — English

Default locale of the extension (`default_locale: "en"`). Paste the texts below into the Developer Dashboard →
**Store listing** with the language set to **English**.

## Name

`Hover Translator — Translate Text In Place` (42 characters, limit 75)

Comes from the package: `extName` in `hover-translate/_locales/en/messages.json` (manifest `name`). It can't be
edited in the dashboard. The short name in the toolbar is `Hover Translator` (`extShortName`).

## Summary (short description)

```text
Hover over any text and press Shift to translate it in place. Free and private with Chrome’s built-in translator, no sign-up.
```

125 characters (limit 132). The store takes the summary from the package — `extDescription` in
`hover-translate/_locales/en/messages.json` (manifest `description`) — so to change it, change that message and
upload a new package. “Private” refers to the default built-in translator; the description below says when text
does leave the computer.

## Category

**Productivity → Tools** (the category is one for all languages). If the dashboard offers it, “Education” is a
reasonable second choice, but translators are usually listed under Tools.

## Detailed description

Plain text: the store doesn’t render Markdown. Copy everything inside the block.

```text
Hover Translator translates text right where it is. Point at a paragraph, heading, list item or table cell and press Shift: the words are replaced with their translation, while links, bold text and the layout stay as they were. Press again to see the original, or Esc to restore the whole page.

It works right after installing: no account, no sign-up, no key. By default it uses the translator built into Google Chrome™, which runs on your computer, so what you read stays private.

An unfamiliar word or phrase? Select it and do the same, or use the item with the extension’s icon in the right-click menu: the translation appears in a card next to the selection, and nothing else changes.

HOW TO START
1. Install the extension. A welcome tab opens.
2. Choose the language you want and click “Download translator”. The browser downloads it once, for free, and you can try it right there.
3. Point at any text and press Shift.
Tabs that were open before installing need to be reloaded.

FEATURES
• Inline translation in place, or in a card next to the text if you’d like to keep the original visible.
• Page translator: “Translate page” handles what’s on screen first and the rest as you scroll down. Stop it at any time, then switch between Original and Translation in one click.
• Hover mode: just rest the cursor on a sentence, no keypress needed (links, buttons and menus are skipped). You can also choose Alt or Ctrl as the trigger.
• A compact toolbar window for everyday actions, and a separate settings tab for the rest.
• A floating button to switch languages without opening the settings.
• Turn it off on a particular site, such as your email or bank.
• A list of names and terms to keep as they are (DeepL and AI only).
• 121 target languages; each service supports its own set.
• English and Russian interface, light and dark theme.

SERVICES AND PRIVACY
• Built-in (default): free, works on your computer, even offline once the models are downloaded. Nothing leaves your device.
• DeepL: more accurate, uses your own API key (the free API plan includes 500,000 characters a month).
• AI: uses your own OpenAI or Anthropic API key; billed to your account.
DeepL and AI stay off until you select one, allow sending text to that service and add a working key. Only the passages you ask for are sent, straight from your browser to that service, never the URL. Keys stay in your browser. Their results are saved on your computer for 14 days, so the same sentence isn’t paid for twice.
The extension has no server of its own, no analytics and no ads. Its source code is open on GitHub.

KEYBOARD SHORTCUTS
• Shift (or Alt / Ctrl): translate the passage or selection under the cursor; press again for the original
• Esc: show the original everywhere
• Alt+Shift+O: turn translation on or off
• Alt+Shift+G: translate the whole page
On a Mac, use Ctrl instead of Alt. You can change them at chrome://extensions/shortcuts.

LIMITATIONS
• The built-in translator needs Chrome 138 or newer on a computer and may be missing in other Chromium-based browsers. Without it, connect one of the other services with your key.
• Extensions can’t run on the browser’s own settings pages, the Chrome Web Store and some embedded frames.
• Blocks longer than 2,000 characters are skipped.
• “Translate page” covers up to 500 blocks at once, and content that loads later isn’t picked up automatically: just point at it.

Google Chrome is a trademark of Google LLC. DeepL, OpenAI and Anthropic are trademarks of their respective owners. This extension is not affiliated with or endorsed by them.
```

3363 characters. Checked against the store rules:

- no word other than “the/and/to…” appears more than 5 times (Shift, Alt, page, key, Chrome, text, translator,
  original, own — 5 each);
- the keywords appear naturally, once or twice: hover, translator, in place, inline, page translator, free, private;
- third-party names are used only as compatibility (“uses your own OpenAI or Anthropic API key”), at most 4 brands
  (Google Chrome, DeepL, OpenAI, Anthropic), with the trademark notice at the end and “Google Chrome™” on first use;
- no superlatives, no comparisons with other extensions, no ratings or testimonials;
- every claim matches the code of version 1.1.0 (limits: 2,000 characters per block or selection, 500 blocks per
  “Translate page”, saved translations for 14 days, built-in translator needs Chrome 138+).

## Graphic assets

| Field | File | Notes |
|---|---|---|
| Store icon (128×128) | `hover-translate/icons/128.png` | the same as in the package |
| Screenshots (1280×800), up to 5 | `store/images/en/screenshot-1.png` … `screenshot-5.png` | upload in this order |
| Small promo tile (440×280) | `store/images/en/promo-small-440x280.png` | promo tiles can’t be localized — this one is shown in every language |
| Marquee promo tile (1400×560) | `store/images/en/promo-marquee-1400x560.png` | optional; also not localized |
| Video | — | optional; can be added later |

## Links

| Field | Value |
|---|---|
| Homepage URL | `https://nikimix.github.io/hover-translator/` |
| Support URL | `https://github.com/nikimix/hover-translator/issues` |
| Privacy policy (Privacy practices tab) | `https://nikimix.github.io/hover-translator/privacy.html` |
| Official URL | leave empty (needs a site verified in Google Search Console) |

Replace `nikimix` once the repository exists.
