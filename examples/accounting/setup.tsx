import { useMemo, useRef, useState } from "react";
import { Archive, CalendarDays, Landmark, Lock, Plus, RotateCcw, Search } from "dohc/icons";
import {
  Failure,
  Loading,
  TYPE_LABEL,
  cx,
  fiscalEndYear,
  fiscalLabel,
  shortMonth,
  today,
  useBooks,
  type AccountType,
} from "./shared";
import { Empty, Kbd, Topbar, useAction, useBooksContext, useKeys } from "./parts";
import { money } from "./amounts";

interface Period {
  id: string;
  startDate: string;
  endDate: string;
  status: "open" | "locked";
  entries: number;
  waiting: number;
  duplicates: number;
  reviewQueue: "new" | "matched" | "duplicate" | null;
}

const TYPES = Object.keys(TYPE_LABEL) as AccountType[];
const ROLE_LABEL: Record<string, string> = { receivable: "Receivables", sales_tax: "Sales tax" };

export function Accounts() {
  const { accounts, currency, go } = useBooksContext();
  const { run, pending } = useAction();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    type: "expense" as AccountType,
    isBank: false,
  });
  const search = useRef<HTMLInputElement>(null);
  useKeys((event) => {
    if (event.key === "/") {
      event.preventDefault();
      search.current?.focus();
    } else if (event.key === "c") {
      event.preventDefault();
      setAdding(true);
    }
  });
  const needle = q.trim().toLowerCase();
  const visible = accounts.filter(
    (account) =>
      (showArchived || !account.archived) &&
      (!needle ||
        account.id.toLowerCase().startsWith(needle) ||
        account.name.toLowerCase().includes(needle)),
  );
  const archived = accounts.filter((account) => account.archived).length;
  const taken = accounts.some((account) => account.id === draft.id.trim());
  const validCode = /^[0-9A-Za-z][0-9A-Za-z.-]{0,11}$/.test(draft.id.trim());
  return (
    <>
      <Topbar
        title="Accounts"
        meta={`${accounts.filter((account) => !account.archived).length} active`}
      >
        <button
          type="button"
          className="b-btn b-btn-primary"
          onClick={() => setAdding(!adding)}
          aria-expanded={adding}
        >
          <Plus size={14} aria-hidden />
          New account
          <Kbd>C</Kbd>
        </button>
      </Topbar>
      <div className="b-filters">
        <label className="b-search">
          <Search size={14} aria-hidden />
          <input
            ref={search}
            type="search"
            aria-label="Search accounts"
            placeholder="Search code or name"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && (setQ(""), event.currentTarget.blur())}
          />
          {q ? null : <Kbd>/</Kbd>}
        </label>
        {archived ? (
          <label className="b-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show {archived} archived
          </label>
        ) : null}
      </div>
      {adding ? (
        <form
          className="b-sheet-form b-add-account"
          onSubmit={(event) => {
            event.preventDefault();
            if (!validCode || taken || !draft.name.trim()) return;
            void run(
              "addAccount",
              { ...draft, id: draft.id.trim(), name: draft.name.trim() },
              {
                done: `Added ${draft.id.trim()} ${draft.name.trim()}`,
                failed: "Could not add the account",
                after: () => setDraft({ id: "", name: "", type: draft.type, isBank: false }),
              },
            );
          }}
          onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
        >
          <label className="b-inline-field">
            <span>Code</span>
            <input
              className={cx(
                "b-input b-input-code",
                draft.id && (!validCode || taken) && "is-invalid",
              )}
              autoFocus
              value={draft.id}
              maxLength={12}
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </label>
          <label className="b-inline-field b-grow">
            <span>Name</span>
            <input
              className="b-input"
              value={draft.name}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="b-inline-field">
            <span>Type</span>
            <select
              className="b-select"
              value={draft.type}
              onChange={(event) =>
                setDraft({ ...draft, type: event.target.value as AccountType, isBank: false })
              }
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
          {draft.type === "asset" ? (
            <label className="b-check">
              <input
                type="checkbox"
                checked={draft.isBank}
                onChange={(event) => setDraft({ ...draft, isBank: event.target.checked })}
              />
              Bank account
            </label>
          ) : null}
          <button
            type="submit"
            className="b-btn b-btn-primary"
            disabled={!validCode || taken || !draft.name.trim() || pending !== null}
          >
            Add
          </button>
          <button type="button" className="b-btn b-btn-ghost" onClick={() => setAdding(false)}>
            Done
          </button>
          {taken ? (
            <p className="b-hint is-warn">Account {draft.id.trim()} already exists.</p>
          ) : null}
        </form>
      ) : null}
      <div className="b-page b-page-flush">
        {visible.length === 0 ? (
          <Empty icon={<Search size={20} aria-hidden />} title="No accounts match">
            Try a code prefix like 6 or part of a name.
          </Empty>
        ) : (
          <table className="b-grid b-coa" aria-label="Chart of accounts">
            <thead>
              <tr>
                <th className="col-code">Code</th>
                <th>Name</th>
                <th className="col-flags-wide" aria-label="Details" />
                <th className="b-num col-amt">Balance</th>
                <th className="col-act" aria-label="Actions" />
              </tr>
            </thead>
            {TYPES.map((type) => {
              const group = visible.filter((account) => account.type === type);
              if (!group.length) return null;
              const total = group.reduce((sum, account) => sum + account.balanceCents, 0);
              return (
                <tbody key={type}>
                  <tr className="b-group-row">
                    <th colSpan={2} scope="rowgroup">
                      {TYPE_LABEL[type]}
                      {type === "equity" ? (
                        <span className="b-subtle b-group-note">
                          {" "}
                          · before this year's earnings
                        </span>
                      ) : null}
                    </th>
                    <th className="col-flags-wide" />
                    <th className="b-num col-amt">{money(total, currency)}</th>
                    <th className="col-act" />
                  </tr>
                  {group.map((account) => (
                    <tr
                      key={account.id}
                      className={cx(account.archived && "is-muted")}
                      onClick={() => go({ view: "register", account: account.id })}
                    >
                      <td className="col-code b-code">{account.id}</td>
                      <td>
                        <button
                          type="button"
                          className="b-row-link"
                          onClick={(event) => (
                            event.stopPropagation(),
                            go({ view: "register", account: account.id })
                          )}
                        >
                          {account.name}
                        </button>
                      </td>
                      <td className="col-flags-wide">
                        {account.isBank ? (
                          <span className="b-tag">
                            <Landmark size={11} aria-hidden /> Bank
                          </span>
                        ) : null}
                        {account.role ? (
                          <span className="b-tag">{ROLE_LABEL[account.role] ?? account.role}</span>
                        ) : null}
                        {account.archived ? <span className="b-tag is-warn">Archived</span> : null}
                      </td>
                      <td
                        className={cx(
                          "b-num col-amt",
                          account.isBank && account.balanceCents < 0 && "is-negative",
                          !account.balanceCents && "b-subtle",
                        )}
                      >
                        {money(account.balanceCents, currency)}
                      </td>
                      <td className="col-act">
                        {account.role ? null : (
                          <button
                            type="button"
                            className="b-icon-btn b-row-action"
                            aria-label={
                              account.archived
                                ? `Restore ${account.name}`
                                : `Archive ${account.name}`
                            }
                            title={
                              account.archived
                                ? "Restore"
                                : account.balanceCents
                                  ? "Move the balance out before archiving"
                                  : "Archive"
                            }
                            disabled={
                              pending !== null || (!account.archived && account.balanceCents !== 0)
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void run(
                                "updateAccount",
                                { id: account.id, archived: !account.archived },
                                {
                                  done: account.archived
                                    ? `Restored ${account.name}`
                                    : `Archived ${account.name}`,
                                  failed: "Could not change the account",
                                },
                              );
                            }}
                          >
                            {account.archived ? (
                              <RotateCcw size={14} aria-hidden />
                            ) : (
                              <Archive size={14} aria-hidden />
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        )}
      </div>
    </>
  );
}

const MONTHS = Array.from({ length: 12 }, (_, index) =>
  new Date(Date.UTC(2000, index, 1)).toLocaleString(undefined, { month: "long", timeZone: "UTC" }),
);

export function OpenFirstYear({ now }: { now: string }) {
  const { run, pending } = useAction();
  const [startMonth, setStartMonth] = useState(1);
  const label = fiscalLabel(now, startMonth);
  return (
    <Empty
      icon={<CalendarDays size={22} aria-hidden />}
      title={`Open fiscal year ${label}`}
      action={
        <div className="b-open-year">
          <label className="b-open-year-month">
            <span className="b-muted">Starts in</span>
            <select
              className="b-select"
              value={startMonth}
              onChange={(event) => setStartMonth(Number(event.target.value))}
            >
              {MONTHS.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="b-btn b-btn-primary"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "addFiscalYear",
                { year: fiscalEndYear(now, startMonth), startMonth },
                { done: `Opened fiscal year ${label}`, failed: `Could not open ${label}` },
              )
            }
          >
            Open {label}
          </button>
        </div>
      }
    >
      Entries need an open month to post into. This adds twelve monthly periods.
    </Empty>
  );
}

export function Periods() {
  const { overview, go } = useBooksContext();
  const periods = useBooks<Period[]>("listPeriods", {}, { keep: true });
  const { run, pending } = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = overview?.today ?? today();
  const list = periods.data ?? [];
  const startMonth = list.length ? Number(list[0]!.startDate.slice(5, 7)) : 1;
  const years = useMemo(() => {
    const map = new Map<number, Period[]>();
    for (const period of list) {
      const year = fiscalEndYear(period.startDate, startMonth);
      map.set(year, [...(map.get(year) ?? []), period]);
    }
    return [...map.entries()].reverse();
  }, [list, startMonth]);
  const firstOpen = list.find((period) => period.status === "open");
  const nextYear = list.length
    ? fiscalEndYear(list[list.length - 1]!.endDate, startMonth) + 1
    : null;
  const label = (year: number) => `${startMonth === 1 ? "" : "FY"}${year}`;
  const nextLabel = nextYear === null ? null : label(nextYear);
  const lockedThrough = [...list].reverse().find((period) => period.status === "locked");
  const earlierYear =
    list.length && !lockedThrough ? fiscalEndYear(list[0]!.startDate, startMonth) - 1 : null;
  return (
    <>
      <Topbar
        title="Periods"
        meta={
          lockedThrough
            ? `Closed through ${shortMonth(lockedThrough.id, true)}`
            : "No months closed"
        }
      >
        {earlierYear !== null ? (
          <button
            type="button"
            className="b-btn b-page-action"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "addFiscalYear",
                { year: earlierYear },
                {
                  done: `Opened ${label(earlierYear)}`,
                  failed: `Could not open ${label(earlierYear)}`,
                },
              )
            }
          >
            <Plus size={14} aria-hidden />
            Open {label(earlierYear)}
          </button>
        ) : null}
        {nextYear !== null ? (
          <button
            type="button"
            className="b-btn b-page-action"
            disabled={pending !== null}
            onClick={() =>
              void run(
                "addFiscalYear",
                { year: nextYear },
                { done: `Opened ${nextLabel}`, failed: `Could not open ${nextLabel}` },
              )
            }
          >
            <Plus size={14} aria-hidden />
            Open {nextLabel}
          </button>
        ) : null}
      </Topbar>
      <div className="b-page">
        {periods.error && !periods.data ? (
          <Failure error={periods.error} retry={periods.reload} title="Could not load periods" />
        ) : !periods.data ? (
          <Loading rows={6} />
        ) : !list.length ? (
          <OpenFirstYear now={now} />
        ) : (
          <>
            {firstOpen ? (
              <div className={cx("b-close-bar", confirming && "is-confirming")}>
                {confirming === firstOpen.id ? (
                  <>
                    <p>
                      <strong>Close {shortMonth(firstOpen.id, true)}?</strong> Closed months refuse
                      new entries and reversals. Receipts can still be attached. This can't be
                      undone.
                    </p>
                    <button type="button" className="b-btn" onClick={() => setConfirming(null)}>
                      Keep open
                    </button>
                    <button
                      type="button"
                      className="b-btn b-btn-danger"
                      disabled={pending !== null}
                      onClick={() =>
                        void run(
                          "lockPeriod",
                          { periodId: firstOpen.id },
                          {
                            done: `Closed ${shortMonth(firstOpen.id, true)}`,
                            failed: `Could not close ${shortMonth(firstOpen.id, true)}`,
                            after: () => setConfirming(null),
                          },
                        )
                      }
                    >
                      <Lock size={14} aria-hidden />
                      Close {shortMonth(firstOpen.id, true)}
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      Next to close:{" "}
                      <strong className="b-nowrap">{shortMonth(firstOpen.id, true)}</strong>
                      <span className="b-subtle b-nowrap">
                        {" "}
                        · {firstOpen.entries} {firstOpen.entries === 1 ? "entry" : "entries"}
                      </span>
                      {firstOpen.waiting ? (
                        <span className="b-warn-text">
                          {" "}
                          · {firstOpen.waiting} bank {firstOpen.waiting === 1 ? "row" : "rows"} to
                          review first
                        </span>
                      ) : firstOpen.duplicates ? (
                        <span className="b-warn-text">
                          {" "}
                          · {firstOpen.duplicates} possible{" "}
                          {firstOpen.duplicates === 1 ? "duplicate" : "duplicates"} to check first
                        </span>
                      ) : firstOpen.endDate >= now ? (
                        <span className="b-subtle"> · still in progress</span>
                      ) : null}
                    </p>
                    {firstOpen.waiting || firstOpen.duplicates ? (
                      <button
                        type="button"
                        className="b-btn"
                        onClick={() => go({ view: "bank", show: firstOpen.reviewQueue ?? "new" })}
                      >
                        <Landmark size={14} aria-hidden />
                        {firstOpen.reviewQueue === "duplicate"
                          ? "Check duplicates"
                          : firstOpen.reviewQueue === "matched"
                            ? "Review suggestions"
                            : "Review bank rows"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="b-btn"
                        disabled={firstOpen.endDate >= now}
                        onClick={() => setConfirming(firstOpen.id)}
                      >
                        <Lock size={14} aria-hidden />
                        Close month
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : null}
            {years.map(([year, months]) => (
              <section className="b-year" key={year} aria-labelledby={`year-${year}`}>
                <h2 id={`year-${year}`}>
                  Fiscal year {year}
                  {startMonth === 1 ? null : (
                    <span className="b-subtle">
                      {" "}
                      · {shortMonth(months[0]!.id, true)} to{" "}
                      {shortMonth(months[months.length - 1]!.id, true)}
                    </span>
                  )}
                </h2>
                <ol className="b-months">
                  {months.map((period) => {
                    const current = period.startDate <= now && now <= period.endDate;
                    return (
                      <li
                        key={period.id}
                        className={cx(
                          "b-month",
                          period.status === "locked" && "is-locked",
                          current && "is-current",
                          period.id === firstOpen?.id && "is-next",
                        )}
                      >
                        <span className="b-month-name">
                          {new Date(`${period.startDate}T00:00:00Z`).toLocaleString(undefined, {
                            month: "short",
                            timeZone: "UTC",
                          })}
                        </span>
                        <span className="b-month-count b-mono">
                          {period.entries ? period.entries.toLocaleString() : "–"}
                        </span>
                        <span className="b-month-status">
                          {period.status === "locked" ? (
                            <>
                              <Lock size={11} aria-hidden /> Closed
                            </>
                          ) : current ? (
                            "Current"
                          ) : (
                            "Open"
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </>
        )}
      </div>
    </>
  );
}
