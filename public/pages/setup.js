import { h, api, table, openForm, toast, can } from '../lib.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function shifts(box) {
  const list = h('div');
  const fields = (s = {}) => [
    { name: 'name', label: 'Name', required: true, value: s.name },
    { name: 'start_time', label: 'Start (HH:MM)', required: true, value: (s.start_time || '09:00').slice(0, 5) },
    { name: 'cutoff_time', label: 'Attendance cutoff (HH:MM)', required: true, value: (s.cutoff_time || '09:15').slice(0, 5) },
    { name: 'end_time', label: 'End (HH:MM)', required: true, value: (s.end_time || '18:00').slice(0, 5) },
    { name: 'timezone', label: 'Timezone', value: s.timezone || 'Asia/Dhaka' },
    { name: 'policy_mode', label: 'Policy', type: 'select', options: [['STRICT', 'Strict: on/before cutoff = present, after = absent'], ['LATE', 'Late: after start but by cutoff = late'], ['GRACE', 'Grace: start + grace minutes = present']], value: s.policy_mode || 'STRICT' },
    { name: 'grace_minutes', label: 'Grace minutes (GRACE policy)', type: 'number', value: s.grace_minutes ?? 0 },
    { name: 'working_days', label: 'Working days (numbers, 0=Sun … 6=Sat, comma separated)', value: (s.working_days || [6, 0, 1, 2, 3, 4]).join(',') },
    { name: 'is_default', label: 'Default shift', type: 'checkbox', value: s.is_default }];
  const parse = (b) => ({ ...b, working_days: b.working_days.split(',').map((x) => x.trim()).filter(Boolean).map(Number) });
  const load = async () => {
    const rows = await api('/api/shifts');
    list.replaceChildren(table(['Shift', 'Start', 'Cutoff', 'End', 'Timezone', 'Policy', 'Working days', ''], rows.map((s) => h('tr', {},
      h('td', {}, s.name, s.is_default ? h('span', { class: 'badge info' }, ' default') : null), h('td', {}, s.start_time.slice(0, 5)), h('td', {}, s.cutoff_time.slice(0, 5)), h('td', {}, s.end_time.slice(0, 5)),
      h('td', {}, s.timezone), h('td', {}, s.policy_mode), h('td', {}, s.working_days.map((d) => DAYS[d]).join(' ')),
      h('td', {}, can('org:manage') ? h('button', { class: 'btn sm', onclick: () => openForm('Edit shift', fields(s), async (b) => { await api(`/api/shifts/${s.id}`, { method: 'PUT', body: parse(b) }); load(); }) }, 'Edit') : null)))));
  };
  box.append(h('h2', {}, 'Shifts'), can('org:manage') ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm('New shift', fields(), async (b) => { await api('/api/shifts', { method: 'POST', body: parse(b) }); load(); }) }, '+ New shift')) : null,
    h('div', { class: 'note' }, 'Cutoff is evaluated in the shift timezone, not the server timezone. Overnight shifts are not supported yet.'), h('div', { class: 'card' }, list));
  await load();
}

function simple(title, path) {
  return async (box) => {
    const list = h('div');
    const load = async () => {
      const rows = await api(path);
      list.replaceChildren(table(['Name', ''], rows.map((r) => h('tr', {}, h('td', {}, r.name),
        h('td', {}, can('org:manage') ? h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Delete ${r.name}?`)) { await api(`${path}/${r.id}`, { method: 'DELETE' }); load(); } } }, 'Delete') : null)))));
    };
    box.append(h('h2', {}, title), can('org:manage') ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm(`New ${title.toLowerCase().replace(/s$/, '')}`, [{ name: 'name', label: 'Name', required: true }], async (b) => { await api(path, { method: 'POST', body: b }); load(); }) }, '+ Add')) : null, h('div', { class: 'card' }, list));
    await load();
  };
}
export const sites = simple('Sites', '/api/sites');
export const departments = simple('Departments', '/api/departments');

export async function holidays(box) {
  const list = h('div');
  const load = async () => {
    const rows = await api('/api/holidays');
    list.replaceChildren(table(['Date', 'Name', 'Description', ''], rows.map((r) => h('tr', {}, h('td', {}, r.date), h('td', {}, r.name), h('td', {}, r.description),
      h('td', {}, can('org:manage') ? h('button', { class: 'btn sm danger', onclick: async () => { await api(`/api/holidays/${r.id}`, { method: 'DELETE' }); load(); } }, 'Delete') : null)))));
  };
  box.append(h('h2', {}, 'Holidays'), h('div', { class: 'note' }, 'No absences are generated on holidays.'),
    can('org:manage') ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm('New holiday', [{ name: 'name', label: 'Name', required: true }, { name: 'date', label: 'Date', type: 'date', required: true }, { name: 'description', label: 'Description' }], async (b) => { await api('/api/holidays', { method: 'POST', body: b }); load(); }) }, '+ Add holiday')) : null,
    h('div', { class: 'card' }, list));
  await load();
}

