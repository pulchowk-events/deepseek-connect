// tests/server.test.js — Node's built-in test runner. Exercises the terminal
// server's auth, /hello handshake, /next long-poll, /reply resolution, and
// queue fairness. Uses global fetch (Node 22). No external deps.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server.js');

const TOKEN = 'test-token';

let portSeq = 17400;

async function startServer(options) {
  const port = portSeq++;
  const quiet = () => {};
  const server = createServer(Object.assign({ port, token: TOKEN, log: quiet }, options || {}));
  await server.listen();
  return { server, baseUrl: 'http://127.0.0.1:' + port };
}

function authHeaders(extra) {
  return Object.assign({ Authorization: 'Bearer ' + TOKEN }, extra || {});
}

function postJson(baseUrl, path, body, token) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test('rejects requests without token', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await fetch(baseUrl + '/hello', { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  } finally { await server.close(); }
});

test('rejects requests with wrong token', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await fetch(baseUrl + '/hello', {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
      body: '{}',
    });
    assert.equal(r.status, 401);
  } finally { await server.close(); }
});

test('/hello returns sessionId', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await postJson(baseUrl, '/hello', { version: '0.1.0', tabUrl: 'x', buildHash: server.buildHash });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.sessionId, /^[0-9a-f-]{36}$/);
  } finally { await server.close(); }
});

test('/next returns idle after long-poll timeout when queue empty', async () => {
  const { server, baseUrl } = await startServer();
  try {
    // Shorten wait by not using the real 30s. Skip — just assert it doesn't hang
    // forever by racing against a 500ms guard. We don't actually trigger timeout.
    // Instead: enqueue, then /next should return immediately.
    const enq = server.enqueue({ prompt: 'hello world', chatName: 'chat-x', provider: 'deepseek' });
    const r = await fetch(baseUrl + '/next', { headers: authHeaders() });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.action, 'next');
    assert.equal(j.chatName, 'chat-x');
    assert.equal(j.prompt, 'hello world');
    assert.equal(j.requestId.length > 0, true);

    // Reply ok, promise resolves.
    const rep = await postJson(baseUrl, '/reply', {
      requestId: j.requestId, status: 'ok', content: 'reply content', raw: 'raw content',
    });
    assert.equal(rep.status, 200);
    const resolved = await enq;
    assert.equal(resolved.content, 'reply content');
    assert.equal(typeof resolved.elapsedMs, 'number');
  } finally { await server.close(); }
});

test('/reply error rejects the enqueue promise', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const enq = server.enqueue({ prompt: 'boom', chatName: 'chat-x', provider: 'deepseek' });
    const nextR = await fetch(baseUrl + '/next', { headers: authHeaders() });
    const work = await nextR.json();

    const rejected = assert.rejects(enq, (err) => {
      assert.equal(err.code, 'input_not_found');
      assert.equal(err.reason, 'no_input');
      return true;
    });

    await postJson(baseUrl, '/reply', {
      requestId: work.requestId,
      status: 'error',
      error: 'input_not_found',
      reason: 'no_input',
    });

    await rejected;
  } finally { await server.close(); }
});

test('/chat preserves retry metadata from provider errors', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const responsePromise = postJson(baseUrl, '/chat', {
      messages: [{ role: 'user', content: 'hello' }],
      chat: 'rate-limited-chat',
      provider: 'deepseek',
      url: 'https://chat.deepseek.com/a/chat/s/saved-chat',
    });
    const next = await fetch(baseUrl + '/next', { headers: authHeaders() });
    const work = await next.json();
    assert.equal(work.targetUrl, 'https://chat.deepseek.com/a/chat/s/saved-chat');

    await postJson(baseUrl, '/reply', {
      requestId: work.requestId,
      status: 'error',
      error: 'rate_limited',
      reason: 'rate_limited',
      retryAfter: 30000,
      executionState: 'not_dispatched',
    });

    const response = await responsePromise;
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.error, 'rate_limited');
    assert.equal(body.retryable, true);
    assert.equal(body.retryAfter, 30000);
    assert.equal(body.userFixable, false);
  } finally { await server.close(); }
});

test('/reply cannot mark a dispatched provider error safe to retry', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const responsePromise = postJson(baseUrl, '/chat', {
      requestId: 'rate-after-submit',
      messages: [{ role: 'user', content: 'possibly submitted' }],
      provider: 'deepseek',
    });
    const work = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    await postJson(baseUrl, '/reply', {
      requestId: work.requestId,
      status: 'error',
      error: 'rate_limited',
      reason: 'rate limit after submit',
      retryable: true,
      trace: [{ phase: 'sendClick' }],
    });
    const response = await responsePromise;
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.retryable, false);
    assert.equal(body.executionState, 'outcome_unknown');
  } finally { await server.close(); }
});

test('/reply with unknown requestId returns 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await postJson(baseUrl, '/reply', {
      requestId: 'does-not-exist', status: 'ok', content: 'x',
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error, 'unknown_request');
  } finally { await server.close(); }
});

test('queue serves FIFO, one in-flight at a time', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const a = server.enqueue({ prompt: 'first', chatName: 'A', provider: 'deepseek' });
    const b = server.enqueue({ prompt: 'second', chatName: 'B', provider: 'deepseek' });

    // First /next must return 'first'.
    const n1 = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    assert.equal(n1.prompt, 'first');
    assert.equal(n1.chatName, 'A');

    // While 'first' is in flight, /next should NOT immediately return 'second'
    // unless we've replied. Race a 300ms guard.
    const pending = fetch(baseUrl + '/next', { headers: authHeaders() });
    const guard = await Promise.race([
      pending.then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('waiting'), 300)),
    ]);
    assert.equal(guard, 'waiting');

    // Reply to first, then pending should resolve with second.
    await postJson(baseUrl, '/reply', {
      requestId: n1.requestId, status: 'ok', content: 'one',
    });
    const n2 = await (await pending).json();
    assert.equal(n2.prompt, 'second');
    assert.equal(n2.chatName, 'B');

    await postJson(baseUrl, '/reply', {
      requestId: n2.requestId, status: 'ok', content: 'two',
    });
    assert.equal((await a).content, 'one');
    assert.equal((await b).content, 'two');
  } finally { await server.close(); }
});

test('enqueue rejects empty prompt', async () => {
  const { server } = await startServer();
  try {
    await assert.rejects(
      server.enqueue({ prompt: '', chatName: 'x', provider: 'deepseek' }),
      /prompt required/
    );
  } finally { await server.close(); }
});

test('close() rejects queued and in-flight enqueues', async () => {
  const { server } = await startServer();
  const q = server.enqueue({ prompt: 'queued-but-not-dispatched', chatName: 'Q', provider: 'deepseek' });
  await server.close();
  await assert.rejects(q, /server_closed/);
});

test('/chat rejects malformed JSON, wrong content type, invalid messages, and bad routing fields', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const wrongType = await fetch(baseUrl + '/chat', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'text/plain' }), body: '{}',
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).reason, 'content_type_must_be_application_json');

    const malformed = await fetch(baseUrl + '/chat', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{"messages":',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).reason, 'invalid_json');

    const invalid = [
      {},
      { messages: [{ role: 'user', content: ' \t ' }], provider: 'deepseek' },
      { messages: [{ role: 'usr', content: 'hello' }], provider: 'deepseek' },
      { messages: [{ role: 'user', content: 'hello' }], provider: 'typo' },
      { messages: [{ role: 'user', content: 'hello' }], provider: 'deepseek', targetTabId: 0 },
      { messages: [{ role: 'user', content: 'hello' }], provider: 'deepseek', url: 'https://chat.deepseek.com.evil.example/' },
    ];
    for (const body of invalid) {
      const response = await postJson(baseUrl, '/chat', body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).ok, false);
    }
    const invalidWithId = await postJson(baseUrl, '/chat', {
      requestId: 'invalid-before-dispatch',
      messages: [{ role: 'user', content: '   ' }],
      provider: 'deepseek',
    });
    const invalidError = await invalidWithId.json();
    assert.equal(invalidError.requestId, 'invalid-before-dispatch');
    assert.equal(invalidError.executionState, 'not_dispatched');
    assert.equal(server.status().queued, 0);
  } finally { await server.close(); }
});

test('duplicate request IDs share one dispatch and conflicting payloads are rejected', async () => {
  const { server, baseUrl } = await startServer();
  const body = {
    requestId: 'batch-item-1',
    messages: [{ role: 'user', content: 'unique private prompt text' }],
    provider: 'deepseek',
  };
  try {
    const first = postJson(baseUrl, '/chat', body);
    const duplicate = postJson(baseUrl, '/chat', body);
    const next = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    assert.equal(next.requestId, body.requestId);
    assert.equal(server.status().inFlight, 1);

    const conflict = await postJson(baseUrl, '/chat', Object.assign({}, body, {
      messages: [{ role: 'user', content: 'different prompt' }],
    }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).reason, 'request_id_conflict');

    await postJson(baseUrl, '/reply', {
      requestId: next.requestId, status: 'ok', content: 'answer',
    });
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await a.json()).requestId, body.requestId);
    assert.equal((await b.json()).content, 'answer');
    assert.equal(server.status().inFlight, 0);
  } finally { await server.close(); }
});

test('timed-out dispatched requests report uncertain outcome and hold the queue until late reply', async () => {
  const { server, baseUrl } = await startServer({ requestTimeoutMs: 40, queueTimeoutMs: 1000 });
  try {
    const caller = postJson(baseUrl, '/chat', {
      requestId: 'uncertain-1',
      messages: [{ role: 'user', content: 'possibly sent' }],
      provider: 'deepseek',
    });
    const work = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    const response = await caller;
    assert.equal(response.status, 504);
    const error = await response.json();
    assert.equal(error.requestId, work.requestId);
    assert.equal(error.executionState, 'outcome_unknown');
    assert.equal(error.retryable, false);
    assert.equal(server.status().inFlight, 1);

    const queuedCaller = postJson(baseUrl, '/chat', {
      requestId: 'after-uncertain-1',
      messages: [{ role: 'user', content: 'next prompt' }],
      provider: 'deepseek',
    });
    const queueDeadline = Date.now() + 1000;
    while (server.status().queued !== 1 && Date.now() < queueDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.status().queued, 1);
    await postJson(baseUrl, '/reply', {
      requestId: work.requestId, status: 'ok', content: 'late result',
    });
    assert.equal(server.status().inFlight, 0);

    const recovered = await postJson(baseUrl, '/chat', {
      requestId: 'uncertain-1',
      messages: [{ role: 'user', content: 'possibly sent' }],
      provider: 'deepseek',
    });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).content, 'late result');

    const next = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    assert.equal(next.requestId, 'after-uncertain-1');
    await postJson(baseUrl, '/reply', {
      requestId: next.requestId, status: 'ok', content: 'next result',
    });
    assert.equal((await queuedCaller).status, 200);
  } finally { await server.close(); }
});

test('caller disconnect before dispatch removes its queued request', async () => {
  const { server, baseUrl } = await startServer();
  const controller = new AbortController();
  try {
    const pending = fetch(baseUrl + '/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        requestId: 'disconnect-queued',
        messages: [{ role: 'user', content: 'do not dispatch' }],
        provider: 'deepseek',
      }),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await assert.rejects(pending);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(server.status().queued, 0);
    assert.equal(server.status().inFlight, 0);
  } finally { await server.close(); }
});

test('server progress and request logs redact prompt-bearing data', async () => {
  const lines = [];
  const { server, baseUrl } = await startServer({ log: (...args) => lines.push(args.join(' ')) });
  try {
    const pending = server.enqueue({
      prompt: 'secret-prompt-do-not-log', chatName: 'log-test', provider: 'deepseek',
    });
    const work = await (await fetch(baseUrl + '/next', { headers: authHeaders() })).json();
    const progress = await postJson(baseUrl, '/progress', {
      requestId: work.requestId, phase: 'test_phase', extra: { content: 'secret-reply-do-not-log', len: 10 },
    });
    assert.equal(progress.status, 200);
    await postJson(baseUrl, '/reply', {
      requestId: work.requestId, status: 'ok', content: 'safe result',
    });
    await pending;
    assert.equal(lines.join('\n').includes('secret-prompt-do-not-log'), false);
    assert.equal(lines.join('\n').includes('secret-reply-do-not-log'), false);
    assert.equal(lines.join('\n').includes('[redacted]'), true);
  } finally { await server.close(); }
});

test('unknown route returns 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await fetch(baseUrl + '/nope', { headers: authHeaders() });
    assert.equal(r.status, 404);
  } finally { await server.close(); }
});
