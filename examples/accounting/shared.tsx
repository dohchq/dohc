import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDatasetQuery, type AppBackendError } from "dohc/app";
import { BarChart } from "dohc/charts";
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Grid,
  Input,
  Select,
  Skeleton,
  Stack,
  StatCard,
  Tabs,
} from "dohc/ui";

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
  currency: string;
  assets: AccountTotal[];
  liabilities: AccountTotal[];
  equity: AccountTotal[];
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
  currencies: Array<{ currency: string; entries: number; firstDate: string; lastDate: string }>;
  accounts: Array<{ id: string; name: string; type: AccountType }>;
  periods: Array<{ id: string; startDate: string; endDate: string; status: "open" | "locked" }>;
}

export function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
export function parseMoney(value: string): number | null {
  const text = value.trim().replace(/[,\s]/g, "").replace(/^\$/, "");
  const match = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -cents : cents;
}
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function problem(error: unknown) {
  if (error && typeof error === "object" && "status" in error && error.status === 429)
    return "dohc is limiting how fast this app can send requests. Wait a few seconds, then try again.";
  if (error && typeof error === "object" && "message" in error) return String((error as Error).message);
  return "Something went wrong.";
}

const PRINT_HTML_CSS = `body{font:14px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;margin:24px auto;max-width:860px;padding:0 16px}
h2{margin:4px 0;font-size:1.25rem}p{margin:2px 0}.books-muted,.books-code{color:#555}.books-code{font-family:ui-monospace,monospace;font-size:.8125rem;margin-right:4px}
.books-statement-head{text-align:center;margin-bottom:14px}.books-invoice{display:grid;gap:18px}.books-invoice header{display:flex;justify-content:space-between;align-items:flex-start}
.books-table{width:100%;border-collapse:collapse;font-size:.875rem}.books-table th,.books-table td{padding:6px 8px;border-bottom:1px solid #ccc;text-align:left;vertical-align:middle}
.books-num{text-align:right;white-space:nowrap}.books-amount,.books-date{font-variant-numeric:tabular-nums;white-space:nowrap}
.books-section th,.books-section td{padding-top:14px;font-weight:600}.books-total td,.books-strong{font-weight:600}
.books-grand td{font-weight:700;border-top:2px solid #111;border-bottom:3px double #111}.books-balanced{margin-top:12px}
.print-bar{display:flex;justify-content:flex-end;margin-bottom:12px}.print-bar button{padding:6px 12px;font:inherit;cursor:pointer}
@media print{.print-bar{display:none}body{margin:0;max-width:none;padding:0}.books-table tr{break-inside:avoid}}`;

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function downloadPrintableHtml(filename: string, title: string, node: HTMLElement | null) {
  if (!node) return;
  const clone = node.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".books-no-print, .kit-tabs, button").forEach((element) => element.remove());
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

const Refresh = createContext<{ tick: number; bump: () => void }>({ tick: 0, bump: () => {} });
export function RefreshProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  return <Refresh.Provider value={{ tick, bump: () => setTick((value) => value + 1) }}>{children}</Refresh.Provider>;
}
export const useRefresh = () => useContext(Refresh).bump;
export function useBooks<T>(operation: string, input?: unknown, enabled = true) {
  const query = useDatasetQuery<T>(operation, input, { enabled });
  const { tick } = useContext(Refresh);
  const seen = useRef(tick);
  const { reload } = query;
  useEffect(() => {
    if (seen.current === tick) return;
    seen.current = tick;
    reload();
  }, [tick, reload]);
  return query;
}

export function Failure({ error, retry, title = "Could not load this" }: { error: AppBackendError | Error; retry?: () => void; title?: string }) {
  return (
    <Callout
      tone="danger"
      title={title}
      action={
        <Stack direction="horizontal" gap={8}>
          {retry ? (
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(error.message)}>
            Copy
          </Button>
        </Stack>
      }
    >
      {error.message}
    </Callout>
  );
}

export function Table({ form, children }: { form?: boolean; children: ReactNode }) {
  return (
    <div className="books-scroll">
      <table className={form ? "books-table books-form-table" : "books-table"}>{children}</table>
    </div>
  );
}

function Amount({ cents, currency, strong }: { cents: number; currency: string; strong?: boolean }) {
  return <span className={strong ? "books-amount books-strong" : "books-amount"}>{money(cents, currency)}</span>;
}

function StatementSection({ title, rows, totalLabel, totalCents, currency }: {
  title: string;
  rows: AccountTotal[];
  totalLabel: string;
  totalCents: number;
  currency: string;
}) {
  return (
    <tbody>
      <tr className="books-section">
        <th colSpan={2}>{title}</th>
      </tr>
      {rows.length ? (
        rows.map((row) => (
          <tr key={row.id}>
            <td>
              {row.id ? <span className="books-code">{row.id}</span> : null}
              {row.name}
            </td>
            <td className="books-num">
              <Amount cents={row.balanceCents} currency={currency} />
            </td>
          </tr>
        ))
      ) : (
        <tr>
          <td className="books-muted">No activity</td>
          <td />
        </tr>
      )}
      <tr className="books-total">
        <td>{totalLabel}</td>
        <td className="books-num">
          <Amount cents={totalCents} currency={currency} strong />
        </td>
      </tr>
    </tbody>
  );
}

export function TrialBalanceView({ report }: { report: TrialBalance }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Account</th>
          <th className="books-num">Debit</th>
          <th className="books-num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={row.id}>
            <td>
              {row.id ? <span className="books-code">{row.id}</span> : null}
              {row.name}
            </td>
            <td className="books-num">{row.debitBalanceCents ? <Amount cents={row.debitBalanceCents} currency={report.currency} /> : ""}</td>
            <td className="books-num">{row.creditBalanceCents ? <Amount cents={row.creditBalanceCents} currency={report.currency} /> : ""}</td>
          </tr>
        ))}
        <tr className="books-total">
          <td>Total</td>
          <td className="books-num">
            <Amount cents={report.totalDebitCents} currency={report.currency} strong />
          </td>
          <td className="books-num">
            <Amount cents={report.totalCreditCents} currency={report.currency} strong />
          </td>
        </tr>
      </tbody>
    </Table>
  );
}

export function IncomeStatementView({ report }: { report: IncomeStatement }) {
  return (
    <Table>
      <StatementSection title="Income" rows={report.income} totalLabel="Total income" totalCents={report.totalIncomeCents} currency={report.currency} />
      <StatementSection title="Expenses" rows={report.expenses} totalLabel="Total expenses" totalCents={report.totalExpenseCents} currency={report.currency} />
      <tbody>
        <tr className="books-grand">
          <td>Net income</td>
          <td className="books-num">
            <Amount cents={report.netIncomeCents} currency={report.currency} strong />
          </td>
        </tr>
      </tbody>
    </Table>
  );
}

export function BalanceSheetView({ report }: { report: BalanceSheet }) {
  const equity = [
    ...report.equity,
    { id: "", name: "Current earnings", type: "equity" as const, debitCents: 0, creditCents: 0, balanceCents: report.earningsCents },
  ];
  return (
    <Table>
      <StatementSection title="Assets" rows={report.assets} totalLabel="Total assets" totalCents={report.totalAssetsCents} currency={report.currency} />
      <StatementSection title="Liabilities" rows={report.liabilities} totalLabel="Total liabilities" totalCents={report.totalLiabilitiesCents} currency={report.currency} />
      <StatementSection title="Equity" rows={equity} totalLabel="Total equity" totalCents={report.totalEquityCents} currency={report.currency} />
      <tbody>
        <tr className="books-grand">
          <td>Liabilities and equity</td>
          <td className="books-num">
            <Amount cents={report.totalLiabilitiesCents + report.totalEquityCents} currency={report.currency} strong />
          </td>
        </tr>
      </tbody>
    </Table>
  );
}

function LedgerView({ accountId, currency, from, to, onState }: {
  accountId: string;
  currency: string;
  from: string;
  to: string;
  onState: (ready: boolean) => void;
}) {
  const [pages, setPages] = useState<Array<Ledger["nextAfter"]>>([null]);
  const [readyPages, setReadyPages] = useState<Record<number, boolean>>({});
  useEffect(() => {
    setPages([null]);
    setReadyPages({});
  }, [accountId, currency, from, to]);
  const allReady = pages.every((_, index) => readyPages[index] === true);
  useEffect(() => {
    onState(allReady);
  }, [onState, allReady]);
  const onPageState = useCallback(
    (pageIndex: number, ready: boolean) =>
      setReadyPages((map) => (map[pageIndex] === ready ? map : { ...map, [pageIndex]: ready })),
    [],
  );
  return (
    <Stack gap={8}>
      {pages.map((after, index) => (
        <LedgerPage
          key={`${accountId}:${currency}:${from}:${to}:${index}`}
          pageIndex={index}
          input={{ accountId, currency, from, to, limit: 50, after }}
          first={index === 0}
          onPageState={onPageState}
          onMore={
            index === pages.length - 1
              ? (next) => {
                  onState(false);
                  setPages((list) => [...list, next]);
                }
              : undefined
          }
        />
      ))}
    </Stack>
  );
}
function LedgerPage({ pageIndex, input, first, onPageState, onMore }: {
  pageIndex: number;
  input: { accountId: string; currency: string; from: string; to: string; limit: number; after: Ledger["nextAfter"] };
  first: boolean;
  onPageState: (pageIndex: number, ready: boolean) => void;
  onMore?: (next: NonNullable<Ledger["nextAfter"]>) => void;
}) {
  const { data, loading, error, reload } = useBooks<Ledger>("accountLedger", input);
  const ready = !loading && !error && Boolean(data);
  useEffect(() => {
    onPageState(pageIndex, ready);
  }, [onPageState, pageIndex, ready]);
  if (error) return <Failure error={error} retry={reload} />;
  if (loading || !data) return <Skeleton height={120} />;
  return (
    <>
      <Table>
        {first ? (
          <thead>
            <tr>
              <th>Date</th>
              <th>No.</th>
              <th>Memo</th>
              <th className="books-num">Debit</th>
              <th className="books-num">Credit</th>
              <th className="books-num">Balance</th>
            </tr>
            <tr className="books-section">
              <td colSpan={5}>Opening balance</td>
              <td className="books-num">
                <Amount cents={data.openingBalanceCents} currency={data.currency} />
              </td>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {data.rows.map((row) => (
            <tr key={`${row.entryId}:${row.lineNo}`}>
              <td className="books-date">{row.date}</td>
              <td>{row.number}</td>
              <td>{row.lineMemo || row.memo}</td>
              <td className="books-num">{row.debitCents ? <Amount cents={row.debitCents} currency={data.currency} /> : ""}</td>
              <td className="books-num">{row.creditCents ? <Amount cents={row.creditCents} currency={data.currency} /> : ""}</td>
              <td className="books-num">
                <Amount cents={row.balanceCents} currency={data.currency} />
              </td>
            </tr>
          ))}
          {data.nextAfter ? null : (
            <tr className="books-total">
              <td colSpan={5}>Closing balance</td>
              <td className="books-num">
                <Amount cents={data.closingBalanceCents} currency={data.currency} strong />
              </td>
            </tr>
          )}
        </tbody>
      </Table>
      {data.nextAfter && onMore ? (
        <div className="books-no-print">
          <Button variant="secondary" size="sm" onClick={() => onMore(data.nextAfter!)}>
            Show more lines
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ReportBody<T>({ operation, input, onState, render }: {
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
  if (loading || !data) return <Skeleton height={240} />;
  return <>{render(data)}</>;
}

export function Reports({ bookName }: { bookName: string }) {
  const info = useBooks<BooksInfo>("booksInfo", {});
  const year = today().slice(0, 4);
  const [tab, setTab] = useState("trialBalance");
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(today());
  const [currency, setCurrency] = useState("");
  const [accountId, setAccountId] = useState("1000");
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const statementRef = useRef<HTMLDivElement>(null);
  const currencies = info.data?.currencies.map((row) => row.currency) ?? [];
  const code = currency || currencies[0] || "USD";
  const usesRange = tab === "incomeStatement" || tab === "accountLedger";
  const queryKey = JSON.stringify([tab, usesRange ? from : "", to, code, tab === "accountLedger" ? accountId : ""]);
  const onReportState = useCallback(
    (ready: boolean) => setReadyKey((current) => (ready ? queryKey : current === queryKey ? null : current)),
    [queryKey],
  );
  if (info.error) return <Failure error={info.error} retry={info.reload} title="Could not load the books" />;
  if (info.loading || !info.data) return <Skeleton height={320} />;
  const titles: Record<string, string> = {
    trialBalance: "Trial balance",
    incomeStatement: "Income statement",
    balanceSheet: "Balance sheet",
    accountLedger: "Account ledger",
  };
  const account = info.data.accounts.find((row) => row.id === accountId);
  const validRange = usesRange
    ? /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to
    : /^\d{4}-\d{2}-\d{2}$/.test(to);
  const period = usesRange ? `${from} to ${to}` : `As of ${to}`;
  return (
    <Stack gap={16}>
      <div className="books-no-print">
        <Tabs
          label="Reports"
          value={tab}
          onChange={setTab}
          items={Object.entries(titles).map(([id, label]) => ({ id, label }))}
        />
      </div>
      <div className="books-controls books-no-print">
        {usesRange ? (
          <Field label="From" htmlFor="report-from">
            <Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
        ) : null}
        <Field label={usesRange ? "To" : "As of"} htmlFor="report-to">
          <Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Field label="Currency" htmlFor="report-currency">
          <Select id="report-currency" value={code} onChange={(event) => setCurrency(event.target.value)}>
            {(currencies.length ? currencies : ["USD"]).map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
        </Field>
        {tab === "accountLedger" ? (
          <Field label="Account" htmlFor="report-account">
            <Select id="report-account" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {info.data.accounts.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} {row.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Button
          variant="secondary"
          disabled={!validRange || readyKey !== queryKey}
          onClick={() => downloadPrintableHtml(`${tab}-${to}.html`, `${bookName} - ${titles[tab]}`, statementRef.current)}
        >
          Download printable HTML
        </Button>
      </div>
      <Card>
        <div ref={statementRef}>
        <header className="books-statement-head">
          <p className="books-muted">{bookName}</p>
          <h2>
            {titles[tab]}
            {tab === "accountLedger" && account ? `: ${account.id} ${account.name}` : ""}
          </h2>
          <p className="books-muted">
            {period} · {code}
          </p>
        </header>
        {!validRange ? (
          <Callout tone="warning">{usesRange ? "Choose a start date on or before the end date." : "Choose a valid date."}</Callout>
        ) : tab === "trialBalance" ? (
          <ReportBody<TrialBalance>
            operation="trialBalance"
            input={{ asOf: to, currency: code }}
            onState={onReportState}
            render={(report) => (
              <>
                <TrialBalanceView report={report} />
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
              <Stack gap={16}>
                {report.months.length > 1 ? (
                  <div className="books-no-print">
                    <BarChart
                      labels={report.months.map((row) => row.month)}
                      series={[
                        { name: "Income", values: report.months.map((row) => row.incomeCents / 100) },
                        { name: "Expenses", values: report.months.map((row) => row.expenseCents / 100) },
                      ]}
                      height={200}
                      formatValue={(value) => money(Math.round(value * 100), code)}
                      ariaLabel="Income and expenses by month"
                    />
                  </div>
                ) : null}
                <IncomeStatementView report={report} />
              </Stack>
            )}
          />
        ) : tab === "balanceSheet" ? (
          <ReportBody<BalanceSheet>
            operation="balanceSheet"
            input={{ asOf: to, currency: code }}
            onState={onReportState}
            render={(report) => (
              <>
                <BalanceSheetView report={report} />
                <Balanced ok={report.balanced} />
              </>
            )}
          />
        ) : (
          <LedgerView accountId={accountId} currency={code} from={from} to={to} onState={onReportState} />
        )}
        </div>
      </Card>
    </Stack>
  );
}

function Balanced({ ok }: { ok: boolean }) {
  return (
    <p className="books-balanced">
      <Badge tone={ok ? "success" : "danger"}>{ok ? "In balance" : "Out of balance"}</Badge>
    </p>
  );
}

export function Summary({ cards }: { cards: Array<{ label: string; value: string; hint?: string; tone?: "neutral" | "success" | "warning" | "danger" }> }) {
  return (
    <Grid cols={4}>
      {cards.map((card) => (
        <StatCard key={card.label} label={card.label} value={card.value} hint={card.hint} tone={card.tone} />
      ))}
    </Grid>
  );
}

