// shared.js -- constants and shapes used by both background.js (service worker)
// and content.js (content script). Multi-provider aware. Must be a classic script: no ESM, no CJS.
// Both contexts get `globalThis.DSC`.
//
// The server reads the build stamp below straight from this file (regex), so
// keep the stamp on a single line in the form KEY: 'value'. Bump it on every
// change to extension code; extension and server compare it on /hello.

(function () {
  'use strict';

  const DSC = {
    VERSION: '0.2.0',

    BUILD_HASH: 'p2-auto-reload-20261117a',

    STORAGE: {
      TOKEN: 'dsc_token',
      PORT: 'dsc_port',
    },

    DEFAULT_PORT: 7331,

    // Providers that have a registered module. tongyi has a domain below but
    // no module, so it is not routable.
    ROUTABLE_PROVIDERS: ['deepseek', 'qwen'],

    // PROVIDER_HOSTS -- exact hostname per provider. Matching is hostname
    // equality on a parsed URL, never a string prefix.
    PROVIDER_HOSTS: {
      deepseek: 'chat.deepseek.com',
      qwen: 'chat.qwen.ai',
      tongyi: 'tongyi.aliyun.com',
    },

    // PROVIDER_DOMAINS -- origin (with trailing slash) used for navigation.
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
      AMBIGUOUS_PROVIDER_TAB: 'ambiguous_provider_tab',
      VERSION_MISMATCH: 'version_mismatch',
      BAD_REQUEST: 'bad_request',
    },

    DELIMITER_RE: /^[ \t]*(\S+)[ \t]+START_(\S+)[ \t]*$([\s\S]*?)^[ \t]*\1[ \t]+END_\2[ \t]*$/m,

    FENCE_JS_RE: /```(?:js|javascript)\s*\n([\s\S]*?)```/g,
  };

  // Lowercased hostname of a URL, or null if it does not parse.
  DSC.hostnameOf = function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return null;
    }
  };

  // Provider name from a URL, or null if the URL is not a supported
  // provider. https + exact hostname equality. The mock fixture counts as
  // deepseek.
  DSC.providerForUrl = function providerForUrl(url) {
    url = url || '';
    let u = null;
    try { u = new URL(url); } catch (_) { u = null; }
    if (u && u.protocol === 'https:') {
      const host = u.hostname.toLowerCase();
      for (const [name, h] of Object.entries(DSC.PROVIDER_HOSTS)) {
        if (host === h) return name;
      }
    }
    if (/^file:\/\/.*mock-deepseek\.html/.test(url)) return 'deepseek';
    return null;
  };

  // True when `url` belongs to exactly this provider (exact hostname).
  DSC.tabMatchesProvider = function tabMatchesProvider(url, provider) {
    return !!provider && DSC.providerForUrl(url) === provider;
  };

  // PROVIDER CONTRACT -- a provider module must register itself as:
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
  //   3. shared.js PROVIDER_HOSTS + PROVIDER_DOMAINS (above), plus
  //      ROUTABLE_PROVIDERS here and KNOWN_PROVIDERS in src/server.js
  //
  // content.js routes blindly (and requires msg.provider); server.js and
  // client.js thread the provider string through and refuse when it is missing.

  globalThis.DSC = DSC;
})();
