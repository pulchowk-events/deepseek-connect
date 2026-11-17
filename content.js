'use strict';

(function () {
  const DSC = globalThis.DSC;
  const log = (...a) => console.debug('[dsc:router]', ...a);

  // Idempotent: re-injection (executeScript after Save, sendToTab recovery) must
  // not add a second onMessage listener, which would double-send prompts.
  const loadKey = DSC.BUILD_HASH + ':' + (chrome.runtime && chrome.runtime.id);
  if (globalThis.__dsc_content_loaded === loadKey) return;
  globalThis.__dsc_content_loaded = loadKey;

  // Provider contract lives in shared.js (search for "PROVIDER CONTRACT").
  // This router is deliberately blind to provider internals -- it looks up
  // the module by name, calls one of four methods, and returns the result.
  // The only lookup is globalThis.DSC_PROVIDERS[name]: no storage fallback.
  //
  // msg.provider is required. There is no default provider.

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (!msg || !msg.action) return sendResponse({ error: 'no_action' });

        const providerName = msg.provider;
        if (!providerName) {
          log('request without provider', msg.action, location.hostname);
          return sendResponse({
            error: DSC.ERR.BAD_REQUEST,
            reason: 'provider_required',
            details: { action: msg.action, hostname: location.hostname },
          });
        }

        // This tab must belong to the requested provider (exact hostname).
        const hostProvider = DSC.providerForUrl(location.href);
        if (hostProvider !== providerName) {
          log('provider/tab mismatch', providerName, location.hostname);
          return sendResponse({
            error: DSC.ERR.AMBIGUOUS_PROVIDER_TAB,
            reason: 'provider_mismatch',
            details: { requested: providerName, actual: hostProvider, hostname: location.hostname },
          });
        }

        const provider = (globalThis.DSC_PROVIDERS && globalThis.DSC_PROVIDERS[providerName]);
        if (!provider) {
          log('no provider loaded for', providerName, location.hostname);
          return sendResponse({ error: 'no_provider_loaded', provider: providerName, hostname: location.hostname });
        }

        if (msg.action === DSC.MSG.ENSURE_CHAT) {
          return sendResponse(await provider.ensureChat(msg.name));
        }
        if (msg.action === DSC.MSG.SEND_PROMPT) {
          return sendResponse(await provider.sendPrompt(msg.prompt, msg.delimiters));
        }
        if (msg.action === DSC.MSG.CHECK_STATE) {
          return sendResponse(await provider.checkState());
        }
        if (msg.action === DSC.MSG.RESET_CHAT) {
          return sendResponse(await provider.resetChat(msg.name));
        }
        return sendResponse({ error: 'unknown_action', action: msg.action });
      } catch (e) {
        log('handler error', e);
        sendResponse({ error: 'content_error', reason: e.message });
      }
    })();
    return true; // async response
  });

  console.debug('[dsc:router:diag]', {
    href: location.href,
    hostname: location.hostname,
    pathname: location.pathname,
    frame: window === window.top ? 'top' : 'iframe',
    registeredProviders: Object.keys(globalThis.DSC_PROVIDERS || {}),
    dscDefined: !!globalThis.DSC,
  });
  log('content router loaded, active providers:', Object.keys(globalThis.DSC_PROVIDERS || {}));
})();
