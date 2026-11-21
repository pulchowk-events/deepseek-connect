# Providers

> **Current flow (config providers).** A provider is a file, `providers/<name>.js`, containing one
> `DSC.makeConfigProvider({...})` call. Adding one needs **zero edits to existing files**:
> open the extension popup, click **Providers...**, fill the form (or click **Seed GLM**), and Save.
> The Providers page POSTs the definition to the local server (`POST /providers`), which validates it,
> renders the file from a fixed template (no caller-supplied JS is ever written), and writes it with
> `wx` (never overwrites). The page then requests the host permission, registers a content script
> (`dsc-provider-<name>`), and injects into matching open tabs. The file is a normal committable
> artifact. If the server is down, Save falls back to a file picker/download and skips registration.
>
> If injection reports the file was not found, click **Reload extension** once (Chrome may not serve
> files added after load on some setups).
>
> Schema (`schema: 1`): `name`, `label`, `domains` (plain hostnames), `selectors.{input,send,response}`
> (arrays, first match wins), optional `selectors.{stop,code}`, `dismiss`, `exclude`, `timeouts.{sendMs,responseMs}`
> (defaults 15000/180000), `pacingMs`, `extraction` (`rawText` | `codeBlock` | `delimiter`),
> `delimiter.{prefix,suffix}`, `completionMode` (`whichever` | `stopGone` | `textStable` | `delimiter`),
> `completionStableMs`. `enabled` is per-machine state in `chrome.storage.local` (`dsc_registered`),
> not part of the file.
>
> DeepSeek and Qwen remain code modules (DeepThink toggle, age modal). The **five steps** and
> **three registrations** sections below describe the legacy code-module flow only. Corrections to the
> text below: `providerForUrl` matches exact hostnames (not `startsWith`); there is no default provider
> (the server refuses a missing one); the server whitelist is `providers/*.js` plus the built-ins.
>
> **Use the Providers page for ordinary additions.** The code-module contract and manual registration
> walkthrough are maintainer notes for built-in drivers; they are not the current config-provider flow.


How to add a new provider, understand the plugin contract, and debug a provider that isn't routing correctly. This is the doc that makes `deepseek-connect` extensible — without it, "add a provider" means reverse-engineering `qwen.js` and hoping.

Companion docs: [architecture.md](architecture.md) explains the plugin registry as a load-bearing decision; [protocol.md](protocol.md) has the wire shapes that `provider` travels through; [selector-maintenance.md](selector-maintenance.md) is the recovery playbook when a provider's DOM changes.

**Contents**
- [What a provider is](#what-a-provider-is)
- [The contract](#the-contract)
- [Adding a provider in five steps](#adding-a-provider-in-five-steps)
- [The registration checklist](#the-registration-checklist)
- [Case study: Qwen](#case-study-qwen)
- [Testing a new provider](#testing-a-new-provider)
- [Reload discipline](#reload-discipline)
- [What not to put in a provider](#what-not-to-put-in-a-provider)
- [Known provider quirks](#known-provider-quirks)

---

## What a provider is

The extension drives a browser tab. To drive a tab, it needs to know four things about the provider whose page is loaded:

1. How to find the chat input and the send button on this page
2. How to type a prompt and click send, and how long to wait between those actions
3. How to detect when the assistant's reply has finished streaming
4. How to read the reply text out of the DOM

Every provider has different answers. DeepSeek uses a textarea with an aria-labeled send button and streams an answer into `.ds-assistant-message-main-content`. Qwen uses a different textarea, a different send button, a different reply element, and also shows an age-verification modal on first use that needs to be dismissed before anything else can happen.

The provider contract isolates those four answers behind a small interface. Everything above it — `content.js` routing, `background.js` tab selection, `src/server.js` queueing, `src/client.js` HTTP — works identically regardless of which provider answers.

```
┌──────────────────────────────────────────────────┐
│  src/server.js (queue)                            │
│  src/client.js (HTTP)                             │
│  background.js (tab routing, message dispatch)    │
│  content.js (router)                              │
└──────────────────────┬───────────────────────────┘
                       │  sendMessage({ action, provider, ... })
                       ▼
              ┌────────────────────┐
              │  provider module   │
              │  (deepseek, qwen,  │
              │   claude, ...)     │
              └────────────────────┘
                       │  provider-specific DOM work
                       ▼
                ┌──────────────┐
                │  browser tab │
                └──────────────┘
```

Everything above the provider module is provider-agnostic. Adding a provider means writing the bottom box and registering it in three places.

## The contract

A provider is an object with one property and four methods:

```js
globalThis.DSC_PROVIDERS['<name>'] = {
  name: '<name>',

  async ensureChat(chatName) {
    // Ensure the page is ready to receive a prompt.
    // Called once per source, before every sendPrompt.
    // Returns:
    //   { ok: true, existing: boolean, mode: 'existing'|'fresh', debug: {...} }
    //   OR
    //   { ok: false, error: 'chat_not_found'|'input_not_found', reason: string, debug: {...} }
    //   OR
    //   { ok: false, needNewChat: true }  (background will navigate to / and retry)
  },

  async sendPrompt(prompt, delimiters) {
    // Type the prompt, click send, wait for completion, extract the reply.
    // delimiters is { start, end } — provider may ignore and use its own.
    // Returns:
    //   { content: string, raw: string, url: string, source: string, trace: array }
    //   OR
    //   { error: 'rate_limited'|'input_not_found'|..., reason: string, trace: array }
  },

  async checkState() {
    // Read the current page state without changing it.
    // Returns:
    //   { inputFound: boolean, currentChatName?: string, deepThinkOn?: boolean, ... }
  },

  async resetChat(chatName) {
    // Reset the named chat. May be a no-op on providers with no delete UI.
    // Returns:
    //   { ok: true, reason?: string }
  },
};
```

Four methods, one property. That's the entire interface.

**`url` in `sendPrompt`'s return is mandatory.** It's how the wizard persists the chat identity for URL-based retry. If your provider can't produce a stable URL, return `null` and `open { url }` will fall through to the sidebar walk on retry (which may or may not work, depending on the provider).

**`trace` is mandatory in `sendPrompt`'s return, even on failure.** It carries per-phase timing to the server log. See [protocol.md#post-progress](protocol.md#post-progress) for the shape — an array of `{ t, phase, ...extra }` objects. A provider that omits trace breaks the `~ <id8> <phase>` live logging the wizard depends on.

**Gate each UI transition on observed state.** Before filling, wait for a complete, stable page, a visible/enabled empty input, and no active generation control; verify the existing response is stable where response selectors are available. After filling, read the input back and re-check that the page, input, and enabled send control still match the expected state. Click once only, then wait for UI evidence that submission was accepted. Emit progress phases for checks and observed state using the request ID. Built-in drivers use a 1-second minimum inter-stage pause; config drivers honor their configured pacing with a 1-second floor. If a provider exposes no reliable generation control, document that limitation and use stable response observation rather than claiming certain idleness.

**`debug` in `ensureChat`'s return is strongly encouraged.** It's surfaced in `/open`'s response, which is the only way to diagnose why a sidebar walk failed without opening F12 on the work tab.

Everything else — selector strategy, pacing, modal dismissal, delimiter enforcement — is provider-specific and belongs inside the provider module.

## Adding a provider in five steps

Example: adding `claude` for `claude.ai`.

### 1. Add the domain to `DSC.PROVIDER_DOMAINS`

In `shared.js`, find `PROVIDER_DOMAINS` and add the entry:

```js
PROVIDER_DOMAINS: {
  deepseek: 'https://chat.deepseek.com/',
  qwen: 'https://chat.qwen.ai/',
  tongyi: 'https://tongyi.aliyun.com/',
  claude: 'https://claude.ai/',          // <-- new
},
```

`DSC.providerForUrl(url)` reads this map. `background.js#getWorkTab(provider)` reads this map. Adding the entry here is what makes `/chat { provider: 'claude' }` route to the claude.ai tab.

**Routing compares parsed hostnames exactly.** `https://claude.ai.attacker.com` must never match `claude.ai`; do not implement hostname routing with string-prefix checks. Provider URL records should use the canonical provider origin.

### 2. Update `manifest.json`

Two places. First, `host_permissions` and `content_scripts.matches`:

```json
{
  "host_permissions": [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "file:///*",
    "https://chat.deepseek.com/*",
    "https://chat.qwen.ai/*",
    "https://tongyi.aliyun.com/*",
    "https://claude.ai/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://chat.deepseek.com/*",
        "https://chat.qwen.ai/*",
        "https://tongyi.aliyun.com/*",
        "https://claude.ai/*",
        "file:///*mock-deepseek.html"
      ],
      "js": [
        "shared.js",
        "selectors.js",
        "providers/deepseek.js",
        "providers/qwen.js",
        "providers/claude.js",
        "content.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

Order matters in `content_scripts.js`. `shared.js` must come first (it defines `globalThis.DSC`). `content.js` must come last (it routes to providers that must already be registered). Provider files can come in any order between those two.

If the provider's tab loads anything from a subdomain (e.g., `assets.claude.ai`), add the necessary host permissions. Routing matches the provider's configured hostname exactly; it does not depend on a sticky work tab.

### 3. Update `background.js`'s `sendToTab` re-injection list

When the content script crashes and needs to be re-injected, `background.js` runs `chrome.scripting.executeScript` with a hardcoded file list. That list must include the new provider:

```js
await chrome.scripting.executeScript({
  target: { tabId },
  files: [
    'shared.js',
    'selectors.js',
    'providers/deepseek.js',
    'providers/qwen.js',
    'providers/claude.js',    // <-- new
    'content.js',
  ],
});
```

Forgetting this means a mid-run crash re-injects only the old providers. A missing provider module is an internal registration failure, not a registered public `DSCError` code.

### 4. Create `providers/claude.js`

The provider module. Self-contained — no imports from other files, no dependence on `globalThis.DSC_SELECTORS` unless the provider wants to reuse DeepSeek's selectors (which are DeepSeek-specific, so a Claude provider wouldn't).

Minimal skeleton:

```js
// providers/claude.js -- DOM manipulation for Claude.ai
'use strict';

(function () {
  const DSC = globalThis.DSC;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  async function waitFor(fn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  function findInput() {
    return (
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('textarea')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[aria-label*="send" i]') ||
      document.querySelector('button[type="submit"]')
    );
  }

  async function ensureChat(name) {
    const input = await waitFor(() => {
      const el = findInput();
      return el && visible(el) ? el : null;
    }, 5000);

    if (!input) {
      return { ok: false, error: DSC.ERR.INPUT_NOT_FOUND, reason: 'input_not_found' };
    }
    return { ok: true, existing: false, mode: 'fresh' };
  }

  async function sendPrompt(prompt, delimiters) {
    const startedAt = Date.now();
    const trace = [];
    const T = (phase, extra) => {
      try { chrome.runtime.sendMessage({ type: 'dsc_phase', phase, extra }).catch(() => {}); } catch (_) {}
      trace.push(Object.assign({ t: Date.now() - startedAt, phase }, extra || {}));
    };
    const fail = (error, reason, extra) =>
      Object.assign({ error, reason, trace, elapsedMs: Date.now() - startedAt }, extra || {});

    const input = await waitFor(findInput, 5000);
    if (!input) return fail(DSC.ERR.INPUT_NOT_FOUND, 'input_not_found_after_wait');

    // Type the prompt. For contenteditable, use execCommand.
    input.focus();
    document.execCommand('insertText', false, prompt);
    await sleep(300);

    const sendBtn = findSendButton();
    if (!sendBtn) return fail(DSC.ERR.SEND_FAILED, 'send_button_not_found');
    sendBtn.click();
    T('sendClick');

    // Wait for reply. This is provider-specific -- Claude streams a reply
    // into a series of divs. The exact selector depends on Claude's DOM.
    // For the skeleton, wait until the last message stops growing for 2s.
    const streamUrl = location.href;
    let lastLen = 0;
    let stableSince = 0;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(500);
      const msgs = document.querySelectorAll('[class*="message" i]');
      const last = msgs[msgs.length - 1];
      const txt = last ? (last.textContent || '').trim() : '';
      if (txt.length > 0) {
        if (txt.length !== lastLen) {
          lastLen = txt.length;
          stableSince = Date.now();
          T('answer', { len: lastLen });
        } else if (Date.now() - stableSince >= 2000) {
          T('replyDone', { stableLen: lastLen });
          return {
            content: txt,
            raw: txt,
            url: streamUrl,
            source: 'raw',
            trace,
          };
        }
      }
    }
    return fail(DSC.ERR.RESPONSE_TIMEOUT, 'completion_timeout');
  }

  async function checkState() {
    const input = findInput();
    return { inputFound: !!input, currentChatName: document.title };
  }

  async function resetChat(name) {
    return { ok: true, reason: 'reset_not_implemented' };
  }

  globalThis.DSC_PROVIDERS = globalThis.DSC_PROVIDERS || {};
  globalThis.DSC_PROVIDERS['claude'] = {
    name: 'claude',
    ensureChat,
    sendPrompt,
    checkState,
    resetChat,
  };

  console.debug('[dsc:registry] claude provider registered');
})();
```

The skeleton is functional but not production-ready. A real Claude provider would need:

- The correct streaming-completion detector (Claude shows a "stop generating" button while streaming and removes it when done — that's the reliable signal, not text-stability)
- The correct reply-block selector (`.font-claude-message` at the time of writing, but this changes)
- The correct URL pattern for chat identity (`https://claude.ai/chat/<uuid>`)

The point of the skeleton is to show the shape. Every provider-specific detail goes inside the IIFE, nowhere else.

### 5. Register it (the checklist below)

The next section.

## The registration checklist

A new provider needs exactly **three** registrations. Missing any of them produces a specific, confusing failure mode.

| Registration | File | Missing means |
|---|---|---|
| Provider host definition and permissions | Shared/config setup and extension manifest | The tab is not recognized or the extension cannot access it. Current work requests fail with `ambiguous_provider_tab` if there is not exactly one provider match. |
| `providers/<name>.js` in built-in `content_scripts.js` | `manifest.json` | The built-in module is not loaded. Inspect the tab's extension console and registration diagnostics; public errors may be normalized to `internal_error`. |
| `providers/<name>.js` in the `sendToTab` re-injection `files` array | `background.js` | A re-injected tab may lack the built-in provider module. Test initial load and reinjection after any registration change. |

Three places, one file each. If any provider-specific logic ever lives outside `providers/<name>.js`, that's a bug — the router is deliberately blind, and everything provider-specific belongs inside the module.

## Case study: Qwen

`providers/qwen.js` demonstrates three patterns that a new provider might need, and none of them are documented in the minimal skeleton above. Reading Qwen's implementation is the best way to see what a real provider looks like.

### Pattern 1: modal dismissal

Qwen shows a "Confirm your age" modal on first use per session. The modal blocks the input field, so any `sendPrompt` that fires before it's dismissed fails with `input_not_found` even though the input is technically present in the DOM (behind the modal's z-index).

The Qwen provider runs `dismissAgeModal()` at the top of **every** action:

```js
async function sendPrompt(prompt, delimiters) {
  dismissAgeModal();
  // ...
}

async function ensureChat(name) {
  dismissAgeModal();
  // ...
}

async function checkState() {
  dismissAgeModal();
  // ...
}
```

The dismisser hunts for `.ant-modal-container.qwen-chat-v2-modal-container`, finds the "Continue" button, and clicks it. If the modal isn't present, it returns immediately — the cost of calling it on every action is negligible, and the cost of missing it once is a confusing `input_not_found`.

**The general principle:** if the provider has any UI element that sometimes blocks the input (modal, cookie banner, paywall prompt, welcome screen), run the dismisser at the top of every action, not just the first. Modals can appear between prompts, and the safe pattern is "check every time."

### Pattern 2: anti-bot pacing

Qwen's React app gets overloaded if you type-and-send in under ~100ms. It either drops the send event or triggers the age modal as a "you're acting like a bot" defense. The Qwen provider inserts explicit `sleep()` calls between every action:

```js
await sleep(1000);   // wait for modals to settle
const input = await waitFor(...);
await sleep(1000);   // ensure UI is stable before typing
setInputValue(input, prompt);
await sleep(1500);   // let React register the input value
sendBtn.click();
await sleep(1500);   // wait for the network request to initiate
```

Every one of those is in the trace as a `step_N_*` phase, so if pacing changes are needed, the log shows exactly where time went. Total pre-send time is ~5 seconds — slow but reliable. A batch of 76 sources takes 76 × (5s overhead + 3-8s response) = ~10 minutes, which is faster than the clipboard loop and doesn't fail.

**The general principle:** if the provider's UI is React-based (most are), assume the send click needs a beat to register. Start with 300ms and increase only if the failure mode is "send didn't happen." Under-pacing produces "the input has text but no message appears," which is harder to diagnose than "the whole thing took 2 seconds longer."

### Pattern 3: strict delimiter enforcement

DeepSeek lets the caller decide on delimiters. Qwen does not — it hardcodes `START_QWEN_REPLY` / `END_QWEN_REPLY` and **appends** a delimiter instruction to the caller's prompt:

```js
const delimiterStart = (delimiters && delimiters.start) || 'START_QWEN_REPLY';
const delimiterEnd = (delimiters && delimiters.end) || 'END_QWEN_REPLY';
const enforcedPrompt = prompt +
  `\n\nIMPORTANT: You MUST wrap your ENTIRE response between ` +
  `${delimiterStart} and ${delimiterEnd}. ` +
  `Do not include any other text, thinking process, or greetings ` +
  `outside these markers.`;
```

Then, when the reply comes back, Qwen's completion loop **only** breaks when both delimiters are detected in the DOM. If the delimiters are missing at the end, it fails with `invalid_response_format` rather than returning whatever text happened to be present.

Why so strict? Qwen streams a "Thinking..." preamble before the answer, and the preamble satisfies DeepSeek-style "wait for answer to stabilize" detectors, returning "Thinking..." as the content. Requiring the delimiters eliminates the false positive: if the delimiters aren't there, the answer isn't done yet, regardless of what the DOM contains.

**The general principle:** a provider whose model produces preamble text (thinking blocks, "let me help with that," reasoning streams) needs **either** a reliable DOM signal that preamble is over **or** strict caller-enforced delimiters. Qwen chose delimiters because its DOM signal is unreliable across versions. Other providers can choose the DOM signal — DeepSeek uses `.ds-assistant-message-main-content` as the "this is the actual answer" marker. The one thing that doesn't work is "read the whole message text and hope it's the answer."

## Testing a new provider

Three-level testing ladder, same as the rest of the repo.

### Level 1 — the provider loads and registers

Open the provider's tab (`https://claude.ai/`, or wherever). F12 → Console. Look for:

```
[dsc:registry] claude provider registered
[dsc:router] content router loaded, active providers: ['deepseek', 'qwen', 'claude']
[dsc:router:diag] { href: "https://claude.ai/...", registeredProviders: [...], ... }
```

If `registeredProviders` is missing `claude`, the `manifest.json` patch (step 2) didn't take. Reload the extension and hard-reload the tab.

If the provider registers but the router's diagnostic shows a different URL than expected, the tab's `host_permissions` entry might be wrong — the content script injects but on the wrong pages.

### Level 2 — the provider routes

Send a minimal `/chat` through curl with `provider: 'claude'`:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: ping"}],"chat":"claude-test","provider":"claude"}' \
  | python3 -m json.tool
```

Expected on success: `{ content: "ping", chat: "claude-test", url: "https://claude.ai/chat/...", elapsedMs: N }`.

Expected current failures include `ambiguous_provider_tab` (missing/duplicate provider tab), `input_not_found` (input unavailable), and `response_timeout` (completion detector did not finish). A response timeout may occur after the prompt was submitted; inspect the provider tab before retrying. Provider registration problems may surface as `internal_error`.

The error code itself is the diagnosis. Match it against the three registrations:

| Error | Registration missing |
|---|---|
| `internal_error` with registration diagnostics | Built-in script load or config-provider registration |
| `ambiguous_provider_tab` | Exact provider hostname and number of open matching tabs |
| Works once, fails on retry | `background.js` `sendToTab` re-injection list |
| `input_not_found` after successful `ensureChat` | Provider's `findInput` selector is wrong |
| `response_timeout` | Provider's completion detector never fires |

### Level 3 — the provider survives real content

Send a real prompt that produces a real answer — the kind the wizard will send. For a batch wizard, that means a prompt with `START_<file>` / `END_<file>` delimiters, or whatever the wizard's delimiter convention is. Confirm the extracted `content` is the extractor code, not preamble, not thinking text, not the whole message.

If the content includes prose before the code, the completion detector is too lax — it stopped before the answer was done. If the content is missing the code entirely, the completion detector stopped on the reasoning stream. Both are provider-side bugs, not router-side.

## Reload discipline

The single most common "my provider isn't loading" mistake. Reloading the extension is **not enough**.

When you change any of:

- `providers/<name>.js`
- `content.js`
- `selectors.js`
- `shared.js`
- `manifest.json`

…you must **reload the extension** AND **hard-reload every open provider tab** (Ctrl+Shift+R). The extension reload restarts the service worker but does not re-inject content scripts into already-open tabs. The tab keeps running the old provider modules, and your new ones never load.

For a provider addition specifically, close all provider tabs first, then reload the extension, then open exactly one fresh tab to the target provider. This kills orphaned content script instances and gives you a clean slate. The full sequence:

1. Close every DeepSeek, Qwen, Claude (etc.) tab
2. Ctrl+C the server, then `node --env-file=.env src/server.js` again
3. Reload the extension in `brave://extensions`
4. Open a single fresh tab to the new provider
5. Hard-reload it (Ctrl+Shift+R)
6. Check F12 console for the `[dsc:registry]` log lines

Skipping any step leaves a stale service worker or a stale content script, and the symptom is always the same: "the code on disk is correct but the extension isn't seeing it."

Full details in [operations.md#reload-discipline](operations.md#reload-discipline).

## What not to put in a provider

Four things that look like they belong in a provider but don't.

**1. Server-side state.** Providers don't know the server exists. They receive `msg.action` and `msg.provider` from `background.js` and return objects. Any per-source state — chat identity, retry count, rate-limit backoff — lives in the server, the aggregator, or `chat-map.json`. A provider that "remembers" something across requests via a module-level variable will break the moment the tab reloads.

**2. Cross-provider logic.** A provider should never import from another provider or check whether a second provider is registered. The router handles dispatch; each provider only knows about its own tab.

**3. Error taxonomy changes.** If a provider needs a new error code (Qwen needed `invalid_response_format`), the code is added to `src/errors.js` in a separate commit, not raised ad-hoc from the provider. A provider that raises `fail('some_new_error', ...)` with an unregistered code produces `internal_error` at the client — the wizard can't switch on it, and the failure is indistinguishable from a genuine internal bug.

**4. UI rendering.** No `console.log` beyond the one `[dsc:registry] <name> provider registered` line. No progress reporting beyond `dsc_phase` messages — the wizard renders those, not the provider. The provider is silent by design; everything user-facing goes through the trace / progress path.

## Known provider quirks

Reference table for the two shipped providers. Useful when debugging or when writing a third.

### DeepSeek (`providers/deepseek.js`)

| Quirk | Handling |
|---|---|
| DeepThink and Search toggles must be ON | Verified before every send. Hard-fail with `deepthink_enable_failed` / `search_enable_failed` if either can't be verified. |
| Reasoning stream finishes before answer starts | Completion detector gates on `.ds-assistant-message-main-content` appearing. Before that point, `lastAssistantText` returns null and the loop continues. |
| Sidebar titles are paraphrased from first message | DeepSeek rewrites "reuse-test-175..." into "Alpha reply" in the sidebar. **Sidebar fuzzy-match can't find chats by the source name reliably.** URL-based retry (via `sendPrompt`'s `url` return) is the primary identity mechanism. |
| Class names are build-hashed | `selectors.js` uses text-content and structural anchors. Build-hash classes change on every deploy and are never relied on. |
| `.ds-markdown` is both reasoning and answer | Extraction targets `.ds-assistant-message-main-content` specifically. Any `.ds-markdown` that isn't inside that wrapper is reasoning and gets skipped. |

### Qwen (`providers/qwen.js`)

| Quirk | Handling |
|---|---|
| Age-verification modal blocks input | `dismissAgeModal()` runs at the top of every action. |
| React drops fast send clicks | 1-1.5s `sleep()` between every action. Total ~5s pre-send overhead. |
| Streams a "Thinking..." preamble | Completion detector **only** breaks when both `START_QWEN_REPLY` and `END_QWEN_REPLY` appear. Missing delimiters → `invalid_response_format`, not silent wrong-answer. |
| Delimiters are appended to caller's prompt | Provider adds a `IMPORTANT: You MUST wrap...` suffix to every prompt. Caller's delimiters can override the default tokens via the `delimiters` parameter, but the appending happens regardless. |
| Send button is not aria-labeled consistently | Selector tries buttons inside `.chat-message-input-fixed` / `.message-input-wrapper`, falls back to `button.send-button`, then `button[type="submit"]`. |
| `resetChat` is a no-op | Qwen has no delete-chat UI the provider can drive reliably. Returns `{ ok: true, reason: 'qwen_reset_not_implemented' }`. |

When a provider's DOM changes and the recovery playbook in [selector-maintenance.md](selector-maintenance.md) doesn't cover it, the fix is usually a new tier in the provider's own selector logic, not a change to `selectors.js` (which is DeepSeek-specific). See [selector-maintenance.md#when-adding-a-tier-isnt-enough](selector-maintenance.md#when-adding-a-tier-isnt-enough) for the general procedure.

---

## Picking selectors: rating guide

The Providers page **Pick** buttons inject `picker.js` into the provider tab. Move over the page, click to lock an element, Up/Down walks to the parent/child, and a card at the top right lists up to four candidate selectors, each with a rating badge and a one-line reason.

Keys: `click` locks, `1`-`4` or clicking a row chooses a candidate, `Enter` confirms, `Esc` cancels.

| Rating | Meaning |
|---|---|
| recommended | `#id` that is not generated (React `:r..:`, radix and uuid-like ids are rejected); `[aria-label]`; a stable `data-*` that is not uuid-like or hex; a class combination with at least one named class that is not a bare Tailwind utility. |
| might break | A single volatile `data-*` (`data-state`, `data-v-*`, `data-radix-*`); a combination made only of Tailwind utilities, such as `div.group`; a loose `[attr*=...]` match; a chain of more than 2 compound selectors (counted on top-level combinators, ignoring brackets, parentheses and quotes). |
| will break | Any `:nth-of-type` / `:nth-child` chain; anything containing a uuid or a 6+ character hex run that includes a digit; a generated id; for `response` and `code`, any selector that also matches the input bar (see Exclude). |

The worst applicable rating wins. The "also matches the input bar" check uses the lowest common ancestor of the first visible `input` and `send` matches, so fill those two fields in before picking `response` or `code`; otherwise the card says the check was skipped.

**What gets written.** Picking only fills the form field; nothing is saved until you click Save. The chosen selector is written first, then the other candidates that are not rated will break. A will-break candidate is written only if you choose it and press Enter a second time at the warning.

## Exclude selectors

`exclude` is an optional top-level array of selectors. The runner discards any response match that is, or sits inside, a match of an exclude selector, before it applies the non-empty and echo filters. It is applied everywhere the runner reads `selectors.response` (the before snapshot, new-message detection, candidates, diagnostics), so counts and candidates always agree.

Scope: whole elements are discarded. Text inside a kept bubble is not stripped, so a "Thought Process" label inside a reply stays in `raw` (`codeBlock` extraction already copes with it).

Typical use: a loose response selector such as `[class*="message"]` can also match the chat input bar, which sits below every bubble, so the runner reads the input bar instead of the reply (an 18-character result such as `Connect IM` + `GLM-5.2`). Excluding `[class*="messageInputContainer"]` fixes that. Prefer a precise response selector and keep exclude as the safety net.

**Test selectors** prints `[after exclude: N of M]` on each response selector and warns when N is 0 while M is not, which means an over-broad exclude is discarding every reply.

## Community submission

Each custom provider row has a **Submit** button. It opens a pre-filled GitHub issue on the repository (`REPO_URL` at the top of `providers.js`), with the provider's `providers/<name>.js`, the domains, and the name or handle from the "your name or GitHub handle" field. No API calls and no OAuth. The issue is public, so review it before submitting.

If the encoded body would exceed about 6000 characters (GitHub rejects very long links), the button falls back in two steps: first the definition as compact JSON only, then a short body with the full file copied to your clipboard to paste between the fences.

Maintainer: copy the file into `providers/<name>.js` and the definition into `seeds/<name>.json`. Note that the **Seed** button currently only knows `seeds/glm.json`; seeding other providers needs a seed index and is on the deferred list, so a merged `seeds/<name>.json` is not yet offered to other users by the UI.

## Gotchas

- After **Edit**, the form stays in edit mode and Save overwrites that provider. Click **New / clear** before adding a different one.
- `stop` carries the completion logic: while it matches, the runner ignores text stability. Without a `stop` selector it can finish on thinking text.
- Keep exactly one tab per provider hostname open; two give `multiple_work_tabs`.
