import type { Db } from '../db/pool.ts';

export const CHANNEL = 'attendance_events';

/** Cross-process realtime: the worker publishes, the API relays to browsers over SSE. */
export async function publish(db: Db, event: Record<string, unknown>): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(event).slice(0, 7000)]);
}

/** Insert a notification unless an identical one was raised within the cooldown (prevents spam from repeated failures). */
export async function notifyOnce(db: Db, kind: string, dedupeKey: string, message: string, cooldownMinutes = 30): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO notifications (kind, dedupe_key, message)
     SELECT $1, $2, $3 WHERE NOT EXISTS (
       SELECT 1 FROM notifications WHERE dedupe_key = $2 AND created_at > now() - make_interval(mins => $4))`,
    [kind, dedupeKey, message, cooldownMinutes]);
  return (r.rowCount ?? 0) > 0;
}
