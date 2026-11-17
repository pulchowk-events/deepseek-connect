// shared.js -- constants and shapes used by background.js (service worker),
// content scripts, extension pages, and (via require) src/server.js.
// Classic script: no ESM, no CJS exports. Everything lives on globalThis.DSC.
//
// The server reads the build stamp below straight from this file (regex), so
// keep the stamp on a single line in the form KEY: 'value'. Bump it on every
// change to extension code; extension and server compare it on /hello.

(function () {
  'use strict';

  const DSC = {
    VERSION: '0.2.0',

    BUILD_HASH: 'cfg-providers-20261117a',

    STORAGE: {
      TOKEN: 'dsc_token',
      PORT: 'dsc_port',
      REGISTERED: 'dsc_registered',
    },

    DEFAULT_PORT: 7331,

    // Built-in providers with a code module. Config providers are added to this
    // list at runtime by registerDynamicProvider().
    ROUTABLE_PROVIDERS: ['deepseek', 'qwen'],

    // Built-in hosts (exact hostname). Never mutated at runtime.
    PROVIDER_HOSTS: {
      deepseek: 'chat.deepseek.com',
      qwen: 'chat.qwen.ai',
      tongyi: 'tongyi.aliyun.com',
    },

    // Origin (with trailing slash) used for navigation. Config providers are
    // added at runtime.
    PROVIDER_DOMAINS: {
      deepseek: 'https://chat.deepseek.com/',
      qwen: 'https://chat.qwen.ai/',
      tongyi: 'https://tongyi.aliyun.com/',
    },

    // name -> [hostnames] for config providers (providers/<name>.js).
    DYNAMIC_HOSTS: {},

    LONG_POLL_MS: 30000,

    RECONNECT_BACKOFF_MS: [1000, 2000, 5000, 10000],

    RESPONSE_TIMEOUT_MS: 90000,

    MSG: {
      ENSURE_CHAT: 'ensureChat',
      SEND_PROMPT: 'sendPrompt',
      CHECK_STATE: 'checkState',
      RESET_CHAT: 'resetChat',
    },

    ERR: {
      DOM_DRIFT: 'dom_drift',
      INPUT_NOT_FOUND: 'input_not_found',
      DEEPTHINK_ENABLE_FAILED: 'deepthink_enable_failed',
      SEARCH_ENABLE_FAILED: 'search_enable_failed',
      CHAT_NOT_FOUND: 'chat_not_found',
      RATE_LIMITED: 'rate_limited',
      LOGGED_OUT: 'logged_out',
      RESPONSE_TIMEOUT: 'response_timeout',
      SEND_FAILED: 'send_failed',
      INVALID_RESPONSE_FORMAT: 'invalid_response_format',
      AMBIGUOUS_PROVIDER_TAB: 'ambiguous_provider_tab',
      VERSION_MISMATCH: 'version_mismatch',
      BAD_REQUEST: 'bad_request',
    },

    DELIMITER_RE: /^[ \t]*(\S+)[ \t]+START_(\S+)[ \t]*$([\s\S]*?)^[ \t]*\1[ \t]+END_\2[ \t]*$/m,

    FENCE_JS_RE: /```(?:js|javascript)\s*\n([\s\S]*?)```/g,
  };

  // Idempotent injection: a second load of the same build keeps the first DSC.
  if (globalThis.DSC && globalThis.DSC.BUILD_HASH === DSC.BUILD_HASH && globalThis.DSC.makeConfigProvider) return;

  const BUILTIN_ROUTABLE = ['deepseek', 'qwen'];
  const BUILTIN_NAMES = ['deepseek', 'qwen', 'tongyi'];
  const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
  const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  DSC.NAME_RE = NAME_RE;
  DSC.HOST_RE = HOST_RE;

  // Lowercased hostname of a URL, or null if it does not parse.
  DSC.hostnameOf = function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return null;
    }
  };

  // Provider name from a URL, or null. https + exact hostname equality.
  // Built-ins first, then config providers. The mock fixture counts as deepseek.
  DSC.providerForUrl = function providerForUrl(url) {
    url = url || '';
    let u = null;
    try { u = new URL(url); } catch (_) { u = null; }
    if (u && u.protocol === 'https:') {
      const host = u.hostname.toLowerCase();
      for (const [name, h] of Object.entries(DSC.PROVIDER_HOSTS)) {
        if (host === h) return name;
      }
      for (const [name, hosts] of Object.entries(DSC.DYNAMIC_HOSTS)) {
        if (hosts.includes(host)) return name;
      }
    }
    if (/^file:\/\/.*mock-deepseek\.html/.test(url)) return 'deepseek';
    return null;
  };

  DSC.tabMatchesProvider = function tabMatchesProvider(url, provider) {
    return !!provider && DSC.providerForUrl(url) === provider;
  };

  DSC.isRoutable = function isRoutable(name) {
    return !!name && DSC.ROUTABLE_PROVIDERS.includes(name);
  };

  // ---- config providers: registry ------------------------------------------
  DSC.registerDynamicProvider = function registerDynamicProvider(name, domains) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('bad provider name: ' + name);
    if (BUILTIN_NAMES.includes(name)) throw new Error('"' + name + '" is a built-in provider');
    if (!Array.isArray(domains) || domains.length === 0 || !domains.every((d) => typeof d === 'string' && HOST_RE.test(d))) {
      throw new Error('bad domains for provider ' + name);
    }
    DSC.DYNAMIC_HOSTS[name] = domains.slice();
    DSC.PROVIDER_DOMAINS[name] = 'https://' + domains[0] + '/';
    if (!DSC.ROUTABLE_PROVIDERS.includes(name)) DSC.ROUTABLE_PROVIDERS.push(name);
  };

  DSC.clearDynamicProviders = function clearDynamicProviders() {
    for (const n of Object.keys(DSC.DYNAMIC_HOSTS)) delete DSC.PROVIDER_DOMAINS[n];
    DSC.DYNAMIC_HOSTS = {};
    DSC.ROUTABLE_PROVIDERS.length = 0;
    for (const n of BUILTIN_ROUTABLE) DSC.ROUTABLE_PROVIDERS.push(n);
  };

  // list: [{ name, domains, enabled }] (the dsc_registered rows).
  DSC.setDynamicHosts = function setDynamicHosts(list) {
    DSC.clearDynamicProviders();
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || r.enabled === false || !Array.isArray(r.domains) || r.domains.length === 0) continue;
      try { DSC.registerDynamicProvider(r.name, r.domains); } catch (_) { /* skip bad row */ }
    }
  };

  // ---- config providers: definition validation (pure; also used by the server)
  const TOP_KEYS = ['schema', 'name', 'label', 'domains', 'selectors', 'dismiss', 'timeouts',
    'pacingMs', 'extraction', 'delimiter', 'completionMode', 'completionStableMs'];
  const SEL_KEYS = ['input', 'send', 'stop', 'response', 'code'];
  const EXTRACTIONS = ['rawText', 'codeBlock', 'delimiter'];
  const MODES = ['whichever', 'stopGone', 'textStable', 'delimiter'];

  function isStrArr(a, min) {
    return Array.isArray(a) && a.length >= min &&
      a.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= 300);
  }
  function inRange(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

  // -> { ok:true, value } | { ok:false, errors:[...] }. value has every default applied.
  DSC.validateDefinition = function validateDefinition(def) {
    const errors = [];
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      return { ok: false, errors: ['definition must be an object'] };
    }
    for (const k of Object.keys(def)) if (!TOP_KEYS.includes(k)) errors.push('unknown key "' + k + '"');
    if (def.schema !== 1) errors.push('schema must be 1');

    if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) {
      errors.push('name must match ' + NAME_RE);
    } else if (BUILTIN_NAMES.includes(def.name)) {
      errors.push('name "' + def.name + '" is a built-in provider');
    }
    if (typeof def.label !== 'string' || def.label.trim() === '' || def.label.length > 80) {
      errors.push('label required (max 80 chars)');
    }

    let domains = [];
    if (!Array.isArray(def.domains) || def.domains.length === 0) {
      errors.push('domains must be a non-empty array of hostnames');
    } else {
      domains = def.domains.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : d));
      const staticHosts = Object.values(DSC.PROVIDER_HOSTS);
      for (const d of domains) {
        if (typeof d !== 'string' || !HOST_RE.test(d)) {
          errors.push('domain "' + d + '" is not a plain hostname (no protocol, port, path, wildcard, IP or localhost)');
        } else if (staticHosts.includes(d)) {
          errors.push('domain "' + d + '" belongs to a built-in provider');
        }
      }
      domains = Array.from(new Set(domains));
    }

    const sel = def.selectors;
    if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
      errors.push('selectors must be an object');
    } else {
      for (const k of Object.keys(sel)) if (!SEL_KEYS.includes(k)) errors.push('unknown selectors key "' + k + '"');
      for (const k of ['input', 'send', 'response']) {
        if (!isStrArr(sel[k], 1)) errors.push('selectors.' + k + ' must be a non-empty array of selector strings');
      }
      for (const k of ['stop', 'code']) {
        if (sel[k] !== undefined && !isStrArr(sel[k], 0)) errors.push('selectors.' + k + ' must be an array of selector strings');
      }
    }
    if (def.dismiss !== undefined && !isStrArr(def.dismiss, 0)) errors.push('dismiss must be an array of selector strings');

    const to = def.timeouts === undefined ? {} : def.timeouts;
    if (!to || typeof to !== 'object' || Array.isArray(to)) {
      errors.push('timeouts must be an object');
    } else {
      for (const k of Object.keys(to)) if (k !== 'sendMs' && k !== 'responseMs') errors.push('unknown timeouts key "' + k + '"');
      if (to.sendMs !== undefined && !inRange(to.sendMs, 1000, 60000)) errors.push('timeouts.sendMs must be an integer 1000-60000');
      if (to.responseMs !== undefined && !inRange(to.responseMs, 10000, 900000)) errors.push('timeouts.responseMs must be an integer 10000-900000');
    }
    if (def.pacingMs !== undefined && !inRange(def.pacingMs, 0, 60000)) errors.push('pacingMs must be an integer 0-60000');
    if (def.extraction !== undefined && !EXTRACTIONS.includes(def.extraction)) errors.push('extraction must be one of ' + EXTRACTIONS.join(', '));
    if (def.completionMode !== undefined && !MODES.includes(def.completionMode)) errors.push('completionMode must be one of ' + MODES.join(', '));
    if (def.completionStableMs !== undefined && !inRange(def.completionStableMs, 1500, 30000)) errors.push('completionStableMs must be an integer 1500-30000');

    const extraction = def.extraction === undefined ? 'rawText' : def.extraction;
    const mode = def.completionMode === undefined ? 'whichever' : def.completionMode;
    if (def.delimiter !== undefined) {
      const d = def.delimiter;
      if (extraction !== 'delimiter') errors.push('delimiter is only allowed with extraction "delimiter"');
      if (!d || typeof d !== 'object' || typeof d.prefix !== 'string' || typeof d.suffix !== 'string' ||
          d.prefix.trim() === '' || d.suffix.trim() === '' || d.prefix === d.suffix) {
        errors.push('delimiter needs distinct non-empty prefix and suffix strings');
      }
    } else if (extraction === 'delimiter') {
      errors.push('extraction "delimiter" requires a delimiter {prefix, suffix}');
    }
    if (mode === 'delimiter' && extraction !== 'delimiter') errors.push('completionMode "delimiter" requires extraction "delimiter"');

    if (errors.length) return { ok: false, errors };

    const value = {
      schema: 1,
      name: def.name,
      label: def.label.trim(),
      domains,
      selectors: {
        input: sel.input.slice(),
        send: sel.send.slice(),
        stop: (sel.stop || []).slice(),
        response: sel.response.slice(),
        code: (sel.code && sel.code.length ? sel.code : ['pre code', 'pre']).slice(),
      },
      timeouts: {
        sendMs: to.sendMs === undefined ? 15000 : to.sendMs,
        responseMs: to.responseMs === undefined ? 180000 : to.responseMs,
      },
      pacingMs: def.pacingMs === undefined ? 0 : def.pacingMs,
      extraction,
      completionMode: mode,
      completionStableMs: def.completionStableMs === undefined ? 4000 : def.completionStableMs,
    };
    if (def.dismiss && def.dismiss.length) value.dismiss = def.dismiss.slice();
    if (def.delimiter) value.delimiter = { prefix: def.delimiter.prefix, suffix: def.delimiter.suffix };
    return { ok: true, value };
  };

  // ---- config providers: generic runner ------------------------------------
  // Same interface as providers/deepseek.js and providers/qwen.js.
  // Content-script only (touches document/chrome at call time, never at load).
  DSC.makeConfigProvider = function makeConfigProvider(rawDef) {
    const v = DSC.validateDefinition(rawDef);
    if (!v.ok) throw new Error('makeConfigProvider: ' + v.errors.join('; '));
    const def = v.value;
    DSC.registerDynamicProvider(def.name, def.domains);

    const S = def.selectors;
    const E = DSC.ERR;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let lastSendAt = 0; // tab-local: a tab reload resets pacing

    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }
    function q(sels, needVisible) {
      for (const s of sels) {
        let el = null;
        try { el = document.querySelector(s); } catch (_) { el = null; }
        if (el && (!needVisible || visible(el))) return el;
      }
      return null;
    }
    function countOf(sel) {
      try { return document.querySelectorAll(sel).length; } catch (_) { return 0; }
    }
    function qAll(sels) {
      for (const s of sels) {
        let l = [];
        try { l = Array.from(document.querySelectorAll(s)); } catch (_) { l = []; }
        if (l.length) return l;
      }
      return [];
    }
    async function waitFor(fn, timeout, interval) {
      const start = Date.now();
      for (;;) {
        let r = null;
        try { r = fn(); } catch (_) { r = null; }
        if (r) return r;
        if (Date.now() - start >= timeout) return null;
        await sleep(interval || 200);
      }
    }
    function dismiss() {
      for (const s of def.dismiss || []) {
        const el = q([s], true);
        if (el) { try { el.click(); } catch (_) { /* ignore */ } }
      }
    }
    const findInput = () => q(S.input, true);
    function findSend() {
      const b = q(S.send, true);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }
    const stopPresent = () => S.stop.length > 0 && q(S.stop, true) !== null;

    function setInput(el, text) {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
    function readInput(el) {
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      return el.textContent || '';
    }
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const isRootToChat = (a, b) => {
      try {
        const pa = new URL(a).pathname; const pb = new URL(b).pathname;
        return (pa === '/' || pa === '') && pb !== '/' && pb !== '';
      } catch (_) { return false; }
    };

    async function ensureChat(name) {
      dismiss();
      const debug = { name, path: location.pathname, provider: def.name };
      const input = await waitFor(findInput, def.timeouts.sendMs);
      if (!input) return { ok: false, error: E.INPUT_NOT_FOUND, reason: 'input_not_found', debug };
      if (location.pathname !== '/' && location.pathname !== '' && qAll(S.response).length > 0) {
        return { ok: false, needNewChat: true, mode: 'need_nav', path: location.pathname, debug };
      }
      return { ok: true, existing: false, mode: 'fresh', debug };
    }

    async function checkState() {
      dismiss();
      const input = findInput();
      return {
        inputFound: !!input,
        currentChatName: document.title,
        loggedOut: !input && document.querySelectorAll('input[type="password"]').length > 0,
      };
    }

    async function resetChat() {
      return { ok: true, reason: 'config_reset_not_implemented' };
    }

    async function sendPrompt(prompt) {
      const startedAt = Date.now();
      const trace = [];
      const T = (phase, extra) => {
        try { chrome.runtime.sendMessage({ type: 'dsc_phase', phase, extra }).catch(() => {}); } catch (_) { /* port closed */ }
        trace.push(Object.assign({ t: Date.now() - startedAt, phase }, extra || {}));
        if (trace.length > 80) trace.splice(1, 1);
      };
      const fail = (error, reason, extra) =>
        Object.assign({ error, reason, trace, elapsedMs: Date.now() - startedAt }, extra || {});

      dismiss();
      const input = await waitFor(findInput, def.timeouts.sendMs);
      T('cfg_input', { found: !!input });
      if (!input) return fail(E.INPUT_NOT_FOUND, 'input_not_found');

      // TYPED: snapshot per-selector counts, then fill the input.
      const before = {};
      for (const s of S.response) before[s] = countOf(s);
      setInput(input, prompt);
      await sleep(150);
      const typedLen = readInput(input).length;
      T('cfg_typed', { promptLen: prompt.length, typedLen });
      if (typedLen === 0) return fail(E.SEND_FAILED, 'input_empty_after_set');

      // PACED
      const gap = def.pacingMs - (Date.now() - lastSendAt);
      if (gap > 0) await sleep(gap);
      await sleep(Math.max(300, Math.round(def.pacingMs / 3)));
      T('cfg_paced', { pacingMs: def.pacingMs });

      // SENT
      const btn = await waitFor(findSend, def.timeouts.sendMs);
      if (!btn) return fail(E.SEND_FAILED, 'send_button_not_found');
      btn.click();
      lastSendAt = Date.now();
      const sentAt = lastSendAt;
      T('cfg_sent', { ms: sentAt - startedAt });

      // New response elements: first selector whose match count grew.
      function newResponseEls() {
        for (const s of S.response) {
          let cur = [];
          try { cur = Array.from(document.querySelectorAll(s)); } catch (_) { cur = []; }
          if (cur.length > (before[s] || 0)) return cur;
        }
        return [];
      }
      const evidence = await waitFor(() => {
        const cur = findInput();
        return !cur || readInput(cur).length < Math.max(1, typedLen / 2) || stopPresent() || newResponseEls().length > 0;
      }, def.timeouts.sendMs);
      if (!evidence) return fail(E.SEND_FAILED, 'send_not_registered');

      // STREAMING
      const head = norm(prompt).slice(0, 80);
      const isEcho = (t) => head.length >= 30 && norm(t).includes(head);
      const delimOk = (t) => {
        if (!def.delimiter) return false;
        const end = t.lastIndexOf(def.delimiter.suffix);
        return end >= 0 && t.lastIndexOf(def.delimiter.prefix, end) >= 0;
      };
      let streamUrl = null; let urlHop = false;
      let lastKey = ''; let stableSince = Date.now();
      let seenStop = false; let noStopPolls = 0;
      let completedBy = null; let sawMsg = false; let text = '';
      const deadline = sentAt + def.timeouts.responseMs;
      let lastLog = 0;

      while (Date.now() < deadline) {
        await sleep(500);
        const stop = stopPresent();
        if (stop) seenStop = true;
        noStopPolls = stop ? 0 : noStopPolls + 1;

        const els = newResponseEls();
        if (els.length === 0) continue;
        if (!sawMsg) { sawMsg = true; streamUrl = location.href; T('cfg_first', { msgs: els.length }); }
        if (location.href !== streamUrl) {
          if (!urlHop && isRootToChat(streamUrl, location.href)) { streamUrl = location.href; urlHop = true; }
          else return fail(E.DOM_DRIFT, 'user_navigated', { expected: streamUrl, actual: location.href });
        }

        const last = els[els.length - 1];
        let t = ((last.innerText || last.textContent) || '').trim();
        if (isEcho(t)) t = '';
        const key = t.length + '|' + t.slice(0, 64) + '|' + t.slice(-64);
        if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
        text = t;
        if (Date.now() - lastLog > 3000) { lastLog = Date.now(); T('cfg_stream', { len: t.length, stop, seenStop }); }
        if (!t || stop) continue;

        const stableFor = Date.now() - stableSince;
        const cond = {
          stopGone: seenStop && noStopPolls >= 2 && stableFor >= 1000,
          textStable: stableFor >= def.completionStableMs,
          delimiter: delimOk(t) && stableFor >= 1500,
        };
        const mode = def.completionMode;
        if (mode === 'whichever') {
          completedBy = cond.stopGone ? 'stopGone' : cond.textStable ? 'textStable' : cond.delimiter ? 'delimiter' : null;
        } else {
          completedBy = cond[mode] ? mode : null;
        }
        if (completedBy) break;
      }
      T('cfg_done', { completedBy, sawMsg, len: text.length });
      if (!sawMsg) return fail(E.RESPONSE_TIMEOUT, 'no_new_message');
      if (!completedBy) return fail(E.RESPONSE_TIMEOUT, 'completion_timeout');

      // EXTRACT
      const finalEls = newResponseEls();
      const lastEl = finalEls.length ? finalEls[finalEls.length - 1] : null;
      const raw = lastEl ? ((lastEl.innerText || lastEl.textContent) || '').trim() : text;
      if (!raw || isEcho(raw)) return fail(E.RESPONSE_TIMEOUT, 'empty_response');
      if (raw.length < 300 && /too many requests|rate limit/i.test(raw)) {
        return fail(E.RATE_LIMITED, 'rate_limited', { retryAfter: 30000 });
      }

      let content = null;
      if (def.extraction === 'rawText') {
        content = raw;
      } else if (def.extraction === 'codeBlock') {
        let code = null;
        for (const s of S.code) {
          let l = [];
          try { l = Array.from(lastEl.querySelectorAll(s)); } catch (_) { l = []; }
          if (l.length) { code = (l[l.length - 1].innerText || l[l.length - 1].textContent || '').trim(); break; }
        }
        const vm = raw.match(/^[ \t]*VERDICT[ \t]*:.*$/mi);
        const verdictLine = vm ? vm[0].trim() : null;
        if (code) {
          content = (verdictLine ? verdictLine + '\n' : '') + '```js\n' + code + '\n```';
        } else if (verdictLine) {
          content = verdictLine;
        } else {
          return fail(E.INVALID_RESPONSE_FORMAT, 'no_code_block', { rawPreview: raw.slice(0, 200) });
        }
      } else {
        const end = raw.lastIndexOf(def.delimiter.suffix);
        const start = end >= 0 ? raw.lastIndexOf(def.delimiter.prefix, end) : -1;
        if (end < 0 || start < 0) return fail(E.INVALID_RESPONSE_FORMAT, 'delimiters_missing', { rawPreview: raw.slice(0, 200) });
        content = raw.slice(start + def.delimiter.prefix.length, end).trim();
      }
      T('cfg_extract', { source: def.extraction, contentLen: content.length, rawLen: raw.length });
      return {
        content, raw, source: def.extraction, completedBy,
        elapsedMs: Date.now() - startedAt, url: location.href, trace,
      };
    }

    globalThis.DSC_PROVIDERS = globalThis.DSC_PROVIDERS || {};
    const provider = { name: def.name, ensureChat, sendPrompt, checkState, resetChat };
    globalThis.DSC_PROVIDERS[def.name] = provider;
    console.debug('[dsc:registry]', def.name, 'provider registered');
    return provider;
  };

  // PROVIDER CONTRACT -- a provider registers itself as
  //   globalThis.DSC_PROVIDERS['<name>'] = { name, ensureChat, sendPrompt, checkState, resetChat }
  // Built-in code modules (deepseek, qwen) are listed in manifest.json and
  // background.js. Config providers are providers/<name>.js files calling
  // DSC.makeConfigProvider({...}); they need no edits to any existing file.

  globalThis.DSC = DSC;
})();
