CREATE TABLE milestones (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  due_on TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at INTEGER NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  area TEXT NOT NULL CHECK (area IN ('platform', 'apps', 'sync', 'mobile')),
  status TEXT NOT NULL CHECK (status IN ('new', 'triaged', 'planned', 'in_progress', 'done')),
  priority INTEGER CHECK (priority BETWEEN 0 AND 3),
  milestone_id TEXT REFERENCES milestones (id),
  estimate_days INTEGER CHECK (estimate_days BETWEEN 1 AND 60),
  triage_note TEXT CHECK (length(triage_note) <= 500),
  requested_by TEXT NOT NULL,
  triaged_by TEXT,
  updated_by TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (status = 'new' OR estimate_days IS NOT NULL),
  CHECK (status IN ('new', 'triaged') OR (priority IS NOT NULL AND milestone_id IS NOT NULL))
);

CREATE INDEX items_by_status ON items (archived_at, status, coalesce(priority, 4), created_at, id);
CREATE INDEX items_by_rank ON items (archived_at, coalesce(priority, 4), created_at, id);
CREATE INDEX items_by_milestone ON items (milestone_id, status);
