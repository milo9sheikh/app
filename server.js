'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const auth = require('./auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 100 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Field definitions: validation for each resource.
const str = (max, { required = false } = {}) => (v) => {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new Error('must be text');
  v = v.trim();
  if (required && !v) throw new Error('is required');
  if (v.length > max) throw new Error(`must be at most ${max} characters`);
  return v;
};
const oneOf = (list) => (v) => { if (!list.includes(v)) throw new Error(`must be one of: ${list.join(', ')}`); return v; };
const optDate = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Error('must be a date (YYYY-MM-DD)');
  return v;
};
const optId = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('must be an id');
  return n;
};

const RESOURCES = {
  customers: {
    fields: {
      name: str(120, { required: true }), company: str(120), email: str(160), phone: str(40),
      status: oneOf(['lead', 'active', 'inactive']), notes: str(4000),
    },
    defaults: { status: 'lead' },
    order: 'name COLLATE NOCASE',
  },
  tasks: {
    fields: {
      title: str(200, { required: true }), description: str(4000), status: oneOf(['todo', 'doing', 'done']),
      due_date: optDate, assignee_id: optId, customer_id: optId,
    },
    defaults: { status: 'todo' },
    order: "CASE status WHEN 'done' THEN 1 ELSE 0 END, due_date IS NULL, due_date, id DESC",
  },
};

function validate(res, body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON body');
  const out = {}; const errors = [];
  for (const [key, fn] of Object.entries(res.fields)) {
    if (!(key in body) && (partial || key in res.defaults)) {
      if (!partial) out[key] = res.defaults[key];
      continue;
    }
    try { out[key] = fn(body[key]); } catch (e) { errors.push(`${key} ${e.message}`); }
  }
  if (errors.length) throw new HttpError(400, errors.join('; '));
  return out;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db'), secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const db = openDb(dbFile);
  const loginAttempts = new Map(); // ip -> {count, resetAt}

  function bootstrapAdmin() {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || require('node:crypto').randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users (name, email, role, password_hash) VALUES (?,?,?,?)')
      .run('Administrator', email, 'admin', auth.hashPassword(password));
    console.log(`Created first admin account: ${email} / ${password}  (change it after logging in)`);
  }
  bootstrapAdmin();

  const send = (res, status, data, headers = {}) => {
    const body = data === undefined ? '' : JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

  function rateLimited(ip) {
    const now = Date.now();
    const e = loginAttempts.get(ip);
    if (!e || e.resetAt < now) { loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); return false; }
    e.count += 1;
    return e.count > 10;
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const method = req.method;
    const cookies = parseCookies(req.headers.cookie);
    const user = auth.getSessionUser(db, cookies.sid);

    // CSRF defence: state-changing requests must be JSON (blocks plain form posts) and same-origin.
    if (method !== 'GET') {
      const origin = req.headers.origin;
      need(!origin || new URL(origin).host === req.headers.host, 403, 'Cross-origin request blocked');
      if (parts[0] !== 'logout') need((req.headers['content-type'] || '').startsWith('application/json') || method === 'DELETE', 415, 'Expected JSON');
    }

    if (parts[0] === 'login' && method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      need(!rateLimited(ip), 429, 'Too many login attempts, try again later');
      const { email, password } = await readJson(req);
      const row = typeof email === 'string' && typeof password === 'string'
        ? db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.trim().toLowerCase()) : null;
      // Always hash-compare to keep timing similar for unknown emails.
      const ok = row ? auth.verifyPassword(password, row.password_hash) : (auth.verifyPassword('x', auth.hashPassword('y')), false);
      need(ok, 401, 'Invalid email or password');
      loginAttempts.delete(ip);
      const token = auth.createSession(db, row.id);
      const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_MS / 1000}${secureCookies ? '; Secure' : ''}`;
      return send(res, 200, { id: row.id, name: row.name, email: row.email, role: row.role }, { 'Set-Cookie': cookie });
    }
    if (parts[0] === 'logout' && method === 'POST') {
      if (cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    need(user, 401, 'Not logged in');

    if (parts[0] === 'me' && method === 'GET') return send(res, 200, user);

    if (parts[0] === 'dashboard' && method === 'GET') {
      const today = new Date().toISOString().slice(0, 10);
      const count = (sql, ...a) => db.prepare(sql).get(...a).n;
      return send(res, 200, {
        customers: {
          total: count('SELECT COUNT(*) n FROM customers'),
          leads: count("SELECT COUNT(*) n FROM customers WHERE status='lead'"),
          active: count("SELECT COUNT(*) n FROM customers WHERE status='active'"),
        },
        tasks: {
          open: count("SELECT COUNT(*) n FROM tasks WHERE status != 'done'"),
          overdue: count("SELECT COUNT(*) n FROM tasks WHERE status != 'done' AND due_date < ?", today),
          mine: count("SELECT COUNT(*) n FROM tasks WHERE status != 'done' AND assignee_id = ?", user.id),
        },
        team: count('SELECT COUNT(*) n FROM users WHERE active = 1'),
      });
    }

    if (parts[0] === 'users') return usersApi(req, res, parts, user);

    const resource = RESOURCES[parts[0]];
    need(resource, 404, 'Not found');
    const id = parts[1] !== undefined ? Number(parts[1]) : null;
    need(id === null || Number.isInteger(id), 404, 'Not found');
    const table = parts[0];

    if (id === null && method === 'GET') {
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status');
      const where = []; const args = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (q) {
        const textCols = Object.keys(resource.fields).filter((k) => ['name', 'company', 'email', 'title', 'description'].includes(k));
        where.push('(' + textCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        textCols.forEach(() => args.push(like));
      }
      if (table === 'tasks' && url.searchParams.get('mine') === '1') { where.push('assignee_id = ?'); args.push(user.id); }
      const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${resource.order} LIMIT 500`;
      return send(res, 200, db.prepare(sql).all(...args));
    }
    if (id === null && method === 'POST') {
      const data = validate(resource, await readJson(req), false);
      checkRefs(table, data);
      const keys = Object.keys(data);
      const r = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k]));
      return send(res, 201, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid));
    }
    if (id !== null) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      need(row, 404, 'Not found');
      if (method === 'GET') return send(res, 200, row);
      if (method === 'PUT' || method === 'PATCH') {
        const data = validate(resource, await readJson(req), true);
        checkRefs(table, data);
        const keys = Object.keys(data);
        if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), id);
        return send(res, 200, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
      }
      if (method === 'DELETE') {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        return send(res, 204);
      }
    }
    throw new HttpError(405, 'Method not allowed');
  }

  function checkRefs(table, data) {
    if (table !== 'tasks') return;
    if (data.assignee_id != null) need(db.prepare('SELECT 1 FROM users WHERE id = ?').get(data.assignee_id), 400, 'assignee_id does not exist');
    if (data.customer_id != null) need(db.prepare('SELECT 1 FROM customers WHERE id = ?').get(data.customer_id), 400, 'customer_id does not exist');
  }

  async function usersApi(req, res, parts, user) {
    const method = req.method;
    const cols = 'id, name, email, role, active, created_at';
    if (parts.length === 1 && method === 'GET') return send(res, 200, db.prepare(`SELECT ${cols} FROM users ORDER BY name COLLATE NOCASE`).all());
    need(user.role === 'admin', 403, 'Admins only');
    if (parts.length === 1 && method === 'POST') {
      const b = await readJson(req);
      const name = str(120, { required: true })(b.name);
      const email = str(160, { required: true })(b.email).toLowerCase();
      need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'email is invalid');
      need(typeof b.password === 'string' && b.password.length >= 8, 400, 'password must be at least 8 characters');
      const role = b.role === undefined ? 'member' : oneOf(['admin', 'member'])(b.role);
      need(!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email), 409, 'A user with that email already exists');
      const r = db.prepare('INSERT INTO users (name,email,role,password_hash) VALUES (?,?,?,?)').run(name, email, role, auth.hashPassword(b.password));
      return send(res, 201, db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(r.lastInsertRowid));
    }
    const id = Number(parts[1]);
    need(Number.isInteger(id), 404, 'Not found');
    need(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id), 404, 'Not found');
    if (parts.length === 2 && method === 'PATCH') {
      const b = await readJson(req);
      if ('role' in b) { need(['admin', 'member'].includes(b.role), 400, 'invalid role'); need(!(id === user.id && b.role !== 'admin'), 400, 'You cannot demote yourself'); db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id); }
      if ('active' in b) { need(!(id === user.id && !b.active), 400, 'You cannot deactivate yourself'); db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, id); if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
      if ('password' in b) { need(typeof b.password === 'string' && b.password.length >= 8, 400, 'password must be at least 8 characters'); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(b.password), id); db.prepare('DELETE FROM sessions WHERE user_id=? AND token != ?').run(id, parseCookies(req.headers.cookie).sid || ''); }
      return send(res, 200, db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(id));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof URIError) return send(res, 400, { error: 'Bad request' });
      console.error(e);
      send(res, 500, { error: 'Internal server error' });
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Company Hub running at http://localhost:${port}`));
}
module.exports = { createApp };
