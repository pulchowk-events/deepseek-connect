'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildIssue, MAX_ENCODED_BODY } = require('../submit.js');

const SRC = "// providers/glm.js\n'use strict';\nglobalThis.DSC.makeConfigProvider(/*DEF*/{\"name\":\"glm\"}/*END*/);\n";
const BASE = {
  repoUrl: 'https://github.com/pulchowk-events/deepseek-connect',
  name: 'glm',
  label: 'GLM (Z.ai)',
  domains: ['chat.z.ai'],
  source: SRC,
  definition: { schema: 1, name: 'glm' },
  submitter: 'alice',
};
const bodyOf = (out) => new URL(out.url).searchParams.get('body');

test('submit: a short definition fits in one link with the full file (tier 1)', () => {
  const out = buildIssue(BASE);
  const u = new URL(out.url);
  assert.strictEqual(out.tier, 1);
  assert.strictEqual(out.clipboard, null);
  assert.strictEqual(u.pathname, '/pulchowk-events/deepseek-connect/issues/new');
  assert.strictEqual(u.searchParams.get('title'), 'New provider: glm');
  const body = bodyOf(out);
  assert.ok(body.includes('```js\n' + SRC.trimEnd() + '\n```'));
  assert.ok(body.includes('Submitted by: alice'));
  assert.ok(body.includes('`seeds/glm.json`') && body.includes('`providers/glm.js`'));
});

test('submit: a long file falls back to compact JSON (tier 2)', () => {
  const out = buildIssue(Object.assign({}, BASE, { source: 'x'.repeat(7000) }));
  const body = bodyOf(out);
  assert.strictEqual(out.tier, 2);
  assert.ok(out.encodedLength <= MAX_ENCODED_BODY);
  assert.ok(body.includes('```json\n{"schema":1,"name":"glm"}\n```'));
  assert.ok(!body.includes('xxxxxxxx'));
});

test('submit: a huge definition falls back to the clipboard (tier 3)', () => {
  const big = 'y'.repeat(7000);
  const out = buildIssue(Object.assign({}, BASE, { source: big, definition: { big } }));
  assert.strictEqual(out.tier, 3);
  assert.strictEqual(out.clipboard, big);
  assert.ok(out.encodedLength <= MAX_ENCODED_BODY);
  assert.ok(bodyOf(out).includes('clipboard'));
});

test('submit: the body is URL-encoded and a missing submitter is labelled', () => {
  const odd = buildIssue(Object.assign({}, BASE, { submitter: 'a&b #1 100% \u00fcn\u00ef', repoUrl: BASE.repoUrl + '/' }));
  assert.ok(bodyOf(odd).includes('Submitted by: a&b #1 100% \u00fcn\u00ef'));
  assert.strictEqual(odd.url.indexOf('&', odd.url.indexOf('&body=') + 6), -1);
  assert.strictEqual(new URL(odd.url).pathname, '/pulchowk-events/deepseek-connect/issues/new');
  const none = buildIssue(Object.assign({}, BASE, { submitter: '   ' }));
  assert.ok(bodyOf(none).includes('Submitted by: (not given)'));
});
