import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.ts';
import type { Pool, PoolClient } from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(pool: Pool): Promise<string[]> {
  const db = await pool.connect();
  try { return await run(db); } finally { db.release(); }
}

async function run(db: PoolClient): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await db.query('BEGIN');
    try {
      await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    ran.push(file);
  }
  return ran;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  migrate(pool).then((r) => { console.log(r.length ? `Applied: ${r.join(', ')}` : 'Database up to date'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
