// background.js — service worker. Polls the terminal server's /next, routes
// jobs to content.js via chrome.tabs.sendMessage, posts results to /reply.
// Classic script (MV3 SW): importScripts loads shared.js so globalThis.DSC
// is available. No ESM, no build step.

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

async function getWorkTab(targetTabId, provider) {
  const providerDomains = DSC.PROVIDER_DOMAINS;
  const isWorkUrl = (url) => DSC.providerForUrl(url) !== null;

  // Caller-supplied tab ID: honour it only if it matches the requested
  // provider (or no provider was requested). No silent fallback — a stale
  // tab ID plus a provider mismatch is a caller bug.
  if (targetTabId) {
    try {
      const t = await chrome.tabs.get(targetTabId);
      if (!t) return null;
      if (provider) {
        const prefix = providerDomains[provider];
        if (!prefix || !(t.url || '').startsWith(prefix)) return null;
      } else if (!isWorkUrl(t.url)) {
        return null;
      }
      return t;
    } catch (_) { return null; }
  }

  // Provider-scoped: query that provider's domain directly, bypass the
  // pinned work tab. Without this, a single pinned tab ID would route
  // every provider through the same tab, which breaks the multi-provider
  // contract the moment two tabs are open.
  if (provider) {
    const prefix = providerDomains[provider];
    if (!prefix) return null;
    const candidates = await chrome.tabs.query({ url: prefix + '*' });
    if (candidates.length === 0) return null;
    return candidates.find((t) => !t.active) || candidates[0];
  }

  // Default (no provider): existing behaviour — pinned tab first, else
  // first non-active across all supported domains, else mock fixture.
  const stored = await chrome.storage.local.get('workTabId');
  if (stored && stored.workTabId) {
    try {
      const t = await chrome.tabs.get(stored.workTabId);
      if (t && isWorkUrl(t.url)) return t;
    } catch (_) { /* stale — clear and re-pick */ }
    await chrome.storage.local.remove('workTabId');
  }
  const ds = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  const qwen = await chrome.tabs.query({ url: 'https://chat.qwen.ai/*' });
  const tongyi = await chrome.tabs.query({ url: 'https://tongyi.aliyun.com/*' });
  const candidates = [...ds, ...qwen, ...tongyi];
  if (candidates.length === 0) {
    const mock = await chrome.tabs.query({ url: 'file:///*mock-deepseek.html' });
    return mock[0] || null;
  }
  const chosen = candidates.find((t) => !t.active) || candidates[0];
  await chrome.storage.local.set({ workTabId: chosen.id });
  return chosen;
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
  const dsTabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  const qwenTabs = await chrome.tabs.query({ url: 'https://chat.qwen.ai/*' });
  const tongyiTabs = await chrome.tabs.query({ url: 'https://tongyi.aliyun.com/*' });
  const tabs = [...dsTabs, ...qwenTabs, ...tongyiTabs];
  const tabList = tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: (t.title || '').slice(0, 80),
    active: !!t.active,
    provider: DSC.providerForUrl(t.url),
  }));
  const tab = await getWorkTab();
  const tabUrl = tab ? tab.url : null;
  const resp = await apiFetch(cfg, '/hello', {
    method: 'POST',
    body: JSON.stringify({ version: DSC.VERSION, tabUrl, tabs: tabList }),
  });
  state.connected = true;
  state.lastHelloAt = Date.now();
  state.serverUrl = cfg.baseUrl;
  state.tabs = tabList;
  broadcast();
  return resp;
}

async function handleNext(cfg, work) {
  const tab = await getWorkTab(work.targetTabId, work.provider);
  if (!tab) {
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'error',
        error: DSC.ERR.INPUT_NOT_FOUND,
        reason: 'no_work_tab',
      }),
    });
    return;
  }

  try {
    activeRequestId = work.requestId;
    // If the caller supplied a persisted chat URL (retry path), navigate
    // directly and skip the sidebar walk entirely. The URL contains the
    // UUID, which is stable for the chat's lifetime — no fuzzy matching
    // needed, no dependence on provider's title auto-generation.
    let ensured;
    if (work.targetUrl) {
      try {
        await chrome.tabs.update(tab.id, { url: work.targetUrl });
        await new Promise((resolve) => {
          const onUpd = (id, info) => {
            if (id === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpd);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpd);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpd);
            resolve();
          }, 15000);
        });
        await new Promise((r) => setTimeout(r, 800));
        const state = await sendToTab(tab.id, { action: DSC.MSG.CHECK_STATE, provider: work.provider });
        if (!state || !state.inputFound) {
          throw Object.assign(new Error('url-nav: input not found after navigate'), {
            code: DSC.ERR.INPUT_NOT_FOUND,
          });
        }
        ensured = { ok: true, existing: true, mode: 'existing', url: work.targetUrl };
      } catch (e) {
        // Fall through to ensureChat as a safety net — the URL might be
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
      const baseUrl = tab.url ? new URL(tab.url).origin : 'https://chat.deepseek.com';
        await chrome.tabs.update(tab.id, { url: baseUrl + '/' });
      await new Promise((res) => {
        const onUpd = (id, info) => {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpd);
            res();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpd);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); res(); }, 15000);
      });
      await new Promise((r) => setTimeout(r, 800));
      ensured = await sendToTab(tab.id, {
        action: DSC.MSG.ENSURE_CHAT,
        name: work.chatName,
      });
    }
    if (!ensured || !ensured.ok) {
      throw Object.assign(new Error('ensureChat failed'), {
        code: (ensured && ensured.error) || DSC.ERR.CHAT_NOT_FOUND,
        details: ensured,
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
        state.lastError = e.message;
        broadcast();
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
