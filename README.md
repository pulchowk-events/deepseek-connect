# deepseek-connect

A Chromium extension and a Node server that drive a real logged-in DeepSeek chat tab over a local HTTP API — so any caller can use DeepSeek as a free LLM endpoint without clipboard round-trips, Puppeteer fingerprinting, or credential handling.

**Contents**
- [What this is](#what-this-is)
- [Why it exists](#why-it-exists)
- [Quickstart](#quickstart)
- [What you get](#what-you-get)
- [Documentation](#documentation)
- [Status](#status)
- [Constraints](#constraints)
- [License](#license)

---

## What this is

Two pieces, one protocol:

1. **A load-unpacked Chromium extension** (Manifest V3, plain JavaScript, no build step) that lives in the user's real Brave/Chrome profile, finds the DeepSeek input box on a real `chat.deepseek.com` tab, types a prompt, clicks send, waits for the answer to finish streaming, and reads the reply back out.
2. **A Node HTTP server** on `127.0.0.1:<port>` that the extension polls. Callers send `POST /chat` with messages; the server queues the request, the extension drives the browser, the reply comes back as `{ content, chat, elapsedMs }`.

The extension is the client of the server. The server is the client of the extension. HTTP long-poll sits between them because the flow is strictly alternating and the tab is single-threaded anyway — no WebSockets, no sockets, no build step, no shared state file, no credential storage. Each side stays in its lane.

## Why it exists

Two problems, one tool:

**Problem 1: clipboard round-trips don't scale.** The Pulchowk Events Aggregator's `batch paste` wizard onboards dozens of job sources at once. Each source needs an LLM prompt dumped to the clipboard, pasted into a DeepSeek chat, and the reply copy-pasted back. For a 76-source batch, that's roughly 80 minutes of pure clipboard work per run. It is also error-prone in exactly one way — the wrong-clipboard-copy bug, where a previous site's reply gets pasted into the next site's prompt file, has caught real mistakes in every multi-site batch ever run.

**Problem 2: Puppeteer triggers DeepSeek's fingerprinting.** DeepSeek rate-limits headless and stealth-patched browser sessions aggressively, and real auth cookies are hard to keep alive in a fresh profile. Driving the user's already-logged-in real Chrome tab sidesteps both — the browser is the same browser the user browses in, the cookies are the user's cookies, and the fingerprint is a real fingerprint because it is a real browser. No credential handling, no login flows, no API keys.

`deepseek-connect` replaces the clipboard loop with a fully automated round-trip. The wizard sends a prompt, the extension drives the tab, the reply comes back as JSON. Zero-touch, same LLM, same conversation state.

## Quickstart

**Prerequisites:** Node 22, Brave or Chrome, a logged-in DeepSeek account in that browser.

**1. Start the server:**

```bash
git clone https://github.com/pulchowk-events/deepseek-connect.git
cd deepseek-connect
cp .env.example .env          # then set EXTENSION_TOKEN to any long random string
node --env-file=.env src/server.js
```

The server prints `listening on 127.0.0.1:7331` and waits for the extension.

**2. Load the extension:**

- Open `brave://extensions` (or `chrome://extensions`)
- Enable **Developer mode** (top right)
- Click **Load unpacked** → select the `deepseek-connect/` directory
- Click the extension icon → paste the same `EXTENSION_TOKEN` from `.env`, plus the port (`7331` by default) → **Save**
- Open one tab to `https://chat.deepseek.com/` and leave it open

The extension registers with the server. The server terminal should now show:

```
[HH:MM:SS] extension connected (0.1.0) | https://chat.deepseek.com/ | 1 tab(s)
```

**3. Send a prompt:**

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: hello"}],"chat":"quickstart"}' \
  | python3 -m json.tool
```

You get back:

```json
{
  "content": "hello",
  "chat": "quickstart",
  "elapsedMs": 4300
}
```

The work tab's URL changed to a chat slug, the prompt was typed into it, and the assistant's reply was extracted and returned. DeepThink and Search were verified on before the send; if either wasn't, the request would have failed with a structured error rather than quietly producing lower-quality output.

## What you get

**From the HTTP API:**

| Route | What it does |
|---|---|
| `POST /chat` | Send `{ messages, chat? }`, receive `{ content, chat, elapsedMs }`. The main entry point. |
| `POST /open` | Find-or-create a chat by name. Returns `{ existing, mode, debug }`. Used by the wizard before each source. |
| `POST /reset` | Reset a chat's state. Currently a no-op alias for `/open` — DeepSeek's delete UI is fragile. |
| `GET /tabs` | Snapshot of `chat.deepseek.com` tabs currently open. |
| `GET /next` | Extension long-poll. Not for callers. |
| `POST /reply` | Extension's reply-to-server. Not for callers. |
| `POST /progress` | Extension's live phase telemetry. Not for callers. |
| `POST /hello` | Extension's registration. Not for callers. |

**From the Node package:**

```js
const { createServer } = require('deepseek-connect');
const { createClient } = require('deepseek-connect/client');
const { CODES, DSCError } = require('deepseek-connect/errors');

const server = createServer({ token, port: 0 });  // 0 = OS-assigned
await server.start();
const dc = createClient({ token, port: server.port() });

try {
  const { content } = await dc.chat({
    messages: [{ role: 'user', content: 'Say hi' }],
    chat: 'my-chat',
  });
  console.log(content);
} finally {
  await server.stop();
}
```

Errors thrown by the client are `DSCError` instances carrying `{ code, reason, retryable, retryAfter, userFixable, details }`. See [docs/error-codes.md](docs/error-codes.md) for the full 20-code table and the decision rule for each.

## Documentation

| Doc | Read it when |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | First time setting up the extension; want a guided tutorial instead of a quickstart |
| [docs/protocol.md](docs/protocol.md) | Writing an integrator or a client for the HTTP API — every route, request shape, response shape, error shape |
| [docs/error-codes.md](docs/error-codes.md) | Handling a `DSCError` — the full taxonomy, which codes are retryable, which require the user to fix something |
| [docs/integration-guide.md](docs/integration-guide.md) | Integrating deepseek-connect into a batch wizard or another consumer — lifecycle blueprint, batch loop, per-code error policy |
| [docs/architecture.md](docs/architecture.md) | Understanding why the system is shaped this way — long-poll vs WebSockets, real Chrome vs Puppeteer, one chat per source, sticky tab |
| [docs/operations.md](docs/operations.md) | Running this day-to-day — reloading the extension after a code change, reading the trace log, recovering from `logged_out` or `extension_disconnected` |
| [docs/selector-maintenance.md](docs/selector-maintenance.md) | A DeepSeek DOM change broke extraction — per-selector fallbacks, the structural-walk strategy, the diagnostic snippet |
| [docs/adr/](docs/adr/) | Understanding a specific load-bearing decision — seven ADRs cover the non-obvious choices |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Opening a PR — build, test, branch, commit conventions |

## Status

`v0.1` — functional end-to-end against real `chat.deepseek.com` as of November 2026.

**Working:**

- Real DeepSeek round-trip: type, send, wait for answer (skipping reasoning), extract between delimiters or fall back to last code fence or raw text
- DeepThink + Search auto-enable with hard-fail if either can't be verified on
- Per-source chat lifecycle: `/open { chatName }` finds an existing chat via sidebar fuzzy match, or navigates to `/` for a fresh one
- Retry path clicks the sidebar item so the LLM sees its own prior turns
- Sticky work tab — one tab pinned in `chrome.storage`, survives focus switches and mid-run user clicks
- Queue serialization — concurrent `/chat` calls dispatch one at a time, each in its own chat
- Live progress stream — every content-script phase forwards to the server log while the request is still running
- Navigation guard — aborts with `user_navigated` if the work tab URL changes mid-stream
- 20-code error taxonomy with `retryable` / `userFixable` / `retryAfter` metadata
- `createServer` / `createClient` / `DSCError` exported for direct `require()`

**Not yet shipped (follow-up work):**

- Aggregator `--extension` flag — the consumer that this repo was built for
- Wizard error beeps + needs-review skip — the aggregator side of the failure policy
- Playwright e2e test (`tests/e2e.test.js`) — slow, run on release only
- Automatic `/reset` — DeepSeek's delete UI is fragile; current `/reset` behaves like `/open`

## Constraints

**One work tab, one wizard at a time.** The extension pins exactly one `chat.deepseek.com` tab and registers with exactly one server token. Two servers running simultaneously against the same browser profile would fight over `/next` polling; the extension only polls one endpoint. The intended deployment is one server + one extension + one browser profile, driving a single batch run at a time. This is a design consequence, not a limitation to engineer around.

**DeepSeek's DOM is not stable.** Class names are build-hashed (`c08e6e93`, `_7b40dad` — these change on every deploy). The extension resolves selectors through `src/selectors.js` with fallback tiers, and the primary anchors are structural (text content, element shape, `aria-` attributes) rather than class names. When DeepSeek redesigns, [docs/selector-maintenance.md](docs/selector-maintenance.md) is the recovery playbook.

**Extension code changes require a reload.** Reloading the unpacked extension does **not** re-inject content scripts into already-open tabs. After any change to `content.js`, `selectors.js`, or `shared.js`, the work tab must be hard-reloaded (`Ctrl+Shift+R`) for the new code to take effect. This is the single most common "my fix didn't work" mistake — see [docs/operations.md#reload-discipline](docs/operations.md#reload-discipline).

**No build step, by design.** Plain JavaScript, load-unpacked. `manifest.json` loads `shared.js → selectors.js → content.js` in that order; `background.js` uses `importScripts('shared.js')`. If a file grows past ~800 lines, refactor into modules with `import` — but no bundler, no webpack, no vite.

## License

MIT. See [LICENSE](LICENSE).