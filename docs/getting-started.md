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

**3. A logged-in DeepSeek account (for steps 5, 7, 8) and a logged-in Qwen account (for step 6).** Open a new tab to `https://chat.deepseek.com/` and log in. Open another tab to `https://chat.qwen.ai/` and log in. You should see a chat input on each. If either shows a login screen, log in before continuing — the extension can't log you in, and every prompt will fail with `logged_out`.

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

That's the `/hello` registration. The extension found both provider tabs, read their URLs, and told the server it exists. The `2 tab(s)` is the count of supported provider tabs — not just the pinned one.

**Expected:**
- `listening on 127.0.0.1:7331`
- Within 2 seconds: `extension connected (0.2.0) | ... | 2 tab(s)`

The popup's status dot is now **green**.

**If this didn't work:**

- **No `extension connected` line after 5 seconds.** Three causes:
  1. Token mismatch — compare the popup's Token field against `.env`'s `EXTENSION_TOKEN` byte-for-byte.
  2. Extension not reloaded after a change — in `brave://extensions`, click the reload button on the deepseek-connect card.
  3. No provider tab open — the extension needs at least one supported provider tab to register against.

- **`extension connected ... | 0 tab(s)`.** The extension found no provider tabs. Open a fresh `chat.deepseek.com/` or `chat.qwen.ai/` tab and the extension re-registers on the next tab event.

- **`extension connected ... | 1 tab(s)` when you expected 2.** One of your provider tabs is on a URL that doesn't match `DSC.PROVIDER_DOMAINS`. Check that the URLs are exactly `https://chat.deepseek.com/` and `https://chat.qwen.ai/` (no trailing path like `/login`). If a tab got auto-redirected to a login page, log in and the count will update.

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

3. **Background called `getWorkTab(null, 'deepseek')`.** Since `provider: 'deepseek'` was specified, background queried `chrome.tabs.query({ url: 'https://chat.deepseek.com/*' })` and picked your DeepSeek tab — bypassing the pinned `workTabId` because the request named a specific provider.

4. **Background sent `sendMessage({ action: 'sendPrompt', provider: 'deepseek', ... })` to `content.js`.** The router looked up `DSC_PROVIDERS['deepseek']` and dispatched to `providers/deepseek.js`'s `sendPrompt`. The DeepSeek provider probed selectors, enabled DeepThink and Search, typed the prompt, clicked send, waited for the answer, and extracted "hello".

5. **The extension POSTed `/reply`.** The server resolved the pending `/chat` promise with `{ content: 'hello', url: 'https://chat.deepseek.com/a/chat/s/...', elapsedMs: 4321 }`.

6. **Your curl received the JSON.** The connection that had been open for 4.3 seconds received its body and closed.

**If this didn't work:**

- **curl hangs for 90+ seconds, then times out.** The extension never replied. Check the first terminal — if `dispatched` appears with no `probe` after it, the extension crashed or is stuck. In `brave://extensions`, click the "service worker" link; if it's greyed out, reload the extension.

- **`{"ok": false, "error": "auth_failed"}`.** Your `-H "Authorization: Bearer ..."` doesn't match `.env`'s `EXTENSION_TOKEN`. Compare exactly.

- **`{"ok": false, "error": "extension_disconnected"}`.** Extension not connected. Step 4's `extension connected` line should have appeared.

- **`{"ok": false, "error": "input_not_found", "reason": "no_work_tab"}`.** No DeepSeek tab is open. The `provider: 'deepseek'` routing couldn't find a tab to dispatch to. Open `chat.deepseek.com` in a new tab and retry.

- **`{"ok": false, "error": "input_not_found"}`** (without `no_work_tab`). The DeepSeek tab exists but the input box isn't where the extension expects it. Confirm the tab is on `chat.deepseek.com` (not `/login`), then refresh.

- **`{"ok": false, "error": "no_provider_loaded", ...}`** — actually this surfaces as `input_not_found` with `reason: 'no_provider_loaded'`. The DeepSeek provider module didn't register. Check that `manifest.json`'s `content_scripts.js` array includes `"providers/deepseek.js"`. Reload the extension and hard-reload the tab.

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

1. **Background called `getWorkTab(null, 'qwen')`.** Provider-scoped tab selection — it queried `chrome.tabs.query({ url: 'https://chat.qwen.ai/*' })` and picked the Qwen tab, bypassing the pinned tab entirely. This is the whole point of multi-provider routing: two tabs are open, the request names one, the extension picks the right one.

2. **`content.js` dispatched to `DSC_PROVIDERS['qwen']` instead of `DSC_PROVIDERS['deepseek']`.** The Qwen provider handled: age-modal dismissal (Qwen shows one on first use per session), anti-bot pacing (~5 seconds of `sleep()` between actions), typing the prompt plus a delimiter instruction, clicking send, and waiting for both `START_QWEN_REPLY` and `END_QWEN_REPLY` to appear before extracting.

The response shape is identical because the multi-provider contract guarantees it. `content.js` doesn't care which provider answered — it just gets `{ content, raw, url, source, trace }` back from whichever one it dispatched to.

**If this didn't work:**

- **`{"ok": false, "error": "input_not_found", "reason": "no_work_tab"}`.** No Qwen tab is open. Open `chat.qwen.ai` in a new tab.

- **`{"ok": false, "error": "input_not_found"}`** (without `no_work_tab`). The Qwen tab exists but the input box wasn't found. The Qwen provider's selector for the input field is `textarea.message-input-textarea` with fallback to `textarea`. If Qwen redesigned, the input might be somewhere else. F12 the Qwen tab, check whether `document.querySelector('textarea')` returns anything. If not, Qwen's DOM has changed — see [selector-maintenance.md](selector-maintenance.md).

- **`{"ok": false, "error": "invalid_response_format"}`.** Qwen produced a reply but didn't wrap it in the required `START_QWEN_REPLY` / `END_QWEN_REPLY` delimiters. The `details.rawPreview` field shows the first 200 chars of what the model actually said. Retry once — the model usually cooperates on attempt 2. If it fails three times in a row, the prompt's delimiter instruction is being ignored — check the actual prompt sent by looking at `step_4_verify_input.promptLen` in the trace.

- **`{"ok": false, "error": "no_provider_loaded"}`** (as `input_not_found` with that reason). The Qwen provider module didn't register. Check that `manifest.json`'s `content_scripts.js` array includes `"providers/qwen.js"`. Reload the extension and hard-reload the tab.

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

**Then** — send a follow-up prompt to the same URL:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What did I ask you to reply with, one message ago?"}],"chat":"first-test","provider":"deepseek"}' \
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

2. **`/chat` to the same chat URL.** The `chatName: 'first-test'` and the tab already being on the URL meant `/chat` didn't need to navigate again — `ensureChat` returned `{ok: true, existing: true, mode: 'existing'}` because `findChatInSidebar('first-test')` matched the chat title (which DeepSeek auto-named something close to "first-test — reply with exactly: hello"). Wait — the sidebar walk *did* run in step 7's second call, because the second prompt didn't pass a `url` to `/chat`.

Actually let me trace this more carefully. `/chat` doesn't accept a `url` parameter — it only takes `provider` and `chat`. So when you called `/chat` with `chat: 'first-test'`, background's `handleNext` had `work.targetUrl = null` (since `/chat` didn't set it) and called `ensureChat('first-test')`. `ensureChat` on DeepSeek does the sidebar walk, which found the chat titled "first-test — reply with exactly: hello", and clicked it. That's why the LLM saw the prior turn — the sidebar walk worked here because the chat title actually contains "first-test".

So actually **two mechanisms** contributed: `/open { url }` navigated the tab to the chat URL, then the follow-up `/chat` was already on the right chat. The `ensureChat` call was a no-op (`existing: true`) because the tab was already on the chat, but even if it hadn't been, the sidebar walk would have found it.

The key insight: **the URL mechanism is more reliable than the sidebar walk.** The DeepSeek sidebar fuzzy-match works only when the chat title happens to contain the source name — and DeepSeek paraphrases titles, so it often doesn't. The URL mechanism always works — the URL contains the UUID, which is stable for the chat's lifetime.

**In a batch wizard**, the wizard persists the URL from `/chat`'s response and passes it to `/open` on every retry. The sidebar walk becomes a fallback for the first send per source.

**If this didn't work:**

- **`{"ok": true, "existing": false, "mode": "fresh"}` from `/open`.** The URL navigation failed and fell through to `ensureChat`, which then found no matching chat (because you're on a fresh page). The stale URL case. This can happen if the chat was deleted, or if the URL from step 5 is from an old session where the UUID has been invalidated. Refresh the tab, and either re-open the chat manually or start a fresh `/chat` to get a new URL.

- **The follow-up `/chat` returns something like "I don't have prior context in this conversation."** Either the URL navigation went to the wrong chat, or the follow-up `/chat` opened a fresh chat instead of reusing the existing one. Check `ensureChat`'s response — if `existing: false, mode: 'fresh'`, the sidebar walk didn't find the chat. Look at `debug.leafPreview` — if the chat title isn't in the list, that's why. This is exactly the case URL-based retry is designed to fix; the wizard should pass the `url` to `/chat` (which requires the `/chat` route to accept it — see [Extending the protocol](protocol.md#extending-the-protocol) — OR use the two-call pattern above: `/open { url }` first, then `/chat`).

---

## Step 8 — Same chat, second turn

The full retry pattern: same chat, new prompt, LLM sees prior turn.

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
  -d '{"messages":[{"role":"user","content":"What was the first thing I asked you in this conversation?"}],"chat":"first-test","provider":"deepseek"}' \
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

**This is what a batch wizard does on retry.** It persists the URL after every `/chat` success, then on retry: `/open { url }` to navigate, then `/chat` to send the refined prompt. The LLM sees the failed attempt from the prior turn and produces a better second attempt.

### What just happened

Same as step 7 — `/open { url }` navigated, `/chat` sent, LLM answered in context. The point of step 8 is the *recall*: the LLM sees the entire conversation history, not just the immediately prior turn. That's the whole reason for one-chat-per-source (see [architecture.md#3-one-chat-per-source-url-primary-identity](architecture.md#3-one-chat-per-source-url-primary-identity)).

**If this didn't work:**

- **The LLM says "I don't have prior context."** Same diagnosis as step 7. Check whether `ensureChat` found the chat. Look at the `url` field in the response — if it's `null` or a different UUID, the tab ended up somewhere unexpected.

- **The LLM says something plausible but wrong** (a hallucinated first message). The chat was probably reused but the LLM's context window is truncated — DeepSeek has a context limit, and if the conversation is very long, earlier turns get dropped. For a batch wizard, this only matters if a single source has 20+ retry attempts in the same chat; the practical limit is fine for 3-attempt retry policies.

---

## What you've built

You have:

- The `deepseek-connect` extension loaded in your browser, authenticated to the server via `EXTENSION_TOKEN`
- A running HTTP server on `127.0.0.1:7331` that queues prompts and returns provider-specific replies
- A working `/chat` route with `provider` selection: DeepSeek and Qwen both functional
- A working `/open` route with URL-based navigation for retry
- Per-provider chat lifecycle: same chat, second turn, LLM sees prior context
- Live progress telemetry in the server log: every phase of every prompt is visible as it happens, with provider-specific phase names
- The multi-provider plugin system: two provider tabs open simultaneously, each request routed to the right one

That's the entire functional surface. Everything else is either a helper (`/tabs`, `/reset`), extension-side (`/hello`, `/next`, `/reply`, `/progress`), or a refinement (better error handling, retries, beeps).

## Where to go next

You've used the API. Now read the docs that make it navigable:

- **[protocol.md](protocol.md)** — the full route reference. You'll need `POST /chat`'s request shape, the provider field threading, and `GET /tabs`'s response shape for anything beyond the basic flow.
- **[error-codes.md](error-codes.md)** — the 21 failure codes with the decision rule for each, including the two provider-specific ones (`invalid_response_format`, `deepthink_enable_failed`).
- **[providers.md](providers.md)** — if you want to add a third provider (Claude, Gemini, whatever). The contract, the registration checklist, the Qwen case study.
- **[integration-guide.md](integration-guide.md)** — the batch wizard blueprint. Same walkthrough you just did, but as a Node integration: `require('deepseek-connect')`, transport abstraction, batch loop, error policy, provider threading, provider-pivot on rate limit.
- **[architecture.md](architecture.md)** — the "why" behind every decision you just exercised. The eight load-bearing choices are pinned to ADRs there, including the plugin registry that makes the two-provider setup work.
- **[operations.md](operations.md)** — the reload discipline, log interpretation, and recovery playbook for `logged_out`, `rate_limited`, Qwen's age modal, and the other things that go wrong in real use.
- **[selector-maintenance.md](selector-maintenance.md)** — the recovery playbook when a provider ships a UI change and the extension starts failing with `dom_drift`.

If you're integrating `deepseek-connect` into a batch wizard, the [integration-guide.md](integration-guide.md) is your next read. If you're operating it as-is, [operations.md](operations.md) is. If you're modifying the internals or adding a provider, [architecture.md](architecture.md) first.