# Support

Where to get help with `deepseek-connect`. Choose the channel that matches what you need.

## I have a question about how to use it

Open a [GitHub Discussion](https://github.com/pulchowk-events/deepseek-connect/discussions). This is the right place for "how do I...", "can I...", and "should I...". Discussions are searchable — check if your question has already been answered before starting a new thread.

Before posting, skim these docs — most questions are already answered:

- [Getting started](docs/getting-started.md) — install and first round-trip
- [Protocol](docs/protocol.md) — every route and its request/response shape
- [Error codes](docs/error-codes.md) — what each `DSCError` means and what to do
- [Operations](docs/operations.md) — symptom-indexed troubleshooting
- [Selector maintenance](docs/selector-maintenance.md) — when DeepSeek's UI breaks

## I found a bug

Open a [GitHub Issue](https://github.com/pulchowk-events/deepseek-connect/issues/new/choose) using the bug report template. Include:

- The version (`0.1.0` at the time of writing — check `manifest.json`)
- Your OS and browser version
- The exact request you sent (curl or the client's method call)
- The full server log around the failure, including the `~ <id8> <phase>` lines
- The `trace` array from the `/chat` response, if it's in the response body
- What you expected vs what you got

The `trace` array is the single most useful piece of information. It tells us which phase the content script reached before it failed. Without it, the first response is always "please send the trace."

## I want to request a feature

Open a [GitHub Discussion](https://github.com/pulchowk-events/deepseek-connect/discussions) in the "Ideas" category. Explain:

- The problem you're trying to solve (the use case, not the solution)
- Why the current API doesn't solve it
- What you'd expect the fix to look like, if you have an idea

Feature requests are considered against three criteria: does the current design allow it without breaking a load-bearing decision (see [docs/architecture.md](docs/architecture.md)), is it in scope for a small browser-automation tool (not "add an API key path" — that's a different product), and is there a caller who actually needs it (not "it'd be nice").

## I found a security vulnerability

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for the private disclosure process.

## I want to contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, conventions, and the PR checklist. The docs in [docs/](docs/) cover the architecture in depth — read [docs/architecture.md](docs/architecture.md) before proposing a change that touches the queue, the selector strategy, or the chat lifecycle.

## I want to run this for my own project

Fork it. The MIT license allows it. The `docs/` directory is written so that a fresh LLM can read [docs/protocol.md](docs/protocol.md), [docs/error-codes.md](docs/error-codes.md), and [docs/integration-guide.md](docs/integration-guide.md) and build an integration without ever touching this codebase.

One thing to know before you fork: the tool exists to solve a specific problem — automating DeepSeek round-trips for a batch scraper. It's not a general-purpose "make DeepSeek an API" library. If your use case is different, the design decisions in [docs/architecture.md](docs/architecture.md) may not fit. Read them before assuming the tool will work for you.

## What's not supported

- **Puppeteer or headless browser requests.** The whole point of the design is that it drives a real Chrome tab. See [architecture.md#2-real-chrome-over-puppeteer](docs/architecture.md#2-real-chrome-over-puppeteer). If you need Puppeteer, the answer is a different tool.
- **Firefox support.** The extension uses MV3's `background.service_worker`, which Firefox handles differently. Making it work on Firefox is a separate port with separate testing, not a config change.
- **Multi-user, multi-account, or shared-server deployments.** One extension, one Chrome profile, one DeepSeek account. See [docs/protocol.md#constraints](docs/protocol.md#constraints).
- **OpenAI-compatible API shims.** The `/chat` API is deliberately minimal — `{ messages } → { content }`. If you want OpenAI compatibility, wrap it in your caller; the server won't grow that surface.

---

