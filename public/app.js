import { h, api, state } from './lib.js';
import { dashboard } from './pages/dashboard.js';
import { attendance } from './pages/attendance.js';
import { employees, unknownDevices } from './pages/employees.js';
import { routers } from './pages/routers.js';
import { shifts, sites, departments, holidays } from './pages/setup.js';
import { users, audit, reports, settingsPage } from './pages/admin.js';
import { can } from './lib.js';

const root = document.getElementById('app');
let view = 'dashboard';
let handlers = [];
let es = null;

const PAGES = {
  dashboard: ['Dashboard', dashboard], attendance: ['Attendance', attendance], employees: ['Employees', employees],
  unknown: ['Unknown devices', unknownDevices, () => can('devices:manage')], routers: ['Routers', routers], shifts: ['Shifts', shifts],
  sites: ['Sites', sites], departments: ['Departments', departments], holidays: ['Holidays', holidays], reports: ['Reports', reports],
  users: ['Users', users, () => can('users:manage')], audit: ['Audit logs', audit, () => can('audit:view')], settings: ['Settings', settingsPage],
};

function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handlers.forEach((fn) => fn(ev)); };
}

function loginScreen() {
  if (es) { es.close(); es = null; }
  const err = h('div', { class: 'error' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  root.replaceChildren(h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    try { state.user = await api('/api/auth/login', { method: 'POST', body: { email: email.value, password: pw.value } }); await boot(); }
    catch (ex) { err.textContent = ex.message; }
  } }, h('h2', {}, 'WiFi Attendance'), h('label', {}, 'Email'), email, h('label', {}, 'Password'), pw, err, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
}

async function render() {
  handlers = [];
  const main = h('main');
  // Pages pass optional (possibly null) children; drop them instead of rendering the text "null".
  main.append = (...kids) => Element.prototype.append.apply(main, kids.flat().filter((k) => k != null && k !== false));
  const clock = h('span', { class: 'muted' });
  const tick = () => { clock.textContent = new Date().toLocaleString('en-GB', { timeZone: state.meta.settings.timezone, dateStyle: 'medium', timeStyle: 'medium' }); };
  tick(); const timer = setInterval(() => { if (!clock.isConnected) return clearInterval(timer); tick(); }, 1000);
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', {}, h('h1', {}, '📶 WiFi Attendance'), Object.entries(PAGES).filter(([, p]) => !p[2] || p[2]()).map(([k, [label]]) =>
      h('button', { class: k === view ? 'active' : '', onclick: () => { view = k; render(); } }, label))),
    h('div', {}, h('div', { class: 'top' }, h('b', {}, state.meta.settings.organization_name), h('span', { class: 'grow' }), clock,
      h('span', {}, `${state.user.name} · ${state.user.role}`), h('button', { class: 'btn sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); state.user = null; loginScreen(); } }, 'Sign out')), main)));
  try { await PAGES[view][1](main, { onEvent: (fn) => handlers.push(fn) }); }
  catch (e) { main.append(h('div', { class: 'error' }, e.message)); }
}

async function boot() {
  state.meta = await api('/api/meta');
  state.meta.today = new Intl.DateTimeFormat('en-CA', { timeZone: state.meta.settings.timezone }).format(new Date());
  connectEvents();
  await render();
}

state.onUnauth = () => { state.user = null; loginScreen(); };
(async () => {
  try { state.user = await api('/api/auth/me'); await boot(); } catch { loginScreen(); }
})();
