import { h, api, badge, fmtTime, fmtDateTime, table, openForm, toast, can, debounce, state } from '../lib.js';

export async function attendance(box, ctx) {
  const [depts, sites, shifts] = await Promise.all([api('/api/departments'), api('/api/sites'), api('/api/shifts')]);
  const today = state.meta.today;
  const f = {
    date: h('input', { type: 'date', value: today }), q: h('input', { type: 'search', placeholder: 'Employee…' }),
    department: h('select', {}, h('option', { value: '' }, 'All departments'), depts.map((d) => h('option', { value: d.id }, d.name))),
    site: h('select', {}, h('option', { value: '' }, 'All sites'), sites.map((d) => h('option', { value: d.id }, d.name))),
    shift: h('select', {}, h('option', { value: '' }, 'All shifts'), shifts.map((d) => h('option', { value: d.id }, d.name))),
    status: h('select', {}, h('option', { value: '' }, 'All statuses'), ['PRESENT', 'LATE', 'ABSENT', 'PENDING', 'MANUAL_PRESENT', 'MANUAL_ABSENT', 'ON_LEAVE'].map((s) => h('option', { value: s }, s))),
  };
  const review = h('input', { type: 'checkbox' });
  const list = h('div');
  const qs = () => { const p = new URLSearchParams(); for (const [k, el] of Object.entries(f)) if (el.value) p.set(k, el.value); if (review.checked) p.set('review', '1'); return p.toString(); };

  const correct = (a) => openForm(`Correct attendance — ${a.employee_name}`, [
    { name: 'status', label: 'New status', type: 'select', options: [['PRESENT', 'Present'], ['ABSENT', 'Absent']], value: 'PRESENT' },
    { name: 'reason', label: 'Reason (required, saved in the audit log)', type: 'textarea', required: true, hint: 'Example: Router was offline during employee arrival.' }],
    async (b) => { await api(`/api/attendance/${a.id}/correction`, { method: 'POST', body: b }); toast('Attendance corrected'); load(); },
    { note: `Automatic result: ${a.automatic_status}. It is preserved; the manual change is stored separately.` });

  const detail = async (a) => {
    const d = await api(`/api/attendance/${a.id}`);
    openForm('Attendance evidence', [], async () => {}, { note: `${d.employee_name} · ${d.attendance_date} · Device: ${d.device_name || '—'} ${d.mac_address || ''} · Router: ${d.router || '—'} · First seen: ${fmtDateTime(d.first_wifi_seen_at)} · Cutoff: ${d.cutoff_time} (${d.timezone}) · Automatic: ${d.automatic_status} · Final: ${d.final_status}${d.manual_override_reason ? ' · Reason: ' + d.manual_override_reason : ''}` });
  };

  const load = async () => {
    const rows = await api('/api/attendance?' + qs());
    list.replaceChildren(table(['Employee', 'ID', 'Department', 'Date', 'First WiFi seen', 'Start', 'Cutoff', 'Status', 'Router', 'Device', ''],
      rows.map((a) => h('tr', {},
        h('td', {}, a.employee_name), h('td', {}, a.employee_code), h('td', {}, a.department || '—'), h('td', {}, a.attendance_date),
        h('td', {}, fmtTime(a.first_wifi_seen_at, a.timezone)), h('td', {}, a.start_time.slice(0, 5)), h('td', {}, a.cutoff_time.slice(0, 5)),
        h('td', {}, badge(a.final_status), a.needs_review ? h('span', { class: 'badge warn', title: 'Router data was unavailable; review manually' }, ' ⚠ review') : null),
        h('td', {}, a.router || '—'), h('td', {}, a.device_name || '—'),
        h('td', {}, h('button', { class: 'btn sm', onclick: () => detail(a) }, 'Evidence'), ' ', can('attendance:correct') ? h('button', { class: 'btn sm', onclick: () => correct(a) }, 'Correct') : null)))));
  };
  for (const el of Object.values(f)) el.addEventListener(el === f.q ? 'input' : 'change', debounce(load));
  review.addEventListener('change', load);
  ctx.onEvent((ev) => { if (ev.type === 'attendance.updated' || ev.type === 'attendance.finalized') load(); });
  const exportBtn = can('attendance:export') ? h('a', { class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); location.href = '/api/attendance/export?' + qs(); } }, '⇩ Export CSV') : null;
  box.append(h('h2', {}, 'Attendance'), h('div', { class: 'toolbar' }, Object.values(f), h('label', {}, review, ' Needs review'), exportBtn), h('div', { class: 'card' }, list));
  await load();
}
