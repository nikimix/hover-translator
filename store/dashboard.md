# Developer Dashboard answers — Privacy practices and test instructions

What to type into the Chrome Web Store Developer Dashboard for version 1.1.0. Text in blocks is meant to be
pasted as is (English; justification blocks are under 1,000 characters, test instructions about 2,400). Checked against `hover-translate/manifest.json`,
`background.js`, `content.js` and `popup.js` on 18.11.2026; `contextMenus` (new in 1.1.0) — on 24.11.2026.

What the manifest actually declares:

| Manifest key | Value | Asked in the dashboard? |
|---|---|---|
| `permissions` | `storage`, `alarms`, `activeTab`, `contextMenus` | yes — one field per permission |
| `host_permissions` | `https://api-free.deepl.com/*`, `https://api.deepl.com/*`, `https://api.openai.com/*`, `https://api.anthropic.com/*` | yes — “Host permission justification” |
| `content_scripts.matches` | `<all_urls>` (all frames, `document_idle`) | counted as host access — same field |
| `commands` | `toggle-enabled` (Alt+Shift+O), `translate-page` (Alt+Shift+G) | no — not a permission, no warning; text below in case a reviewer asks |
| `options_ui` | `options.html`, opens in a tab | no — not a permission |
| not requested | `tabs`, `scripting`, `unlimitedStorage`, `identity`, `cookies`, `history` | — |

`chrome.tabs.create / query / sendMessage / reload / get` are used without the `tabs` permission. The only tab
address the extension reads is the URL of the active tab, in the toolbar popup, which `activeTab` exposes only when
the user opens the popup (clicks the icon, or uses a shortcut set for it). Titles, other tabs and history are never
read; the URL is not stored or sent. `activeTab` shows no warning at install.

---

## Single purpose

```text
Translate text on web pages in place. The user points at text and presses a key (or rests the cursor, or clicks "Translate page"), and the extension replaces that text with its translation, keeping links and layout, or shows it in a small card. Translation is done by Chrome's built-in on-device translator by default, or, if the user chooses and explicitly agrees, by DeepL, OpenAI or Anthropic using the user's own API key. Everything else in the extension (language choice, shortcuts, turning it off per site, a floating button for changing the language and translating the page, a right-click menu item for translating selected text) serves this one purpose.
```

## Permission justifications

**storage**

```text
Keeps the user's settings on their computer: target language, trigger key, how translations are shown, the chosen translator, the list of sites where translation is turned off, and the user's consent for each translation service. Also stores the user's own API keys (only if they paste one) and saved translations from DeepL/AI for up to 14 days, so the same text isn't sent and paid for twice. Nothing is synced or sent to the developer; the user can delete saved translations with one button.
```

**alarms**

```text
One periodic alarm (every 12 hours) removes saved translations older than 14 days and keeps them within their size budget, so that chrome.storage.local never fills up and the user's settings can always be saved.
```

**activeTab**

```text
When the user clicks the toolbar icon, the popup reads the URL of the current tab (chrome.tabs.query on the active tab, visible thanks to activeTab) to tell the user honestly whether translation can work there. Extensions can't run on Chrome's own pages or in the Chrome Web Store, so on those the popup says so instead of showing a button that does nothing; on a web page opened before the extension was installed it offers "Reload tab". While a page is still loading, the URL also gives the site name for the "Translate on <site>" switch. The URL is used only while the popup is open: it is not stored, not sent anywhere, and nothing is injected into the tab. activeTab is used instead of the broader "tabs" permission so that only the tab the user is looking at, and only after the user's click, is visible to the extension.
```

**contextMenus**

```text
Adds one item to the right-click menu: Translate "<selected text>". It appears only when the user has selected text on a regular web page (http, https or file), and not at all while translation is turned off everywhere. Choosing it translates the selected text and shows the translation in a small card next to the selection, the same way the trigger key does with the cursor over a selection; in the "No key" mode it is the only way to translate a selection. The selected text goes only where any other text the user translates goes: to Chrome's built-in on-device translator by default, or to DeepL/AI after explicit consent. The page address Chrome passes with the click is not stored or sent. In a tab opened before the extension was installed or updated, the item opens the extension's popup with a "Reload tab" button instead. contextMenus shows no warning at install.
```

**Host permission justification** (covers `<all_urls>` in content scripts and the four API hosts)

```text
Content script on all sites: the extension's purpose is translating the text the user points at on any website, so its content script must be present on every page and frame the user reads. It does nothing until the user acts (trigger key, hover with delay, the right-click menu item, or "Translate page"), changes only the text nodes of the element being translated, sends nothing on page load, and stays inactive on sites the user turns off.

Host permissions are limited to four translation API endpoints: api-free.deepl.com and api.deepl.com (DeepL Free/Pro keys), api.openai.com and api.anthropic.com. The background service worker calls only the one service the user selected, with the user's own key, and only after the user clicked "Allow sending" for that service. The built-in translator (default) needs no network access.
```

**commands** — not a permission, so the dashboard doesn’t ask. If a reviewer does:

```text
Two keyboard shortcuts the user can change at chrome://extensions/shortcuts: Alt+Shift+O turns translation on or off, Alt+Shift+G translates the current page (Ctrl+Shift+O / Ctrl+Shift+G on Mac).
```

## Remote code

Select **“No, I am not using remote code”**. If a justification is requested:

```text
All JavaScript is included in the package (background.js, content.js, shared.js, popup.js, options.js, welcome.js, builtin.js, ui.js), and so is the font. The extension doesn't load scripts from the network, doesn't use eval() or new Function(), and has no WebAssembly. Responses from DeepL, OpenAI and Anthropic are data: the translated text is decoded to plain text and written with textContent/nodeValue; it is never executed or inserted as HTML.
```

## Data usage

### What user data is collected (handled)

| Category | Check? | Why |
|---|---|---|
| Personally identifiable information | No | No name, email, address or ID is asked for or read. |
| Health information | No | — |
| Financial and payment information | No | The extension doesn’t handle payments; AI usage is billed by the provider to the user’s own account. |
| **Authentication information** | **Yes** | The user may paste their own API key for DeepL, OpenAI or Anthropic. It is a credential: stored in `chrome.storage.local` on the user’s computer and sent in the request header to the service that issued it (`Authorization: DeepL-Auth-Key …`, `Authorization: Bearer …`, `x-api-key`). The developer never receives it. Declaring it keeps the form consistent with the privacy policy, which describes how keys are stored and sent; leaving it unchecked would be a mismatch a reviewer can point to. |
| Personal communications | No | Text from a page (including webmail) is covered by “Website content”; the extension doesn’t read messages on its own. |
| Location | No | No location is read. The provider sees the user’s IP address as with any request — the extension doesn’t collect or send it. |
| Web history | No | Page URLs and titles are never sent or recorded. The popup looks at the active tab’s URL only while it is open (`activeTab`, see above) and keeps nothing. Locally there is only the list of sites the user turned off (host names the user chose) and, for AI translations, the site origin used to keep saved translations separate per site — see the privacy policy. |
| User activity | No | The trigger key, pointer position and text selection are used only in the moment to find the text to translate; nothing is recorded, stored or sent. |
| **Website content** | **Yes** | The text the user asks to translate is sent to the selected service (DeepL, OpenAI or Anthropic) after explicit consent, and translations from these services are saved locally for 14 days. With the default built-in translator, text never leaves the device. |

### Certifications — check all three

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item’s single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

The only transfer is the one the user asks for: text (and the user’s own key) goes to the translation service the user
selected, which is necessary for the single purpose and happens only after a prominent in-product disclosure and an
“Allow sending” click (Limited Use: transfer to provide a user-facing feature). The disclosure is in the product, not
only in the policy: connecting DeepL or AI on the settings page starts with the step “Send text to DeepL? The text you
translate will go to DeepL. The built-in translator sends nothing.” + **Allow sending**, and the extension window asks
the same if consent is missing. The translator switches to the service only after consent and a working key; consent
is stored per service and can be withdrawn (“Withdraw consent”).

## Privacy policy URL

```text
https://nikimix.github.io/hover-translator/privacy.html
```

(Russian version: `…/privacy-ru.html`, linked from the English page.) The same URL goes into the developer account
settings if the dashboard asks for it there.

---

## Test instructions

No login is needed — leave the username and password fields empty. Paste into “Additional instructions”:

```text
No account, sign-up or API key is needed. By default the extension uses Chrome's built-in Translator API (Chrome 138+ on desktop), which runs on-device.

1. After installing, a welcome tab opens. In step 1, pick a translation language different from the pages you will test on (for example "Deutsch" or "Español" if you test on English pages). In step 2, click "Download translator": Chrome downloads it once (usually under a minute, with a progress bar). Chrome allows this download only after a click, so please use the button.
2. Point at the sample text on the welcome page and press and release Shift: the text is replaced with its translation. Press Shift again to get the original back.
3. On a regular website (for example https://en.wikipedia.org/wiki/Translation; reload tabs opened before installing), point at a paragraph and press Shift. Esc restores the whole page. Click the toolbar icon and then "Translate page" (or press Alt+Shift+G, Ctrl+Shift+G on Mac) to translate the visible part of the page; the popup shows the progress and a Stop button, and the rest is translated while scrolling. Then "Original | Translation" in the popup switches between the two.
4. Select a few words on a page and press Shift with the cursor over the selection, or right-click it and choose Translate "...": the translation appears in a card next to the selection, and the page stays as it is.
5. In the popup you can also turn translation off for the current site. The gear icon in the popup (or right-click the toolbar icon > Options) opens the settings page: there you can choose "No key" (translate after resting the cursor) or show the result in a card next to the text.

Optional: DeepL and AI (OpenAI/Anthropic) need the tester's own API key and are not required to review the main functionality. On the settings page, under "Translator", choose DeepL: it is connected in three steps (Consent, Key, Done). Nothing is sent until "Allow sending" is clicked and a working key is pasted (a free key is available at https://www.deepl.com/pro-api); the extension switches to DeepL only at "Done".

Note: extensions don't run on chrome:// pages or the Chrome Web Store; on such a tab the popup says that translation doesn't work there. If the built-in translator is unavailable in the test browser, the toolbar icon shows "!" and the popup explains why.
```

---

## Other fields (for reference)

- **Mature content:** No.
- **Payments / in-app purchases:** none — the extension is free; DeepL and AI are paid to those services directly, if the user chooses them.
- **Homepage URL:** `https://nikimix.github.io/hover-translator/`
- **Support URL:** `https://github.com/nikimix/hover-translator/issues`
