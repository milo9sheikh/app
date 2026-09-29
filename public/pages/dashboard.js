import { h, api, badge, fmtTime, state } from '../lib.js';

export async function dashboard(box, ctx) {
  const [s, chart, live, routers] = await Promise.all([api('/api/dashboard/summary'), api('/api/dashboard/chart?days=14'), api('/api/dashboard/live'), api('/api/routers')]);
  const stat = (n, l) => h('div', { class: 'card stat' }, h('b', {}, n), h('span', {}, l));
  const liveList = h('ul', { class: 'live' });
  const renderLive = (rows) => liveList.replaceChildren(...(rows.length ? rows.map((r) => h('li', {},
    h('time', {}, fmtTime(r.last_seen_at)), h('b', {}, r.employee_name),
    h('span', { class: r.event_type === 'DISCONNECTED' ? 'muted' : '' }, r.event_type === 'DISCONNECTED' ? 'Disconnected' : 'Connected'), h('span', { class: 'muted' }, r.router))) : [h('li', { class: 'muted' }, 'No WiFi activity yet.')]));
  renderLive(live);
  ctx.onEvent((ev) => { if (ev.type === 'attendance.updated' || ev.type === 'router.status_changed') refresh(); });
  async function refresh() { if (!liveList.isConnected) return; renderLive(await api('/api/dashboard/live')); }

  const max = Math.max(1, ...chart.daily.map((d) => d.present + d.absent));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Attendance for the last 14 days' }, chart.daily.map((d) => {
    const col = h('div', { class: 'bar', title: `${d.date}: ${d.present} present, ${d.absent} absent` });
    const abs = h('i', { class: 'abs' }); abs.style.height = `${(d.absent / max) * 100}%`;
    const pres = h('i'); pres.style.height = `${(d.present / max) * 100}%`;
    col.append(abs, pres, d.date.slice(8)); return col;
  }));
  const breakdown = (title, rows) => h('div', { class: 'card' }, h('h3', {}, title), rows.length ? h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, `${r.present} present`), h('td', { class: 'muted' }, `${r.absent} absent`))))) : h('div', { class: 'muted' }, 'No data for today.'));

  box.append(...[h('h2', {}, s.holiday ? `Dashboard — HOLIDAY: ${s.holiday}` : 'Dashboard'),
    s.warning ? h('div', { class: 'banner', role: 'alert' }, '⚠ ROUTER OFFLINE / INCOMPLETE DATA — ', s.warning, s.needs_review ? ` (${s.needs_review} need review)` : '') : null,
    h('div', { class: 'grid cols-5' }, stat(s.total_employees, 'Total employees'), stat(s.present, 'Present'), stat(s.absent, 'Absent'), stat(s.pending, 'Pending'), stat(`${s.attendance_percent}%`, 'Attendance')),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Attendance — last 14 days'), h('div', { class: 'muted' }, 'green = present, red = absent'), bars),
      h('div', { class: 'card' }, h('h3', {}, 'Live WiFi activity'), liveList)),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h3', {}, 'Router health'), routers.length ? h('table', {}, h('tbody', {}, routers.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, badge(r.status)),
        h('td', { class: 'muted' }, r.last_successful_sync_at ? `synced ${fmtTime(r.last_successful_sync_at)}` : 'never synced'))))) : h('div', { class: 'muted' }, 'No routers configured.')),
      breakdown('Today by department', chart.byDepartment)),
    breakdown('Today by site', chart.bySite)].filter(Boolean));
}
