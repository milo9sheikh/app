import { h, api, badge, table, openForm, toast, can, fmtDateTime, state } from '../lib.js';

export async function routers(box, ctx) {
  const sites = await api('/api/sites');
  const list = h('div');
  const fields = (r = {}) => [
    { name: 'name', label: 'Router name', required: true, value: r.name },
    { name: 'type', label: 'Router type', type: 'select', options: state.meta.routerTypes.map((t) => [t, t]), value: r.type },
    { name: 'host', label: 'Host / IP', required: true, value: r.host }, { name: 'port', label: 'Port', type: 'number', value: r.port },
    { name: 'protocol', label: 'Protocol', type: 'select', options: ['https', 'http', 'ssh', 'snmp'].map((p) => [p, p]), value: r.protocol || 'https' },
    { name: 'username', label: 'Username', value: r.username },
    { name: 'password', label: 'Password', type: 'password', hint: r.has_password ? 'Stored encrypted. Leave blank to keep it.' : 'Stored encrypted; never shown again.' },
    { name: 'api_path', label: 'API path', value: r.api_path },
    { name: 'site_id', label: 'Site', type: 'select', options: [['', 'None'], ...sites.map((s) => [s.id, s.name])], value: r.site_id },
    { name: 'poll_interval_seconds', label: 'Polling interval (seconds)', type: 'select', options: [5, 10, 15, 30, 60].map((n) => [n, `${n} sec`]), value: r.poll_interval_seconds || 15 },
    { name: 'is_active', label: 'Enabled', type: 'checkbox', value: r.is_active ?? true }];
  const load = async () => {
    const rows = await api('/api/routers');
    list.replaceChildren(table(['Router', 'Type', 'Host', 'Site', 'Status', 'Last sync', 'Poll', ''], rows.map((r) => h('tr', {},
      h('td', {}, r.name), h('td', {}, r.type), h('td', {}, r.host), h('td', {}, r.site || '—'),
      h('td', { class: 'wrap' }, badge(r.status), r.last_error ? h('div', { class: 'muted' }, r.last_error) : null,
        r.history_supported ? null : h('div', { class: 'muted' }, 'Current clients only: short connections between polls can be missed.')),
      h('td', {}, fmtDateTime(r.last_successful_sync_at)), h('td', {}, `${r.poll_interval_seconds}s`),
      h('td', {}, can('routers:manage') ? [
        h('button', { class: 'btn sm', onclick: async () => { const t = await api(`/api/routers/${r.id}/test`, { method: 'POST', body: {} }); toast(`${t.ok ? '✓' : '✕'} ${t.message}${t.ok ? ` · clients: ${t.connectedClients ?? '?'} · ${t.responseTimeMs} ms` : ''}`); } }, 'Test'), ' ',
        h('button', { class: 'btn sm', onclick: async () => { const s = await api(`/api/routers/${r.id}/sync`, { method: 'POST', body: {} }); toast(s.ok ? `Synced: ${s.clients} clients` : `Sync failed: ${s.error}`); load(); } }, 'Sync now'), ' ',
        h('button', { class: 'btn sm', onclick: () => openForm('Edit router', fields(r), async (b) => { await api(`/api/routers/${r.id}`, { method: 'PUT', body: b }); load(); }) }, 'Edit'), ' ',
        h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Remove ${r.name}?`)) { await api(`/api/routers/${r.id}`, { method: 'DELETE' }); load(); } } }, 'Remove')] : null)))));
  };
  ctx.onEvent((ev) => { if (ev.type === 'router.status_changed') load(); });
  box.append(h('h2', {}, 'Routers'),
    h('div', { class: 'note' }, 'Router credentials are encrypted on the server and are never sent to the browser. If a router cannot be reached, attendance is never inferred from the failed poll; affected records are flagged for review instead.'),
    can('routers:manage') ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm('Add router', fields(), async (b) => { await api('/api/routers', { method: 'POST', body: b }); load(); }) }, '+ Add router')) : null,
    h('div', { class: 'card' }, list));
  await load();
}
