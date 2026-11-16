// shared.js — constants and shapes used by both background.js (service worker)
// and content.js (content script). Must be a classic script: no ESM, no CJS.
// Both contexts get `globalThis.DSC`.

(function () {
  'use strict';

  const DSC = {
    VERSION: '0.1.0',

    STORAGE: {
      TOKEN: 'dsc_token',
      PORT: 'dsc_port',
    },

    DEFAULT_PORT: 7331,

    LONG_POLL_MS: 30000,

    RECONNECT_BACKOFF_MS: [1000, 2000, 5000, 10000],

    RESPONSE_TIMEOUT_MS: 90000,

    MSG: {
      ENSURE_CHAT: 'ensureChat',
      SEND_PROMPT: 'sendPrompt',
      CHECK_STATE: 'checkState',
      RESET_CHAT: 'resetChat',
    },

    ERR: {
      DOM_DRIFT: 'dom_drift',
      INPUT_NOT_FOUND: 'input_not_found',
      DEEPTHINK_ENABLE_FAILED: 'deepthink_enable_failed',
      DEEPTHINK_OFF: 'deepthink_off',
      SEARCH_ENABLE_FAILED: 'search_enable_failed',
      CHAT_NOT_FOUND: 'chat_not_found',
      RATE_LIMITED: 'rate_limited',
      LOGGED_OUT: 'logged_out',
      RESPONSE_TIMEOUT: 'response_timeout',
      SEND_FAILED: 'send_failed',
    },

    DELIMITER_RE: /^[ \t]*(\S+)[ \t]+START_(\S+)[ \t]*$([\s\S]*?)^[ \t]*\1[ \t]+END_\2[ \t]*$/m,

    FENCE_JS_RE: /```(?:js|javascript)\s*\n([\s\S]*?)```/g,
  };

  globalThis.DSC = DSC;
})();
