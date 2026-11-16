# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 versions may break wire compatibility between the extension and the
server. Upgrade both sides together.

## [Unreleased]

### Planned

- Aggregator `--extension` flag integration (separate repo)
- Wizard error beeps and `needs-review` skip on the aggregator side
- Playwright end-to-end test (`tests/e2e.test.js`)
- `POST /cancel/:requestId` route
- `GET /status` route
- `GET /health` route
- Per-request server-side timeout (fixes the "extension dies mid-flight" queue block)
- `/reset` with `delete: true` flag for actual chat deletion
- Protocol version negotiation (`PROTOCOL_VERSION_MISMATCH`)
- Extension popup "Skip site" button (`user_skipped` error code)
- Remove stale `DEEPTHINK_OFF` entry from `shared.js`'s `DSC.ERR` map

## [0.1.0] — 2026-11-16

First working version. Functional end-to-end against real `chat.deepseek.com`.

### Added

**HTTP API** — `src/server.js`

- `POST /chat` — send messages, receive `{ content, chat, elapsedMs }`. The main entry point.
- `POST /open` — find-or-create a chat by name, returns `{ existing, mode, debug }`.
- `POST /reset` — reset a chat's state (current behavior is an alias for `/open`).
- `GET /tabs` — snapshot of `chat.deepseek.com` tabs.
- `POST /hello` — extension registration, caches the tab inventory.
- `GET /next` — extension long-poll (30s hold), returns queued jobs.
- `POST /reply` — extension's result delivery, resolves the pending `/chat` promise.
- `POST /progress` — live phase telemetry, logged but not stored.
- FIFO request queue with serialized dispatch (`inFlight.size <= 1`).
- Graceful shutdown (`SIGINT`/`SIGTERM` rejects in-flight and queued requests).

**Node package** — `src/client.js`, `src/errors.js`

- `createServer({ token, port, host, log })` returns `{ start, stop, listen, close, status, enqueue, port }`. Accepts `port: 0` for OS-assigned ports.
- `createClient({ token, port, host })` returns `{ chat, open, reset, tabs, raw }`. Throws `DSCError` on non-2xx, never retries silently.
- `DSCError` class with `{ code, reason, retryable, retryAfter, userFixable, http, details, trace }`.
- 20-code error taxonomy grouped into five decision buckets (retry-silently, retry-delayed, retry-then-beep, beep-immediately, skip-silently).
- `isRetryable(code)`, `isUserFixable(code)`, `httpStatusFor(code, fallback)` helpers.
- `package.json` `exports` map so `require('deepseek-connect')`, `require('deepseek-connect/client')`, and `require('deepseek-connect/errors')` resolve.

**Extension** — `background.js`, `content.js`, `selectors.js`, `shared.js`

- Manifest V3, load-unpacked, no build step.
- Real DeepSeek round-trip: type prompt, click send, wait for answer (skipping reasoning stream), extract between delimiters with fence and raw fallbacks.
- DeepThink and Search auto-enable with hard-fail on verification (`deepthink_enable_failed`, `search_enable_failed`).
- Per-source chat lifecycle: `/open` finds existing chat via structural sidebar walk, or navigates to `/` for a fresh one.
- Retry path clicks the sidebar item so the LLM sees its own prior turns in context.
- Sticky work tab pinned in `chrome.storage.local.workTabId`, survives focus switches and mid-run clicks.
- `streamUrl` guard — aborts with `user_navigated` if the work tab URL changes mid-stream, preventing stale reads from the wrong chat.
- `reasoning` phase gating — the completion detector waits for the answer block specifically (`.ds-assistant-message-main-content`), not the whole message, so the reasoning stream doesn't false-positive the stabilization check.
- Live progress stream — twelve content-script phases forwarded to `/progress` while the request is running.
- Tiered selector resolution (`selectors.js`) — text content first, structural walk second, `aria-` attributes third, never build-hashed class names.
- `probeDom()` diagnostic — reports healthy, degraded, and required-missing selectors before every send.

**Documentation** — `docs/`

- [README.md](README.md) — front door, quickstart, API surface, doc index.
- [docs/index.md](docs/index.md) — docs hub organized by Diátaxis quadrant.
- [docs/protocol.md](docs/protocol.md) — full HTTP wire contract.
- [docs/error-codes.md](docs/error-codes.md) — error taxonomy with retry policy per code.
- [docs/integration-guide.md](docs/integration-guide.md) — batch wizard integration blueprint.
- [docs/architecture.md](docs/architecture.md) — the "why" doc, seven load-bearing decisions.
- [docs/getting-started.md](docs/getting-started.md) — tutorial walkthrough.
- [docs/operations.md](docs/operations.md) — symptom-indexed day-2 runbook.
- [docs/selector-maintenance.md](docs/selector-maintenance.md) — DeepSeek DOM recovery playbook.

### Verified

- Real DeepSeek round-trip against a logged-in Brave tab.
- Queue serialization under 3 concurrent `/chat` calls (sequential dispatch, each in its own chat, no overlap).
- Delimiter extraction (`source: "delimiter"`) with fence and raw fallbacks tested.
- Reasoning-vs-answer split confirmed with DeepThink on.
- Same-chat reuse: second prompt to the same chat name sees the first turn in context.
- Different-chat isolation: two sources get two chats, no cross-contamination.
- `/open` fuzzy match against the sidebar after a fresh chat was created.
- Sticky tab survives a focus switch to a different Brave tab.

### Known limitations

- No per-request server-side timeout. If the extension crashes after `/next` returns a job, the server's `inFlight` map blocks the queue until the server is restarted. See [docs/protocol.md#queue-state-machine](docs/protocol.md#queue-state-machine).
- One work tab, one server, one browser profile. Two servers against the same profile fight over `/next` polling.
- `/reset` does not actually delete the chat. DeepSeek's delete UI is fragile; the route is a placeholder for future behavior.
- Version negotiation is not implemented. `PROTOCOL_VERSION_MISMATCH` exists in the taxonomy but is never raised.
- Rename is deferred. Chats are auto-named by DeepSeek from the first message, and the batch prompt embeds the source name so the auto-title contains it. If the prompt doesn't embed the source name, sidebar fuzzy match will miss on retry.


---