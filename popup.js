// popup.js — config + status UI. Reads chrome.storage.local, writes token/port,
// shows connection state pushed by background.js.

'use strict';

const DSC = globalThis.DSC;

const $ = (id) => document.getElementById(id);
const dot = $('dot');
const statusEl = $('status');
const currentEl = $('current');
const tokenEl = $('token');
const portEl = $('port');
const msgEl = $('msg');

function setDot(color) {
  dot.className = 'dot' + (color ? ' ' + color : '');
}

function render(state) {
  if (!state) return;
  if (!state.connected) {
    setDot(state.lastError ? 'red' : 'yellow');
    statusEl.textContent = state.lastError ? 'error' : 'waiting';
  } else {
    setDot('green');
    statusEl.textContent = 'connected';
  }
  const chat = state.currentChat ? 'chat: ' + state.currentChat : '';
  const done = state.promptsDone ? 'prompts: ' + state.promptsDone : '';
  currentEl.textContent = [chat, done].filter(Boolean).join(' · ');
  msgEl.textContent = state.lastError || '';
}

async function loadConfig() {
  const s = await chrome.storage.local.get([DSC.STORAGE.TOKEN, DSC.STORAGE.PORT]);
  tokenEl.value = s[DSC.STORAGE.TOKEN] || '';
  portEl.value = s[DSC.STORAGE.PORT] || DSC.DEFAULT_PORT;
}

async function saveConfig() {
  const token = tokenEl.value.trim();
  const port = Number(portEl.value.trim() || DSC.DEFAULT_PORT);
  if (!token) { msgEl.textContent = 'token required'; return; }
  if (!Number.isFinite(port) || port < 1 || port > 65535) { msgEl.textContent = 'invalid port'; return; }
  await chrome.storage.local.set({
    [DSC.STORAGE.TOKEN]: token,
    [DSC.STORAGE.PORT]: port,
  });
  msgEl.textContent = 'saved';
}

async function refreshState() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getState' });
    render(resp && resp.state);
  } catch (_) {}
}

$('save').addEventListener('click', saveConfig);

$('skip').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (!tabs[0]) { msgEl.textContent = 'no deepseek tab'; return; }
  try {
    await chrome.tabs.sendMessage(tabs[0].id, { action: 'skip' });
    msgEl.textContent = 'skip sent';
  } catch (e) {
    msgEl.textContent = 'skip failed: ' + e.message;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'state') render(msg.state);
});

loadConfig();
refreshState();
setInterval(refreshState, 1000);
