'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../shared.js');
const DSC = globalThis.DSC;

const SEEDS_DIR = path.join(__dirname, '..', 'seeds');
const NTH_RE = /:nth-(of-type|child)\(/;

const files = fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.json')).sort();

for (const file of files) {
  test('seed ' + file + ': valid definition, no positional response selectors', () => {
    const def = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8'));
    const r = DSC.validateDefinition(def);
    assert.equal(r.ok, true, file + ' failed validation: ' + (r.errors || []).join('; '));
    for (const s of def.selectors.response) {
      assert.equal(NTH_RE.test(s), false, file + ' has a positional response selector: ' + s);
    }
  });
}
