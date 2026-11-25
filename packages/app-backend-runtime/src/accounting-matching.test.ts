import { describe, expect, it } from "vitest";
import {
  RULE_OUT,
  applyChoice,
  decide,
  enterLabel,
  type BankRow,
  type Candidate,
  type Choice,
} from "../../../examples/accounting/matching.ts";

const candidate = (id: string, sure: boolean): Candidate => ({
  id,
  number: 7,
  date: "2026-05-10",
  memo: "Northwind",
  accounts: "Service revenue",
  sure,
});
const invoice = {
  id: "inv-1",
  number: "INV-0002",
  version: 2,
  dueDate: "2026-06-30",
  clientName: "Northwind",
  balanceCents: 90_000,
};
const row = (patch: Partial<BankRow>): BankRow => ({
  id: "row-1",
  importId: "import-1",
  lineNo: 1,
  bankAccountId: "1000",
  date: "2026-06-20",
  description: "NORTHWIND RETAINER",
  amountCents: 90_000,
  currency: "USD",
  status: "new",
  journalEntryId: null,
  journalNumber: null,
  reversedByNumber: null,
  original: null,
  rowHash: "hash",
  suggestedAccountId: null,
  match: null,
  payables: [],
  candidates: [],
  linked: false,
  confirmed: false,
  closed: false,
  ...patch,
});
const after = (bankRow: BankRow, ...patches: Choice[]) =>
  decide(
    bankRow,
    patches.reduce<Choice | undefined>(
      (stored, patch) => applyChoice(bankRow, stored, patch),
      undefined,
    ),
  );

describe("bank row decisions", () => {
  it("matches a single sure entry on Enter until it is ruled out", () => {
    const sure = row({ candidates: [candidate("entry-1", true)], suggestedAccountId: "4000" });
    const first = decide(sure);
    expect(first).toMatchObject({
      entry: { id: "entry-1" },
      undecided: false,
      matchesOnEnter: true,
    });
    expect(enterLabel(sure, first)).toBe("match");
    const ruledOut = after(sure, RULE_OUT);
    expect(ruledOut).toMatchObject({ entry: undefined, undecided: false, matchesOnEnter: false });
    expect(ruledOut.pick).toEqual({ id: "row-1", notMatched: ["entry-1"], accountId: "4000" });
    expect(enterLabel(sure, ruledOut)).toBe("post");
  });

  it("pays a new invoice from a row whose sure entry is ruled out", () => {
    const retainer = row({ candidates: [candidate("entry-1", true)], payables: [invoice] });
    const paying = after(retainer, { invoiceId: invoice.id, none: true });
    expect(paying).toMatchObject({
      entry: undefined,
      invoice: { id: invoice.id },
      notMatched: ["entry-1"],
      matchesOnEnter: true,
    });
    expect(enterLabel(retainer, paying)).toBe("record payment");
    const over = row({ ...retainer, amountCents: 95_000 });
    expect(enterLabel(over, after(over, { invoiceId: invoice.id, none: true }))).toBe("choose");
  });

  it("waits for a choice while a possible entry is unreviewed", () => {
    const maybe = row({
      candidates: [candidate("entry-1", false)],
      match: invoice,
      suggestedAccountId: "4000",
    });
    const waiting = decide(maybe);
    expect(waiting).toMatchObject({ entry: undefined, undecided: true, matchesOnEnter: false });
    expect(enterLabel(maybe, waiting)).toBe("choose");
    const none = after(maybe, { none: true });
    expect(none).toMatchObject({
      undecided: false,
      invoice: { id: invoice.id },
      matchesOnEnter: true,
    });
    expect(after(maybe, { none: true }, { entryId: "entry-1", none: false }).entry?.id).toBe(
      "entry-1",
    );
  });

  it("explains a split that does not add up and posts one that does", () => {
    const bankRow = row({ amountCents: -10_000 });
    const split = (first: string, second: string) =>
      after(bankRow, {
        splits: [
          { key: 1, accountId: "6000", amount: first, memo: "" },
          { key: 2, accountId: "6100", amount: second, memo: " Lunch " },
        ],
      }).pick;
    expect(split("60.00", "39.00")).toBe("Splits are off by $1.00");
    expect(split("60.00", "40.00")).toEqual({
      id: "row-1",
      splits: [
        { accountId: "6000", amountCents: 6_000 },
        { accountId: "6100", amountCents: 4_000, memo: "Lunch" },
      ],
    });
    expect(decide(bankRow).pick).toBe("Choose the other account");
  });

  it("never swaps the entry the operator chose for another one", () => {
    const left = row({ candidates: [candidate("entry-b", true)] });
    expect(decide(left, { entryId: "entry-a" })).toMatchObject({
      entry: undefined,
      undecided: true,
    });
    const gone = row({ candidates: [], suggestedAccountId: "4000" });
    const fallback = decide(gone, { entryId: "entry-a" });
    expect(fallback).toMatchObject({ entry: undefined, undecided: false });
    expect(enterLabel(gone, fallback)).toBe("post");
  });

  it("pays the invoice the operator chose over the suggested one", () => {
    const other = { ...invoice, id: "inv-2", number: "INV-0003", balanceCents: 180_000 };
    const suggested = row({
      match: invoice,
      payables: [invoice, other],
      suggestedAccountId: "4000",
    });
    expect(decide(suggested).invoice?.id).toBe("inv-1");
    const chosen = after(suggested, {
      invoiceId: "inv-2",
      entryId: undefined,
      accountId: undefined,
      splits: undefined,
      override: false,
      none: true,
    });
    expect(chosen.invoice?.id).toBe("inv-2");
    const paidElsewhere = { ...suggested, payables: [invoice] };
    const stored = applyChoice(suggested, undefined, {
      invoiceId: "inv-2",
      entryId: undefined,
      accountId: undefined,
      splits: undefined,
      override: false,
      none: true,
    });
    const gone = decide(paidElsewhere, stored);
    expect(gone).toMatchObject({ invoice: undefined, matchesOnEnter: false });
    expect(typeof gone.pick).toBe("string");
    expect(enterLabel(paidElsewhere, gone)).toBe("choose");
  });
});
