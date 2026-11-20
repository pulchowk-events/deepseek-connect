# Error codes

`src/errors.js` is the authoritative source for the registered codes, default metadata, and HTTP statuses. This reference lists the current taxonomy. A registered code is not proof that the current server/provider path emits it; some codes remain reserved for future behavior.

Every error response has `error`, `reason`, `retryable`, `retryAfter` (milliseconds), and `userFixable`; `details` and `trace` are optional. The Node client turns recognized non-2xx error responses into `DSCError`. It does not retry automatically.

## Registered codes

| Code | `retryable` | `retryAfter` | `userFixable` | HTTP | Notes |
|---|---:|---:|---:|---:|---|
| `ambiguous_provider_tab` | no | 0 | yes | 409 | No exact provider tab, multiple matches, or explicit tab mismatch |
| `auth_failed` | no | 0 | yes | 401 | Bearer token mismatch |
| `bad_request` | no | 0 | no | 400 | Invalid or incomplete request, including missing/unknown provider |
| `bot_blocked` | yes | 30000 | yes | 403 | ChatGPT bot challenge |
| `cancelled` | no | 0 | no | 499 | Registered for caller cancellation; no `/cancel` route is currently shipped |
| `chat_not_found` | no | 0 | no | 404 | Provider could not locate the named chat |
| `deepthink_enable_failed` | no | 0 | yes | 502 | DeepSeek toggle could not be enabled |
| `dom_drift` | no | 0 | no | 500 | Required provider UI elements are missing |
| `extension_disconnected` | yes | 0 | yes | 409 | Registered transport error; do not assume `/tabs` detects it |
| `extension_stale` | yes | 0 | no | 409 | Extension stopped polling |
| `extension_timeout` | yes | 0 | no | 504 | Extension did not reply in time |
| `input_not_found` | no | 0 | yes | 502 | Provider chat input is unavailable |
| `internal_error` | yes | 0 | no | 500 | Unexpected server or unrecognized extension error |
| `invalid_response_format` | yes | 0 | no | 502 | Provider response could not be extracted as expected |
| `logged_out` | no | 0 | yes | 401 | Provider session requires login |
| `protocol_version_mismatch` | no | 0 | yes | 500 | Registered compatibility error |
| `rate_limited` | yes | 30000 | no | 429 | Provider rate limit |
| `response_timeout` | yes | 0 | yes | 504 | Provider reply did not complete before timeout |
| `search_enable_failed` | no | 0 | yes | 502 | DeepSeek Search toggle could not be enabled |
| `send_failed` | yes | 0 | no | 502 | Prompt submission did not register |
| `unknown_request` | no | 0 | no | 404 | Unknown request ID |
| `user_navigated` | no | 0 | yes | 409 | Provider tab URL changed during a reply |
| `user_skipped` | no | 0 | yes | 499 | Registered for a user skip action |
| `version_mismatch` | no | 0 | yes | 409 | Extension build hash differs from server |

`retryAfter` on provider rate-limit and challenge errors is 30000 milliseconds. Follow the actual returned metadata rather than hardcoding retries based only on the code. A client timeout does not cancel the server's queued/in-flight request.

## Provider routing errors

Provider selection is mandatory for `/chat`, `/open`, and `/reset`. The built-in routable providers are `deepseek`, `qwen`, and `chatgpt`; configured providers must be enabled in the extension. `tongyi` is not routable. The server rejects a missing or unknown name with `bad_request`.

The extension requires exactly one tab matching the requested provider's exact hostname. No match, multiple matches, or a `targetTabId` for a different provider returns `ambiguous_provider_tab`. There is no sticky-tab fallback. `/tabs` is a cached snapshot from the last `/hello`, not a live health/readiness probe.

`no_work_tab` and `no_provider_loaded` are not registered public error codes. Unknown extension codes are normalized to `internal_error` by the client. If a provider fails to register, check its config/registration and extension console rather than branching on an invented error code.

## Handling errors

- Retry only when `retryable` is true, and wait `retryAfter` milliseconds first when nonzero. Bound retries to avoid loops.
- Surface `userFixable` errors with their `reason`; the caller cannot make progress until the user or environment changes.
- Do not treat `userFixable` as the inverse of `retryable`; both may be true (for example `response_timeout` and `bot_blocked`).
- Treat unrecognized errors as failures and preserve `reason`, `details`, and `trace` for diagnosis.
- Provider pivot (for example, retrying on Qwen after a DeepSeek rate limit) is caller policy, not an API feature.

For exact HTTP request and response shapes, see [protocol.md](protocol.md). For operational troubleshooting, see [operations.md](operations.md).
