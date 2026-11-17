// providers.js -- Providers page. Lists built-in and config providers, adds/edits/
// deletes providers/<name>.js through the local server, registers content scripts.
'use strict';

const DSC = globalThis.DSC;
const $ = (id) => document.getElementById(id);
const REG_KEY = DSC.STORAGE.REGISTERED;
const BUILTIN = ['deepseek', 'qwen'];
let editing = null;
let server = { up: false, providers: [] };
let rows = [];

function setMsg(text, bad) { const m = $('msg'); m.textContent = text || ''; m.className = bad ? 'bad' : ''; }

async function getCfg() {
  const s = await chrome.storage.local.get([DSC.STORAGE.TOKEN, DSC.STORAGE.PORT]);
  if (!s[DSC.STORAGE.TOKEN]) return null;
  return { token: s[DSC.STORAGE.TOKEN], base: 'http://127.0.0.1:' + (s[DSC.STORAGE.PORT] || DSC.DEFAULT_PORT) };
}

async function api(method, path, body) {
  const cfg = await getCfg();
  if (!cfg) throw Object.assign(new Error('no token configured (open the popup and save one)'), { down: true });
  let res;
  try {
    res = await fetch(cfg.base + path, {
      method,
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_) {
    throw Object.assign(new Error('server unreachable'), { down: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.reason || json.error || ('http_' + res.status)), { status: res.status });
  return json;
}

const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };

function readForm() {
  const sel = { input: lines('f-input'), send: lines('f-send'), response: lines('f-response') };
  if (lines('f-stop').length) sel.stop = lines('f-stop');
  if (lines('f-code').length) sel.code = lines('f-code');
  const def = {
    schema: 1,
    name: $('f-name').value.trim(),
    label: $('f-label').value.trim(),
    domains: lines('f-domains'),
    selectors: sel,
    extraction: $('f-extraction').value,
    completionMode: $('f-mode').value,
  };
  if (lines('f-dismiss').length) def.dismiss = lines('f-dismiss');
  const to = {};
  if (num('f-sendMs') !== undefined) to.sendMs = num('f-sendMs');
  if (num('f-responseMs') !== undefined) to.responseMs = num('f-responseMs');
  if (Object.keys(to).length) def.timeouts = to;
  if (num('f-pacing') !== undefined) def.pacingMs = num('f-pacing');
  if (num('f-stable') !== undefined) def.completionStableMs = num('f-stable');
  if (def.extraction === 'delimiter') def.delimiter = { prefix: $('f-prefix').value, suffix: $('f-suffix').value };
  return def;
}

function fillForm(d) {
  d = d || {};
  const s = d.selectors || {}; const t = d.timeouts || {};
  $('f-name').value = d.name || ''; $('f-label').value = d.label || '';
  $('f-domains').value = (d.domains || []).join('\n');
  $('f-input').value = (s.input || []).join('\n'); $('f-send').value = (s.send || []).join('\n');
  $('f-stop').value = (s.stop || []).join('\n'); $('f-response').value = (s.response || []).join('\n');
  $('f-code').value = (s.code || []).join('\n'); $('f-dismiss').value = (d.dismiss || []).join('\n');
  $('f-sendMs').value = t.sendMs === undefined ? '' : t.sendMs;
  $('f-responseMs').value = t.responseMs === undefined ? '' : t.responseMs;
  $('f-pacing').value = d.pacingMs === undefined ? '' : d.pacingMs;
  $('f-extraction').value = d.extraction || 'rawText';
  $('f-prefix').value = d.delimiter ? d.delimiter.prefix : ''; $('f-suffix').value = d.delimiter ? d.delimiter.suffix : '';
  $('f-mode').value = d.completionMode || 'whichever';
  $('f-stable').value = d.completionStableMs === undefined ? '' : d.completionStableMs;
  $('delim-box').hidden = $('f-extraction').value !== 'delimiter';
  $('f-name').disabled = !!editing;
  $('form-title').textContent = editing ? 'Edit provider: ' + editing : 'Add provider';
}

function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function btn(label, fn) { const b = el('button', label); b.addEventListener('click', fn); return b; }

function render() {
  $('dot').className = 'dot ' + (server.up ? 'green' : 'red');
  $('status').textContent = server.up ? 'server connected' : 'server unreachable (saving falls back to a file download)';
  $('seed').hidden = !(server.up && !server.providers.some((p) => p.name === 'glm'));

  const b = $('builtin'); b.textContent = '';
  for (const n of BUILTIN) {
    const r = el('div', undefined, 'row');
    const g = el('div', undefined, 'grow');
    g.append(el('strong', n + ' '), el('span', 'built-in', 'badge'), el('div', DSC.PROVIDER_HOSTS[n], 'sub'));
    r.append(g); b.append(r);
  }

  const c = $('custom'); c.textContent = '';
  const custom = server.up ? server.providers.filter((p) => p.kind === 'config') : rows.map((r) => ({ name: r.name, definition: null, file: 'providers/' + r.name + '.js' }));
  if (custom.length === 0) c.append(el('div', 'none yet', 'sub'));
  for (const p of custom) {
    const reg = rows.find((x) => x.name === p.name);
    const status = !p.definition && server.up ? 'no DEF markers: edit by hand' : reg ? reg.status : 'not reconciled (Rescan)';
    const r = el('div', undefined, 'row');
    const g = el('div', undefined, 'grow');
    g.append(el('strong', (p.definition ? p.definition.label : p.name) + ' '), el('span', p.name, 'badge'),
      el('div', (p.definition ? p.definition.domains.join(', ') + ' | ' : '') + status, 'sub'));
    r.append(g);
    if (p.definition) {
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = !reg || reg.enabled !== false; cb.title = 'enabled on this machine';
      cb.addEventListener('change', () => toggleEnabled(p, cb.checked));
      r.append(cb);
      r.append(btn('Grant', () => grant(p.definition)));
      r.append(btn('Edit', () => { editing = p.name; fillForm(p.definition); window.scrollTo(0, document.body.scrollHeight); }));
    }
    r.append(btn('Delete', () => del(p)));
    c.append(r);
  }
}

async function refresh() {
  rows = ((await chrome.storage.local.get(REG_KEY))[REG_KEY]) || [];
  try { server = { up: true, providers: (await api('GET', '/providers')).providers }; }
  catch (_) { server = { up: false, providers: [] }; }
  render();
}

async function reconcile() { return chrome.runtime.sendMessage({ type: 'reconcileProviders' }).catch(() => null); }

async function grant(def) {
  const granted = await chrome.permissions.request({ origins: def.domains.map((d) => 'https://' + d + '/*') }).catch(() => false);
  await reconcile(); await refresh();
  setMsg(granted ? 'Permission granted for ' + def.name : 'Permission not granted', !granted);
}

async function toggleEnabled(p, on) {
  const cur = ((await chrome.storage.local.get(REG_KEY))[REG_KEY]) || [];
  const row = cur.find((r) => r.name === p.name);
  if (row) row.enabled = on; else cur.push({ name: p.name, id: 'dsc-provider-' + p.name, domains: p.definition.domains, enabled: on, status: 'pending' });
  await chrome.storage.local.set({ [REG_KEY]: cur });
  await reconcile(); await refresh();
}

async function injectInto(name, origins) {
  const errs = []; let n = 0;
  const tabs = await chrome.tabs.query({ url: origins });
  for (const t of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['shared.js', 'providers/' + name + '.js', 'content.js'] }); n++; }
    catch (e) { errs.push(e.message); }
  }
  return { n, errs };
}

function renderSource(v) {
  const json = JSON.stringify(v, null, 2).replace(/\*\//g, '*\\u002f').replace(/\/\*/g, '\\u002f*');
  return '// providers/' + v.name + '.js -- generated by the deepseek-connect Providers page (schema 1).\n' +
    '// Edit via the Providers page, or by hand; keep the DEF/END markers.\n' +
    "'use strict';\n" +
    'globalThis.DSC.makeConfigProvider(/*DEF*/' + json + '/*END*/);\n';
}

async function fallbackSave(v) {
  const src = renderSource(v);
  try {
    const h = await window.showSaveFilePicker({ suggestedName: v.name + '.js', types: [{ description: 'JavaScript', accept: { 'text/javascript': ['.js'] } }] });
    const w = await h.createWritable(); await w.write(src); await w.close();
  } catch (e) {
    if (e && e.name === 'AbortError') { setMsg('Save cancelled', true); return false; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); a.download = v.name + '.js'; a.click();
  }
  setMsg('Server down: file saved manually. Put it in the repo providers/ directory, then Rescan (registration was skipped).');
  return true;
}

async function saveDefinition(def, isEdit) {
  const v = DSC.validateDefinition(def);
  if (!v.ok) { setMsg(v.errors.join('\n'), true); return false; }
  const value = v.value;
  const origins = value.domains.map((d) => 'https://' + d + '/*');
  let granted = false;
  try { granted = await chrome.permissions.request({ origins }); } catch (_) { granted = false; }
  try {
    if (isEdit) await api('PUT', '/providers/' + value.name, { definition: value });
    else await api('POST', '/providers', { name: value.name, definition: value });
  } catch (e) {
    if (e.down) return fallbackSave(value);
    setMsg('Save failed: ' + e.message, true);
    return false;
  }
  await reconcile();
  const inj = await injectInto(value.name, origins);
  let msg = 'Saved providers/' + value.name + '.js. Permission ' + (granted ? 'granted' : 'NOT granted (use Grant)') +
    '. Injected into ' + inj.n + ' open tab(s).';
  if (inj.errs.length) msg += '\nInjection failed: ' + inj.errs[0] + '\nIf the file was not found, click "Reload extension".';
  if (value.timeouts.responseMs > 300000) msg += '\nNote: responseMs exceeds the aggregator per-prompt timeout (300000).';
  setMsg(msg, inj.errs.length > 0);
  await refresh();
  return true;
}

async function del(p) {
  if (!confirm('Delete provider "' + p.name + '" (removes providers/' + p.name + '.js)?')) return;
  try {
    await api('DELETE', '/providers/' + p.name);
    if (p.definition) await chrome.permissions.remove({ origins: p.definition.domains.map((d) => 'https://' + d + '/*') }).catch(() => {});
    await reconcile();
    if (editing === p.name) { editing = null; fillForm(); }
    setMsg('Deleted ' + p.name);
  } catch (e) { setMsg('Delete failed: ' + e.message, true); }
  await refresh();
}

async function testSelectors() {
  const v = DSC.validateDefinition(readForm());
  if (!v.ok) { setMsg(v.errors.join('\n'), true); return; }
  const origins = v.value.domains.map((d) => 'https://' + d + '/*');
  const tabs = await chrome.tabs.query({ url: origins });
  if (tabs.length === 0) { setMsg('No open tab on ' + v.value.domains.join(', '), true); return; }
  const map = Object.assign({}, v.value.selectors, { dismiss: v.value.dismiss || [] });
  let out = '';
  for (const t of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        args: [map],
        func: (m) => {
          const o = {};
          for (const [k, sels] of Object.entries(m)) {
            o[k] = sels.map((s) => { try { return [s, document.querySelectorAll(s).length]; } catch (_) { return [s, 'invalid']; } });
          }
          return o;
        },
      });
      out += 'tab ' + t.id + ' ' + t.url + '\n';
      for (const [k, list] of Object.entries(res.result)) for (const [s, n] of list) out += '  ' + k + ': ' + n + '  ' + s + '\n';
    } catch (e) { out += 'tab ' + t.id + ': ' + e.message + '\n'; }
  }
  $('results').textContent = out;
  setMsg('Selector counts above (0 = no match; for stop, 0 is expected while idle).');
}

$('f-extraction').addEventListener('change', () => { $('delim-box').hidden = $('f-extraction').value !== 'delimiter'; });
$('save').addEventListener('click', () => saveDefinition(readForm(), !!editing));
$('test').addEventListener('click', testSelectors);
$('clear').addEventListener('click', () => { editing = null; fillForm(); setMsg(''); $('results').textContent = ''; });
$('rescan').addEventListener('click', async () => { await reconcile(); await refresh(); setMsg('Rescanned'); });
$('reload').addEventListener('click', () => chrome.runtime.reload());
$('seed').addEventListener('click', async () => {
  try {
    const def = await (await fetch(chrome.runtime.getURL('seeds/glm.json'))).json();
    await saveDefinition(def, false);
  } catch (e) { setMsg('Seed failed: ' + e.message, true); }
});
chrome.storage.onChanged.addListener((c, a) => { if (a === 'local' && c[REG_KEY]) refresh(); });

fillForm();
refresh();
