# Error codes

The `DSCError` taxonomy. Twenty codes, every failure mode the extension or server can report, and — the part that matters for integrators — the decision rule for what to do about each one. Read this before writing a `try/catch` around any `deepseek-connect` call.

Companion to [protocol.md](protocol.md), which defines the error *shape*; this doc defines the error *meanings* and the wizard's response to each. If the two disagree on a code's metadata, [src/errors.js](../src/errors.js) is authoritative — this doc tracks it, not the other way around.

**Contents**
- [Three metadata flags](#three-metadata-flags)
- [Decision tree](#decision-tree)
- [Five decision buckets](#five-decision-buckets)
- [Full code table](#full-code-table)
- [Per-code reference](#per-code-reference)
- [Common try/catch patterns](#common-trycatch-patterns)
- [Adding a new code](#adding-a-new-code)

---

## Three metadata flags

Every `DSCError` carries three booleans (plus an optional `retryAfter`) that answer three separate questions. Understanding the difference between them is the entire reason this taxonomy exists — a `catch` block that only reads `code` and hardcodes per-code logic will drift from the metadata within a month.

### `retryable`

> Can the caller safely resend the exact same request?

`true` means yes — no state has changed on the server that would make the retry produce a different outcome than the original would have if it had succeeded. The retry is *safe*; it may still fail with the same code again, but if it succeeds the result is indistinguishable from a first-attempt success.

`false` means no — the same request will fail again with the same code. Either something external must change first (user logs in, tab opens, DeepSeek DOM updates), or the request itself is wrong (bad shape, unknown requestId). Retrying wastes time and, for `rate_limited` specifically, can make the rate limit worse.

**Does not imply `userFixable`.** `dom_drift` is `retryable: false, userFixable: false` — the code is broken, not the user. `auth_failed` is `retryable: false, userFixable: true` — the user has to fix the token.

### `userFixable`

> Is there something a human must do before this can succeed?

`true` means yes — the failure is a state the operator can change. The token in `.env` is wrong, the tab closed, DeepSeek logged the user out, the DeepThink toggle got stuck. Beeping and surfacing the message is the right response; silently retrying is not, because the retry will fail until the human acts.

`false` means no — either the code is at fault (`dom_drift`), the caller is at fault (`bad_request`), or the failure is transient and clears on its own (`internal_error`, `extension_timeout`). Retrying or skipping is the right response; beeping at the user is not, because there's nothing they can do.

`userFixable: true` does not mean "don't retry." Two codes — `extension_disconnected` and `response_timeout` — are both `retryable` and `userFixable`. The pattern for those is: retry a small number of times (2–3), then beep. The first retry usually succeeds; the beep is for the cases where it doesn't.

### `retryAfter`

> Milliseconds to wait before the retry, if `retryable`.

Only `rate_limited` sets a non-zero value (30000ms). Every other retryable code defaults to 0 — retry immediately. The field is present on every `DSCError` as `0` when irrelevant, so a caller can unconditionally `await sleep(err.retryAfter)` and it does the right thing.

### HTTP status

The `http` field is what the caller's HTTP client sees, derived from the code via `httpStatusFor(code)`. It exists so that a proxy, load balancer, or monitoring dashboard sees a sensible status (401 for auth, 429 for rate limit, 504 for timeout) rather than a uniform 500 for every application error. It is **not** the primary decision signal — the code is. A wizard that switches on `res.status` instead of `err.code` is reading the wrong field.

---

## Decision tree

For any `DSCError`, the recommended response is:

```mermaid
flowchart TD
    Err["DSCError caught"]
    Err --> Retry{"retryable?"}

    Retry -->|"yes"| Attempts{"attempts < 3?"}
    Attempts -->|"yes"| Sleep["await sleep(err.retryAfter)"]
    Sleep --> Resend["resend same request"]
    Resend --> Err

    Attempts -->|"no"| Fix{"userFixable?"}
    Retry -->|"no"| Fix

    Fix -->|"yes"| Beep["beep 3× at 20s intervals<br/>surface err.reason to operator<br/>wait for user action"]
    Beep --> Retry2{"user fixed it?"}
    Retry2 -->|"yes"| Resend
    Retry2 -->|"no"| Skip["mark source needs-review<br/>advance to next source"]

    Fix -->|"no"| Skip

    Skip --> End["next source"]
```

Three things the diagram encodes:

1. **Retry before beep.** A `retryable && userFixable` code goes through the retry loop first. Only after 3 failed attempts does it escalate to a beep. `extension_disconnected` during a brief server restart is the canonical case — the retry succeeds, the user never sees a beep.
2. **Beep before skip.** A `!retryable && userFixable` code beeps. It does not auto-skip. The wizard's `needs-review` marker is set only after the beep sequence completes without the user acting.
3. **Skip without beep.** A `!retryable && !userFixable` code skips silently. `dom_drift` is the canonical case — the selector changed, the user can't fix it from the CLI, beeping would just be noise. Log the code, mark the source, move on.

The `attempts < 3` cap is a wizard-side policy, not a `DSCError` guarantee. See [integration-guide.md#retry-policy](integration-guide.md#retry-policy) for the wizard's actual retry loop.

---

## Five decision buckets

Twenty codes, grouped by their response. Every code falls into exactly one bucket.

### Bucket A — Retry, no beep (4 codes)

`retryable: true, userFixable: false`. Transient failures. Retry up to 3 times with no beep, no user surface, no `needs-review` marker. If all 3 fail, fall through to bucket E (skip).

| Code | What causes it | Typical fix |
|---|---|---|
| `send_failed` | The send click didn't register — DeepSeek's React dropped the event, or the input cleared before send | Retry; usually succeeds on attempt 2 |
| `internal_error` | Unexpected server error, an unregistered code collapsed to this | Retry; if consistent, check server logs |
| `extension_stale` | Extension hasn't polled `/next` in over 60s — usually a service worker restart | Retry; extension reconnects within a few seconds |
| `extension_timeout` | Server didn't get a `/reply` within the expected window — usually a slow DeepSeek stream | Retry; if consistent, check that the work tab is still responsive |

**Do not beep for these.** A user seeing a beep for `internal_error` on retry 1 of 3 will waste 40 seconds staring at a terminal for something that resolves itself.

### Bucket B — Retry after delay, no beep (1 code)

`retryable: true, retryAfter: 30000, userFixable: false`. Rate limited. Retry once after the delay, then fall through to bucket E (skip).

| Code | What causes it | retryAfter |
|---|---|---|
| `rate_limited` | DeepSeek returned a rate-limit response — too many prompts in a short window, or DeepThink active on a low-quota account | 30000ms |

**One retry, not three.** The `attempts < 3` cap doesn't apply here — a caller who hits `rate_limited` twice in 60 seconds is being told by DeepSeek to back off, and a third retry will just produce `rate_limited` again with a longer window. After one delayed retry, skip the source and move on.

### Bucket C — Retry, then beep (2 codes)

`retryable: true, userFixable: true`. Dual-flag — retry first, but if retries exhaust, escalate to beep. The retry handles transient cases (brief extension restart, slow stream); the beep handles the case where the transient condition has become permanent.

| Code | What causes it | When to beep |
|---|---|---|
| `response_timeout` | No answer within the timeout window — DeepSeek's stream stalled, DeepThink is taking unusually long, or the tab is backgrounded and Chrome throttled it | After 2 retries with the same code; the third beep is the user's signal to check the tab |
| `extension_disconnected` | Extension hasn't polled `/next` in over 60s — service worker crashed, or `.env` token was changed without reloading the extension | After 2 retries with the same code; the third beep is the user's signal to reload the extension |

**The beep message must be specific.** `extension_disconnected` says "reload the extension in `brave://extensions`"; `response_timeout` says "check the work tab — DeepSeek might be stuck streaming". The reason field carries this through; beep renderers should not collapse it to the code name.

### Bucket D — Beep, no auto-retry (7 codes)

`retryable: false, userFixable: true`. The operator must act. Beep 3 times at 20-second intervals, surface `err.reason` to the terminal, wait. If the user doesn't act by the third beep, mark `needs-review` and advance to the next source.

| Code | What causes it | User action |
|---|---|---|
| `auth_failed` | Bearer token mismatch — `.env` and popup disagree on `EXTENSION_TOKEN` | Set the same token in `.env` and the popup |
| `deepthink_enable_failed` | Could not verify DeepThink is on after clicking the toggle | Manually toggle DeepThink on, confirm it stays on |
| `input_not_found` | The chat input box isn't where it should be — tab closed, wrong page, or the DOM changed | Open the work tab, confirm it's `chat.deepseek.com`, refresh |
| `logged_out` | The work tab shows DeepSeek's login screen — session expired | Log in to DeepSeek in the work tab |
| `protocol_version_mismatch` | Server and extension disagree on the protocol version — **not raised in v0.1**, see [protocol.md#version-negotiation](protocol.md#version-negotiation) | Reload the extension, restart the server |
| `search_enable_failed` | Could not verify Search is on after clicking the toggle | Manually toggle Search on, confirm it stays on |
| `user_navigated` | The work tab URL changed mid-stream — user clicked into a different chat while a reply was streaming | Don't touch the work tab while a prompt is running |

`input_not_found` and `logged_out` are the two most common beeps. `deepthink_enable_failed` and `search_enable_failed` are rarer but harder to debug — the beep message names the specific toggle, so the user isn't guessing.

### Bucket E — Skip without beep (6 codes)

`!retryable, !userFixable`. The request will never succeed with the same inputs. Log the code, mark the source `needs-review`, advance. No beep, no waiting, no user surface beyond the log line.

| Code | What causes it | What happened |
|---|---|---|
| `bad_request` | Malformed request — missing `messages`, missing `chatName`, wrong types | Caller bug — check the request shape against [protocol.md](protocol.md) |
| `cancelled` | `/cancel` was called on this requestId — **route not shipped in v0.1**, see [protocol.md#extending-the-protocol](protocol.md#extending-the-protocol) | Caller aborted the request |
| `chat_not_found` | Could not find or create the requested chat | Sidebar and new-chat navigation both failed |
| `dom_drift` | Required selectors missing from the DeepSeek DOM — a page redesign | The extension is out of date; see [selector-maintenance.md](selector-maintenance.md) |
| `unknown_request` | `/reply` carried a `requestId` that isn't in `inFlight` | Internal inconsistency — usually a double-reply after a server restart |
| `user_skipped` | The user clicked "Skip site" in the popup — **button not shipped in v0.1** | User explicitly skipped the source |

`dom_drift` is the one to watch. Everything else in this bucket is either a caller bug (won't happen in a well-built wizard) or a planned-but-unshipped feature (won't fire yet). `dom_drift` will happen — DeepSeek ships UI changes regularly, and every one is a candidate. The `probe` field on the error carries the specific missing selector names; that's the handoff to [selector-maintenance.md](selector-maintenance.md).

`user_skipped` sits in bucket E by behavior but is flagged `userFixable: true` in `src/errors.js` — the user is the one who chose to skip. A wizard that follows bucket-D beep rules blindly for `user_skipped` would beep at the user who just clicked "Skip". The metadata is correct; the wizard's per-code policy must override the generic flag rule for this one.

---

## Full code table

Sorted by bucket, then alphabetically within bucket. Use this for reference lookups — the prose sections above are for understanding.

| Bucket | Code | `retryable` | `retryAfter` | `userFixable` | HTTP | One-line reason |
|---|---|---|---|---|---|---|
| **A** | `extension_stale` | ✓ | 0 | ✗ | 409 | Extension stopped polling |
| **A** | `extension_timeout` | ✓ | 0 | ✗ | 504 | Extension didn't respond in time |
| **A** | `internal_error` | ✓ | 0 | ✗ | 500 | Unexpected server error |
| **A** | `send_failed` | ✓ | 0 | ✗ | 502 | Send click didn't register |
| **B** | `rate_limited` | ✓ | 30000 | ✗ | 429 | DeepSeek rate limit hit |
| **C** | `extension_disconnected` | ✓ | 0 | ✓ | 409 | Extension not connected |
| **C** | `response_timeout` | ✓ | 0 | ✓ | 504 | No answer within timeout |
| **D** | `auth_failed` | ✗ | 0 | ✓ | 401 | Bearer token mismatch |
| **D** | `deepthink_enable_failed` | ✗ | 0 | ✓ | 502 | DeepThink couldn't be verified on |
| **D** | `input_not_found` | ✗ | 0 | ✓ | 502 | Chat input not found |
| **D** | `logged_out` | ✗ | 0 | ✓ | 401 | Not logged in to DeepSeek |
| **D** | `protocol_version_mismatch` | ✗ | 0 | ✓ | 500 | Protocol versions differ |
| **D** | `search_enable_failed` | ✗ | 0 | ✓ | 502 | Search couldn't be verified on |
| **D** | `user_navigated` | ✗ | 0 | ✓ | 409 | Work tab URL changed mid-stream |
| **E** | `bad_request` | ✗ | 0 | ✗ | 400 | Malformed request |
| **E** | `cancelled` | ✗ | 0 | ✗ | 499 | Request cancelled by caller |
| **E** | `chat_not_found` | ✗ | 0 | ✗ | 404 | Chat not found and not creatable |
| **E** | `dom_drift` | ✗ | 0 | ✗ | 500 | DeepSeek DOM changed |
| **E** | `unknown_request` | ✗ | 0 | ✗ | 404 | Unknown requestId |
| **E** | `user_skipped` | ✗ | 0 | ✓ | 499 | Skipped by user via popup |

**Sanity check:** 4 (A) + 1 (B) + 2 (C) + 7 (D) + 6 (E) = 20. Matches `Object.keys(CODES).length` in `src/errors.js`.

---

## Per-code reference

The one-liner in the full table is what fits on a log line. This section is what fits in a beep message or a `needs-review` terminal row.

### Bucket A

#### `extension_stale`

**Raises in:** `src/server.js`, when the extension hasn't polled `/next` in over 60 seconds. **Not raised in v0.1** — the heartbeat check is designed but not shipped. The code exists in `errors.js` for the future implementation.

**Means:** the extension's service worker was killed by Chrome (happens after ~30s of inactivity on MV3) and hasn't woken up yet. On the next tab event, the service worker restarts and re-polls.

**Retry:** yes, up to 3 attempts. In practice, attempt 2 succeeds because the content-script message that triggers the service worker wake-up has fired by then.

**Beep:** no. Self-resolves on retry.

**Details:** when shipped, the field will carry `{ lastPollAt, sinceMs }` so the retry policy can be adaptive.

#### `extension_timeout`

**Raises in:** `src/server.js`, when a per-request deadline fires with no `/reply` received. **Not raised in v0.1** — the per-request deadline is designed but not shipped; the caller's HTTP client timeout is the current mechanism (which the caller sees as a network error, not a `DSCError`).

**Means:** the extension picked up the job but never finished. Either the send never clicked, the stream never completed, or the content script crashed silently.

**Retry:** yes, up to 3 attempts with increasing wait — first retry immediately, second after 5s, third after 15s.

**Beep:** no. Retry usually resolves.

**Details:** when shipped, carries `{ requestId, elapsedMs, lastPhase }` so the wizard knows whether the job got as far as `sendClick` or stalled at `firstMsg`.

#### `internal_error`

**Raises in:** `src/server.js`, `src/errors.js`, or anywhere a code propagates that isn't in `CODES`. The client-side `fromReply` helper collapses unknown codes to this.

**Means:** something failed that doesn't fit the taxonomy. Either a new error path was added without registering a code, or the server hit an edge case in its own logic.

**Retry:** yes, up to 3 attempts. Most `internal_error` cases are transient — a timing issue in the queue, a socket that closed unexpectedly, a JSON parse that hit a partial body.

**Beep:** no on first attempts. If all 3 retries fail with `internal_error`, check the server log — the specific failure should be visible as an uncaught exception or a `! handler error` line.

**Details:** usually `null`. If the server was able to attach a `reason`, it's a free-form string from the underlying exception.

#### `send_failed`

**Raises in:** `content.js`, `sendPrompt` phase, after `clickSend()` returns false or after the input clears but no assistant message appears within 3 seconds.

**Means:** the send button click was dispatched but DeepSeek's React didn't process it. The most common cause is that the input value was set via `execCommand('insertText')` which React's synthetic event system sometimes misses — the input shows the text visually, but the internal state is empty, so the send button is disabled or no-ops.

**Retry:** yes, up to 3 attempts. Attempt 2 almost always succeeds because the content script falls back to a different input-setting method (native setter + `input` event) when attempt 1 fails.

**Beep:** no. Transient. A user seeing a beep for `send_failed` on attempt 1 would escalate something that self-resolves.

**Details:** the `probe` field carries the selector probe at send-click time. Rarely useful — this code is a timing issue, not a selector issue.

### Bucket B

#### `rate_limited`

**Raises in:** `content.js`, `sendPrompt` phase, when the assistant's reply contains text matching `/too many requests|rate limit|try again later/i`.

**Means:** DeepSeek is throttling the account. Most common when DeepThink is enabled (each prompt is a "reasoning" quota hit) and the batch runs many sources back to back.

**Retry:** yes, once, after `retryAfter` (30000ms). Not 3 attempts — a third prompt inside the rate window makes the next window longer.

**Beep:** no. Beeping doesn't un-rate-limit; the delay does.

**Details:** `retryAfter` is the primary payload. The wizard's retry loop should `await sleep(err.retryAfter)` before resending.

### Bucket C

#### `extension_disconnected`

**Raises in:** `src/server.js`, any caller route, when the extension has never registered (`POST /hello` never received) or when the last `/hello` is older than a configured threshold.

**Means:** the server is up but no extension is talking to it. Either the extension isn't loaded, the token in the popup doesn't match `.env`, or the extension's service worker is in a crashed state.

**Retry:** yes, up to 2 attempts, with a 1-second wait between. If the extension was mid-restart, attempt 2 succeeds; if the extension was never loaded, all attempts fail and escalate to beep.

**Beep:** yes, after the second failed retry. Message: "extension not connected — load it in `brave://extensions` or check `EXTENSION_TOKEN`".

**Details:** `{ lastHelloAt, sessionId, expectedToken }` — the last two fields are what to compare against the popup's current values.

#### `response_timeout`

**Raises in:** `content.js`, `sendPrompt` phase, when the response wait loop hits `RESPONSE_TIMEOUT_MS` (90s default) without a completion signal.

**Means:** DeepSeek started generating but never finished, or the completion detector didn't recognize the finished stream. The `trace` array carries the last phases seen — if the last phase is `reasoning` with a large `len`, the model is stuck in a long reasoning loop; if the last phase is `answer` with a small `len`, the completion detector missed the end.

**Retry:** yes, up to 2 attempts. Attempt 2 may succeed if the first was a transient stall.

**Beep:** yes, after the second failed retry. The user needs to check the work tab — DeepSeek may be showing a manual "stop generating" button that needs clicking, or the tab may be suspended.

**Details:** `trace` is the primary payload. The last 2-3 entries tell the wizard where the stream stalled.

### Bucket D

#### `auth_failed`

**Raises in:** `src/server.js`, before any route dispatch, when the `Authorization` header is missing, malformed, or doesn't match the token.

**Means:** the caller's token and the server's token differ. Most common after changing `.env` without restarting the server, or changing the popup without reloading the extension.

**Retry:** no. The same token will fail again.

**Beep:** yes, immediately (not after 3 beeps — the user has to act before anything can succeed). Message: "Bearer token mismatch between `.env` and popup".

**Details:** `{ expectedSource: '.env' | 'popup' }` — the field names which side the server thinks is authoritative.

#### `deepthink_enable_failed`

**Raises in:** `content.js`, `sendPrompt` phase, after `ensureToggleOn('deepthink')` returns `ok: false` and 3 internal toggle attempts have failed.

**Means:** the DeepThink toggle could not be verified as on. Either the toggle element moved (DOM drift), the toggle is disabled (quota exhausted), or the click registered but the `aria-pressed` state didn't update.

**Retry:** no. Retrying the same selector will produce the same failure.

**Beep:** yes, immediately. Message: "DeepThink could not be enabled — toggle it manually and confirm it stays on". The user can do this in 5 seconds; the wizard shouldn't waste 60 seconds retrying.

**Details:** `{ toggleSelector, ariaPressedBefore, ariaPressedAfter, clickAttempts }` — everything the user needs to know which control to click and why the auto-enable missed it.

#### `input_not_found`

**Raises in:** `content.js`, `waitForInputReady` phase, after 5 seconds of polling for the input box with no match.

**Means:** the work tab is not on a `chat.deepseek.com` page that has an active input box. Either the tab was closed, the URL changed to something that isn't a chat, the page is stuck on a loading state, or the DOM changed such that the input selector no longer matches.

**Retry:** no. The tab state is the state.

**Beep:** yes, immediately. Message: "Chat input not found — confirm the work tab is on `chat.deepseek.com` and refresh". The `probe` field carries what selectors did match — if `probe.healthy` is empty, nothing at all is on the page (tab closed or wrong URL); if `probe.degraded` has entries, the DOM changed.

**Details:** `probe` is the primary payload. It carries every selector tier's resolution result.

#### `logged_out`

**Raises in:** `content.js`, `sendPrompt` phase, before the first send, when `detectLoggedOut()` finds the login screen.

**Means:** the DeepSeek session in the work tab has expired. Cookies gone, or account logged out on another tab.

**Retry:** no.

**Beep:** yes, immediately. Message: "Not logged in to DeepSeek — log in in the work tab and confirm you see the chat input".

**Details:** `{ loginFormDetected: true, lastKnownUrl }` — the `lastKnownUrl` is what the tab showed before the redirect to login, which is sometimes useful for debugging.

#### `protocol_version_mismatch`

**Raises in:** `src/server.js`, on `/hello`, when the version in the body doesn't match the server's supported major version. **Not raised in v0.1** — version negotiation is designed but not shipped.

**Means:** the extension and server are different versions and the protocol has changed incompatibly between them. Should never happen with both installed from the same commit, but possible after a partial upgrade.

**Retry:** no.

**Beep:** yes. Message: "extension and server versions differ — reload the extension and restart the server".

**Details:** when shipped, `{ serverVersion, extensionVersion, breakingChange }` — the `breakingChange` field names the specific incompatible field or route.

#### `search_enable_failed`

**Raises in:** `content.js`, `sendPrompt` phase, after `ensureToggleOn('search')` returns `ok: false` and 3 internal toggle attempts have failed.

**Means:** the Search toggle could not be verified as on. Same root causes as `deepthink_enable_failed` — the toggle moved, the toggle is disabled, or the state didn't update.

**Retry:** no.

**Beep:** yes, immediately. Message: "Search could not be enabled — toggle it manually".

**Details:** `{ toggleSelector, ariaPressedBefore, ariaPressedAfter, clickAttempts }`, same shape as `deepthink_enable_failed`.

#### `user_navigated`

**Raises in:** `content.js`, `sendPrompt` phase, when `location.href` changes away from the URL captured at `firstMsg` before `replyDone` fires.

**Means:** the work tab's URL changed mid-stream. The most common cause is the user clicking into a different chat while a reply was streaming — they see the reply coming in, get impatient, click elsewhere, and the content script's polling loop reads from the wrong page.

**Retry:** no. The user has to stop touching the tab.

**Beep:** yes, after the second occurrence within the same batch. The first `user_navigated` is treated as an accident; the second means the user is genuinely interfering and needs to be told.

**Details:** `{ expected: '<captured URL>', actual: '<current URL>' }` — the two URLs that differ.

### Bucket E

#### `bad_request`

**Raises in:** `src/server.js`, route-level validation, when a required field is missing or a type is wrong.

**Means:** the caller's request doesn't match the documented shape. Missing `messages`, missing `chatName`, `messages` isn't an array, etc.

**Retry:** no. The same request will produce the same 400.

**Beep:** no. This is a caller bug, not a user-fixable state.

**Details:** the `reason` field names the specific missing or malformed field. `{ field: 'messages', expected: 'array', received: 'undefined' }` is the shape a well-built server attaches.

#### `cancelled`

**Raises in:** `src/server.js`, `pump()`, when an entry with `cancelled: true` reaches the front of the queue. **Not raised in v0.1** — `/cancel` is designed but not shipped.

**Means:** the caller explicitly aborted the request via `/cancel/:requestId` after it was queued but before it dispatched.

**Retry:** no. The caller chose not to run it.

**Beep:** no. Cancellation is intentional.

**Details:** `{ cancelledBy: 'caller' }`. When `/cancel` ships, a future variant will be `{ cancelledBy: 'server', reason: 'deadline_exceeded' }` for the per-request timeout, and that one is retryable. Distinct codes may be needed then.

#### `chat_not_found`

**Raises in:** `content.js`, `ensureChat` phase, when `needNewChat: true` was returned, the background navigated to `/`, and the retry `ensureChat` also failed to find or create the chat.

**Means:** both paths failed — the sidebar fuzzy match returned null AND the fresh-page path couldn't establish an input. This is essentially "input_not_found on a fresh page", which usually means the new-chat flow itself is broken (DeepSeek changed the sidebar structure or removed the new-chat affordance).

**Retry:** no. The DOM is the DOM.

**Beep:** no, per bucket E. The user can see the `needs-review` marker and investigate manually. See [selector-maintenance.md](selector-maintenance.md).

**Details:** `{ sidebarMatch: null, freshPageInput: null }` — the two things that were attempted. If both are null, the sidebar walk and the input detection are both broken; the next step is `dom_drift`.

#### `dom_drift`

**Raises in:** `content.js`, `sendPrompt` phase, at the initial `probeDom()` call, when any selector marked `required: true` resolves to null.

**Means:** DeepSeek shipped a UI change and one or more required selectors no longer match. The extension is out of date. Every send will fail with this code until the selectors are updated.

**Retry:** no. Same selectors, same DOM, same failure.

**Beep:** no. The user cannot fix this from the CLI. `needs-review` + `probe` + the selector-maintenance playbook.

**Details:** `details` is an array of missing required selector names (e.g. `['input']`). `probe` is the full selector resolution snapshot. Together they're the handoff — see [selector-maintenance.md#diagnosing-a-drift](selector-maintenance.md#diagnosing-a-drift) for the diagnostic loop.

#### `unknown_request`

**Raises in:** `src/server.js`, `/reply` handler, when the `requestId` isn't found in `inFlight`.

**Means:** a `/reply` arrived for a request that isn't currently being processed. Either the reply was a double-delivery (extension retried `/reply` after a network hiccup — unlikely, since `/reply` is fire-and-forget) or the server was restarted between `/next` and `/reply` (likely, since a server restart clears `inFlight`).

**Retry:** no. Retrying the same `requestId` will also 404.

**Beep:** no. The `/reply` call has already returned 404 — the caller's `/chat` promise is still hanging. In practice, the caller times out at the client level.

**Details:** `{ requestId, inFlightSize }` — the ID that was sent and how many entries were in `inFlight` at the time. If `inFlightSize` is 0, the server was almost certainly restarted.

#### `user_skipped`

**Raises in:** `background.js`, when the user clicks "Skip site" in the popup. **Not raised in v0.1** — the skip button is designed but not shipped.

**Means:** the user explicitly chose to abort the current request. This is bucket E (skip) but has `userFixable: true` because the user is the one who triggered it.

**Retry:** no. The user chose to skip; retrying would override their choice.

**Beep:** no. Beeping at a user who just clicked "Skip" is user-hostile. The metadata says `userFixable: true` because the user *can* un-skip; the response rule overrides that to "skip silently".

**Details:** `{ skippedAt, source }` — when the skip happened and which source it was. Used by the wizard to record which source landed in `needs-review`.

---

## Common try/catch patterns

Four shapes that cover every wizard interaction with `DSCError`. Copy-paste, adapt.

### Pattern 1 — Batch loop with retry, beep, skip

The canonical integration. See [integration-guide.md#batch-loop](integration-guide.md#batch-loop) for the full version.

```js
async function processSource(dc, source, beeper) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await dc.chat({ messages: source.messages, chat: source.name });
    } catch (err) {
      if (!(err instanceof DSCError)) throw err;

      if (err.retryable && attempt < 3) {
        await sleep(err.retryAfter);
        continue;
      }

      if (err.userFixable) {
        await beeper.beep3x(err.reason);
      }
      throw err;
    }
  }
}
```

### Pattern 2 — Probe server readiness before a batch

```js
async function ensureReady(dc) {
  try {
    await dc.tabs();
  } catch (err) {
    if (err.code === CODES.EXTENSION_DISCONNECTED) {
      throw new Error('extension not connected — load it or check EXTENSION_TOKEN');
    }
    throw err;
  }
}
```

### Pattern 3 — Distinguish caller errors from extension errors

```js
try {
  await dc.chat({ messages });
} catch (err) {
  if (err.code === CODES.BAD_REQUEST) {
    console.error('your request is malformed:', err.reason);
    process.exit(2);
  }
  if (err.code === CODES.AUTH_FAILED) {
    console.error('token mismatch:', err.reason);
    process.exit(3);
  }
  // extension-side error — retryable
  throw err;
}
```

### Pattern 4 — Inspect the trace for a failed send

```js
try {
  await dc.chat({ messages });
} catch (err) {
  if (err.code === CODES.RESPONSE_TIMEOUT) {
    console.error('timed out after', err.trace.slice(-1)[0]?.t, 'ms');
    for (const entry of err.trace) {
      console.error(' ', entry.phase, entry.len ? `(len ${entry.len})` : '');
    }
  }
  throw err;
}
```

---

## Adding a new code

Five steps. In this order. A route that raises an unregistered code is worse than a route that doesn't exist.

**1. Decide the metadata.** Before naming the code, answer: is this `retryable`? Is this `userFixable`? What HTTP status does the caller see? If the code is dual-flagged (both retryable and userFixable), it belongs in bucket C and the beep-after-retries pattern applies — be explicit about when the beep fires.

**2. Add to `src/errors.js` first.** Both `CODES` and `META`. The file has a self-check at the bottom (`Object.keys(CODES).length === Object.keys(META).length`) — a code without metadata, or metadata without a code, fails at module load.

**3. Add a test.** `tests/errors.test.js` has a "every code has a meta entry" assertion. If the test doesn't exist yet, add it before the code — a code that can't be tested is a code that will be forgotten. The test is trivial (`for (const code of Object.values(CODES)) assert(META[code])`), but the point is that adding a code requires touching two files plus a test.

**4. Raise it from exactly one place.** A code that's raised from `content.js` and `background.js` and `src/server.js` is a code whose cause is ambiguous. If two modules can produce the same failure, they should produce two codes — the taxonomy is the failure's identity, not its category.

**5. Update this doc.** Add the code to the [full code table](#full-code-table), add a per-code entry under the right bucket heading, and if the code opens a new decision path (e.g., the first dual-flagged code, the first `retryAfter` that isn't 30s), update the relevant prose section too.

**Reconcile `shared.js` in the same PR.** `shared.js` has a `DSC.ERR` map that mirrors `CODES`. It's not the source of truth (that's `errors.js`) but it's what the content script references, so an out-of-sync `ERR` map means a code that fires in `content.js` won't match what the server expects. The current `shared.js` has a stale entry — `DEEPTHINK_OFF: 'deepthink_off'` — that isn't in `CODES`. It's unused; the actual failure path raises `deepthink_enable_failed`. Consider removing it in the same PR that touches the taxonomy, or leave it and note it as a `shared.js` cleanup. Either way, a new code addition is a chance to reconcile the two maps.

**Do not invent codes in the content script.** If `content.js` raises a code that isn't in `errors.js`, the client-side `fromReply` helper collapses it to `internal_error` — the caller sees `internal_error` with a `reason` field that names the real code, but can't switch on it. This is by design (unknown codes are always safe to collapse) but it means a new content-side failure mode that needs its own bucket must be registered first.