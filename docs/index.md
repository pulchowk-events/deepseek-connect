# Documentation

Reference for `deepseek-connect`. Start with the quadrant that matches what you're trying to do, or scan the table below for the specific topic.

**Contents**
- [By quadrant](#by-quadrant)
- [All docs](#all-docs)
- [Architecture decisions](#architecture-decisions)
- [Reading order for integrators](#reading-order-for-integrators)
- [Reading order for maintainers](#reading-order-for-maintainers)

---

## By quadrant

The four [Diátaxis](https://diataxis.fr/) quadrants answer four different questions. Pick the one that matches what you need right now.

### Learning — "how do I get this working?"

New to the project, want to reach a working round-trip step by step. Start here.

| Doc | Answers |
|---|---|
| [getting-started.md](getting-started.md) | Install the extension unpacked, set the token in the popup, send your first prompt, understand what just happened |

### Doing — "how do I accomplish a specific task?"

Have a working install, need to integrate or operate. Task-oriented guides.

| Doc | Answers |
|---|---|
| [integration-guide.md](integration-guide.md) | Wire deepseek-connect into a batch wizard or another Node consumer — lifecycle blueprint, batch loop, per-code error policy, `--manual` fallback |
| [operations.md](operations.md) | Reload the extension after a code change, read the trace log, recover from `logged_out` or `extension_disconnected`, start/stop the server |
| [selector-maintenance.md](selector-maintenance.md) | A DeepSeek DOM change broke extraction — per-selector fallbacks, the structural-walk strategy, the recovery playbook |

### Looking up — "what exactly does X do?"

Need precise, exhaustive information. Not for learning, not for doing — for reference.

| Doc | Answers |
|---|---|
| [protocol.md](protocol.md) | Every HTTP route — request shape, response shape, error shape, auth, long-poll lifecycle, queue state machine, protocol version, one-work-tab constraint |
| [error-codes.md](error-codes.md) | All 20 `DSCError` codes — `retryable`, `userFixable`, `retryAfter`, HTTP status, wizard decision per code |

### Understanding — "why is it shaped this way?"

Not trying to do anything yet, want the mental model before deciding what to build.

| Doc | Answers |
|---|---|
| [architecture.md](architecture.md) | Long-poll vs WebSockets, real Chrome vs Puppeteer, one chat per source, sticky work tab, streamUrl guard, build-hash selector strategy — every load-bearing decision and the reasoning behind it |

---

## All docs

| File | Diátaxis type | One-line description |
|---|---|---|
| [getting-started.md](getting-started.md) | Tutorial | Install + first round-trip in five minutes |
| [integration-guide.md](integration-guide.md) | How-to | `require()` this repo and drive DeepSeek from another Node process |
| [protocol.md](protocol.md) | Reference | Full HTTP wire contract |
| [error-codes.md](error-codes.md) | Reference | Complete `DSCError` taxonomy with retry policy |
| [architecture.md](architecture.md) | Explanation | Mental model and the "why" behind every decision |
| [operations.md](operations.md) | How-to | Day-2 operational runbook |
| [selector-maintenance.md](selector-maintenance.md) | How-to | DeepSeek DOM recovery playbook |

---

## Architecture decisions

Material decisions that constrain multiple modules or the wire protocol. Each ADR records the decision, the context that forced it, the alternatives considered, and the consequences of accepting it. ADRs are append-only — a decision that gets reversed gets a new ADR that supersedes the old one, not an edit.

| ADR | Decision |
|---|---|
| [0001 — long-poll over WebSocket](adr/0001-use-long-poll-over-websocket.md) | HTTP long-poll between server and extension, not WebSockets |
| [0002 — real Chrome over Puppeteer](adr/0002-real-chrome-over-puppeteer.md) | Drive the user's logged-in tab, not a fresh headless session |
| [0003 — one chat per source](adr/0003-one-chat-per-source.md) | Each source gets its own persistent chat, reused across retries |
| [0004 — sticky work tab](adr/0004-sticky-work-tab-over-target-tab-id.md) | Extension pins one tab in `chrome.storage`; callers don't supply tab IDs |
| [0005 — URL navigation for new chat](adr/0005-url-navigation-over-new-chat-button.md) | Fresh chat via `chrome.tabs.update({ url: '/' })`, not the "New chat" button |
| [0006 — answer-block extraction](adr/0006-answer-block-extraction-over-whole-message.md) | Extract `.ds-assistant-message-main-content` only; skip the reasoning stream |
| [0007 — structural sidebar walk](adr/0007-structural-sidebar-walk.md) | Find chat titles by walking from "New chat" text, not by class name |

---

## Reading order for integrators

You're building against this repo from a different process — a batch wizard, a CLI wrapper, an external service. Read in this order:

1. **[getting-started.md](getting-started.md)** — reach a working round-trip before designing anything
2. **[architecture.md](architecture.md)** — understand why the API is shaped the way it is, so you don't design against it
3. **[protocol.md](protocol.md)** — the full contract when you need a route's exact shape
4. **[error-codes.md](error-codes.md)** — the decision rule for every failure, before you write a `try/catch`
5. **[integration-guide.md](integration-guide.md)** — the concrete blueprint: lifecycle, batch loop, error policy

Steps 1-2 are non-negotiable — skipping them leads to integrations that fight the design. Steps 3-5 are consulted during the build, not read once front-to-back.

---

## Reading order for maintainers

You're operating or modifying this repo directly. Read in this order:

1. **[architecture.md](architecture.md)** — the load-bearing invariants before you change anything
2. **[operations.md](operations.md)** — how to run it, reload it, and diagnose it
3. **[selector-maintenance.md](selector-maintenance.md)** — how to recover when DeepSeek redesigns, which it will
4. **[protocol.md](protocol.md)** — the wire contract if you're changing what the extension sends or the server receives
5. **[error-codes.md](error-codes.md)** — when adding a new failure mode, this is where it gets registered before it gets raised

The [ADR folder](adr/) is the record of decisions that look arbitrary until you read the reasoning. Before proposing a change that touches long-poll, tab selection, chat lifecycle, or extraction, check whether an ADR already pins the current behavior — if it does, the change needs a new ADR that supersedes it, not a quiet edit.