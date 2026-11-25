import { useEffect, useState } from "react";
import { Trash2 } from "dohc/icons";
import { Modal } from "dohc/ui";
import { cx, problem, shortDate, today, useBooks } from "./shared";
import { Kbd, useAction, useBooksContext, useInitialFocus, useToast } from "./parts";
import { money, parseAmount } from "./amounts";

export interface Reconciled {
  id: string;
  bankAccountId: string;
  accountName: string;
  currency: string;
  date: string;
  balanceCents: number;
  waiting: number;
  holds: boolean;
}

interface StatementCheck {
  bankAccountId: string;
  currency: string;
  date: string;
  booksCents: number;
  clearedCents: number;
  outstanding: Array<{ id: string; number: number; date: string; memo: string; amountCents: number; clearedOn: string | null }>;
  outstandingCount: number;
  firstWaiting: string | null;
  waiting: number;
  reviewQueue: "new" | "matched" | "duplicate" | null;
  currencies: string[];
  reconciliationId: string | null;
  reconciledCents: number | null;
}

function monthBefore(day: string) {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
}

export function ReconcileSheet({
  last,
  initial,
  onClose,
  onReview,
}: {
  last: Reconciled[];
  initial: Reconciled | null;
  onClose: () => void;
  onReview: (queue: "new" | "matched" | "duplicate") => void;
}) {
  const { accounts, currency: booksCurrency, overview } = useBooksContext();
  const { run, pending } = useAction();
  const toast = useToast();
  const banks = accounts.filter((account) => account.isBank && !account.archived);
  const [bankAccountId, setBankAccountId] = useState(initial?.bankAccountId ?? banks[0]?.id ?? "");
  const [chosen, setChosen] = useState<string | null>(initial?.currency ?? null);
  const [asOf, setAsOf] = useState(() => initial?.date ?? overview?.today ?? today());
  const [dated, setDated] = useState(Boolean(initial));
  const [ending, setEnding] = useState("");
  const [shownFor, setShownFor] = useState<string | null>(null);
  const field = useInitialFocus<HTMLInputElement>();
  const check = useBooks<StatementCheck>("reconcileStatus", { bankAccountId, date: asOf, ...(chosen ? { currency: chosen } : {}) }, {
    enabled: Boolean(bankAccountId) && /^\d{4}-\d{2}-\d{2}$/.test(asOf),
  });
  const currency = check.data?.currency ?? chosen ?? booksCurrency;
  const current = check.data?.bankAccountId === bankAccountId && check.data.date === asOf && (!chosen || check.data.currency === chosen);
  const booksCents = check.data?.booksCents ?? null;
  const clearedCents = check.data?.clearedCents ?? null;
  const outstanding = check.data?.outstanding ?? [];
  const statementCents = ending.trim() ? parseAmount(ending, currency) : null;
  const difference = clearedCents !== null && statementCents !== null ? statementCents - clearedCents : null;
  const open = check.data?.waiting ?? 0;
  const already = check.data ? check.data.reconciledCents !== null : false;
  const lockedThrough = overview?.periods.lockedThrough;
  const closed = Boolean(lockedThrough && asOf.slice(0, 7) <= lockedThrough);
  const currencies = check.data?.currencies.length ? check.data.currencies : [currency];
  const previous = last.find((item) => item.bankAccountId === bankAccountId && item.currency === currency);
  const ready = difference === 0 && !open && !already && current && pending === null;
  const firstWaiting = current ? check.data?.firstWaiting ?? null : null;
  useEffect(() => {
    if (dated || !firstWaiting || firstWaiting > asOf) return;
    const suggested = monthBefore(firstWaiting);
    setDated(true);
    if (!previous || suggested > previous.date) setAsOf(suggested);
  }, [dated, firstWaiting, asOf, previous]);
  const listKey = `${bankAccountId} ${asOf} ${chosen ?? ""}`;
  const allShown = shownFor === listKey;
  const shown = allShown ? outstanding : outstanding.slice(0, 5);
  const hiddenCount = (check.data?.outstandingCount ?? 0) - shown.length;
  const remove = () => {
    const id = check.data?.reconciliationId;
    const balanceCents = check.data?.reconciledCents;
    if (!id || balanceCents === null || balanceCents === undefined) return;
    void run("removeReconciliation", { id }, {
      failed: "Could not remove the reconciliation",
      after: () =>
        toast({
          message: `Removed the reconciliation on ${shortDate(asOf, true)}`,
          undo: () => void run("reconcileBank", { bankAccountId, date: asOf, currency, balanceCents }, { done: "Reconciled again", failed: "Could not reconcile again" }),
        }),
    });
  };
  const save = () => {
    if (!ready || statementCents === null) return;
    void run<{ id: string }>("reconcileBank", { bankAccountId, date: asOf, currency, balanceCents: statementCents }, {
      failed: "Could not reconcile",
      after: (result) => {
        onClose();
        toast({
          message: `Reconciled through ${shortDate(asOf, true)}`,
          undo: () => void run("removeReconciliation", { id: result.id }, { done: "Reconciliation removed", failed: "Could not undo the reconciliation" }),
        });
      },
    });
  };
  return (
    <Modal
      open
      title="Reconcile a bank account"
      onClose={onClose}
      footer={
        <div className="b-composer-foot">
          <span className={cx("b-balance-label", difference ? "is-negative" : undefined)} aria-live="polite">
            {already
              ? open
                ? `Reconciled at ${money(check.data!.reconciledCents!, currency)}, ${open} ${open === 1 ? "row" : "rows"} to review`
                : check.data!.reconciledCents === clearedCents
                  ? `Reconciled at ${money(check.data!.reconciledCents!, currency)} on this date`
                  : `Reconciled at ${money(check.data!.reconciledCents!, currency)}, the statement should now show ${money(clearedCents ?? 0, currency)}`
              : open
              ? `${open} ${open === 1 ? "row" : "rows"} to review first`
              : difference === null
                ? previous
                  ? `Last reconciled through ${shortDate(previous.date, true)}`
                  : null
                : difference === 0
                  ? "The books match the statement"
                  : `Off by ${money(Math.abs(difference), currency)}`}
          </span>
          {open ? (
            <button type="button" className="b-btn" onClick={() => onReview(check.data?.reviewQueue ?? "new")}>
              Review rows
            </button>
          ) : null}
          {already && !closed ? (
            <button type="button" className="b-btn" disabled={pending !== null} onClick={remove}>
              <Trash2 size={14} aria-hidden />
              Remove
            </button>
          ) : null}
          <button type="button" className="b-btn b-btn-primary" disabled={!ready} onClick={save}>
            Reconcile <Kbd>↵</Kbd>
          </button>
        </div>
      }
    >
      <form
        className="b-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="b-field">
          <span className="b-field-label">Bank account</span>
          <select className="b-select" value={bankAccountId} onChange={(event) => (setBankAccountId(event.target.value), setChosen(null))}>
            {banks.map((account) => (
              <option key={account.id} value={account.id}>
                {account.id} {account.name}
              </option>
            ))}
          </select>
        </label>
        {currencies.length > 1 ? (
          <label className="b-field">
            <span className="b-field-label">Currency</span>
            <select className="b-select" value={currency} onChange={(event) => setChosen(event.target.value)}>
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="b-field">
          <span className="b-field-label">Statement date</span>
          <input className="b-input b-input-date" type="date" max={overview?.today ?? today()} value={asOf} onChange={(event) => (setDated(true), setAsOf(event.target.value))} />
        </label>
        <label className="b-field">
          <span className="b-field-label">Ending balance on the statement</span>
          <input ref={field} className={cx("b-input b-input-amount", ending.trim() && statementCents === null && "is-invalid")} inputMode="decimal" value={ending} onChange={(event) => setEnding(event.target.value)} />
        </label>
        <div className="b-field">
          <span className="b-field-label">Should be on the statement</span>
          <span className="b-reconcile-books b-mono">{check.error ? problem(check.error) : clearedCents === null ? "…" : money(clearedCents, currency)}</span>
        </div>
        {outstanding.length ? (
          <div className="b-field b-outstanding">
            <span className="b-field-label">Timing differences on {shortDate(asOf, true)}</span>
            <ul>
              {shown.map((item) => (
                <li key={item.id}>
                  <span className="b-mono">#{item.number}</span>
                  <span className="b-date">{shortDate(item.date)}</span>
                  <span className="b-candidate-memo">
                    {item.memo || "No memo"}
                    <span className="b-subtle">
                      {" "}
                      ·{" "}
                      {item.date > asOf
                        ? `on the statement ${shortDate(item.clearedOn!)}, in the books later`
                        : item.clearedOn
                          ? `clears ${shortDate(item.clearedOn)}`
                          : "not on a statement yet"}
                    </span>
                  </span>
                  <span className={cx("b-num", item.amountCents > 0 && "is-positive")}>{money(item.amountCents, currency)}</span>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              allShown || outstanding.length <= 5 ? (
                <span className="b-subtle">{hiddenCount} more not listed</span>
              ) : (
                <button type="button" className="b-link" onClick={() => setShownFor(listKey)}>
                  Show {Math.min(hiddenCount, outstanding.length - 5)} more
                </button>
              )
            ) : null}
            <p className="b-outstanding-books">
              <span>In the books</span>
              <span className="b-num">{money(booksCents ?? 0, currency)}</span>
            </p>
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
