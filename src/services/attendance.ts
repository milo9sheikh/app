import type { Pool, PoolClient } from 'pg';
import type { Db } from '../db/pool.ts';
import { calculateAttendance } from '../shared/attendance-rules.ts';
import type { PolicyMode } from '../shared/attendance-rules.ts';
import { localDate, weekdayOf, zonedToUtc } from '../shared/time.ts';
import { audit } from './audit.ts';
import type { AuditContext } from './audit.ts';
import { publish } from './events.ts';

export interface Shift {
  id: string; name: string; start_time: string; cutoff_time: string; end_time: string; timezone: string;
  grace_minutes: number; policy_mode: PolicyMode; working_days: number[]; is_default: boolean;
}
export interface Settings { organization_name: string; timezone: string; finalization_buffer_min: number; max_backoff_seconds: number; retention_days: number }

export async function getSettings(db: Db): Promise<Settings> {
  return (await db.query('SELECT * FROM settings')).rows[0];
}

export function shiftWindow(shift: Shift, date: string) {
  return {
    startAt: zonedToUtc(date, shift.start_time, shift.timezone),
    cutoffAt: zonedToUtc(date, shift.cutoff_time, shift.timezone),
    dayStartAt: zonedToUtc(date, '00:00:00', shift.timezone),
  };
}

export function policyFor(shift: Shift, date: string) {
  const w = shiftWindow(shift, date);
  return { mode: shift.policy_mode, startAt: w.startAt, cutoffAt: w.cutoffAt, graceMinutes: shift.grace_minutes };
}

export interface Sighting {
  mac: string; routerId: string; seenAt: Date; connectedAt?: Date; ip?: string; hostname?: string; signal?: number;
}

/**
 * Handles one observed client. Only a registered, ACTIVE device of an ACTIVE employee can create attendance.
 * Unknown clients are stored for the "Unknown devices" page; disabled devices only leave event history.
 */
export async function recordSighting(pool: Pool, s: Sighting): Promise<void> {
  const dev = (await pool.query(
    `SELECT d.id AS device_id, d.is_active AS device_active, e.id AS employee_id, e.is_active AS employee_active,
            e.name AS employee_name, e.shift_id
       FROM devices d JOIN employees e ON e.id = d.employee_id WHERE d.mac_address = $1`, [s.mac])).rows[0];

  await recordEvent(pool, s, dev?.device_id ?? null);

  if (!dev) {
    await pool.query(
      `INSERT INTO unknown_clients (mac_address, hostname, ip_address, signal_strength, router_id, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (mac_address) DO UPDATE SET hostname = COALESCE(EXCLUDED.hostname, unknown_clients.hostname),
         ip_address = COALESCE(EXCLUDED.ip_address, unknown_clients.ip_address), signal_strength = EXCLUDED.signal_strength,
         router_id = EXCLUDED.router_id, last_seen_at = EXCLUDED.last_seen_at`,
      [s.mac, s.hostname ?? null, s.ip ?? null, s.signal ?? null, s.routerId, s.seenAt]);
    return;
  }
  if (!dev.device_active || !dev.employee_active) return; // disabled: history only, no attendance

  await pool.query('UPDATE devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2) WHERE id = $1', [dev.device_id, s.seenAt]);

  const shift = await shiftFor(pool, dev.shift_id);
  if (!shift) return;
  const date = localDate(s.seenAt, shift.timezone);
  if (!shift.working_days.includes(weekdayOf(date))) return;
  if ((await pool.query('SELECT 1 FROM holidays WHERE date = $1', [date])).rowCount) return;

  // Router-reported connect time is better evidence than our poll time, but only if it is on the same local day.
  let evidence = s.seenAt;
  if (s.connectedAt && s.connectedAt < s.seenAt && localDate(s.connectedAt, shift.timezone) === date) evidence = s.connectedAt;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Earliest evidence wins (LEAST ignores NULL); later reconnects only advance last_wifi_seen_at.
    await client.query(
      `INSERT INTO attendance (employee_id, shift_id, attendance_date, first_wifi_seen_at, last_wifi_seen_at, device_id, router_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (employee_id, shift_id, attendance_date) DO UPDATE SET
         device_id = CASE WHEN attendance.first_wifi_seen_at IS NULL OR EXCLUDED.first_wifi_seen_at < attendance.first_wifi_seen_at
                          THEN EXCLUDED.device_id ELSE attendance.device_id END,
         router_id = CASE WHEN attendance.first_wifi_seen_at IS NULL OR EXCLUDED.first_wifi_seen_at < attendance.first_wifi_seen_at
                          THEN EXCLUDED.router_id ELSE attendance.router_id END,
         first_wifi_seen_at = LEAST(attendance.first_wifi_seen_at, EXCLUDED.first_wifi_seen_at),
         last_wifi_seen_at = GREATEST(attendance.last_wifi_seen_at, EXCLUDED.last_wifi_seen_at),
         updated_at = now()`,
      [dev.employee_id, shift.id, date, evidence, s.seenAt, dev.device_id, s.routerId]);
    const row = (await client.query(
      'SELECT * FROM attendance WHERE employee_id=$1 AND shift_id=$2 AND attendance_date=$3 FOR UPDATE',
      [dev.employee_id, shift.id, date])).rows[0];

    const calc = calculateAttendance(row.first_wifi_seen_at, policyFor(shift, date));
    const protectedRow = row.manual_override || row.final_status === 'ON_LEAVE';
    let finalStatus = row.final_status;
    if (!protectedRow) {
      if (calc !== 'ABSENT') finalStatus = calc;
      else if (row.finalized_at) finalStatus = 'ABSENT';
    }
    const changed = row.automatic_status !== calc || row.final_status !== finalStatus;
    if (changed) {
      await client.query(
        `UPDATE attendance SET automatic_status=$2, final_status=$3, needs_review = CASE WHEN $2 <> 'ABSENT' THEN false ELSE needs_review END,
           calculated_at=now(), finalized_at = CASE WHEN $2 <> 'ABSENT' AND finalized_at IS NULL THEN now() ELSE finalized_at END WHERE id=$1`,
        [row.id, calc, finalStatus]);
    }
    await client.query('COMMIT');
    if (changed || row.first_wifi_seen_at === null) {
      await publish(pool, { type: 'attendance.updated', employeeId: dev.employee_id, employeeName: dev.employee_name,
        status: finalStatus, firstSeenAt: (row.first_wifi_seen_at as Date).toISOString() });
    }
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function shiftFor(db: Db, shiftId: string | null): Promise<Shift | null> {
  const r = shiftId
    ? await db.query('SELECT * FROM shifts WHERE id = $1', [shiftId])
    : await db.query('SELECT * FROM shifts WHERE is_default');
  return r.rows[0] ?? null;
}

/**
 * Event history with de-duplication: repeated polls of one continuous session update last_seen_at on a single row
 * instead of inserting a row per poll. A gap longer than SESSION_GAP_SECONDS starts a RECONNECTED event.
 */
export const SESSION_GAP_SECONDS = 90;
async function recordEvent(pool: Pool, s: Sighting, deviceId: string | null): Promise<void> {
  const last = (await pool.query(
    'SELECT id, event_type, last_seen_at FROM wifi_events WHERE router_id=$1 AND mac_address=$2 ORDER BY id DESC LIMIT 1',
    [s.routerId, s.mac])).rows[0];
  const live = last && last.event_type !== 'DISCONNECTED' && s.seenAt.getTime() - new Date(last.last_seen_at).getTime() <= SESSION_GAP_SECONDS * 1000;
  if (live) {
    await pool.query('UPDATE wifi_events SET last_seen_at = GREATEST(last_seen_at, $2), ip_address = COALESCE($3, ip_address) WHERE id = $1',
      [last.id, s.seenAt, s.ip ?? null]);
    return;
  }
  await pool.query(
    `INSERT INTO wifi_events (router_id, device_id, mac_address, event_type, first_seen_at, last_seen_at, ip_address, hostname, raw_source)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'poll')`,
    [s.routerId, deviceId, s.mac, last ? 'RECONNECTED' : 'CONNECTED', s.seenAt, s.ip ?? null, s.hostname ?? null]);
}

/** Create PENDING rows for today's working day (ON_LEAVE when approved leave exists). Idempotent. */
export async function openDay(db: Db, now: Date): Promise<number> {
  let created = 0;
  for (const shift of (await db.query('SELECT * FROM shifts')).rows as Shift[]) {
    const date = localDate(now, shift.timezone);
    if (!shift.working_days.includes(weekdayOf(date))) continue;
    if ((await db.query('SELECT 1 FROM holidays WHERE date = $1', [date])).rowCount) continue;
    const r = await db.query(
      `INSERT INTO attendance (employee_id, shift_id, attendance_date, final_status, finalized_at)
       SELECT e.id, $1, $2,
              CASE WHEN l.id IS NOT NULL THEN 'ON_LEAVE' ELSE 'PENDING' END,
              CASE WHEN l.id IS NOT NULL THEN now() END
         FROM employees e
         LEFT JOIN leaves l ON l.employee_id = e.id AND l.status = 'APPROVED' AND $2::date BETWEEN l.from_date AND l.to_date
        WHERE e.is_active AND (e.shift_id = $1 OR (e.shift_id IS NULL AND $3))
       ON CONFLICT (employee_id, shift_id, attendance_date) DO NOTHING`,
      [shift.id, date, shift.is_default]);
    created += r.rowCount ?? 0;
  }
  return created;
}

export interface FinalizeResult { finalized: number; needsReview: number }

/**
 * After cutoff + buffer, resolve unresolved attendance. "No registered device seen" only becomes ABSENT when the
 * relevant routers were healthy for the whole window up to the cutoff; otherwise the row is flagged for manual review
 * instead of being marked absent.
 */
export async function finalizeDue(pool: Pool, now: Date): Promise<FinalizeResult> {
  const { finalization_buffer_min } = await getSettings(pool);
  const res: FinalizeResult = { finalized: 0, needsReview: 0 };
  const rows = (await pool.query(
    `SELECT a.*, e.site_id, e.name AS employee_name FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.finalized_at IS NULL AND a.final_status = 'PENDING' AND a.attendance_date >= (now() - interval '3 days')::date`)).rows;
  const shifts = new Map<string, Shift>();
  for (const r of rows) if (!shifts.has(r.shift_id)) shifts.set(r.shift_id, (await pool.query('SELECT * FROM shifts WHERE id=$1', [r.shift_id])).rows[0]);

  for (const a of rows) {
    const shift = shifts.get(a.shift_id)!;
    const w = shiftWindow(shift, a.attendance_date);
    if (now.getTime() < w.cutoffAt.getTime() + finalization_buffer_min * 60_000) continue;
    const calc = calculateAttendance(a.first_wifi_seen_at, policyFor(shift, a.attendance_date));

    if (calc !== 'ABSENT') {
      await pool.query(`UPDATE attendance SET automatic_status=$2, final_status=$2, finalized_at=$3, calculated_at=$3, needs_review=false, updated_at=$3 WHERE id=$1`, [a.id, calc, now]);
      res.finalized++;
      continue;
    }
    if (await sourcesUnreliable(pool, a.site_id, w.dayStartAt, w.cutoffAt)) {
      if (!a.needs_review) {
        await pool.query('UPDATE attendance SET needs_review=true, updated_at=now() WHERE id=$1', [a.id]);
        res.needsReview++;
      }
      continue; // stays PENDING: never infer absence from missing data
    }
    await pool.query(`UPDATE attendance SET automatic_status='ABSENT', final_status='ABSENT', finalized_at=$2, calculated_at=$2, updated_at=$2 WHERE id=$1`, [a.id, now]);
    res.finalized++;
  }
  if (res.finalized) await publish(pool, { type: 'attendance.finalized', count: res.finalized });
  return res;
}

/** True when we cannot trust "not seen" for this site's employees between windowStart and cutoff. */
export async function sourcesUnreliable(db: Db, siteId: string | null, windowStart: Date, cutoff: Date): Promise<boolean> {
  const routers = (await db.query(
    `SELECT id, last_successful_sync_at FROM routers WHERE is_active AND ($1::uuid IS NULL OR site_id IS NULL OR site_id = $1)`, [siteId])).rows;
  if (!routers.length) return true;
  for (const r of routers) {
    if (!r.last_successful_sync_at) return true;
    const outage = await db.query(
      `SELECT 1 FROM router_outages WHERE router_id=$1 AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2) LIMIT 1`,
      [r.id, windowStart, cutoff]);
    if (outage.rowCount) return true;
  }
  return false;
}

export class ValidationError extends Error {}

/** Manual correction. The automatic result is preserved; who/when/why goes to the audit log. */
export async function correctAttendance(pool: Pool, ctx: AuditContext, id: string, status: unknown, reason: unknown) {
  if (status !== 'PRESENT' && status !== 'ABSENT') throw new ValidationError('status must be PRESENT or ABSENT');
  if (typeof reason !== 'string' || reason.trim().length < 3) throw new ValidationError('A reason is required');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = (await client.query('SELECT * FROM attendance WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!old) { await client.query('ROLLBACK'); return null; }
    const final = status === 'PRESENT' ? 'MANUAL_PRESENT' : 'MANUAL_ABSENT';
    const upd = (await client.query(
      `UPDATE attendance SET final_status=$2, manual_override=true, manual_override_reason=$3, needs_review=false,
              finalized_at=COALESCE(finalized_at, now()), source='MANUAL', updated_at=now() WHERE id=$1 RETURNING *`,
      [id, final, reason.trim()])).rows[0];
    await audit(client, ctx, 'ATTENDANCE_MANUALLY_CHANGED', 'attendance', id,
      { final_status: old.final_status, automatic_status: old.automatic_status }, { final_status: final }, reason.trim());
    await client.query('COMMIT');
    await publish(pool, { type: 'attendance.updated', employeeId: old.employee_id, status: final });
    return upd;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
