# 0008 — Multi-provider plugin architecture

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Amends:** [0003 — one chat per source](0003-one-chat-per-source.md), [0004 — sticky work tab](0004-sticky-work-tab-over-target-tab-id.md), [0007 — structural sidebar walk](0007-structural-sidebar-walk.md)
- **Superseded by:** —

> **Current implementation note:** This ADR records the original multi-provider design. Current APIs require an explicit provider, and `background.js` requires exactly one exact-host tab match; the optional default-provider and sticky-tab compatibility described in earlier versions no longer apply. Config providers use the Providers page rather than the built-in driver registration checklist.

## Context

The original architecture was DeepSeek-only. `content.js` contained all DOM manipulation logic, hardcoded to DeepSeek's chat page: sidebar walk from "New chat" text, DeepThink and Search toggle auto-enable, `.ds-assistant-message-main-content` for answer extraction, reasoning stream detection via `.ds-think-content`.

Two problems forced a refactor in November 2026.

**Problem 1 — DeepSeek's free-tier rate limits.** A 76-source batch run against DeepSeek's free tier hits the rate limit around source 40-50. The wizard's retry policy (one delayed retry after 30 seconds, then skip the source and mark needs-review) turns a 76-source batch into a 76-source batch where 25-35 sources land in `needs-review` for no reason other than "the batch ran too fast for DeepSeek's quota." The workaround — pause 30 seconds between sources — doubles the batch's wall-clock time without solving the underlying problem (the quota is per-hour, not per-minute).

**Problem 2 — Qwen has a parallel free tier.** Qwen's free tier has its own quota, separate from DeepSeek's. A wizard that could route sources to Qwen would have twice the throughput and a natural fallback when one provider rate-limits. But wiring Qwen into the existing DeepSeek-specific `content.js` would mean every function gets a `if (provider === 'deepseek') { ... } else if (provider === 'qwen') { ... }` branch. Three providers would be triple branches. Four would be quadruple. The design would become a combinatorial mess.

The Qwen provider needed to be added without making DeepSeek's code harder to maintain, without adding a build step, and without touching `src/server.js` or `src/client.js` (both of which are provider-agnostic by design).

## Decision

Adopt a **registry-based plugin architecture**. `content.js` becomes a thin router that reads `msg.provider` from the background service worker, looks up the corresponding module in `globalThis.DSC_PROVIDERS`, and delegates the action. Each provider registers itself into the global registry on injection.

### The provider contract

A provider is an object with one property and four methods:

```js
globalThis.DSC_PROVIDERS['<name>'] = {
  name: '<name>',
  async ensureChat(chatName) { /* returns {ok, existing?, mode?, debug?} or {ok: false, needNewChat: true} */ },
  async sendPrompt(prompt, delimiters) { /* returns {content, raw, url, source, trace} or {error, reason, trace} */ },
  async checkState() { /* returns {inputFound, currentChatName?, ...} */ },
  async resetChat(chatName) { /* returns {ok, reason?} */ },
};
```

The contract is documented in `shared.js` (search for `PROVIDER CONTRACT`) so a contributor adding a provider reads the spec from the codebase, not from a doc that can drift.

### The three registration points

A new provider requires exactly three registrations. Missing any of them produces a specific, diagnosable failure:

| Registration | File | Missing means |
|---|---|---|
| `DSC.PROVIDER_DOMAINS['<name>'] = '<url-prefix>/'` | `shared.js` | `no_work_tab` — the tab is open but background can't find it |
| `providers/<name>.js` in `manifest.json`'s `content_scripts.js` and `host_permissions`/`matches` | `manifest.json` | `no_provider_loaded` — the module never loads |
| `providers/<name>.js` in `background.js`'s `sendToTab` re-injection file list | `background.js` | Works once, fails on retry — the re-injection re-loads the old file list, not the new one |

The third registration is the hardest to catch. It only fires after a mid-run crash (service worker killed, tab reloaded), and the symptom is intermittent: the first request works, the retry fails with `no_provider_loaded`. The `PROVIDER CONTRACT` comment in `shared.js` lists all three registrations explicitly so a contributor reading the contract doesn't miss one.

### Provider-specific concerns

Each provider is fully self-contained. No shared helpers, no cross-provider imports, no knowledge that other providers exist.

- **DeepSeek** uses `globalThis.DSC_SELECTORS` (the tiered selector registry in `selectors.js`) as a fallback, but declares its own helpers for everything else.
- **Qwen** doesn't use `DSC_SELECTORS` at all. It has inline selectors, its own pacing (`sleep()` between every action), its own age-modal dismisser (`dismissAgeModal()` before every action), and its own completion detector (strict delimiter enforcement — the loop only breaks when both `START_QWEN_REPLY` and `END_QWEN_REPLY` are present).

The providers share zero implementation. This is deliberate — the failure modes are different (DeepSeek has toggles and a reasoning stream; Qwen has an age modal and a "Thinking..." preamble), and a shared abstraction would either be too loose (return preamble as content) or too strict (fail on legitimate replies).

### Provider threading

The `provider` string threads through every layer as a data field, but only `content.js` and `background.getWorkTab` interpret it:

- Caller sends `provider` in `/chat` or `/open` body
- Server stores `provider` on the queue entry, includes it in `/next` payload
- Background passes `provider` to `getWorkTab(targetTabId, provider)` for provider-scoped tab selection, and to `content.js` via `sendMessage`'s `provider` field
- `content.js` looks up `DSC_PROVIDERS[provider]` and dispatches
- `src/server.js` and `src/client.js` never branch on `provider`

If the provider string is normalized, defaulted, or interpreted anywhere else, that's a design smell. `src/server.js` is ~5 lines of provider threading total (the `provider: req.provider || 'deepseek'` on enqueue, and the `provider: entry.provider` on the `/next` payload). Anything more means provider-specific logic has leaked out of the provider module.

## Consequences

### Positive

- **Adding a provider is a single-file change plus three registrations.** `providers/claude.js` (new file) + one line in `shared.js` `PROVIDER_DOMAINS` + two entries in `manifest.json` + one entry in `background.js` `sendToTab`. Nothing in `content.js`, `src/server.js`, or `src/client.js` changes.
- **The router is deliberately blind.** `content.js` is ~40 lines. It looks up `DSC_PROVIDERS[msg.provider]` and calls one of four methods. It does not know what a DeepSeek is, what a Qwen is, or what `sendPrompt` returns. It has no per-provider logic.
- **The provider contract is documented in code.** `shared.js`'s `PROVIDER CONTRACT` comment block names the four methods and the three registrations. `content.js`'s router references the contract block from its top. A contributor reading the router sees the reference, reads the contract, and knows what to implement.
- **Provider internals are isolated.** `providers/qwen.js` doesn't import from `providers/deepseek.js`. A DeepSeek redesign touches only `providers/deepseek.js` (and `selectors.js`); a Qwen redesign touches only `providers/qwen.js`. A provider that isn't being actively used can drift for months without affecting the other.
- **Failures are provider-attributed.** The trace phase names are provider-specific (`probe`/`waitInput`/`toggleDeepthink` for DeepSeek; `step_1_dismiss_modal`/`step_2_find_input` for Qwen). When a request fails, the trace's last phase identifies which provider was running — no log correlation needed.
- **The wire protocol didn't change shape, only gained a field.** `/chat`, `/open`, `/next`, `/reply` all have the same request/response shapes as v0.1.x, with `provider` added. Backwards compatibility held for DeepSeek callers (server defaults to `'deepseek'`), and Qwen support is additive.

### Negative

- **Three registration points to miss.** Adding a provider is single-file *for the provider module*, but the three registrations are separate edits in separate files. The `no_provider_loaded` error mode exists specifically because missing a registration is easy. Documented extensively in `providers.md#the-registration-checklist` and the `PROVIDER CONTRACT` comment, but still a real friction point.
- **Providers share no implementation.** A new provider that needs the same tiered selector pattern as DeepSeek has to copy the pattern (or the code) into its own file. Two providers don't justify a shared `selector-tiers.js` abstraction; a third provider might. The current state is "duplication over premature abstraction" — acceptable, but the trade-off is real.
- **`shared.js` DSC.ERR is a mirror of `src/errors.js` CODES, not an import.** A new error code requires updating both files. The multi-provider refactor added `INVALID_RESPONSE_FORMAT` to both; the mirror is checked by a test that asserts the key sets match. But the mirror exists because `shared.js` is a classic script and can't `require()` the Node module — a Manifest V3 constraint, not a design choice.
- **Provider-specific error codes.** `deepthink_enable_failed` and `search_enable_failed` apply to DeepSeek; `invalid_response_format` may apply to provider response extraction. Integrators should use the current registry in `error-codes.md`.

### Neutral

- **`selectors.js` is now DeepSeek-specific, not provider-neutral infrastructure.** This is documented in the file's header, and `providers/qwen.js` ignores it entirely. The alternative — extract the tier-list pattern into a shared `selector-tiers.js` with per-provider config — was deferred because two providers don't justify the abstraction.
- **The provider names are case-sensitive.** `'deepseek'`, not `'DeepSeek'`. `DSC_PROVIDERS[msg.provider]` is a JavaScript object key lookup. No normalization at intermediate layers — a caller typo produces `no_provider_loaded`, which is the correct behavior (silent normalization would hide the typo).

## Alternatives considered

**Alternative 1 — Feature flags inside a monolithic `content.js`.**

```js
if (provider === 'deepseek') {
  // all DeepSeek logic
} else if (provider === 'qwen') {
  // all Qwen logic
}
```

Rejected for four reasons:

1. **Linear growth.** Every function in `content.js` would need dual branches. Three providers = three branches per function. The codebase grows linearly with provider count.
2. **Interleaving.** The provider-specific logic would be interleaved with the router code. Reading `content.js` to add a provider would mean parsing hundreds of lines of other providers' logic to find where to insert.
3. **Testability.** A monolithic `content.js` with provider branches would need to load both providers' DOM fixtures to test either. The current design lets each provider's tests be independent.
4. **Qwen was a significant codebase.** Qwen's provider needed ~230 lines (age modal dismisser, pacing sleeps, strict delimiter loop, self-contained selectors). Doubling `content.js` from ~40 to ~600 lines was unappealing, especially given the maintenance cost when either provider redesigns.

**Alternative 2 — Class inheritance.**

```js
class Provider { async ensureChat(name) {} async sendPrompt(prompt) {} /* ... */ }
class DeepSeekProvider extends Provider { /* ... */ }
class QwenProvider extends Provider { /* ... */ }
```

Rejected for three reasons:

1. **Manifest V3 content scripts are classic scripts, not modules.** `import`/`export` don't work in content scripts without a bundler, and adding a bundler is against the project's hard constraint (no build step). The class approach requires either a bundler (rejected) or `globalThis` tricks that end up looking like the registry anyway.
2. **The implicit interface has to be maintained in two places.** The base class defines the abstract methods, and each subclass has to implement them. A mismatch between what the base class expects and what a subclass provides is a runtime error, not a compile-time error. The registry approach has one place — the `PROVIDER CONTRACT` comment — and if a provider doesn't implement a method, the router throws a `TypeError` that names the missing method.
3. **Two providers don't justify the abstraction.** A registry is 10 lines of code; a class hierarchy is 200 lines of scaffolding for 30 lines of shared behavior. The math flips at three or four providers, at which point the abstraction might earn its keep. Two is not enough.

**Alternative 3 — Separate content script per provider, dispatched by manifest.**

```json
{
  "matches": ["https://chat.deepseek.com/*"],
  "js": ["providers/deepseek.js", "content.js"]
},
{
  "matches": ["https://chat.qwen.ai/*"],
  "js": ["providers/qwen.js", "content.js"]
}
```

Rejected because:

1. **Background would need to know which content script is injected where.** `manifest.json`'s `content_scripts` array handles this at load time, but background would still need to correlate tab IDs with provider names — the same coordination problem `DSC.PROVIDER_DOMAINS` solves, just moved one layer up.
2. **The router pattern is more flexible.** One content script that dispatches by provider name supports modes the per-script pattern doesn't — for example, a future "cross-provider orchestration" mode where one tab drives two providers sequentially. The router is provider-agnostic; it doesn't care that each provider is loaded in a specific context.
3. **The registry is simpler.** A single `content_scripts` entry with `shared.js → selectors.js → providers/*.js → content.js` load order, and a single `sendToTab` re-injection list, versus N entries each with their own list. The current design has one list to keep in sync, not N.

**Alternative 4 — Do nothing, route all sources to DeepSeek, skip on rate limit.**

Rejected because it doesn't solve the actual problem. A 76-source batch against DeepSeek's free tier hits the rate limit around source 40-50. Skipping the rate-limited sources means the batch produces ~30-40 fewer extractors than it should. The wizard's purpose is to onboard sources, not to onboard half of them. The multi-provider refactor was driven by a real batch failure mode, not an aesthetic preference for modularity.

**Alternative 5 — Do nothing, wait for DeepSeek's rate limit to clear.**

Rejected because the rate window is unknown (could be 30 minutes or 3 hours depending on the account), and waiting wastes the interactive time budget. The whole point of the batch pipeline is to compress 2-3 hours of interactive work into 20-30 minutes; a batch that pauses for 3 hours per rate limit is worse than the clipboard loop it replaced.

## References

- [architecture.md#8-plugin-registry-over-feature-flags](../architecture.md#8-plugin-registry-over-feature-flags) — the decision in prose, with the failure modes each alternative would produce
- [providers.md](../providers.md) — the how-to for adding a provider, with the registration checklist and the Qwen case study
- [protocol.md#provider-threading](../protocol.md#provider-threading) — the field's path through every layer
- [error-codes.md#registered-codes](../error-codes.md#registered-codes) — registered error metadata
- [selector-maintenance.md#deepseek-selectors](../selector-maintenance.md#deepseek-selectors) and [#qwen-selectors](../selector-maintenance.md#qwen-selectors) — the per-provider selector strategies
- `shared.js` — the `PROVIDER CONTRACT` comment block (the spec in code)
- `content.js` — the router (~40 lines, the only file that dispatches by provider name)
- `providers/deepseek.js` — DeepSeek's implementation (pre-refactor content.js, unchanged in behavior)
- `providers/qwen.js` — Qwen's implementation (self-contained, reference for a new provider)
- `background.js#getWorkTab` — provider-scoped tab selection
- `background.js#sendToTab` — the re-injection list that must include every provider