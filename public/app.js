'use strict';
const root = document.getElementById('app');
let me = null;
let view = 'dashboard';

// --- helpers -------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { me = null; render(); throw new Error('Session expired'); }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const today = () => new Date().toISOString().slice(0, 10);

// Modal form: fields = [{name,label,type,options,value}]
function openForm(title, fields, onSave) {
  const err = h('div', { class: 'error' });
  const inputs = {};
  const form = h('form', { method: 'dialog' }, h('h3', {}, title),
    fields.map((f) => {
      let input;
      if (f.type === 'select') input = h('select', {}, f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)));
      else if (f.type === 'textarea') { input = h('textarea', { rows: 3 }); input.value = f.value ?? ''; }
      else { input = h('input', { type: f.type || 'text', autocomplete: 'off', required: f.required }); input.value = f.value ?? ''; }
      inputs[f.name] = input;
      return [h('label', {}, f.label), input];
    }), err,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  const dlg = h('dialog', {}, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of fields) body[f.name] = inputs[f.name].value;
    try { await onSave(body); dlg.close(); } catch (ex) { err.textContent = ex.message; }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const table = (heads, rows) => h('div', { class: 'tbl-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))),
  h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: heads.length, class: 'muted' }, 'Nothing here yet.')))));

// --- views ---------------------------------------------------------------
async function dashboardView(box) {
  const d = await api('/dashboard');
  const stat = (n, l, cls = '') => h('div', { class: 'card stat' }, h('b', { class: cls }, n), h('span', {}, l));
  box.append(h('h2', {}, `Welcome, ${me.name}`), h('div', { class: 'stats' },
    stat(d.customers.total, 'Customers'), stat(d.customers.leads, 'Open leads'), stat(d.customers.active, 'Active customers'),
    stat(d.tasks.open, 'Open tasks'), stat(d.tasks.overdue, 'Overdue tasks', d.tasks.overdue ? 'overdue' : ''),
    stat(d.tasks.mine, 'Assigned to me'), stat(d.team, 'Team members')));
}

const CUSTOMER_STATUS = [['lead', 'Lead'], ['active', 'Active'], ['inactive', 'Inactive']];
async function customersView(box) {
  const q = h('input', { type: 'search', placeholder: 'Search customers…' });
  const status = h('select', {}, h('option', { value: '' }, 'All statuses'), CUSTOMER_STATUS.map(([v, l]) => h('option', { value: v }, l)));
  const list = h('div');
  const fields = (c = {}) => [
    { name: 'name', label: 'Name', required: true, value: c.name }, { name: 'company', label: 'Company', value: c.company },
    { name: 'email', label: 'Email', type: 'email', value: c.email }, { name: 'phone', label: 'Phone', value: c.phone },
    { name: 'status', label: 'Status', type: 'select', options: CUSTOMER_STATUS, value: c.status || 'lead' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes }];
  const load = async () => {
    const rows = await api(`/customers?q=${encodeURIComponent(q.value)}&status=${status.value}`);
    list.replaceChildren(table(['Name', 'Company', 'Contact', 'Status', ''], rows.map((c) => h('tr', {},
      h('td', {}, c.name), h('td', {}, c.company), h('td', {}, c.email, c.email && c.phone ? ' · ' : '', c.phone),
      h('td', {}, h('span', { class: 'badge ' + c.status }, c.status)),
      h('td', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => openForm('Edit customer', fields(c), async (b) => { await api('/customers/' + c.id, { method: 'PUT', body: b }); load(); }) }, 'Edit'),
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`Delete ${c.name}?`)) { await api('/customers/' + c.id, { method: 'DELETE' }); load(); } } }, 'Delete'))))));
  };
  q.addEventListener('input', debounce(load)); status.addEventListener('change', load);
  box.append(h('h2', {}, 'Customers'), h('div', { class: 'toolbar' }, q, status,
    h('button', { class: 'btn primary', onclick: () => openForm('New customer', fields(), async (b) => { await api('/customers', { method: 'POST', body: b }); load(); }) }, '+ New customer')),
    h('div', { class: 'card' }, list));
  await load();
}

const TASK_STATUS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
async function tasksView(box) {
  const [users, customers] = await Promise.all([api('/users'), api('/customers')]);
  const userName = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const custName = Object.fromEntries(customers.map((c) => [c.id, c.name]));
  const q = h('input', { type: 'search', placeholder: 'Search tasks…' });
  const status = h('select', {}, h('option', { value: '' }, 'All statuses'), TASK_STATUS.map(([v, l]) => h('option', { value: v }, l)));
  const mine = h('input', { type: 'checkbox', id: 'mine' });
  const list = h('div');
  const fields = (t = {}) => [
    { name: 'title', label: 'Title', required: true, value: t.title }, { name: 'description', label: 'Description', type: 'textarea', value: t.description },
    { name: 'status', label: 'Status', type: 'select', options: TASK_STATUS, value: t.status || 'todo' },
    { name: 'due_date', label: 'Due date', type: 'date', value: t.due_date },
    { name: 'assignee_id', label: 'Assignee', type: 'select', options: [['', 'Unassigned'], ...users.filter((u) => u.active).map((u) => [u.id, u.name])], value: t.assignee_id },
    { name: 'customer_id', label: 'Customer', type: 'select', options: [['', 'None'], ...customers.map((c) => [c.id, c.name])], value: t.customer_id }];
  const load = async () => {
    const rows = await api(`/tasks?q=${encodeURIComponent(q.value)}&status=${status.value}&mine=${mine.checked ? 1 : 0}`);
    list.replaceChildren(table(['Task', 'Assignee', 'Customer', 'Due', 'Status', ''], rows.map((t) => h('tr', {},
      h('td', {}, h('b', {}, t.title), t.description ? h('div', { class: 'muted' }, t.description.slice(0, 100)) : null),
      h('td', {}, userName[t.assignee_id] || '—'), h('td', {}, custName[t.customer_id] || '—'),
      h('td', { class: t.status !== 'done' && t.due_date && t.due_date < today() ? 'overdue' : '' }, t.due_date || '—'),
      h('td', {}, h('span', { class: 'badge ' + t.status }, t.status)),
      h('td', { class: 'row-actions' },
        t.status !== 'done' ? h('button', { class: 'btn', onclick: async () => { await api('/tasks/' + t.id, { method: 'PATCH', body: { status: 'done' } }); load(); } }, '✓ Done') : null,
        h('button', { class: 'btn', onclick: () => openForm('Edit task', fields(t), async (b) => { await api('/tasks/' + t.id, { method: 'PUT', body: b }); load(); }) }, 'Edit'),
        h('button', { class: 'btn danger', onclick: async () => { if (confirm('Delete this task?')) { await api('/tasks/' + t.id, { method: 'DELETE' }); load(); } } }, 'Delete'))))));
  };
  q.addEventListener('input', debounce(load)); status.addEventListener('change', load); mine.addEventListener('change', load);
  box.append(h('h2', {}, 'Tasks'), h('div', { class: 'toolbar' }, q, status,
    h('label', { class: 'muted' }, mine, ' Mine only'),
    h('button', { class: 'btn primary', onclick: () => openForm('New task', fields(), async (b) => { await api('/tasks', { method: 'POST', body: b }); load(); }) }, '+ New task')),
    h('div', { class: 'card' }, list));
  await load();
}

async function teamView(box) {
  const list = h('div');
  const isAdmin = me.role === 'admin';
  const load = async () => {
    const users = await api('/users');
    list.replaceChildren(table(['Name', 'Email', 'Role', 'Status', ...(isAdmin ? [''] : [])], users.map((u) => h('tr', {},
      h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role), h('td', {}, u.active ? 'Active' : h('span', { class: 'muted' }, 'Deactivated')),
      isAdmin ? h('td', { class: 'row-actions' },
        h('button', { class: 'btn', onclick: () => openForm('Reset password', [{ name: 'password', label: 'New password (min 8 chars)', type: 'password', required: true }], async (b) => { await api('/users/' + u.id, { method: 'PATCH', body: b }); }) }, 'Password'),
        u.id !== me.id ? [
          h('button', { class: 'btn', onclick: async () => { await api('/users/' + u.id, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } }); load(); } }, u.role === 'admin' ? 'Make member' : 'Make admin'),
          h('button', { class: 'btn danger', onclick: async () => { await api('/users/' + u.id, { method: 'PATCH', body: { active: !u.active } }); load(); } }, u.active ? 'Deactivate' : 'Reactivate')] : null) : null))));
  };
  box.append(h('h2', {}, 'Team'),
    isAdmin ? h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => openForm('Add team member', [
      { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Initial password (min 8 chars)', type: 'password', required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['member', 'Member'], ['admin', 'Admin']] }],
      async (b) => { await api('/users', { method: 'POST', body: b }); load(); }) }, '+ Add member')) : null,
    h('div', { class: 'card' }, list));
  await load();
}

const VIEWS = { dashboard: ['Dashboard', dashboardView], customers: ['Customers', customersView], tasks: ['Tasks', tasksView], team: ['Team', teamView] };

// --- shell ---------------------------------------------------------------
function loginScreen() {
  const err = h('div', { class: 'error' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    try { me = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } }); render(); }
    catch (ex) { err.textContent = ex.message; }
  } }, h('h2', {}, 'Company Hub'), h('label', {}, 'Email'), email, h('label', {}, 'Password'), pw, err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
  root.replaceChildren(form);
}

async function render() {
  if (!me) return loginScreen();
  const main = h('main');
  root.replaceChildren(
    h('header', {}, h('h1', {}, 'Company Hub'),
      h('nav', {}, Object.entries(VIEWS).map(([key, [label]]) => h('button', { class: key === view ? 'active' : '', onclick: () => { view = key; render(); } }, label))),
      h('span', { class: 'muted' }, me.name),
      h('button', { class: 'btn', onclick: async () => { await api('/logout', { method: 'POST' }); me = null; render(); } }, 'Sign out')),
    main);
  try { await VIEWS[view][1](main); } catch (e) { if (me) main.append(h('div', { class: 'error' }, e.message)); }
}

(async () => {
  try { me = await api('/me'); } catch { me = null; }
  render();
})();
