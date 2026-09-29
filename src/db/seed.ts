import { fileURLToPath } from 'node:url';
import { createPool } from './pool.ts';
import { migrate } from './migrate.ts';
import { hashPassword } from '../services/crypto.ts';

/** Demo data: one site, department, the default General shift, a MOCK router and a few employees. Safe to re-run. */
const pool = createPool();
await migrate(pool);
const one = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];

const site = await one(`INSERT INTO sites (name) VALUES ('Head Office') ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
const dept = await one(`INSERT INTO departments (name) VALUES ('R&D') ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
const shift = await one(`INSERT INTO shifts (name,start_time,cutoff_time,end_time,timezone,is_default) VALUES ('General','09:00','09:15','18:00','Asia/Dhaka',true)
  ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
const router = await one(`INSERT INTO routers (name,type,host,protocol,site_id,api_path,poll_interval_seconds) VALUES ('Office AP-01','MOCK','192.168.1.1','http',$1,'',15)
  ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [site.id]);
const people: [string, string, string][] = [['EMP001', 'Rahim', 'AA:BB:CC:DD:EE:01'], ['EMP002', 'Karim', 'AA:BB:CC:DD:EE:02'], ['EMP003', 'Sumaiya', 'AA:BB:CC:DD:EE:03'], ['EMP004', 'Mahi', 'AA:BB:CC:DD:EE:04']];
for (const [code, name, mac] of people) {
  const e = await one(`INSERT INTO employees (employee_code,name,department_id,site_id,shift_id) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (employee_code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name, dept.id, site.id, shift.id]);
  await pool.query(`INSERT INTO devices (employee_id, mac_address, device_name, device_type) VALUES ($1,$2,'Phone','mobile') ON CONFLICT (mac_address) DO NOTHING`, [e.id, mac]);
}
if (process.env.SEED_ADMIN_PASSWORD) {
  await pool.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('admin@example.com','Administrator','SUPER_ADMIN',$1) ON CONFLICT (email) DO NOTHING`, [hashPassword(process.env.SEED_ADMIN_PASSWORD)]);
}
console.log(`Seeded demo data (router ${router.id}). MOCK router: put MAC addresses (comma separated) in its "API path" to simulate connections.`);
await pool.end();
