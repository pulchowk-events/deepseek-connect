// src/client.js — HTTP client for the deepseek-connect server.
// CommonJS, zero deps. Wizard usage:
//
//   const { createClient } = require('deepseek-connect/client');
//   const dc = createClient({ token, port });
//   const { content } = await dc.chat({ messages, chat: 'src-alpha' });
//
// Every method either resolves with the server's success payload or throws
// a DSCError (see src/errors.js) carrying `code`, `retryable`, `retryAfter`,
// `userFixable`. Client does NOT auto-retry — the wizard decides whether
// to sleep(retryAfter) and retry, beep, or skip. Silent retries hide
// rate-limit conditions.

'use strict';

const http = require('node:http');
const { CODES, DSCError } = require('./errors.js');

const DEFAULT_PORT = 7331;
// Content-side response timeout is 90s. Add nav (up to 15s) + deepthink
// warmup (up to 10s) + safety. Anything longer means the request is wedged,
// not slow.
const DEFAULT_CHAT_TIMEOUT_MS = 180000;
const DEFAULT_OPEN_TIMEOUT_MS = 30000;
const DEFAULT_SHORT_TIMEOUT_MS = 10000;

const KNOWN_CODES = new Set(Object.values(CODES));

function createClient(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  const port = opts.port || DEFAULT_PORT;
  const token = opts.token;
  if (!token) throw new Error('createClient: token required');

  function request(method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const headers = { Authorization: 'Bearer ' + token };
      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      const req = http.request({ host, port, path, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* leave null */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(json || {});
          }
          if (json && typeof json === 'object') {
            const code = json.error;
            if (KNOWN_CODES.has(code)) {
              return reject(new DSCError(code, {
                reason: json.reason,
                retryAfter: json.retryAfter,
                details: json.details,
                trace: json.trace,
                http: res.statusCode,
              }));
            }
            return reject(new DSCError(CODES.INTERNAL_ERROR, {
              reason: json.error || json.reason || ('http_' + res.statusCode),
              http: res.statusCode,
              details: json,
            }));
          }
          return reject(new DSCError(CODES.INTERNAL_ERROR, {
            reason: 'http_' + res.statusCode + ' non-json body',
            http: res.statusCode,
          }));
        });
      });
      req.on('error', (e) => {
        if (e.code === 'ECONNREFUSED') {
          return reject(new DSCError(CODES.INTERNAL_ERROR, {
            reason: 'server not listening on ' + host + ':' + port,
            details: { code: 'ECONNREFUSED' },
          }));
        }
        reject(new DSCError(CODES.INTERNAL_ERROR, {
          reason: e.message,
          details: { code: e.code },
        }));
      });
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new DSCError(CODES.EXTENSION_TIMEOUT, {
            reason: 'client timeout after ' + timeoutMs + 'ms',
          }));
        });
      }
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function chat(params) {
    if (!params || !Array.isArray(params.messages)) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'messages[] required' });
    }
    const body = { messages: params.messages };
    if (params.chat) body.chat = params.chat;
    if (params.targetTabId) body.targetTabId = params.targetTabId;
    if (params.provider) body.provider = params.provider;
    const timeoutMs = params.timeoutMs || DEFAULT_CHAT_TIMEOUT_MS;
    return await request('POST', '/chat', body, timeoutMs);
  }

  async function open(params) {
    if (!params || !params.chatName) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'chatName required' });
    }
    const timeoutMs = params.timeoutMs || DEFAULT_OPEN_TIMEOUT_MS;
    const body = { chatName: params.chatName };
    if (params.url) body.url = params.url;
    if (params.provider) body.provider = params.provider;
    return await request('POST', '/open', body, timeoutMs);
  }

  async function reset(params) {
    if (!params || !params.chatName) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'chatName required' });
    }
    if (!params.provider) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'provider required' });
    }
    const timeoutMs = params.timeoutMs || DEFAULT_OPEN_TIMEOUT_MS;
    return await request('POST', '/reset', { chatName: params.chatName, provider: params.provider }, timeoutMs);
  }

  async function tabs() {
    return await request('GET', '/tabs', null, DEFAULT_SHORT_TIMEOUT_MS);
  }

  // Escape hatch: future routes (/status /health /cancel) and wizard-only
  // calls before they get dedicated wrappers.
  async function raw(method, path, body, timeoutMs) {
    return await request(method, path, body, timeoutMs || DEFAULT_SHORT_TIMEOUT_MS);
  }

  return { chat, open, reset, tabs, raw };
}

module.exports = {
  createClient,
  DEFAULT_PORT,
  DEFAULT_CHAT_TIMEOUT_MS,
  DEFAULT_OPEN_TIMEOUT_MS,
};
