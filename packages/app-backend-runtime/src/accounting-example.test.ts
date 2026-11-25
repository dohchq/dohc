import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
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
async function books({ named = true } = {}) {
  const fixture = await accountingFixture();
  open.push(fixture);
  await fixture.result("addFiscalYear", { year: 2026 });
  if (named) await fixture.result("saveBusiness", { name: "Synthetic Books" });
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

const unreviewed = async (f: Fixture) => [
  ...(await f.result("listBankRows", { status: "new" })).rows,
  ...(await f.result("listBankRows", { status: "matched" })).rows,
];

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
    expect(
      await f.result("attachReceipt", { entryId: rent.id, fileId: receiptPdf.fileId }),
    ).toEqual({ entryId: rent.id, fileId: receiptPdf.fileId });
    expect((await f.result("listPeriods"))[0]).toMatchObject({
      id: "2026-01",
      status: "locked",
      entries: 2,
    });
  });

  it("issues, pays, reverses, and voids invoices atomically with their ledger entries", async () => {
    const f = await books({ named: false });
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
    ).rejects.toMatchObject(refusal("missing_business"));
    await expect(f.call("saveBusiness", { name: "  " })).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    await f.result("saveBusiness", { name: "Synthetic Studio", email: "hello@example.test" });
    await f.result("saveBusiness", { name: "Synthetic Studio LLC", address: "1 Main St" });
    expect(await f.result("getBusiness", {})).toEqual({
      name: "Synthetic Studio LLC",
      email: null,
      address: "1 Main St",
    });
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
    await f.result("saveBusiness", { name: "Renamed Studio" });
    await f.result("saveClient", {
      id: client.id,
      name: "Renamed Client",
      email: "new@example.test",
    });
    expect(await f.result("getInvoice", { id: draft.id })).toMatchObject({
      seller: { name: "Synthetic Studio LLC", email: null, address: "1 Main St" },
      clientName: "Synthetic Client Co",
      clientEmail: "billing@example.test",
      saleNumber: 1,
      payments: [],
    });
    expect((await f.result("listInvoices", { today: "2026-12-31" })).invoices[0].clientName).toBe(
      "Synthetic Client Co",
    );
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

    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        date: "2026-04-20",
        bankAccountId: "1000",
        amountCents: 202_970,
      }),
    ).rejects.toMatchObject(refusal("amount_mismatch"));
    const part = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: issued.version,
      date: "2026-04-10",
      bankAccountId: "1000",
      amountCents: 100_000,
    });
    expect(part).toMatchObject({ status: "issued", amountCents: 100_000, balanceCents: 102_969 });
    expect((await f.result("overview", { today: "2026-04-15" })).receivables).toMatchObject({
      open: 1,
      openCents: 102_969,
    });
    const paid = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: part.version,
      date: "2026-04-20",
      bankAccountId: "1000",
    });
    expect(paid).toMatchObject({ status: "paid", amountCents: 102_969, balanceCents: 0 });
    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: paid.version,
        date: "2026-04-21",
        bankAccountId: "1000",
      }),
    ).rejects.toMatchObject(refusal("conflict"));
    await expect(
      f.call("voidInvoice", { id: draft.id, expectedVersion: paid.version }),
    ).rejects.toMatchObject(refusal("conflict"));
    expect(await f.result("getInvoice", { id: draft.id })).toMatchObject({
      status: "paid",
      paidCents: 202_969,
      balanceCents: 0,
      paidOn: "2026-04-20",
      payments: [
        { entryId: part.paymentEntryId, number: 2, date: "2026-04-10", amountCents: 100_000 },
        { entryId: paid.paymentEntryId, number: 3, date: "2026-04-20", amountCents: 102_969 },
      ],
    });
    await expect(
      f.call("reverseJournalEntry", { entryId: part.paymentEntryId, date: "2026-04-09" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("reverseJournalEntry", { entryId: paid.paymentEntryId });
    expect(await f.result("getInvoice", { id: draft.id })).toMatchObject({
      status: "issued",
      paidCents: 100_000,
      balanceCents: 102_969,
      paidOn: null,
      payments: [{ entryId: part.paymentEntryId }],
    });
    await f.result("reverseJournalEntry", { entryId: part.paymentEntryId });
    const reopened = await f.result("getInvoice", { id: draft.id });
    expect(reopened).toMatchObject({
      status: "issued",
      paidCents: 0,
      payments: [],
      voidFrom: "2026-04-20",
    });
    await expect(
      f.call("voidInvoice", {
        id: draft.id,
        expectedVersion: reopened.version,
        date: "2026-04-12",
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const again = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: reopened.version,
      date: "2026-04-21",
      bankAccountId: "1000",
    });
    await f.result("reverseJournalEntry", { entryId: again.paymentEntryId, date: "2026-04-25" });
    const back = await f.result("getInvoice", { id: draft.id });
    expect(back).toMatchObject({ status: "issued", paidCents: 0, voidFrom: "2026-04-25" });
    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: back.version,
        date: "2026-04-22",
        bankAccountId: "1000",
      }),
    ).rejects.toMatchObject(refusal("amount_mismatch"));
    await expect(
      f.call("reverseJournalEntry", { entryId: issued.journalEntryId }),
    ).rejects.toMatchObject(refusal("use_invoice"));
    await expect(
      f.call("voidInvoice", {
        id: draft.id,
        expectedVersion: back.version,
        date: "2026-03-31",
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("lockPeriod", { periodId: "2026-04" });
    await expect(
      f.call("voidInvoice", { id: draft.id, expectedVersion: back.version }),
    ).rejects.toMatchObject(refusal("period_closed"));
    const voided = await f.result("voidInvoice", {
      id: draft.id,
      expectedVersion: back.version,
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
    expect(fresh.counts).toEqual({ new: 5, duplicate: 8, review: 5 });
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
        ["2026-05-30", "Too precise", "1.234", ""],
        ["2026-05-30", "Comma decimal", "12.34", "5,00"],
        ["2026-05-30", "Dash for none", "-", "8.00"],
      ],
      { date: 0, description: 1, amount: 2, credit: 3 },
      "ymd",
      2,
    );
    expect(splitMapped).toEqual({
      rows: [
        ["2026-05-30", "Signed debit", "-4.00"],
        ["2026-05-30", "Paren debit", "-5.50"],
        ["2026-05-30", "Signed credit", "12.00"],
        ["2026-05-30", "Dash for none", "8.00"],
      ],
      errors: [
        "Row 4 has amounts in both money-in and money-out columns.",
        "Row 5 has more than 2 decimals for this currency.",
        "Row 6 has an amount that can't be read: 5,00.",
      ],
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

  it("stores bank amounts in each currency's minor units", async () => {
    const f = await books();
    let imports = 0;
    const stage = (currency: string, rows: string[][]) =>
      f.result("stageBankRows", {
        importId: `import-${currency}-${++imports}`,
        bankAccountId: "1000",
        currency,
        firstLine: 1,
        rows,
      });
    await stage("JPY", [["2026-05-01", "Kissa", "-1,200"]]);
    await stage("KWD", [["2026-05-01", "Souq", "-1.234"]]);
    await stage("HUF", [["2026-05-01", "Piac", "-1,500"]]);
    await stage("IQD", [["2026-05-01", "Suq", "-2,000"]]);
    await stage("CLF", [["2026-05-01", "Arriendo", "-1.0000"]]);
    for (const [currency, amount] of [
      ["JPY", "-1.5"],
      ["USD", "-1.234"],
      ["KWD", "-1.2345"],
      ["HUF", "-1.50"],
      ["IQD", "-1.5"],
      ["CLF", "-1.00001"],
    ])
      await expect(stage(currency, [["2026-05-02", "Bad", amount!]])).rejects.toMatchObject(
        refusal("invalid_input"),
      );
    const rows = (await f.result("listBankRows", { status: "new" })).rows;
    expect(rows.map((row: any) => [row.currency, row.amountCents]).sort()).toEqual([
      ["CLF", -10_000],
      ["HUF", -1_500],
      ["IQD", -2_000],
      ["JPY", -1_200],
      ["KWD", -1_234],
    ]);
  });

  it("matches a deposit to an invoice only when the amount or the client name settles it", async () => {
    const f = await books();
    const invoice = async (name: string) => {
      const client = await f.result("saveClient", { name });
      const draft = await f.result("saveDraftInvoice", {
        clientId: client.id,
        issueDate: "2026-05-01",
        dueDate: "2026-05-31",
        currency: "USD",
        lines: [
          { description: "Design", quantity: 1, unitPriceCents: 90_000, revenueAccountId: "4000" },
        ],
      });
      await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
      return draft.id;
    };
    await invoice("Northwind Studio");
    const contoso = await invoice("Contoso");
    await f.result("stageBankRows", {
      importId: "import-deposits",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-06-02", "Client payment", "900.00"],
        ["2026-06-03", "ACH CONTOSO INV", "900.00"],
      ],
    });
    const rows = await unreviewed(f);
    const match = (description: string) =>
      rows.find((row: any) => row.description === description).match;
    expect(match("Client payment")).toBeNull();
    expect(match("ACH CONTOSO INV")).toMatchObject({ id: contoso, clientName: "Contoso" });

    await invoice("Contoso");
    await invoice("Fabrikam Foods");
    await f.result("stageBankRows", {
      importId: "import-deposits-2",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-06-04", "STRIPE TRANSFER FABRIKAM", "900.00"],
        ["2026-06-05", "Contoso wire", "900.00"],
        ["2026-04-30", "Fabrikam early", "900.00"],
      ],
    });
    const later = await unreviewed(f);
    const laterMatch = (description: string) =>
      later.find((row: any) => row.description === description).match;
    expect(laterMatch("STRIPE TRANSFER FABRIKAM")).toMatchObject({ clientName: "Fabrikam Foods" });
    expect(laterMatch("Contoso wire")).toBeNull();
    expect(laterMatch("Fabrikam early")).toBeNull();
  });

  it("matches a statement row to an entry already in the books without posting it twice", async () => {
    const f = await books();
    const client = await f.result("saveClient", { name: "Northwind Studio" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-05-01",
      dueDate: "2026-05-31",
      currency: "USD",
      lines: [
        { description: "Design", quantity: 1, unitPriceCents: 90_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        date: "2026-04-30",
        bankAccountId: "1000",
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const paid = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: issued.version,
      date: "2026-05-20",
      bankAccountId: "1000",
    });
    const split = await f.result(
      "postJournalEntry",
      entry("2026-05-24", [
        ["1000", 100_000, 0],
        ["1000", 0, 10_000],
        ["3000", 0, 90_000],
      ]),
    );
    await f.result("stageBankRows", {
      importId: "import-may-wire",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-05-22", "WIRE NORTHWIND", "900.00"],
        ["2026-06-30", "WIRE NORTHWIND", "900.00"],
      ],
    });
    const fresh = await unreviewed(f);
    const near = fresh.find((row: any) => row.date === "2026-05-22");
    const far = fresh.find((row: any) => row.date === "2026-06-30");
    expect(
      near.candidates.map((candidate: any) => [candidate.id, candidate.number, candidate.sure]),
    ).toEqual([
      [paid.paymentEntryId, 2, true],
      [split.id, 3, false],
    ]);
    expect(near.match).toBeNull();
    expect(far.candidates).toEqual([]);
    expect(
      (await f.result("listBankRows", { status: "matched" })).rows.map((row: any) => row.id),
    ).toEqual([near.id]);
    expect(
      (await f.result("findBankMatches", { id: far.id })).entries.map((item: any) => item.number),
    ).toEqual([3, 2]);
    expect(
      await f.result("linkBankRow", { id: near.id, entryId: paid.paymentEntryId }),
    ).toMatchObject({
      entryId: paid.paymentEntryId,
    });
    await expect(
      f.call("linkBankRow", { id: far.id, entryId: paid.paymentEntryId }),
    ).rejects.toMatchObject(refusal("conflict"));
    expect(
      (await f.result("findBankMatches", { id: far.id })).entries.map((item: any) => item.number),
    ).toEqual([3]);
    await f.result("stageBankRows", {
      importId: "import-sep-wire",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-09-30", "WIRE NORTHWIND", "900.00"]],
    });
    const late = (await unreviewed(f)).find((row: any) => row.date === "2026-09-30");
    expect((await f.result("findBankMatches", { id: late.id })).entries).toEqual([]);
    await expect(f.call("linkBankRow", { id: late.id, entryId: split.id })).rejects.toMatchObject(
      refusal("conflict"),
    );
    await f.result("setBankRowsIgnored", { ids: [late.id], ignored: true });
    await expect(
      f.call("linkBankRow", { id: near.id, entryId: paid.paymentEntryId }),
    ).rejects.toMatchObject(refusal("conflict"));
    const cash = async () =>
      (
        await f.result("accountLedger", {
          accountId: "1000",
          currency: "USD",
          from: "2026-01-01",
          to: "2026-12-31",
        })
      ).closingBalanceCents;
    expect(await cash()).toBe(180_000);
    expect((await f.result("listBankRows", { status: "posted" })).rows[0]).toMatchObject({
      id: near.id,
      linked: true,
    });
    expect((await f.result("getEntry", { id: paid.paymentEntryId })).bankRow).toMatchObject({
      id: near.id,
      linked: true,
    });
    expect((await f.result("listBankRows", { status: "new" })).rows[0].candidates).toEqual([]);
    await f.result("unlinkBankRow", { id: near.id });
    await expect(f.call("unlinkBankRow", { id: near.id })).rejects.toMatchObject(
      refusal("conflict"),
    );
    await f.result("linkBankRow", { id: near.id, entryId: paid.paymentEntryId });
    await f.result("reverseJournalEntry", { entryId: paid.paymentEntryId });
    expect((await unreviewed(f)).map((row: any) => row.id).sort()).toEqual(
      [near.id, far.id].sort(),
    );
    expect(await cash()).toBe(90_000);
    expect(await f.result("linkBankRow", { id: near.id, entryId: split.id })).toMatchObject({
      entryId: split.id,
      number: 3,
    });
  });

  it("closes earnings at the fiscal year start, not in December", async () => {
    const f = await accountingFixture();
    open.push(f);
    await f.result("addFiscalYear", { year: 2026, startMonth: 7 });
    await expect(f.call("addFiscalYear", { year: 2027, startMonth: 1 })).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    await expect(f.call("addFiscalYear", { year: 2029 })).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    const next = await f.result("addFiscalYear", { year: 2027 });
    expect(next.periods[0]).toMatchObject({ id: "2026-07", startDate: "2026-07-01" });
    await f.result(
      "postJournalEntry",
      entry("2026-03-10", [
        ["1000", 40_000, 0],
        ["4000", 0, 40_000],
      ]),
    );
    await f.result(
      "postJournalEntry",
      entry("2026-08-10", [
        ["1000", 15_000, 0],
        ["4000", 0, 15_000],
      ]),
    );
    expect(await f.result("balanceSheet", { asOf: "2026-09-30" })).toMatchObject({
      yearStart: "2026-07-01",
      retainedEarningsCents: 40_000,
      earningsCents: 15_000,
      balanced: true,
    });
    expect((await f.result("overview", { today: "2026-09-30" })).yearToDate.incomeCents).toBe(
      15_000,
    );
    expect((await f.result("booksInfo", {})).fiscalStartMonth).toBe(7);
  });

  it("keeps a row posted when a later reversal would count it twice, and needs the other account named for a transfer", async () => {
    const f = await books();
    await f.result("stageBankRows", {
      importId: "import-late",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-05-02", "BLUE BOTTLE COFFEE", "-12.00"],
        ["2026-05-03", "STAPLES", "-30.00"],
      ],
    });
    const staged = (await f.result("listBankRows", { status: "new" })).rows;
    const posted = await f.result("postBankRows", {
      rows: staged.map((row: any) => ({ id: row.id, accountId: "6500" })),
    });
    const entryFor = async (description: string) =>
      (await f.result("listBankRows", { status: "posted" })).rows.find(
        (row: any) => row.description === description,
      )?.journalEntryId;
    expect(posted).toBeTruthy();
    await f.result("reverseJournalEntry", {
      entryId: await entryFor("BLUE BOTTLE COFFEE"),
      date: "2026-05-10",
    });
    await f.result("reverseJournalEntry", { entryId: await entryFor("STAPLES") });
    expect(
      (await f.result("listBankRows", { status: "posted" })).rows.map(
        (row: any) => row.description,
      ),
    ).toEqual(["BLUE BOTTLE COFFEE"]);
    expect(
      (await f.result("listBankRows", { status: "new" })).rows.map((row: any) => row.description),
    ).toEqual(["STAPLES"]);

    const client = await f.result("saveClient", { name: "Northwind" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-05-01",
      dueDate: "2026-05-31",
      currency: "USD",
      lines: [
        { description: "Design", quantity: 1, unitPriceCents: 10_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    const sweep = await f.result(
      "postJournalEntry",
      entry(
        "2026-05-05",
        [
          ["1000", 10_000, 0],
          ["1010", 0, 10_000],
        ],
        { memo: "Savings sweep" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-sweep",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-05-05", "NORTHWIND ACH", "100.00"]],
    });
    const deposit = (await f.result("listBankRows", { status: "matched" })).rows[0];
    expect(deposit).toMatchObject({ description: "NORTHWIND ACH", match: { id: draft.id } });
    expect(deposit.candidates).toEqual([expect.objectContaining({ id: sweep.id, sure: false })]);
    const payment = { id: draft.id, expectedVersion: issued.version, bankRowId: deposit.id };
    await expect(f.call("recordPayment", payment)).rejects.toMatchObject(
      refusal("already_in_books"),
    );
    await f.result("recordPayment", { ...payment, notMatched: [sweep.id] });
  });

  it("refuses future dates, keeps closed-month rows as they are, and never posts a known entry twice", async () => {
    const f = await books();
    await f.result("addFiscalYear", { year: 2027 });
    await expect(
      f.call(
        "postJournalEntry",
        entry("2027-12-30", [
          ["6000", 100, 0],
          ["1000", 0, 100],
        ]),
      ),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await expect(
      f.call("stageBankRows", {
        importId: "import-future",
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [["2999-01-01", "FUTURE", "-1.00"]],
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));

    const adobe = await f.result(
      "postJournalEntry",
      entry(
        "2026-01-10",
        [
          ["6500", 2_000, 0],
          ["1000", 0, 2_000],
        ],
        { memo: "Adobe" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-january",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-01-10", "ADOBE", "-20.00"],
        ["2026-01-12", "BANK FEE", "-3.00"],
      ],
    });
    const january = await unreviewed(f);
    const known = january.find((row: any) => row.description === "ADOBE");
    const fee = january.find((row: any) => row.description === "BANK FEE");
    expect(known.candidates).toEqual([expect.objectContaining({ id: adobe.id, sure: true })]);
    await expect(
      f.call("postBankRows", { rows: [{ id: known.id, accountId: "6500" }] }),
    ).rejects.toMatchObject(refusal("already_in_books"));
    await expect(f.call("updateAccount", { id: "6500", archived: true })).rejects.toMatchObject(
      refusal("account_in_use"),
    );
    await f.result("linkBankRow", { id: known.id, entryId: adobe.id });
    await f.result("setBankRowsIgnored", { ids: [fee.id], ignored: true });
    await f.result("lockPeriod", { periodId: "2026-01" });
    await expect(f.call("addFiscalYear", { year: 2025 })).rejects.toMatchObject(
      refusal("period_closed"),
    );
    await expect(f.call("unlinkBankRow", { id: known.id })).rejects.toMatchObject(
      refusal("period_closed"),
    );
    await expect(
      f.call("setBankRowsIgnored", { ids: [fee.id], ignored: false }),
    ).rejects.toMatchObject(refusal("period_closed"));
    expect(
      await f.result("stageBankRows", {
        importId: "import-late-january",
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [["2026-01-20", "LATE FEE", "-5.00"]],
      }),
    ).toMatchObject({ added: 0, closed: 1 });
    expect(
      (await f.result("listBankRows", { status: "ignored" })).rows.map(
        (row: any) => row.description,
      ),
    ).toContain("LATE FEE");

    const staples = await f.result(
      "postJournalEntry",
      entry(
        "2026-03-02",
        [
          ["6500", 4_000, 0],
          ["1000", 0, 4_000],
        ],
        { memo: "Staples" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-march",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-03-02", "STAPLES", "-40.00"],
        ["2026-03-04", "TAILSPIN WIRE", "150.00"],
      ],
    });
    const march = await unreviewed(f);
    const office = march.find((row: any) => row.description === "STAPLES");
    await f.result("postBankRows", {
      rows: [
        {
          id: office.id,
          accountId: "6500",
          notMatched: office.candidates.map((candidate: any) => candidate.id),
        },
      ],
    });
    expect(
      (await f.result("listBankRows", { status: "posted" })).rows.map(
        (row: any) => row.description,
      ),
    ).toContain("STAPLES");
    await f.result("stageBankRows", {
      importId: "import-staples",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-03", "STAPLES CHECK", "-40.00"]],
    });
    const check = (await unreviewed(f)).find((row: any) => row.description === "STAPLES CHECK");
    await f.result("linkBankRow", { id: check.id, entryId: staples.id });
    await f.result("reverseJournalEntry", { entryId: staples.id, date: "2026-03-20" });
    const reversed = (await f.result("listBankRows", { status: "posted" })).rows.find(
      (row: any) => row.description === "STAPLES CHECK",
    );
    expect(reversed.reversedByNumber).toBeTruthy();
    await expect(f.call("unlinkBankRow", { id: reversed.id })).rejects.toMatchObject(
      refusal("reversed"),
    );

    const client = await f.result("saveClient", { name: "Tailspin" });
    const issue = async () => {
      const draft = await f.result("saveDraftInvoice", {
        clientId: client.id,
        issueDate: "2026-02-20",
        dueDate: "2026-03-20",
        currency: "USD",
        lines: [
          {
            description: "Retainer",
            quantity: 1,
            unitPriceCents: 15_000,
            revenueAccountId: "4000",
          },
        ],
      });
      await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
      return draft.id;
    };
    const ids = [await issue(), await issue()];
    const wire = (await unreviewed(f)).find((row: any) => row.description === "TAILSPIN WIRE");
    expect(wire.match).toBeNull();
    expect(wire.payables.map((item: any) => item.id).sort()).toEqual([...ids].sort());
  });

  it("refuses to post both statements of one transfer as new money in one batch", async () => {
    const f = await books();
    for (const [importId, bankAccountId, description, amount] of [
      ["import-out", "1000", "TRANSFER", "-200.00"],
      ["import-in", "1010", "TRANSFER", "200.00"],
    ])
      await f.result("stageBankRows", {
        importId,
        bankAccountId,
        currency: "USD",
        firstLine: 1,
        rows: [["2026-04-02", description, amount]],
      });
    const rows = (await f.result("listBankRows", { status: "new" })).rows;
    const side = (bank: string) => rows.find((row: any) => row.bankAccountId === bank).id;
    const both = {
      rows: [
        { id: side("1000"), accountId: "1010" },
        { id: side("1010"), accountId: "1000" },
      ],
    };
    await expect(f.call("postBankRows", both)).rejects.toMatchObject(refusal("already_in_books"));
    expect((await f.result("listBankRows", { status: "new" })).rows).toHaveLength(2);
    await f.result("postBankRows", { rows: [both.rows[0]] });
    const savings = (await unreviewed(f)).find((row: any) => row.bankAccountId === "1010");
    expect(savings.candidates).toEqual([expect.objectContaining({ sure: false })]);
    await expect(f.call("postBankRows", { rows: [both.rows[1]] })).rejects.toMatchObject(
      refusal("already_in_books"),
    );
    await f.result("postBankRows", {
      rows: [
        {
          ...both.rows[1],
          notMatched: savings.candidates.map((candidate: any) => candidate.id),
        },
      ],
    });
  });

  it("asks again about an entry that appears after review, and holds a re-export with a new description", async () => {
    const f = await books();
    const stage = (importId: string, row: string[]) =>
      f.result("stageBankRows", {
        importId,
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [row],
      });
    await stage("import-card-1", ["2026-04-10", "PAYEE PURCHASE", "-12.34"]);
    const first = (await unreviewed(f)).find((row: any) => row.description === "PAYEE PURCHASE");
    await f.result("postBankRows", { rows: [{ id: first.id, accountId: "6500" }] });
    expect(
      await f.result("stageBankRows", {
        importId: "import-card-2",
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [
          ["2026-04-10", "PAYEE PURCHASE CARD", "-12.34"],
          ["2026-04-10", "PAYEE PURCHASE 2", "-12.34"],
        ],
      }),
    ).toMatchObject({ added: 1, duplicates: 1 });
    const [again] = (await f.result("listBankRows", { status: "duplicate" })).rows;
    expect(again.original).toMatchObject({
      description: "PAYEE PURCHASE",
      status: "posted",
      journalNumber: expect.any(Number),
    });
    const batch = (importId: string, firstLine: number, rows: string[][]) =>
      f.result("stageBankRows", {
        importId,
        bankAccountId: "1000",
        currency: "USD",
        firstLine,
        rows,
      });
    await batch("import-lunch-1", 1, [
      ["2026-04-11", "LUNCH", "-9.00"],
      ["2026-04-12", "LUNCH", "-9.00"],
      ["2026-04-13", "LUNCH", "-9.00"],
    ]);
    expect(
      await batch("import-lunch-2", 1, [
        ["2026-04-11", "LUNCH SPOT", "-9.00"],
        ["2026-04-11", "LUNCH", "-9.00"],
      ]),
    ).toMatchObject({ added: 1, duplicates: 1 });
    expect(await batch("import-lunch-3", 1, [["2026-04-12", "LUNCH SPOT", "-9.00"]])).toMatchObject(
      { added: 0, duplicates: 1 },
    );
    expect(await batch("import-lunch-3", 2, [["2026-04-12", "LUNCH", "-9.00"]])).toMatchObject({
      added: 1,
      duplicates: 0,
    });
    expect(await batch("import-lunch-4", 1, [["2026-04-13", "LUNCH", "-9.00"]])).toMatchObject({
      added: 0,
      duplicates: 1,
    });
    expect(await batch("import-lunch-4", 2, [["2026-04-13", "LUNCH SPOT", "-9.00"]])).toMatchObject(
      { added: 1, duplicates: 0 },
    );
    await batch("import-cafe-0", 1, [["2026-01-04", "CAFE", "-5.00"]]);
    const [cafe] = (await f.result("listBankRows", { limit: 100 })).rows.filter(
      (row: any) => row.importId === "import-cafe-0",
    );
    await f.result("setBankRowsIgnored", { ids: [cafe.id], ignored: true });
    expect(await batch("import-cafe-00", 1, [["2026-01-04", "CAFE", "-5.00"]])).toMatchObject({
      duplicates: 1,
    });
    const twice = (await f.result("listBankRows", { status: "duplicate", limit: 100 })).rows.find(
      (row: any) => row.importId === "import-cafe-00",
    );
    expect(twice).toMatchObject({ importId: "import-cafe-00", confirmed: false, closed: false });
    await expect(f.call("lockPeriod", { periodId: "2026-01" })).rejects.toMatchObject({
      refusal: { code: "unreviewed", message: expect.stringContaining("1 possible duplicate") },
    });
    expect(
      (await f.result("listPeriods", {})).find((row: any) => row.id === "2026-01"),
    ).toMatchObject({ waiting: 0, duplicates: 1 });
    const duplicatesBefore = (await f.result("overview", { today: "2026-04-30" }))
      .duplicateBankRows;
    expect(
      await f.result("confirmDuplicateBankRow", { id: twice.id, confirmed: true }),
    ).toMatchObject({ confirmed: true });
    expect((await f.result("overview", { today: "2026-04-30" })).duplicateBankRows).toBe(
      duplicatesBefore - 1,
    );
    const confirmedPage = await f.result("listBankRows", { status: "duplicate", limit: 100 });
    expect(confirmedPage.counts.confirmed).toBe(1);
    expect(confirmedPage.rows.find((row: any) => row.id === twice.id)).toMatchObject({
      confirmed: true,
    });
    await f.result("lockPeriod", { periodId: "2026-01" });
    await expect(f.call("keepDuplicateBankRow", { id: twice.id })).rejects.toMatchObject(
      refusal("period_closed"),
    );
    await expect(
      f.call("confirmDuplicateBankRow", { id: twice.id, confirmed: false }),
    ).rejects.toMatchObject(refusal("period_closed"));
    expect(
      (await f.result("listBankRows", { status: "duplicate", limit: 100 })).rows.find(
        (row: any) => row.id === twice.id,
      ),
    ).toMatchObject({ confirmed: true, closed: true });
    await f.result("confirmDuplicateBankRow", { id: twice.id, confirmed: true });
    await expect(
      f.call("confirmDuplicateBankRow", { id: cafe.id, confirmed: true }),
    ).rejects.toMatchObject(refusal("conflict"));
    await expect(
      f.call("confirmDuplicateBankRow", { id: twice.id, confirmed: "yes" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    expect(
      await batch("import-cafe-1", 1, [
        ["2026-01-05", "CAFE", "-5.00"],
        ["2026-01-06", "CAFE", "-5.00"],
      ]),
    ).toMatchObject({ added: 0, closed: 2 });
    expect(await batch("import-cafe-2", 1, [["2026-01-05", "CAFE BAR", "-5.00"]])).toMatchObject({
      added: 0,
      duplicates: 1,
      closed: 0,
    });
    expect(await batch("import-cafe-2", 2, [["2026-01-05", "CAFE", "-5.00"]])).toMatchObject({
      added: 0,
      duplicates: 0,
      closed: 1,
    });
    expect(
      await batch("import-cafe-3", 1, [
        ["2026-01-06", "CAFE BAR", "-5.00"],
        ["2026-01-06", "CAFE", "-5.00"],
      ]),
    ).toMatchObject({ added: 0, duplicates: 1, closed: 1 });
    expect(
      (await f.result("listBankRows", { status: "ignored", limit: 100 })).rows
        .filter((row: any) => row.description === "CAFE BAR")
        .map((row: any) => row.importId)
        .sort(),
    ).toEqual(["import-cafe-2", "import-cafe-3"]);
    const lunches = (await f.result("listBankRows", { limit: 100 })).rows
      .filter(
        (row: any) => row.description.startsWith("LUNCH") && row.importId !== "import-lunch-1",
      )
      .map((row: any) => `${row.importId} ${row.date} ${row.description}`)
      .sort();
    expect(lunches).toEqual([
      "import-lunch-2 2026-04-11 LUNCH SPOT",
      "import-lunch-3 2026-04-12 LUNCH SPOT",
      "import-lunch-4 2026-04-13 LUNCH SPOT",
    ]);

    await stage("import-card-3", ["2026-04-20", "HARDWARE", "-75.00"]);
    await f.result(
      "postJournalEntry",
      entry("2026-04-18", [
        ["6500", 7500, 0],
        ["1000", 0, 7500],
      ]),
    );
    const hardware = (await unreviewed(f)).find((row: any) => row.description === "HARDWARE");
    const seen = hardware.candidates.map((candidate: any) => candidate.id);
    expect(seen).toHaveLength(1);
    const later = await f.result(
      "postJournalEntry",
      entry("2026-04-19", [
        ["6500", 7500, 0],
        ["1000", 0, 7500],
      ]),
    );
    const pick = { id: hardware.id, accountId: "6500" };
    await expect(
      f.call("postBankRows", { rows: [{ ...pick, notMatched: seen }] }),
    ).rejects.toMatchObject(refusal("already_in_books"));
    await expect(
      f.call("postBankRows", { rows: [{ ...pick, notMatched: "all" }] }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("postBankRows", { rows: [{ ...pick, notMatched: [...seen, later.id] }] });
  });

  it("closes only months that have ended", async () => {
    const f = await accountingFixture();
    open.push(f);
    const month = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 7);
    await f.result("addFiscalYear", { year: Number(month.slice(0, 4)) });
    for (let at = 1; at < Number(month.slice(5)); at += 1)
      await f.result("lockPeriod", {
        periodId: `${month.slice(0, 4)}-${String(at).padStart(2, "0")}`,
      });
    await expect(f.call("lockPeriod", { periodId: month })).rejects.toMatchObject(
      refusal("period_in_progress"),
    );
  });

  it("matches both statements of a transfer between two bank accounts", async () => {
    const f = await books();
    const transfer = await f.result(
      "postJournalEntry",
      entry(
        "2026-04-02",
        [
          ["1010", 10_000, 0],
          ["1000", 0, 10_000],
        ],
        { memo: "Transfer to savings" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-checking",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-04-02", "Transfer to savings", "-100.00"]],
    });
    await f.result("stageBankRows", {
      importId: "import-savings",
      bankAccountId: "1010",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-04-03", "Transfer from checking", "100.00"]],
    });
    const rows = (await f.result("listBankRows", { status: "matched" })).rows;
    expect(rows.map((row: any) => row.candidates.map((candidate: any) => candidate.id))).toEqual([
      [transfer.id],
      [transfer.id],
    ]);
    for (const row of rows) await f.result("linkBankRow", { id: row.id, entryId: transfer.id });
    expect((await f.result("listBankRows", { status: "posted" })).rows).toHaveLength(2);
    const cash = (await f.result("overview", { today: "2026-04-30" })).cash;
    expect(cash.map((account: any) => [account.id, account.balanceCents])).toEqual([
      ["1000", -10_000],
      ["1010", 10_000],
    ]);
  });

  it("keeps amount-and-date matches as suggestions and never pays an invoice from a row already in the books", async () => {
    const f = await books();
    const ticket = await f.result(
      "postJournalEntry",
      entry(
        "2026-05-02",
        [
          ["6500", 4_500, 0],
          ["1000", 0, 4_500],
        ],
        { memo: "Train ticket" },
      ),
    );
    const client = await f.result("saveClient", { name: "Contoso" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-05-01",
      dueDate: "2026-05-31",
      currency: "USD",
      lines: [
        { description: "Design", quantity: 1, unitPriceCents: 90_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    const deposit = await f.result(
      "postJournalEntry",
      entry(
        "2026-05-03",
        [
          ["1000", 90_000, 0],
          ["4000", 0, 90_000],
        ],
        { memo: "Contoso deposit" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-suggestions",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-05-03", "COMCAST INTERNET", "-45.00"],
        ["2026-05-04", "CONTOSO ACH", "900.00"],
      ],
    });
    const review = (await f.result("listBankRows", { status: "new" })).rows;
    expect(review.map((row: any) => row.description)).toEqual(["COMCAST INTERNET"]);
    expect(review[0].candidates).toEqual([expect.objectContaining({ id: ticket.id, sure: false })]);
    const matched = await f.result("listBankRows", { status: "matched" });
    expect(matched.rows.map((row: any) => row.description)).toEqual(["CONTOSO ACH"]);
    expect(matched.rows[0].candidates).toEqual([
      expect.objectContaining({ id: deposit.id, sure: true }),
    ]);
    expect(matched.rows[0].match).toBeNull();
    expect(matched).toMatchObject({ matched: 1, counts: { new: 2, review: 1 } });
    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        bankRowId: matched.rows[0].id,
      }),
    ).rejects.toMatchObject(refusal("already_in_books"));
    const overdue = async (today: string) =>
      (await f.result("listInvoices", { status: "overdue", today })).invoices.map(
        (row: any) => row.id,
      );
    expect(await overdue("2026-06-15")).toEqual([draft.id]);
    expect(await overdue("2026-05-15")).toEqual([]);
    expect((await f.result("overview", { today: "2026-04-30" })).receivables.openCents).toBe(0);
  });

  it("pays an invoice only from a row naming its client, posts any extra, and dates every change today or earlier", async () => {
    const f = await books();
    const client = await f.result("saveClient", { name: "Northwind" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-05-01",
      dueDate: "2026-05-31",
      currency: "USD",
      lines: [
        { description: "Design", quantity: 1, unitPriceCents: 520_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    const ticket = await f.result(
      "postJournalEntry",
      entry(
        "2026-05-02",
        [
          ["6500", 4_500, 0],
          ["1000", 0, 4_500],
        ],
        { memo: "POS Train ticket" },
      ),
    );
    await f.result("stageBankRows", {
      importId: "import-names",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-05-03", "POS COMCAST", "-45.00"],
        ["2026-05-04", "IRS TREAS REFUND", "5200.00"],
        ["2026-05-05", "NORTHWIND ACH", "5700.00"],
      ],
    });
    const rows = (await f.result("listBankRows", { status: "new" })).rows;
    const row = (description: string) => rows.find((item: any) => item.description === description);
    expect(rows).toHaveLength(3);
    expect(row("POS COMCAST").candidates).toEqual([
      expect.objectContaining({ id: ticket.id, sure: false }),
    ]);
    for (const description of ["IRS TREAS REFUND", "NORTHWIND ACH"]) {
      expect(row(description).match).toBeNull();
      expect(row(description).payables.map((item: any) => item.id)).toEqual([draft.id]);
    }
    const over = row("NORTHWIND ACH");
    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        bankRowId: over.id,
      }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const paid = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: issued.version,
      bankRowId: over.id,
      restAccountId: "4000",
    });
    expect(paid).toMatchObject({
      status: "paid",
      amountCents: 520_000,
      restCents: 50_000,
      balanceCents: 0,
    });
    const payment = await f.result("getEntry", { id: paid.paymentEntryId });
    expect(
      payment.lines.map((line: any) => [line.accountId, line.debitCents, line.creditCents]),
    ).toEqual([
      ["1000", 570_000, 0],
      ["1100", 0, 520_000],
      ["4000", 0, 50_000],
    ]);
    await expect(
      f.call("reverseJournalEntry", { entryId: ticket.id, date: "2999-01-01" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("reverseJournalEntry", { entryId: paid.paymentEntryId, date: "2026-06-02" });
    expect((await f.result("overview", { today: "2026-05-31" })).receivables.openCents).toBe(0);
    expect((await f.result("overview", { today: "2026-06-02" })).receivables).toMatchObject({
      open: 1,
      openCents: 520_000,
      overdue: 1,
    });
    for (const periodId of ["2026-01", "2026-02", "2026-03", "2026-04"])
      await f.result("lockPeriod", { periodId });
    await expect(f.call("lockPeriod", { periodId: "2026-05" })).rejects.toMatchObject(
      refusal("unreviewed"),
    );
    expect(
      (await f.result("listPeriods", {})).find((period: any) => period.id === "2026-05").waiting,
    ).toBe(2);
    await f.result("stageBankRows", {
      importId: "import-euro",
      bankAccountId: "1010",
      currency: "EUR",
      firstLine: 1,
      rows: [["2026-05-06", "Wise", "10.00"]],
    });
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1010", date: "2026-05-31" }),
    ).toMatchObject({ currency: "EUR", currencies: ["EUR"], waiting: 1 });
    await expect(
      f.call("reconcileStatus", { bankAccountId: "1010", date: "2026-05-31", currency: "USD" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await expect(
      f.call("reconcileBank", { bankAccountId: "1000", date: "2999-01-01", balanceCents: 0 }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    expect((await f.result("listEntries", { accountId: "1010" })).account).toMatchObject({
      currency: "EUR",
      currencies: ["EUR"],
    });
  });

  it("applies a partial deposit to the open invoice it names", async () => {
    const f = await books();
    const client = await f.result("saveClient", { name: "Contoso Health" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-04-01",
      dueDate: "2026-04-30",
      currency: "USD",
      lines: [
        { description: "Audit", quantity: 1, unitPriceCents: 570_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    await f.result("stageBankRows", {
      importId: "import-partial",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-04-10", "STRIPE TRANSFER CONTOSO", "500.00"],
        ["2026-04-11", "Unknown deposit", "3000.00"],
        ["2026-04-12", "Too large", "6000.00"],
        ["2026-04-13", "INTEREST PAYMENT", "3.12"],
      ],
    });
    const rows = await unreviewed(f);
    const row = (description: string) => rows.find((item: any) => item.description === description);
    expect(row("STRIPE TRANSFER CONTOSO").match).toMatchObject({
      id: draft.id,
      balanceCents: 570_000,
    });
    expect(row("Unknown deposit").match).toBeNull();
    expect(row("Unknown deposit").payables.map((item: any) => item.id)).toEqual([draft.id]);
    expect(row("Too large").payables).toEqual([]);
    expect(row("INTEREST PAYMENT").payables).toEqual([]);
    expect(
      await f.result("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        bankRowId: row("STRIPE TRANSFER CONTOSO").id,
      }),
    ).toMatchObject({ amountCents: 50_000, balanceCents: 520_000, status: "issued" });
  });

  it("saves a draft with its client and business in one step and keeps invoice dates in the past", async () => {
    const f = await books();
    const line = {
      description: "Audit",
      quantity: 1,
      unitPriceCents: 10_000,
      revenueAccountId: "4000",
    };
    const draft = {
      business: { name: "Renamed Books" },
      client: { name: "Fresh Client", email: "fresh@example.com" },
      issueDate: "2026-04-01",
      dueDate: "2026-04-30",
      currency: "USD",
      lines: [line],
    };
    await expect(
      f.call("saveDraftInvoice", { ...draft, lines: [{ ...line, revenueAccountId: "6000" }] }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    expect(await f.result("listClients", {})).toEqual([]);
    expect((await f.result("getBusiness", {})).name).toBe("Synthetic Books");
    const saved = await f.result("saveDraftInvoice", draft);
    expect(await f.result("listClients", {})).toMatchObject([
      { name: "Fresh Client", email: "fresh@example.com" },
    ]);
    expect((await f.result("getInvoice", { id: saved.id })).seller.name).toBe("Renamed Books");
    const later = await f.result("saveDraftInvoice", {
      id: saved.id,
      expectedVersion: saved.version,
      clientId: (await f.result("listClients", {}))[0].id,
      issueDate: "2990-01-01",
      dueDate: "2990-01-31",
      currency: "USD",
      lines: [line],
    });
    await expect(
      f.call("issueInvoice", { id: saved.id, expectedVersion: later.version }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const now = await f.result("saveDraftInvoice", {
      id: saved.id,
      expectedVersion: later.version,
      clientId: (await f.result("listClients", {}))[0].id,
      issueDate: "2026-04-01",
      dueDate: "2026-04-30",
      currency: "USD",
      lines: [line],
    });
    const issued = await f.result("issueInvoice", { id: saved.id, expectedVersion: now.version });
    const payment = { id: saved.id, expectedVersion: issued.version, bankAccountId: "1000" };
    await expect(f.call("recordPayment", { ...payment, date: "2990-01-01" })).rejects.toMatchObject(
      refusal("invalid_input"),
    );
    await expect(
      f.call("voidInvoice", { id: saved.id, expectedVersion: issued.version, date: "2990-01-01" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const paid = await f.result("recordPayment", { ...payment, date: "2026-04-05" });
    await expect(
      f.call("reverseJournalEntry", { entryId: paid.paymentEntryId, date: "2990-01-01" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
  });

  it("reconciles a bank account only when every row is reviewed and the books match the statement", async () => {
    const f = await books();
    const deposit = await f.result(
      "postJournalEntry",
      entry("2026-03-01", [
        ["1000", 50_000, 0],
        ["3000", 0, 50_000],
      ]),
    );
    await f.result("stageBankRows", {
      importId: "import-march",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-02", "Deposit", "500.00"]],
    });
    const statement = {
      bankAccountId: "1000",
      date: "2026-03-31",
      currency: "USD",
      balanceCents: 50_000,
    };
    await expect(f.call("reconcileBank", statement)).rejects.toMatchObject(refusal("unreviewed"));
    expect(
      await f.result("reconcileStatus", {
        bankAccountId: "1000",
        date: "2026-03-31",
        currency: "USD",
      }),
    ).toMatchObject({
      waiting: 1,
      firstWaiting: "2026-03-02",
      booksCents: 50_000,
      reconciledCents: null,
    });
    const [row] = await unreviewed(f);
    await f.result("linkBankRow", { id: row.id, entryId: deposit.id });
    await expect(
      f.call("reconcileBank", { ...statement, balanceCents: 49_999 }),
    ).rejects.toMatchObject(refusal("not_reconciled"));
    await expect(
      f.call("reconcileBank", { ...statement, bankAccountId: "6000" }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    const done = await f.result("reconcileBank", statement);
    await expect(f.call("reconcileBank", statement)).rejects.toMatchObject(
      refusal("already_reconciled"),
    );
    expect((await f.result("listBankRows", {})).reconciled).toEqual([
      {
        id: done.id,
        bankAccountId: "1000",
        accountName: "Checking account",
        currency: "USD",
        date: "2026-03-31",
        balanceCents: 50_000,
        waiting: 0,
        holds: true,
      },
    ]);
    await f.result("stageBankRows", {
      importId: "import-march-late",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-20", "Late fee", "-1.00"]],
    });
    expect((await f.result("listBankRows", {})).reconciled[0]).toMatchObject({
      waiting: 1,
      holds: false,
    });
    const [late] = (await f.result("listBankRows", { status: "new" })).rows;
    await f.result("setBankRowsIgnored", { ids: [late.id] });
    expect((await f.result("listBankRows", {})).reconciled[0].holds).toBe(true);
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-03-31" }),
    ).toMatchObject({ currencies: ["USD"], reconciliationId: done.id, reconciledCents: 50_000 });
    const holds = async () => (await f.result("listBankRows", {})).reconciled[0].holds;
    const check = await f.result(
      "postJournalEntry",
      entry("2026-03-15", [
        ["6300", 1_000, 0],
        ["1000", 0, 1_000],
      ]),
    );
    expect(await holds()).toBe(true);
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-03-31" }),
    ).toMatchObject({
      booksCents: 49_000,
      clearedCents: 50_000,
      outstanding: [{ id: check.id, amountCents: -1_000, clearedOn: null }],
    });
    const early = await f.result(
      "postJournalEntry",
      entry("2026-03-01", [
        ["6300", 500, 0],
        ["1000", 0, 500],
      ]),
    );
    expect(await holds()).toBe(false);
    await f.result("reverseJournalEntry", { entryId: early.id, date: "2026-03-01" });
    expect(await holds()).toBe(true);
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-03-31" }),
    ).toMatchObject({ outstanding: [{ id: check.id }], outstandingCount: 1 });
    await f.result("stageBankRows", {
      importId: "import-april",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-04-03", "CHECK 101", "-10.00"],
        ["2026-03-02", "Deposit", "500.00"],
      ],
    });
    expect(await holds()).toBe(false);
    const twice = (await f.result("listBankRows", { status: "duplicate" })).rows[0];
    expect(twice).toMatchObject({ date: "2026-03-02", confirmed: false });
    await expect(
      f.call("reconcileBank", { ...statement, date: "2026-04-30", balanceCents: 49_000 }),
    ).rejects.toMatchObject(refusal("unreviewed"));
    await f.result("confirmDuplicateBankRow", { id: twice.id, confirmed: true });
    expect(await holds()).toBe(true);
    const cleared = (await unreviewed(f)).find((row: any) => row.description === "CHECK 101");
    await f.result("linkBankRow", { id: cleared.id, entryId: check.id });
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-03-31" }),
    ).toMatchObject({
      clearedCents: 50_000,
      outstanding: [{ id: check.id, clearedOn: "2026-04-03" }],
    });
    expect(await holds()).toBe(true);
    expect(
      await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-04-30" }),
    ).toMatchObject({ booksCents: 49_000, clearedCents: 49_000, outstanding: [] });
    await expect(
      f.call("reconcileBank", { ...statement, date: "2026-04-30", balanceCents: 50_000 }),
    ).rejects.toMatchObject(refusal("not_reconciled"));
    const april = await f.result("reconcileBank", {
      ...statement,
      date: "2026-04-30",
      balanceCents: 49_000,
    });
    expect((await f.result("listBankRows", {})).reconciled).toEqual([
      expect.objectContaining({ id: april.id, date: "2026-04-30", holds: true }),
    ]);
    await f.result("removeReconciliation", { id: done.id });
    await f.result("removeReconciliation", { id: april.id });
    expect((await f.result("listBankRows", {})).reconciled).toEqual([]);
    const days = Array.from({ length: 70 }, (_, at) =>
      new Date(Date.UTC(2026, 4, 1 + at)).toISOString().slice(0, 10),
    );
    for (const date of days)
      await f.result("reconcileBank", { ...statement, date, balanceCents: 49_000 });
    expect((await f.result("listBankRows", {})).reconciled).toEqual([
      expect.objectContaining({ date: days[69], holds: true }),
    ]);
  });

  it("matches a retainer only to its own month and pays a new invoice from it", async () => {
    const f = await books();
    const client = await f.result("saveClient", { name: "Northwind Studio" });
    const retainer = async (issueDate: string, dueDate: string) => {
      const draft = await f.result("saveDraftInvoice", {
        clientId: client.id,
        issueDate,
        dueDate,
        currency: "USD",
        lines: [
          {
            description: "Retainer",
            quantity: 1,
            unitPriceCents: 90_000,
            revenueAccountId: "4000",
          },
        ],
      });
      return f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    };
    const april = await retainer("2026-04-01", "2026-04-30");
    await f.result("recordPayment", {
      id: april.id,
      expectedVersion: april.version,
      date: "2026-04-15",
      bankAccountId: "1000",
    });
    const may = await retainer("2026-05-01", "2026-05-31");
    const mayPaid = await f.result("recordPayment", {
      id: may.id,
      expectedVersion: may.version,
      date: "2026-05-10",
      bankAccountId: "1000",
    });
    await f.result("stageBankRows", {
      importId: "import-may-coffee",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-05-02", "Coffee", "-4.00"]],
    });
    const june = await retainer("2026-06-01", "2026-06-30");
    await f.result("stageBankRows", {
      importId: "import-june-retainer",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-06-20", "NORTHWIND RETAINER", "900.00"]],
    });
    const suggested = (await f.result("listBankRows", { status: "matched" })).rows;
    expect(suggested).toHaveLength(1);
    const [row] = suggested;
    expect(row.candidates.map((candidate: any) => [candidate.id, candidate.sure])).toEqual([
      [mayPaid.paymentEntryId, true],
    ]);
    expect(row.match).toBeNull();
    expect(row.payables.map((item: any) => item.id)).toEqual([june.id]);
    const payment = { id: june.id, expectedVersion: june.version, bankRowId: row.id };
    await expect(f.call("recordPayment", payment)).rejects.toMatchObject(
      refusal("already_in_books"),
    );
    await f.result("recordPayment", { ...payment, notMatched: [mayPaid.paymentEntryId] });
    expect(
      (await f.result("listBankRows", { status: "posted" })).rows.map((item: any) => item.id),
    ).toEqual([row.id]);
  });

  it("refuses a match that would change a reconciliation in a closed month", async () => {
    const f = await books();
    const deposit = (day: string) =>
      f.result(
        "postJournalEntry",
        entry(day, [
          ["1000", 10_000, 0],
          ["3000", 0, 10_000],
        ]),
      );
    const january = await deposit("2026-01-10");
    const february = await deposit("2026-02-01");
    const cleared = async () =>
      (await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-01-31" }))
        .clearedCents;
    const balanceCents = await cleared();
    await f.result("reconcileBank", {
      bankAccountId: "1000",
      date: "2026-01-31",
      currency: "USD",
      balanceCents,
    });
    await f.result("lockPeriod", { periodId: "2026-01" });
    await f.result("stageBankRows", {
      importId: "import-february",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-02-03", "Deposit", "100.00"]],
    });
    const [row] = (await unreviewed(f)) as any[];
    await expect(f.call("linkBankRow", { id: row.id, entryId: january.id })).rejects.toMatchObject(
      refusal("period_closed"),
    );
    expect(await f.result("linkBankRow", { id: row.id, entryId: february.id })).toMatchObject({
      entryId: february.id,
    });
    expect(await cleared()).toBe(balanceCents);
    expect((await f.result("listBankRows", {})).reconciled).toEqual([
      expect.objectContaining({ date: "2026-01-31", holds: true }),
    ]);
  });

  it("keeps a closed month's reconciliation through removal, reversal, and a late re-export", async () => {
    const f = await books();
    const deposit = await f.result(
      "postJournalEntry",
      entry("2026-01-10", [
        ["1000", 10_000, 0],
        ["3000", 0, 10_000],
      ]),
    );
    await f.result("stageBankRows", {
      importId: "import-february",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-02-03", "Deposit", "100.00"]],
    });
    const [row] = (await unreviewed(f)) as any[];
    await f.result("linkBankRow", { id: row.id, entryId: deposit.id });
    const status = await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-01-31" });
    const january = await f.result("reconcileBank", {
      bankAccountId: "1000",
      date: "2026-01-31",
      currency: "USD",
      balanceCents: status.clearedCents,
    });
    await f.result("lockPeriod", { periodId: "2026-01" });
    await expect(f.call("removeReconciliation", { id: january.id })).rejects.toMatchObject(
      refusal("period_closed"),
    );
    await expect(
      f.call("reverseJournalEntry", { entryId: deposit.id, date: "2026-02-02" }),
    ).rejects.toMatchObject({
      refusal: { code: "period_closed", message: expect.stringContaining("after 2026-02-03") },
    });
    await f.result("reverseJournalEntry", { entryId: deposit.id, date: "2026-02-04" });
    await f.result("stageBankRows", {
      importId: "import-february-again",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-02-03", "Deposit", "100.00"]],
    });
    const listed = await f.result("listBankRows", { status: "duplicate" });
    expect(listed.rows).toEqual([
      expect.objectContaining({ status: "duplicate", confirmed: false }),
    ]);
    expect(listed.reconciled).toEqual([
      expect.objectContaining({
        date: "2026-01-31",
        balanceCents: status.clearedCents,
        holds: true,
      }),
    ]);
  });

  it("refuses to close a month whose reconciliation no longer holds", async () => {
    const f = await books();
    const deposit = await f.result(
      "postJournalEntry",
      entry("2026-01-10", [
        ["1000", 10_000, 0],
        ["3000", 0, 10_000],
      ]),
    );
    await f.result("stageBankRows", {
      importId: "import-february",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-02-03", "Deposit", "100.00"]],
    });
    const { clearedCents } = await f.result("reconcileStatus", {
      bankAccountId: "1000",
      date: "2026-01-31",
    });
    expect(clearedCents).toBe(10_000);
    await f.result("reconcileBank", {
      bankAccountId: "1000",
      date: "2026-01-31",
      currency: "USD",
      balanceCents: clearedCents,
    });
    const [row] = (await unreviewed(f)) as any[];
    await f.result("linkBankRow", { id: row.id, entryId: deposit.id });
    await expect(f.call("lockPeriod", { periodId: "2026-01" })).rejects.toMatchObject(
      refusal("reconciliation_broken"),
    );
    await f.result("unlinkBankRow", { id: row.id });
    expect(await f.result("lockPeriod", { periodId: "2026-01" })).toMatchObject({
      status: "locked",
    });
  });

  it("confirms a re-exported row from a closed month on import", async () => {
    const f = await books();
    const stage = (importId: string) =>
      f.result("stageBankRows", {
        importId,
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [["2026-01-12", "Coffee Shop", "-5.25"]],
      });
    await stage("import-january");
    const [row] = (await unreviewed(f)) as any[];
    await f.result("postBankRows", { rows: [{ id: row.id, accountId: "6500" }] });
    const { clearedCents } = await f.result("reconcileStatus", {
      bankAccountId: "1000",
      date: "2026-01-31",
    });
    await f.result("reconcileBank", {
      bankAccountId: "1000",
      date: "2026-01-31",
      currency: "USD",
      balanceCents: clearedCents,
    });
    await f.result("lockPeriod", { periodId: "2026-01" });
    expect(await stage("import-january-again")).toMatchObject({ added: 0, duplicates: 1 });
    const listed = await f.result("listBankRows", { status: "duplicate" });
    expect(listed.rows).toEqual([expect.objectContaining({ confirmed: true, closed: true })]);
    expect(listed.reconciled).toEqual([
      expect.objectContaining({ date: "2026-01-31", holds: true }),
    ]);
  });

  it("matches a bank return to the reversal of a cleared deposit", async () => {
    const f = await books();
    await f.result("stageBankRows", {
      importId: "import-deposit",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-02", "Client deposit", "100.00"]],
    });
    const [deposit] = (await unreviewed(f)) as any[];
    const posted = await f.result("postBankRows", {
      rows: [{ id: deposit.id, accountId: "4000" }],
    });
    const reversal = await f.result("reverseJournalEntry", {
      entryId: posted.entries[0],
      date: "2026-03-06",
    });
    await f.result("stageBankRows", {
      importId: "import-return",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-06", "Returned deposit", "-100.00"]],
    });
    const [returned] = (await unreviewed(f)) as any[];
    expect(returned.candidates.map((candidate: any) => candidate.id)).toEqual([reversal.id]);
    await expect(
      f.call("postBankRows", { rows: [{ id: returned.id, accountId: "4000" }] }),
    ).rejects.toMatchObject(refusal("already_in_books"));
    await f.result("linkBankRow", { id: returned.id, entryId: reversal.id });
    await f.result("stageBankRows", {
      importId: "import-undo",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-03-09", "Office supplies", "-40.00"]],
    });
    const [supplies] = (await unreviewed(f)) as any[];
    const bought = await f.result("postBankRows", {
      rows: [{ id: supplies.id, accountId: "6100" }],
    });
    await f.result("reverseJournalEntry", { entryIds: bought.entries });
    const [back] = (await unreviewed(f)) as any[];
    expect(back).toMatchObject({ id: supplies.id, candidates: [] });
  });

  it("refuses a statement for an archived bank account and malformed IDs", async () => {
    const f = await books();
    await f.result("updateAccount", { id: "1010", archived: true });
    await expect(
      f.call("stageBankRows", {
        importId: "import-archived",
        bankAccountId: "1010",
        currency: "USD",
        firstLine: 1,
        rows: [["2026-02-03", "Deposit", "100.00"]],
      }),
    ).rejects.toMatchObject(refusal("account_archived"));
    const malformed: Array<[string, Record<string, AppBackendJson>]> = [
      ["getEntry", { id: {} }],
      ["getInvoice", { id: 7 }],
      ["deleteDraftInvoice", { id: [], expectedVersion: 1 }],
      ["accountLedger", { accountId: {} }],
      ["listEntries", { accountId: [] }],
      ["saveClient", { id: {}, name: "Synthetic Client" }],
    ];
    for (const [operation, input] of malformed)
      await expect(f.call(operation, input)).rejects.toMatchObject(refusal("invalid_input"));
  });

  it("ends a bank page before it outgrows the result limit", async () => {
    const f = await books();
    await f.result("updateAccount", { id: "4000", name: "R".repeat(120) });
    for (let index = 0; index < 5; index++)
      await f.result("postJournalEntry", {
        ...entry("2026-04-15", [
          ["1000", 10_000, 0],
          ["4000", 0, 10_000],
        ]),
        memo: `Ledger ${index} `.padEnd(500, "m"),
      });
    await f.result("stageBankRows", {
      importId: "import-wide",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: Array.from({ length: 100 }, (_, index) => [
        "2026-04-15",
        `Bank credit ${index} `.padEnd(300, "d"),
        "100.00",
      ]),
    });
    const first = await f.result("listBankRows", { status: "new", limit: 100 });
    expect(first.rows[0].candidates).toHaveLength(5);
    expect(first.rows.length).toBeLessThan(100);
    expect(first.nextOffset).toBe(first.rows.length);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    const rest = await f.result("listBankRows", {
      status: "new",
      limit: 100,
      offset: first.nextOffset,
    });
    expect(first.rows.length + rest.rows.length).toBe(100);
    expect(rest.nextOffset).toBeNull();
  });

  it("undoes a full page of posted bank rows in one reversal", async () => {
    const f = await books();
    await f.result("stageBankRows", {
      importId: "import-page",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: Array.from({ length: 100 }, (_, index) => [
        `2026-04-${String((index % 28) + 1).padStart(2, "0")}`,
        `Vendor ${index}`,
        `-${index + 1}.00`,
      ]),
    });
    const page = await f.result("listBankRows", { limit: 100 });
    const posted = await f.result("postBankRows", {
      rows: page.rows.map((row: any) => ({ id: row.id, accountId: "6100" })),
    });
    expect(posted.posted).toBe(100);
    expect(await f.result("reverseJournalEntry", { entryIds: posted.entries })).toMatchObject({
      reversed: 100,
    });
    expect((await f.result("listBankRows", { limit: 100 })).rows).toHaveLength(100);
  });

  it("keeps a reconciliation when a closed month's statement row arrives later", async () => {
    const f = await books();
    const cleared = async () =>
      (await f.result("reconcileStatus", { bankAccountId: "1000", date: "2026-01-31" }))
        .clearedCents;
    const before = await cleared();
    await f.result(
      "postJournalEntry",
      entry("2026-01-10", [
        ["1000", 10_000, 0],
        ["3000", 0, 10_000],
      ]),
    );
    expect(await cleared()).toBe(before + 10_000);
    await f.result("reconcileBank", {
      bankAccountId: "1000",
      date: "2026-01-31",
      currency: "USD",
      balanceCents: before + 10_000,
    });
    await f.result("lockPeriod", { periodId: "2026-01" });
    expect(
      await f.result("stageBankRows", {
        importId: "import-january-late",
        bankAccountId: "1000",
        currency: "USD",
        firstLine: 1,
        rows: [["2026-01-10", "Deposit", "100.00"]],
      }),
    ).toMatchObject({ added: 0, closed: 1 });
    expect(await cleared()).toBe(before + 10_000);
    expect((await f.result("listBankRows", {})).reconciled).toEqual([
      expect.objectContaining({ date: "2026-01-31", holds: true }),
    ]);
  });

  it("splits, suggests, matches, and reverses bank rows in batches", async () => {
    const f = await books();
    const client = await f.result("saveClient", { name: "Synthetic Client Co" });
    const draft = await f.result("saveDraftInvoice", {
      clientId: client.id,
      issueDate: "2026-05-01",
      dueDate: "2026-05-31",
      currency: "USD",
      lines: [
        { description: "Design", quantity: 1, unitPriceCents: 90_000, revenueAccountId: "4000" },
      ],
    });
    const issued = await f.result("issueInvoice", { id: draft.id, expectedVersion: draft.version });
    await f.result("stageBankRows", {
      importId: "import-june",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [
        ["2026-06-01", "Office Depot 114", "-100.00"],
        ["2026-06-02", "Synthetic Client payment", "900.00"],
        ["2026-06-03", "Coffee Shop", "-4.50"],
        ["2026-06-04", "Client payment", "450.00"],
      ],
    });
    const fresh = await unreviewed(f);
    const byDescription = (text: string, amount: number) =>
      fresh.find((row: any) => row.description === text && row.amountCents === amount);
    const office = byDescription("Office Depot 114", -10_000);
    const payment = byDescription("Synthetic Client payment", 90_000);
    const coffee = byDescription("Coffee Shop", -450);
    expect(payment.match).toMatchObject({
      id: draft.id,
      number: "INV-0001",
      clientName: "Synthetic Client Co",
    });
    expect(byDescription("Client payment", 45_000).match).toBeNull();
    expect(
      (await f.result("listBankRows", { status: "matched" })).rows.map((row: any) => row.id),
    ).toEqual([payment.id]);

    await expect(
      f.call("postBankRows", {
        rows: [
          {
            id: office.id,
            splits: [
              { accountId: "6100", amountCents: 6_000 },
              { accountId: "6200", amountCents: 3_000 },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject(refusal("unbalanced"));
    const picks: Record<string, AppBackendJson>[] = [
      { splits: [{ accountId: "6100", amountCents: 10_000 }] },
      {
        splits: [
          { accountId: "1100", amountCents: 6_000 },
          { accountId: "6200", amountCents: 4_000 },
        ],
      },
      { accountId: "1100" },
    ];
    for (const pick of picks)
      await expect(
        f.call("postBankRows", { rows: [{ id: office.id, ...pick }] }),
      ).rejects.toMatchObject(refusal("invalid_input"));
    const split = await f.result("postBankRows", {
      rows: [
        {
          id: office.id,
          memo: "Paper and toner",
          splits: [
            { accountId: "6100", amountCents: 6_000, memo: "Toner" },
            { accountId: "6200", amountCents: 4_000 },
          ],
        },
        { id: coffee.id, accountId: "6500" },
      ],
    });
    expect(split).toMatchObject({ posted: 2, numbers: [2, 3] });
    const splitEntry = await f.result("getEntry", { id: split.entries[0] });
    expect(splitEntry.memo).toBe("Paper and toner");
    expect(
      splitEntry.lines.map((line: any) => [line.accountId, line.debitCents, line.creditCents]),
    ).toEqual([
      ["6100", 6_000, 0],
      ["6200", 4_000, 0],
      ["1000", 0, 10_000],
    ]);
    expect(splitEntry.bankRow).toMatchObject({ id: office.id, description: "Office Depot 114" });

    await f.result("stageBankRows", {
      importId: "import-july",
      bankAccountId: "1000",
      currency: "USD",
      firstLine: 1,
      rows: [["2026-07-03", "Coffee Shop", "-5.25"]],
    });
    const july = (await unreviewed(f)).find((row: any) => row.date === "2026-07-03");
    expect(july.suggestedAccountId).toBe("6500");

    await expect(
      f.call("recordPayment", {
        id: draft.id,
        expectedVersion: issued.version,
        bankRowId: byDescription("Client payment", 45_000).id,
        amountCents: 40_000,
      }),
    ).rejects.toMatchObject(refusal("amount_mismatch"));
    const paid = await f.result("recordPayment", {
      id: draft.id,
      expectedVersion: issued.version,
      bankRowId: payment.id,
    });
    expect(await f.result("getEntry", { id: paid.paymentEntryId })).toMatchObject({
      date: "2026-06-02",
      totalCents: 90_000,
    });
    expect((await f.result("listBankRows", { status: "matched" })).rows).toEqual([]);
    expect(
      (await f.result("listBankRows", { status: "posted" })).rows.find(
        (row: any) => row.id === payment.id,
      ),
    ).toMatchObject({ journalEntryId: paid.paymentEntryId });

    const register = await f.result("listEntries", { accountId: "1000", currency: "USD" });
    expect(register.entries.map((row: any) => [row.number, row.balanceCents])).toEqual([
      [3, 90_000 - 10_000 - 450],
      [4, 90_000 - 10_000],
      [2, -10_000],
    ]);
    expect(register).toMatchObject({ total: 3, debitCents: 90_000, creditCents: 10_450 });
    expect(
      (await f.result("listEntries", { q: "toner" })).entries.map((row: any) => row.number),
    ).toEqual([2]);
    expect(
      (await f.result("listEntries", { show: "missing" })).entries.map((row: any) => row.number),
    ).toEqual([3, 2]);

    await expect(
      f.call("reverseJournalEntry", { entryIds: [split.entries[0], split.entries[0]] }),
    ).rejects.toMatchObject(refusal("invalid_input"));
    await f.result("reverseJournalEntry", { entryIds: split.entries });
    const restored = (await unreviewed(f)).map((row: any) => row.id);
    expect(restored).toEqual(expect.arrayContaining([office.id, coffee.id]));
    expect(
      (await f.result("listEntries", { show: "reversed" })).entries.map((row: any) => row.number),
    ).toEqual([6, 3, 5, 2]);
    expect(
      (await f.result("listEntries", { accountId: "1000", currency: "USD" })).entries[0]
        .balanceCents,
    ).toBe(90_000);

    const overview = await f.result("overview", { today: "2026-07-15" });
    expect(overview).toMatchObject({
      today: "2026-07-15",
      currency: "USD",
      cashCents: 90_000,
      receivables: { open: 0, openCents: 0 },
      newBankRows: 4,
      draftInvoices: 0,
      periods: { total: 12, unlocked: 6, nextToLock: "2026-01", lockedThrough: null },
      yearToDate: { incomeCents: 90_000, expenseCents: 0, netIncomeCents: 90_000 },
      hasPeriods: true,
    });
    expect(overview.periods.current).toMatchObject({ id: "2026-07" });
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
    expect(
      await f.result("removeReceipt", { entryId: bare.id, fileId: receiptPdf.fileId }),
    ).toEqual({ entryId: bare.id, fileId: receiptPdf.fileId });
    await expect(
      f.call("removeReceipt", { entryId: bare.id, fileId: receiptPdf.fileId }),
    ).rejects.toMatchObject(refusal("conflict"));
    expect((await f.result("getEntry", { id: bare.id })).receiptFileId).toBeNull();
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
          ["1010", 80_000, 0],
          ["4000", 0, 80_000],
        ]),
        entry("2026-02-12", [
          ["6100", 4_900, 0],
          ["2200", 0, 4_900],
        ]),
        entry("2026-03-01", [
          ["1000", 80_000, 0],
          ["1010", 0, 80_000],
        ]),
      ],
    });
    const toReceivable = entry("2026-02-11", [
      ["1100", 1_200, 0],
      ["4000", 0, 1_200],
    ]);
    await expect(f.call("postJournalEntry", toReceivable)).rejects.toMatchObject(
      refusal("control_account"),
    );
    await expect(f.call("postJournalEntries", { entries: [toReceivable] })).rejects.toMatchObject(
      refusal("control_account"),
    );
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
      retainedEarningsCents: 0,
      earningsCents: 75_100,
      totalEquityCents: 575_100,
      balanced: true,
    });
    expect(
      await f.result("balanceSheet", { asOf: "2027-03-31", currency: "USD" }, "accountant"),
    ).toMatchObject({
      retainedEarningsCents: 75_100,
      earningsCents: 0,
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
      "confirmDuplicateBankRow",
      "findBankMatches",
      "linkBankRow",
      "reconcileStatus",
      "reconcileBank",
      "removeReconciliation",
      "recordPayment",
      "getBusiness",
      "saveBusiness",
      "getInvoice",
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
    expect((await f.result("booksInfo", {}, "accountant")).name).toBe("Synthetic Books");
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
  const post = (
    db: DatabaseSync,
    id: string,
    debit = 100,
    credit = 100,
    date = "2026-01-10",
    source = "manual",
    sourceId: string | null = null,
  ) => {
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES(?,?,1,'6000',?,0)",
      ).run(`${id}-1`, id, debit);
      db.prepare(
        "INSERT INTO journal_lines(id,entry_id,line_no,account_id,debit_cents,credit_cents) VALUES(?,?,2,?,0,?)",
      ).run(`${id}-2`, id, source === "payment" ? "1100" : "1000", credit);
      db.prepare(
        "INSERT INTO journal_entries(id,number,entry_date,currency,memo,source,source_id,total_cents,created_at_ms) VALUES(?,?,?,'USD','',?,?,?,0)",
      ).run(id, Number(id.slice(1)), date, source, sourceId, debit);
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
    db.exec("UPDATE journal_entries SET receipt_file_id='late' WHERE id='e1'");
    db.exec("UPDATE journal_entries SET receipt_file_id=NULL WHERE id='e1'");
    expect(() => db.exec("UPDATE journal_entries SET total_cents=1 WHERE id='e1'")).toThrow(
      /posted/,
    );
    expect(() => post(db, "e4")).toThrow(/period_closed/);
    expect(
      db.prepare("SELECT sum(debit_cents) AS d,sum(credit_cents) AS c FROM journal_lines").get(),
    ).toEqual({ d: 100, c: 100 });
  });

  it("keeps a duplicate bank row a duplicate until it is kept, with or without a closed month", () => {
    const db = database();
    db.exec(`INSERT INTO bank_imports(id,import_id,line_no,bank_account_id,posted_on,description,amount_cents,
      currency,base_hash,row_hash,status,imported_at_ms)
      VALUES('d1','import-raw-1',1,'1000','2026-01-05','CAFE',-500,'USD','${"a".repeat(64)}','${"b".repeat(64)}','duplicate',0)`);
    expect(() => db.exec("UPDATE bank_imports SET status='ignored' WHERE id='d1'")).toThrow(
      /bank_row_fixed/,
    );
    db.exec("UPDATE bank_imports SET confirmed=1 WHERE id='d1'");
    expect(() => db.exec("UPDATE bank_imports SET status='new' WHERE id='d1'")).toThrow(
      /CHECK constraint/,
    );
    expect(() =>
      db.exec(`UPDATE bank_imports SET row_hash='${"c".repeat(64)}' WHERE id='d1'`),
    ).toThrow(/bank_row_fixed/);
    db.exec("UPDATE bank_imports SET confirmed=0 WHERE id='d1'");
    db.exec("UPDATE bank_imports SET status='new' WHERE id='d1'");
    expect(() => db.exec("UPDATE bank_imports SET status='duplicate' WHERE id='d1'")).toThrow(
      /bank_row_fixed/,
    );
    db.exec(`INSERT INTO bank_imports(id,import_id,line_no,bank_account_id,posted_on,description,amount_cents,
      currency,base_hash,row_hash,status,imported_at_ms)
      VALUES('d2','import-raw-1',2,'1000','2026-01-05','CAFE',-500,'USD','${"a".repeat(64)}','${"d".repeat(64)}','duplicate',0)`);
    db.exec("UPDATE fiscal_periods SET status='locked' WHERE id='2026-01'");
    db.exec("UPDATE bank_imports SET status='ignored' WHERE id='d2'");
  });

  it("keeps an invoice's paid amount equal to its payments in SQL", () => {
    const db = database();
    post(db, "e1");
    post(db, "e2", 60, 60, "2026-01-11", "payment", "i");
    post(db, "e3", 60, 60, "2026-01-12", "payment", "i");
    post(db, "e4", 40, 40, "2026-01-12", "payment", "i");
    post(db, "e5", 40, 40, "2026-01-12", "payment", "other");
    db.exec("INSERT INTO clients(id,name,created_at_ms) VALUES('c','Client',0)");
    db.exec(`INSERT INTO invoices(id,number,client_id,issue_date,due_date,currency,tax_rate_bp,subtotal_cents,
      tax_cents,total_cents,status,journal_entry_id,seller_name,buyer_name,created_at_ms)
      VALUES('i','INV-0001','c','2026-01-10','2026-01-31','USD',0,100,0,100,'issued','e1','Seller','Client',0)`);
    const pay = (entryId: string, amount: number, on = "2026-01-11") =>
      db
        .prepare(
          "INSERT INTO invoice_payments(entry_id,invoice_id,paid_on,amount_cents) VALUES(?,'i',?,?)",
        )
        .run(entryId, on, amount);
    expect(() => pay("e1", 100)).toThrow(/overpaid/);
    expect(() => pay("e2", 50)).toThrow(/overpaid/);
    pay("e2", 60);
    expect(() => pay("e3", 60)).toThrow(/overpaid/);
    expect(() => pay("e5", 40, "2026-01-12")).toThrow(/overpaid/);
    expect(() => pay("e4", 40, "2026-01-13")).toThrow(/overpaid/);
    expect(() => db.exec("UPDATE invoices SET paid_cents=0 WHERE id='i'")).toThrow(/invoice_paid/);
    pay("e4", 40, "2026-01-12");
    expect(db.prepare("SELECT status,paid_cents,paid_on FROM invoices").get()).toEqual({
      status: "paid",
      paid_cents: 100,
      paid_on: "2026-01-12",
    });
    expect(() => db.exec("DELETE FROM invoice_payments WHERE entry_id='e2'")).toThrow(/posted/);
    expect(() => db.exec("UPDATE invoice_payments SET amount_cents=1")).toThrow(/posted/);
    expect(() => db.exec("UPDATE invoices SET seller_name='Other' WHERE id='i'")).toThrow(
      /invoice_issued/,
    );
    expect(() =>
      db.exec(
        "INSERT INTO reconciliations(id,bank_account_id,currency,statement_date,balance_cents,created_at_ms) VALUES('r','6000','USD','2026-01-31',0,0)",
      ),
    ).toThrow(/invalid_input/);
  });
});
