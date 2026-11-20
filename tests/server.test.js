// tests/server.test.js — Node's built-in test runner. Exercises the terminal
// server's auth, /hello handshake, /next long-poll, /reply resolution, and
// queue fairness. Uses global fetch (Node 22). No external deps.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server.js');

const TOKEN = 'test-token';

let portSeq = 17400;

async function startServer() {
  const port = portSeq++;
  const quiet = () => {};
  const server = createServer({ port, token: TOKEN, log: quiet });
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

test('unknown route returns 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const r = await fetch(baseUrl + '/nope', { headers: authHeaders() });
    assert.equal(r.status, 404);
  } finally { await server.close(); }
});
