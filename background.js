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

async function getWorkTab() {
  const ds = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (ds[0]) return ds[0];
  const mock = await chrome.tabs.query({ url: 'file:///*mock-deepseek.html' });
  return mock[0] || null;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const le = chrome.runtime.lastError;
      if (le) return reject(new Error(le.message));
      resolve(resp);
    });
  });
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

async function register(cfg) {
  const tab = await getWorkTab();
  const tabUrl = tab ? tab.url : null;
  const resp = await apiFetch(cfg, '/hello', {
    method: 'POST',
    body: JSON.stringify({ version: DSC.VERSION, tabUrl }),
  });
  state.connected = true;
  state.lastHelloAt = Date.now();
  state.serverUrl = cfg.baseUrl;
  broadcast();
  return resp;
}

async function handleNext(cfg, work) {
  const tab = await getWorkTab();
  if (!tab) {
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'error',
        error: DSC.ERR.INPUT_NOT_FOUND,
        reason: 'no_deepseek_tab',
      }),
    });
    return;
  }

  try {
    const ensured = await sendToTab(tab.id, {
      action: DSC.MSG.ENSURE_CHAT,
      name: work.chatName,
    });
    if (!ensured || !ensured.ok) {
      throw Object.assign(new Error('ensureChat failed'), {
        code: (ensured && ensured.error) || DSC.ERR.CHAT_NOT_FOUND,
      });
    }
    state.currentChat = work.chatName;
    broadcast();

    const result = await sendToTab(tab.id, {
      action: DSC.MSG.SEND_PROMPT,
      prompt: work.prompt,
      delimiters: work.delimiters,
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
        }),
      });
      return;
    }

    state.promptsDone += 1;
    broadcast();
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'ok',
        content: result.content,
        raw: result.raw,
      }),
    });
  } catch (e) {
    state.lastError = e.message;
    broadcast();
    await apiFetch(cfg, '/reply', {
      method: 'POST',
      body: JSON.stringify({
        requestId: work.requestId,
        status: 'error',
        error: e.code || 'background_error',
        reason: e.message,
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
