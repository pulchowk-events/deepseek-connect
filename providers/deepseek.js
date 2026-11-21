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

  // Input lookup goes through the DeepSeek selector registry only. No raw
  // textarea / contenteditable fallback here: a bare textarea fallback is
  // what let this provider match another provider's input box.
  function findInput() {
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve('input');
    return (r && r.el) ? r.el : null;
  }

  function findSendButton() {
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve('sendButton');
    if (r && r.el) return r.el;
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

  async function waitForFindSend(timeout) {
    return waitFor(() => {
      const button = findSendButton();
      if (!button) return null;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
      return button;
    }, { timeout: timeout || 10000, interval: 100 });
  }

  function findToggle(kind) {
    const logical = kind === 'deepthink' ? 'toggleDeepThink' : 'toggleSearch';
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve(logical);
    if (r && r.el) return r.el;
    const re = kind === 'deepthink' ? /deep\s*think/i : /^search$/i;
    for (const el of document.querySelectorAll('[aria-pressed]')) {
      if (re.test((el.textContent || '').trim())) return el;
    }
    return findByText(document, 'button, [role="button"]', re);
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
    const probe = globalThis.DSC_SELECTORS ? globalThis.DSC_SELECTORS.probeDom() : null;
    return {
      inputFound: !!input,
      deepThinkOn: toggleIsOn(dt),
      searchOn: toggleIsOn(sr),
      currentChatName: currentChatName(),
      loggedOut: detectLoggedOut(),
      drift: probe ? { drifted: probe.drifted, degraded: probe.degraded } : null,
    };
  }

  function currentChatName() {
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve('headerTitle');
    if (r && r.el) {
      const t = (r.el.textContent || '').trim();
      if (t) return t;
    }
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

  function findSidebarContainer() {
    // DeepSeek's sidebar no longer has semantic class names (only build
    // hashes). Anchor on the "New chat" button text and walk up to a
    // narrow-tall container -- that's the sidebar.
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
      if (r.top > vh - 80) continue; // profile/settings at bottom
      out.push(el);
    }
    return out;
  }

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

  function findChatInSidebar(name) {
    const re = new RegExp(escapeRe(name), 'i');
    const leaves = listChatLeafItems();
    for (const leaf of leaves) {
      const t = (leaf.textContent || '').trim();
      if (t === name || re.test(t)) return clickableAncestor(leaf);
    }
    return null;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findNewChatButton() {
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve('newChatButton');
    if (r && r.el) return r.el;
    return findByText(document, 'button, a, [role="button"]', /new\s*chat/i);
  }

  async function waitForInputReady(timeout) {
    const input = await waitFor(() => {
      const el = findInput();
      return el && visible(el) && !el.disabled ? el : null;
    }, { timeout: timeout || 5000 });
    return input;
  }

  function findGenerationControl() {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(el)) continue;
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.textContent,
      ].filter(Boolean).join(' ');
      if (/\bstop(?:\s+generating)?\b/i.test(label)) return el;
    }
    return null;
  }

  async function waitForAutomationIdle(timeout) {
    const startedAt = Date.now();
    let idleSince = 0;
    let responseSignature = null;
    let latest = null;
    while (Date.now() - startedAt < timeout) {
      const input = findInput();
      const busy = !!findGenerationControl();
      const messages = findAssistantMessages();
      const lastText = messages.length ? (messages[messages.length - 1].textContent || '').trim() : '';
      const signature = messages.length + ':' + lastText.length + ':' +
        lastText.slice(0, 60) + ':' + lastText.slice(-60);
      latest = {
        readyState: document.readyState,
        inputFound: !!(input && visible(input) && !input.disabled),
        inputEmpty: !!input && readInputValue(input).trim() === '',
        generating: busy,
        responseStable: responseSignature === null || responseSignature === signature,
      };
      if (responseSignature !== signature) {
        responseSignature = signature;
        idleSince = 0;
      } else if (latest.readyState === 'complete' && latest.inputFound && !busy) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= DSC.STAGE_DELAY_MS) return { ok: true, state: latest };
      } else {
        idleSince = 0;
      }
      await sleep(200);
    }
    return { ok: false, state: latest };
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

    const debug = { sideFound: false, leafCount: 0, leafPreview: [], name, path: location.pathname };
    try {
      const side = findSidebarContainer();
      debug.sideFound = !!side;
      if (side) {
        const leaves = listChatLeafItems();
        debug.leafCount = leaves.length;
        debug.leafPreview = leaves.slice(0, 8).map((el) => (el.textContent || '').trim().slice(0, 40));
      }
    } catch (e) {
      debug.debugError = String(e && e.message || e);
    }

    const existing = findChatInSidebar(name);
    if (existing) {
      existing.click();
      const input = await waitForInputReady(5000);
      if (!input) return { ok: false, error: DSC.ERR.INPUT_NOT_FOUND, reason: 'input_after_open_existing', debug };
      return { ok: true, existing: true, mode: 'existing', debug };
    }

    if (location.pathname === '/' || location.pathname === '') {
      const input = await waitForInputReady(2000);
      if (input) return { ok: true, existing: false, mode: 'fresh', debug };
    }

    return { ok: false, needNewChat: true, mode: 'need_nav', path: location.pathname, debug };
  }

  async function resetChat(name) {
    // Delete is fragile; instead ensure a fresh chat and rename to name.
    // If a chat with `name` exists, open new and rename over it (DeepSeek
    // tolerates duplicate titles; wizard always finds by newest match).
    return ensureChat(name);
  }

  function setInputValue(input, text) {
    return DSC.fillPromptInput(input, text);
  }

  function readInputValue(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    return input.textContent || '';
  }

  function findAssistantMessages() {
    const r = globalThis.DSC_SELECTORS && globalThis.DSC_SELECTORS.resolve('assistantMessages');
    if (r && r.el) return Array.isArray(r.el) ? r.el : [r.el];
    // Fallback if selectors.js somehow didn't load (defensive).
    return Array.from(document.querySelectorAll('.ds-message'))
      .filter((m) => m.querySelector('.ds-markdown'));
  }

  function lastAssistantText() {
    const msgs = findAssistantMessages();
    if (msgs.length === 0) return null;
    const last = msgs[msgs.length - 1];
    let target = last.querySelector('.ds-assistant-message-main-content');
    if (!target) {
      const mds = Array.from(last.querySelectorAll('.ds-markdown'));
      for (let i = mds.length - 1; i >= 0; i--) {
        if (!mds[i].closest('[class*="think" i]')) { target = mds[i]; break; }
      }
      if (!target && mds.length === 0) target = last;
      if (!target) return null;
    }
    // Must read innerText on the LIVE element. A detached cloneNode returns
    // '' for innerText in Chromium (falls back to textContent, which loses
    // newlines between block elements and breaks delimiter line anchors).
    // Buttons inside assistant blocks carry aria-label, no text content, so
    // innerText stays clean without stripping.
    const txt = (target.innerText || target.textContent || '').trim();
    return txt || null;
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

  // Two-pass extractor for the "<token> START_<name>" / "<token> END_<name>"
  // line protocol. Also exported on DSC for providers that need the same
  // contract (see qwen.js).
  function extractDelimited(raw, start, end) {
    if (!raw) return null;
    const s = escapeRe(start);
    const e = escapeRe(end);
    // Pass 1: line-anchored. Preferred when innerText preserved newlines.
    const reAnchored = new RegExp(
      '^[ \\t]*(\\S+)[ \\t]+' + s + '(\\S+)[ \\t]*$[\\s\\S]*?^[ \\t]*\\1[ \\t]+' + e + '\\2[ \\t]*$',
      'm'
    );
    let m = raw.match(reAnchored);
    if (m) {
      const lines = m[0].split('\n');
      if (lines.length >= 2) { lines.shift(); lines.pop(); }
      return lines.join('\n').trim();
    }
    // Pass 2: whitespace-tolerant. Handles collapsed single-line blobs where
    // the model or DOM dropped the newlines. Match anywhere, no line anchors.
    const reLoose = new RegExp(
      '(\\w[\\w-]*)[ \\t\\n]*' + s + '([\\w.-]+)[\\s\\S]*?' +
      '\\1[ \\t\\n]*' + e + '\\2',
      'm'
    );
    m = raw.match(reLoose);
    if (m) {
      // Strip the header and footer from the full match, keep the middle.
      const full = m[0];
      const headerLen = m[1].length + s.length + m[2].length;
      // Skip optional whitespace between header and body.
      let bodyStart = headerLen;
      while (bodyStart < full.length && /[\s]/.test(full[bodyStart])) bodyStart++;
      const footerLen = m[1].length + e.length + m[2].length;
      let bodyEnd = full.length - footerLen;
      while (bodyEnd > bodyStart && /[\s]/.test(full[bodyEnd - 1])) bodyEnd--;
      return full.slice(bodyStart, bodyEnd).trim();
    }
    return null;
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

  async function sendPrompt(prompt, delimiters, requestId) {
    const startedAt = Date.now();
    const trace = [];
    const T = (phase, extra) => {
      // Broadcast live so background can POST /progress; final trace below
      // still carries the full sequence in the /reply payload.
      try {
        chrome.runtime.sendMessage({ type: 'dsc_phase', requestId, phase, extra }).catch(() => {});
      } catch (_) { /* no-op if port closed */ }
      trace.push(Object.assign({ t: Date.now() - startedAt, phase }, extra || {}));
      if (trace.length > 60) trace.splice(1, 1);
    };
    const fail = (error, reason, extra) => Object.assign(
      { error, reason, trace, elapsedMs: Date.now() - startedAt },
      extra || {}
    );

    T('pageReady', { checking: true });
    const pageReady = await DSC.waitForPageStable(15000, DSC.STAGE_DELAY_MS);
    T('pageReady', { ready: pageReady.ok, readyState: pageReady.readyState });
    if (!pageReady.ok) return fail(DSC.ERR.INPUT_NOT_FOUND, 'page_not_stable', { details: pageReady });

    // Phase 1: DOM probe
    const probe = globalThis.DSC_SELECTORS ? globalThis.DSC_SELECTORS.probeDom() : null;
    if (probe) {
      const requiredDrift = probe.drifted.filter((d) => d.required);
      T('probe', {
        healthy: probe.healthy,
        degraded: probe.degraded,
        requiredMissing: requiredDrift.map((d) => d.name),
      });
      if (requiredDrift.length > 0) {
        return fail(DSC.ERR.DOM_DRIFT, 'required_elements_missing', {
          details: requiredDrift.map((d) => d.name),
          probe,
        });
      }
    } else {
      T('probe', { note: 'selectors_not_loaded' });
    }

    // Phase 2: input
    T('preflight', { checking: 'input_and_provider_idle' });
    const idle = await waitForAutomationIdle(15000);
    T('preflight', Object.assign({ ready: idle.ok }, idle.state || {}));
    if (!idle.ok) {
      return fail(DSC.ERR.SEND_FAILED, idle.state && idle.state.generating
        ? 'provider_busy_before_send' : 'provider_not_ready', { details: idle.state });
    }
    const input = await waitForInputReady(5000);
    T('waitInput', { found: !!input });
    if (!input) return fail(DSC.ERR.INPUT_NOT_FOUND, 'input_not_found');
    if (readInputValue(input).trim() !== '') {
      return fail(DSC.ERR.SEND_FAILED, 'input_not_empty_before_send', {
        details: { inputEmpty: false, recovery: 'The existing composer was left untouched; review or clear it manually before retrying.' },
      });
    }

    if (detectLoggedOut()) return fail(DSC.ERR.LOGGED_OUT, 'logged_out');

    // Phase 3: toggles
    const dt = await ensureToggleOn('deepthink', DSC.ERR.DEEPTHINK_ENABLE_FAILED);
    T('toggleDeepthink', { ok: dt.ok, reason: dt.reason });
    if (!dt.ok) return fail(DSC.ERR.DEEPTHINK_ENABLE_FAILED, dt.reason);
    await sleep(DSC.STAGE_DELAY_MS);

    const sr = await ensureToggleOn('search', DSC.ERR.SEARCH_ENABLE_FAILED);
    T('toggleSearch', { ok: sr.ok, reason: sr.reason });
    if (!sr.ok) return fail(DSC.ERR.SEARCH_ENABLE_FAILED, sr.reason);
    await sleep(DSC.STAGE_DELAY_MS);

    // Phase 4: set input
    const before = findAssistantMessages().length;
    const currentInput = await waitForInputReady(5000);
    if (!currentInput || readInputValue(currentInput).trim() !== '' || findGenerationControl()) {
      return fail(DSC.ERR.SEND_FAILED, 'pre_paste_state_changed', {
        inputFound: !!currentInput,
        inputEmpty: !!currentInput && readInputValue(currentInput).trim() === '',
        generating: !!findGenerationControl(),
      });
    }
    const pageUrlBeforeSend = location.href;
    const filled = setInputValue(currentInput, prompt);
    await sleep(DSC.STAGE_DELAY_MS);
    const typedLen = readInputValue(currentInput).length;
    T('setInput', { promptLen: prompt.length, typedLen, method: filled.method, exact: filled.ok, msgBefore: before });
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_after_input', { inputRetained: typedLen > 0 });
    }
    if (!filled.ok || typedLen !== prompt.length) return fail(DSC.ERR.SEND_FAILED, 'input_not_set');

    // Phase 5: click send
    const sendBtn = await waitForFindSend(10000);
    if (!sendBtn) return fail(DSC.ERR.SEND_FAILED, 'send_button_not_found');
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }
    if (findGenerationControl() || readInputValue(currentInput) !== prompt || currentInput.isConnected === false) {
      return fail(DSC.ERR.SEND_FAILED, 'pre_send_state_changed', {
        inputMatchesPrompt: readInputValue(currentInput) === prompt,
        generating: !!findGenerationControl(),
      });
    }
    await sleep(DSC.STAGE_DELAY_MS);
    const finalSendBtn = await waitForFindSend(2000);
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }
    if (!finalSendBtn || findGenerationControl() || readInputValue(currentInput) !== prompt) {
      return fail(DSC.ERR.SEND_FAILED, 'send_control_not_stable', {
        sendReady: !!finalSendBtn,
        generating: !!findGenerationControl(),
        inputMatchesPrompt: readInputValue(currentInput) === prompt,
      });
    }
    if (!DSC.clickSendOnce(finalSendBtn)) return fail(DSC.ERR.SEND_FAILED, 'send_button_disabled');
    const sendClickedAt = Date.now();
    T('sendClick', { ms: sendClickedAt - startedAt });
    const submission = await waitFor(() => {
      const postClickInput = findInput();
      const assistantCount = findAssistantMessages().length;
      const state = {
        inputCleared: !!postClickInput && readInputValue(postClickInput).trim() === '',
        generating: !!findGenerationControl(),
        assistantCount,
      };
      return state.inputCleared || state.generating || assistantCount > before ? state : null;
    }, { timeout: 15000, interval: 200 });
    T('submitObserved', Object.assign({ accepted: !!submission }, submission || {
      inputCleared: false, generating: false, assistantCount: findAssistantMessages().length,
    }));
    if (!submission) {
      return fail(DSC.ERR.SEND_FAILED, 'send_not_registered', {
        inputRetained: readInputValue(findInput()).length > 0,
        details: { recovery: 'The send click was issued but UI acceptance was not observed; inspect the provider tab before retrying.' },
      });
    }

    // Phase 6: wait for reply.
    // This provider streams reasoning first (.ds-think-content), answer later
    // (.ds-assistant-message-main-content). Reasoning text is NOT the answer;
    // ignore it for completion detection, log its growth as 'reasoning'.
    const deadline = sendClickedAt + DSC.RESPONSE_TIMEOUT_MS;
    let sawNew = false;
    let streamUrl = null;
    let answerStarted = false;
    let stableLen = -1;
    let stableSince = 0;
    let completedBy = null;
    let lastSample = 0;
    let lastReasonLen = -1;
    while (Date.now() < deadline) {
      await sleep(400);
      const msgs = findAssistantMessages();
      if (msgs.length > before && !sawNew) {
        sawNew = true;
        streamUrl = location.href;
        T('firstMsg', { msgs: msgs.length, url: streamUrl.split('/').pop().slice(0, 8) });
      }
      if (!sawNew) continue;
      if (streamUrl && location.href !== streamUrl) {
        return fail(DSC.ERR.USER_NAVIGATED, 'user_navigated', {
          expected: streamUrl, actual: location.href,
        });
      }
      if (responseLooksComplete()) { completedBy = 'buttons'; break; }

      const last = msgs[msgs.length - 1];
      const hasAnswer = !!(last && last.querySelector('.ds-assistant-message-main-content'));
      if (!hasAnswer) {
        const reasonLen = last ? (last.textContent || '').length : 0;
        if (reasonLen !== lastReasonLen && Date.now() - lastSample > 1500) {
          lastReasonLen = reasonLen;
          lastSample = Date.now();
          T('reasoning', { len: reasonLen });
        }
        continue;
      }
      if (!answerStarted) {
        answerStarted = true;
        T('answerStarted');
      }

      const txt = lastAssistantText() || '';
      if (txt.length === 0) continue;
      if (txt.length !== stableLen) {
        stableLen = txt.length;
        stableSince = Date.now();
        if (Date.now() - lastSample > 1500) {
          lastSample = Date.now();
          T('answer', { len: stableLen });
        }
      } else if (stableSince > 0 && Date.now() - stableSince >= 2500) {
        completedBy = 'stable';
        break;
      }
    }
    T('replyDone', { completedBy, sawNew, stableLen });
    if (!sawNew) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'no_new_message');
    if (!completedBy) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'completion_timeout');

    const raw = lastAssistantText();
    if (!raw) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'empty_response');

    if (/too many requests|rate limit/i.test(raw)) {
      return fail(DSC.ERR.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 });
    }

    // Phase 7: extract
    const extracted = extractContent(raw, delimiters);
    T('extract', { source: extracted.source, contentLen: extracted.content.length, rawLen: raw.length });
    return {
      content: extracted.content,
      raw,
      source: extracted.source,
      elapsedMs: Date.now() - startedAt,
      url: streamUrl,  // the actual /a/chat/s/<uuid> the reply landed in;
                       // caller persists this for retry-direct navigation
      trace,
    };
  }

  // Shared with other providers that speak the same marker-line protocol.
  DSC.extractDelimited = extractDelimited;

  globalThis.DSC_PROVIDERS = globalThis.DSC_PROVIDERS || {};
  globalThis.DSC_PROVIDERS['deepseek'] = {
    name: 'deepseek',
    ensureChat,
    sendPrompt,
    checkState,
    resetChat
  };
  console.debug('[dsc:registry]', 'deepseek provider registered');
})();
