# 0003 — One chat per source

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Amended by:** [0008 — multi-provider plugin architecture](0008-multi-provider-plugin-architecture.md)
- **Superseded by:** —

## Context

DeepSeek's chat is stateful — the LLM sees every prior turn in the current conversation. For a batch wizard, this matters: if source A's extractor fails verification and the wizard refines the prompt, the refined prompt should land in the *same* chat so the LLM can see "here's what I tried last time, here's why it failed, now fix it."

The alternative is to send every prompt in a fresh chat. That's simpler (no chat lifecycle to manage) but loses the retry-with-context benefit, which is the main reason to use a stateful LLM for batch generation.

## Decision

Each source gets its own DeepSeek chat. The chat name matches the source name. On retry, the same chat is reopened so the LLM sees its prior attempt in context.

The chat name is used in three places:

1. `POST /chat` `chat` field — the wizard sends the source name
2. `POST /open` `chatName` field — used to establish the chat before sending
3. Sidebar fuzzy match — `findChatInSidebar(name)` finds a chat whose title *contains* the source name

DeepSeek auto-names every chat from its first message. The batch prompt embeds the source name in the first line, so the auto-generated title contains it. On retry, the fuzzy match finds the chat by the source name embedded in the title.

## Consequences

### Positive

- **Retry-with-context.** Source A fails verification. Wizard refines the prompt (adds "here's the failure, fix it"). Refined prompt lands in source A's chat. LLM sees the first attempt, sees the failure evidence, produces a better second attempt. Without this, every retry is a cold start.
- **Isolation between sources.** Source A's context doesn't bleed into source B's. The LLM doesn't see A's DOM structure when generating B's extractor.
- **Context window management.** A 76-source batch would need 76 rounds of exchange in one chat. Each source's chat is one or two turns — well within any context window.
- **User can audit per source.** The sidebar shows one chat per source. If source A's extractor is broken, the user clicks the chat, sees the full conversation, understands what the LLM was thinking. Much easier than scrolling through a mega-chat.

### Negative

- **Chat lifecycle is a real feature.** `ensureChat`, `findChatInSidebar`, `findSidebarContainer`, `listChatLeafItems`, `clickableAncestor` — ~80 lines of DOM walking that wouldn't exist if every prompt was a fresh chat.
- **Auto-naming is a dependency.** The chat title must contain the source name for the fuzzy match to find it on retry. If the batch prompt's first line doesn't include the source name, the fuzzy match fails and a fresh chat is opened on every retry (breaking the retry-with-context benefit). This is a prompt-construction bug, not a code bug, but it's a coupling the design accepts.
- **Sidebar grows.** 76 sources = 76 chats in the sidebar. The user's sidebar is cluttered after a batch. Not a technical problem, but a UX one.
- **Duplicate chat titles.** If two runs use the same source name, the sidebar has two chats with the same title. `findChatInSidebar` returns the first (top of sidebar, most recent). The older chat is orphaned.

### Neutral

- The design explicitly does *not* try to reuse a chat across batch runs. Each run creates new chats. If the user wants to retry a source from a prior run, they use the prior run's `needs-review` output, not this repo's chat lifecycle.

## Alternatives considered

**One chat for the whole batch.** Rejected for two reasons:

1. **Context window fills up.** 76 rounds of exchange would push against DeepSeek's context limit. Even if it fits, the LLM's attention degrades on long contexts — the 60th source's prompt gets worse quality than the 1st's.
2. **Cross-contamination.** The LLM sees the previous source's extractor code and, when asked for the new source's extractor, sometimes copies patterns from the previous site's DOM. This produces extractors that reference selectors that don't exist on the new site — silent bugs that pass verification by coincidence.

**Fresh chat per prompt, no reuse.** Rejected because it loses the retry-with-context benefit. The whole reason a batch wizard refines a prompt is because the LLM's first attempt failed *in a specific way* — without that context, the refined prompt is just a longer prompt with the same chance of failure.

**Rename the chat via the three-dot menu after creation.** Considered and deferred. The rename flow requires four selectors (menu trigger, rename menu item, rename input, submit), each build-hashed and breakable. Auto-naming produces a title that contains the source name (because the prompt does), which is sufficient for fuzzy match. Rename is a future improvement that would eliminate the "auto-named title happens to contain the source name" dependency, but it's not required for v0.1.

**URL-based chat lookup.** Rejected because DeepSeek assigns a UUID to each chat (e.g., `/a/chat/s/d3545c8f-b493-4ee3-a727-a554a3d44232`), and the UUID isn't derivable from the source name. To use URL-based lookup, we'd need to store the UUID after creating the chat — which means a persistent mapping from `sourceName → chatUrl`. That mapping is state the batch wizard would have to own, and it breaks if the chat is deleted or renamed from the UI. The sidebar fuzzy match is stateless and robust to all of those.

## References

- [architecture.md#3-one-chat-per-source](../../architecture.md#3-one-chat-per-source)
- [protocol.md#post-open](../../protocol.md#post-open)
- [selector-maintenance.md#the-structural-sidebar-walk](../../selector-maintenance.md#the-structural-sidebar-walk)
- `content.js` `ensureChat`, `findChatInSidebar`
- `background.js` `handleNext` (the `needNewChat` branch)

---

## Amendment (2026-11-16)

ADR 0008 changed the chat-identity mechanism from "sidebar fuzzy-match on chat title" to "URL-based direct navigation, with sidebar fuzzy-match as a fallback."

The one-chat-per-source principle is unchanged. What changed is how the extension finds the chat on retry:

- **Before:** `findChatInSidebar(name)` matched the chat title via substring. DeepSeek auto-named chats from the first message, and the batch prompt embedded the source name, so the title contained the source name — most of the time.
- **After:** `/chat` returns the chat URL (e.g., `https://chat.deepseek.com/a/chat/s/<uuid>`), the wizard persists it (in `chat-map.json`, keyed by `<sourceName>::<provider>`), `/open { chatName, url }` navigates directly via `chrome.tabs.update`, and the sidebar walk never runs on retry.

**Why the change:** DeepSeek paraphrases chat titles. A prompt starting with `reuse-test-1754824017022 — reply with just: alpha` became a chat titled **"Alpha reply"** — the `reuse-test-` prefix was completely dropped. No fuzzy match could find it. Every retry opened a fresh chat, the LLM never saw its prior turn, and the one-chat-per-source benefit was silently lost. Qwen paraphrases too. The sidebar title is not a stable identity mechanism; the URL is.

**What remains:** the sidebar walk is still in `ensureChat` as a fallback for the first send per source (when no URL is persisted yet). It's used to find an existing chat from a prior batch run, or to reuse a chat by name. It is no longer the primary mechanism.

**Multi-provider implications:** the `chat-map.json` keys are `<sourceName>::<provider>` pairs, not just `sourceName`, because a source can have one chat on DeepSeek and a different one on Qwen (via the provider-pivot pattern on rate limit). Each provider's URL is tracked independently.

Reversing this amendment requires reversing ADR 0008.
