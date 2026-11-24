(function () {
  const MAX_CENTS = 1000000000000;
  const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"];
  const DEBIT_NORMAL = new Set(["asset", "expense"]);
  const MAX_ACCOUNTS = 500;
  const MAX_PERIODS = 600;
  const MAX_LINES = 500;
  const MAX_BANK_BATCH = 500;
  const MAX_POST_BATCH = 500;
  const PARAMETER_BYTES = 60 * 1024;

  function invalid(ctx, message) {
    ctx.refuse("invalid_input", message);
  }
  function owner(ctx) {
    if (ctx.caller.kind !== "owner" && ctx.caller.kind !== "automation")
      ctx.refuse("forbidden", "Only the owner of these books can change them.");
  }
  function object(ctx, value, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(ctx, message);
    return value;
  }
  function text(ctx, value, max, message, optional = false) {
    if (optional && (value === undefined || value === null || value === "")) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max) invalid(ctx, message);
    return value.trim();
  }
  function isoDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return year >= 1900 && year <= 2999 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  function date(ctx, value, message) {
    if (!isoDate(value)) invalid(ctx, message);
    return value;
  }
  function currency(ctx, value) {
    if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
      invalid(ctx, "Use a three-letter currency code, such as USD.");
    return value;
  }
  function cents(ctx, value, message) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) invalid(ctx, message);
    return value;
  }
  function limit(ctx, value, fallback, max) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < 1 || result > max)
      invalid(ctx, `Choose a page size from 1 to ${max}.`);
    return result;
  }
  function list(ctx, value, min, max, message) {
    if (!Array.isArray(value) || value.length < min || value.length > max) invalid(ctx, message);
    return value;
  }
  function mapped(ctx, error) {
    const match = /^([a-z][a-z0-9_]{0,63}): (.+)$/s.exec(String(error && error.message));
    if (match) ctx.refuse(match[1], match[2]);
    throw error;
  }
  function execute(ctx, sql, params = []) {
    try {
      return ctx.db.execute(sql, params);
    } catch (error) {
      return mapped(ctx, error);
    }
  }
  function each(columns) {
    return `WITH RECURSIVE i(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM i WHERE n + 1 < json_array_length(?1))
      SELECT ${columns.map((_, index) => `json_extract(?1, '$[' || n || '][${index}]')`).join(", ")} FROM i`;
  }
  function byteLength(value) {
    let bytes = 0;
    for (const character of value) {
      const code = character.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }
  function insertRows(ctx, table, columns, rows) {
    const sql = `INSERT INTO ${table}(${columns.join(",")}) ${each(columns)}`;
    let chunk = [], bytes = 2;
    for (const row of rows) {
      const json = JSON.stringify(row);
      const size = byteLength(json) + 1;
      if (chunk.length && bytes + size > PARAMETER_BYTES) {
        execute(ctx, sql, [`[${chunk.join(",")}]`]);
        chunk = [];
        bytes = 2;
      }
      chunk.push(json);
      bytes += size;
    }
    if (chunk.length) execute(ctx, sql, [`[${chunk.join(",")}]`]);
  }
  function jsonList() {
    return `SELECT json_extract(?1, '$[' || n || ']') FROM (WITH RECURSIVE i(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM i WHERE n + 1 < json_array_length(?1)) SELECT n FROM i)`;
  }
  function signedBalance(type, debit, credit) {
    return DEBIT_NORMAL.has(type) ? debit - credit : credit - debit;
  }

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function utf8(value) {
    const bytes = [];
    for (const character of value) {
      let code = character.codePointAt(0);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    return bytes;
  }
  function sha256(value) {
    const bytes = utf8(value);
    const words = new Array(((bytes.length + 72) >> 6) << 4).fill(0);
    for (let index = 0; index < bytes.length; index++) words[index >> 2] |= bytes[index] << (24 - (index & 3) * 8);
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length & 3) * 8);
    words[words.length - 1] = bytes.length * 8;
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let block = 0; block < words.length; block += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[block + t];
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15], y = w[t - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let t = 0; t < 64; t++) {
        const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0; hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
      hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0; hash[6] = (hash[6] + g) | 0; hash[7] = (hash[7] + h) | 0;
    }
    return hash.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
  }

  function parseAmount(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const raw = String(value).trim();
    const paren = /^\(\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*\)$/.exec(raw);
    const signed = paren ? null : /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(raw);
    if (!paren && !signed) return null;
    const negative = Boolean(paren) || signed[1] === "-";
    const whole = (paren ? paren[1] : signed[2]).replace(/,/g, "");
    const frac = (paren ? paren[2] : signed[3]) || "";
    if (whole.length > 13) return null;
    const amount = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    if (!Number.isSafeInteger(amount) || amount > MAX_CENTS) return null;
    return negative ? -amount : amount;
  }

  function accountsById(ctx) {
    const rows = ctx.db.query("SELECT id,name,type,role,is_bank AS isBank,archived FROM accounts ORDER BY id");
    return new Map(rows.map((row) => [row.id, row]));
  }
  function roleAccount(ctx, accounts, role) {
    for (const account of accounts.values()) if (account.role === role) return account;
    ctx.refuse("missing_account", `Mark one account as ${role === "receivable" ? "accounts receivable" : "sales tax"} first.`);
  }
  function periods(ctx) {
    return ctx.db.query("SELECT id,start_date AS startDate,end_date AS endDate,status FROM fiscal_periods ORDER BY start_date");
  }
  function openPeriodCheck(ctx, allPeriods, entryDate) {
    const period = allPeriods.find((row) => row.startDate <= entryDate && entryDate <= row.endDate);
    if (!period) ctx.refuse("period_closed", `${entryDate} is outside every fiscal period. Open its fiscal year first.`);
    if (period.status !== "open") ctx.refuse("period_closed", `${entryDate} is in locked period ${period.id}.`);
  }

  function normalizeEntry(ctx, input, accounts, allPeriods, index) {
    const where = index === undefined ? "" : ` (entry ${index + 1})`;
    object(ctx, input, `Enter the journal entry${where}.`);
    const entryDate = date(ctx, input.date, `Enter the entry date as YYYY-MM-DD${where}.`);
    openPeriodCheck(ctx, allPeriods, entryDate);
    const entryCurrency = currency(ctx, input.currency);
    const memo = input.memo === undefined ? "" : typeof input.memo === "string" && input.memo.length <= 500 ? input.memo.trim() : invalid(ctx, `Keep the memo under 500 characters${where}.`);
    const lines = list(ctx, input.lines, 2, MAX_LINES, `An entry needs 2 to ${MAX_LINES} lines${where}.`).map((line) => {
      object(ctx, line, `Enter each line${where}.`);
      const account = accounts.get(line.accountId);
      if (!account) invalid(ctx, `Choose an existing account for each line${where}.`);
      if (account.archived) ctx.refuse("account_archived", `${account.id} ${account.name} is archived${where}.`);
      const debitCents = line.debitCents === undefined ? 0 : cents(ctx, line.debitCents, `Enter debits as whole cents${where}.`);
      const creditCents = line.creditCents === undefined ? 0 : cents(ctx, line.creditCents, `Enter credits as whole cents${where}.`);
      if ((debitCents > 0) + (creditCents > 0) !== 1) invalid(ctx, `Each line needs either a debit or a credit${where}.`);
      const lineMemo = line.memo === undefined || line.memo === null ? null : text(ctx, line.memo, 200, `Keep line memos under 200 characters${where}.`, true);
      return { accountId: account.id, debitCents, creditCents, memo: lineMemo };
    });
    let debits = 0, credits = 0;
    for (const line of lines) {
      debits += line.debitCents;
      credits += line.creditCents;
    }
    if (!Number.isSafeInteger(debits) || debits > MAX_CENTS * 10) invalid(ctx, `The entry total is too large${where}.`);
    if (debits !== credits) ctx.refuse("unbalanced", `Debits ${debits} and credits ${credits} differ by ${Math.abs(debits - credits)} cents${where}.`);
    return { date: entryDate, currency: entryCurrency, memo, lines, totalCents: debits };
  }

  // Lines go in before their entry: the entry's insert trigger checks the balance, and later lines are refused.
  function insertEntries(ctx, entries) {
    let number = ctx.db.query("SELECT coalesce(max(number),0) AS n FROM journal_entries")[0].n;
    const lineRows = [], entryRows = [], created = [];
    entries.forEach((entry, index) => {
      const id = entries.length === 1 && !entry.idSuffix ? ctx.requestId : `${ctx.requestId}-${entry.idSuffix || index + 1}`;
      number += 1;
      entry.lines.forEach((line, lineIndex) =>
        lineRows.push([`${id}-${lineIndex + 1}`, id, lineIndex + 1, line.accountId, line.debitCents, line.creditCents, line.memo]));
      entryRows.push([id, number, entry.date, entry.currency, entry.memo, entry.source || "manual", entry.sourceId || null,
        entry.reversesEntryId || null, entry.totalCents, entry.receiptFileId || null, ctx.nowMs]);
      created.push({ id, number, date: entry.date, currency: entry.currency, totalCents: entry.totalCents });
    });
    insertRows(ctx, "journal_lines", ["id", "entry_id", "line_no", "account_id", "debit_cents", "credit_cents", "memo"], lineRows);
    insertRows(ctx, "journal_entries", ["id", "number", "entry_date", "currency", "memo", "source", "source_id",
      "reverses_entry_id", "total_cents", "receipt_file_id", "created_at_ms"], entryRows);
    return created;
  }
  function receipt(ctx, fileId) {
    if (fileId === undefined || fileId === null) return null;
    if (typeof fileId !== "string") invalid(ctx, "Choose an uploaded receipt.");
    const file = ctx.files.attach(fileId);
    if (!/^(application\/pdf|image\/(png|jpeg|webp|gif|heic))$/.test(file.contentType))
      ctx.refuse("invalid_receipt", "Attach a receipt as a PDF or an image.");
    return file.fileId;
  }

  function postJournalEntry(ctx, input) {
    owner(ctx);
    const entry = normalizeEntry(ctx, input, accountsById(ctx), periods(ctx));
    entry.receiptFileId = receipt(ctx, input.receiptFileId);
    return insertEntries(ctx, [entry])[0];
  }
  function postJournalEntries(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the journal entries.");
    const accounts = accountsById(ctx), allPeriods = periods(ctx);
    const entries = list(ctx, input.entries, 1, MAX_POST_BATCH, `Post 1 to ${MAX_POST_BATCH} entries at a time.`)
      .map((entry, index) => normalizeEntry(ctx, entry, accounts, allPeriods, index));
    const created = insertEntries(ctx, entries);
    return { posted: created.length, firstNumber: created[0].number, lastNumber: created[created.length - 1].number,
      lines: entries.reduce((sum, entry) => sum + entry.lines.length, 0) };
  }
  function entryWithLines(ctx, id) {
    const entry = ctx.db.query(`SELECT e.id,e.number,e.entry_date AS date,e.currency,e.memo,e.source,e.source_id AS sourceId,
      e.reverses_entry_id AS reversesEntryId,e.total_cents AS totalCents,e.receipt_file_id AS receiptFileId,
      (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversedByEntryId
      FROM journal_entries e WHERE e.id=?`, [id])[0];
    if (!entry) ctx.refuse("not_found", "That journal entry does not exist.");
    entry.lines = ctx.db.query(`SELECT l.line_no AS lineNo,l.account_id AS accountId,a.name AS accountName,
      l.debit_cents AS debitCents,l.credit_cents AS creditCents,l.memo FROM journal_lines l JOIN accounts a ON a.id=l.account_id
      WHERE l.entry_id=? ORDER BY l.line_no`, [id]);
    return entry;
  }
  function reversal(ctx, entry, reversalDate, memo) {
    openPeriodCheck(ctx, periods(ctx), reversalDate);
    if (entry.reversedByEntryId) ctx.refuse("already_reversed", `Entry ${entry.number} is already reversed.`);
    if (entry.reversesEntryId) ctx.refuse("is_reversal", `Entry ${entry.number} is a reversal. Post a new entry instead.`);
    return insertEntries(ctx, [{
      date: reversalDate, currency: entry.currency, memo, source: "reversal", sourceId: entry.sourceId,
      reversesEntryId: entry.id, totalCents: entry.totalCents, idSuffix: "reversal",
      lines: entry.lines.map((line) => ({ accountId: line.accountId, debitCents: line.creditCents, creditCents: line.debitCents, memo: line.memo })),
    }])[0];
  }
  function reverseJournalEntry(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry to reverse.");
    const entry = entryWithLines(ctx, text(ctx, input.entryId, 200, "Choose an entry to reverse."));
    if (entry.source === "invoice") ctx.refuse("use_invoice", "Void the invoice to reverse its entry.");
    const reversalDate = input.date === undefined ? entry.date : date(ctx, input.date, "Enter the reversal date as YYYY-MM-DD.");
    const memo = `Reversal of entry ${entry.number}${entry.memo ? `: ${entry.memo}` : ""}`.slice(0, 500);
    const created = reversal(ctx, entry, reversalDate, memo);
    if (entry.source === "payment")
      execute(ctx, "UPDATE invoices SET status='issued',payment_entry_id=NULL,paid_on=NULL,version=version+1 WHERE payment_entry_id=?", [entry.id]);
    execute(ctx, "UPDATE bank_imports SET status='new',journal_entry_id=NULL WHERE journal_entry_id=?", [entry.id]);
    return created;
  }
  function attachReceipt(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry and a receipt.");
    const entryId = text(ctx, input.entryId, 200, "Choose an entry.");
    const fileId = receipt(ctx, input.fileId);
    if (!fileId) invalid(ctx, "Choose an uploaded receipt.");
    if (execute(ctx, "UPDATE journal_entries SET receipt_file_id=? WHERE id=? AND receipt_file_id IS NULL", [fileId, entryId]).changes !== 1)
      ctx.refuse("conflict", "That entry does not exist or already has a receipt.");
    return { entryId, fileId };
  }
  function receiptAccess(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry.");
    const row = ctx.db.query("SELECT receipt_file_id AS fileId FROM journal_entries WHERE id=?", [input.entryId])[0];
    if (!row || !row.fileId) ctx.refuse("not_found", "This entry has no receipt.");
    return { fileId: row.fileId };
  }

  function addAccount(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the account.");
    if (typeof input.id !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]{0,11}$/.test(input.id))
      invalid(ctx, "Use an account code of up to 12 letters, digits, dots, or dashes.");
    const name = text(ctx, input.name, 120, "Enter an account name up to 120 characters.");
    if (!ACCOUNT_TYPES.includes(input.type)) invalid(ctx, "Choose asset, liability, equity, income, or expense.");
    const isBank = input.isBank === true;
    if (isBank && input.type !== "asset") invalid(ctx, "Only an asset account can be a bank account.");
    if (ctx.db.query("SELECT count(*) AS n FROM accounts")[0].n >= MAX_ACCOUNTS)
      ctx.refuse("limit", `These books hold at most ${MAX_ACCOUNTS} accounts.`);
    if (ctx.db.query("SELECT 1 FROM accounts WHERE id=?", [input.id]).length) ctx.refuse("conflict", `Account ${input.id} already exists.`);
    execute(ctx, "INSERT INTO accounts(id,name,type,is_bank,archived) VALUES(?,?,?,?,0)", [input.id, name, input.type, isBank ? 1 : 0]);
    return { id: input.id, name, type: input.type, isBank };
  }
  function updateAccount(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an account.");
    const account = accountsById(ctx).get(input.id);
    if (!account) ctx.refuse("not_found", "That account does not exist.");
    const name = input.name === undefined ? account.name : text(ctx, input.name, 120, "Enter an account name up to 120 characters.");
    const archived = input.archived === undefined ? account.archived : input.archived === true ? 1 : input.archived === false ? 0 : invalid(ctx, "Choose whether the account is archived.");
    if (archived && account.role) ctx.refuse("account_in_use", "Invoices post to this account, so it stays active.");
    execute(ctx, "UPDATE accounts SET name=?,archived=? WHERE id=?", [name, archived, account.id]);
    return { id: account.id, name, archived: archived === 1 };
  }
  function listAccounts(ctx) {
    owner(ctx);
    return ctx.db.query(`SELECT a.id,a.name,a.type,a.role,a.is_bank AS isBank,a.archived,
      EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id=a.id) AS used FROM accounts a ORDER BY a.id`)
      .map((row) => ({ ...row, isBank: row.isBank === 1, archived: row.archived === 1, used: row.used === 1 }));
  }

  function addFiscalYear(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a fiscal year.");
    const year = input.year, startMonth = input.startMonth === undefined ? 1 : input.startMonth;
    if (!Number.isSafeInteger(year) || year < 1900 || year > 2998) invalid(ctx, "Choose a year from 1900 to 2998.");
    if (!Number.isSafeInteger(startMonth) || startMonth < 1 || startMonth > 12) invalid(ctx, "Choose a starting month from 1 to 12.");
    if (ctx.db.query("SELECT count(*) AS n FROM fiscal_periods")[0].n + 12 > MAX_PERIODS)
      ctx.refuse("limit", `These books hold at most ${MAX_PERIODS} fiscal periods.`);
    const rows = [];
    for (let index = 0; index < 12; index++) {
      const month = (startMonth - 1 + index) % 12, periodYear = year + Math.floor((startMonth - 1 + index) / 12);
      const start = new Date(Date.UTC(periodYear, month, 1)), end = new Date(Date.UTC(periodYear, month + 1, 0));
      const startDate = start.toISOString().slice(0, 10), endDate = end.toISOString().slice(0, 10);
      rows.push([startDate.slice(0, 7), startDate, endDate]);
    }
    insertRows(ctx, "fiscal_periods", ["id", "start_date", "end_date"], rows);
    return { periods: rows.map(([id, startDate, endDate]) => ({ id, startDate, endDate, status: "open" })) };
  }
  function lockPeriod(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a period to lock.");
    const all = periods(ctx);
    const index = all.findIndex((row) => row.id === input.periodId);
    if (index < 0) ctx.refuse("not_found", "That fiscal period does not exist.");
    if (all[index].status === "locked") return { id: all[index].id, status: "locked" };
    const earlier = all.slice(0, index).find((row) => row.status === "open");
    if (earlier) ctx.refuse("lock_in_order", `Lock ${earlier.id} first. Periods lock in order.`);
    execute(ctx, "UPDATE fiscal_periods SET status='locked',locked_at_ms=? WHERE id=?", [ctx.nowMs, all[index].id]);
    return { id: all[index].id, status: "locked" };
  }
  function listPeriods(ctx) {
    owner(ctx);
    return ctx.db.query(`SELECT p.id,p.start_date AS startDate,p.end_date AS endDate,p.status,
      (SELECT count(*) FROM journal_entries e WHERE e.entry_date BETWEEN p.start_date AND p.end_date) AS entries
      FROM fiscal_periods p ORDER BY p.start_date`);
  }
  function listEntries(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a page of entries.");
    const size = limit(ctx, input.limit, 50, 200);
    const before = input.beforeNumber === undefined ? Number.MAX_SAFE_INTEGER : input.beforeNumber;
    if (!Number.isSafeInteger(before)) invalid(ctx, "The page is invalid.");
    const rows = ctx.db.query(`SELECT e.id,e.number,e.entry_date AS date,e.currency,e.memo,e.source,e.total_cents AS totalCents,
      e.receipt_file_id IS NOT NULL AS hasReceipt,e.reverses_entry_id AS reversesEntryId,
      EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed,
      (SELECT group_concat(a.name, ', ') FROM (SELECT DISTINCT l.account_id FROM journal_lines l WHERE l.entry_id=e.id LIMIT 4) x
        JOIN accounts a ON a.id=x.account_id) AS accounts
      FROM journal_entries e WHERE e.number < ? ORDER BY e.number DESC LIMIT ?`, [before, size + 1]);
    const more = rows.length > size;
    if (more) rows.pop();
    return { entries: rows.map((row) => ({ ...row, hasReceipt: row.hasReceipt === 1, reversed: row.reversed === 1 })),
      nextBeforeNumber: more ? rows[rows.length - 1].number : null };
  }
  function getEntry(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry.");
    return entryWithLines(ctx, input.id);
  }

  function stageBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the bank statement rows.");
    if (typeof input.importId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.importId))
      invalid(ctx, "Use an import ID of 8 to 64 letters, digits, dashes, or underscores.");
    const bank = accountsById(ctx).get(input.bankAccountId);
    if (!bank || !bank.isBank) invalid(ctx, "Choose a bank account.");
    const rowCurrency = currency(ctx, input.currency);
    if (!Number.isSafeInteger(input.firstLine) || input.firstLine < 1) invalid(ctx, "Enter the first line number of this batch.");
    const rows = list(ctx, input.rows, 1, MAX_BANK_BATCH, `Send 1 to ${MAX_BANK_BATCH} rows at a time.`);
    const stored = ctx.db.query("SELECT count(*) AS n,min(bank_account_id) AS bank,min(currency) AS currency FROM bank_imports WHERE import_id=?", [input.importId])[0];
    if (stored.n && (stored.bank !== bank.id || stored.currency !== rowCurrency))
      ctx.refuse("conflict", "This import already belongs to another bank account or currency.");
    const lastLine = input.firstLine + rows.length - 1;
    if (stored.n >= lastLine)
      return { importId: input.importId, added: 0, duplicates: 0, alreadyStaged: rows.length, nextLine: stored.n + 1 };
    if (stored.n !== input.firstLine - 1)
      ctx.refuse("out_of_order", `Send line ${stored.n + 1} next. Batches of one import go in order.`);
    const parsed = rows.map((row, index) => {
      const where = `line ${input.firstLine + index}`;
      if (!Array.isArray(row) || row.length !== 3) invalid(ctx, `Send ${where} as [date, description, amount].`);
      if (!isoDate(row[0])) invalid(ctx, `The date on ${where} must be YYYY-MM-DD.`);
      if (typeof row[1] !== "string" || row[1].length > 300) invalid(ctx, `The description on ${where} must be text up to 300 characters.`);
      const amountCents = parseAmount(row[2]);
      if (amountCents === null || amountCents === 0) invalid(ctx, `The amount on ${where} must be a nonzero amount with at most two decimals.`);
      const description = row[1].trim().replace(/\s+/g, " ");
      const base = sha256([bank.id, row[0], String(amountCents), rowCurrency, description.toLowerCase()].join("\n"));
      return { lineNo: input.firstLine + index, date: row[0], description, amountCents, base };
    });
    const priorCounts = new Map(ctx.db.query(
      `SELECT base_hash AS base,count(*) AS n FROM bank_imports WHERE import_id=?2 AND base_hash IN (${jsonList()}) GROUP BY base_hash`,
      [JSON.stringify([...new Set(parsed.map((row) => row.base))]), input.importId]).map((row) => [row.base, row.n]));
    for (const row of parsed) {
      const occurrence = (priorCounts.get(row.base) || 0) + 1;
      priorCounts.set(row.base, occurrence);
      row.hash = sha256(`${row.base}\n${occurrence}`);
    }
    const known = new Set(ctx.db.query(`SELECT row_hash AS hash FROM bank_imports WHERE status<>'duplicate' AND row_hash IN (${jsonList()})`,
      [JSON.stringify(parsed.map((row) => row.hash))]).map((row) => row.hash));
    let duplicates = 0;
    insertRows(ctx, "bank_imports", ["id", "import_id", "line_no", "bank_account_id", "posted_on", "description", "amount_cents",
      "currency", "base_hash", "row_hash", "status", "imported_at_ms"], parsed.map((row) => {
      const duplicate = known.has(row.hash);
      if (duplicate) duplicates += 1;
      return [`${input.importId}-${row.lineNo}`, input.importId, row.lineNo, bank.id, row.date, row.description, row.amountCents,
        rowCurrency, row.base, row.hash, duplicate ? "duplicate" : "new", ctx.nowMs];
    }));
    return { importId: input.importId, added: parsed.length - duplicates, duplicates, alreadyStaged: 0, nextLine: lastLine + 1 };
  }
  function listBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows.");
    const status = input.status === undefined ? "new" : input.status;
    if (!["new", "duplicate", "posted", "ignored"].includes(status)) invalid(ctx, "Choose new, duplicate, posted, or ignored rows.");
    const size = limit(ctx, input.limit, 100, 100);
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    const rows = ctx.db.query(`SELECT b.id,b.import_id AS importId,b.line_no AS lineNo,b.bank_account_id AS bankAccountId,
      b.posted_on AS date,b.description,b.amount_cents AS amountCents,b.currency,b.status,b.journal_entry_id AS journalEntryId,b.row_hash AS rowHash
      FROM bank_imports b WHERE b.status=? ORDER BY b.posted_on DESC,b.id LIMIT ? OFFSET ?`, [status, size + 1, offset]);
    const counts = Object.fromEntries(ctx.db.query("SELECT status,count(*) AS n FROM bank_imports GROUP BY status").map((row) => [row.status, row.n]));
    const more = rows.length > size;
    if (more) rows.pop();
    return { rows, counts, nextOffset: more ? offset + size : null };
  }
  function postBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows to post.");
    const picks = list(ctx, input.rows, 1, MAX_POST_BATCH, `Post 1 to ${MAX_POST_BATCH} bank rows at a time.`);
    const accounts = accountsById(ctx), allPeriods = periods(ctx);
    const ids = picks.map((pick) => object(ctx, pick, "Choose each bank row and account.").id);
    if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) invalid(ctx, "Choose each bank row once.");
    const rows = new Map(ctx.db.query(`SELECT id,bank_account_id AS bankAccountId,posted_on AS date,description,amount_cents AS amountCents,currency,status
      FROM bank_imports WHERE id IN (${jsonList()})`, [JSON.stringify(ids)]).map((row) => [row.id, row]));
    const entries = picks.map((pick, index) => {
      const row = rows.get(pick.id);
      if (!row) ctx.refuse("not_found", `Bank row ${pick.id} does not exist.`);
      if (row.status !== "new") ctx.refuse("conflict", `Bank row ${pick.id} is ${row.status}, not new.`);
      const account = accounts.get(pick.accountId);
      if (!account || account.id === row.bankAccountId) invalid(ctx, `Choose the other account for ${row.description || "each row"}.`);
      const amount = Math.abs(row.amountCents);
      const bankSide = { accountId: row.bankAccountId, debitCents: row.amountCents > 0 ? amount : 0, creditCents: row.amountCents < 0 ? amount : 0 };
      const otherSide = { accountId: account.id, debitCents: bankSide.creditCents, creditCents: bankSide.debitCents };
      const memo = pick.memo === undefined ? row.description : text(ctx, pick.memo, 500, "Keep memos under 500 characters.");
      return { ...normalizeEntry(ctx, { date: row.date, currency: row.currency, memo, lines: [bankSide, otherSide] }, accounts, allPeriods, index),
        source: "bank", sourceId: row.id, idSuffix: `b${index + 1}` };
    });
    const created = insertEntries(ctx, entries);
    execute(ctx, `UPDATE bank_imports SET status='posted',journal_entry_id=(SELECT e.id FROM journal_entries e
      WHERE e.source='bank' AND e.source_id=bank_imports.id AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id))
      WHERE id IN (${jsonList()})`, [JSON.stringify(ids)]);
    return { posted: created.length, entries: created.map((entry) => entry.id) };
  }
  function setBankRowsIgnored(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows.");
    const ids = list(ctx, input.ids, 1, MAX_BANK_BATCH, `Choose 1 to ${MAX_BANK_BATCH} rows.`);
    if (ids.some((id) => typeof id !== "string")) invalid(ctx, "Choose bank rows by ID.");
    const [from, to] = input.ignored === false ? ["ignored", "new"] : ["new", "ignored"];
    const changed = execute(ctx, `UPDATE bank_imports SET status=?2 WHERE status=?3 AND id IN (${jsonList()})`, [JSON.stringify(ids), to, from]).changes;
    return { changed };
  }
  function keepDuplicateBankRow(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a duplicate bank row.");
    const id = text(ctx, input.id, 200, "Choose a duplicate bank row.");
    const row = ctx.db.query("SELECT id,base_hash AS baseHash,status FROM bank_imports WHERE id=?", [id])[0];
    if (!row) ctx.refuse("not_found", "That bank row does not exist.");
    if (row.status !== "duplicate") ctx.refuse("conflict", `Bank row ${id} is ${row.status}, not duplicate.`);
    const existing = new Set(ctx.db.query("SELECT row_hash AS hash FROM bank_imports WHERE status<>'duplicate' AND base_hash=?", [row.baseHash]).map((item) => item.hash));
    let occurrence = existing.size + 1;
    let nextHash = sha256(`${row.baseHash}\n${occurrence}`);
    while (existing.has(nextHash)) {
      occurrence += 1;
      nextHash = sha256(`${row.baseHash}\n${occurrence}`);
    }
    execute(ctx, "UPDATE bank_imports SET status='new',row_hash=? WHERE id=? AND status='duplicate'", [nextHash, id]);
    return { id, status: "new", rowHash: nextHash };
  }

  function saveClient(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the client.");
    const name = text(ctx, input.name, 150, "Enter a client name up to 150 characters.");
    const email = text(ctx, input.email, 200, "Keep the email under 200 characters.", true);
    const address = text(ctx, input.address, 500, "Keep the address under 500 characters.", true);
    if (input.id !== undefined) {
      if (execute(ctx, "UPDATE clients SET name=?,email=?,address=? WHERE id=?", [name, email, address, input.id]).changes !== 1)
        ctx.refuse("not_found", "That client does not exist.");
      return { id: input.id, name, email, address };
    }
    execute(ctx, "INSERT INTO clients(id,name,email,address,created_at_ms) VALUES(?,?,?,?,?)", [ctx.requestId, name, email, address, ctx.nowMs]);
    return { id: ctx.requestId, name, email, address };
  }
  function listClients(ctx) {
    owner(ctx);
    return ctx.db.query("SELECT id,name,email,address FROM clients ORDER BY name,id LIMIT 1000");
  }
  function quantityMilli(ctx, value) {
    const milli = Math.round(value * 1000);
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value * 1000 - milli) > 1e-6 || milli < 1 || milli > 1000000000)
      invalid(ctx, "Enter a positive quantity with at most three decimals.");
    return milli;
  }
  function roundedDivide(ctx, numerator, divisor) {
    if (!Number.isSafeInteger(numerator)) invalid(ctx, "The invoice amount is too large.");
    return Math.floor((numerator + divisor / 2) / divisor);
  }
  function saveDraftInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the invoice.");
    const accounts = accountsById(ctx);
    const client = ctx.db.query("SELECT id FROM clients WHERE id=?", [input.clientId])[0];
    if (!client) invalid(ctx, "Choose a client.");
    const issueDate = date(ctx, input.issueDate, "Enter the issue date as YYYY-MM-DD.");
    const dueDate = date(ctx, input.dueDate, "Enter the due date as YYYY-MM-DD.");
    if (dueDate < issueDate) invalid(ctx, "The due date cannot be before the issue date.");
    const invoiceCurrency = currency(ctx, input.currency);
    const taxRateBp = input.taxRateBp === undefined ? 0 : input.taxRateBp;
    if (!Number.isSafeInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10000) invalid(ctx, "Enter a tax rate from 0% to 100%.");
    const notes = text(ctx, input.notes, 1000, "Keep notes under 1,000 characters.", true);
    const lines = list(ctx, input.lines, 1, 100, "An invoice needs 1 to 100 lines.").map((line, index) => {
      object(ctx, line, "Enter each invoice line.");
      const description = text(ctx, line.description, 300, `Describe line ${index + 1} in up to 300 characters.`);
      const milli = quantityMilli(ctx, line.quantity);
      const unitPriceCents = cents(ctx, line.unitPriceCents, `Enter the unit price on line ${index + 1} in whole cents.`);
      const account = accounts.get(line.revenueAccountId);
      if (!account || account.type !== "income" || account.archived) invalid(ctx, `Choose an active income account on line ${index + 1}.`);
      return { description, milli, unitPriceCents, amountCents: roundedDivide(ctx, milli * unitPriceCents, 1000), accountId: account.id };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
    const tax = roundedDivide(ctx, subtotal * taxRateBp, 10000);
    if (subtotal + tax > MAX_CENTS) invalid(ctx, "The invoice total is too large.");
    let id = ctx.requestId, version = 1;
    if (input.id !== undefined) {
      const current = ctx.db.query("SELECT id,status,version FROM invoices WHERE id=?", [input.id])[0];
      if (!current) ctx.refuse("not_found", "That invoice does not exist.");
      if (current.status !== "draft") ctx.refuse("invoice_issued", "Only a draft invoice can change.");
      if (input.expectedVersion !== current.version) ctx.refuse("conflict", "This invoice changed. Reload it before saving.");
      id = current.id;
      version = current.version + 1;
      execute(ctx, "DELETE FROM invoice_lines WHERE invoice_id=?", [id]);
      execute(ctx, `UPDATE invoices SET client_id=?,issue_date=?,due_date=?,currency=?,tax_rate_bp=?,subtotal_cents=?,tax_cents=?,total_cents=?,notes=?,version=?
        WHERE id=?`, [client.id, issueDate, dueDate, invoiceCurrency, taxRateBp, subtotal, tax, subtotal + tax, notes, version, id]);
    } else {
      execute(ctx, `INSERT INTO invoices(id,client_id,issue_date,due_date,currency,tax_rate_bp,subtotal_cents,tax_cents,total_cents,notes,status,version,created_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,'draft',1,?)`, [id, client.id, issueDate, dueDate, invoiceCurrency, taxRateBp, subtotal, tax, subtotal + tax, notes, ctx.nowMs]);
    }
    insertRows(ctx, "invoice_lines", ["id", "invoice_id", "line_no", "description", "quantity_milli", "unit_price_cents", "amount_cents", "revenue_account_id"],
      lines.map((line, index) => [`${id}-${version}-${index + 1}`, id, index + 1, line.description, line.milli, line.unitPriceCents, line.amountCents, line.accountId]));
    return { id, version, status: "draft", subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax };
  }
  function deleteDraftInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a draft invoice.");
    if (execute(ctx, "DELETE FROM invoices WHERE id=? AND status='draft' AND version=?", [input.id, input.expectedVersion]).changes !== 1)
      ctx.refuse("conflict", "Only an unchanged draft invoice can be deleted.");
    return { id: input.id, deleted: true };
  }
  function invoice(ctx, id) {
    const row = ctx.db.query(`SELECT i.id,i.number,i.client_id AS clientId,c.name AS clientName,c.email AS clientEmail,c.address AS clientAddress,
      i.issue_date AS issueDate,i.due_date AS dueDate,i.currency,i.tax_rate_bp AS taxRateBp,i.subtotal_cents AS subtotalCents,
      i.tax_cents AS taxCents,i.total_cents AS totalCents,i.notes,i.status,i.journal_entry_id AS journalEntryId,
      i.payment_entry_id AS paymentEntryId,i.void_entry_id AS voidEntryId,i.paid_on AS paidOn,i.version
      FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`, [id])[0];
    if (!row) ctx.refuse("not_found", "That invoice does not exist.");
    row.lines = ctx.db.query(`SELECT line_no AS lineNo,description,quantity_milli AS quantityMilli,unit_price_cents AS unitPriceCents,
      amount_cents AS amountCents,revenue_account_id AS revenueAccountId FROM invoice_lines WHERE invoice_id=? ORDER BY line_no`, [id]);
    return row;
  }
  function issueInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a draft invoice.");
    const draft = invoice(ctx, input.id);
    if (draft.status !== "draft") ctx.refuse("invoice_issued", `Invoice ${draft.number} is already ${draft.status}.`);
    if (input.expectedVersion !== draft.version) ctx.refuse("conflict", "This invoice changed. Reload it before issuing.");
    if (draft.totalCents <= 0) ctx.refuse("invalid_input", "An invoice needs a total above zero.");
    const accounts = accountsById(ctx);
    const receivable = roleAccount(ctx, accounts, "receivable");
    const revenue = new Map();
    for (const line of draft.lines) revenue.set(line.revenueAccountId, (revenue.get(line.revenueAccountId) || 0) + line.amountCents);
    const lines = [{ accountId: receivable.id, debitCents: draft.totalCents }];
    for (const [accountId, amount] of revenue) if (amount > 0) lines.push({ accountId, creditCents: amount });
    if (draft.taxCents > 0) lines.push({ accountId: roleAccount(ctx, accounts, "sales_tax").id, creditCents: draft.taxCents });
    const number = `INV-${String(ctx.db.query("SELECT count(*) AS n FROM invoices WHERE number IS NOT NULL")[0].n + 1).padStart(4, "0")}`;
    const entry = { ...normalizeEntry(ctx, { date: draft.issueDate, currency: draft.currency, memo: `Invoice ${number} to ${draft.clientName}`.slice(0, 500), lines }, accounts, periods(ctx)),
      source: "invoice", sourceId: draft.id };
    const [created] = insertEntries(ctx, [entry]);
    execute(ctx, "UPDATE invoices SET status='issued',number=?,journal_entry_id=?,version=version+1 WHERE id=? AND version=?", [number, created.id, draft.id, draft.version]);
    return { id: draft.id, number, status: "issued", version: draft.version + 1, journalEntryId: created.id, journalNumber: created.number };
  }
  function recordPayment(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an invoice and payment details.");
    const issued = invoice(ctx, input.id);
    if (issued.status !== "issued") ctx.refuse("conflict", `Invoice ${issued.number || "draft"} is ${issued.status}, so it cannot take a payment.`);
    if (input.expectedVersion !== issued.version) ctx.refuse("conflict", "This invoice changed. Reload it before recording a payment.");
    const accounts = accountsById(ctx);
    let paidOn = input.date, bankAccountId = input.bankAccountId, bankRow = null;
    if (input.bankRowId !== undefined) {
      bankRow = ctx.db.query("SELECT id,bank_account_id AS bankAccountId,posted_on AS date,amount_cents AS amountCents,currency,status FROM bank_imports WHERE id=?", [input.bankRowId])[0];
      if (!bankRow || bankRow.status !== "new") ctx.refuse("conflict", "Choose a new bank row.");
      if (bankRow.amountCents !== issued.totalCents || bankRow.currency !== issued.currency)
        ctx.refuse("amount_mismatch", "The bank row must match the invoice total and currency.");
      paidOn = bankRow.date;
      bankAccountId = bankRow.bankAccountId;
    }
    date(ctx, paidOn, "Enter the payment date as YYYY-MM-DD.");
    const bank = accounts.get(bankAccountId);
    if (!bank || !bank.isBank) invalid(ctx, "Choose the bank account that received the payment.");
    const receivable = roleAccount(ctx, accounts, "receivable");
    const entry = { ...normalizeEntry(ctx, { date: paidOn, currency: issued.currency, memo: `Payment for invoice ${issued.number}`,
      lines: [{ accountId: bank.id, debitCents: issued.totalCents }, { accountId: receivable.id, creditCents: issued.totalCents }] }, accounts, periods(ctx)),
      source: "payment", sourceId: issued.id };
    const [created] = insertEntries(ctx, [entry]);
    execute(ctx, "UPDATE invoices SET status='paid',payment_entry_id=?,paid_on=?,version=version+1 WHERE id=? AND version=?", [created.id, paidOn, issued.id, issued.version]);
    if (bankRow) execute(ctx, "UPDATE bank_imports SET status='posted',journal_entry_id=? WHERE id=? AND status='new'", [created.id, bankRow.id]);
    return { id: issued.id, status: "paid", version: issued.version + 1, paymentEntryId: created.id };
  }
  function voidInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an invoice to void.");
    const issued = invoice(ctx, input.id);
    if (issued.status === "paid") ctx.refuse("conflict", "Reverse the payment before voiding this invoice.");
    if (issued.status !== "issued") ctx.refuse("conflict", `Invoice ${issued.number || "draft"} is ${issued.status}.`);
    if (input.expectedVersion !== issued.version) ctx.refuse("conflict", "This invoice changed. Reload it before voiding.");
    const voidDate = input.date === undefined ? issued.issueDate : date(ctx, input.date, "Enter the void date as YYYY-MM-DD.");
    if (voidDate < issued.issueDate) invalid(ctx, `The void date cannot be before the issue date (${issued.issueDate}).`);
    const created = reversal(ctx, entryWithLines(ctx, issued.journalEntryId), voidDate, `Void invoice ${issued.number}`);
    execute(ctx, "UPDATE invoices SET status='void',void_entry_id=?,version=version+1 WHERE id=? AND version=?", [created.id, issued.id, issued.version]);
    return { id: issued.id, status: "void", version: issued.version + 1, voidEntryId: created.id };
  }
  function listInvoices(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose invoices.");
    const size = limit(ctx, input.limit, 100, 500);
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    const rows = ctx.db.query(`SELECT i.id,i.number,c.name AS clientName,i.issue_date AS issueDate,i.due_date AS dueDate,i.currency,
      i.total_cents AS totalCents,i.status,i.version FROM invoices i JOIN clients c ON c.id=i.client_id
      ORDER BY i.status='draft' DESC,i.issue_date DESC,i.created_at_ms DESC LIMIT ? OFFSET ?`, [size + 1, offset]);
    const more = rows.length > size;
    if (more) rows.pop();
    return { invoices: rows, nextOffset: more ? offset + size : null };
  }
  function getInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an invoice.");
    return invoice(ctx, input.id);
  }

  function reportCurrency(ctx, input) {
    if (input.currency !== undefined) return currency(ctx, input.currency);
    const first = ctx.db.query("SELECT currency FROM journal_entries GROUP BY currency ORDER BY count(*) DESC, currency LIMIT 1")[0];
    return first ? first.currency : "USD";
  }
  function accountTotals(ctx, reportCurrency, from, to, types) {
    return ctx.db.query(`SELECT a.id,a.name,a.type,coalesce(sum(l.debit_cents),0) AS debitCents,coalesce(sum(l.credit_cents),0) AS creditCents
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
      WHERE e.currency=? AND e.entry_date>=? AND e.entry_date<=? AND a.type IN (${types.map(() => "?").join(",")})
      GROUP BY a.id ORDER BY a.id`, [reportCurrency, from, to, ...types])
      .map((row) => ({ ...row, balanceCents: signedBalance(row.type, row.debitCents, row.creditCents) }));
  }
  function booksInfo(ctx) {
    const currencies = ctx.db.query("SELECT currency,count(*) AS entries,min(entry_date) AS firstDate,max(entry_date) AS lastDate FROM journal_entries GROUP BY currency ORDER BY count(*) DESC, currency");
    return {
      currencies,
      accounts: ctx.db.query("SELECT id,name,type FROM accounts ORDER BY id"),
      periods: ctx.db.query("SELECT id,start_date AS startDate,end_date AS endDate,status FROM fiscal_periods ORDER BY start_date"),
    };
  }
  function trialBalance(ctx, input) {
    object(ctx, input, "Choose the report date.");
    const asOf = date(ctx, input.asOf, "Enter the report date as YYYY-MM-DD.");
    const reportCode = reportCurrency(ctx, input);
    const rows = accountTotals(ctx, reportCode, "0000-01-01", asOf, ACCOUNT_TYPES).map((row) => {
      const net = row.debitCents - row.creditCents;
      return { ...row, debitBalanceCents: net > 0 ? net : 0, creditBalanceCents: net < 0 ? -net : 0 };
    });
    const totalDebitCents = rows.reduce((sum, row) => sum + row.debitBalanceCents, 0);
    const totalCreditCents = rows.reduce((sum, row) => sum + row.creditBalanceCents, 0);
    return { asOf, currency: reportCode, rows, totalDebitCents, totalCreditCents, balanced: totalDebitCents === totalCreditCents };
  }
  function incomeStatement(ctx, input) {
    object(ctx, input, "Choose the report dates.");
    const from = date(ctx, input.from, "Enter the start date as YYYY-MM-DD.");
    const to = date(ctx, input.to, "Enter the end date as YYYY-MM-DD.");
    if (to < from) invalid(ctx, "The end date cannot be before the start date.");
    const reportCode = reportCurrency(ctx, input);
    const rows = accountTotals(ctx, reportCode, from, to, ["income", "expense"]);
    const income = rows.filter((row) => row.type === "income"), expenses = rows.filter((row) => row.type === "expense");
    const totalIncomeCents = income.reduce((sum, row) => sum + row.balanceCents, 0);
    const totalExpenseCents = expenses.reduce((sum, row) => sum + row.balanceCents, 0);
    const months = ctx.db.query(`SELECT substr(e.entry_date,1,7) AS month,
      coalesce(sum(CASE WHEN a.type='income' THEN l.credit_cents-l.debit_cents END),0) AS incomeCents,
      coalesce(sum(CASE WHEN a.type='expense' THEN l.debit_cents-l.credit_cents END),0) AS expenseCents
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id
      WHERE e.currency=? AND e.entry_date>=? AND e.entry_date<=? AND a.type IN ('income','expense')
      GROUP BY month ORDER BY month LIMIT 240`, [reportCode, from, to]);
    return { from, to, currency: reportCode, income, expenses, totalIncomeCents, totalExpenseCents,
      netIncomeCents: totalIncomeCents - totalExpenseCents, months };
  }
  function balanceSheet(ctx, input) {
    object(ctx, input, "Choose the report date.");
    const asOf = date(ctx, input.asOf, "Enter the report date as YYYY-MM-DD.");
    const reportCode = reportCurrency(ctx, input);
    const rows = accountTotals(ctx, reportCode, "0000-01-01", asOf, ACCOUNT_TYPES);
    const sum = (type) => rows.filter((row) => row.type === type).reduce((total, row) => total + row.balanceCents, 0);
    const earningsCents = sum("income") - sum("expense");
    const assets = rows.filter((row) => row.type === "asset"), liabilities = rows.filter((row) => row.type === "liability");
    const equity = rows.filter((row) => row.type === "equity");
    const totalAssetsCents = sum("asset"), totalLiabilitiesCents = sum("liability"), totalEquityCents = sum("equity") + earningsCents;
    return { asOf, currency: reportCode, assets, liabilities, equity, earningsCents, totalAssetsCents, totalLiabilitiesCents,
      totalEquityCents, balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents };
  }
  function accountLedger(ctx, input) {
    object(ctx, input, "Choose an account.");
    const account = ctx.db.query("SELECT id,name,type FROM accounts WHERE id=?", [input.accountId])[0];
    if (!account) ctx.refuse("not_found", "That account does not exist.");
    const reportCode = reportCurrency(ctx, input);
    const from = date(ctx, input.from, "Enter the start date as YYYY-MM-DD.");
    const to = date(ctx, input.to, "Enter the end date as YYYY-MM-DD.");
    if (to < from) invalid(ctx, "The end date cannot be before the start date.");
    const size = limit(ctx, input.limit, 100, 500);
    let after = null;
    if (input.after !== undefined && input.after !== null) {
      after = object(ctx, input.after, "The page is invalid.");
      if (!isoDate(after.date) || !Number.isSafeInteger(after.number) || !Number.isSafeInteger(after.lineNo)) invalid(ctx, "The page is invalid.");
    }
    const position = after ? "(e.entry_date>? OR (e.entry_date=? AND (e.number>? OR (e.number=? AND l.line_no>?))))" : "e.entry_date>=?";
    const positionParams = after ? [after.date, after.date, after.number, after.number, after.lineNo] : [from];
    const opening = ctx.db.query(`SELECT coalesce(sum(l.debit_cents),0) AS d,coalesce(sum(l.credit_cents),0) AS c
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.currency=? AND NOT ${position}`,
      [account.id, reportCode, ...positionParams])[0];
    let balance = signedBalance(account.type, opening.d, opening.c);
    const openingBalanceCents = balance;
    const rows = ctx.db.query(`SELECT e.id AS entryId,e.number,e.entry_date AS date,e.memo,l.line_no AS lineNo,l.memo AS lineMemo,
      l.debit_cents AS debitCents,l.credit_cents AS creditCents FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=? AND e.currency=? AND ${position} AND e.entry_date<=? ORDER BY e.entry_date,e.number,l.line_no LIMIT ?`,
      [account.id, reportCode, ...positionParams, to, size + 1]);
    const more = rows.length > size;
    if (more) rows.pop();
    for (const row of rows) {
      balance += signedBalance(account.type, row.debitCents, row.creditCents);
      row.balanceCents = balance;
    }
    const last = rows[rows.length - 1];
    return { account, currency: reportCode, from, to, openingBalanceCents, closingBalanceCents: balance, rows,
      nextAfter: more ? { date: last.date, number: last.number, lineNo: last.lineNo } : null };
  }
  function overview(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose the overview date.");
    const today = date(ctx, input.today, "Enter today's date as YYYY-MM-DD.");
    const reportCode = reportCurrency(ctx, input);
    const year = today.slice(0, 4);
    const statement = incomeStatement(ctx, { from: `${year}-01-01`, to: today, currency: reportCode });
    const accounts = accountsById(ctx);
    const cash = accountTotals(ctx, reportCode, "0000-01-01", today, ["asset"]).filter((row) => accounts.get(row.id).isBank === 1);
    const receivables = ctx.db.query(`SELECT count(*) AS open,coalesce(sum(total_cents),0) AS openCents,
      coalesce(sum(CASE WHEN due_date<? THEN 1 END),0) AS overdue,coalesce(sum(CASE WHEN due_date<? THEN total_cents END),0) AS overdueCents
      FROM invoices WHERE status='issued' AND currency=?`, [today, today, reportCode])[0];
    const bankRows = ctx.db.query("SELECT count(*) AS n FROM bank_imports WHERE status='new'")[0].n;
    return { today, currency: reportCode, currencies: booksInfo(ctx).currencies.map((row) => row.currency), cash,
      cashCents: cash.reduce((sum, row) => sum + row.balanceCents, 0), receivables, newBankRows: bankRows,
      yearToDate: { incomeCents: statement.totalIncomeCents, expenseCents: statement.totalExpenseCents, netIncomeCents: statement.netIncomeCents, months: statement.months },
      hasPeriods: ctx.db.query("SELECT count(*) AS n FROM fiscal_periods")[0].n > 0 };
  }

  globalThis.operations = {
    overview, booksInfo, trialBalance, incomeStatement, balanceSheet, accountLedger,
    listAccounts, addAccount, updateAccount, listPeriods, addFiscalYear, lockPeriod,
    listEntries, getEntry, postJournalEntry, postJournalEntries, reverseJournalEntry, attachReceipt, receiptAccess,
    stageBankRows, listBankRows, postBankRows, setBankRowsIgnored, keepDuplicateBankRow,
    listClients, saveClient, listInvoices, getInvoice, saveDraftInvoice, deleteDraftInvoice, issueInvoice, recordPayment, voidInvoice,
  };
}());
