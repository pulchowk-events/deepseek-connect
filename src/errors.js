// src/errors.js -- stable error taxonomy for deepseek-connect.
// CommonJS. Imported by src/server.js and src/client.js. The aggregator's
// batch paste loop switches on `code` and reads `retryable`/`userFixable`
// to decide whether to loop, beep, or fail. Do not add codes silently --
// every code lands here first, then PROTOCOL.md, then content/background.
//
// userFixable=true  -> something the human must do (log in, open tab, toggle).
//                      Aggregator should beep + surface the message.
// userFixable=false -> the code is at fault (DOM drift) or the caller is
//                      (bad_request). Retrying the same request wastes time.
// retryable=true    -> safe to resend the exact same request after
//                      `retryAfter` ms (default 0 unless specified).
//                      Does NOT imply userFixable.

'use strict';

const CODES = {
  // ---- Provider page (content script) ----
  DOM_DRIFT: 'dom_drift',
  INPUT_NOT_FOUND: 'input_not_found',
  DEEPTHINK_ENABLE_FAILED: 'deepthink_enable_failed',
  SEARCH_ENABLE_FAILED: 'search_enable_failed',
  CHAT_NOT_FOUND: 'chat_not_found',
  RATE_LIMITED: 'rate_limited',
  LOGGED_OUT: 'logged_out',
  RESPONSE_TIMEOUT: 'response_timeout',
  SEND_FAILED: 'send_failed',
  USER_NAVIGATED: 'user_navigated',
  INVALID_RESPONSE_FORMAT: 'invalid_response_format',
  AMBIGUOUS_PROVIDER_TAB: 'ambiguous_provider_tab',
  BOT_BLOCKED: 'bot_blocked',

  // ---- Server / transport ----
  EXTENSION_DISCONNECTED: 'extension_disconnected',
  EXTENSION_STALE: 'extension_stale',
  EXTENSION_TIMEOUT: 'extension_timeout',
  PROTOCOL_VERSION_MISMATCH: 'protocol_version_mismatch',
  VERSION_MISMATCH: 'version_mismatch',
  BAD_REQUEST: 'bad_request',
  AUTH_FAILED: 'auth_failed',
  UNKNOWN_REQUEST: 'unknown_request',
  INTERNAL_ERROR: 'internal_error',
  CANCELLED: 'cancelled',
  USER_SKIPPED: 'user_skipped',
};

const META = {
  [CODES.DOM_DRIFT]: {
    retryable: false, userFixable: false, http: 500,
    human: 'Provider page structure changed; selectors need updating.',
  },
  [CODES.INPUT_NOT_FOUND]: {
    retryable: false, userFixable: true, http: 502,
    human: 'Chat input not found. Is the work tab on a supported provider and logged in?',
  },
  [CODES.DEEPTHINK_ENABLE_FAILED]: {
    retryable: false, userFixable: true, http: 502,
    human: 'Could not enable provider feature toggle. Toggle it manually in the tab and retry.',
  },
  [CODES.SEARCH_ENABLE_FAILED]: {
    retryable: false, userFixable: true, http: 502,
    human: 'Could not enable provider search feature. Toggle it manually in the tab and retry.',
  },
  [CODES.CHAT_NOT_FOUND]: {
    retryable: false, userFixable: false, http: 404,
    human: 'Chat not found in sidebar and could not be created.',
  },
  [CODES.RATE_LIMITED]: {
    retryable: true, userFixable: false, http: 429,
    human: 'Provider rate limit hit; retry after retryAfter ms.',
  },
  [CODES.LOGGED_OUT]: {
    retryable: false, userFixable: true, http: 401,
    human: 'Not logged in to provider. Log in and retry.',
  },
  [CODES.RESPONSE_TIMEOUT]: {
    retryable: true, userFixable: true, http: 504,
    human: 'No answer within timeout; check the work tab (streaming paused?).',
  },
  [CODES.SEND_FAILED]: {
    retryable: true, userFixable: false, http: 502,
    human: 'Send click did not register; safe to retry.',
  },
  [CODES.USER_NAVIGATED]: {
    retryable: false, userFixable: true, http: 409,
    human: 'Work tab navigated mid-stream; result discarded to avoid stale read.',
  },
  [CODES.INVALID_RESPONSE_FORMAT]: {
    retryable: true, userFixable: false, http: 502,
    human: 'Model reply did not include the required delimiters. Retry may succeed; if it repeats, the prompt enforcement needs strengthening.',
  },
  [CODES.AMBIGUOUS_PROVIDER_TAB]: {
    retryable: false, userFixable: true, http: 409,
    human: 'Expected exactly one open tab for the requested provider (exact hostname match); found none or several. Close extras or open one.',
  },
  [CODES.BOT_BLOCKED]: {
    retryable: true, userFixable: true, http: 403,
    human: 'Provider showed a bot challenge (e.g. Cloudflare Turnstile) instead of the chat. Solve it in the work tab, or retry after retryAfter ms. Raised by chatgpt only.',
  },

  [CODES.EXTENSION_DISCONNECTED]: {
    retryable: true, userFixable: true, http: 409,
    human: 'Extension not connected. Load it or check EXTENSION_TOKEN.',
  },
  [CODES.EXTENSION_STALE]: {
    retryable: true, userFixable: false, http: 409,
    human: 'Extension stopped polling; will retry as soon as it reconnects.',
  },
  [CODES.EXTENSION_TIMEOUT]: {
    retryable: true, userFixable: false, http: 504,
    human: 'Extension did not respond in time; safe to retry.',
  },
  [CODES.PROTOCOL_VERSION_MISMATCH]: {
    retryable: false, userFixable: true, http: 500,
    human: 'Extension and server protocol versions differ; reload the extension.',
  },
  [CODES.VERSION_MISMATCH]: {
    retryable: false, userFixable: true, http: 409,
    human: 'Extension build hash differs from the server build hash; reload the extension and hard-reload provider tabs.',
  },
  [CODES.BAD_REQUEST]: {
    retryable: false, userFixable: false, http: 400,
    human: 'Malformed request.',
  },
  [CODES.AUTH_FAILED]: {
    retryable: false, userFixable: true, http: 401,
    human: 'Bearer token mismatch; check EXTENSION_TOKEN in .env and popup.',
  },
  [CODES.UNKNOWN_REQUEST]: {
    retryable: false, userFixable: false, http: 404,
    human: 'Request id not recognised (internal inconsistency).',
  },
  [CODES.INTERNAL_ERROR]: {
    retryable: true, userFixable: false, http: 500,
    human: 'Unexpected server error; safe to retry.',
  },
  [CODES.CANCELLED]: {
    retryable: false, userFixable: false, http: 499,
    human: 'Request cancelled by caller via POST /cancel.',
  },
  [CODES.USER_SKIPPED]: {
    retryable: false, userFixable: true, http: 499,
    human: 'Skipped via popup; user chose to skip this source.',
  },
};

class DSCError extends Error {
  constructor(code, opts) {
    opts = opts || {};
    const meta = META[code] || META[CODES.INTERNAL_ERROR];
    super(opts.reason || meta.human);
    this.name = 'DSCError';
    this.code = code;
    this.reason = opts.reason || meta.human;
    this.retryable = opts.retryable ?? meta.retryable;
    this.retryAfter = opts.retryAfter || 0;
    this.userFixable = opts.userFixable ?? meta.userFixable;
    this.http = opts.http ?? meta.http;
    this.details = opts.details || undefined;
    this.trace = opts.trace || undefined;
  }
  toJSON() {
    return {
      ok: false,
      error: this.code,
      reason: this.reason,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      userFixable: this.userFixable,
      details: this.details,
      trace: this.trace,
    };
  }
}

function isRetryable(code) {
  const m = META[code];
  return !!(m && m.retryable);
}

function isUserFixable(code) {
  const m = META[code];
  return !!(m && m.userFixable);
}

function httpStatusFor(code, fallback) {
  const m = META[code];
  return (m && m.http) || fallback || 500;
}

function fromReply(body) {
  // Turn an extension /reply { status:'error', error, reason, ... } into a
  // DSCError. Unknown codes collapse to INTERNAL_ERROR (never invent).
  const code = body && body.error && META[body.error] ? body.error : CODES.INTERNAL_ERROR;
  return new DSCError(code, {
    reason: body && body.reason,
    retryAfter: body && body.retryAfter,
    details: body && body.details,
    trace: body && body.trace,
  });
}

module.exports = {
  CODES,
  META,
  DSCError,
  isRetryable,
  isUserFixable,
  httpStatusFor,
  fromReply,
};
