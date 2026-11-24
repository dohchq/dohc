CREATE TABLE shoots (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 120),
  shot_on TEXT NOT NULL,
  selection_limit INTEGER NOT NULL CHECK (selection_limit BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('draft', 'proofing', 'delivered')),
  internal_rate_cents INTEGER NOT NULL CHECK (internal_rate_cents >= 0),
  access_code TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  shoot_id TEXT NOT NULL REFERENCES shoots(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  file_id TEXT,
  demo_scene TEXT,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 30000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 30000),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sort_order INTEGER NOT NULL,
  owner_rating INTEGER NOT NULL DEFAULT 0 CHECK (owner_rating BETWEEN 0 AND 5),
  color_label TEXT NOT NULL DEFAULT 'none' CHECK (color_label IN ('none', 'red', 'yellow', 'green', 'blue', 'purple')),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  CHECK ((file_id IS NULL) <> (demo_scene IS NULL))
);
CREATE INDEX assets_by_shoot ON assets(shoot_id, sort_order, id);

CREATE TABLE selections (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  reviewer_key TEXT NOT NULL,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (asset_id, reviewer_key)
);
CREATE INDEX selections_by_reviewer ON selections(reviewer_key, selected);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  x_pct REAL NOT NULL CHECK (x_pct BETWEEN 0 AND 100),
  y_pct REAL NOT NULL CHECK (y_pct BETWEEN 0 AND 100),
  author_name TEXT NOT NULL CHECK (length(author_name) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX annotations_by_asset ON annotations(asset_id, created_at_ms, id);

INSERT INTO shoots (id, title, client_name, shot_on, selection_limit, status, internal_rate_cents, access_code, created_at_ms) VALUES
  ('shoot_positano', 'Golden hour in Positano', 'Mara & Theo', '2026-09-14', 12, 'proofing', 280000, 'GOLDHOUR2026', 1789430400000),
  ('shoot_atelier', 'Atelier Nove autumn lookbook', 'Atelier Nove', '2026-10-30', 20, 'draft', 450000, 'NOVE7KQ2X9PD', 1793404800000);

INSERT INTO assets (id, shoot_id, title, demo_scene, mime_type, width, height, byte_length, sort_order, owner_rating, color_label, is_published, created_at_ms) VALUES
  ('pos_0012', 'shoot_positano', 'POS_0012', 'coast:11', 'image/png', 1800, 1200, 0, 10, 4, 'green', 1, 1789430400000),
  ('pos_0027', 'shoot_positano', 'POS_0027', 'arches:4', 'image/png', 1200, 1800, 0, 20, 5, 'green', 1, 1789430400000),
  ('pos_0031', 'shoot_positano', 'POS_0031', 'lagoon:7', 'image/png', 1800, 1200, 0, 30, 3, 'none', 1, 1789430400000),
  ('pos_0044', 'shoot_positano', 'POS_0044', 'bokeh:2', 'image/png', 1200, 1500, 0, 40, 4, 'yellow', 1, 1789430400000),
  ('pos_0058', 'shoot_positano', 'POS_0058', 'peaks:9', 'image/png', 1920, 1080, 0, 50, 2, 'none', 1, 1789430400000),
  ('pos_0063', 'shoot_positano', 'POS_0063', 'dunes:5', 'image/png', 1800, 1200, 0, 60, 4, 'red', 1, 1789430400000),
  ('pos_0071', 'shoot_positano', 'POS_0071', 'coast:23', 'image/png', 1200, 1800, 0, 70, 5, 'green', 1, 1789430400000),
  ('pos_0086', 'shoot_positano', 'POS_0086', 'arches:12', 'image/png', 1800, 1200, 0, 80, 3, 'none', 1, 1789430400000),
  ('pos_0090', 'shoot_positano', 'POS_0090', 'bokeh:8', 'image/png', 1800, 1200, 0, 90, 4, 'blue', 1, 1789430400000),
  ('pos_0104', 'shoot_positano', 'POS_0104', 'lagoon:15', 'image/png', 1200, 1500, 0, 100, 3, 'none', 1, 1789430400000),
  ('pos_0119', 'shoot_positano', 'POS_0119', 'coast:31', 'image/png', 1800, 1200, 0, 110, 4, 'none', 1, 1789430400000),
  ('pos_0125', 'shoot_positano', 'POS_0125', 'peaks:3', 'image/png', 1200, 1800, 0, 120, 5, 'purple', 1, 1789430400000),
  ('pos_0133', 'shoot_positano', 'POS_0133', 'dunes:14', 'image/png', 1920, 1080, 0, 130, 2, 'none', 1, 1789430400000),
  ('pos_0140', 'shoot_positano', 'POS_0140', 'coast:44', 'image/png', 1800, 1200, 0, 140, 1, 'none', 0, 1789430400000),
  ('pos_0152', 'shoot_positano', 'POS_0152', 'bokeh:19', 'image/png', 1200, 1800, 0, 150, 0, 'none', 0, 1789430400000),
  ('pos_0167', 'shoot_positano', 'POS_0167', 'arches:27', 'image/png', 1800, 1200, 0, 160, 2, 'red', 0, 1789430400000),
  ('nove_01', 'shoot_atelier', 'NOVE_01', 'bokeh:31', 'image/png', 1200, 1500, 0, 10, 0, 'none', 0, 1793404800000),
  ('nove_02', 'shoot_atelier', 'NOVE_02', 'arches:40', 'image/png', 1200, 1800, 0, 20, 0, 'none', 0, 1793404800000),
  ('nove_03', 'shoot_atelier', 'NOVE_03', 'dunes:22', 'image/png', 1800, 1200, 0, 30, 0, 'none', 0, 1793404800000),
  ('nove_04', 'shoot_atelier', 'NOVE_04', 'peaks:18', 'image/png', 1200, 1500, 0, 40, 0, 'none', 0, 1793404800000);

INSERT INTO selections (id, asset_id, reviewer_key, selected, updated_at_ms) VALUES
  ('sel_seed_01', 'pos_0027', 'seed:mara', 1, 1789516800000),
  ('sel_seed_02', 'pos_0044', 'seed:mara', 1, 1789516800000),
  ('sel_seed_03', 'pos_0071', 'seed:mara', 1, 1789516800000),
  ('sel_seed_04', 'pos_0090', 'seed:mara', 1, 1789516800000),
  ('sel_seed_05', 'pos_0125', 'seed:mara', 1, 1789516800000),
  ('sel_seed_06', 'pos_0027', 'seed:theo', 1, 1789520400000),
  ('sel_seed_07', 'pos_0071', 'seed:theo', 1, 1789520400000),
  ('sel_seed_08', 'pos_0119', 'seed:theo', 1, 1789520400000);

INSERT INTO annotations (id, asset_id, x_pct, y_pct, author_name, body, resolved, created_at_ms) VALUES
  ('note_seed_01', 'pos_0027', 38.5, 22, 'Mara', 'Could this one be a touch warmer? The light on the wall is the best part.', 0, 1789517000000),
  ('note_seed_02', 'pos_0027', 71.2, 64.3, 'Theo', 'Crop a little tighter on the right for the album spread?', 0, 1789520500000),
  ('note_seed_03', 'pos_0071', 50, 30, 'Mara', 'This is the cover. No notes.', 1, 1789517100000),
  ('note_seed_04', 'pos_0125', 22, 70, 'Mara', 'Is it possible to soften the bright patch down here?', 0, 1789517200000);
