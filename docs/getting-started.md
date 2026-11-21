# Getting started

A hands-on tutorial. Install the extension, start the server, send your first prompt to DeepSeek, then send the same prompt to Qwen, then prove URL-based retry works. Follow it top to bottom — each section builds on the last, and each has an expected output you can compare against and a "if this didn't work" branch for the common stumbles.

If you already have a working install and just want the API surface, skip to [protocol.md](protocol.md). If you're deciding whether this repo is what you need, read [README.md](../README.md) first. This doc is for the reader who has decided to install it and wants to do that carefully.

**Contents**
- [Before you start](#before-you-start)
- [Step 1 — Install](#step-1--install)
- [Step 2 — Load the extension](#step-2--load-the-extension)
- [Step 3 — Configure the token](#step-3--configure-the-token)
- [Step 4 — Start the server](#step-4--start-the-server)
- [Step 5 — First round-trip (DeepSeek)](#step-5--first-round-trip-deepseek)
- [Step 6 — Same prompt, Qwen](#step-6--same-prompt-qwen)
- [Step 7 — URL-based retry](#step-7--url-based-retry)
- [Step 8 — Same chat, second turn](#step-8--same-chat-second-turn)
- [What you've built](#what-youve-built)
- [Where to go next](#where-to-go-next)

---

## Before you start

Four things to confirm before you type a command. Each one that's wrong produces a specific failure you'd otherwise waste 20 minutes debugging.

**1. Node 22 or later.** The server uses `node --env-file` and modern `node:` import prefixes. Check:

```bash
node --version
```

Expected: `v22.x.x` or higher. If it's `v20` or lower, upgrade before continuing — `--env-file` will fail with `bad option: --env-file` and the walkthrough stalls at step 4.

**2. Brave or Chrome.** The extension targets Chromium and is tested on Brave 1.60+. Firefox won't work — the manifest uses MV3 with `background.service_worker`, which Firefox handles differently enough that none of the background.js code would run as written. Edge works (it's Chromium) but is untested.

**3. A logged-in DeepSeek account (for steps 5, 7, 8) and a logged-in Qwen account (for step 6).** Open one tab to `https://chat.deepseek.com/` and log in. Open one tab to `https://chat.qwen.ai/` and log in. Keep exactly one tab open per provider; duplicate tabs make routing ambiguous. If either shows a login screen, log in before continuing — the extension can't log you in, and every prompt will fail with `logged_out`.

**4. Git.** You're going to clone the repo. Check:

```bash
git --version
```

Expected: `git version 2.x` or higher.

Once all four are true, you're ready.

---

## Step 1 — Install

Clone and enter the repo:

```bash
git clone https://github.com/pulchowk-events/deepseek-connect.git
cd deepseek-connect
```

There are no dependencies to install — the server uses only Node's built-in `node:http` and `node:crypto`, and the extension is plain JavaScript with no build step. The `devDependencies` block in `package.json` is empty.

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` in any text editor. You'll see two lines:

```
EXTENSION_TOKEN=
EXTENSION_PORT=7331
```

Fill in the token. Any long random string works — the token is compared byte-for-byte between the server and the popup, and never leaves your machine. On Linux or macOS:

```bash
echo "EXTENSION_TOKEN=$(openssl rand -hex 24)"
```

Take the output and paste it after `EXTENSION_TOKEN=` in `.env`. For the rest of this walkthrough, we'll assume the token is `demo-token-12345` — substitute your own in every command below.

Your `.env` should now look like:

```
EXTENSION_TOKEN=demo-token-12345
EXTENSION_PORT=7331
```

**Expected:** `ls -la` shows a `.env` file around 60-80 bytes. `cat .env` shows your token and port.

**If this didn't work:**
- `cp: .env.example: No such file or directory` — you're not in the `deepseek-connect` directory. `pwd` should end in `/deepseek-connect`.
- `.env` exists but is 0 bytes — the `cp` failed silently. Re-run it.
- Windows PowerShell — `cp` is `Copy-Item`, and `openssl` may not exist. Use `[System.Guid]::NewGuid().ToString()` or just type a 32-character random string.

---

## Step 2 — Load the extension

Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`).

Enable **Developer mode** — the toggle in the top right of the page. This is required for "Load unpacked" to appear.

Click **Load unpacked**. A file picker opens. Navigate to your `deepseek-connect/` directory and select it (not a file inside it — the whole folder).

The extension appears in the list as **deepseek-connect** with version `0.2.0`.

**Expected:** the extension card shows name `deepseek-connect`, version `0.2.0`, no red "Errors" badge.

**If this didn't work:**
- "Load unpacked" button doesn't appear — Developer mode isn't on. Toggle it in the top right.
- `Manifest file is missing or unreadable` — you selected a subdirectory. The picker must point at the folder containing `manifest.json`, `background.js`, and `providers/`.
- `Service worker registration failed` — click the red "Errors" button. Usually a typo in `background.js`'s `importScripts('shared.js')`. Verify these files exist: `manifest.json`, `background.js`, `content.js`, `shared.js`, `selectors.js`, `providers/deepseek.js`, `providers/qwen.js`, `popup.html`.

---

## Step 3 — Configure the token

Click the extension icon in the toolbar. A popup opens with two fields: **Token** and **Port**.

Paste `demo-token-12345` (or your real token) into the Token field. Leave Port at `7331` unless you changed `.env`. Click **Save**.

The popup flashes `saved`. The token is now in `chrome.storage.local` — it persists across reloads, browser restarts, and server restarts.

**Expected:** the popup's status dot is now **yellow** or **red** (not green yet — the server isn't running).

**If this didn't work:**
- Popup doesn't open — click the puzzle-piece icon in the toolbar (Extensions menu) and pin deepseek-connect. The icon is sometimes hidden by default.
- Popup opens but **Save** does nothing — right-click the popup → **Inspect** to open its DevTools console. Errors here will be obvious.
- `saved` appears but the popup is empty on next open — `chrome.storage.local` isn't persisting. Check `manifest.json` still has `"storage"` in `permissions`.

---

## Step 4 — Start the server

Open a terminal in the `deepseek-connect` directory:

```bash
node --env-file=.env src/server.js
```

You'll see one line:

```
[HH:MM:SS] listening on 127.0.0.1:7331
```

**Switch to Brave.** You should already have two tabs open from [Before you start](#before-you-start) — one at `https://chat.deepseek.com/`, one at `https://chat.qwen.ai/`. If you closed them, reopen now.

**Switch back to the terminal.** Within 1-2 seconds:

```
[HH:MM:SS] extension connected (0.2.0) | https://chat.deepseek.com/ | 2 tab(s)
```

That's the `/hello` registration. The extension reported the currently open supported provider tabs. `/tabs` later returns this cached snapshot; it is not a live health check.

**Expected:**
- `listening on 127.0.0.1:7331`
- Within 2 seconds: `extension connected (0.2.0) | ... | 2 tab(s)`

The popup's status dot is now **green**.

**If this didn't work:**

- **No `extension connected` line after 5 seconds.** Three causes:
  1. Token mismatch — compare the popup's Token field against `.env`'s `EXTENSION_TOKEN` byte-for-byte.
  2. Extension not reloaded after a change — in `brave://extensions`, click the reload button on the deepseek-connect card.
  3. No provider tab open — the extension needs at least one supported provider tab to register against.

- **`extension connected ... | 0 tab(s)`.** The extension is connected but found no supported provider tabs. Open one tab for the provider you intend to use; `/hello` refreshes the tab inventory when tabs change.

- **`extension connected ... | 1 tab(s)` when you expected 2.** One tab may be on a non-provider page, such as a login redirect, or may not have finished loading. Check `/tabs`; log in or navigate to the provider root as needed.

- **`EADDRINUSE: 127.0.0.1:7331`.** Another process is on that port. Either kill it (`lsof -i :7331`) or change `EXTENSION_PORT` in `.env` to `7332` and the popup's Port to match.

- **`bad option: --env-file`.** Node is older than 22. Upgrade — see [Before you start](#before-you-start).

- **`Error: EXTENSION_TOKEN not set`.** `.env` isn't in the current directory, or the flag's relative path is wrong.

Leave this terminal running. The server stays up for the rest of the walkthrough.

---

## Step 5 — First round-trip (DeepSeek)

Open a **second** terminal (the first one holds the server). In the new terminal, from the `deepseek-connect` directory:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"first-test — reply with exactly: hello"}],"chat":"first-test","provider":"deepseek"}' \
  | python3 -m json.tool
```

**Watch the first terminal** while the curl runs. In 4-10 seconds:

```
[HH:MM:SS] <- enqueued <id> | first-test — reply with exactly: hello
[HH:MM:SS] -> dispatched <id> | first-test — reply with exactly: hello
[HH:MM:SS]   ~ <id8> probe {"healthy":["input","toggleDeepThink","toggleSearch","chatList"],...}
[HH:MM:SS]   ~ <id8> waitInput {"found":true}
[HH:MM:SS]   ~ <id8> toggleDeepthink {"ok":true}
[HH:MM:SS]   ~ <id8> toggleSearch {"ok":true}
[HH:MM:SS]   ~ <id8> setInput {"promptLen":38,"typedLen":38,"msgBefore":0}
[HH:MM:SS]   ~ <id8> sendClick {"ms":105}
[HH:MM:SS]   ~ <id8> firstMsg {"msgs":1,"url":"..."}
[HH:MM:SS]   ~ <id8> reasoning {"len":23}
[HH:MM:SS]   ~ <id8> answerStarted
[HH:MM:SS]   ~ <id8> answer {"len":5}
[HH:MM:SS] ok done <id> | <N>ms
```

**Switch to Brave.** The DeepSeek tab now shows a new chat. Your prompt is there, and the assistant replied "hello".

**Switch back to the second terminal.** The curl returns:

```json
{
  "content": "hello",
  "chat": "first-test",
  "url": "https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5",
  "elapsedMs": 4321
}
```

Note the `url` field — that's the **stable chat identity** you'll use in step 7. Save that URL somewhere; you'll pass it back to `/open` to prove URL-based retry works.

### What just happened

Six things, in order:

1. **Your curl POSTed to `/chat`.** The server enqueued the request with `provider: 'deepseek'`. Your curl's connection stayed open — no response yet.

2. **The extension was polling `GET /next`.** The server dispatched the job: `{ action: 'next', provider: 'deepseek', prompt: '...', chatName: 'first-test' }`.

3. **Background resolved the DeepSeek tab.** The request names `deepseek`; background requires exactly one tab whose hostname matches that provider.

4. **Background sent `sendMessage({ action: 'sendPrompt', provider: 'deepseek', ... })` to `content.js`.** The router looked up `DSC_PROVIDERS['deepseek']` and dispatched to `providers/deepseek.js`'s `sendPrompt`. The DeepSeek provider probed selectors, enabled DeepThink and Search, typed the prompt, clicked send, waited for the answer, and extracted "hello".

5. **The extension POSTed `/reply`.** The server resolved the pending `/chat` promise with `{ content: 'hello', url: 'https://chat.deepseek.com/a/chat/s/...', elapsedMs: 4321 }`.

6. **Your curl received the JSON.** The connection that had been open for 4.3 seconds received its body and closed.

**If this didn't work:**

- **curl waits and then times out.** `curl` has no built-in deadline unless one is specified; the server defaults to a 120-second queue deadline and a 960-second dispatched-request deadline. Check `/status` and inspect the provider tab. A timeout after `dispatched` is `outcome_unknown`, not cancellation; do not resend under a new request ID until the tab is reconciled.

- **`{"ok": false, "error": "auth_failed"}`.** Your `-H "Authorization: Bearer ..."` doesn't match `.env`'s `EXTENSION_TOKEN`. Compare exactly.

- **The request waits and then times out.** Confirm the extension's token and port match `.env`, then inspect `/status`. The server starts on the port in `.env`, while the popup has its own saved port setting. `/tabs` is only a cached `/hello` snapshot, not a readiness check.

- **`{"ok": false, "error": "ambiguous_provider_tab", ...}`.** No tab or multiple tabs match the requested provider's exact hostname. Open one provider tab or close extras, then retry.

- **`{"ok": false, "error": "input_not_found"}`.** The matching DeepSeek tab exists but the input box isn't where the extension expects it. Confirm the tab is on `chat.deepseek.com` (not `/login`), then refresh.

- **`internal_error` with a provider registration failure in the reason/details.** Check that the config provider is enabled, or inspect the extension console and reload the extension and provider tab after built-in driver changes. `no_provider_loaded` is not a registered public error code.

---

## Step 6 — Same prompt, Qwen

Same prompt, different provider:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"first-test — reply with exactly: hello"}],"chat":"first-test-qwen","provider":"qwen"}' \
  | python3 -m json.tool
```

**Watch the first terminal.** The trace looks different this time:

```
[HH:MM:SS] <- enqueued <id> | first-test — reply with exactly: hello
[HH:MM:SS] -> dispatched <id> | first-test — reply with exactly: hello
[HH:MM:SS]   ~ <id8> step_1_dismiss_modal {"action":"checking for age modal"}
[HH:MM:SS]   ~ <id8> step_2_find_input {"action":"locating input field"}
[HH:MM:SS]   ~ <id8> step_3_type_prompt {"action":"typing prompt"}
[HH:MM:SS]   ~ <id8> step_4_verify_input {"promptLen":192,"typedLen":192}
[HH:MM:SS]   ~ <id8> step_5_click_send {"action":"clicking send button"}
[HH:MM:SS]   ~ <id8> step_6_send_clicked
[HH:MM:SS]   ~ <id8> step_7_wait_for_reply
[HH:MM:SS]   ~ <id8> step_7a_first_msg
[HH:MM:SS]   ~ <id8> step_7b_streaming {"len":12}
[HH:MM:SS]   ~ <id8> step_8_reply_done {"len":5}
[HH:MM:SS] ok done <id> | <N>ms
```

Different phase names — that's the Qwen provider's own trace, not the DeepSeek one. Notice `step_4_verify_input`'s `promptLen: 192` — that's 38 characters of your prompt plus ~154 characters of the delimiter instruction that Qwen's provider appended automatically.

**Switch to Brave.** The Qwen tab shows a new chat with your prompt and the reply "hello".

**Switch back to the terminal.** The curl returns:

```json
{
  "content": "hello",
  "chat": "first-test-qwen",
  "url": "https://chat.qwen.ai/c/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5",
  "elapsedMs": 8123
}
```

Same content, same shape, different provider and URL. Note that `elapsedMs` is higher — Qwen's anti-bot pacing adds about 5 seconds of pre-send overhead.

### What just happened

Same six steps as DeepSeek, with two differences:

1. **Background resolved the Qwen tab.** The request names `qwen`; background requires exactly one tab whose hostname matches that provider.

2. **`content.js` dispatched to `DSC_PROVIDERS['qwen']` instead of `DSC_PROVIDERS['deepseek']`.** The Qwen provider handled: age-modal dismissal (Qwen shows one on first use per session), anti-bot pacing (~5 seconds of `sleep()` between actions), typing the prompt plus a delimiter instruction, clicking send, and waiting for both `START_QWEN_REPLY` and `END_QWEN_REPLY` to appear before extracting.

The response shape is identical because the multi-provider contract guarantees it. `content.js` doesn't care which provider answered — it just gets `{ content, raw, url, source, trace }` back from whichever one it dispatched to.

**If this didn't work:**

- **`{"ok": false, "error": "ambiguous_provider_tab", ...}`.** No tab or multiple tabs match Qwen's exact hostname. Open one Qwen tab or close extras, then retry.
- **`{"ok": false, "error": "input_not_found"}`.** The Qwen tab exists but the input box wasn't found. Check the provider tab and follow [selector-maintenance.md](selector-maintenance.md) if the DOM changed.

- **`invalid_response_format`.** Qwen returned a reply that could not be extracted. Inspect the provider tab and the bounded error details; this occurs after prompt submission and is not automatically retryable. Treat any model-produced code as untrusted and validate it in the caller before saving or using it.

- **`internal_error` with a provider registration failure in the reason/details.** Check that the config provider is enabled, or inspect the extension console and reload the extension and provider tab after built-in driver changes. `no_provider_loaded` is not a registered public error code.

---

## Step 7 — URL-based retry

This is the feature that makes batch wizards work. In step 5 you got a `url` back. Now use it.

Two commands, run them back-to-back.

**First** — send a new prompt to `first-test`, using the URL you captured from step 5:

```bash
curl -s -X POST http://127.0.0.1:7331/open \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"chatName":"first-test","url":"https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5","provider":"deepseek"}' \
  | python3 -m json.tool
```

Substitute the real URL from step 5's response. Expected:

```json
{
  "ok": true,
  "existing": true,
  "mode": "existing",
  "url": "https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5",
  "debug": {
    "sideFound": false,
    "leafCount": 0,
    "leafPreview": [],
    "name": "first-test",
    "path": "/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5"
  },
  "chat": "first-test"
}
```

The `debug.sideFound: false` is expected — the sidebar walk didn't run at all. Mode B (URL navigation) bypasses the sidebar entirely and just navigates the tab. The `mode: "existing"` confirms it went to an existing chat.

**Watch the first terminal.** You'll see:

```
[HH:MM:SS] <- enqueued <id> | [open] first-test
[HH:MM:SS] -> dispatched <id> | [open] first-test
[HH:MM:SS] ok done <id> | <N>ms
```

No `probe`, no `step_*` phases. The extension navigated the tab, verified the input is there via `checkState`, and returned. The whole thing takes ~2-3 seconds (mostly the tab navigation + React mount).

**Then** — send a new follow-up prompt to the same URL. This is safe because the previous `/chat` completed successfully; it is not a timeout-retry recipe:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What did I ask you to reply with, one message ago?"}],"chat":"first-test","provider":"deepseek","url":"https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5"}' \
  | python3 -m json.tool
```

Expected:

```json
{
  "content": "You asked me to reply with: hello",
  "chat": "first-test",
  "url": "https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5",
  "elapsedMs": 3245
}
```

The LLM remembers the prior turn because the extension navigated to the exact URL — the chat already contained the first exchange, and the new prompt became the second turn. **The URL is the identity.** No sidebar fuzzy-matching required.

### What just happened

Three things:

1. **`/open` with `url` navigated directly.** Background called `chrome.tabs.update(tab.id, { url: 'https://chat.deepseek.com/a/chat/s/ae834e91-...' })`, waited for the tab to complete loading, waited 800ms for React to mount, and called the DeepSeek provider's `checkState()` to verify the input is present. No `ensureChat` — no sidebar walk. This is what makes the URL path reliable when the sidebar walk isn't.

2. **`/chat` with the saved URL.** `/chat` accepts `url` and navigates to that exact provider conversation before sending. This avoids relying on sidebar title matching.

**If this didn't work:**

- **`/open` rejects a stale or mismatched URL.** The extension does not fall back to another chat or provider. Verify the provider hostname and conversation URL in the tab; if the saved conversation is gone, explicitly choose a new chat and record its URL.

- **The follow-up `/chat` returns something like "I don't have prior context in this conversation."** Verify the exact URL and provider tab, then manually inspect that conversation. Do not send further prompts until the identity is clear.

---

## Step 8 — Same chat, another turn

This sends a new prompt after the prior request completed. It demonstrates conversation continuity; it is not a recipe for replaying a timed-out request.

Send a third prompt to the same chat, again with the URL:

```bash
curl -s -X POST http://127.0.0.1:7331/open \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"chatName":"first-test","url":"https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5","provider":"deepseek"}' \
  > /dev/null

curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What was the first thing I asked you in this conversation?"}],"chat":"first-test","provider":"deepseek","url":"https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5"}' \
  | python3 -m json.tool
```

Expected:

```json
{
  "content": "You asked me to reply with: hello.",
  "chat": "first-test",
  "url": "https://chat.deepseek.com/a/chat/s/ae834e91-aed2-4254-bb12-6b8b7c1dc7d5",
  "elapsedMs": 3456
}
```

The LLM recalls the very first message even though you've sent two more prompts since. That's stateful chat behavior — the provider navigated to the URL, the tab loaded the full conversation, and the LLM answered in context.

For a new follow-up prompt, persist the returned URL and include it in `/chat` or navigate with `/open` first. For an uncertain timeout, do not send a new prompt; inspect the tab and use the original `requestId` to recover a late result. See [protocol.md](protocol.md) for exact idempotency and restart limitations.

### What just happened

Same as step 7 — `/open { url }` navigated, `/chat` sent, LLM answered in context. The point of step 8 is the *recall*: the LLM sees the entire conversation history, not just the immediately prior turn. That's the whole reason for one-chat-per-source (see [architecture.md#3-one-chat-per-source-url-primary-identity](architecture.md#3-one-chat-per-source-url-primary-identity)).

**If this didn't work:**

- **The LLM says "I don't have prior context."** Verify the exact URL and selected provider tab manually. Do not send further prompts until the conversation identity is clear.

- **The LLM says something plausible but wrong** (a hallucinated first message). The chat was probably reused but the LLM's context window is truncated — DeepSeek has a context limit, and if the conversation is very long, earlier turns get dropped. For a batch wizard, this only matters if a single source has 20+ retry attempts in the same chat; the practical limit is fine for 3-attempt retry policies.

---

## What you've built

You have:

- The `deepseek-connect` extension loaded in your browser, authenticated to the server via `EXTENSION_TOKEN`
- A running HTTP server on `127.0.0.1:7331` that queues prompts and returns provider-specific replies
- A working `/chat` route with `provider` selection: DeepSeek and Qwen both functional
- A working `/open` route with URL-based navigation
- Per-provider chat lifecycle: follow-up turns use the same conversation URL
- Best-effort progress telemetry in the server log, correlated by request ID
- The multi-provider plugin system: two provider tabs open simultaneously, each request routed to the right one

The extension returns provider UI output; the caller must validate identity, syntax, and verdicts before accepting or saving it. The extension does not execute generated code. Timeouts are not cancellation, and automatic retries are limited to failures explicitly marked retryable and definitely not dispatched.

## Where to go next

You've used the API. Now read the docs that make it navigable:

- **[protocol.md](protocol.md)** — the full route reference. You'll need `POST /chat`'s request shape, the provider field threading, and `GET /tabs`'s response shape for anything beyond the basic flow.
- **[error-codes.md](error-codes.md)** — registered failures, retry metadata, and dispatch-state recovery rules.
- **[providers.md](providers.md)** — if you want to add a third provider (Claude, Gemini, whatever). The contract, the registration checklist, the Qwen case study.
- **[integration-guide.md](integration-guide.md)** — the batch wizard blueprint. Same walkthrough you just did, but as a Node integration: `require('deepseek-connect')`, transport abstraction, batch loop, error policy, provider threading, provider-pivot on rate limit.
- **[architecture.md](architecture.md)** — the "why" behind every decision you just exercised. The eight load-bearing choices are pinned to ADRs there, including the plugin registry that makes the two-provider setup work.
- **[operations.md](operations.md)** — the reload discipline, log interpretation, and recovery playbook for `logged_out`, `rate_limited`, Qwen's age modal, and the other things that go wrong in real use.
- **[selector-maintenance.md](selector-maintenance.md)** — the recovery playbook when a provider ships a UI change and the extension starts failing with `dom_drift`.

If you're integrating `deepseek-connect` into a batch wizard, the [integration-guide.md](integration-guide.md) is your next read. If you're operating it as-is, [operations.md](operations.md) is. If you're modifying the internals or adding a provider, [architecture.md](architecture.md) first.