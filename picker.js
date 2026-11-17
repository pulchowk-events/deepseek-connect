// picker.js -- interactive selector picker, injected into a provider tab by
// providers.js (chrome.scripting.executeScript files:['picker.js']).
// providers.js first sets globalThis.__dsc_pick = { id, field, input, send } in
// this world (input/send are the form's selector lists, used for the composer check).
// The result goes back through chrome.runtime.sendMessage as
// { type: 'dsc_picker_result', pickId, field, candidates, chosen }, where candidates
// is null when the user cancels (Esc) and [] when nothing stable was found. Each
// candidate is { selector, count, rating, reason }; chosen is the selector the
// operator confirmed (a will-break one only after a second, explicit Enter).
//
// The rating functions at the top are pure so tests/picker.test.js can require() this
// file in Node (it exports them and returns before touching the DOM).
//
// TODO(iframes): main frame only. An element inside an iframe needs
// allFrames:true and per-frame coordinate handling. Not supported yet.

(function () {
  'use strict';

  if (typeof globalThis.__dsc_picker_cancel === 'function') {
    try { globalThis.__dsc_picker_cancel(); } catch (_) { /* stale picker */ }
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_RE = /^[0-9a-f]{8,}$/i;
  const REACT_ID_RE = /^:r[a-z0-9]+:/;
  const RADIX_RE = /^radix-/i;
  const DATA_DENY_RE = /^data-(?:v-.*|radix-.*|state|active|selected|disabled|highlighted|focus|focused|hover|checked|open|loading|orientation)$/;
  const HASHED_CLASS_RE = /_?[a-z0-9]{6,}_[a-z0-9]+/i;
  const TRAILING_HEX_RE = /[-_][0-9a-f]{6,}$/i;
  const UTILITY_RE = /^(?:!|-?(?:group|peer|sr|contents|isolate|visible|invisible|flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|truncate|grow|shrink|container|w|h|p[xytblr]?|m[xytblr]?|gap|space|text|bg|border|rounded|shadow|opacity|font|leading|tracking|items|justify|self|place|content|overflow|min|max|z|top|bottom|left|right|inset|col|row|order|basis|cursor|select|transition|duration|ease|whitespace|break|object|aspect|size|ring|outline|fill|stroke|divide|list|underline|uppercase|lowercase|capitalize)(?:-|$))/;

  // ---- pure helpers + rating --------------------------------------------------
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

  // Split a selector into compound selectors on top-level combinators (space, >, +, ~),
  // ignoring anything inside [] or () or quotes. "levels" = compounds.length.
  function compounds(sel) {
    const out = [];
    let cur = '';
    let br = 0;
    let pa = 0;
    let q = null;
    const s = String(sel || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { cur += c + (s[i + 1] || ''); i++; continue; }
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '[') br++;
      else if (c === ']') br = Math.max(0, br - 1);
      else if (c === '(') pa++;
      else if (c === ')') pa = Math.max(0, pa - 1);
      if (!br && !pa && /[\s>+~]/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  const NTH_RE = /:nth-(?:of-type|child|last-child|last-of-type)\(/i;
  const UUID_ANY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const HEX_RUN_RE = /(?=[0-9a-f]*\d)[0-9a-f]{6,}/i; // 6+ hex run that contains a digit
  const ATTR_SRC = '\\[\\s*([^\\]=~|^$*\\s]+)\\s*(?:([~|^$*]?=)\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\]\\s]*))?\\s*(?:[iIsS])?\\s*\\]';
  const LEVELS = ['recommended', 'might-break', 'will-break'];
  const unesc = (v) => v.replace(/\\([\s\S])/g, '$1');

  // -> { rating: 'recommended' | 'might-break' | 'will-break', reason }
  function rate(sel) {
    const s = String(sel || '');
    let level = 0;
    let reason = '';
    const bump = (lv, why) => { if (lv > level) { level = lv; reason = why; } };

    if (NTH_RE.test(s)) bump(2, 'positional nth-* chain, breaks when the layout shifts');
    if (UUID_ANY_RE.test(s) || HEX_RUN_RE.test(s)) bump(2, 'contains a generated id or hash');

    const parts = compounds(s);
    if (parts.length === 0) return { rating: LEVELS[2], reason: 'empty selector' };
    if (parts.length > 2) bump(1, parts.length + '-level chain is fragile');

    const last = parts[parts.length - 1];
    const bare = last.replace(new RegExp(ATTR_SRC, 'g'), '').replace(/\([^)]*\)/g, '');
    let anchor = null;

    const idm = bare.match(/#((?:\\[\s\S]|[\w-])+)/);
    if (idm) {
      if (unstable(unesc(idm[1]))) bump(2, 'id looks generated');
      else anchor = 'stable id';
    }

    const re = new RegExp(ATTR_SRC, 'g');
    let m;
    while ((m = re.exec(last)) !== null) {
      const name = m[1].toLowerCase();
      const op = m[2] || '';
      const val = (m[3] || '').replace(/^["']|["']$/g, '');
      if (op && op !== '=') bump(1, 'loose [' + name + op + '] match can hit unrelated elements');
      if (name === 'aria-label') {
        anchor = anchor || 'aria-label';
      } else if (name.indexOf('data-') === 0) {
        if (DATA_DENY_RE.test(name)) bump(1, 'volatile ' + name + ' attribute');
        else if (val && unstable(val)) bump(1, name + ' value looks generated');
        else anchor = anchor || 'stable data attribute';
      }
    }

    const classes = [];
    bare.replace(/\.((?:\\[\s\S]|[\w-])+)/g, (_, c) => { classes.push(unesc(c)); return ''; });
    if (classes.some(stableClass)) anchor = anchor || 'named class';

    if (!anchor) {
      if (classes.length) bump(1, 'only utility or generated classes');
      else bump(1, 'no stable id, label, data attribute or class');
    }
    if (level === 0) reason = anchor;
    return { rating: LEVELS[level], reason };
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { rate, compounds, stableClass, unstable };
    }
    return;
  }

  // ---- candidate generation (DOM) ---------------------------------------------
  const cfg = globalThis.__dsc_pick || {};
  const pickId = cfg.id || null;
  const field = cfg.field || 'response';
  const MULTI = field === 'response' || field === 'code' || field === 'exclude';
  const COMPOSER_CHECK = field === 'response' || field === 'code';
  const MAX_SAFE = 3;
  const MAX_LEN = 300;

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

  // Most stable first: id, one data-* attribute, aria-label, classes, role, a volatile
  // data-* (last resort), structure. Everything is rated afterwards.
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
    const vol = Array.from(el.attributes).find((a) => /^data-/.test(a.name) && DATA_DENY_RE.test(a.name));
    if (vol) out.push(vol.value && vol.value.length <= 40 ? tag + '[' + vol.name + '=' + qa(vol.value) + ']' : tag + '[' + vol.name + ']');
    out.push(structural(el));
    return out;
  }

  // Single-target fields (input/send/stop): the runner takes the first DOM match,
  // so it must be the picked element. Multi-target (response/code/exclude): the match
  // set must include it. -> match count, or null to drop the candidate.
  function check(sel, el) {
    if (!sel || sel.length > MAX_LEN) return null;
    let list;
    try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { return null; }
    if (MULTI) return list.includes(el) ? list.length : null;
    return list.length && list[0] === el ? list.length : null;
  }

  // Composer = lowest common ancestor of the first visible input and send matches.
  function firstVisible(sels) {
    for (const s of Array.isArray(sels) ? sels : []) {
      let l = [];
      try { l = Array.from(document.querySelectorAll(s)); } catch (_) { l = []; }
      for (const el of l) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }
  function lca(a, b) {
    for (let n = a; n; n = n.parentElement) if (n.contains(b)) return n;
    return null;
  }
  const inputEl = COMPOSER_CHECK ? firstVisible(cfg.input) : null;
  const sendEl = COMPOSER_CHECK ? firstVisible(cfg.send) : null;
  const composer = inputEl && sendEl ? lca(inputEl, sendEl) : null;

  function composerHit(sel) {
    if (!composer) return false;
    let l = [];
    try { l = Array.from(document.querySelectorAll(sel)); } catch (_) { return false; }
    return l.some((m) => composer.contains(m) || m.contains(inputEl));
  }

  // Up to MAX_SAFE recommended/might-break candidates (best rating first), then at most
  // one will-break candidate. A will-break candidate is only ever written when the
  // operator picks it and confirms it a second time.
  function candidatesFor(el) {
    const seen = new Set();
    const safe = [];
    let risky = null;
    for (const s of rawCandidates(el)) {
      if (seen.has(s)) continue;
      seen.add(s);
      const count = check(s, el);
      if (count === null) continue;
      const r = rate(s);
      let rating = r.rating;
      let reason = r.reason;
      if (COMPOSER_CHECK && composerHit(s)) {
        rating = 'will-break';
        reason = 'also matches the input bar; add it to Exclude';
      }
      const c = { selector: s, count, rating, reason };
      if (rating === 'will-break') { if (!risky) risky = c; }
      else if (safe.length < MAX_SAFE) safe.push(c);
    }
    safe.sort((a, b) => LEVELS.indexOf(a.rating) - LEVELS.indexOf(b.rating));
    return risky ? safe.concat([risky]) : safe;
  }

  // ---- overlay ----------------------------------------------------------------
  const BADGE = {
    'recommended': ['#16a34a', 'recommended'],
    'might-break': ['#d97706', 'might break'],
    'will-break': ['#dc2626', 'will break'],
  };
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #4f46e5;background:rgba(79,70,229,0.08);display:none;';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif;background:#111;color:#fff;padding:6px 10px;border-radius:6px;max-width:80vw;';
  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;top:8px;right:8px;width:380px;max-width:90vw;z-index:2147483647;pointer-events:auto;font:12px system-ui,sans-serif;background:#111;color:#fff;border:1px solid #444;border-radius:8px;padding:8px;box-sizing:border-box;';

  let current = null;
  let locked = false;
  let stack = [];
  let lastX = 0;
  let lastY = 0;
  let list = [];
  let sel = 0;
  let armed = false;
  let cacheEl = null;

  function mk(tag, text, css) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (css) e.style.cssText = css;
    return e;
  }
  function renderCard() {
    card.textContent = '';
    card.append(mk('div', 'pick ' + field, 'font-weight:600;margin-bottom:2px;'));
    if (!current) { card.append(mk('div', 'move over the page, click to lock', 'color:#aaa;')); return; }
    if (list.length === 0) {
      card.append(mk('div', 'No stable selector for this element. Try Up/Down for another level.', 'color:#fca5a5;'));
      return;
    }
    list.forEach((c, i) => {
      const on = i === sel;
      const row = mk('div', undefined, 'padding:4px 6px;margin-top:4px;border-radius:6px;cursor:pointer;border:1px solid ' + (on ? '#4f46e5' : 'transparent') + ';background:' + (on ? '#1e1b4b' : 'transparent') + ';');
      const b = BADGE[c.rating];
      row.append(
        mk('span', b[1], 'display:inline-block;background:' + b[0] + ';color:#fff;border-radius:4px;padding:0 6px;margin-right:6px;font-size:11px;'),
        mk('span', (i + 1) + '. ' + c.selector + '  (' + c.count + 'x)', 'font-family:ui-monospace,monospace;word-break:break-all;')
      );
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sel = i;
        armed = false;
        locked = true;
        renderCard();
        draw();
      });
      card.append(row);
    });
    card.append(mk('div', list[sel].reason, 'color:#bbb;margin-top:6px;'));
    if (COMPOSER_CHECK && !composer) {
      card.append(mk('div', 'composer check skipped: fill in input and send selectors first', 'color:#fbbf24;margin-top:4px;'));
    }
    if (armed) {
      card.append(mk('div', 'This selector will break. Press Enter again to accept it anyway, or choose another.', 'color:#fca5a5;margin-top:6px;font-weight:600;'));
    }
  }
  function draw() {
    if (current !== cacheEl) {
      cacheEl = current;
      list = current ? candidatesFor(current) : [];
      sel = 0;
      armed = false;
      renderCard();
    }
    if (!current) { box.style.display = 'none'; return; }
    const r = current.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    const cn = typeof current.className === 'string' ? current.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    tip.textContent = 'pick ' + field + ': <' + current.tagName.toLowerCase() + (cn ? '.' + cn : '') + '>' + (locked ? ' [locked]' : '') +
      '   click = lock | 1-4 or click a row = choose | Up/Down = parent/child | Enter = confirm | Esc = cancel';
  }
  function hit(x, y) {
    overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = 'auto';
    if (el && !card.contains(el) && el !== overlay && el !== box && el !== tip && el !== document.documentElement && el !== document.body) {
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null, null); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      if (list.length === 0) { finish([], null); return; }
      const c = list[sel];
      if (c.rating === 'will-break' && !armed) { armed = true; renderCard(); return; }
      finish(list, c.selector);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < list.length) {
        e.preventDefault();
        e.stopPropagation();
        sel = i;
        armed = false;
        locked = true;
        renderCard();
        draw();
      }
      return;
    }
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
    card.remove();
    if (globalThis.__dsc_picker_cancel === cleanup) delete globalThis.__dsc_picker_cancel;
  }
  function finish(candidates, chosen) {
    cleanup();
    try {
      chrome.runtime.sendMessage({ type: 'dsc_picker_result', pickId, field, candidates, chosen: chosen || null }).catch(() => {});
    } catch (_) { /* extension reloaded mid-pick */ }
  }

  document.documentElement.append(overlay, box, tip, card);
  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('click', onClick, true);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', draw, true);
  window.addEventListener('resize', draw, true);
  globalThis.__dsc_picker_cancel = cleanup;
  tip.textContent = 'pick ' + field + ': move over the element, click to lock, Enter to confirm, Esc to cancel';
  renderCard();
})();
