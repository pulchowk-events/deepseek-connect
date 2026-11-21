# 0006 — Answer-block extraction over whole-message extraction

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** —

## Context

DeepSeek with DeepThink enabled produces an assistant message with two parts: a collapsible "Thought for N seconds" section that contains the reasoning trace, and a final answer below it. Both are visible; only the answer is the "reply" the caller wants.

Extracting the answer correctly is non-trivial because both parts are rendered as `.ds-markdown` elements, and the reasoning appears first in document order.

## Decision

Target `.ds-assistant-message-main-content` specifically — the element that contains only the final answer. The full extraction logic in `lastAssistantText`:

1. Look for `.ds-assistant-message-main-content` inside the last assistant message.
2. If not found (mock page, older DeepSeek), fall back to the last `.ds-markdown` that is **not** inside a `[class*="think"]` parent.
3. If still not found, return the whole message.

The stream loop's `answerStarted` flag gates on `.ds-assistant-message-main-content` appearing. The `reasoning` phase (before `answerStarted`) logs the message's growing length as telemetry but does not count toward the stability check that triggers `replyDone`.

## Consequences

### Positive

- **Correct content.** The reply is the answer, not the reasoning. A caller sending "Reply with exactly: console.log(42);" gets `console.log(42);`, not "The user wants me to reply with exactly that content. Just output it verbatim."
- **Completion detection is correct.** The reasoning stream stabilizes 1-2 seconds before the answer starts streaming. If the completion detector tracked "the whole message's text content," it would fire on reasoning stabilization and return the reasoning as the answer. The `answerStarted` gate prevents this.
- **Delimiter extraction works.** The delimiters (`START_*` / `END_*`) appear in the answer, not the reasoning. Extracting from the answer means delimiter extraction finds them; extracting from the whole message means it finds the reasoning's discussion of the delimiters (if any) before the actual answer.

### Negative

- **Selector dependency.** The extraction depends on `.ds-assistant-message-main-content` and `[class*="think"]` — both are semantic-ish class names that DeepSeek could rename. If they do, extraction falls back to whole-message and the reasoning-as-answer bug returns. This is tracked in [selector-maintenance.md](../selector-maintenance.md).
- **Mock page divergence.** The mock page (`tests/mock-deepseek.html`) doesn't have a `.ds-assistant-message-main-content` element — its assistant message is just a `.assistant` div with a code block. The fallback path handles this, but it means the mock page never exercises the primary extraction path. Testing the primary path requires real DeepSeek.
- **Answer-not-yet-present race.** Between `firstMsg` and `answerStarted`, `.ds-assistant-message-main-content` doesn't exist yet. The `lastAssistantText` function returns null during this window. The stream loop handles this with the `if (!hasAnswer) continue` check, but it means the extraction can't run on a message that hasn't started answering yet — which is correct, but means the caller can't inspect partial reasoning.

### Neutral

- The reasoning trace is still accessible via `last.textContent` for debugging — the `reasoning` phase logs its length. The full reasoning isn't returned to the caller (it's not the answer), but it's available in the DOM if a debugger wants it.

## Alternatives considered

**Extract the entire `.ds-message` element's text.** Rejected because it includes the reasoning, and the reasoning frequently contains fragments that look like the answer. The specific bug that motivated this decision: a "Reply with exactly: console.log(42);" prompt returned 78 chars of "The user wants me to reply with exactly that content. Just output it verbatim." — the model's plan, not its output. Every DeepThink prompt was returning reasoning text as content.

**Extract the last `.ds-markdown` block.** Rejected because on real DeepSeek, `.ds-markdown` is *both* the reasoning block *and* the answer block — same class, different parents. A `last.querySelector('.ds-markdown')` returns the first one (reasoning), because `querySelector` returns the first match in document order, and the reasoning appears before the answer. Every attempt to fix this with `querySelectorAll` and `.slice(-1)` also failed because the reasoning's `.ds-markdown` was sometimes after the answer's in DOM order (depends on when the reasoning collapsed).

**Extract the last N characters of the whole message.** Rejected as a hack. The reasoning and answer can be different lengths, so truncating the last N chars doesn't reliably grab the answer. It works for short replies, breaks for long ones.

**Wait for the "copy" button to appear (the completion signal from the mock page).** Rejected because on real DeepSeek the copy button only appears on hover, not on completion. The mock page's completion signal doesn't exist on real DeepSeek. `.ds-assistant-message-main-content` appearing is the real signal.

**Add a marker in the prompt that the LLM should repeat before the answer.** Rejected because it adds prompt complexity without solving the extraction problem — the marker would appear in the reasoning too (the LLM discusses the marker before using it).

## References

- [architecture.md#6-answer-block-extraction-over-whole-message](../architecture.md#6-answer-block-extraction-over-whole-message)
- [architecture.md#the-two-streaming-guards](../architecture.md#the-two-streaming-guards)
- [selector-maintenance.md#deepseek-per-selector-reference](../selector-maintenance.md#deepseek-per-selector-reference)
- `content.js` `lastAssistantText`, the `answerStarted` gating in the stream loop
