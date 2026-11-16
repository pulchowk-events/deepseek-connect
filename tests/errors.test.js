'use strict';

const test = require('node:test');
const assert = require('node:assert');

const errors = require('../src/errors.js');
const { CODES, META, DSCError, isRetryable, isUserFixable, httpStatusFor, fromReply } = errors;

test('every CODES entry has a META entry', () => {
  for (const code of Object.values(CODES)) {
    assert.ok(META[code], 'missing META for code: ' + code);
  }
});

test('every META entry corresponds to a CODES entry', () => {
  const codeValues = new Set(Object.values(CODES));
  for (const key of Object.keys(META)) {
    assert.ok(codeValues.has(key), 'META key not in CODES: ' + key);
  }
});

test('CODES and META have matching counts', () => {
  assert.strictEqual(Object.keys(CODES).length, Object.keys(META).length);
});

test('every META entry has the required fields', () => {
  for (const [code, meta] of Object.entries(META)) {
    assert.strictEqual(typeof meta.retryable, 'boolean', code + ': retryable not boolean');
    assert.strictEqual(typeof meta.userFixable, 'boolean', code + ': userFixable not boolean');
    assert.strictEqual(typeof meta.http, 'number', code + ': http not number');
    assert.strictEqual(typeof meta.human, 'string', code + ': human not string');
    assert.ok(meta.human.length > 0, code + ': human is empty');
  }
});

test('DSCError carries code, reason, retryable, retryAfter, userFixable, http', () => {
  const err = new DSCError(CODES.RATE_LIMITED, { retryAfter: 30000 });
  assert.strictEqual(err.name, 'DSCError');
  assert.strictEqual(err.code, 'rate_limited');
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.retryAfter, 30000);
  assert.strictEqual(err.userFixable, false);
  assert.strictEqual(err.http, 429);
  assert.ok(err.reason.length > 0);
});

test('DSCError opts override META defaults', () => {
  const err = new DSCError(CODES.INTERNAL_ERROR, {
    retryable: false,
    userFixable: true,
    http: 418,
    reason: 'custom reason',
  });
  assert.strictEqual(err.retryable, false);
  assert.strictEqual(err.userFixable, true);
  assert.strictEqual(err.http, 418);
  assert.strictEqual(err.reason, 'custom reason');
});

test('DSCError.toJSON returns the wire shape', () => {
  const err = new DSCError(CODES.RATE_LIMITED, { retryAfter: 30000 });
  const json = err.toJSON();
  assert.strictEqual(json.ok, false);
  assert.strictEqual(json.error, 'rate_limited');
  assert.strictEqual(json.retryable, true);
  assert.strictEqual(json.retryAfter, 30000);
  assert.strictEqual(json.userFixable, false);
  assert.ok(json.reason.length > 0);
});

test('isRetryable matches META', () => {
  for (const [code, meta] of Object.entries(META)) {
    assert.strictEqual(isRetryable(code), meta.retryable, code);
  }
  assert.strictEqual(isRetryable('not_a_real_code'), false);
});

test('isUserFixable matches META', () => {
  for (const [code, meta] of Object.entries(META)) {
    assert.strictEqual(isUserFixable(code), meta.userFixable, code);
  }
  assert.strictEqual(isUserFixable('not_a_real_code'), false);
});

test('httpStatusFor returns META.http or fallback', () => {
  assert.strictEqual(httpStatusFor(CODES.RATE_LIMITED), 429);
  assert.strictEqual(httpStatusFor(CODES.AUTH_FAILED), 401);
  assert.strictEqual(httpStatusFor(CODES.INPUT_NOT_FOUND), 502);
  assert.strictEqual(httpStatusFor('not_a_real_code', 500), 500);
  assert.strictEqual(httpStatusFor('not_a_real_code'), 500);
});

test('fromReply returns a DSCError for known codes', () => {
  const err = fromReply({ error: 'rate_limited', reason: 'slow down', retryAfter: 5000 });
  assert.ok(err instanceof DSCError);
  assert.strictEqual(err.code, 'rate_limited');
  assert.strictEqual(err.reason, 'slow down');
  assert.strictEqual(err.retryAfter, 5000);
});

test('fromReply collapses unknown codes to internal_error', () => {
  const err = fromReply({ error: 'some_new_code_not_registered', reason: 'custom' });
  assert.strictEqual(err.code, 'internal_error');
  assert.strictEqual(err.reason, 'custom');
});

test('fromReply handles null/undefined gracefully', () => {
  const err = fromReply(null);
  assert.strictEqual(err.code, 'internal_error');
  const err2 = fromReply(undefined);
  assert.strictEqual(err2.code, 'internal_error');
});

test('decision buckets match the documented counts', () => {
  // error-codes.md classifies user_skipped as bucket E (skip silently)
  // despite its metadata flagging userFixable: true — the user is the
  // one who chose to skip, so beeping at them would be user-hostile.
  // The count below is the doc's decision-tree classification, not the
  // raw metadata classification. Verify the metadata exception is real
  // so that if someone "fixes" user_skipped to userFixable: false, this
  // test asks "did you also update error-codes.md's bucket E note?"
  assert.strictEqual(META[CODES.USER_SKIPPED].userFixable, true,
    'user_skipped should still be userFixable: true (documented exception)');

  const buckets = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const [code, meta] of Object.entries(META)) {
    // Classify per the doc's decision tree, with user_skipped moved
    // from bucket D to bucket E as documented.
    if (code === CODES.USER_SKIPPED) { buckets.E++; continue; }
    if (meta.retryable && meta.userFixable) buckets.C++;
    // bucket B (retry-after-delay) is identified by HTTP 429 — the
    // per-instance retryAfter is opts, not META, so the HTTP status is
    // the stable marker. Only rate_limited carries 429.
    else if (meta.retryable && meta.http === 429) buckets.B++;
    else if (meta.retryable) buckets.A++;
    else if (meta.userFixable) buckets.D++;
    else buckets.E++;
  }
  assert.strictEqual(buckets.A, 4, 'bucket A (retry silently)');
  assert.strictEqual(buckets.B, 1, 'bucket B (retry delayed)');
  assert.strictEqual(buckets.C, 2, 'bucket C (retry then beep)');
  assert.strictEqual(buckets.D, 7, 'bucket D (beep)');
  assert.strictEqual(buckets.E, 6, 'bucket E (skip)');
});
