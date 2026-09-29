import { createPool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { MockRouterState } from '../src/adapters/mock.ts';
import type { Pool } from 'pg';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5433/attendance_test';

export async function freshDb(): Promise<Pool> {
  const pool = createPool(TEST_DB);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  MockRouterState.reset();
  return pool;
}

/** 2026-09-29 is a Tuesday. Dhaka is UTC+6, so 09:15 Dhaka = 03:15Z. */
export const dhaka = (hhmm: string, date = '2026-09-29') => new Date(`${date}T${hhmm.length === 5 ? hhmm + ":00" : hhmm}+06:00`);

export async function seedBasics(pool: Pool) {
  const shift = (await pool.query(
    `INSERT INTO shifts (name, start_time, cutoff_time, end_time, is_default) VALUES ('General','09:00','09:15','18:00',true) RETURNING id`)).rows[0];
  const site = (await pool.query(`INSERT INTO sites (name) VALUES ('Head Office') RETURNING id`)).rows[0];
  const routerA = (await pool.query(
    `INSERT INTO routers (name,type,host,site_id,poll_interval_seconds) VALUES ('Router-A','MOCK','10.0.0.1',$1,15) RETURNING *`, [site.id])).rows[0];
  const routerB = (await pool.query(
    `INSERT INTO routers (name,type,host,site_id,poll_interval_seconds) VALUES ('Router-B','MOCK','10.0.0.2',$1,15) RETURNING *`, [site.id])).rows[0];
  const mk = async (code: string, name: string, mac: string | null, active = true) => {
    const e = (await pool.query(`INSERT INTO employees (employee_code,name,site_id) VALUES ($1,$2,$3) RETURNING *`, [code, name, site.id])).rows[0];
    let device = null;
    if (mac) device = (await pool.query(`INSERT INTO devices (employee_id, mac_address, is_active) VALUES ($1,$2,$3) RETURNING *`, [e.id, mac, active])).rows[0];
    return { e, device };
  };
  return { shift, site, routerA, routerB, mk };
}
