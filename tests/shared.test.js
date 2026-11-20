'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../shared.js');
const DSC = globalThis.DSC;

const base = () => ({
  schema: 1, name: 'myprov', label: 'My Prov', domains: ['Chat.Example.com'],
  selectors: { input: ['#in'], send: ['#send'], response: ['.msg'] },
});

test('validateDefinition accepts a minimal definition and applies defaults', () => {
  const r = DSC.validateDefinition(base());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const v = r.value;
  assert.deepEqual(v.domains, ['chat.example.com']);
  assert.equal(v.timeouts.sendMs, 15000);
  assert.equal(v.timeouts.responseMs, 180000);
  assert.equal(v.pacingMs, 0);
  assert.equal(v.extraction, 'rawText');
  assert.equal(v.completionMode, 'whichever');
  assert.equal(v.completionStableMs, 4000);
  assert.deepEqual(v.selectors.code, ['pre code', 'pre']);
  assert.deepEqual(v.selectors.stop, []);
});

test('validateDefinition rejects bad definitions', () => {
  const bad = (mut) => { const d = base(); mut(d); return DSC.validateDefinition(d); };
  const cases = [
    (d) => { delete d.domains; },
    (d) => { d.domains = []; },
    (d) => { d.domains = ['127.0.0.1']; },
    (d) => { d.domains = ['localhost']; },
    (d) => { d.domains = ['https://chat.example.com']; },
    (d) => { d.domains = ['chat.example.com:8443']; },
    (d) => { d.domains = ['chat.example.com/path']; },
    (d) => { d.domains = ['*.example.com']; },
    (d) => { d.domains = ['chat.deepseek.com']; },
    (d) => { d.name = 'deepseek'; },
    (d) => { d.name = '../x'; },
    (d) => { d.schema = 2; },
    (d) => { d.bogus = 1; },
    (d) => { d.selectors.input = []; },
    (d) => { d.extraction = 'magic'; },
    (d) => { d.completionMode = 'delimiter'; },
    (d) => { d.delimiter = { prefix: 'A', suffix: 'B' }; },
    (d) => { d.extraction = 'delimiter'; },
    (d) => { d.timeouts = { responseMs: 5 }; },
    (d) => { d.pacingMs = -1; },
  ];
  cases.forEach((mut, i) => {
    const r = bad(mut);
    assert.equal(r.ok, false, 'case ' + i + ' should be rejected');
    assert.ok(r.errors.length > 0);
  });
  const good = base();
  good.extraction = 'delimiter';
  good.delimiter = { prefix: 'START_X', suffix: 'END_X' };
  good.completionMode = 'delimiter';
  assert.equal(DSC.validateDefinition(good).ok, true);
});

test('dynamic registration drives providerForUrl, isRoutable and navigation origins', () => {
  DSC.clearDynamicProviders();
  assert.equal(DSC.isRoutable('myprov'), false);
  DSC.registerDynamicProvider('myprov', ['chat.example.com']);
  assert.equal(DSC.isRoutable('myprov'), true);
  assert.equal(DSC.providerForUrl('https://chat.example.com/c/1'), 'myprov');
  assert.equal(DSC.providerForUrl('http://chat.example.com/'), null);
  assert.equal(DSC.providerForUrl('https://chat.example.com.evil.com/'), null);
  assert.equal(DSC.providerForUrl('https://chat.deepseek.com/'), 'deepseek');
  assert.equal(DSC.PROVIDER_DOMAINS.myprov, 'https://chat.example.com/');
  assert.throws(() => DSC.registerDynamicProvider('deepseek', ['chat.example.com']));
  assert.throws(() => DSC.registerDynamicProvider('x1', ['127.0.0.1']));
  DSC.clearDynamicProviders();
  assert.equal(DSC.providerForUrl('https://chat.example.com/'), null);
});

test('setDynamicHosts replaces the set and skips disabled rows', () => {
  DSC.setDynamicHosts([
    { name: 'aa', domains: ['a.example.com'], enabled: true },
    { name: 'bb', domains: ['b.example.com'], enabled: false },
  ]);
  assert.equal(DSC.isRoutable('aa'), true);
  assert.equal(DSC.isRoutable('bb'), false);
  DSC.setDynamicHosts([{ name: 'cc', domains: ['c.example.com'] }]);
  assert.equal(DSC.isRoutable('aa'), false);
  assert.equal(DSC.isRoutable('cc'), true);
  assert.deepEqual(DSC.ROUTABLE_PROVIDERS.slice(0, 3), ['deepseek', 'qwen', 'chatgpt']);
  DSC.setDynamicHosts([]);
  assert.deepEqual(DSC.ROUTABLE_PROVIDERS, ['deepseek', 'qwen', 'chatgpt']);
});
