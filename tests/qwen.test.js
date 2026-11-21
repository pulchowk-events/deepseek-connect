'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../shared.js');
globalThis.location = { href: 'https://chat.qwen.ai/', pathname: '/' };
require('../providers/deepseek.js');
require('../providers/qwen.js');

const DSC = globalThis.DSC;
const provider = globalThis.DSC_PROVIDERS.qwen;

test('Qwen does not overwrite a non-empty composer or click send', async () => {
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
    chrome: globalThis.chrome,
    getComputedStyle: globalThis.getComputedStyle,
    fillPromptInput: DSC.fillPromptInput,
    clickSendOnce: DSC.clickSendOnce,
  };
  let clicked = false;
  const input = {
    tagName: 'TEXTAREA',
    value: 'human draft',
    disabled: false,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const send = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    click: () => { clicked = true; },
  };
  try {
    globalThis.location = { href: 'https://chat.qwen.ai/', pathname: '/' };
    globalThis.document = {
      readyState: 'complete',
      title: 'Qwen',
      querySelector(selector) {
        if (selector.indexOf('textarea') >= 0) return input;
        if (selector.indexOf('button.send-button') >= 0 || selector.indexOf('button[type="submit"]') >= 0) return send;
        return null;
      },
      querySelectorAll(selector) {
        if (selector.indexOf('qwen-chat-message-assistant') >= 0 ||
            selector.indexOf('data-message-author-role') >= 0) return [];
        return [];
      },
    };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() } };
    DSC.fillPromptInput = () => { throw new Error('must not overwrite existing input'); };
    DSC.clickSendOnce = (button) => { button.click(); return true; };

    const result = await provider.sendPrompt('new request', {}, 'request-draft');
    assert.equal(result.error, DSC.ERR.SEND_FAILED);
    assert.equal(result.reason, 'input_not_empty_before_send');
    assert.equal(input.value, 'human draft');
    assert.equal(clicked, false);
    assert.ok(result.trace.some((item) => item.phase === 'step_2a_preflight'));
    assert.equal(result.trace.some((item) => item.phase === 'step_3_type_prompt'), false);
  } finally {
    globalThis.document = saved.document;
    globalThis.location = saved.location;
    globalThis.chrome = saved.chrome;
    globalThis.getComputedStyle = saved.getComputedStyle;
    DSC.fillPromptInput = saved.fillPromptInput;
    DSC.clickSendOnce = saved.clickSendOnce;
  }
});

test('Qwen does not treat an earlier assistant reply as the current request result', async () => {
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
    chrome: globalThis.chrome,
    getComputedStyle: globalThis.getComputedStyle,
    fillPromptInput: DSC.fillPromptInput,
    readPromptInput: DSC.readPromptInput,
    clickSendOnce: DSC.clickSendOnce,
    responseTimeout: DSC.RESPONSE_TIMEOUT_MS,
  };
  const input = {
    tagName: 'TEXTAREA',
    value: '',
    disabled: false,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const send = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    click: () => { input.value = ''; },
  };
  const oldReply = {
    innerText: 'source START_file.js\nold answer\nsource END_file.js',
    textContent: 'source START_file.js\nold answer\nsource END_file.js',
    querySelector: () => ({})
  };
  try {
    globalThis.location = { href: 'https://chat.qwen.ai/', pathname: '/' };
    globalThis.document = {
      readyState: 'complete',
      querySelector(selector) {
        if (selector.indexOf('textarea') >= 0) return input;
        if (selector.indexOf('button.send-button') >= 0 || selector.indexOf('button[type="submit"]') >= 0) return send;
        return null;
      },
      querySelectorAll(selector) {
        if (selector.indexOf('qwen-chat-message-assistant') >= 0 ||
            selector.indexOf('data-message-author-role') >= 0) return [oldReply];
        return [];
      },
    };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() } };
    DSC.fillPromptInput = (el, text) => { el.value = text; return { ok: true, method: 'test' }; };
    DSC.readPromptInput = (el) => el.value;
    DSC.clickSendOnce = (button) => { button.click(); return true; };
    DSC.RESPONSE_TIMEOUT_MS = 2500;

    const result = await provider.sendPrompt('new request', {}, 'request-current');
    assert.equal(result.error, DSC.ERR.RESPONSE_TIMEOUT);
    assert.equal(result.reason, 'no_new_message');
    assert.ok(result.trace.some((item) => item.phase === 'step_6a_submit_observed'));
  } finally {
    globalThis.document = saved.document;
    globalThis.location = saved.location;
    globalThis.chrome = saved.chrome;
    globalThis.getComputedStyle = saved.getComputedStyle;
    DSC.fillPromptInput = saved.fillPromptInput;
    DSC.readPromptInput = saved.readPromptInput;
    DSC.clickSendOnce = saved.clickSendOnce;
    DSC.RESPONSE_TIMEOUT_MS = saved.responseTimeout;
  }
});
