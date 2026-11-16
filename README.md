# deepseek-connect

A Chromium extension and a Node server that drives real AI chat tabs — DeepSeek, Qwen, and future providers — over a local HTTP API. Any caller can use these chats as a free LLM endpoint without clipboard round-trips, Puppeteer fingerprinting, or credential handling.

**Contents**
- [What this is](#what-this-is)
- [Why it exists](#why-it-exists)
- [Quickstart](#quickstart)
- [What you get](#what-you-get)
- [Providers](#providers)
- [Documentation](#documentation)
- [Status](#status)
- [Constraints](#constraints)
- [License](#license)

---

## What this is

Two pieces, one protocol, N providers:

1. **A load-unpacked Chromium extension** (Manifest V3, plain JavaScript, no build step) that lives in the user's real Brave/Chrome profile. It finds the chat input on a real provider tab (DeepSeek, Qwen, Tongyi), types a prompt, clicks send, waits for the answer to finish streaming, and reads the reply back out. The DOM work is provider-specific; the routing is not.
2. **A Node HTTP server** on `127.0.0.1:<port>` that the extension polls. Callers send `POST /chat` with messages and a `provider` field; the server queues the request, the extension dispatches to the right provider module, the reply comes back as `{ content, chat, url, elapsedMs }`.

The extension is the client of the server. The server is the client of the extension. HTTP long-poll sits between them because the flow is strictly alternating and the tab is single-threaded anyway — no WebSockets, no sockets, no build step, no shared state file, no credential storage.

**Why "deepseek-connect" if it supports more than DeepSeek?** DeepSeek was the original target and the name is baked into the repo, npm scope, and every URL in the ecosystem. Renaming it would break existing references for zero functional benefit. The plugin registry underneath is provider-agnostic — see [Providers](#providers) below.

## Why it exists

Two problems, one tool:

**Problem 1: clipboard round-trips don't scale.** The Pulchowk Events Aggregator's `batch paste` wizard onboards dozens of job sources at once. Each source needs an LLM prompt dumped to the clipboard, pasted into a chat, and the reply copy-pasted back. For a 76-source batch, that's roughly 80 minutes of pure clipboard work per run. It is also error-prone in exactly one way — the wrong-clipboard-copy bug, where a previous site's reply gets pasted into the next site's prompt file, has caught real mistakes in every multi-site batch ever run.

**Problem 2: Puppeteer triggers provider fingerprinting.** DeepSeek and Qwen both rate-limit headless and stealth-patched browser sessions aggressively, and real auth cookies are hard to keep alive in a fresh profile. Driving the user's already-logged-in real Chrome tab sidesteps both — the browser is the same browser the user browses in, the cookies are the user's cookies, and the fingerprint is a real fingerprint because it is a real browser. No credential handling, no login flows, no API keys.

**Problem 3: a single provider isn't enough.** DeepSeek's free tier rate-limits after a burst of requests. Qwen's free tier has its own quota and its own session lifecycle. Building against one provider meant a batch could stall on a rate limit with no recovery path. The multi-provider architecture (v0.2.0) lets a caller pivot: if DeepSeek is throttled, the same batch re-runs the affected source on Qwen.

`deepseek-connect` replaces the clipboard loop with a fully automated round-trip. The wizard sends a prompt, the extension drives the tab, the reply comes back as JSON. Zero-touch, same LLM, same conversation state.

## Quickstart

**Prerequisites:** Node 22, Brave or Chrome, a logged-in DeepSeek **or** Qwen account in that browser.

**1. Start the server:**

```bash
git clone https://github.com/pulchowk-events/deepseek-connect.git
cd deepseek-connect
cp .env.example .env          # then set EXTENSION_TOKEN to any long random string
node --env-file=.env src/server.js
```

The server prints `listening on 127.0.0.1:7331` and waits for the extension.

**2. Load the extension:**

- Open `brave://extensions` (or `chrome://extensions`)
- Enable **Developer mode** (top right)
- Click **Load unpacked** → select the `deepseek-connect/` directory
- Click the extension icon → paste the same `EXTENSION_TOKEN` from `.env`, plus the port (`7331` by default) → **Save**
- Open one tab to `https://chat.deepseek.com/` **or** `https://chat.qwen.ai/` and leave it open

The extension registers with the server. The server terminal should now show:

```
[HH:MM:SS] extension connected (0.2.0) | https://chat.deepseek.com/ | 1 tab(s)
```

**3. Send a prompt (DeepSeek):**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: hello"}],"chat":"quickstart","provider":"deepseek"}' \
  | python3 -m json.tool
```

You get back:

```json
{
  "content": "hello",
  "chat": "quickstart",
  "url": "https://chat.deepseek.com/a/chat/s/ae834e91-...",
  "elapsedMs": 4300
}
```

The `url` is the stable chat identity for retry. On the next call to the same `chat` name, pass `url` to `/open` and the extension navigates directly — no sidebar fuzzy-matching, no dependence on provider title auto-generation.

**4. Same prompt, Qwen instead:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: hello"}],"chat":"quickstart-qwen","provider":"qwen"}' \
  | python3 -m json.tool
```

Same shape, different provider. The extension routes to `providers/qwen.js`, which handles Qwen-specific concerns (age-modal dismissal, anti-bot pacing, strict delimiter enforcement) transparently.

**If `provider` is omitted, it defaults to `deepseek`.** Existing v0.1.x callers work unchanged.

## What you get

**From the HTTP API:**

| Route | What it does |
|---|---|
| `POST /chat` | Send `{ messages, chat?, provider? }`, receive `{ content, chat, url, elapsedMs }`. The main entry point. |
| `POST /open` | Find-or-create a chat by name, or navigate directly to a persisted URL. Returns `{ existing, mode, url, debug }`. |
| `POST /reset` | Reset a chat's state. Currently a no-op alias for `/open`. |
| `GET /tabs` | Snapshot of provider tabs currently open, each with a `provider` field. |
| `GET /next` | Extension long-poll. Not for callers. |
| `POST /reply` | Extension's reply-to-server. Not for callers. |
| `POST /progress` | Extension's live phase telemetry. Not for callers. |
| `POST /hello` | Extension's registration. Not for callers. |

**From the Node package:**

```js
const { createServer } = require('deepseek-connect');
const { createClient } = require('deepseek-connect/client');
const { CODES, DSCError } = require('deepseek-connect/errors');

const server = createServer({ token, port: 0 });
await server.start();
const dc = createClient({ token, port: server.port() });

try {
  const { content, url } = await dc.chat({
    messages: [{ role: 'user', content: 'Say hi' }],
    chat: 'my-chat',
    provider: 'qwen',     // 'deepseek' (default), 'qwen', or a future provider
  });
  console.log(content, url);
} finally {
  await server.stop();
}
```

Errors thrown by the client are `DSCError` instances carrying `{ code, reason, retryable, retryAfter, userFixable, details }`. See [docs/error-codes.md](docs/error-codes.md) for the full 21-code table and the decision rule for each.

## Providers

Currently supported:

| Provider | Status | Notes |
|---|---|---|
| `deepseek` | Stable | The original target. DeepThink and Search auto-enabled with hard-fail on verification. Reasoning stream skipped during extraction. |
| `qwen` | Stable | Added in v0.2.0. Age-modal dismisser runs before every action. Strict delimiter enforcement (`START_QWEN_REPLY` / `END_QWEN_REPLY`) prevents "Thinking..." false positives. 1-1.5s pacing between actions prevents bot detection. |
| `tongyi` | Domain reserved | `tongyi.aliyun.com` is in `manifest.json` host permissions and `DSC.PROVIDER_DOMAINS`. No provider module yet; adding one requires only a `providers/tongyi.js` file. |

Adding a third provider is a **single-file change** plus three small registrations. See [docs/providers.md](docs/providers.md) for the complete walkthrough. The short version:

1. Create `providers/claude.js` (or whatever provider) — a self-contained module exposing `{ name, ensureChat, sendPrompt, checkState, resetChat }` and registering itself into `globalThis.DSC_PROVIDERS['claude']`.
2. Add the domain to `DSC.PROVIDER_DOMAINS` in `shared.js`.
3. Add the domain to `manifest.json` (`host_permissions`, `content_scripts.matches`) and add `providers/claude.js` to `content_scripts.js` and `background.js`'s `sendToTab` re-injection list.

Nothing in `content.js`, `src/server.js`, or `src/client.js` needs to change. The router and HTTP pipeline are already universal.

## Documentation

| Doc | Read it when |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | First time setting up the extension; want a guided tutorial instead of a quickstart |
| [docs/providers.md](docs/providers.md) | Adding a new provider; understanding the plugin contract; debugging a provider that isn't routing correctly |
| [docs/protocol.md](docs/protocol.md) | Writing an integrator or a client for the HTTP API — every route, request shape, response shape, error shape |
| [docs/error-codes.md](docs/error-codes.md) | Handling a `DSCError` — the full taxonomy, which codes are retryable, which require the user to fix something |
| [docs/integration-guide.md](docs/integration-guide.md) | Integrating deepseek-connect into a batch wizard or another consumer — lifecycle blueprint, batch loop, per-code error policy, multi-provider threading |
| [docs/architecture.md](docs/architecture.md) | Understanding why the system is shaped this way — plugin registry, long-poll vs WebSockets, real Chrome vs Puppeteer, one chat per source, sticky tab |
| [docs/operations.md](docs/operations.md) | Running this day-to-day — reloading the extension after a code change, reading the trace log, recovering from `logged_out` / `rate_limited` / Qwen's age modal |
| [docs/selector-maintenance.md](docs/selector-maintenance.md) | A provider DOM change broke extraction — per-provider selector fallbacks, the structural-walk strategy, the diagnostic snippet |
| [docs/adr/](docs/adr/) | Understanding a specific load-bearing decision — eight ADRs cover the non-obvious choices |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Opening a PR — build, test, branch, commit conventions |

## Status

`v0.2.0` — multi-provider plugin architecture, functional end-to-end against real `chat.deepseek.com` and `chat.qwen.ai` as of November 2026.

**Working:**

- Plugin registry: `content.js` is a thin router, each provider is a self-contained module
- DeepSeek round-trip: type, send, wait for answer (skipping reasoning), extract between delimiters or fall back to last code fence or raw text
- DeepSeek's DeepThink + Search auto-enable with hard-fail if either can't be verified on
- Qwen round-trip: age-modal dismissal, anti-bot pacing, strict delimiter enforcement
- Per-source chat lifecycle: `/open { chatName }` finds an existing chat or navigates to a fresh one
- **URL-based retry**: `/chat` response includes the actual chat URL; `/open { chatName, url }` navigates directly and skips the sidebar entirely. Proven against DeepSeek; works the same way on Qwen.
- Sticky work tab: pinned in `chrome.storage` for the default (single-provider) case; provider-scoped queries bypass the pin when a specific provider is requested
- Queue serialization: concurrent `/chat` calls dispatch one at a time
- Live progress stream: every content-script phase forwards to the server log while the request is running
- Navigation guard: aborts with `user_navigated` if the work tab URL changes mid-stream
- 21-code error taxonomy with `retryable` / `userFixable` / `retryAfter` metadata
- `createServer` / `createClient` / `DSCError` exported for direct `require()`

**Not yet shipped (follow-ups):**

- Aggregator `--extension` flag integration in `pulchowk-events-bot` (separate repo; transport + paste-extension exist, provider forwarding is next)
- Wizard error beeps + needs-review skip (aggregator side)
- Per-provider work tab ID storage (currently the pinned tab is single; provider-scoped queries bypass it)
- Auto-pivot on rate limit (core loop fails with `rate_limited`; the wizard layers the pivot decision)
- Provider unit tests (`tests/providers/*.test.js`)
- Playwright e2e test
- Generic toggle error codes (rename `deepthink_enable_failed` → `reasoning_toggle_failed` with a compatibility alias, deferred to 0.3.0)

## Constraints

**One work tab at a time, per provider.** The extension's default behavior pins exactly one tab in `chrome.storage.local.workTabId`. When a request specifies a `provider`, the extension queries that provider's domain directly and bypasses the pin — so two providers can run sequentially without fighting over the pinned tab. Two concurrent requests against the same provider would still serialize through the queue.

**Provider DOMs are not stable.** Both DeepSeek and Qwen ship redesigns regularly. Class names on both are build-hashed. The extension resolves selectors through per-provider tier lists; the primary anchors are structural (text content, element shape, `aria-` attributes) rather than class names. When a provider redesigns, [docs/selector-maintenance.md](docs/selector-maintenance.md) is the recovery playbook, and [docs/providers.md](docs/providers.md) covers the case where a provider needs a fresh selector strategy entirely.

**Extension code changes require a reload.** Reloading the unpacked extension does **not** re-inject content scripts into already-open tabs. After any change to `content.js`, `providers/*.js`, `selectors.js`, or `shared.js`, the work tab must be hard-reloaded (`Ctrl+Shift+R`) for the new code to take effect. When multiple provider modules changed, close all provider tabs and reopen one fresh. This is the single most common "my fix didn't work" mistake — see [docs/operations.md#reload-discipline](docs/operations.md#reload-discipline).

**No build step, by design.** Plain JavaScript, load-unpacked. `manifest.json` loads `shared.js → selectors.js → providers/deepseek.js → providers/qwen.js → content.js` in that order; `background.js` uses `importScripts('shared.js')`. If a file grows past ~800 lines, refactor into modules with `import` — but no bundler, no webpack, no vite.

**No per-request server-side timeout in v0.2.0.** If the extension crashes after `/next` returns a job, the server's `inFlight` map blocks the queue until restart. Documented in [docs/protocol.md#queue-state-machine](docs/protocol.md#queue-state-machine).

## License

MIT. See [LICENSE](LICENSE).

---
