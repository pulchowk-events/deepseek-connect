'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../shared.js');
require('../providers/chatgpt.js');
const { CODES } = require('../src/errors.js');

const provider = globalThis.DSC_PROVIDERS.chatgpt;

test('oversize prompt is rejected as bad_request / prompt_too_large before any DOM access', async () => {
  const prompt = 'x'.repeat(55001);
  const r = await provider.sendPrompt(prompt, {});
  assert.strictEqual(r.error, 'bad_request');
  assert.strictEqual(r.reason, 'prompt_too_large');
  assert.strictEqual(r.promptLen, 55001);
  assert.strictEqual(r.limit, 55000);
});

test('limits.maxPromptChars is 55000 and 55001 chars is rejected', async () => {
  assert.strictEqual(provider.limits.maxPromptChars, 55000);
  const r = await provider.sendPrompt('y'.repeat(provider.limits.maxPromptChars + 1), {});
  assert.strictEqual(r.error, 'bad_request');
});

test('tooLongRe matches both phrasings and not ordinary or rate-limit text', () => {
  const re = provider.tooLongRe;
  assert.ok(re.test('The message you submitted was too long, please reload the conversation and submit something shorter.'));
  assert.ok(re.test('The messages you submitted were too long'));
  assert.ok(!re.test('Here is a summary of your document.'));
  assert.ok(!re.test('Too many requests. You have reached the usage limit.'));
});

test('DSC.ERR.BAD_REQUEST equals errors CODES.BAD_REQUEST', () => {
  assert.strictEqual(globalThis.DSC.ERR.BAD_REQUEST, CODES.BAD_REQUEST);
});
