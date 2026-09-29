import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import { freshDb, dhaka } from './helpers.ts';
import { createApp } from '../src/api/server.ts';
import { hashPassword } from '../src/services/crypto.ts';
import { MockRouterState } from '../src/adapters/mock.ts';
import { openDay } from '../src/services/attendance.ts';

let pool: Pool, server: Server, base: string;
const cookies: Record<string, string> = {};

before(async () => {
  pool = await freshDb();
  for (const [email, role] of [['super@t.com', 'SUPER_ADMIN'], ['admin@t.com', 'ADMIN'], ['hr@t.com', 'HR'], ['viewer@t.com', 'VIEWER']]) {
    await pool.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [email, role, role, hashPassword('correct-horse-1')]);
  }
  await pool.query(`INSERT INTO shifts (name,start_time,cutoff_time,end_time,is_default) VALUES ('General','09:00','09:15','18:00',true)`);
  const app = createApp({ pool });
  server = app.server;
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as any).port}`;
  for (const k of ['super', 'admin', 'hr', 'viewer']) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${k}@t.com`, password: 'correct-horse-1' }) });
    cookies[k] = res.headers.get('set-cookie')!.split(';')[0];
  }
});
after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await pool.end(); });

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Cookie: cookies[as] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: res.status === 204 ? null : ct.includes('json') ? await res.json() : await res.text() };
}
const ids: Record<string, string> = {};

test('unauthenticated requests are rejected, bad logins fail', async () => {
  assert.equal((await call(null, 'GET', '/api/employees')).status, 401);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'super@t.com', password: 'nope' }) });
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as any).error.code, 'INVALID_CREDENTIALS');
});

test('RBAC: viewer read-only, HR can correct but not manage devices, only super admin sees routers config/audit/users', async () => {
  const emp = await call('admin', 'POST', '/api/employees', { employee_code: 'E1', name: 'Rahim' });
  assert.equal(emp.status, 201); ids.emp = emp.data.id;
  assert.equal((await call('viewer', 'POST', '/api/employees', { employee_code: 'E2', name: 'X' })).status, 403);
  assert.equal((await call('hr', 'POST', `/api/employees/${ids.emp}/devices`, { mac_address: 'AA:BB:CC:DD:EE:01' })).status, 403);
  assert.equal((await call('admin', 'GET', '/api/audit-logs')).status, 403);
  assert.equal((await call('admin', 'POST', '/api/routers', { name: 'R', type: 'MOCK', host: '1.1.1.1' })).status, 403);
  assert.equal((await call('admin', 'GET', '/api/users')).status, 403);
  assert.equal((await call('super', 'GET', '/api/audit-logs')).status, 200);
});

test('device registration normalizes MAC, rejects duplicates, masks MAC for non-admins', async () => {
  const d = await call('admin', 'POST', `/api/employees/${ids.emp}/devices`, { mac_address: 'aa-bb-cc-dd-ee-01', device_name: 'Phone' });
  assert.equal(d.status, 201); assert.equal(d.data.mac_address, 'AA:BB:CC:DD:EE:01');
  assert.equal((await call('admin', 'POST', `/api/employees/${ids.emp}/devices`, { mac_address: 'AABBCCDDEE01' })).status, 409);
  assert.equal((await call('admin', 'POST', `/api/employees/${ids.emp}/devices`, { mac_address: 'nonsense' })).status, 400);
  const asHr = await call('hr', 'GET', `/api/employees/${ids.emp}`);
  assert.match(asHr.data.devices[0].mac_address, /••/);
});

test('router credentials are encrypted at rest and never returned; errors scrub secrets', async () => {
  const r = await call('super', 'POST', '/api/routers', { name: 'Main', type: 'MOCK', host: '10.0.0.1', username: 'api', password: 'S3cret-Pass!', poll_interval_seconds: 15 });
  assert.equal(r.status, 201);
  assert.equal(JSON.stringify(r.data).includes('S3cret'), false);
  assert.equal(r.data.encrypted_password, undefined); assert.equal(r.data.has_password, true);
  ids.router = r.data.id;
  const stored = (await pool.query('SELECT encrypted_password FROM routers WHERE id=$1', [ids.router])).rows[0].encrypted_password;
  assert.ok(!stored.includes('S3cret'));
  const list = await call('super', 'GET', '/api/routers');
  assert.equal(JSON.stringify(list.data).includes('encrypted_password'), false);
  MockRouterState.setFailing(ids.router, 'auth failed password=S3cret-Pass!');
  const t = await call('super', 'POST', `/api/routers/${ids.router}/test`);
  assert.equal(t.data.ok, false); assert.equal(JSON.stringify(t.data).includes('S3cret'), false);
  MockRouterState.setFailing(ids.router, null);
  assert.equal((await call('super', 'POST', `/api/routers/${ids.router}/test`)).data.ok, true);
});

test('unknown device can be assigned to an employee from the unknown list', async () => {
  MockRouterState.setClients(ids.router, [{ mac: 'AA:BB:CC:DD:EE:77', hostname: 'newphone' }]);
  await call('super', 'POST', `/api/routers/${ids.router}/sync`);
  const unknown = await call('admin', 'GET', '/api/unknown-devices');
  assert.equal(unknown.data[0].mac_address, 'AA:BB:CC:DD:EE:77');
  const a = await call('admin', 'POST', `/api/unknown-devices/AA%3ABB%3ACC%3ADD%3AEE%3A77/assign`, { employee_id: ids.emp });
  assert.equal(a.status, 201);
  assert.equal((await call('admin', 'GET', '/api/unknown-devices')).data.length, 0);
});

test('attendance list, correction requires reason, CSV export is formula-safe', async () => {
  await pool.query(`UPDATE employees SET name = '=cmd|calc' WHERE id=$1`, [ids.emp]);
  await openDay(pool, new Date());
  const today = (await call('viewer', 'GET', '/api/dashboard/summary')).data.date;
  const rows = (await call('viewer', 'GET', `/api/attendance?date=${today}`)).data;
  if (!rows.length) return; // non-working day for the shift: nothing to correct
  const id = rows[0].id;
  assert.equal((await call('hr', 'POST', `/api/attendance/${id}/correction`, { status: 'PRESENT' })).status, 400);
  assert.equal((await call('viewer', 'POST', `/api/attendance/${id}/correction`, { status: 'PRESENT', reason: 'x y z' })).status, 403);
  const ok = await call('hr', 'POST', `/api/attendance/${id}/correction`, { status: 'PRESENT', reason: 'Router outage' });
  assert.equal(ok.data.final_status, 'MANUAL_PRESENT');
  const csv = await call('hr', 'GET', `/api/attendance/export?date=${today}`);
  assert.match(csv.data as string, /'=cmd\|calc/);
  assert.equal((await call('viewer', 'GET', `/api/attendance/export?date=${today}`)).status, 403);
});

test('cross-origin writes blocked, static files served, traversal blocked, health ok', async () => {
  const bad = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: cookies.admin }, body: '{}' });
  assert.equal(bad.status, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
});

test('shift validation rejects bad timezone / times', async () => {
  const base_ = { name: 'Eve', start_time: '17:00', cutoff_time: '17:15', end_time: '23:00', timezone: 'Mars/Base' };
  assert.equal((await call('admin', 'POST', '/api/shifts', base_)).status, 400);
  assert.equal((await call('admin', 'POST', '/api/shifts', { ...base_, timezone: 'Asia/Dhaka' })).status, 201);
  assert.equal((await call('admin', 'POST', '/api/shifts', { ...base_, name: 'Bad', timezone: 'Asia/Dhaka', cutoff_time: '16:00' })).status, 400);
});
