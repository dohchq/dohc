CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  spent_on TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT
);
