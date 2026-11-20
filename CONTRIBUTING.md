# Contributing to deepseek-connect

Thanks for contributing. This doc covers the practical bits — setup, workflow, conventions, what gets a PR merged. Read it before opening a PR; it's shorter than debugging a rejection.

If you're here to fix a DeepSeek DOM change that broke extraction, skip ahead to [Changing selectors](#changing-selectors) — that's the recovery playbook, and it's the most common contribution to this repo.

**Contents**
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Project layout](#project-layout)
- [Development workflow](#development-workflow)
- [Branch and commit conventions](#branch-and-commit-conventions)
- [Testing](#testing)
- [Changing selectors](#changing-selectors)
- [Pull request checklist](#pull-request-checklist)
- [What gets a PR rejected](#what-gets-a-pr-rejected)
- [Code review](#code-review)

---

## Prerequisites

- **Node 22 or later.** The server uses `node --env-file` and modern `node:` import prefixes.
- **Brave or Chrome.** The extension targets Chromium MV3. Firefox is out of scope.
- **A logged-in DeepSeek account** in the browser where you'll test.
- **Git** with a GitHub account that has push access to a fork.

No package manager setup beyond `npm` (comes with Node). No build step, no test framework beyond `node --test`, no linting setup beyond `node --check`.

## Setup

```bash
git clone https://github.com/YOUR_FORK/deepseek-connect.git
cd deepseek-connect
cp .env.example .env
# edit .env: set EXTENSION_TOKEN to any long random string
node --env-file=.env src/server.js
```

In a second terminal, load the extension:

1. `brave://extensions` → Developer mode → Load unpacked → select this directory
2. Click the extension icon, paste the same token, set port to `7331`, save
3. Open `https://chat.deepseek.com/` in a tab

The server terminal should print `extension connected (...) | ... | 1 tab(s)`. If it doesn't, see [docs/getting-started.md#step-4--start-the-server](docs/getting-started.md#step-4--start-the-server).

Confirm the round-trip works before making any changes:

```bash
curl -s -X POST http://127.0.0.1:7331/chat \
  -H "Authorization: Bearer $EXTENSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with just: setup-ok"}],"chat":"setup-check"}' \
  | python3 -m json.tool
```

Expected: `{ "content": "setup-ok", "chat": "setup-check", "elapsedMs": ... }`. If this fails, fix setup before changing code — otherwise you can't tell your changes from an existing problem.

## Project layout

One-glance map. Every file's role is documented in [docs/architecture.md#module-boundaries](docs/architecture.md#module-boundaries).

```
deepseek-connect/
├── manifest.json         MV3 extension manifest
├── shared.js             constants, DSC.ERR, DSC.MSG, DSC.VERSION
├── selectors.js          tiered selector resolution
├── content.js            DOM manipulation (the only file with querySelector)
├── background.js         poll loop, message router, exact provider-tab routing
├── popup.html            status UI
├── popup.js              config + status reads
├── src/
│   ├── server.js         HTTP server (the only file with require('node:http'))
│   ├── client.js         HTTP client (what callers require)
│   └── errors.js         error taxonomy (imported by server and client)
├── tests/
│   ├── mock-deepseek.html    fixture page for selector development
│   └── server.test.js        queue, auth, /chat shape tests
└── docs/                 reference docs — read architecture.md first
```

If you're about to add a new file: it should fit one of those categories. A new file that doesn't fit is a sign the change crosses a module boundary — see [docs/architecture.md](docs/architecture.md) before proceeding.

## Development workflow

Four rules. Each one exists because skipping it has burned someone.

**1. One branch per change.** Branch off `main`, do the change, open a PR. Don't commit multiple concerns to one branch — reviewing a branch that mixes a bug fix and a refactor is harder than reviewing two PRs.

**2. Test locally before pushing.** At minimum `node --check` on every changed `.js` file and `npm test` passing. For extension changes, a real round-trip (not just the mock page) — the mock page doesn't exercise the real DeepSeek DOM.

**3. Respect the reload discipline.** See [docs/operations.md#reload-discipline](docs/operations.md#reload-discipline). Reloading the extension does not re-inject content scripts into open tabs. If you change `content.js`, `selectors.js`, or `shared.js`, you must hard-reload the work tab (`Ctrl+Shift+R`) for the change to take effect. The single biggest source of "I changed the code and nothing happened" is forgetting this.

**4. Don't introduce dependencies without a stated reason.** The repo currently has zero production dependencies and zero dev dependencies. Adding one requires a one-line justification in the PR description and a stated rollback (what happens if we have to remove it). "It makes the code cleaner" is not a reason. "It handles WebSocket framing so we don't have to" is — but the design is long-poll, so the answer is still no.

## Branch and commit conventions

### Branch names

Format: `<type>/<short-description>`

| Type | Use for |
|---|---|
| `feat/` | New functionality |
| `fix/` | Bug fix |
| `docs/` | Documentation-only change |
| `refactor/` | Code change that doesn't alter behavior |
| `chore/` | Dependency bump, tooling, config |
| `test/` | Test-only change |

Examples: `feat/cancel-route`, `fix/sidebar-walk-after-drift`, `docs/operations-runbook`.

### Commit messages

Format: `<type>(<scope>): <imperative subject>`, then an optional body.

```
feat(server): add /cancel route
fix(content): wait for answer block before stable-text check
docs(protocol): document the queue's inFlight timeout gap
refactor(selectors): extract sidebar walk into three functions
chore: remove unused DEEPTHINK_OFF constant
```

Rules:

- **Imperative mood.** "add" not "added", "fix" not "fixes". A commit message should complete the sentence "if applied, this commit will..."
- **Scope is the file or module.** `server`, `client`, `content`, `background`, `selectors`, `docs`, `protocol`, `errors`. Omit scope if the change is truly cross-cutting.
- **Subject line ≤ 72 chars.** The body can be longer; GitHub truncates the subject.
- **One commit per concern.** A bug fix and a refactor go in separate commits, even if they're in the same branch. A new route and its error code go in the same commit (they're one logical change).
- **Body explains why, not what.** The diff shows what; the message explains what the diff doesn't show. "Fixes #42" is not an explanation — it's a link. Include the link, but also explain the fix.

### Signing

Not required for external contributors. The maintainer's commits are signed.

## Testing

Three levels of verification. The checklist requires the first two; the third is required for extension changes.

### Level 1 — Syntax and unit tests

```bash
cd ~/deepseek-connect
node --check background.js
node --check content.js
node --check selectors.js
node --check shared.js
node --check src/server.js
node --check src/client.js
node --check src/errors.js
npm test
```

Expected: `SYNTAX_OK` for each file, and `# pass N` for the test suite. No `# fail`.

### Level 2 — Mock page (optional for non-selector changes)

`tests/mock-deepseek.html` replicates the essential DeepSeek DOM: input textarea, send button, DeepThink and Search toggles, chat sidebar, assistant message block with copy/regenerate buttons.

Load it via `file://` and run the extension against it to test the flow without hitting real DeepSeek. Useful for fast iteration on `content.js` logic that isn't selector-dependent.

**Limitation:** the mock page's DOM is a *snapshot* of what DeepSeek looked like at some point. It drifts from reality. If your change is "the extension should do X on real DeepSeek," the mock page can only prove it does X on the mock — not that it does X on the real page. Real round-trip is required for selector changes.

### Level 3 — Real round-trip

The only proof that a change to the extension works. See the curl command in [Setup](#setup).

For changes to `sendPrompt`, the reply extraction, or the stream loop, also test:

- **DeepThink on** — the prompt should route through reasoning, then answer, and extraction should return the answer only. Check the server log for the `reasoning` → `answerStarted` → `answer` sequence.
- **Same chat, two turns** — send two prompts to the same `chat` name; the second should land in the same chat and the LLM should remember the first.
- **Different chats** — send prompts to two different `chat` names; they should be isolated (the second chat shouldn't have context from the first).

For changes to the server's queue, testing one request isn't enough — testing concurrent requests is:

```bash
for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:7331/chat \
    -H "Authorization: Bearer $EXTENSION_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Reply with just: $i\"}],\"chat\":\"concurrent-$i\"}" &
done
wait
```

Expected: three responses, each with the correct content, each in its own chat. Server log shows three `-> dispatched` lines, serialized (no overlap between them).

## Changing selectors

DeepSeek redesigns its DOM regularly. Fixing extraction when it breaks is the most common contribution. The full playbook is [docs/selector-maintenance.md](docs/selector-maintenance.md) — read it before touching `selectors.js`. The short version:

1. Confirm the failure is actually drift (not `logged_out`, not a closed tab)
2. Run the diagnostic snippet from `docs/selector-maintenance.md#diagnosing-a-drift` in the work tab's console
3. Identify the broken selector from the `tried` array
4. Add a new tier at the **end** of that selector's tier list (don't reorder existing tiers)
5. Test with a real round-trip
6. Commit with a message that says *what changed in DeepSeek* and *how the new tier finds the element*

Selector PRs are reviewed against one criterion: does the new tier use a stable anchor (text, structure, `aria-*`) or a fragile one (build-hashed class name)? Class-name anchors are rejected. See [docs/architecture.md#7-structural-sidebar-walk-as-fallback](docs/architecture.md#7-structural-sidebar-walk-as-fallback) for why.

## Pull request checklist

Before clicking "Create pull request":

- [ ] `node --check` passes on every changed `.js` file
- [ ] `npm test` passes
- [ ] If extension-side: real DeepSeek round-trip verified (`content` is correct, `trace` shows the expected phases)
- [ ] If server-side queue change: concurrent requests tested, dispatch is serialized
- [ ] If a new error code: added to `src/errors.js` **first** (both `CODES` and `META`), added to `shared.js`'s `DSC.ERR` map, added to `docs/error-codes.md`'s full table
- [ ] If a new route: added to `docs/protocol.md` under the appropriate section, added to `src/client.js` with a method wrapper
- [ ] If a selector change: added to `docs/selector-maintenance.md`'s per-selector reference
- [ ] If a load-bearing decision is touched (long-poll, tab selection, chat lifecycle, extraction, selector strategy): an ADR under `docs/adr/` before the change
- [ ] Branch is up to date with `main` (`git rebase main` or `git merge main`, squash before requesting review)
- [ ] Commit messages follow the format above

If a checklist item doesn't apply (e.g., no selector change in this PR), say so in the description — "N/A, no selector changes" is faster to review than leaving it unchecked.

## What gets a PR rejected

Five things. Every one of them exists because a version of this was proposed and rejected during development.

**1. Puppeteer, headless browser, or anything that isn't the real Chrome tab.** The entire reason this repo exists is that Puppeteer triggers DeepSeek's fingerprinting and rate limits. A PR that adds a Puppeteer path is a PR that undoes the design. See [docs/architecture.md#2-real-chrome-over-puppeteer](docs/architecture.md#2-real-chrome-over-puppeteer).

**2. A build step, bundler, or TypeScript.** The extension is load-unpacked, plain JavaScript, no build. Adding webpack/vite/tsc would make every selector change require a rebuild, which triples the iteration loop for the change that happens most often. If you want TypeScript, the answer is no — but feel free to run `tsc --checkJs` locally for your own confidence.

**3. Retry logic inside the extension or the client.** Retry is caller policy (see [docs/error-codes.md](docs/error-codes.md) and [docs/integration-guide.md#sendwithretry](docs/integration-guide.md#sendwithretry)). A client that retries silently hides rate-limit conditions and breaks the caller's attempt-counting. The extension does one attempt and reports faithfully; the client throws on non-2xx and lets the caller decide.

**4. New error codes without the metadata.** Every code needs `retryable`, `userFixable`, `retryAfter`, and `http` set in `src/errors.js` before it's raised anywhere. A code without metadata is a code whose cause is ambiguous. See [docs/error-codes.md#registered-codes](docs/error-codes.md#registered-codes).

**5. Class-name anchors for selectors.** A `querySelector('.dc04ec1d')` works today and breaks on the next DeepSeek deploy. Reviewers reject these even if they "work right now" — a selector that has a shelf life of days is not a fix.

## Code review

Reviews are best-effort. Realistic expectations:

- **Small PRs (docs, single-file fixes):** 1-3 days
- **Medium PRs (new route, selector change with test):** 3-7 days
- **Large PRs (new module, architectural change):** 1-2 weeks, and may need a design discussion (as a GitHub Discussion) before the PR

Reviewer will check:

- Does the change respect the module boundaries in [docs/architecture.md#module-boundaries](docs/architecture.md#module-boundaries)?
- Does it touch a load-bearing decision without an ADR?
- Is the test evidence in the PR description (not just "it works")?
- Are commit messages clear about *why* the change is needed?
- Are docs updated where they need to be?

**Rejections are about the change, not the contributor.** If a PR is rejected, the reviewer will explain what would need to change for a re-review. Push to the same branch; don't open a new PR.

**One thing reviewers don't care about:** style, beyond "matches the surrounding code." The repo doesn't have a linter; consistency with adjacent files is the standard. Don't reformat unrelated code in a PR — it makes the diff harder to review and will be requested as a separate change.

---

Thanks for reading. The docs under [docs/](docs/) are the most valuable contribution to this repo (there are more of them than code files) — if something is unclear, a doc improvement PR is just as welcome as a bug fix.