# ChatGPT selector overrides

`providers/chatgpt.js` stays a hand-written code provider (Cloudflare challenge
detection, reasoning skip, too-long and rate-limit detection). Its DOM selectors
can be edited from the Providers page without touching that code.

- Providers page > Built-in > chatgpt > Edit. The form and the Pick buttons work as for
  custom providers. Save writes to `chrome.storage.local["chatgpt_overrides"]`
  (browser storage on this machine; nothing is sent to the server or written to disk).
- Saved shape: `{ schema: 1, savedAt, selectors: { input, send, stop, response } }`. Data only.
- Mapping: UI `response` -> `SEL.assistant`. `user`, `challenge` and `notice` have no
  UI field and always keep their defaults. `code`, `exclude`, `dismiss`, timeouts,
  extraction and completion fields are ignored for chatgpt.
- A saved list replaces the default list for that key (the form shows the effective
  list). An empty `stop` keeps the default. Invalid or oversized entries are dropped.
- The provider reads the override at the start of `ensureChat`, `sendPrompt` and
  `checkState`, so changes apply on the next request with no reload. The ChatGPT tab
  console logs `[dsc:chatgpt] merged N selectors from storage` (N = selectors taken
  from storage; 0 = defaults).
- Reset (shown while an override exists) removes the key and restores the defaults.
- Changing `shared.js` bumps `BUILD_HASH`; restart the server after pulling, because it
  reads the hash only at startup.
