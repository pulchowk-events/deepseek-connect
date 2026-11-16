# 0007 — Structural sidebar walk over class-name selectors

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** —

## Context

To find an existing chat by name (for `/open`'s fuzzy match, which is the mechanism behind [ADR 0003](0003-one-chat-per-source.md)), the extension needs to enumerate chat titles in the sidebar.

On current DeepSeek, the sidebar has no semantic classes — every element has a build-hashed class like `dc04ec1d`, `c08e6e93`, `_7b40dad`. The only stable anchors are text content and structural position.

The "obvious" selector — `querySelectorAll('a[href*="/a/chat/s/"]')` — returned 0 on real DeepSeek during development, because chat entries aren't anchors. They're `<div>` elements with click handlers.

## Decision

The sidebar is found by a three-function structural walk:

**`findSidebarContainer()`** — anchor on the "New chat" text. Walk up the parent chain until a container with `height > 400 && 100 < width < 500` is found. That's the sidebar.

**`listChatLeafItems()`** — enumerate leaf elements inside the sidebar. Filter out: section headers ("Today", "Yesterday", "Previous 7 days"), the "New chat" button itself, the profile section (bottom 80px of viewport), and anything that isn't a chat-row shape (10-60px tall, at least 30px wide, 2-200 chars of text).

**`clickableAncestor(el)`** — walk up from a chat title leaf to find the clickable wrapper. Prioritize `<a>`, `role="link"`, `role="button"`, then `cursor: pointer` as a fallback. Return the leaf if no clickable ancestor is found within 5 levels.

The "New chat" button's text is the only required anchor. If the button's text changes ("New Chat", "Create chat", etc.), the regex `/^new chat$/i` doesn't match and `findSidebarContainer()` falls back to `querySelector('aside, nav, [class*="sidebar" i]')` — which returns null on current DeepSeek, meaning the fallback doesn't help. The button's text is load-bearing.

## Consequences

### Positive

- **Stable against class renames.** Every DeepSeek build changes the class hashes. The structural walk doesn't touch class names. A class-hash change (which happens on every deploy) doesn't affect the walk.
- **Works with any number of chats.** `listChatLeafItems()` enumerates all leaf elements, filters, and returns the survivors. A sidebar with 5 chats and a sidebar with 500 chats both work — the only cost is the O(n) walk, which is ~1-2ms for 500 entries.
- **Diagnostic-friendly.** The `/open` response includes a `debug` field with `leafCount` and `leafPreview` — if the walk fails, the caller sees exactly what it saw without needing F12. This was originally a temporary debugging aid and is now a permanent part of the contract.
- **Fails predictably.** When the walk can't find the sidebar (button text changed), it returns null, and `findChatInSidebar` returns null, and `ensureChat` returns `needNewChat: true`. The failure mode is "open a fresh chat every time" — annoying but not silently wrong.

### Negative

- **O(n) walk on every `findChatInSidebar` call.** For 500 chats and 500 nested divs, that's ~500 `getBoundingClientRect()` calls per lookup. Measured at ~1-2ms — fast enough that caching isn't worth the staleness risk, but if DeepSeek's sidebar grows to thousands of chats, the walk would be perceptible.
- **Thresholds are empirical.** `height > 400`, `width 100-500`, `top < viewport - 80` — these numbers were chosen to match current DeepSeek's sidebar dimensions (~261px wide, ~1080px tall). If DeepSeek changes the sidebar width to 350px, the walk still works (350 is inside 100-500). If DeepSeek makes the sidebar wider than 500px, the walk fails. The thresholds are documented as a known maintenance point.
- **"New chat" text is load-bearing.** If DeepSeek renames the button to "Start a conversation" or an icon-only button, `findByText(/^new chat$/i)` returns null, and the walk can't find its anchor. The fallback to `aside, nav, [class*="sidebar" i]` doesn't help on current DeepSeek. This is a single point of failure, but it's more stable than any class-name alternative.
- **The mock page divergence.** `tests/mock-deepseek.html` has a sidebar with `class="sidebar"` and chat entries as `<a>` elements — the tier 0 path. The structural walk (tier 1) is never exercised on the mock page. Real DeepSeek is the only test for the walk. This means a change to `findSidebarContainer` that looks correct on the mock page could silently break on real DeepSeek.

### Neutral

- The walk is re-run on every `findChatInSidebar` call, which means a chat created 1 second ago is visible to the walk immediately — no cache invalidation problem. The cost is CPU, not staleness.

## Alternatives considered

**`querySelectorAll('a[href*="/a/chat/s/"]')`.** This is the "obvious" approach — chat entries are links, right? Rejected because on current DeepSeek, they aren't links. They're `<div>` elements with click handlers. The href-based selector returns 0 on real DeepSeek. Kept as tier 0 for backward compatibility (works on older DeepSeek and on the mock page) but never fires on the version we're actually driving.

**`querySelector('aside')`, `querySelector('nav')`, `querySelector('[class*="sidebar"]')`.** Rejected because on current DeepSeek, the sidebar container is a plain `<div class="dc04ec1d">`. No `<aside>`, no `<nav>`, no class containing "sidebar". This tier is kept as a fallback but doesn't match.

**A cached selector for the chat list container.** Considered: run the walk once, cache the resulting container element, re-use it for subsequent lookups. Rejected because the element identity isn't stable across React re-renders — a container element might be replaced (not just re-rendered) when the chat list changes, and the cached reference would be detached. Re-running the walk is cheap enough that caching is a premature optimization.

**Use DeepSeek's `/api/chat-list` endpoint (if one exists).** Rejected because it would require capturing auth cookies and replaying requests — a security and maintenance regression, same reasoning as [ADR 0005](0005-url-navigation-over-new-chat-button.md).

**Ask the user to name chats with a recognizable prefix.** Rejected as user-hostile — the whole point of auto-naming is that the user doesn't have to name chats.

## References

- [architecture.md#7-structural-sidebar-walk-over-class-names](../../architecture.md#7-structural-sidebar-walk-over-class-names)
- [selector-maintenance.md#the-structural-sidebar-walk](../../selector-maintenance.md#the-structural-sidebar-walk)
- [protocol.md#post-open](../../protocol.md#post-open) — `debug` field
- `content.js` `findSidebarContainer`, `listChatLeafItems`, `clickableAncestor`, `findChatInSidebar`
