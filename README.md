# WiFi Attendance

Attendance from WiFi: a registered device seen on the office network at or before the shift cutoff = **PRESENT**;
first seen after the cutoff or never seen (after finalization) = **ABSENT**. Default timezone `Asia/Dhaka`.

**Stack:** Node 22 (runs TypeScript directly) · PostgreSQL · plain-DOM web UI · separate worker process. Only runtime dependency: `pg`.

## Important: no real router integration yet
Only a `MOCK` adapter ships. Send the router **brand + model + firmware + API details** and implement the matching adapter
(see [docs/ROUTER_ADAPTERS.md](docs/ROUTER_ADAPTERS.md)). Attendance code is brand-independent.

## Rules implemented (all covered by tests)
- First seen ≤ cutoff → PRESENT; after → ABSENT; no device seen → ABSENT **only after finalization** (cutoff + buffer)
- Unknown device → no attendance (listed under *Unknown devices*); disabled device → history only
- Multiple devices/routers → earliest sighting wins; reconnects never overwrite first-seen; polls are de-duplicated
- **Router/API failure is never "zero clients"**: the router goes to ERROR with backoff, an outage window is recorded, and
  anyone without evidence before the cutoff stays PENDING + "needs review" instead of ABSENT
- Manual corrections keep the automatic status separately, require a reason, and go to an append-only audit log
- Holidays / non-working days / approved leave produce no absences
- STRICT (default), LATE and GRACE policy modes; cutoffs computed in the shift's timezone, not the server's

## Run locally
```bash
npm install
export DATABASE_URL=postgresql://user@localhost:5432/attendance     # a database you created
npm run migrate && npm run seed                                       # seed = demo data (optional)
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='choose-a-password' npm start   # http://localhost:3000
npm run worker                                                        # second terminal: polling + finalization
```
With `npm run seed` a MOCK router is created; edit it and put `AA:BB:CC:DD:EE:01` in **API path** to simulate Rahim connecting.

## Tests
```bash
export TEST_DATABASE_URL=postgresql://user@localhost:5432/attendance_test   # WARNING: its public schema is dropped on every run
npm test && npm run typecheck
```

## Docker / production
```bash
cp .env.example .env    # set POSTGRES_PASSWORD, ROUTER_ENCRYPTION_KEY, ADMIN_PASSWORD
docker compose up -d --build
```
Nginx serves on :80; add TLS (see `docker/nginx.conf`) and use HTTPS in production (cookies are `Secure` when `NODE_ENV=production`).
The worker must reach your routers over the LAN. Keep the server clock NTP-synced. Back up the `pgdata` volume.
> The Docker files were written but **not run** in the environment this was built in (no Docker daemon available).

## Roles
`SUPER_ADMIN` everything · `ADMIN` employees/devices/org setup/corrections/export · `HR` employees, corrections, export ·
`VIEWER` read-only. MAC addresses are masked for HR/VIEWER.

## Scope vs. the original specification
Built: login/RBAC, dashboard (summary, 14-day chart, department/site split, live SSE activity, router health), attendance +
filters + evidence + manual correction, employees + devices, unknown-device assignment, routers (encrypted credentials, test,
sync), shifts, sites, departments, holidays, users, audit log, settings, CSV export, health endpoints, Docker.
Not built yet (deviations): Next.js/Prisma/Redis/BullMQ (used plain Node + SQL migrations + Postgres LISTEN/NOTIFY),
Excel/PDF export, leave-request UI (table + ON_LEAVE handling exist), overnight shifts, real router adapter, router webhooks,
monthly/device-activity reports, block/disconnect, WebSocket (SSE used).

## WiFi limitation
Phones with private/randomized WiFi addresses may not match their registered MAC; the UI flags private-looking addresses.
Polling "current clients" can miss very short connections; prefer routers/controllers that expose history.
