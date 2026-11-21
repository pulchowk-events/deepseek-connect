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
      return Array.from(document.querySelectorAll(
        '.qwen-chat-message.qwen-chat-message-assistant, [data-message-author-role="assistant"]'
      ));
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

  async sendPrompt(prompt, delimiters, requestId) {
    dismissAgeModal();

    const DSC = globalThis.DSC;
    const startedAt = Date.now();
    const initialUrl = location.href;
    const trace = [];

    const T = function(phase, extra) {
      try { chrome.runtime.sendMessage({ type: 'dsc_phase', requestId: requestId, phase: phase, extra: extra }).catch(function() {}); } catch (_) {}
      trace.push(Object.assign({ t: Date.now() - startedAt, phase: phase }, extra || {}));
    };

    const fail = function(error, reason, extra) {
      return Object.assign({ error: error, reason: reason, trace: trace, elapsedMs: Date.now() - startedAt }, extra || {});
    };

    T('pageReady', { checking: true });
    const pageReady = await DSC.waitForPageStable(15000, DSC.STAGE_DELAY_MS);
    T('pageReady', { ready: pageReady.ok, readyState: pageReady.readyState });
    if (!pageReady.ok) return fail(DSC.ERR.INPUT_NOT_FOUND, 'page_not_stable', { details: pageReady });

    const extractor = getExtractor();
    if (!extractor) return fail(DSC.ERR.INVALID_RESPONSE_FORMAT, 'extractor_unavailable');

    const delimiterStart = (delimiters && delimiters.start) || 'START_';
    const delimiterEnd = (delimiters && delimiters.end) || 'END_';
    const enforcedPrompt = prompt + '\n\nIMPORTANT: Follow the output format above exactly, including the marker lines of the form `<token> ' + delimiterStart + '<name>` and `<token> ' + delimiterEnd + '<name>`, each on its own line. Do not add thinking, greetings, or any other text outside the marker lines.';

    T('step_1_dismiss_modal', { action: 'checking for age modal' });
    await sleep(150);

    T('step_2_find_input', { action: 'locating input field' });
    const input = await waitFor(function() {
      const el = qwenProvider.selectors.input();
      return el && visible(el) && !el.disabled ? el : null;
    }, { timeout: 10000 });

    if (!input) return fail(DSC.ERR.INPUT_NOT_FOUND, 'input_not_found');
    const initialAssistantCount = qwenProvider.selectors.assistantMessages().length;
    let idleSince = 0;
    let responseSignature = null;
    const preflight = await waitFor(function() {
      const current = qwenProvider.selectors.input();
      const generating = findGenerationControl();
      const messages = qwenProvider.selectors.assistantMessages();
      const lastText = messages.length ? (messages[messages.length - 1].textContent || '').trim() : '';
      const signature = messages.length + ':' + lastText.length + ':' +
        lastText.slice(0, 60) + ':' + lastText.slice(-60);
      if (responseSignature !== signature) {
        responseSignature = signature;
        idleSince = 0;
        return null;
      }
      if (!current || !visible(current) || current.disabled || generating) {
        idleSince = 0;
        return null;
      }
      if (!idleSince) idleSince = Date.now();
      return Date.now() - idleSince >= DSC.STAGE_DELAY_MS
        ? { input: current, generating: false, responseStable: true } : null;
    }, { timeout: 15000, interval: 200 });
    const inputEmpty = !!preflight && readInputValue(preflight.input).trim() === '';
    T('step_2a_preflight', {
      ready: !!preflight && inputEmpty,
      readyState: document.readyState,
      inputEmpty: inputEmpty,
      generating: !!findGenerationControl(),
      assistantCount: initialAssistantCount,
    });
    if (!preflight || !inputEmpty) {
      return fail(DSC.ERR.SEND_FAILED, preflight ? 'input_not_empty_before_send' : 'provider_busy_or_not_ready', {
        details: {
          inputEmpty: !!preflight && inputEmpty,
          generating: !!findGenerationControl(),
          recovery: preflight
            ? 'The existing composer was left untouched; review or clear it manually before retrying.'
            : 'Wait for the provider page and any active response to settle, then inspect the tab before retrying.',
        },
      });
    }
    await sleep(DSC.STAGE_DELAY_MS);

    T('step_3_type_prompt', { action: 'typing prompt' });
    const pageUrlBeforeSend = location.href;
    const currentInput = qwenProvider.selectors.input();
    if (!currentInput || readInputValue(currentInput).trim() !== '' || findGenerationControl()) {
      return fail(DSC.ERR.SEND_FAILED, 'pre_paste_state_changed', {
        inputFound: !!currentInput,
        inputEmpty: !!currentInput && readInputValue(currentInput).trim() === '',
        generating: !!findGenerationControl(),
      });
    }
    const filled = setInputValue(currentInput, enforcedPrompt);
    await sleep(DSC.STAGE_DELAY_MS);

    const typedLen = readInputValue(currentInput).length;
    T('step_4_verify_input', { promptLen: enforcedPrompt.length, typedLen: typedLen });
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_after_input', { inputRetained: typedLen > 0 });
    }
    if (!filled.ok || typedLen !== enforcedPrompt.length) return fail(DSC.ERR.SEND_FAILED, 'input_not_set');

    T('step_5_click_send', { action: 'clicking send button' });
    const sendBtn = await waitFor(function() {
      const el = qwenProvider.selectors.sendButton();
      return el && visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' ? el : null;
    }, { timeout: 10000, interval: 100 });
    if (!sendBtn) return fail(DSC.ERR.SEND_FAILED, 'send_button_not_found');
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }

    if (findGenerationControl() || readInputValue(currentInput) !== enforcedPrompt ||
        currentInput.isConnected === false) {
      return fail(DSC.ERR.SEND_FAILED, 'pre_send_state_changed', {
        inputMatchesPrompt: readInputValue(currentInput) === enforcedPrompt,
        generating: !!findGenerationControl(),
      });
    }
    await sleep(DSC.STAGE_DELAY_MS);
    const stableSendBtn = qwenProvider.selectors.sendButton();
    if (location.href !== pageUrlBeforeSend) {
      return fail(DSC.ERR.USER_NAVIGATED, 'page_changed_before_send', { inputRetained: true });
    }
    if (!stableSendBtn || !visible(stableSendBtn) || stableSendBtn.disabled ||
        stableSendBtn.getAttribute('aria-disabled') === 'true' ||
        findGenerationControl() || readInputValue(currentInput) !== enforcedPrompt) {
      return fail(DSC.ERR.SEND_FAILED, 'send_control_not_stable', {
        sendReady: !!stableSendBtn && !stableSendBtn.disabled,
        generating: !!findGenerationControl(),
        inputMatchesPrompt: readInputValue(currentInput) === enforcedPrompt,
      });
    }
    if (!DSC.clickSendOnce(stableSendBtn)) return fail(DSC.ERR.SEND_FAILED, 'send_button_disabled');
    const sendClickedAt = Date.now();
    T('step_6_send_clicked', { ms: sendClickedAt - startedAt });
    const submission = await waitFor(function() {
      const postClickInput = qwenProvider.selectors.input();
      const assistantCount = qwenProvider.selectors.assistantMessages().length;
      const state = {
        inputCleared: !!postClickInput && readInputValue(postClickInput).trim() === '',
        generating: !!findGenerationControl(),
        assistantCount: assistantCount,
      };
      return state.inputCleared || state.generating || assistantCount > initialAssistantCount ? state : null;
    }, { timeout: 15000, interval: 200 });
    T('step_6a_submit_observed', Object.assign({ accepted: !!submission }, submission || {
      inputCleared: false,
      generating: false,
      assistantCount: qwenProvider.selectors.assistantMessages().length,
    }));
    if (!submission) {
      return fail(DSC.ERR.SEND_FAILED, 'send_not_registered', {
        inputRetained: readInputValue(qwenProvider.selectors.input()).length > 0,
        details: { recovery: 'The send click was issued but UI acceptance was not observed; inspect the provider tab before retrying.' },
      });
    }

    const deadline = sendClickedAt + (DSC.RESPONSE_TIMEOUT_MS || 120000);
    let sawNew = false, streamUrl = null, completedBy = null;

    T('step_7_wait_for_reply', { action: 'monitoring response' });
    while (Date.now() < deadline) {
      await sleep(500);

      // Dismiss modal if it pops up mid-generation
      dismissAgeModal();

      const msgs = qwenProvider.selectors.assistantMessages();
      if (msgs.length > initialAssistantCount && !sawNew) {
        sawNew = true;
        streamUrl = location.href;
        if (initialUrl !== streamUrl && !isRootToChat(initialUrl, streamUrl)) {
          return fail(DSC.ERR.USER_NAVIGATED, 'user_navigated', {
            expected: initialUrl, actual: streamUrl,
          });
        }
        T('step_7a_first_msg', { msgs: msgs.length, url: streamUrl });
      }
      if (!sawNew) continue;
      if (location.href !== streamUrl) {
        return fail(DSC.ERR.USER_NAVIGATED, 'user_navigated', {
          expected: streamUrl, actual: location.href,
        });
      }

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

function isRootToChat(from, to) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    return a.origin === b.origin && (a.pathname === '/' || a.pathname === '') &&
      b.pathname !== '/' && b.pathname !== '';
  } catch (_) {
    return false;
  }
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function findGenerationControl() {
  const controls = document.querySelectorAll('button, [role="button"]');
  for (let i = 0; i < controls.length; i++) {
    const el = controls[i];
    if (!visible(el)) continue;
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.textContent
    ].filter(Boolean).join(' ');
    if (/\bstop(?:\s+generating)?\b/i.test(label)) return el;
  }
  return null;
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
  return globalThis.DSC.fillPromptInput(input, text);
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
