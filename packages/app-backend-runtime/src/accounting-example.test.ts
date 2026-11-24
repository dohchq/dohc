import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { mapStatement } from "../../../examples/accounting/statement.ts";
import {
  accountingFile,
  accountingFixture,
  receiptPdf,
  receiptText,
} from "./accounting.test-helper.ts";

type Fixture = Awaited<ReturnType<typeof accountingFixture>>;
const open: Fixture[] = [];
afterEach(async () => {
  for (const fixture of open.splice(0)) await fixture.close();
});
async function books() {
  const fixture = await accountingFixture();
  open.push(fixture);
  await fixture.result("addFiscalYear", { year: 2026 });
  return fixture;
}
const refusal = (code: string) => ({ refusal: { code } });
const entry = (date: string, lines: Array<[string, number, number]>, extra: object = {}) => ({
  date,
  currency: "USD",
  memo: "Synthetic entry",
  lines: lines.map(([accountId, debitCents, creditCents]) => ({
    accountId,
    ...(debitCents ? { debitCents } : {}),
    ...(creditCents ? { creditCents } : {}),
  })),
  ...extra,
});

describe("accounting example on the real dataset host", () => {
  it("posts only balanced whole-cent entries and keeps currencies apart", async () => {
    const f = await books();
    const capital = entry("2026-01-02", [
      ["1000", 1_000_000, 0],
      ["3000", 0, 1_000_000],
    ]);
    const posted = await f.result("postJournalEntry", capital);
    expect(posted).toMatchObject({ number: 1, totalCents: 1_000_000 });
    await f.result("postJournalEntry", {
      ...entry("2026-01-03", [
        ["1010", 50_000, 0],
        ["3000", 0, 50_000],
      ]),
      currency: "EUR",
    });
    for (const [input, code] of [
      [
        entry("2026-01-05", [
          ["6000", 100, 0],
          ["1000", 0, 99],
        ]),
        "unbalanced",
      ],
      [
        entry("2026-01-05", [
          ["6000", 100.5, 0],
          ["1000", 0, 100.5],
        ]),
        "invalid_input",
      ],
      [entry("2026-01-05", [["6000", 100, 0]]), "invalid_input"],
      [
        {
          ...entry("2026-01-05", [
            ["6000", 100, 0],
            ["1000", 0, 100],
          ]),
          currency: "usd",
        },
        "invalid_input",
      ],
      [
        entry("2026-01-05", [
          ["9999", 100, 0],
          ["1000", 0, 100],
        ]),
        "invalid_input",
      ],
      [
        entry("2027-01-05", [
          ["6000", 100, 0],
          ["1000", 0, 100],
        ]),
        "period_closed",
      ],
    ] as const)
      await expect(f.call("postJournalEntry", input)).rejects.toMatchObject(refusal(code));
    const both = entry("2026-01-05", [
      ["6000", 100, 0],
      ["1000", 0, 100],
    ]);
    both.lines[0]!.creditCents = 5;
    await expect(f.call("postJournalEntry", both)).rejects.toMatchObject(refusal("invalid_input"));

    const usd = await f.result("trialBalance", { asOf: "2026-12-31", currency: "USD" });
    expect(usd).toMatchObject({
      totalDebitCents: 1_000_000,
      totalCreditCents: 1_000_000,
      balanced: true,
    });
    expect(usd.rows.map((row: any) => row.id)).toEqual(["1000", "3000"]);
    const eur = await f.result("trialBalance", { asOf: "2026-12-31", currency: "EUR" });
    expect(eur).toMatchObject({ totalDebitCents: 50_000, balanced: true });
    expect((await f.result("booksInfo")).currencies.map((row: any) => row.currency)).toEqual([
      "EUR",
      "USD",
    ]);
  });

  it("refuses archived accounts, corrects by reversal only, and locks periods in order", async () => {
    const f = await books();
    const rent = await f.result(
      "postJournalEntry",
      entry("2026-01-31", [
        ["6000", 120_000, 0],
        ["1000", 0, 120_000],
      ]),
    );
    const reversed = await f.result("reverseJournalEntry", { entryId: rent.id });
    expect(reversed).toMatchObject({ number: 2, date: "2026-01-31" });
    await expect(f.call("reverseJournalEntry", { entryId: rent.id })).rejects.toMatchObject(
      refusal("already_reversed"),
    );
    await expect(f.call("reverseJournalEntry", { entryId: reversed.id })).rejects.toMatchObject(
      refusal("is_reversal"),
    );
    const tb = await f.result("trialBalance", { asOf: "2026-12-31", currency: "USD" });
    expect(
      tb.rows.every((row: any) => row.debitBalanceCents === 0 && row.creditBalanceCents === 0),
    ).toBe(true);
    expect((await f.result("getEntry", { id: rent.id })).reversedByEntryId).toBe(reversed.id);

    await f.result("updateAccount", { id: "6900", archived: true });
    await expect(
      f.call(
        "postJournalEntry",
        entry("2026-02-01", [
          ["6900", 10, 0],
          ["1000", 0, 10],
        ]),
      ),
    ).rejects.toMatchObject(refusal("account_archived"));
    await expect(f.call("updateAccount", { id: "1100", archived: true })).rejects.toMatchObject(
      refusal("account_in_use"),
    );

    await expect(f.call("lockPeriod", { periodId: "2026-02" })).rejects.toMatchObject(
      refusal("lock_in_order"),
    );
    await f.result("lockPeriod", { periodId: "2026-01" });
    await expect(
      f.call(
        "postJournalEntry",
        entry("2026-01-15", [
          ["6000", 10, 0],
          ["1000", 0, 10],
        ]),
      ),
    ).rejects.toMatchObject(refusal("period_closed"));
    await expect(
      f.call("attachReceipt", { entryId: rent.id, fileId: receiptPdf.fileId }),
    ).rejects.toMatchObject({
      refusal: {
        code: "posted",
        message: "A posted entry cannot change. Post a reversing entry instead.",
      },
    });
    expect((await f.result("listPeriods"))[0]).toMatchObject({
      id: "2026-01",
      status: "locked",
      entries: 2,
    });
  });

  it("issues, pays, reverses, and voids invoices atomically with their ledger entries", async () => {
    const f = await books();
    const client = await f.result("saveClient", {
      name: "Synthetic Client Co",
      email: "billing@example.test",
    });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-03-01",
      dueDate: "2026-03-31",
      currency: "USD",
      taxRateBp: 825,
      lines: [
        {
          description: "Design work",
          quantity: 12.5,
          unitPriceCents: 15_000,
          revenueAccountId: "4000",
        },
        {
          description: "Printed copies",
          quantity: 3,
          unitPriceCents: 333,
          revenueAccountId: "4100",
        },
      ],
    });
    expect(draft).toMatchObject({ subtotalCents: 188_499, taxCents: 15_551, totalCents: 204_050 });
    await f.result("lockPeriod", { periodId: "2026-01" });
    await f.result("lockPeriod", { periodId: "2026-02" });
    await f.result("lockPeriod", { periodId: "2026-03" });
    await expect(
      f.call("issueInvoice", { id: draft.id, expectedVersion: 1 }),
    ).rejects.toMatchObject(refusal("period_closed"));
    expect(await f.result("getInvoice", { id: draft.id })).toMatchObject({
      status: "draft",
      number: null,
    });
    expect((await f.result("listEntries", {})).entries).toEqual([]);

    const second = await f.result("saveDraftInvoice", {
      id: draft.id,
      expectedVersion: 1,
      clientId: client.id,
      issueDate: "2026-04-01",
      dueDate: "2026-04-30",
      currency: "USD",
      taxRateBp: 825,
      lines: [
        {
          description: "Design work",
          quantity: 12.5,
          unitPriceCents: 15_000,
          revenueAccountId: "4000",
        },
      ],
    });
    const issued = await f.result("issueInvoice", {
      id: draft.id,
      expectedVersion: second.version,
    });
    expect(issued).toMatchObject({ number: "INV-0001", status: "issued" });
    const posting = await f.result("getEntry", { id: issued.journalEntryId });
    expect(
      posting.lines.map((line: any) => [line.accountId, line.debitCents, line.creditCents]),
    ).toEqual([
      ["1100", 202_969, 0],
      ["4000", 0, 187_500],
      ["2100", 0, 15_469],
    ]);
    await expect(
      f.call("saveDraftInvoice", {
        id: draft.id,
        expectedVersion: issued.version,
        clientId: client.id,
        issueDate: "2026-04-01",
        dueDate: "2026-04-30",
        currency: "USD",
        lines: [
          { description: "Changed", quantity: 1, unitPriceCents: 1, revenueAccountId: "4000" },
        ],
      }),
    ).rejects.toMatchObject(refusal("invoice_issued"));

    const paid = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: issued.version,
      date: "2026-04-20",
      bankAccountId: "1000",
    });
    expect(paid.status).toBe("paid");
    await expect(
      f.call("voidInvoice", { id: draft.id, expectedVersion: paid.version }),
    ).rejects.toMatchObject(refusal("conflict"));
    await f.result("reverseJournalEntry", { entryId: paid.paymentEntryId });
    const reopened = await f.result("getInvoice", { id: draft.id });
    expect(reopened).toMatchObject({ status: "issued", paymentEntryId: null });
    await expect(
      f.call("reverseJournalEntry", { entryId: issued.journalEntryId }),
    ).rejects.toMatchObject(refusal("use_invoice"));
    await expect(
      f.call("voidInvoice", {
        id: draft.id,
        expectedVersion: reopened.version,
        date: "2026-03-31",
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("lockPeriod", { periodId: "2026-04" });
    await expect(
      f.call("voidInvoice", { id: draft.id, expectedVersion: reopened.version }),
    ).rejects.toMatchObject(refusal("period_closed"));
    const voided = await f.result("voidInvoice", {
      id: draft.id,
      expectedVersion: reopened.version,
      date: "2026-05-01",
    });
    expect(voided.status).toBe("void");
    const sheet = await f.result("balanceSheet", { asOf: "2026-12-31", currency: "USD" });
    expect(sheet).toMatchObject({
      totalAssetsCents: 0,
      totalLiabilitiesCents: 0,
      totalEquityCents: 0,
      balanced: true,
    });
  });

  it("imports bank statements idempotently with SHA-256 row identities", async () => {
    const f = await books();
    const statement = [
      ["2026-05-01", "Coffee  Shop", "-4.50"],
      ["2026-05-01", "Coffee Shop", "-4.50"],
      ["2026-05-02", "Client payment", "1,250.00"],
      ["2026-05-03", "Bank fee", "(12.00)"],
    ];
    const stage = (importId: string, firstLine: number, rows: string[][]) =>
      f.result("stageBankRows", {
        importId,
        bankAccountId: "1000",
        currency: "USD",
        firstLine,
        rows,
      });
    expect(await stage("import-may-a", 1, statement.slice(0, 2))).toMatchObject({
      added: 2,
      duplicates: 0,
      nextLine: 3,
    });
    await expect(
      f.call("stageBankRows", {
        importId: "import-may-a",
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 5,
        rows: statement.slice(3),
      }),
    ).rejects.toMatchObject(refusal("out_of_order"));
    expect(await stage("import-may-a", 1, statement.slice(0, 2))).toMatchObject({
      added: 0,
      alreadyStaged: 2,
    });
    expect(await stage("import-may-a", 3, statement.slice(2))).toMatchObject({
      added: 2,
      nextLine: 5,
    });
    expect(await stage("import-may-b", 1, statement)).toMatchObject({ added: 0, duplicates: 4 });
    expect(
      await stage("import-may-c", 1, [
        ...statement.slice(1),
        ["2026-05-01", "Coffee Shop", "-4.50"],
        ["2026-05-04", "Rent", "-1200"],
      ]),
    ).toMatchObject({ added: 1, duplicates: 4 });
    await expect(stage("import-may-d", 1, [["2026-05-32", "Bad", "1"]])).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    await expect(stage("import-may-d", 1, [["2026-05-30", "Bad", "1.001"]])).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    for (const badAmount of ["(-4.00)", "(+4.00)", "12,34", "1,2345", ",100"])
      await expect(
        stage("import-may-d", 1, [["2026-05-30", "Bad", badAmount]]),
      ).rejects.toMatchObject(refusal("invalid_input"));

    const fresh = await f.result("listBankRows", { status: "new" });
    expect(fresh.counts).toEqual({ new: 5, duplicate: 8 });
    const duplicates = await f.result("listBankRows", { status: "duplicate" });
    const separateCoffee = duplicates.rows.find((row: any) => row.description === "Coffee Shop");
    const promoted = await f.result("keepDuplicateBankRow", { id: separateCoffee.id });
    expect(promoted).toMatchObject({ id: separateCoffee.id, status: "new" });
    expect(promoted.rowHash).not.toBe(separateCoffee.rowHash);
    await expect(f.call("keepDuplicateBankRow", { id: separateCoffee.id })).rejects.toMatchObject(
      refusal("conflict"),
    );
    await f.result("setBankRowsIgnored", { ids: [separateCoffee.id], ignored: true });

    const splitMapped = mapStatement(
      [
        ["2026-05-30", "Signed debit", "+4.00", ""],
        ["2026-05-30", "Paren debit", "(5.50)", ""],
        ["2026-05-30", "Signed credit", "", "+12.00"],
        ["2026-05-30", "Both sides", "100.00", "25.00"],
      ],
      { date: 0, description: 1, amount: 2, credit: 3 },
      "ymd",
    );
    expect(splitMapped).toEqual({
      rows: [
        ["2026-05-30", "Signed debit", "-4.00"],
        ["2026-05-30", "Paren debit", "-5.50"],
        ["2026-05-30", "Signed credit", "12.00"],
      ],
      errors: ["Row 4 has amounts in both money-in and money-out columns."],
    });

    const longRows = Array.from({ length: 100 }, (_, index) => [
      "2026-06-01",
      `${"\u0001".repeat(290)} #${String(index).padStart(3, "0")}`,
      "-1.00",
    ]);
    for (let start = 0; start < longRows.length; start += 25)
      expect(
        await stage("import-long-desc", start + 1, longRows.slice(start, start + 25)),
      ).toMatchObject({ added: 25 });
    const page1 = await f.result("listBankRows", { status: "new", limit: 100, offset: 0 });
    expect(page1.rows).toHaveLength(100);
    expect(page1.nextOffset).toBe(100);
    const page2 = await f.result("listBankRows", { status: "new", limit: 100, offset: 100 });
    expect(page2.rows).toHaveLength(5);
    expect(page2.nextOffset).toBeNull();
    await expect(f.call("listBankRows", { status: "new", limit: 101 })).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    await f.result("setBankRowsIgnored", {
      ids: [...page1.rows, ...page2.rows]
        .filter((row: any) => row.importId === "import-long-desc")
        .map((row: any) => row.id),
      ignored: true,
    });
    const coffee = fresh.rows.filter((row: any) => row.description === "Coffee Shop");
    expect(coffee.map((row: any) => row.lineNo).sort()).toEqual([1, 2]);
    const content = ["1000", "2026-05-01", "-450", "USD", "coffee shop"].join("\n");
    const base = createHash("sha256").update(content).digest("hex");
    expect(coffee.map((row: any) => row.rowHash).sort()).toEqual(
      [1, 2].map((n) => createHash("sha256").update(`${base}\n${n}`).digest("hex")).sort(),
    );
    const ledger = await f.result("postBankRows", {
      rows: fresh.rows.map((row: any) => ({
        id: row.id,
        accountId: row.amountCents > 0 ? "4000" : "6300",
      })),
    });
    expect(ledger.posted).toBe(5);
    await expect(
      f.call("postBankRows", { rows: [{ id: fresh.rows[0].id, accountId: "6300" }] }),
    ).rejects.toMatchObject(refusal("conflict"));
    const posted = await f.result("listBankRows", { status: "posted" });
    expect(posted.rows).toHaveLength(5);
    const fee = posted.rows.find((row: any) => row.amountCents === -1200);
    await f.result("reverseJournalEntry", { entryId: fee.journalEntryId });
    expect(
      (await f.result("listBankRows", { status: "new" })).rows.map((row: any) => row.id),
    ).toEqual([fee.id]);
    const cash = await f.result("accountLedger", {
      accountId: "1000",
      currency: "USD",
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(cash.closingBalanceCents).toBe(-450 * 2 + 125_000 - 120_000);
  });

  it("attaches PDF and image receipts and refuses other files", async () => {
    const f = await books();
    const posted = await f.result(
      "postJournalEntry",
      entry(
        "2026-06-01",
        [
          ["6200", 2_599, 0],
          ["2200", 0, 2_599],
        ],
        { receiptFileId: receiptPdf.fileId },
      ),
    );
    expect(await f.result("receiptAccess", { entryId: posted.id })).toEqual({
      fileId: receiptPdf.fileId,
    });
    const bare = await f.result(
      "postJournalEntry",
      entry("2026-06-02", [
        ["6200", 100, 0],
        ["2200", 0, 100],
      ]),
    );
    await expect(
      f.call("attachReceipt", { entryId: bare.id, fileId: receiptText.fileId }),
    ).rejects.toMatchObject(refusal("invalid_receipt"));
    expect(
      await f.result("attachReceipt", { entryId: bare.id, fileId: receiptPdf.fileId }),
    ).toEqual({
      entryId: bare.id,
      fileId: receiptPdf.fileId,
    });
    await expect(
      f.call("attachReceipt", { entryId: bare.id, fileId: receiptPdf.fileId }),
    ).rejects.toMatchObject(refusal("conflict"));
  });

  it("gives the accountant link read-only reports and nothing else", async () => {
    const f = await books();
    await f.result("postJournalEntries", {
      entries: [
        entry("2026-01-02", [
          ["1000", 500_000, 0],
          ["3000", 0, 500_000],
        ]),
        entry("2026-02-10", [
          ["1100", 80_000, 0],
          ["4000", 0, 80_000],
        ]),
        entry("2026-02-12", [
          ["6100", 4_900, 0],
          ["2200", 0, 4_900],
        ]),
        entry("2026-03-01", [
          ["1000", 80_000, 0],
          ["1100", 0, 80_000],
        ]),
      ],
    });
    const pnl = await f.result(
      "incomeStatement",
      { from: "2026-01-01", to: "2026-12-31", currency: "USD" },
      "accountant",
    );
    expect(pnl).toMatchObject({
      totalIncomeCents: 80_000,
      totalExpenseCents: 4_900,
      netIncomeCents: 75_100,
    });
    expect(pnl.months).toEqual([{ month: "2026-02", incomeCents: 80_000, expenseCents: 4_900 }]);
    const sheet = await f.result(
      "balanceSheet",
      { asOf: "2026-12-31", currency: "USD" },
      "accountant",
    );
    expect(sheet).toMatchObject({
      totalAssetsCents: 580_000,
      totalLiabilitiesCents: 4_900,
      earningsCents: 75_100,
      totalEquityCents: 575_100,
      balanced: true,
    });
    const ledger = await f.result(
      "accountLedger",
      { accountId: "1000", currency: "USD", from: "2026-02-01", to: "2026-12-31", limit: 1 },
      "accountant",
    );
    expect(ledger).toMatchObject({
      openingBalanceCents: 500_000,
      closingBalanceCents: 580_000,
      nextAfter: null,
    });
    expect(
      (await f.result("trialBalance", { asOf: "2026-02-28", currency: "USD" }, "accountant"))
        .balanced,
    ).toBe(true);
    await expect(
      f.call(
        "accountLedger",
        { accountId: "1000", currency: "USD", from: "2026-03-01", to: "2026-02-01" },
        "accountant",
      ),
    ).rejects.toMatchObject(refusal("invalid_input"));

    for (const name of [
      "postJournalEntry",
      "addFiscalYear",
      "lockPeriod",
      "stageBankRows",
      "keepDuplicateBankRow",
      "listEntries",
      "overview",
      "receiptAccess",
    ])
      await expect(f.call(name, {}, "accountant")).rejects.toThrow();
    await expect(
      f.call("trialBalance", { asOf: "2026-12-31" }, "stranger", null),
    ).rejects.toThrow();
    await expect(
      f.call(
        "postJournalEntry",
        entry("2026-02-01", [
          ["6000", 1, 0],
          ["1000", 0, 1],
        ]),
        "stranger",
        null,
      ),
    ).rejects.toThrow();
    expect(f.portal.operationIds).toHaveLength(5);
    expect(
      f.portal.operationIds.every((id) => {
        const declared = f.definition.operations.find((operation) => operation.operationId === id)!;
        return declared.readOnly && declared.access === "link";
      }),
    ).toBe(true);
    expect(
      f.definition.operations
        .filter((operation) => operation.access === "link")
        .every((operation) => operation.readOnly),
    ).toBe(true);
  });
});

describe("accounting schema without the operations", () => {
  function database() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(accountingFile("schema.sql"));
    db.exec(
      "INSERT INTO fiscal_periods(id,start_date,end_date) VALUES('2026-01','2026-01-01','2026-01-31')",
    );
    return db;
  }
  const post = (db: DatabaseSync, id: string, debit = 100, credit = 100, date = "2026-01-10") => {
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES(?,?,1,'6000',?,0)",
      ).run(`${id}-1`, id, debit);
      db.prepare(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES(?,?,2,'1000',0,?)",
      ).run(`${id}-2`, id, credit);
      db.prepare(
        "INSERT INTO journal_entries(id,number,entry_date,currency,memo,source,total_cents,created_at_ms) VALUES(?,?,?,'USD','',?,?,0)",
      ).run(id, Number(id.slice(1)), date, "manual", debit);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  it("refuses unbalanced, edited, deleted, appended, and locked-period postings in SQL", () => {
    const db = database();
    post(db, "e1");
    expect(() => post(db, "e2", 100, 99)).toThrow(/unbalanced/);
    expect(() => post(db, "e3", 100, 100, "2026-02-01")).toThrow(/period_closed/);
    expect(() => db.exec("UPDATE journal_lines SET debit_cents=200 WHERE id='e1-1'")).toThrow(
      /posted/,
    );
    expect(() => db.exec("DELETE FROM journal_lines WHERE id='e1-1'")).toThrow(/posted/);
    expect(() => db.exec("DELETE FROM journal_entries WHERE id='e1'")).toThrow(/posted/);
    expect(() => db.exec("UPDATE journal_entries SET memo='changed' WHERE id='e1'")).toThrow(
      /posted/,
    );
    expect(() =>
      db.exec(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES('e1-3','e1',3,'6000',1,0)",
      ),
    ).toThrow(/posted/);
    expect(() =>
      db.exec(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES('x','e9',1,'6000',1.5,0)",
      ),
    ).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE accounts SET type='income' WHERE id='6000'")).toThrow(
      /account_in_use/,
    );
    db.exec("UPDATE fiscal_periods SET status='locked' WHERE id='2026-01'");
    expect(() => db.exec("UPDATE fiscal_periods SET status='open' WHERE id='2026-01'")).toThrow(
      /period_locked/,
    );
    expect(() =>
      db.exec("UPDATE journal_entries SET receipt_file_id='late' WHERE id='e1'"),
    ).toThrow(/posted/);
    expect(() => post(db, "e4")).toThrow(/period_closed/);
    expect(
      db.prepare("SELECT sum(debit_cents) AS d,sum(credit_cents) AS c FROM journal_lines").get(),
    ).toEqual({ d: 100, c: 100 });
  });
});
