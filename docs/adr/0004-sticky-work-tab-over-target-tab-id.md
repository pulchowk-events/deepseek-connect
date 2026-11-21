# 0004 — Sticky work tab over caller-supplied targetTabId

- **Status:** Superseded
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** [0008 — multi-provider plugin architecture](0008-multi-provider-plugin.architecture.md), as refined by current exact-provider tab routing

> This ADR records a superseded design, not current behavior. The extension no longer pins `chrome.storage.local.workTabId`; it requires exactly one tab matching the explicitly selected provider's exact hostname and validates any supplied `targetTabId`.

## Context

With multiple DeepSeek tabs open — which happens, the user might be chatting in one while the batch runs in another — the extension needs to pick one for automation. It must be consistent across requests, or different requests would land in different tabs.

Two options: the caller supplies a `targetTabId` on every `/chat`, or the extension picks a tab and pins it for the session.

## Decision

The extension pins exactly one DeepSeek tab in `chrome.storage.local.workTabId` on first use and reuses it for the entire session. Callers do not supply tab IDs. If a stale `targetTabId` is passed (deprecated but still accepted), the extension hard-fails with `input_not_found` rather than silently falling back to a different tab.

Selection algorithm in `getWorkTab()`:

1. If `chrome.storage.local.workTabId` exists and the tab still exists with a `chat.deepseek.com` URL, use it.
2. If the stored ID is stale, clear it and pick a fresh one.
3. Pick from `chrome.tabs.query({ url: 'https://chat.deepseek.com/*' })` — prefer the non-active tab, fall back to the first.
4. Store the picked ID in `chrome.storage.local.workTabId`.

## Consequences

### Positive

- **Consistency.** Every request in a session lands in the same tab. The queue serialization guarantee (one in-flight job) works because there's one tab to serialize against.
- **No caller state.** The wizard doesn't need to query `/tabs` before every `/chat` to get a fresh `targetTabId`. That's 76 extra round-trips per batch, avoided.
- **No stale-ID bugs.** Tab IDs change on tab close, on browser restart, on some reload paths. A caller that cached a `targetTabId` would eventually point at a wrong tab. The extension handles this internally — if the pinned tab is gone, it re-picks.
- **Hard-fail on explicit `targetTabId`.** If a caller passes a specific tab and that tab doesn't exist, failing with `input_not_found` is better than silently typing into a different chat. The caller asked for a specific tab; if it's gone, they should know.

### Negative

- **No caller override.** A caller can't say "use tab 42 for this prompt, tab 43 for the next." Every request in a session uses the same tab. For the batch wizard workflow, that's the requirement, not a limitation. For a caller who wants to parallelize across tabs, this extension isn't the right tool.
- **Session lifetime.** If the user closes the work tab mid-batch, the request now fails unless exactly one matching tab remains. See [operations.md](../operations.md).
- **Storage coupling.** `chrome.storage.local.workTabId` persists across browser restarts. After a browser restart, the stored ID is stale and the extension re-picks. This is handled but it's an extra state variable to reason about.

### Neutral

- The `targetTabId` field remains in `/chat` and `/next` for backward compatibility. It's honored if it points at a valid DeepSeek tab, hard-failed otherwise. Future versions may remove it.

## Alternatives considered

**Caller supplies `targetTabId` on every `/chat`.** Rejected because tab IDs are not stable:

1. **Tabs close and IDs are invalidated.** The caller captures a `targetTabId` once, the user closes that tab, the caller's next request fails.
2. **The caller would need to re-query `/tabs` before every request.** That's an extra round-trip per prompt — 76 per batch. The extra latency is small per request but adds up, and the extra API surface is complex for no benefit.
3. **Silent fallback on stale IDs.** If the caller passes a `targetTabId` that no longer exists, the extension could fall back to another DeepSeek tab. But then it types into a chat the user is actively reading, which is exactly the "wait, why did this text appear in my chat" bug. Hard-failing is the correct behavior.
4. **The caller and extension could disagree on which tab is "the work tab."** The caller cached tab 42; the user clicked into tab 43; the extension thinks 43 is the work tab (because it was the last active); the caller's next request targets 42, which is now stale. Coordination requires shared state, which is what the sticky approach provides without exposing it.

**Extension picks a tab on every request (no pinning).** Rejected because "first non-active DeepSeek tab" isn't stable — as the user clicks around, the active tab changes and the picked tab moves. A batch that starts on tab A ends on tab B with no code change, because the user switched tabs. Pinning removes this ambiguity.

## References

- [architecture.md#4-exact-provider-tab-routing](../architecture.md#4-exact-provider-tab-routing)
- [protocol.md#post-chat](../protocol.md#post-chat) — `targetTabId` field
- [operations.md#symptom-input_not_found](../operations.md#symptom-input_not_found)
- `background.js` `getWorkTab()`, `chrome.storage.local.workTabId`
