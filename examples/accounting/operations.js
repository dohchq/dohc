(function () {
  const MAX_CENTS = 1000000000000;
  const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"];
  const DEBIT_NORMAL = new Set(["asset", "expense"]);
  const MAX_ACCOUNTS = 500;
  const MAX_PERIODS = 600;
  const MAX_LINES = 500;
  const MAX_BANK_BATCH = 5000;
  const MAX_POST_BATCH = 5000;
  const MAX_BANK_POSTS = 500;
  const MAX_REVERSALS = 100;
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

  const MINOR_DIGITS = new Map([
    ..."ADP AFN ALL BIF BYR CLP COP DJF ESP GNF HUF IDR IQD IRR ISK ITL JPY KMF KPW KRW LAK LBP LUF MGA MGF MMK MRO PKR PYG RWF SLL SOS STD SYP TMM TRL UGX UYI VND VUV XAF XOF XPF YER ZMK ZWD"
      .split(" ").map((code) => [code, 0]),
    ..."BHD JOD KWD LYD OMR TND".split(" ").map((code) => [code, 3]),
    ["CLF", 4], ["UYW", 4],
  ]);
  function minorDigits(code) {
    return MINOR_DIGITS.has(code) ? MINOR_DIGITS.get(code) : 2;
  }
  function parseAmount(value, digits) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const raw = String(value).trim();
    const paren = /^\(\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*\)$/.exec(raw);
    const signed = paren ? null : /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(raw);
    if (!paren && !signed) return null;
    const negative = Boolean(paren) || signed[1] === "-";
    const whole = (paren ? paren[1] : signed[2]).replace(/,/g, "");
    const frac = (paren ? paren[2] : signed[3]) || "";
    if (whole.length > 13 || frac.length > digits) return null;
    const amount = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
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
  function closedThrough(ctx) {
    return ctx.db.query("SELECT max(end_date) AS day FROM fiscal_periods WHERE status<>'open'")[0].day;
  }
  function rowsOpenCheck(ctx, ids) {
    const through = closedThrough(ctx);
    if (!through) return;
    const closed = ctx.db.query(`SELECT posted_on AS day,description FROM bank_imports WHERE posted_on<=?2 AND id IN (${jsonList()}) LIMIT 1`, [JSON.stringify(ids), through])[0];
    if (closed) ctx.refuse("period_closed", `${closed.description} is dated ${closed.day}, in a closed month. It stays as it is.`);
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
    notFuture(ctx, entryDate, `entry${where}`);
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

  function insertLinesThenEntries(ctx, entries) {
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

  function manualEntry(ctx, input, accounts, allPeriods, index) {
    const entry = normalizeEntry(ctx, input, accounts, allPeriods, index);
    const control = entry.lines.map((line) => accounts.get(line.accountId)).find((account) => account.role === "receivable");
    if (control)
      ctx.refuse("control_account", `${control.id} ${control.name} follows the invoices${index === undefined ? "" : ` (entry ${index + 1})`}. Issue an invoice or record a payment instead.`);
    return entry;
  }
  function postJournalEntry(ctx, input) {
    owner(ctx);
    const entry = manualEntry(ctx, input, accountsById(ctx), periods(ctx));
    entry.receiptFileId = receipt(ctx, input.receiptFileId);
    return insertLinesThenEntries(ctx, [entry])[0];
  }
  function postJournalEntries(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the journal entries.");
    const accounts = accountsById(ctx), allPeriods = periods(ctx);
    const entries = list(ctx, input.entries, 1, MAX_POST_BATCH, `Post 1 to ${MAX_POST_BATCH} entries at a time.`)
      .map((entry, index) => manualEntry(ctx, entry, accounts, allPeriods, index));
    const created = insertLinesThenEntries(ctx, entries);
    return { posted: created.length, firstNumber: created[0].number, lastNumber: created[created.length - 1].number,
      lines: entries.reduce((sum, entry) => sum + entry.lines.length, 0) };
  }
  function entryWithLines(ctx, id) {
    const entry = ctx.db.query(`SELECT e.id,e.number,e.entry_date AS date,e.currency,e.memo,e.source,e.source_id AS sourceId,
      e.reverses_entry_id AS reversesEntryId,e.total_cents AS totalCents,e.receipt_file_id AS receiptFileId,e.created_at_ms AS createdAtMs,
      (SELECT r.id FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversedByEntryId,
      (SELECT r.number FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversedByNumber,
      (SELECT r.created_at_ms FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversedAtMs,
      (SELECT o.number FROM journal_entries o WHERE o.id=e.reverses_entry_id) AS reversesNumber
      FROM journal_entries e WHERE e.id=?`, [id])[0];
    if (!entry) ctx.refuse("not_found", "That journal entry does not exist.");
    entry.lines = ctx.db.query(`SELECT l.line_no AS lineNo,l.account_id AS accountId,a.name AS accountName,
      l.debit_cents AS debitCents,l.credit_cents AS creditCents,l.memo FROM journal_lines l JOIN accounts a ON a.id=l.account_id
      WHERE l.entry_id=? ORDER BY l.line_no`, [id]);
    return entry;
  }
  function reversal(ctx, entry, reversalDate, memo, suffix = "reversal") {
    if (reversalDate < entry.date) invalid(ctx, `Date the reversal on or after ${entry.date}, the date of entry ${entry.number}.`);
    openPeriodCheck(ctx, periods(ctx), reversalDate);
    if (entry.reversedByEntryId) ctx.refuse("already_reversed", `Entry ${entry.number} is already reversed.`);
    if (entry.reversesEntryId) ctx.refuse("is_reversal", `Entry ${entry.number} is a reversal. Post a new entry instead.`);
    return insertLinesThenEntries(ctx, [{
      date: reversalDate, currency: entry.currency, memo, source: "reversal", sourceId: entry.sourceId,
      reversesEntryId: entry.id, totalCents: entry.totalCents, idSuffix: suffix,
      lines: entry.lines.map((line) => ({ accountId: line.accountId, debitCents: line.creditCents, creditCents: line.debitCents, memo: line.memo })),
    }])[0];
  }
  function reverseOne(ctx, entryId, inputDate, suffix) {
    const entry = entryWithLines(ctx, text(ctx, entryId, 200, "Choose an entry to reverse."));
    if (entry.source === "invoice") ctx.refuse("use_invoice", "Void the invoice to reverse its entry.");
    const reversalDate = inputDate === undefined ? entry.date : date(ctx, inputDate, "Enter the reversal date as YYYY-MM-DD.");
    const memo = `Reversal of entry ${entry.number}${entry.memo ? `: ${entry.memo}` : ""}`.slice(0, 500);
    notFuture(ctx, reversalDate, "reversal");
    const created = reversal(ctx, entry, reversalDate, memo, suffix);
    if (entry.source === "payment") execute(ctx, "DELETE FROM invoice_payments WHERE entry_id=?", [entry.id]);
    const reopened = ctx.db.query(`SELECT id FROM bank_imports WHERE journal_entry_id=?1 AND (?2<=posted_on OR ?2=?3) AND (?4 IS NULL OR posted_on>?4)`,
      [entry.id, reversalDate, entry.date, closedThrough(ctx)]).map((row) => row.id);
    for (const rowId of reopened) clearingLockCheck(ctx, rowId, entry.id, (posted) => `Date the reversal after ${posted}, when its bank row cleared.`);
    if (reopened.length)
      execute(ctx, `UPDATE bank_imports SET status='new',journal_entry_id=NULL,linked=0 WHERE id IN (${jsonList()})`, [JSON.stringify(reopened)]);
    return created;
  }
  function reverseJournalEntry(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry to reverse.");
    if (input.entryIds === undefined) return reverseOne(ctx, input.entryId, input.date, "reversal");
    const ids = list(ctx, input.entryIds, 1, MAX_REVERSALS, `Reverse 1 to ${MAX_REVERSALS} entries at a time.`);
    if (new Set(ids).size !== ids.length) invalid(ctx, "Choose each entry once.");
    const created = ids.map((id, index) => reverseOne(ctx, id, input.date, `reversal-${index + 1}`));
    return { reversed: created.length, entries: created };
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
  function removeReceipt(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry and its receipt.");
    const entryId = text(ctx, input.entryId, 200, "Choose an entry.");
    const fileId = text(ctx, input.fileId, 200, "Choose the receipt to remove.");
    if (execute(ctx, "UPDATE journal_entries SET receipt_file_id=NULL WHERE id=? AND receipt_file_id=?", [entryId, fileId]).changes !== 1)
      ctx.refuse("conflict", "That receipt is no longer on this entry.");
    return { entryId, fileId };
  }
  function receiptAccess(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry.");
    const row = ctx.db.query("SELECT receipt_file_id AS fileId FROM journal_entries WHERE id=?", [text(ctx, input.entryId, 200, "Choose an entry.")])[0];
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
    if (archived && !account.archived) {
      const held = ctx.db.query(`SELECT e.currency,sum(l.debit_cents-l.credit_cents) AS net FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
        WHERE l.account_id=? GROUP BY e.currency HAVING net<>0 LIMIT 1`, [account.id])[0];
      if (held) ctx.refuse("account_in_use", `${account.name} holds ${amountText(held.net, held.currency)}. Move the balance to another account before archiving it.`);
      const waiting = ctx.db.query(`SELECT count(*) AS n FROM bank_imports b WHERE b.bank_account_id=? AND ${UNDECIDED}`, [account.id])[0].n;
      if (waiting) ctx.refuse("account_in_use", `${account.name} has ${waiting} bank ${waiting === 1 ? "row" : "rows"} to review. Post or skip them before archiving it.`);
    }
    execute(ctx, "UPDATE accounts SET name=?,archived=? WHERE id=?", [name, archived, account.id]);
    return { id: account.id, name, archived: archived === 1 };
  }
  function listAccounts(ctx) {
    owner(ctx);
    return ctx.db.query(`SELECT a.id,a.name,a.type,a.role,a.is_bank AS isBank,a.archived,
      EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id=a.id) AS used FROM accounts a ORDER BY a.id`)
      .map((row) => ({ ...row, isBank: row.isBank === 1, archived: row.archived === 1, used: row.used === 1 }));
  }

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function shiftDay(day, days) {
    return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  }
  function fiscalStartMonth(ctx) {
    const first = ctx.db.query("SELECT min(start_date) AS d FROM fiscal_periods")[0].d;
    return first ? Number(first.slice(5, 7)) : 1;
  }
  function fiscalYearStart(ctx, day) {
    const month = fiscalStartMonth(ctx), year = Number(day.slice(0, 4));
    return `${String(Number(day.slice(5, 7)) >= month ? year : year - 1).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  }
  function latestToday(ctx) {
    return new Date(ctx.nowMs + 14 * 3600000).toISOString().slice(0, 10);
  }
  function notFuture(ctx, day, what) {
    if (day > latestToday(ctx)) invalid(ctx, `Date the ${what} today or earlier. The books record what has already happened.`);
  }
  function amountText(value, code) {
    const digits = minorDigits(code), unit = 10 ** digits, abs = Math.abs(value);
    const whole = String(Math.floor(abs / unit)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${value < 0 ? "-" : ""}${whole}${digits ? `.${String(abs % unit).padStart(digits, "0")}` : ""} ${code}`;
  }

  function addFiscalYear(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a fiscal year.");
    const bounds = ctx.db.query("SELECT min(start_date) AS first,max(end_date) AS last FROM fiscal_periods")[0];
    const year = input.year, startMonth = input.startMonth === undefined ? fiscalStartMonth(ctx) : input.startMonth;
    if (!Number.isSafeInteger(year) || year < 1900 || year > 2998) invalid(ctx, "Choose a year from 1900 to 2998.");
    if (!Number.isSafeInteger(startMonth) || startMonth < 1 || startMonth > 12) invalid(ctx, "Choose a starting month from 1 to 12.");
    if (bounds.first && startMonth !== fiscalStartMonth(ctx)) invalid(ctx, `Fiscal years in these books start in ${MONTH_NAMES[fiscalStartMonth(ctx) - 1]}.`);
    if (bounds.first && closedThrough(ctx) && `${startMonth === 1 ? year : year - 1}-${String(startMonth).padStart(2, "0")}-01` < bounds.first)
      ctx.refuse("period_closed", "Months in these books are already closed, so an earlier fiscal year can't be added.");
    if (ctx.db.query("SELECT count(*) AS n FROM fiscal_periods")[0].n + 12 > MAX_PERIODS)
      ctx.refuse("limit", `These books hold at most ${MAX_PERIODS} fiscal periods.`);
    const startYear = startMonth === 1 ? year : year - 1;
    const rows = [];
    for (let index = 0; index < 12; index++) {
      const month = (startMonth - 1 + index) % 12, periodYear = startYear + Math.floor((startMonth - 1 + index) / 12);
      const start = new Date(Date.UTC(periodYear, month, 1)), end = new Date(Date.UTC(periodYear, month + 1, 0));
      const startDate = start.toISOString().slice(0, 10), endDate = end.toISOString().slice(0, 10);
      rows.push([startDate.slice(0, 7), startDate, endDate]);
    }
    if (bounds.first && rows[0][1] !== shiftDay(bounds.last, 1) && rows[11][2] !== shiftDay(bounds.first, -1))
      invalid(ctx, `Fiscal years follow one another. Open fiscal year ${Number(bounds.last.slice(0, 4)) + 1} next.`);
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
    const earliestToday = new Date(ctx.nowMs - 12 * 3600000).toISOString().slice(0, 10);
    if (all[index].endDate >= earliestToday) ctx.refuse("period_in_progress", `${all[index].id} runs through ${all[index].endDate}. Close it after the month ends.`);
    const left = ctx.db.query(`SELECT coalesce(sum(status='new'),0) AS waiting,coalesce(sum(status='duplicate'),0) AS doubles FROM bank_imports
      WHERE status IN ('new','duplicate') AND confirmed=0 AND posted_on<=?`, [all[index].endDate])[0];
    if (left.waiting) ctx.refuse("unreviewed", `Review or skip the ${left.waiting} bank ${left.waiting === 1 ? "row" : "rows"} dated on or before ${all[index].endDate} first.`);
    if (left.doubles)
      ctx.refuse("unreviewed", `Confirm or keep the ${left.doubles} possible ${left.doubles === 1 ? "duplicate" : "duplicates"} dated on or before ${all[index].endDate} first.`);
    const broken = reconciled(ctx).find((row) => !row.holds && row.date <= all[index].endDate);
    if (broken)
      ctx.refuse("reconciliation_broken", `The ${broken.date} reconciliation of ${broken.accountName} no longer matches the statement. Fix the matches or remove it first.`);
    execute(ctx, "UPDATE fiscal_periods SET status='locked',locked_at_ms=? WHERE id=?", [ctx.nowMs, all[index].id]);
    return { id: all[index].id, status: "locked" };
  }
  function listPeriods(ctx) {
    owner(ctx);
    return ctx.db.query(`SELECT p.id,p.start_date AS startDate,p.end_date AS endDate,p.status,
      (SELECT count(*) FROM journal_entries e WHERE e.entry_date BETWEEN p.start_date AND p.end_date) AS entries,
      (SELECT count(*) FROM bank_imports b WHERE b.status='new' AND b.posted_on<=p.end_date) AS waiting,
      (SELECT count(*) FROM bank_imports b WHERE b.status='duplicate' AND b.confirmed=0 AND b.posted_on<=p.end_date) AS duplicates
      FROM fiscal_periods p ORDER BY p.start_date`);
  }
  const ENTRY_VIEWS = ["all", "receipt", "missing", "reversed"];
  const CLIENT = "coalesce(i.buyer_name,c.name)";
  const nameKey = (name) => {
    const space = name.indexOf(" ");
    return (space >= 4 ? name.slice(0, space) : name).toLowerCase();
  };
  const NAMED = `instr(lower(b.description),lower(CASE WHEN instr(${CLIENT},' ')>4 THEN substr(${CLIENT},1,instr(${CLIENT},' ')-1) ELSE ${CLIENT} END))>0`;
  const OPEN_FOR = "i.status='issued' AND i.currency=b.currency AND i.issue_date<=b.posted_on AND b.amount_cents>0";
  const PAYABLE = `${OPEN_FOR} AND i.total_cents-i.paid_cents=b.amount_cents`;
  const PART_PAYABLE = `${OPEN_FOR} AND i.total_cents-i.paid_cents>b.amount_cents`;
  const MATCH = `(SELECT CASE WHEN count(*)=1 THEN max(i.id) WHEN count(*)=0 THEN
      (SELECT CASE WHEN count(*)=1 THEN max(i.id) END FROM invoices i JOIN clients c ON c.id=i.client_id WHERE ${PART_PAYABLE} AND ${NAMED}) END
    FROM invoices i JOIN clients c ON c.id=i.client_id WHERE ${PAYABLE} AND ${NAMED})`;
  const PAYABLES = `(SELECT json_group_array(id) FROM (SELECT i.id FROM invoices i JOIN clients c ON c.id=i.client_id
    WHERE ${OPEN_FOR} AND (i.total_cents-i.paid_cents>=b.amount_cents
      AND (i.total_cents-i.paid_cents=b.amount_cents OR ${NAMED} OR b.amount_cents*2>=i.total_cents-i.paid_cents)
      OR i.total_cents-i.paid_cents<b.amount_cents AND ${NAMED})
    ORDER BY i.total_cents-i.paid_cents=b.amount_cents DESC,${NAMED} DESC,i.due_date,i.number LIMIT 5))`;
  const MAX_CANDIDATES = 5;
  const PREVIEW = 120;
  const PAGE_BYTES = 240 * 1024;
  const DETAIL_GROUP = 100;
  const GENERIC = ["pos", "ach", "debit", "credit", "card", "checkcard", "purchase", "payment", "pmt", "transfer", "xfer", "deposit", "withdrawal",
    "check", "chk", "visa", "sq", "tst", "direct", "online", "recurring", "bill", "from", "for", "the", "and", "ref", "inc", "llc", "ltd",
    "invoice", "inv", "received", "paid"];
  const keyWord = (value) => {
    let words = `' '||replace(replace(lower(trim(${value})),'*',' '),' ','  ')||' '`;
    for (const word of GENERIC) words = `replace(${words},' ${word} ','')`;
    const first = `trim(${words})||' '`;
    return `trim(substr(${first},1,instr(${first},' ')-1),',.*:;#-')`;
  };
  const PAYEE = keyWord("b.description"), MEMO = keyWord("e.memo");
  const OTHER = "CASE WHEN instr(ta.name,' ')>0 THEN substr(ta.name,1,instr(ta.name,' ')-1) ELSE ta.name END";
  const SURE = `((length(${PAYEE})>=3 AND (instr(lower(e.memo),${PAYEE})>0
      OR EXISTS (SELECT 1 FROM journal_lines m WHERE m.entry_id=e.id AND instr(lower(coalesce(m.memo,'')),${PAYEE})>0)))
    OR (e.source IN ('manual','bank') AND length(${MEMO})>=3 AND instr(lower(b.description),${MEMO})>0)
    OR EXISTS (SELECT 1 FROM journal_lines t JOIN accounts ta ON ta.id=t.account_id WHERE t.entry_id=e.id AND ta.is_bank=1 AND t.account_id<>b.bank_account_id
      AND length(${OTHER})>=4 AND instr(lower(b.description),lower(${OTHER}))>0)
    OR (e.source='payment' AND EXISTS (SELECT 1 FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=e.source_id AND ${NAMED})))`;
  const NETS = `WITH nets AS MATERIALIZED (SELECT l.account_id AS account,CAST(sum(l.debit_cents-l.credit_cents) AS INTEGER) AS net,e.currency,
      e.entry_date AS day,e.id
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.is_bank=1 JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.reverses_entry_id IS NULL OR EXISTS (SELECT 1 FROM bank_imports o WHERE o.journal_entry_id=e.reverses_entry_id AND o.bank_account_id=l.account_id)
    GROUP BY l.entry_id,l.account_id)`;
  const MATCH_DAYS = 90;
  const firstRow = (account, code) => `coalesce((SELECT min(f.posted_on) FROM bank_imports f WHERE f.bank_account_id=${account} AND f.currency=${code}
    AND f.status NOT IN ('duplicate','ignored')),'9999-12-31')`;
  const NEAR = `(n.day BETWEEN date(b.posted_on,'-7 days') AND date(b.posted_on,'+7 days'))`;
  const SINCE_FIRST = `n.day>=${firstRow("b.bank_account_id", "b.currency")}`;
  const candidates = (columns, scope = "near") => `SELECT ${columns} FROM nets n JOIN journal_entries e ON e.id=n.id
    WHERE n.account=b.bank_account_id AND n.net=b.amount_cents AND n.currency=b.currency
    AND n.day BETWEEN date(b.posted_on,'-${MATCH_DAYS} days') AND date(b.posted_on,'+${MATCH_DAYS} days')
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id)
    AND NOT EXISTS (SELECT 1 FROM bank_imports x WHERE x.journal_entry_id=e.id AND x.bank_account_id=b.bank_account_id)
    ${scope === "any" ? "" : scope === "sure" ? `AND ${SURE} AND (${NEAR} OR ${SINCE_FIRST})` : `AND (${NEAR} OR (${SURE} AND ${SINCE_FIRST}))`}`;
  const LINKABLE = candidates("e.id", "any");
  const UNREVIEWED = `SELECT number FROM (${candidates("e.id,e.number")}
    ORDER BY ${SURE} DESC,abs(julianday(e.entry_date)-julianday(b.posted_on)),e.number LIMIT ${MAX_CANDIDATES})
    WHERE instr(p.seen,json_quote(id))=0 LIMIT 1`;
  const reviewedEntries = (ctx, value) => value === undefined ? []
    : Array.isArray(value) && value.length <= MAX_CANDIDATES && value.every((id) => typeof id === "string" && id.length <= 200) ? value
      : invalid(ctx, `List up to ${MAX_CANDIDATES} entry IDs in notMatched.`);
  const MATCHED = `(${MATCH} IS NOT NULL OR EXISTS (${candidates("e.id", "sure")}))`;
  const EXISTING = `(SELECT json_group_array(pick) FROM (${candidates(`CASE WHEN ${SURE} THEN '1' ELSE '0' END||e.id AS pick`)}
    ORDER BY substr(pick,1,1) DESC,abs(julianday(e.entry_date)-julianday(b.posted_on)),e.number LIMIT ${MAX_CANDIDATES}))`;
  const MISSING_RECEIPT = `e.receipt_file_id IS NULL AND e.source IN ('manual','bank') AND e.reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id)
    AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.type='expense')`;
  function listEntries(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a page of entries.");
    const size = limit(ctx, input.limit, 50, 200);
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    const show = input.show === undefined ? "all" : input.show;
    if (!ENTRY_VIEWS.includes(show)) invalid(ctx, "Show all entries, entries with receipts, entries missing receipts, or reversals.");
    const from = input.from === undefined ? "0000-01-01" : date(ctx, input.from, "Enter the start date as YYYY-MM-DD.");
    const to = input.to === undefined ? "9999-12-31" : date(ctx, input.to, "Enter the end date as YYYY-MM-DD.");
    const search = input.q === undefined ? "" : typeof input.q === "string" && input.q.length <= 200 ? input.q.trim() : invalid(ctx, "Search for up to 200 characters.");
    const account = input.accountId === undefined ? null
      : ctx.db.query("SELECT id,name,type FROM accounts WHERE id=?", [text(ctx, input.accountId, 200, "Choose an account.")])[0];
    if (input.accountId !== undefined && !account) ctx.refuse("not_found", "That account does not exist.");
    const currencies = account ? accountCurrencies(ctx, account.id) : [];
    const accountCurrency = !account ? null : input.currency !== undefined ? currency(ctx, input.currency) : currencies[0] || reportCurrency(ctx, {});
    const where = ["e.entry_date>=?", "e.entry_date<=?"], params = [from, to];
    if (show === "receipt") where.push("e.receipt_file_id IS NOT NULL");
    if (show === "missing") where.push(MISSING_RECEIPT);
    if (show === "reversed") where.push("(e.reverses_entry_id IS NOT NULL OR EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id))");
    if (search) {
      const like = `%${search.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      const amount = parseAmount(search.replace(/^\$/, ""), minorDigits(accountCurrency || reportCurrency(ctx, {})));
      where.push(`(lower(e.memo) LIKE ? ESCAPE '\\' OR CAST(e.number AS TEXT)=? OR e.total_cents=?
        OR EXISTS (SELECT 1 FROM journal_lines s JOIN accounts sa ON sa.id=s.account_id WHERE s.entry_id=e.id AND (lower(sa.name) LIKE ? ESCAPE '\\' OR s.account_id=? OR lower(coalesce(s.memo,'')) LIKE ? ESCAPE '\\')))`);
      params.push(like, search.replace(/^#/, ""), amount === null ? -1 : Math.abs(amount), like, search, like);
    }
    const base = `SELECT e.id,e.number,e.entry_date AS date,e.currency,e.memo,e.source,e.total_cents AS totalCents,
      e.receipt_file_id IS NOT NULL AS hasReceipt,e.reverses_entry_id AS reversesEntryId,
      EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed,
      (SELECT count(*) FROM journal_lines c WHERE c.entry_id=e.id) AS lineCount,
      (SELECT group_concat(a.name, ' · ') FROM (SELECT DISTINCT l.account_id FROM journal_lines l WHERE l.entry_id=e.id LIMIT 3) x
        JOIN accounts a ON a.id=x.account_id) AS accounts`;
    let rows, total;
    if (account) {
      const sign = DEBIT_NORMAL.has(account.type) ? 1 : -1;
      const ledger = `WITH own AS (SELECT l.entry_id AS id,sum(l.debit_cents) AS d,sum(l.credit_cents) AS c FROM journal_lines l
          JOIN journal_entries je ON je.id=l.entry_id WHERE l.account_id=? AND je.currency=? GROUP BY l.entry_id),
        run AS (SELECT own.id,own.d,own.c,sum(own.d-own.c) OVER (ORDER BY je.entry_date,je.number ROWS UNBOUNDED PRECEDING) AS net
          FROM own JOIN journal_entries je ON je.id=own.id)`;
      const scoped = [account.id, accountCurrency, ...params];
      rows = ctx.db.query(`${ledger} ${base},run.d AS debitCents,run.c AS creditCents,run.net*${sign} AS balanceCents
        FROM journal_entries e JOIN run ON run.id=e.id WHERE ${where.join(" AND ")}
        ORDER BY e.entry_date DESC,e.number DESC LIMIT ? OFFSET ?`, [...scoped, size + 1, offset]);
      total = ctx.db.query(`${ledger} SELECT count(*) AS n,coalesce(sum(run.d),0) AS d,coalesce(sum(run.c),0) AS c
        FROM journal_entries e JOIN run ON run.id=e.id WHERE ${where.join(" AND ")}`, scoped)[0];
    } else {
      rows = ctx.db.query(`${base} FROM journal_entries e WHERE ${where.join(" AND ")}
        ORDER BY e.entry_date DESC,e.number DESC LIMIT ? OFFSET ?`, [...params, size + 1, offset]);
      total = ctx.db.query(`SELECT count(*) AS n FROM journal_entries e WHERE ${where.join(" AND ")}`, params)[0];
    }
    const more = rows.length > size;
    if (more) rows.pop();
    const today = account ? ctx.db.query(`SELECT coalesce(sum(l.debit_cents),0) AS d,coalesce(sum(l.credit_cents),0) AS c FROM journal_lines l
      JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.currency=? AND e.entry_date<=?`, [account.id, accountCurrency, latestToday(ctx)])[0] : null;
    return {
      account: account ? { ...account, currency: accountCurrency, currencies: currencies.length ? currencies : [accountCurrency],
        balanceCents: signedBalance(account.type, today.d, today.c) } : null,
      entries: rows.map((row) => ({ ...row, hasReceipt: row.hasReceipt === 1, reversed: row.reversed === 1 })),
      total: total.n,
      ...(account ? { debitCents: total.d, creditCents: total.c } : {}),
      nextOffset: more ? offset + size : null,
    };
  }
  function getEntry(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an entry.");
    const entry = entryWithLines(ctx, text(ctx, input.id, 200, "Choose an entry."));
    entry.invoice = entry.sourceId && ["invoice", "payment", "reversal"].includes(entry.source)
      ? ctx.db.query("SELECT id,number,status,void_entry_id AS voidEntryId FROM invoices WHERE id=?", [entry.sourceId])[0] || null : null;
    entry.bankRow = ctx.db.query(`SELECT id,import_id AS importId,line_no AS lineNo,posted_on AS date,description,amount_cents AS amountCents,
      imported_at_ms AS importedAtMs,status,linked=1 AS linked FROM bank_imports WHERE journal_entry_id=?1 OR (?2 IS NOT NULL AND id=?2)
      ORDER BY journal_entry_id=?1 DESC LIMIT 1`, [entry.id, ["bank", "reversal"].includes(entry.source) ? entry.sourceId : null])
      .map((row) => ({ ...row, linked: row.linked === 1 }))[0] || null;
    return entry;
  }

  function stageBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter the bank statement rows.");
    if (typeof input.importId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.importId))
      invalid(ctx, "Use an import ID of 8 to 64 letters, digits, dashes, or underscores.");
    const bank = accountsById(ctx).get(input.bankAccountId);
    if (!bank || !bank.isBank) invalid(ctx, "Choose a bank account.");
    if (bank.archived) ctx.refuse("account_archived", `${bank.name} is archived. Restore it before importing its statement.`);
    const rowCurrency = currency(ctx, input.currency);
    if (!Number.isSafeInteger(input.firstLine) || input.firstLine < 1) invalid(ctx, "Enter the first line number of this batch.");
    const rows = list(ctx, input.rows, 1, MAX_BANK_BATCH, `Send 1 to ${MAX_BANK_BATCH} rows at a time.`);
    const digits = minorDigits(rowCurrency);
    const stored = ctx.db.query("SELECT count(*) AS n,min(bank_account_id) AS bank,min(currency) AS currency FROM bank_imports WHERE import_id=?", [input.importId])[0];
    if (stored.n && (stored.bank !== bank.id || stored.currency !== rowCurrency))
      ctx.refuse("conflict", "This import already belongs to another bank account or currency.");
    const lastLine = input.firstLine + rows.length - 1;
    if (stored.n >= lastLine)
      return { importId: input.importId, added: 0, duplicates: 0, closed: 0, alreadyStaged: rows.length, nextLine: stored.n + 1 };
    if (stored.n !== input.firstLine - 1)
      ctx.refuse("out_of_order", `Send line ${stored.n + 1} next. Batches of one import go in order.`);
    const parsed = rows.map((row, index) => {
      const where = `line ${input.firstLine + index}`;
      if (!Array.isArray(row) || row.length !== 3) invalid(ctx, `Send ${where} as [date, description, amount].`);
      if (!isoDate(row[0])) invalid(ctx, `The date on ${where} must be YYYY-MM-DD.`);
      if (row[0] > latestToday(ctx)) invalid(ctx, `The date on ${where} is ${row[0]}, after today. Check the date order of the file.`);
      if (typeof row[1] !== "string" || row[1].length > 300) invalid(ctx, `The description on ${where} must be text up to 300 characters.`);
      const amountCents = parseAmount(row[2], digits);
      if (amountCents === null || amountCents === 0)
        invalid(ctx, `The amount on ${where} must be a nonzero ${rowCurrency} amount with ${digits ? `at most ${digits} decimals` : "no decimals"}.`);
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
    const days = JSON.stringify([...new Set(parsed.map((row) => row.date))]);
    const earlier = new Map(ctx.db.query(`SELECT posted_on||' '||amount_cents AS key,count(*) AS n FROM bank_imports
      WHERE bank_account_id=?2 AND currency=?3 AND import_id<>?4 AND status<>'duplicate' AND posted_on IN (${jsonList()}) GROUP BY key`,
      [days, bank.id, rowCurrency, input.importId]).map((row) => [row.key, row.n]));
    const held = ctx.db.query(`SELECT b.id,b.posted_on AS date,b.posted_on||' '||b.amount_cents AS key,
      EXISTS (SELECT 1 FROM bank_imports o WHERE o.row_hash=b.row_hash AND o.status<>'duplicate') AS exact
      FROM bank_imports b WHERE b.import_id=?2 AND b.status='duplicate' AND b.posted_on IN (${jsonList()}) ORDER BY b.line_no DESC`,
      [days, input.importId]);
    const exact = new Map(), overlap = new Map();
    const tally = (counts, key, step = 1) => counts.set(key, (counts.get(key) || 0) + step);
    const room = (key) => (earlier.get(key) || 0) - (exact.get(key) || 0) - (overlap.get(key) || 0);
    for (const row of held) tally(row.exact ? exact : overlap, row.key);
    for (const row of parsed) {
      row.key = `${row.date} ${row.amountCents}`;
      row.exact = known.has(row.hash);
      if (row.exact) tally(exact, row.key);
    }
    for (const row of parsed) {
      row.overlap = !row.exact && room(row.key) > 0;
      if (row.overlap) tally(overlap, row.key);
    }
    const through = closedThrough(ctx);
    const late = (day) => Boolean(through) && day <= through;
    const freed = held.filter((row) => !row.exact && room(row.key) < 0 && tally(overlap, row.key, -1));
    for (const status of ["new", "ignored"]) {
      const ids = freed.filter((row) => late(row.date) === (status === "ignored")).map((row) => row.id);
      if (ids.length) execute(ctx, `UPDATE bank_imports SET status=?2,confirmed=0 WHERE status='duplicate' AND id IN (${jsonList()})`, [JSON.stringify(ids), status]);
    }
    let duplicates = -freed.length, closed = freed.filter((row) => late(row.date)).length;
    insertRows(ctx, "bank_imports", ["id", "import_id", "line_no", "bank_account_id", "posted_on", "description", "amount_cents",
      "currency", "base_hash", "row_hash", "status", "confirmed", "imported_at_ms"], parsed.map((row) => {
      const duplicate = row.exact || row.overlap;
      const old = !duplicate && late(row.date);
      if (duplicate) duplicates += 1;
      if (old) closed += 1;
      return [`${input.importId}-${row.lineNo}`, input.importId, row.lineNo, bank.id, row.date, row.description, row.amountCents,
        rowCurrency, row.base, row.hash, duplicate ? "duplicate" : old ? "ignored" : "new", duplicate && late(row.date) ? 1 : 0, ctx.nowMs];
    }));
    return { importId: input.importId, added: parsed.length - duplicates - closed, duplicates, closed, alreadyStaged: 0, nextLine: lastLine + 1 };
  }
  function listBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows.");
    const view = input.status === undefined ? "new" : input.status;
    if (!["new", "matched", "duplicate", "posted", "ignored"].includes(view)) invalid(ctx, "Choose new, matched, duplicate, posted, or ignored rows.");
    const size = limit(ctx, input.limit, 100, 100);
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid(ctx, "The page is invalid.");
    const rows = ctx.db.query(`${NETS} SELECT b.id,b.import_id AS importId,b.line_no AS lineNo,b.bank_account_id AS bankAccountId,
      b.posted_on AS date,b.description,b.amount_cents AS amountCents,b.currency,b.status,b.journal_entry_id AS journalEntryId,b.row_hash AS rowHash,
      CASE WHEN b.status='new' THEN (SELECT l.account_id FROM bank_imports p JOIN journal_lines l ON l.entry_id=p.journal_entry_id
        AND l.account_id<>p.bank_account_id JOIN accounts sa ON sa.id=l.account_id AND sa.archived=0 AND coalesce(sa.role,'')<>'receivable'
        WHERE p.status='posted' AND p.linked=0 AND p.bank_account_id=b.bank_account_id AND p.currency=b.currency
        AND length(trim(b.description))>=3 AND substr(lower(p.description),1,12)=substr(lower(b.description),1,12)
        AND (SELECT count(*) FROM journal_lines c WHERE c.entry_id=p.journal_entry_id)=2
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=p.journal_entry_id)
        ORDER BY lower(p.description)=lower(b.description) DESC,p.posted_on DESC LIMIT 1) END AS suggestedAccountId,
      CASE WHEN b.status='new' THEN ${MATCH} END AS matchInvoiceId,
      CASE WHEN b.status='new' AND b.amount_cents>0 THEN ${PAYABLES} END AS payableIds,
      CASE WHEN b.status='new' THEN ${EXISTING} END AS candidateIds,b.linked=1 AS linked,b.confirmed=1 AS confirmed,
      (SELECT e.number FROM journal_entries e WHERE e.id=b.journal_entry_id) AS journalNumber,
      (SELECT r.number FROM journal_entries r WHERE r.reverses_entry_id=b.journal_entry_id) AS reversedByNumber,
      CASE WHEN b.status='duplicate' THEN (SELECT json_object('description',o.description,'status',o.status,'importedAtMs',o.imported_at_ms,
        'journalNumber',(SELECT e.number FROM journal_entries e WHERE e.id=o.journal_entry_id)) FROM bank_imports o
        WHERE o.bank_account_id=b.bank_account_id AND o.currency=b.currency AND o.posted_on=b.posted_on AND o.amount_cents=b.amount_cents
          AND o.status<>'duplicate' AND o.id<>b.id ORDER BY o.row_hash=b.row_hash DESC,o.base_hash=b.base_hash DESC,o.imported_at_ms,o.id LIMIT 1) END AS original
      FROM bank_imports b WHERE b.status=? ${view === "matched" ? `AND ${MATCHED}` : view === "new" ? `AND NOT ${MATCHED}` : ""}
      ORDER BY b.posted_on DESC,b.id LIMIT ? OFFSET ?`, [view === "matched" ? "new" : view, size + 1, offset]);
    for (const row of rows) {
      row.payableIds = row.payableIds ? JSON.parse(row.payableIds) : [];
      row.original = row.original ? JSON.parse(row.original) : null;
    }
    const invoiceIds = [...new Set(rows.flatMap((row) => [row.matchInvoiceId, ...row.payableIds]).filter(Boolean))];
    const invoices = new Map(invoiceIds.length ? ctx.db.query(`SELECT i.id,i.number,i.version,i.due_date AS dueDate,${CLIENT} AS clientName,
      i.total_cents-i.paid_cents AS balanceCents FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id IN (${jsonList()})`,
      [JSON.stringify(invoiceIds)]).map((row) => [row.id, row]) : []);
    for (const row of rows) row.candidateIds = (row.candidateIds ? JSON.parse(row.candidateIds) : []).map((pick) => ({ id: pick.slice(1), sure: pick[0] === "1" }));
    const entryIds = [...new Set(rows.flatMap((row) => row.candidateIds.map((pick) => pick.id)))];
    const existing = new Map();
    for (let start = 0; start < entryIds.length; start += DETAIL_GROUP)
      for (const row of ctx.db.query(`SELECT e.id,e.number,e.entry_date AS date,substr(e.memo,1,${PREVIEW}) AS memo,e.source,
        substr((SELECT group_concat(a.name,', ') FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.is_bank=0),1,${PREVIEW}) AS accounts
        FROM journal_entries e WHERE e.id IN (${jsonList()})`, [JSON.stringify(entryIds.slice(start, start + DETAIL_GROUP))])) existing.set(row.id, row);
    const counts = Object.fromEntries(ctx.db.query("SELECT CASE WHEN confirmed=1 THEN 'confirmed' ELSE status END AS status,count(*) AS n FROM bank_imports GROUP BY 1")
      .map((row) => [row.status, row.n]));
    const through = closedThrough(ctx);
    const matched = ctx.db.query(`${NETS} SELECT count(*) AS n FROM bank_imports b WHERE b.status='new' AND ${MATCHED}`)[0].n;
    counts.review = (counts.new || 0) - matched;
    const shown = [];
    let bytes = 0;
    for (const { matchInvoiceId, candidateIds, payableIds, linked, confirmed, ...row } of rows.slice(0, size)) {
      const sure = candidateIds.some((pick) => pick.sure);
      const item = {
          ...row,
          linked: Boolean(linked),
          confirmed: Boolean(confirmed),
          closed: Boolean(through) && row.date <= through,
          candidates: candidateIds.filter((pick) => existing.has(pick.id)).map((pick) => ({ ...existing.get(pick.id), sure: pick.sure })),
          match: matchInvoiceId && !sure ? invoices.get(matchInvoiceId) || null : null,
          payables: payableIds.map((id) => invoices.get(id)).filter(Boolean)
            .map((item) => ({ ...item, named: row.description.toLowerCase().includes(nameKey(item.clientName)) })),
      };
      bytes += byteLength(JSON.stringify(item)) + 1;
      if (shown.length && bytes > PAGE_BYTES) break;
      shown.push(item);
    }
    const next = shown.length < rows.length ? offset + shown.length : null;
    return {
      rows: shown,
      status: view, offset, counts, matched, reconciled: reconciled(ctx), nextOffset: next,
    };
  }
  function bookBalance(ctx, bankAccountId, code, asOf) {
    return ctx.db.query(`SELECT coalesce(sum(l.debit_cents-l.credit_cents),0) AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=? AND e.currency=? AND e.entry_date<=?`, [bankAccountId, code, asOf])[0].n;
  }
  const UNDECIDED = "(b.status='new' OR (b.status='duplicate' AND b.confirmed=0))";
  const clearedBy = (asOf, first) => `CASE WHEN c.id IS NULL THEN e.entry_date<=${asOf} AND e.entry_date<${first} ELSE c.posted_on<=${asOf} END`;
  const CLEARED_LINES = `FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    LEFT JOIN bank_imports c ON c.journal_entry_id=e.id AND c.bank_account_id=l.account_id`;
  function reconciled(ctx) {
    return ctx.db.query(`WITH c AS (SELECT r.id,r.bank_account_id AS bankAccountId,a.name AS accountName,r.currency,
      r.statement_date AS date,r.balance_cents AS balanceCents,
      (SELECT count(*) FROM bank_imports b WHERE b.bank_account_id=r.bank_account_id AND b.currency=r.currency AND ${UNDECIDED}
        AND b.posted_on<=r.statement_date) AS waiting,
      (SELECT coalesce(sum(l.debit_cents-l.credit_cents),0) ${CLEARED_LINES} WHERE l.account_id=r.bank_account_id AND e.currency=r.currency
        AND ${clearedBy("r.statement_date", firstRow("r.bank_account_id", "r.currency"))}) AS clearedCents
      FROM reconciliations r JOIN accounts a ON a.id=r.bank_account_id),
    k AS (SELECT *,waiting=0 AND clearedCents=balanceCents AS holds FROM c),
    f AS (SELECT *,row_number() OVER (PARTITION BY bankAccountId,currency ORDER BY holds,CASE WHEN holds THEN NULL ELSE date END,date DESC) AS n FROM k)
    SELECT id,bankAccountId,accountName,currency,date,balanceCents,waiting,holds FROM f WHERE n=1 ORDER BY bankAccountId,currency`)
      .map((row) => ({ ...row, holds: row.holds === 1 }));
  }
  const MAX_OUTSTANDING = 200;
  function clearing(ctx, bankAccountId, code, asOf) {
    const first = ctx.db.query(`SELECT ${firstRow("?1", "?2")} AS day`, [bankAccountId, code])[0].day;
    const clearedCents = ctx.db.query(`SELECT coalesce(sum(l.debit_cents-l.credit_cents),0) AS n ${CLEARED_LINES}
      WHERE l.account_id=?1 AND e.currency=?2 AND ${clearedBy("?3", "?4")}`, [bankAccountId, code, asOf, first])[0].n;
    const rows = ctx.db.query(`WITH o AS (SELECT e.id,e.number,e.entry_date AS date,e.memo,e.reverses_entry_id AS rev,
        sum(l.debit_cents-l.credit_cents) AS amountCents,c.posted_on AS clearedOn ${CLEARED_LINES}
        WHERE l.account_id=?1 AND e.currency=?2 AND (e.entry_date<=?3)<>(${clearedBy("?3", "?4")}) GROUP BY e.id HAVING amountCents<>0)
      SELECT x.id,x.number,x.date,x.memo,x.amountCents,x.clearedOn,count(*) OVER () AS total FROM o x
      WHERE NOT EXISTS (SELECT 1 FROM o p WHERE p.rev=x.id OR p.id=x.rev) ORDER BY x.date,x.number LIMIT ${MAX_OUTSTANDING}`,
    [bankAccountId, code, asOf, first]);
    const firstWaiting = ctx.db.query(`SELECT min(b.posted_on) AS day FROM bank_imports b WHERE b.bank_account_id=? AND b.currency=? AND ${UNDECIDED}`,
      [bankAccountId, code])[0].day;
    return { clearedCents, outstanding: rows.map(({ total, ...row }) => row), outstandingCount: rows.length ? rows[0].total : 0, firstWaiting };
  }
  function waitingRows(ctx, bankAccountId, code, asOf) {
    return ctx.db.query(`SELECT count(*) AS n FROM bank_imports b WHERE b.bank_account_id=? AND b.currency=? AND ${UNDECIDED} AND b.posted_on<=?`,
      [bankAccountId, code, asOf])[0].n;
  }
  function accountCurrencies(ctx, accountId) {
    return ctx.db.query(`SELECT currency FROM (SELECT e.currency,count(*) AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE l.account_id=?1 GROUP BY e.currency UNION ALL SELECT currency,count(*) FROM bank_imports WHERE bank_account_id=?1 GROUP BY currency)
      GROUP BY currency ORDER BY sum(n) DESC,currency`, [accountId]).map((row) => row.currency);
  }
  function statementCheck(ctx, input) {
    const bank = accountsById(ctx).get(input.bankAccountId);
    if (!bank || !bank.isBank) invalid(ctx, "Choose a bank account.");
    const statementDate = date(ctx, input.date, "Enter the statement date as YYYY-MM-DD.");
    notFuture(ctx, statementDate, "statement");
    const currencies = accountCurrencies(ctx, bank.id);
    const code = input.currency === undefined ? currencies[0] || reportCurrency(ctx, {}) : currency(ctx, input.currency);
    if (currencies.length && !currencies.includes(code)) invalid(ctx, `${bank.name} holds ${currencies.join(", ")}. Reconcile one of those.`);
    const waiting = waitingRows(ctx, bank.id, code, statementDate);
    const queues = waiting ? ctx.db.query(`${NETS} SELECT coalesce(sum(s='new' AND NOT m),0) AS review,coalesce(sum(m),0) AS matched
      FROM (SELECT b.status AS s,b.status='new' AND ${MATCHED} AS m FROM bank_imports b
        WHERE b.bank_account_id=? AND b.currency=? AND ${UNDECIDED} AND b.posted_on<=?)`, [bank.id, code, statementDate])[0] : null;
    const reviewQueue = !queues ? null : queues.review ? "new" : queues.matched ? "matched" : "duplicate";
    const existing = ctx.db.query("SELECT id,balance_cents AS balanceCents FROM reconciliations WHERE bank_account_id=? AND currency=? AND statement_date=?",
      [bank.id, code, statementDate])[0] || null;
    return { bank, statementDate, code, currencies, waiting, reviewQueue, existing, booksCents: bookBalance(ctx, bank.id, code, statementDate),
      ...clearing(ctx, bank.id, code, statementDate) };
  }
  function reconcileStatus(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a bank account and a statement date.");
    const check = statementCheck(ctx, input);
    return { bankAccountId: check.bank.id, currency: check.code, currencies: check.currencies, date: check.statementDate, booksCents: check.booksCents,
      clearedCents: check.clearedCents, outstanding: check.outstanding, outstandingCount: check.outstandingCount, firstWaiting: check.firstWaiting,
      waiting: check.waiting, reviewQueue: check.reviewQueue, reconciliationId: check.existing ? check.existing.id : null, reconciledCents: check.existing ? check.existing.balanceCents : null };
  }
  function reconcileBank(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a bank account, a statement date, and its ending balance.");
    const { bank, statementDate, code, waiting, existing, booksCents, clearedCents } = statementCheck(ctx, input);
    if (!Number.isSafeInteger(input.balanceCents) || Math.abs(input.balanceCents) > MAX_CENTS) invalid(ctx, "Enter the statement's ending balance in whole cents.");
    if (existing) ctx.refuse("already_reconciled", `${bank.name} is already reconciled on ${statementDate}. Remove that reconciliation first.`);
    if (waiting) ctx.refuse("unreviewed", `Review or confirm the ${waiting} statement ${waiting === 1 ? "row" : "rows"} dated on or before ${statementDate} first.`);
    const through = closedThrough(ctx);
    if (through && statementDate <= through) ctx.refuse("period_closed", `${statementDate} is in a closed month. Reconcile a later statement.`);
    if (clearedCents !== input.balanceCents)
      ctx.refuse("not_reconciled", `${bank.name} should show ${amountText(clearedCents, code)} on ${statementDate}: ${amountText(booksCents, code)} in the books, less what hasn't cleared. That is ${amountText(Math.abs(clearedCents - input.balanceCents), code)} from the statement.`);
    execute(ctx, "INSERT INTO reconciliations(id,bank_account_id,currency,statement_date,balance_cents,created_at_ms) VALUES(?,?,?,?,?,?)",
      [ctx.requestId, bank.id, code, statementDate, input.balanceCents, ctx.nowMs]);
    return { id: ctx.requestId, bankAccountId: bank.id, currency: code, date: statementDate, balanceCents: input.balanceCents };
  }
  function removeReconciliation(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a reconciliation.");
    const id = text(ctx, input.id, 200, "Choose a reconciliation.");
    const found = ctx.db.query("SELECT statement_date AS day FROM reconciliations WHERE id=?", [id])[0];
    if (!found) ctx.refuse("not_found", "That reconciliation does not exist.");
    const through = closedThrough(ctx);
    if (through && found.day <= through) ctx.refuse("period_closed", `The ${found.day} reconciliation is in a closed month. It stays as it is.`);
    execute(ctx, "DELETE FROM reconciliations WHERE id=?", [id]);
    return { id, removed: true };
  }
  function postBankRows(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows to post.");
    const picks = list(ctx, input.rows, 1, MAX_BANK_POSTS, `Post 1 to ${MAX_BANK_POSTS} bank rows at a time.`);
    const accounts = accountsById(ctx), allPeriods = periods(ctx);
    const ids = picks.map((pick) => object(ctx, pick, "Choose each bank row and account.").id);
    if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) invalid(ctx, "Choose each bank row once.");
    const rows = new Map(ctx.db.query(`SELECT id,bank_account_id AS bankAccountId,posted_on AS date,description,amount_cents AS amountCents,currency,status
      FROM bank_imports WHERE id IN (${jsonList()})`, [JSON.stringify(ids)]).map((row) => [row.id, row]));
    const entries = picks.map((pick, index) => {
      const row = rows.get(pick.id);
      if (!row) ctx.refuse("not_found", `Bank row ${pick.id} does not exist.`);
      if (row.status !== "new") ctx.refuse("conflict", `Bank row ${pick.id} is ${row.status}, not new.`);
      const label = row.description || "each row";
      const amount = Math.abs(row.amountCents);
      const splits = pick.splits === undefined
        ? [{ accountId: pick.accountId, amountCents: amount }]
        : list(ctx, pick.splits, 2, MAX_LINES - 1, `Split ${label} into 2 to ${MAX_LINES - 1} parts.`);
      let allocated = 0;
      const others = splits.map((split) => {
        object(ctx, split, `Enter each split of ${label}.`);
        const account = accounts.get(split.accountId);
        if (!account || account.id === row.bankAccountId) invalid(ctx, `Choose the other account for ${label}.`);
        if (account.role === "receivable") invalid(ctx, `Record ${label} as a payment on its invoice. ${account.name} follows the invoices.`);
        const part = cents(ctx, split.amountCents, `Enter each split of ${label} in whole cents.`);
        allocated += part;
        const lineMemo = split.memo === undefined ? undefined : split.memo;
        return row.amountCents > 0
          ? { accountId: account.id, creditCents: part, memo: lineMemo }
          : { accountId: account.id, debitCents: part, memo: lineMemo };
      });
      if (allocated !== amount) ctx.refuse("unbalanced", `The splits of ${label} add up to ${allocated} cents, not ${amount}.`);
      const bankSide = row.amountCents > 0 ? { accountId: row.bankAccountId, debitCents: amount } : { accountId: row.bankAccountId, creditCents: amount };
      const memo = pick.memo === undefined ? row.description : text(ctx, pick.memo, 500, "Keep memos under 500 characters.");
      const lines = row.amountCents > 0 ? [bankSide, ...others] : [...others, bankSide];
      return { ...normalizeEntry(ctx, { date: row.date, currency: row.currency, memo, lines }, accounts, allPeriods, index),
        source: "bank", sourceId: row.id, idSuffix: `b${index + 1}` };
    });
    const created = insertLinesThenEntries(ctx, entries);
    execute(ctx, `UPDATE bank_imports SET status='posted',journal_entry_id=(SELECT e.id FROM journal_entries e
      WHERE e.source='bank' AND e.source_id=bank_imports.id AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id))
      WHERE id IN (${jsonList()})`, [JSON.stringify(ids)]);
    const reviewed = picks.map((pick) => ({ id: pick.id, seen: reviewedEntries(ctx, pick.notMatched) }));
    const known = ctx.db.query(`${NETS}, p AS (SELECT json_extract(?1,'$['||n||'].id') AS id,json_extract(?1,'$['||n||'].seen') AS seen
        FROM (WITH RECURSIVE i(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM i WHERE n+1<json_array_length(?1)) SELECT n FROM i))
      SELECT * FROM (SELECT b.description,(${UNREVIEWED}) AS number FROM p JOIN bank_imports b ON b.id=p.id) WHERE number IS NOT NULL LIMIT 1`,
      [JSON.stringify(reviewed)])[0];
    if (known)
      ctx.refuse("already_in_books", `${known.description} may be the same money as entry ${known.number}. Match the row to it, or list the entry in notMatched to post the row as new money.`);
    return { posted: created.length, entries: created.map((entry) => entry.id), numbers: created.map((entry) => entry.number) };
  }
  function setBankRowsIgnored(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose bank rows.");
    const ids = list(ctx, input.ids, 1, MAX_BANK_POSTS, `Choose 1 to ${MAX_BANK_POSTS} rows.`);
    if (ids.some((id) => typeof id !== "string")) invalid(ctx, "Choose bank rows by ID.");
    const [from, to] = input.ignored === false ? ["ignored", "new"] : ["new", "ignored"];
    if (input.ignored === false) rowsOpenCheck(ctx, ids);
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
    rowsOpenCheck(ctx, [id]);
    const existing = new Set(ctx.db.query("SELECT row_hash AS hash FROM bank_imports WHERE status<>'duplicate' AND base_hash=?", [row.baseHash]).map((item) => item.hash));
    let occurrence = existing.size + 1;
    let nextHash = sha256(`${row.baseHash}\n${occurrence}`);
    while (existing.has(nextHash)) {
      occurrence += 1;
      nextHash = sha256(`${row.baseHash}\n${occurrence}`);
    }
    execute(ctx, "UPDATE bank_imports SET status='new',row_hash=?,confirmed=0 WHERE id=? AND status='duplicate'", [nextHash, id]);
    return { id, status: "new", rowHash: nextHash };
  }
  function confirmDuplicateBankRow(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a duplicate bank row.");
    const id = text(ctx, input.id, 200, "Choose a duplicate bank row.");
    if (typeof input.confirmed !== "boolean") invalid(ctx, "Set confirmed to true or false.");
    const row = ctx.db.query("SELECT status FROM bank_imports WHERE id=?", [id])[0];
    if (!row) ctx.refuse("not_found", "That bank row does not exist.");
    if (row.status !== "duplicate") ctx.refuse("conflict", `Bank row ${id} is ${row.status}, not duplicate.`);
    if (!input.confirmed) rowsOpenCheck(ctx, [id]);
    execute(ctx, "UPDATE bank_imports SET confirmed=? WHERE id=? AND status='duplicate'", [input.confirmed ? 1 : 0, id]);
    return { id, confirmed: input.confirmed };
  }
  function findBankMatches(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a bank row.");
    const id = text(ctx, input.id, 200, "Choose a bank row.");
    const row = ctx.db.query("SELECT status FROM bank_imports WHERE id=?", [id])[0];
    if (!row) ctx.refuse("not_found", "That bank row does not exist.");
    if (row.status !== "new") ctx.refuse("conflict", `Bank row ${id} is ${row.status}, so it cannot be matched.`);
    return {
      days: MATCH_DAYS,
      entries: ctx.db.query(`${NETS} SELECT e.id,e.number,e.entry_date AS date,substr(e.memo,1,${PREVIEW}) AS memo,
        substr((SELECT group_concat(a.name,', ') FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.is_bank=0),1,${PREVIEW}) AS accounts
        FROM bank_imports b JOIN journal_entries e ON e.id IN (${LINKABLE}) WHERE b.id=?
        ORDER BY abs(julianday(e.entry_date)-julianday(b.posted_on)),e.number LIMIT 50`, [id]),
    };
  }
  function clearingLockCheck(ctx, rowId, entryId, change) {
    const through = closedThrough(ctx);
    if (!through) return;
    const locked = ctx.db.query(`SELECT e.number,b.posted_on AS posted,r.statement_date AS day FROM bank_imports b JOIN journal_entries e ON e.id=?2
      JOIN reconciliations r ON r.bank_account_id=b.bank_account_id AND r.currency=b.currency
      WHERE b.id=?1 AND e.entry_date<${firstRow("b.bank_account_id", "b.currency")} AND r.statement_date>=e.entry_date
        AND r.statement_date<b.posted_on AND r.statement_date<=?3 ORDER BY r.statement_date LIMIT 1`, [rowId, entryId, through])[0];
    if (locked)
      ctx.refuse("period_closed", `Entry ${locked.number} counts as cleared in the ${locked.day} reconciliation, in a closed month. ${change(locked.posted)}`);
  }
  function linkBankRow(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a bank row and the entry it matches.");
    const id = text(ctx, input.id, 200, "Choose a bank row.");
    const entryId = text(ctx, input.entryId, 200, "Choose the entry this row matches.");
    const row = ctx.db.query("SELECT status FROM bank_imports WHERE id=?", [id])[0];
    if (!row) ctx.refuse("not_found", "That bank row does not exist.");
    if (row.status !== "new") ctx.refuse("conflict", `Bank row ${id} is ${row.status}, so it cannot be matched.`);
    rowsOpenCheck(ctx, [id]);
    const entry = ctx.db.query(`${NETS} SELECT e.id,e.number FROM bank_imports b JOIN journal_entries e ON e.id=?1 WHERE b.id=?2
      AND e.id IN (${LINKABLE})`, [entryId, id])[0];
    if (!entry) ctx.refuse("conflict", `Match an entry that moves this amount through this bank account within ${MATCH_DAYS} days and no other row matches.`);
    clearingLockCheck(ctx, id, entry.id, (posted) => `Matching it to a row dated ${posted} would change it.`);
    execute(ctx, "UPDATE bank_imports SET status='posted',journal_entry_id=?,linked=1 WHERE id=? AND status='new'", [entry.id, id]);
    return { id, entryId: entry.id, number: entry.number };
  }
  function unlinkBankRow(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose a matched bank row.");
    const id = text(ctx, input.id, 200, "Choose a matched bank row.");
    if (!ctx.db.query("SELECT 1 AS found FROM bank_imports WHERE id=?", [id]).length) ctx.refuse("not_found", "That bank row does not exist.");
    const reversed = ctx.db.query(`SELECT e.number,r.number AS reversal FROM bank_imports b JOIN journal_entries e ON e.id=b.journal_entry_id
      JOIN journal_entries r ON r.reverses_entry_id=e.id WHERE b.id=?`, [id])[0];
    rowsOpenCheck(ctx, [id]);
    const linked = ctx.db.query("SELECT journal_entry_id AS entryId FROM bank_imports WHERE id=? AND linked=1", [id])[0];
    if (linked) clearingLockCheck(ctx, id, linked.entryId, (posted) => `Unmatching it from a row dated ${posted} would change it.`);
    if (reversed)
      ctx.refuse("reversed", `Entry ${reversed.number} was reversed by entry ${reversed.reversal}, so this row stays posted. Post a new entry for the money instead.`);
    if (execute(ctx, "UPDATE bank_imports SET status='new',journal_entry_id=NULL,linked=0 WHERE id=? AND status='posted' AND linked=1", [id]).changes !== 1)
      ctx.refuse("conflict", "That bank row is not matched to an existing entry.");
    return { id, status: "new" };
  }

  function saveClient(ctx, input, newId = ctx.requestId) {
    owner(ctx);
    object(ctx, input, "Enter the client.");
    const name = text(ctx, input.name, 150, "Enter a client name up to 150 characters.");
    const email = text(ctx, input.email, 200, "Keep the email under 200 characters.", true);
    const address = text(ctx, input.address, 500, "Keep the address under 500 characters.", true);
    if (input.id !== undefined) {
      const id = text(ctx, input.id, 200, "Choose a client.");
      if (execute(ctx, "UPDATE clients SET name=?,email=?,address=? WHERE id=?", [name, email, address, id]).changes !== 1)
        ctx.refuse("not_found", "That client does not exist.");
      return { id, name, email, address };
    }
    execute(ctx, "INSERT INTO clients(id,name,email,address,created_at_ms) VALUES(?,?,?,?,?)", [newId, name, email, address, ctx.nowMs]);
    return { id: newId, name, email, address };
  }
  function business(ctx) {
    return ctx.db.query("SELECT name,email,address FROM business WHERE id='business'")[0] || null;
  }
  function getBusiness(ctx) {
    owner(ctx);
    return business(ctx);
  }
  function saveBusiness(ctx, input) {
    owner(ctx);
    object(ctx, input, "Enter your business details.");
    const name = text(ctx, input.name, 150, "Enter a business name up to 150 characters.");
    const email = text(ctx, input.email, 200, "Keep the email under 200 characters.", true);
    const address = text(ctx, input.address, 500, "Keep the address under 500 characters.", true);
    execute(ctx, `INSERT INTO business(id,name,email,address,updated_at_ms) VALUES('business',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,address=excluded.address,updated_at_ms=excluded.updated_at_ms`, [name, email, address, ctx.nowMs]);
    return { name, email, address };
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
    if (input.business !== undefined) saveBusiness(ctx, input.business);
    const client = input.client !== undefined
      ? saveClient(ctx, { ...object(ctx, input.client, "Enter the new client."), id: undefined }, `${ctx.requestId}-client`)
      : ctx.db.query("SELECT id FROM clients WHERE id=?", [text(ctx, input.clientId, 200, "Choose a client.")])[0];
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
      const current = ctx.db.query("SELECT id,status,version FROM invoices WHERE id=?", [text(ctx, input.id, 200, "Choose an invoice.")])[0];
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
    const id = text(ctx, input.id, 200, "Choose a draft invoice.");
    if (!Number.isSafeInteger(input.expectedVersion)) invalid(ctx, "Send the version of the draft you saw.");
    if (execute(ctx, "DELETE FROM invoices WHERE id=? AND status='draft' AND version=?", [id, input.expectedVersion]).changes !== 1)
      ctx.refuse("conflict", "Only an unchanged draft invoice can be deleted.");
    return { id, deleted: true };
  }
  function invoice(ctx, raw) {
    const id = text(ctx, raw, 200, "Choose an invoice.");
    const row = ctx.db.query(`SELECT i.id,i.number,i.client_id AS clientId,coalesce(i.buyer_name,c.name) AS clientName,
      CASE WHEN i.buyer_name IS NULL THEN c.email ELSE i.buyer_email END AS clientEmail,
      CASE WHEN i.buyer_name IS NULL THEN c.address ELSE i.buyer_address END AS clientAddress,
      i.seller_name AS sellerName,i.seller_email AS sellerEmail,i.seller_address AS sellerAddress,
      i.issue_date AS issueDate,i.due_date AS dueDate,i.currency,i.tax_rate_bp AS taxRateBp,i.subtotal_cents AS subtotalCents,
      i.tax_cents AS taxCents,i.total_cents AS totalCents,i.paid_cents AS paidCents,i.total_cents-i.paid_cents AS balanceCents,
      i.notes,i.status,i.journal_entry_id AS journalEntryId,i.void_entry_id AS voidEntryId,i.paid_on AS paidOn,i.version,
      (SELECT number FROM journal_entries WHERE id=i.journal_entry_id) AS saleNumber,
      (SELECT number FROM journal_entries WHERE id=i.void_entry_id) AS voidNumber
      FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?`, [id])[0];
    if (!row) ctx.refuse("not_found", "That invoice does not exist.");
    const { sellerName, sellerEmail, sellerAddress } = row;
    delete row.sellerName; delete row.sellerEmail; delete row.sellerAddress;
    row.seller = sellerName === null ? business(ctx) : { name: sellerName, email: sellerEmail, address: sellerAddress };
    row.payments = ctx.db.query(`SELECT p.entry_id AS entryId,e.number,p.paid_on AS date,p.amount_cents AS amountCents
      FROM invoice_payments p JOIN journal_entries e ON e.id=p.entry_id WHERE p.invoice_id=? ORDER BY p.paid_on,e.number`, [id]);
    const changed = ctx.db.query(`SELECT max(e.entry_date) AS day FROM journal_entries e WHERE (e.source='payment' AND e.source_id=?1)
      OR e.reverses_entry_id IN (SELECT p.id FROM journal_entries p WHERE p.source='payment' AND p.source_id=?1)`, [id])[0].day;
    row.voidFrom = changed && changed > row.issueDate ? changed : row.issueDate;
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
    if (!draft.seller) ctx.refuse("missing_business", "Add your business name before issuing an invoice.");
    notFuture(ctx, draft.issueDate, "invoice");
    const accounts = accountsById(ctx);
    const receivable = roleAccount(ctx, accounts, "receivable");
    const revenue = new Map();
    for (const line of draft.lines) revenue.set(line.revenueAccountId, (revenue.get(line.revenueAccountId) || 0) + line.amountCents);
    const lines = [{ accountId: receivable.id, debitCents: draft.totalCents }];
    for (const [accountId, amount] of revenue) if (amount > 0) lines.push({ accountId, creditCents: amount });
    if (draft.taxCents > 0) lines.push({ accountId: roleAccount(ctx, accounts, "sales_tax").id, creditCents: draft.taxCents });
    const number = `INV-${String(ctx.db.query("SELECT coalesce(max(CAST(substr(number,5) AS INTEGER)),0) AS n FROM invoices WHERE number IS NOT NULL")[0].n + 1).padStart(4, "0")}`;
    const entry = { ...normalizeEntry(ctx, { date: draft.issueDate, currency: draft.currency, memo: `Invoice ${number} to ${draft.clientName}`.slice(0, 500), lines }, accounts, periods(ctx)),
      source: "invoice", sourceId: draft.id };
    const [created] = insertLinesThenEntries(ctx, [entry]);
    execute(ctx, `UPDATE invoices SET status='issued',number=?,journal_entry_id=?,seller_name=?,seller_email=?,seller_address=?,
      buyer_name=?,buyer_email=?,buyer_address=?,version=version+1 WHERE id=? AND version=?`, [number, created.id, draft.seller.name,
      draft.seller.email, draft.seller.address, draft.clientName, draft.clientEmail, draft.clientAddress, draft.id, draft.version]);
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
    let amount = input.amountCents === undefined ? issued.balanceCents : cents(ctx, input.amountCents, "Enter the payment in whole cents.");
    if (input.bankRowId !== undefined) {
      bankRow = ctx.db.query("SELECT id,bank_account_id AS bankAccountId,posted_on AS date,amount_cents AS amountCents,currency,status FROM bank_imports WHERE id=?", [text(ctx, input.bankRowId, 200, "Choose a bank row.")])[0];
      if (!bankRow || bankRow.status !== "new") ctx.refuse("conflict", "Choose a new bank row.");
      const unseen = ctx.db.query(`${NETS}, p AS (SELECT ? AS seen) SELECT (${UNREVIEWED}) AS number FROM p,bank_imports b WHERE b.id=?`,
        [JSON.stringify(reviewedEntries(ctx, input.notMatched)), bankRow.id])[0].number;
      if (unseen)
        ctx.refuse("already_in_books", `Entry ${unseen} may record this bank row. Match the row to it, or list the entry in notMatched to pay the invoice from it.`);
      if (bankRow.currency !== issued.currency || (input.amountCents !== undefined && input.amountCents !== bankRow.amountCents))
        ctx.refuse("amount_mismatch", "The payment takes the bank row's amount and currency.");
      paidOn = bankRow.date;
      bankAccountId = bankRow.bankAccountId;
      amount = Math.min(bankRow.amountCents, issued.balanceCents);
    }
    const restCents = bankRow ? bankRow.amountCents - amount : 0;
    const rest = restCents > 0 ? accounts.get(input.restAccountId) : null;
    if (restCents > 0 && (!rest || rest.isBank || rest.role === "receivable"))
      invalid(ctx, `Choose the account for the ${amountText(restCents, issued.currency)} beyond what ${issued.number} owes.`);
    if (amount <= 0 || amount > issued.balanceCents)
      ctx.refuse("amount_mismatch", `Record a payment up to ${amountText(issued.balanceCents, issued.currency)}, the amount still due.`);
    date(ctx, paidOn, "Enter the payment date as YYYY-MM-DD.");
    if (paidOn < issued.issueDate) invalid(ctx, `The payment date cannot be before the issue date (${issued.issueDate}).`);
    notFuture(ctx, paidOn, "payment");
    const bank = accounts.get(bankAccountId);
    if (!bank || !bank.isBank) invalid(ctx, "Choose the bank account that received the payment.");
    const receivable = roleAccount(ctx, accounts, "receivable");
    const low = ctx.db.query(`SELECT d.day,(SELECT coalesce(sum(l.debit_cents-l.credit_cents),0) FROM journal_lines l
        JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=?3 AND e.source_id=?1 AND e.entry_date<=d.day) AS due
      FROM (SELECT ?2 AS day UNION SELECT entry_date FROM journal_entries WHERE source_id=?1 AND entry_date>?2) d
      ORDER BY due,d.day LIMIT 1`, [issued.id, paidOn, receivable.id])[0];
    if (low.due < amount)
      ctx.refuse("amount_mismatch", `${issued.number} had ${amountText(low.due, issued.currency)} due on ${low.day}, so ${amountText(amount, issued.currency)} dated ${paidOn} would overpay it. Date the payment on or after the day the earlier payment was reversed.`);
    const entry = { ...normalizeEntry(ctx, { date: paidOn, currency: issued.currency, memo: `Payment for invoice ${issued.number}`,
      lines: [{ accountId: bank.id, debitCents: amount + restCents }, { accountId: receivable.id, creditCents: amount },
        ...(rest ? [{ accountId: rest.id, creditCents: restCents, memo: `Beyond invoice ${issued.number}` }] : [])] }, accounts, periods(ctx)),
      source: "payment", sourceId: issued.id };
    const [created] = insertLinesThenEntries(ctx, [entry]);
    execute(ctx, "INSERT INTO invoice_payments(entry_id,invoice_id,paid_on,amount_cents) VALUES(?,?,?,?)", [created.id, issued.id, paidOn, amount]);
    if (bankRow) execute(ctx, "UPDATE bank_imports SET status='posted',journal_entry_id=? WHERE id=? AND status='new'", [created.id, bankRow.id]);
    const balanceCents = issued.balanceCents - amount;
    return { id: issued.id, status: balanceCents ? "issued" : "paid", version: issued.version + 1, paymentEntryId: created.id,
      paymentNumber: created.number, amountCents: amount, restCents, balanceCents };
  }
  function voidInvoice(ctx, input) {
    owner(ctx);
    object(ctx, input, "Choose an invoice to void.");
    const issued = invoice(ctx, input.id);
    if (issued.paidCents > 0) ctx.refuse("conflict", "Reverse this invoice's payments before voiding it.");
    if (issued.status !== "issued") ctx.refuse("conflict", `Invoice ${issued.number || "draft"} is ${issued.status}.`);
    if (input.expectedVersion !== issued.version) ctx.refuse("conflict", "This invoice changed. Reload it before voiding.");
    const voidDate = input.date === undefined ? issued.voidFrom : date(ctx, input.date, "Enter the void date as YYYY-MM-DD.");
    if (voidDate < issued.voidFrom)
      invalid(ctx, issued.voidFrom === issued.issueDate
        ? `The void date cannot be before the issue date (${issued.issueDate}).`
        : `The void date cannot be before ${issued.voidFrom}, when a payment on this invoice last changed.`);
    notFuture(ctx, voidDate, "void");
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
    const status = input.status === undefined ? null : input.status;
    if (status !== null && !["draft", "issued", "overdue", "paid", "void"].includes(status)) invalid(ctx, "Choose draft, issued, overdue, paid, or void invoices.");
    const today = date(ctx, input.today, "Enter today's date as YYYY-MM-DD.");
    const rows = ctx.db.query(`SELECT i.id,i.number,coalesce(i.buyer_name,c.name) AS clientName,i.issue_date AS issueDate,i.due_date AS dueDate,
      i.currency,i.total_cents AS totalCents,i.paid_cents AS paidCents,i.status,i.paid_on AS paidOn,i.version FROM invoices i JOIN clients c ON c.id=i.client_id
      WHERE ?1 IS NULL OR i.status=?1 OR (?1='overdue' AND i.status='issued' AND i.due_date<?4)
      ORDER BY i.status='draft' DESC,i.issue_date DESC,i.created_at_ms DESC LIMIT ?2 OFFSET ?3`, [status, size + 1, offset, today]);
    const counts = Object.fromEntries(ctx.db.query("SELECT status,count(*) AS n FROM invoices GROUP BY status").map((row) => [row.status, row.n]));
    counts.overdue = ctx.db.query("SELECT count(*) AS n FROM invoices WHERE status='issued' AND due_date<?", [today])[0].n;
    const more = rows.length > size;
    if (more) rows.pop();
    return { invoices: rows, counts, status, offset, nextOffset: more ? offset + size : null };
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
    const named = business(ctx);
    return {
      name: named ? named.name : null,
      fiscalStartMonth: fiscalStartMonth(ctx),
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
    const sum = (type, from = rows) => from.filter((row) => row.type === type).reduce((total, row) => total + row.balanceCents, 0);
    const yearStart = fiscalYearStart(ctx, asOf);
    const earlier = accountTotals(ctx, reportCode, "0000-01-01", shiftDay(yearStart, -1), ["income", "expense"]);
    const retainedEarningsCents = sum("income", earlier) - sum("expense", earlier);
    const earningsCents = sum("income") - sum("expense") - retainedEarningsCents;
    const assets = rows.filter((row) => row.type === "asset"), liabilities = rows.filter((row) => row.type === "liability");
    const equity = rows.filter((row) => row.type === "equity");
    const totalAssetsCents = sum("asset"), totalLiabilitiesCents = sum("liability"), totalEquityCents = sum("equity") + retainedEarningsCents + earningsCents;
    return { asOf, yearStart, currency: reportCode, assets, liabilities, equity, retainedEarningsCents, earningsCents, totalAssetsCents, totalLiabilitiesCents,
      totalEquityCents, balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents };
  }
  function accountLedger(ctx, input) {
    object(ctx, input, "Choose an account.");
    const account = ctx.db.query("SELECT id,name,type FROM accounts WHERE id=?", [text(ctx, input.accountId, 200, "Choose an account.")])[0];
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
    const statement = incomeStatement(ctx, { from: fiscalYearStart(ctx, today), to: today, currency: reportCode });
    const accounts = ctx.db.query(`SELECT a.id,a.name,a.type,a.role,a.is_bank AS isBank,a.archived,
      coalesce(t.d,0) AS debitCents,coalesce(t.c,0) AS creditCents FROM accounts a LEFT JOIN (SELECT l.account_id AS id,
      sum(l.debit_cents) AS d,sum(l.credit_cents) AS c FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE e.currency=? AND e.entry_date<=? GROUP BY l.account_id) t ON t.id=a.id ORDER BY a.id`, [reportCode, today])
      .map(({ debitCents, creditCents, ...row }) => ({ ...row, isBank: row.isBank === 1, archived: row.archived === 1,
        balanceCents: signedBalance(row.type, debitCents, creditCents) }));
    const cash = accounts.filter((row) => row.isBank);
    const receivables = ctx.db.query(`SELECT count(*) AS open,coalesce(sum(due),0) AS openCents,coalesce(sum(due_date<?1),0) AS overdue,
      coalesce(sum(CASE WHEN due_date<?1 THEN due END),0) AS overdueCents FROM (SELECT i.due_date,sum(l.debit_cents-l.credit_cents) AS due
      FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN invoices i ON i.id=e.source_id
      WHERE l.account_id=(SELECT id FROM accounts WHERE role='receivable') AND e.source IN ('invoice','payment','reversal')
      AND e.entry_date<=?1 AND i.currency=?2 GROUP BY i.id HAVING due>0)`, [today, reportCode])[0];
    const bank = Object.fromEntries(ctx.db.query("SELECT status,count(*) AS n FROM bank_imports WHERE status IN ('new','duplicate') AND confirmed=0 GROUP BY status")
      .map((row) => [row.status, row.n]));
    const drafts = ctx.db.query("SELECT count(*) AS n FROM invoices WHERE status='draft'")[0].n;
    const missingReceipts = ctx.db.query(`SELECT count(*) AS n FROM journal_entries e WHERE ${MISSING_RECEIPT}`)[0].n;
    const allPeriods = periods(ctx);
    const unlocked = allPeriods.filter((row) => row.status === "open" && row.endDate < today);
    const current = allPeriods.find((row) => row.startDate <= today && today <= row.endDate) || null;
    const recent = ctx.db.query(`SELECT e.id,e.number,e.entry_date AS date,e.currency,e.memo,e.total_cents AS totalCents,e.source,
      e.reverses_entry_id IS NOT NULL AS reversal,EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=e.id) AS reversed
      FROM journal_entries e ORDER BY e.entry_date DESC,e.number DESC LIMIT 6`).map((row) => ({ ...row, reversal: row.reversal === 1, reversed: row.reversed === 1 }));
    return { today, currency: reportCode, currencies: booksInfo(ctx).currencies.map((row) => row.currency), accounts, cash,
      cashCents: cash.reduce((sum, row) => sum + row.balanceCents, 0), receivables, newBankRows: bank.new || 0,
      duplicateBankRows: bank.duplicate || 0, draftInvoices: drafts, missingReceipts, recent,
      periods: { total: allPeriods.length, current, unlocked: unlocked.length, nextToLock: unlocked[0] ? unlocked[0].id : null,
        lockedThrough: allPeriods.filter((row) => row.status === "locked").map((row) => row.id).pop() || null },
      fiscalStartMonth: fiscalStartMonth(ctx),
      yearToDate: { incomeCents: statement.totalIncomeCents, expenseCents: statement.totalExpenseCents, netIncomeCents: statement.netIncomeCents, months: statement.months },
      hasPeriods: allPeriods.length > 0 };
  }

  globalThis.operations = {
    overview, booksInfo, trialBalance, incomeStatement, balanceSheet, accountLedger,
    listAccounts, addAccount, updateAccount, listPeriods, addFiscalYear, lockPeriod,
    listEntries, getEntry, postJournalEntry, postJournalEntries, reverseJournalEntry, attachReceipt, removeReceipt, receiptAccess,
    stageBankRows, listBankRows, postBankRows, setBankRowsIgnored, keepDuplicateBankRow, confirmDuplicateBankRow, findBankMatches, linkBankRow, unlinkBankRow, reconcileStatus, reconcileBank, removeReconciliation,
    getBusiness, saveBusiness, listClients, saveClient, listInvoices, getInvoice, saveDraftInvoice, deleteDraftInvoice, issueInvoice, recordPayment, voidInvoice,
  };
}());
