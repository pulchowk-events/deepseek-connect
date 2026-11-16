# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✓ |
| < 0.1.0 | ✗ |

Pre-1.0 software: only the latest minor version receives security patches. If you're on an older version, upgrade to the latest `main` before reporting an issue.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Public issues are visible to everyone, and a security bug that's publicly disclosed before a fix is available can be exploited by anyone.

Report privately via one of these channels:

1. **GitHub Security Advisories** (preferred). Go to the [Security tab](https://github.com/pulchowk-events/deepseek-connect/security) and click "Report a vulnerability". This creates a private advisory visible only to the maintainer and yourself.

2. **Email** — if Security Advisories are unavailable for any reason, email `pulchowkevents@gmail.com` (the address is monitored, though responses may take longer than the GitHub flow).

Include in your report:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- Affected versions (the `version` field in `manifest.json` and the server's startup log)
- Any mitigations you've already identified

## What's in scope

- **Extension privilege escalation** — a page script gaining access to `chrome.*` APIs, `chrome.storage.local`, or the extension's network surface beyond what it already has
- **Auth bypass** — a request reaching a caller route without a valid `Bearer` token, or reaching it with a different token than the configured `EXTENSION_TOKEN`
- **Remote code execution** — via a malicious DeepSeek page, a malicious `/chat` caller, or a malicious `/reply` payload
- **Server-side injection** — prompt injection that causes the server to execute unintended commands (the server never `eval`s, so this should be impossible; if you find a path, it's a real bug)
- **Data exfiltration** — the extension reading or transmitting data from other browser tabs, other extensions' storage, or the user's filesystem
- **CSRF / XSS** in the popup or any rendered response
- **Denial of service** on the local server from an unauthenticated source (loopback is trusted, but a malicious process on the same machine shouldn't be able to crash the server)

## What's out of scope

- **DeepSeek's own rate limits, account bans, or ToS enforcement.** The extension drives a real logged-in tab; if DeepSeek flags the automation, that's a product concern, not a security vulnerability. Report it as a regular issue.
- **DeepSeek's DOM breaking the extension** — that's `dom_drift`, documented in [docs/selector-maintenance.md](docs/selector-maintenance.md). Regular issue, not a security bug.
- **The user configuring `EXTENSION_TOKEN` insecurely.** The token is a shared secret between processes on the same machine. If you write it to a world-readable file or commit it to a public repo, that's a user error, not a vulnerability. (The `.gitignore` prevents the common case.)
- **The server binding to loopback but being reachable from another machine on the same host** (e.g., another user account on the same Linux box). This is a known limitation of the design — the server trusts any process that can connect to loopback. If you need per-user isolation, run each user's server on a different port inside a container.
- **Denial of service from a caller with a valid token.** If someone has your `EXTENSION_TOKEN`, they can queue arbitrary prompts. The mitigation is to not share the token.
- **The extension not auto-updating.** Load-unpacked extensions don't update automatically. The user is responsible for pulling the latest `main` and reloading. See [docs/operations.md#reload-discipline](docs/operations.md#reload-discipline).

## Response timeline

Best-effort, given that this is a solo-maintained project:

- **Acknowledgment** within 72 hours
- **Initial assessment** (severity, scope, reproducibility) within 7 days
- **Fix** — timeline depends on severity:
  - Critical (RCE, auth bypass): within 7 days
  - High (data exfiltration, privilege escalation): within 30 days
  - Medium / Low: next scheduled release
- **Disclosure** — coordinated with you. Default is 90 days from acknowledgment, or sooner if a fix ships first.

If a fix is delayed, you'll get an update every 14 days explaining why and what the new timeline is.

## Bounty

No monetary bounty. This is a small project; the reward is a public credit in the release notes and the CHANGELOG, unless you prefer to remain anonymous.

---
