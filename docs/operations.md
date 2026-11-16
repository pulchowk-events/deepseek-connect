# Operations

Day-2 runbook for `deepseek-connect`. This doc is indexed by *symptom*, not by concept — find your failure in the [symptom index](#symptom-index), jump to the section, follow the fix. If you're looking for what each phase in the log means, read [log format](#log-format) first; nearly every symptom below is diagnosed by reading the trace.

If you're setting up for the first time, read [getting-started.md](getting-started.md) first. If you're modifying the extension, read [architecture.md](architecture.md) before touching anything here. If you're integrating into a wizard, [integration-guide.md](integration-guide.md) has the caller-side operational concerns.

**Contents**
- [Log format](#log-format)
- [Symptom index](#symptom-index)
- [Reload discipline](#reload-discipline)
- [Symptom: batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line)
- [Symptom: batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line)
- [Symptom: `content` is wrong](#symptom-content-is-wrong)
- [Symptom: `logged_out`](#symptom-logged_out)
- [Symptom: `extension_disconnected`](#symptom-extension_disconnected)
- [Symptom: `rate_limited`](#symptom-rate_limited)
- [Symptom: `input_not_found`](#symptom-input_not_found)
- [Symptom: `dom_drift`](#symptom-dom_drift)
- [Symptom: `user_navigated`](#symptom-user_navigated)
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

**Progress line** — one per `dsc_phase` message from the content script:

```
[HH:MM:SS]   ~ <id8> <phase> <json-extra>
```

The two leading spaces distinguish progress from request lines. `<phase>` is one of the twelve phases listed below.

**Trace line** — printed at `ok done` or `x failed`, summarizing the last few phases:

```
  trace[ok] <id8>   <t>ms <phase> <json-extra>
  trace[err] <id8>  <t>ms <phase> <json-extra>
```

The `trace` lines are redundant with the `~` lines (they're the same data, printed again at completion). They exist so a batch's final summary has the per-request timing without scrolling back through hundreds of `~` lines.

**The twelve phases**, in the order a successful prompt emits them:

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
| `replyDone` | `{completedBy, sawNew, stableLen}` | Completion detected. `completedBy: 'stable'` means text stopped growing; `'buttons'` means copy/regen appeared (mock page only). |
| `extract` | `{source, contentLen, rawLen}` | Extraction ran. `source: 'delimiter'` = markers found, `'fence'` = JS fence fallback, `'raw'` = raw text. |

A **successful** prompt emits: `probe` → `waitInput` → `toggleDeepthink` → `toggleSearch` → `setInput` → `sendClick` → `firstMsg` → (`reasoning` if DeepThink) → `answerStarted` → `answer` → `replyDone` → `extract`.

A **failed** prompt stops at the phase that failed. The last `~` line before `x failed` is the diagnosis.

---

## Symptom index

Find your symptom. Jump to the section.

| What you see | Section |
|---|---|
| `curl /chat` hangs forever, no `dispatched` in log | [Batch hangs with no `dispatched` line](#symptom-batch-hangs-with-no-dispatched-line) |
| `dispatched` appears but no `probe` after it | [Batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line) |
| `probe` → `firstMsg` → `reasoning` → silence | [Batch hangs after `dispatched` line](#symptom-batch-hangs-after-dispatched-line) |
| Content is reasoning text, not the answer | [Content is wrong](#symptom-content-is-wrong) |
| Content is from a different chat | [Content is wrong](#symptom-content-is-wrong) |
| `extract source: 'raw'` in the trace | [Content is wrong](#symptom-content-is-wrong) |
| Every request returns `logged_out` | [`logged_out`](#symptom-logged_out) |
| Every request returns `extension_disconnected` | [`extension_disconnected`](#symptom-extension_disconnected) |
| Every request returns `rate_limited` | [`rate_limited`](#symptom-rate_limited) |
| Every request returns `input_not_found` | [`input_not_found`](#symptom-input_not_found) |
| Every request returns `dom_drift` | [`dom_drift`](#symptom-dom_drift) |
| A prompt fails with `user_navigated` | [`user_navigated`](#symptom-user_navigated) |
| First request after a crash hangs | [Queue blocked by a crashed extension](#symptom-queue-blocked-by-a-crashed-extension) |
| Changes to `content.js` don't take effect | [Reload discipline](#reload-discipline) |

If your symptom isn't in the table, the diagnosis loop is:

```bash
# 1. Is the extension connected?
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool

# 2. What's the last line in the server log?
# (Find the request id from your failing curl, grep the log)

# 3. What phase did it stop at?
# (The last `~ <id8> <phase>` line tells you)

# 4. What's the content script doing?
# (F12 in the work tab, check the console for errors)
```

99% of the time, step 3 is the answer.

---

## Reload discipline

The single most common operational mistake. Read this once, internalize it, and you'll never spend 20 minutes on "I changed the code and nothing happened" again.

**Changing `content.js` requires hard-reloading the work tab.** Reloading the extension is *not enough*.

Why: content scripts are injected at page load. Reloading the extension restarts the service worker (`background.js`, `shared.js` on the extension side) but does **not** re-inject content scripts into already-open tabs. The tab keeps running the *old* content.js. Your change is on disk, in the extension's loaded code, but the tab that's actually executing the send/type/extract loop is running the pre-change version.

**The rule:**

| You changed | You must reload |
|---|---|
| `background.js`, `popup.js`, `popup.html` | Extension (brave://extensions → reload button) |
| `manifest.json` | Extension reload (may require full browser restart) |
| `content.js`, `selectors.js`, `shared.js` | Extension reload **AND** hard-reload every open `chat.deepseek.com` tab (Ctrl+Shift+R) |
| `src/server.js`, `src/client.js`, `src/errors.js` | Restart the server (Ctrl+C, `node --env-file=.env src/server.js`) |

When in doubt, reload everything: extension reload, hard-reload the work tab, restart the server. Takes 15 seconds, saves 20 minutes of debugging.

**How to confirm the reload worked:**

1. **Extension reload** → the server log prints a new `extension connected` line within 1-2 seconds. If it doesn't, the extension didn't reconnect — check brave://extensions for a red "Errors" badge.

2. **Work tab hard reload** → in brave://extensions, click the "service worker" link on the deepseek-connect card. The service worker's console shows content-script messages. After a hard reload, you should see a fresh "content script ready" log line (if you've added one — see below).

3. **Server restart** → the `listening on 127.0.0.1:7331` line reappears, followed by `extension connected`.

**Adding a diagnostic to content.js for reload confirmation.** If you're actively developing content.js and want proof the reload took effect, add this at the top of the file's IIFE:

```js
console.log('[dsc] content script loaded', new Date().toISOString());
```

Then in the work tab's DevTools console (F12), every hard-reload prints a new line with the current timestamp. If the timestamp doesn't update after a hard reload, the reload didn't take — the tab is still running cached content.js, and you need to close + reopen the tab (rare, but happens with aggressive tab caching).

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
  -d '{"messages":[{"role":"user","content":"test"}],"chat":"diag"}'
```

If the curl hangs and the log shows only `<- enqueued`, no `-> dispatched`, the extension isn't polling.

**Fix, in order:**

1. **Is the extension connected?** Check the server log for `extension connected` within the last minute. If it's absent, the extension never registered. Go to brave://extensions, confirm deepseek-connect is loaded and enabled, and check for errors on its card.

2. **Is the token correct?** The extension compares its stored token against what the server expects byte-for-byte. If they differ, the extension's `/hello` returns 401 and it never registers. Check:
   ```bash
   curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs
   ```
   If this returns `{ok: true, tabs: [...]}`, your token is correct. If it returns `{ok: false, error: "auth_failed"}`, the token in `.env` doesn't match what you're passing. If the token is correct on the curl but the extension still isn't registering, the popup's stored token is wrong — open the popup and re-save.

3. **Is there a `chat.deepseek.com` tab open?** The extension registers only if it finds at least one DeepSeek tab. No tab = no registration = no polling. Open `https://chat.deepseek.com/` and wait 2 seconds.

4. **Is the service worker running?** In brave://extensions, click the "service worker" link on the deepseek-connect card. If the link is greyed out, the service worker is suspended (Chrome kills MV3 workers after ~30s of inactivity). Any event — an extension reload, a tab URL change — wakes it. If reloading the extension doesn't wake it, check the extension's Errors panel.

**If none of these fix it**, the extension's service worker is running but its poll loop has a bug. Open its console (brave://extensions → service worker link) and check for uncaught exceptions or a stalled `fetch('/next')`. See [Batch hangs after dispatched](#symptom-batch-hangs-after-dispatched-line) for the deeper debugging loop.

---

## Symptom: batch hangs after `dispatched` line

**Diagnosis:** the server dispatched the job to the extension (`-> dispatched` appeared) but the extension never replied (`ok done` / `x failed` never appeared). The job is stuck.

The last `~ <id8> <phase>` line tells you where. Each phase corresponds to a specific failure:

**Stuck after `dispatched`, no `probe`.** The content script never ran. Either:
- The work tab isn't on `chat.deepseek.com` (check with `curl /tabs`)
- The content script crashed before emitting `probe` (F12 in the work tab, check Console for errors)
- Background's `chrome.tabs.sendMessage` failed (`Receiving end does not exist` — the content script isn't injected; reload the tab with Ctrl+Shift+R)

**Stuck after `probe`, before `sendClick`.** The content script ran but a phase failed silently. Check the last phase:
- `waitInput {found: false}` — input box not found. See [input_not_found](#symptom-input_not_found).
- `toggleDeepthink {ok: false}` — DeepThink couldn't be enabled. See [deepthink_enable_failed](#symptom-dom_drift) (same diagnosis path as `dom_drift` if the toggle moved).
- `setInput {promptLen, typedLen}` with `typedLen < promptLen` — the input didn't accept the full text. Usually a timing issue; retry once.

**Stuck after `sendClick`, no `firstMsg`.** The send clicked but DeepSeek didn't respond. Either:
- The click didn't register (DeepSeek's React dropped the event — see `send_failed` in [error-codes.md](error-codes.md#bucket-a)). Retry once; usually succeeds on attempt 2.
- The page is rate-limited and DeepSeek silently swallowed the request. Check the work tab visually — if there's no user message visible, the send didn't go through. If there's a "too many requests" toast, see [rate_limited](#symptom-rate_limited).

**Stuck after `firstMsg`, before `answerStarted`.** The reasoning stream is running but the answer never started. This happens with DeepThink on very complex prompts — the model's reasoning phase can take 60+ seconds. Wait for `RESPONSE_TIMEOUT_MS` (90s default). If it times out, the prompt is too complex or the model is stuck; see `response_timeout` in [error-codes.md](error-codes.md).

**Stuck after `answerStarted`.** Same as above — the answer is streaming but slow. Wait for completion. If it exceeds 90s, timeout fires with `response_timeout`.

**Hangs indefinitely with no trace line at `x failed`.** This is the [queue blocked by a crashed extension](#symptom-queue-blocked-by-a-crashed-extension) case. The extension crashed after `/next` but before `/reply`. Restart the server.

**The work tab shows the prompt but it hasn't been sent.** The input was typed but `sendClick` didn't fire, or fired and didn't register. Manually click send in the tab to unblock (the content script will detect the assistant message and complete normally). Then check the `sendClick` trace — if `ms` is present but no `firstMsg` follows, that's the bug; see `send_failed`.

---

## Symptom: `content` is wrong

**Diagnosis:** the request completes (`ok done`) but the returned `content` isn't what you asked for. Several distinct causes; the `extract` trace line distinguishes them.

**`extract source: 'raw'` with reasoning text.** The completion detector locked onto the reasoning stream instead of the answer. Content is the model's plan ("The user wants me to..."), not its output. Known bug in older builds — see [decision 6](architecture.md#6-answer-block-extraction-over-whole-message). If you're on current `main`, this shouldn't happen; if it does, file an issue with the `trace` array.

**`extract source: 'raw'` with the full assistant message.** The extraction fell through all passes — the LLM didn't include delimiters (`START_*`/`END_*`), and there's no JS code fence either. The `raw` content is the whole message. This is a **prompt** bug, not a code bug: your prompt didn't instruct the LLM to emit delimiters, or the LLM ignored the instruction. Fix the prompt (see [integration-guide.md](#the-batch-loop) for the batch wizard's prompt shape) or accept `raw` and extract yourself.

**`extract source: 'raw'` with a short reply.** The LLM replied without delimiters and without a code block. If your prompt asked it to say a specific string, the string should be `content` directly. If not, check that the prompt actually contained the delimiters — the batch wizard has a bug where the source name isn't in the first line, so DeepSeek auto-names the chat wrongly and the sidebar match fails on the second call.

**`extract source: 'fence'` when you expected `'delimiter'`.** The LLM ignored the delimiters but did emit a fenced code block. Extraction fell back to the last ```js fence. This is usually fine for the batch wizard (it just wants the code) but means your prompt's delimiter instruction isn't reaching the LLM. Check `prompt` in the `setInput` trace — if the delimiters aren't there, your prompt construction is broken.

**`content` from a completely different chat.** Cross-chat contamination. The `streamUrl` guard should prevent this (see [architecture.md#the-two-streaming-guards](architecture.md#the-two-streaming-guards)), but if it fires, check `trace` for a `user_navigated` phase before `replyDone`. If there's no `user_navigated` but the content is wrong, the sidebar match returned the wrong chat on `ensureChat` — see [Symptom: `input_not_found`](#symptom-input_not_found)'s sidebar debugging, or check `debug.leafPreview` from a `/open` call.

**`content` is correct but `chat` in the response is wrong.** The `chat` field is what you sent, not what DeepSeek actually used. `ensureChat` might have matched a different chat and used it. If the `chat` field matters (for follow-up calls), check `/open`'s response first and confirm `existing: true` and `chat` matches your expectation.

---

## Symptom: `logged_out`

**Diagnosis:** the work tab shows DeepSeek's login screen. Session expired, cookies gone, or the account was logged out on another tab.

**Fix:** click into the work tab, log in to DeepSeek. Confirm you see the chat input at the bottom. The extension will pick it up on the next request — no server restart, no extension reload needed.

**If logging in doesn't fix it:**

```bash
# Check that the tab URL is a chat page (not /login)
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

The `url` field should be `https://chat.deepseek.com/` or `https://chat.deepseek.com/a/chat/s/...`. If it's `https://chat.deepseek.com/login` or `https://chat.deepseek.com/sign-in`, the login didn't complete. Refresh the tab, log in again.

**Why this happens:** DeepSeek sessions expire after some period of inactivity (typically a few days). The extension can't renew them — that's a credential operation that requires the user. The mitigation is: log in once, keep the tab open for the duration of a batch. If a batch takes long enough that the session expires mid-run, the first failing request will be `logged_out`, and the batch loop's beep (see [error-codes.md#bucket-d](error-codes.md#bucket-d--beep-no-auto-retry-7-codes)) will tell the user.

---

## Symptom: `extension_disconnected`

**Diagnosis:** every request returns `extension_disconnected`. The server is up but no extension is talking to it. Three possible causes.

**Cause 1 — Extension not loaded.** Check brave://extensions. If deepseek-connect isn't in the list, click Load unpacked and select the directory. If it's in the list but disabled, toggle it on.

**Cause 2 — Token mismatch.** The popup's token and `.env`'s `EXTENSION_TOKEN` differ. Compare byte-for-byte. If they differ:

1. Open the popup, correct the token, click Save
2. Reload the extension (brave://extensions → reload)
3. Check the server log for a new `extension connected` line

The extension's `/hello` sends the token in the `Authorization` header. If the token is wrong, the server responds 401, and the extension's registration loop retries with backoff (1s/2s/5s/10s). After the third retry, the extension gives up — the popup's status dot goes red. Correcting the token and clicking Save restarts the registration immediately.

**Cause 3 — No DeepSeek tab open.** Open `https://chat.deepseek.com/` and wait 2 seconds. The extension registers on the next tab event.

**Confirm the fix:**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

Expected:
```json
{
  "ok": true,
  "tabs": [{"id": ..., "url": "https://chat.deepseek.com/...", "title": "...", "active": ...}]
}
```

If `tabs` is empty, the extension is connected but doesn't see any DeepSeek tabs — open one. If the request returns `auth_failed`, your curl's token is wrong (not the extension's — this is a caller-side issue). If it returns a network error, the server isn't running.

---

## Symptom: `rate_limited`

**Diagnosis:** DeepSeek is throttling the account. The response contains text matching "too many requests" or "rate limit". This is the most common failure for a batch running many sources back to back with DeepThink enabled.

**Fix:**

1. **Wait 30 seconds.** The extension's `rate_limited` error carries `retryAfter: 30000`. The batch wizard's retry policy should `await sleep(err.retryAfter)` before the retry (see [integration-guide.md#sendwithretry](integration-guide.md#sendwithretry)). This is automatic in a well-built wizard — you don't have to do anything.

2. **If retries still fail**, the rate window has moved. Restart the batch after a longer pause (2-5 minutes).

**Prevention:** if this happens regularly, the batch is running too fast for the account's quota. Options:

- Increase the pause between sources (the batch wizard's flag is per-batch, not per-source; adding a `--delay` flag is a follow-up)
- Disable DeepThink for prompts that don't need reasoning (the extension's auto-enable can't be bypassed per-request in v0.1 — it's on every prompt)
- Use a different DeepSeek account (out of scope for the extension's design — one profile, one account)

The extension **cannot** do anything about rate limits. It reports them accurately, and the caller's policy decides what to do. See [error-codes.md#bucket-b](error-codes.md#bucket-b--retry-after-delay-no-beep-1-code).

---

## Symptom: `input_not_found`

**Diagnosis:** the work tab doesn't have a chat input box where the extension expects one. Four causes, in order of frequency.

**Cause 1 — Wrong URL.** The work tab is on a non-chat page. Confirm:

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

The `url` field must be `https://chat.deepseek.com/` or `https://chat.deepseek.com/a/chat/s/...`. If it's anything else (`/login`, `/app`, a settings page), navigate to `chat.deepseek.com` in the tab and retry.

**Cause 2 — Tab closed.** The extension pinned the tab when it registered, but the user closed it. The extension's `getWorkTab` now returns `null` (the stored `workTabId` no longer points at a valid tab). Open a fresh `chat.deepseek.com/` tab and the extension will re-pin on the next registration.

**Cause 3 — Loading state.** The tab is still loading a chat page. The extension's `waitForInputReady(5000)` times out after 5 seconds. If the page is genuinely slow to load (network, cold cache), retry — it usually succeeds on attempt 2.

**Cause 4 — DOM drift.** The input selector matched before, but DeepSeek's DOM changed. Check the `probe` field on the error:

```json
{
  "probe": {
    "healthy": ["toggleDeepThink", "toggleSearch", "chatList"],
    "degraded": ["sendButton"],
    "requiredMissing": ["input"]
  }
}
```

`requiredMissing: ["input"]` means the input selector returned null. If `healthy` has other entries, the page loaded fine — it's the input selector specifically. That's [dom_drift](#symptom-dom_drift). Escalate to [selector-maintenance.md](selector-maintenance.md).

**If `probe` is empty** (all fields null or empty arrays), the content script couldn't run — likely the tab crashed or the content script was unloaded. Hard-reload the tab (Ctrl+Shift+R) and retry.

---

## Symptom: `dom_drift`

**Diagnosis:** DeepSeek shipped a UI change and one or more required selectors no longer match. This is the failure the extension is *designed* to fail loudly on — better a clean `dom_drift` than silent cross-chat contamination.

**Confirm:**

```bash
# Send a test prompt
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}],"chat":"dom-check"}' \
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

1. F12 in the work tab, run the diagnostic snippet from [selector-maintenance.md#diagnosing-a-drift](selector-maintenance.md#diagnosing-a-drift)
2. Update `selectors.js` with the new selector as a fallback tier
3. Reload extension + hard-reload tab
4. Re-test with the curl above
5. If successful, commit the selector change

**Do not** try to fix `dom_drift` by retrying the same prompt. It will fail with the same error every time. The DOM is the DOM.

**Prevention:** the extension's selector strategy is tiered — text-content first, structural walk second, `aria-` attributes third. This means a class-name change (common) doesn't produce `dom_drift` (the walk still finds the elements). Only a structural change (rare, ~every 6 months) does. The `probe` field tells you which type of change happened.

---

## Symptom: `user_navigated`

**Diagnosis:** the work tab's URL changed mid-stream. The response is discarded rather than returning content from the wrong chat. This is the `streamUrl` guard working as designed — see [architecture.md#the-two-streaming-guards](architecture.md#the-two-streaming-guards).

**Cause:** the user clicked into a different chat while a prompt was streaming, or DeepSeek auto-redirected (session expiry mid-stream, for example).

**Fix:** retry the request. The batch wizard's retry policy should already do this — `user_navigated` is `retryable: true, userFixable: true` (bucket C in [error-codes.md](error-codes.md)), so it retries twice before beeping.

**If it happens repeatedly:** the user is actively clicking around in the work tab during the batch. Tell them to leave the work tab alone while a batch is running. This is the one failure mode where the fix is procedural, not code.

**Confirm the guard fired correctly:** the `trace` for a `user_navigated` failure ends with:
```
  trace[err] <id8>  <t>ms replyDone {"completedBy": null, ...}    # or no replyDone
  trace[err] <id8>  <t>ms user_navigated {"expected": "...", "actual": "..."}
```
The `expected` field is the captured `streamUrl`; `actual` is where the tab ended up. If they're the same URL, the guard is firing incorrectly — file a bug. If they differ, the guard is working.

---

## Symptom: queue blocked by a crashed extension

**Diagnosis:** every new `/chat` hangs. The server log shows `-> dispatched <id>` for a previous request but no `ok done` or `x failed` for it. The previous request is stuck in `inFlight` forever, blocking the queue.

**This is the v0.1 "extension dies mid-flight" bug**, documented in [protocol.md#queue-state-machine](protocol.md#queue-state-machine). It happens when the extension picks up a job via `/next`, then crashes (service worker killed, tab crashed, browser closed) before posting `/reply`. The server's `inFlight` map keeps the entry; `pump()` never advances; new requests queue up behind it.

**Fix:** restart the server.

```bash
# Ctrl+C the running server
# Then restart:
node --env-file=.env src/server.js
```

After restart, the queue is empty, the extension reconnects via `/hello`, and the next `/chat` dispatches normally. The stuck request's caller (if any) has already timed out at the HTTP client level — the server can't retry it, and the caller's `DSCError('extension_timeout')` is what they saw.

**If restarting the server doesn't clear it**, the extension is genuinely crashed, not just offline. Reload the extension (brave://extensions → reload) and hard-reload the work tab. Then restart the server again.

**Prevention:** none in v0.1. The per-request server-side timeout is designed but not shipped (see [protocol.md#extending-the-protocol](protocol.md#extending-the-protocol)). In practice, the extension crashing mid-stream is rare — most failures are graceful (`dom_drift`, `input_not_found`, `response_timeout`), which return via `/reply` and clean up `inFlight` correctly. The "extension dies mid-flight" case is genuinely exceptional.

**If you're debugging why the extension crashed:** open brave://extensions, click "Errors" on the deepseek-connect card. If the card shows a red "Errors" badge, click it — the crash trace is there. Common causes: an uncaught exception in `content.js` (usually a selector returning `null` when the code assumed non-null), or an out-of-memory crash in the service worker (rare, usually from a runaway loop).

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

For the browser side: load the extension in Brave/Chrome as usual, set the token, open a `chat.deepseek.com` tab. The extension reconnects to the systemd-managed server on the same port. On a fresh boot, the extension's `/hello` might fire before the server is up — the backoff handles this (1s/2s/5s/10s, then stuck until the next tab event). Opening the DeepSeek tab after the server is up is the cleanest order.

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

Or use `journalctl` instead of a file by setting `StandardOutput=journal` in the unit file. Either works; the file is easier to grep for a specific request ID.

---

## Diagnostics cheat sheet

One-liners for the commands you'll type most.

**Is the extension connected?**

```bash
curl -s -H "Authorization: Bearer $EXTENSION_TOKEN" http://127.0.0.1:7331/tabs | python3 -m json.tool
```

Empty `tabs` = not connected or no DeepSeek tabs open. `auth_failed` = token mismatch on the curl side. Network error = server not running.

**Send a test prompt:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: ok"}],"chat":"diag"}' \
  | python3 -m json.tool
```

Fastest end-to-end test. If this returns `{content: "ok", ...}`, the whole pipeline works. If not, the error code is your diagnosis.

**Find a specific request in the log:**

```bash
# Given a request ID (first 8 chars is enough)
grep "<id8>" /path/to/deepseek-connect.log
```

Or, if you're watching live:

```bash
tail -f /path/to/deepseek-connect.log | grep "<id8>"
```

**What phase did the last request reach?**

```bash
# Last 20 lines of the log
tail -20 /path/to/deepseek-connect.log

# Or just the request-phase lines (skip `~` progress)
tail -50 /path/to/deepseek-connect.log | grep -E "(enqueued|dispatched|ok done|x failed)"
```

**Is the content script alive in the work tab?**

F12 in the work tab, then in the console:

```js
typeof DSC !== 'undefined'
// Expected: "object"  — the shared.js global is loaded

typeof DSC_SELECTORS !== 'undefined'
// Expected: "object"  — the selectors.js global is loaded

DSC_SELECTORS.resolve('input')
// Expected: { el: <textarea>, kind: 'healthy', tier: 0, tried: [...] }
```

If `DSC` or `DSC_SELECTORS` are `undefined`, the content script didn't inject. Hard-reload the tab (Ctrl+Shift+R) and check again. If they're `undefined` after a hard reload, the extension is broken — check its Errors panel.

**Is the sidebar walk finding chats?**

```js
// In the work tab console
(() => {
  const side = document.querySelector('[class*="sider"]');
  // Or the "New chat" text anchor
  const btn = Array.from(document.querySelectorAll('*')).find(
    e => (e.textContent || '').trim() === 'New chat' && e.children.length === 0
  );
  let container = btn;
  for (let i = 0; i < 10 && container; i++) {
    const r = container.getBoundingClientRect();
    if (r.height > 400 && r.width > 100 && r.width < 500) return { found: true, w: r.width, h: r.height };
    container = container.parentElement;
  }
  return { found: false };
})()
```

`found: true` with sensible dimensions means the sidebar walk's anchor is intact. If the `New chat` button text changed, `found: false` and that's your `dom_drift`.

---

## When to escalate to selector-maintenance

Three situations. In each, the fix is in `selectors.js`, not in any caller:

1. **`dom_drift` fires with `requiredMissing: ["input"]` or `["toggleDeepThink"]` or `["toggleSearch"]`.** A required selector broke. Escalate to [selector-maintenance.md](selector-maintenance.md).

2. **`input_not_found` fires repeatedly with `probe.healthy` showing some selectors and `probe.requiredMissing` showing the input.** Same as above — the input selector specifically broke.

3. **`chat_not_found` fires on a chat you know exists** — the sidebar fuzzy match failed. Could be a fuzzy-match bug (chat name doesn't actually contain the source name) or a sidebar walk bug. Check `debug.leafPreview` from a `/open` call first — if the chat title isn't in the preview, it's a walk bug; if it is, it's a matching bug.

The recovery playbook for all three is [selector-maintenance.md](selector-maintenance.md). If the fix is successful, the resulting change is a *new selector tier* in `selectors.js` — never a rewrite of the extraction logic, never a change to `content.js`'s structure. The tiered fallback design means old DeepSeek versions (via the mock page) still work with the new tier added.