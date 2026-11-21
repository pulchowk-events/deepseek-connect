# Operations

Day-2 runbook for `deepseek-connect`. This doc is indexed by *symptom*, not by concept — find your failure in the [symptom index](#symptom-index), jump to the section, follow the fix. If you're looking for what each phase in the log means, read [log format](#log-format) first; nearly every symptom below is diagnosed by reading the trace.

Multi-provider adds two wrinkles to the runbook. First, the trace phase names are **provider-specific** — DeepSeek emits `probe`/`waitInput`/`toggleDeepthink`, Qwen emits `step_1_dismiss_modal`/`step_2_find_input`. The phase names are the fastest way to identify which provider actually ran. Second, the reload discipline is stricter: **all** provider tabs must be closed before reloading, not just the one you're testing.

> **Current routing/error behavior:** provider choice is required, and exactly one tab must match its exact hostname. Missing or duplicate tabs return `ambiguous_provider_tab`; `/tabs` is only a cached snapshot. `no_work_tab` and `no_provider_loaded` are not registered public codes, and `extension_disconnected` is not a current readiness probe. For current error metadata see [error-codes.md](error-codes.md).

If you're setting up for the first time, read [getting-started.md](getting-started.md) first. If you're modifying the extension or adding a provider, read [architecture.md](architecture.md) and [providers.md](providers.md) before touching anything here. If you're integrating into a wizard, [integration-guide.md](integration-guide.md) has the caller-side operational concerns.

**Contents**
- [Log format](#log-format)
- [Phase names by provider](#phase-names-by-provider)
- [Symptom index](#symptom-index)
- [Reload discipline](#reload-discipline)
- [Symptom: batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line)
- [Symptom: batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line)
- [Symptom: `content` is wrong](#symptom-content-is-wrong)
- [Symptom: `logged_out`](#symptom-logged_out)
- [Symptom: `rate_limited`](#symptom-rate_limited)
- [Symptom: `input_not_found`](#symptom-input_not_found)
- [Symptom: `dom_drift`](#symptom-dom_drift)
- [Symptom: `invalid_response_format` (Qwen)](#symptom-invalid_response_format-qwen)
- [Symptom: `user_navigated`](#symptom-user_navigated)
- [Symptom: Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing)
- [Symptom: Qwen is much slower than DeepSeek](#symptom-qwen-is-much-slower-than-deepseek)
- [Symptom: queue blocked by a crashed extension](#symptom-queue-blocked-by-a-crashed-extension)
- [Server lifecycle](#server-lifecycle)
- [Deployment](#deployment)
- [Diagnostics cheat sheet](#diagnostics-cheat-sheet)
- [When to escalate to selector-maintenance](#when-to-escalate-to-selector-maintenance)

---

## Log format

The server log is a useful diagnostic surface, but it intentionally does not contain prompts or full replies. Correlate a request using its `requestId` (or its first eight characters in trace lines), then inspect `/status` and the selected provider tab as needed.

Three line formats. Every line starts with `[HH:MM:SS]`.

**Request line** — one per `/chat`, `/open`, or `/reset`:

```
[HH:MM:SS] <- enqueued <id> | <label>
[HH:MM:SS] -> dispatched <id> | <label>
[HH:MM:SS] ok done <id> | <N>ms
[HH:MM:SS] x failed <id> | <reason>
```

`<label>` is the provider, operation mode, and bounded chat name; prompt text is not logged. `<id>` is the request ID; `<id8>` is its first 8 characters, used in progress/trace lines.

**Progress line** — one per `dsc_phase` message from the provider module:

```
[HH:MM:SS]   ~ <id8> <phase> <json-extra>
```

The two leading spaces distinguish progress from request lines. `<phase>` is provider-specific — see [Phase names by provider](#phase-names-by-provider) below.

**Trace line** — printed at `ok done` or `x failed`, summarizing the last few phases:

```
  trace[ok] <id8>   <t>ms <phase> <json-extra>
  trace[err] <id8>  <t>ms <phase> <json-extra>
```

The `trace` lines repeat bounded, redacted phase metadata for diagnosis. Prompt/reply/text/URL/token-like fields are redacted; strings, arrays, objects, nesting, and trace tails are bounded.

**Identifying the provider from the log.** Three places:

1. The `/hello` line: `extension connected (0.2.0) | <tabUrl> | N tab(s)` — `<tabUrl>` is one of the supported provider tabs.
2. The `~ <id8> <phase>` lines — the phase names are provider-specific. `probe`, `waitInput`, `toggleDeepthink` = DeepSeek. `step_1_dismiss_modal`, `step_2_find_input` = Qwen.
3. The `chatName` in the enqueued line — the wizard convention is to name the chat after the source, but there's no provider marker in the name unless the wizard adds one.

If you need to check which provider served a specific request, correlate the request ID in `/status` and look at the bounded phase lines. Missing progress does not prove that the request was not dispatched.

## Phase names by provider

The single most useful diagnostic. Each provider emits its own phase sequence; matching the phases to the provider tells you what actually ran.

### DeepSeek (`providers/deepseek.js`)

| Phase | `extra` | Meaning |
|---|---|---|
| `pageReady` | `{checking}` / `{ready, readyState}` | Document and URL stable before provider interaction. |
| `probe` | `{healthy, degraded, requiredMissing}` | Every required selector resolved. `requiredMissing: []` means the DOM looks right. |
| `preflight` | `{ready, readyState, inputFound, inputEmpty, generating, responseStable}` | Input is available/empty and the prior response is idle/stable. |
| `waitInput` | `{found: bool}` | The chat input was found and enabled. |
| `toggleDeepthink` | `{ok: bool, reason?}` | DeepThink verified on, or clicked and verified. |
| `toggleSearch` | `{ok: bool, reason?}` | Search verified on, or clicked and verified. |
| `setInput` | `{promptLen, typedLen, msgBefore}` | Prompt typed into the input. `typedLen === promptLen` means the full text landed. |
| `sendClick` | `{ms}` | Send button clicked, `ms` is the click duration. |
| `submitObserved` | `{accepted, inputCleared, generating, assistantCount}` | Provider UI showed evidence the one send click was accepted. |
| `firstMsg` | `{msgs, url}` | First assistant message of this response appeared. `url` is the captured `streamUrl` (last 8 chars). |
| `reasoning` | `{len}` | Reasoning stream is growing (DeepThink only). `len` is the whole message text length. |
| `answerStarted` | *(none)* | The answer block (`.ds-assistant-message-main-content`) appeared. |
| `answer` | `{len}` | Answer stream is growing. `len` is the answer block's text length. |
| `replyDone` | `{completedBy, sawNew, stableLen}` | Completion detected. `completedBy: 'stable'` means text stopped growing. |
| `extract` | `{source, contentLen, rawLen}` | Extraction ran. `source: 'delimiter'` = markers found, `'fence'` = JS fence fallback, `'raw'` = raw text. |

A **successful DeepSeek prompt** includes: `pageReady` → `probe` → `preflight` → `waitInput` → `toggleDeepthink` → `toggleSearch` → `setInput` → `sendClick` → `submitObserved` → `firstMsg` → (`reasoning` if DeepThink) → `answerStarted` → `answer` → `replyDone` → `extract`. Polling/state observations may repeat; failures stop at their last completed stage.

### Qwen (`providers/qwen.js`)

| Phase | `extra` | Meaning |
|---|---|---|
| `pageReady` | `{checking}` / `{ready, readyState}` | Document and URL stable before provider interaction. |
| `step_1_dismiss_modal` | `{action: 'checking for age modal'}` | Age modal dismisser ran (before every action). |
| `step_2_find_input` | `{action: 'locating input field'}` | Searching for `textarea.message-input-textarea`. |
| `step_2a_preflight` | `{ready, readyState, inputEmpty, generating, assistantCount}` | Empty composer and stable, idle chat verified before paste. |
| `step_3_type_prompt` | `{action: 'typing prompt'}` | Prompt + delimiter instruction injected into input. |
| `step_4_verify_input` | `{promptLen, typedLen}` | Input value read back. `promptLen` includes the ~154-char delimiter instruction. |
| `step_5_click_send` | `{action: 'clicking send button'}` | Waiting for a usable send control and rechecking the prompt. |
| `step_6_send_clicked` | `{ms}` | One send click issued. |
| `step_6a_submit_observed` | `{accepted, inputCleared, generating, assistantCount}` | UI evidence that submission was accepted. |
| `step_7_wait_for_reply` | *(none)* | Polling for both delimiters. |
| `step_7a_first_msg` | *(none)* | First assistant message appeared in the DOM. |
| `step_7b_streaming` | `{len}` | Stream growing (used for timeout diagnostics). |
| `step_8_reply_done` | `{len}` | Both `START_QWEN_REPLY` and `END_QWEN_REPLY` detected. |

A **successful Qwen prompt** includes: `pageReady` → `step_1_dismiss_modal` → `step_2_find_input` → `step_2a_preflight` → `step_3_type_prompt` → `step_4_verify_input` → `step_5_click_send` → `step_6_send_clicked` → `step_6a_submit_observed` → `step_7_wait_for_reply` → `step_7a_first_msg` → `step_7b_streaming` → `step_8_reply_done`. Polling/state observations may repeat; failures stop at their last completed stage. The minimum pre-send UI pacing adds several seconds before response monitoring.

**A failed prompt stops at the phase that failed.** The last `~` line before `x failed` is the diagnosis. If it stops at `step_2_find_input`, that's `input_not_found` on Qwen. If it stops at `probe`, that's `dom_drift` on DeepSeek.

**Mixed phases in one trace means something is wrong with the routing.** If you see `probe` then `step_2_find_input`, the request was dispatched to one provider and something else ran — check whether the tab is actually on the provider you requested (via `/tabs`), or whether two requests got crossed.

---

## Symptom index

Find your symptom. Jump to the section.

| What you see | Section |
|---|---|
| `/chat` ends in queue timeout, no `dispatched` in log | [Batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line) |
| `dispatched` appears but no phase line after it | [Batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line) |
| Content is reasoning text, not the answer | [Content is wrong](#symptom-content-is-wrong) |
| `extract source: 'raw'` in the trace | [Content is wrong](#symptom-content-is-wrong) |
| `ambiguous_provider_tab` | Open exactly one tab for the requested provider |
| Every request returns `logged_out` | [`logged_out`](#symptom-logged_out) |
| Requests wait and then time out | Verify extension poller, token, port, and server log |
| Every request returns `rate_limited` | [`rate_limited`](#symptom-rate_limited) |
| Every request returns `input_not_found` | [`input_not_found`](#symptom-input_not_found) |
| Every request returns `dom_drift` | [`dom_drift`](#symptom-dom_drift) |
| Qwen returns `invalid_response_format` | [`invalid_response_format`](#symptom-invalid_response_format-qwen) |
| A prompt fails with `user_navigated` | [`user_navigated`](#symptom-user_navigated) |
| Qwen keeps showing an age modal | [Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing) |
| Qwen takes 3x as long as DeepSeek | [Qwen is much slower than DeepSeek](#symptom-qwen-is-much-slower-than-deepseek) |
| A request times out after `dispatched` | [Dispatched request has an uncertain outcome](#symptom-queue-blocked-by-a-crashed-extension) |
| Changes to a provider module don't take effect | [Reload discipline](#reload-discipline) |

If your symptom isn't in the table, the diagnosis loop is:

```bash
# 1. Is the extension connected, and which provider tabs does it see?
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool

# 1a. Check polling and queued/in-flight request IDs (not provider UI readiness)
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/status | python3 -m json.tool

# 2. What's the last line in the server log for the failing request?
# (Find the request id from your failing curl, grep the log for it)

# 3. What phase did it stop at? (matches provider)
# (The last `~ <id8> <phase>` line tells you — and identifies the provider)

# 4. What's the content script doing?
# (F12 in the specific provider's tab, check the console for errors)
```

Progress helps locate the last observed provider phase, but it is best-effort telemetry. A missing phase is not evidence that dispatch did not happen.

---

## Reload discipline

The single most common operational mistake. **Multi-provider makes it worse** — you have to close *all* provider tabs, not just the one you're working on.

**Changing any provider module requires hard-reloading the corresponding provider tab.** Reloading the extension is *not enough*.

Why: content scripts are injected at page load. Reloading the extension restarts the service worker (`background.js`, `shared.js` on the extension side) but does **not** re-inject content scripts into already-open tabs. The tab keeps running the *old* content.js, *old* provider modules. Your change is on disk, in the extension's loaded code, but the tab that's actually executing is running the pre-change version.

**With multiple provider tabs, this gets worse.** Every provider tab has its own content-script instance. If you change `providers/deepseek.js`, the DeepSeek tab runs the new code after a hard reload, but the Qwen tab still has the old `providers/qwen.js` loaded (which was already in memory before your change). Normally that's fine — the Qwen tab is running the old Qwen code, which is functionally correct since you didn't change Qwen. But if you change `shared.js` (which both providers import), *both* tabs are now running stale `shared.js`, and the extension's `background.js` is running the new `shared.js`. Version skew between provider modules and background causes subtle bugs.

**The rule:**

| You changed | You must reload |
|---|---|
| `background.js`, `popup.js`, `popup.html` | Extension (brave://extensions → reload button) |
| `manifest.json` | Extension reload (may require full browser restart) |
| `content.js`, `shared.js` | Extension reload **AND** hard-reload **every** provider tab (Ctrl+Shift+R on each) |
| `selectors.js` | Extension reload **AND** hard-reload the DeepSeek tab (selectors.js is DeepSeek-specific) |
| `providers/deepseek.js` | Extension reload **AND** hard-reload the DeepSeek tab |
| `providers/qwen.js` | Extension reload **AND** hard-reload the Qwen tab |
| `src/server.js`, `src/client.js`, `src/errors.js` | Restart the server (Ctrl+C, `node --env-file=.env src/server.js`) |

**When in doubt, reload everything.** Extension reload, hard-reload every provider tab, restart the server. Takes 15 seconds, saves 20 minutes of debugging.

**The full multi-provider reload sequence** (use this whenever you change anything in `content.js`, `shared.js`, or `selectors.js`):

1. **Close every provider tab** — every DeepSeek, every Qwen, every Tongyi. This kills any orphaned content-script instances.
2. **Ctrl+C the server**, then restart: `node --env-file=.env src/server.js`.
3. **Reload the extension** in `brave://extensions`.
4. **Open exactly one fresh tab** to the provider you're testing.
5. **Hard-reload that tab** (Ctrl+Shift+R).
6. **Check F12 console** for `[dsc:registry] <name> provider registered` and `[dsc:router] content router loaded, active providers: [...]`.

Skipping any step leaves a stale service worker or a stale content script, and the symptom is always the same: "the code on disk is correct but the extension isn't seeing it."

**Confirming the reload worked.** In `brave://extensions`, click the "service worker" link on the deepseek-connect card. The service worker's console shows content-script messages. After a reload, you should see a fresh `[dsc:router:diag]` line reporting the URL, hostname, and registered providers.

---

## Symptom: batch hangs with no `dispatched` line

**Diagnosis:** the server received your `/chat` (the `enqueued` line is there) but no extension is polling `/next` to pick it up.

**Confirm:**

```bash
# In one terminal — watch the log
node --env-file=.env src/server.js

# In another — send a request
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}],"chat":"diag","provider":"deepseek"}'
```

If the curl hangs and the log shows only `<- enqueued`, no `-> dispatched`, the extension isn't polling.

**Fix, in order:**

1. **Is the extension connected?** Check the server log for `extension connected` within the last minute. If absent, the extension never registered. Go to `brave://extensions`, confirm deepseek-connect is loaded and enabled, and check for errors on its card.

2. **Is the token correct?** The extension compares its stored token against what the server expects byte-for-byte. If they differ, the extension's `/hello` returns 401 and it never registers. Check:
   ```bash
   curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs
   ```
   If this returns `{ok: true, tabs: [...]}`, your token is correct. If it returns `{ok: false, error: "auth_failed"}`, the token in `.env` doesn't match what you're passing. If the token is correct on the curl but the extension still isn't registering, the popup's stored token is wrong — open the popup and re-save.

3. **Is there a `chat.deepseek.com` tab open?** The extension registers only if it finds at least one supported provider tab. No tab = no registration = no polling. Open `https://chat.deepseek.com/` and wait 2 seconds.

4. **Is the service worker running?** In `brave://extensions`, click the "service worker" link on the deepseek-connect card. If the link is greyed out, the service worker is suspended (Chrome kills MV3 workers after ~30s of inactivity). Any event — an extension reload, a tab URL change — wakes it. If reloading the extension doesn't wake it, check the extension's Errors panel.

**If none of these fix it**, the extension's service worker is running but its poll loop has a bug. Open its console (brave://extensions → service worker link) and check for uncaught exceptions or a stalled `fetch('/next')`.

---

## Symptom: batch hangs after `dispatched` line

**Diagnosis:** the server dispatched the job to the extension (`-> dispatched` appeared) but no reply has arrived yet. The server will return `extension_timeout` at the dispatched-request deadline; caller timeout may happen sooner. A timeout after dispatch is an uncertain outcome, not proof the provider never received the prompt.

The last `~ <id8> <phase>` line tells you where — and **which provider** based on the phase name.

### DeepSeek-specific stops

**Stuck after `dispatched`, no `probe`.** The content script never ran. Either:
- The work tab isn't on `chat.deepseek.com` (check with `/tabs` — look for a tab with `provider: 'deepseek'`)
- The content script crashed before emitting `probe` (F12 in the DeepSeek tab, check Console for errors)
- Background's `chrome.tabs.sendMessage` failed (`Receiving end does not exist` — the content script isn't injected; reload the tab with Ctrl+Shift+R)

**Stuck after `probe`, before `sendClick`.**
- `waitInput {found: false}` — input box not found. See [input_not_found](#symptom-input_not_found).
- `toggleDeepthink {ok: false}` — DeepThink couldn't be enabled. See the [registered error codes](error-codes.md#registered-codes).
- `setInput {promptLen, typedLen}` with `typedLen < promptLen` — the input did not accept the full text. Inspect the provider tab and the returned `executionState` before deciding whether a new attempt is safe.

**Stuck after `sendClick`, no `firstMsg`.** The send interaction may have occurred but DeepSeek has not shown a new assistant message. Check the tab visually for a user turn, rate-limit, challenge, or ongoing generation. Do not infer non-dispatch from the absence of `firstMsg`.

**Stuck after `firstMsg`, before `answerStarted`.** The provider has not reported an answer block. Check the browser tab for a login, challenge, error, or ongoing generation. The request's configured/server deadline determines when an explicit timeout is returned; `response_timeout` does not prove the prompt was never submitted.

### Qwen-specific stops

**Stuck after `dispatched`, no `step_1_dismiss_modal`.** Same as DeepSeek — content script didn't run. Check the Qwen tab is on `chat.qwen.ai` and has the content script.

**Stuck after `step_1_dismiss_modal`, before `step_2_find_input`.** The age modal dismisser ran but something blocked it. This is rare — the dismisser is idempotent. Check the Qwen tab visually: is there a modal that isn't `.ant-modal-container.qwen-chat-v2-modal-container`? Qwen sometimes shows different modal variants — see [Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing).

**Stuck after `step_2_find_input`, before `step_3_type_prompt`.** The input selector didn't find anything. Qwen's input is `textarea.message-input-textarea` with fallback to `textarea`. If Qwen redesigned, the input might be somewhere else. F12 the Qwen tab: `document.querySelector('textarea')` — does it return anything? If not, Qwen's DOM changed.

**Stuck after `step_5_click_send`, before `step_6_send_clicked`.** The driver did not confirm the click. Inspect the provider tab before retrying; phase names alone do not prove that the prompt was or was not accepted.

**Stuck after `step_7_wait_for_reply`, no `step_8_reply_done`.** The delimiters never appeared. The model produced a reply but didn't wrap it in `START_QWEN_REPLY` / `END_QWEN_REPLY`. This is the `invalid_response_format` case — see [invalid_response_format](#symptom-invalid_response_format-qwen).

### General

**No trace line and the request has not dispatched.** Check `/status`, extension popup token/port, and the server's queue deadline. Queue expiry returns a `not_dispatched` failure; an empty or stale `/tabs` snapshot alone is not proof of extension readiness.

**The work tab shows the prompt but no answer is visible.** Do not click send or resubmit blindly. Check whether a user turn was created and whether the provider is still generating. If dispatch status is uncertain, keep the same request ID and wait for a late reply; do not make a new request until the tab has been inspected.

---

## Symptom: `content` is wrong

**Diagnosis:** the request completes (`ok done`) but the returned `content` isn't what you asked for. Several distinct causes; the `extract` trace line distinguishes them.

**`extract source: 'raw'` with reasoning text (DeepSeek).** The completion detector locked onto the reasoning stream instead of the answer. Content is the model's plan ("The user wants me to..."), not its output. See [architecture.md#6-answer-block-extraction-over-whole-message](architecture.md#6-answer-block-extraction-over-whole-message). If you're on current `main`, this shouldn't happen; if it does, file an issue with the `trace` array.

**`extract source: 'raw'` with the full assistant message.** The extraction fell through all passes — the LLM didn't include delimiters (`START_*`/`END_*`), and there's no JS code fence either. This is a **prompt** bug, not a code bug: your prompt didn't instruct the LLM to emit delimiters, or the LLM ignored the instruction.

**`extract source: 'strict_delimiter'` but content is wrong (Qwen).** The Qwen provider extracts everything between `START_QWEN_REPLY` and `END_QWEN_REPLY`. If the model wrapped the wrong content in those markers (e.g., it wrapped its reasoning preamble in the delimiters too), the extraction is technically correct but useless. Check `raw` (which the provider also returns) to see what the full model reply was.

**`content` from a completely different chat.** Cross-chat contamination. The `streamUrl` guard should prevent this (see [architecture.md#the-two-streaming-guards](architecture.md#the-two-streaming-guards)), but if it fires, check `trace` for a `user_navigated` phase before `replyDone`. If there's no `user_navigated` but the content is wrong, the sidebar match returned the wrong chat on `ensureChat` — check `debug.leafPreview` from a `/open` call, or rely on the URL-based retry path (see [getting-started.md#step-7--url-based-retry](getting-started.md#step-7--url-based-retry)).

**`content` is correct but `chat` in the response is wrong.** The `chat` field is what you sent, not what the provider actually used. `ensureChat` might have matched a different chat and used it. If the `chat` field matters (for follow-up calls), check `/open`'s response first and confirm `existing: true` and `chat` matches your expectation.

**`content` is correct but `url` in the response is `null`.** The provider didn't capture the chat URL. DeepSeek always returns it; Qwen always returns it. If you see `null`, check the provider's `sendPrompt` — the `url` field must be populated on success. If it's not, that's a provider bug.

---

## Symptom: `ambiguous_provider_tab`

**Diagnosis:** the extension did not find exactly one tab matching the explicitly requested provider's exact hostname, or the supplied `targetTabId` does not match that provider. It does not silently select another provider or tab.

**Fix:** open exactly one tab for the requested provider, close duplicate matching tabs, and verify any `targetTabId` against the current browser tab. `/tabs` is only a cached snapshot from the last extension registration; it is useful for diagnosis but does not establish live readiness. The request itself performs the authoritative routing check.

---

## Provider registration failure

The content router reports `no_provider_loaded` internally when `DSC_PROVIDERS[msg.provider]` is absent. This is not a registered public error code, so do not depend on a particular public code or decision bucket; preserve the returned request identity and diagnostics, and treat it as a failure requiring review.

This is generally a provider registration or stale-injection problem, not something a batch caller can fix by retrying. Check the provider configuration and extension build, reload the extension, then reload the provider tab. Do not retry under a new request ID unless the failed request is confirmed `not_dispatched`.

**Confirm** by checking the content script's console on the failing provider tab:

```js
// F12 in the failing provider's tab
Object.keys(globalThis.DSC_PROVIDERS || {})
// Expected: ['deepseek', 'qwen'] (or whatever providers should be loaded)
// If it's missing the requested provider, that's the bug
```

And check whether `[dsc:router:diag]` appears in the console at all:

```js
// Search the console for '[dsc:router:diag]'
// If it's absent, the content script didn't inject — see the reload discipline
// If it's present, look at the registeredProviders array
```

**Fix for built-in drivers:** verify the registration checklist in [providers.md#the-registration-checklist](providers.md#the-registration-checklist):

1. `providers/<name>.js` in `manifest.json`'s `content_scripts.js` array (loaded before `content.js`).
2. `providers/<name>.js` in `background.js`'s `sendToTab` re-injection files list.
3. `DSC.PROVIDER_DOMAINS['<name>'] = '<url-prefix>/'` in `shared.js`.

If any built-in registration is missing, correct it, then reload the extension and provider tab (see [reload discipline](#reload-discipline)). For a config provider, verify that it is enabled in the Providers page, its definition has the expected exact domain, and the extension has its host permission; do not add a hand-written driver module.

**This symptom appearing intermittently** (works on first request, fails on retry) usually means the `background.js` re-injection list is missing the provider. The first request works because the content script was already injected; a mid-run crash triggers re-injection with the old file list, and the retry fails. See [providers.md#the-registration-checklist](providers.md#the-registration-checklist) for why this is the hardest of the three to catch.

---

## Symptom: `logged_out`

**Diagnosis:** the work tab shows the provider's login screen. Session expired, cookies gone, or the account was logged out on another tab.

**Fix:** click into the failing provider's tab, log in. Confirm you see the chat input at the bottom. The extension picks it up on the next request — no server restart, no extension reload needed.

**If logging in doesn't fix it:**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

The failing tab's `url` should be a chat URL. If it's a login page (`/login`, `/sign-in`), the login didn't complete. Refresh the tab, log in again.

**Why this happens:** DeepSeek sessions expire after some period of inactivity (typically a few days). Qwen's session lifetime varies. The extension can't renew either — that's a credential operation that requires the user.

**Multi-provider note:** if a batch mixes DeepSeek and Qwen sources, a `logged_out` on DeepSeek doesn't mean Qwen is logged out. Check each provider's tab independently. The `err.reason` field doesn't currently include the provider name (the code is the same for both), so you need to correlate with which provider the failing source was routed to.

---

## Symptom: queued request times out

The server accepted the request but no poller dispatched it before the queue deadline. Check `/status` for `registered`, `extensionResponsive`, `queued`, `inFlight`, and `lastPollAt`; `/tabs` is a cached tab snapshot, not a connectivity or provider-readiness probe.

Check that the extension is loaded, its token and configured port match the server, and its poll loop is active. The server reports the bound port from `/status`; the popup must target that port. Opening a provider tab is not required for extension registration, but exactly one matching tab is required when the request is routed.

After confirming the error is `not_dispatched`, correct the cause and retry with a new request ID; the old ID is deduplicated to its original failure. If the request timed out after dispatch, it is `outcome_unknown`: inspect the provider tab before recovery and do not replay under a new ID.

---

## Symptom: `rate_limited`

**Diagnosis:** the provider reported a rate limit. Check `retryable` and `executionState` on the actual error; an error code alone does not establish that the prompt was not submitted.

**Fix:**

1. **Retry only if the response says `retryable: true` and `executionState: "not_dispatched"`.** Honor the returned `retryAfter` (currently often 30,000 ms); bound the attempts. If the state is `outcome_unknown`, inspect the tab and do not replay automatically.

2. If a safe retry still fails, pause and report the provider's returned error; do not loop indefinitely.

**Multi-provider pivot is caller policy, not automatic failover.** Only consider a different provider after the current request is confirmed not dispatched or the operator has reconciled its outcome. A pivot is a new request and must use the explicitly selected provider and that provider's own saved conversation URL.

**Prevention.** If this happens regularly, lower the caller's request rate or pause between items. Do not send concurrent work expecting provider-level parallelism; the server dispatches one item at a time.

The extension does not switch providers or silently replay prompts. The caller chooses any explicit provider change.

---

## Symptom: `input_not_found`

The extension returns `input_not_found` when a supported provider driver cannot find a usable chat input. Missing, duplicate, or mismatched provider tabs use `ambiguous_provider_tab`; provider registration failures are diagnostics, not a public `no_provider_loaded` code.

Check `executionState` before recovery. Retry only when the error explicitly reports `not_dispatched` and `retryable: true`; if dispatch is uncertain, inspect the provider tab first.

**Cause 1 — Provider page state.** Confirm the provider tab is on its chat view:

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

If the tab shows a login page, use the [logged_out recovery](#symptom-logged_out). If it is on another page on the same provider hostname, navigate to the chat view. Wait for loading or blocking dialogs to clear, and retry only if the failed request is confirmed not dispatched.

**Cause 2 — DOM drift.** The provider's controls changed or the input selector no longer matches. Check the `probe` field on a `dom_drift` error:

```json
{
  "probe": {
    "healthy": ["toggleDeepThink", "toggleSearch", "chatList"],
    "degraded": ["sendButton"],
    "requiredMissing": ["input"]
  }
}
```

`requiredMissing: ["input"]` means the required input selector returned null. Escalate to [selector-maintenance.md](selector-maintenance.md).

**Qwen-specific:** Qwen's `input_not_found` doesn't carry a `probe` field (Qwen's provider doesn't use `selectors.js`). The `reason` is just `'input_not_found'`. To diagnose:

```js
// F12 in the Qwen tab
document.querySelector('textarea.message-input-textarea')  // primary selector
document.querySelector('textarea')                          // fallback
```

If both return null, Qwen's input has moved. The Qwen provider needs a new selector tier — see [selector-maintenance.md](selector-maintenance.md).

---

## Symptom: `send_failed` during readiness checks

The provider driver records a stage trace and stops rather than overwriting a non-empty composer or clicking an unstable send control. For `input_not_empty_before_send`, the existing text was deliberately preserved; inspect it and clear it yourself only after confirming it is not an unsent prompt. For `provider_busy_or_not_ready` or `send_control_not_stable`, let the page finish loading or generation settle, then retry only if `executionState` is `not_dispatched`.

For `send_not_registered`, the send click was already issued but the driver did not observe the composer clearing, generation starting, or a new assistant message. This is not safe to replay automatically. Inspect the provider tab first; if the prompt is present or running, wait for that response rather than sending again. Stage progress is correlated with the original `requestId`; use it together with the final `trace` to see which guard stopped the transition.

---

## Symptom: `dom_drift`

**Diagnosis:** a provider shipped a UI change and one or more required selectors no longer match. This is the failure the extension is *designed* to fail loudly on — better a clean `dom_drift` than silent cross-chat contamination.

**Confirm:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}],"chat":"dom-check","provider":"deepseek"}' \
  | python3 -m json.tool
```

Expected if drift:

```json
{
  "ok": false,
  "error": "dom_drift",
  "details": ["input"],
  "probe": {
    "healthy": [...],
    "degraded": [...],
    "requiredMissing": ["input"]
  }
}
```

The `details` array names which required selector broke. The `probe` field shows what resolved.

**Fix:** this is not a batch-wizard fix. It's a code fix in this repo. See [selector-maintenance.md](selector-maintenance.md) for the recovery playbook — the whole doc is about this failure mode. The steps are:

1. F12 in the failing provider's tab, run the diagnostic snippet from [selector-maintenance.md#diagnosing-a-drift](selector-maintenance.md#diagnosing-a-drift)
2. Update the provider's selectors (DeepSeek: `selectors.js`; Qwen: `providers/qwen.js`) with the new selector as a fallback tier
3. Reload extension + hard-reload the tab
4. Re-test with the curl above
5. If successful, commit the selector change

**Do not** try to fix `dom_drift` by retrying the same prompt. It will fail with the same error every time.

**Multi-provider note:** a `dom_drift` on DeepSeek doesn't affect Qwen (they have independent selectors). If a batch mixes providers, you can pivot affected sources to the other provider while you fix the DeepSeek selectors. See the provider-pivot pattern in [integration-guide.md](integration-guide.md).

---

## Symptom: `invalid_response_format` (Qwen)

**Diagnosis:** Qwen produced a reply but the configured delimiters were not found, so extraction failed rather than returning an ambiguous fragment. The optional `details.rawPreview` is a short excerpt of provider output in the HTTP error; it is not written to server logs and should be handled as untrusted model output.

Inspect the provider tab and the bounded trace/preview. Confirm whether the prompt and a new assistant turn are present, then decide whether a new prompt is appropriate. This failure occurs after dispatch and is not marked retryable. Do not copy model-produced code into a trusted location or execute it; the caller must perform syntax, identity, and verdict checks.

---

## Symptom: `user_navigated`

**Diagnosis:** the work tab's URL changed mid-stream. The response is discarded rather than returning content from the wrong chat. The `streamUrl` guard working as designed.

**Cause:** the user clicked into a different chat while a prompt was streaming, or the provider auto-redirected (session expiry mid-stream, for example).

**Fix:** inspect the tab and conversation, then decide whether a new prompt is appropriate. `user_navigated` is not retryable by default because the original may have been submitted and its result is discarded to avoid returning a response from the wrong conversation.

**If it happens repeatedly:** the user is actively clicking around in the work tab during the batch. Tell them to leave the work tab alone while a batch is running. This is the one failure mode where the fix is procedural, not code.

**Multi-provider note:** `user_navigated` fires from whichever provider was running. The `err.trace` phase names tell you which. If it's consistently DeepSeek, the user is clicking around in the DeepSeek tab; if Qwen, the Qwen tab.

---

## Symptom: Qwen's age modal keeps appearing

**Diagnosis:** a modal or other blocking page UI may be preventing access to the chat input. The Qwen driver attempts to dismiss its known age modal, but other consent/challenge UI is not guaranteed to be handled.

**Confirm** by looking at the trace — if a Qwen request fails with `input_not_found` after `step_1_dismiss_modal`, the modal dismissal ran but didn't dismiss the modal that was actually present.

**Root causes:**

1. **The modal's class changed.** The dismisser looks for `.ant-modal-container.qwen-chat-v2-modal-container`. If Qwen renamed the class, the dismisser doesn't find it.
2. **A different modal variant.** Qwen shows different modals for different states (age verification, cookie consent, feature announcement). The dismisser only handles the age one.
3. **The modal appears after a delay.** The dismisser runs at the top of each action, but if the modal appears 2 seconds after `step_2_find_input` starts, the dismisser already ran and doesn't run again until the next action.

**Fix:**

1. **Check which modal is present.** F12 the Qwen tab when the batch is stuck. What modal container class do you see? If it's not `.ant-modal-container.qwen-chat-v2-modal-container`, that's your problem.
2. **Add the new class to the dismisser.** In `providers/qwen.js`, `dismissAgeModal()` targets specific selectors. Add the new one.
3. **Consider running the dismisser in the sendPrompt loop.** The current implementation runs it at the top of `sendPrompt`; if a modal appears mid-prompt, it's not caught. A periodic check inside the polling loop would catch it, at the cost of a small per-iteration overhead.

For urgent cases: run the dismisser manually by clicking the modal's "Continue" / "I'm over 18" / "Accept" button in the Qwen tab. The next prompt will proceed.

**If the modal appears repeatedly:** complete only the provider's legitimate UI step in the browser, then verify the chat is usable. The extension does not bypass bot challenges or authentication.

---

## Symptom: Qwen is much slower than DeepSeek

**Diagnosis:** Qwen's driver includes pacing between UI interactions. Total duration also depends on page readiness and provider generation; fixed latency/success estimates are not guarantees.

Keep the workflow sequential; this server has one in-flight request across all providers. Compare elapsed time and the last observed progress phase. Long generation can be provider-side; missing progress can also mean telemetry delivery failed. Check the tab rather than assuming a specific phase caused the delay.

---

## Symptom: queue blocked by a crashed extension

**Diagnosis:** a dispatched request reached its deadline without a reply, so its outcome is uncertain. Check `/status` for the request ID and `inFlight` state. The server quarantines this slot and does not dispatch later jobs into it.

**Recovery:**

1. Inspect the exact provider tab for the user prompt and any assistant response, login page, challenge, or ongoing generation.
2. If a late reply arrives, the server releases the slot. Repeat the original request with the same `requestId` and identical payload to retrieve the cached terminal result without redispatch.
3. If there is no reply and the tab has been manually reconciled, stop/restart the server only after recording what happened. Restart clears in-memory request IDs and cannot prove whether the prompt was submitted.

```bash
# Only after inspecting and reconciling the provider tab:
node --env-file=.env src/server.js
```

Queued requests time out separately if an in-flight slot remains quarantined. Their `executionState` is `not_dispatched`, so those requests can be considered independently. No extension/server restart can cancel work already running in a provider tab.

---

## Server lifecycle

Start:

```bash
cd deepseek-connect
node --env-file=.env src/server.js
```

Stop: Ctrl+C. `server.stop()` fails queued requests as `not_dispatched` and dispatched requests as `outcome_unknown`, clears local state, and closes the socket. It does not cancel provider work. An extension that is still configured retries connection and registers again when the server returns.

Restart after a code change:

```bash
# Ctrl+C, then:
node --env-file=.env src/server.js
```

Port conflicts:

```bash
# What's on 7331?
lsof -i :7331

# Or on Windows:
netstat -ano | findstr :7331
```

If another process is on the port, either kill it or change `EXTENSION_PORT` in `.env` (and the popup's Port field to match).

**Running under systemd** (Linux deployment):

```ini
# /etc/systemd/system/deepseek-connect.service
[Unit]
Description=deepseek-connect server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/deepseek-connect
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/deepseek-connect.log
StandardError=append:/var/log/deepseek-connect-error.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-connect
sudo systemctl status deepseek-connect
journalctl -u deepseek-connect -f
```

For the browser side: load the extension in Brave/Chrome as usual, set the token, open a provider tab. The extension reconnects to the systemd-managed server on the same port. On a fresh boot, the extension's `/hello` might fire before the server is up — the backoff handles this (1s/2s/5s/10s, then stuck until the next tab event). Opening a provider tab after the server is up is the cleanest order.

**Log rotation:** systemd's `StandardOutput=append:` writes to a plain file that grows forever. Add a logrotate config:

```
# /etc/logrotate.d/deepseek-connect
/var/log/deepseek-connect*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

Or use `journalctl` instead of a file by setting `StandardOutput=journal` in the unit file.

---

## Deployment

### Single-machine deployment (the common case)

One machine, one Chrome profile, one server, one extension. This is what the quickstart assumes and what most users want.

- Server: systemd (Linux) or Task Scheduler (Windows) or pm2 (cross-platform)
- Extension: loaded unpacked in the user's browser
- One provider tab open for each provider the batch will use

### Multi-provider considerations

If the batch explicitly routes different sources to different providers:

1. **Select the provider per source.** The extension never performs automatic failover. A provider change is a caller decision and must not be used to retry an `outcome_unknown` request.
2. **Open and log in to each provider tab before its request is dispatched.** Exactly one matching provider hostname must be open when each request runs; `/tabs` is not a readiness guarantee.
3. **Keep the run sequential.** The server dispatches one request at a time even when multiple provider tabs are open.

### Restart discipline after provider changes

If you change a provider module:

1. Close every provider tab (all of them, not just the one you changed)
2. Reload the extension
3. Reopen fresh tabs
4. Restart the server

See [reload discipline](#reload-discipline) for the full sequence and why each step is necessary.

---

## Diagnostics cheat sheet

One-liners for the commands you'll type most.

**Is the extension connected, and what provider tabs does it see?**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

Empty `tabs` = not connected or no provider tabs open. `auth_failed` = token mismatch. Network error = server not running. Each tab's `provider` field tells you which provider it serves.

**Send a test prompt to a specific provider:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: ok"}],"chat":"diag","provider":"qwen"}' \
  | python3 -m json.tool
```

Fastest end-to-end test for a specific provider. If this returns `{content: "ok", ...}`, the whole pipeline works for that provider. If not, the error code is your diagnosis.

**Find a specific request in the log:**

```bash
# Given a request ID (first 8 chars is enough)
grep "<id8>" /path/to/deepseek-connect.log
```

Or, if you're watching live:

```bash
tail -f /path/to/deepseek-connect.log | grep "<id8>"
```

**What phase did the last request reach, and which provider?**

```bash
# Last 20 lines of the log
tail -20 /path/to/deepseek-connect.log

# Or just the request-phase lines (skip `~` progress)
tail -50 /path/to/deepseek-connect.log | grep -E "(enqueued|dispatched|ok done|x failed)"
```

The phase names in the `~` lines tell you which provider ran.

**Is the content script alive in the work tab?**

F12 in the specific provider tab, then in the console:

```js
typeof DSC !== 'undefined'
// Expected: "object"  — the shared.js global is loaded

typeof DSC_PROVIDERS !== 'undefined'
// Expected: "object"  — the provider registry is loaded

Object.keys(DSC_PROVIDERS || {})
// Expected: ['deepseek', 'qwen']  — or whichever providers are registered
```

If `DSC_PROVIDERS` is undefined or missing an expected provider, the content script didn't inject. Hard-reload the tab (Ctrl+Shift+R) and check again.

**Is the provider's module registered?**

```js
// F12 in the failing provider's tab
DSC_PROVIDERS['deepseek']
// Expected: { name: 'deepseek', ensureChat: f, sendPrompt: f, checkState: f, resetChat: f }

DSC_PROVIDERS['qwen']
// Expected: { name: 'qwen', selectors: {...}, ensureChat: f, ... }
```

If a provider you expect is `undefined`, its module didn't register. Check `manifest.json`'s `content_scripts.js` array.

---

## When to escalate to selector-maintenance

Three situations. In each, the fix is in the provider's selector logic, not in any caller:

1. **`dom_drift` fires with `requiredMissing: ["input"]` or `["toggleDeepThink"]` or `["toggleSearch"]`.** A DeepSeek selector broke. Escalate to [selector-maintenance.md#deepseek-selectors](selector-maintenance.md#deepseek-selectors).

2. **`input_not_found` fires repeatedly on Qwen** (the Qwen tab exists, but the input selector doesn't match). The provider's input selector may need a new tier. Escalate to [selector-maintenance.md#qwen-selectors](selector-maintenance.md#qwen-selectors).

3. **`chat_not_found` fires on a DeepSeek chat you know exists** — the sidebar fuzzy match failed. Could be a fuzzy-match bug (chat title doesn't contain the source name — common) or a sidebar walk bug. The primary mitigation is URL-based retry (see [getting-started.md#step-7--url-based-retry](getting-started.md#step-7--url-based-retry)) — but if you're seeing this on the first send per source, the sidebar walk is the last resort.

The recovery playbook for all three is [selector-maintenance.md](selector-maintenance.md), which is split by provider. If the fix is successful, the resulting change is a *new selector tier* in the provider's file — never a rewrite of the extraction logic, never a change to `content.js`'s structure. The tiered fallback design means old provider versions still work with the new tier added.