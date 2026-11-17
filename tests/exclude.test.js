'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('../shared.js');
const DSC = globalThis.DSC;
const { createServer } = require('../src/server.js');
const { createClient } = require('../src/client.js');

function def(extra) {
  return Object.assign({
    schema: 1,
    name: 'excl',
    label: 'Exclude test',
    domains: ['chat.example.org'],
    selectors: { input: ['#i'], send: ['#s'], response: ['div.r'] },
  }, extra || {});
}

test('exclude: validateDefinition accepts an exclude array and keeps it', () => {
  const ex = ['[class*="messageInputContainer"]', 'div.thinking'];
  const v = DSC.validateDefinition(def({ exclude: ex }));
  assert.strictEqual(v.ok, true, v.errors && v.errors.join('; '));
  assert.deepStrictEqual(v.value.exclude, ex);
});

test('exclude: omitted from the validated value when absent or empty', () => {
  const a = DSC.validateDefinition(def());
  const b = DSC.validateDefinition(def({ exclude: [] }));
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual('exclude' in a.value, false);
  assert.strictEqual('exclude' in b.value, false);
});

test('exclude: rejects a non-array value', () => {
  const v = DSC.validateDefinition(def({ exclude: 'div.x' }));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /exclude/.test(e)));
});

test('exclude: rejects blank and non-string entries', () => {
  assert.strictEqual(DSC.validateDefinition(def({ exclude: ['  '] })).ok, false);
  assert.strictEqual(DSC.validateDefinition(def({ exclude: [5] })).ok, false);
});

test('exclude: rejects an entry longer than 300 characters', () => {
  const v = DSC.validateDefinition(def({ exclude: ['x'.repeat(301)] }));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /exclude/.test(e)));
});

test('exclude: the server round-trips it through POST and GET /providers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-excl-'));
  const server = createServer({ port: 0, token: 't', providersDir: dir, log: () => {} });
  await server.start();
  try {
    const dc = createClient({ token: 't', port: server.port() });
    await dc.addProvider('excl', def({ exclude: ['[class*="messageInputContainer"]'] }));
    const listing = await dc.providers();
    const p = listing.providers.find((x) => x.name === 'excl');
    assert.ok(p && p.definition, 'provider listed with its definition');
    assert.deepStrictEqual(p.definition.exclude, ['[class*="messageInputContainer"]']);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
