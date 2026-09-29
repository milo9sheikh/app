import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { HttpError, bad, sendJson, readJson, parseCookies, text, oneOf, optUuid, int, timeOfDay, dateStr, isUuid, csvCell } from './http.ts';
import { can, ROLES } from './permissions.ts';
import type { Permission, Role } from './permissions.ts';
import { hashPassword, verifyPassword, sha256, encryptSecret } from '../services/crypto.ts';
import { audit } from '../services/audit.ts';
import type { AuditContext } from '../services/audit.ts';
import { CHANNEL } from '../services/events.ts';
import { correctAttendance, ValidationError, getSettings } from '../services/attendance.ts';
import { normalizeMac, isLocallyAdministeredMac, maskMac } from '../shared/mac.ts';
import { isValidTimezone, localDate } from '../shared/time.ts';
import { ROUTER_TYPES, getAdapter } from '../adapters/index.ts';
import { syncRouter, toConfig } from '../services/sync.ts';
import type { RouterRow } from '../services/sync.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SESSION_SECONDS = 12 * 3600;
const PRESENT_SET = ['PRESENT', 'LATE', 'MANUAL_PRESENT'];
const ABSENT_SET = ['ABSENT', 'MANUAL_ABSENT'];

interface User { id: string; email: string; name: string; role: Role }
interface Ctx {
  req: IncomingMessage; res: ServerResponse; user: User; params: Record<string, string>; query: URLSearchParams;
  body: () => Promise<any>; audit: AuditContext;
}
type Handler = (c: Ctx) => Promise<unknown | void>;
interface Route { method: string; re: RegExp; keys: string[]; perm: Permission | 'public' | 'auth'; handler: Handler }

export interface AppOptions { pool?: Pool; secureCookies?: boolean }

export function createApp(opts: AppOptions = {}) {
  const pool = opts.pool ?? createPool();
  const secureCookies = opts.secureCookies ?? process.env.NODE_ENV === 'production';
  const routes: Route[] = [];
  const sseClients = new Set<ServerResponse>();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  const add = (method: string, p: string, perm: Route['perm'], handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + p.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, perm, handler });
  };
  const uuidParam = (c: Ctx, k = 'id') => { if (!isUuid(c.params[k])) throw new HttpError(404, 'NOT_FOUND', 'Not found'); return c.params[k]; };

  // Helpers reused by several routes ------------------------------------------------------------
  const maskFor = (c: Ctx) => !can(c.user.role, 'devices:view_mac');
  const deviceOut = (c: Ctx, d: any) => ({ ...d, mac_address: maskFor(c) ? maskMac(d.mac_address) : d.mac_address,
    randomized_mac: isLocallyAdministeredMac(d.mac_address) });
  const routerOut = (r: any) => { const { encrypted_password, ...rest } = r; return { ...rest, has_password: !!encrypted_password }; };
  const getRouterRow = async (id: string): Promise<RouterRow> => {
    const r = (await pool.query('SELECT * FROM routers WHERE id=$1', [id])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Router not found');
    return r;
  };

  // ---- auth ------------------------------------------------------------------------------------
  add('POST', '/api/auth/login', 'public', async (c) => {
    const ip = c.audit.ip ?? 'unknown';
    const now = Date.now(); const e = loginAttempts.get(ip);
    if (!e || e.resetAt < now) loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    else if (++e.count > 10) throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts, try again later');
    const b = await c.body();
    const row = typeof b.email === 'string' && typeof b.password === 'string'
      ? (await pool.query('SELECT * FROM users WHERE email=$1 AND is_active', [b.email.trim().toLowerCase()])).rows[0] : null;
    const ok = row ? verifyPassword(b.password, row.password_hash) : (verifyPassword('x', hashPassword('y')), false);
    if (!ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(secs => $3))', [sha256(token), row.id, SESSION_SECONDS]);
    c.res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secureCookies ? '; Secure' : ''}`);
    return { id: row.id, email: row.email, name: row.name, role: row.role };
  });
  add('POST', '/api/auth/logout', 'public', async (c) => {
    const sid = parseCookies(c.req.headers.cookie).sid;
    if (sid) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(sid)]);
    c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  add('GET', '/api/auth/me', 'auth', async (c) => c.user);
  add('GET', '/api/meta', 'auth', async (c) => {
    const s = await getSettings(pool);
    return { routerTypes: ROUTER_TYPES, roles: ROLES, settings: s, permissions: (['attendance:correct', 'attendance:export', 'employees:manage', 'devices:manage', 'routers:manage', 'org:manage', 'users:manage', 'audit:view', 'devices:view_mac'] as Permission[]).filter((p) => can(c.user.role, p)) };
  });

  // ---- sites / departments -----------------------------------------------------------------------
  for (const [table, label] of [['sites', 'SITE'], ['departments', 'DEPARTMENT']] as const) {
    add('GET', `/api/${table}`, 'auth', async () => (await pool.query(`SELECT * FROM ${table} ORDER BY name`)).rows);
    add('POST', `/api/${table}`, 'org:manage', async (c) => {
      const name = text((await c.body()).name, 'name', { required: true, max: 120 });
      const r = (await pool.query(`INSERT INTO ${table} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *`, [name])).rows[0];
      if (!r) throw new HttpError(409, 'DUPLICATE', 'Already exists');
      await audit(pool, c.audit, `${label}_CREATED`, table, r.id, null, r);
      return { status: 201, body: r };
    });
    add('DELETE', `/api/${table}/:id`, 'org:manage', async (c) => {
      const r = (await pool.query(`DELETE FROM ${table} WHERE id=$1 RETURNING *`, [uuidParam(c)])).rows[0];
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      await audit(pool, c.audit, `${label}_DELETED`, table, r.id, r, null);
      return { status: 204 };
    });
  }

  // ---- shifts -----------------------------------------------------------------------------------
  const shiftInput = async (c: Ctx) => {
    const b = await c.body();
    const tz = text(b.timezone ?? 'Asia/Dhaka', 'timezone', { required: true });
    if (!isValidTimezone(tz)) throw bad('timezone is not a valid IANA timezone');
    const days = Array.isArray(b.working_days) ? b.working_days.map((d: unknown) => int(d, 'working_days', 0, 6)) : [6, 0, 1, 2, 3, 4];
    const v = { name: text(b.name, 'name', { required: true, max: 80 }), start_time: timeOfDay(b.start_time, 'start_time'),
      cutoff_time: timeOfDay(b.cutoff_time, 'cutoff_time'), end_time: timeOfDay(b.end_time, 'end_time'), timezone: tz,
      grace_minutes: int(b.grace_minutes ?? 0, 'grace_minutes', 0, 240), policy_mode: oneOf(b.policy_mode ?? 'STRICT', 'policy_mode', ['STRICT', 'LATE', 'GRACE'] as const),
      working_days: [...new Set<number>(days)], is_default: b.is_default === true };
    if (v.cutoff_time < v.start_time) throw bad('cutoff_time must not be before start_time');
    if (v.end_time <= v.cutoff_time) throw bad('end_time must be after cutoff_time (overnight shifts are not supported yet)');
    return v;
  };
  add('GET', '/api/shifts', 'auth', async () => (await pool.query('SELECT * FROM shifts ORDER BY name')).rows);
  add('POST', '/api/shifts', 'org:manage', async (c) => {
    const v = await shiftInput(c);
    if (v.is_default) await pool.query('UPDATE shifts SET is_default=false');
    const r = (await pool.query(
      `INSERT INTO shifts (name,start_time,cutoff_time,end_time,timezone,grace_minutes,policy_mode,working_days,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.name, v.start_time, v.cutoff_time, v.end_time, v.timezone, v.grace_minutes, v.policy_mode, v.working_days, v.is_default])).rows[0];
    await audit(pool, c.audit, 'SHIFT_CREATED', 'shifts', r.id, null, r);
    return { status: 201, body: r };
  });
  add('PUT', '/api/shifts/:id', 'org:manage', async (c) => {
    const id = uuidParam(c); const v = await shiftInput(c);
    const old = (await pool.query('SELECT * FROM shifts WHERE id=$1', [id])).rows[0];
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (v.is_default) await pool.query('UPDATE shifts SET is_default=false WHERE id<>$1', [id]);
    const r = (await pool.query(
      `UPDATE shifts SET name=$2,start_time=$3,cutoff_time=$4,end_time=$5,timezone=$6,grace_minutes=$7,policy_mode=$8,working_days=$9,is_default=$10 WHERE id=$1 RETURNING *`,
      [id, v.name, v.start_time, v.cutoff_time, v.end_time, v.timezone, v.grace_minutes, v.policy_mode, v.working_days, v.is_default])).rows[0];
    await audit(pool, c.audit, 'SHIFT_UPDATED', 'shifts', id, old, r);
    return r;
  });

  // ---- holidays ---------------------------------------------------------------------------------
  add('GET', '/api/holidays', 'auth', async () => (await pool.query('SELECT * FROM holidays ORDER BY date DESC')).rows);
  add('POST', '/api/holidays', 'org:manage', async (c) => {
    const b = await c.body();
    const r = (await pool.query(`INSERT INTO holidays (name,date,description) VALUES ($1,$2,$3) ON CONFLICT (date) DO NOTHING RETURNING *`,
      [text(b.name, 'name', { required: true }), dateStr(b.date, 'date'), text(b.description, 'description', { max: 500 })])).rows[0];
    if (!r) throw new HttpError(409, 'DUPLICATE', 'A holiday already exists on that date');
    await audit(pool, c.audit, 'HOLIDAY_CREATED', 'holidays', r.id, null, r);
    return { status: 201, body: r };
  });
  add('DELETE', '/api/holidays/:id', 'org:manage', async (c) => {
    const r = (await pool.query('DELETE FROM holidays WHERE id=$1 RETURNING *', [uuidParam(c)])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    await audit(pool, c.audit, 'HOLIDAY_DELETED', 'holidays', r.id, r, null);
    return { status: 204 };
  });

  // ---- employees & devices ---------------------------------------------------------------------
  const employeeInput = async (c: Ctx, partial = false) => {
    const b = await c.body();
    const v = { employee_code: text(b.employee_code, 'employee_code', { required: true, max: 40 }), name: text(b.name, 'name', { required: true, max: 120 }),
      phone: text(b.phone, 'phone', { max: 40 }), email: text(b.email, 'email', { max: 160 }), designation: text(b.designation, 'designation', { max: 120 }),
      department_id: optUuid(b.department_id, 'department_id'), site_id: optUuid(b.site_id, 'site_id'), shift_id: optUuid(b.shift_id, 'shift_id'),
      is_active: b.is_active === undefined ? true : b.is_active === true };
    void partial; return v;
  };
  add('GET', '/api/employees', 'employees:view', async (c) => {
    const where: string[] = []; const args: unknown[] = [];
    const q = c.query.get('q'); if (q) { args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(e.name ILIKE $${args.length} OR e.employee_code ILIKE $${args.length})`); }
    for (const [k, col] of [['department', 'e.department_id'], ['site', 'e.site_id']] as const) {
      const v = c.query.get(k); if (v) { args.push(optUuid(v, k)); where.push(`${col} = $${args.length}`); }
    }
    if (c.query.get('active') === '1') where.push('e.is_active');
    return (await pool.query(
      `SELECT e.*, d.name AS department, s.name AS site, sh.name AS shift,
              (SELECT count(*)::int FROM devices dv WHERE dv.employee_id = e.id AND dv.is_active) AS active_devices
         FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN sites s ON s.id=e.site_id LEFT JOIN shifts sh ON sh.id=e.shift_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.name LIMIT 1000`, args)).rows;
  });
  add('POST', '/api/employees', 'employees:manage', async (c) => {
    const v = await employeeInput(c);
    try {
      const r = (await pool.query(
        `INSERT INTO employees (employee_code,name,phone,email,designation,department_id,site_id,shift_id,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [v.employee_code, v.name, v.phone, v.email, v.designation, v.department_id, v.site_id, v.shift_id, v.is_active])).rows[0];
      await audit(pool, c.audit, 'EMPLOYEE_CREATED', 'employees', r.id, null, r);
      return { status: 201, body: r };
    } catch (e) { throw dupOr(e, 'Employee code already exists'); }
  });
  add('GET', '/api/employees/:id', 'employees:view', async (c) => {
    const id = uuidParam(c);
    const e = (await pool.query('SELECT * FROM employees WHERE id=$1', [id])).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const devices = (await pool.query('SELECT * FROM devices WHERE employee_id=$1 ORDER BY created_at', [id])).rows;
    return { ...e, devices: devices.map((d) => deviceOut(c, d)) };
  });
  add('PUT', '/api/employees/:id', 'employees:manage', async (c) => {
    const id = uuidParam(c); const v = await employeeInput(c);
    const old = (await pool.query('SELECT * FROM employees WHERE id=$1', [id])).rows[0];
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    try {
      const r = (await pool.query(
        `UPDATE employees SET employee_code=$2,name=$3,phone=$4,email=$5,designation=$6,department_id=$7,site_id=$8,shift_id=$9,is_active=$10,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, v.employee_code, v.name, v.phone, v.email, v.designation, v.department_id, v.site_id, v.shift_id, v.is_active])).rows[0];
      await audit(pool, c.audit, 'EMPLOYEE_UPDATED', 'employees', id, old, r);
      return r;
    } catch (e) { throw dupOr(e, 'Employee code already exists'); }
  });
  // Employees are deactivated, never hard-deleted: attendance history must stay intact.
  add('DELETE', '/api/employees/:id', 'employees:manage', async (c) => {
    const id = uuidParam(c);
    const r = (await pool.query('UPDATE employees SET is_active=false, updated_at=now() WHERE id=$1 RETURNING *', [id])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    await audit(pool, c.audit, 'EMPLOYEE_DEACTIVATED', 'employees', id, { is_active: true }, { is_active: false });
    return { status: 204 };
  });

  add('GET', '/api/employees/:id/devices', 'employees:view', async (c) =>
    (await pool.query('SELECT * FROM devices WHERE employee_id=$1 ORDER BY created_at', [uuidParam(c)])).rows.map((d) => deviceOut(c, d)));
  add('POST', '/api/employees/:id/devices', 'devices:manage', async (c) => {
    const id = uuidParam(c); const b = await c.body();
    const mac = normalizeMac(b.mac_address);
    if (!mac) throw bad('mac_address is not a valid MAC address');
    try {
      const r = (await pool.query(
        `INSERT INTO devices (employee_id, mac_address, device_name, device_type, router_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, mac, text(b.device_name, 'device_name', { max: 80 }), text(b.device_type ?? 'mobile', 'device_type', { max: 30 }), optUuid(b.router_id, 'router_id')])).rows[0];
      await pool.query('DELETE FROM unknown_clients WHERE mac_address=$1', [mac]);
      await audit(pool, c.audit, 'DEVICE_REGISTERED', 'devices', r.id, null, { employee_id: id, mac_address: mac });
      return { status: 201, body: deviceOut(c, r) };
    } catch (e) { throw dupOr(e, 'That MAC address is already registered', 'Employee not found'); }
  });
  add('PUT', '/api/devices/:id', 'devices:manage', async (c) => {
    const id = uuidParam(c); const b = await c.body();
    const old = (await pool.query('SELECT * FROM devices WHERE id=$1', [id])).rows[0];
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const r = (await pool.query(
      `UPDATE devices SET device_name=$2, device_type=$3, is_active=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, text(b.device_name ?? old.device_name, 'device_name', { max: 80 }), text(b.device_type ?? old.device_type, 'device_type', { max: 30 }),
        b.is_active === undefined ? old.is_active : b.is_active === true])).rows[0];
    await audit(pool, c.audit, r.is_active === old.is_active ? 'DEVICE_UPDATED' : (r.is_active ? 'DEVICE_ENABLED' : 'DEVICE_DISABLED'), 'devices', id,
      { is_active: old.is_active, device_name: old.device_name }, { is_active: r.is_active, device_name: r.device_name });
    return deviceOut(c, r);
  });
  add('DELETE', '/api/devices/:id', 'devices:manage', async (c) => {
    const r = (await pool.query('DELETE FROM devices WHERE id=$1 RETURNING *', [uuidParam(c)])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    await audit(pool, c.audit, 'DEVICE_REMOVED', 'devices', r.id, { employee_id: r.employee_id, mac_address: r.mac_address }, null);
    return { status: 204 };
  });
  add('GET', '/api/devices/:id/history', 'employees:view', async (c) => {
    const d = (await pool.query('SELECT mac_address FROM devices WHERE id=$1', [uuidParam(c)])).rows[0];
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    return (await pool.query(
      `SELECT w.id, w.event_type, w.first_seen_at, w.last_seen_at, r.name AS router FROM wifi_events w JOIN routers r ON r.id=w.router_id
        WHERE w.mac_address=$1 ORDER BY w.id DESC LIMIT 200`, [d.mac_address])).rows;
  });

  // ---- unknown devices --------------------------------------------------------------------------
  add('GET', '/api/unknown-devices', 'devices:manage', async (c) =>
    (await pool.query(
      `SELECT u.*, r.name AS router FROM unknown_clients u LEFT JOIN routers r ON r.id=u.router_id
        WHERE u.status='NEW' ORDER BY u.last_seen_at DESC LIMIT 200`)).rows.map((u) => ({ ...u, randomized_mac: isLocallyAdministeredMac(u.mac_address) })));
  add('POST', '/api/unknown-devices/:mac/assign', 'devices:manage', async (c) => {
    const mac = normalizeMac(decodeURIComponent(c.params.mac)); if (!mac) throw bad('Invalid MAC');
    const b = await c.body();
    const u = (await pool.query('SELECT * FROM unknown_clients WHERE mac_address=$1', [mac])).rows[0];
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Unknown device not found');
    try {
      const r = (await pool.query(`INSERT INTO devices (employee_id, mac_address, device_name, router_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [optUuid(b.employee_id, 'employee_id'), mac, text(b.device_name ?? u.hostname ?? '', 'device_name', { max: 80 }), u.router_id])).rows[0];
      await pool.query('DELETE FROM unknown_clients WHERE mac_address=$1', [mac]);
      await audit(pool, c.audit, 'DEVICE_REGISTERED', 'devices', r.id, null, { employee_id: r.employee_id, mac_address: mac, via: 'unknown-device' });
      return { status: 201, body: deviceOut(c, r) };
    } catch (e) { throw dupOr(e, 'Already registered', 'Employee not found'); }
  });
  add('POST', '/api/unknown-devices/:mac/ignore', 'devices:manage', async (c) => {
    const mac = normalizeMac(decodeURIComponent(c.params.mac)); if (!mac) throw bad('Invalid MAC');
    await pool.query(`UPDATE unknown_clients SET status='IGNORED' WHERE mac_address=$1`, [mac]);
    await audit(pool, c.audit, 'UNKNOWN_DEVICE_IGNORED', 'unknown_clients', mac);
    return { ok: true };
  });

  // ---- routers (credentials never leave the server) ---------------------------------------------
  const routerInput = async (c: Ctx, existing?: any) => {
    const b = await c.body();
    const type = oneOf(b.type, 'type', ROUTER_TYPES as readonly string[]);
    const pw = b.password === undefined || b.password === '' ? undefined : text(b.password, 'password', { max: 200 });
    return { name: text(b.name, 'name', { required: true, max: 80 }), type, host: text(b.host, 'host', { required: true, max: 253 }),
      port: b.port == null || b.port === '' ? null : int(b.port, 'port', 1, 65535), protocol: oneOf(b.protocol ?? 'https', 'protocol', ['http', 'https', 'ssh', 'snmp'] as const),
      username: text(b.username, 'username', { max: 100 }) || null, api_path: text(b.api_path, 'api_path', { max: 200 }) || null,
      site_id: optUuid(b.site_id, 'site_id'), is_active: b.is_active === undefined ? true : b.is_active === true,
      poll_interval_seconds: int(b.poll_interval_seconds ?? 15, 'poll_interval_seconds', 5, 3600),
      encrypted_password: pw !== undefined ? encryptSecret(pw) : existing?.encrypted_password ?? null };
  };
  add('GET', '/api/routers', 'routers:view', async () => {
    const rows = (await pool.query(`SELECT r.*, s.name AS site FROM routers r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.name`)).rows;
    return rows.map((r) => ({ ...routerOut(r), history_supported: getAdapterCaps(r.type) }));
  });
  add('POST', '/api/routers', 'routers:manage', async (c) => {
    const v = await routerInput(c);
    try {
      const r = (await pool.query(
        `INSERT INTO routers (name,type,host,port,protocol,username,encrypted_password,api_path,site_id,is_active,poll_interval_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [v.name, v.type, v.host, v.port, v.protocol, v.username, v.encrypted_password, v.api_path, v.site_id, v.is_active, v.poll_interval_seconds])).rows[0];
      await audit(pool, c.audit, 'ROUTER_ADDED', 'routers', r.id, null, routerOut(r));
      return { status: 201, body: routerOut(r) };
    } catch (e) { throw dupOr(e, 'A router with that name exists'); }
  });
  add('GET', '/api/routers/:id', 'routers:view', async (c) => routerOut(await getRouterRow(uuidParam(c))));
  add('PUT', '/api/routers/:id', 'routers:manage', async (c) => {
    const id = uuidParam(c); const old = await getRouterRow(id) as any; const v = await routerInput(c, old);
    try {
      const r = (await pool.query(
        `UPDATE routers SET name=$2,type=$3,host=$4,port=$5,protocol=$6,username=$7,encrypted_password=$8,api_path=$9,site_id=$10,is_active=$11,poll_interval_seconds=$12,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, v.name, v.type, v.host, v.port, v.protocol, v.username, v.encrypted_password, v.api_path, v.site_id, v.is_active, v.poll_interval_seconds])).rows[0];
      await audit(pool, c.audit, 'ROUTER_UPDATED', 'routers', id, routerOut(old), routerOut(r));
      return routerOut(r);
    } catch (e) { throw dupOr(e, 'A router with that name exists'); }
  });
  add('DELETE', '/api/routers/:id', 'routers:manage', async (c) => {
    const id = uuidParam(c); const old = await getRouterRow(id);
    await pool.query('DELETE FROM routers WHERE id=$1', [id]);
    await audit(pool, c.audit, 'ROUTER_REMOVED', 'routers', id, routerOut(old), null);
    return { status: 204 };
  });
  add('POST', '/api/routers/:id/test', 'routers:manage', async (c) => {
    const row = await getRouterRow(uuidParam(c));
    try {
      const t0 = Date.now();
      const r = await getAdapter(row.type).testConnection(toConfig(row));
      return { ...r, message: scrub(r.message), responseTimeMs: r.responseTimeMs ?? Date.now() - t0 };
    } catch (e) { return { ok: false, authenticated: false, responseTimeMs: 0, message: scrub(e instanceof Error ? e.message : 'Connection failed') }; }
  });
  add('POST', '/api/routers/:id/sync', 'routers:manage', async (c) => {
    const res = await syncRouter(pool, await getRouterRow(uuidParam(c)));
    return res;
  });

  // ---- attendance -----------------------------------------------------------------------------
  const attendanceQuery = (c: Ctx) => {
    const where: string[] = []; const args: unknown[] = [];
    const push = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    const date = c.query.get('date'); if (date) push('a.attendance_date = ?', dateStr(date, 'date'));
    const from = c.query.get('from'); if (from) push('a.attendance_date >= ?', dateStr(from, 'from'));
    const to = c.query.get('to'); if (to) push('a.attendance_date <= ?', dateStr(to, 'to'));
    for (const [k, col] of [['department', 'e.department_id'], ['site', 'e.site_id'], ['shift', 'a.shift_id'], ['employee', 'a.employee_id'], ['router', 'a.router_id']] as const) {
      const v = c.query.get(k); if (v) push(`${col} = ?`, optUuid(v, k));
    }
    const st = c.query.get('status'); if (st) push('a.final_status = ?', oneOf(st, 'status', ['PENDING', 'PRESENT', 'LATE', 'ABSENT', 'MANUAL_PRESENT', 'MANUAL_ABSENT', 'ON_LEAVE'] as const));
    const q = c.query.get('q'); if (q) { args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(e.name ILIKE $${args.length} OR e.employee_code ILIKE $${args.length})`); }
    if (c.query.get('review') === '1') where.push('a.needs_review');
    const sql = `SELECT a.id, a.attendance_date, a.first_wifi_seen_at, a.last_wifi_seen_at, a.automatic_status, a.final_status, a.manual_override,
                        a.manual_override_reason, a.needs_review, a.finalized_at, e.id AS employee_id, e.employee_code, e.name AS employee_name,
                        d.name AS department, s.name AS site, sh.name AS shift, sh.start_time, sh.cutoff_time, sh.timezone,
                        r.name AS router, dv.device_name, dv.mac_address
                   FROM attendance a JOIN employees e ON e.id=a.employee_id JOIN shifts sh ON sh.id=a.shift_id
                   LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN sites s ON s.id=e.site_id
                   LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN devices dv ON dv.id=a.device_id
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.attendance_date DESC, e.name`;
    return { sql, args };
  };
  add('GET', '/api/attendance', 'attendance:view', async (c) => {
    const { sql, args } = attendanceQuery(c);
    const limit = Math.min(Number(c.query.get('limit')) || 500, 2000); const offset = Math.max(Number(c.query.get('offset')) || 0, 0);
    const rows = (await pool.query(`${sql} LIMIT ${limit} OFFSET ${offset}`, args)).rows;
    return rows.map((r) => ({ ...r, mac_address: r.mac_address && maskFor(c) ? maskMac(r.mac_address) : r.mac_address }));
  });
  add('GET', '/api/attendance/summary', 'attendance:view', async (c) => summary(c.query.get('date') ?? undefined));
  add('GET', '/api/attendance/export', 'attendance:export', async (c) => {
    const { sql, args } = attendanceQuery(c);
    const rows = (await pool.query(sql, args)).rows;
    const head = ['Employee ID', 'Employee', 'Department', 'Site', 'Date', 'First WiFi Seen', 'Shift Start', 'Cutoff', 'Automatic Status', 'Final Status', 'Router', 'Manual Reason'];
    const lines = [head.join(',')].concat(rows.map((r) => [r.employee_code, r.employee_name, r.department, r.site, r.attendance_date,
      r.first_wifi_seen_at ? new Date(r.first_wifi_seen_at).toLocaleTimeString('en-GB', { timeZone: r.timezone }) : '', r.start_time, r.cutoff_time,
      r.automatic_status, r.final_status, r.router, r.manual_override_reason].map(csvCell).join(',')));
    await audit(pool, c.audit, 'ATTENDANCE_EXPORTED', 'attendance', null, null, { rows: rows.length });
    return { raw: lines.join('\r\n') + '\r\n', contentType: 'text/csv; charset=utf-8', filename: 'attendance.csv' };
  });
  add('GET', '/api/attendance/:id', 'attendance:view', async (c) => {
    const id = uuidParam(c);
    const a = (await pool.query(
      `SELECT a.*, e.name AS employee_name, e.employee_code, sh.name AS shift, sh.start_time, sh.cutoff_time, sh.timezone, r.name AS router,
              dv.device_name, dv.mac_address FROM attendance a JOIN employees e ON e.id=a.employee_id JOIN shifts sh ON sh.id=a.shift_id
              LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN devices dv ON dv.id=a.device_id WHERE a.id=$1`, [id])).rows[0];
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (a.mac_address && maskFor(c)) a.mac_address = maskMac(a.mac_address);
    a.audit = (await pool.query(`SELECT action, old_value, new_value, reason, created_at, u.name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id
      WHERE l.entity_type='attendance' AND l.entity_id=$1 ORDER BY l.id DESC`, [id])).rows;
    return a;
  });
  add('POST', '/api/attendance/:id/correction', 'attendance:correct', async (c) => {
    const b = await c.body();
    try {
      const r = await correctAttendance(pool, c.audit, uuidParam(c), b.status, b.reason);
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      return r;
    } catch (e) { if (e instanceof ValidationError) throw bad(e.message); throw e; }
  });

  // ---- dashboard ---------------------------------------------------------------------------------
  const summary = async (date?: string) => {
    const s = await getSettings(pool);
    const d = date ? dateStr(date, 'date') : localDate(new Date(), s.timezone);
    const r = (await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE final_status = ANY($2))::int AS present,
              count(*) FILTER (WHERE final_status = ANY($3))::int AS absent,
              count(*) FILTER (WHERE final_status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE final_status = 'ON_LEAVE')::int AS on_leave,
              count(*) FILTER (WHERE needs_review)::int AS needs_review
         FROM attendance WHERE attendance_date = $1`, [d, PRESENT_SET, ABSENT_SET])).rows[0];
    const holiday = (await pool.query('SELECT name FROM holidays WHERE date=$1', [d])).rows[0]?.name ?? null;
    const employees = (await pool.query('SELECT count(*)::int n FROM employees WHERE is_active')).rows[0].n;
    const routers = (await pool.query(`SELECT count(*) FILTER (WHERE status='ONLINE')::int online, count(*) FILTER (WHERE status<>'ONLINE')::int offline FROM routers WHERE is_active`)).rows[0];
    const expected = r.total - r.on_leave;
    return { date: d, holiday, total_employees: employees, ...r, attendance_percent: expected > 0 ? Math.round((r.present / expected) * 1000) / 10 : 0, routers,
      warning: routers.offline > 0 || r.needs_review > 0 ? 'Router data may be incomplete. Attendance for some employees needs manual review.' : null };
  };
  add('GET', '/api/dashboard/summary', 'attendance:view', async (c) => summary(c.query.get('date') ?? undefined));
  add('GET', '/api/dashboard/live', 'attendance:view', async () =>
    (await pool.query(
      `SELECT w.id, w.event_type, w.last_seen_at, w.first_seen_at, e.name AS employee_name, e.employee_code, r.name AS router
         FROM wifi_events w JOIN devices d ON d.id=w.device_id JOIN employees e ON e.id=d.employee_id JOIN routers r ON r.id=w.router_id
        WHERE w.event_type IN ('CONNECTED','RECONNECTED','DISCONNECTED') ORDER BY w.id DESC LIMIT 30`)).rows);
  add('GET', '/api/dashboard/chart', 'attendance:view', async (c) => {
    const s = await getSettings(pool);
    const today = localDate(new Date(), s.timezone);
    const days = Math.min(Number(c.query.get('days')) || 14, 90);
    const daily = (await pool.query(
      `SELECT attendance_date AS date, count(*) FILTER (WHERE final_status = ANY($2))::int AS present, count(*) FILTER (WHERE final_status = ANY($3))::int AS absent
         FROM attendance WHERE attendance_date > ($1::date - $4::int) GROUP BY 1 ORDER BY 1`, [today, PRESENT_SET, ABSENT_SET, days])).rows;
    const byDept = (await pool.query(
      `SELECT COALESCE(d.name,'(none)') AS name, count(*) FILTER (WHERE a.final_status = ANY($2))::int AS present, count(*) FILTER (WHERE a.final_status = ANY($3))::int AS absent
         FROM attendance a JOIN employees e ON e.id=a.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE a.attendance_date=$1 GROUP BY 1 ORDER BY 1`, [today, PRESENT_SET, ABSENT_SET])).rows;
    const bySite = (await pool.query(
      `SELECT COALESCE(s.name,'(none)') AS name, count(*) FILTER (WHERE a.final_status = ANY($2))::int AS present, count(*) FILTER (WHERE a.final_status = ANY($3))::int AS absent
         FROM attendance a JOIN employees e ON e.id=a.employee_id LEFT JOIN sites s ON s.id=e.site_id WHERE a.attendance_date=$1 GROUP BY 1 ORDER BY 1`, [today, PRESENT_SET, ABSENT_SET])).rows;
    return { daily, byDepartment: byDept, bySite };
  });
  add('GET', '/api/notifications', 'attendance:view', async () => (await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 30')).rows);

  // ---- users / settings / audit --------------------------------------------------------------------
  const userCols = 'id, email, name, role, is_active, created_at';
  add('GET', '/api/users', 'users:manage', async () => (await pool.query(`SELECT ${userCols} FROM users ORDER BY name`)).rows);
  add('POST', '/api/users', 'users:manage', async (c) => {
    const b = await c.body();
    const email = text(b.email, 'email', { required: true, max: 160 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('email is invalid');
    if (typeof b.password !== 'string' || b.password.length < 10) throw bad('password must be at least 10 characters');
    try {
      const r = (await pool.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING ${userCols}`,
        [email, text(b.name, 'name', { required: true, max: 120 }), oneOf(b.role ?? 'VIEWER', 'role', ROLES), hashPassword(b.password)])).rows[0];
      await audit(pool, c.audit, 'USER_CREATED', 'users', r.id, null, r);
      return { status: 201, body: r };
    } catch (e) { throw dupOr(e, 'A user with that email already exists'); }
  });
  add('PATCH', '/api/users/:id', 'users:manage', async (c) => {
    const id = uuidParam(c); const b = await c.body();
    const old = (await pool.query(`SELECT ${userCols} FROM users WHERE id=$1`, [id])).rows[0];
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (id === c.user.id && (b.is_active === false || (b.role && b.role !== 'SUPER_ADMIN'))) throw bad('You cannot demote or deactivate yourself');
    if (b.role !== undefined) await pool.query('UPDATE users SET role=$2 WHERE id=$1', [id, oneOf(b.role, 'role', ROLES)]);
    if (b.is_active !== undefined) {
      await pool.query('UPDATE users SET is_active=$2 WHERE id=$1', [id, b.is_active === true]);
      if (b.is_active !== true) await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    }
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 10) throw bad('password must be at least 10 characters');
      await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, hashPassword(b.password)]);
      await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    }
    const r = (await pool.query(`SELECT ${userCols} FROM users WHERE id=$1`, [id])).rows[0];
    await audit(pool, c.audit, 'USER_UPDATED', 'users', id, old, { ...r, password_changed: b.password !== undefined });
    return r;
  });
  add('PUT', '/api/settings', 'org:manage', async (c) => {
    const b = await c.body(); const old = await getSettings(pool);
    const tz = text(b.timezone ?? old.timezone, 'timezone', { required: true });
    if (!isValidTimezone(tz)) throw bad('timezone is invalid');
    await pool.query(`UPDATE settings SET organization_name=$1, timezone=$2, finalization_buffer_min=$3, max_backoff_seconds=$4, retention_days=$5`,
      [text(b.organization_name ?? old.organization_name, 'organization_name', { required: true, max: 120 }), tz,
        int(b.finalization_buffer_min ?? old.finalization_buffer_min, 'finalization_buffer_min', 0, 120),
        int(b.max_backoff_seconds ?? old.max_backoff_seconds, 'max_backoff_seconds', 15, 3600), int(b.retention_days ?? old.retention_days, 'retention_days', 30, 3650)]);
    const now = await getSettings(pool);
    await audit(pool, c.audit, 'SETTINGS_UPDATED', 'settings', null, old, now);
    return now;
  });
  add('GET', '/api/audit-logs', 'audit:view', async (c) => {
    const limit = Math.min(Number(c.query.get('limit')) || 200, 1000);
    const action = c.query.get('action');
    return (await pool.query(
      `SELECT l.*, u.name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ${action ? 'WHERE l.action = $1' : ''} ORDER BY l.id DESC LIMIT ${limit}`,
      action ? [action] : [])).rows;
  });

  // ---- health --------------------------------------------------------------------------------------
  add('GET', '/health', 'public', async () => {
    const db = await pool.query('SELECT 1').then(() => 'ok', () => 'error');
    return { status: db === 'ok' ? 'ok' : 'degraded', database: db };
  });
  add('GET', '/health/database', 'public', async () => { await pool.query('SELECT 1'); return { database: 'ok' }; });
  add('GET', '/health/routers', 'public', async () =>
    (await pool.query(`SELECT count(*) FILTER (WHERE status='ONLINE')::int AS online, count(*) FILTER (WHERE status<>'ONLINE')::int AS offline FROM routers WHERE is_active`)).rows[0]);

  // ---- SSE -----------------------------------------------------------------------------------------
  add('GET', '/api/events', 'attendance:view', async (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write(': connected\n\n');
    sseClients.add(c.res);
    const ka = setInterval(() => c.res.write(': ping\n\n'), 25_000);
    c.req.on('close', () => { clearInterval(ka); sseClients.delete(c.res); });
    return { handled: true };
  });

  let listener: pg.Client | null = null;
  async function startListener() {
    listener = new pg.Client({ connectionString: (pool.options as any).connectionString });
    listener.on('error', () => { listener = null; setTimeout(() => startListener().catch(() => {}), 3000); });
    listener.on('notification', (m) => { for (const r of sseClients) r.write(`data: ${m.payload}\n\n`); });
    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);
  }

  // ---- dispatcher ----------------------------------------------------------------------------------
  async function authenticate(req: IncomingMessage): Promise<User | null> {
    const sid = parseCookies(req.headers.cookie).sid;
    if (!sid) return null;
    const r = (await pool.query(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.is_active`, [sha256(sid)])).rows[0];
    return r ?? null;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    let match: { route: Route; params: Record<string, string> } | null = null; let pathMatched = false;
    for (const route of routes) {
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {}; route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      match = { route, params }; break;
    }
    if (!match) throw pathMatched ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed') : new HttpError(404, 'NOT_FOUND', 'Not found');

    if (method !== 'GET') { // CSRF: same-origin + JSON only
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'CSRF_BLOCKED', 'Cross-origin request blocked');
      const ct = req.headers['content-type'] ?? '';
      if (method !== 'DELETE' && !ct.startsWith('application/json') && match.route.perm !== 'public') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected JSON');
    }
    let user = null as User | null;
    if (match.route.perm !== 'public') {
      user = await authenticate(req);
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Not logged in');
      if (match.route.perm !== 'auth' && !can(user.role, match.route.perm)) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to do that');
    }
    const ip = req.socket.remoteAddress ?? null;
    const ctx: Ctx = { req, res, user: user as User, params: match.params, query: url.searchParams, body: () => readJson(req),
      audit: { userId: user?.id ?? null, ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) } };
    const out: any = await match.route.handler(ctx);
    if (out?.handled) return;
    if (out?.raw !== undefined) {
      res.writeHead(200, { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' });
      return void res.end(out.raw);
    }
    if (out && typeof out === 'object' && typeof out.status === 'number' && ('body' in out || Object.keys(out).length === 1)) return sendJson(res, out.status, out.body);
    sendJson(res, 200, out);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return void res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { success: false, error: { code: e.code, message: e.message } });
      if (e instanceof URIError) return sendJson(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Bad request' } });
      console.error(JSON.stringify({ level: 'error', event: 'unhandled', message: e instanceof Error ? e.message : String(e) }));
      sendJson(res, 500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });
  server.on('close', () => { listener?.end().catch(() => {}); for (const r of sseClients) r.end(); });
  return { server, pool, startListener };
}

function getAdapterCaps(type: string): boolean {
  try { return getAdapter(type).capabilities.connectionHistory; } catch { return false; }
}
const scrub = (m: string) => m.replace(/(password|passwd|pwd|token|secret)\s*[=:]\s*\S+/gi, '$1=***').slice(0, 300);
function dupOr(e: unknown, dupMsg: string, fkMsg = 'Referenced record not found'): Error {
  const code = (e as { code?: string }).code;
  if (code === '23505') return new HttpError(409, 'DUPLICATE', dupMsg);
  if (code === '23503' || code === '22P02') return new HttpError(400, 'VALIDATION_ERROR', fkMsg);
  return e as Error;
}

// ---- entrypoint ---------------------------------------------------------------------------------------
async function bootstrapAdmin(pool: Pool) {
  if ((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n > 0) return;
  const email = (process.env.ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? crypto.randomBytes(12).toString('base64url');
  await pool.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,'Administrator','SUPER_ADMIN',$2)`, [email, hashPassword(password)]);
  console.log(`Created first SUPER_ADMIN: ${email}${process.env.ADMIN_PASSWORD ? '' : ' / ' + password}  (change the password after signing in)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, pool, startListener } = createApp();
  await migrate(pool);
  await bootstrapAdmin(pool);
  await startListener().catch((e) => console.error('SSE listener failed:', e.message));
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(JSON.stringify({ level: 'info', event: 'api_started', port })));
}
