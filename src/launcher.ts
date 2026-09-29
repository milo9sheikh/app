import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One-click launcher used by the Windows installer (also works on Linux/macOS for testing).
 * First run: creates a private PostgreSQL cluster + secrets. Every run: starts PostgreSQL, the web server and the worker,
 * then opens the browser. Closing the window (or `--stop`) shuts everything down.
 * Everything is logged to <data>/launcher.log and errors keep the window open so they can be read.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const exe = win ? '.exe' : '';
const pgHome = process.env.WA_PG_HOME ?? path.join(appDir, '..', 'postgres');
const dataDir = process.env.WA_DATA ?? (win ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'WiFiAttendance') : path.join(os.homedir(), '.wifi-attendance'));
const pgData = path.join(dataDir, 'pg');
const pgBin = (n: string) => path.join(pgHome, 'bin', n + exe);

fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'launcher.log');
const logFd = fs.openSync(logFile, 'a');
const log = (m: string) => {
  const line = `[${new Date().toLocaleString()}] ${m}`;
  console.log(line);
  fs.writeSync(logFd, line + '\n');
};

async function fail(message: string): Promise<never> {
  log('ERROR: ' + message);
  log(`Full details: ${logFile}`);
  if (win && process.stdin.isTTY && !process.env.WA_NO_BROWSER) {
    console.log('\nPress any key to close this window...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise((r) => process.stdin.once('data', r));
  }
  process.exit(1);
}
process.on('uncaughtException', (e) => { void fail(e.stack ?? e.message); });
process.on('unhandledRejection', (e) => { void fail(e instanceof Error ? (e.stack ?? e.message) : String(e)); });

log(`Starting. Node ${process.version}, ${process.platform}. App: ${appDir}. PostgreSQL: ${pgHome}. Data: ${dataDir}`);

interface Config { dbPassword: string; encKey: string; adminEmail: string; adminPassword: string; pgPort: number; webPort: number }

function loadConfig(): { cfg: Config; first: boolean } {
  const file = path.join(dataDir, 'config.json');
  if (fs.existsSync(file)) return { cfg: JSON.parse(fs.readFileSync(file, 'utf8')), first: false };
  const cfg: Config = {
    dbPassword: crypto.randomBytes(18).toString('base64url'), encKey: crypto.randomBytes(32).toString('hex'),
    adminEmail: 'admin@company.local', adminPassword: crypto.randomBytes(9).toString('base64url'),
    pgPort: Number(process.env.WA_PG_PORT) || 54329, webPort: Number(process.env.WA_WEB_PORT) || 3000,
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { cfg, first: true };
}

/** Runs a command to completion, appending its output to the log. Returns the exit code (127 if it could not start). */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  log(`> ${path.basename(cmd)} ${args.filter((a) => !a.startsWith('--pwfile')).join(' ')}`);
  const r = spawnSync(cmd, args, { env, stdio: ['ignore', logFd, logFd] });
  if (r.error) { log(`Could not run ${cmd}: ${r.error.message}`); return 127; }
  return r.status ?? 1;
}

function stopPostgres() {
  if (fs.existsSync(path.join(pgData, 'PG_VERSION'))) run(pgBin('pg_ctl'), ['stop', '-D', pgData, '-m', 'fast', '-w', '-t', '30']);
}

if (process.argv.includes('--stop')) { stopPostgres(); log('Stopped.'); process.exit(0); }

const { cfg, first } = loadConfig();
const dbUrl = `postgresql://postgres:${cfg.dbPassword}@127.0.0.1:${cfg.pgPort}/attendance`;
const appEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl, PORT: String(cfg.webPort), ROUTER_ENCRYPTION_KEY: cfg.encKey,
  ADMIN_EMAIL: cfg.adminEmail, ADMIN_PASSWORD: cfg.adminPassword };
const nodeArgs = ['--disable-warning=ExperimentalWarning'];

if (!fs.existsSync(pgBin('postgres'))) await fail(`PostgreSQL files not found at ${pgHome}. Re-run the installer.`);

if (!fs.existsSync(path.join(pgData, 'PG_VERSION'))) {
  log('First run: creating the database (one time, about 30 seconds)...');
  const pw = path.join(dataDir, 'pw.tmp');
  fs.writeFileSync(pw, cfg.dbPassword, { mode: 0o600 });
  let code: number;
  try { code = run(pgBin('initdb'), ['-D', pgData, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile=' + pw, '-E', 'UTF8', '--locale=C']); }
  finally { fs.rmSync(pw, { force: true }); }
  if (code !== 0) {
    fs.rmSync(pgData, { recursive: true, force: true });
    await fail(`Could not create the database (exit code ${code}). If Windows reports a missing DLL (for example VCRUNTIME140.dll or MSVCP140.dll), install "Microsoft Visual C++ Redistributable 2015-2022 (x64)" from microsoft.com and start the app again.`);
  }
}

if (run(pgBin('pg_ctl'), ['status', '-D', pgData]) !== 0) {
  log('Starting database...');
  const code = run(pgBin('pg_ctl'), ['start', '-D', pgData, '-w', '-t', '90', '-l', path.join(dataDir, 'postgres.log'),
    '-o', `-p ${cfg.pgPort} -c listen_addresses=127.0.0.1`]);
  if (code !== 0) {
    let tail = '';
    try { tail = fs.readFileSync(path.join(dataDir, 'postgres.log'), 'utf8').split('\n').slice(-8).join('\n'); } catch { /* no log yet */ }
    await fail(`Database failed to start (exit code ${code}). Is another program using port ${cfg.pgPort}?\n${tail}`);
  }
}

for (const script of ['src/db/create-db.ts', 'src/db/migrate.ts']) {
  const code = run(process.execPath, [...nodeArgs, path.join(appDir, script)], appEnv);
  if (code !== 0) { stopPostgres(); await fail(`${script} failed (exit code ${code}).`); }
}

const children: ChildProcess[] = [];
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log('Shutting down...');
  for (const c of children) c.kill();
  await Promise.race([
    Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r(0) : c.once('exit', r))))),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  stopPostgres();
  process.exit(code);
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { void shutdown(0); });

for (const [name, file] of [['web', 'src/api/server.ts'], ['worker', 'src/worker.ts']] as const) {
  const c = spawn(process.execPath, [...nodeArgs, path.join(appDir, file)], { env: appEnv, stdio: ['ignore', logFd, logFd] });
  c.on('error', (e) => { void fail(`Could not start ${name}: ${e.message}`); });
  c.on('exit', (code) => { if (!stopping) { log(`${name} stopped unexpectedly (code ${code}). See ${logFile}`); void shutdown(1); } });
  children.push(c);
}

const url = `http://localhost:${cfg.webPort}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(url + '/health')).ok; } catch { /* not up yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { stopPostgres(); await fail(`The web server did not start. Is port ${cfg.webPort} used by another program? Check the log for details.`); }

log(`WiFi Attendance is running: ${url}`);
log('Keep this window open (minimize it). Close it, or use "Stop WiFi Attendance", to stop.');
if (first) {
  const note = path.join(dataDir, 'first-login.txt');
  fs.writeFileSync(note, `WiFi Attendance - first login\r\n\r\nAddress : ${url}\r\nEmail   : ${cfg.adminEmail}\r\nPassword: ${cfg.adminPassword}\r\n\r\nChange the password after logging in (Users page), then delete this file.\r\n`);
  log(`First login details saved to ${note}`);
  if (win && !process.env.WA_NO_BROWSER) spawn('notepad.exe', [note], { detached: true, stdio: 'ignore' }).unref();
}
if (!process.env.WA_NO_BROWSER) {
  if (win) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}
