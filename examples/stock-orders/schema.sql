-- Generic stock-limited order data. The same operation host handles this app.
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0)
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled')),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  UNIQUE (order_id, item_id)
);
INSERT INTO items(id,name,price_cents,remaining) VALUES ('shirt-s','Fundraiser shirt, small',1500,20),('shirt-m','Fundraiser shirt, medium',1500,20),('shirt-l','Fundraiser shirt, large',1500,20);
