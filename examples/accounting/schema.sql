CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 12),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  role TEXT UNIQUE CHECK (role IN ('receivable','sales_tax')),
  is_bank INTEGER NOT NULL DEFAULT 0 CHECK (is_bank IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  CHECK (is_bank = 0 OR type = 'asset')
);
CREATE TABLE fiscal_periods (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 7),
  start_date TEXT NOT NULL CHECK (date(start_date) IS start_date),
  end_date TEXT NOT NULL CHECK (date(end_date) IS end_date AND end_date >= start_date),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_at_ms INTEGER
);
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY NOT NULL,
  number INTEGER NOT NULL UNIQUE CHECK (typeof(number) = 'integer' AND number > 0),
  entry_date TEXT NOT NULL CHECK (date(entry_date) IS entry_date),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND upper(currency) = currency),
  memo TEXT NOT NULL CHECK (length(memo) <= 500),
  source TEXT NOT NULL CHECK (source IN ('manual','invoice','payment','bank','reversal')),
  source_id TEXT,
  reverses_entry_id TEXT UNIQUE REFERENCES journal_entries(id),
  total_cents INTEGER NOT NULL CHECK (typeof(total_cents) = 'integer' AND total_cents > 0),
  receipt_file_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX journal_entries_date ON journal_entries(entry_date, number);
CREATE INDEX journal_entries_source ON journal_entries(source_id) WHERE source_id IS NOT NULL;
CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 500),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL CHECK (typeof(debit_cents) = 'integer' AND debit_cents BETWEEN 0 AND 1000000000000),
  credit_cents INTEGER NOT NULL CHECK (typeof(credit_cents) = 'integer' AND credit_cents BETWEEN 0 AND 1000000000000),
  memo TEXT CHECK (length(memo) <= 200),
  CHECK ((debit_cents > 0) + (credit_cents > 0) = 1),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_account ON journal_lines(account_id, entry_id);
CREATE TABLE bank_imports (
  id TEXT PRIMARY KEY NOT NULL,
  import_id TEXT NOT NULL CHECK (length(import_id) BETWEEN 8 AND 64),
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no > 0),
  bank_account_id TEXT NOT NULL REFERENCES accounts(id),
  posted_on TEXT NOT NULL CHECK (date(posted_on) IS posted_on),
  description TEXT NOT NULL CHECK (length(description) <= 300),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents <> 0 AND abs(amount_cents) <= 1000000000000),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND upper(currency) = currency),
  base_hash TEXT NOT NULL CHECK (length(base_hash) = 64),
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('new','duplicate','posted','ignored')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  linked INTEGER NOT NULL DEFAULT 0 CHECK (linked IN (0, 1)),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  imported_at_ms INTEGER NOT NULL,
  CHECK ((status = 'posted') = (journal_entry_id IS NOT NULL)),
  CHECK (linked = 0 OR status = 'posted'),
  CHECK (confirmed = 0 OR status = 'duplicate'),
  UNIQUE (import_id, line_no)
);
CREATE UNIQUE INDEX bank_imports_row_hash ON bank_imports(row_hash) WHERE status <> 'duplicate';
CREATE INDEX bank_imports_base ON bank_imports(import_id, base_hash);
CREATE INDEX bank_imports_status ON bank_imports(status, posted_on);
CREATE UNIQUE INDEX bank_imports_entry ON bank_imports(journal_entry_id, bank_account_id) WHERE journal_entry_id IS NOT NULL;
CREATE TABLE business (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'business'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 150),
  email TEXT CHECK (length(email) <= 200),
  address TEXT CHECK (length(address) <= 500),
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 150),
  email TEXT CHECK (length(email) <= 200),
  address TEXT CHECK (length(address) <= 500),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY NOT NULL,
  number TEXT UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  issue_date TEXT NOT NULL CHECK (date(issue_date) IS issue_date),
  due_date TEXT NOT NULL CHECK (date(due_date) IS due_date AND due_date >= issue_date),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND upper(currency) = currency),
  tax_rate_bp INTEGER NOT NULL CHECK (typeof(tax_rate_bp) = 'integer' AND tax_rate_bp BETWEEN 0 AND 10000),
  subtotal_cents INTEGER NOT NULL CHECK (typeof(subtotal_cents) = 'integer' AND subtotal_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (typeof(tax_cents) = 'integer' AND tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents = subtotal_cents + tax_cents),
  notes TEXT CHECK (length(notes) <= 1000),
  status TEXT NOT NULL CHECK (status IN ('draft','issued','paid','void')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  void_entry_id TEXT REFERENCES journal_entries(id),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(paid_cents) = 'integer' AND paid_cents BETWEEN 0 AND total_cents),
  paid_on TEXT CHECK (paid_on IS NULL OR date(paid_on) IS paid_on),
  seller_name TEXT CHECK (length(seller_name) <= 150),
  seller_email TEXT CHECK (length(seller_email) <= 200),
  seller_address TEXT CHECK (length(seller_address) <= 500),
  buyer_name TEXT CHECK (length(buyer_name) <= 150),
  buyer_email TEXT CHECK (length(buyer_email) <= 200),
  buyer_address TEXT CHECK (length(buyer_address) <= 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL,
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((status = 'draft') = (journal_entry_id IS NULL)),
  CHECK ((status = 'draft') = (seller_name IS NULL AND buyer_name IS NULL)),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
  CHECK (CASE WHEN status IN ('issued','paid') THEN (status = 'paid') = (paid_cents = total_cents) ELSE paid_cents = 0 END),
  CHECK ((status = 'void') = (void_entry_id IS NOT NULL))
);
CREATE INDEX invoices_status ON invoices(status, due_date);
CREATE TABLE invoice_payments (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES journal_entries(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  paid_on TEXT NOT NULL CHECK (date(paid_on) IS paid_on),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0)
);
CREATE INDEX invoice_payments_invoice ON invoice_payments(invoice_id, paid_on);
CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES accounts(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND upper(currency) = currency),
  statement_date TEXT NOT NULL CHECK (date(statement_date) IS statement_date),
  balance_cents INTEGER NOT NULL CHECK (typeof(balance_cents) = 'integer' AND abs(balance_cents) <= 1000000000000),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (bank_account_id, currency, statement_date)
);
CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 300),
  quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli BETWEEN 1 AND 1000000000),
  unit_price_cents INTEGER NOT NULL CHECK (typeof(unit_price_cents) = 'integer' AND unit_price_cents BETWEEN 0 AND 1000000000000),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  revenue_account_id TEXT NOT NULL REFERENCES accounts(id),
  UNIQUE (invoice_id, line_no)
);

CREATE TRIGGER accounts_type_fixed BEFORE UPDATE OF type, is_bank ON accounts
WHEN (OLD.type IS NOT NEW.type OR OLD.is_bank IS NOT NEW.is_bank)
  AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'account_in_use: An account with postings keeps its type.'); END;

CREATE TRIGGER periods_no_overlap BEFORE INSERT ON fiscal_periods
WHEN EXISTS (SELECT 1 FROM fiscal_periods WHERE start_date <= NEW.end_date AND end_date >= NEW.start_date)
BEGIN SELECT RAISE(ABORT, 'period_overlap: Fiscal periods cannot overlap.'); END;
CREATE TRIGGER periods_locked_fixed BEFORE UPDATE ON fiscal_periods
WHEN OLD.status = 'locked' OR OLD.start_date IS NOT NEW.start_date OR OLD.end_date IS NOT NEW.end_date OR OLD.id IS NOT NEW.id
BEGIN SELECT RAISE(ABORT, 'period_locked: A locked fiscal period cannot change.'); END;
CREATE TRIGGER periods_kept BEFORE DELETE ON fiscal_periods
WHEN OLD.status = 'locked' OR EXISTS (SELECT 1 FROM journal_entries WHERE entry_date BETWEEN OLD.start_date AND OLD.end_date)
BEGIN SELECT RAISE(ABORT, 'period_in_use: A fiscal period with entries cannot be removed.'); END;

CREATE TRIGGER entries_open_period BEFORE INSERT ON journal_entries
WHEN NOT EXISTS (SELECT 1 FROM fiscal_periods WHERE NEW.entry_date BETWEEN start_date AND end_date AND status = 'open')
BEGIN SELECT RAISE(ABORT, 'period_closed: The entry date is not in an open fiscal period.'); END;
CREATE TRIGGER entries_balanced AFTER INSERT ON journal_entries
WHEN (SELECT count(*) < 2 OR coalesce(sum(debit_cents), 0) <> NEW.total_cents OR coalesce(sum(credit_cents), 0) <> NEW.total_cents
      FROM journal_lines WHERE entry_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'unbalanced: Debits must equal credits, with at least two lines.'); END;
CREATE TRIGGER entries_posted_fixed BEFORE UPDATE ON journal_entries
WHEN OLD.id IS NOT NEW.id OR OLD.number IS NOT NEW.number OR OLD.entry_date IS NOT NEW.entry_date
  OR OLD.currency IS NOT NEW.currency OR OLD.memo IS NOT NEW.memo OR OLD.source IS NOT NEW.source
  OR OLD.source_id IS NOT NEW.source_id OR OLD.reverses_entry_id IS NOT NEW.reverses_entry_id
  OR OLD.total_cents IS NOT NEW.total_cents OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN SELECT RAISE(ABORT, 'posted: A posted entry cannot change. Post a reversing entry instead.'); END;
CREATE TRIGGER entries_posted_kept BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'posted: A posted entry cannot be deleted. Post a reversing entry instead.'); END;

CREATE TRIGGER lines_before_entry BEFORE INSERT ON journal_lines
WHEN EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id)
BEGIN SELECT RAISE(ABORT, 'posted: Lines cannot be added to a posted entry.'); END;
CREATE TRIGGER lines_active_account BEFORE INSERT ON journal_lines
WHEN (SELECT archived FROM accounts WHERE id = NEW.account_id) = 1
BEGIN SELECT RAISE(ABORT, 'account_archived: An archived account cannot take new postings.'); END;
CREATE TRIGGER lines_fixed BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'posted: A posted line cannot change.'); END;
CREATE TRIGGER lines_kept BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'posted: A posted line cannot be deleted.'); END;

CREATE TRIGGER bank_rows_fixed BEFORE UPDATE ON bank_imports
WHEN OLD.id IS NOT NEW.id OR OLD.import_id IS NOT NEW.import_id OR OLD.line_no IS NOT NEW.line_no
  OR OLD.bank_account_id IS NOT NEW.bank_account_id OR OLD.posted_on IS NOT NEW.posted_on
  OR OLD.description IS NOT NEW.description OR OLD.amount_cents IS NOT NEW.amount_cents
  OR OLD.currency IS NOT NEW.currency OR OLD.base_hash IS NOT NEW.base_hash
  OR OLD.imported_at_ms IS NOT NEW.imported_at_ms OR (NEW.status = 'duplicate' AND OLD.status <> 'duplicate')
  OR (OLD.status = 'duplicate' AND NEW.status NOT IN ('new', 'duplicate')
    AND NOT (NEW.status = 'ignored' AND OLD.posted_on <= coalesce((SELECT max(end_date) FROM fiscal_periods WHERE status <> 'open'), '')))
  OR (OLD.row_hash IS NOT NEW.row_hash AND NOT (OLD.status = 'duplicate' AND NEW.status = 'new'))
  OR (OLD.linked IS NOT NEW.linked AND NOT (OLD.status = 'new' AND NEW.status = 'posted') AND NOT (OLD.status = 'posted' AND NEW.status = 'new'))
  OR (OLD.status = 'posted' AND NEW.status = 'posted' AND OLD.journal_entry_id IS NOT NEW.journal_entry_id)
  OR (OLD.status = 'posted' AND NOT OLD.linked AND NOT EXISTS (SELECT 1 FROM journal_entries WHERE reverses_entry_id = OLD.journal_entry_id))
BEGIN SELECT RAISE(ABORT, 'bank_row_fixed: An imported bank row keeps its details, and a posted row stays posted until its entry is reversed or the match is undone.'); END;
CREATE TRIGGER bank_rows_kept BEFORE DELETE ON bank_imports
WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'bank_row_fixed: A posted bank row cannot be removed.'); END;

CREATE TRIGGER invoices_issued_fixed BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND (
  OLD.number IS NOT NEW.number OR OLD.client_id IS NOT NEW.client_id OR OLD.issue_date IS NOT NEW.issue_date
  OR OLD.due_date IS NOT NEW.due_date OR OLD.currency IS NOT NEW.currency OR OLD.tax_rate_bp IS NOT NEW.tax_rate_bp
  OR OLD.subtotal_cents IS NOT NEW.subtotal_cents OR OLD.tax_cents IS NOT NEW.tax_cents
  OR OLD.journal_entry_id IS NOT NEW.journal_entry_id OR OLD.status = 'void' OR NEW.status = 'draft'
  OR OLD.seller_name IS NOT NEW.seller_name OR OLD.seller_email IS NOT NEW.seller_email OR OLD.seller_address IS NOT NEW.seller_address
  OR OLD.buyer_name IS NOT NEW.buyer_name OR OLD.buyer_email IS NOT NEW.buyer_email OR OLD.buyer_address IS NOT NEW.buyer_address
  OR (OLD.status = 'paid' AND NEW.status <> 'issued') OR (OLD.status = 'issued' AND NEW.status NOT IN ('issued','paid','void')))
BEGIN SELECT RAISE(ABORT, 'invoice_issued: An issued invoice keeps its amounts. Void it and issue a new one.'); END;
CREATE TRIGGER invoices_issued_kept BEFORE DELETE ON invoices
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice_issued: An issued invoice cannot be deleted. Void it instead.'); END;
CREATE TRIGGER invoices_start_unpaid BEFORE INSERT ON invoices
WHEN NEW.paid_cents <> 0
BEGIN SELECT RAISE(ABORT, 'invoice_paid: The paid amount on an invoice is the sum of its payments.'); END;
CREATE TRIGGER invoices_paid_matches AFTER UPDATE OF paid_cents ON invoices
WHEN NEW.paid_cents <> (SELECT coalesce(sum(amount_cents), 0) FROM invoice_payments WHERE invoice_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'invoice_paid: The paid amount on an invoice is the sum of its payments.'); END;
CREATE TRIGGER invoice_payments_open BEFORE INSERT ON invoice_payments
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS NOT 'issued'
  OR (SELECT total_cents - paid_cents FROM invoices WHERE id = NEW.invoice_id) < NEW.amount_cents
  OR (SELECT e.source || ':' || e.source_id || ':' || e.currency || ':' || e.entry_date || ':' || (SELECT sum(l.credit_cents - l.debit_cents)
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.role = 'receivable') FROM journal_entries e WHERE e.id = NEW.entry_id)
    IS NOT 'payment:' || NEW.invoice_id || ':' || (SELECT currency FROM invoices WHERE id = NEW.invoice_id) || ':' || NEW.paid_on || ':' || NEW.amount_cents
  OR EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = NEW.entry_id)
BEGIN SELECT RAISE(ABORT, 'overpaid: A payment is a payment entry that credits receivables by its amount, to an issued invoice, and no more than what is still due.'); END;
CREATE TRIGGER invoice_payments_paid AFTER INSERT ON invoice_payments
BEGIN
  UPDATE invoices SET paid_cents = paid_cents + NEW.amount_cents,
    status = CASE WHEN paid_cents + NEW.amount_cents = total_cents THEN 'paid' ELSE 'issued' END,
    paid_on = CASE WHEN paid_cents + NEW.amount_cents = total_cents
      THEN (SELECT max(paid_on) FROM invoice_payments WHERE invoice_id = NEW.invoice_id) END,
    version = version + 1
  WHERE id = NEW.invoice_id;
END;
CREATE TRIGGER invoice_payments_fixed BEFORE UPDATE ON invoice_payments
BEGIN SELECT RAISE(ABORT, 'posted: A recorded payment cannot change. Reverse its entry instead.'); END;
CREATE TRIGGER invoice_payments_kept BEFORE DELETE ON invoice_payments
WHEN NOT EXISTS (SELECT 1 FROM journal_entries WHERE reverses_entry_id = OLD.entry_id)
BEGIN SELECT RAISE(ABORT, 'posted: A payment leaves its invoice only when its entry is reversed.'); END;
CREATE TRIGGER invoice_payments_reversed AFTER DELETE ON invoice_payments
BEGIN
  UPDATE invoices SET paid_cents = paid_cents - OLD.amount_cents, status = 'issued', paid_on = NULL, version = version + 1
  WHERE id = OLD.invoice_id;
END;
CREATE TRIGGER reconciliations_bank BEFORE INSERT ON reconciliations
WHEN (SELECT is_bank FROM accounts WHERE id = NEW.bank_account_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'invalid_input: Only a bank account can be reconciled.'); END;
CREATE TRIGGER reconciliations_fixed BEFORE UPDATE ON reconciliations
BEGIN SELECT RAISE(ABORT, 'reconciliation_fixed: A reconciliation cannot change. Remove it and reconcile again.'); END;
CREATE TRIGGER reconciliations_closed BEFORE DELETE ON reconciliations
WHEN OLD.statement_date <= coalesce((SELECT max(end_date) FROM fiscal_periods WHERE status <> 'open'), '')
BEGIN SELECT RAISE(ABORT, 'period_closed: A reconciliation in a closed month stays as it is.'); END;
CREATE TRIGGER invoice_lines_draft_insert BEFORE INSERT ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice_issued: Only a draft invoice can change its lines.'); END;
CREATE TRIGGER invoice_lines_draft_update BEFORE UPDATE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'invoice_issued: Only a draft invoice can change its lines.'); END;
CREATE TRIGGER invoice_lines_draft_delete BEFORE DELETE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IN ('issued','paid','void')
BEGIN SELECT RAISE(ABORT, 'invoice_issued: Only a draft invoice can change its lines.'); END;

INSERT INTO accounts(id,name,type,role,is_bank) VALUES
  ('1000','Checking account','asset',NULL,1),
  ('1010','Savings account','asset',NULL,1),
  ('1100','Accounts receivable','asset','receivable',0),
  ('1500','Equipment','asset',NULL,0),
  ('2000','Accounts payable','liability',NULL,0),
  ('2100','Sales tax payable','liability','sales_tax',0),
  ('2200','Credit card','liability',NULL,0),
  ('3000','Owner''s capital','equity',NULL,0),
  ('3100','Owner''s draws','equity',NULL,0),
  ('4000','Service revenue','income',NULL,0),
  ('4100','Product sales','income',NULL,0),
  ('4900','Interest income','income',NULL,0),
  ('5000','Cost of goods sold','expense',NULL,0),
  ('6000','Rent','expense',NULL,0),
  ('6100','Software and subscriptions','expense',NULL,0),
  ('6200','Office supplies','expense',NULL,0),
  ('6300','Bank fees','expense',NULL,0),
  ('6400','Travel','expense',NULL,0),
  ('6500','Meals','expense',NULL,0),
  ('6600','Professional fees','expense',NULL,0),
  ('6900','Other expenses','expense',NULL,0);
