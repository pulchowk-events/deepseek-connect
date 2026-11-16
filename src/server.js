// src/server.js — terminal-side HTTP server for deepseek-connect.
// Node 22, CommonJS, no external deps. Runs standalone (node src/server.js)
// or required by the aggregator's batch paste phase.
//
// Protocol: see docs/PROTOCOL.md. Auth: Bearer token on every request.
// Queue: FIFO, one in-flight per extension. /next is a long-poll (30s hold).

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 7331;
const LONG_POLL_MS = 30000;
const DEFAULT_DELIMITERS = { start: 'START_', end: 'END_' };

function createServer(opts) {
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? defaultLog;

  if (!token) throw new Error('createServer: token required');

  const queue = [];
  const waiting = [];
  const inFlight = new Map();
  let sessionId = null;
  let cachedTabs = [];

  function pump() {
    while (queue.length > 0 && waiting.length > 0 && inFlight.size === 0) {
      const entry = queue.shift();
      const waiter = waiting.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      entry.startedAt = Date.now();
      inFlight.set(entry.requestId, entry);
      writeJson(waiter.res, 200, {
        action: 'next',
        requestId: entry.requestId,
        mode: entry.mode || 'prompt',
        chatName: entry.chatName,
        targetTabId: entry.targetTabId,
        prompt: entry.prompt,
        delimiters: entry.delimiters,
      });
      const label = (entry.mode && entry.mode !== 'prompt')
        ? ('[' + entry.mode + '] ' + entry.chatName)
        : truncate(entry.prompt, 60);
      log('-> dispatched', entry.requestId, '|', label);
    }
  }

  function enqueue(req) {
    return new Promise((resolve, reject) => {
      const mode = req.openOnly ? 'open'
                 : req.resetOnly ? 'reset'
                 : 'prompt';
      if (mode === 'prompt' && (typeof req.prompt !== 'string' || !req.prompt)) {
        return reject(new Error('prompt required'));
      }
      const requestId = crypto.randomUUID();
      const entry = {
        requestId,
        mode,
        prompt: req.prompt,
        chatName: req.chatName || ('chat-' + requestId.slice(0, 8)),
        targetTabId: req.targetTabId,
        delimiters: req.delimiters || DEFAULT_DELIMITERS,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: null,
      };
      queue.push(entry);
      const label = mode === 'prompt' ? truncate(req.prompt, 60) : ('[' + mode + '] ' + entry.chatName);
      log('<- enqueued', requestId, '|', label);
      pump();
    });
  }

  function writeJson(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }

  function checkAuth(req) {
    const h = req.headers['authorization'] || '';
    return h.startsWith('Bearer ') && h.slice(7) === token;
  }

  function readJson(req, limitBytes) {
    limitBytes = limitBytes || 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limitBytes) { req.destroy(); reject(new Error('payload too large')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { reject(new Error('invalid json: ' + e.message)); }
      });
      req.on('error', reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!checkAuth(req)) {
        log('! auth fail', req.method, req.url);
        return writeJson(res, 401, { ok: false, error: 'auth_failed', reason: 'unauthorized' });
      }

      const method = req.method;
      const url = req.url;

      if (method === 'POST' && url === '/hello') {
        const body = await readJson(req);
        sessionId = crypto.randomUUID();
        if (Array.isArray(body.tabs)) cachedTabs = body.tabs;
        log('extension connected (' + (body.version || '?') + ') | ' + (body.tabUrl || '?') +
            ' | ' + cachedTabs.length + ' tab(s)');
        return writeJson(res, 200, { ok: true, sessionId });
      }

      if (method === 'GET' && url === '/tabs') {
        return writeJson(res, 200, { ok: true, tabs: cachedTabs });
      }

      if (method === 'GET' && url === '/next') {
        const waiter = { res, timer: null };
        waiter.timer = setTimeout(() => {
          const i = waiting.indexOf(waiter);
          if (i >= 0) waiting.splice(i, 1);
          writeJson(res, 200, { action: 'idle' });
        }, LONG_POLL_MS);
        waiting.push(waiter);
        pump();
        req.on('close', () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          const i = waiting.indexOf(waiter);
          if (i >= 0) waiting.splice(i, 1);
        });
        return;
      }

      if (method === 'POST' && url === '/progress') {
        const body = await readJson(req);
        const id8 = String(body.requestId || '').slice(0, 8);
        const extra = body.extra ? ' ' + JSON.stringify(body.extra) : '';
        log('  ~ ' + id8 + ' ' + (body.phase || '?') + extra);
        return writeJson(res, 200, { ok: true });
      }

      if (method === 'POST' && url === '/reply') {
        const body = await readJson(req);
        const entry = inFlight.get(body.requestId);
        if (!entry) {
          return writeJson(res, 404, { ok: false, error: 'unknown_request' });
        }
        inFlight.delete(body.requestId);
        const elapsedMs = Date.now() - entry.startedAt;
        if (body.status === 'ok') {
          log('ok done', body.requestId, '| ' + elapsedMs + 'ms');
          logTrace('ok', body.requestId, body.trace, 4);
          entry.resolve({
            content: body.content,
            raw: body.raw,
            elapsedMs,
            trace: body.trace,
            existing: body.existing,
            mode: body.mode,
            debug: body.debug,
            chat: body.chat,
          });
        } else {
          if (body.error === 'dom_drift') {
            const names = Array.isArray(body.details) ? body.details.join(', ') : '?';
            log('! DOM DRIFT', body.requestId, '| missing required:', names);
          } else {
            log('x failed', body.requestId, '|', body.reason || body.error || 'unknown');
          }
          logTrace('err', body.requestId, body.trace, 8);
          const err = new Error(body.reason || body.error || 'extension_error');
          err.code = body.error;
          err.reason = body.reason;
          err.retryAfter = body.retryAfter;
          err.details = body.details;
          err.probe = body.probe;
          err.trace = body.trace;
          entry.reject(err);
        }
        pump();
        return writeJson(res, 200, { ok: true });
      }

      if (method === 'POST' && url === '/open') {
        const body = await readJson(req);
        const chatName = body.chatName;
        if (!chatName) return writeJson(res, 400, { ok: false, error: 'chatName required' });
        try {
          const result = await enqueue({ prompt: null, chatName, openOnly: true });
          return writeJson(res, 200, {
            ok: true,
            existing: !!(result && result.existing),
            mode: result && result.mode,
            debug: result && result.debug,
            chat: chatName,
          });
        } catch (e) {
          return writeJson(res, 500, { ok: false, error: e.message || 'open_failed' });
        }
      }

      if (method === 'POST' && url === '/reset') {
        const body = await readJson(req);
        const chatName = body.chatName;
        if (!chatName) return writeJson(res, 400, { ok: false, error: 'chatName required' });
        try {
          const result = await enqueue({ prompt: null, chatName, resetOnly: true });
          return writeJson(res, 200, { ok: true, chat: chatName, result });
        } catch (e) {
          return writeJson(res, 500, { ok: false, error: e.message || 'reset_failed' });
        }
      }

      if (method === 'POST' && url === '/chat') {
        const body = await readJson(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) {
          return writeJson(res, 400, { ok: false, error: 'messages_required' });
        }
        const prompt = messages.map((m) => m.content || '').join('\n\n');
        const chatName = body.chat || ('api-' + crypto.randomUUID().slice(0, 8));
        const targetTabId = body.targetTabId;
        const startedAt = Date.now();
        try {
          const result = await enqueue({ prompt, chatName, targetTabId });
          return writeJson(res, 200, {
            content: result.content,
            chat: chatName,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (e) {
          return writeJson(res, 500, {
            ok: false,
            error: e.code || e.message,
            reason: e.reason,
            details: e.details,
            trace: e.trace,
          });
        }
      }

      return writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      log('! handler error', e.message);
      if (!res.headersSent) writeJson(res, 500, { ok: false, error: e.message });
    }
  });

  let boundPort = null;
  function start() {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        boundPort = httpServer.address().port;
        log('listening on ' + host + ':' + boundPort);
        resolve(boundPort);
      });
    });
  }
  // Backward-compatible alias — old callers use listen().
  const listen = start;

  function stop() {
    return new Promise((resolve) => {
      const err = new Error('server_closed');
      err.code = 'cancelled';
      for (const e of queue) e.reject(err);
      for (const e of inFlight.values()) e.reject(err);
      queue.length = 0;
      inFlight.clear();
      for (const w of waiting) { if (w.timer) clearTimeout(w.timer); }
      waiting.length = 0;
      httpServer.close(() => resolve());
    });
  }
  // Backward-compatible alias — old callers use close().
  const close = stop;

  function status() {
    return {
      connected: !!(sessionId && httpServer.listening),
      sessionId,
      listening: httpServer.listening,
      port: boundPort || port,
      queued: queue.length,
      inFlight: inFlight.size,
      waitingPollers: waiting.length,
      tabs: cachedTabs.length,
    };
  }

  return {
    httpServer,
    enqueue,
    start,
    stop,
    listen,   // alias for start
    close,    // alias for stop
    status,
    port: () => boundPort || port,
    get sessionId() { return sessionId; },
  };
}

function defaultLog() {
  const ts = new Date().toISOString().slice(11, 19);
  console.log.apply(console, ['[' + ts + ']'].concat(Array.from(arguments)));
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function logTrace(tag, id, trace, tail) {
  if (!Array.isArray(trace) || trace.length === 0) return;
  const shown = trace.slice(-(tail || 6));
  for (const e of shown) {
    const { t, phase, ...rest } = e;
    console.log('  trace[' + tag + ']', id.slice(0, 8),
      String(t).padStart(5) + 'ms',
      phase,
      Object.keys(rest).length ? JSON.stringify(rest) : '');
  }
}

async function main() {
  const port = Number(process.env.EXTENSION_PORT || DEFAULT_PORT);
  const token = process.env.EXTENSION_TOKEN;
  if (!token) {
    console.error('EXTENSION_TOKEN not set. Create .env or export it.');
    process.exit(1);
  }
  const server = createServer({ port, token });
  await server.start();
  const shutdown = async () => {
    console.log('');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createServer, DEFAULT_PORT, LONG_POLL_MS };
