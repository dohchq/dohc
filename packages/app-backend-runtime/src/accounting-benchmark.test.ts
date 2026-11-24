import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { afterAll, describe, expect, it } from "vitest";
import { accountingFixture } from "./accounting.test-helper.ts";

const ENTRIES = 2_500;
const BANK_ROWS = 2_500;
const INPUT_BUDGET = 60 * 1024;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
const day = (index: number, count: number) => {
  const date = new Date(Date.UTC(2026, 0, 1) + Math.floor((index * 364) / count) * 86_400_000);
  return date.toISOString().slice(0, 10);
};
function journal(next: () => number) {
  return Array.from({ length: ENTRIES }, (_, index) => {
    const date = day(index, ENTRIES);
    const a = 1_000 + Math.floor(next() * 250_000);
    const b = 100 + Math.floor(next() * 25_000);
    const lines: AppBackendJson[] =
      index % 2 === 0
        ? [
            { accountId: "1000", debitCents: a + b - 35 },
            { accountId: "6300", debitCents: 35 },
            { accountId: "4000", creditCents: a },
            { accountId: "2100", creditCents: b },
          ]
        : [
            {
              accountId: ["6000", "6100", "6200", "6400"][index % 4 === 1 ? 0 : 1 + (index % 3)]!,
              debitCents: a,
            },
            { accountId: "6500", debitCents: b },
            { accountId: "1000", creditCents: a },
            { accountId: "2200", creditCents: b },
          ];
    return { date, currency: "USD", memo: `Synthetic entry ${index + 1}`, lines };
  });
}
function statement(next: () => number) {
  const payees = [
    "Coffee Shop",
    "Hardware Store",
    "Client payment",
    "Software subscription",
    "Transit card",
    "Bank fee",
  ];
  return Array.from({ length: BANK_ROWS }, (_, index) => {
    const cents = (next() < 0.25 ? 1 : -1) * (100 + Math.floor(next() * 90_000));
    const amount = `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    return [
      day(index, BANK_ROWS),
      `POS ${payees[index % payees.length]} #${1000 + (index % 97)} SYNTHETIC CITY`,
      amount,
    ];
  });
}
function batches<T>(items: T[], cap: number, wrap: (chunk: T[]) => unknown) {
  const out: T[][] = [];
  let chunk: T[] = [];
  for (const item of items) {
    if (
      chunk.length &&
      (chunk.length >= cap ||
        Buffer.byteLength(JSON.stringify(wrap([...chunk, item]))) > INPUT_BUDGET)
    ) {
      out.push(chunk);
      chunk = [];
    }
    chunk.push(item);
  }
  if (chunk.length) out.push(chunk);
  return out;
}
function bytes(directory: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) walk(child);
      else sizes[child.slice(directory.length + 1).replaceAll("\\", "/")] = info.size;
    }
  };
  walk(directory);
  return sizes;
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const round = (value: number) => Math.round(value * 10) / 10;
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const refusal = (error as { refusal?: { code: string; message: string } }).refusal;
    return refusal
      ? `refusal ${refusal.code}: ${refusal.message}`
      : String((error as Error).message);
  }
  return "accepted";
}

const report: Record<string, unknown> = {};
afterAll(() => {
  const out = process.env.ACCOUNTING_BENCHMARK_OUT;
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
});

describe("accounting example at 10,000 journal lines", () => {
  it(
    "seeds, imports, reports, and stays inside every runtime limit",
    { timeout: 600_000 },
    async () => {
      const f = await accountingFixture();
      try {
        await f.result("addFiscalYear", { year: 2026 });
        const next = random(0x5eed);
        const sizesBefore = bytes(f.directory);

        const entries = journal(next);
        const postBatches = batches(entries, 500, (chunk) => ({ entries: chunk }));
        const postTimes: number[] = [];
        for (const chunk of postBatches) {
          const started = performance.now();
          const posted = await f.result("postJournalEntries", { entries: chunk });
          postTimes.push(performance.now() - started);
          expect(posted.posted).toBe(chunk.length);
        }
        const lines = entries.reduce((sum, entry) => sum + entry.lines.length, 0);
        expect(lines).toBe(10_000);
        report.journal = {
          entries: entries.length,
          lines,
          batches: postBatches.length,
          entriesPerBatch: [
            Math.min(...postBatches.map((c) => c.length)),
            Math.max(...postBatches.map((c) => c.length)),
          ],
          batchMs: { median: round(median(postTimes)), max: round(Math.max(...postTimes)) },
          totalMs: round(postTimes.reduce((a, b) => a + b, 0)),
        };

        const rows = statement(next);
        const stageBatches = batches(rows, 500, (chunk) => ({
          importId: "benchmark-statement-0001",
          bankAccountId: "1000",
          currency: "USD",
          firstLine: 1_000_000,
          rows: chunk,
        }));
        const stageTimes: number[] = [];
        let line = 1;
        let added = 0;
        for (const chunk of stageBatches) {
          const started = performance.now();
          const staged = await f.result("stageBankRows", {
            importId: "benchmark-statement-0001",
            bankAccountId: "1000",
            currency: "USD",
            firstLine: line,
            rows: chunk,
          });
          stageTimes.push(performance.now() - started);
          added += staged.added;
          line = staged.nextLine;
        }
        const replayStarted = performance.now();
        let duplicates = 0;
        line = 1;
        for (const chunk of stageBatches) {
          const staged = await f.result("stageBankRows", {
            importId: "benchmark-statement-0002",
            bankAccountId: "1000",
            currency: "USD",
            firstLine: line,
            rows: chunk,
          });
          duplicates += staged.duplicates;
          line = staged.nextLine;
        }
        const replayMs = performance.now() - replayStarted;
        const postRowTimes: number[] = [];
        let postedRows = 0;
        for (;;) {
          const page = await f.result("listBankRows", { status: "new", limit: 100 });
          if (!page.rows.length) break;
          const started = performance.now();
          const posted = await f.result("postBankRows", {
            rows: page.rows.map((row: any) => ({
              id: row.id,
              accountId: row.amountCents > 0 ? "4000" : "6900",
            })),
          });
          postRowTimes.push(performance.now() - started);
          postedRows += posted.posted;
        }
        report.bankImport = {
          rows: rows.length,
          added,
          duplicatesOnReimport: duplicates,
          stageBatches: stageBatches.length,
          rowsPerBatch: [
            Math.min(...stageBatches.map((c) => c.length)),
            Math.max(...stageBatches.map((c) => c.length)),
          ],
          stageBatchMs: { median: round(median(stageTimes)), max: round(Math.max(...stageTimes)) },
          reimportMs: round(replayMs),
          postedRows,
          postBatchMs: {
            median: round(median(postRowTimes)),
            max: round(Math.max(...postRowTimes)),
          },
        };
        expect(added).toBe(BANK_ROWS);
        expect(duplicates).toBe(BANK_ROWS);
        expect(postedRows).toBe(BANK_ROWS);

        const timed = async (
          name: string,
          input: AppBackendJson,
          caller: "owner" | "accountant" = "owner",
        ) => {
          const times: number[] = [];
          let last: any;
          for (let run = 0; run < 7; run++) {
            const started = performance.now();
            last = await f.result(name, input, caller);
            times.push(performance.now() - started);
          }
          const resultBytes = Buffer.byteLength(JSON.stringify(last));
          return {
            last,
            ms: { median: round(median(times)), max: round(Math.max(...times)) },
            resultBytes,
          };
        };
        const tb = await timed(
          "trialBalance",
          { asOf: "2026-12-31", currency: "USD" },
          "accountant",
        );
        const pnl = await timed(
          "incomeStatement",
          { from: "2026-01-01", to: "2026-12-31", currency: "USD" },
          "accountant",
        );
        const bs = await timed(
          "balanceSheet",
          { asOf: "2026-12-31", currency: "USD" },
          "accountant",
        );
        const ledger = await timed(
          "accountLedger",
          { accountId: "1000", currency: "USD", from: "2026-01-01", to: "2026-12-31", limit: 500 },
          "accountant",
        );
        const overview = await timed("overview", { today: "2026-12-31", currency: "USD" });
        const baseline = await timed("booksInfo", {}, "accountant");
        expect(tb.last.balanced).toBe(true);
        expect(bs.last.balanced).toBe(true);
        expect(tb.last.totalDebitCents).toBe(tb.last.totalCreditCents);
        expect(pnl.last.months).toHaveLength(12);
        report.reports = {
          trialBalance: { ...tb.ms, resultBytes: tb.resultBytes },
          incomeStatement: { ...pnl.ms, resultBytes: pnl.resultBytes },
          balanceSheet: { ...bs.ms, resultBytes: bs.resultBytes },
          accountLedger500: { ...ledger.ms, resultBytes: ledger.resultBytes },
          overview: { ...overview.ms, resultBytes: overview.resultBytes },
          booksInfoBaseline: { ...baseline.ms, resultBytes: baseline.resultBytes },
        };

        const sizesAfter = bytes(f.directory);
        const worker = Object.entries(sizesAfter).filter(([name]) => name.startsWith("workers/"));
        report.storage = {
          totalLines: lines + BANK_ROWS * 2,
          totalEntries: entries.length + BANK_ROWS,
          bankRows: BANK_ROWS * 2,
          workerFiles: Object.fromEntries(worker),
          hostJournalFiles: Object.fromEntries(
            Object.entries(sizesAfter).filter(([name]) => name.startsWith("host.sqlite")),
          ),
          hostJournalGrowthBytes:
            Object.entries(sizesAfter)
              .filter(([name]) => name.startsWith("host.sqlite"))
              .reduce((sum, [, size]) => sum + size, 0) -
            Object.entries(sizesBefore)
              .filter(([name]) => name.startsWith("host.sqlite"))
              .reduce((sum, [, size]) => sum + size, 0),
        };

        const big = Array.from({ length: 500 }, (_, index) => [
          "2026-06-01",
          `${"x".repeat(200)} ${index}`,
          "-1.00",
        ]);
        const nodes = Array.from({ length: 4_200 }, () => [0, 0, 0]);
        const nodesPayload = {
          importId: "ceiling-nodes",
          bankAccountId: "1000",
          currency: "USD",
          firstLine: 1,
          rows: nodes,
        };
        const bank501Payload = {
          importId: "ceiling-rows",
          bankAccountId: "1000",
          currency: "USD",
          firstLine: 1,
          rows: Array.from({ length: 501 }, () => ["2026-06-01", "x", "1"]),
        };
        const minimalEntry: AppBackendJson = {
          date: "2026-06-01",
          currency: "USD",
          lines: [
            { accountId: "1000", debitCents: 1 },
            { accountId: "3000", creditCents: 1 },
          ],
        };
        const post500Payload = {
          entries: Array.from({ length: 500 }, () => minimalEntry),
        };
        const post501Payload = {
          entries: Array.from({ length: 501 }, () => minimalEntry),
        };
        expect(Buffer.byteLength(JSON.stringify(nodesPayload))).toBeLessThan(64 * 1024);
        expect(Buffer.byteLength(JSON.stringify(bank501Payload))).toBeLessThan(64 * 1024);
        expect(Buffer.byteLength(JSON.stringify(post500Payload))).toBeLessThan(64 * 1024);
        expect(Buffer.byteLength(JSON.stringify(post501Payload))).toBeLessThan(64 * 1024);
        const ceilings = {
          input65KiB: await failure(() =>
            f.call("stageBankRows", {
              importId: "ceiling-input",
              bankAccountId: "1000",
              currency: "USD",
              firstLine: 1,
              rows: big,
            }),
          ),
          jsonNodes16801: await failure(() => f.call("stageBankRows", nodesPayload)),
          bankBatch501: await failure(() => f.call("stageBankRows", bank501Payload)),
          postBatch500: await failure(() => f.call("postJournalEntries", post500Payload)),
          postBatch501: await failure(() => f.call("postJournalEntries", post501Payload)),
          bankPage100: await failure(() =>
            f.call("listBankRows", { status: "posted", limit: 100 }),
          ),
          bankPage101: await failure(() =>
            f.call("listBankRows", { status: "posted", limit: 101 }),
          ),
          ledgerPage501: await failure(() =>
            f.call("accountLedger", {
              accountId: "1000",
              currency: "USD",
              from: "2026-01-01",
              to: "2026-12-31",
              limit: 501,
            }),
          ),
          entry500Lines: await failure(() =>
            f.call("postJournalEntry", {
              date: "2026-06-30",
              currency: "USD",
              memo: "Largest entry",
              lines: Array.from({ length: 500 }, (_, index): AppBackendJson =>
                index % 2
                  ? { accountId: "1000", creditCents: 1 }
                  : { accountId: "6900", debitCents: 1 },
              ),
            }),
          ),
          entry501Lines: await failure(() =>
            f.call("postJournalEntry", {
              date: "2026-06-30",
              currency: "USD",
              memo: "Too many lines",
              lines: Array.from({ length: 501 }, (_, index): AppBackendJson =>
                index % 2
                  ? { accountId: "1000", creditCents: 1 }
                  : { accountId: "6900", debitCents: 1 },
              ),
            }),
          ),
        };
        report.ceilings = ceilings;
        expect(ceilings.input65KiB).toMatch(/byte bound/i);
        expect(ceilings.jsonNodes16801).toMatch(/structural bound/i);
        expect(ceilings.bankBatch501).toBe("refusal invalid_input: Send 1 to 500 rows at a time.");
        expect(ceilings.postBatch500).toBe("accepted");
        expect(ceilings.postBatch501).toBe(
          "refusal invalid_input: Post 1 to 500 entries at a time.",
        );
        expect(ceilings.bankPage100).toBe("accepted");
        expect(ceilings.bankPage101).toBe(
          "refusal invalid_input: Choose a page size from 1 to 100.",
        );
        expect(ceilings.ledgerPage501).toBe(
          "refusal invalid_input: Choose a page size from 1 to 500.",
        );
        expect(ceilings.entry500Lines).toBe("accepted");
        expect(ceilings.entry501Lines).toBe(
          "refusal invalid_input: An entry needs 2 to 500 lines.",
        );
      } finally {
        await f.close();
      }
    },
  );
});
