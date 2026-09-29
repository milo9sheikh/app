import type { Pool } from 'pg';
import { getAdapter } from '../adapters/index.ts';
import type { ConnectedWifiClient, RouterConfig, WifiRouterAdapter } from '../adapters/types.ts';
import { normalizeMac } from '../shared/mac.ts';
import { recordSighting, getSettings, SESSION_GAP_SECONDS } from './attendance.ts';
import { decryptSecret } from './crypto.ts';
import { notifyOnce, publish } from './events.ts';

export interface RouterRow {
  id: string; name: string; type: string; host: string; port: number | null; protocol: string; username: string | null;
  encrypted_password: string | null; api_path: string | null; site_id: string | null; poll_interval_seconds: number;
  consecutive_failures: number; last_error?: string | null; last_successful_sync_at: Date | null; status: string;
}

export function toConfig(r: RouterRow): RouterConfig {
  return { id: r.id, name: r.name, type: r.type, host: r.host, port: r.port, protocol: r.protocol, username: r.username,
    password: r.encrypted_password ? decryptSecret(r.encrypted_password) : null, apiPath: r.api_path, siteId: r.site_id };
}

/** Exponential backoff: failures 1-2 retry at the normal interval, then double each time up to maxSeconds. */
export function backoffSeconds(interval: number, failures: number, maxSeconds: number): number {
  if (failures <= 2) return interval;
  return Math.min(interval * 2 ** (failures - 2), Math.max(maxSeconds, interval));
}

export interface SyncResult { ok: boolean; clients: number; error?: string }

/**
 * Polls one router. On ANY adapter failure the sync is recorded as failed and NO absence is inferred:
 * an error is never converted into an empty client list.
 */
export async function syncRouter(pool: Pool, router: RouterRow, now = new Date(), adapter?: WifiRouterAdapter): Promise<SyncResult> {
  const started = Date.now();
  let clients: ConnectedWifiClient[];
  try {
    const a = adapter ?? getAdapter(router.type);
    const got = await a.getConnectedClients(toConfig(router));
    if (!Array.isArray(got)) throw new Error('Adapter returned an invalid response');
    clients = got;
  } catch (e) {
    return recordFailure(pool, router, now, safeMessage(e));
  }

  const seen = new Set<string>();
  for (const c of clients) {
    const mac = normalizeMac(c.macAddress);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    await recordSighting(pool, {
      mac, routerId: router.id, seenAt: now, connectedAt: c.connectedAt, ip: c.ipAddress, hostname: c.hostname, signal: c.signalStrength,
    });
  }
  await markDisconnects(pool, router.id, seen, now);

  const wasDown = router.consecutive_failures > 0 || router.status !== 'ONLINE';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `UPDATE routers SET status='ONLINE', last_successful_sync_at=$2, consecutive_failures=0, last_error=NULL,
              next_poll_at = $2::timestamptz + make_interval(secs => poll_interval_seconds), updated_at=now() WHERE id=$1`, [router.id, now]);
    await c.query('UPDATE router_outages SET ended_at=$2 WHERE router_id=$1 AND ended_at IS NULL', [router.id, now]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (wasDown) {
    await publish(pool, { type: 'router.status_changed', routerId: router.id, name: router.name, status: 'ONLINE' });
    if (router.status === 'OFFLINE' || router.status === 'ERROR') await notifyOnce(pool, 'router_online', `router-online:${router.id}`, `${router.name} is back online`, 5);
  }
  console.log(JSON.stringify({ level: 'info', event: 'router_sync_success', routerId: router.id, connectedClients: clients.length, durationMs: Date.now() - started }));
  return { ok: true, clients: clients.length };
}

async function recordFailure(pool: Pool, router: RouterRow, now: Date, message: string): Promise<SyncResult> {
  const { max_backoff_seconds } = await getSettings(pool);
  const failures = router.consecutive_failures + 1;
  const wait = backoffSeconds(router.poll_interval_seconds, failures, max_backoff_seconds);
  await pool.query(
    `UPDATE routers SET status='ERROR', consecutive_failures=$2, last_failure_at=$3, last_error=$4,
            next_poll_at = $3::timestamptz + make_interval(secs => $5), updated_at=now() WHERE id=$1`,
    [router.id, failures, now, message, wait]);
  // The outage starts at the last good sync: anything between then and recovery is unobserved.
  await pool.query(
    `INSERT INTO router_outages (router_id, started_at) VALUES ($1, COALESCE($2::timestamptz, $3::timestamptz)) ON CONFLICT DO NOTHING`,
    [router.id, router.last_successful_sync_at, now]);
  if (failures === 1) await publish(pool, { type: 'router.status_changed', routerId: router.id, name: router.name, status: 'ERROR' });
  if (failures >= 3) await notifyOnce(pool, 'router_offline', `router-offline:${router.id}`, `${router.name} is offline: attendance data may be incomplete`, 30);
  console.log(JSON.stringify({ level: 'warn', event: 'router_sync_failed', routerId: router.id, failures, error: message }));
  return { ok: false, clients: 0, error: message };
}

/** Record DISCONNECTED once a device has been absent from successful polls for longer than the session gap. */
async function markDisconnects(pool: Pool, routerId: string, present: Set<string>, now: Date): Promise<void> {
  const open = (await pool.query(
    `SELECT DISTINCT ON (mac_address) id, mac_address, device_id, event_type, last_seen_at
       FROM wifi_events WHERE router_id=$1 ORDER BY mac_address, id DESC`, [routerId])).rows;
  for (const ev of open) {
    if (ev.event_type === 'DISCONNECTED' || present.has(ev.mac_address)) continue;
    if (now.getTime() - new Date(ev.last_seen_at).getTime() <= SESSION_GAP_SECONDS * 1000) continue;
    await pool.query(
      `INSERT INTO wifi_events (router_id, device_id, mac_address, event_type, first_seen_at, last_seen_at, raw_source)
       VALUES ($1,$2,$3,'DISCONNECTED',$4,$4,'poll')`, [routerId, ev.device_id, ev.mac_address, ev.last_seen_at]);
  }
}

/** Never leak credentials into stored errors/logs. */
function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/(password|passwd|pwd|token|secret)\s*[=:]\s*\S+/gi, '$1=***').slice(0, 300);
}
