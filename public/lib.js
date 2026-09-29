// Small DOM + fetch helpers. All dynamic text goes through textContent (no innerHTML) so data can never inject markup.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export const state = { user: null, meta: null, onUnauth: () => {} };

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.includes('/auth/login')) { state.onUnauth(); throw new Error('Session expired'); }
  const ct = res.headers.get('content-type') || '';
  const data = res.status === 204 ? null : ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
  return data;
}

export function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

export const can = (p) => !!state.meta && state.meta.permissions.includes(p);
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function fmtTime(iso, tz) {
  return iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz || state.meta.settings.timezone }) : '—';
}
export function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: state.meta.settings.timezone }) : '—';
}

const STATUS = {
  PRESENT: ['ok', '✓ Present'], LATE: ['warn', '◔ Late'], ABSENT: ['bad', '✕ Absent'], PENDING: ['info', '… Pending'],
  MANUAL_PRESENT: ['ok', '✓ Present (manual)'], MANUAL_ABSENT: ['bad', '✕ Absent (manual)'], ON_LEAVE: ['mute', '⌂ On leave'],
  ONLINE: ['ok', '● Online'], OFFLINE: ['bad', '○ Offline'], ERROR: ['bad', '⚠ Error'], SYNCING: ['info', '↻ Syncing'],
};
export const badge = (s) => { const [c, l] = STATUS[s] || ['mute', s]; return h('span', { class: `badge ${c}` }, l); };

export function table(heads, rows, empty = 'Nothing here yet.') {
  return h('div', { class: 'tbl' }, h('table', {},
    h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: heads.length, class: 'muted' }, empty)))));
}

/** Modal form. fields: [{name,label,type,options:[[v,l]],value,required,hint}] */
export function openForm(title, fields, onSave, { note } = {}) {
  const err = h('div', { class: 'error' }); const inputs = {};
  const form = h('form', { method: 'dialog' }, h('h3', {}, title), note ? h('div', { class: 'note' }, note) : null,
    fields.map((f) => {
      let input;
      if (f.type === 'select') input = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)));
      else if (f.type === 'textarea') { input = h('textarea', { rows: 3 }); input.value = f.value ?? ''; }
      else if (f.type === 'checkbox') { input = h('input', { type: 'checkbox', checked: !!f.value }); }
      else { input = h('input', { type: f.type || 'text', required: !!f.required, autocomplete: 'off', placeholder: f.placeholder || '' }); input.value = f.value ?? ''; }
      inputs[f.name] = input;
      return [h('label', {}, f.label), input, f.hint ? h('div', { class: 'muted' }, f.hint) : null];
    }), err,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  const dlg = h('dialog', {}, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of fields) body[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
    try { await onSave(body); dlg.close(); } catch (ex) { err.textContent = ex.message; }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

export const MAC_WARNING = 'WiFi attendance depends on the device identifier reported by the WiFi network. Some smartphones use private/randomized WiFi addresses. If a device changes its WiFi identifier, the system may not recognize it as the registered employee device.';
