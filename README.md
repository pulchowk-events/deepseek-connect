<p align="center"><a href="assets/banner.mp4"><img src="assets/banner.gif" alt="deepseek-connect" width="100%"></a></p>

# deepseek-connect

A Chromium extension and a Node server that drives real AI chat tabs — DeepSeek, Qwen, ChatGPT, and configurable providers — over a local HTTP API. Any caller can use these chats without clipboard round-trips, headless-browser automation, or handling provider credentials.

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

1. **A load-unpacked Chromium extension** (Manifest V3, plain JavaScript, no build step) that lives in the user's real browser profile. It drives exactly one open tab for the requested provider. Built-in drivers cover DeepSeek, Qwen, and ChatGPT; additional selector-based providers can be configured from the extension's Providers page.
2. **A Node HTTP server** on `127.0.0.1:<port>` that the extension polls. Callers send `POST /chat` with messages and a required `provider` field; the server queues the request, the extension dispatches it to the matching provider, and the reply comes back as `{ content, chat, url, elapsedMs }`.

The extension is the client of the server. The server is the client of the extension. HTTP long-poll sits between them because the flow is strictly alternating and the tab is single-threaded anyway — no WebSockets, no sockets, no build step, no shared state file, no credential storage.

**Why "deepseek-connect" if it supports more than DeepSeek?** DeepSeek was the original target and the name is baked into the repo, npm scope, and every URL in the ecosystem. Renaming it would break existing references for zero functional benefit. The plugin registry underneath is provider-agnostic — see [Providers](#providers) below.

## Why it exists

Two problems, one tool:

**Problem 1: clipboard round-trips don't scale.** A separate batch workflow may use this extension to automate provider input and reply retrieval. The caller remains responsible for checking reply syntax, source identity, verdicts, and any generated code before saving or using it. The extension does not validate extractor correctness and never executes model-produced code.

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
- Open exactly one tab for the provider you intend to call (for example `https://chat.deepseek.com/`, `https://chat.qwen.ai/`, or `https://chatgpt.com/`) and leave it open. Multiple tabs matching the same provider are rejected as ambiguous.

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

The `url` identifies the conversation. Pass it to `/open` to navigate or include it with an explicitly selected, confirmed-safe `/chat` attempt. A safe retry requires `retryable: true` and `executionState: "not_dispatched"` and uses a new request ID because the old ID is deduplicated to its original failure. Do not replay after an uncertain timeout under a new ID: inspect the provider tab first. Reuse the original `requestId` to deduplicate and retrieve a late result. The extension goes directly to the selected provider's exact-host conversation; it does not fall back to another provider or chat.

**4. Same prompt, Qwen instead:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: hello"}],"chat":"quickstart-qwen","provider":"qwen"}' \
  | python3 -m json.tool
```

Same shape, different provider. The extension routes to `providers/qwen.js`, which handles Qwen-specific concerns (age-modal dismissal, anti-bot pacing, strict delimiter enforcement) transparently.

**`provider` is required** on `/chat`, `/open`, and `/reset`. The server rejects a missing or unknown provider instead of silently routing to another tab.

## What you get

**From the HTTP API:**

| Route | What it does |
|---|---|
| `POST /chat` | Send `{ messages, chat?, provider, requestId? }`, receive `{ content, chat, url, elapsedMs, requestId, executionState }`. The main entry point. |
| `POST /open` | Find-or-create a chat by name, or navigate directly to a persisted URL. Requires `chatName` and `provider`. |
| `POST /reset` | Run the provider's reset behavior. Requires `chatName` and `provider`; current built-in implementations do not delete chat history. |
| `GET /tabs` | Snapshot of provider tabs currently open, each with a `provider` field. |
| `GET /status` | Authenticated server/extension queue snapshot; not a provider-readiness check. |
| `GET /version` | Return the server package version and extension build hash. |
| `GET, POST, PUT, DELETE /providers` | List or manage selector-based config providers. Changes require the extension's Providers page to reconcile permissions and registration. |
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
    provider: 'qwen',     // required: deepseek, qwen, chatgpt, or an enabled config provider
  });
  console.log(content, url);
} finally {
  await server.stop();
}
```

Errors thrown by the client are `DSCError` instances carrying `{ code, reason, retryable, retryAfter, userFixable, details, trace, requestId, executionState }` (optional fields may be absent). See [docs/error-codes.md](docs/error-codes.md) for the registered taxonomy and the distinction between default retry metadata and dispatch-safe retryability. `retryAfter` is in milliseconds. Successful `/chat` responses also include `requestId` and `executionState: "completed"`.

## Providers

Currently supported:

| Provider | Status | Notes |
|---|---|---|
| `deepseek` | Built-in | DeepThink and Search auto-enabled; reasoning text is excluded from answer extraction. |
| `qwen` | Built-in | Age-modal handling, paced UI actions, and delimiter-based completion. |
| `chatgpt` | Built-in | ChatGPT web UI driver with prompt-size checks and bot-challenge detection. |
| `glm` | Config provider | Seeded selector-based provider for GLM on `chat.z.ai`; manage it through the extension's Providers page. |
| Other config providers | User-configured | Define selectors, completion, pacing, and extraction through the Providers page; host permission is requested by the extension. |
| `tongyi` | Not routable | A host permission remains reserved, but there is no provider module or config definition for it. |

For selector-based providers, use the Providers page and picker described in [docs/providers.md](docs/providers.md). Writing a new built-in DOM driver is maintainer-level work and requires updating the extension manifest, provider registries, server allowlist, and tests; the old three-registration checklist is not sufficient for that path.

## Documentation

| Doc | Read it when |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | First time setting up the extension; want a guided tutorial instead of a quickstart |
| [docs/providers.md](docs/providers.md) | Adding a new provider; understanding the plugin contract; debugging a provider that isn't routing correctly |
| [docs/protocol.md](docs/protocol.md) | Writing an integrator or a client for the HTTP API — every route, request shape, response shape, error shape |
| [docs/error-codes.md](docs/error-codes.md) | Handling a `DSCError` — the full taxonomy, which codes are retryable, which require the user to fix something |
| [docs/integration-guide.md](docs/integration-guide.md) | Integrating deepseek-connect into a batch wizard or another consumer — lifecycle blueprint, batch loop, per-code error policy, multi-provider threading |
| [docs/architecture.md](docs/architecture.md) | Understanding the current provider registry, long-poll flow, URL-based chat identity, and strict provider-tab routing |
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
- Strict provider tab selection: exactly one tab must match the requested provider's exact hostname; the extension does not fall back to another provider
- Queue serialization: concurrent `/chat` calls dispatch one at a time
- Live progress stream: every content-script phase forwards to the server log while the request is running
- Navigation guard: aborts with `user_navigated` if the work tab URL changes mid-stream
- 24-code error taxonomy with `retryable` / `userFixable` / `retryAfter` metadata
- `createServer` / `createClient` / `DSCError` exported for direct `require()`

**Not yet shipped (follow-ups):**

- Aggregator `--extension` flag integration in `pulchowk-events-bot` (separate repo; transport + paste-extension exist, provider forwarding is next)
- Wizard error beeps + needs-review skip (aggregator side)
- Sticky or per-provider work-tab ID storage (routing now requires exactly one provider-matching tab per request)
- Auto-pivot on rate limit (core loop fails with `rate_limited`; the wizard layers the pivot decision)
- Broader DOM-driver integration coverage beyond the current ChatGPT and config-provider tests
- Playwright end-to-end test
- Generic toggle error codes (rename `deepthink_enable_failed` → `reasoning_toggle_failed` with a compatibility alias, deferred to 0.3.0)

## Constraints

**Exactly one open tab per requested provider.** The extension requires one matching tab and rejects zero or multiple matches with `ambiguous_provider_tab`. Requests are serialized through the server queue, including requests for different providers.

**Provider DOMs are not stable.** DeepSeek's selectors are maintained in `selectors.js`; Qwen and ChatGPT have driver-specific selectors; config providers use their saved selector definitions. When a provider redesigns, [docs/selector-maintenance.md](docs/selector-maintenance.md) is the recovery playbook, and [docs/providers.md](docs/providers.md) covers selector editing through the Providers page.

**Extension code changes require a reload.** Reloading the unpacked extension does **not** re-inject content scripts into already-open tabs. After any change to `content.js`, `providers/*.js`, `selectors.js`, or `shared.js`, the work tab must be hard-reloaded (`Ctrl+Shift+R`) for the new code to take effect. When multiple provider modules changed, close all provider tabs and reopen one fresh. This is the single most common "my fix didn't work" mistake — see [docs/operations.md#reload-discipline](docs/operations.md#reload-discipline).

**No build step, by design.** Plain JavaScript, load-unpacked. `manifest.json` loads `shared.js`, `selectors.js`, the three built-in provider drivers, then `content.js`; config-provider files are registered dynamically. `background.js` uses `importScripts('shared.js')`.

**Request deadlines are not cancellation.** Queue timeout defaults to 120 seconds; dispatched-request timeout defaults to 960 seconds. The client also defaults to 960 seconds, but callers may choose a shorter deadline. A disconnect or timeout after dispatch does not cancel provider work: the result is `outcome_unknown`, and the server quarantines that queue slot until a late reply or shutdown. Inspect the provider tab before recovery. Reuse the same `requestId` to prevent duplicate dispatch and retrieve a late result. The in-memory deduplication cache (100 completed requests) is lost on server restart. There is no `/cancel` route.

**Provider UI interaction is paced and guarded.** Before pasting, the extension waits for the tab document and URL to settle, checks that the composer is visible, enabled, and empty, and waits for detected generation/prior-response activity to stabilize. After pasting it verifies the value and rechecks the send control before a single click, then waits for submission evidence. UI stages have a 1-second minimum pause; config-provider pacing can be longer. If a guard reports a non-empty composer or uncertain submission, inspect the provider tab rather than clearing or resending blindly. See [docs/protocol.md](docs/protocol.md#post-progress) for progress phases.

**Validation limits:** `/chat` requires JSON with a nonblank prompt in 1-100 valid message objects, max 1 MiB request body and 250,000 flattened prompt characters. Saved URLs must use HTTPS and the exact selected provider hostname. See [docs/protocol.md](docs/protocol.md) for all field constraints and recovery semantics.

## License

MIT. See [LICENSE](LICENSE).

---
