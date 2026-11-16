# Operations

Day-2 runbook for `deepseek-connect`. This doc is indexed by *symptom*, not by concept — find your failure in the [symptom index](#symptom-index), jump to the section, follow the fix. If you're looking for what each phase in the log means, read [log format](#log-format) first; nearly every symptom below is diagnosed by reading the trace.

Multi-provider adds two wrinkles to the runbook. First, the trace phase names are **provider-specific** — DeepSeek emits `probe`/`waitInput`/`toggleDeepthink`, Qwen emits `step_1_dismiss_modal`/`step_2_find_input`. The phase names are the fastest way to identify which provider actually ran. Second, the reload discipline is stricter: **all** provider tabs must be closed before reloading, not just the one you're testing.

If you're setting up for the first time, read [getting-started.md](getting-started.md) first. If you're modifying the extension or adding a provider, read [architecture.md](architecture.md) and [providers.md](providers.md) before touching anything here. If you're integrating into a wizard, [integration-guide.md](integration-guide.md) has the caller-side operational concerns.

**Contents**
- [Log format](#log-format)
- [Phase names by provider](#phase-names-by-provider)
- [Symptom index](#symptom-index)
- [Reload discipline](#reload-discipline)
- [Symptom: batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line)
- [Symptom: batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line)
- [Symptom: `content` is wrong](#symptom-content-is-wrong)
- [Symptom: `no_work_tab`](#symptom-no_work_tab)
- [Symptom: `no_provider_loaded`](#symptom-no_provider_loaded)
- [Symptom: `logged_out`](#symptom-logged_out)
- [Symptom: `extension_disconnected`](#symptom-extension_disconnected)
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

Everything below assumes you can read the server's log. It's the primary operational surface — every prompt that ever runs leaves a trail, and nearly every symptom is diagnosed by finding the trail's last line.

Three line formats. Every line starts with `[HH:MM:SS]`.

**Request line** — one per `/chat`, `/open`, or `/reset`:

```
[HH:MM:SS] <- enqueued <id> | <label>
[HH:MM:SS] -> dispatched <id> | <label>
[HH:MM:SS] ok done <id> | <N>ms
[HH:MM:SS] x failed <id> | <reason>
```

`<label>` is the prompt truncated to 60 chars, or `[open] chat-name` / `[reset] chat-name` for the mode-specific routes. `<id>` is a UUID; `<id8>` is the first 8 chars, used in every follow-up line.

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

The `trace` lines are redundant with the `~` lines (they're the same data, printed again at completion). They exist so a batch's final summary has the per-request timing without scrolling back through hundreds of `~` lines.

**Identifying the provider from the log.** Three places:

1. The `/hello` line: `extension connected (0.2.0) | <tabUrl> | N tab(s)` — `<tabUrl>` is one of the open provider tabs (usually the pinned one).
2. The `~ <id8> <phase>` lines — the phase names are provider-specific. `probe`, `waitInput`, `toggleDeepthink` = DeepSeek. `step_1_dismiss_modal`, `step_2_find_input` = Qwen.
3. The `chatName` in the enqueued line — the wizard convention is to name the chat after the source, but there's no provider marker in the name unless the wizard adds one.

If you need to check which provider served a specific request, grep the id8 in the log and look at the phase names.

## Phase names by provider

The single most useful diagnostic. Each provider emits its own phase sequence; matching the phases to the provider tells you what actually ran.

### DeepSeek (`providers/deepseek.js`)

| Phase | `extra` | Meaning |
|---|---|---|
| `probe` | `{healthy, degraded, requiredMissing}` | Every required selector resolved. `requiredMissing: []` means the DOM looks right. |
| `waitInput` | `{found: bool}` | The chat input was found (and enabled) within 5s. |
| `toggleDeepthink` | `{ok: bool, reason?}` | DeepThink verified on, or clicked and verified. |
| `toggleSearch` | `{ok: bool, reason?}` | Search verified on, or clicked and verified. |
| `setInput` | `{promptLen, typedLen, msgBefore}` | Prompt typed into the input. `typedLen === promptLen` means the full text landed. |
| `sendClick` | `{ms}` | Send button clicked, `ms` is the click duration. |
| `firstMsg` | `{msgs, url}` | First assistant message of this response appeared. `url` is the captured `streamUrl` (last 8 chars). |
| `reasoning` | `{len}` | Reasoning stream is growing (DeepThink only). `len` is the whole message text length. |
| `answerStarted` | *(none)* | The answer block (`.ds-assistant-message-main-content`) appeared. |
| `answer` | `{len}` | Answer stream is growing. `len` is the answer block's text length. |
| `replyDone` | `{completedBy, sawNew, stableLen}` | Completion detected. `completedBy: 'stable'` means text stopped growing. |
| `extract` | `{source, contentLen, rawLen}` | Extraction ran. `source: 'delimiter'` = markers found, `'fence'` = JS fence fallback, `'raw'` = raw text. |

A **successful DeepSeek prompt** emits: `probe` → `waitInput` → `toggleDeepthink` → `toggleSearch` → `setInput` → `sendClick` → `firstMsg` → (`reasoning` if DeepThink) → `answerStarted` → `answer` → `replyDone` → `extract`.

### Qwen (`providers/qwen.js`)

| Phase | `extra` | Meaning |
|---|---|---|
| `step_1_dismiss_modal` | `{action: 'checking for age modal'}` | Age modal dismisser ran (before every action). |
| `step_2_find_input` | `{action: 'locating input field'}` | Searching for `textarea.message-input-textarea`. |
| `step_3_type_prompt` | `{action: 'typing prompt'}` | Prompt + delimiter instruction injected into input. |
| `step_4_verify_input` | `{promptLen, typedLen}` | Input value read back. `promptLen` includes the ~154-char delimiter instruction. |
| `step_5_click_send` | `{action: 'clicking send button'}` | Send button clicked. |
| `step_6_send_clicked` | *(none)* | Click registered, waiting for network to initiate. |
| `step_7_wait_for_reply` | *(none)* | Polling for both delimiters. |
| `step_7a_first_msg` | *(none)* | First assistant message appeared in the DOM. |
| `step_7b_streaming` | `{len}` | Stream growing (used for timeout diagnostics). |
| `step_8_reply_done` | `{len}` | Both `START_QWEN_REPLY` and `END_QWEN_REPLY` detected. |

A **successful Qwen prompt** emits: `step_1_dismiss_modal` → `step_2_find_input` → `step_3_type_prompt` → `step_4_verify_input` → `step_5_click_send` → `step_6_send_clicked` → `step_7_wait_for_reply` → `step_7a_first_msg` → `step_7b_streaming` → `step_8_reply_done`. Total elapsed is typically 7-10s (vs. DeepSeek's 4-8s) because of the ~5s pre-send pacing.

**A failed prompt stops at the phase that failed.** The last `~` line before `x failed` is the diagnosis. If it stops at `step_2_find_input`, that's `input_not_found` on Qwen. If it stops at `probe`, that's `dom_drift` on DeepSeek.

**Mixed phases in one trace means something is wrong with the routing.** If you see `probe` then `step_2_find_input`, the request was dispatched to one provider and something else ran — check whether the tab is actually on the provider you requested (via `/tabs`), or whether two requests got crossed.

---

## Symptom index

Find your symptom. Jump to the section.

| What you see | Section |
|---|---|
| `curl /chat` hangs forever, no `dispatched` in log | [Batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line) |
| `dispatched` appears but no phase line after it | [Batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line) |
| Content is reasoning text, not the answer | [Content is wrong](#symptom-content-is-wrong) |
| `extract source: 'raw'` in the trace | [Content is wrong](#symptom-content-is-wrong) |
| `input_not_found` with `reason: 'no_work_tab'` | [`no_work_tab`](#symptom-no_work_tab) |
| `input_not_found` with `reason: 'no_provider_loaded'` | [`no_provider_loaded`](#symptom-no_provider_loaded) |
| Every request returns `logged_out` | [`logged_out`](#symptom-logged_out) |
| Every request returns `extension_disconnected` | [`extension_disconnected`](#symptom-extension_disconnected) |
| Every request returns `rate_limited` | [`rate_limited`](#symptom-rate_limited) |
| Every request returns `input_not_found` (without `no_work_tab`) | [`input_not_found`](#symptom-input_not_found) |
| Every request returns `dom_drift` | [`dom_drift`](#symptom-dom_drift) |
| Qwen returns `invalid_response_format` | [`invalid_response_format`](#symptom-invalid_response_format-qwen) |
| A prompt fails with `user_navigated` | [`user_navigated`](#symptom-user_navigated) |
| Qwen keeps showing an age modal | [Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing) |
| Qwen takes 3x as long as DeepSeek | [Qwen is much slower than DeepSeek](#symptom-qwen-is-much-slower-than-deepseek) |
| First request after a crash hangs | [Queue blocked by a crashed extension](#symptom-queue-blocked-by-a-crashed-extension) |
| Changes to a provider module don't take effect | [Reload discipline](#reload-discipline) |

If your symptom isn't in the table, the diagnosis loop is:

```bash
# 1. Is the extension connected, and which provider tabs does it see?
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool

# 2. What's the last line in the server log for the failing request?
# (Find the request id from your failing curl, grep the log for it)

# 3. What phase did it stop at? (matches provider)
# (The last `~ <id8> <phase>` line tells you — and identifies the provider)

# 4. What's the content script doing?
# (F12 in the specific provider's tab, check the console for errors)
```

99% of the time, step 3 is the answer, and the phase name tells you which provider it was.

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

**Diagnosis:** the server dispatched the job to the extension (`-> dispatched` appeared) but the extension never replied (`ok done` / `x failed` never appeared). The job is stuck.

The last `~ <id8> <phase>` line tells you where — and **which provider** based on the phase name.

### DeepSeek-specific stops

**Stuck after `dispatched`, no `probe`.** The content script never ran. Either:
- The work tab isn't on `chat.deepseek.com` (check with `/tabs` — look for a tab with `provider: 'deepseek'`)
- The content script crashed before emitting `probe` (F12 in the DeepSeek tab, check Console for errors)
- Background's `chrome.tabs.sendMessage` failed (`Receiving end does not exist` — the content script isn't injected; reload the tab with Ctrl+Shift+R)

**Stuck after `probe`, before `sendClick`.**
- `waitInput {found: false}` — input box not found. See [input_not_found](#symptom-input_not_found).
- `toggleDeepthink {ok: false}` — DeepThink couldn't be enabled. See [deepthink_enable_failed](error-codes.md#deepthink_enable_failed).
- `setInput {promptLen, typedLen}` with `typedLen < promptLen` — the input didn't accept the full text. Usually a timing issue; retry once.

**Stuck after `sendClick`, no `firstMsg`.** The send clicked but DeepSeek didn't respond. Either the click didn't register (see `send_failed`) or the page is rate-limited. Check the DeepSeek tab visually — if there's no user message visible, the send didn't go through.

**Stuck after `firstMsg`, before `answerStarted`.** The reasoning stream is running but the answer never started. DeepThink on complex prompts can take 60+ seconds. Wait for the 90s timeout. If it times out, see `response_timeout`.

### Qwen-specific stops

**Stuck after `dispatched`, no `step_1_dismiss_modal`.** Same as DeepSeek — content script didn't run. Check the Qwen tab is on `chat.qwen.ai` and has the content script.

**Stuck after `step_1_dismiss_modal`, before `step_2_find_input`.** The age modal dismisser ran but something blocked it. This is rare — the dismisser is idempotent. Check the Qwen tab visually: is there a modal that isn't `.ant-modal-container.qwen-chat-v2-modal-container`? Qwen sometimes shows different modal variants — see [Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing).

**Stuck after `step_2_find_input`, before `step_3_type_prompt`.** The input selector didn't find anything. Qwen's input is `textarea.message-input-textarea` with fallback to `textarea`. If Qwen redesigned, the input might be somewhere else. F12 the Qwen tab: `document.querySelector('textarea')` — does it return anything? If not, Qwen's DOM changed.

**Stuck after `step_5_click_send`, before `step_6_send_clicked`.** The click didn't register. Qwen's anti-bot pacing should prevent this, but if it happens, retry. If it happens repeatedly, the pacing may need adjustment — see [Qwen is much slower than DeepSeek](#symptom-qwen-is-much-slower-than-deepseek).

**Stuck after `step_7_wait_for_reply`, no `step_8_reply_done`.** The delimiters never appeared. The model produced a reply but didn't wrap it in `START_QWEN_REPLY` / `END_QWEN_REPLY`. This is the `invalid_response_format` case — see [invalid_response_format](#symptom-invalid_response_format-qwen).

### General

**Hangs indefinitely with no trace line at `x failed`.** This is the [queue blocked by a crashed extension](#symptom-queue-blocked-by-a-crashed-extension) case. The extension crashed after `/next` but before `/reply`. Restart the server.

**The work tab shows the prompt but it hasn't been sent.** The input was typed but `sendClick` didn't fire, or fired and didn't register. Manually click send in the tab to unblock (the provider will detect the assistant message and complete normally). Then check the `sendClick` trace — if `ms` is present but no `firstMsg` follows, that's the bug; see `send_failed`.

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

## Symptom: `no_work_tab`

**Diagnosis:** `{"ok": false, "error": "input_not_found", "reason": "no_work_tab"}`. The `reason` field is `no_work_tab`, which means `getWorkTab(provider)` returned `null`. **No tab with the requested provider is open.**

This is a **user-fixable** case: the user needs to open a tab for the provider that the request targets. The `input_not_found` code is technically accurate but the `reason` is what the user sees and acts on.

**Confirm:**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

Look at the `provider` field for each tab. If you requested `provider: 'qwen'` but the `tabs` array has no entries with `provider: 'qwen'`, that's the diagnosis.

**Fix:** open a tab to the requested provider's domain:

- `provider: 'deepseek'` → open `https://chat.deepseek.com/`
- `provider: 'qwen'` → open `https://chat.qwen.ai/`
- `provider: 'tongyi'` → open `https://tongyi.aliyun.com/` (note: no provider module yet — this would return `no_provider_loaded`, not `no_work_tab`, after the tab opens)

The extension re-registers via `/hello` when a new provider tab opens (the tab URL change triggers `register()`), and the next `/chat` finds it.

**If `/tabs` shows a tab for the provider but you're still getting `no_work_tab`:** the tab's URL might not match `DSC.PROVIDER_DOMAINS[provider]` exactly. For example, `provider: 'qwen'` looks for URLs starting with `https://chat.qwen.ai/`. A tab at `https://chat.qwen.ai/chat/abc` matches (startsWith), but `https://chat.qwenlm.ai/` does not (old domain). Check the tab's URL in `/tabs`.

**Common cause:** the user closed the Qwen tab thinking they were done with it, then a batch run targets Qwen sources. In batch wizards, add a pre-flight check — see [integration-guide.md#pattern-3--probe-server-readiness-before-a-batch](integration-guide.md#pattern-3--probe-server-readiness-before-a-batch).

---

## Symptom: `no_provider_loaded`

**Diagnosis:** `{"ok": false, "error": "input_not_found", "reason": "no_provider_loaded"}`. The `reason` field is `no_provider_loaded`, which means `content.js`'s router couldn't find `DSC_PROVIDERS[msg.provider]`. **The provider module isn't registered.**

This is **not user-fixable** — it's a **developer registration bug**. The user cannot fix it from the CLI. It surfaces as `input_not_found` at the code level (because `background.js` doesn't recognize the code `no_provider_loaded`), but the correct classification is bucket E (skip silently, mark `needs-review`), not bucket D (beep).

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

**Fix** — three registrations must be in place (see [providers.md#the-registration-checklist](providers.md#the-registration-checklist)):

1. `providers/<name>.js` in `manifest.json`'s `content_scripts.js` array (loaded before `content.js`).
2. `providers/<name>.js` in `background.js`'s `sendToTab` re-injection files list.
3. `DSC.PROVIDER_DOMAINS['<name>'] = '<url-prefix>/'` in `shared.js`.

If any of these is missing, add it. Then reload the extension and hard-reload the provider tab (see [reload discipline](#reload-discipline)).

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

## Symptom: `extension_disconnected`

**Diagnosis:** every request returns `extension_disconnected`. The server is up but no extension is talking to it. Three possible causes.

**Cause 1 — Extension not loaded.** Check `brave://extensions`. If deepseek-connect isn't in the list, click Load unpacked and select the directory. If it's in the list but disabled, toggle it on.

**Cause 2 — Token mismatch.** The popup's token and `.env`'s `EXTENSION_TOKEN` differ. Compare byte-for-byte. If they differ:

1. Open the popup, correct the token, click Save
2. Reload the extension (brave://extensions → reload)
3. Check the server log for a new `extension connected` line

**Cause 3 — No provider tab open.** Open `https://chat.deepseek.com/` or `https://chat.qwen.ai/` and wait 2 seconds. The extension registers on the next tab event.

**Confirm the fix:**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

Expected:

```json
{
  "ok": true,
  "tabs": [
    { "id": ..., "url": "https://chat.deepseek.com/...", "provider": "deepseek", ... }
  ]
}
```

If `tabs` is empty, the extension is connected but doesn't see any provider tabs — open one.

---

## Symptom: `rate_limited`

**Diagnosis:** the provider is throttling the account. The reply contains text matching "too many requests" or "rate limit". The most common failure for a batch running many sources back to back.

**Fix:**

1. **Wait 30 seconds.** The `rate_limited` error carries `retryAfter: 30000`. The wizard's retry policy should `await sleep(err.retryAfter)` before the retry. This is automatic in a well-built wizard.

2. **If retries still fail**, the rate window has moved. Restart the batch after a longer pause (2-5 minutes).

**Multi-provider pivot.** If the wizard supports multiple providers and the source wasn't already on a fallback provider, retry the same prompt on the other provider instead of waiting:

```js
// Pseudocode — see integration-guide.md#pattern-2--provider-aware-pivot-on-rate-limit
if (err.code === 'rate_limited') {
  if (currentProvider === 'deepseek') {
    retryWithProvider('qwen');
  } else if (currentProvider === 'qwen') {
    retryWithProvider('deepseek');
  }
}
```

Note that each provider gets its own chat — the retry on Qwen should use `chat: \`${source.name}-qwen\`` (or similar), not the DeepSeek chat name. The `chat-map.json` in [integration-guide.md](integration-guide.md) keys on `(source.name, provider)` pairs for this reason.

**Prevention.** If this happens regularly, the batch is running too fast for the account's quota. Options:

- Increase the pause between sources (add a `--delay` flag to the batch wizard)
- Disable DeepThink for prompts that don't need reasoning (DeepSeek only — the extension's auto-enable can't be bypassed per-request in v0.2.0)
- Use the provider-pivot pattern to spread load across both providers
- Use a different account (out of scope — one profile, one account per provider)

The extension **cannot** do anything about rate limits. It reports them accurately, and the caller's policy decides what to do.

---

## Symptom: `input_not_found`

**Diagnosis:** the work tab doesn't have a chat input box where the extension expects one. The `reason` field distinguishes the causes.

**`reason: 'no_work_tab'`** — see [no_work_tab](#symptom-no_work_tab). No provider tab is open.

**`reason: 'no_provider_loaded'`** — see [no_provider_loaded](#symptom-no_provider_loaded). Registration bug.

**`reason: 'input_not_found'`** (or any other reason string without a `no_*` prefix) — the tab exists and the provider module is registered, but the input selector didn't match. Four causes, in order of frequency:

**Cause 1 — Wrong URL.** The tab is on a non-chat page. Confirm:

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

The failing tab's `url` must be a provider chat URL. If it's `/login`, `/app`, or a settings page, navigate to the provider root and retry.

**Cause 2 — Tab closed.** The extension selected the tab but it closed between selection and dispatch. Open a fresh provider tab and retry.

**Cause 3 — Loading state.** The tab is still loading. The extension's `waitForInputReady(5000)` times out after 5 seconds. If the page is genuinely slow to load (network, cold cache), retry — it usually succeeds on attempt 2.

**Cause 4 — DOM drift.** The input selector matched before, but the provider's DOM changed. Check the `probe` field on the error:

```json
{
  "probe": {
    "healthy": ["toggleDeepThink", "toggleSearch", "chatList"],
    "degraded": ["sendButton"],
    "requiredMissing": ["input"]
  }
}
```

`requiredMissing: ["input"]` means the input selector returned null. That's [dom_drift](#symptom-dom_drift). Escalate to [selector-maintenance.md](selector-maintenance.md).

**Qwen-specific:** Qwen's `input_not_found` doesn't carry a `probe` field (Qwen's provider doesn't use `selectors.js`). The `reason` is just `'input_not_found'`. To diagnose:

```js
// F12 in the Qwen tab
document.querySelector('textarea.message-input-textarea')  // primary selector
document.querySelector('textarea')                          // fallback
```

If both return null, Qwen's input has moved. The Qwen provider needs a new selector tier — see [selector-maintenance.md](selector-maintenance.md).

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

**Diagnosis:** `{"ok": false, "error": "invalid_response_format", "details": {"rawPreview": "..."}}`. Qwen produced a reply but didn't wrap it in `START_QWEN_REPLY` / `END_QWEN_REPLY`. The Qwen provider's strict-delimiter extraction refuses to extract anything not properly delimited.

**Confirm** by looking at `details.rawPreview` — the first 200 chars of what the model actually said. Two cases:

1. **`rawPreview` shows prose** (e.g., "Sure, here's the extractor:") — the model started replying but never produced the delimiters. Retry once; the model usually cooperates on attempt 2.
2. **`rawPreview` shows code or structured content** — the model produced an answer but wrapped it differently (maybe in markdown fences, or in different delimiters). This means the model is ignoring the delimiter instruction. The prompt enforcement needs strengthening.

**Fix:**

1. **Retry once.** The Qwen provider's retry policy retries `invalid_response_format` up to 3 times (bucket A — retryable, not user-fixable). The wizard should already do this. If you're seeing it manually, just resend the same curl.
2. **If it fails 3 times in a row**, the model is consistently ignoring the delimiter instruction. Check the actual prompt sent by examining `step_4_verify_input.promptLen` in the trace — it should be ~154 chars longer than your original prompt (the delimiter instruction the provider appends). If it's not, the provider's prompt construction broke.
3. **If the prompt looks right but the model still ignores it**, the model may be in a state where it prioritizes other instructions over the delimiter one. Try a different prompt formulation — the batch wizard's prompt may need to move the delimiter instruction to the top, not the end, or use stronger language ("CRITICAL: You MUST..." instead of "IMPORTANT: You MUST...").

**Why this happens on Qwen specifically:** Qwen streams a "Thinking..." preamble before the answer. The strict-delimiter requirement is what prevents the provider from returning "Thinking..." as the content. A DeepSeek-style stability detector would return whatever text was there when it stabilized — and on Qwen, that's often the preamble. The strict delimiter requirement is a trade-off: it prevents false positives, at the cost of occasionally failing on genuine replies where the model didn't follow the instruction.

**The error is bucket A** — retry silently, don't beep. The retry usually succeeds, and if it doesn't, the source lands in `needs-review` for the operator to investigate.

---

## Symptom: `user_navigated`

**Diagnosis:** the work tab's URL changed mid-stream. The response is discarded rather than returning content from the wrong chat. The `streamUrl` guard working as designed.

**Cause:** the user clicked into a different chat while a prompt was streaming, or the provider auto-redirected (session expiry mid-stream, for example).

**Fix:** retry the request. The batch wizard's retry policy should already do this — `user_navigated` is `retryable: true, userFixable: true` (bucket C), so it retries twice before beeping.

**If it happens repeatedly:** the user is actively clicking around in the work tab during the batch. Tell them to leave the work tab alone while a batch is running. This is the one failure mode where the fix is procedural, not code.

**Multi-provider note:** `user_navigated` fires from whichever provider was running. The `err.trace` phase names tell you which. If it's consistently DeepSeek, the user is clicking around in the DeepSeek tab; if Qwen, the Qwen tab.

---

## Symptom: Qwen's age modal keeps appearing

**Diagnosis:** Qwen's "Confirm your age" modal appears repeatedly during a batch, blocking the input. The Qwen provider has a `dismissAgeModal()` function that runs before every action, but it's not catching every case.

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

**If the modal appears on every prompt:** that's a stronger signal — Qwen is flagging the automation. Slow down the pacing (the provider uses 1000-1500ms sleeps; try increasing to 2000ms). The trade-off is slower batches, but a batch that completes slowly is better than one that stalls on a modal every 3 prompts.

---

## Symptom: Qwen is much slower than DeepSeek

**Diagnosis:** Qwen requests take 7-10 seconds, DeepSeek requests take 4-8 seconds. This is **expected behavior**, not a bug.

**Why:** Qwen's provider inserts explicit `sleep()` calls between every action to prevent the React app from dropping the send click and to avoid triggering the age modal:

- 1000ms after dismissing the modal (wait for it to settle)
- 1000ms after finding the input (ensure UI is stable)
- 1500ms after typing (let React register the input value)
- 1000ms before clicking send
- 1500ms after clicking send (wait for network to initiate)

Total: ~5 seconds of pure pacing, on top of the model's own generation time (which is typically 2-4 seconds).

**Do not reduce the pacing to speed things up.** The pacing is what prevents two failure modes:

1. **Dropped send clicks** — Qwen's React app gets overloaded if you send too fast. Without the sleeps, the send click fails about 10% of the time, and the failure is `send_failed` (retryable but frustrating).
2. **Age modal triggers** — Qwen uses the age modal as a bot-defense signal. Fast action sequences trigger it more often.

The pacing trade-off was made during development after observing that fast actions led to significantly worse reliability. The current pacing produces a 99%+ first-attempt success rate on Qwen; reducing it drops below 90%. A 5-second-per-prompt overhead is worth a 10% failure rate.

**If you need faster batches:**

1. **Route sources to DeepSeek when possible.** DeepSeek is faster (no pacing overhead). Pivot to Qwen only when DeepSeek rate-limits.
2. **Batch in parallel across providers.** Two sources, one on DeepSeek and one on Qwen, run concurrently (they're on different tabs). See [integration-guide.md](integration-guide.md) for the pattern.
3. **Accept the slower pace.** A batch of 76 sources on Qwen takes ~10-13 minutes vs. 6-8 minutes on DeepSeek. That's still faster than the clipboard loop, and it doesn't fail.

**If Qwen is taking 20+ seconds per prompt:** something is wrong. Check the trace for where the time is going. If most time is in `step_7_wait_for_reply`, the model is generating a very long reply (check `step_8_reply_done.len`). If most time is in `step_2_find_input`, the input selector is slow — Qwen's DOM might have grown large. If most time is in `step_1_dismiss_modal`, the modal dismissal is running repeatedly — check whether the modal is actually being dismissed or just found repeatedly.

---

## Symptom: queue blocked by a crashed extension

**Diagnosis:** every new `/chat` hangs. The server log shows `-> dispatched <id>` for a previous request but no `ok done` or `x failed` for it. The previous request is stuck in `inFlight` forever, blocking the queue.

**This is the v0.2.0 "extension dies mid-flight" bug**, documented in [protocol.md#queue-state-machine](protocol.md#queue-state-machine). It happens when the extension picks up a job via `/next`, then crashes (service worker killed, tab crashed, browser closed) before posting `/reply`.

**Fix:** restart the server.

```bash
# Ctrl+C the running server
# Then restart:
node --env-file=.env src/server.js
```

After restart, the queue is empty, the extension reconnects via `/hello`, and the next `/chat` dispatches normally.

**If restarting the server doesn't clear it**, the extension is genuinely crashed, not just offline. Reload the extension (brave://extensions → reload) and hard-reload every provider tab. Then restart the server again.

**Prevention:** none in v0.2.0. The per-request server-side timeout is designed but not shipped. In practice, the extension crashing mid-stream is rare — most failures are graceful (`dom_drift`, `input_not_found`, `response_timeout`), which return via `/reply` and clean up `inFlight` correctly.

**Multi-provider note:** if two providers are being driven concurrently (two requests in-flight at once — which shouldn't happen since the queue is serialized, but could happen if the wizard bypasses the queue and calls `/next` directly), a crash on one provider could block the other. The queue serialization should prevent this; if you observe it, something is bypassing the queue.

---

## Server lifecycle

Start:

```bash
cd deepseek-connect
node --env-file=.env src/server.js
```

Stop: Ctrl+C. The server's `SIGINT` handler calls `server.stop()`, which rejects all in-flight and queued promises with `{ code: 'cancelled' }`, clears the queue, and closes the socket. The extension gets a network error on its next `/next` poll, retries with backoff, and reconnects once the server is back.

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

If the batch mixes providers (DeepSeek for some sources, Qwen for others, with pivot on rate limit):

1. **Open both provider tabs** before starting the batch. See [no_work_tab](#symptom-no_work_tab) for what happens if one is missing.
2. **Log into both providers** in the same browser session. Different accounts, same Chrome profile — the extension can't tell which account is logged into which tab, and doesn't care.
3. **Monitor rate limits independently.** DeepSeek and Qwen have separate quotas. A DeepSeek rate limit doesn't affect Qwen and vice versa.
4. **The Qwen tab needs to stay open even during DeepSeek-only phases.** If the wizard pivots to Qwen on the 5th source, the Qwen tab must have been open the whole time. Opening it mid-batch causes a `hello` re-registration, which is fine, but the first request after it opens might race with the registration.

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

1. **`dom_drift` fires with `requiredMissing: ["input"]` or `["toggleDeepThink"]` or `["toggleSearch"]`.** A DeepSeek selector broke. Escalate to [selector-maintenance.md#deepseek](selector-maintenance.md#deepseek).

2. **`input_not_found` fires repeatedly on Qwen** (no `no_work_tab` reason, Qwen tab exists, but the input selector doesn't match). The Qwen provider's `selectors.input()` needs a new tier. Escalate to [selector-maintenance.md#qwen](selector-maintenance.md#qwen).

3. **`chat_not_found` fires on a DeepSeek chat you know exists** — the sidebar fuzzy match failed. Could be a fuzzy-match bug (chat title doesn't contain the source name — common) or a sidebar walk bug. The primary mitigation is URL-based retry (see [getting-started.md#step-7--url-based-retry](getting-started.md#step-7--url-based-retry)) — but if you're seeing this on the first send per source, the sidebar walk is the last resort.

The recovery playbook for all three is [selector-maintenance.md](selector-maintenance.md), which is split by provider. If the fix is successful, the resulting change is a *new selector tier* in the provider's file — never a rewrite of the extraction logic, never a change to `content.js`'s structure. The tiered fallback design means old provider versions still work with the new tier added.