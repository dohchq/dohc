CREATE TABLE games (
  id TEXT PRIMARY KEY NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  seed INTEGER NOT NULL,
  radius INTEGER NOT NULL CHECK (radius >= 2 AND radius <= 4),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'finished')),
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  active_seat INTEGER NOT NULL CHECK (active_seat IN (1, 2)),
  winner_player_id TEXT,
  win_reason TEXT CHECK (win_reason IS NULL OR win_reason IN ('capital_captured', 'resignation')),
  initial_tiles_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat IN (1, 2)),
  name TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('crimson', 'cobalt')),
  player_token TEXT NOT NULL UNIQUE,
  gold INTEGER NOT NULL CHECK (gold >= 0),
  joined_at_ms INTEGER NOT NULL,
  UNIQUE (game_id, seat)
);

CREATE TABLE hex_tiles (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  q INTEGER NOT NULL,
  r INTEGER NOT NULL,
  terrain TEXT NOT NULL CHECK (terrain IN ('capital', 'plains', 'gold', 'forest', 'mountain')),
  owner_player_id TEXT REFERENCES players(id),
  units INTEGER NOT NULL CHECK (units >= 0),
  fortified INTEGER NOT NULL DEFAULT 0 CHECK (fortified IN (0, 1)),
  UNIQUE (game_id, q, r)
);

CREATE TABLE moves (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  actor_player_id TEXT NOT NULL REFERENCES players(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('march', 'fortify', 'reinforce', 'pass', 'resign')),
  from_hex TEXT,
  to_hex TEXT,
  units_moved INTEGER NOT NULL CHECK (units_moved >= 0),
  combat_outcome_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (game_id, turn_number)
);

CREATE INDEX idx_games_updated ON games (updated_at_ms DESC, id DESC);
