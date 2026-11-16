# Integration guide

How to wire `deepseek-connect` into a batch wizard. This doc assumes you're a developer or an LLM working on a *different* repository — `pulchowk-events/aggregator`, most likely — and you need to add a `--extension` mode to an existing batch paste loop without breaking the existing `--manual` mode. If you're looking for the wire protocol, read [protocol.md](protocol.md). If you're looking for what each error means, read [error-codes.md](error-codes.md). This doc is the concrete blueprint that shows how the three fit together into a working integration.

**Contents**
- [What you're building](#what-youre-building)
- [Prerequisites](#prerequisites)
- [The transport abstraction](#the-transport-abstraction)
- [ExtensionTransport implementation](#extensiontransport-implementation)
- [Lifecycle](#lifecycle)
- [The batch loop](#the-batch-loop)
- [Error policy](#error-policy)
- [Flag parsing and defaults](#flag-parsing-and-defaults)
- [Concurrency](#concurrency)
- [Smoke test before a full batch](#smoke-test-before-a-full-batch)
- [Acceptance checklist](#acceptance-checklist)

---

## What you're building

The `batch paste` command in the aggregator currently has a manual clipboard loop. For each source, it:

1. Copies an LLM prompt to the clipboard
2. Opens DeepSeek in a browser for the user
3. Waits for the user to paste the prompt, wait for the reply, and copy the reply back
4. Validates the reply (JS syntax, identity check)
5. Extracts the code block
6. Writes the extractor to `data/batch/<run>/generated/<name>.js`
7. Advances to the next source

The user does 76 of those paste round-trips per batch. It takes 80 minutes. It also silently produces the wrong-clipboard-copy bug about once per batch.

You're replacing steps 1-5 with an HTTP round-trip. The batch loop *structure* stays identical — same per-source iteration, same identity check, same extraction, same file write, same advance. What changes is the transport underneath: instead of clipboard + human, the loop calls `dc.chat()` and gets `{ content }` back in 4–12 seconds.

**The design goal is that the batch loop doesn't know which transport it's using.** Same loop, same per-source logic, same error handling — a transport-agnostic interface that happens to have two implementations. That's what lets `--manual` survive as a fallback (for when the extension isn't loaded, or the user wants to watch the round-trip, or DeepSeek redesigns and the extension is temporarily broken) with zero duplicated orchestration.

## Prerequisites

Before you write a line of integration code, confirm these are true on the machine:

1. **`deepseek-connect` is installed.** Either as a sibling repo via `npm link`, a git dependency in `package.json`, or a relative `require('../../../deepseek-connect/src/server')`. `require('deepseek-connect')` must resolve. If it doesn't, the rest of this doc is moot — fix the install first.

2. **The extension is loaded and connected.** Open `brave://extensions`, load unpacked, set the token in the popup. Open `chat.deepseek.com` in one tab. The server terminal (once you start it) should print `extension connected (0.1.0) | ...`. If it doesn't, see [operations.md#reload-discipline](operations.md#reload-discipline).

3. **`EXTENSION_TOKEN` is set.** Same value in `.env` and the popup. If the token doesn't match, every request returns `auth_failed` (see [error-codes.md](error-codes.md)).

4. **You know the current `batch paste` shape.** Read `scripts/batch/paste.js` in the aggregator before writing the integration. The batch loop's structure — per-source iteration, identity check, extraction, advance — is what you're preserving. The transport is what you're swapping.

## The transport abstraction

One interface, two implementations. The batch loop only sees the interface.

```js
// scripts/batch/lib/transport.js
//
// Both transports implement this interface. The batch loop never knows
// which one it's using.

class Transport {
  /**
   * Establish the chat for a source. Called once per source, before chat().
   * Extension: opens the named chat (or navigates to / for a fresh one).
   * Manual: no-op — the clipboard loop doesn't track chats.
   */
  async open(chatName) {}

  /**
   * Send the prompt, wait for the reply, extract the code block, return it.
   * Extension: POST /chat, wait for the JSON response, extract via dc's
   *            built-in delimiter/fence/raw passes.
   * Manual: copy to clipboard, poll for user paste, read reply from clipboard,
   *         extract via existing extractCodeFromClipboard.
   *
   * Returns: { content: string, elapsedMs: number, chat: string|null }
   * Throws:  Error with { code, reason, retryable, retryAfter, userFixable }
   *          shape (ExtensionTransport throws DSCError; ManualClipboardTransport
   *          throws plain Error with code: 'manual_aborted' on Ctrl+C).
   */
  async chat({ chatName, prompt }) {}

  /**
   * Clean up. Called once, in a finally block, whether the batch succeeded
   * or failed.
   * Extension: stops the HTTP server.
   * Manual: no-op.
   */
  async shutdown() {}
}

module.exports = { Transport };
```

The shape isn't arbitrary — it maps 1:1 to what `/open` and `/chat` already provide on the HTTP side, so `ExtensionTransport` is ~50 lines of adapter. `ManualClipboardTransport` is a similar wrapper around the existing clipboard loop, also ~50 lines.

## ExtensionTransport implementation

```js
// scripts/batch/lib/transport-extension.js
'use strict';

const { createServer } = require('deepseek-connect');
const { createClient } = require('deepseek-connect/client');
const { Transport } = require('./transport');

class ExtensionTransport extends Transport {
  constructor(opts) {
    super();
    opts = opts || {};
    this.token = opts.token || process.env.EXTENSION_TOKEN;
    if (!this.token) throw new Error('ExtensionTransport: EXTENSION_TOKEN required');
    this.server = createServer({ token: this.token, port: opts.port ?? 0 });
    this.client = null;
    this.started = false;
  }

  async start() {
    const port = await this.server.start();
    this.client = createClient({ token: this.token, port });
    this.started = true;

    // Readiness probe — fails fast if the extension isn't connected.
    // See the "smoke test before a full batch" section for why this is
    // not optional.
    await this.client.tabs();
  }

  async open(chatName) {
    await this.client.open({ chatName });
  }

  async chat({ chatName, prompt }) {
    const result = await this.client.chat({
      messages: [{ role: 'user', content: prompt }],
      chat: chatName,
      timeoutMs: 180000,  // matches client default; explicit for readability
    });
    return {
      content: result.content,
      elapsedMs: result.elapsedMs,
      chat: result.chat,
    };
  }

  async shutdown() {
    if (this.started) await this.server.stop();
  }
}

module.exports = { ExtensionTransport };
```

Notes on the implementation:

- **`port: 0`.** The server binds an OS-assigned port so two wizards running on the same machine don't collide. The client connects to `server.port()` after `start()`. If you need a specific port (because the extension's popup is configured for it), pass `opts.port` and let it be whatever the popup says.
- **`start()` is separate from the constructor.** The constructor is cheap (no I/O). `start()` binds the socket and does the readiness probe. This means a `try { transport.start() } finally { transport.shutdown() }` pattern can be used cleanly.
- **`await this.client.tabs()` in `start()`.** This is the readiness probe. It will throw `extension_disconnected` if the extension isn't connected within the client's timeout. Better to fail here, with a clear error, than three sources into the batch.
- **`open()` doesn't throw on fresh.** If the chat doesn't exist yet, `/open` navigates to `/` and returns `existing: false`. The `chat()` call that follows sends into that fresh chat, DeepSeek auto-names it from the first message, and the next `/open` for the same `chatName` will find it via sidebar fuzzy match.
- **Errors propagate as-is.** `dc.chat()` throws `DSCError` with `{ code, retryable, retryAfter, userFixable, details, trace }`. The batch loop's error handler switches on these fields; the transport doesn't wrap or re-interpret them.

## Lifecycle

The clean pattern for a batch run:

```js
const transport = createTransport(opts);

try {
  await transport.start();  // ExtensionTransport only; Manual is no-op
  const results = await runBatch(transport, sources);
  printReport(results);
  process.exit(results.needsReview.length === 0 ? 0 : 1);
} catch (err) {
  // Startup failure — extension disconnected, server port taken, token
  // missing. This is fatal; don't try to run sources anyway.
  console.error('batch failed to start:', err.message);
  process.exit(2);
} finally {
  await transport.shutdown();
}
```

Three rules:

1. **`shutdown()` in `finally`.** Whether the batch succeeded, failed partway, or crashed, the server needs to stop. Otherwise the next run inherits a stale `inFlight` entry and every `/chat` hangs. See [protocol.md#queue-state-machine](protocol.md#queue-state-machine) — the "extension dies mid-flight" hole is real and server-restart is the only recovery.
2. **`start()` failures are fatal, per-source failures aren't.** If `start()` throws — extension not connected, port collision, token mismatch — the batch can't run at all. Exit with a distinct code. If a source fails mid-batch, that's a `needs-review` entry, not an abort. The batch loop handles the latter; `start()`'s `catch` handles the former.
3. **Signal handlers.** If the user hits Ctrl+C mid-batch, the `finally` should still fire. Either `try/finally` around the batch loop, or register `process.on('SIGINT', async () => { await transport.shutdown(); process.exit(130); })`. Both work; the `finally` is simpler because it covers normal exits too.

## The batch loop

The batch loop is transport-agnostic. This is the canonical version — adapt field names and paths to match the existing `paste.js` but keep the structure.

```js
async function runBatch(transport, sources) {
  const results = { ok: [], needsReview: [] };

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const label = `[${i + 1}/${sources.length}] ${source.name}`;

    try {
      // Step 1 — establish the chat. Per-source, once, before the prompt.
      // On the retry path, this finds the chat from the prior attempt and
      // the LLM sees its own prior turns. On the first path, this navigates
      // to / for a fresh chat.
      await transport.open(source.name);

      // Step 2 — send the prompt. May throw with a DSCError.
      const prompt = buildPrompt(source);  // existing function; embeds START_/END_ markers
      const result = await sendWithRetry(transport, source.name, prompt);

      // Step 3 — validate and extract. Same as manual mode.
      const extracted = extractFromContent(result.content, source.name);
      if (!extracted) {
        results.needsReview.push({
          source: source.name,
          code: 'no_code_block',
          reason: 'LLM replied but no code block found in reply',
          raw: result.content,
        });
        printLine(label, 'needs-review', 'no code block');
        continue;
      }

      // Step 4 — identity check. A wrong-clipboard-copy check from manual
      // mode, preserved. In extension mode this rarely fires because the
      // prompt was sent through the right chat, but the LLM can still
      // hallucinate a filename.
      if (!referencesSource(extracted, source)) {
        results.needsReview.push({
          source: source.name,
          code: 'identity_mismatch',
          reason: 'code does not reference ' + source.name,
          raw: result.content,
        });
        printLine(label, 'needs-review', 'identity mismatch');
        continue;
      }

      // Step 5 — write the file. Existing behavior.
      const outPath = path.join(runDir, 'generated', source.name + '.js');
      fs.writeFileSync(outPath, extracted);
      results.ok.push({ source: source.name, elapsedMs: result.elapsedMs });
      printLine(label, 'ok', result.elapsedMs + 'ms');

    } catch (err) {
      const handled = await handleError(err, label, source);
      if (handled.action === 'retry-source') {
        // handleError decided this is worth a fresh attempt from Step 1.
        // Decrement i and let the loop re-run this source.
        i--;
        continue;
      }
      results.needsReview.push({
        source: source.name,
        code: handled.code,
        reason: handled.reason,
        details: handled.details,
      });
      printLine(label, 'needs-review', handled.code);
    }
  }

  return results;
}
```

### sendWithRetry

The retry policy is its own function because it's shared between the `chat()` call and the initial `open()` call — both can throw retryable errors, and both should follow the same per-attempt cap.

```js
async function sendWithRetry(transport, chatName, prompt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await transport.chat({ chatName, prompt });
    } catch (err) {
      // Caller bugs and unrecoverable extension states should not retry.
      if (!isRetryable(err)) throw err;

      // rate_limited is special-cased — one delayed retry, not three
      // immediate ones. See error-codes.md#bucket-b.
      if (err.code === 'rate_limited') {
        if (attempt >= 2) throw err;
        await sleep(err.retryAfter || 30000);
        continue;
      }

      // Bucket A and C: retry up to 3 with err.retryAfter between
      // attempts. Bucket A's retryAfter is 0, so this is immediate.
      if (attempt < 3) {
        await sleep(err.retryAfter || 0);
        continue;
      }

      throw err;
    }
  }
}

function isRetryable(err) {
  // Trust DSCError's metadata, don't switch on code. New codes added in
  // errors.js get the right retry policy for free.
  if (typeof err.retryable === 'boolean') return err.retryable;
  // Manual transport: user pressed Ctrl+C, abort.
  if (err.code === 'manual_aborted') return false;
  // Anything else: retry.
  return true;
}
```

## Error policy

The per-code decision comes directly from [error-codes.md](error-codes.md). The `handleError` function in the batch loop maps each bucket to a wizard action:

```js
async function handleError(err, label, source) {
  const code = err.code || 'unknown';
  const reason = err.reason || err.message || 'unknown error';

  // Bucket E — skip silently. No beep, no retry beyond what already happened.
  // dom_drift, chat_not_found, bad_request, unknown_request, cancelled,
  // user_skipped.
  if (!err.retryable && !err.userFixable) {
    return { action: 'needs-review', code, reason, details: err.details };
  }

  // Bucket D — beep immediately. auth_failed, input_not_found, logged_out,
  // deepthink_enable_failed, search_enable_failed, user_navigated,
  // protocol_version_mismatch.
  if (!err.retryable && err.userFixable) {
    await beep3x(reason);
    return { action: 'needs-review', code, reason, details: err.details };
  }

  // Bucket C — retry then beep. extension_disconnected, response_timeout.
  // The retries already happened in sendWithRetry; this is the "retries
  // exhausted" path. Beep, then skip.
  if (err.retryable && err.userFixable) {
    await beep3x(reason);
    return { action: 'needs-review', code, reason, details: err.details };
  }

  // Bucket A / B — retryable, not user-fixable. Retries exhausted.
  // Just skip. The user can see the code in the report.
  return { action: 'needs-review', code, reason, details: err.details };
}
```

The beep function is the wizard's own — 3 beeps at 20-second intervals, presumably printing the `reason` between them. This is the same beep behavior the aggregator already has for manual mode timeouts; the extension integration doesn't change it.

Two places the wizard **must not** deviate from [error-codes.md](error-codes.md):

1. **`rate_limited` retries once, not three times.** A third prompt inside DeepSeek's rate window makes the next window longer. This is documented as bucket B and the policy exists for a reason — ignoring it turns a 30-second delay into a 5-minute lockout.
2. **`user_skipped` skips silently.** It has `userFixable: true` in metadata but the wizard should not beep at a user who just clicked "Skip". The `handleError` above handles it correctly because it checks `!err.retryable && !err.userFixable` first — and `user_skipped` is `retryable: false, userFixable: true`, so it falls into bucket D... which is wrong. `user_skipped` needs an explicit early-return before the bucket-D check:

```js
// Explicit early-return for codes whose metadata says "beep" but whose
// correct behavior is "skip silently". user_skipped is the only current
// example — the user chose to skip, beeping would be user-hostile.
if (code === 'user_skipped') {
  return { action: 'needs-review', code, reason: 'skipped by user' };
}
```

Put this before the bucket-E check in `handleError`. It's a one-line special-case that [error-codes.md](error-codes.md#bucket-e--skip-without-beep-6-codes) documents.

## Flag parsing and defaults

The integration preserves the existing `--manual` mode and adds `--extension` as the default when `EXTENSION_TOKEN` is set. Three cases:

```js
function createTransport(opts) {
  // Explicit --manual overrides everything, including a set token.
  if (opts.manual) {
    return new ManualClipboardTransport(opts);
  }

  // Explicit --extension throws if there's no token. The user asked for
  // extension mode; falling back silently to manual would surprise them.
  if (opts.extension) {
    if (!process.env.EXTENSION_TOKEN) {
      throw new Error('--extension requires EXTENSION_TOKEN in .env');
    }
    return new ExtensionTransport(opts);
  }

  // No flag: extension if token is present, manual otherwise.
  if (process.env.EXTENSION_TOKEN) {
    return new ExtensionTransport(opts);
  }
  return new ManualClipboardTransport(opts);
}
```

Three behaviors this produces:

- `batch paste` with `EXTENSION_TOKEN` set → `ExtensionTransport` (the new default)
- `batch paste --manual` → `ManualClipboardTransport`, regardless of token
- `batch paste` without `EXTENSION_TOKEN` set → `ManualClipboardTransport` (graceful degradation for a user who hasn't set up the extension yet)
- `batch paste --extension` without `EXTENSION_TOKEN` → hard error, no silent fallback

The fourth case is the one that matters — a user who typed `--extension` wants extension mode and should be told explicitly when it's not available, not silently given the clipboard loop they were trying to avoid.

`ManualClipboardTransport` is a thin wrapper around the existing clipboard loop. It implements the same three methods but the bodies are what `paste.js` does today:

```js
class ManualClipboardTransport extends Transport {
  async open(chatName) {
    // No-op. The clipboard loop doesn't track chats.
  }

  async chat({ chatName, prompt }) {
    // Exactly what paste.js does today:
    // 1. Copy prompt to clipboard
    // 2. Open DeepSeek to /  (or the user does it manually)
    // 3. Poll clipboard for reply
    // 4. Parse verdict, identity check
    // 5. Extract code, return { content, elapsedMs, chat: null }
    // ...
  }

  async shutdown() {
    // No-op.
  }
}
```

The batch loop calls `await transport.open(source.name)` and `await transport.chat({ chatName, prompt })` for both. In manual mode, `open` is a no-op and `chat` runs the clipboard loop. In extension mode, `open` establishes the chat and `chat` does the HTTP round-trip. **The batch loop doesn't change.**

## Concurrency

One batch at a time. Not a limitation of the wizard — a limitation of the extension.

The extension pins exactly one work tab in `chrome.storage.local.workTabId` and registers with exactly one server token. Two `batch paste` runs starting at the same time would each start their own server, each get a random port, and the extension would only be connected to whichever server won the `/hello` race. The other server's `/next` polls would return `idle` forever, and its queue would fill up with requests that never dispatch.

This is documented as a constraint in [protocol.md#constraints](protocol.md#constraints). Two mitigations the wizard can apply:

1. **Advisory lock on batch start.** Write `data/batch/.lock` with `{ pid, startedAt, runId }` on `start()`. If the file exists and the pid is alive, refuse to start. Delete the file in `shutdown()`. This catches the common case — a user starting two `batch paste` runs in two terminals.

2. **Wait for extension idle before starting.** Call `GET /tabs` (or the future `GET /status` when it ships) and confirm the extension is connected and has an idle worker. If `queued > 0` or `inFlight > 0` on the server we just started, that's a leftover from a crashed previous run — see [operations.md#reload-discipline](operations.md#reload-discipline) for the recovery procedure.

The lock is one file, ~20 lines of code. Worth it because the failure mode (two batches, one silently does nothing) is hard to debug from the outside.

## Smoke test before a full batch

Before running a 76-source batch, prove the integration works on one source. This catches the three integration bugs that bite most often:

1. **`open()` and `chat()` reversed.** The source's first prompt lands in a chat that already has content from a different source, and the LLM's reply is confused. Symptom: source 1 works, source 2's reply references source 1's data.
2. **Token mismatch.** `auth_failed` on every request. Symptom: `start()` throws `DSCError('auth_failed')` immediately.
3. **Wrong chat name.** `open()` finds the wrong chat via fuzzy match because the source name is too generic (`jobs`, `careers`). Symptom: sources 3 and 4 both land in source 2's chat because they all matched the same sidebar entry.

Smoke test:

```bash
# Terminal A — start the server in standalone mode, watch the log
cd ~/deepseek-connect && node --env-file=.env src/server.js

# Terminal B — run one source through the integration
cd ~/pulchowk-events-bot
node -e '
const { ExtensionTransport } = require("./scripts/batch/lib/transport-extension");
(async () => {
  const t = new ExtensionTransport();
  await t.start();
  try {
    await t.open("smoke-test-source");
    const r = await t.chat({
      chatName: "smoke-test-source",
      prompt: "Reply with exactly:\nsmoke-test-source START_a.js\nconsole.log(42);\nsmoke-test-source END_a.js",
    });
    console.log("OK:", r);
  } finally {
    await t.shutdown();
  }
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
'
```

Expected in Terminal A:

```
[HH:MM:SS] extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)
[HH:MM:SS] <- enqueued <id> | Reply with exactly: smoke-test-source START_a.js...
[HH:MM:SS] -> dispatched <id> | Reply with exactly: smoke-test-source START_a.js...
[HH:MM:SS]   ~ <id8> probe {"healthy":[...],...}
[HH:MM:SS]   ~ <id8> answerStarted
[HH:MM:SS]   ~ <id8> answer {"len":55}
[HH:MM:SS]   ~ <id8> replyDone {"completedBy":"stable",...}
[HH:MM:SS] ok done <id> | <N>ms
```

Expected in Terminal B:

```
OK: { content: 'console.log(42);', elapsedMs: 4300, chat: 'smoke-test-source' }
```

If the content is `console.log(42);` — the delimiter extraction worked, the chat lifecycle worked, the token matched. Integration is wired correctly. Run the batch.

If the content is something else — the LLM replied but extraction returned raw text — check the `extract` trace line in Terminal A: `source: 'delimiter'` means extraction worked, `source: 'raw'` means the LLM didn't emit the delimiters. That's a prompt bug, not an integration bug.

## Acceptance checklist

Before submitting the integration PR, verify each of these against the acceptance criteria that the aggregator's PR review will check. This list is derived from the constraints in [protocol.md](protocol.md), [error-codes.md](error-codes.md), and the current `paste.js` behavior that must be preserved.

**Lifecycle:**

- [ ] `createServer` + `start()` called once at batch start, `stop()` called once in `finally`
- [ ] `createClient` connects to `server.port()` (works with `port: 0`)
- [ ] `start()` failure exits with distinct code, does not try to run sources
- [ ] Ctrl+C mid-batch triggers `shutdown()` via `finally` or `SIGINT` handler

**Batch loop:**

- [ ] `transport.open(chatName)` called once per source, before `transport.chat()`
- [ ] `transport.chat()` called with `chat: chatName` (not a random name)
- [ ] Per-source failures caught and pushed to `needs-review`, do not abort the batch
- [ ] `extractFromContent` (or equivalent) produces the same code as `extractCodeFromClipboard` in manual mode
- [ ] Identity check preserved — code must reference the source name
- [ ] File written to `data/batch/<run>/generated/<name>.js` (same path as manual mode)

**Error policy:**

- [ ] `isRetryable()` reads `err.retryable` from metadata, does not switch on `err.code`
- [ ] `rate_limited` retries once after `err.retryAfter` (30s), not three times
- [ ] `user_skipped` skips silently (early-return before bucket-D beep)
- [ ] Bucket A retryable errors retry up to 3 attempts before `needs-review`
- [ ] Bucket D errors beep immediately, no auto-retry
- [ ] `DSCError` instances are recognized by `instanceof DSCError` (not by duck-typing `err.code`)

**Flags:**

- [ ] `--manual` forces `ManualClipboardTransport` even when `EXTENSION_TOKEN` is set
- [ ] `--extension` throws if `EXTENSION_TOKEN` is missing (no silent fallback)
- [ ] No flag + token present → `ExtensionTransport` (new default)
- [ ] No flag + token absent → `ManualClipboardTransport` (graceful degradation)

**Preservation of manual mode:**

- [ ] `ManualClipboardTransport` has identical behavior to the current `paste.js` clipboard loop
- [ ] Identity check fires in manual mode exactly as before
- [ ] Wrong-clipboard-copy rejection works in manual mode exactly as before

**Concurrency:**

- [ ] Advisory lock on `data/batch/.lock` or equivalent, refuses second concurrent batch
- [ ] Lock released on `shutdown()` and on `SIGINT`

**Smoke test:**

- [ ] One-source smoke test (section [Smoke test before a full batch](#smoke-test-before-a-full-batch)) returns `console.log(42);` before the first full batch is attempted
- [ ] The smoke test's server log shows `source: 'delimiter'` in the `extract` trace (not `raw`)

Every item on this list is enforced by one of the three reference docs. If a review comment asks "why does this check exist", the answer is a link back to the source-of-truth. The checklist itself is not new policy — it's a mechanical restatement of what [protocol.md](protocol.md) and [error-codes.md](error-codes.md) already specify.