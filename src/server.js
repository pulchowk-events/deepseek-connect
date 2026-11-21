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

const { META, httpStatusFor } = require('./errors.js');

const DEFAULT_PORT = 7331;
const LONG_POLL_MS = 30000;
const DEFAULT_REQUEST_TIMEOUT_MS = 960000;
const DEFAULT_QUEUE_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_PROMPT_CHARS = 250000;
const DEFAULT_DELIMITERS = { start: 'START_', end: 'END_' };

// Providers with a registered extension module. Mirrors shared.js
// ROUTABLE_PROVIDERS. tongyi has a domain but no module, so it is excluded.
const KNOWN_PROVIDERS = Object.freeze(['deepseek', 'qwen', 'chatgpt']);

function makeErr(code, reason, details, extra) {
  const e = new Error(reason);
  e.code = code;
  e.reason = reason;
  e.details = details;
  Object.assign(e, extra || {});
  return e;
}

// Returns an Error to refuse with, or null when the provider is acceptable.
function checkProvider(provider, known) {
  return checkProviderIn(provider, known || KNOWN_PROVIDERS);
}
function checkProviderIn(provider, KNOWN_PROVIDERS) {
  if (typeof provider !== 'string' || provider.trim() === '') {
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
  const code = e.code || fallbackCode || e.message;
  const meta = META[code];
  return {
    ok: false,
    error: code,
    reason: e.reason || e.message,
    retryable: e.retryable ?? (meta ? meta.retryable : false),
    retryAfter: e.retryAfter || 0,
    userFixable: e.userFixable ?? (meta ? meta.userFixable : false),
    details: e.details,
    trace: e.trace,
    requestId: e.requestId,
    executionState: e.executionState,
  };
}

function createServer(opts) {
  const port = opts.port ?? DEFAULT_PORT;
  const token = opts.token;
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? defaultLog;
  const buildHash = readBuildHash();
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;

  if (!token) throw new Error('createServer: token required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('createServer: port must be 0-65535');
  }
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error('createServer: host must be a non-empty string');
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
    throw new Error('createServer: requestTimeoutMs and queueTimeoutMs must be positive integers');
  }

  const queue = [];
  const waiting = [];
  const inFlight = new Map();
  const requestsById = new Map();
  const completedRequests = [];
  let sessionId = null;
  let lastHelloAt = null;
  let lastPollAt = null;
  let cachedTabs = [];

  function pump() {
    while (queue.length > 0 && waiting.length > 0 && inFlight.size === 0) {
      const entry = queue.shift();
      const waiter = waiting.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      entry.startedAt = Date.now();
      inFlight.set(entry.requestId, entry);
      entry.executionState = 'outcome_unknown';
      scheduleRequestTimeout(entry, requestTimeoutMs);
      writeJson(waiter.res, 200, {
        action: 'next',
        requestId: entry.requestId,
        executionState: entry.executionState,
        mode: entry.mode || 'prompt',
        chatName: entry.chatName,
        targetTabId: entry.targetTabId,
        targetUrl: entry.targetUrl,
        provider: entry.provider,
        prompt: entry.prompt,
        delimiters: entry.delimiters,
      });
      log('-> dispatched', entry.requestId, '|', entry.provider, '|', entry.mode, '|', entry.chatName);
    }
  }

  function enqueue(req) {
    const mode = req.openOnly ? 'open'
               : req.resetOnly ? 'reset'
               : 'prompt';
    const requestId = req.requestId || crypto.randomUUID();
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      mode,
      prompt: req.prompt || '',
      chatName: req.chatName || '',
      targetTabId: req.targetTabId || null,
      targetUrl: req.targetUrl || null,
      provider: req.provider,
      delimiters: req.delimiters || DEFAULT_DELIMITERS,
    })).digest('hex');
    const prior = requestsById.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return Promise.reject(makeErr('bad_request', 'request_id_conflict', { requestId }, { http: 409, requestId }));
      }
      attachCaller(prior, req.callerResponse);
      if (prior.replyReceived) {
        return prior.result
          ? Promise.resolve(prior.result)
          : Promise.reject(prior.replyError || prior.terminalError);
      }
      return prior.promise;
    }

    let resolveEntry;
    let rejectEntry;
    const promise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    const entry = {
      requestId,
      fingerprint,
      promise,
      resolve: resolveEntry,
      reject: rejectEntry,
      settled: false,
      replyReceived: false,
      callerClosers: new Map(),
    };
    requestsById.set(requestId, entry);

    function settleError(e, keepTimer) {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer && !keepTimer) clearTimeout(entry.timer);
      clearCallers(entry);
      e.requestId = requestId;
      entry.terminalError = e;
      entry.reject(e);
      if (!keepTimer || inFlight.get(requestId) !== entry) rememberCompleted(entry);
    }
    entry.settleSuccess = (value) => {
      entry.result = value;
      entry.executionState = 'completed';
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(value);
      rememberCompleted(entry);
      clearCallers(entry);
    };
    entry.settleError = settleError;

    const rejectInvalid = (e) => {
      requestsById.delete(requestId);
      settleError(e);
      return promise;
    };

    {
      const mode = req.openOnly ? 'open'
                 : req.resetOnly ? 'reset'
                 : 'prompt';
      if (mode === 'prompt' && (typeof req.prompt !== 'string' || !req.prompt.trim())) {
        return rejectInvalid(makeErr('bad_request', 'prompt required', { field: 'messages' }));
      }
      const providerErr = checkProvider(req.provider, knownProviders());
      if (providerErr) return rejectInvalid(providerErr);
      entry.requestId = requestId;
      Object.assign(entry, {
        mode,
        prompt: req.prompt,
        chatName: req.chatName || ('chat-' + requestId.slice(0, 8)),
        targetTabId: req.targetTabId,
        targetUrl: req.targetUrl,
        provider: req.provider,
        delimiters: req.delimiters || DEFAULT_DELIMITERS,
        enqueuedAt: Date.now(),
        startedAt: null,
        executionState: 'not_dispatched',
        timer: null,
      });
      attachCaller(entry, req.callerResponse);
      queue.push(entry);
      log('<- enqueued', requestId, '|', entry.provider, '|', mode, '|', entry.chatName);
      scheduleRequestTimeout(entry, queueTimeoutMs);
      pump();
    }
    return promise;
  }

  function attachCaller(entry, response) {
    if (!response || !entry.callerClosers || entry.callerClosers.has(response)) return;
    const onClose = () => {
      entry.callerClosers.delete(response);
      if (response.writableEnded || entry.callerClosers.size > 0 || entry.settled) return;
      entry.callerGone = true;
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        entry.executionState = 'not_dispatched';
        entry.settleError(makeErr('extension_timeout', 'caller_disconnected_before_dispatch', {
          requestId: entry.requestId, executionState: 'not_dispatched',
          recovery: 'The request was not dispatched; confirm before submitting it again.',
        }, { retryable: true, requestId: entry.requestId, executionState: 'not_dispatched' }));
        log('x caller disconnected before dispatch', entry.requestId);
      } else if (inFlight.get(entry.requestId) === entry) {
        entry.executionState = 'outcome_unknown';
        entry.settleError(makeErr('extension_timeout', 'caller_disconnected_after_dispatch', {
          requestId: entry.requestId, executionState: 'outcome_unknown',
          recovery: 'The provider may have received the prompt. Inspect the provider tab before retrying.',
        }, { retryable: false, requestId: entry.requestId, executionState: 'outcome_unknown' }), true);
        log('! caller disconnected after dispatch', entry.requestId, '| outcome unknown');
      }
    };
    entry.callerClosers.set(response, onClose);
    response.once('close', onClose);
  }

  function scheduleRequestTimeout(entry, timeoutMs) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        entry.executionState = 'not_dispatched';
        entry.settleError(makeErr('extension_timeout', 'queue_timeout', {
          requestId: entry.requestId, executionState: 'not_dispatched', timeoutMs,
          recovery: 'The request was not dispatched. Check extension connection and port before retrying.',
        }, { retryable: true, requestId: entry.requestId, executionState: 'not_dispatched' }));
        log('x not dispatched', entry.requestId, '| queue timeout');
        return;
      }
      if (inFlight.get(entry.requestId) === entry && !entry.replyReceived) {
        entry.executionState = 'outcome_unknown';
        const timeoutError = makeErr('extension_timeout', 'request_timeout_outcome_unknown', {
          requestId: entry.requestId, executionState: 'outcome_unknown', timeoutMs,
          recovery: 'Do not resend yet. Inspect the provider tab; wait for a late reply or stop the server after manual verification.',
        }, { retryable: false, requestId: entry.requestId, executionState: 'outcome_unknown' });
        entry.settleError(timeoutError, true);
        log('x outcome unknown', entry.requestId, '| request timeout; queue held for late reply');
      }
    }, timeoutMs);
  }

  function clearCallers(entry) {
    if (!entry.callerClosers) return;
    for (const [response, listener] of entry.callerClosers) {
      response.removeListener('close', listener);
    }
    entry.callerClosers.clear();
  }

  function rememberCompleted(entry) {
    if (entry.completedRemembered) return;
    entry.completedRemembered = true;
    completedRequests.push({ requestId: entry.requestId, at: Date.now() });
    while (completedRequests.length > 100) {
      const old = completedRequests.shift();
      const candidate = requestsById.get(old.requestId);
      if (candidate && candidate.settled && inFlight.get(old.requestId) !== candidate) {
        requestsById.delete(old.requestId);
      }
    }
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

  function statusFor(e, fallback) {
    return e.http || httpStatusFor(e.code, fallback || 500);
  }

  function validateRequestId(value) {
    return value === undefined ||
      (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value));
  }

  function validateName(value, field) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(value)) {
      return makeErr('bad_request', field + '_invalid', { field, maxLength: 200 });
    }
    return null;
  }

  function validateUrl(value, provider) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 2048) {
      return makeErr('bad_request', 'url_invalid', { field: 'url', maxLength: 2048 });
    }
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.port) throw new Error();
      const builtinHosts = {
        deepseek: ['chat.deepseek.com'],
        qwen: ['chat.qwen.ai'],
        chatgpt: ['chatgpt.com'],
      };
      let hosts = builtinHosts[provider] || [];
      if (!hosts.length && provider) {
        const configured = describeProviders().find((p) => p.name === provider && p.kind === 'config');
        if (configured && configured.definition) hosts = configured.definition.domains;
      }
      if (hosts.length && !hosts.includes(u.hostname.toLowerCase())) {
        return makeErr('bad_request', 'url_provider_mismatch', { field: 'url', provider });
      }
    } catch (_) {
      return makeErr('bad_request', 'url_invalid', {
        field: 'url', expected: 'HTTPS provider conversation URL',
      });
    }
    return null;
  }

  function validateBodyObject(body) {
    return body && typeof body === 'object' && !Array.isArray(body)
      ? null
      : makeErr('bad_request', 'json_object_required');
  }

  function providerError(body) {
    return checkProvider(body.provider, knownProviders());
  }

  function checkAuth(req) {
    const h = req.headers['authorization'] || '';
    return h.startsWith('Bearer ') && h.slice(7) === token;
  }

  function readJson(req, limitBytes) {
    limitBytes = limitBytes || MAX_BODY_BYTES;
    const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return Promise.reject(makeErr('bad_request', 'content_type_must_be_application_json', null,
        { http: 415 }));
    }
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let failed = false;
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (size > limitBytes) {
          failed = true;
          chunks.length = 0;
          reject(makeErr('bad_request', 'payload_too_large', { limitBytes }, { http: 413 }));
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (_) { reject(makeErr('bad_request', 'invalid_json')); }
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
    const dsc = getDSC();
    const names = describeProviders().filter((p) => {
      if (p.kind !== 'config' || !p.definition) return false;
      return dsc.validateDefinition(p.definition).ok;
    }).map((p) => p.name);
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
        const objectError = validateBodyObject(body);
        if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
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
      const objectError = validateBodyObject(body);
      if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
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
        const objectError = validateBodyObject(body);
        if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
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
        lastHelloAt = Date.now();
        if (Array.isArray(body.tabs)) {
          cachedTabs = body.tabs.slice(0, 100).filter((t) =>
            t && Number.isSafeInteger(t.id) && typeof t.url === 'string'
          ).map((t) => ({
            id: t.id,
            url: t.url.slice(0, 2048),
            title: typeof t.title === 'string' ? t.title.slice(0, 80) : '',
            active: !!t.active,
            provider: typeof t.provider === 'string' ? t.provider.slice(0, 80) : null,
          }));
        }
        log('extension connected (' + (body.version || '?') + ') | ' + (body.tabUrl || '?') +
            ' | ' + cachedTabs.length + ' tab(s)');
        return writeJson(res, 200, { ok: true, sessionId, buildHash });
      }

      if (method === 'GET' && url === '/tabs') {
        return writeJson(res, 200, { ok: true, tabs: cachedTabs });
      }

      if (method === 'GET' && url === '/status') {
        const now = Date.now();
        return writeJson(res, 200, {
          ok: true,
          registered: !!sessionId,
          extensionResponsive: !!sessionId &&
            (waiting.length > 0 || inFlight.size > 0 || (lastPollAt !== null && now - lastPollAt < LONG_POLL_MS + 10000)),
          sessionId,
          lastHelloAt,
          lastPollAt,
          port: boundPort || port,
          queued: queue.map((e) => ({
            requestId: e.requestId, provider: e.provider, state: 'queued',
            ageMs: Date.now() - e.enqueuedAt,
          })),
          inFlight: Array.from(inFlight.values()).map((e) => ({
            requestId: e.requestId, provider: e.provider, mode: e.mode,
            state: e.executionState, ageMs: Date.now() - e.startedAt,
            callerGone: !!e.callerGone,
          })),
          tabs: cachedTabs.length,
        });
      }

      if (method === 'GET' && url === '/next') {
        lastPollAt = Date.now();
        const waiter = { res, timer: null };
        const removeWaiter = () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          const i = waiting.indexOf(waiter);
          if (i >= 0) waiting.splice(i, 1);
        };
        res.once('close', () => {
          if (!res.writableEnded) removeWaiter();
        });
        waiter.timer = setTimeout(() => {
          const i = waiting.indexOf(waiter);
          if (i >= 0) waiting.splice(i, 1);
          writeJson(res, 200, { action: 'idle' });
        }, LONG_POLL_MS);
        waiting.push(waiter);
        pump();
        return;
      }

      if (method === 'POST' && url === '/progress') {
        const body = await readJson(req);
        const entry = body && typeof body.requestId === 'string' ? inFlight.get(body.requestId) : null;
        if (!entry) return writeJson(res, 404, { ok: false, error: 'unknown_request' });
        if (typeof body.phase !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(body.phase)) {
          return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'phase_invalid' });
        }
        let extra = '';
        if (body.extra !== undefined) {
          const safeExtra = sanitizeProgress(body.extra, '', 0);
          let serialized;
          try { serialized = JSON.stringify(safeExtra); } catch (_) { serialized = ''; }
          if (serialized && serialized.length <= 1000) {
            extra = ' ' + serialized;
          } else if (serialized) {
            extra = ' [extra omitted: too large]';
          }
        }
        log('  ~ ' + String(body.requestId).slice(0, 8) + ' ' + body.phase + extra);
        return writeJson(res, 200, { ok: true });
      }

      if (method === 'POST' && url === '/reply') {
        const body = await readJson(req);
        const entry = body && typeof body.requestId === 'string' ? inFlight.get(body.requestId) : null;
        if (!entry) {
          return writeJson(res, 404, { ok: false, error: 'unknown_request' });
        }
        if (entry.replyReceived) {
          return writeJson(res, 409, { ok: false, error: 'bad_request', reason: 'duplicate_reply', requestId: body.requestId });
        }
        if (body.status !== 'ok' && body.status !== 'error') {
          return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'reply_status_invalid' });
        }
        if (body.status === 'ok' && entry.mode === 'prompt' &&
            (typeof body.content !== 'string' || body.content.trim() === '')) {
          return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'reply_content_missing' });
        }
        if (body.status === 'error' && (typeof body.error !== 'string' || body.error.trim() === '')) {
          return writeJson(res, 400, { ok: false, error: 'bad_request', reason: 'reply_error_missing' });
        }
        entry.replyReceived = true;
        if (entry.timer) clearTimeout(entry.timer);
        clearCallers(entry);
        inFlight.delete(body.requestId);
        const elapsedMs = Date.now() - entry.startedAt;
        if (body.status === 'ok') {
          log('ok done', body.requestId, '| ' + elapsedMs + 'ms');
          logTrace(log, 'ok', body.requestId, body.trace, 4);
          entry.settleSuccess({
            content: body.content,
            raw: body.raw,
            elapsedMs,
            trace: body.trace,
            existing: body.existing,
            mode: body.mode,
            debug: body.debug,
            chat: body.chat,
            url: body.url,
            requestId: body.requestId,
            executionState: 'completed',
          });
        } else {
          log('x failed', body.requestId, '|', String(body.error).slice(0, 80));
          logTrace(log, 'err', body.requestId, body.trace, 8);
          const known = META[body.error];
          const trace = Array.isArray(body.trace) ? sanitizeProgress(body.trace, '', 0) : undefined;
          const executionState = traceHasDispatch(body.trace)
            ? 'outcome_unknown'
            : body.executionState === 'not_dispatched' ||
                (body.executionState === undefined && Array.isArray(body.trace))
              ? 'not_dispatched'
              : 'outcome_unknown';
          const err = makeErr(known ? body.error : 'internal_error',
            String(body.reason || body.error || 'extension_error').slice(0, 500),
            known ? sanitizeProgress(body.details, '', 0) : {
              providerError: String(body.error).slice(0, 80),
              details: sanitizeProgress(body.details, '', 0),
            });
          err.retryAfter = Number.isFinite(body.retryAfter)
            ? Math.max(0, Math.min(body.retryAfter, 3600000)) : 0;
          err.probe = sanitizeProgress(body.probe, '', 0);
          err.trace = trace;
          err.executionState = executionState;
          err.retryable = executionState === 'not_dispatched' && known ? META[body.error].retryable : false;
          err.userFixable = known ? META[body.error].userFixable : false;
          entry.replyError = err;
          entry.settleError(err);
        }
        rememberCompleted(entry);
        pump();
        return writeJson(res, 200, { ok: true });
      }

      if (method === 'POST' && url === '/open') {
        const body = await readJson(req);
        const objectError = validateBodyObject(body);
        if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
        if (!validateRequestId(body.requestId)) {
          const e = makeErr('bad_request', 'request_id_invalid', { field: 'requestId' });
          return writeJson(res, statusFor(e), errorBody(e));
        }
        const requestId = body.requestId || crypto.randomUUID();
        const failBeforeDispatch = (e) => {
          e.requestId = requestId;
          e.executionState = 'not_dispatched';
          return writeJson(res, statusFor(e), errorBody(e));
        };
        const chatName = body.chatName;
        const targetUrl = body.url;
        const nameError = validateName(chatName, 'chatName');
        if (nameError) return failBeforeDispatch(nameError);
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return failBeforeDispatch(providerErr);
        const urlError = validateUrl(targetUrl, body.provider);
        if (urlError) return failBeforeDispatch(urlError);
        try {
          const result = await enqueue({
            requestId, callerResponse: res,
            prompt: null, chatName, openOnly: true, targetUrl, provider: body.provider,
          });
          return writeJson(res, 200, {
            ok: true,
            existing: !!(result && result.existing),
            mode: result && result.mode,
            debug: result && result.debug,
            url: (result && result.url) || targetUrl || null,
            chat: chatName,
            requestId: result.requestId,
            executionState: 'completed',
          });
        } catch (e) {
          return writeJson(res, statusFor(e), errorBody(e, 'open_failed'));
        }
      }

      if (method === 'POST' && url === '/reset') {
        const body = await readJson(req);
        const objectError = validateBodyObject(body);
        if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
        if (!validateRequestId(body.requestId)) {
          const e = makeErr('bad_request', 'request_id_invalid', { field: 'requestId' });
          return writeJson(res, statusFor(e), errorBody(e));
        }
        const requestId = body.requestId || crypto.randomUUID();
        const failBeforeDispatch = (e) => {
          e.requestId = requestId;
          e.executionState = 'not_dispatched';
          return writeJson(res, statusFor(e), errorBody(e));
        };
        const chatName = body.chatName;
        const nameError = validateName(chatName, 'chatName');
        if (nameError) return failBeforeDispatch(nameError);
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return failBeforeDispatch(providerErr);
        try {
          const result = await enqueue({
            requestId, callerResponse: res,
            prompt: null, chatName, resetOnly: true, provider: body.provider,
          });
          return writeJson(res, 200, {
            ok: true, chat: chatName, result,
            requestId: result.requestId, executionState: 'completed',
          });
        } catch (e) {
          return writeJson(res, statusFor(e), errorBody(e, 'reset_failed'));
        }
      }

      if (method === 'POST' && url === '/chat') {
        const body = await readJson(req);
        const objectError = validateBodyObject(body);
        if (objectError) return writeJson(res, statusFor(objectError), errorBody(objectError));
        if (!validateRequestId(body.requestId)) {
          const e = makeErr('bad_request', 'request_id_invalid', { field: 'requestId' });
          return writeJson(res, statusFor(e), errorBody(e));
        }
        const requestId = body.requestId || crypto.randomUUID();
        const failBeforeDispatch = (e) => {
          e.requestId = requestId;
          e.executionState = 'not_dispatched';
          return writeJson(res, statusFor(e), errorBody(e));
        };
        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
          const e = makeErr('bad_request', 'messages_invalid', { minItems: 1, maxItems: MAX_MESSAGES });
          return failBeforeDispatch(e);
        }
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          if (!m || typeof m !== 'object' || Array.isArray(m) ||
              !['system', 'user', 'assistant'].includes(m.role) ||
              typeof m.content !== 'string') {
            const e = makeErr('bad_request', 'message_invalid', {
              field: 'messages[' + i + ']', allowedRoles: ['system', 'user', 'assistant'],
            });
            return failBeforeDispatch(e);
          }
        }
        const prompt = messages.map((m) => m.content).join('\n\n');
        if (!prompt.trim()) {
          const e = makeErr('bad_request', 'prompt_required', { field: 'messages' });
          return failBeforeDispatch(e);
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
          const e = makeErr('bad_request', 'prompt_too_large', {
            promptLength: prompt.length, maxPromptChars: MAX_PROMPT_CHARS,
          });
          return failBeforeDispatch(e);
        }
        const providerErr = checkProvider(body.provider, knownProviders());
        if (providerErr) return failBeforeDispatch(providerErr);
        const nameError = body.chat === undefined ? null : validateName(body.chat, 'chat');
        if (nameError) return failBeforeDispatch(nameError);
        const tabId = body.targetTabId;
        if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId <= 0)) {
          const e = makeErr('bad_request', 'target_tab_id_invalid', { field: 'targetTabId' });
          return failBeforeDispatch(e);
        }
        const urlError = validateUrl(body.url, body.provider);
        if (urlError) return failBeforeDispatch(urlError);
        const chatName = body.chat || ('api-' + requestId.slice(0, 8));
        const targetTabId = body.targetTabId;
        const targetUrl = body.url;
        const startedAt = Date.now();
        try {
          const result = await enqueue({
            requestId, callerResponse: res,
            prompt, chatName, targetTabId, targetUrl, provider: body.provider,
          });
          return writeJson(res, 200, {
            content: result.content,
            chat: chatName,
            url: result.url,
            elapsedMs: Date.now() - startedAt,
            requestId: result.requestId,
            executionState: 'completed',
          });
        } catch (e) {
          return writeJson(res, statusFor(e), errorBody(e));
        }
      }

      if (url === '/providers' || url.startsWith('/providers/')) {
        return await handleProviders(req, res, method, url);
      }

      return writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      log('! handler error', e.code || 'internal_error', '|', String(e.reason || e.message).slice(0, 160));
      if (!res.headersSent) writeJson(res, statusFor(e), errorBody(e, 'internal_error'));
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
      for (const e of queue) {
        if (e.timer) clearTimeout(e.timer);
        e.settleError(makeErr('extension_timeout', 'server_closed', {
          requestId: e.requestId, executionState: 'not_dispatched',
        }, { retryable: true, requestId: e.requestId, executionState: 'not_dispatched' }));
      }
      for (const e of inFlight.values()) {
        if (e.timer) clearTimeout(e.timer);
        e.settleError(makeErr('extension_timeout', 'server_closed', {
          requestId: e.requestId, executionState: 'outcome_unknown',
          recovery: 'Inspect the provider tab before retrying this request.',
        }, { retryable: false, requestId: e.requestId, executionState: 'outcome_unknown' }));
        clearCallers(e);
      }
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

function sanitizeProgress(value, key, depth) {
  if (depth > 4) return '[depth limited]';
  if (key && /prompt|raw|content|text|token|authorization|reply|url|reason/i.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 120);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeProgress(v, '', depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 20)) {
      out[k.slice(0, 80)] = sanitizeProgress(value[k], k, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 80);
}

function traceHasDispatch(trace) {
  if (!Array.isArray(trace)) return false;
  const phases = new Set(['sendClick', 'step_6_send_clicked', 'gpt_sent', 'cfg_sent']);
  return trace.some((entry) => entry && phases.has(entry.phase));
}

function logTrace(log, tag, id, trace, tail) {
  if (!Array.isArray(trace) || trace.length === 0) return;
  const shown = trace.slice(-(tail || 6));
  for (const e of shown) {
    if (!e || typeof e !== 'object') continue;
    const { t, phase, ...rest } = e;
    log('  trace[' + tag + ']', id.slice(0, 8),
      String(Number.isFinite(t) ? t : '?').padStart(5) + 'ms',
      typeof phase === 'string' ? phase.slice(0, 80) : '?',
      Object.keys(rest).length ? JSON.stringify(sanitizeProgress(rest, '', 0)) : '');
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
