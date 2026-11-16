// selectors.js — DeepSeek-specific DOM selector registry (and the mock fixture,
// which mirrors DeepSeek's shape).
//
// PROVIDER SCOPE: This file is DeepSeek's. It is not provider-neutral shared
// infrastructure, despite living at the top level.
//
// Each provider is expected to own its own selector strategy:
//   - DeepSeek: this file, loaded before providers/deepseek.js, exposes
//     globalThis.DSC_SELECTORS. providers/deepseek.js calls
//     DSC_SELECTORS.resolve(name).
//   - Qwen: providers/qwen.js declares its selectors inline and ignores
//     this file entirely.
//
// When a THIRD provider needs shared selector infrastructure, extract the
// genuinely shared parts into a new module (e.g. selector-tiers.js) and
// keep each provider's selectors in its own provider file. Do not add
// provider-specific selectors here.
//
// Tier kinds:
//   healthy  — the primary/stable selector matched.
//   degraded — a fallback matched. Log it; feature may still work.
//   drifted  — nothing matched. Required elements block sendPrompt.
//
// DeepSeek is a React SPA with CSS-module hashes in class names. Do not rely
// on hash-bearing classes; do rely on semantic anchors: placeholder text,
// role, aria-*, href patterns, and relative DOM position.
//
// Tier kinds:
//   healthy  — the primary/stable selector matched.
//   degraded — a fallback matched. Log it; feature may still work.
//   drifted  — nothing matched. Required elements block sendPrompt.
//
// Target UIs are React SPAs with CSS-module hashes in class names. Do not rely
// on hash-bearing classes; do rely on semantic anchors: placeholder text,
// role, aria-*, href patterns, and relative DOM position.

'use strict';

(function () {
  const S = {};

  function visible(el) {
    if (!el) return false;
    // Virtual results (plain { textContent } objects) are considered visible;
    // only real elements carry getBoundingClientRect.
    if (typeof el.getBoundingClientRect !== 'function') return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function findByText(sel, re) {
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.textContent || '').trim();
      if (re.test(t)) return el;
    }
    return null;
  }

  function nearTextarea(el) {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const tr = ta.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.right > tr.left - 300 && er.left < tr.right + 300 &&
           er.bottom > tr.top - 100 && er.top < tr.bottom + 100;
  }

  const TIERS = {
    input: [
      { sel: 'textarea[placeholder*="Message" i]', kind: 'healthy' },
      { sel: 'textarea', kind: 'healthy' },
      { sel: '[contenteditable="true"]', kind: 'degraded' },
    ],
    sendButton: [
      { try: () => {
          for (const el of document.querySelectorAll('div[role="button"]')) {
            if (!visible(el)) continue;
            if (el.classList.contains('ds-button--disabled')) continue;
            const primary = el.classList.contains('ds-button--primary') || el.classList.contains('ds-button--filled');
            if (primary && nearTextarea(el)) return el;
          }
          return null;
        }, kind: 'healthy' },
      { try: () => {
          for (const el of document.querySelectorAll('button')) {
            if (el.disabled) continue;
            const aria = (el.getAttribute('aria-label') || '').trim();
            const text = (el.textContent || '').trim();
            if (/^send$/i.test(aria) || /^send$/i.test(text)) return el;
          }
          return null;
        }, kind: 'healthy' },
      { try: () => {
          for (const el of document.querySelectorAll('[role="button"], button')) {
            if (!visible(el)) continue;
            if (nearTextarea(el) && /primary|accent|submit/i.test(el.className)) return el;
          }
          return null;
        }, kind: 'degraded' },
    ],
    toggleDeepThink: [
      { try: () => {
          for (const el of document.querySelectorAll('[aria-pressed]')) {
            if (/deep\s*think/i.test((el.textContent || '').trim())) return el;
          }
          return null;
        }, kind: 'healthy' },
      { try: () => findByText('button, [role="button"], div', /deep\s*think/i), kind: 'degraded' },
    ],
    toggleSearch: [
      { try: () => {
          for (const el of document.querySelectorAll('[aria-pressed]')) {
            if (/^search$/i.test((el.textContent || '').trim())) return el;
          }
          return null;
        }, kind: 'healthy' },
      { try: () => {
          for (const el of document.querySelectorAll('button, [role="button"]')) {
            if (/^search$/i.test((el.textContent || '').trim())) return el;
          }
          return null;
        }, kind: 'degraded' },
    ],
    newChatButton: [
      { try: () => findByText('button, div, a, [role="button"]', /^new\s*chat$/i), kind: 'healthy' },
    ],
    chatList: [
      { try: () => Array.from(document.querySelectorAll('a[href*="/a/chat/s/"]')), kind: 'healthy' },
      { try: () => {
          const side = document.querySelector('aside, nav, [class*="sidebar" i]');
          return side ? Array.from(side.querySelectorAll('li, a, [role="link"], [role="button"]')) : [];
        }, kind: 'degraded' },
    ],
    assistantMessages: [
      { try: () => Array.from(document.querySelectorAll('.ds-message'))
                .filter((m) => m.querySelector('.ds-markdown')), kind: 'healthy' },
      { try: () => Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')), kind: 'healthy' },
      { try: () => Array.from(document.querySelectorAll('.ds-markdown')), kind: 'degraded' },
    ],
    headerTitle: [
      { try: () => document.querySelector('header h1') || document.querySelector('#chat-title'), kind: 'healthy' },
      { try: () => {
          const t = document.title || '';
          const m = t.match(/^(.*?)\s*[-|]\s*DeepSeek/i);
          return m ? { textContent: m[1].trim() } : null;
        }, kind: 'degraded' },
    ],
  };

  function resolveOne(spec) {
    if (spec.sel) {
      const el = document.querySelector(spec.sel);
      return el && visible(el) ? { el, kind: spec.kind } : null;
    }
    if (spec.try) {
      const el = spec.try();
      if (!el) return null;
      if (Array.isArray(el)) return el.length > 0 ? { el, kind: spec.kind } : null;
      return visible(el) ? { el, kind: spec.kind } : null;
    }
    return null;
  }

  S.resolve = function (name) {
    const tiers = TIERS[name];
    if (!tiers) return { el: null, kind: 'unknown', tried: [] };
    const tried = [];
    for (const spec of tiers) {
      tried.push(spec.sel || 'custom');
      const got = resolveOne(spec);
      if (got) return { el: got.el, kind: got.kind, tier: spec.sel || 'custom', tried };
    }
    return { el: null, kind: 'drifted', tried };
  };

  const REQUIRED = ['input', 'sendButton', 'toggleDeepThink', 'toggleSearch'];
  const OPTIONAL = ['newChatButton', 'chatList', 'headerTitle'];

  S.probeDom = function () {
    const report = { healthy: [], degraded: [], drifted: [], details: {} };
    for (const name of REQUIRED.concat(OPTIONAL)) {
      const r = S.resolve(name);
      const required = REQUIRED.includes(name);
      report.details[name] = { kind: r.kind, tier: r.tier, tried: r.tried, required };
      if (r.el) {
        if (r.kind === 'healthy') report.healthy.push(name);
        else report.degraded.push(name);
      } else if (required) {
        report.drifted.push({ name, required: true });
      } else {
        report.drifted.push({ name, required: false });
      }
    }
    return report;
  };

  S.visible = visible;
  S.findByText = findByText;
  S.nearTextarea = nearTextarea;
  S.TIERS = TIERS;

  globalThis.DSC_SELECTORS = S;
})();
