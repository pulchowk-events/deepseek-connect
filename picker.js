// picker.js -- interactive selector picker, injected into a provider tab by
// providers.js (chrome.scripting.executeScript files:['picker.js']).
// providers.js first sets globalThis.__dsc_pick = { id, field } in this world.
// The result goes back through chrome.runtime.sendMessage as
// { type: 'dsc_picker_result', pickId, field, candidates }, where candidates is
// null when the user cancels (Esc) and [] when nothing stable was found.
//
// TODO(iframes): main frame only. An element inside an iframe needs
// allFrames:true and per-frame coordinate handling. Not supported yet.

(function () {
  'use strict';

  if (typeof globalThis.__dsc_picker_cancel === 'function') {
    try { globalThis.__dsc_picker_cancel(); } catch (_) { /* stale picker */ }
  }

  const cfg = globalThis.__dsc_pick || {};
  const pickId = cfg.id || null;
  const field = cfg.field || 'response';
  const MULTI = field === 'response' || field === 'code';
  const MAX_CANDIDATES = 3;
  const MAX_LEN = 300;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_RE = /^[0-9a-f]{8,}$/i;
  const REACT_ID_RE = /^:r[a-z0-9]+:/;
  const RADIX_RE = /^radix-/i;
  const DATA_DENY_RE = /^data-(?:v-.*|radix-.*|state|active|selected|disabled|highlighted|focus|focused|hover|checked|open|loading|orientation)$/;
  const HASHED_CLASS_RE = /_?[a-z0-9]{6,}_[a-z0-9]+/i;
  const TRAILING_HEX_RE = /[-_][0-9a-f]{6,}$/i;
  const UTILITY_RE = /^(?:!|-?(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|truncate|grow|shrink|container|w|h|p[xytblr]?|m[xytblr]?|gap|space|text|bg|border|rounded|shadow|opacity|font|leading|tracking|items|justify|self|place|content|overflow|min|max|z|top|bottom|left|right|inset|col|row|order|basis|cursor|select|transition|duration|ease|whitespace|break|object|aspect|size|ring|outline|fill|stroke|divide|list|underline|uppercase|lowercase|capitalize)(?:-|$))/;

  // ---- candidate generation -------------------------------------------------
  function unstable(v) {
    if (!v || v.length > 40) return true;
    if (UUID_RE.test(v) || HEX_RE.test(v) || REACT_ID_RE.test(v) || RADIX_RE.test(v)) return true;
    const digits = (v.match(/\d/g) || []).length;
    return v.length >= 8 && digits / v.length > 0.4;
  }
  function stableClass(c) {
    if (!c || c.length > 40) return false;
    if (/[:\/\[\]%]/.test(c)) return false;
    if (HASHED_CLASS_RE.test(c) || TRAILING_HEX_RE.test(c)) return false;
    if (UTILITY_RE.test(c)) return false;
    return true;
  }
  const qa = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ') + '"';

  function nth(n) {
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    return n.tagName.toLowerCase() + ':nth-of-type(' + i + ')';
  }
  function structural(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== el && n.id && !unstable(n.id)) { parts.unshift('#' + CSS.escape(n.id)); return parts.join(' > '); }
      if (n === document.body) { parts.unshift('body'); break; }
      parts.unshift(nth(n));
    }
    return parts.join(' > ');
  }

  // Most stable first: id, one data-* attribute, aria-label, classes, role, structure.
  function rawCandidates(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    if (el.id && !unstable(el.id)) out.push('#' + CSS.escape(el.id));
    const attrs = Array.from(el.attributes).filter((a) => /^data-/.test(a.name) && !DATA_DENY_RE.test(a.name));
    const good = attrs.find((a) => !unstable(a.value));
    if (good) out.push(tag + '[' + good.name + '=' + qa(good.value) + ']');
    else if (attrs.length) out.push(tag + '[' + attrs[0].name + ']');
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 80) out.push(tag + '[aria-label=' + qa(aria) + ']');
    const classes = Array.from(el.classList).filter(stableClass).slice(0, 2);
    if (classes.length) out.push(tag + classes.map((c) => '.' + CSS.escape(c)).join(''));
    const role = el.getAttribute('role');
    if (role && role.length <= 40) out.push(tag + '[role=' + qa(role) + ']');
    out.push(structural(el));
    return out;
  }

  // Single-target fields (input/send/stop): the runner takes the first DOM match,
  // so it must be the picked element. Multi-target (response/code): the match
  // set must include it. -> match count, or null to drop the candidate.
  function check(sel, el) {
    if (!sel || sel.length > MAX_LEN) return null;
    let list;
    try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { return null; }
    if (MULTI) return list.includes(el) ? list.length : null;
    return list.length && list[0] === el ? list.length : null;
  }
  function candidatesFor(el) {
    const seen = new Set();
    const res = [];
    for (const s of rawCandidates(el)) {
      if (seen.has(s)) continue;
      seen.add(s);
      const count = check(s, el);
      if (count !== null) res.push({ selector: s, count });
      if (res.length >= MAX_CANDIDATES) break;
    }
    return res;
  }

  // ---- overlay ----------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #4f46e5;background:rgba(79,70,229,0.08);display:none;';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif;background:#111;color:#fff;padding:6px 10px;border-radius:6px;max-width:80vw;';

  let current = null;
  let locked = false;
  let stack = [];
  let lastX = 0;
  let lastY = 0;

  function draw() {
    if (!current) { box.style.display = 'none'; return; }
    const r = current.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    const cn = typeof current.className === 'string' ? current.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    tip.textContent = 'pick ' + field + ': <' + current.tagName.toLowerCase() + (cn ? '.' + cn : '') + '>' + (locked ? ' [locked]' : '') +
      '   click = lock | Up/Down = parent/child | Enter = confirm | Esc = cancel | wheel = scroll';
  }
  function hit(x, y) {
    overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = 'auto';
    if (el && el !== overlay && el !== box && el !== tip && el !== document.documentElement && el !== document.body) {
      current = el;
      stack = [];
      draw();
    }
  }

  function onMove(e) { lastX = e.clientX; lastY = e.clientY; if (!locked) hit(lastX, lastY); }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!locked) hit(e.clientX, e.clientY);
    if (current) { locked = true; draw(); }
  }
  // The overlay swallows the wheel, so forward it to the nearest scrollable ancestor.
  function onWheel(e) {
    e.preventDefault();
    let n = current;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) { n.scrollBy(0, e.deltaY); break; }
      n = n.parentElement;
    }
    if (!n || n === document.documentElement) window.scrollBy(0, e.deltaY);
    setTimeout(() => { if (locked) draw(); else hit(lastX, lastY); }, 50);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (current) finish(candidatesFor(current)); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      locked = true;
      if (e.key === 'ArrowUp') {
        const p = current.parentElement;
        if (p && p !== document.documentElement && p !== document.body) { stack.push(current); current = p; }
      } else {
        const c = stack.pop() || current.firstElementChild;
        if (c) current = c;
      }
      draw();
    }
  }

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', draw, true);
    window.removeEventListener('resize', draw, true);
    overlay.remove();
    box.remove();
    tip.remove();
    if (globalThis.__dsc_picker_cancel === cleanup) delete globalThis.__dsc_picker_cancel;
  }
  function finish(candidates) {
    cleanup();
    try {
      chrome.runtime.sendMessage({ type: 'dsc_picker_result', pickId, field, candidates }).catch(() => {});
    } catch (_) { /* extension reloaded mid-pick */ }
  }

  document.documentElement.append(overlay, box, tip);
  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('click', onClick, true);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', draw, true);
  window.addEventListener('resize', draw, true);
  globalThis.__dsc_picker_cancel = cleanup;
  tip.textContent = 'pick ' + field + ': move over the element, click to lock, Enter to confirm, Esc to cancel';
})();
