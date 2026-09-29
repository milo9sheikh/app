import pg from 'pg';

/** Creates the database named in DATABASE_URL if it does not exist yet (handy on Windows where psql is not on PATH). */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set (check your .env file).'); process.exit(1); }
const target = new URL(url);
const dbName = decodeURIComponent(target.pathname.slice(1));
if (!/^[A-Za-z0-9_]+$/.test(dbName)) { console.error('Database name may only contain letters, digits and underscore.'); process.exit(1); }
target.pathname = '/postgres';
const client = new pg.Client({ connectionString: target.toString() });
try {
  await client.connect();
} catch (e) {
  console.error(`Cannot connect to PostgreSQL: ${(e as Error).message}\nIs PostgreSQL installed and running, and is the password in .env correct?`);
  process.exit(1);
}
const exists = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount;
if (exists) console.log(`Database "${dbName}" already exists.`);
else { await client.query(`CREATE DATABASE "${dbName}"`); console.log(`Database "${dbName}" created.`); }
await client.end();
