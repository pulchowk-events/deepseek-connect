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

test('DSCError ignores malformed retry metadata', () => {
  const err = new DSCError(CODES.RATE_LIMITED, {
    retryable: 'false',
    retryAfter: '30000',
    userFixable: 1,
  });
  assert.strictEqual(err.retryable, true);
  assert.strictEqual(err.retryAfter, 0);
  assert.strictEqual(err.userFixable, false);
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

test('fromReply preserves per-request retry and execution metadata', () => {
  const err = fromReply({
    error: 'rate_limited',
    reason: 'dispatch outcome unknown',
    retryable: false,
    retryAfter: 30000,
    userFixable: true,
    requestId: 'rate-item-1',
    executionState: 'outcome_unknown',
  });
  assert.equal(err.retryable, false);
  assert.equal(err.retryAfter, 30000);
  assert.equal(err.userFixable, true);
  assert.equal(err.requestId, 'rate-item-1');
  assert.equal(err.executionState, 'outcome_unknown');
});
