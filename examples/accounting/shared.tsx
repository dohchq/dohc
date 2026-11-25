import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyText, useDatasetQuery, type AppBackendError } from "dohc/app";
import { BarChart } from "dohc/charts";
import { ArrowLeft, Check, Copy, Download, RotateCcw, TriangleAlert } from "dohc/icons";
import { compactMoney, majorUnits, money } from "./amounts";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export interface AccountTotal {
  id: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}
export interface TrialBalance {
  asOf: string;
  currency: string;
  rows: Array<AccountTotal & { debitBalanceCents: number; creditBalanceCents: number }>;
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
}
export interface IncomeStatement {
  from: string;
  to: string;
  currency: string;
  income: AccountTotal[];
  expenses: AccountTotal[];
  totalIncomeCents: number;
  totalExpenseCents: number;
  netIncomeCents: number;
  months: Array<{ month: string; incomeCents: number; expenseCents: number }>;
}
export interface BalanceSheet {
  asOf: string;
  yearStart: string;
  currency: string;
  assets: AccountTotal[];
  liabilities: AccountTotal[];
  equity: AccountTotal[];
  retainedEarningsCents: number;
  earningsCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  balanced: boolean;
}
export interface LedgerRow {
  entryId: string;
  number: number;
  date: string;
  memo: string;
  lineNo: number;
  lineMemo: string | null;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
}
export interface Ledger {
  account: { id: string; name: string; type: AccountType };
  currency: string;
  from: string;
  to: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  rows: LedgerRow[];
  nextAfter: { date: string; number: number; lineNo: number } | null;
}
export interface BooksInfo {
  name: string | null;
  fiscalStartMonth: number;
  currencies: Array<{ currency: string; entries: number; firstDate: string; lastDate: string }>;
  accounts: Array<{ id: string; name: string; type: AccountType }>;
  periods: Array<{ id: string; startDate: string; endDate: string; status: "open" | "locked" }>;
}

export const TYPE_LABEL: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function shortDate(iso: string, withYear = false) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString(undefined, {
    ...(withYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
export function longDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
export function problem(error: unknown) {
  if (error && typeof error === "object" && "message" in error)
    return String((error as Error).message);
  return "Something went wrong.";
}
export function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

export function CopyButton({
  text,
  className,
  size = 14,
}: {
  text: string;
  className: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() =>
        void copyText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? <Check size={size} aria-hidden /> : <Copy size={size} aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function useBooks<T>(
  operation: string,
  input?: unknown,
  options: { enabled?: boolean; keep?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  const query = useDatasetQuery<T>(operation, input, { enabled });
  const last = useRef<T | undefined>(undefined);
  if (query.data !== undefined) last.current = query.data;
  const data =
    query.data !== undefined
      ? query.data
      : enabled && options.keep && !query.error
        ? last.current
        : undefined;
  return { ...query, data, refreshing: query.loading && data !== undefined };
}

export function Failure({
  error,
  retry,
  title = "Could not load this",
}: {
  error: AppBackendError | Error;
  retry?: () => void;
  title?: string;
}) {
  return (
    <div className="b-failure" role="alert">
      <TriangleAlert size={16} aria-hidden />
      <div className="b-failure-text">
        <strong>{title}</strong>
        <span>{problem(error)}</span>
      </div>
      <div className="b-failure-actions">
        {retry ? (
          <button type="button" className="b-btn b-btn-sm" onClick={retry}>
            <RotateCcw size={14} aria-hidden />
            Try again
          </button>
        ) : null}
        <CopyButton className="b-btn b-btn-sm b-btn-ghost" text={`${title}: ${problem(error)}`} />
      </div>
    </div>
  );
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="b-loading" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} style={{ width: `${92 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

const PRINT_HTML_CSS = `:root{color-scheme:light}body{font:13px/1.5 "Iowan Old Style","Charter",Georgia,serif;color:#1c1b18;background:#fff;margin:40px auto;max-width:760px;padding:0 24px}
.b-sheet-head{text-align:center;margin-bottom:24px}.b-sheet-head p{margin:2px 0;color:#55524a;font-size:12px;letter-spacing:.02em}.b-sheet-head h2{margin:4px 0;font-size:20px;font-weight:600}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:5px 0;text-align:left;vertical-align:baseline}
.b-num{text-align:right;white-space:nowrap;font-family:ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;font-size:12px}
.b-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#7f7b6e;margin-right:8px}
.b-st-section th{padding-top:18px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#55524a;font-weight:600}
.b-st-row td:first-child{padding-left:12px}.b-st-total td{border-top:1px solid #1c1b18;font-weight:600}
.b-st-grand td{border-top:1px solid #1c1b18;border-bottom:3px double #1c1b18;font-weight:700;padding:8px 0}
.b-st-head th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#55524a;border-bottom:1px solid #1c1b18;font-weight:600}
.b-st-check{margin-top:16px;font-size:12px;color:#38684e}.b-st-check.is-off{color:#9d3c28}.b-st-account{all:unset}
.b-pill{border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px}
.b-invoice{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}.b-invoice-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:28px}
.b-invoice-kicker{margin:0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#55524a}.b-invoice-head h2{margin:2px 0 0;font-size:24px;font-weight:600;white-space:nowrap}
.b-invoice-number{display:flex;align-items:center;gap:10px}.b-invoice-from{font-style:normal;text-align:right;color:#55524a;line-height:1.5}.b-invoice-from strong{display:block;color:#1c1b18}.b-invoice-from span{display:block}
.b-invoice-meta{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:24px;margin:0 0 32px}.b-invoice-meta dt{color:#55524a;font-size:11px;margin-top:6px}.b-invoice-meta dd{margin:2px 0 0}.b-invoice-meta dd span{display:block}
.b-invoice-due{text-align:right}.b-invoice-due dd{font-size:20px;font-weight:600}.b-invoice-due dd.is-void{text-decoration:line-through;color:#7f7b6e}
.b-invoice-lines th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#55524a;border-bottom:1px solid #1c1b18;font-weight:600}.b-invoice-lines tbody td{border-bottom:1px solid #dedad0;padding:9px 0}
.b-invoice-lines tfoot td{padding:6px 0;color:#55524a}.b-invoice-lines tfoot td:first-child{text-align:right;padding-right:24px}.b-invoice-total td{border-top:1px solid #1c1b18;color:#1c1b18!important;font-weight:700;font-size:14px}
.b-invoice-notes,.b-invoice-paid{margin-top:28px;padding-top:16px;border-top:1px solid #dedad0;color:#55524a}.b-pre{white-space:pre-line}
.b-muted{color:#55524a}.print-bar{display:flex;justify-content:flex-end;margin-bottom:16px}.print-bar button{padding:6px 12px;font:inherit;cursor:pointer}
@media print{.print-bar{display:none}body{margin:0;max-width:none;padding:0}tr{break-inside:avoid}}`;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function downloadPrintableHtml(filename: string, title: string, node: HTMLElement | null) {
  if (!node) return;
  const clone = node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".b-no-print").forEach((element) => element.remove());
  clone
    .querySelectorAll("button")
    .forEach((button) => button.replaceWith(...Array.from(button.childNodes)));
  clone.querySelectorAll("svg").forEach((element) => element.remove());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PRINT_HTML_CSS}</style></head><body><div class="print-bar"><button type="button" onclick="window.print()">Print</button></div>${clone.innerHTML}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Amount({ cents, currency }: { cents: number; currency: string }) {
  return <>{money(cents, currency)}</>;
}

type OpenAccount = ((id: string) => void) | undefined;

function AccountName({
  row,
  onAccount,
}: {
  row: { id: string; name: string };
  onAccount: OpenAccount;
}) {
  const label = (
    <span className="b-acct">
      {row.id ? <span className="b-code">{row.id}</span> : null}
      <span>{row.name}</span>
    </span>
  );
  return row.id && onAccount ? (
    <button
      type="button"
      className="b-st-account"
      onClick={() => onAccount(row.id)}
      title={`Open the ${row.name} ledger`}
    >
      {label}
    </button>
  ) : (
    label
  );
}

function StatementSection({
  title,
  rows,
  totalLabel,
  totalCents,
  currency,
  onAccount,
}: {
  title: string;
  rows: Array<{ id: string; name: string; balanceCents: number }>;
  totalLabel: string;
  totalCents: number;
  currency: string;
  onAccount: OpenAccount;
}) {
  return (
    <tbody>
      <tr className="b-st-section">
        <th colSpan={2} scope="rowgroup">
          {title}
        </th>
      </tr>
      {rows.length ? (
        rows.map((row) => (
          <tr key={row.id || row.name} className="b-st-row">
            <td>
              <AccountName row={row} onAccount={onAccount} />
            </td>
            <td className="b-num">
              <Amount cents={row.balanceCents} currency={currency} />
            </td>
          </tr>
        ))
      ) : (
        <tr className="b-st-row">
          <td className="b-muted">No activity</td>
          <td />
        </tr>
      )}
      <tr className="b-st-total">
        <td>{totalLabel}</td>
        <td className="b-num">
          <Amount cents={totalCents} currency={currency} />
        </td>
      </tr>
    </tbody>
  );
}

export function TrialBalanceView({
  report,
  onAccount,
}: {
  report: TrialBalance;
  onAccount?: OpenAccount;
}) {
  return (
    <table className="b-statement">
      <thead>
        <tr className="b-st-head">
          <th>Account</th>
          <th className="b-num">Debit</th>
          <th className="b-num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={row.id} className="b-st-row">
            <td>
              <AccountName row={row} onAccount={onAccount} />
            </td>
            <td className="b-num">
              {row.debitBalanceCents ? (
                <Amount cents={row.debitBalanceCents} currency={report.currency} />
              ) : (
                ""
              )}
            </td>
            <td className="b-num">
              {row.creditBalanceCents ? (
                <Amount cents={row.creditBalanceCents} currency={report.currency} />
              ) : (
                ""
              )}
            </td>
          </tr>
        ))}
        <tr className="b-st-grand">
          <td>Total</td>
          <td className="b-num">
            <Amount cents={report.totalDebitCents} currency={report.currency} />
          </td>
          <td className="b-num">
            <Amount cents={report.totalCreditCents} currency={report.currency} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function IncomeStatementView({
  report,
  onAccount,
}: {
  report: IncomeStatement;
  onAccount?: OpenAccount;
}) {
  return (
    <table className="b-statement">
      <StatementSection
        title="Income"
        rows={report.income}
        totalLabel="Total income"
        totalCents={report.totalIncomeCents}
        currency={report.currency}
        onAccount={onAccount}
      />
      <StatementSection
        title="Expenses"
        rows={report.expenses}
        totalLabel="Total expenses"
        totalCents={report.totalExpenseCents}
        currency={report.currency}
        onAccount={onAccount}
      />
      <tbody>
        <tr className="b-st-grand">
          <td>Net income</td>
          <td className="b-num">
            <Amount cents={report.netIncomeCents} currency={report.currency} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function BalanceSheetView({
  report,
  onAccount,
}: {
  report: BalanceSheet;
  onAccount?: OpenAccount;
}) {
  const equity = [
    ...report.equity,
    ...(report.retainedEarningsCents
      ? [{ id: "", name: "Retained earnings", balanceCents: report.retainedEarningsCents }]
      : []),
    {
      id: "",
      name: `Current earnings, ${fiscalLabel(report.yearStart, Number(report.yearStart.slice(5, 7)))}`,
      balanceCents: report.earningsCents,
    },
  ];
  return (
    <table className="b-statement">
      <StatementSection
        title="Assets"
        rows={report.assets}
        totalLabel="Total assets"
        totalCents={report.totalAssetsCents}
        currency={report.currency}
        onAccount={onAccount}
      />
      <StatementSection
        title="Liabilities"
        rows={report.liabilities}
        totalLabel="Total liabilities"
        totalCents={report.totalLiabilitiesCents}
        currency={report.currency}
        onAccount={onAccount}
      />
      <StatementSection
        title="Equity"
        rows={equity}
        totalLabel="Total equity"
        totalCents={report.totalEquityCents}
        currency={report.currency}
        onAccount={onAccount}
      />
      <tbody>
        <tr className="b-st-grand">
          <td>Liabilities and equity</td>
          <td className="b-num">
            <Amount
              cents={report.totalLiabilitiesCents + report.totalEquityCents}
              currency={report.currency}
            />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

type PageState = { revision: number | null; after: Ledger["nextAfter"] };
const sameCursor = (a: Ledger["nextAfter"], b: Ledger["nextAfter"]) =>
  a === b || Boolean(a && b && a.date === b.date && a.number === b.number && a.lineNo === b.lineNo);

function LedgerView({
  accountId,
  currency,
  from,
  to,
  loadAll,
  onState,
}: {
  accountId: string;
  currency: string;
  from: string;
  to: string;
  loadAll: boolean;
  onState: (ready: boolean) => void;
}) {
  const [pages, setPages] = useState<Array<Ledger["nextAfter"]>>([null]);
  const [readyPages, setReadyPages] = useState<Record<number, PageState | null>>({});
  const states = pages.map((_, index) => readyPages[index]);
  const allReady = states.every(
    (state, index) =>
      state &&
      sameCursor(state.after, pages[index] ?? null) &&
      state.revision === states[0]?.revision,
  );
  useEffect(() => {
    onState(allReady);
  }, [onState, allReady]);
  const onPageState = useCallback(
    (pageIndex: number, state: PageState | null, next: Ledger["nextAfter"] | undefined) => {
      setReadyPages((map) => ({ ...map, [pageIndex]: state }));
      if (next === undefined) return;
      setPages((list) => {
        if (pageIndex + 1 >= list.length) return list;
        if (!next) return list.slice(0, pageIndex + 1);
        if (sameCursor(list[pageIndex + 1] ?? null, next)) return list;
        return list.map((item, at) => (at === pageIndex + 1 ? next : item));
      });
    },
    [],
  );
  return (
    <table className="b-statement b-ledger">
      <thead>
        <tr className="b-st-head">
          <th>Date</th>
          <th className="b-num">No.</th>
          <th>Memo</th>
          <th className="b-num">Debit</th>
          <th className="b-num">Credit</th>
          <th className="b-num">Balance</th>
        </tr>
      </thead>
      {pages.map((after, index) => (
        <LedgerPage
          key={`${accountId}:${currency}:${from}:${to}:${index}`}
          pageIndex={index}
          input={{ accountId, currency, from, to, limit: 100, after }}
          first={index === 0}
          loadAll={loadAll}
          onPageState={onPageState}
          onMore={
            index === pages.length - 1
              ? (next) => {
                  onState(false);
                  setPages((list) => (list.length === index + 1 ? [...list, next] : list));
                }
              : undefined
          }
        />
      ))}
    </table>
  );
}
function LedgerPage({
  pageIndex,
  input,
  first,
  loadAll,
  onPageState,
  onMore,
}: {
  pageIndex: number;
  input: {
    accountId: string;
    currency: string;
    from: string;
    to: string;
    limit: number;
    after: Ledger["nextAfter"];
  };
  first: boolean;
  loadAll: boolean;
  onPageState: (
    pageIndex: number,
    state: PageState | null,
    next: Ledger["nextAfter"] | undefined,
  ) => void;
  onMore?: (next: NonNullable<Ledger["nextAfter"]>) => void;
}) {
  const { data, loading, error, reload, revision } = useBooks<Ledger>("accountLedger", input);
  const settled = !loading && !error && data ? data.nextAfter : undefined;
  const ready = settled !== undefined && !(onMore && settled);
  const after = input.after;
  useEffect(() => {
    onPageState(pageIndex, ready ? { revision, after } : null, settled);
  }, [onPageState, pageIndex, ready, settled, revision, after]);
  useEffect(() => {
    if (loadAll && settled && onMore) onMore(settled);
  }, [loadAll, settled, onMore]);
  if (error || loading || !data)
    return (
      <tbody>
        <tr>
          <td colSpan={6}>
            {error ? <Failure error={error} retry={reload} /> : <Loading rows={4} />}
          </td>
        </tr>
      </tbody>
    );
  return (
    <tbody>
      {first ? (
        <tr className="b-st-section">
          <th colSpan={5} scope="row">
            Opening balance
          </th>
          <td className="b-num">
            <Amount cents={data.openingBalanceCents} currency={data.currency} />
          </td>
        </tr>
      ) : null}
      {data.rows.map((row) => (
        <tr key={`${row.entryId}:${row.lineNo}`} className="b-st-row">
          <td className="b-date">
            {shortDate(
              row.date,
              row.date.slice(0, 4) !== input.from.slice(0, 4) ||
                input.from.slice(0, 4) !== input.to.slice(0, 4),
            )}
          </td>
          <td className="b-num">{row.number}</td>
          <td className="b-ledger-memo">{row.lineMemo || row.memo}</td>
          <td className="b-num">
            {row.debitCents ? <Amount cents={row.debitCents} currency={data.currency} /> : ""}
          </td>
          <td className="b-num">
            {row.creditCents ? <Amount cents={row.creditCents} currency={data.currency} /> : ""}
          </td>
          <td className="b-num">
            <Amount cents={row.balanceCents} currency={data.currency} />
          </td>
        </tr>
      ))}
      {data.nextAfter ? (
        onMore ? (
          <tr className="b-no-print">
            <td colSpan={6}>
              <button
                type="button"
                className="b-btn b-btn-sm"
                onClick={() => onMore(data.nextAfter!)}
              >
                Show more lines
              </button>
            </td>
          </tr>
        ) : null
      ) : (
        <tr className="b-st-grand">
          <td colSpan={5}>Closing balance</td>
          <td className="b-num">
            <Amount cents={data.closingBalanceCents} currency={data.currency} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function ReportBody<T>({
  operation,
  input,
  onState,
  render,
}: {
  operation: string;
  input: unknown;
  onState: (ready: boolean) => void;
  render: (data: T) => ReactNode;
}) {
  const { data, loading, error, reload } = useBooks<T>(operation, input);
  const ready = !loading && !error && Boolean(data);
  useEffect(() => {
    onState(ready);
  }, [onState, ready]);
  if (error) return <Failure error={error} retry={reload} />;
  if (loading || !data) return <Loading rows={10} />;
  return <>{render(data)}</>;
}

export const REPORTS = {
  trialBalance: "Trial balance",
  incomeStatement: "Income statement",
  balanceSheet: "Balance sheet",
  accountLedger: "Account ledger",
} as const;
export type ReportId = keyof typeof REPORTS;

export function Tablist<T extends string>({
  label,
  items,
  value,
  onChange,
  className,
}: {
  label: string;
  items: Array<{ id: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number) => {
    const next = (index + items.length) % items.length;
    refs.current[next]?.focus();
    onChange(items[next]!.id);
  };
  const [more, setMore] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const measure = () => setMore(node.scrollWidth - node.clientWidth - node.scrollLeft > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [items.length]);
  return (
    <div
      ref={strip}
      className={cx("b-seg", more && "has-more", className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          className="b-seg-item"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index - 1);
            }
          }}
        >
          {item.label}
          {item.count !== undefined ? <span className="b-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function fiscalEndYear(day: string, startMonth: number) {
  const year = Number(day.slice(0, 4));
  return startMonth !== 1 && Number(day.slice(5, 7)) >= startMonth ? year + 1 : year;
}

export function fiscalLabel(day: string, startMonth: number) {
  return `${startMonth === 1 ? "" : "FY"}${fiscalEndYear(day, startMonth)}`;
}

function fiscalYear(day: string, startMonth: number) {
  const year = Number(day.slice(0, 4));
  const startYear = Number(day.slice(5, 7)) >= startMonth ? year : year - 1;
  const from = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const lastFrom = `${startYear - 1}${from.slice(4)}`;
  const before = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { from, last: { from: lastFrom, to: before } };
}

export function presetRanges(now: string, startMonth: number) {
  const year = Number(now.slice(0, 4));
  const month = Number(now.slice(5, 7));
  const pad = (value: number) => String(value).padStart(2, "0");
  const end = (y: number, m: number) =>
    `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  const quarter = Math.floor((month - 1) / 3) * 3 + 1;
  const lastMonth = month === 1 ? [year - 1, 12] : [year, month - 1];
  const fiscal = fiscalYear(now, startMonth);
  return {
    ytd: { label: "Year to date", from: fiscal.from, to: now },
    month: { label: "This month", from: `${year}-${pad(month)}-01`, to: now },
    lastMonth: {
      label: "Last month",
      from: `${lastMonth[0]}-${pad(lastMonth[1]!)}-01`,
      to: end(lastMonth[0]!, lastMonth[1]!),
    },
    quarter: { label: "This quarter", from: `${year}-${pad(quarter)}-01`, to: now },
    lastYear: { label: "Last year", from: fiscal.last.from, to: fiscal.last.to },
  } as const;
}

export function Reports({
  initial = "trialBalance",
  initialAccount,
  heading,
  badge,
}: {
  initial?: ReportId;
  initialAccount?: string;
  heading?: ReactNode;
  badge?: ReactNode;
}) {
  const info = useBooks<BooksInfo>("booksInfo", {});
  const bookName = info.data?.name ?? "Books";
  const now = today();
  const startMonth = info.data?.fiscalStartMonth ?? 1;
  const presets = presetRanges(now, startMonth);
  const [tab, setTab] = useState<ReportId>(initial);
  const [chosenFrom, setFrom] = useState<string | null>(null);
  const from = chosenFrom ?? presets.ytd.from;
  const [to, setTo] = useState(now);
  const [currency, setCurrency] = useState("");
  const [accountId, setAccountId] = useState(initialAccount ?? "1000");
  const [returnTo, setReturnTo] = useState<ReportId | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [wantAll, setWantAll] = useState<string | null>(null);
  const statementRef = useRef<HTMLDivElement>(null);
  const currencies = info.data?.currencies.map((row) => row.currency) ?? [];
  const code = currency || currencies[0] || "USD";
  const usesRange = tab === "incomeStatement" || tab === "accountLedger";
  const queryKey = JSON.stringify([
    tab,
    usesRange ? from : "",
    to,
    code,
    tab === "accountLedger" ? accountId : "",
  ]);
  const onReportState = useCallback(
    (ready: boolean) =>
      setReadyKey((current) => (ready ? queryKey : current === queryKey ? null : current)),
    [queryKey],
  );
  const download = useCallback(
    () =>
      downloadPrintableHtml(
        `${tab}-${to}.html`,
        `${bookName} - ${REPORTS[tab]}`,
        statementRef.current,
      ),
    [tab, to, bookName],
  );
  useEffect(() => {
    if (wantAll === null || wantAll !== queryKey || readyKey !== queryKey) return;
    setWantAll(null);
    download();
  }, [wantAll, queryKey, readyKey, download]);
  const drill = (id: string) => {
    setReturnTo(tab === "accountLedger" ? returnTo : tab);
    setAccountId(id);
    if (!usesRange) setFrom(fiscalYear(to, startMonth).from);
    setTab("accountLedger");
  };
  if (info.error)
    return <Failure error={info.error} retry={info.reload} title="Could not load the books" />;
  if (info.loading || !info.data) return <Loading rows={12} />;
  const account = info.data.accounts.find((row) => row.id === accountId);
  const valid = usesRange
    ? /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to
    : /^\d{4}-\d{2}-\d{2}$/.test(to);
  const period = usesRange ? `${longDate(from)} to ${longDate(to)}` : `As of ${longDate(to)}`;
  const preset =
    Object.entries(presets).find(([, range]) => range.from === from && range.to === to)?.[0] ??
    "custom";
  const tabs = (
    <Tablist
      label="Reports"
      value={tab}
      onChange={(next) => {
        setReturnTo(null);
        setTab(next);
      }}
      items={(Object.keys(REPORTS) as ReportId[]).map((id) => ({ id, label: REPORTS[id] }))}
    />
  );
  return (
    <div className="b-reports">
      {heading ? (
        <header className="b-portal-head b-no-print">
          {heading}
          {tabs}
          {badge}
        </header>
      ) : null}
      <div className="b-reports-bar b-no-print">
        {heading ? null : tabs}
        <div className="b-reports-controls">
          {usesRange ? (
            <>
              <select
                className="b-select"
                aria-label="Period"
                value={preset}
                onChange={(event) => {
                  const range = presets[event.target.value as keyof typeof presets];
                  if (!range) return;
                  setFrom(range.from);
                  setTo(range.to);
                }}
              >
                {Object.entries(presets).map(([id, range]) => (
                  <option key={id} value={id}>
                    {range.label}
                  </option>
                ))}
                <option value="custom" disabled>
                  Custom
                </option>
              </select>
              <input
                className="b-input b-input-date"
                aria-label="From"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <span className="b-muted">to</span>
            </>
          ) : null}
          <input
            className="b-input b-input-date"
            aria-label={usesRange ? "To" : "As of"}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          {currencies.length > 1 ? (
            <select
              className="b-select"
              aria-label="Currency"
              value={code}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {currencies.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          ) : null}
          {tab === "accountLedger" ? (
            <select
              className="b-select"
              aria-label="Account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {info.data.accounts.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} {row.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="b-btn"
            disabled={
              !valid || wantAll === queryKey || (tab !== "accountLedger" && readyKey !== queryKey)
            }
            onClick={() => (readyKey === queryKey ? download() : setWantAll(queryKey))}
          >
            <Download size={14} aria-hidden />
            {wantAll === queryKey ? (
              "Loading every line…"
            ) : (
              <span>
                Download<span className="b-btn-more"> printable HTML</span>
              </span>
            )}
          </button>
        </div>
      </div>
      <div className="b-paper" ref={statementRef}>
        {returnTo ? (
          <button
            type="button"
            className="b-back b-no-print"
            onClick={() => (setTab(returnTo), setReturnTo(null))}
          >
            <ArrowLeft size={14} aria-hidden />
            Back to {REPORTS[returnTo].toLowerCase()}
          </button>
        ) : null}
        <header className="b-sheet-head">
          <p>{bookName}</p>
          <h2>
            {REPORTS[tab]}
            {tab === "accountLedger" && account ? ` · ${account.id} ${account.name}` : ""}
          </h2>
          <p>
            {period} · {code}
          </p>
        </header>
        {!valid ? (
          <p className="b-muted b-center">
            {usesRange ? "Choose a start date on or before the end date." : "Choose a valid date."}
          </p>
        ) : tab === "trialBalance" ? (
          <ReportBody<TrialBalance>
            operation="trialBalance"
            input={{ asOf: to, currency: code }}
            onState={onReportState}
            render={(report) => (
              <>
                <TrialBalanceView report={report} onAccount={drill} />
                <Balanced ok={report.balanced} />
              </>
            )}
          />
        ) : tab === "incomeStatement" ? (
          <ReportBody<IncomeStatement>
            operation="incomeStatement"
            input={{ from, to, currency: code }}
            onState={onReportState}
            render={(report) => (
              <>
                {report.months.length > 1 ? (
                  <div className="b-no-print b-report-chart">
                    <BarChart
                      labels={report.months.map((row) => shortMonth(row.month))}
                      series={[
                        {
                          name: "Income",
                          values: report.months.map((row) => majorUnits(row.incomeCents, code)),
                        },
                        {
                          name: "Expenses",
                          values: report.months.map((row) => majorUnits(row.expenseCents, code)),
                        },
                      ]}
                      height={160}
                      formatValue={(value) => compactMoney(value, code)}
                      ariaLabel="Income and expenses by month"
                    />
                  </div>
                ) : null}
                <IncomeStatementView report={report} onAccount={drill} />
              </>
            )}
          />
        ) : tab === "balanceSheet" ? (
          <ReportBody<BalanceSheet>
            operation="balanceSheet"
            input={{ asOf: to, currency: code }}
            onState={onReportState}
            render={(report) => (
              <>
                <BalanceSheetView report={report} onAccount={drill} />
                <Balanced ok={report.balanced} />
              </>
            )}
          />
        ) : (
          <LedgerView
            key={`${accountId}:${code}:${from}:${to}`}
            accountId={accountId}
            currency={code}
            from={from}
            to={to}
            loadAll={wantAll === queryKey}
            onState={onReportState}
          />
        )}
      </div>
    </div>
  );
}

export function shortMonth(month: string, withYear = false) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, value! - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

function Balanced({ ok }: { ok: boolean }) {
  return (
    <p className={cx("b-st-check", !ok && "is-off")}>
      {ok ? <Check size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
      {ok ? "In balance" : "Out of balance"}
    </p>
  );
}
