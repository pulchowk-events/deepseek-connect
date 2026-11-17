'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rate, compounds } = require('../picker.js');

const R = 'recommended';
const M = 'might-break';
const W = 'will-break';

test('picker rate: a stable id is recommended', () => {
  assert.strictEqual(rate('#chat-input').rating, R);
});

test('picker rate: an aria-label is recommended', () => {
  assert.strictEqual(rate('button[aria-label="Send Message"]').rating, R);
});

test('picker rate: a stable data-* attribute is recommended', () => {
  assert.strictEqual(rate('div[data-testid="msg-list"]').rating, R);
});

test('picker rate: Tailwind-only classes might break (div.group)', () => {
  assert.strictEqual(rate('div.group').rating, M);
  assert.strictEqual(rate('div.flex.items-center').rating, M);
});

test('picker rate: a volatile data-* attribute might break', () => {
  const r = rate('div[data-state="open"]');
  assert.strictEqual(r.rating, M);
  assert.match(r.reason, /data-state/);
});

test('picker rate: a chain more than 2 levels deep might break', () => {
  const r = rate('main > section.chat > div.thread');
  assert.strictEqual(r.rating, M);
  assert.match(r.reason, /3-level/);
  assert.strictEqual(rate('section.chat > div.thread').rating, R);
});

test('picker rate: any nth-of-type chain will break', () => {
  assert.strictEqual(rate('div:nth-of-type(2) > div').rating, W);
  assert.strictEqual(rate('body > div:nth-of-type(1) > div:nth-of-type(3)').rating, W);
});

test('picker rate: uuid-like and generated ids will break', () => {
  assert.strictEqual(rate('div[data-id="123e4567-e89b-12d3-a456-426614174000"]').rating, W);
  assert.strictEqual(rate('#\\:r1\\:').rating, W);
});

test('picker rate: a 6+ hex run with a digit will break, a plain word does not', () => {
  assert.strictEqual(rate('div.css-1a2b3c4').rating, W);
  assert.strictEqual(rate('div.feedback').rating, R);
});

test('picker rate: a named, non-utility class is recommended', () => {
  assert.strictEqual(rate('div.chat-message').rating, R);
});

test('picker rate: the worst rating wins', () => {
  assert.strictEqual(rate('button[aria-label="Send"]:nth-of-type(2)').rating, W);
  assert.strictEqual(rate('main > section.chat > div[data-state="open"]').rating, M);
});

test('picker compounds: splits on top-level combinators only', () => {
  assert.deepStrictEqual(compounds('main > a[title="x > y"]'), ['main', 'a[title="x > y"]']);
  assert.deepStrictEqual(compounds('div:not(.a .b) span'), ['div:not(.a .b)', 'span']);
  assert.strictEqual(compounds('div.a').length, 1);
});
