# Developer Dashboard answers — Privacy practices and test instructions

What to type into the Chrome Web Store Developer Dashboard for version 1.0.0. Text in blocks is meant to be
pasted as is (English; justification blocks are under 1,000 characters, test instructions about 1,800). Checked against `hover-translate/manifest.json`,
`background.js` and `content.js` on 18.11.2026.

What the manifest actually declares:

| Manifest key | Value | Asked in the dashboard? |
|---|---|---|
| `permissions` | `storage`, `alarms` | yes — one field per permission |
| `host_permissions` | `https://api-free.deepl.com/*`, `https://api.deepl.com/*`, `https://api.openai.com/*`, `https://api.anthropic.com/*` | yes — “Host permission justification” |
| `content_scripts.matches` | `<all_urls>` (all frames, `document_idle`) | counted as host access — same field |
| `commands` | `toggle-enabled` (Alt+Shift+O), `translate-page` (Alt+Shift+G) | no — not a permission, no warning; text below in case a reviewer asks |
| not requested | `tabs`, `activeTab`, `scripting`, `contextMenus`, `unlimitedStorage`, `identity`, `cookies`, `history` | — |

`chrome.tabs.create / query / sendMessage / reload / get` are used without the `tabs` permission: the extension
never reads tab URLs or titles.

---

## Single purpose

```text
Translate text on web pages in place. The user points at text and presses a key (or rests the cursor, or clicks "Translate page"), and the extension replaces that text with its translation, keeping links and layout, or shows it in a small card. Translation is done by Chrome's built-in on-device translator by default, or, if the user chooses and explicitly agrees, by DeepL, OpenAI or Anthropic using the user's own API key. Everything else in the extension (language choice, shortcuts, turning it off per site, a small language panel) serves this one purpose.
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

**Host permission justification** (covers `<all_urls>` in content scripts and the four API hosts)

```text
Content script on all sites: the extension's purpose is translating the text the user points at on any website, so its content script must be present on every page and frame the user reads. It does nothing until the user acts (trigger key, hover with delay, or "Translate page"), changes only the text nodes of the element being translated, sends nothing on page load, and stays inactive on sites the user turns off.

Host permissions are limited to four translation API endpoints: api-free.deepl.com and api.deepl.com (DeepL Free/Pro keys), api.openai.com and api.anthropic.com. The background service worker calls only the one service the user selected, with the user's own key, and only after the user clicked "I agree" to sending text to that service. The built-in translator (default) needs no network access.
```

**commands** — not a permission, so the dashboard doesn’t ask. If a reviewer does:

```text
Two keyboard shortcuts the user can change at chrome://extensions/shortcuts: Alt+Shift+O turns translation on or off, Alt+Shift+G translates the current page (Ctrl+Shift+O / Ctrl+Shift+G on Mac).
```

## Remote code

Select **“No, I am not using remote code”**. If a justification is requested:

```text
All JavaScript is included in the package (background.js, content.js, shared.js, popup.js, welcome.js, builtin.js). The extension doesn't load scripts from the network, doesn't use eval() or new Function(), and has no WebAssembly. Responses from DeepL, OpenAI and Anthropic are data: the translated text is decoded to plain text and written with textContent/nodeValue; it is never executed or inserted as HTML.
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
| Web history | No | Page URLs and titles are never sent or recorded. Locally there is only the list of sites the user turned off (host names the user chose) and, for AI translations, the site origin used to keep saved translations separate per site — see the privacy policy. |
| User activity | No | The trigger key and pointer position are used only in the moment to find the text under the cursor; nothing is recorded, stored or sent. |
| **Website content** | **Yes** | The text the user asks to translate is sent to the selected service (DeepL, OpenAI or Anthropic) after explicit consent, and translations from these services are saved locally for 14 days. With the default built-in translator, text never leaves the device. |

### Certifications — check all three

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item’s single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

The only transfer is the one the user asks for: text (and the user’s own key) goes to the translation service the user
selected, which is necessary for the single purpose and happens only after a prominent in-product disclosure and an
“I agree” click (Limited Use: transfer to provide a user-facing feature). The disclosure is in the extension window,
not only in the policy: “The text you translate will be sent to DeepL using your key. The built-in translator doesn’t
send anything.” + **I agree**; consent is stored per service and can be withdrawn.

## Privacy policy URL

```text
https://GITHUB_USER.github.io/hover-translator/privacy.html
```

(Russian version: `…/privacy-ru.html`, linked from the English page.) The same URL goes into the developer account
settings if the dashboard asks for it there.

---

## Test instructions

No login is needed — leave the username and password fields empty. Paste into “Additional instructions”:

```text
No account, sign-up or API key is needed. By default the extension uses Chrome's built-in Translator API (Chrome 138+ on desktop), which runs on-device.

1. After installing, a welcome tab opens. In step 1, pick a translation language different from the pages you will test on (for example "Deutsch" or "Español" if you test on English pages). In step 2, click "Set up translator": Chrome downloads the language models once (usually under a minute, with a progress bar). Chrome allows this download only after a click, so please use the button.
2. Point at the sample text on the welcome page and press and release Shift: the text is replaced with its translation. Press Shift again to get the original back.
3. On a regular website (for example https://en.wikipedia.org/wiki/Translation; reload tabs opened before installing), point at a paragraph and press Shift. Esc restores the whole page. Click the toolbar icon and then "Translate page" (or press Alt+Shift+G, Ctrl+Shift+G on Mac) to translate the visible part of the page; the rest is translated while scrolling.
4. In the toolbar popup you can switch to "Hover" (translate after resting the cursor), turn translation off for the current site, or, under "More settings", show the result in a card next to the text.

Optional: DeepL and AI (OpenAI/Anthropic) need the tester's own API key and are not required to review the main functionality. In the popup, "Translation quality" > choose DeepL: nothing is sent until "I agree" is clicked and a key is pasted (a free key is available at https://www.deepl.com/pro-api).

Note: extensions don't run on chrome:// pages or the Chrome Web Store. If the built-in translator is unavailable in the test browser, the toolbar icon shows "!" and the popup explains why.
```

---

## Other fields (for reference)

- **Mature content:** No.
- **Payments / in-app purchases:** none — the extension is free; DeepL and AI are paid to those services directly, if the user chooses them.
- **Homepage URL:** `https://GITHUB_USER.github.io/hover-translator/`
- **Support URL:** `https://github.com/GITHUB_USER/hover-translator/issues`
