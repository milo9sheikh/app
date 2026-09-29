import { h, api, table, openForm, toast, can, fmtDateTime, state } from '../lib.js';

export async function users(box) {
  const list = h('div');
  const load = async () => {
    const rows = await api('/api/users');
    list.replaceChildren(table(['Name', 'Email', 'Role', 'Status', ''], rows.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role), h('td', {}, u.is_active ? 'Active' : 'Deactivated'),
      h('td', {}, u.id === state.user.id ? h('span', { class: 'muted' }, 'you') : [
        h('button', { class: 'btn sm', onclick: () => openForm('Change role', [{ name: 'role', label: 'Role', type: 'select', options: state.meta.roles.map((r) => [r, r]), value: u.role }], async (b) => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: b }); load(); }) }, 'Role'), ' ',
        h('button', { class: 'btn sm', onclick: () => openForm('Reset password', [{ name: 'password', label: 'New password (min 10 chars)', type: 'password', required: true }], async (b) => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: b }); toast('Password changed'); }) }, 'Password'), ' ',
        h('button', { class: 'btn sm danger', onclick: async () => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }); load(); } }, u.is_active ? 'Deactivate' : 'Reactivate')])))));
  };
  box.append(h('h2', {}, 'Users'), h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm('New user', [
    { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Password (min 10 chars)', type: 'password', required: true },
    { name: 'role', label: 'Role', type: 'select', options: state.meta.roles.map((r) => [r, r]), value: 'VIEWER' }], async (b) => { await api('/api/users', { method: 'POST', body: b }); load(); }) }, '+ New user')), h('div', { class: 'card' }, list));
  await load();
}

export async function audit(box) {
  const rows = await api('/api/audit-logs?limit=300');
  const short = (v) => v ? JSON.stringify(v).slice(0, 120) : '';
  box.append(h('h2', {}, 'Audit logs'), h('div', { class: 'card' }, table(['When', 'User', 'Action', 'Entity', 'Change', 'Reason', 'IP'],
    rows.map((r) => h('tr', {}, h('td', {}, fmtDateTime(r.created_at)), h('td', {}, r.user_name || '—'), h('td', {}, r.action), h('td', {}, r.entity_type),
      h('td', { class: 'wrap' }, short(r.old_value), r.old_value ? ' → ' : '', short(r.new_value)), h('td', { class: 'wrap' }, r.reason || ''), h('td', {}, r.ip_address || ''))))));
}

export async function reports(box) {
  const today = state.meta.today;
  const from = h('input', { type: 'date', value: today.slice(0, 8) + '01' }); const to = h('input', { type: 'date', value: today });
  const status = h('select', {}, h('option', { value: '' }, 'All statuses'), ['PRESENT', 'ABSENT', 'LATE', 'PENDING', 'ON_LEAVE'].map((s) => h('option', { value: s }, s)));
  const go = (e) => { e.preventDefault(); const p = new URLSearchParams({ from: from.value, to: to.value }); if (status.value) p.set('status', status.value); location.href = '/api/attendance/export?' + p; };
  box.append(h('h2', {}, 'Reports'), h('div', { class: 'card' }, h('h3', {}, 'Attendance report (CSV)'),
    h('div', { class: 'toolbar' }, h('label', {}, 'From'), from, h('label', {}, 'To'), to, status, can('attendance:export') ? h('button', { class: 'btn primary', onclick: go }, '⇩ Download CSV') : h('span', { class: 'muted' }, 'You do not have export permission.')),
    h('div', { class: 'note' }, 'Excel opens CSV files directly. PDF/Excel-native exports are planned for a later release.')));
}

export async function settingsPage(box) {
  const s = state.meta.settings;
  box.append(h('h2', {}, 'Settings'), h('div', { class: 'card' }, h('h3', {}, 'Organization'),
    h('p', {}, 'Name: ', h('b', {}, s.organization_name)), h('p', {}, 'Timezone: ', h('b', {}, s.timezone)),
    h('p', {}, 'Finalization buffer: ', h('b', {}, `${s.finalization_buffer_min} min after cutoff`)), h('p', {}, 'Max polling backoff: ', h('b', {}, `${s.max_backoff_seconds}s`)),
    can('org:manage') ? h('button', { class: 'btn primary', onclick: () => openForm('Organization settings', [
      { name: 'organization_name', label: 'Organization name', value: s.organization_name }, { name: 'timezone', label: 'Timezone (IANA)', value: s.timezone },
      { name: 'finalization_buffer_min', label: 'Finalization buffer (minutes after cutoff)', type: 'number', value: s.finalization_buffer_min },
      { name: 'max_backoff_seconds', label: 'Max polling backoff (seconds)', type: 'number', value: s.max_backoff_seconds },
      { name: 'retention_days', label: 'Data retention (days)', type: 'number', value: s.retention_days }],
      async (b) => { state.meta.settings = await api('/api/settings', { method: 'PUT', body: b }); toast('Saved'); location.reload(); }) }, 'Edit') : null));
}
