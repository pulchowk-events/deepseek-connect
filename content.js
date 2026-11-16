// content.js — runs inside chat.deepseek.com (and the local mock page).
// Reads DOM, finds input, types prompts, toggles DeepThink/Search, waits for
// streaming to finish, extracts reply. Classic script — relies on
// globalThis.DSC from shared.js (loaded before this file by manifest).

'use strict';

(function () {
  const DSC = globalThis.DSC;
  const log = (...a) => console.debug('[dsc]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function waitFor(fn, opts) {
    opts = opts || {};
    const timeout = opts.timeout ?? 3000;
    const interval = opts.interval ?? 100;
    const start = Date.now();
    return new Promise((resolve) => {
      (function tick() {
        let v;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      })();
    });
  }

  function findByText(root, selector, re) {
    const els = root.querySelectorAll(selector);
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (re.test(t)) return el;
    }
    return null;
  }

  function findInput() {
    return (
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function findSendButton() {
    const candidates = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && visible(el) && !el.disabled) return el;
    }
    return findByText(document, 'button', /^send$/i);
  }

  function findToggle(kind) {
    // kind: 'deepthink' | 'search'
    const re = kind === 'deepthink' ? /deep\s*think/i : /^search$/i;
    const btn = findByText(document, 'button', re) || findByText(document, '[role="button"]', re);
    if (btn) return btn;
    const attrs = kind === 'deepthink'
      ? ['[data-testid*="deepthink" i]', '[class*="deepthink" i]', '[class*="reasoning" i]']
      : ['[data-testid*="search" i]', '[class*="search" i][role="button"]'];
    for (const sel of attrs) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function toggleIsOn(el) {
    if (!el) return false;
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.classList.contains('active') || el.classList.contains('on')) return true;
    if (el.dataset && (el.dataset.state === 'on' || el.dataset.active === 'true')) return true;
    const cs = getComputedStyle(el);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
      // Heuristic only; verified again after click.
    }
    return false;
  }

  async function ensureToggleOn(kind, failureCode) {
    const el = findToggle(kind);
    if (!el) return { ok: false, error: failureCode, reason: kind + '_toggle_not_found' };
    if (toggleIsOn(el)) return { ok: true };
    el.click();
    await sleep(400);
    const el2 = findToggle(kind);
    if (!toggleIsOn(el2)) {
      return { ok: false, error: failureCode, reason: kind + '_not_on_after_click' };
    }
    return { ok: true };
  }

  function detectLoggedOut() {
    if (findInput()) return false;
    const body = (document.body && document.body.textContent) || '';
    return /log\s*in|sign\s*in|sign\s*up/i.test(body) &&
           document.querySelectorAll('input[type="password"]').length > 0;
  }

  async function checkState() {
    await waitFor(findInput, { timeout: 3000 });
    const input = findInput();
    const dt = findToggle('deepthink');
    const sr = findToggle('search');
    return {
      inputFound: !!input,
      deepThinkOn: toggleIsOn(dt),
      searchOn: toggleIsOn(sr),
      currentChatName: currentChatName(),
      loggedOut: detectLoggedOut(),
    };
  }

  function currentChatName() {
    const header = document.querySelector('header, [data-testid*="header" i], h1');
    if (!header) return null;
    const t = (header.textContent || '').trim();
    return t || null;
  }

  function findSidebar() {
    return (
      document.querySelector('aside') ||
      document.querySelector('nav') ||
      document.querySelector('[data-testid*="sidebar" i]') ||
      document.querySelector('[class*="sidebar" i]')
    );
  }

  function findChatInSidebar(name) {
    const side = findSidebar();
    if (!side) return null;
    const re = new RegExp(escapeRe(name), 'i');
    const items = side.querySelectorAll('a, button, li, [role="button"], [role="link"]');
    for (const el of items) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (t === name || re.test(t)) return el;
    }
    return null;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findNewChatButton() {
    const byText = findByText(document, 'button, a, [role="button"]', /new\s*chat/i);
    if (byText) return byText;
    return document.querySelector('[aria-label*="new chat" i]') ||
           document.querySelector('[data-testid*="new-chat" i]');
  }

  async function waitForInputReady(timeout) {
    const input = await waitFor(() => {
      const el = findInput();
      return el && visible(el) && !el.disabled ? el : null;
    }, { timeout: timeout || 5000 });
    return input;
  }

  async function openNewChat() {
    const btn = findNewChatButton();
    if (!btn) return { ok: false, error: DSC.ERR.CHAT_NOT_FOUND, reason: 'new_chat_button_not_found' };
    btn.click();
    const input = await waitForInputReady(5000);
    if (!input) return { ok: false, error: DSC.ERR.INPUT_NOT_FOUND, reason: 'input_after_new_chat' };
    return { ok: true };
  }

  async function renameCurrentChat(name) {
    // Best-effort. Try three-dot menu on the chat title / sidebar item.
    const titleEl = findChatInSidebar(name) ||
                    document.querySelector('header h1, header [class*="title" i]') ||
                    document.querySelector('header') ||
                    document.querySelector('h1');
    if (!titleEl) return { ok: false, reason: 'title_not_found' };

    const target = (titleEl.closest('a, li, [role="button"], button') || titleEl);
    // Hover to reveal menu affordance.
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(200);

    const menuTrigger = target.querySelector('[aria-label*="more" i], [aria-label*="menu" i], [aria-label*="option" i]') ||
                        target.parentElement?.querySelector('[aria-label*="more" i], [aria-label*="menu" i]');
    if (menuTrigger) { menuTrigger.click(); await sleep(200); }

    const renameItem = findByText(document, '[role="menuitem"], button, li', /rename/i);
    if (!renameItem) return { ok: false, reason: 'rename_menu_item_not_found' };
    renameItem.click();
    await sleep(200);

    const input = document.querySelector('input[type="text"]:not([disabled])') ||
                  document.querySelector('[contenteditable="true"]');
    if (!input) return { ok: false, reason: 'rename_input_not_found' };

    if (input.tagName === 'INPUT') {
      input.focus();
      input.select?.();
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      input.textContent = name;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(100);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(500);
    return { ok: true };
  }

  async function ensureChat(name) {
    if (!name) return { ok: false, error: DSC.ERR.CHAT_NOT_FOUND, reason: 'no_name' };

    const existing = findChatInSidebar(name);
    if (existing) {
      existing.click();
      const input = await waitForInputReady(5000);
      if (!input) return { ok: false, error: DSC.ERR.INPUT_NOT_FOUND, reason: 'input_after_open_existing' };
      return { ok: true, existing: true };
    }

    const created = await openNewChat();
    if (!created.ok) return created;

    const renamed = await renameCurrentChat(name);
    // Rename failure is non-fatal: chat exists, just unnamed. Wizard can still proceed.
    return { ok: true, existing: false, rename: renamed };
  }

  async function resetChat(name) {
    // Delete is fragile; instead ensure a fresh chat and rename to name.
    // If a chat with `name` exists, open new and rename over it (DeepSeek
    // tolerates duplicate titles; wizard always finds by newest match).
    return ensureChat(name);
  }

  function setInputValue(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      input.textContent = '';
      document.execCommand('insertText', false, text);
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  function readInputValue(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    return input.textContent || '';
  }

  function findAssistantMessages() {
    // DeepSeek assistant blocks. Order of specificity — first that yields >0 wins.
    const sels = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant" i]',
      '[class*="assistant" i]',
      '[class*="markdown" i]',
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    }
    return [];
  }

  function lastAssistantText() {
    const msgs = findAssistantMessages();
    if (msgs.length === 0) return null;
    const last = msgs[msgs.length - 1];
    const clone = last.cloneNode(true);
    // Strip buttons and copy affordances so extracted text is clean.
    clone.querySelectorAll('button, [role="button"], svg').forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  function hasCopyAndRegenerateButtons(root) {
    if (!root) root = document;
    const has = (re) => findByText(root, 'button, [role="button"]', re) !== null ||
                       Array.from(root.querySelectorAll('button, [role="button"]'))
                         .some((b) => re.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
    return has(/copy/i) && has(/regenerat|retry/i);
  }

  function responseLooksComplete() {
    const msgs = findAssistantMessages();
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    if (hasCopyAndRegenerateButtons(last)) return true;
    if (hasCopyAndRegenerateButtons(document)) return true;
    return false;
  }

  function extractDelimited(raw, start, end) {
    if (!raw) return null;
    // Match "<source> START_<file>" ... "<source> END_<file>". Multi-block: take first.
    const re = new RegExp(
      '^[ \\t]*(\\S+)[ \\t]+' + escapeRe(start) + '(\\S+)[ \\t]*$[\\s\\S]*?^[ \\t]*\\1[ \\t]+' + escapeRe(end) + '\\2[ \\t]*$',
      'm'
    );
    const m = raw.match(re);
    if (!m) return null;
    const lines = m[0].split('\n');
    lines.shift();
    lines.pop();
    return lines.join('\n').trim();
  }

  function extractLastJsFence(raw) {
    if (!raw) return null;
    const re = /```(?:js|javascript)\s*\n([\s\S]*?)```/gi;
    let m; let last = null;
    while ((m = re.exec(raw)) !== null) last = m[1];
    return last ? last.trim() : null;
  }

  function extractContent(raw, delimiters) {
    const start = (delimiters && delimiters.start) || 'START_';
    const end = (delimiters && delimiters.end) || 'END_';
    const delimited = extractDelimited(raw, start, end);
    if (delimited != null) return { content: delimited, source: 'delimiter' };
    const fenced = extractLastJsFence(raw);
    if (fenced != null) return { content: fenced, source: 'fence' };
    return { content: raw, source: 'raw' };
  }

  async function sendPrompt(prompt, delimiters) {
    const input = await waitForInputReady(5000);
    if (!input) return { error: DSC.ERR.INPUT_NOT_FOUND };

    if (detectLoggedOut()) return { error: DSC.ERR.LOGGED_OUT };

    const dt = await ensureToggleOn('deepthink', DSC.ERR.DEEPTHINK_ENABLE_FAILED);
    if (!dt.ok) return { error: DSC.ERR.DEEPTHINK_ENABLE_FAILED, reason: dt.reason };
    const sr = await ensureToggleOn('search', DSC.ERR.SEARCH_ENABLE_FAILED);
    if (!sr.ok) return { error: DSC.ERR.SEARCH_ENABLE_FAILED, reason: sr.reason };

    const before = findAssistantMessages().length;

    setInputValue(input, prompt);
    await sleep(100);
    if (readInputValue(input).length === 0) {
      return { error: DSC.ERR.SEND_FAILED, reason: 'input_empty_after_set' };
    }

    const sendBtn = findSendButton();
    if (!sendBtn) return { error: DSC.ERR.SEND_FAILED, reason: 'send_button_not_found' };
    const startedAt = Date.now();
    sendBtn.click();

    // Wait for at least one new assistant message AND completion markers.
    const deadline = startedAt + DSC.RESPONSE_TIMEOUT_MS;
    let sawNew = false;
    while (Date.now() < deadline) {
      await sleep(400);
      const msgs = findAssistantMessages();
      if (msgs.length > before) sawNew = true;
      if (sawNew && responseLooksComplete()) break;
    }

    if (!sawNew) return { error: DSC.ERR.RESPONSE_TIMEOUT, reason: 'no_new_message' };
    if (!responseLooksComplete()) return { error: DSC.ERR.RESPONSE_TIMEOUT, reason: 'completion_markers_missing' };

    const raw = lastAssistantText();
    if (!raw) return { error: DSC.ERR.RESPONSE_TIMEOUT, reason: 'empty_response' };

    if (/too many requests|rate limit/i.test(raw)) {
      return { error: DSC.ERR.RATE_LIMITED, retryAfter: 30 };
    }

    const extracted = extractContent(raw, delimiters);
    return {
      content: extracted.content,
      raw,
      source: extracted.source,
      elapsedMs: Date.now() - startedAt,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (!msg || !msg.action) return sendResponse({ error: 'no_action' });
        if (msg.action === DSC.MSG.ENSURE_CHAT)  return sendResponse(await ensureChat(msg.name));
        if (msg.action === DSC.MSG.SEND_PROMPT)  return sendResponse(await sendPrompt(msg.prompt, msg.delimiters));
        if (msg.action === DSC.MSG.CHECK_STATE)  return sendResponse(await checkState());
        if (msg.action === DSC.MSG.RESET_CHAT)   return sendResponse(await resetChat(msg.name));
        return sendResponse({ error: 'unknown_action', action: msg.action });
      } catch (e) {
        log('handler error', e);
        sendResponse({ error: 'content_error', reason: e.message });
      }
    })();
    return true; // async response
  });

  log('content script loaded');
})();
