'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server, base, cookie = '';
before(async () => {
  process.env.ADMIN_EMAIL = 'admin@test.com';
  process.env.ADMIN_PASSWORD = 'supersecret1';
  server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, ck = cookie) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  return { status: res.status, data: res.status === 204 ? null : await res.json(), cookie: set && set.split(';')[0] };
}

test('requires login', async () => { assert.equal((await call('GET', '/customers', null, '')).status, 401); });
test('rejects bad login', async () => { assert.equal((await call('POST', '/login', { email: 'admin@test.com', password: 'nope' }, '')).status, 401); });
test('logs in', async () => {
  const r = await call('POST', '/login', { email: 'admin@test.com', password: 'supersecret1' }, '');
  assert.equal(r.status, 200); cookie = r.cookie; assert.ok(cookie);
});
test('customer CRUD + validation', async () => {
  assert.equal((await call('POST', '/customers', { name: '' })).status, 400);
  const c = await call('POST', '/customers', { name: 'Acme', company: 'Acme Inc' });
  assert.equal(c.status, 201); assert.equal(c.data.status, 'lead');
  assert.equal((await call('PUT', `/customers/${c.data.id}`, { status: 'active' })).data.status, 'active');
  assert.equal((await call('GET', '/customers?q=acm')).data.length, 1);
  assert.equal((await call('GET', '/customers?q=%25')).data.length, 0); // wildcard is escaped
  assert.equal((await call('DELETE', `/customers/${c.data.id}`)).status, 204);
});
test('tasks with references and dashboard', async () => {
  assert.equal((await call('POST', '/tasks', { title: 'x', assignee_id: 999 })).status, 400);
  const t = await call('POST', '/tasks', { title: 'Call client', due_date: '2000-01-01', assignee_id: 1 });
  assert.equal(t.status, 201);
  const d = await call('GET', '/dashboard');
  assert.equal(d.data.tasks.overdue, 1); assert.equal(d.data.tasks.mine, 1);
});
test('members cannot manage users', async () => {
  await call('POST', '/users', { name: 'Bob', email: 'bob@test.com', password: 'password123' });
  const bob = await call('POST', '/login', { email: 'bob@test.com', password: 'password123' }, '');
  assert.equal(bob.status, 200);
  assert.equal((await call('POST', '/users', { name: 'E', email: 'e@t.com', password: 'password123' }, bob.cookie)).status, 403);
});
test('blocks cross-origin writes', async () => {
  const res = await fetch(base + '/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: cookie }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
});
test('serves the UI and blocks traversal', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  const res = await fetch(base + '/..%2fserver.js');
  assert.equal(res.status, 404);
});
