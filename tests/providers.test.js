'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server.js');

const TOKEN = 'test-token';
let portSeq = 17600;
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-prov-'));
  fs.writeFileSync(path.join(dir, 'deepseek.js'), '// built-in\n');
  const port = portSeq++;
  const server = createServer({ port, token: TOKEN, log: () => {}, providersDir: dir });
  await server.listen();
  return { server, dir, base: 'http://127.0.0.1:' + port };
}
async function stop(ctx) {
  await ctx.server.close();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}
const call = (ctx, method, p, body) =>
  fetch(ctx.base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
const def = (over) => Object.assign({
  schema: 1, name: 'myprov', label: 'My Prov', domains: ['chat.example.com'],
  selectors: { input: ['#in'], send: ['#send'], response: ['.msg'] },
}, over || {});

test('POST /providers writes a marked file and GET lists its definition', async () => {
  const ctx = await start();
  try {
    const r = await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def() });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).written, 'providers/myprov.js');
    const src = fs.readFileSync(path.join(ctx.dir, 'myprov.js'), 'utf8');
    assert.match(src, /makeConfigProvider\(\/\*DEF\*\//);
    const g = await (await call(ctx, 'GET', '/providers')).json();
    const p = g.providers.find((x) => x.name === 'myprov');
    assert.equal(p.kind, 'config');
    assert.equal(p.definition.label, 'My Prov');
    assert.equal(p.definition.timeouts.responseMs, 180000);
    assert.ok(g.providers.some((x) => x.name === 'deepseek' && x.kind === 'built-in'));
  } finally { await stop(ctx); }
});

test('POST refuses to overwrite an existing provider (409)', async () => {
  const ctx = await start();
  try {
    assert.equal((await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def() })).status, 200);
    const r = await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def({ label: 'Other' }) });
    assert.equal(r.status, 409);
    const g = await (await call(ctx, 'GET', '/providers')).json();
    assert.equal(g.providers.find((x) => x.name === 'myprov').definition.label, 'My Prov');
  } finally { await stop(ctx); }
});

test('POST refuses bad names, built-ins, reserved names and bad domains', async () => {
  const ctx = await start();
  try {
    const cases = [
      { name: 'deepseek', definition: def({ name: 'deepseek' }) },
      { name: '../x', definition: def({ name: '../x' }) },
      { name: 'Bad', definition: def({ name: 'Bad' }) },
      { name: 'con', definition: def({ name: 'con' }) },
      { name: 'myprov', definition: def({ name: 'other' }) },
      { name: 'myprov', definition: def({ domains: ['chat.deepseek.com'] }) },
      { name: 'myprov', definition: def({ domains: ['127.0.0.1'] }) },
      { name: 'myprov', definition: def({ domains: ['localhost'] }) },
    ];
    for (const c of cases) {
      const r = await call(ctx, 'POST', '/providers', c);
      assert.equal(r.status, 400, JSON.stringify(c.name) + ' should be refused');
    }
    assert.deepEqual(fs.readdirSync(ctx.dir), ['deepseek.js']);
  } finally { await stop(ctx); }
});

test('a written provider becomes routable; an unknown one is still refused', async () => {
  const ctx = await start();
  try {
    await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def() });
    const queued = ctx.server.enqueue({ prompt: 'x', chatName: 'c', provider: 'myprov' });
    const closed = assert.rejects(queued, /server_closed/);
    await assert.rejects(
      ctx.server.enqueue({ prompt: 'x', chatName: 'c', provider: 'nope' }),
      (e) => e.code === 'bad_request'
    );
    await ctx.server.close();
    await closed;
  } finally { fs.rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('PUT updates, DELETE removes, built-ins and hand-written files are protected', async () => {
  const ctx = await start();
  try {
    await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def() });
    const put = await call(ctx, 'PUT', '/providers/myprov', { definition: def({ label: 'Renamed' }) });
    assert.equal(put.status, 200);
    const g = await (await call(ctx, 'GET', '/providers')).json();
    assert.equal(g.providers.find((x) => x.name === 'myprov').definition.label, 'Renamed');
    assert.equal((await call(ctx, 'DELETE', '/providers/myprov')).status, 200);
    assert.equal(fs.existsSync(path.join(ctx.dir, 'myprov.js')), false);
    assert.equal((await call(ctx, 'DELETE', '/providers/myprov')).status, 404);
    assert.equal((await call(ctx, 'DELETE', '/providers/deepseek')).status, 400);
    fs.writeFileSync(path.join(ctx.dir, 'hand.js'), '// written by hand\n');
    assert.equal((await call(ctx, 'PUT', '/providers/hand', { definition: def({ name: 'hand' }) })).status, 400);
    assert.equal((await call(ctx, 'DELETE', '/providers/hand')).status, 400);
    assert.equal(fs.existsSync(path.join(ctx.dir, 'hand.js')), true);
  } finally { await stop(ctx); }
});

test('comment-like text inside strings round-trips through the sentinels', async () => {
  const ctx = await start();
  try {
    const label = 'a*/b /*END*/ c /*DEF*/ d';
    const r = await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def({ label }) });
    assert.equal(r.status, 200);
    const g = await (await call(ctx, 'GET', '/providers')).json();
    assert.equal(g.providers.find((x) => x.name === 'myprov').definition.label, label);
    new (require('node:vm').Script)(fs.readFileSync(path.join(ctx.dir, 'myprov.js'), 'utf8'));
  } finally { await stop(ctx); }
});

test('a second provider cannot reuse another provider\'s domain', async () => {
  const ctx = await start();
  try {
    await call(ctx, 'POST', '/providers', { name: 'myprov', definition: def() });
    const r = await call(ctx, 'POST', '/providers', { name: 'second', definition: def({ name: 'second' }) });
    assert.equal(r.status, 400);
    const ok = await call(ctx, 'POST', '/providers', { name: 'second', definition: def({ name: 'second', domains: ['other.example.org'] }) });
    assert.equal(ok.status, 200);
  } finally { await stop(ctx); }
});
