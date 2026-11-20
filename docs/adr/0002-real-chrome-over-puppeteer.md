# 0002 — Real Chrome over Puppeteer

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** maintainer
- **Supersedes:** —
- **Superseded by:** —

## Context

The goal is to use DeepSeek as a free LLM endpoint from a batch wizard. Two ways to automate a web page: drive a fresh browser instance from a script (Puppeteer / Playwright), or inject into an existing browser tab (extension).

DeepSeek's anti-automation is more aggressive than typical sites. The aggregator's own scrapers use Puppeteer with `puppeteer-extra-plugin-stealth` successfully against 10+ sources; DeepSeek is the first site where that pattern fails.

## Decision

Drive the user's already-logged-in Chrome/Brave tab via a load-unpacked extension. No Puppeteer, no headless browser, no scripted login, no credential handling.

The extension is a client of the local server; the server is a client of the extension. Both sides live on `127.0.0.1`. The extension polls the server via HTTP long-poll (see [ADR 0001](0001-use-long-poll-over-websocket.md)).

## Consequences

### Positive

- **Real fingerprint.** The browser is the same browser the user browses in. Canvas, WebGL, audio context, plugin list — all real, all unique to the user's machine. DeepSeek sees a real user, because it is one.
- **Real cookies.** The logged-in session persists across runs because it's the same Chrome profile. No `--user-data-dir` to persist, no cookie-jar serialization, no "why did I get logged out again."
- **No credential handling.** The extension never touches the user's password, 2FA code, or session token. It drives a page that's already authenticated. A compromised extension has the same privileges as a compromised browser tab — which is to say, whatever the user's session allows, and no more.
- **Rate limits match the user's tier.** DeepSeek rate-limits the *account*, not the browser instance. A real account in a real browser gets the account's tier, not the headless-tier penalty.
- **User can watch.** The batch runs visibly. The user sees prompts being typed, answers streaming, chats being created. Debugging "why is it slow" is watching the tab, not reading a Puppeteer log.

### Negative

- **Requires install.** One-time `brave://extensions` → Load unpacked. Not a `npm install`-and-go experience. This is the main cost.
- **Requires an open tab.** The extension needs at least one `chat.deepseek.com` tab to drive. If the user closes the tab mid-batch, the next request fails with `input_not_found`.
- **Single-tab constraint.** One extension drives one tab. Multi-tab parallelism isn't possible (see [ADR 0004](0004-sticky-work-tab-over-target-tab-id.md)). For a batch that processes 76 sources serially, this is fine — serial is the requirement, not a limitation.
- **Manifest V3 lifecycle.** Service workers get killed after ~30s of inactivity. The extension must handle restart gracefully. See [ADR 0001](0001-use-long-poll-over-websocket.md) for how the long-poll accommodates this.

### Neutral

- The extension's `manifest.json` declares `host_permissions: ["http://127.0.0.1:*/*"]` and a content script match on `https://chat.deepseek.com/*`. Both are narrow — the extension has no access to other origins, other tabs' content, or the network beyond loopback.

## Alternatives considered

**Puppeteer with stealth plugins.** The status quo for the aggregator's scrapers. Rejected on three grounds:

1. **Headless fingerprinting.** DeepSeek rate-limits headless sessions aggressively. Even with `puppeteer-extra-plugin-stealth`, the fingerprint — canvas, WebGL renderer, audio context, plugin list — is detectable on a fresh profile. The rate limits go from "one prompt per 5 seconds" to "one prompt per 10 minutes" or "account banned."
2. **Credential handling.** A Puppeteer-driven session starts with an empty profile. To use the user's actual account, we'd script the login — email, password, possibly 2FA — which means storing credentials somewhere the extension doesn't. That's a security regression with no compensating benefit.
3. **Session continuity.** Cookies from the extension-driven tab persist across runs because they're the same Chrome profile. A Puppeteer session that closes loses them (unless you persist the profile directory, which is another complication).

**Puppeteer with `--user-data-dir` pointing at the user's real profile.** Attempted in early development. Rejected because:

1. Chrome refuses to open a profile directory that's already in use by a running browser — the user's daily browser locks the profile.
2. If the user closes their browser to allow Puppeteer, they're not using their browser — the "real browser" benefit is gone.
3. Locking the profile directory per batch run means the user can't browse DeepSeek while the batch runs, which defeats the "user can watch" benefit above.

**Playwright with a persistent context.** Same profile-locking issue as Puppeteer. Same fingerprinting issue with a fresh context. Rejected.

**Direct API access.** DeepSeek's free tier doesn't expose an API — the paid tier does, but this repo's reason for existing is the free tier. A user who has API access doesn't need this tool. Rejected because the use case doesn't apply.

## References

- [architecture.md#2-real-chrome-over-puppeteer](../architecture.md#2-real-chrome-over-puppeteer)
- `manifest.json` — MV3, content script match on `chat.deepseek.com`
- `background.js` — `chrome.tabs` interaction, sticky tab
- `README.md#why-it-exists` — the problem statement this addresses
