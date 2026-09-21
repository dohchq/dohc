-- Generic fundraiser data. The host owns the transaction around each operation.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  player_capacity INTEGER NOT NULL CHECK (player_capacity > 0),
  reserved_players INTEGER NOT NULL DEFAULT 0 CHECK (reserved_players >= 0 AND reserved_players <= player_capacity)
);
CREATE TABLE registrations (
  id TEXT PRIMARY KEY NOT NULL,
  status_token TEXT NOT NULL,
  full_name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('website','reclub','manual')),
  status TEXT NOT NULL CHECK (status IN ('pending_verification','verified','rejected','pay_at_venue')),
  payment_method TEXT NOT NULL,
  total_php INTEGER NOT NULL CHECK (total_php > 0),
  receipt_file_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE registration_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  player_count INTEGER NOT NULL CHECK (player_count >= 0),
  spectator_count INTEGER NOT NULL CHECK (spectator_count >= 0),
  UNIQUE (registration_id, session_id),
  CHECK (player_count + spectator_count > 0)
);
CREATE TABLE attendees (
  id TEXT PRIMARY KEY NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('player','spectator')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  UNIQUE (registration_id, session_id, name_key)
);
INSERT INTO sessions(id,name,starts_at,player_capacity) VALUES
  ('s1','Session 1','2026-10-10T09:00:00+08:00',36),
  ('s2','Session 2','2026-10-10T13:00:00+08:00',36);

