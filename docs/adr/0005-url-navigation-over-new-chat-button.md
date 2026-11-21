# 0005 — URL navigation over the "New chat" button

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** —

## Context

When `ensureChat` needs a fresh chat, there are two ways to get one: click the "New chat" button in the sidebar, or navigate the tab to `https://chat.deepseek.com/`.

The button is user-facing UI, which means it's subject to every kind of redesign. The URL is a route, which is more stable but still not an API contract.

## Decision

Background navigates the work tab to `https://chat.deepseek.com/` via `chrome.tabs.update({ url: '...' })`, waits for `chrome.tabs.onUpdated` with `status: 'complete'`, waits an additional 800ms for React to mount, and retries `ensureChat` once.

The content script never clicks the "New chat" button. It returns `{ ok: false, needNewChat: true }` when it can't find a sidebar match and isn't already on `/`. Background does the navigation.

## Consequences

### Positive

- **Atomic navigation.** `chrome.tabs.update({ url: '/' })` either navigates or throws. No element to find, no "did the click register" ambiguity. The only synchronization point is `chrome.tabs.onUpdated` with `status: 'complete'`, which is a browser-level event, not a DOM-level one.
- **No selector to maintain.** The "New chat" button's selector is only used as the anchor for the sidebar walk (see [ADR 0007](0007-structural-sidebar-walk.md)). It's not used to *click* anything. So a button redesign doesn't break the fresh-chat path — it only affects the sidebar walk's anchor, which is a separate failure mode.
- **Works when the sidebar is collapsed.** When the sidebar is collapsed (narrow window, user preference), the "New chat" button might be hidden inside a hamburger menu or unmounted entirely. This was observed during development — the sidebar was `display: none` with `querySelectorAll` returning zero elements. URL navigation is unaffected.
- **Clean responsibility split.** The content script knows the DOM; it returns "I need a fresh chat." Background knows the tab; it navigates. Neither has to know the other's mechanism.

### Negative

- **Navigation is heavyweight.** A full page load is ~1-2 seconds on a cold cache, ~500ms warm. Clicking the button is ~100ms (React re-renders without a full reload). For a batch that creates 76 fresh chats, that's 40-80 seconds of cumulative navigation time.
- **State is lost on navigation.** The work tab's in-memory state (scroll position, focused element, etc.) resets. For a batch that only cares about the chat URL and the sidebar titles (both persisted by DeepSeek), this doesn't matter. For a hypothetical use case where the user is manually interacting with the tab, it would.
- **`chrome.tabs.onUpdated` might not fire on cached navigations.** If `/` is served from cache, the `status: 'complete'` event might fire before the page has actually re-rendered. The 800ms wait after `status: 'complete'` is a buffer — sometimes the buffer isn't enough on a slow machine, and the retry `ensureChat` sees a half-mounted page. Handled by the fact that `ensureChat` has its own 5-second wait for the input box.

### Neutral

- The content script's `openNewChat()` function — which would have clicked the button — still exists in the codebase for the mock page and future fallback use. It's dead code in the current flow but not removed, because a future DeepSeek redesign might make URL navigation fail (e.g., if `/` becomes a landing page rather than a fresh chat).

## Alternatives considered

**Click the "New chat" button.** Rejected because the button is fragile:

1. **Text-based match.** `findByText(document, 'button, a, [role="button"]', /new\s*chat/i)` depends on the button's text content being literally "New chat" (case-insensitive). A rename, a translation, an icon-only redesign, or a "New" prefix all break it.
2. **Build-hashed classes.** The actual button element on current DeepSeek has classes like `_7b40dad dc1f7bee _4bcc731` — build artifacts, no semantic name.
3. **Sidebar-collapsed state.** When the sidebar is collapsed, the "New chat" button might not be in the DOM at all. The click flow can't even start.
4. **Double-click risk.** If the click handler is slow to respond, the content script might click twice and produce two fresh chats. Navigation can't double-fire.

**Navigate via `location.href = '/'` from the content script.** Considered and rejected for the same reason as the button: the content script can't reliably navigate without knowing the tab's state, and `chrome.tabs.update` from background is the canonical way to change a tab's URL in MV3.

**Use DeepSeek's internal `/api/new-chat` endpoint (if one exists).** Rejected because DeepSeek's internal API is even less stable than its DOM, and it would require capturing auth cookies and replaying requests — a security and maintenance regression.

## References

- [architecture.md#5-url-navigation-over-new-chat-button](../architecture.md#5-url-navigation-over-new-chat-button)
- [protocol.md#ensurechat](../protocol.md#ensurechat)
- `background.js` `handleNext` (the `needNewChat` branch)
- `content.js` `ensureChat` — returns `needNewChat: true`
