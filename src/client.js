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
const crypto = require('node:crypto');
const { CODES, DSCError } = require('./errors.js');

const DEFAULT_PORT = 7331;
// Includes the maximum configured provider response window plus navigation
// and extension overhead. A local timeout never cancels dispatched work.
const DEFAULT_CHAT_TIMEOUT_MS = 960000;
const DEFAULT_OPEN_TIMEOUT_MS = 30000;
const DEFAULT_SHORT_TIMEOUT_MS = 10000;

const KNOWN_CODES = new Set(Object.values(CODES));

function createClient(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  const port = opts.port || DEFAULT_PORT;
  const token = opts.token;
  if (!token) throw new Error('createClient: token required');
  if (typeof host !== 'string' || !host.trim()) throw new Error('createClient: host must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('createClient: port must be 1-65535');

  function request(method, path, body, timeoutMs, meta) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const headers = { Authorization: 'Bearer ' + token };
      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }
      let requestStarted = false;
      const req = http.request({ host, port, path, method, headers }, (res) => {
        const chunks = [];
        let responseBytes = 0;
        let responseTooLarge = false;
        res.on('data', (c) => {
          responseBytes += c.length;
          if (responseBytes > 2 * 1024 * 1024) {
            responseTooLarge = true;
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (responseTooLarge) {
            return reject(new DSCError(CODES.INTERNAL_ERROR, {
              reason: 'response_too_large',
              http: res.statusCode,
              requestId: meta && meta.requestId,
              executionState: 'outcome_unknown',
              retryable: false,
            }));
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* leave null */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!json || typeof json !== 'object' || Array.isArray(json)) {
              return reject(new DSCError(CODES.INTERNAL_ERROR, {
                reason: 'invalid_success_response',
                http: res.statusCode,
                requestId: meta && meta.requestId,
              }));
            }
            return resolve(json);
          }
          if (json && typeof json === 'object') {
            const code = json.error;
            if (KNOWN_CODES.has(code)) {
              return reject(new DSCError(code, {
                reason: json.reason,
                retryable: json.retryable,
                retryAfter: json.retryAfter,
                userFixable: json.userFixable,
                details: json.details,
                trace: json.trace,
                requestId: json.requestId || (meta && meta.requestId),
                executionState: json.executionState,
                http: res.statusCode,
              }));
            }
            return reject(new DSCError(CODES.INTERNAL_ERROR, {
              reason: json.error || json.reason || ('http_' + res.statusCode),
              http: res.statusCode,
              details: { error: json.error, reason: json.reason },
              requestId: json.requestId || (meta && meta.requestId),
              executionState: json.executionState,
              retryable: false,
            }));
          }
          return reject(new DSCError(CODES.INTERNAL_ERROR, {
            reason: 'http_' + res.statusCode + ' non-json body',
            http: res.statusCode,
            requestId: meta && meta.requestId,
            executionState: meta && meta.executionState,
            retryable: false,
          }));
        });
      });
      req.on('error', (e) => {
        if (e.code === 'ECONNREFUSED') {
          return reject(new DSCError(CODES.INTERNAL_ERROR, {
            reason: 'server not listening on ' + host + ':' + port,
            details: { code: 'ECONNREFUSED' },
            requestId: meta && meta.requestId,
            executionState: 'not_dispatched',
            retryable: true,
          }));
        }
        reject(new DSCError(CODES.INTERNAL_ERROR, {
          reason: e.message,
          details: { code: e.code },
          requestId: meta && meta.requestId,
          executionState: meta && meta.executionState,
          retryable: false,
        }));
      });
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new DSCError(CODES.EXTENSION_TIMEOUT, {
            reason: 'client wait timed out after ' + timeoutMs + 'ms; server work may continue',
            requestId: meta && meta.requestId,
            executionState: meta && meta.executionState,
            retryable: false,
            details: { timeoutMs, recovery: 'Inspect the provider tab before retrying; reuse requestId to avoid duplicate dispatch.' },
          }));
        });
      }
      const signal = meta && meta.signal;
      const onAbort = () => {
        req.destroy();
        reject(new DSCError(CODES.EXTENSION_TIMEOUT, {
          reason: 'client stopped waiting; this does not cancel dispatched provider work',
          requestId: meta && meta.requestId,
          executionState: requestStarted ? (meta && meta.executionState) : 'not_dispatched',
          retryable: false,
          details: { recovery: 'Inspect the provider tab before retrying; reuse requestId to avoid duplicate dispatch.' },
        }));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      requestStarted = true;
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function chat(params) {
    if (!params || !Array.isArray(params.messages) || params.messages.length === 0) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'messages[] required' });
    }
    if (!params.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m) &&
        ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'messages contain an invalid role or content' });
    }
    const requestId = params.requestId || crypto.randomUUID();
    const body = { messages: params.messages, requestId };
    if (params.chat) body.chat = params.chat;
    if (params.targetTabId !== undefined) body.targetTabId = params.targetTabId;
    if (params.url) body.url = params.url;
    if (params.provider) body.provider = params.provider;
    const timeoutMs = params.timeoutMs === undefined ? DEFAULT_CHAT_TIMEOUT_MS : params.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'timeoutMs must be a positive number' });
    }
    const result = await request('POST', '/chat', body, timeoutMs, {
      requestId,
      executionState: 'outcome_unknown',
      signal: params.signal,
    });
    if (typeof result.content !== 'string' || result.content.trim() === '') {
      throw new DSCError(CODES.INTERNAL_ERROR, {
        reason: 'invalid_chat_success_response',
        requestId,
        executionState: 'completed',
        retryable: false,
      });
    }
    return result;
  }

  async function open(params) {
    if (!params || !params.chatName) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'chatName required' });
    }
    const timeoutMs = params.timeoutMs === undefined ? DEFAULT_OPEN_TIMEOUT_MS : params.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'timeoutMs must be a positive number' });
    }
    const requestId = params.requestId || crypto.randomUUID();
    const body = { chatName: params.chatName, requestId };
    if (params.url) body.url = params.url;
    if (params.provider) body.provider = params.provider;
    return await request('POST', '/open', body, timeoutMs, {
      requestId,
      executionState: 'outcome_unknown',
      signal: params.signal,
    });
  }

  async function reset(params) {
    if (!params || !params.chatName) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'chatName required' });
    }
    if (!params.provider) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'provider required' });
    }
    const timeoutMs = params.timeoutMs === undefined ? DEFAULT_OPEN_TIMEOUT_MS : params.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DSCError(CODES.BAD_REQUEST, { reason: 'timeoutMs must be a positive number' });
    }
    const requestId = params.requestId || crypto.randomUUID();
    return await request('POST', '/reset', {
      chatName: params.chatName, provider: params.provider, requestId,
    }, timeoutMs, {
      requestId,
      executionState: 'outcome_unknown',
      signal: params.signal,
    });
  }

  async function tabs() {
    return await request('GET', '/tabs', null, DEFAULT_SHORT_TIMEOUT_MS);
  }

  async function status() {
    return await request('GET', '/status', null, DEFAULT_SHORT_TIMEOUT_MS);
  }

  // Escape hatch: future routes (/status /health /cancel) and wizard-only
  // calls before they get dedicated wrappers.
  async function raw(method, path, body, timeoutMs) {
    return await request(method, path, body, timeoutMs || DEFAULT_SHORT_TIMEOUT_MS);
  }

  async function providers() {
    return await request('GET', '/providers', null, DEFAULT_SHORT_TIMEOUT_MS);
  }
  async function addProvider(name, definition) {
    return await request('POST', '/providers', { name, definition }, DEFAULT_SHORT_TIMEOUT_MS);
  }
  async function updateProvider(name, definition) {
    return await request('PUT', '/providers/' + name, { definition }, DEFAULT_SHORT_TIMEOUT_MS);
  }
  async function deleteProvider(name) {
    return await request('DELETE', '/providers/' + name, null, DEFAULT_SHORT_TIMEOUT_MS);
  }

  return { chat, open, reset, tabs, status, providers, addProvider, updateProvider, deleteProvider, raw };
}

module.exports = {
  createClient,
  DEFAULT_PORT,
  DEFAULT_CHAT_TIMEOUT_MS,
  DEFAULT_OPEN_TIMEOUT_MS,
};
