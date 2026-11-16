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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadConfig() {
  const s = await chrome.storage.local.get([DSC.STORAGE.TOKEN, DSC.STORAGE.PORT]);
  const token = s[DSC.STORAGE.TOKEN];
  const port = s[DSC.STORAGE.PORT] || DSC.DEFAULT_PORT;
  if (!token) return null;
  return { token, port, baseUrl: 'http://127.0.0.1:' + port };
}

async function apiFetch(cfg, path, init) {
  init = init || {};
  const headers = Object.assign(
    { 'Authorization': 'Bearer ' + cfg.token },
    init.headers || {}
  );
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(cfg.baseUrl + path, Object.assign({}, init, { headers }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || ('http_' + res.status));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Resolve the single tab for `provider`. Returns { tab } or
// { error, reason, details } -- never a fallback to another provider.
async function resolveWorkTab(targetTabId, provider) {
  if (!provider || !DSC.ROUTABLE_PROVIDERS.includes(provider)) {
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
      files: ['shared.js', 'selectors.js', 'providers/deepseek.js', 'providers/qwen.js', 'content.js'],
    });
    return await sendOnce(tabId, msg);
  }
}

// Resolve when the tab reports status=complete, or after timeoutMs.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    }, timeoutMs);
  });
}

let activeRequestId = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'dsc_phase') return;
  if (!activeRequestId) return;
  const rid = activeRequestId;
  (async () => {
    const cfg = await loadConfig();
    if (!cfg) return;
    await apiFetch(cfg, '/progress', {
      method: 'POST',
      body: JSON.stringify({ requestId: rid, phase: msg.phase, extra: msg.extra }),
    }).catch(() => {});
  })();
});

function broadcast() {
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

async function register(cfg) {
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

async function handleNext(cfg, work) {
  const resolved = await resolveWorkTab(work.targetTabId, work.provider);
  if (!resolved.tab) {
    await replyError(cfg, work.requestId, resolved.error, resolved.reason, resolved.details);
    return;
  }
  const tab = resolved.tab;

  try {
    activeRequestId = work.requestId;
    // If the caller supplied a persisted chat URL (retry path), navigate
    // directly and skip the sidebar walk entirely. The URL contains the
    // UUID, which is stable for the chat's lifetime -- no fuzzy matching
    // needed, no dependence on provider's title auto-generation.
    let ensured;
    if (work.targetUrl) {
      try {
        await chrome.tabs.update(tab.id, { url: work.targetUrl });
        await waitForTabComplete(tab.id, 15000);
        await new Promise((r) => setTimeout(r, 800));
        const st = await sendToTab(tab.id, { action: DSC.MSG.CHECK_STATE, provider: work.provider });
        if (!st || !st.inputFound) {
          throw Object.assign(new Error('url-nav: input not found after navigate'), {
            code: DSC.ERR.INPUT_NOT_FOUND,
          });
        }
        ensured = { ok: true, existing: true, mode: 'existing', url: work.targetUrl };
      } catch (e) {
        // Fall through to ensureChat as a safety net -- the URL might be
        // stale (chat deleted, provider relocated the UUID).
        ensured = null;
      }
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
      await new Promise((r) => setTimeout(r, 800));
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

    const result = await sendToTab(tab.id, {
      action: DSC.MSG.SEND_PROMPT,
      prompt: work.prompt,
      delimiters: work.delimiters,
      provider: work.provider,
    });

    if (result && result.error) {
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
      }),
    }).catch(() => {});
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
      work = await apiFetch(cfg, '/next', { method: 'GET' });
    } catch (e) {
      state.connected = false;
      state.lastError = e.message;
      broadcast();
      await sleep(DSC.RECONNECT_BACKOFF_MS[0]);
      continue;
    }

    if (!work || work.action === 'idle') continue;
    if (work.action !== 'next') continue;

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
  if (msg && msg.type === 'getState') {
    sendResponse({ state });
    return false;
  }
  if (msg && msg.type === 'start') { startLoop(); sendResponse({ ok: true }); return false; }
  if (msg && msg.type === 'stop')  { stopLoop();  sendResponse({ ok: true }); return false; }
  return false;
});

startLoop();
