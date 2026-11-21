// background.js -- service worker. Polls the terminal server's /next, routes
// jobs to content.js via chrome.tabs.sendMessage, posts results to /reply.
// Classic script (MV3 SW): importScripts loads shared.js so globalThis.DSC
// is available. No ESM, no build step.
//
// Tab selection is strict: a request names a provider, and exactly one open
// tab must match that provider's exact hostname. Zero or several is refused.
// There is no pinned work tab and no fallback to another provider's tab.

'use strict';

importScripts('shared.js');

const DSC = globalThis.DSC;

const state = {
  connected: false,
  serverUrl: null,
  currentChat: null,
  lastError: null,
  promptsDone: 0,
  lastHelloAt: 0,
};

let running = false;
let loopActive = false;

// ---- config providers: dynamic host hydration --------------------------------
// The SW restarts often; dsc_registered is the persisted copy of what the last
// reconcile found on disk. Awaited before the first register()/resolveWorkTab().
const REG_KEY = DSC.STORAGE.REGISTERED;
const BUILTIN_PROVIDERS = ['deepseek', 'qwen', 'chatgpt'];
let hydrated = null;
async function hydrateDynamic() {
  const s = await chrome.storage.local.get(REG_KEY);
  DSC.setDynamicHosts(Array.isArray(s[REG_KEY]) ? s[REG_KEY] : []);
}
function ensureHydrated() {
  if (!hydrated) hydrated = hydrateDynamic().catch(() => { hydrated = null; });
  return hydrated;
}

function injectFilesFor(provider) {
  if (provider && !BUILTIN_PROVIDERS.includes(provider) && DSC.isRoutable(provider)) {
    return ['shared.js', 'providers/' + provider + '.js', 'content.js'];
  }
  return ['shared.js', 'selectors.js', 'providers/deepseek.js', 'providers/qwen.js', 'providers/chatgpt.js', 'content.js'];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadConfig() {
  const s = await chrome.storage.local.get([DSC.STORAGE.TOKEN, DSC.STORAGE.PORT]);
  const token = s[DSC.STORAGE.TOKEN];
  const port = Number(s[DSC.STORAGE.PORT] || DSC.DEFAULT_PORT);
  if (!token) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    state.connected = false;
    state.lastError = 'invalid_port: configure a port from 1 to 65535';
    broadcast();
    return null;
  }
  return { token, port, baseUrl: 'http://127.0.0.1:' + port };
}

async function apiFetch(cfg, path, init) {
  init = init || {};
  const timeoutMs = init.timeoutMs || 0;
  const headers = Object.assign(
    { 'Authorization': 'Bearer ' + cfg.token },
    init.headers || {}
  );
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const fetchInit = Object.assign({}, init, { headers });
  delete fetchInit.timeoutMs;
  let controller = null;
  let timer = null;
  if (timeoutMs > 0) {
    controller = new AbortController();
    fetchInit.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(cfg.baseUrl + path, fetchInit);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error('invalid_json_response_' + path.slice(1));
    }
    if (controller && controller.signal.aborted) throw new Error('aborted');
    if (!res.ok) {
      const err = new Error(json.error || ('http_' + res.status));
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } catch (e) {
    if (controller && controller.signal.aborted) {
      const err = new Error('timeout_' + path.slice(1));
      err.code = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Resolve the single tab for `provider`. Returns { tab } or
// { error, reason, details } -- never a fallback to another provider.
async function resolveWorkTab(targetTabId, provider) {
  await ensureHydrated();
  if (!provider || !DSC.isRoutable(provider)) {
    return {
      error: DSC.ERR.BAD_REQUEST,
      reason: 'provider_required',
      details: { provider: provider || null, known: DSC.ROUTABLE_PROVIDERS.slice() },
    };
  }

  // Caller-supplied tab ID: honour it only if that tab's exact hostname is
  // the requested provider's.
  if (targetTabId) {
    try {
      const t = await chrome.tabs.get(targetTabId);
      if (t && DSC.tabMatchesProvider(t.url, provider)) return { tab: t };
      return {
        error: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
        reason: 'target_tab_mismatch',
        details: { provider, targetTabId, url: t ? t.url : null },
      };
    } catch (_) {
      return {
        error: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
        reason: 'target_tab_not_found',
        details: { provider, targetTabId },
      };
    }
  }

  const all = await chrome.tabs.query({});
  const matches = all.filter((t) => DSC.tabMatchesProvider(t.url, provider));
  if (matches.length !== 1) {
    return {
      error: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
      reason: matches.length === 0 ? 'no_work_tab' : 'multiple_work_tabs',
      details: {
        provider,
        count: matches.length,
        tabs: matches.map((t) => ({ id: t.id, url: t.url })),
      },
    };
  }
  return { tab: matches[0] };
}

function sendOnce(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const le = chrome.runtime.lastError;
      if (le) return reject(new Error(le.message));
      resolve(resp);
    });
  });
}

async function sendToTab(tabId, msg) {
  try {
    return await sendOnce(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist/i.test(e.message)) throw e;
    // Content script is orphaned (loaded before last extension reload, or
    // lost after SW restart). Re-inject and retry once.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: injectFilesFor(msg && msg.provider),
    });
    return await sendOnce(tabId, msg);
  }
}

// Resolve when the tab reports status=complete, or after timeoutMs.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let checking = false;
    let lastUrl = null;
    let stableSince = 0;
    let pollTimer = null;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (done || checking) return;
      checking = true;
      chrome.tabs.get(tabId, (tab) => {
        checking = false;
        if (done) return;
        if (chrome.runtime.lastError || !tab) {
          finish(new Error('target_tab_unavailable_during_navigation'));
          return;
        }
        const now = Date.now();
        if (tab.status !== 'complete') {
          lastUrl = tab.url || null;
          stableSince = 0;
        } else if (tab.url !== lastUrl) {
          lastUrl = tab.url || null;
          stableSince = now;
        } else if (!stableSince) {
          stableSince = now;
        } else if (now - stableSince >= 1000) {
          finish();
          return;
        }
        pollTimer = setTimeout(check, 200);
      });
    };
    const onUpd = (id) => {
      if (id === tabId) check();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new Error('target_tab_closed_during_navigation'));
    };
    const timer = setTimeout(() => finish(new Error('navigation_timeout')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onRemoved);
    check();
  });
}

let activeRequestId = null;

async function reportProgress(cfg, requestId, phase, extra) {
  try {
    await apiFetch(cfg, '/progress', {
      method: 'POST',
      body: JSON.stringify({ requestId, phase, extra }),
    });
  } catch (e) {
    console.warn('[dsc:progress] report failed', String(requestId || '').slice(0, 8), phase, e.message);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'dsc_phase') return;
  const rid = msg.requestId;
  if (!rid || rid !== activeRequestId) {
    console.warn('[dsc:progress] dropped phase without matching active request', String(rid || '').slice(0, 8));
    return;
  }
  (async () => {
    const cfg = await loadConfig();
    if (!cfg) return;
    await apiFetch(cfg, '/progress', {
      method: 'POST',
      body: JSON.stringify({ requestId: rid, phase: msg.phase, extra: msg.extra }),
    }).catch((e) => {
      console.warn('[dsc:progress] report failed', rid.slice(0, 8), String(msg.phase || '').slice(0, 80), e.message);
    });
  })();
});

function broadcast() {
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

async function register(cfg) {
  await ensureHydrated();
  const all = await chrome.tabs.query({});
  const tabs = all.filter((t) => DSC.providerForUrl(t.url) !== null);
  const tabList = tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: (t.title || '').slice(0, 80),
    active: !!t.active,
    provider: DSC.providerForUrl(t.url),
  }));
  const resp = await apiFetch(cfg, '/hello', {
    method: 'POST',
    body: JSON.stringify({
      version: DSC.VERSION,
      buildHash: DSC.BUILD_HASH,
      tabUrl: tabList.length > 0 ? tabList[0].url : null,
      tabs: tabList,
    }),
  });
  state.connected = true;
  state.lastHelloAt = Date.now();
  state.serverUrl = cfg.baseUrl;
  state.tabs = tabList;
  state.lastError = null;
  broadcast();
  return resp;
}

async function replyError(cfg, requestId, error, reason, details) {
  await apiFetch(cfg, '/reply', {
    method: 'POST',
    body: JSON.stringify({ requestId, status: 'error', error, reason, details }),
  });
}

function traceShowsPromptDispatch(trace) {
  if (!Array.isArray(trace)) return false;
  return trace.some((entry) => entry && [
    'sendClick', 'step_6_send_clicked', 'gpt_sent', 'cfg_sent',
  ].includes(entry.phase));
}

async function handleNext(cfg, work) {
  let promptMayHaveBeenDispatched = false;
  try {
    if (!work || typeof work.requestId !== 'string' || !work.requestId ||
        !['prompt', 'open', 'reset'].includes(work.mode) ||
        typeof work.provider !== 'string' ||
        typeof work.chatName !== 'string' ||
        (work.mode === 'prompt' && typeof work.prompt !== 'string')) {
      if (work && typeof work.requestId === 'string') {
        await replyError(cfg, work.requestId, DSC.ERR.BAD_REQUEST, 'malformed_work_item');
        return;
      }
      throw new Error('malformed_work_item');
    }
    activeRequestId = work.requestId;
    await reportProgress(cfg, work.requestId, 'tabResolving', { provider: work.provider });
    const resolved = await resolveWorkTab(work.targetTabId, work.provider);
    if (!resolved.tab) {
      activeRequestId = null;
      await replyError(cfg, work.requestId, resolved.error, resolved.reason, resolved.details);
      return;
    }
    const tab = resolved.tab;
    await reportProgress(cfg, work.requestId, 'waitingPageStable', { tabId: tab.id });
    await waitForTabComplete(tab.id, 15000);
    await reportProgress(cfg, work.requestId, 'providerTabStable', { tabId: tab.id });
    // If the caller supplied a persisted chat URL (retry path), navigate
    // directly and skip the sidebar walk entirely. The URL contains the
    // UUID, which is stable for the chat's lifetime -- no fuzzy matching
    // needed, no dependence on provider's title auto-generation.
    let ensured;
    if (work.targetUrl) {
      if (DSC.providerForUrl(work.targetUrl) !== work.provider) {
        throw Object.assign(new Error('saved_chat_url_provider_mismatch'), {
          code: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
        });
      }
      await chrome.tabs.update(tab.id, { url: work.targetUrl });
      await waitForTabComplete(tab.id, 15000);
      const current = await chrome.tabs.get(tab.id);
      if (!current || !DSC.tabMatchesProvider(current.url, work.provider)) {
        throw Object.assign(new Error('saved_chat_url_redirected_to_different_host'), {
          code: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
          details: { provider: work.provider, url: current && current.url },
        });
      }
      const requestedPath = new URL(work.targetUrl).pathname.replace(/\/+$/, '');
      const actualPath = new URL(current.url).pathname.replace(/\/+$/, '');
      if (requestedPath !== actualPath) {
        throw Object.assign(new Error('saved_chat_url_redirected_to_different_conversation'), {
          code: DSC.ERR.CHAT_NOT_FOUND,
        });
      }
      await new Promise((r) => setTimeout(r, DSC.STAGE_DELAY_MS));
      const st = await sendToTab(tab.id, { action: DSC.MSG.CHECK_STATE, provider: work.provider });
      if (!st || !st.inputFound) {
        throw Object.assign(new Error('url-nav: input not found after navigate'), {
          code: (st && st.loggedOut) ? DSC.ERR.LOGGED_OUT : DSC.ERR.INPUT_NOT_FOUND,
        });
      }
      ensured = { ok: true, existing: true, mode: 'existing', url: current.url };
    }
    if (!ensured) {
      ensured = await sendToTab(tab.id, {
        action: DSC.MSG.ENSURE_CHAT,
        name: work.chatName,
        provider: work.provider,
      });
    }
    if (ensured && ensured.needNewChat) {
      // Content is on an existing chat with no sidebar match. Navigate to a
      // fresh / and retry once. URL nav is robust; button text is not.
      await chrome.tabs.update(tab.id, { url: DSC.PROVIDER_DOMAINS[work.provider] });
      await waitForTabComplete(tab.id, 15000);
      await new Promise((r) => setTimeout(r, DSC.STAGE_DELAY_MS));
      ensured = await sendToTab(tab.id, {
        action: DSC.MSG.ENSURE_CHAT,
        name: work.chatName,
        provider: work.provider,
      });
    }
    if (!ensured || !ensured.ok) {
      throw Object.assign(new Error((ensured && ensured.reason) || 'ensureChat failed'), {
        code: (ensured && ensured.error) || DSC.ERR.CHAT_NOT_FOUND,
        details: (ensured && ensured.details) || ensured,
      });
    }
    await reportProgress(cfg, work.requestId, 'chatReady', {
      existing: !!ensured.existing,
      mode: ensured.mode || null,
    });
    state.currentChat = work.chatName;
    broadcast();

    if (work.mode === 'open') {
      activeRequestId = null;
      await apiFetch(cfg, '/reply', {
        method: 'POST',
        body: JSON.stringify({
          requestId: work.requestId,
          status: 'ok',
          content: null,
          existing: !!(ensured && ensured.existing),
          mode: ensured && ensured.mode,
          debug: ensured && ensured.debug,
          url: (ensured && ensured.url) || work.targetUrl || null,
          chat: work.chatName,
        }),
      });
      return;
    }

    if (work.mode === 'reset') {
      const reset = await sendToTab(tab.id, {
        action: DSC.MSG.RESET_CHAT,
        name: work.chatName,
        provider: work.provider,
      });
      activeRequestId = null;
      await apiFetch(cfg, '/reply', {
        method: 'POST',
        body: JSON.stringify({
          requestId: work.requestId,
          status: (reset && reset.ok) ? 'ok' : 'error',
          error: (reset && reset.error) || null,
          reason: (reset && reset.reason) || null,
          chat: work.chatName,
        }),
      });
      return;
    }

    promptMayHaveBeenDispatched = true;
    const result = await sendToTab(tab.id, {
      action: DSC.MSG.SEND_PROMPT,
      prompt: work.prompt,
      delimiters: work.delimiters,
      provider: work.provider,
      requestId: work.requestId,
    });

    if (result && result.error) {
      activeRequestId = null;
      await apiFetch(cfg, '/reply', {
        method: 'POST',
        body: JSON.stringify({
          requestId: work.requestId,
          status: 'error',
          error: result.error,
          reason: result.reason,
          retryAfter: result.retryAfter,
          details: result.details,
          probe: result.probe,
          trace: result.trace,
          executionState: Array.isArray(result.trace)
            ? (traceShowsPromptDispatch(result.trace) ? 'outcome_unknown' : 'not_dispatched')
            : 'outcome_unknown',
        }),
      });
      return;
    }

    state.promptsDone += 1;
    broadcast();
    activeRequestId = null;
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'ok',
        content: result.content,
        raw: result.raw,
        url: result.url,
        trace: result.trace,
      }),
    });
  } catch (e) {
    state.lastError = e.message;
    activeRequestId = null;
    broadcast();
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'error',
        error: e.code || 'background_error',
        reason: e.message,
        details: e.details,
        executionState: promptMayHaveBeenDispatched ? 'outcome_unknown' : 'not_dispatched',
        retryable: !promptMayHaveBeenDispatched,
      }),
    }).catch((replyError) => {
      console.error('[dsc:reply] failed to report error', String(work && work.requestId || '').slice(0, 8), replyError.message);
    });
  }
}

// ---- P2: automatic reload on build-hash mismatch ----------------------------
// Cooldown state lives in chrome.storage.local (key dsc_last_reload), NOT in a
// module variable: chrome.runtime.reload() tears down this service worker, so
// module-level state would reset and the cooldown would never hold.
const LAST_RELOAD_KEY = 'dsc_last_reload';
const RELOAD_COOLDOWN_MS = 60000;

async function fetchServerHash(cfg, mismatchBody) {
  try {
    const v = await apiFetch(cfg, '/version', { method: 'GET' });
    if (v && v.buildHash) return v.buildHash;
  } catch (_) { /* fall through to the hash the 409 carried */ }
  const d = mismatchBody && mismatchBody.details;
  return (d && d.server) || null;
}

// Returns true if a reload was triggered. Never throws.
async function reloadIfStale(cfg, mismatchBody) {
  try {
    const own = DSC.BUILD_HASH;
    const srv = await fetchServerHash(cfg, mismatchBody);
    if (!srv || srv === own) return false;

    const s = await chrome.storage.local.get(LAST_RELOAD_KEY);
    const last = s[LAST_RELOAD_KEY];
    const now = Date.now();
    if (last && now - last.at < RELOAD_COOLDOWN_MS) {
      console.warn('[dsc:reload] skipped: cooldown (' + Math.round((now - last.at) / 1000) + 's since last reload)');
      return false;
    }
    if (last && last.ext === own && last.srv === srv) {
      console.warn('[dsc:reload] skipped: already reloaded for ext=' + own + ' srv=' + srv +
                   '; disk build is unchanged, reload cannot fix this');
      return false;
    }
    await chrome.storage.local.set({ [LAST_RELOAD_KEY]: { at: now, ext: own, srv } });
    console.warn('[dsc:reload] build mismatch ext=' + own + ' srv=' + srv + ' -> chrome.runtime.reload()');
    chrome.runtime.reload();
    return true;
  } catch (e) {
    console.warn('[dsc:reload] check failed:', e && e.message);
    return false;
  }
}

async function pollLoop() {
  if (loopActive) return;
  loopActive = true;

  let backoffIdx = 0;
  while (running) {
    const cfg = await loadConfig();
    if (!cfg) { await sleep(2000); continue; }

    if (!state.connected) {
      try {
        await register(cfg);
        backoffIdx = 0;
      } catch (e) {
        state.connected = false;
        state.lastError = (e.body && e.body.reason) || e.message;
        broadcast();
        if (e.body && e.body.error === 'version_mismatch') {
          await reloadIfStale(cfg, e.body);
        }
        const wait = DSC.RECONNECT_BACKOFF_MS[Math.min(backoffIdx, DSC.RECONNECT_BACKOFF_MS.length - 1)];
        backoffIdx += 1;
        await sleep(wait);
        continue;
      }
    }

    let work;
    try {
      // Bounded: server holds 30s; a dead socket must not wedge the loop.
      work = await apiFetch(cfg, '/next', { method: 'GET', timeoutMs: DSC.LONG_POLL_MS + 10000 });
    } catch (e) {
      state.connected = false;
      state.lastError = e.message;
      broadcast();
      await sleep(DSC.RECONNECT_BACKOFF_MS[0]);
      continue;
    }

    if (!work || work.action === 'idle') continue;
    if (work.action !== 'next') {
      if (typeof work.requestId === 'string') {
        await replyError(cfg, work.requestId, DSC.ERR.BAD_REQUEST, 'unexpected_poll_action')
          .catch((e) => console.error('[dsc:reply] unexpected action report failed', e.message));
      }
      state.lastError = 'unexpected_poll_action';
      state.connected = false;
      broadcast();
      await sleep(DSC.RECONNECT_BACKOFF_MS[0]);
      continue;
    }

    await handleNext(cfg, work);
  }

  loopActive = false;
}

function startLoop() {
  if (running) return;
  running = true;
  pollLoop().catch((e) => {
    state.lastError = e.message;
    broadcast();
    running = false;
  });
}

function stopLoop() {
  running = false;
}

let tabRefreshTimer = null;
function refreshTabsSoon() {
  if (tabRefreshTimer) return;
  tabRefreshTimer = setTimeout(async () => {
    tabRefreshTimer = null;
    if (!state.connected) return;
    const cfg = await loadConfig();
    if (!cfg) return;
    try { await register(cfg); } catch (_) {}
  }, 1000);
}
chrome.tabs.onCreated.addListener(() => refreshTabsSoon());
chrome.tabs.onRemoved.addListener(() => refreshTabsSoon());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) refreshTabsSoon();
});

chrome.runtime.onInstalled.addListener(() => { startLoop(); });
chrome.runtime.onStartup.addListener(() => { startLoop(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[DSC.STORAGE.TOKEN] || changes[DSC.STORAGE.PORT]) {
    state.connected = false;
    broadcast();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'reconcileProviders') {
    reconcileProviders().then((r) => sendResponse(r || { ok: true }), (e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }
  if (msg && msg.type === 'getState') {
    sendResponse({ state });
    return false;
  }
  if (msg && msg.type === 'start') { startLoop(); sendResponse({ ok: true }); return false; }
  if (msg && msg.type === 'stop')  { stopLoop();  sendResponse({ ok: true }); return false; }
  return false;
});

// ---- config providers: reconcile providers/ on disk with content scripts -----
// GET /providers is the source of truth. dsc_registered is a cache plus the
// per-machine `enabled` flag. A storage change only re-hydrates (no reconcile),
// so writing the rows here cannot loop.
const DYN_PREFIX = 'dsc-provider-';
let reconciling = null;

function reconcileProviders() {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const cfg = await loadConfig();
    if (!cfg) return { ok: false, reason: 'no_config' };
    const s = await chrome.storage.local.get(REG_KEY);
    const prev = Array.isArray(s[REG_KEY]) ? s[REG_KEY] : [];
    let listing;
    try {
      listing = await apiFetch(cfg, '/providers', { method: 'GET', timeoutMs: 8000 });
    } catch (e) {
      DSC.setDynamicHosts(prev); // server down: keep the cache, prune nothing
      return { ok: false, reason: 'server_down' };
    }
    const enabledBefore = new Map(prev.map((r) => [r.name, r.enabled !== false]));
    const rows = [];
    for (const p of (listing.providers || []).filter((x) => x.kind === 'config')) {
      const id = DYN_PREFIX + p.name;
      if (!p.definition || !Array.isArray(p.definition.domains)) {
        rows.push({ name: p.name, id, domains: [], enabled: false, status: 'no definition' });
        continue;
      }
      const domains = p.definition.domains;
      const enabled = enabledBefore.has(p.name) ? enabledBefore.get(p.name) : true;
      let granted = false;
      try { granted = await chrome.permissions.contains({ origins: domains.map((d) => 'https://' + d + '/*') }); } catch (_) { granted = false; }
      rows.push({ name: p.name, id, domains, enabled, status: !enabled ? 'disabled' : granted ? 'registered' : 'permission needed' });
    }

    const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((x) => x.id.startsWith(DYN_PREFIX));
    const want = new Map(rows.filter((r) => r.status === 'registered').map((r) => [r.id, r]));
    const stale = existing.filter((x) => !want.has(x.id)).map((x) => x.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
    for (const r of want.values()) {
      const script = {
        id: r.id,
        matches: r.domains.map((d) => 'https://' + d + '/*'),
        js: ['shared.js', 'providers/' + r.name + '.js', 'content.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      };
      try {
        if (existing.some((x) => x.id === r.id)) await chrome.scripting.updateContentScripts([script]);
        else await chrome.scripting.registerContentScripts([script]);
      } catch (e) {
        r.status = 'register failed: ' + e.message;
      }
    }
    await chrome.storage.local.set({ [REG_KEY]: rows });
    DSC.setDynamicHosts(rows);
    refreshTabsSoon();
    return { ok: true, providers: rows.length };
  })().finally(() => { reconciling = null; });
  return reconciling;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[REG_KEY]) DSC.setDynamicHosts(changes[REG_KEY].newValue || []);
});
chrome.runtime.onInstalled.addListener(() => { reconcileProviders().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { reconcileProviders().catch(() => {}); });
ensureHydrated().then(() => reconcileProviders()).catch(() => {});

startLoop();

