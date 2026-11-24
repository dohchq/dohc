CREATE TABLE tournaments (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('Pickleball', 'Esports', 'Tabletop')),
  status TEXT NOT NULL CHECK (status IN ('live', 'finished')),
  bracket_size INTEGER NOT NULL CHECK (bracket_size IN (4, 8, 16, 32)),
  points_to_win INTEGER NOT NULL CHECK (points_to_win BETWEEN 1 AND 99),
  win_by INTEGER NOT NULL CHECK (win_by BETWEEN 1 AND 5),
  k_factor INTEGER NOT NULL CHECK (k_factor BETWEEN 1 AND 64),
  champion_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments (id),
  name TEXT NOT NULL,
  club TEXT,
  seed INTEGER NOT NULL CHECK (seed BETWEEN 1 AND 32),
  rating INTEGER NOT NULL,
  start_rating INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points_for INTEGER NOT NULL DEFAULT 0,
  points_against INTEGER NOT NULL DEFAULT 0,
  eliminated_round INTEGER,
  UNIQUE (tournament_id, seed)
);

CREATE TABLE courts (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments (id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE (tournament_id, position)
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments (id),
  round INTEGER NOT NULL CHECK (round >= 1),
  slot INTEGER NOT NULL CHECK (slot >= 1),
  player_a_id TEXT REFERENCES players (id),
  player_b_id TEXT REFERENCES players (id),
  next_match_id TEXT REFERENCES matches (id),
  next_slot TEXT CHECK (next_slot IN ('a', 'b')),
  court_id TEXT REFERENCES courts (id),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'ready', 'live', 'done', 'bye')),
  score_a INTEGER NOT NULL DEFAULT 0 CHECK (score_a >= 0),
  score_b INTEGER NOT NULL DEFAULT 0 CHECK (score_b >= 0),
  winner_id TEXT REFERENCES players (id),
  started_at INTEGER,
  finished_at INTEGER,
  version INTEGER NOT NULL CHECK (version >= 1),
  UNIQUE (tournament_id, round, slot),
  CHECK (status != 'live' OR court_id IS NOT NULL)
);

CREATE UNIQUE INDEX matches_one_live_match_per_court ON matches (court_id) WHERE status = 'live';

CREATE TABLE match_events (
  id TEXT PRIMARY KEY NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments (id),
  match_id TEXT NOT NULL REFERENCES matches (id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('bye', 'start', 'point', 'undo', 'complete')),
  side TEXT CHECK (side IN ('a', 'b')),
  score_a INTEGER NOT NULL,
  score_b INTEGER NOT NULL,
  court_id TEXT,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (match_id, seq)
);

CREATE INDEX match_events_recent ON match_events (tournament_id, at);
