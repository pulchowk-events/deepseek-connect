# Documentation

Reference for `deepseek-connect`. Start with the quadrant that matches what you're trying to do, or scan the table below for the specific topic.

**Contents**
- [By quadrant](#by-quadrant)
- [All docs](#all-docs)
- [Architecture decisions](#architecture-decisions)
- [Reading order for integrators](#reading-order-for-integrators)
- [Reading order for provider authors](#reading-order-for-provider-authors)
- [Reading order for maintainers](#reading-order-for-maintainers)

---

## By quadrant

The four [Diátaxis](https://diataxis.fr/) quadrants answer four different questions. Pick the one that matches what you need right now.

### Learning — "how do I get this working?"

New to the project, want to reach a working round-trip step by step. Start here.

| Doc | Answers |
|---|---|
| [getting-started.md](getting-started.md) | Install the extension unpacked, set the token in the popup, send your first prompt (DeepSeek or Qwen), understand what just happened |

### Doing — "how do I accomplish a specific task?"

Have a working install, need to integrate, extend, or operate. Task-oriented guides.

| Doc | Answers |
|---|---|
| [providers.md](providers.md) | Configure selector-based providers in the Providers page; maintainer-only notes cover built-in driver development |
| [integration-guide.md](integration-guide.md) | Reference design for integrating another Node consumer; examples are illustrative and the aggregator is a separate repository |
| [operations.md](operations.md) | Reload the extension after a code change, read the trace log, recover from `logged_out` / `rate_limited` / Qwen's age modal |
| [selector-maintenance.md](selector-maintenance.md) | A provider DOM change broke extraction — per-provider selector fallbacks, the structural-walk strategy, the recovery playbook |

### Looking up — "what exactly does X do?"

Need precise, exhaustive information. Not for learning, not for doing — for reference.

| Doc | Answers |
|---|---|
| [protocol.md](protocol.md) | HTTP route shapes, auth, queue lifecycle, provider requirements, and exact-host tab routing |
| [error-codes.md](error-codes.md) | Registered error codes and retry metadata; verify current mappings against `src/errors.js` |

### Understanding — "why is it shaped this way?"

Not trying to do anything yet, want the mental model before deciding what to build.

| Doc | Answers |
|---|---|
| [architecture.md](architecture.md) | Plugin registry, long-poll flow, URL-based chat identity, and strict provider-tab routing; superseded designs are labeled |

---

## All docs

| File | Diátaxis type | One-line description |
|---|---|---|
| [getting-started.md](getting-started.md) | Tutorial | Install + first round-trip (DeepSeek or Qwen) in five minutes |
| [providers.md](providers.md) | How-to | Add a new provider; understand the plugin contract; debug routing |
| [integration-guide.md](integration-guide.md) | How-to | `require()` this repo and drive DeepSeek / Qwen from another Node process |
| [protocol.md](protocol.md) | Reference | Full HTTP wire contract, provider threading, queue semantics |
| [error-codes.md](error-codes.md) | Reference | Complete `DSCError` taxonomy with retry policy |
| [architecture.md](architecture.md) | Explanation | Mental model and the "why" behind every decision |
| [operations.md](operations.md) | How-to | Day-2 operational runbook, per-provider symptom index |
| [selector-maintenance.md](selector-maintenance.md) | How-to | Provider DOM recovery playbook |

---

## Architecture decisions

Material decisions that constrain multiple modules or the wire protocol. Each ADR records the decision, the context that forced it, the alternatives considered, and the consequences of accepting it. ADRs are append-only — a decision that gets reversed gets a new ADR that supersedes the old one, not an edit.

| ADR | Decision |
|---|---|
| [0001 — long-poll over WebSocket](adr/0001-use-long-poll-over-websocket.md) | HTTP long-poll between server and extension, not WebSockets |
| [0002 — real Chrome over Puppeteer](adr/0002-real-chrome-over-puppeteer.md) | Drive the user's logged-in tab, not a fresh headless session |
| [0003 — one chat per source](adr/0003-one-chat-per-source.md) | Each source gets its own persistent chat, reused across retries *(amended by 0008: URL-based identity is now primary)* |
| [0004 — sticky work tab](adr/0004-sticky-work-tab-over-target-tab-id.md) | Historical decision; the current extension does not pin a work tab and instead requires one exact provider-tab match |
| [0005 — URL navigation for new chat](adr/0005-url-navigation-over-new-chat-button.md) | Fresh chat via `chrome.tabs.update({ url: '/' })`, not the "New chat" button |
| [0006 — answer-block extraction](adr/0006-answer-block-extraction-over-whole-message.md) | Extract the answer wrapper only; skip the reasoning / thinking stream |
| [0007 — structural sidebar walk](adr/0007-structural-sidebar-walk.md) | Find chat titles by walking from "New chat" text, not by class name *(amended by 0008: sidebar walk is a fallback, not the primary mechanism)* |
| [0008 — multi-provider plugin architecture](adr/0008-multi-provider-plugin.architecture.md) | Registry-based plugin system; `content.js` as router; original built-in provider contract |

---

## Reading order for integrators

You're building against this repo from a different process — a batch wizard, a CLI wrapper, an external service. Read in this order:

1. **[getting-started.md](getting-started.md)** — reach a working round-trip before designing anything
2. **[architecture.md](architecture.md)** — understand why the API is shaped the way it is, including the provider dimension, so you don't design against it
3. **[protocol.md](protocol.md)** — the full contract when you need a route's exact shape, especially the `provider` field on `/chat` and `/open`
4. **[error-codes.md](error-codes.md)** — the decision rule for every failure, before you write a `try/catch`. `invalid_response_format` can come from Qwen and ChatGPT; `rate_limited` is provider-independent.
5. **[integration-guide.md](integration-guide.md)** — the concrete blueprint: lifecycle, batch loop, provider threading, error policy

Steps 1-2 are non-negotiable — skipping them leads to integrations that fight the design. Steps 3-5 are consulted during the build, not read once front-to-back.

## Reading order for provider authors

You're configuring a selector-based provider or implementing a new built-in driver. Start with the Providers page workflow; use the maintainer-only driver details only when a config provider cannot express the behavior you need.

1. **[providers.md](providers.md)** — the contract, the five-step walkthrough, the registration checklist, the Qwen case study
2. **[architecture.md#8-plugin-registry-over-feature-flags](architecture.md#8-plugin-registry-over-feature-flags)** — why `content.js` is a router and nothing else
3. **[adr/0008-multi-provider-plugin.architecture.md](adr/0008-multi-provider-plugin.architecture.md)** — the decision record, including alternatives that were rejected (feature flags, subclassing, hardcoded branching)
4. **[selector-maintenance.md](selector-maintenance.md)** — when your provider's DOM changes, this is the recovery playbook (per-provider sections)
5. **[operations.md#reload-discipline](operations.md#reload-discipline)** — the six-step reload sequence that prevents "the code on disk is correct but the extension isn't seeing it"

For a code-based driver, `providers/chatgpt.js` and `providers/qwen.js` are useful references. Config providers such as GLM are defined through the Providers page and do not implement the four-method JavaScript plugin contract themselves.

## Reading order for maintainers

You're operating or modifying this repo directly. Read in this order:

1. **[architecture.md](architecture.md)** — the load-bearing invariants before you change anything, especially the plugin registry and the provider contract
2. **[operations.md](operations.md)** — how to run it, reload it, and diagnose it, split by provider
3. **[selector-maintenance.md](selector-maintenance.md)** — how to recover when a provider redesigns, which happens roughly every 6 months per provider
4. **[protocol.md](protocol.md)** — the wire contract if you're changing what the extension sends or the server receives, or adding a new provider-side field that needs to reach the caller
5. **[error-codes.md](error-codes.md)** — when adding a new failure mode, this is where it gets registered before it gets raised
6. **[providers.md](providers.md)** — even if you're not adding a provider, this is the best single-doc overview of how the pieces fit

The [ADR folder](adr/) is the record of decisions that look arbitrary until you read the reasoning. Before proposing a change that touches long-poll, tab selection, chat lifecycle, extraction, selector strategy, or provider routing, check whether an ADR already pins the current behavior — if it does, the change needs a new ADR that supersedes it, not a quiet edit. ADR 0008 in particular documents what was considered and rejected when building the plugin system; reading it first saves a design conversation.