CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  organization_name      text NOT NULL DEFAULT 'My Organization',
  timezone               text NOT NULL DEFAULT 'Asia/Dhaka',
  finalization_buffer_min integer NOT NULL DEFAULT 5,
  max_backoff_seconds    integer NOT NULL DEFAULT 300,
  retention_days         integer NOT NULL DEFAULT 730
);
INSERT INTO settings DEFAULT VALUES;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','HR','VIEWER')),
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE sites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE departments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  start_time    time NOT NULL,
  cutoff_time   time NOT NULL,
  end_time      time NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Dhaka',
  grace_minutes integer NOT NULL DEFAULT 0,
  policy_mode   text NOT NULL DEFAULT 'STRICT' CHECK (policy_mode IN ('STRICT','LATE','GRACE')),
  working_days  integer[] NOT NULL DEFAULT '{6,0,1,2,3,4}',  -- 0=Sunday..6=Saturday
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_default_shift ON shifts (is_default) WHERE is_default;

CREATE TABLE employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL UNIQUE,
  name          text NOT NULL,
  phone         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  designation   text NOT NULL DEFAULT '',
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  site_id       uuid REFERENCES sites(id) ON DELETE SET NULL,
  shift_id      uuid REFERENCES shifts(id) ON DELETE SET NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL UNIQUE,
  type                     text NOT NULL,
  host                     text NOT NULL,
  port                     integer,
  protocol                 text NOT NULL DEFAULT 'https' CHECK (protocol IN ('http','https','ssh','snmp')),
  username                 text,
  encrypted_password       text,
  api_path                 text,
  site_id                  uuid REFERENCES sites(id) ON DELETE SET NULL,
  is_active                boolean NOT NULL DEFAULT true,
  poll_interval_seconds    integer NOT NULL DEFAULT 15 CHECK (poll_interval_seconds BETWEEN 5 AND 3600),
  status                   text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE','OFFLINE','ERROR','SYNCING')),
  last_successful_sync_at  timestamptz,
  last_failure_at          timestamptz,
  last_error               text,
  consecutive_failures     integer NOT NULL DEFAULT 0,
  next_poll_at             timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Windows in which a router could not report clients. Used to avoid false ABSENT results.
CREATE TABLE router_outages (
  id         bigserial PRIMARY KEY,
  router_id  uuid NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE UNIQUE INDEX one_open_outage ON router_outages (router_id) WHERE ended_at IS NULL;

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  mac_address text NOT NULL UNIQUE CHECK (mac_address ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  device_name text NOT NULL DEFAULT '',
  device_type text NOT NULL DEFAULT 'mobile',
  router_id   uuid REFERENCES routers(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wifi_events (
  id            bigserial PRIMARY KEY,
  router_id     uuid NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  mac_address   text NOT NULL,
  event_type    text NOT NULL CHECK (event_type IN ('CONNECTED','DISCONNECTED','SEEN','RECONNECTED')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  ip_address    text,
  hostname      text,
  raw_source    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wifi_events_mac ON wifi_events (mac_address);
CREATE INDEX wifi_events_created ON wifi_events (created_at);
CREATE INDEX wifi_events_router ON wifi_events (router_id, mac_address, id DESC);

-- Clients seen on the network that are not registered. They never create attendance.
CREATE TABLE unknown_clients (
  mac_address   text PRIMARY KEY,
  hostname      text,
  ip_address    text,
  signal_strength integer,
  router_id     uuid REFERENCES routers(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IGNORED'))
);

CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, date date NOT NULL UNIQUE, description text NOT NULL DEFAULT ''
);

CREATE TABLE leaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  from_date date NOT NULL, to_date date NOT NULL CHECK (to_date >= from_date),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id               uuid NOT NULL REFERENCES shifts(id),
  attendance_date        date NOT NULL,
  first_wifi_seen_at     timestamptz,
  last_wifi_seen_at      timestamptz,
  automatic_status       text NOT NULL DEFAULT 'PENDING' CHECK (automatic_status IN ('PENDING','PRESENT','LATE','ABSENT')),
  final_status           text NOT NULL DEFAULT 'PENDING' CHECK (final_status IN ('PENDING','PRESENT','LATE','ABSENT','MANUAL_PRESENT','MANUAL_ABSENT','ON_LEAVE')),
  manual_override        boolean NOT NULL DEFAULT false,
  manual_override_reason text,
  needs_review           boolean NOT NULL DEFAULT false,
  device_id              uuid REFERENCES devices(id) ON DELETE SET NULL,
  router_id              uuid REFERENCES routers(id) ON DELETE SET NULL,
  source                 text NOT NULL DEFAULT 'WIFI',
  finalized_at           timestamptz,
  calculated_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, shift_id, attendance_date)
);
CREATE INDEX attendance_date ON attendance (attendance_date);
CREATE INDEX attendance_employee ON attendance (employee_id);
CREATE INDEX attendance_status ON attendance (final_status);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  dedupe_key text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_dedupe ON notifications (dedupe_key, created_at DESC);
