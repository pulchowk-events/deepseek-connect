// shared.js — constants and shapes used by both background.js (service worker)
// and content.js (content script). Multi-provider aware. Must be a classic script: no ESM, no CJS.
// Both contexts get `globalThis.DSC`.

(function () {
  'use strict';

  const DSC = {
    VERSION: '0.2.0',

    STORAGE: {
      TOKEN: 'dsc_token',
      PORT: 'dsc_port',
    },

    DEFAULT_PORT: 7331,

    // PROVIDER_DOMAINS — single source of truth for URL -> provider mapping.
    // background.js uses this to pick the correct tab per request. Adding a
    // provider means adding one line here, plus the manifest entry and the
    // provider file itself. Nothing else.
    PROVIDER_DOMAINS: {
      deepseek: 'https://chat.deepseek.com/',
      qwen: 'https://chat.qwen.ai/',
      tongyi: 'https://tongyi.aliyun.com/',
    },

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
      SEARCH_ENABLE_FAILED: 'search_enable_failed',
      CHAT_NOT_FOUND: 'chat_not_found',
      RATE_LIMITED: 'rate_limited',
      LOGGED_OUT: 'logged_out',
      RESPONSE_TIMEOUT: 'response_timeout',
      SEND_FAILED: 'send_failed',
      INVALID_RESPONSE_FORMAT: 'invalid_response_format',
    },

    DELIMITER_RE: /^[ \t]*(\S+)[ \t]+START_(\S+)[ \t]*$([\s\S]*?)^[ \t]*\1[ \t]+END_\2[ \t]*$/m,

    FENCE_JS_RE: /```(?:js|javascript)\s*\n([\s\S]*?)```/g,
  };

  // Provider name from a URL, or null if the URL isn't a supported
  // provider (mock fixture counts as deepseek). Used by background.js
  // when reporting tabs and picking a work tab.
  DSC.providerForUrl = function providerForUrl(url) {
    url = url || '';
    for (const [name, prefix] of Object.entries(DSC.PROVIDER_DOMAINS)) {
      if (url.startsWith(prefix)) return name;
    }
    if (/^file:\/\/.*mock-deepseek\.html/.test(url)) return 'deepseek';
    return null;
  };

  // PROVIDER CONTRACT — a provider module must register itself as:
  //
  //   globalThis.DSC_PROVIDERS['<name>'] = {
  //     name: '<name>',
  //     ensureChat(name)           -> { ok, existing?, mode?, debug? }
  //     sendPrompt(prompt, delims) -> { content, raw, url?, source?, trace }
  //     checkState()               -> { inputFound, currentChatName? }
  //     resetChat(name)            -> { ok, reason? }
  //   }
  //
  // And must be added to:
  //   1. manifest.json content_scripts.js (loaded before content.js)
  //   2. background.js sendToTab re-injection files list
  //   3. shared.js DSC.PROVIDER_DOMAINS (above)
  //
  // Nothing else needs to change. content.js routes blindly; server.js and
  // client.js thread the provider string through without interpreting it.

  globalThis.DSC = DSC;
})();
