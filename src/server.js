// src/server.js -- terminal-side HTTP server for deepseek-connect.
// Node 22, CommonJS, no external deps. Runs standalone (node src/server.js)
// or required by the aggregator's batch paste phase.
//
// Protocol: see docs/PROTOCOL.md. Auth: Bearer token on every request.
// Queue: FIFO, one in-flight per extension. /next is a long-poll (30s hold).
//
// Provider routing: every work request (/chat, /open, /reset, enqueue) MUST
// name its provider. There is no default; a missing or unknown provider is
// refused with bad_request.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { httpStatusFor } = require('./errors.js');

const DEFAULT_PORT = 7331;
const LONG_POLL_MS = 30000;
const DEFAULT_DELIMITERS = { start: 'START_', end: 'END_' };

// Providers with a registered extension module. Mirrors shared.js
// ROUTABLE_PROVIDERS. tongyi has a domain but no module, so it is excluded.
const KNOWN_PROVIDERS = Object.freeze(['deepseek', 'qwen']);

function makeErr(code, reason, details) {
  const e = new Error(reason);
  e.code = code;
  e.reason = reason;
  e.details = details;
  return e;
}

// Returns an Error to refuse with, or null when the provider is acceptable.
function checkProvider(provider, known) {
  return checkProviderIn(provider, known || KNOWN_PROVIDERS);
}
function checkProviderIn(provider, KNOWN_PROVIDERS) {
  if (typeof provider !== 'string' || provider === '') {
    return makeErr('bad_request', 'provider required; known: ' + KNOWN_PROVIDERS.join(', '),
      { field: 'provider', known: KNOWN_PROVIDERS.slice() });
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return makeErr('bad_request', 'unknown provider "' + provider + '"; known: ' + KNOWN_PROVIDERS.join(', '),
      { field: 'provider', value: provider, known: KNOWN_PROVIDERS.slice() });
  }
  return null;
}

// Build stamp, read from the extension's shared.js so server and extension
// compare against the same source of truth. null when unreadable (check off).
function readBuildHash() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8');
    const m = src.match(/BUILD_HASH:\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function errorBody(e, fallbackCode) {
  return {
    ok: false,
    error: e.code || fallbackCode || e.message,
    reason: e.reason || e.message,
    details: e.details,
    trace: e.trace,
  };
}

function createServer(opts) {
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? defaultLog;
  const buildHash = readBuildHash();

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
        targetUrl: entry.targetUrl,
        provider: entry.provider,
        prompt: entry.prompt,
        delimiters: entry.delimiters,
      });
      const label = (entry.mode && entry.mode !== 'prompt')
        ? ('[' + entry.mode + '] ' + entry.chatName)
        : truncate(entry.prompt, 60);
      log('-> dispatched', entry.requestId, '|', entry.provider, '|', label);
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
      const providerErr = checkProvider(req.provider, knownProviders());
      if (providerErr) return reject(providerErr);
      const requestId = crypto.randomUUID();
      const entry = {
        requestId,
        mode,
        prompt: req.prompt,
        chatName: req.chatName || ('chat-' + requestId.slice(0, 8)),
        targetTabId: req.targetTabId,
        targetUrl: req.targetUrl,
        provider: req.provider,
        delimiters: req.delimiters || DEFAULT_DELIMITERS,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: null,
      };
      queue.push(entry);
      const label = mode === 'prompt' ? truncate(req.prompt, 60) : ('[' + mode + '] ' + entry.chatName);
      log('<- enqueued', requestId, '|', entry.provider, '|', label);
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

  // ---- config providers (providers/<name>.js) --------------------------------
  const providersDir = path.resolve(opts.providersDir || path.join(__dirname, '..', 'providers'));
  const NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
  const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
  let provCache = null;
  let provCacheAt = 0;

  function invalidateProviders() { provCache = null; }
  function getDSC() { require('../shared.js'); return globalThis.DSC; }
  function providerFiles() {
    try { return fs.readdirSync(providersDir).filter((f) => f.endsWith('.js')).sort(); } catch (_) { return []; }
  }
  function knownProviders() {
    const now = Date.now();
    if (provCache && now - provCacheAt < 2000) return provCache;
    const names = providerFiles().map((f) => f.slice(0, -3)).filter((n) => NAME_RE.test(n));
    provCache = Array.from(new Set(KNOWN_PROVIDERS.concat(names)));
    provCacheAt = now;
    return provCache;
  }
  function sliceDefinition(src) {
    const a = src.indexOf('/*DEF*/');
    const b = src.lastIndexOf('/*END*/');
    if (a < 0 || b < a) return null;
    try { return JSON.parse(src.slice(a + 7, b)); } catch (_) { return null; }
  }
  function describeProviders() {
    const out = KNOWN_PROVIDERS.map((n) => ({ name: n, file: 'providers/' + n + '.js', kind: 'built-in', definition: null }));
    for (const f of providerFiles()) {
      const stem = f.slice(0, -3);
      if (!NAME_RE.test(stem) || KNOWN_PROVIDERS.includes(stem)) continue;
      let definition = null;
      try { definition = sliceDefinition(fs.readFileSync(path.join(providersDir, f), 'utf8')); } catch (_) { definition = null; }
      out.push({ name: stem, file: 'providers/' + f, kind: 'config', definition });
    }
    return out;
  }
  // -> { error } | { src, value }. Never writes caller-supplied code: the file is
  // rendered from a fixed template around the validated definition.
  function renderProvider(name, def, excludeName) {
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || name.includes('/')) {
      return { error: 'invalid provider name (must match ^[a-z][a-z0-9_-]{0,30}$)' };
    }
    if (KNOWN_PROVIDERS.includes(name) || name === 'tongyi') return { error: '"' + name + '" is a built-in provider' };
    if (RESERVED_RE.test(name)) return { error: '"' + name + '" is a reserved name' };
    const v = getDSC().validateDefinition(def);
    if (!v.ok) return { error: 'invalid definition: ' + v.errors.join('; ') };
    if (v.value.name !== name) return { error: 'definition.name must equal name' };
    for (const p of describeProviders()) {
      if (p.kind !== 'config' || p.name === excludeName || !p.definition || !Array.isArray(p.definition.domains)) continue;
      const clash = v.value.domains.find((d) => p.definition.domains.includes(d));
      if (clash) return { error: 'domain "' + clash + '" is already used by provider "' + p.name + '"' };
    }
    const json = JSON.stringify(v.value, null, 2).replace(/\*\//g, '*\\u002f').replace(/\/\*/g, '\\u002f*');
    const src = '// providers/' + name + '.js -- generated by the deepseek-connect Providers page (schema 1).\n' +
      '// Edit via the Providers page, or by hand; keep the DEF/END markers.\n' +
      "'use strict';\n" +
      'globalThis.DSC.makeConfigProvider(/*DEF*/' + json + '/*END*/);\n';
    try {
      new vm.Script(src, { filename: name + '.js' }); // compile only, never executed here
      if (JSON.stringify(sliceDefinition(src)) !== JSON.stringify(v.value)) return { error: 'rendered file failed round-trip check' };
    } catch (e) {
      return { error: 'rendered file failed to compile: ' + e.message };
    }
    return { src, value: v.value };
  }

  async function handleProviders(req, res, method, url) {
    const m = url.match(/^\/providers(?:\/([^/?#]+))?$/);
    if (!m) return writeJson(res, 404, { ok: false, error: 'not_found' });
    const seg = m[1] || null;
    const refuse = (status, reason) => writeJson(res, status, { ok: false, error: 'bad_request', reason });

    if (seg === null) {
      if (method === 'GET') return writeJson(res, 200, { ok: true, providers: describeProviders() });
      if (method === 'POST') {
        const body = await readJson(req);
        const r = renderProvider(body.name, body.definition, body.name);
        if (r.error) return refuse(400, r.error);
        const file = path.join(providersDir, body.name + '.js');
        try {
          fs.mkdirSync(providersDir, { recursive: true });
          fs.writeFileSync(file, r.src, { flag: 'wx' });
        } catch (e) {
          if (e.code === 'EEXIST') return refuse(409, 'provider "' + body.name + '" already exists');
          return refuse(500, 'write failed: ' + e.message);
        }
        invalidateProviders();
        log('+ provider written', body.name);
        return writeJson(res, 200, { ok: true, written: 'providers/' + body.name + '.js' });
      }
      return refuse(405, 'method not allowed');
    }

    if (!NAME_RE.test(seg)) return refuse(400, 'invalid provider name');
    if (KNOWN_PROVIDERS.includes(seg) || seg === 'tongyi') return refuse(400, 'built-in providers cannot be modified');
    const file = path.join(providersDir, seg + '.js');
    if (path.dirname(path.resolve(file)) !== providersDir) return refuse(400, 'invalid path');
    let existing;
    try { existing = fs.readFileSync(file, 'utf8'); } catch (_) {
      return writeJson(res, 404, { ok: false, error: 'not_found', reason: 'no such provider' });
    }
    if (sliceDefinition(existing) === null) return refuse(400, 'not a generated provider file (no DEF markers); edit it by hand');

    if (method === 'PUT') {
      const body = await readJson(req);
      const r = renderProvider(seg, body.definition, seg);
      if (r.error) return refuse(400, r.error);
      const tmp = path.join(providersDir, '.' + seg + '.tmp');
      fs.writeFileSync(tmp, r.src);
      fs.renameSync(tmp, file);
      invalidateProviders();
      log('~ provider updated', seg);
      return writeJson(res, 200, { ok: true, written: 'providers/' + seg + '.js' });
    }
    if (method === 'DELETE') {
      fs.unlinkSync(file);
      invalidateProviders();
      log('- provider deleted', seg);
      return writeJson(res, 200, { ok: true, deleted: 'providers/' + seg + '.js' });
    }
    return refuse(405, 'method not allowed');
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!checkAuth(req)) {
        log('! auth fail', req.method, req.url);
        return writeJson(res, 401, { ok: false, error: 'auth_failed', reason: 'unauthorized' });
      }

      const method = req.method;
      const url = req.url;

      if (method === 'GET' && url === '/version') {
        return writeJson(res, 200, {
          ok: true,
          version: require('../package.json').version,
          buildHash,
        });
      }

      if (method === 'POST' && url === '/hello') {
        const body = await readJson(req);
        if (buildHash && body.buildHash !== buildHash) {
          log('! version_mismatch | server', buildHash, '| extension', body.buildHash || '(none)');
          return writeJson(res, httpStatusFor('version_mismatch'), {
            ok: false,
            error: 'version_mismatch',
            reason: 'extension build ' + (body.buildHash || '(none)') + ' != server build ' + buildHash +
                    '; reload the extension and hard-reload provider tabs',
            details: { server: buildHash, extension: body.buildHash || null },
          });
        }
        sessionId = crypto.randomUUID();
        if (Array.isArray(body.tabs)) cachedTabs = body.tabs;
        log('extension connected (' + (body.version || '?') + ') | ' + (body.tabUrl || '?') +
            ' | ' + cachedTabs.length + ' tab(s)');
        return writeJson(res, 200, { ok: true, sessionId, buildHash });
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
            url: body.url,
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
        const targetUrl = body.url;
        if (!chatName) return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'chatName required' });
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return writeJson(res, 400, errorBody(providerErr));
        try {
          const result = await enqueue({ prompt: null, chatName, openOnly: true, targetUrl, provider: body.provider });
          return writeJson(res, 200, {
            ok: true,
            existing: !!(result && result.existing),
            mode: result && result.mode,
            debug: result && result.debug,
            url: (result && result.url) || targetUrl || null,
            chat: chatName,
          });
        } catch (e) {
          return writeJson(res, httpStatusFor(e.code, 500), errorBody(e, 'open_failed'));
        }
      }

      if (method === 'POST' && url === '/reset') {
        const body = await readJson(req);
        const chatName = body.chatName;
        if (!chatName) return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'chatName required' });
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return writeJson(res, 400, errorBody(providerErr));
        try {
          const result = await enqueue({ prompt: null, chatName, resetOnly: true, provider: body.provider });
          return writeJson(res, 200, { ok: true, chat: chatName, result });
        } catch (e) {
          return writeJson(res, httpStatusFor(e.code, 500), errorBody(e, 'reset_failed'));
        }
      }

      if (method === 'POST' && url === '/chat') {
        const body = await readJson(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) {
          return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'messages required' });
        }
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return writeJson(res, 400, errorBody(providerErr));
        const prompt = messages.map((m) => m.content || '').join('\n\n');
        const chatName = body.chat || ('api-' + crypto.randomUUID().slice(0, 8));
        const targetTabId = body.targetTabId;
        const startedAt = Date.now();
        try {
          const result = await enqueue({ prompt, chatName, targetTabId, provider: body.provider });
          return writeJson(res, 200, {
            content: result.content,
            chat: chatName,
            url: result.url,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (e) {
          return writeJson(res, httpStatusFor(e.code, 500), errorBody(e));
        }
      }

      if (url === '/providers' || url.startsWith('/providers/')) {
        return await handleProviders(req, res, method, url);
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
  // Backward-compatible alias -- old callers use listen().
  const listen = start;

  // Answer every held /next with a synthetic idle so the extension's fetch
  // resolves instead of hanging on a socket the server is about to drop.
  function answerAllWaiters() {
    const n = waiting.length;
    for (const w of waiting) {
      if (w.timer) clearTimeout(w.timer);
      writeJson(w.res, 200, { action: 'idle' });
    }
    waiting.length = 0;
    return n;
  }

  function stop() {
    return new Promise((resolve) => {
      const err = new Error('server_closed');
      err.code = 'cancelled';
      for (const e of queue) e.reject(err);
      for (const e of inFlight.values()) e.reject(err);
      queue.length = 0;
      inFlight.clear();
      const answered = answerAllWaiters();
      if (answered > 0) log('stop: answered ' + answered + ' waiting /next poller(s)');
      let killer = null;
      httpServer.close(() => {
        if (killer) clearTimeout(killer);
        resolve();
      });
      httpServer.closeIdleConnections();
      killer = setTimeout(() => httpServer.closeAllConnections(), 250);
      killer.unref();
    });
  }
  // Backward-compatible alias -- old callers use close().
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
      buildHash,
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
    buildHash,
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
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    // Failsafe: if stop() somehow hangs, still exit.
    setTimeout(() => process.exit(0), 3000).unref();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createServer, DEFAULT_PORT, LONG_POLL_MS, KNOWN_PROVIDERS };
