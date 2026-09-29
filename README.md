# Company Hub

Internal web app for your team: **customers (CRM)**, **tasks**, **team management** and a dashboard.
Zero npm dependencies — needs only Node.js ≥ 22.13 (uses the built-in `node:sqlite`).

## Run
```
npm start            # http://localhost:3000
npm test
```
On first start an admin account is created and its credentials printed to the console.
Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` beforehand to choose them.

| Env var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | 3000 |
| `DB_FILE` | SQLite file (back this up) | `data/app.db` |
| `NODE_ENV=production` | Marks session cookies `Secure` (serve behind HTTPS) | – |

## Features
- Login with sessions, scrypt-hashed passwords, login rate limiting, CSRF/same-origin checks, CSP headers
- Roles: `admin` (manage users) and `member`
- Customers: search, status filter, notes; Tasks: assignee, customer link, due dates, overdue highlighting

## Layout
`server.js` API + static server · `db.js` schema · `auth.js` passwords/sessions · `public/` UI · `test/` tests
