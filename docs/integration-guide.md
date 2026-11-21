# Integration guide

How to integrate `deepseek-connect` into a batch wizard. The aggregator repository is separate and is not included here; this is a reference design, not a description of its current scripts. Before applying any example, inspect the current batch command, transport code, and persistence format in that repository. Do not copy the pseudocode as if it were an existing implementation. For the wire contract, read [protocol.md](protocol.md); for failures, read [error-codes.md](error-codes.md).

The examples cover provider threading and optional provider pivot policy. `/chat`, `/open`, and `/reset` require an explicit provider. Built-in names are `deepseek`, `qwen`, and `chatgpt`; selector-based config providers must be configured and enabled in the extension before use. `tongyi` is not currently routable.

**Contents**
- [What you're building](#what-youre-building)
- [Prerequisites](#prerequisites)
- [The transport abstraction](#the-transport-abstraction)
- [ExtensionTransport implementation](#extensiontransport-implementation)
- [Lifecycle](#lifecycle)
- [The batch loop](#the-batch-loop)
- [Safe retry and recovery](#safe-retry-and-recovery)
- [Error policy](#error-policy)
- [Provider pivot](#provider-pivot)
- [chat-map.json — the persistence layer](#chat-mapjson--the-persistence-layer)
- [Flag parsing and defaults](#flag-parsing-and-defaults)
- [Concurrency](#concurrency)
- [Smoke test before a full batch](#smoke-test-before-a-full-batch)
- [Acceptance checklist](#acceptance-checklist)

---

## What you're building

If the target batch command uses a manual clipboard flow, its per-source work commonly looks like this:

1. Copies an LLM prompt to the clipboard
2. Opens the LLM in a browser for the user
3. Waits for the user to paste the prompt, wait for the reply, and copy the reply back
4. Validates the reply (JS syntax, identity check)
5. Extracts the code block
6. Writes the extractor to `data/batch/<run>/generated/<name>.js`
7. Advances to the next source

The amount of manual work and its failure modes depend on the target repository and batch size; verify those against its current implementation rather than assuming a fixed source count or runtime.

An extension transport can replace the manual input/reply exchange with an HTTP round-trip. Preserve the target wizard's existing validation, identity check, extraction, file writing, and review flow. The extension's response includes `{ content, url, elapsedMs }`; actual latency depends on provider and response.

**The design goal is that the batch loop doesn't know which transport it's using.** Same loop, same per-source logic, same error handling — a transport-agnostic interface that happens to have two implementations. That's what lets `--manual` survive as a fallback with zero duplicated orchestration.

**Multi-provider adds one more dimension.** The batch loop also doesn't know *which provider* is answering — it passes a `provider` string to the transport, the transport forwards it to the server, and the server routes it to the right provider tab. A source can be routed to DeepSeek, then pivoted to Qwen on failure, without the batch loop caring.

## Prerequisites

Before you write a line of integration code, confirm these are true on the machine:

1. **`deepseek-connect` is installed.** Either as a sibling repo via `npm link`, a git dependency in `package.json`, or a relative `require('../../../deepseek-connect/src/server')`. `require('deepseek-connect')` must resolve. If it doesn't, the rest of this doc is moot.

2. **The extension is loaded and connected.** Open `brave://extensions`, load unpacked, set the token in the popup. Open exactly one tab for each provider the batch will use. Zero or multiple matching tabs for a requested provider fail with `ambiguous_provider_tab`.

3. **`EXTENSION_TOKEN` is set.** Same value in `.env` and the popup.

4. **You have inspected the current batch command.** The aggregator is a separate repository; locate its present entry point and tests instead of assuming it still uses `scripts/batch/paste.js`.

5. **Each selected provider tab is logged in.** A logged-out tab produces `logged_out` on requests routed to it.

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
   * Extension: opens the named chat by URL (if supplied) or by the provider's
   *            normal ensure-chat behavior.
   * Manual: no-op — the clipboard loop doesn't track chats.
   */
  async open({ chatName, provider, url }) {}

  /**
   * Send the prompt, wait for the reply, extract the code block, return it.
   * Extension: POST /chat with required provider and optional saved URL,
   *            wait for JSON, return { content, url, elapsedMs }.
   * Manual: copy to clipboard, poll for user paste, read reply, extract
   *         via existing extractCodeFromClipboard.
   *
   * Returns: { content: string, url: string|null, elapsedMs: number,
   *            chat: string, provider: string }
   * Throws:  DSCError with { code, retryable, retryAfter, userFixable,
   *          details, trace } on failure.
   */
  async chat({ chatName, provider, prompt, url, requestId, timeoutMs, signal }) {}

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

The shape isn't arbitrary — it maps 1:1 to what `/open` and `/chat` provide on the HTTP side, with `provider` threaded through both. `ExtensionTransport` is ~80 lines of adapter. `ManualClipboardTransport` is a similar wrapper around the existing clipboard loop.

## ExtensionTransport implementation

```js
// scripts/batch/lib/transport-extension.js
'use strict';

const { createServer } = require('deepseek-connect');
const { createClient } = require('deepseek-connect/client');
const { Transport } = require('./transport');

class ExtensionTransport extends Transport {
  constructor(opts = {}) {
    super();
    this.token = opts.token || process.env.EXTENSION_TOKEN;
    if (!this.token) throw new Error('ExtensionTransport: EXTENSION_TOKEN required');
    const defaultPort = Number(process.env.EXTENSION_PORT || 7331);
    this.port = opts.port != null ? opts.port : defaultPort;
    this.server = createServer({ token: this.token, port: this.port, log: () => {} });
    this.client = null;
    this.started = false;
    this.ownsServer = false;
    this.boundPort = this.port;
  }

  async start() {
    try {
      this.boundPort = await this.server.start();
      this.ownsServer = true;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        // Another deepseek-connect is already running on this port —
        // attach to it, don't fight for the socket.
        this.ownsServer = false;
      } else {
        throw err;
      }
    }
    this.client = createClient({ token: this.token, port: this.boundPort });
    this.started = true;
    // /tabs returns the last /hello snapshot. It does not prove that the
    // extension is connected or that a requested provider has one tab.
    await this.client.tabs();
  }

  async open({ chatName, provider, url } = {}) {
    return this.client.open({ chatName, url, provider });
  }

  async chat({ chatName, provider, prompt, url, timeoutMs }) {
    const result = await this.client.chat({
      messages: [{ role: 'user', content: prompt }],
      chat: chatName,
      provider,
      url,
      requestId,
      timeoutMs,
      signal,
    });
    return {
      content: result.content,
      url: result.url,
      elapsedMs: result.elapsedMs,
      chat: result.chat,
      provider,
    };
  }

  async shutdown() {
    if (!this.started) return;
    this.started = false;
    if (this.ownsServer) await this.server.stop();
  }
}

module.exports = { ExtensionTransport };
```

Notes:

- **`port: EXTENSION_PORT from env`.** Not `port: 0`. The extension's popup is configured for a specific port; a wizard on port 0 would bind fine but the extension would never poll it. `EXTENSION_PORT` in `.env` is the source of truth.
- **Attach-or-own.** If the port is taken (another wizard, another deepseek-connect instance), `EADDRINUSE` is caught and the transport attaches to the existing server. The `ownsServer` flag tracks whether `shutdown()` should stop the server. This lets two wizards coexist — they share one server, both talk to the same extension, and the queue serializes their requests.
- **`start()` is separate from the constructor.** Constructor is cheap (no I/O). `start()` binds the socket and does the readiness probe.
- **Preflight with `/status` and `/tabs`.** They help diagnose server registration and cached tabs, but neither proves provider login/UI readiness. The request itself performs strict provider-tab matching and fails explicitly if zero or multiple matches exist.
- **Provider availability is not inferred from a successful `start()`.** The extension may not have registered yet, and config providers must be enabled in the extension. Fail preflight clearly rather than treating `/tabs` as a readiness guarantee.
- **Saved URL on safe new attempts.** Pass the saved URL when a caller has determined another provider turn is appropriate. After an uncertain timeout, do not send a new request; inspect the tab and retain the original request ID for late-result recovery.
- **Errors propagate as-is.** `dc.chat()` throws `DSCError` with `{ code, retryable, retryAfter, userFixable, details, trace }`. The batch loop's error handler switches on these fields; the transport doesn't wrap or re-interpret them.

## Lifecycle

The clean pattern for a batch run:

```js
const transport = createTransport(opts);

try {
  await transport.start();
  const results = await runBatch(transport, sources);
  printReport(results);
  process.exitCode = results.needsReview.length === 0 ? 0 : 1;
} catch (err) {
  // Fatal startup/configuration failure. Do not start the batch.
  console.error('batch failed to start:', err.message);
  process.exitCode = 2;
} finally {
  await transport.shutdown();
}
```

Three rules:

1. **`shutdown()` in `finally`.** Stop the server only if this process started it. Stopping clears in-memory request identity and does not cancel provider work; inspect uncertain requests before restarting. If attached to an existing server, leave it running.

2. **`start()` failures are fatal, per-source failures aren't.** If `start()` throws, the batch can't run at all. Exit with a distinct code. Per-source failures become `needs-review` entries.

3. **Signal handlers.** Keep cleanup in `finally`; avoid calling `process.exit()` before async cleanup completes. If installing a `SIGINT` handler, stop accepting more work, let the loop unwind, run `shutdown()`, then set `process.exitCode = 130`.

## The batch loop

The batch loop is transport-agnostic and provider-aware. It passes `provider` through, but doesn't interpret it.

```js
async function runBatch(transport, sources, chatMap) {
  const results = { ok: [], needsReview: [] };

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const label = `[${i + 1}/${sources.length}] ${source.name}`;

    try {
      // Step 1 — determine the provider for this source.
      // Priority: explicit per-source field > CLI --provider > batch default
      const provider = source.provider || globalOpts.provider || 'deepseek';
      source.provider = provider;

      // Step 2 — use the saved URL, if any. /chat accepts url and navigates
      // directly before sending, so a retry uses the same conversation.
      const mapEntry = chatMap.get(source.name, provider);

      // Step 3 — retry only definitely undispatched attempts
      const prompt = buildPrompt(source);
      const result = await sendWithSafeRetry(transport, {
        chatName: source.name,
        provider,
        prompt,
        url: mapEntry && mapEntry.url,
      });

      // Step 4 — persist the URL for retry
      if (result.url) {
        chatMap.set(source.name, provider, { url: result.url, at: Date.now() });
      }

      // Step 5 — validate and extract. Never execute generated code.
      const extracted = extractFromContent(result.content, source.name);
      if (!extracted) {
        results.needsReview.push({
          source: source.name,
          provider,
          code: 'no_code_block',
          reason: 'LLM replied but no code block found in reply',
          raw: result.content,
        });
        printLine(label, 'needs-review', 'no code block');
        continue;
      }

      // Step 6 — identity check (unchanged from manual mode)
      if (!referencesSource(extracted, source)) {
        results.needsReview.push({
          source: source.name,
          provider,
          code: 'identity_mismatch',
          reason: 'code does not reference ' + source.name,
          raw: result.content,
        });
        printLine(label, 'needs-review', 'identity mismatch');
        continue;
      }

      // Also run syntax-only validation and the caller's acceptance/verdict
      // checks here. All must pass before any generated file is saved.
      if (!validateJavaScriptSyntax(extracted) || !checkAcceptanceVerdict(result.content, source)) {
        results.needsReview.push({
          source: source.name,
          provider,
          code: 'validation_failed',
          requestId: result.requestId,
        });
        continue;
      }

      // Step 7 — write the file only after validation succeeds
      const outPath = path.join(runDir, 'generated', source.name + '.js');
      fs.writeFileSync(outPath, extracted);
      results.ok.push({ source: source.name, provider, elapsedMs: result.elapsedMs });
      printLine(label, 'ok', result.elapsedMs + 'ms');

    } catch (err) {
      const handled = await handleError(err, label, source, results);
      if (handled.action === 'retry-source') {
        i--;  // re-run this source with the new provider
        continue;
      }
      results.needsReview.push({
        source: source.name,
        provider: source.provider,
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

### The chat map

The `chatMap` object is a small persistence layer. Its job: remember the URL for each `(sourceName, provider)` pair, so retries can navigate directly.

```js
// scripts/batch/lib/chat-map.js
const fs = require('fs');
const path = require('path');

class ChatMap {
  constructor(runDir) {
    this.path = path.join(runDir, 'chat-map.json');
    this.data = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('chat-map.json must contain an object');
      }
      this.data = parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  }

  get(sourceName, provider) {
    const key = `${sourceName}::${provider}`;
    return this.data[key] || null;
  }

  set(sourceName, provider, value) {
    const key = `${sourceName}::${provider}`;
    this.data[key] = value;
    this.save();
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { ChatMap };
```

Key design choices:

- **`(sourceName, provider)` is the key.** Not just `sourceName`. Because a source can be routed to DeepSeek on first attempt and Qwen on retry (via the pivot pattern below). Each provider gets its own chat, so each needs its own URL.
- **Stored in `data/batch/<run>/chat-map.json`.** Same lifecycle as the run directory. A fresh run starts with an empty map; retries within a run reuse the URLs.
- **Written after every successful `/chat`.** If the process crashes mid-batch, the map has the URLs for all completed sources — a restarted batch can pick up where it left off.

## Safe retry and recovery

Retry only when the server proves the request was not dispatched. Each confirmed-safe attempt gets a new ID because the old ID is deduplicated to its original failure. If dispatch may have occurred, stop and surface the request ID for inspection; do not generate a new ID and replay.

```js
async function sendWithSafeRetry(transport, params) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const requestId = crypto.randomUUID();
    try {
      return await transport.chat({ ...params, requestId });
    } catch (err) {
      if (err.executionState !== 'not_dispatched' ||
          err.retryable !== true ||
          attempt === maxAttempts) throw err;
      if (err.retryAfter > 0) await sleep(err.retryAfter);
    }
  }
  throw new Error('unreachable');
}
```

If the caller's own timeout or abort occurs after dispatch, `executionState` is `outcome_unknown`. Report the request ID, inspect the provider tab, and wait for a late reply; after a late reply, repeating the identical request with the same ID retrieves the cached result without dispatching a second prompt. This cache is bounded and lost on server restart. After a restart, inspect the provider tab before any retry.

## Error policy

The per-code decision comes directly from [error-codes.md](error-codes.md). The `handleError` function in the batch loop maps each bucket to a wizard action:

```js
async function handleError(err, label, source, transport, chatMap, results) {
  const code = err.code || 'unknown';
  const reason = err.reason || err.message || 'unknown error';
  const currentProvider = source.provider;
  const failure = {
    code, reason, requestId: err.requestId, executionState: err.executionState,
    retryable: err.retryable, retryAfter: err.retryAfter,
    userFixable: err.userFixable, details: err.details, trace: err.trace,
  };

  // ── Early returns for codes that need special handling ─────────────

  // user_skipped is registered but no current route emits it.
  if (code === 'user_skipped') {
    return Object.assign({ action: 'needs-review' }, failure, { reason: 'skipped by user' });
  }

  // ── Provider pivot on rate limit ───────────────────────────────────
  // If the wizard has multi-provider support and hasn't already tried
  // the fallback, pivot instead of skipping.

  if (code === 'rate_limited' && err.retryable === true &&
      err.executionState === 'not_dispatched' && canPivot(currentProvider, source)) {
    const fallback = pivotProviderFor(currentProvider);
    // Mark the source to be retried on the fallback provider
    source.provider = fallback;
    source._pivotedFrom = currentProvider;
    return Object.assign({ action: 'retry-source', reason: `pivoting to ${fallback}` }, failure);
  }

  // Keep the failure visible for operator review.

  if (!err.retryable && !err.userFixable) {
    return Object.assign({ action: 'needs-review' }, failure);
  }

  // ── Bucket D — beep immediately ────────────────────────────────────

  if (!err.retryable && err.userFixable) {
    await beep3x(reason, currentProvider);
    return Object.assign({ action: 'needs-review' }, failure);
  }

  // ── Bucket C — retry then beep ─────────────────────────────────────
  // (safe retries already exhausted in sendWithSafeRetry)

  if (err.retryable && err.userFixable) {
    await beep3x(reason, currentProvider);
    return Object.assign({ action: 'needs-review' }, failure);
  }

  // The caller's bounded retry helper has already exhausted safe retries.

  return Object.assign({ action: 'needs-review' }, failure);
}
```

The `handleError` function receives the source's explicitly selected provider. It preserves the failure metadata for review; a pivot is allowed only after a known `not_dispatched` result.

Two places the wizard **must not** deviate from [error-codes.md](error-codes.md):

1. Retry only when both `retryable === true` and `executionState === "not_dispatched"`.
2. Keep unknown/outcome-uncertain requests visible for human review.

## Provider pivot

Provider pivot is optional caller policy, not built-in failover. Only pivot after the original request is confirmed `not_dispatched`; never pivot an `outcome_unknown` request because the first provider may already have received the prompt.

```js
function canPivot(currentProvider, source) {
  // Only pivot once per source — if we're already on the fallback,
  // don't pivot again.
  if (source._pivotedFrom) return false;

  // Only pivot on rate limits (other failures aren't provider-specific)
  // and only if a fallback is configured.
  return !!pivotProviderFor(currentProvider);
}

function pivotProviderFor(currentProvider) {
  if (currentProvider === 'deepseek') return 'qwen';
  if (currentProvider === 'qwen') return 'deepseek';
  return null;
}
```

Before returning to the loop, record the old provider in `_pivotedFrom`, set the explicitly selected fallback provider, and create a fresh request ID for the new request. Keep separate chat URLs by `(sourceName, provider)`.

**The chat map handles the URL separation.** When the source retries on Qwen, `chatMap.get(source.name, 'qwen')` returns `null` (first Qwen attempt for this source), so the `/chat` call omits `url` and Qwen starts a fresh chat. The prompt is resent to Qwen, and Qwen's LLM answers without seeing DeepSeek's prior attempt. That's correct — the pivot is a fresh start on a different provider, not a continuation.

**Mark the source so it doesn't pivot twice:**

```js
// In handleError, before returning { action: 'retry-source' }:
source._pivotedFrom = currentProvider;
source.provider = fallback;
```

The `_pivotedFrom` field is a flag — if it's set, `canPivot` returns false and the source won't try the other provider.

**The pivot decision is a policy, not a protocol.** `deepseek-connect` does not choose a fallback provider. The caller changes the provider only when its recovery policy proves that doing so will not duplicate an already-dispatched prompt.

## chat-map.json — the persistence layer

The full schema:

```json
{
  "src-alpha::deepseek": {
    "url": "https://chat.deepseek.com/a/chat/s/ae834e91-...",
    "at": 1700000000000
  },
  "src-alpha::qwen": {
    "url": "https://chat.qwen.ai/c/d3545c8f-...",
    "at": 1700000015000
  },
  "src-beta::deepseek": {
    "url": "https://chat.deepseek.com/a/chat/s/bb12aa34-...",
    "at": 1700000030000
  }
}
```

Key: `<sourceName>::<provider>`. Value: `{ url, at }` where `at` is a Unix timestamp for debugging.

**Why key on both:** the same source can have one DeepSeek chat and one Qwen chat (via the pivot pattern). The wizard needs to know both URLs to correctly reuse the right chat on retry.

**When to prune:** the map grows by one entry per source per provider. For a 76-source batch across two providers, that's up to 152 entries — trivial. For a wizard that runs many batches over months, the map accumulates. Prune on a time window (entries older than 30 days) or on a count limit (keep last 500 entries).

**When to clear:** decide based on the batch's retry/resume semantics. Reusing the map resumes the saved conversations; clearing it starts fresh chats. Do not assume a rerun should always discard or always reuse prior URLs.

## Flag parsing and defaults

The integration preserves the existing `--manual` mode and adds `--extension` as the default when `EXTENSION_TOKEN` is set.

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

**Provider flag.** A `--provider <name>` flag on the batch command:

```js
function parseProviderFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider' && argv[i + 1]) {
      const name = argv[i + 1].toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        throw new Error('--provider must be a valid provider name');
      }
      return name;
    }
  }
  return 'deepseek';  // default
}
```

Priority order for per-source provider assignment:

1. `source.provider` from `classes.json` (if the wizard lets the user set per-source)
2. `--provider` CLI flag (batch-wide default)
3. `'deepseek'` (hardcoded fallback)

The `classes.json` field is the escape hatch — if a specific source is known to need another provider, the user can set it explicitly. Validate every selected name against the current `/providers` response before processing: built-ins are `deepseek`, `qwen`, and `chatgpt`; config providers must be enabled in the extension. `tongyi` is not routable.

## Concurrency

**Requests are serialized by one server queue.** The extension resolves each request to exactly one tab for its named provider. Multiple consumers may share a server and queue, but their requests still execute serially; avoid sharing a run directory or mutable chat map between processes.

**One server, one serialized queue.** Multiple callers may share a server, but every request—including requests for different providers—runs sequentially. Concurrent caller submissions wait FIFO; they do not produce provider-level parallelism. Prefer one sequential batch runner to keep source ordering and logs understandable.

**Advisory lock.** Write `data/batch/.lock` on `start()` with `{ pid, startedAt, runId }`. If the file exists and the pid is alive, refuse to start. Delete the file in `shutdown()`. This catches the common case — a user starting two `batch paste` runs in two terminals.

## Smoke test before a full batch

Before a batch, prove the integration works with one prompt per selected provider.

**DeepSeek smoke test:**

```bash
cd ~/pulchowk-events-bot
node -e '
const { ExtensionTransport } = require("./scripts/batch/lib/transport-extension");
(async () => {
  const t = new ExtensionTransport();
  await t.start();
  try {
    await t.open({ chatName: "smoke-deepseek", provider: "deepseek" });
    const r = await t.chat({
      chatName: "smoke-deepseek",
      provider: "deepseek",
      prompt: "Reply with exactly:\nsmoke-deepseek START_a.js\nconsole.log(42);\nsmoke-deepseek END_a.js",
    });
    console.log("OK:", JSON.stringify(r));
  } finally {
    await t.shutdown();
  }
})().catch(e => { console.error("FAIL:", e.code, e.message); process.exit(1); });
'
```

Expected: `OK: {"content":"console.log(42);","url":"https://chat.deepseek.com/a/chat/s/...","elapsedMs":...,"chat":"smoke-deepseek","provider":"deepseek"}`.

**Qwen smoke test:**

```bash
cd ~/pulchowk-events-bot
node -e '
const { ExtensionTransport } = require("./scripts/batch/lib/transport-extension");
(async () => {
  const t = new ExtensionTransport();
  await t.start();
  try {
    await t.open({ chatName: "smoke-qwen", provider: "qwen" });
    const r = await t.chat({
      chatName: "smoke-qwen",
      provider: "qwen",
      prompt: "Reply with exactly:\nsmoke-qwen START_a.js\nconsole.log(42);\nsmoke-qwen END_a.js",
    });
    console.log("OK:", JSON.stringify(r));
  } finally {
    await t.shutdown();
  }
})().catch(e => { console.error("FAIL:", e.code, e.message); process.exit(1); });
'
```

Expected: a successful response with the requested provider and returned chat URL. Elapsed time varies with UI readiness and provider generation.

**What each smoke test catches:**

| Bug | DeepSeek test | Qwen test |
|---|---|---|
| Token mismatch | `auth_failed` | `auth_failed` |
| Extension/server authentication mismatch | `auth_failed` | `auth_failed` |
| Provider tab missing or duplicated | `ambiguous_provider_tab` | `ambiguous_provider_tab` |
| Provider module/config unavailable | `bad_request` or `internal_error` | `bad_request` or `internal_error` |
| Provider's DOM drifted | `input_not_found` or `dom_drift` | `input_not_found` (Qwen) |
| Qwen's delimiter enforcement broken | — | `invalid_response_format` |

Run both smoke tests before the full batch. If either fails, fix the failure before proceeding — a full batch amplifies every integration bug.

## Acceptance checklist

Before submitting the integration PR:

**Lifecycle:**

- [ ] `createServer` + `start()` called once at batch start, `stop()` called once in `finally`
- [ ] `createClient` connects to `server.port()` or `EXTENSION_PORT` (matches popup config)
- [ ] `start()` failure exits with distinct code, does not try to run sources
- [ ] Ctrl+C mid-batch triggers `shutdown()` via `finally` or `SIGINT` handler
- [ ] Attach-or-own: `EADDRINUSE` is caught, does not abort if a server already exists

**Batch loop:**

- [ ] A saved URL is passed to `/chat` when sending a retry; use `/open` only when navigating without sending
- [ ] `transport.chat()` called with `chatName`, `provider`, `prompt`, and optional saved `url`
- [ ] Per-source failures caught and pushed to `needs-review`, do not abort the batch
- [ ] `extractFromContent` produces the same code as `extractCodeFromClipboard` in manual mode
- [ ] Identity check preserved
- [ ] File written to `data/batch/<run>/generated/<name>.js` (same path as manual mode)

**Provider threading:**

- [ ] `provider` field is passed through `open()`, `chat()`, and error handling
- [ ] Per-source provider defaults to `--provider` flag, then `'deepseek'`
- [ ] `classes.json` can override the provider per source
- [ ] Smoke test run for both DeepSeek and Qwen before a full batch

**Chat map:**

- [ ] `chat-map.json` created in run directory
- [ ] Keys are `<sourceName>::<provider>` pairs
- [ ] Written after every successful `/chat`
- [ ] Read before `open()` — if a URL exists, pass it to `open({ url })` to skip the sidebar walk
- [ ] Fresh run starts with an empty map

**Error policy:**

- [ ] Automatic retry occurs only when `retryable === true` and `executionState === "not_dispatched"`
- [ ] Unknown/outcome-uncertain requests preserve `requestId` and go to human review, never silent replay
- [ ] Provider selection is validated against `/providers`; a config provider must be enabled and routable
- [ ] `invalid_response_format` is not automatically retried after dispatch
- [ ] Failures preserve `code`, `reason`, `requestId`, `executionState`, `retryable`, `retryAfter`, `userFixable`, `details`, and `trace`
- [ ] `DSCError` recognized by `instanceof DSCError`, not duck-typing

**Provider pivot:**

- [ ] `rate_limited` on DeepSeek pivots to Qwen (if configured)
- [ ] `rate_limited` on Qwen pivots to DeepSeek (if configured)
- [ ] Pivot happens only once per source (`_pivotedFrom` flag)
- [ ] Pivot uses a different chat name per provider in `chat-map.json`

**Flags:**

- [ ] `--manual` forces `ManualClipboardTransport` even when `EXTENSION_TOKEN` is set
- [ ] `--extension` throws if `EXTENSION_TOKEN` is missing
- [ ] No flag + token present → `ExtensionTransport`
- [ ] No flag + token absent → `ManualClipboardTransport`
- [ ] `--provider <name>` and per-source overrides validated against `/providers` before processing

**Preservation of manual mode:**

- [ ] `ManualClipboardTransport` has identical behavior to current `paste.js`
- [ ] Identity check fires in manual mode
- [ ] Wrong-clipboard-copy rejection works in manual mode

**Concurrency:**

- [ ] Advisory lock on `data/batch/.lock`, refuses second concurrent batch
- [ ] Lock released on `shutdown()` and on `SIGINT`

**Smoke test:**

- [ ] Both provider smoke tests pass before the first full batch

Every item on this list is enforced by one of the reference docs. If a review comment asks "why does this check exist", the answer is a link back to the source-of-truth.