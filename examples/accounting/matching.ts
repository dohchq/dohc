import { money, parseAmount } from "./amounts";

export type Queue = "new" | "matched" | "duplicate" | "posted" | "ignored";

export interface Payable {
  id: string;
  number: string;
  version: number;
  dueDate: string;
  clientName: string;
  balanceCents: number;
  named?: boolean;
}

export interface Candidate {
  id: string;
  number: number;
  date: string;
  memo: string;
  accounts: string | null;
  sure: boolean;
}

export interface BankRow {
  id: string;
  importId: string;
  lineNo: number;
  bankAccountId: string;
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  status: "new" | "duplicate" | "posted" | "ignored";
  journalEntryId: string | null;
  journalNumber: number | null;
  reversedByNumber: number | null;
  original: { description: string; status: string; importedAtMs: number; journalNumber: number | null } | null;
  rowHash: string;
  suggestedAccountId: string | null;
  match: Payable | null;
  payables: Payable[];
  candidates: Candidate[];
  linked: boolean;
  confirmed: boolean;
  closed: boolean;
}

export interface Split {
  key: number;
  accountId: string;
  amount: string;
  memo: string;
  auto?: boolean;
}

export interface Choice {
  entryId?: string;
  invoiceId?: string;
  accountId?: string;
  memo?: string;
  splits?: Split[];
  override?: boolean;
  none?: boolean;
  seen?: string[];
  restAccountId?: string;
}

export interface Pick {
  id: string;
  notMatched?: string[];
  accountId?: string;
  memo?: string;
  splits?: Array<{ accountId: string; amountCents: number; memo?: string }>;
}

export interface Decision {
  choice: Choice;
  entry: Candidate | undefined;
  invoice: Payable | undefined;
  notMatched: string[];
  undecided: boolean;
  matchesOnEnter: boolean;
  needsRest: boolean;
  pick: Pick | string;
}

export const RULE_OUT: Choice = { override: true, entryId: undefined, invoiceId: undefined };

export function applyChoice(row: BankRow, stored: Choice | undefined, patch: Choice): Choice {
  return { ...stored, ...patch, ...(patch.override || patch.none ? { seen: row.candidates.map((candidate) => candidate.id) } : {}) };
}

function pickFor(row: BankRow, choice: Choice, notMatched: string[] | undefined): Pick | string {
  const memo = choice.memo?.trim();
  const base = { id: row.id, ...(notMatched ? { notMatched } : {}), ...(memo ? { memo } : {}) };
  if (!choice.splits) return choice.accountId ? { ...base, accountId: choice.accountId } : "Choose the other account";
  const splits = choice.splits
    .filter((split) => split.accountId || split.amount.trim())
    .map((split) => ({ accountId: split.accountId, amountCents: parseAmount(split.amount, row.currency), memo: split.memo.trim() }));
  if (splits.length < 2) return "Add a second split";
  if (splits.some((split) => !split.accountId)) return "Choose an account on each split";
  if (splits.some((split) => !split.amountCents || split.amountCents < 0)) return "Enter an amount on each split";
  const sum = splits.reduce((total, split) => total + split.amountCents!, 0);
  const amount = Math.abs(row.amountCents);
  if (sum !== amount) return `Splits are off by ${money(Math.abs(amount - sum), row.currency)}`;
  return { ...base, splits: splits.map((split) => ({ accountId: split.accountId, amountCents: split.amountCents!, ...(split.memo ? { memo: split.memo } : {}) })) };
}

export function decide(row: BankRow, stored: Choice = {}): Decision {
  const choice: Choice = { accountId: row.suggestedAccountId ?? undefined, ...stored };
  const notMatched = stored.override || stored.none ? (stored.seen ?? []) : [];
  const unseen = row.candidates.some((candidate) => !notMatched.includes(candidate.id));
  const entry =
    stored.none || stored.override || stored.invoiceId
      ? undefined
      : (row.candidates.find((candidate) => candidate.id === stored.entryId) ??
        (row.candidates.length === 1 && row.candidates[0]!.sure ? row.candidates[0] : undefined));
  const invoice = row.match ?? row.payables.find((item) => item.id === stored.invoiceId);
  const undecided = unseen && !entry;
  const overridden = Boolean(stored.override) && !unseen;
  return {
    choice,
    entry,
    invoice,
    notMatched,
    undecided,
    matchesOnEnter: Boolean(invoice || entry) && !overridden && !stored.accountId && !stored.splits && !undecided,
    needsRest: Boolean(invoice && row.amountCents > invoice.balanceCents && !stored.restAccountId),
    pick: pickFor(row, choice, row.candidates.length && !unseen ? notMatched : undefined),
  };
}

export function enterLabel(row: BankRow, decision: Decision): string | null {
  if (row.status === "duplicate") return row.confirmed ? null : "confirm";
  if (row.status === "ignored") return row.closed ? null : "restore";
  if (row.status === "posted") return "open";
  if (decision.undecided) return "choose";
  if (!decision.matchesOnEnter) return typeof decision.pick === "string" ? "choose" : "post";
  if (decision.entry) return "match";
  return decision.needsRest ? "choose" : "record payment";
}
