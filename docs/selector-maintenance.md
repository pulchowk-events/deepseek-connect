# Selector maintenance

The recovery playbook when DeepSeek ships a UI change and the extension starts failing with `dom_drift`, `input_not_found`, or `chat_not_found`. DeepSeek redesigns its chat page roughly every 6 months — this doc exists so that the fix takes 20 minutes instead of a weekend.

**Read this when** you have a confirmed drift. If you're not sure the failure is drift, read [Is this actually drift?](#is-this-actually-drift) first — operators reflexively blame drift and waste 30 minutes when the real cause is `logged_out` or a closed tab.

**Contents**
- [Is this actually drift?](#is-this-actually-drift)
- [Why DeepSeek is uniquely hard](#why-deepseek-is-uniquely-hard)
- [The tiered strategy](#the-tiered-strategy)
- [Diagnosing a drift](#diagnosing-a-drift)
- [Per-selector reference](#per-selector-reference)
- [The structural sidebar walk](#the-structural-sidebar-walk)
- [Adding a new tier](#adding-a-new-tier)
- [Testing the fix](#testing-the-fix)
- [When adding a tier isn't enough](#when-adding-a-tier-isnt-enough)
- [Historical drift incidents](#historical-drift-incidents)

---

## Is this actually drift?

Before touching `selectors.js`, confirm the failure is drift and not one of the five other causes that produce the same symptom. This is the most common time-waster in the operations runbook.

| Failure code | Drift? | How to tell |
|---|---|---|
| `logged_out` | No | Work tab shows login screen. Log in. |
| `input_not_found` with empty `probe` | No | Content script didn't inject. Hard-reload the tab (Ctrl+Shift+R). |
| `input_not_found` with `probe.requiredMissing: ["input"]` | **Yes** | Input selector returned null. Drift. |
| `input_not_found` with `probe.healthy` empty but no `requiredMissing` | No | Content script found nothing — wrong URL (not `chat.deepseek.com`), or tab crashed. |
| `dom_drift` with `requiredMissing: [...]` | **Yes** | Required selector(s) failed. Drift. |
| `dom_drift` with empty `requiredMissing` | No | Probe itself threw. Check content script console for the exception. |
| `chat_not_found` | Maybe | Sidebar walk failed — but only if `debug.leafCount` is 0. If `leafCount > 0` but the chat isn't in `leafPreview`, the chat name doesn't contain the source name (matching bug, not drift). |
| `extension_disconnected` | No | Not connected. See [operations.md#symptom-extension_disconnected](operations.md#symptom-extension_disconnected). |

The `probe` field on the error is the primary signal. It's the content script's selector-probe snapshot at failure time:

```json
"probe": {
  "healthy": ["toggleDeepThink", "toggleSearch", "chatList"],
  "degraded": ["sendButton"],
  "requiredMissing": ["input"]
}
```

- `healthy` — resolved via the first tier (most stable)
- `degraded` — resolved via a fallback tier (still works, but a higher-fragility tier)
- `requiredMissing` — required selector returned null (the failure)

**Only `requiredMissing` non-empty means drift.** `degraded` non-empty is a warning — the extension works but is on a fallback. Worth fixing but not urgent.

---

## Why DeepSeek is uniquely hard

DeepSeek's DOM has no semantic class names. Every element that does anything is classed with a build artifact:

```html
<div class="dc04ec1d">                    <!-- the sidebar container -->
<div class="c08e6e93">                    <!-- a chat title -->
<div class="_7b40dad dc1f7bee _4bcc731">  <!-- the "New chat" button -->
<span class="_9d8da05">mercury</span>     <!-- the profile name -->
```

Every hash changes on every DeepSeek deploy. A selector like `.c08e6e93` works today and breaks tomorrow. This is not a stable anchor — it's a build fingerprint, and it rotates.

Compare to a typical site where the sidebar might be `<aside class="chat-sidebar">` — the class name is a *design decision* (it names the role of the element) and stays stable across deploys. DeepSeek's build pipeline strips that information. Everything is hashed.

The extension's selector strategy is a response to this. It cannot rely on class names, so it relies on the three things that *do* survive a redesign:

1. **Text content.** "New chat" is still "New chat" after a class rename. Chat titles are still the chat titles.
2. **Structural position.** The input box is still at the bottom of the chat area. The send button is still adjacent to it. A structural walk up from a stable anchor (the "New chat" text) still finds the sidebar container.
3. **`aria-` attributes.** DeepSeek has so far preserved `aria-label`, `aria-pressed`, `role` on interactive elements — those are accessibility contracts, harder to change than a build hash.

The `selectors.js` tiered strategy tries each anchor type in priority order. The tier list for each selector is a record of what's been observed to survive which kind of redesign.

---

## The tiered strategy

`selectors.js` exposes one function that matters for maintenance:

```js
DSC_SELECTORS.resolve(name)  // returns { el, kind, tier, tried }
```

`name` is a key in the selector table (see [per-selector reference](#per-selector-reference) below). Each key has a **tier list** — an ordered array of `{ try, kind }` objects:

```js
input: [
  { try: () => document.querySelector('textarea[placeholder*="message" i]'), kind: 'healthy' },
  { try: () => document.querySelector('textarea:not([readonly])'), kind: 'degraded' },
  { try: () => {
      const send = document.querySelector('[aria-label*="send" i]');
      return send?.parentElement?.querySelector('textarea');
    }, kind: 'fragile' },
]
```

`resolve('input')` walks the list in order, returns the first non-null element, and reports which tier succeeded:

- `tier: 0` → `kind: 'healthy'` (preferred selector)
- `tier: 1` → `kind: 'degraded'` (fallback)
- `tier: 2` → `kind: 'fragile'` (last resort)
- No tier matched → `tier: -1`, `el: null`

**Tiers are append-only.** A new tier is added at the *end* of the list, not inserted or reordered. The current `tier: 0` might be the fragile one next year — when it becomes fragile, you add a new tier 0 and the old one becomes tier 1. The labels `healthy`/`degraded`/`fragile` reflect *current* stability, not a permanent classification.

**The `kind` labels are advisory, not enforced.** A `resolve` that returns `kind: 'degraded'` still works — the extension proceeds, and the content script logs `{ degraded: [...] }` in the probe. The probe data is what tells you "your preferred selector broke, you're on the fallback."

**Adding a new tier is the fix for 95% of drifts.** See [Adding a new tier](#adding-a-new-tier). The other 5% require a structural rewrite — see [When adding a tier isn't enough](#when-adding-a-tier-isnt-enough).

---

## Diagnosing a drift

The fastest way to see what's broken is to run the content script's selector resolution in the work tab's console. This snippet reproduces the same logic content.js uses, so the output matches what the extension would see:

```js
(() => {
  const names = ['input', 'sendButton', 'toggleDeepThink', 'toggleSearch', 'newChatButton', 'chatList', 'headerTitle'];
  const out = {};
  for (const name of names) {
    try {
      const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve(name);
      if (!r) { out[name] = { error: 'selectors_not_loaded' }; continue; }
      out[name] = r.el ? {
        found: true,
        kind: r.kind,
        tier: r.tier,
        tag: r.el.tagName,
        text: (r.el.textContent || '').trim().slice(0, 40),
        aria: r.el.getAttribute && r.el.getAttribute('aria-label'),
        tried: r.tried,
      } : {
        found: false,
        tried: r.tried,
      };
    } catch (e) {
      out[name] = { error: String(e && e.message || e) };
    }
  }
  return out;
})()
```

Run it in the work tab's DevTools console (F12). The output is one entry per selector. For each:

- `found: true, kind: 'healthy'` — this selector is on its preferred tier. Good.
- `found: true, kind: 'degraded' | 'fragile'` — this selector is on a fallback tier. **A drift already happened; the extension is working but fragile.** Worth fixing so the fallback stays a fallback.
- `found: false` — this selector returned null from every tier. **This is the drift.** The `tried` array shows which selectors were attempted.

**If `DSC_SELECTORS` is undefined**, the content script didn't inject. Hard-reload the tab with Ctrl+Shift+R and re-run. If it's still undefined after a hard reload, the extension is broken — check its Errors panel.

**Reading `tried`:** the `tried` array is the sequence of selectors the resolver attempted and failed. It tells you exactly which selectors are now broken:

```json
{
  "input": {
    "found": false,
    "tried": [
      "textarea[placeholder*=\"message\" i]",
      "textarea:not([readonly])",
      "[aria-label*=\"send\" i] → parent → textarea"
    ]
  }
}
```

All three tiers failed. The input has moved somewhere none of the existing selectors reach. That's the diagnosis: add a tier that does reach it.

**Finding the new selector.** In the work tab, inspect the element manually. On current DeepSeek:

- Right-click the element (input box, send button, etc.) → **Inspect**
- The element is highlighted in DevTools. Note its tag, attributes, `aria-label`, and its parent chain
- Look for stable anchors: text content, `aria-label`, `role`, `data-*` attributes (unusual for DeepSeek but worth checking), position in the DOM relative to a stable sibling

**Do not use the class name.** Even if you find `class="c08e6e93"` on the target, that hash changes on every deploy. It's a valid selector for confirming the element *today* but useless as a fallback tier — it'll be dead tomorrow.

Good anchors, in order of stability:

1. **`aria-label`, `role`, `aria-pressed`** — accessibility contracts. DeepSeek has preserved these so far.
2. **Text content** — "New chat" is still "New chat". Chat titles are chat titles. Slower (requires walking children) but survives.
3. **Structural position** — "the textarea inside the element that also contains a `[aria-label*='send']` button" is a structural relationship, stable across class renames.
4. **DOM order** — "the second textarea on the page" is the last resort. Breaks if DeepSeek adds a third.

Class names are not on this list.

---

## Per-selector reference

The full selector table. Every entry corresponds to a key in `selectors.js` and a name the content script passes to `DSC_SELECTORS.resolve()`.

**Required selectors** — the content script's `probeDom()` fails `dom_drift` if any of these return null:

### `input`

The chat input box.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `textarea[placeholder*="message" i]` | healthy | Placeholder text has been stable for ~18 months |
| 1 | `textarea:not([readonly])` | degraded | First writable textarea on the page. Fragile if DeepSeek adds a second (search bar, etc.) |
| 2 | `[aria-label*="send" i]` parent → `textarea` | fragile | Structural: the send button's parent container holds the input |

**Why three tiers:** tier 0 covers current DeepSeek (a `<textarea>` with a "Message DeepSeek..." placeholder). Tier 1 catches the case where DeepSeek renames the placeholder (rare). Tier 2 catches the case where DeepSeek changes the input element type — if it becomes `<div contenteditable>`, tier 0 and 1 both fail and tier 2 finds it via the send button.

**If all three fail:** the input has moved. Look at the element in DevTools. If it's still a `<textarea>`, tier 0's placeholder changed — update the placeholder string. If it's now a `<div contenteditable="true">`, add a new tier 0 for `[contenteditable="true"]`.

### `sendButton`

The button that submits the prompt.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `[aria-label*="send" i]` | healthy | Has matched since ~Feb 2025 |
| 1 | `button[type="submit"]` | degraded | Standard form submit button |
| 2 | Text content `/send/i` on `button, [role="button"]` | fragile | Slow walk; works if the aria-label changed |

### `toggleDeepThink`

The DeepThink toggle. **Required** — if not verifiable on, `deepthink_enable_failed`.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | Text content `/deepthink/i` on `button, [role="button"], [aria-pressed]` | healthy | Text match is the most stable anchor |
| 1 | `[aria-label*="deepthink" i]` | degraded | If the text label disappears but the aria-label survives |
| 2 | `[class*="deepThink" i]` or `[class*="reasoning" i]` | fragile | Only if DeepSeek exposes these in the class name (currently doesn't, but reserved) |

**Verifying "on":** after resolving the element, the content script checks `aria-pressed === 'true'` or a visible "on" indicator. If the element resolves but the "on" state can't be verified, that's still `deepthink_enable_failed` — the fix is to add a tier that can read the state, not just find the element.

### `toggleSearch`

The Search (web search) toggle. Same tier structure as `toggleDeepThink`, with `/search/i` and `[aria-label*="search" i]`.

### `newChatButton`

The "New chat" button. **Optional** — used only as the anchor for the sidebar walk (see below). If it's missing, the sidebar walk falls back to `aside, nav, [class*="sider" i]`.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | Text content `/^new chat$/i` on `button, a, [role="button"]` | healthy | Exact text match; anchored to the root of the button |
| 1 | `[aria-label*="new chat" i]` | degraded | If the visible text changes but the aria-label survives |

**Note:** this selector is not actually used to *click* new chat — URL navigation is the current path (see [architecture.md#5-url-navigation-over-new-chat-button](architecture.md#5-url-navigation-over-new-chat-button)). It's used only as the anchor for `findSidebarContainer()`, which walks up from this element to find the sidebar's bounding box.

### `chatList`

The sidebar chat list. **Optional** — if it returns an empty array, `findChatInSidebar` fails and `/open` returns `existing: false` every time (the "fresh chat every time" bug).

**This is not a `resolve` selector.** It's a function call that returns an array. Two tiers:

| Tier | Function | Kind | Notes |
|---|---|---|---|
| 0 | `Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]'))` | healthy | Works on older DeepSeek and on the mock page. Current DeepSeek: returns 0 (chat entries aren't anchors) |
| 1 | structural walk from "New chat" text | degraded | The current production path. See [the structural sidebar walk](#the-structural-sidebar-walk) |

**Tier 0 returns 0 on current DeepSeek** — this is expected, not a bug. It's kept as tier 0 because the mock page and older DeepSeek versions still match it, and because if DeepSeek returns to anchor-based chat entries, it'll just start working again.

**The probe reports `chatList` as `healthy` even when tier 0 returns 0** — because tier 1 (the structural walk) is what's actually running. The probe's `kind` field tracks the tier that succeeded, so `chatList` showing `degraded` in the probe means the walk is in use (which is normal).

### `headerTitle`

The current chat's title, shown in the page header. **Optional** — currently used only for the `renameCurrentChat` helper, which is not exercised in v0.1 (rename is deferred, see [architecture.md#3-one-chat-per-source](architecture.md#3-one-chat-per-source)).

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `header h1` | healthy | Probing currently reports this as `degraded` or missing — the header doesn't have an h1 on current DeepSeek |
| 1 | `#chat-title` | degraded | Legacy ID, reserved |
| 2 | `[class*="title" i]` inside `header` | fragile | Last resort |

**This selector is not load-bearing in v0.1.** If it breaks, nothing breaks. When rename is implemented, it becomes required.

---

## The structural sidebar walk

The sidebar is the one selector that isn't a `querySelector` — it's a three-function walk. It's the hardest selector to maintain because there's no single string to update. If it breaks, you need to understand the walk.

### The three functions

**`findSidebarContainer()`** — returns the sidebar's bounding `<div>`.

```js
function findSidebarContainer() {
  const btn = findByText(document, 'button, div, a, span', /^new chat$/i);
  if (btn) {
    let el = btn;
    for (let i = 0; i < 10; i++) {
      const r = el.getBoundingClientRect();
      if (r.height > 400 && r.width > 100 && r.width < 500) return el;
      el = el.parentElement;
      if (!el) break;
    }
  }
  return document.querySelector('aside, nav, [class*="sidebar" i], [class*="sider" i]');
}
```

Anchor: the "New chat" text. Walk up until you hit a tall, narrow container. That's the sidebar. On current DeepSeek, this is a `<div>` at ~261px wide, 1080px tall.

**`listChatLeafItems()`** — returns an array of leaf elements that are chat titles.

```js
function listChatLeafItems() {
  const side = findSidebarContainer();
  if (!side) return [];
  const skip = /^(new chat|today|yesterday|previous \d+ days?|older|archived?)$/i;
  const out = [];
  const vh = window.innerHeight;
  for (const el of side.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || '').trim();
    if (txt.length < 2 || txt.length > 200) continue;
    if (skip.test(txt)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 10 || r.height > 60) continue;
    if (r.top > vh - 80) continue;
    out.push(el);
  }
  return out;
}
```

Iterate every leaf element inside the sidebar. Filter out:
- Section headers ("Today", "Yesterday", "Previous 7 days", etc.)
- The "New chat" button
- The profile section (bottom 80px of the viewport)
- Anything shorter than 10px or taller than 60px (not a chat row)
- Anything narrower than 30px (probably an icon)
- Empty text and very long text

What's left: chat title elements.

**`clickableAncestor(el)`** — walks up to find the clickable wrapper.

```js
function clickableAncestor(el) {
  let cur = el;
  for (let i = 0; i < 5 && cur; i++) {
    const tag = cur.tagName;
    const role = cur.getAttribute && cur.getAttribute('role');
    if (tag === 'A' || role === 'link' || role === 'button') return cur;
    try {
      if (window.getComputedStyle(cur).cursor === 'pointer') return cur;
    } catch (_) { /* detached */ }
    cur = cur.parentElement;
  }
  return el;
}
```

Chat title is often a `<div>` inside a clickable `<div>` (no role, no tag). `cursor: pointer` is the current heuristic for "this is clickable." Walk up 5 levels; if nothing clickable is found, return the leaf — the click will bubble up to whatever handler is there.

### How to debug a broken walk

Run `findSidebarContainer()` and `listChatLeafItems()` in the work tab's console:

```js
// In the work tab console

// 1. Does the container resolve?
(() => {
  const btn = Array.from(document.querySelectorAll('*')).find(
    e => e.children.length === 0 && (e.textContent || '').trim() === 'New chat'
  );
  if (!btn) return { err: 'new chat button not found' };
  let el = btn;
  for (let i = 0; i < 10; i++) {
    const r = el.getBoundingClientRect();
    if (r.height > 400 && r.width > 100 && r.width < 500) {
      return { ok: true, tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), iter: i };
    }
    el = el.parentElement;
    if (!el) return { err: 'no tall-narrow ancestor found' };
  }
  return { err: 'exceeded 10 iterations' };
})()
```

- `{ok: true, w: ~261, h: ~1080}` — the walk found the container. Sidebar is fine.
- `{err: 'new chat button not found'}` — "New chat" text changed or moved. Update `findByText`'s selector or regex.
- `{err: 'no tall-narrow ancestor found'}` — the container's dimensions changed. Update the `400/100/500` thresholds in `findSidebarContainer`. This is rare but happens if DeepSeek changes the sidebar's width or if the user has collapsed it.

```js
// 2. What leaves are found?
(() => {
  const side = (() => {
    const btn = Array.from(document.querySelectorAll('*')).find(
      e => e.children.length === 0 && (e.textContent || '').trim() === 'New chat'
    );
    let el = btn;
    for (let i = 0; i < 10 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.height > 400 && r.width > 100 && r.width < 500) return el;
      el = el.parentElement;
    }
    return null;
  })();
  if (!side) return { err: 'no sidebar' };
  const skip = /^(new chat|today|yesterday|previous \d+ days?|older|archived?)$/i;
  const out = [];
  for (const el of side.querySelectorAll('*')) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || '').trim();
    if (txt.length < 2 || txt.length > 200) continue;
    if (skip.test(txt)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 10 || r.height > 60) continue;
    if (r.top > window.innerHeight - 80) continue;
    out.push({ txt: txt.slice(0, 40), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { count: out.length, leaves: out.slice(0, 20) };
})()
```

- `{count: N, leaves: [...]}` with N > 0 — the walk found chat titles.
- `{count: 0}` — the filter caught everything. The chat rows' dimensions changed, or the leaf structure changed (chat titles might now have children). Update the filters.

---

## Adding a new tier

The correct fix for 95% of drifts. Six steps, ~20 minutes total.

### 1. Get the element's properties from DevTools

In the work tab, F12, inspect the broken element. Note:

- Tag name (`TEXTAREA`, `BUTTON`, `DIV`)
- All `aria-*` attributes
- Text content (if the element has text)
- Position relative to stable siblings (does it have a `[aria-label]` neighbor? a `type="submit"` neighbor?)
- Whether it has `role` or `contenteditable`

**Do not use the class name.** Even if you find one that looks semantic (`class="ds-input"`), DeepSeek might rename it next deploy. Use it as confirmation that you're looking at the right element, not as the selector.

### 2. Write the new selector as a function

Open `selectors.js`. Find the broken selector's tier list. Add a new tier at the **end**:

```js
input: [
  { try: () => document.querySelector('textarea[placeholder*="message" i]'), kind: 'healthy' },
  { try: () => document.querySelector('textarea:not([readonly])'), kind: 'degraded' },
  { try: () => {
      const send = document.querySelector('[aria-label*="send" i]');
      return send?.parentElement?.querySelector('textarea');
    }, kind: 'fragile' },
  // NEW tier — element moved or changed type, find via a different anchor
  { try: () => document.querySelector('[data-testid="chat-input"]'), kind: 'fragile' },
]
```

The new tier's `try` function is where you put the selector. The `kind` label reflects fragility — a new tier is always `'fragile'` until it's had a few months of stability, at which point it can be promoted (in a future commit) by reordering.

**Prefer structural `try` functions over plain `querySelector` strings.** If the new element has no stable string anchor, write a function that walks from a stable sibling:

```js
{ try: () => {
    // Find the input by: it's the textarea in the same container as the send button
    const send = document.querySelector('[aria-label*="send" i]');
    if (!send) return null;
    const container = send.closest('[class*="chat" i], form, [role="form"]') || send.parentElement;
    return container?.querySelector('textarea') || null;
  }, kind: 'fragile' }
```

Structural `try` functions survive class renames because they anchor on something stable (the send button's aria-label) rather than on the element's own properties.

### 3. Test in the work tab's console

Before editing the file, test the new `try` function in the console:

```js
// Paste your new try function here and check the output
(() => document.querySelector('[data-testid="chat-input"]'))()
// Expected: the textarea element, or null if the selector is wrong
```

If it returns `null`, the selector is wrong. Iterate until it returns the right element.

If it returns the *wrong* element (e.g. the search bar instead of the chat input), refine the selector. The tier should return the input box, not the first `textarea` on the page.

### 4. Update `selectors.js`

Add the tier to the appropriate list. Run `node --check selectors.js` to verify syntax:

```bash
cd ~/deepseek-connect && node --check selectors.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`.

### 5. Reload and re-test

Reload the extension (brave://extensions → reload button), then hard-reload the work tab (Ctrl+Shift+R). Re-run the diagnostic snippet from [Diagnosing a drift](#diagnosing-a-drift):

```js
(() => {
  const r = globalThis.DSC_SELECTORS.resolve('input');
  return { found: !!r.el, kind: r.kind, tier: r.tier };
})()
```

Expected: `{ found: true, kind: 'fragile', tier: 3 }` — the new tier was reached and returned an element.

If `found: false`, the new tier's `try` function returned null even though the console test showed it should work. Most likely cause: the selector runs in a different context (the content script's isolated world) where some globals behave differently. Check the content script console (not the page console) via brave://extensions → service worker link → Console tab, and look for errors from your `try` function.

### 6. Commit the fix

```bash
cd ~/deepseek-connect
git add selectors.js
git commit -m "fix(selectors): add tier for <selector-name> after <date> drift

DeepSeek changed <what changed>. The existing tiers all return null;
the new tier finds the element via <what anchor>.

Tested in production with one prompt round-trip."
```

The commit message is the historical record. When the next drift happens on the same selector, the git log shows "here's what broke last time, here's how it was fixed" — that's the diagnostic shortcut.

---

## Testing the fix

Three levels of verification, in order of confidence:

**1. Console test** (step 3 above) — proves the selector reaches the element in isolation.

**2. Mock page test** — `tests/mock-deepseek.html` replicates the DOM of the pre-drift DeepSeek. Load it via `file://` and the extension should still pass all its checks. If your new tier is at the *end* of the list (correct behavior), the mock page will hit an earlier tier and never exercise your new one — the mock page proves the old tiers still work, not the new one. The real test is level 3.

**3. Real round-trip** — the actual proof. Reload extension + tab, then:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: drift-fix-ok"}],"chat":"drift-test"}' \
  | python3 -m json.tool
```

Expected: `{ content: "drift-fix-ok", chat: "drift-test", elapsedMs: ... }`.

If this returns the expected content, the drift is fixed end-to-end. Check the server log to confirm which tier the resolver used:

```
[HH:MM:SS]   ~ <id8> probe {"healthy":[...], "degraded":["input"], "requiredMissing":[]}
```

`degraded: ["input"]` means the input selector reached a fallback tier. That's the correct outcome after a drift — the new tier is a fallback (tier 2 or 3), the original tiers still exist (in case DeepSeek reverts), and the extension logs "I'm on a fallback" so a future maintainer knows to eventually promote the new tier or clean up the old ones.

---

## When adding a tier isn't enough

Two cases where the tiered strategy fails and you need a structural rewrite. These are rare — twice in the repo's history.

**Case 1 — the element's semantic role changed.** Example: the send button changed from `<button>` to `<div role="button">`, and its aria-label was removed. Every text-and-aria anchor fails. The element is only findable by walking from the input box (structural relationship), which means the send button's selector has to reference the input selector, which breaks the "selectors are independent" invariant.

**The fix:** this requires changes to `content.js`, not just `selectors.js`. The `probeDom()` function's independence assumption (each selector resolves in isolation) breaks. The new approach is a joint resolution: `resolve('sendButton', { input: resolve('input') })` — the send button's tiers receive the already-resolved input as context.

This is a significant redesign of `selectors.js` and `content.js`'s probe logic. Before committing to it, check whether a simpler tier is possible — walking from any stable neighbor, not specifically the input. If the send button is next to a `[role="form"]` or a `[type="submit"]` sibling, anchor on that.

**Case 2 — the sidebar walk's structure changed.** Example: the "New chat" button moved out of the sidebar (to a toolbar at the top), and the sidebar container is now a different element. `findSidebarContainer()` walks from "New chat" upward and never finds a tall-narrow container — it hits a wide toolbar instead.

**The fix:** rewrite `findSidebarContainer()` with a different anchor. Options:

- Anchor on the user's profile name (bottom of sidebar, always present)
- Anchor on the first chat title (requires having matched one, chicken-and-egg)
- Anchor on a stable container class (if any survive the redesign)

The profile anchor is usually the best fallback — the user's name is always rendered somewhere in the sidebar, it's short text, and it's at a known position (bottom of the sidebar, within 100px of the viewport bottom). Walking *up* from the profile name to a tall-narrow container is the mirror of the "New chat" walk.

If the structural rewrite is genuinely necessary, it's a 2-hour job: write the new anchor function, update `findSidebarContainer()` to try both anchors, test on the real page, test with the mock page (which needs its DOM updated to match the new DeepSeek for the walk to work there), commit.

**When in doubt, prefer tiering over rewriting.** A new tier is a 20-minute fix that's reversible (revert the commit, you're back to the pre-drift state). A rewrite is a 2-hour fix that changes an invariant and needs the mock page updated too. Only rewrite when the tiered strategy is genuinely exhausted.

---

Record of past drifts, as a reference for what "a drift" looks like in practice. Each entry: what changed, what broke, what the fix was, how long it took.

**November 2026 — chat entries stopped being anchors.** DeepSeek changed the sidebar's chat entries from `<a href="/a/chat/s/...">` to `<div>` elements with click handlers. `chatList` tier 0 (anchor-based) started returning 0, and `findChatInSidebar` returned null on every call. `/open` reported `existing: false` on every chat, and the batch wizard opened a fresh chat for every source (breaking the retry-reuse guarantee).

*Fix:* added tier 1 — the structural sidebar walk (`findSidebarContainer` + `listChatLeafItems` + `clickableAncestor`). Three new functions, ~80 lines, plus a `debug` field on `/open`'s response so the walk's failure modes are visible without F12. Took ~3 hours including the debug payload.

**November 2026 — reasoning became a `.ds-markdown`.** DeepSeek changed the assistant message structure so that reasoning content and answer content were both `.ds-markdown` elements, with the reasoning appearing first in document order. `lastAssistantText`'s `querySelector('.ds-markdown')` returned the reasoning block, not the answer. Every DeepThink prompt extracted reasoning text as content.

*Fix:* switched `lastAssistantText` to target `.ds-assistant-message-main-content` (the answer wrapper) specifically, and added a "skip if the element is inside a `[class*="think"]` parent" fallback for the mock page. Also added the `answerStarted` gating on the stream loop — without it, the completion detector locked onto the reasoning stabilization. Took ~2 hours including the streaming guard.

**Pre-November 2026 (unrecorded)** — the initial scaffolding had several selector misses during development, before the tiered strategy existed. The tiered strategy itself was a response to discovering that naive selectors break on every deploy.

**What each incident teaches:** the drift is usually one thing changing, not a wholesale redesign. The fix is usually a new tier or a structural rewrite of one function. The diagnosis is always the same: `DSC_SELECTORS.resolve()` in the console, read the `tried` array.