# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 versions may break wire compatibility between the extension and the
server. Upgrade both sides together.

## [Unreleased]

### Planned

- Aggregator `--extension` flag integration in `pulchowk-events-bot` (transport + paste-extension exist; provider forwarding to the transport is next)
- Wizard error beeps and `needs-review` skip on the aggregator side
- Per-provider work tab ID storage (currently the pinned tab is single; provider-scoped queries bypass it)
- Auto-pivot on rate limit as a wizard-level policy (the pivot pattern is documented; the aggregator's transport doesn't implement it yet)
- Provider unit tests (`tests/providers/*.test.js`)
- Playwright end-to-end test (`tests/e2e.test.js`)
- `POST /cancel/:requestId` route
- `GET /status` route
- `GET /health` route
- Per-request server-side timeout (fixes the "extension dies mid-flight" queue block)
- `/reset` with `delete: true` flag for actual chat deletion
- Protocol version negotiation (`PROTOCOL_VERSION_MISMATCH`)
- Extension popup "Skip site" button (`user_skipped` error code)
- Generic toggle error codes (rename `deepthink_enable_failed` → `reasoning_toggle_failed` with a compatibility alias)

## [0.2.0] — 2026-11-17

Multi-provider plugin architecture. `deepseek-connect` now drives DeepSeek, Qwen, and future providers through a registry-based plugin system.

### Added

**Plugin architecture** — `providers/` directory

- `content.js` is now a ~40-line router. It reads `msg.provider` from the background service worker, looks up the corresponding module in `globalThis.DSC_PROVIDERS`, and delegates one of four actions (`ensureChat`, `sendPrompt`, `checkState`, `resetChat`).
- `providers/deepseek.js` — the pre-refactor `content.js` logic, wrapped in an IIFE that registers into `DSC_PROVIDERS['deepseek']`. Behavior unchanged: sidebar walk, DeepThink + Search auto-enable, reasoning-vs-answer stream loop.
- `providers/qwen.js` — self-contained. Own selectors, own helpers, own pacing (1000-1500ms sleeps between actions), own age-modal dismisser (`dismissAgeModal()` before every action), strict delimiter enforcement (`START_QWEN_REPLY` / `END_QWEN_REPLY`).
- The provider contract is documented in `shared.js` (`PROVIDER CONTRACT` comment block) and enumerated in [docs/providers.md](docs/providers.md). Adding a new provider is one new file plus three registrations.

**URL-based retry** — the primary chat-identity mechanism

- `POST /chat` response now includes `url` — the stable chat URL the reply landed in (e.g., `https://chat.deepseek.com/a/chat/s/<uuid>`, `https://chat.qwen.ai/c/<uuid>`).
- `POST /open` accepts a `url` field. When present, the extension navigates directly via `chrome.tabs.update` and skips the sidebar walk entirely.
- This fixes the "DeepSeek paraphrases chat titles, so sidebar fuzzy-match can't find chats by source name" bug. Documented in [ADR 0003's amendment](docs/adr/0003-one-chat-per-source.md#amendment-2026-11-16).
- Retry with context now works reliably: send → capture URL → persist → on retry, `/open { url }` navigates directly → LLM sees prior turn.

**Provider threading**

- `POST /chat`, `POST /open`, `POST /reset` accept an optional `provider` field (defaults to `'deepseek'`).
- `GET /tabs` response includes a `provider` field per tab, derived from `DSC.providerForUrl(url)`.
- `GET /next` payload includes `provider` and `targetUrl` (the queue entry's fields).
- `DSC.PROVIDER_DOMAINS` in `shared.js` is the single source of truth for URL → provider mapping.
- `background.getWorkTab(targetTabId, provider)` — when a provider is specified, queries that provider's domain directly and bypasses the pinned `workTabId`. Fixes multi-tab routing.

**Error taxonomy**

- New code: `invalid_response_format` (Qwen). The model didn't wrap its reply in the required `START_QWEN_REPLY` / `END_QWEN_REPLY` delimiters. `retryable: true, userFixable: false, http: 502`. Bucket A (retry silently).
- Provider attribution table in [docs/error-codes.md](docs/error-codes.md#provider-attribution) — which codes can be raised by which provider.
- `deepthink_enable_failed` and `search_enable_failed` are now documented as DeepSeek-only.

**Architecture decision record**

- [ADR 0008 — multi-provider plugin architecture](docs/adr/0008-multi-provider-plugin-architecture.md). Documents the registry vs. feature flags vs. class inheritance vs. per-provider content scripts trade-off, and the three-registration checklist.
- ADRs 0003, 0004, 0007 amended with cross-references.

**Documentation** — `docs/`

- New: [docs/providers.md](docs/providers.md) (how to add a provider, with the Qwen case study).
- Updated for multi-provider: [README.md](README.md), [docs/index.md](docs/index.md), [docs/protocol.md](docs/protocol.md), [docs/error-codes.md](docs/error-codes.md), [docs/architecture.md](docs/architecture.md), [docs/getting-started.md](docs/getting-started.md), [docs/operations.md](docs/operations.md), [docs/selector-maintenance.md](docs/selector-maintenance.md), [docs/integration-guide.md](docs/integration-guide.md).

### Changed

- `manifest.json` — added `tabs` permission (required for `chrome.tabs.query` across providers), added `chat.qwen.ai` and `tongyi.aliyun.com` host permissions, updated `content_scripts.js` to load `providers/*.js` between `selectors.js` and `content.js`.
- `background.js#register` — `/hello` reports full tab inventory with per-tab `provider` field.
- `background.js#sendToTab` — re-injection file list includes both providers.
- `background.js#handleNext` — threads `work.provider` through every `sendToTab` call. The `needNewChat` fallback navigates to the current tab's origin (`new URL(tab.url).origin + '/'`) instead of hardcoded DeepSeek.
- `src/client.js` — `chat()` and `open()` forward `provider` in the request body.
- `src/errors.js` — human strings generalized to be provider-agnostic.
- `shared.js` — `DSC.VERSION` bumped to `'0.2.0'`; `PROVIDER_DOMAINS` + `providerForUrl` added; `PROVIDER CONTRACT` comment block added.
- `selectors.js` header now documents that it's DeepSeek-specific, not provider-neutral shared infrastructure.
- `package.json` + `manifest.json` version `0.1.1` → `0.2.0`.

### Removed

- `DEEPTHINK_OFF` constant from `shared.js`'s `DSC.ERR` map — never raised; the actual failure path is `DEEPTHINK_ENABLE_FAILED`.
- `retry-test.js` from repo root — was a debug script from the URL-retry investigation.

### Fixed

- Sidebar fuzzy match is no longer the primary chat-identity mechanism. DeepSeek and Qwen both paraphrase chat titles, so fuzzy-matching on title was silently failing on every retry. URL-based navigation (from `/chat`'s `url` response field) is now the reliable path.
- Multi-tab routing: `getWorkTab(provider)` correctly selects the provider's tab even when another provider's tab is pinned as `workTabId`.
- Two hardcoded domain maps in `background.js` collapsed into `DSC.PROVIDER_DOMAINS` — adding a provider no longer means editing two copies of the same mapping.

### Breaking changes

- `provider` field is new on `/chat`, `/open`, `/reset`. Callers that don't send it default to `'deepseek'` — v0.1.x callers work unchanged.
- `url` field is new on `/chat` responses. Additive — old clients ignore it.
- `provider` field is new on `/tabs` per-tab objects. Additive.
- No breaking changes for DeepSeek-only callers.

### Cross-version compatibility

- Old client + new server: works (server defaults provider to `'deepseek'`).
- New client + old server: DeepSeek works; Qwen requests fail (old server can't route).
- Old extension + new server: DeepSeek works; Qwen requests fail (old extension has no provider module).
- New extension + old server: same shape — DeepSeek works, Qwen fails.

Upgrade both sides together for multi-provider.

## [0.1.1] — 2026-11-16

Test coverage. No user-facing changes.

### Added

- `tests/errors.test.js` — 20 assertions covering the error taxonomy: every code has metadata, bucket counts match documentation, `DSCError` constructor/toJSON produce the documented shape, `fromReply` collapses unknown codes correctly.
- `tests/client.test.js` — mock-server HTTP tests covering `chat()`, `open()`, `tabs()` request shape, `DSCError` on non-2xx, client-side validation, network error handling, timeout.

### Verified

- `npm test` → 34 pass, 0 fail. Closes the last real coverage gap: `src/errors.js` and `src/client.js` now have automated tests, so regressions in the two modules that integrators depend on fail before reaching downstream code.

## [0.1.0] — 2026-11-16

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