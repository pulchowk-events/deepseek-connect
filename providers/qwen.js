// Qwen provider -- DOM manipulation for Qwen chat
'use strict';

// The "<token> START_<name>" / "<token> END_<name>" line protocol is parsed by
// the two-pass extractor that providers/deepseek.js exports on DSC. It is
// loaded before this file (manifest order and the re-injection list).
function getExtractor() {
  const fn = globalThis.DSC && globalThis.DSC.extractDelimited;
  return typeof fn === 'function' ? fn : null;
}

const qwenProvider = {
  name: 'qwen',
  selectors: {
    input: function() {
      return document.querySelector('textarea.message-input-textarea') || document.querySelector('textarea');
    },
    sendButton: function() {
      const wrapper = document.querySelector('.chat-message-input-fixed, .message-input-wrapper');
      if (wrapper) {
        const buttons = wrapper.querySelectorAll('button');
        for (let i = 0; i < buttons.length; i++) {
          const btn = buttons[i];
          if (visible(btn) && !btn.disabled) return btn;
        }
      }
      return document.querySelector('button.send-button') || document.querySelector('button[type="submit"]');
    },
    assistantMessages: function() {
      return Array.from(document.querySelectorAll('.qwen-chat-message.qwen-chat-message-assistant, .qwen-chat-message'));
    }
  },

  async ensureChat(name) {
    dismissAgeModal();
    const DSC = globalThis.DSC;
    const debug = { name: name, path: location.pathname };
    const input = await waitForInputReady(10000);
    if (!input) return { ok: false, error: DSC.ERR.INPUT_NOT_FOUND, reason: 'input_not_found', debug: debug };
    return { ok: true, existing: false, mode: 'fresh', debug: debug };
  },

  async sendPrompt(prompt, delimiters) {
    dismissAgeModal();

    const DSC = globalThis.DSC;
    const startedAt = Date.now();
    const trace = [];

    const T = function(phase, extra) {
      try { chrome.runtime.sendMessage({ type: 'dsc_phase', phase: phase, extra: extra }).catch(function() {}); } catch (_) {}
      trace.push(Object.assign({ t: Date.now() - startedAt, phase: phase }, extra || {}));
    };

    const fail = function(error, reason, extra) {
      return Object.assign({ error: error, reason: reason, trace: trace, elapsedMs: Date.now() - startedAt }, extra || {});
    };

    const extractor = getExtractor();
    if (!extractor) return fail(DSC.ERR.INVALID_RESPONSE_FORMAT, 'extractor_unavailable');

    const delimiterStart = (delimiters && delimiters.start) || 'START_';
    const delimiterEnd = (delimiters && delimiters.end) || 'END_';
    const enforcedPrompt = prompt + '\n\nIMPORTANT: Follow the output format above exactly, including the marker lines of the form `<token> ' + delimiterStart + '<name>` and `<token> ' + delimiterEnd + '<name>`, each on its own line. Do not add thinking, greetings, or any other text outside the marker lines.';

    T('step_1_dismiss_modal', { action: 'checking for age modal' });
    await sleep(1000); // Pace: wait for any modals to settle

    T('step_2_find_input', { action: 'locating input field' });
    const input = await waitFor(function() {
      const el = qwenProvider.selectors.input();
      return el && visible(el) && !el.disabled ? el : null;
    }, { timeout: 10000 });

    if (!input) return fail(DSC.ERR.INPUT_NOT_FOUND, 'input_not_found');
    await sleep(1000); // Pace: ensure UI is stable before typing

    T('step_3_type_prompt', { action: 'typing prompt' });
    setInputValue(input, enforcedPrompt);
    await sleep(1500); // Pace: let React register the input value

    const typedLen = readInputValue(input).length;
    T('step_4_verify_input', { promptLen: enforcedPrompt.length, typedLen: typedLen });
    if (typedLen === 0) return fail(DSC.ERR.SEND_FAILED, 'input_empty_after_set');
    await sleep(1000); // Pace: before clicking

    T('step_5_click_send', { action: 'clicking send button' });
    const sendBtn = qwenProvider.selectors.sendButton();
    if (!sendBtn) return fail(DSC.ERR.SEND_FAILED, 'send_button_not_found');

    sendBtn.click();
    const sendClickedAt = Date.now();
    T('step_6_send_clicked', { ms: sendClickedAt - startedAt });
    await sleep(1500); // Pace: wait for network request to initiate and "Thinking" to start

    const deadline = sendClickedAt + (DSC.RESPONSE_TIMEOUT_MS || 120000);
    let sawNew = false, streamUrl = null, completedBy = null;

    T('step_7_wait_for_reply', { action: 'monitoring response' });
    while (Date.now() < deadline) {
      await sleep(1000); // Pace: check every 1 second

      // Dismiss modal if it pops up mid-generation
      dismissAgeModal();

      const msgs = qwenProvider.selectors.assistantMessages();
      if (msgs.length > 0 && !sawNew) {
        sawNew = true;
        streamUrl = location.href;
        T('step_7a_first_msg', { msgs: msgs.length, url: streamUrl });
      }
      if (!sawNew) continue;

      const last = msgs[msgs.length - 1];
      const txt = (last.innerText || last.textContent || '').trim();

      // STRICT completion: a full marker-line pair must parse out of the
      // reply, AND (copy button present OR text is substantial).
      const hasCopyBtn = !!last.querySelector('button[aria-label*="copy" i], .copy-btn, [data-icon="copy"]');
      const parsedNow = extractor(txt, delimiterStart, delimiterEnd);
      const isComplete = parsedNow !== null && (hasCopyBtn || txt.length > 50);

      if (!isComplete) {
        T('step_7b_streaming', { len: txt.length, parsed: parsedNow !== null, hasCopyBtn });
        continue;
      }

      // Double-check stability
      await sleep(2000);
      const txtAfterDelay = (last.innerText || last.textContent || '').trim();
      if (extractor(txtAfterDelay, delimiterStart, delimiterEnd) !== null) {
        completedBy = 'strict_delimiters';
        break;
      }
    }

    T('step_8_reply_done', { completedBy: completedBy, sawNew: sawNew });
    if (!sawNew) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'no_new_message');
    if (!completedBy) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'completion_timeout_missing_delimiters');

    const finalMsgs = qwenProvider.selectors.assistantMessages();
    const raw = (finalMsgs.length > 0 ? (finalMsgs[finalMsgs.length - 1].innerText || '').trim() : '');
    if (!raw) return fail(DSC.ERR.RESPONSE_TIMEOUT, 'empty_response');

    // STRICT EXTRACTION: if the marker lines do not parse, REJECT.
    const content = extractor(raw, delimiterStart, delimiterEnd);
    if (content === null) {
      return fail(DSC.ERR.INVALID_RESPONSE_FORMAT, 'Model did not follow delimiter instructions', { rawPreview: raw.slice(0, 200) });
    }

    return { content: content, raw: raw, source: 'strict_delimiter', elapsedMs: Date.now() - startedAt, url: streamUrl, trace: trace };
  },

  async checkState() {
    dismissAgeModal();
    const input = qwenProvider.selectors.input();
    return { inputFound: !!input, currentChatName: document.title, loggedOut: !input };
  },

  async resetChat(name) {
    return { ok: true, reason: 'qwen_reset_not_implemented' };
  }
};

function dismissAgeModal() {
  const modal = document.querySelector('.ant-modal-container.qwen-chat-v2-modal-container');
  if (modal) {
    const continueBtn = modal.querySelector('.qwen-chat-v2-btn.qwen-chat-v2-btn-black.qwen-chat-v2-btn-xl.qwen-chat-v2-btn-block');
    if (continueBtn && continueBtn.textContent.includes('Continue')) {
      continueBtn.click();
      console.debug('[dsc:qwen] Age modal auto-dismissed');
      return true;
    }
  }
  return false;
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function waitFor(fn, opts) {
  opts = opts || {};
  const timeout = opts.timeout !== undefined ? opts.timeout : 3000;
  const interval = opts.interval !== undefined ? opts.interval : 500; // Slower polling
  const start = Date.now();
  return new Promise(function(resolve) {
    (function tick() {
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return resolve(v);
      if (Date.now() - start >= timeout) return resolve(null);
      setTimeout(tick, interval);
    })();
  });
}

function waitForInputReady(timeout) {
  return waitFor(function() {
    const el = qwenProvider.selectors.input();
    return el && visible(el) && !el.disabled ? el : null;
  }, { timeout: timeout || 10000 });
}

function setInputValue(input, text) {
  input.focus();
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

function readInputValue(input) {
  if (!input) return '';
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
  return input.textContent || '';
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

try {
  globalThis.DSC_PROVIDERS = globalThis.DSC_PROVIDERS || {};
  globalThis.DSC_PROVIDERS['qwen'] = qwenProvider;
  console.debug('[dsc:registry] qwen provider registered successfully', {
    keys: Object.keys(globalThis.DSC_PROVIDERS),
    href: location.href
  });
} catch (e) {
  console.error('[dsc:registry] Failed to register qwen provider:', e);
}
