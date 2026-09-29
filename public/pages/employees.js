import { h, api, table, openForm, toast, can, debounce, fmtDateTime, MAC_WARNING } from '../lib.js';

export async function employees(box) {
  const [depts, sites, shifts] = await Promise.all([api('/api/departments'), api('/api/sites'), api('/api/shifts')]);
  const q = h('input', { type: 'search', placeholder: 'Search name or ID…' });
  const list = h('div');
  const opts = (rows, none) => [['', none], ...rows.map((r) => [r.id, r.name])];
  const fields = (e = {}) => [
    { name: 'employee_code', label: 'Employee ID', required: true, value: e.employee_code }, { name: 'name', label: 'Name', required: true, value: e.name },
    { name: 'phone', label: 'Phone', value: e.phone }, { name: 'email', label: 'Email', type: 'email', value: e.email }, { name: 'designation', label: 'Designation', value: e.designation },
    { name: 'department_id', label: 'Department', type: 'select', options: opts(depts, 'None'), value: e.department_id },
    { name: 'site_id', label: 'Site', type: 'select', options: opts(sites, 'None'), value: e.site_id },
    { name: 'shift_id', label: 'Shift', type: 'select', options: opts(shifts, 'Default shift'), value: e.shift_id },
    { name: 'is_active', label: 'Active', type: 'checkbox', value: e.is_active ?? true }];

  async function devices(emp) {
    const full = await api(`/api/employees/${emp.id}`);
    const body = h('div');
    const draw = (rows) => body.replaceChildren(table(['Device', 'MAC', 'Type', 'Status', ''], rows.map((d) => h('tr', {},
      h('td', {}, d.device_name || '—'), h('td', {}, d.mac_address, d.randomized_mac ? h('span', { class: 'badge warn', title: 'Locally-administered (private/randomized) address' }, ' ⚠ private MAC') : null),
      h('td', {}, d.device_type), h('td', {}, d.is_active ? 'Active' : 'Disabled'),
      h('td', {}, can('devices:manage') ? [
        h('button', { class: 'btn sm', onclick: async () => { await api(`/api/devices/${d.id}`, { method: 'PUT', body: { is_active: !d.is_active } }); refresh(); } }, d.is_active ? 'Disable' : 'Enable'), ' ',
        h('button', { class: 'btn sm danger', onclick: async () => { if (confirm('Remove this device?')) { await api(`/api/devices/${d.id}`, { method: 'DELETE' }); refresh(); } } }, 'Remove')] : null))), 'No devices registered.'));
    const refresh = async () => { const r = await api(`/api/employees/${emp.id}/devices`); draw(r); load(); };
    draw(full.devices);
    const dlg = h('dialog', {}, h('h3', {}, `${emp.name} — WiFi devices`), h('div', { class: 'note' }, MAC_WARNING), body,
      h('div', { class: 'actions' },
        can('devices:manage') ? h('button', { class: 'btn primary', onclick: () => openForm('Add device', [
          { name: 'mac_address', label: 'MAC address', required: true, placeholder: 'AA:BB:CC:DD:EE:FF', hint: 'Tip: use the Unknown devices page to pick a device that just connected.' },
          { name: 'device_name', label: 'Device name' }, { name: 'device_type', label: 'Type', type: 'select', options: [['mobile', 'Mobile'], ['laptop', 'Laptop'], ['tablet', 'Tablet'], ['other', 'Other']] }],
          async (b) => { await api(`/api/employees/${emp.id}/devices`, { method: 'POST', body: b }); toast('Device registered'); refresh(); }) }, '+ Add device') : null,
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Close')));
    dlg.addEventListener('close', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  }

  const load = async () => {
    const rows = await api(`/api/employees?q=${encodeURIComponent(q.value)}`);
    list.replaceChildren(table(['ID', 'Name', 'Department', 'Site', 'Shift', 'Devices', 'Status', ''], rows.map((e) => h('tr', {},
      h('td', {}, e.employee_code), h('td', {}, e.name), h('td', {}, e.department || '—'), h('td', {}, e.site || '—'), h('td', {}, e.shift || 'Default'),
      h('td', {}, String(e.active_devices)), h('td', {}, e.is_active ? 'Active' : h('span', { class: 'muted' }, 'Inactive')),
      h('td', {}, h('button', { class: 'btn sm', onclick: () => devices(e) }, 'Devices'), ' ',
        can('employees:manage') ? h('button', { class: 'btn sm', onclick: () => openForm('Edit employee', fields(e), async (b) => { await api(`/api/employees/${e.id}`, { method: 'PUT', body: b }); load(); }) }, 'Edit') : null)))));
  };
  q.addEventListener('input', debounce(load));
  box.append(h('h2', {}, 'Employees'), h('div', { class: 'toolbar' }, q,
    can('employees:manage') ? h('button', { class: 'btn primary', onclick: () => openForm('New employee', fields(), async (b) => { await api('/api/employees', { method: 'POST', body: b }); toast('Employee created'); load(); }) }, '+ New employee') : null),
    h('div', { class: 'card' }, list));
  await load();
}

export async function unknownDevices(box, ctx) {
  const emps = await api('/api/employees?active=1');
  const list = h('div');
  const load = async () => {
    const rows = await api('/api/unknown-devices');
    list.replaceChildren(table(['MAC', 'Hostname', 'IP', 'Signal', 'Router', 'First seen', 'Last seen', ''], rows.map((u) => h('tr', {},
      h('td', {}, u.mac_address, u.randomized_mac ? h('span', { class: 'badge warn' }, ' ⚠ private MAC') : null), h('td', {}, u.hostname || '—'), h('td', {}, u.ip_address || '—'),
      h('td', {}, u.signal_strength ?? '—'), h('td', {}, u.router || '—'), h('td', {}, fmtDateTime(u.first_seen_at)), h('td', {}, fmtDateTime(u.last_seen_at)),
      h('td', {}, h('button', { class: 'btn sm primary', onclick: () => openForm('Assign device to employee', [
        { name: 'employee_id', label: 'Employee', type: 'select', options: emps.map((e) => [e.id, `${e.name} (${e.employee_code})`]) },
        { name: 'device_name', label: 'Device name', value: u.hostname || '' }],
        async (b) => { await api(`/api/unknown-devices/${encodeURIComponent(u.mac_address)}/assign`, { method: 'POST', body: b }); toast('Device registered'); load(); }) }, 'Assign'), ' ',
        h('button', { class: 'btn sm', onclick: async () => { await api(`/api/unknown-devices/${encodeURIComponent(u.mac_address)}/ignore`, { method: 'POST', body: {} }); load(); } }, 'Ignore')))), 'No unknown devices detected.'));
  };
  box.append(h('h2', {}, 'Unknown WiFi devices'), h('div', { class: 'note' }, 'Unknown devices never create attendance. Have the employee connect to the WiFi, then assign the device that appears here. ', MAC_WARNING),
    h('div', { class: 'card' }, list));
  await load();
}
