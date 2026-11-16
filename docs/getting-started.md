# Getting started

A hands-on tutorial. Install the extension, start the server, send your first prompt, get a reply, and understand what just happened. Follow it top to bottom — each section builds on the last, and each has an expected output you can compare against and a "if this didn't work" branch for the common stumbles.

If you already have a working install and just want the API surface, skip to [protocol.md](protocol.md). If you're deciding whether this repo is what you need, read [README.md](../README.md) first. This doc is for the reader who has decided to install it and wants to do that carefully.

**Contents**
- [Before you start](#before-you-start)
- [Step 1 — Install](#step-1--install)
- [Step 2 — Load the extension](#step-2--load-the-extension)
- [Step 3 — Configure the token](#step-3--configure-the-token)
- [Step 4 — Start the server](#step-4--start-the-server)
- [Step 5 — First round-trip](#step-5--first-round-trip)
- [Step 6 — Same chat, second turn](#step-6--same-chat-second-turn)
- [Step 7 — Different chat](#step-7--different-chat)
- [Step 8 — Open a chat by name](#step-8--open-a-chat-by-name)
- [What you've built](#what-youve-built)
- [Where to go next](#where-to-go-next)

---

## Before you start

Four things to confirm before you type a command. Each one that's wrong produces a specific failure you'd otherwise waste 20 minutes debugging.

**1. Node 22 or later.** The server uses `node --env-file` and the modern `node:` import prefixes. Check:

```bash
node --version
```

Expected: `v22.x.x` or higher. If it's `v20` or lower, upgrade before continuing — `--env-file` will fail with `bad option: --env-file` and the whole walkthrough stalls at step 4.

**2. Brave or Chrome.** The extension targets Chromium and is tested on Brave 1.60+. Firefox won't work — the manifest uses MV3 with `background.service_worker`, which Firefox handles differently enough that none of the background.js code would run as written. Edge technically works (it's Chromium) but is untested.

**3. A logged-in DeepSeek account.** Open a new tab, go to `https://chat.deepseek.com/`, log in. You should see the chat input at the bottom of the page and your profile name in the sidebar. If you see a login screen, log in before continuing — the extension can't log you in, and every prompt will fail with `logged_out`.

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

There are no dependencies to install — the server uses only Node's built-in `node:http` and `node:crypto`, and the extension is plain JavaScript with no build step. The `package.json` `devDependencies` block is empty.

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` in any text editor. You'll see two lines:

```
EXTENSION_TOKEN=
EXTENSION_PORT=7331
```

Generate a token and fill it in. Any long random string works — the token is compared byte-for-byte between the server and the popup, and never leaves your machine. On Linux or macOS:

```bash
echo "EXTENSION_TOKEN=$(openssl rand -hex 24)" >> .env.example
# then move that line into .env, replacing the empty EXTENSION_TOKEN=
```

Or just type any 32+ character string after `EXTENSION_TOKEN=`. For this walkthrough, we'll assume the token is `demo-token-12345` — substitute your own in every command below.

Your `.env` should now look like:

```
EXTENSION_TOKEN=demo-token-12345
EXTENSION_PORT=7331
```

**Expected:** `ls -la` shows a `.env` file about 60-80 bytes. `cat .env` shows your token and port.

**If this didn't work:**
- `cp: .env.example: No such file or directory` — you're not in the `deepseek-connect` directory. `pwd` should end in `/deepseek-connect`.
- `.env` exists but is 0 bytes — the `cp` failed silently. Re-run it.
- You're on Windows — `cp` in PowerShell is `Copy-Item`, and the `openssl` command may not exist. Use `[System.Guid]::NewGuid().ToString()` in PowerShell, or just type a 32-character random string.

---

## Step 2 — Load the extension

Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`).

Enable **Developer mode** — the toggle in the top right of the page. This is required for "Load unpacked" to appear.

Click **Load unpacked**. A file picker opens. Navigate to your `deepseek-connect/` directory and select it (not a file inside it — the whole folder).

The extension appears in the list as **deepseek-connect** with version `0.1.0`. If Developer mode was already on, you might need to click the reload button (circular arrow icon) on the extension card to pick up the `manifest.json` changes.

**Expected:** the extension card shows:
- Name: `deepseek-connect`
- Version: `0.1.0`
- Status: no errors (no red "Errors" badge)

**If this didn't work:**
- "Load unpacked" button doesn't appear — Developer mode isn't on. Toggle it in the top right.
- `Manifest file is missing or unreadable` — you selected a subdirectory. The picker must point at the folder containing `manifest.json`, `background.js`, and `content.js`.
- `Service worker registration failed` — open the extension's "Errors" panel (there's a red button if this happened). Usually a typo in `background.js`'s `importScripts('shared.js')` line — verify all six files exist: `manifest.json`, `background.js`, `content.js`, `shared.js`, `selectors.js`, `popup.html`.

---

## Step 3 — Configure the token

Click the extension icon in the toolbar. A popup opens with two fields:

- **Token** — the `EXTENSION_TOKEN` from your `.env`
- **Port** — the `EXTENSION_PORT` from your `.env` (`7331` by default)

Paste `demo-token-12345` (or your real token) into the Token field. Leave the Port at `7331` unless you changed `.env`. Click **Save**.

The popup shows `saved` briefly. The token is now stored in `chrome.storage.local` — the extension persists it across reloads, browser restarts, and server restarts.

**Expected:** the popup's status dot is now **yellow** or **red** (not green yet — the server isn't running). Yellow means "waiting," red means "error."

**If this didn't work:**
- Popup doesn't open — click the puzzle-piece icon in the toolbar (Extensions menu) and pin deepseek-connect. The icon is sometimes hidden by default.
- Popup opens but **Save** does nothing — open the browser DevTools console (F12) on the popup (right-click the popup → **Inspect**). Errors here will be obvious.
- `saved` appears but the popup still shows empty token on next open — `chrome.storage.local` isn't persisting. Check that the extension has the `storage` permission (it does in `manifest.json`, but a fresh checkout or an edited manifest can drop it).

---

## Step 4 — Start the server

Open a terminal in the `deepseek-connect` directory. Start the server:

```bash
node --env-file=.env src/server.js
```

You'll see one line:

```
[HH:MM:SS] listening on 127.0.0.1:7331
```

That's the server telling you it's bound and ready. It doesn't yet know about your extension — that's the next line, and it only appears when the extension polls.

**Switch to Brave. Open a new tab, go to `https://chat.deepseek.com/`.** If you're already logged in, the chat input appears at the bottom. If you see a login screen, log in.

**Switch back to the terminal.** Within 1-2 seconds, the extension registers:

```
[HH:MM:SS] extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)
```

That's the `/hello` registration. The extension found your DeepSeek tab, read its URL, and told the server it exists.

**Expected:**
- `listening on 127.0.0.1:7331`
- Within 2 seconds: `extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)`

The popup's status dot is now **green**.

**If this didn't work:**

- **No `extension connected` line after 5 seconds.** The extension isn't polling. Three causes:
  1. Token mismatch — compare the popup's Token field against `.env`'s `EXTENSION_TOKEN`. They must be byte-identical, including whitespace.
  2. Extension not reloaded after the last change — in `brave://extensions`, click the reload button on the deepseek-connect card.
  3. No DeepSeek tab open — the extension needs at least one `chat.deepseek.com` tab to register against. Open the URL if you haven't.

- **`extension connected ... | 0 tab(s)`.** The extension found DeepSeek but couldn't pick a work tab. Unusual — means your only DeepSeek tab is in a state the extension doesn't trust (mid-login, error page). Close the tab, open a fresh `chat.deepseek.com/`, and the extension will re-register on the next tab event.

- **`EADDRINUSE: 127.0.0.1:7331`.** Another process is on that port. Either kill it (`lsof -i :7331` to find the PID) or change `EXTENSION_PORT` in `.env` to `7332` and the popup's Port to match.

- **`bad option: --env-file`.** Node is older than 22. Upgrade — see [Before you start](#before-you-start).

- **`Error: EXTENSION_TOKEN not set`.** The `.env` file isn't in the current directory, or the `--env-file=.env` flag isn't pointing at it. Check `ls .env` — if it's missing, you're in the wrong directory; if it exists, check the flag's relative path.

Leave this terminal running. The server stays up for the rest of the walkthrough.

---

## Step 5 — First round-trip

Open a **second** terminal (the first one holds the server — it needs to stay running). In the new terminal, from the `deepseek-connect` directory:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: hello from deepseek-connect"}],"chat":"first-test"}' \
  | python3 -m json.tool
```

**Watch the first terminal** while the curl runs. In 5-15 seconds, you should see the phases scroll:

```
[HH:MM:SS] <- enqueued <id> | Reply with exactly: hello from deepseek-connect
[HH:MM:SS] -> dispatched <id> | Reply with exactly: hello from deepseek-connect
[HH:MM:SS]   ~ <id8> probe {"healthy":["input","toggleDeepThink","toggleSearch","chatList"],...}
[HH:MM:SS]   ~ <id8> waitInput {"found":true}
[HH:MM:SS]   ~ <id8> toggleDeepthink {"ok":true}
[HH:MM:SS]   ~ <id8> toggleSearch {"ok":true}
[HH:MM:SS]   ~ <id8> setInput {"promptLen":51,"typedLen":51,"msgBefore":0}
[HH:MM:SS]   ~ <id8> sendClick {"ms":105}
[HH:MM:SS]   ~ <id8> firstMsg {"msgs":1,"url":"..."}
[HH:MM:SS]   ~ <id8> reasoning {"len":23}
[HH:MM:SS]   ~ <id8> answerStarted
[HH:MM:SS]   ~ <id8> answer {"len":18}
[HH:MM:SS] ok done <id> | <N>ms
```

**Then switch to Brave.** The DeepSeek tab now shows a new chat titled "Reply with exactly..." (auto-named by DeepSeek from your message). Your prompt is there and the assistant has replied: `hello from deepseek-connect`.

**Switch back to the second terminal.** The curl returns:

```json
{
  "content": "hello from deepseek-connect",
  "chat": "first-test",
  "elapsedMs": 6789
}
```

### What just happened

Six things happened, in order:

1. **Your curl POSTed to `/chat`.** The server enqueued the request. Your curl's connection stayed open — the server didn't respond yet.

2. **The extension was polling `GET /next`.** The server dispatched the job: it responded to the extension's pending poll with `{ action: 'next', prompt: '...', chatName: 'first-test' }`.

3. **The extension asked the content script to `ensureChat('first-test')`.** The content script looked in the sidebar for a chat named "first-test". Not found (it's the first time). The content script saw the tab was already on `/` (fresh chat page) and returned `{ ok: true, existing: false, mode: 'fresh' }` — no navigation needed.

4. **The extension asked the content script to `sendPrompt`.** The content script:
   - Resolved every required selector (`probe` — all healthy)
   - Verified DeepThink was on (`toggleDeepthink {ok: true}` — it was, no click needed)
   - Verified Search was on (`toggleSearch {ok: true}` — same)
   - Typed your prompt into the input (`setInput`)
   - Clicked send (`sendClick`)
   - Captured the URL (`firstMsg {url: '...'}`)
   - Watched for the answer block to appear (`reasoning` → `answerStarted`)
   - Read the answer (`answer {len: 18}`)
   - Detected the stream stabilized (`replyDone`, not shown in the abbreviated output above)

5. **The extension POSTed `/reply`.** The server looked up the `requestId` in `inFlight`, found the pending `/chat` promise, and resolved it with `{ content: 'hello from deepseek-connect', chat: 'first-test', elapsedMs: 6789 }`.

6. **Your curl received the JSON.** The HTTP connection that had been held open for 6.8 seconds received its body and closed.

The `chat: 'first-test'` in the response is what you sent. But the actual DeepSeek chat is titled "Reply with exactly..." because DeepSeek auto-names chats from the first message. The next step shows how to make this reuse the same chat.

**If this didn't work:**

- **curl hangs for 90+ seconds, then times out.** The server dispatched but the extension never replied. Check the first terminal — if it shows `dispatched` with no `probe` after it, the extension either crashed or is stuck. Go to `brave://extensions`, click the "service worker" link on the deepseek-connect card, and check its console for errors. If it's greyed out, the service worker isn't running — reload the extension.

- **`{"ok": false, "error": "auth_failed"}`.** The `-H "Authorization: Bearer demo-token-12345"` doesn't match `.env`'s `EXTENSION_TOKEN`. Compare exactly.

- **`{"ok": false, "error": "extension_disconnected"}`.** The extension isn't connected. Go back to step 4 — the server should have shown an `extension connected` line by now. If it didn't, the token in the popup and `.env` mismatch.

- **`{"ok": false, "error": "logged_out"}`.** The DeepSeek tab shows a login screen. Log in, then re-run.

- **`{"ok": false, "error": "input_not_found"}`.** The DeepSeek tab doesn't have a chat input. Either the tab is on a different page (not `chat.deepseek.com/`), or the tab was closed after the extension registered. Open a fresh `chat.deepseek.com/` and re-run.

- **curl returns but `content` is reasoning text** (something like "The user wants me to reply with..."). This is a known bug in older builds where the extraction reads the reasoning block instead of the answer. If you cloned from a commit before November 2026, upgrade. If you're on current `main`, this is a bug — [file an issue](https://github.com/pulchowk-events/deepseek-connect/issues) with the `trace` array from the server log.

---

## Step 6 — Same chat, second turn

Send another prompt to the same `chat` name:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What did I ask you to reply with, one message ago?"}],"chat":"first-test"}' \
  | python3 -m json.tool
```

**Expected response:**

```json
{
  "content": "You asked me to reply with exactly: 'hello from deepseek-connect'.",
  "chat": "first-test",
  "elapsedMs": 5432
}
```

The LLM remembers the previous turn. **This is the key behavior for batch wizards.** On retry, the same chat is reused so the LLM sees its own prior attempts in context. When you refine a prompt because the extractor verification failed, the refined prompt lands in the same chat and the LLM can see "here's what I tried, here's why it failed."

### What just happened

Same six steps, but with two differences:

1. **`ensureChat('first-test')` found the chat this time.** The sidebar now has a chat whose title contains "first-test" — actually no, wait. The chat was auto-named "Reply with exactly..." from the first prompt. So `findChatInSidebar('first-test')` searched for "first-test" and *didn't* find it (the title doesn't contain that string).

Hmm, that means the second prompt *should* have opened a fresh chat, not reused the first one. But the response says the LLM remembers. Let me reconsider.

Actually, `findChatInSidebar('first-test')` looks for a sidebar entry whose text *contains* "first-test". The auto-generated title was "Reply with exactly..." — which doesn't contain "first-test". So the fuzzy match failed, and this should have opened a fresh chat.

Unless... the sidebar item is actually titled with the prompt text. On current DeepSeek, auto-naming uses the first ~30 characters of the first message. "Reply with exactly: hello from deepseek-connect" is 51 chars, so the title is something like "Reply with exactly: hello from de...". That title *does* contain "deepseek-connect" and *does not* contain "first-test".

So on the second call, `findChatInSidebar('first-test')` returns null. The extension sees the tab is at `/a/chat/s/<uuid>` (an existing chat, not `/`), returns `needNewChat: true`, background navigates to `/`, retries `ensureChat('first-test')` — still no match, but now on a fresh `/` so it succeeds with `mode: 'fresh'`.

Result: a fresh chat, containing only the "What did I ask you to reply with" prompt. The LLM has no context. It would say "I don't know" or hallucinate.

But the expected response above says the LLM remembers. That means either:

(a) The fuzzy match is doing something I'm not seeing — maybe `findChatInSidebar` matches partial strings and the chat title includes the source name because the LLM echoed it back.
(b) The chat title got auto-updated after the second message to include the second message's text.
(c) My understanding of `findChatInSidebar` is wrong.

Looking at the actual `findChatInSidebar` code from earlier in the conversation:

```js
function findChatInSidebar(name) {
  const re = new RegExp(escapeRe(name), 'i');
  const leaves = listChatLeafItems();
  for (const leaf of leaves) {
    const t = (leaf.textContent || '').trim();
    if (t === name || re.test(t)) return clickableAncestor(leaf);
  }
  return null;
}
```

`re = /first-test/i` — it looks for "first-test" in any sidebar leaf. If the title is "Reply with exactly: hello from deepseek-connect", it doesn't match.

Unless... the chat title on DeepSeek updates after the second message? No, DeepSeek titles from the first message.

Hmm. Let me look at the actual behavior we observed in the earlier development. The user said "Say hi src-alpha" was the prompt, and the title became "Say hi src-alpha". Then on the second call with `chat: 'src-alpha'`, `findChatInSidebar('src-alpha')` found "Say hi src-alpha" because it contains "src-alpha".

So the pattern is: the chat title auto-names from the first message, and if the first message *contains* the source name (which prompts do, because the batch prompt embeds the source name in the first line), the sidebar title contains it.

For my walkthrough, the first message is "Reply with exactly: hello from deepseek-connect" — which does NOT contain "first-test". So the fuzzy match would fail on the second call.

I need to fix the walkthrough. Either:
- Change the first prompt to include "first-test" literally in the message
- Change the second prompt's chat name to match what the first chat's title actually is
- Explain this gotcha in the walkthrough (it's actually educational)

Best approach: adjust the example prompts so the first message contains the chat name. That's the actual pattern batch wizards use. For example:

First prompt: "Reply with exactly: hello from first-test" — the title becomes "Reply with exactly: hello from first-test" which contains "first-test".

Wait but the second call uses `chat: 'first-test'` which matches. Good.

But actually — even better is to make this an explicit teaching moment. The "what just happened" section should explain that the fuzzy match works because the chat title contains the source name, and that's why batch prompts always embed the source name in the first line.

Let me restructure step 6:

1. First prompt (step 5): "Reply with exactly: hello from deepseek-connect" — this creates a chat titled "Reply with exactly: hello from deepseek-connect"
2. Second prompt (step 6): "What did I ask you to reply with? Also, does the string 'deepseek-connect' appear in your first reply?" with `chat: 'deepseek-connect'` — but wait, the fuzzy match for 'deepseek-connect' would look for that exact string. The title "Reply with exactly: hello from deepseek-connect" DOES contain "deepseek-connect". So the match would succeed!

But then the first prompt's chat name in the response was `chat: 'first-test'` — which doesn't match. Hmm.

OK, the cleanest fix is:

Step 5: `chat: 'first-test'`, prompt contains "first-test" literally: "Reply with exactly: first-test-ready". Then the auto-generated title would be "Reply with exactly: first-test-ready" which contains "first-test". Second call with `chat: 'first-test'` finds it.

But then the second call would be the "what did I say" question, and the LLM would see the first prompt in context and answer correctly.

Let me rewrite:

Step 5 prompt: "Reply with exactly: first-test-ready"
Auto title becomes: "Reply with exactly: first-test-ready" or truncated version — contains "first-test"
Step 6 prompt: "What did I ask you to reply with, one message ago?"
`chat: 'first-test'` — fuzzy match finds "Reply with exactly: first-test-ready" via "first-test" substring
LLM answers: "You asked me to reply with 'first-test-ready'"

That works.

Actually wait, let me look at the actual `findChatInSidebar` name matching more carefully. The `name` parameter is 'first-test'. The regex is `/first-test/i`. The chat title is "Reply with exactly: first-test-ready". `re.test('Reply with exactly: first-test-ready')` → does "first-test" appear in that string? Yes, "first-test-ready" contains "first-test" as a substring. Match.

Good. So my fix works.

Let me rewrite step 5 and step 6 with this pattern.

Actually, since I've already started writing the response and the user said "continue" expecting the full doc, let me just produce the full doc with this correction applied. I'll use `chat: 'first-test'` and prompts that embed "first-test" in the message.

Let me update step 5's prompt to: "Reply with exactly: first-test-ready"
Expected content: "first-test-ready"
Step 6's prompt: "What did I ask you to reply with, one message ago?"
Expected content: "You asked me to reply with 'first-test-ready'."

Perfect. And I'll explain in the "what just happened" that the fuzzy match works because the auto-generated title contains "first-test" — which is why batch prompts always embed the source name in the first message.

Let me also fix step 7 and 8 accordingly.

Step 7 (different chat): send another prompt to a different chat name, e.g., `second-test`. First prompt must contain "second-test" so the auto-named title does too.

Step 8 (open by name): use `/open` with a name that's already a sidebar chat.

Let me now write the whole doc cleanly.

Also, "content" in step 5 — I said it would be "hello from deepseek-connect" — I need to update it to "first-test-ready" or whatever the prompt actually says. Let me use "hello-from-first-test" for the content, or simpler: "ready". Let me use "hello" as the reply and embed "first-test" in the message:

Prompt: "Reply with exactly: hello-from-first-test"
Content returned: "hello-from-first-test"

Hmm, then the delimiter extraction wouldn't even be needed — the LLM replies with exactly that. Fine, it proves the round-trip.

Actually, for a first round-trip, simpler is better. Let me just use:

Step 5 prompt: "Reply with exactly: first-test-ready"
Expected content: "first-test-ready"
Expected title: "Reply with exactly: first-test-ready" (or truncated "Reply with exactly: first-tes...")

The truncation might cut off "first-test" if it's right at the boundary. On DeepSeek the truncation is about 30 chars. "Reply with exactly: first-test-ready" is 37 chars. Truncated to ~30 would be "Reply with exactly: first-tes" — which still contains "first-tes" but not "first-test".

Hmm, that would fail the fuzzy match.

To be safe, put "first-test" at the very beginning:

Step 5 prompt: "first-test Reply with exactly: hello"
Title becomes: "first-test Reply with exactly: ..." — first-test at position 0, always survives truncation.

Or even simpler:
Step 5 prompt: "first-test: reply ready"
Title: "first-test: reply ready" — 22 chars, no truncation.

Let me use that pattern:

Step 5 prompt: "first-test: reply with hello"
Expected content: "hello"
Title: "first-test: reply with hello" — contains "first-test" ✓

Or even simpler, just make the chat name the entire first message:

Step 5 prompt: "first-test"
Expected content: something (LLM replies to "first-test" with some greeting)

But that's a weird prompt.

Best balance: prompt explicitly mentions the name in a natural way:
Step 5: "Reply with the word 'hello'. The chat is named first-test."
Title: "Reply with the word 'hello'. Th..." — truncated, doesn't contain "first-test"

Or:
Step 5: "first-test — reply with hello"
Title: "first-test — reply with hello" — 27 chars, fits, contains "first-test" ✓

That's what I'll use.

OK let me just write the doc now. I'll be careful with the prompts.

Let me also think about step 7 and step 8:

Step 7 (different chat): 
Prompt: "second-test — reply with hi"
chat: 'second-test'
Auto title: "second-test — reply with hi"
Response: { content: 'hi', chat: 'second-test' }
Visual: DeepSeek sidebar now has TWO chats: "first-test — reply with hello" and "second-test — reply with hi"

Step 8 (open by name):
`/open { chatName: 'first-test' }` 
Expected: `{ existing: true, mode: 'existing', debug: {...}, chat: 'first-test' }`
Visual: the work tab navigates to the "first-test" chat

Then step 9 could be a third prompt in first-test to confirm:
Prompt: "What did I ask you to reply with in this chat?"
Expected content: "hello" (from context)
This proves the reuse works end-to-end.

That's a good cap. Let me write it.

One more thing: the doc is getting long. Let me keep it tight. The tutorial doesn't need every possible variation. 8 steps is right.

Final structure:
- Before you start
- Step 1 — Install
- Step 2 — Load the extension
- Step 3 — Configure the token
- Step 4 — Start the server
- Step 5 — First round-trip
- Step 6 — Same chat, second turn (proves reuse)
- Step 7 — Different chat (proves isolation)
- Step 8 — Open a chat by name (proves the /open route)
- What you've built
- Where to go next

Let me write it cleanly now.# Getting started

A hands-on tutorial. Install the extension, start the server, send your first prompt, get a reply, and understand what just happened. Follow it top to bottom — each section builds on the last, and each has an expected output you can compare against and a "if this didn't work" branch for the common stumbles.

If you already have a working install and just want the API surface, skip to [protocol.md](protocol.md). If you're deciding whether this repo is what you need, read [README.md](../README.md) first. This doc is for the reader who has decided to install it and wants to do that carefully.

**Contents**
- [Before you start](#before-you-start)
- [Step 1 — Install](#step-1--install)
- [Step 2 — Load the extension](#step-2--load-the-extension)
- [Step 3 — Configure the token](#step-3--configure-the-token)
- [Step 4 — Start the server](#step-4--start-the-server)
- [Step 5 — First round-trip](#step-5--first-round-trip)
- [Step 6 — Same chat, second turn](#step-6--same-chat-second-turn)
- [Step 7 — Different chat](#step-7--different-chat)
- [Step 8 — Open a chat by name](#step-8--open-a-chat-by-name)
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

**3. A logged-in DeepSeek account.** Open a new tab, go to `https://chat.deepseek.com/`, log in. You should see the chat input at the bottom of the page and your profile name in the sidebar. If you see a login screen, log in before continuing — the extension can't log you in, and every prompt will fail with `logged_out`.

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

**Expected:** `ls -la` shows a `.env` file around 60–80 bytes. `cat .env` shows your token and port.

**If this didn't work:**
- `cp: .env.example: No such file or directory` — you're not in the `deepseek-connect` directory. `pwd` should end in `/deepseek-connect`.
- `.env` exists but is 0 bytes — the `cp` failed silently. Re-run it.
- Windows PowerShell — `cp` is `Copy-Item`, and `openssl` may not exist. Use `[System.Guid]::NewGuid().ToString()` or just type a 32-character random string.

---

## Step 2 — Load the extension

Open `brave://extensions` (or `chrome://extensions` / `edge://extensions`).

Enable **Developer mode** — the toggle in the top right of the page. This is required for "Load unpacked" to appear.

Click **Load unpacked**. A file picker opens. Navigate to your `deepseek-connect/` directory and select it (not a file inside it — the whole folder).

The extension appears in the list as **deepseek-connect** with version `0.1.0`.

**Expected:** the extension card shows name `deepseek-connect`, version `0.1.0`, no red "Errors" badge.

**If this didn't work:**
- "Load unpacked" button doesn't appear — Developer mode isn't on. Toggle it in the top right.
- `Manifest file is missing or unreadable` — you selected a subdirectory. The picker must point at the folder containing `manifest.json`, `background.js`, and `content.js`.
- `Service worker registration failed` — click the red "Errors" button. Usually a typo in `background.js`'s `importScripts('shared.js')`. Verify all six files exist: `manifest.json`, `background.js`, `content.js`, `shared.js`, `selectors.js`, `popup.html`.

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

**Switch to Brave. Open a new tab, go to `https://chat.deepseek.com/`.** If you're logged in, the chat input appears at the bottom. If you see a login screen, log in.

**Switch back to the terminal.** Within 1–2 seconds:

```
[HH:MM:SS] extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)
```

That's the `/hello` registration. The extension found your DeepSeek tab, read its URL, and told the server it exists.

**Expected:**
- `listening on 127.0.0.1:7331`
- Within 2 seconds: `extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)`

The popup's status dot is now **green**.

**If this didn't work:**

- **No `extension connected` line after 5 seconds.** Three causes:
  1. Token mismatch — compare the popup's Token field against `.env`'s `EXTENSION_TOKEN` byte-for-byte.
  2. Extension not reloaded after a change — in `brave://extensions`, click the reload button on the deepseek-connect card.
  3. No DeepSeek tab open — the extension needs at least one `chat.deepseek.com` tab to register against.

- **`extension connected ... | 0 tab(s)`.** The extension found DeepSeek but couldn't pick a work tab. Close the tab, open a fresh `chat.deepseek.com/`, and the extension re-registers on the next tab event.

- **`EADDRINUSE: 127.0.0.1:7331`.** Another process is on that port. Either kill it (`lsof -i :7331`) or change `EXTENSION_PORT` in `.env` to `7332` and the popup's Port to match.

- **`bad option: --env-file`.** Node is older than 22. Upgrade — see [Before you start](#before-you-start).

- **`Error: EXTENSION_TOKEN not set`.** `.env` isn't in the current directory, or the flag's relative path is wrong.

Leave this terminal running. The server stays up for the rest of the walkthrough.

---

## Step 5 — First round-trip

Open a **second** terminal (the first one holds the server). In the new terminal, from the `deepseek-connect` directory:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"first-test — reply with exactly: hello"}],"chat":"first-test"}' \
  | python3 -m json.tool
```

**Watch the first terminal** while the curl runs. In 5–15 seconds:

```
[HH:MM:SS] <- enqueued <id> | first-test — reply with exactly: hello
[HH:MM:SS] -> dispatched <id> | first-test — reply with exactly: hello
[HH:MM:SS]   ~ <id8> probe {"healthy":["input","toggleDeepThink","toggleSearch","chatList"],...}
[HH:MM:SS]   ~ <id8> waitInput {"found":true}
[HH:MM:SS]   ~ <id8> toggleDeepthink {"ok":true}
[HH:MM:SS]   ~ <id8> toggleSearch {"ok":true}
[HH:MM:SS]   ~ <id8> setInput {"promptLen":39,"typedLen":39,"msgBefore":0}
[HH:MM:SS]   ~ <id8> sendClick {"ms":105}
[HH:MM:SS]   ~ <id8> firstMsg {"msgs":1,"url":"..."}
[HH:MM:SS]   ~ <id8> reasoning {"len":23}
[HH:MM:SS]   ~ <id8> answerStarted
[HH:MM:SS]   ~ <id8> answer {"len":18}
[HH:MM:SS] ok done <id> | <N>ms
```

**Switch to Brave.** The DeepSeek tab shows a new chat. The sidebar title is "first-test — reply with exactly: hello" (or truncated with "first-test" intact). Your prompt is there, and the assistant replied "hello".

**Switch back to the second terminal.** The curl returns:

```json
{
  "content": "hello",
  "chat": "first-test",
  "elapsedMs": 6789
}
```

### What just happened

Six things, in order:

1. **Your curl POSTed to `/chat`.** The server enqueued the request. Your curl's connection stayed open — no response yet.

2. **The extension was polling `GET /next`.** The server dispatched the job: it responded to the extension's pending poll with `{ action: 'next', prompt: '...', chatName: 'first-test' }`.

3. **The extension asked the content script to `ensureChat('first-test')`.** The content script looked in the sidebar for a chat whose title contains "first-test". Not found. The tab was already on `/`, so no navigation needed — the content script returned `{ ok: true, existing: false, mode: 'fresh' }`.

4. **The extension asked the content script to `sendPrompt`.** The content script resolved every selector (`probe` — all healthy), verified DeepThink and Search were on (`toggleDeepthink`, `toggleSearch` — both already on, no clicks), typed the prompt (`setInput`), clicked send (`sendClick`), captured the URL (`firstMsg`), watched for the answer block (`reasoning` → `answerStarted`), read the answer (`answer`), and detected the stream stabilized.

5. **The extension POSTed `/reply`.** The server resolved the pending `/chat` promise with `{ content: 'hello', chat: 'first-test', elapsedMs: 6789 }`.

6. **Your curl received the JSON.** The connection that had been open for 6.8 seconds received its body and closed.

**The chat title matters.** DeepSeek auto-names every chat from its first message. The first message here was `"first-test — reply with exactly: hello"`, so the auto-generated title starts with `"first-test"`. That's *why* the prompt embeds `first-test` in the message — on the next call, `findChatInSidebar('first-test')` will find this chat by matching the substring. This is the mechanism batch wizards rely on for retry-reuse. Step 6 shows it working.

**If this didn't work:**

- **curl hangs for 90+ seconds, then times out.** The extension never replied. Check the first terminal — if `dispatched` appears with no `probe` after it, the extension crashed or is stuck. In `brave://extensions`, click the "service worker" link; if it's greyed out, reload the extension.

- **`{"ok": false, "error": "auth_failed"}`.** Your `-H "Authorization: Bearer ..."` doesn't match `.env`'s `EXTENSION_TOKEN`. Compare exactly.

- **`{"ok": false, "error": "extension_disconnected"}`.** Extension not connected. Step 4's `extension connected` line should have appeared. If not, token mismatch.

- **`{"ok": false, "error": "logged_out"}`.** The DeepSeek tab shows a login screen. Log in and re-run.

- **`{"ok": false, "error": "input_not_found"}`.** The tab doesn't have a chat input. Open a fresh `chat.deepseek.com/` and re-run.

- **`content` is reasoning text** (something like "The user wants me to reply with..."). Known bug in older builds where extraction reads the reasoning block. If you cloned from `main` after November 2026, [file an issue](https://github.com/pulchowk-events/deepseek-connect/issues) with the `trace` array.

---

## Step 6 — Same chat, second turn

Send another prompt to the same `chat` name:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What did I ask you to reply with, one message ago?"}],"chat":"first-test"}' \
  | python3 -m json.tool
```

**Expected response:**

```json
{
  "content": "You asked me to reply with exactly: hello",
  "chat": "first-test",
  "elapsedMs": 5432
}
```

The LLM remembers the previous turn. **This is the key behavior for batch wizards.** On retry, the same chat is reused so the LLM sees its own prior attempts in context. When you refine a prompt because extractor verification failed, the refined prompt lands in the same chat and the LLM can see "here's what I tried, here's why it failed."

### What just happened

Same pipeline, but step 3 differs:

**`ensureChat('first-test')` found the chat this time.** The content script walked the sidebar, found the entry titled "first-test — reply with exactly: hello" (or its truncated form — the `first-test` prefix survives truncation), and clicked it. The work tab navigated to that chat's URL, which already contains the first exchange. The second prompt was appended as the next turn.

The `ok done` line in the server log is slightly faster than step 5's (no fresh-chat path to wait through, no toggle warmup). Both prompts used the *same* chat, so the LLM had context.

**If this didn't work:**

- **`content` is something like "I don't have prior context in this conversation."** The chat was not reused — a fresh chat was opened. Look for `need_nav` in the server log around the second `/chat`. If you see navigation to `/` instead of a sidebar click, `findChatInSidebar` didn't match. Most likely your first prompt didn't contain `first-test` literally (e.g. you edited the prompt and dropped it). Re-run step 5 with the prompt unchanged.

- **`content` mentions a different source name.** The sidebar matched the *wrong* chat. Your sidebar has an older chat from a prior run whose title also contains "first-test". `findChatInSidebar` returns the *first* match in document order (top of sidebar = most recent). Old chats get pushed down, so a fresh match wins — unless the sidebar is scrolled or the old chat is pinned. If this happens, use a fresh `chat` name (e.g. `first-test-2`) and re-run.

---

## Step 7 — Different chat

Send a prompt to a *different* chat name:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"second-test — reply with exactly: hi"}],"chat":"second-test"}' \
  | python3 -m json.tool
```

**Expected response:**

```json
{
  "content": "hi",
  "chat": "second-test",
  "elapsedMs": 5100
}
```

**Switch to Brave.** The sidebar now has two chats:

- `first-test — reply with exactly: hello`
- `second-test — reply with exactly: hi`

The work tab is on the `second-test` chat.

### What just happened

`ensureChat('second-test')` returned `need_nav: true` — the sidebar had no chat containing "second-test". Background navigated the work tab to `/`, retried `ensureChat`, found the fresh `/` page, sent the prompt. DeepSeek auto-named the new chat from the message.

**This is the isolation guarantee.** Each source gets its own chat. The first source's context doesn't bleed into the second's. If you sent a third prompt to `first-test` right now, it would navigate back to the first chat (via sidebar click) and the LLM would answer in the first source's context — completely separate from `second-test`.

**If this didn't work:**

- **`content` references the first chat's content** (e.g. answers "hello" instead of "hi"). The chat was reused when it should have been fresh. Check the server log for `need_nav` around this call — if the log shows `mode: existing` instead, the sidebar fuzzy match is too loose: "second-test" is being matched against the first chat's title somehow. Rename your chat names to be more distinct.

---

## Step 8 — Open a chat by name

Now use `/open` to explicitly navigate to an existing chat without sending a prompt:

```bash
curl -s -X POST http://127.0.0.1:7331/open \
  -H "Authorization: Bearer demo-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"chatName":"first-test"}' | python3 -m json.tool
```

**Expected response:**

```json
{
  "ok": true,
  "existing": true,
  "mode": "existing",
  "debug": {
    "sideFound": true,
    "leafCount": 13,
    "leafPreview": ["first-test — reply with exactly: hello", "second-test — reply with exactly: hi", "..."],
    "name": "first-test",
    "path": "/a/chat/s/xxxx"
  },
  "chat": "first-test"
}
```

**Switch to Brave.** The work tab navigated to the first chat. The sidebar shows both chats; the first is highlighted.

### What just happened

`/open` is the chat lifecycle route without a prompt. It runs `ensureChat('first-test')`, which finds the sidebar entry and clicks it. The `debug` field is the diagnostic snapshot: `sideFound: true` means the sidebar walk worked, `leafCount: 13` means it enumerated 13 chat-title candidates, `leafPreview` shows the first 8 — including "first-test" and "second-test".

Batch wizards call `/open` once per source, before `/chat`, to establish the chat deterministically. It's also useful for testing `findChatInSidebar` without spending an LLM call.

**If this didn't work:**

- **`existing: false`** — the sidebar match failed. Look at `debug.leafPreview` — if "first-test" is missing from the list, either the chat title doesn't contain the string (check by scrolling the sidebar in Brave), or `leafCount` is 0 (sidebar walk broke — see [selector-maintenance.md](selector-maintenance.md)).

- **`existing: true` but the work tab shows the wrong chat** — `leafPreview` reveals which chat was matched. If two chats match "first-test", the sidebar order determines which wins (top = most recent). Rename chats to be unambiguous.

---

## What you've built

You have:

- The `deepseek-connect` extension loaded in your browser, authenticated to the server via `EXTENSION_TOKEN`
- A running HTTP server on `127.0.0.1:7331` that queues prompts and returns DeepSeek replies
- A working `/chat` route: prompt in, content out, in 4–12 seconds
- A working chat lifecycle: same `chat` name reuses the same DeepSeek chat (retry context), different `chat` names get their own chat (isolation)
- A working `/open` route: navigate to a chat by name without sending a prompt
- Live progress telemetry in the server log: every phase of every prompt is visible as it happens

That's the entire functional surface. Everything else is either a helper (`/tabs`, `/reset`), extension-side (`/hello`, `/next`, `/reply`, `/progress`), or a refinement (better error handling, retries, beeps).

## Where to go next

You've used the API. Now read the docs that make it navigable:

- **[protocol.md](protocol.md)** — the full route reference. You'll need `POST /chat`'s request shape and `GET /tabs`'s response shape for anything beyond the basic flow.
- **[error-codes.md](error-codes.md)** — the 20 failure codes with the decision rule for each. Read this before writing a `try/catch` that switches on `err.code`.
- **[integration-guide.md](integration-guide.md)** — the batch wizard blueprint. Same walkthrough you just did, but as a Node integration: `require('deepseek-connect')`, transport abstraction, batch loop, error policy.
- **[architecture.md](architecture.md)** — the "why" behind every decision you just exercised. Read this before proposing a change; the seven load-bearing choices are pinned to ADRs there.
- **[operations.md](operations.md)** — the reload discipline, log interpretation, and recovery playbook for `logged_out`, `extension_disconnected`, and the other things that go wrong in real use.
- **[selector-maintenance.md](selector-maintenance.md)** — the recovery playbook when DeepSeek ships a UI change and the extension starts failing with `dom_drift`.

If you're integrating `deepseek-connect` into a batch wizard, the [integration-guide.md](integration-guide.md) is your next read. If you're operating it as-is, [operations.md](operations.md) is. If you're modifying the internals, [architecture.md](architecture.md) first.