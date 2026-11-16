'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createClient } = require('../src/client.js');
const { DSCError, CODES } = require('../src/errors.js');

const TOKEN = 'test-token-xyz';

// Spin up a mock server with a handler that returns canned responses.
// Returns { port, close, requests }. `requests` accumulates every
// method+path the client called, for assertions.
function mockServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const entry = { method: req.method, path: req.url, headers: req.headers, body };
        requests.push(entry);
        try {
          handler(entry, res);
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: 'handler_threw', reason: e.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
        requests,
      });
    });
  });
}

function jsonReply(res, status, body) {
  const str = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(str),
  });
  res.end(str);
}

test('chat() sends POST /chat with the right body and returns the parsed result', async () => {
  const srv = await mockServer((req, res) => {
    jsonReply(res, 200, { content: 'hi', chat: 'my-chat', elapsedMs: 1234 });
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    const result = await dc.chat({
      messages: [{ role: 'user', content: 'hello' }],
      chat: 'my-chat',
    });
    assert.strictEqual(result.content, 'hi');
    assert.strictEqual(result.chat, 'my-chat');
    assert.strictEqual(result.elapsedMs, 1234);

    assert.strictEqual(srv.requests.length, 1);
    const req = srv.requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.path, '/chat');
    assert.strictEqual(req.headers['authorization'], 'Bearer ' + TOKEN);
    const sent = JSON.parse(req.body);
    assert.deepStrictEqual(sent.messages, [{ role: 'user', content: 'hello' }]);
    assert.strictEqual(sent.chat, 'my-chat');
  } finally {
    await srv.close();
  }
});

test('chat() throws DSCError with auth_failed on 401', async () => {
  const srv = await mockServer((req, res) => {
    jsonReply(res, 401, { ok: false, error: 'auth_failed', reason: 'unauthorized' });
  });
  try {
    const dc = createClient({ token: 'wrong', port: srv.port });
    await assert.rejects(
      () => dc.chat({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => {
        assert.ok(err instanceof DSCError);
        assert.strictEqual(err.code, 'auth_failed');
        assert.strictEqual(err.http, 401);
        assert.strictEqual(err.retryable, false);
        assert.strictEqual(err.userFixable, true);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('chat() collapses unknown codes to internal_error', async () => {
  const srv = await mockServer((req, res) => {
    jsonReply(res, 500, { ok: false, error: 'some_unknown_code', reason: 'whoops' });
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    await assert.rejects(
      () => dc.chat({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => {
        assert.ok(err instanceof DSCError);
        assert.strictEqual(err.code, CODES.INTERNAL_ERROR);
        // client.js sets reason = json.error || json.reason, so an unknown
        // code surfaces the raw code string. The original human reason is
        // preserved in details for debugging.
        assert.strictEqual(err.reason, 'some_unknown_code');
        assert.strictEqual(err.details.reason, 'whoops');
        assert.strictEqual(err.http, 500);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('chat() validates messages client-side before making a request', async () => {
  const srv = await mockServer(() => {});
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    await assert.rejects(
      () => dc.chat({}),
      (err) => {
        assert.ok(err instanceof DSCError);
        assert.strictEqual(err.code, CODES.BAD_REQUEST);
        return true;
      }
    );
    // No request should have gone out
    assert.strictEqual(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test('open() sends POST /open with chatName and returns the parsed result', async () => {
  const srv = await mockServer((req, res) => {
    jsonReply(res, 200, { ok: true, existing: true, mode: 'existing', chat: 'src-alpha' });
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    const result = await dc.open({ chatName: 'src-alpha' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.existing, true);
    assert.strictEqual(result.mode, 'existing');
    assert.strictEqual(result.chat, 'src-alpha');

    const req = srv.requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.path, '/open');
    const sent = JSON.parse(req.body);
    assert.strictEqual(sent.chatName, 'src-alpha');
  } finally {
    await srv.close();
  }
});

test('open() validates chatName client-side', async () => {
  const srv = await mockServer(() => {});
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    await assert.rejects(
      () => dc.open({}),
      (err) => {
        assert.strictEqual(err.code, CODES.BAD_REQUEST);
        return true;
      }
    );
    assert.strictEqual(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test('tabs() sends GET /tabs and returns the parsed result', async () => {
  const srv = await mockServer((req, res) => {
    jsonReply(res, 200, { ok: true, tabs: [{ id: 1, url: 'https://chat.deepseek.com/', active: true }] });
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    const result = await dc.tabs();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tabs.length, 1);
    assert.strictEqual(result.tabs[0].id, 1);

    assert.strictEqual(srv.requests[0].method, 'GET');
    assert.strictEqual(srv.requests[0].path, '/tabs');
  } finally {
    await srv.close();
  }
});

test('network error (connection refused) throws DSCError internal_error', async () => {
  // Pick a port, don't listen on it, point the client at it
  const dc = createClient({ token: TOKEN, port: 1 });
  await assert.rejects(
    () => dc.tabs(),
    (err) => {
      assert.ok(err instanceof DSCError);
      assert.strictEqual(err.code, CODES.INTERNAL_ERROR);
      return true;
    }
  );
});

test('non-JSON body produces internal_error with reason', async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    await assert.rejects(
      () => dc.tabs(),
      (err) => {
        assert.ok(err instanceof DSCError);
        assert.strictEqual(err.code, CODES.INTERNAL_ERROR);
        assert.ok(/non-json/.test(err.reason));
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('client timeout produces extension_timeout', async () => {
  const srv = await mockServer((req, res) => {
    // Never respond — let the client timeout
  });
  try {
    const dc = createClient({ token: TOKEN, port: srv.port });
    await assert.rejects(
      () => dc.chat({
        messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 50,
      }),
      (err) => {
        assert.strictEqual(err.code, CODES.EXTENSION_TIMEOUT);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});
