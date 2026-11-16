# Selector maintenance

The recovery playbook when a provider ships a UI change and the extension starts failing with `dom_drift`, `input_not_found`, or `chat_not_found`. Both DeepSeek and Qwen redesign their chat pages roughly every 6 months — this doc exists so that the fix takes 20 minutes instead of a weekend.

**Read this when** you have a confirmed drift. If you're not sure the failure is drift, read [Is this actually drift?](#is-this-actually-drift) first — operators reflexively blame drift and waste 30 minutes when the real cause is `logged_out` or a closed tab.

**This doc is split by provider.** DeepSeek and Qwen use different selector strategies — DeepSeek uses a tiered registry in `selectors.js`, Qwen declares its selectors inline in `providers/qwen.js`. The diagnosis flow is the same for both; the fix procedure is provider-specific.

**Contents**
- [Is this actually drift?](#is-this-actually-drift)
- [Why providers are uniquely hard](#why-providers-are-uniquely-hard)
- [The tiered strategy](#the-tiered-strategy)
- [Diagnosing a drift](#diagnosing-a-drift)
- [DeepSeek selectors](#deepseek-selectors)
  - [Per-selector reference](#deepseek-per-selector-reference)
  - [The structural sidebar walk](#the-structural-sidebar-walk)
  - [Adding a DeepSeek tier](#adding-a-deepseek-tier)
- [Qwen selectors](#qwen-selectors)
  - [Per-selector reference](#qwen-per-selector-reference)
  - [Adding a Qwen tier](#adding-a-qwen-tier)
- [Testing the fix](#testing-the-fix)
- [When adding a tier isn't enough](#when-adding-a-tier-isnt-enough)
- [Historical drift incidents](#historical-drift-incidents)

---

## Is this actually drift?

Before touching any selector, confirm the failure is drift and not one of the six other causes that produce the same symptom. This is the most common time-waster in the operations runbook.

| Failure code | Drift? | How to tell |
|---|---|---|
| `logged_out` | No | Provider tab shows login screen. Log in. |
| `input_not_found` with `reason: 'no_work_tab'` | No | No provider tab is open. Open one. |
| `input_not_found` with `reason: 'no_provider_loaded'` | No | Registration bug. See [providers.md#the-registration-checklist](providers.md#the-registration-checklist). |
| `input_not_found` with empty `probe` | No | Content script didn't inject. Hard-reload the tab (Ctrl+Shift+R). |
| `input_not_found` with `probe.requiredMissing: ["input"]` | **Yes** | Input selector returned null. Drift. |
| `input_not_found` on Qwen (no `probe` field) | **Yes** (probably) | Qwen's provider doesn't emit a `probe`; the reason string is just `'input_not_found'`. F12 the tab and check whether `document.querySelector('textarea')` returns anything. |
| `input_not_found` with `probe.healthy` empty but no `requiredMissing` | No | Content script found nothing — wrong URL (not the provider's domain), or tab crashed. |
| `dom_drift` with `requiredMissing: [...]` | **Yes** | Required selector(s) failed. Drift. |
| `dom_drift` with empty `requiredMissing` | No | Probe itself threw. Check content script console for the exception. |
| `chat_not_found` | Maybe | Sidebar walk failed — but only if `debug.leafCount` is 0. If `leafCount > 0` but the chat isn't in `leafPreview`, the chat title doesn't contain the source name (matching bug, not drift; use URL-based retry instead). |
| `invalid_response_format` (Qwen) | No | Not a selector failure — the model didn't wrap its reply in the required delimiters. See [operations.md#symptom-invalid_response_format-qwen](operations.md#symptom-invalid_response_format-qwen). |
| `extension_disconnected` | No | Not connected. See [operations.md#symptom-extension_disconnected](operations.md#symptom-extension_disconnected). |

The `probe` field on the error is the primary signal for DeepSeek. It's the content script's selector-probe snapshot at failure time:

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

**Qwen doesn't emit a `probe` field.** The Qwen provider's `fail()` helper returns `{ error, reason, trace, elapsedMs }` and doesn't include a probe. If a Qwen request fails with `input_not_found` and you can see the input on the page, that's a selector issue. If you can't see the input either, it's a page-state issue (modal, wrong URL, loading). See [Qwen-specific diagnosis](#qwen-specific-diagnosis) below.

---

## Why providers are uniquely hard

Both DeepSeek and Qwen use build-hashed class names. Every element that does anything is classed with a build artifact that changes on every deploy:

**DeepSeek:**
```html
<div class="dc04ec1d">                    <!-- sidebar container -->
<div class="c08e6e93">                    <!-- chat title -->
<div class="_7b40dad dc1f7bee _4bcc731">  <!-- "New chat" button -->
<span class="_9d8da05">mercury</span>     <!-- profile name -->
```

**Qwen:**
```html
<div class="qwen-chat-message">           <!-- message wrapper (stable!) -->
<textarea class="message-input-textarea"> <!-- input (stable!) -->
<div class="chat-message-input-fixed">    <!-- send button wrapper (stable!) -->
```

Interesting difference: **Qwen's class names are actually more stable than DeepSeek's.** Qwen uses `qwen-chat-message`, `message-input-textarea`, `chat-message-input-fixed` — these are semantic, not build-hashed. DeepSeek uses build artifacts (`dc04ec1d`, `c08e6e93`) that rotate on every deploy.

That said, Qwen still isn't guaranteed stable. A redesign could add hashes, rename classes, or restructure the DOM. The tiered strategy still applies, just with fewer tiers needed because the first tier (a semantic class name) tends to work.

Compare to a typical site where the sidebar might be `<aside class="chat-sidebar">` — the class name is a *design decision* (it names the role of the element) and stays stable across deploys. DeepSeek's build pipeline strips that information. Qwen's doesn't (yet).

The tiered strategy is a response to this. It cannot rely on class names (for DeepSeek) or on class names surviving a redesign (for Qwen), so it relies on the three things that *do* survive a redesign:

1. **Text content.** "New chat" is still "New chat" after a class rename. Chat titles are still the chat titles.
2. **Structural position.** The input box is still at the bottom of the chat area. The send button is still adjacent to it. A structural walk up from a stable anchor (the "New chat" text) still finds the sidebar container.
3. **`aria-` attributes.** Both providers have so far preserved `aria-label`, `aria-pressed`, `role` on interactive elements — those are accessibility contracts, harder to change than a build hash.

The tiered strategy tries each anchor type in priority order. The tier list for each selector is a record of what's been observed to survive which kind of redesign.

---

## The tiered strategy

`selectors.js` exposes one function that matters for maintenance:

```js
DSC_SELECTORS.resolve(name)  // returns { el, kind, tier, tried }
```

`name` is a key in the selector table (see [per-selector reference](#deepseek-per-selector-reference) below). Each key has a **tier list** — an ordered array of `{ try, kind }` objects:

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

**Adding a new tier is the fix for 95% of drifts.** See [Adding a DeepSeek tier](#adding-a-deepseek-tier) or [Adding a Qwen tier](#adding-a-qwen-tier). The other 5% require a structural rewrite — see [When adding a tier isn't enough](#when-adding-a-tier-isnt-enough).

**Qwen uses a different pattern.** `providers/qwen.js` has its own `selectors` object with three functions:

```js
selectors: {
  input: function () {
    return document.querySelector('textarea.message-input-textarea') ||
           document.querySelector('textarea');
  },
  sendButton: function () { ... },
  assistantMessages: function () { ... },
}
```

The two-tier pattern (primary + fallback) is baked into the functions themselves, not into an array. See [Qwen selectors](#qwen-selectors) below.

---

## Diagnosing a drift

The fastest way to see what's broken is to run the content script's selector resolution in the specific provider's tab console.

### DeepSeek diagnosis

In the DeepSeek tab's console (F12):

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

The output is one entry per selector. For each:

- `found: true, kind: 'healthy'` — preferred tier. Good.
- `found: true, kind: 'degraded' | 'fragile'` — fallback tier. Works but fragile. Worth fixing so the fallback stays a fallback.
- `found: false` — every tier failed. **This is the drift.** The `tried` array shows which selectors were attempted.

**If `DSC_SELECTORS` is undefined**, the content script didn't inject. Hard-reload the tab (Ctrl+Shift+R) and re-run.

### Qwen diagnosis

Qwen doesn't use `DSC_SELECTORS` — its selectors are in `providers/qwen.js`. The diagnosis runs the same selector functions directly:

```js
// F12 in the Qwen tab
(() => {
  const provider = globalThis.DSC_PROVIDERS && globalThis.DSC_PROVIDERS['qwen'];
  if (!provider) return { error: 'qwen provider not registered', registeredProviders: Object.keys(globalThis.DSC_PROVIDERS || {}) };

  const out = {};
  for (const [name, fn] of Object.entries(provider.selectors)) {
    try {
      const el = fn();
      out[name] = el ? {
        found: true,
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 80),
        text: (el.textContent || '').trim().slice(0, 40),
        visible: !!(el.offsetWidth && el.offsetHeight),
        disabled: !!el.disabled,
      } : { found: false };
    } catch (e) {
      out[name] = { error: String(e && e.message || e) };
    }
  }

  // Also check the current page state
  out._page = {
    href: location.href,
    hostname: location.hostname,
    title: document.title,
    textareaCount: document.querySelectorAll('textarea').length,
    buttonCount: document.querySelectorAll('button').length,
  };
  return out;
})()
```

The output tells you:

- `input.found: false` — the input selector failed. This is the drift.
- `input.found: true, visible: false` — the input exists but is hidden (behind a modal, or scrolled out of view). Not a selector issue — see [Qwen's age modal](#symptom-qwens-age-modal-keeps-appearing) in the operations runbook.
- `sendButton.found: false` — the send button selector failed. Drift.
- `_page.textareaCount: 0` — there's no textarea on the page at all. Either wrong URL, or Qwen redesigned to use `<div contenteditable>`. If `textareaCount` is 0 but the page is on `chat.qwen.ai`, that's a redesign.

### Qwen-specific diagnosis

Qwen's failures often look like selector failures but aren't. Run this before assuming drift:

```js
// F12 in the Qwen tab
(() => {
  return {
    url: location.href,
    hasAgeModal: !!document.querySelector('.ant-modal-container.qwen-chat-v2-modal-container'),
    otherModals: Array.from(document.querySelectorAll('.ant-modal-container')).map(el => String(el.className).slice(0, 80)),
    inputSelectors: {
      primary: !!document.querySelector('textarea.message-input-textarea'),
      fallback: !!document.querySelector('textarea'),
    },
    sendButtonSelectors: {
      wrapper1: !!document.querySelector('.chat-message-input-fixed button'),
      wrapper2: !!document.querySelector('.message-input-wrapper button'),
      fallback1: !!document.querySelector('button.send-button'),
      fallback2: !!document.querySelector('button[type="submit"]'),
    },
    inputVisible: (() => {
      const input = document.querySelector('textarea');
      if (!input) return false;
      const r = input.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
  };
})()
```

Interpreting the output:

- `hasAgeModal: true` — the age modal is present. The provider's `dismissAgeModal()` should be clicking it; if the batch is stuck, the modal's "Continue" button might have a different label or class. Not a selector-maintenance issue — see [Qwen's age modal keeps appearing](#symptom-qwens-age-modal-keeps-appearing).
- `otherModals` non-empty — Qwen shows a modal the provider doesn't know about. Add it to `dismissAgeModal()`'s hunt list.
- `inputSelectors.primary: false` AND `inputSelectors.fallback: false` — there's no textarea on the page. Either wrong URL, or Qwen redesigned to use contenteditable.
- `inputVisible: false` — the textarea exists but is hidden. Almost always the age modal.
- All send button selectors `false` — the send button has moved. This is a real drift.

### Finding the new selector

Once you've confirmed drift, use F12's element inspector to find what changed.

**DeepSeek:**

1. Right-click the broken element (input box, send button, etc.) → **Inspect**
2. The element is highlighted in DevTools. Note its tag, attributes, `aria-label`, and its parent chain
3. Look for stable anchors: text content, `aria-label`, `role`, `data-*` attributes, position relative to a stable sibling

**Qwen:**

Same process. But also check whether the broken selector is *the* element or *near* it — Qwen's React structure sometimes re-parents elements, so the same element may exist under a different wrapper.

**Do not use the class name as the fix** (for DeepSeek). Even if you find `class="c08e6e93"` on the target, that hash changes on every deploy. It's a valid selector for confirming the element *today* but useless as a fallback tier.

For Qwen, class names are *sometimes* stable (`qwen-chat-message`, `message-input-textarea`), but don't count on it. Use them as the primary tier but always have a text-content or structural fallback.

Good anchors, in order of stability:

1. **`aria-label`, `role`, `aria-pressed`** — accessibility contracts. Both providers have preserved these so far.
2. **Text content** — "New chat" is still "New chat". Chat titles are chat titles. Slower (requires walking children) but survives.
3. **Structural position** — "the textarea inside the element that also contains a `[aria-label*='send']` button" is a structural relationship, stable across class renames.
4. **DOM order** — "the second textarea on the page" is the last resort. Breaks if the provider adds a third.

Class names are not on this list for DeepSeek. For Qwen, they're a *soft* anchor — useful when present, never the only anchor.

---

## DeepSeek selectors

DeepSeek's selectors live in `selectors.js` and are resolved via `DSC_SELECTORS.resolve(name)`. The tiered list pattern is documented above.

### DeepSeek per-selector reference

**Required selectors** — the content script's `probeDom()` fails `dom_drift` if any of these return null:

#### `input`

The chat input box.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `textarea[placeholder*="message" i]` | healthy | Placeholder text has been stable for ~18 months |
| 1 | `textarea:not([readonly])` | degraded | First writable textarea on the page. Fragile if DeepSeek adds a second (search bar, etc.) |
| 2 | `[aria-label*="send" i]` parent → `textarea` | fragile | Structural: the send button's parent container holds the input |

**Why three tiers:** tier 0 covers current DeepSeek (a `<textarea>` with a "Message DeepSeek..." placeholder). Tier 1 catches the case where DeepSeek renames the placeholder (rare). Tier 2 catches the case where DeepSeek changes the input element type — if it becomes `<div contenteditable>`, tiers 0 and 1 both fail and tier 2 finds it via the send button.

**If all three fail:** the input has moved. Look at the element in DevTools. If it's still a `<textarea>`, tier 0's placeholder changed — update the placeholder string. If it's now a `<div contenteditable="true">`, add a new tier 0 for `[contenteditable="true"]`.

#### `sendButton`

The button that submits the prompt.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `[aria-label*="send" i]` | healthy | Has matched since ~Feb 2025 |
| 1 | `button[type="submit"]` | degraded | Standard form submit button |
| 2 | Text content `/send/i` on `button, [role="button"]` | fragile | Slow walk; works if the aria-label changed |

#### `toggleDeepThink`

The DeepThink toggle. **Required** — if not verifiable on, `deepthink_enable_failed`.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | Text content `/deepthink/i` on `button, [role="button"], [aria-pressed]` | healthy | Text match is the most stable anchor |
| 1 | `[aria-label*="deepthink" i]` | degraded | If the text label disappears but the aria-label survives |
| 2 | `[class*="deepThink" i]` or `[class*="reasoning" i]` | fragile | Only if DeepSeek exposes these in the class name (currently doesn't, but reserved) |

**Verifying "on":** after resolving the element, the content script checks `aria-pressed === 'true'` or a visible "on" indicator. If the element resolves but the "on" state can't be verified, that's still `deepthink_enable_failed` — the fix is to add a tier that can read the state, not just find the element.

#### `toggleSearch`

The Search (web search) toggle. Same tier structure as `toggleDeepThink`, with `/search/i` and `[aria-label*="search" i]`.

### DeepSeek optional selectors

**Optional selectors** — used for chat lifecycle, not required for a send:

#### `newChatButton`

The "New chat" button. **Optional** — used only as the anchor for the sidebar walk (see below). If it's missing, the sidebar walk falls back to `aside, nav, [class*="sider" i]`.

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | Text content `/^new chat$/i` on `button, a, [role="button"]` | healthy | Exact text match; anchored to the root of the button |
| 1 | `[aria-label*="new chat" i]` | degraded | If the visible text changes but the aria-label survives |

**Note:** this selector is not actually used to *click* new chat — URL navigation is the current path (see [architecture.md#5-url-navigation-over-new-chat-button](architecture.md#5-url-navigation-over-new-chat-button)). It's used only as the anchor for `findSidebarContainer()`, which walks up from this element to find the sidebar's bounding box.

#### `chatList`

The sidebar chat list. **Optional** — if it returns an empty array, `findChatInSidebar` fails and `/open` returns `existing: false` every time. But with URL-based retry (v0.2.0+), this is no longer the primary mechanism — it's a fallback.

**This is not a `resolve` selector.** It's a function call that returns an array. Two tiers:

| Tier | Function | Kind | Notes |
|---|---|---|---|
| 0 | `Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]'))` | healthy | Works on older DeepSeek and on the mock page. Current DeepSeek: returns 0 (chat entries aren't anchors) |
| 1 | structural walk from "New chat" text | degraded | The current production path. See [The structural sidebar walk](#the-structural-sidebar-walk) |

**Tier 0 returns 0 on current DeepSeek** — this is expected, not a bug. It's kept as tier 0 because the mock page and older DeepSeek versions still match it.

#### `headerTitle`

The current chat's title, shown in the page header. **Optional** — currently used only for the `renameCurrentChat` helper, which is not exercised in v0.2.0 (rename is deferred).

| Tier | Selector | Kind | Notes |
|---|---|---|---|
| 0 | `header h1` | healthy | Probing currently reports this as `degraded` or missing |
| 1 | `#chat-title` | degraded | Legacy ID, reserved |
| 2 | `[class*="title" i]` inside `header` | fragile | Last resort |

**This selector is not load-bearing in v0.2.0.** If it breaks, nothing breaks.

### The structural sidebar walk

The sidebar is the one DeepSeek selector that isn't a `querySelector` — it's a three-function walk. It's the hardest selector to maintain because there's no single string to update. If it breaks, you need to understand the walk.

**But — the walk is now a fallback, not the primary mechanism.** URL-based retry (v0.2.0+) makes the sidebar walk less critical. A failed walk means "the first send per source opens a fresh chat, and retries use the URL" — annoying but not blocking. The fix for a broken walk is lower priority than a broken `input` selector.

#### The three functions

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

Chat title is often a `<div>` inside a clickable `<div>` (no role, no tag). `cursor: pointer` is the current heuristic for "this is clickable." Walk up 5 levels; if nothing clickable is found, return the leaf.

#### How to debug a broken walk

```js
// In the DeepSeek tab console

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
- `{err: 'no tall-narrow ancestor found'}` — the container's dimensions changed. Update the `400/100/500` thresholds in `findSidebarContainer`.

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
- `{count: 0}` — the filter caught everything. Chat row dimensions changed, or the leaf structure changed.

### Adding a DeepSeek tier

Six steps, ~20 minutes total.

#### 1. Get the element's properties from DevTools

In the DeepSeek tab, F12, inspect the broken element. Note:

- Tag name (`TEXTAREA`, `BUTTON`, `DIV`)
- All `aria-*` attributes
- Text content (if the element has text)
- Position relative to stable siblings (does it have a `[aria-label]` neighbor? a `type="submit"` neighbor?)
- Whether it has `role` or `contenteditable`

**Do not use the class name.** Even if you find one that looks semantic, DeepSeek's build pipeline hashes classes.

#### 2. Write the new selector as a function

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

#### 3. Test in the DeepSeek tab's console

Before editing the file, test the new `try` function in the console:

```js
// Paste your new try function here and check the output
(() => document.querySelector('[data-testid="chat-input"]'))()
// Expected: the textarea element, or null if the selector is wrong
```

If it returns `null`, the selector is wrong. Iterate until it returns the right element.

If it returns the *wrong* element (e.g. the search bar instead of the chat input), refine the selector. The tier should return the input box, not the first `textarea` on the page.

#### 4. Update `selectors.js`

Add the tier to the appropriate list. Run `node --check selectors.js` to verify syntax:

```bash
cd ~/deepseek-connect && node --check selectors.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`.

#### 5. Reload and re-test

Reload the extension (brave://extensions → reload button), then hard-reload the DeepSeek tab (Ctrl+Shift+R). Re-run the diagnostic snippet from [DeepSeek diagnosis](#deepseek-diagnosis):

```js
(() => {
  const r = globalThis.DSC_SELECTORS.resolve('input');
  return { found: !!r.el, kind: r.kind, tier: r.tier };
})()
```

Expected: `{ found: true, kind: 'fragile', tier: 3 }` — the new tier was reached and returned an element.

If `found: false`, the new tier's `try` function returned null even though the console test showed it should work. Most likely cause: the selector runs in a different context (the content script's isolated world) where some globals behave differently. Check the content script console (not the page console) via brave://extensions → service worker link → Console tab, and look for errors from your `try` function.

#### 6. Commit the fix

```bash
cd ~/deepseek-connect
git add selectors.js
git commit -m "fix(selectors): add tier for <selector-name> after <date> drift

DeepSeek changed <what changed>. The existing tiers all return null;
the new tier finds the element via <what anchor>.

Tested in production with one prompt round-trip."
```

The commit message is the historical record. When the next drift happens on the same selector, the git log shows "here's what broke last time, here's how it was fixed."

---

## Qwen selectors

Qwen's selectors live in `providers/qwen.js` as a `selectors` object with three functions. The structure is different from DeepSeek's — two-tier fallbacks are baked into the functions themselves, not into an array.

### Qwen per-selector reference

#### `input`

The chat input textarea.

```js
input: function() {
  return document.querySelector('textarea.message-input-textarea') ||
         document.querySelector('textarea');
}
```

Two tiers, inline:

1. `textarea.message-input-textarea` — semantic class name, has been stable since Qwen launched
2. `textarea` — first textarea on the page, as a fallback

**Why only two tiers:** Qwen's class name is semantic (not build-hashed), so tier 1 has been stable. The fallback to bare `textarea` catches the case where the class name changes. Two tiers are usually enough for Qwen; DeepSeek needs more because its class names rotate.

**If both fail:**

- Check `document.querySelectorAll('textarea').length` in the console. If it's 0, Qwen redesigned the input element type — likely to `<div contenteditable>`. Add that as a third tier.
- If it's > 0 but the visible one isn't matching, check visibility filters. Qwen's textarea might be hidden behind a modal.

#### `sendButton`

The send button. More complex — Qwen's send button has no stable aria-label, so the selector is structural.

```js
sendButton: function() {
  const wrapper = document.querySelector('.chat-message-input-fixed, .message-input-wrapper');
  if (wrapper) {
    const buttons = wrapper.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (visible(btn) && !btn.disabled) return btn;
    }
  }
  return document.querySelector('button.send-button') || document.querySelector('button[type="submit"]');
}
```

The strategy: find the wrapper container (`.chat-message-input-fixed` or `.message-input-wrapper`), then return the first visible, non-disabled button inside it. This filters out the sidebar toggle, upload button, and other buttons that share the wrapper.

**Why structural:** Qwen's send button has no aria-label and no stable text content. Its only stable property is position — it's inside the message input wrapper, alongside the textarea. The wrapper has a semantic class (`.chat-message-input-fixed`), so the walk anchors on that.

**If both fail:**

- Check `.chat-message-input-fixed` and `.message-input-wrapper` in the console. If neither exists, Qwen renamed the wrapper. Find the new wrapper class via the element inspector.
- Check `button.send-button` and `button[type="submit"]` — the fallbacks. If neither exists, Qwen's send button is now a `<div role="button">` or similar. Add it as a fallback.

#### `assistantMessages`

The assistant's message elements. Qwen uses multiple possible classes.

```js
assistantMessages: function() {
  return Array.from(document.querySelectorAll('.qwen-chat-message.qwen-chat-message-assistant, .qwen-chat-message'));
}
```

Two tiers:

1. `.qwen-chat-message.qwen-chat-message-assistant` — specific class combination
2. `.qwen-chat-message` — general message class

**Why the fallback:** the assistant-specific class has been stable, but Qwen sometimes doesn't tag assistant messages with it (depends on whether the message is still streaming). The bare `.qwen-chat-message` is a superset; the Qwen provider's `sendPrompt` filters by taking the *last* message that matches, which is the assistant's.

**If both fail:**

- Check `.qwen-chat-message` in the console. If it's 0, Qwen redesigned the message class. Find the new one via the element inspector.
- If `.qwen-chat-message` returns elements but they're not messages, Qwen added a wrapper with the same class. Refine the selector to be more specific.

### Adding a Qwen tier

Simpler than DeepSeek — Qwen's selectors are functions, so adding a tier is one line per function.

#### 1. Get the element's properties from DevTools

Same as DeepSeek — tag, attributes, text content, position. But for Qwen, **the class name IS a valid anchor** if it's semantic (not build-hashed). Check by looking at whether the class looks like a name (`qwen-chat-message`) or a hash (`_7b40dad`). Semantic → use it. Hash → skip it.

#### 2. Update the selector function

Open `providers/qwen.js`. Find the broken selector. Add a fallback before the current last fallback (or after, depending on priority):

```js
input: function() {
  return document.querySelector('textarea.message-input-textarea') ||
         // NEW tier — before the bare textarea fallback
         document.querySelector('[data-testid="chat-input"]') ||
         document.querySelector('textarea');
}
```

The order of `||` chains is the tier order. Primary first, fallback last.

**Prefer semantic class names over hashes.** If the new element has `class="qwen-input-field"`, use it. If it has `class="_abc123"`, skip it.

#### 3. Test in the Qwen tab's console

Same as DeepSeek — paste the new selector into the console, verify it returns the right element:

```js
// F12 in the Qwen tab
document.querySelector('[data-testid="chat-input"]')
// Expected: the textarea, or null
```

#### 4. Update `providers/qwen.js`

Add the tier to the function. Run `node --check providers/qwen.js`:

```bash
cd ~/deepseek-connect && node --check providers/qwen.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`.

#### 5. Reload and re-test

Reload the extension, hard-reload the Qwen tab, re-run the diagnostic snippet from [Qwen diagnosis](#qwen-diagnosis).

#### 6. Commit the fix

```bash
cd ~/deepseek-connect
git add providers/qwen.js
git commit -m "fix(qwen): add tier for <selector-name> after <date> drift

Qwen changed <what changed>. The existing selectors all return null;
the new tier finds the element via <what anchor>.

Tested in production with one prompt round-trip."
```

---

## Testing the fix

Three levels of verification, in order of confidence:

**1. Console test** (step 3 above) — proves the selector reaches the element in isolation.

**2. Mock page test** — `tests/mock-deepseek.html` replicates the DOM of the pre-drift DeepSeek. Load it via `file://` and the extension should still pass all its checks. If your new tier is at the *end* of the list (correct behavior), the mock page will hit an earlier tier and never exercise your new one — the mock page proves the old tiers still work, not the new one. There is no Qwen mock page (Qwen uses different DOM); the real Qwen tab is the only test for Qwen changes.

**3. Real round-trip** — the actual proof. Reload extension + tab, then for DeepSeek:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: drift-fix-ok"}],"chat":"drift-test","provider":"deepseek"}' \
  | python3 -m json.tool
```

For Qwen:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: drift-fix-ok"}],"chat":"drift-test-qwen","provider":"qwen"}' \
  | python3 -m json.tool
```

Expected: `{ content: "drift-fix-ok", chat: "...", url: "...", elapsedMs: ... }`.

If this returns the expected content, the drift is fixed end-to-end. Check the server log to confirm which tier the resolver used (for DeepSeek only — Qwen doesn't emit a probe):

```
[HH:MM:SS]   ~ <id8> probe {"healthy":[...], "degraded":["input"], "requiredMissing":[]}
```

`degraded: ["input"]` means the input selector reached a fallback tier. That's the correct outcome after a drift.

---

## When adding a tier isn't enough

Two cases where the tiered strategy fails and you need a structural rewrite. These are rare — twice in the repo's history (both on DeepSeek; Qwen hasn't needed one yet).

**Case 1 — the element's semantic role changed.** Example: the send button changed from `<button>` to `<div role="button">`, and its aria-label was removed. Every text-and-aria anchor fails. The element is only findable by walking from the input box (structural relationship), which means the send button's selector has to reference the input selector, which breaks the "selectors are independent" invariant.

**The fix:** this requires changes to `content.js` (for DeepSeek) or `providers/qwen.js` (for Qwen), not just the selector table. The `probeDom()` function's independence assumption (each selector resolves in isolation) breaks. The new approach is a joint resolution: `resolve('sendButton', { input: resolve('input') })` — the send button's tiers receive the already-resolved input as context.

This is a significant redesign of the selector logic. Before committing to it, check whether a simpler tier is possible — walking from any stable neighbor, not specifically the input. If the send button is next to a `[role="form"]` or a `[type="submit"]` sibling, anchor on that.

**Case 2 — the sidebar walk's structure changed.** Example: the "New chat" button moved out of the sidebar (to a toolbar at the top), and the sidebar container is now a different element. `findSidebarContainer()` walks from "New chat" upward and never finds a tall-narrow container — it hits a wide toolbar instead.

**The fix:** rewrite `findSidebarContainer()` with a different anchor. Options:

- Anchor on the user's profile name (bottom of sidebar, always present)
- Anchor on the first chat title (requires having matched one, chicken-and-egg)
- Anchor on a stable container class (if any survive the redesign)

The profile anchor is usually the best fallback — the user's name is always rendered somewhere in the sidebar, it's short text, and it's at a known position (bottom of the sidebar, within 100px of the viewport bottom).

**But — the sidebar walk is now a fallback.** With URL-based retry (v0.2.0+), a broken sidebar walk means "the first send per source opens a fresh chat, and retries use the URL" — annoying but not blocking. If the walk is broken and you're tight on time, the right move might be "leave it broken, rely on URL retry, fix it when you have a spare hour" rather than "rewrite it now."

**When in doubt, prefer tiering over rewriting.** A new tier is a 20-minute fix that's reversible. A rewrite is a 2-hour fix that changes an invariant and needs the mock page updated too.

---


Record of past drifts, as a reference for what "a drift" looks like in practice.

**November 2026 — DeepSeek reasoning became a `.ds-markdown`.** DeepSeek changed the assistant message structure so that reasoning content and answer content were both `.ds-markdown` elements, with the reasoning appearing first in document order. `lastAssistantText`'s `querySelector('.ds-markdown')` returned the reasoning block, not the answer. Every DeepThink prompt extracted reasoning text as content.

*Fix:* switched `lastAssistantText` to target `.ds-assistant-message-main-content` (the answer wrapper) specifically, and added a "skip if the element is inside a `[class*="think"]` parent" fallback. Also added the `answerStarted` gating on the stream loop. Took ~2 hours.

**November 2026 — DeepSeek chat entries stopped being anchors.** DeepSeek changed the sidebar's chat entries from `<a href="/a/chat/s/...">` to `<div>` elements with click handlers. `chatList` tier 0 (anchor-based) started returning 0, and `findChatInSidebar` returned null on every call.

*Fix:* added tier 1 — the structural sidebar walk. Three new functions, ~80 lines. Took ~3 hours.

**November 2026 — DeepSeek paraphrases chat titles instead of using them literally.** A prompt starting with `reuse-test-1754824017022` became a chat titled "Alpha reply". The sidebar fuzzy match couldn't find the chat. Every retry opened a fresh chat and the LLM never saw its prior turn.

*Fix:* URL-based retry. `sendPrompt` returns the chat URL; the wizard persists it; `/open { url }` navigates directly and skips the sidebar walk. The sidebar walk remains as a fallback for the first send per source. Took ~4 hours including the schema design.

**November 2026 — Qwen's send button was structural, not labeled.** Qwen's send button has no aria-label and no stable text. The initial provider used `button[aria-label*="send"]`, which returned null. Every Qwen send failed with `send_failed`.

*Fix:* the structural send button selector — find the wrapper (`.chat-message-input-fixed`), return the first visible non-disabled button inside. Took ~1 hour (during initial Qwen provider development).

**What each incident teaches:** the drift is usually one thing changing, not a wholesale redesign. The fix is usually a new tier or a structural rewrite of one function. The diagnosis is always the same: `DSC_SELECTORS.resolve()` in the console, read the `tried` array.