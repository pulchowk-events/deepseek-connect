# 0001 — Use long-poll over WebSocket

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** —

## Context

The extension needs to learn "there's a job for you" the moment the server has one. Two options: the server pushes over a persistent connection (WebSocket or SSE), or the extension polls with a hold.

The flow is strictly alternating — `/next` → extension works → `/reply` → `/next` — so there is never a moment where the server needs to push a second message before the first completes.

The extension runs as a Manifest V3 service worker, which Chrome kills after ~30 seconds of inactivity. A killed service worker takes its WebSocket connection with it.

## Decision

The extension polls `GET /next` with a 30-second hold. The server holds the connection open if the queue is empty, responds with `{ action: 'idle' }` on timeout, and responds with `{ action: 'next', ... }` immediately if a job is queued. The extension re-polls immediately on `idle`.

No WebSocket. No SSE. No libraries. Node's `node:http` module and the browser's `fetch` handle long-poll natively.

## Consequences

### Positive

- **Service worker survives.** A 30-second HTTP request that returns `idle` is much lighter than a persistent WebSocket handshake. The extension's poll loop re-enters naturally on each response; if the worker is killed mid-poll, the next wake re-establishes the poll without a reconnect ceremony.
- **Debug-friendly.** A stuck poll produces a `curl` command. A stuck WebSocket produces a DevTools network tab entry with a binary frame that's hard to inspect.
- **No reconnect logic.** WebSocket reconnect after service-worker death requires re-handshake, re-authentication, re-registration with the server. Long-poll reconnect is "call `fetch` again."
- **No server-side session state.** Each `/next` is an independent request. The server tracks waiters in a `waiting[]` array that expires after 30s; there's no persistent connection to garbage-collect.
- **Matches the workload.** The alternation means a push model has no advantage — the server never needs to push before the previous job completes.

### Negative

- **30s idle latency floor.** With no queued job, the extension learns about a new job via its next `/next` return. On average, a job waits 15s for the poll to time out and the extension to re-poll. For batch wizards, this is fine — sources are processed one at a time and the poll return is faster than the next source's prompt construction. But for a caller sending one prompt at a time with pauses between, the 30s hold adds latency the WebSocket model wouldn't.
- **Two long-lived HTTP requests if both a poll and a `/chat` are open.** During a prompt round-trip, the extension's `/next` poll from the *previous* iteration is typically still open (it re-polls immediately on idle). The `/chat` connection is open the entire time. So the server sees two open connections per prompt — one caller, one poller. This is fine for loopback but would matter for a proxy.
- **`LONG_POLL_MS = 30000` is a compromise.** Shorter (10s) is 3x the requests; longer (60s) means up to 60s for the first job after idle to dispatch. 30s balances.

### Neutral

- The 30-second hold means `/next` requests always return within 30s, which is convenient for monitoring — a stuck `/next` is immediately visible as "no `/next` return in 30s."

## Alternatives considered

**WebSocket.** Rejected on four grounds: service worker lifecycle management, debug surface, need for reconnect logic, and no workflow benefit (strict alternation). Full reasoning in [architecture.md#1-long-poll-over-websockets](../../architecture.md#1-long-poll-over-websockets).

**Server-Sent Events.** Rejected for the same reasons as WebSocket, plus the constraint that SSE is one-directional — the extension would still need HTTP POSTs for `/reply`, so the SSE channel adds a second transport without replacing the existing one.

**Poll without a hold (immediate return).** Rejected because the poll rate would be bounded by `setInterval` (say, once per second), which is 30x the request rate of a 30s hold for no latency benefit — the extension learns about a new job within 1s either way, but the no-hold version leaves 60 requests per minute in the log.

## References

- [architecture.md#1-long-poll-over-websockets](../../architecture.md#1-long-poll-over-websockets)
- [protocol.md#long-poll-lifecycle](../../protocol.md#long-poll-lifecycle)
- [protocol.md#queue-state-machine](../../protocol.md#queue-state-machine)
- `src/server.js` `LONG_POLL_MS`, `pump()`, `waiting[]`
- `background.js` `pollLoop()`
