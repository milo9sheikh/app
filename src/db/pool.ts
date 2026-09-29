import pg from 'pg';

// Return DATE columns as plain 'YYYY-MM-DD' strings (avoid server-timezone Date conversion).
pg.types.setTypeParser(1082, (v: string) => v);
// Return TIME columns as 'HH:MM:SS'.
pg.types.setTypeParser(1083, (v: string) => v);
// bigint -> number (ids/counts stay well below 2^53).
pg.types.setTypeParser(20, (v: string) => Number(v));

export const DEFAULT_DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/attendance';

export function createPool(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle client can be dropped when the database restarts; log it instead of crashing the process.
  pool.on('error', (e) => console.error(JSON.stringify({ level: 'warn', event: 'db_pool_error', message: e.message })));
  return pool;
}
export type Db = pg.Pool | pg.PoolClient;
