CREATE TABLE workouts (
  id TEXT PRIMARY KEY NOT NULL,
  done_on TEXT NOT NULL,
  activity TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  effort TEXT NOT NULL,
  notes TEXT
);
