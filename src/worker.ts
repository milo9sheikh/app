import { createPool } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { finalizeDue, openDay } from './services/attendance.ts';
import { syncRouter } from './services/sync.ts';
import type { RouterRow } from './services/sync.ts';

/**
 * Background worker: router polling, day opening and finalization. Runs as its own process, never inside a request.
 * Due routers are claimed with FOR UPDATE SKIP LOCKED so several workers cannot poll the same router twice.
 */
const pool = createPool();
let stopping = false;

async function pollDue(): Promise<void> {
  const client = await pool.connect();
  let due: RouterRow[] = [];
  try {
    await client.query('BEGIN');
    due = (await client.query(
      `SELECT * FROM routers WHERE is_active AND next_poll_at <= now() ORDER BY next_poll_at LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
    // Claim: push next_poll_at forward so a crash mid-sync cannot cause a hot loop.
    if (due.length) await client.query(`UPDATE routers SET next_poll_at = now() + interval '60 seconds' WHERE id = ANY($1)`, [due.map((r) => r.id)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await Promise.all(due.map((r) => syncRouter(pool, r).catch((e) => console.error('sync crashed', r.id, e instanceof Error ? e.message : e))));
}

let lastMaintenance = 0;
async function maintenance(): Promise<void> {
  if (Date.now() - lastMaintenance < 60_000) return;
  lastMaintenance = Date.now();
  const now = new Date();
  const opened = await openDay(pool, now);
  const f = await finalizeDue(pool, now);
  if (opened || f.finalized || f.needsReview) {
    console.log(JSON.stringify({ level: 'info', event: 'attendance_finalized', opened, ...f }));
  }
}

async function main(): Promise<void> {
  await migrate(pool);
  console.log(JSON.stringify({ level: 'info', event: 'worker_started' }));
  while (!stopping) {
    try { await pollDue(); await maintenance(); } catch (e) { console.error('worker tick failed:', e instanceof Error ? e.message : e); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await pool.end();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });
main().catch((e) => { console.error(e); process.exit(1); });
