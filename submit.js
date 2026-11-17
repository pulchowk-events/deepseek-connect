// submit.js -- pure builder for the "Submit to GitHub" issue link. Loaded as a classic
// script by providers.html (exposes globalThis.DSC_SUBMIT) and require()d by
// tests/submit.test.js. No DOM, no chrome.*, no network.
//
// buildIssue({ repoUrl, name, label, domains, source, definition, submitter, max })
//   -> { url, tier, clipboard, encodedLength }
// Tier 1: full providers/<name>.js in a js fence.
// Tier 2: compact JSON of the definition only (when tier 1 would exceed the URL budget).
// Tier 3: short body; the caller must copy `clipboard` (the full file) for the submitter
//         to paste, because even the compact JSON is too long for a link.

(function () {
  'use strict';

  // GitHub rejects request lines over about 8 KB; leave headroom for the title and prefix.
  const MAX_ENCODED_BODY = 6000;
  const enc = encodeURIComponent;

  function maintainerNote(name) {
    return 'maintainer: copy this into `seeds/' + name + '.json` and `providers/' + name +
      '.js`, or just `seeds/' + name + '.json` if you want other users to be able to Seed it';
  }

  function bodyFor(tier, p) {
    const who = p.submitter && String(p.submitter).trim() ? String(p.submitter).trim().slice(0, 80) : '(not given)';
    const head = '## New provider: ' + p.name + '\n\nSubmitted by: ' + who + '\nLabel: ' + p.label +
      '\nDomains: ' + p.domains.join(', ') + '\n\n';
    const tail = '\n\n---\n' + maintainerNote(p.name) + '\n';
    if (tier === 1) {
      return head + '### providers/' + p.name + '.js\n\n```js\n' + String(p.source).trimEnd() + '\n```' + tail;
    }
    if (tier === 2) {
      return head + '### definition (compact JSON)\n\n```json\n' + JSON.stringify(p.definition) + '\n```' + tail;
    }
    return head + 'The definition was too long for a link. It was copied to the submitter\'s clipboard; ' +
      'paste it between the fences below.\n\n```js\n\n```' + tail;
  }

  function buildIssue(p) {
    const max = p.max || MAX_ENCODED_BODY;
    const base = String(p.repoUrl).replace(/\/+$/, '') + '/issues/new?title=' + enc('New provider: ' + p.name) + '&body=';
    let out = null;
    for (const tier of [1, 2, 3]) {
      const e = enc(bodyFor(tier, p));
      out = {
        url: base + e,
        tier,
        clipboard: tier === 3 ? String(p.source).trimEnd() : null,
        encodedLength: e.length,
      };
      if (e.length <= max) break;
    }
    return out;
  }

  const api = { buildIssue, MAX_ENCODED_BODY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.DSC_SUBMIT = api;
})();
