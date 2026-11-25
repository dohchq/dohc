import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "dohc/app";
import { BarChart } from "dohc/charts";
import {
  CalendarDays,
  ChartColumn,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  FileText,
  House,
  Inbox,
  Landmark,
  List,
  Lock,
  Plus,
  Receipt,
  Wallet,
} from "dohc/icons";
import { Modal } from "dohc/ui";
import {
  Failure,
  Loading,
  Reports,
  cx,
  fiscalLabel,
  longDate,
  shortDate,
  shortMonth,
  today,
  useBooks,
} from "./shared";
import {
  BooksContext,
  Kbd,
  MOD,
  Toasts,
  Topbar,
  useBooksContext,
  useClearToasts,
  useKeys,
  type Overview,
  type Route,
  type View,
} from "./parts";
import { Composer, Register } from "./ledger";
import { BankWorkbench } from "./bank";
import { Invoices } from "./invoices";
import { Accounts, OpenFirstYear, Periods } from "./setup";
import "./books.css";
import { compactMoney, majorUnits, money } from "./amounts";

const NAV: Array<{ view: View; label: string; key: string; icon: typeof House; more?: boolean }> = [
  { view: "overview", label: "Overview", key: "o", icon: House },
  { view: "register", label: "Register", key: "r", icon: List },
  { view: "bank", label: "Bank", key: "b", icon: Landmark },
  { view: "invoices", label: "Invoices", key: "i", icon: FileText },
  { view: "accounts", label: "Accounts", key: "a", icon: Wallet, more: true },
  { view: "reports", label: "Reports", key: "f", icon: ChartColumn, more: true },
  { view: "periods", label: "Periods", key: "p", icon: CalendarDays, more: true },
];

function Books() {
  const now = today();
  const overview = useBooks<Overview>("overview", { today: now }, { keep: true });
  const [route, setRoute] = useState<Route>({ view: "overview" });
  const [composing, setComposing] = useState(false);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  const chord = useRef(0);
  const main = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (more) moreMenu.current?.querySelector<HTMLElement>(".is-active, [role=menuitem]")?.focus();
  }, [more]);
  const view = useRef(route.view);
  view.current = route.view;
  const clearToasts = useClearToasts();
  useEffect(() => {
    clearToasts();
  }, [route.view, clearToasts]);
  const go = useCallback((next: Route) => {
    setRoute(next);
    setMore(false);
    if (next.view !== view.current) main.current?.focus({ preventScroll: true });
  }, []);
  const compose = useCallback(() => setComposing(true), []);
  useKeys(
    (event) => {
      if (Date.now() - chord.current < 1200) {
        chord.current = 0;
        const item = NAV.find((entry) => entry.key === event.key);
        if (item) {
          event.preventDefault();
          go({ view: item.view });
        }
        return;
      }
      if (event.key === "g") chord.current = Date.now();
      else if (event.key === "n") {
        event.preventDefault();
        setComposing(true);
      } else if (event.key === "?") {
        event.preventDefault();
        setHelp(true);
      }
    },
    true,
    true,
  );
  const data = overview.data;
  const value = useMemo(
    () => ({
      overview: data,
      accounts: data?.accounts ?? [],
      currency: data?.currency ?? "USD",
      route,
      go,
      compose,
    }),
    [data, route, go, compose],
  );
  const badge: Partial<Record<View, number>> = data
    ? { bank: data.newBankRows + data.duplicateBankRows, invoices: data.receivables.overdue }
    : {};
  return (
    <BooksContext.Provider value={value}>
      <div className="b-app" data-view={route.view}>
        <nav className="b-rail b-no-print" aria-label="Books">
          <div className="b-brand">
            <span className="b-brand-mark" aria-hidden>
              <Receipt size={14} />
            </span>
            <span>Books</span>
          </div>
          <button type="button" className="b-compose" onClick={compose}>
            <Plus size={15} aria-hidden />
            <span>New entry</span>
            <Kbd>N</Kbd>
          </button>
          <ul className="b-nav">
            {NAV.map((item) => (
              <li key={item.view} className={cx(item.more && "b-nav-extra")}>
                <button
                  type="button"
                  className={cx("b-nav-item", route.view === item.view && "is-active")}
                  aria-current={route.view === item.view ? "page" : undefined}
                  title={`${item.label} (G then ${item.key.toUpperCase()})`}
                  onClick={() => go({ view: item.view })}
                >
                  <item.icon size={16} aria-hidden />
                  <span className="b-nav-label">{item.label}</span>
                  {badge[item.view] ? (
                    <span className="b-badge" aria-label={`${badge[item.view]} waiting`}>
                      {badge[item.view]}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            <li className="b-nav-more">
              <button
                ref={moreButton}
                type="button"
                className={cx(
                  "b-nav-item",
                  (more || NAV.some((item) => item.more && item.view === route.view)) &&
                    "is-active",
                )}
                aria-expanded={more}
                aria-controls="b-more"
                onClick={() => setMore((open) => !open)}
              >
                <Ellipsis size={16} aria-hidden />
                <span className="b-nav-label">More</span>
              </button>
            </li>
          </ul>
          {more ? (
            <div className="b-more-scrim" aria-hidden onClick={() => setMore(false)} />
          ) : null}
          {more ? (
            <div
              className="b-more"
              id="b-more"
              role="menu"
              aria-label="More pages"
              ref={moreMenu}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"),
                  ];
                  const at = items.indexOf(document.activeElement as HTMLElement);
                  items[
                    (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
                  ]?.focus();
                } else if (event.key === "Escape") {
                  setMore(false);
                  moreButton.current?.focus();
                }
              }}
            >
              {NAV.filter((item) => item.more).map((item) => (
                <button
                  key={item.view}
                  type="button"
                  role="menuitem"
                  className={cx("b-more-item", route.view === item.view && "is-active")}
                  onClick={() => go({ view: item.view })}
                >
                  <item.icon size={16} aria-hidden />
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="b-rail-foot">
            {data?.periods.lockedThrough ? (
              <span className="b-rail-note">
                <Lock size={12} aria-hidden />
                Closed through {shortMonth(data.periods.lockedThrough, true)}
              </span>
            ) : null}
            <button type="button" className="b-nav-item" onClick={() => setHelp(true)}>
              <CircleHelp size={16} aria-hidden />
              <span className="b-nav-label">Shortcuts</span>
              <Kbd>?</Kbd>
            </button>
          </div>
        </nav>
        <main
          className="b-main"
          ref={main}
          tabIndex={-1}
          aria-label={NAV.find((item) => item.view === route.view)?.label}
        >
          {overview.error && !data ? (
            <div className="b-pad">
              <Failure
                error={overview.error}
                retry={overview.reload}
                title="Could not open the books"
              />
            </div>
          ) : !data ? (
            <div className="b-pad">
              <Loading rows={10} />
            </div>
          ) : (
            <Page route={route} />
          )}
        </main>
      </div>
      {composing ? <Composer onClose={() => setComposing(false)} /> : null}
      {help ? <Shortcuts onClose={() => setHelp(false)} /> : null}
    </BooksContext.Provider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.view) {
    case "register":
      return <Register />;
    case "bank":
      return <BankWorkbench />;
    case "invoices":
      return <Invoices />;
    case "accounts":
      return <Accounts />;
    case "reports":
      return (
        <>
          <Topbar title="Reports" />
          <div className="b-page b-page-reports">
            <Reports
              initial={route.show === "accountLedger" ? "accountLedger" : undefined}
              initialAccount={route.account}
            />
          </div>
        </>
      );
    case "periods":
      return <Periods />;
    default:
      return <OverviewPage />;
  }
}

function OverviewPage() {
  const { overview, go } = useBooksContext();
  const data = overview!;
  const code = data.currency;
  const year = fiscalLabel(data.today, data.fiscalStartMonth);
  if (!data.hasPeriods)
    return (
      <>
        <Topbar title="Overview" />
        <OpenFirstYear now={data.today} />
      </>
    );
  const todo: Array<{
    icon: ReactNode;
    label: string;
    detail?: string;
    route: Route;
    tone?: "warn";
  }> = [];
  if (data.newBankRows)
    todo.push({
      icon: <Landmark size={15} aria-hidden />,
      label: `Review ${data.newBankRows} bank ${data.newBankRows === 1 ? "row" : "rows"}`,
      route: { view: "bank" },
    });
  if (data.duplicateBankRows)
    todo.push({
      icon: <Inbox size={15} aria-hidden />,
      label: `Check ${data.duplicateBankRows} possible ${data.duplicateBankRows === 1 ? "duplicate" : "duplicates"}`,
      route: { view: "bank", show: "duplicate" },
    });
  if (data.receivables.overdue)
    todo.push({
      icon: <FileText size={15} aria-hidden />,
      label: `Follow up ${data.receivables.overdue} overdue ${data.receivables.overdue === 1 ? "invoice" : "invoices"}`,
      detail: money(data.receivables.overdueCents, code),
      route: { view: "invoices", show: "overdue" },
      tone: "warn",
    });
  if (data.draftInvoices)
    todo.push({
      icon: <FileText size={15} aria-hidden />,
      label: `Issue ${data.draftInvoices} draft ${data.draftInvoices === 1 ? "invoice" : "invoices"}`,
      route: { view: "invoices", show: "draft" },
    });
  if (data.missingReceipts)
    todo.push({
      icon: <Receipt size={15} aria-hidden />,
      label: `Attach ${data.missingReceipts} missing ${data.missingReceipts === 1 ? "receipt" : "receipts"}`,
      route: { view: "register", show: "missing" },
    });
  if (data.periods.nextToLock)
    todo.push({
      icon: <Lock size={15} aria-hidden />,
      label: `Close ${shortMonth(data.periods.nextToLock, true)}`,
      detail: data.periods.unlocked > 1 ? `${data.periods.unlocked} months open` : undefined,
      route: { view: "periods" },
    });
  const ytd = data.yearToDate;
  const months = ytd.months.filter((row) => row.incomeCents || row.expenseCents);
  return (
    <>
      <Topbar title="Overview" meta={longDate(data.today)}>
        <button type="button" className="b-btn" onClick={() => go({ view: "reports" })}>
          <ChartColumn size={14} aria-hidden />
          Reports
        </button>
      </Topbar>
      <div className="b-page b-overview">
        <div className="b-ov-col">
          <section aria-labelledby="todo-title">
            <header className="b-block-head">
              <h2 id="todo-title">Needs attention</h2>
              {todo.length ? <span className="b-count">{todo.length}</span> : null}
            </header>
            {todo.length ? (
              <ul className="b-todo">
                {todo.map((item) => (
                  <li key={item.label}>
                    <button
                      type="button"
                      className={cx("b-todo-row", item.tone === "warn" && "is-warn")}
                      onClick={() => go(item.route)}
                    >
                      <span className="b-todo-icon">{item.icon}</span>
                      <span className="b-todo-label">{item.label}</span>
                      {item.detail ? (
                        <span className="b-todo-detail b-mono">{item.detail}</span>
                      ) : null}
                      <ChevronRight size={14} aria-hidden className="b-todo-go" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="b-block-empty">Nothing waiting. The books are up to date.</p>
            )}
          </section>
          <section aria-labelledby="recent-title">
            <header className="b-block-head">
              <h2 id="recent-title">Recent entries</h2>
              <button type="button" className="b-link" onClick={() => go({ view: "register" })}>
                Open register
              </button>
            </header>
            {data.recent.length ? (
              <table className="b-grid is-compact">
                <tbody>
                  {data.recent.map((row) => (
                    <tr
                      key={row.id}
                      className={cx((row.reversed || row.reversal) && "is-muted")}
                      onClick={() => go({ view: "register", entry: row.id })}
                    >
                      <td className="col-date b-date">{shortDate(row.date)}</td>
                      <td className="col-no b-num b-subtle">{row.number}</td>
                      <td className="col-memo">
                        <button
                          type="button"
                          className="b-row-link"
                          onClick={(event) => (
                            event.stopPropagation(),
                            go({ view: "register", entry: row.id })
                          )}
                        >
                          {row.memo || "No memo"}
                        </button>
                        {row.reversed ? <span className="b-tag">Reversed</span> : null}
                        {row.reversal ? <span className="b-tag">Reversal</span> : null}
                      </td>
                      <td className="b-num col-amt">{money(row.totalCents, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="b-block-empty">No entries yet.</p>
            )}
          </section>
        </div>
        <div className="b-ov-col">
          <section aria-labelledby="cash-title">
            <header className="b-block-head">
              <h2 id="cash-title">Cash</h2>
              <span className="b-mono b-strong">{money(data.cashCents, code)}</span>
            </header>
            <ul className="b-ledger-list">
              {data.cash.map((account) => (
                <li key={account.id}>
                  <button
                    type="button"
                    className="b-ledger-row"
                    onClick={() => go({ view: "register", account: account.id })}
                  >
                    <span className="b-code">{account.id}</span>
                    <span className="b-ledger-name">{account.name}</span>
                    <span className={cx("b-mono", account.balanceCents < 0 && "is-negative")}>
                      {money(account.balanceCents, code)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="owed-title">
            <header className="b-block-head">
              <h2 id="owed-title">Owed to you</h2>
              <span className="b-mono b-strong">{money(data.receivables.openCents, code)}</span>
            </header>
            {data.receivables.open ? (
              <ul className="b-ledger-list">
                <li>
                  <button
                    type="button"
                    className="b-ledger-row"
                    onClick={() => go({ view: "invoices", show: "issued" })}
                  >
                    <span className="b-ledger-name">
                      {data.receivables.open} open{" "}
                      {data.receivables.open === 1 ? "invoice" : "invoices"}
                      {data.receivables.overdue ? (
                        <span className="b-subtle"> · {data.receivables.overdue} overdue</span>
                      ) : null}
                    </span>
                    <ChevronRight size={14} aria-hidden className="b-todo-go" />
                  </button>
                </li>
              </ul>
            ) : (
              <p className="b-block-empty">No open invoices.</p>
            )}
          </section>
          <section aria-labelledby="ytd-title">
            <header className="b-block-head">
              <h2 id="ytd-title">Profit and loss</h2>
              <span className="b-subtle">{year} to date</span>
            </header>
            <dl className="b-pl">
              <div>
                <dt>Income</dt>
                <dd className="b-mono">{money(ytd.incomeCents, code)}</dd>
              </div>
              <div>
                <dt>Expenses</dt>
                <dd className="b-mono">{money(ytd.expenseCents, code)}</dd>
              </div>
              <div className="b-pl-net">
                <dt>Net income</dt>
                <dd className={cx("b-mono", ytd.netIncomeCents < 0 && "is-negative")}>
                  {money(ytd.netIncomeCents, code)}
                </dd>
              </div>
            </dl>
            {months.length > 1 ? (
              <div className="b-chart">
                <BarChart
                  labels={ytd.months.map((row) => shortMonth(row.month))}
                  series={[
                    {
                      name: "Income",
                      values: ytd.months.map((row) => majorUnits(row.incomeCents, code)),
                    },
                    {
                      name: "Expenses",
                      values: ytd.months.map((row) => majorUnits(row.expenseCents, code)),
                    },
                  ]}
                  height={150}
                  formatValue={(value) => compactMoney(value, code)}
                  ariaLabel="Income and expenses by month"
                />
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}

const SHORTCUTS: Array<[string, string[]]> = [
  ["New journal entry", ["N"]],
  ["New invoice or account, on those pages", ["C"]],
  ["Search the register or accounts", ["/"]],
  ["Move down or up", ["J", "K"]],
  ["Open the selected row", ["Enter"]],
  ["Close the inspector", ["Esc"]],
  ["Post, match, or record the payment on a bank row, or confirm a duplicate", ["Enter"]],
  ["Choose the account on a bank row", ["A"]],
  ["Find an older entry for a bank row", ["F"]],
  ["Skip a bank row", ["I"]],
  ["Split a bank row", ["S"]],
  ["Fill the difference in the composer", ["="]],
  ["Next line, or a new one, from an amount", ["Enter"]],
  ["Post the entry or save the invoice", [MOD, "Enter"]],
  ["Show shortcuts", ["?"]],
  ...NAV.map((item): [string, string[]] => [`Go to ${item.label}`, ["G", item.key.toUpperCase()]]),
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "?" && !event.defaultPrevented && !event.repeat) onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <Modal open title="Keyboard shortcuts" onClose={onClose}>
      <dl className="b-shortcuts">
        {SHORTCUTS.map(([label, keys]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <Toasts>
      <Books />
    </Toasts>
  </AppProvider>,
);
