// providers/chatgpt.js -- DOM driver for https://chatgpt.com/ (free tier, account default model).
// Contract: globalThis.DSC_PROVIDERS['chatgpt'] = { name, ensureChat, sendPrompt, checkState, resetChat }.
// input/send/stop/assistant selectors were captured with the Providers-page picker (input/send/stop/response).
// Fallback tiers warn once (console.warn) when a fallback tier is used.
'use strict';

(function () {
  const DSC = globalThis.DSC;
  const E = DSC.ERR;
  const BOT_BLOCKED = 'bot_blocked'; // registered in src/errors.js (CODES + META)
  const RESPONSE_MS = 150000;
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  const SEL = {
    input: ['div[aria-label="Ask ChatGPT"]', 'div[data-virtualkeyboard="true"]', 'div.ProseMirror'],
    send: ['button[aria-label="Send"]'],
    stop: ['button[aria-label="Stop"]'],
    assistant: ['div[data-response-body]'],
    user: ['[data-message-author-role="user"]', 'article[data-testid^="conversation-turn"][data-turn="user"]'],
    challenge: ['iframe[src*="challenges.cloudflare.com"]', '#challenge-form', '#cf-challenge-running', 'div.cf-turnstile',
      'input[name="cf-turnstile-response"]'],
    notice: ['[role="dialog"]', '[role="alert"]', '[data-testid*="toast" i]'],
  };
  const REASON_SEL = 'details, [data-testid*="thought" i], [data-testid*="reasoning" i], [class*="thinking" i], [class*="reasoning" i]';
  const RATE_RE = /too many requests|rate limit|you.ve (?:reached|hit)[^.]{0,80}(?:limit|cap)|you have (?:reached|hit)[^.]{0,80}(?:limit|cap)|usage (?:limit|cap)|limit (?:will )?resets?/i;
  const CHATGPT_MAX_PROMPT_CHARS = 55000;
  const TOO_LONG_RE = /messages?\s+you\s+submitted\s+(?:was|were)\s+too\s+long/i;
  let lastTooLongCheck = 0;

  function detectTooLong() {
    const leafMatch = function (el) {
      if (!el || (el.children && el.children.length)) return null;
      const t = (el.textContent || '').trim();
      if (t && t.length < 300 && TOO_LONG_RE.test(t)) return t;
      return null;
    };
    const scoped = '[role="dialog"], [role="alert"], [data-testid*="toast" i], [data-testid*="error" i]';
    let roots = [];
    try { roots = Array.from(document.querySelectorAll(scoped)); } catch (_) { roots = []; }
    for (const root of roots) {
      const self = leafMatch(root);
      if (self) return self;
      let kids = [];
      try { kids = Array.from(root.querySelectorAll('*')); } catch (_) { kids = []; }
      for (const k of kids) { const m = leafMatch(k); if (m) return m; }
    }
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        const tag = n.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let visited = 0;
    let n = walker.nextNode();
    while (n && visited < 20000) {
      visited++;
      const m = leafMatch(n);
      if (m) return m;
      n = walker.nextNode();
    }
    return null;
  }
  const CF_TEXT_RE = /verify you are human|checking your browser|performing security verification|just a moment/i;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  const warned = {};
  function warnTier(name, i, sel) {
    if (i > 0 && !warned[name]) {
      warned[name] = true;
      console.warn('[dsc:chatgpt] selector "' + name + '" resolved via fallback tier ' + i + ': ' + sel);
    }
  }
  function pick(name, needVisible) {
    const sels = SEL[name];
    for (let i = 0; i < sels.length; i++) {
      let el = null;
      try { el = document.querySelector(sels[i]); } catch (_) { el = null; }
      if (el && (!needVisible || visible(el))) { warnTier(name, i, sels[i]); return el; }
    }
    return null;
  }
  function pickAll(name) {
    const sels = SEL[name];
    for (let i = 0; i < sels.length; i++) {
      let l = [];
      try { l = Array.from(document.querySelectorAll(sels[i])); } catch (_) { l = []; }
      if (l.length) { warnTier(name, i, sels[i]); return { sel: sels[i], els: l }; }
    }
    return { sel: null, els: [] };
  }
  function countOf(sel) {
    try { return document.querySelectorAll(sel).length; } catch (_) { return 0; }
  }
  function waitFor(fn, timeout, interval) {
    const start = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        let v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval || 250);
      })();
    });
  }

  const findInput = function () { return pick('input', true); };
  function findSend() {
    const b = pick('send', true);
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
  }
  const stopPresent = function () { return !!pick('stop', true); };

  function detectBlocked() {
    if (findInput()) return false;
    if (pick('challenge', false)) return true;
    if (/just a moment/i.test(document.title || '')) return true;
    const body = ((document.body && document.body.innerText) || '').slice(0, 2000);
    return CF_TEXT_RE.test(body);
  }
  function detectLoggedOut() {
    return /^\/auth\//.test(location.pathname);
  }
  function detectRateLimit() {
    for (const s of SEL.notice) {
      let l = [];
      try { l = Array.from(document.querySelectorAll(s)); } catch (_) { l = []; }
      for (const el of l) {
        const t = ((el.innerText || el.textContent) || '').trim();
        if (t && t.length < 800 && RATE_RE.test(t)) return true;
      }
    }
    return false;
  }

  const compact = function (s) { return String(s || '').replace(/\s+/g, ''); };
  function readInput(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }
  function selectAll(el) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* ignore */ }
  }
  function okTyped(el, text) {
    return compact(readInput(el)).length >= compact(text).length * 0.9;
  }
  // ProseMirror: synthetic paste first (keeps newlines), execCommand insertText as fallback.
  async function fillInput(el, text) {
    const filled = DSC.fillPromptInput(el, text);
    await sleep(100);
    if (!filled.ok) return 'failed';
    return filled.method;
  }

  function answerText(el) {
    const mds = Array.from(el.querySelectorAll('.markdown')).filter(function (m) { return !m.closest(REASON_SEL); });
    const parts = mds.map(function (m) { return ((m.innerText || m.textContent) || '').trim(); }).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    if (el.closest(REASON_SEL)) return '';
    const t = ((el.innerText || el.textContent) || '').trim();
    if (/^(thinking|thought for)\b/i.test(t) && t.length < 200) return '';
    return t;
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // Same two-pass "<token> START_<name>" / "<token> END_<name>" protocol as providers/deepseek.js.
  function extractDelimited(raw, start, end) {
    if (!raw) return null;
    const s = escapeRe(start);
    const e = escapeRe(end);
    const reA = new RegExp('^[ \\t]*(\\S+)[ \\t]+' + s + '(\\S+)[ \\t]*$[\\s\\S]*?^[ \\t]*\\1[ \\t]+' + e + '\\2[ \\t]*$', 'm');
    let m = raw.match(reA);
    if (m) {
      const lines = m[0].split('\n');
      if (lines.length >= 2) { lines.shift(); lines.pop(); }
      return lines.join('\n').trim();
    }
    const reL = new RegExp('(\\w[\\w-]*)[ \\t\\n]*' + s + '([\\w.-]+)[\\s\\S]*?\\1[ \\t\\n]*' + e + '\\2', 'm');
    m = raw.match(reL);
    if (m) {
      const full = m[0];
      let a = m[1].length + s.length + m[2].length;
      while (a < full.length && /\s/.test(full[a])) a++;
      let b = full.length - (m[1].length + e.length + m[2].length);
      while (b > a && /\s/.test(full[b - 1])) b--;
      return full.slice(a, b).trim();
    }
    return null;
  }
  function lastJsFence(raw) {
    const re = /```(?:js|javascript)\s*\n([\s\S]*?)```/gi;
    let m; let last = null;
    while ((m = re.exec(raw)) !== null) last = m[1];
    return last ? last.trim() : null;
  }
  const isRootToChat = function (a, b) {
    try {
      const pa = new URL(a).pathname; const pb = new URL(b).pathname;
      return (pa === '/' || pa === '') && pb !== '/' && pb !== '';
    } catch (_) { return false; }
  };

  // Diagnostic census for input_not_found: document-wide counts, composer candidates, selector tier hits. Never throws.
  function census() {
    const out = { textarea_count: null, contenteditable_count: null, role_textbox_count: null,
      composer_candidates: [], selector_tier_hit: {}, page_ready: null, url_path: null };
    const all = function (s) { try { return Array.from(document.querySelectorAll(s)); } catch (_) { return []; } };
    const attr = function (el, n) { try { return el.getAttribute(n); } catch (_) { return null; } };
    try {
      out.textarea_count = all('textarea').length;
      out.contenteditable_count = all('[contenteditable]').length;
      out.role_textbox_count = all('[role="textbox"]').length;
      out.composer_candidates = all('textarea, [contenteditable], [role="textbox"], form').slice(0, 5).map(function (el) {
        let vis = null;
        try { vis = visible(el); } catch (_) { /* ignore */ }
        return { tag: String(el.tagName || '').toLowerCase(), id: el.id || null,
          className: String(attr(el, 'class') || '').slice(0, 80), role: attr(el, 'role'),
          data_testid: attr(el, 'data-testid'), aria_label: attr(el, 'aria-label'), visible: vis };
      });
      ['input', 'send', 'stop', 'assistant', 'challenge'].forEach(function (n) {
        out.selector_tier_hit[n] = SEL[n].findIndex(function (s) { return all(s).length > 0; });
      });
      out.page_ready = document.readyState;
      out.url_path = location.pathname;
    } catch (_) { /* partial census is fine */ }
    return out;
  }

  async function ensureChat(name) {
    const debug = { name: name, path: location.pathname, provider: 'chatgpt' };
    const input = await waitFor(function () { return findInput() || (detectBlocked() ? true : null); }, 15000);
    if (input === true || (!input && detectBlocked())) {
      return { ok: false, error: BOT_BLOCKED, reason: 'turnstile_challenge', retryAfter: 30000, debug: debug };
    }
    if (!input) return { ok: false, error: E.INPUT_NOT_FOUND, reason: 'input_not_found', debug: Object.assign(debug, census()) };
    if (detectLoggedOut()) return { ok: false, error: E.LOGGED_OUT, reason: 'logged_out', debug: debug };
    if (location.pathname !== '/' && location.pathname !== '' && pickAll('assistant').els.length > 0) {
      return { ok: false, needNewChat: true, mode: 'need_nav', path: location.pathname, debug: debug };
    }
    return { ok: true, existing: false, mode: 'fresh', debug: debug };
  }

  async function sendPrompt(prompt, delimiters, requestId) {
    const startedAt = Date.now();
    const trace = [];
    const T = function (phase, extra) {
      try { chrome.runtime.sendMessage({ type: 'dsc_phase', requestId: requestId, phase: phase, extra: extra }).catch(function () {}); } catch (_) { /* port closed */ }
      trace.push(Object.assign({ t: Date.now() - startedAt, phase: phase }, extra || {}));
      if (trace.length > 80) trace.splice(1, 1);
    };
    const fail = function (error, reason, extra) {
      return Object.assign({ error: error, reason: reason, trace: trace, elapsedMs: Date.now() - startedAt }, extra || {});
    };
    const dStart = (delimiters && delimiters.start) || 'START_';
    const dEnd = (delimiters && delimiters.end) || 'END_';
    if (prompt && prompt.length > CHATGPT_MAX_PROMPT_CHARS) {
      return fail(E.BAD_REQUEST, 'prompt_too_large', { promptLen: prompt.length, limit: CHATGPT_MAX_PROMPT_CHARS });
    }
    lastTooLongCheck = 0;

    T('gpt_page_ready', { checking: true });
    const pageReady = await DSC.waitForPageStable(15000, DSC.STAGE_DELAY_MS);
    T('gpt_page_ready', { ready: pageReady.ok, readyState: pageReady.readyState });
    if (!pageReady.ok) return fail(E.INPUT_NOT_FOUND, 'page_not_stable', { details: pageReady });

    const input = await waitFor(function () { return findInput() || (detectBlocked() ? true : null); }, 15000);
    T('gpt_input', { found: !!input && input !== true });
    if (input === true || (!input && detectBlocked())) return fail(BOT_BLOCKED, 'turnstile_challenge', { retryAfter: 30000 });
    if (!input) return fail(E.INPUT_NOT_FOUND, 'input_not_found', { details: { debug: census() } });
    if (detectLoggedOut()) return fail(E.LOGGED_OUT, 'logged_out');
    if (detectRateLimit()) return fail(E.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 });

    T('gpt_preflight', { checking: 'idle_and_empty_input' });
    let idleSince = 0;
    let responseSignature = null;
    const idle = await waitFor(function () {
      const current = findInput();
      const generating = stopPresent();
      const assistant = pickAll('assistant').els;
      const lastText = assistant.length ? answerText(assistant[assistant.length - 1]) : '';
      const signature = assistant.length + ':' + lastText.length + ':' +
        lastText.slice(0, 60) + ':' + lastText.slice(-60);
      if (responseSignature !== signature) {
        responseSignature = signature;
        idleSince = 0;
        return null;
      }
      if (!current || generating || document.readyState !== 'complete') {
        idleSince = 0;
        return null;
      }
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince < DSC.STAGE_DELAY_MS) return null;
      return { input: current, inputEmpty: compact(readInput(current)) === '', generating: false };
    }, 15000, 200);
    T('gpt_preflight', {
      ready: !!idle && idle.inputEmpty,
      inputEmpty: !!idle && idle.inputEmpty,
      generating: stopPresent(),
      readyState: document.readyState,
    });
    if (!idle) return fail(E.SEND_FAILED, 'provider_busy_or_not_ready');
    if (!idle.inputEmpty) {
      return fail(E.SEND_FAILED, 'input_not_empty_before_send', {
        details: { inputEmpty: false, recovery: 'The existing composer was left untouched; review or clear it manually before retrying.' },
      });
    }

    const beforeA = {}; const beforeU = {};
    SEL.assistant.forEach(function (s) { beforeA[s] = countOf(s); });
    SEL.user.forEach(function (s) { beforeU[s] = countOf(s); });

    await sleep(DSC.STAGE_DELAY_MS);
    const currentInput = findInput();
    if (!currentInput || compact(readInput(currentInput)) !== '' || stopPresent()) {
      return fail(E.SEND_FAILED, 'pre_paste_state_changed', {
        inputFound: !!currentInput,
        inputEmpty: !!currentInput && compact(readInput(currentInput)) === '',
        generating: stopPresent(),
      });
    }
    const pageUrlBeforeSend = location.href;
    const method = await fillInput(currentInput, prompt);
    await sleep(DSC.STAGE_DELAY_MS);
    const typedLen = readInput(currentInput).length;
    T('gpt_typed', { promptLen: prompt.length, typedLen: typedLen, method: method });
    if (location.href !== pageUrlBeforeSend) {
      return fail(E.USER_NAVIGATED, 'page_changed_after_input', { inputRetained: typedLen > 0 });
    }
    if (method === 'failed' || compact(readInput(currentInput)) !== compact(prompt)) {
      return fail(E.SEND_FAILED, 'input_not_set');
    }

    const btn = await waitFor(findSend, 10000);
    if (!btn) return fail(E.SEND_FAILED, 'send_button_not_found');
    if (location.href !== pageUrlBeforeSend) {
      return fail(E.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }
    if (stopPresent() || compact(readInput(currentInput)) !== compact(prompt) ||
        currentInput.isConnected === false) {
      return fail(E.SEND_FAILED, 'pre_send_state_changed', {
        inputMatchesPrompt: compact(readInput(currentInput)) === compact(prompt),
        generating: stopPresent(),
      });
    }
    await sleep(DSC.STAGE_DELAY_MS);
    const stableButton = findSend();
    if (location.href !== pageUrlBeforeSend) {
      return fail(E.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }
    if (!stableButton || stopPresent() || compact(readInput(currentInput)) !== compact(prompt)) {
      return fail(E.SEND_FAILED, 'send_control_not_stable', {
        sendReady: !!stableButton,
        generating: stopPresent(),
        inputMatchesPrompt: compact(readInput(currentInput)) === compact(prompt),
      });
    }
    if (!DSC.clickSendOnce(stableButton)) return fail(E.SEND_FAILED, 'send_button_disabled');
    const sentAt = Date.now();
    T('gpt_sent', { ms: sentAt - startedAt, viaButton: true });
    await sleep(DSC.STAGE_DELAY_MS);
    const postClickInput = findInput();
    T('gpt_submit_observed', {
      inputCleared: !!postClickInput && compact(readInput(postClickInput)) === '',
      generating: stopPresent(),
      assistantCount: pickAll('assistant').els.length,
    });

    function grew(before, names) {
      for (const s of names) { if (countOf(s) > (before[s] || 0)) return true; }
      return false;
    }
    const evidence = await waitFor(function () {
      const cur = findInput();
      return !cur || compact(readInput(cur)).length < Math.max(1, compact(prompt).length / 2) ||
        stopPresent() || grew(beforeU, SEL.user) || grew(beforeA, SEL.assistant);
    }, 15000);
    if (!evidence) return fail(E.SEND_FAILED, 'send_not_registered');

    function newAssistant() {
      for (const s of SEL.assistant) {
        let cur = [];
        try { cur = Array.from(document.querySelectorAll(s)); } catch (_) { cur = []; }
        if (cur.length > (beforeA[s] || 0)) return { sel: s, els: cur };
      }
      return null;
    }
    const delimOk = function (t) {
      const end = t.lastIndexOf(dEnd);
      return end >= 0 && t.lastIndexOf(dStart, end) >= 0;
    };

    const deadline = sentAt + RESPONSE_MS;
    let streamUrl = null; let urlHop = false;
    let seenStop = false; let noStop = 0;
    let sawMsg = false; let lastKey = ''; let stableSince = Date.now();
    let text = ''; let completedBy = null; let lastLog = 0;

    while (Date.now() < deadline) {
      await sleep(500);
      const stop = stopPresent();
      if (stop) seenStop = true;
      noStop = stop ? 0 : noStop + 1;
      if (detectBlocked()) return fail(BOT_BLOCKED, 'turnstile_challenge', { retryAfter: 30000 });

      const cand = newAssistant();
      if (!cand) {
        if (Date.now() - lastTooLongCheck > 3000) {
          lastTooLongCheck = Date.now();
          const matchedText = detectTooLong();
          if (matchedText) return fail(E.BAD_REQUEST, 'prompt_too_long_rejected', { matchedText: matchedText.slice(0, 200) });
        }
        if (detectRateLimit()) return fail(E.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 });
        if (!sawMsg && !seenStop && Date.now() - sentAt > 60000) return fail(E.RESPONSE_TIMEOUT, 'no_new_message');
        continue;
      }
      const last = cand.els[cand.els.length - 1];
      if (!sawMsg) { sawMsg = true; streamUrl = location.href; T('gpt_first', { sel: cand.sel, msgs: cand.els.length }); }
      if (location.href !== streamUrl) {
        if (!urlHop && isRootToChat(streamUrl, location.href)) { streamUrl = location.href; urlHop = true; }
        else return fail('user_navigated', 'user_navigated', { expected: streamUrl, actual: location.href });
      }

      const t = answerText(last);
      const key = t.length + '|' + t.slice(0, 64) + '|' + t.slice(-64);
      if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
      text = t;
      if (Date.now() - lastLog > 3000) { lastLog = Date.now(); T('gpt_stream', { len: t.length, stop: stop, seenStop: seenStop }); }
      if (!t) { if (detectRateLimit()) return fail(E.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 }); continue; }
      if (stop) continue;

      const stableFor = Date.now() - stableSince;
      if (seenStop && noStop >= 2 && stableFor >= 1000) completedBy = 'stopGone';
      else if (delimOk(t) && stableFor >= 1500) completedBy = 'delimiter';
      else if (stableFor >= 4000) completedBy = 'textStable';
      if (completedBy) break;
    }
    T('gpt_done', { completedBy: completedBy, sawMsg: sawMsg, len: text.length });
    if (!sawMsg) return fail(E.RESPONSE_TIMEOUT, 'no_new_message');
    if (!completedBy) return fail(E.RESPONSE_TIMEOUT, 'completion_timeout');

    const fin = newAssistant();
    const lastEl = fin ? fin.els[fin.els.length - 1] : null;
    const raw = lastEl ? answerText(lastEl) : text;
    if (!raw) return fail(E.INVALID_RESPONSE_FORMAT, 'extract_failed');
    if (raw.length < 400 && RATE_RE.test(raw)) return fail(E.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 });

    let content = extractDelimited(raw, dStart, dEnd); let source = 'delimiter';
    if (content === null) { content = lastJsFence(raw); source = 'fence'; }
    if (content === null) { content = raw; source = 'raw'; }
    T('gpt_extract', { source: source, contentLen: content.length, rawLen: raw.length });
    return { content: content, raw: raw, source: source, completedBy: completedBy,
      elapsedMs: Date.now() - startedAt, url: location.href, trace: trace };
  }

  async function checkState() {
    const input = findInput();
    return {
      inputFound: !!input,
      currentChatName: document.title,
      loggedOut: detectLoggedOut(),
      blocked: detectBlocked(),
    };
  }

  async function resetChat(name) {
    return { ok: true, reason: 'chatgpt_reset_not_implemented' };
  }

  globalThis.DSC_PROVIDERS = globalThis.DSC_PROVIDERS || {};
  globalThis.DSC_PROVIDERS['chatgpt'] = { name: 'chatgpt', ensureChat: ensureChat, sendPrompt: sendPrompt, limits: { maxPromptChars: CHATGPT_MAX_PROMPT_CHARS }, tooLongRe: TOO_LONG_RE,
    checkState: checkState, resetChat: resetChat, selectors: SEL };
  console.debug('[dsc:registry] chatgpt provider registered');
})();
