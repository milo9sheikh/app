import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { freshDb, dhaka, seedBasics } from './helpers.ts';
import { MockRouterState, MockAdapter } from '../src/adapters/mock.ts';
import { syncRouter } from '../src/services/sync.ts';
import type { RouterRow } from '../src/services/sync.ts';
import { finalizeDue, openDay, recordSighting, correctAttendance, ValidationError } from '../src/services/attendance.ts';

let pool: Pool;
let s: Awaited<ReturnType<typeof seedBasics>>;
before(async () => { pool = await freshDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE attendance, wifi_events, unknown_clients, devices, employees, routers, sites, shifts, holidays, router_outages, audit_logs, notifications RESTART IDENTITY CASCADE');
  MockRouterState.reset();
  s = await seedBasics(pool);
});

const fresh = async (id: string): Promise<RouterRow> => (await pool.query('SELECT * FROM routers WHERE id=$1', [id])).rows[0];
const poll = async (router: any, when: string, macs: string[]) => {
  MockRouterState.setClients(router.id, macs.map((mac) => ({ mac })));
  return syncRouter(pool, await fresh(router.id), dhaka(when), new MockAdapter());
};
const att = async (code: string) => (await pool.query(
  `SELECT a.* FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE e.employee_code=$1`, [code])).rows[0];

const MAC1 = 'AA:BB:CC:DD:EE:01', MAC2 = 'AA:BB:CC:DD:EE:02', MAC3 = 'AA:BB:CC:DD:EE:03', UNKNOWN = 'AA:BB:CC:DD:EE:99';

test('integration scenario from the spec: Rahim/Karim present, Sumaiya/no-show absent', async () => {
  await s.mk('EMP001', 'Rahim', MAC1); await s.mk('EMP002', 'Karim', MAC2); await s.mk('EMP003', 'Sumaiya', MAC3); await s.mk('EMP004', 'NoShow', null);
  await openDay(pool, dhaka('08:30'));
  await poll(s.routerA, '08:55', [MAC1]);
  await poll(s.routerA, '09:03', [MAC1, MAC2]);
  await poll(s.routerB, '09:04', []);
  await poll(s.routerA, '09:18', [MAC1, MAC2, MAC3]);
  await poll(s.routerB, '09:19', []);
  await finalizeDue(pool, dhaka('09:20'));
  assert.equal((await att('EMP001')).final_status, 'PRESENT');
  assert.equal((await att('EMP002')).final_status, 'PRESENT');
  const sumaiya = await att('EMP003');
  assert.equal(sumaiya.final_status, 'ABSENT');
  assert.equal(sumaiya.first_wifi_seen_at.toISOString(), dhaka('09:18').toISOString(), 'evidence is kept even though ABSENT');
  assert.equal((await att('EMP004')).final_status, 'ABSENT');
});

test('reconnect never overwrites first seen; polls deduplicate into one event and one attendance row', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await poll(s.routerA, '09:01:00', [MAC1]);
  await poll(s.routerA, '09:01:15', [MAC1]);
  await poll(s.routerA, '09:01:30', [MAC1]);
  await poll(s.routerA, '09:10', []);            // gone
  await poll(s.routerA, '09:14', [MAC1]);        // reconnect
  const a = await att('EMP001');
  assert.equal(a.first_wifi_seen_at.toISOString(), dhaka('09:01').toISOString());
  assert.equal(a.last_wifi_seen_at.toISOString(), dhaka('09:14').toISOString());
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance')).rows[0].n, 1);
  const types = (await pool.query('SELECT event_type FROM wifi_events ORDER BY id')).rows.map((r) => r.event_type);
  assert.deepEqual(types, ['CONNECTED', 'DISCONNECTED', 'RECONNECTED']);
});

test('multiple devices: earliest wins even if a later device is seen first by the poller order', async () => {
  const { e } = await s.mk('EMP001', 'Rahim', MAC1);
  await pool.query(`INSERT INTO devices (employee_id, mac_address) VALUES ($1,$2)`, [e.id, MAC2]);
  await poll(s.routerA, '09:07', [MAC2]);
  await poll(s.routerA, '09:08', [MAC1, MAC2]);
  await poll(s.routerA, '08:59', [MAC1]); // older evidence arriving later (e.g. history replay)
  const a = await att('EMP001');
  assert.equal(a.first_wifi_seen_at.toISOString(), dhaka('08:59').toISOString());
  assert.equal(a.final_status, 'PRESENT');
});

test('one device late but another before cutoff => PRESENT', async () => {
  const { e } = await s.mk('EMP001', 'Rahim', MAC1);
  await pool.query(`INSERT INTO devices (employee_id, mac_address) VALUES ($1,$2)`, [e.id, MAC2]);
  await poll(s.routerA, '08:59', [MAC1]);
  await poll(s.routerA, '09:40', [MAC2]);
  await finalizeDue(pool, dhaka('09:45'));
  assert.equal((await att('EMP001')).final_status, 'PRESENT');
});

test('same employee on router A then router B keeps one attendance record', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await poll(s.routerA, '09:04', [MAC1]);
  await poll(s.routerB, '09:10', [MAC1]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance')).rows[0].n, 1);
  assert.equal((await att('EMP001')).router_id, s.routerA.id);
});

test('unknown device creates no attendance and appears in unknown list', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await poll(s.routerA, '08:30', [UNKNOWN]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT mac_address FROM unknown_clients')).rows[0].mac_address, UNKNOWN);
});

test('disabled device: history kept, no attendance', async () => {
  await s.mk('EMP001', 'Rahim', MAC1, false);
  await poll(s.routerA, '08:30', [MAC1]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wifi_events')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM unknown_clients')).rows[0].n, 0);
});

test('router API failure is NOT treated as zero clients and does not create absence', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await openDay(pool, dhaka('08:30'));
  await poll(s.routerA, '08:45', [MAC2]);                    // healthy poll, employee not there
  MockRouterState.setFailing(s.routerA.id, 'connect ECONNREFUSED password=hunter2');
  const r = await syncRouter(pool, await fresh(s.routerA.id), dhaka('08:50'), new MockAdapter());
  assert.equal(r.ok, false);
  const row = await fresh(s.routerA.id);
  assert.equal(row.status, 'ERROR');
  assert.ok(!row.last_error!.includes('hunter2'), 'secrets must be scrubbed from stored errors');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM wifi_events WHERE event_type='DISCONNECTED'`)).rows[0].n, 0);
  // Router stays down through the cutoff; recovers at 09:20.
  MockRouterState.setFailing(s.routerA.id, null);
  await syncRouter(pool, await fresh(s.routerA.id), dhaka('09:20'), new MockAdapter());
  await poll(s.routerB, '09:20', []);
  const f = await finalizeDue(pool, dhaka('09:21'));
  const a = await att('EMP001');
  assert.equal(f.needsReview, 1);
  assert.equal(a.final_status, 'PENDING', 'must not be blindly ABSENT');
  assert.equal(a.needs_review, true);
});

test('all routers offline at finalization => no mass ABSENT', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await s.mk('EMP002', 'Karim', MAC2);
  await openDay(pool, dhaka('08:30'));
  MockRouterState.setFailing(s.routerA.id, 'down'); MockRouterState.setFailing(s.routerB.id, 'down');
  await syncRouter(pool, await fresh(s.routerA.id), dhaka('08:50'), new MockAdapter());
  await syncRouter(pool, await fresh(s.routerB.id), dhaka('08:50'), new MockAdapter());
  await finalizeDue(pool, dhaka('09:21'));
  const rows = (await pool.query('SELECT final_status, needs_review FROM attendance')).rows;
  assert.ok(rows.every((r) => r.final_status === 'PENDING' && r.needs_review));
});

test('unresolved stays PENDING before cutoff+buffer, and no ABSENT before finalization', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await openDay(pool, dhaka('08:30'));
  await poll(s.routerA, '09:10', []); await poll(s.routerB, '09:10', []);
  await finalizeDue(pool, dhaka('09:16'));     // inside the 5 minute buffer
  assert.equal((await att('EMP001')).final_status, 'PENDING');
  await finalizeDue(pool, dhaka('09:21'));
  assert.equal((await att('EMP001')).final_status, 'ABSENT');
});

test('manual correction needs a reason, preserves the automatic result and is audited immutably', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  await openDay(pool, dhaka('08:30'));
  await poll(s.routerA, '09:10', []); await poll(s.routerB, '09:10', []);
  await finalizeDue(pool, dhaka('09:21'));
  const a = await att('EMP001');
  await assert.rejects(correctAttendance(pool, { userId: null }, a.id, 'PRESENT', ''), ValidationError);
  await correctAttendance(pool, { userId: null, ip: '10.0.0.5' }, a.id, 'PRESENT', 'Router outage during arrival');
  const after = await att('EMP001');
  assert.equal(after.final_status, 'MANUAL_PRESENT');
  assert.equal(after.automatic_status, 'ABSENT');
  const log = (await pool.query('SELECT * FROM audit_logs')).rows[0];
  assert.equal(log.action, 'ATTENDANCE_MANUALLY_CHANGED');
  assert.equal(log.reason, 'Router outage during arrival');
  await assert.rejects(pool.query('UPDATE audit_logs SET action = $1', ['x']), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_logs'), /append-only/);
  // a later WiFi sighting must not undo the manual override
  await poll(s.routerA, '09:30', [MAC1]);
  assert.equal((await att('EMP001')).final_status, 'MANUAL_PRESENT');
});

test('holiday and approved leave are not marked absent', async () => {
  const { e } = await s.mk('EMP001', 'Rahim', MAC1);
  await s.mk('EMP002', 'Karim', MAC2);
  await pool.query(`INSERT INTO leaves (employee_id, from_date, to_date, status) VALUES ($1,'2026-09-29','2026-09-29','APPROVED')`, [e.id]);
  await openDay(pool, dhaka('08:30'));
  await poll(s.routerA, '09:10', []); await poll(s.routerB, '09:10', []);
  await finalizeDue(pool, dhaka('09:21'));
  assert.equal((await att('EMP001')).final_status, 'ON_LEAVE');
  await pool.query(`TRUNCATE attendance`);
  await pool.query(`INSERT INTO holidays (name, date) VALUES ('Holiday','2026-09-29')`);
  assert.equal(await openDay(pool, dhaka('08:30')), 0);
});

test('non-working day (Friday) creates nothing', async () => {
  await s.mk('EMP001', 'Rahim', MAC1);
  assert.equal(await openDay(pool, dhaka('08:30', '2026-10-02')), 0); // 2026-10-02 is a Friday
  await recordSighting(pool, { mac: MAC1, routerId: s.routerA.id, seenAt: dhaka('09:00', '2026-10-02') });
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance')).rows[0].n, 0);
});
