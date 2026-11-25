import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { mutationKey, useApp } from "dohc/app";
import {
  ArrowLeft,
  Banknote,
  ChevronLeft,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Landmark,
  Paperclip,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "dohc/icons";
import { Modal } from "dohc/ui";
import { Failure, Loading, cx, longDate, presetRanges, problem, shortDate, Tablist, today, TYPE_LABEL, useBooks, type AccountType } from "./shared";
import { AccountPicker, MOD, Empty, Kbd, Topbar, useAction, useBooksContext, useInitialFocus, useKeys, useMutate, useToast, type Account } from "./parts";
import { centsInput, money, parseAmount } from "./amounts";

interface EntryRow {
  id: string;
  number: number;
  date: string;
  currency: string;
  memo: string;
  source: string;
  totalCents: number;
  hasReceipt: boolean;
  reversesEntryId: string | null;
  reversed: boolean;
  lineCount: number;
  accounts: string | null;
  debitCents?: number;
  creditCents?: number;
  balanceCents?: number;
}
interface EntryPage {
  account: { id: string; name: string; type: AccountType; currency: string; currencies: string[]; balanceCents: number } | null;
  entries: EntryRow[];
  total: number;
  debitCents?: number;
  creditCents?: number;
  nextOffset: number | null;
}
interface Entry {
  id: string;
  number: number;
  date: string;
  currency: string;
  memo: string;
  source: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversesNumber: number | null;
  reversedByEntryId: string | null;
  reversedByNumber: number | null;
  reversedAtMs: number | null;
  totalCents: number;
  receiptFileId: string | null;
  createdAtMs: number;
  invoice: { id: string; number: string | null; status: string; voidEntryId: string | null } | null;
  bankRow: { id: string; importId: string; lineNo: number; date: string; description: string; amountCents: number; importedAtMs: number } | null;
  lines: Array<{ lineNo: number; accountId: string; accountName: string; debitCents: number; creditCents: number; memo: string | null }>;
}

const PAGE = 100;
const RECEIPT_TYPES = "application/pdf,image/png,image/jpeg,image/webp,image/gif,image/heic";
const SOURCE_ICON = { bank: Landmark, invoice: FileText, payment: Banknote, reversal: RotateCcw, manual: PenLine } as const;
const SOURCE_LABEL: Record<string, string> = { bank: "Bank", invoice: "Invoice", payment: "Payment", reversal: "Reversal", manual: "Manual" };

function SourceIcon({ source }: { source: string }) {
  if (source === "manual") return null;
  const Icon = SOURCE_ICON[source as keyof typeof SOURCE_ICON] ?? PenLine;
  return (
    <span className="b-source" title={SOURCE_LABEL[source] ?? source}>
      <Icon size={14} aria-label={SOURCE_LABEL[source] ?? source} />
    </span>
  );
}

function ranges(now: string, startMonth: number): Record<string, { label: string; from?: string; to?: string }> {
  const { month, lastMonth, quarter, ytd, lastYear } = presetRanges(now, startMonth);
  return { all: { label: "All dates" }, month, lastMonth, quarter, ytd: { ...ytd, label: "This year" }, lastYear };
}

export function AccountFilter({ accounts, value, onChange, label = "Account" }: { accounts: Account[]; value: string; onChange: (id: string) => void; label?: string }) {
  const groups = (Object.keys(TYPE_LABEL) as AccountType[]).map((type) => [type, accounts.filter((account) => account.type === type)] as const);
  return (
    <select className="b-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">All accounts</option>
      {groups.map(([type, list]) =>
        list.length ? (
          <optgroup key={type} label={TYPE_LABEL[type]}>
            {list.map((account) => (
              <option key={account.id} value={account.id}>
                {account.id} {account.name}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  );
}

export function Register() {
  const { accounts, overview, route, go } = useBooksContext();
  const now = overview?.today ?? today();
  const presets = ranges(now, overview?.fiscalStartMonth ?? 1);
  const [q, setQ] = useState(route.q ?? "");
  const [search, setSearch] = useState(route.q ?? "");
  const [range, setRange] = useState("all");
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [keyed, setKeyed] = useState(false);
  const account = route.account ?? "";
  const [picked, setPicked] = useState<{ account: string; code: string } | null>(null);
  const code = picked?.account === account ? picked.code : null;
  const show = route.show ?? "all";
  const selected = route.entry ?? null;
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 180);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    setPage(0);
    setCursor(0);
    setKeyed(false);
  }, [account, show, range, search, code]);
  const dates = presets[range] ?? presets.all!;
  const input = {
    limit: PAGE,
    offset: page * PAGE,
    ...(account ? { accountId: account, ...(code ? { currency: code } : {}) } : {}),
    ...(dates.from ? { from: dates.from, to: dates.to } : {}),
    ...(search ? { q: search } : {}),
    ...(show !== "all" ? { show } : {}),
  };
  const list = useBooks<EntryPage>("listEntries", input, { keep: true });
  const fresh = (list.data?.account?.id ?? "") === account;
  const rows = fresh ? (list.data?.entries ?? []) : [];
  const ledger = fresh ? (list.data?.account ?? null) : null;
  const current = fresh ? list.data : undefined;
  const set = (patch: Partial<typeof route>) => go({ ...route, view: "register", ...patch });
  const open = (id: string | null) => set({ entry: id ?? undefined });
  useEffect(() => {
    tableRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  useEffect(() => {
    const at = rows.findIndex((row) => row.id === selected);
    if (at >= 0) setCursor(at);
  }, [rows, selected]);
  useKeys((event) => {
    if (event.key === "/") {
      event.preventDefault();
      searchRef.current?.focus();
    } else if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = keyed ? Math.min(rows.length - 1, cursor + 1) : cursor;
      setKeyed(true);
      setCursor(next);
      if (selected && rows[next]) open(rows[next]!.id);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = keyed ? Math.max(0, cursor - 1) : cursor;
      setKeyed(true);
      setCursor(next);
      if (selected && rows[next]) open(rows[next]!.id);
    } else if ((event.key === "Enter" || event.key === "o") && rows[cursor]) {
      event.preventDefault();
      open(rows[cursor]!.id);
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      open(null);
    }
  });
  const accountName = accounts.find((row) => row.id === account);
  const currency = ledger?.currency ?? overview?.currency ?? "USD";
  return (
    <>
      <Topbar
        title={accountName ? `${accountName.id} ${accountName.name}` : "Register"}
        meta={current ? `${current.total.toLocaleString()} ${current.total === 1 ? "entry" : "entries"}` : undefined}
      >
        {ledger && ledger.currencies.length > 1 ? (
          <select className="b-select" aria-label="Currency" value={ledger.currency} onChange={(event) => setPicked({ account, code: event.target.value })}>
            {ledger.currencies.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : null}
        {accountName && ledger ? (
          <span className="b-top-balance">
            <span className="b-muted b-top-balance-label">Balance today</span>
            <span className="b-mono">{money(ledger.balanceCents, currency)}</span>
          </span>
        ) : null}
      </Topbar>
      <div className="b-filters">
        <label className="b-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search entries"
            placeholder="Search memo, account, amount, or number"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQ("");
                event.currentTarget.blur();
              } else if (event.key === "Enter" || event.key === "ArrowDown") {
                event.currentTarget.blur();
              }
            }}
          />
          {q ? null : <Kbd>/</Kbd>}
        </label>
        <AccountFilter accounts={accounts} value={account} onChange={(id) => set({ account: id || undefined, entry: undefined })} />
        <select className="b-select" aria-label="Dates" value={range} onChange={(event) => setRange(event.target.value)}>
          {Object.entries(presets).map(([id, preset]) => (
            <option key={id} value={id}>
              {preset.label}
            </option>
          ))}
        </select>
        <Tablist
          label="Show"
          value={show}
          onChange={(next) => set({ show: next === "all" ? undefined : next, entry: undefined })}
          items={[
            { id: "all", label: "All" },
            { id: "missing", label: "No receipt" },
            { id: "receipt", label: "With receipt" },
            { id: "reversed", label: "Reversals" },
          ]}
        />
        {list.refreshing ? <span className="b-spinner" aria-label="Updating" /> : null}
      </div>
      <div className={cx("b-split", selected && "has-inspector")}>
        <div className="b-table-wrap" ref={tableRef}>
          {list.error && !current ? (
            <div className="b-pad">
              <Failure error={list.error} retry={list.reload} title="Could not load entries" />
            </div>
          ) : !current ? (
            <div className="b-pad">
              <Loading rows={14} />
            </div>
          ) : rows.length === 0 ? (
            <Empty icon={<Search size={20} aria-hidden />} title={search || show !== "all" || range !== "all" || account ? "No entries match" : "No entries yet"}>
              {search || show !== "all" || range !== "all" || account
                ? "Try a different search, account, or date range."
                : "Post an entry, import a bank statement, or issue an invoice."}
            </Empty>
          ) : (
            <table
              className={cx("b-grid", ledger && "is-ledger")}
              aria-label="Journal entries"
              aria-rowcount={current.total}
              onPointerMove={(event) => (keyed && (event.movementX || event.movementY) ? setKeyed(false) : undefined)}
            >
              <thead>
                <tr>
                  <th className="col-date">Date</th>
                  <th className="col-source" aria-label="Source" />
                  <th className="col-no b-num">No.</th>
                  <th className="col-memo">Description</th>
                  {ledger ? (
                    <>
                      <th className="b-num col-amt">Debit</th>
                      <th className="b-num col-amt">Credit</th>
                      <th className="b-num col-amt">Balance</th>
                    </>
                  ) : (
                    <>
                      <th className="col-accounts">Accounts</th>
                      <th className="b-num col-amt">Amount</th>
                    </>
                  )}
                  <th className="col-flags" aria-label="Receipt" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.id}
                    data-index={index}
                    aria-selected={row.id === selected}
                    className={cx(index === cursor && (keyed || selected) && "is-cursor", (row.reversed || row.reversesEntryId) && "is-muted")}
                    onClick={() => {
                      setCursor(index);
                      open(row.id);
                    }}
                  >
                    <td className="col-date b-date">{shortDate(row.date)}</td>
                    <td className="col-source">
                      <SourceIcon source={row.source} />
                    </td>
                    <td className="col-no b-num b-subtle">{row.number}</td>
                    <td className="col-memo">
                      <button type="button" className="b-row-link" tabIndex={-1} onClick={(event) => (event.stopPropagation(), setCursor(index), open(row.id))}>
                        {row.memo || "No memo"}
                      </button>
                      {row.reversed ? <span className="b-tag">Reversed</span> : null}
                      {row.reversesEntryId ? <span className="b-tag">Reversal</span> : null}
                    </td>
                    {ledger ? (
                      <>
                        <td className="b-num col-amt">{row.debitCents ? money(row.debitCents, ledger.currency) : ""}</td>
                        <td className="b-num col-amt">{row.creditCents ? money(row.creditCents, ledger.currency) : ""}</td>
                        <td className={cx("b-num col-amt", (row.balanceCents ?? 0) < 0 && "is-negative")}>{money(row.balanceCents ?? 0, ledger.currency)}</td>
                      </>
                    ) : (
                      <>
                        <td className="col-accounts b-subtle">{row.accounts}</td>
                        <td className="b-num col-amt">{money(row.totalCents, row.currency)}</td>
                      </>
                    )}
                    <td className="col-flags">{row.hasReceipt ? <Paperclip size={13} aria-label="Has a receipt" /> : null}</td>
                  </tr>
                ))}
              </tbody>
              {ledger ? (
                <tfoot>
                  <tr>
                    <td colSpan={4}>Totals for these filters</td>
                    <td className="b-num col-amt">{money(current.debitCents ?? 0, ledger.currency)}</td>
                    <td className="b-num col-amt">{money(current.creditCents ?? 0, ledger.currency)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          )}
          {current && (page > 0 || current.nextOffset !== null) ? (
            <div className="b-pager">
              <span className="b-muted">
                {(page * PAGE + 1).toLocaleString()}–{(page * PAGE + rows.length).toLocaleString()} of {current.total.toLocaleString()}
              </span>
              <button type="button" className="b-icon-btn" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={16} aria-hidden />
              </button>
              <button type="button" className="b-icon-btn" aria-label="Next page" disabled={current.nextOffset === null} onClick={() => setPage(page + 1)}>
                <ChevronRight size={16} aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
        {selected ? <EntryInspector key={selected} id={selected} onClose={() => open(null)} onOpen={open} /> : null}
      </div>
    </>
  );
}

function stamp(ms: number) {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function EntryInspector({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data, error, reload } = useBooks<Entry>("getEntry", { id });
  const { go, overview } = useBooksContext();
  const toast = useToast();
  const { run, pending } = useAction();
  const [reversing, setReversing] = useState(false);
  const [reverseDate, setReverseDate] = useState("");
  const lockedThrough = overview?.periods.lockedThrough;
  const firstDate = (date: string) => (lockedThrough && date.slice(0, 7) <= lockedThrough ? (overview?.today ?? today()) : date);
  const panel = useRef<HTMLElement>(null);
  if (error)
    return (
      <aside className="b-inspector" ref={panel}>
        <InspectorHead title="Entry" onClose={onClose} />
        <div className="b-pad">
          <Failure error={error} retry={reload} title="Could not load this entry" />
        </div>
      </aside>
    );
  if (!data)
    return (
      <aside className="b-inspector" aria-busy="true">
        <InspectorHead title="Entry" onClose={onClose} />
        <div className="b-pad">
          <Loading rows={8} />
        </div>
      </aside>
    );
  const debits = data.lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credits = data.lines.reduce((sum, line) => sum + line.creditCents, 0);
  const canReverse = !data.reversedByEntryId && !data.reversesEntryId && data.source !== "invoice";
  return (
    <aside className="b-inspector" aria-label={`Entry ${data.number}`} ref={panel}>
      <InspectorHead
        title={`Entry ${data.number}`}
        onClose={onClose}
        tags={
          <>
            <span className="b-tag">{SOURCE_LABEL[data.source] ?? data.source}</span>
            {data.reversedByEntryId ? <span className="b-tag is-warn">Reversed</span> : null}
            {data.reversesEntryId ? <span className="b-tag is-warn">Reversal</span> : null}
          </>
        }
      />
      <div className={cx("b-insp-body", data.receiptFileId && "has-receipt")}>
        <div className="b-insp-main">
          <div className="b-insp-hero">
            <p className="b-muted">{longDate(data.date)}</p>
            <h2>{data.memo || "No memo"}</h2>
            <p className="b-insp-amount b-mono">{money(data.totalCents, data.currency)}</p>
          </div>
          <table className="b-lines">
            <thead>
              <tr>
                <th>Account</th>
                <th className="b-num">Debit</th>
                <th className="b-num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.lineNo}>
                  <td>
                    <button type="button" className="b-row-link" onClick={() => go({ view: "register", account: line.accountId })}>
                      <span className="b-code">{line.accountId}</span>
                      {line.accountName}
                    </button>
                    {line.memo ? <span className="b-line-memo">{line.memo}</span> : null}
                  </td>
                  <td className="b-num">{line.debitCents ? money(line.debitCents, data.currency) : ""}</td>
                  <td className="b-num">{line.creditCents ? money(line.creditCents, data.currency) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>{debits === credits ? "Balanced" : "Out of balance"}</td>
                <td className="b-num">{money(debits, data.currency)}</td>
                <td className="b-num">{money(credits, data.currency)}</td>
              </tr>
            </tfoot>
          </table>
          <section className="b-insp-section">
            <h3>History</h3>
            <ol className="b-trail">
              {data.bankRow ? (
                <li>
                  <Landmark size={13} aria-hidden />
                  <span>
                    Imported from bank statement line {data.bankRow.lineNo}: <q>{data.bankRow.description}</q>
                  </span>
                  <time>{stamp(data.bankRow.importedAtMs)}</time>
                </li>
              ) : null}
              {data.invoice ? (
                <li>
                  <FileText size={13} aria-hidden />
                  <span>
                    {data.source === "payment"
                      ? "Payment for "
                      : data.source === "invoice"
                        ? "Posted by issuing "
                        : data.invoice.voidEntryId === data.id
                          ? "Voids "
                          : "Reverses the payment for "}
                    <button type="button" className="b-link" onClick={() => go({ view: "invoices", invoice: data.invoice!.id })}>
                      invoice {data.invoice.number ?? "draft"}
                    </button>
                  </span>
                </li>
              ) : null}
              <li>
                <PenLine size={13} aria-hidden />
                <span>Posted as entry {data.number}</span>
                <time>{stamp(data.createdAtMs)}</time>
              </li>
              {data.reversesEntryId ? (
                <li>
                  <RotateCcw size={13} aria-hidden />
                  <span>
                    Reverses{" "}
                    <button type="button" className="b-link" onClick={() => onOpen(data.reversesEntryId!)}>
                      entry {data.reversesNumber}
                    </button>
                  </span>
                </li>
              ) : null}
              {data.reversedByEntryId ? (
                <li>
                  <RotateCcw size={13} aria-hidden />
                  <span>
                    Reversed by{" "}
                    <button type="button" className="b-link" onClick={() => onOpen(data.reversedByEntryId!)}>
                      entry {data.reversedByNumber}
                    </button>
                  </span>
                  {data.reversedAtMs ? <time>{stamp(data.reversedAtMs)}</time> : null}
                </li>
              ) : null}
            </ol>
          </section>
          {canReverse ? (
            <section className="b-insp-section">
              {reversing ? (
                <div className="b-confirm">
                  <p>
                    Posted entries never change. Reversing posts a new entry with every debit and credit swapped, and both stay in the books.
                  </p>
                  <div className="b-confirm-row">
                    <label className="b-inline-field">
                      <span>Reversal date</span>
                      <input className="b-input b-input-date" type="date" min={data.date} max={overview?.today ?? today()} value={reverseDate || firstDate(data.date)} onChange={(event) => setReverseDate(event.target.value)} />
                    </label>
                    <button type="button" className="b-btn" onClick={() => setReversing(false)}>
                      Keep
                    </button>
                    <button
                      type="button"
                      className="b-btn b-btn-danger"
                      disabled={pending !== null}
                      onClick={() =>
                        void run<{ id: string; number: number }>(
                          "reverseJournalEntry",
                          { entryId: data.id, ...((reverseDate || firstDate(data.date)) !== data.date ? { date: reverseDate || firstDate(data.date) } : {}) },
                          {
                            failed: `Could not reverse entry ${data.number}`,
                            after: (created) => {
                              setReversing(false);
                              toast({ message: `Reversed by entry ${created.number}`, action: { label: "Open", run: () => onOpen(created.id) } });
                            },
                          },
                        )
                      }
                    >
                      <RotateCcw size={14} aria-hidden />
                      Reverse entry {data.number}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="b-btn" onClick={() => setReversing(true)}>
                  <RotateCcw size={14} aria-hidden />
                  Reverse
                </button>
              )}
            </section>
          ) : data.source === "invoice" && !data.reversedByEntryId ? (
            <p className="b-insp-note">Void the invoice to reverse this entry.</p>
          ) : null}
        </div>
        <div className="b-insp-receipt">
          {data.receiptFileId ? <ReceiptView entryId={data.id} fileId={data.receiptFileId} /> : <ReceiptDrop entryId={data.id} />}
        </div>
      </div>
    </aside>
  );
}

function InspectorHead({ title, tags, onClose }: { title: string; tags?: React.ReactNode; onClose: () => void }) {
  return (
    <header className="b-insp-head">
      <button type="button" className="b-icon-btn b-insp-back" aria-label="Back to the list" onClick={onClose}>
        <ArrowLeft size={16} aria-hidden />
      </button>
      <strong>{title}</strong>
      <span className="b-insp-tags">{tags}</span>
      <button type="button" className="b-btn b-btn-ghost b-btn-sm b-insp-close" onClick={onClose}>
        Close <Kbd>Esc</Kbd>
      </button>
    </header>
  );
}

function ReceiptView({ entryId, fileId }: { entryId: string; fileId: string }) {
  const app = useApp();
  const { run, pending } = useAction();
  const toast = useToast();
  const [state, setState] = useState<{ url?: string; type?: string; name?: string; error?: unknown }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setState({});
    app
      .file(fileId, "receiptAccess", { entryId })
      .then((reply) => {
        if (!alive) return;
        url = URL.createObjectURL(reply.blob());
        setState({ url, type: reply.file.contentType, name: reply.file.name });
      })
      .catch((error: unknown) => alive && setState({ error }));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [app, entryId, fileId, attempt]);
  if (state.error) return <Failure error={state.error as Error} retry={() => setAttempt((value) => value + 1)} title="Could not load the receipt" />;
  if (!state.url) return <div className="b-receipt is-loading" aria-busy="true" aria-label="Loading receipt" />;
  return (
    <figure className="b-receipt">
      {state.type?.startsWith("image/") ? (
        <img src={state.url} alt={`Receipt ${state.name ?? ""}`} />
      ) : (
        <div className="b-receipt-file">
          <FileText size={28} aria-hidden />
          <span>{state.name}</span>
          <span className="b-muted">PDF receipt</span>
        </div>
      )}
      <figcaption>
        <Paperclip size={12} aria-hidden />
        <span className="b-truncate">{state.name}</span>
        <a className="b-link" href={state.url} download={state.name}>
          Download
        </a>
        <button
          type="button"
          className="b-link"
          disabled={pending !== null}
          onClick={() =>
            void run("removeReceipt", { entryId, fileId }, {
              failed: "Could not remove the receipt",
              after: () =>
                toast({
                  message: "Receipt removed",
                  undo: () => void run("attachReceipt", { entryId, fileId }, { done: "Receipt restored", failed: "Could not restore the receipt" }),
                }),
            })
          }
        >
          Remove
        </button>
      </figcaption>
    </figure>
  );
}

function ReceiptDrop({ entryId }: { entryId: string }) {
  const app = useApp();
  const mutate = useMutate();
  const toast = useToast();
  const { run } = useAction();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const busyRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  async function attach(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const fileId = (await app.upload(file, mutationKey("receipt"))).file.fileId;
      await mutate("attachReceipt", { entryId, fileId });
      toast({
        message: "Receipt attached",
        undo: () => void run("removeReceipt", { entryId, fileId }, { done: "Receipt removed", failed: "Could not remove the receipt" }),
      });
    } catch (error) {
      toast({ tone: "error", message: "Could not attach the receipt", detail: problem(error), action: { label: "Try again", run: () => void attach(file) } });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) void attach(file);
  };
  return (
    <div
      className={cx("b-drop", over && "is-over")}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <ImageIcon size={20} aria-hidden />
      <p>{busy ? "Uploading…" : "No receipt yet"}</p>
      <button type="button" className="b-btn b-btn-sm" disabled={busy} onClick={() => input.current?.click()}>
        <Upload size={14} aria-hidden />
        Attach receipt
      </button>
      <span className="b-muted">PDF or image, or drop it here</span>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="Attach a receipt"
        accept={RECEIPT_TYPES}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void attach(file);
        }}
      />
    </div>
  );
}

interface DraftLine {
  key: number;
  accountId: string;
  memo: string;
  debit: string;
  credit: string;
}

export function Composer({ onClose }: { onClose: () => void }) {
  const { accounts, overview, go } = useBooksContext();
  const app = useApp();
  const mutate = useMutate();
  const toast = useToast();
  const { run } = useAction();
  const [date, setDate] = useState(overview?.today ?? today());
  const [currency, setCurrency] = useState(overview?.currency ?? "USD");
  const [memo, setMemo] = useState("");
  const nextKey = useRef(3);
  const blank = (): DraftLine => ({ key: nextKey.current++, accountId: "", memo: "", debit: "", credit: "" });
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, accountId: "", memo: "", debit: "", credit: "" },
    { key: 2, accountId: "", memo: "", debit: "", credit: "" },
  ]);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; uploadKey: string; uploadedFileId?: string; postKey: string } | null>(null);
  const fields = useRef(new Map<string, HTMLInputElement | null>());
  const focusNext = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const memoInput = useInitialFocus<HTMLInputElement>();
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const parsed = lines.map((line) => ({ accountId: line.accountId, memo: line.memo.trim(), debitCents: parseAmount(line.debit, code), creditCents: parseAmount(line.credit, code) }));
  const invalidAmount = parsed.some((line) => line.debitCents === null || line.creditCents === null || line.debitCents < 0 || line.creditCents < 0);
  const debits = parsed.reduce((sum, line) => sum + (line.debitCents ?? 0), 0);
  const credits = parsed.reduce((sum, line) => sum + (line.creditCents ?? 0), 0);
  const delta = debits - credits;
  const used = parsed.filter((line) => line.accountId || line.debitCents || line.creditCents);
  const incomplete = used.some((line) => !line.accountId || (!line.debitCents && !line.creditCents) || (line.debitCents && line.creditCents));
  const reason = !date
    ? "Choose a date"
    : !/^[A-Z]{3}$/.test(currency)
      ? "Use a three-letter currency"
      : invalidAmount
        ? "Fix the amounts"
        : used.length < 2
          ? "Add at least two lines"
          : incomplete
            ? "Each line needs an account and one amount"
            : delta !== 0
              ? `Off by ${money(Math.abs(delta), code)}`
              : null;
  useEffect(() => {
    if (!receipt || !receipt.type.startsWith("image/")) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(receipt);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [receipt]);
  useEffect(() => {
    if (!focusNext.current) return;
    fields.current.get(focusNext.current)?.focus();
    focusNext.current = null;
  });
  const update = (index: number, patch: Partial<DraftLine>) => setLines((list) => list.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  const balanceLine = (index: number, side: "debit" | "credit") => {
    const others = parsed.filter((_, at) => at !== index);
    const otherDebits = others.reduce((sum, line) => sum + (line.debitCents ?? 0), 0);
    const otherCredits = others.reduce((sum, line) => sum + (line.creditCents ?? 0), 0);
    const need = side === "debit" ? otherCredits - otherDebits : otherDebits - otherCredits;
    if (need > 0) update(index, side === "debit" ? { debit: centsInput(need, code), credit: "" } : { credit: centsInput(need, code), debit: "" });
    else if (need < 0) update(index, side === "debit" ? { credit: centsInput(-need, code), debit: "" } : { debit: centsInput(-need, code), credit: "" });
  };
  const autoBalance = () => {
    if (delta === 0) return;
    const side = delta < 0 ? "debit" : "credit";
    const target = parsed.findLastIndex((line) => !line.debitCents && !line.creditCents);
    if (target < 0) {
      const line = { ...blank(), [side]: centsInput(Math.abs(delta), code) };
      setLines((list) => [...list, line]);
      focusNext.current = `${line.key}:account`;
      return;
    }
    balanceLine(target, side);
    focusNext.current = `${lines[target]!.key}:${side}`;
  };
  const addLine = () => {
    const line = blank();
    setLines((list) => [...list, line]);
    focusNext.current = `${line.key}:account`;
  };
  const amountKeys = (index: number, side: "debit" | "credit") => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "=") {
      event.preventDefault();
      balanceLine(index, side);
    } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const next = lines[index + 1];
      if (next) fields.current.get(`${next.key}:account`)?.focus();
      else addLine();
    }
  };
  async function submit() {
    if (inFlight.current || reason) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const payloadLines = used.map((line) => ({
      accountId: line.accountId,
      ...(line.debitCents ? { debitCents: line.debitCents } : {}),
      ...(line.creditCents ? { creditCents: line.creditCents } : {}),
      ...(line.memo ? { memo: line.memo } : {}),
    }));
    const fingerprint = JSON.stringify({ date, currency, memo: memo.trim(), payloadLines, receipt: receipt ? [receipt.name, receipt.size, receipt.lastModified] : null });
    if (!attempt.current || attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, uploadKey: mutationKey("receipt"), postKey: mutationKey("postJournalEntry") };
    const current = attempt.current;
    try {
      let receiptFileId = current.uploadedFileId;
      if (receipt && !receiptFileId) {
        receiptFileId = (await app.upload(receipt, current.uploadKey)).file.fileId;
        current.uploadedFileId = receiptFileId;
      }
      const created = await mutate<{ id: string; number: number }>(
        "postJournalEntry",
        { date, currency, memo: memo.trim(), lines: payloadLines, ...(receiptFileId ? { receiptFileId } : {}) },
        current.postKey,
      );
      onClose();
      toast({
        message: `Posted as entry ${created.number}`,
        undo: () => void run("reverseJournalEntry", { entryId: created.id }, { done: `Reversed entry ${created.number}`, failed: `Could not undo entry ${created.number}` }),
        action: { label: "Open", run: () => go({ view: "register", entry: created.id }) },
      });
    } catch (failure) {
      setError(problem(failure));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  const dismiss = () => {
    if (!inFlight.current) onClose();
  };
  const ref = (name: string) => (node: HTMLInputElement | null) => {
    fields.current.set(name, node);
  };
  return (
    <Modal
      open
      title="New journal entry"
      onClose={dismiss}
      footer={
        <div className="b-composer-foot">
          <div className={cx("b-balance", reason ? "is-off" : "is-ok")} aria-live="polite">
            {delta !== 0 && !invalidAmount ? (
              <>
                <span className="b-balance-label">{delta > 0 ? "Debits exceed credits by" : "Credits exceed debits by"}</span>
                <strong className="b-mono">{money(Math.abs(delta), code)}</strong>
                <button type="button" className="b-btn b-btn-sm" onClick={autoBalance} title="Put the difference on the last empty line, or on a new one">
                  Balance <Kbd>=</Kbd>
                </button>
              </>
            ) : reason ? (
              <span className="b-balance-label">{reason}</span>
            ) : (
              <span className="b-balance-label">Balanced</span>
            )}
          </div>
          <button type="button" className="b-btn b-btn-primary" disabled={Boolean(reason) || submitting} aria-busy={submitting || undefined} title={reason ?? undefined} onClick={() => void submit()}>
            {submitting ? "Posting…" : "Post entry"}
            <Kbd>{MOD} ↵</Kbd>
          </button>
        </div>
      }
    >
      <div
        className="b-composer"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <div className="b-composer-head">
          <label className="b-inline-field">
            <span>Date</span>
            <input className="b-input b-input-date" type="date" max={overview?.today ?? today()} value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="b-inline-field b-grow">
            <span>Memo</span>
            <input
              className="b-input"
              ref={memoInput}
              value={memo}
              maxLength={500}
              placeholder="What happened"
              onChange={(event) => setMemo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault();
                  fields.current.get(`${lines[0]!.key}:account`)?.focus();
                }
              }}
            />
          </label>
          <label className="b-inline-field">
            <span>Currency</span>
            <input className="b-input b-input-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
          </label>
        </div>
        <table className="b-composer-lines">
          <thead>
            <tr>
              <th>Account</th>
              <th>Line memo</th>
              <th className="b-num">Debit</th>
              <th className="b-num">Credit</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const value = parsed[index]!;
              return (
                <tr key={line.key}>
                  <td className="b-cell-account">
                    <AccountPicker
                      accounts={accounts}
                      value={line.accountId}
                      onChange={(accountId) => update(index, { accountId })}
                      label={`Account on line ${index + 1}`}
                      filter={(account) => account.role !== "receivable"}
                      inputRef={ref(`${line.key}:account`)}
                    />
                  </td>
                  <td>
                    <input className="b-input" aria-label={`Memo on line ${index + 1}`} placeholder="Line memo" ref={ref(`${line.key}:memo`)} value={line.memo} maxLength={200} onChange={(event) => update(index, { memo: event.target.value })} />
                  </td>
                  <td>
                    <input
                      className={cx("b-input b-input-amount", value.debitCents === null && "is-invalid")}
                      inputMode="decimal"
                      aria-label={`Debit on line ${index + 1}`}
                      placeholder="Debit"
                      aria-invalid={value.debitCents === null || undefined}
                      ref={ref(`${line.key}:debit`)}
                      value={line.debit}
                      onChange={(event) => update(index, { debit: event.target.value, credit: event.target.value ? "" : line.credit })}
                      onKeyDown={amountKeys(index, "debit")}
                    />
                  </td>
                  <td>
                    <input
                      className={cx("b-input b-input-amount", value.creditCents === null && "is-invalid")}
                      inputMode="decimal"
                      aria-label={`Credit on line ${index + 1}`}
                      placeholder="Credit"
                      aria-invalid={value.creditCents === null || undefined}
                      ref={ref(`${line.key}:credit`)}
                      value={line.credit}
                      onChange={(event) => update(index, { credit: event.target.value, debit: event.target.value ? "" : line.debit })}
                      onKeyDown={amountKeys(index, "credit")}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="b-icon-btn"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={lines.length <= 2}
                      onClick={() => {
                        focusNext.current = `${lines[index ? index - 1 : 1]!.key}:account`;
                        setLines((list) => list.filter((_, at) => at !== index));
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>
                <button type="button" className="b-btn b-btn-ghost b-btn-sm" onClick={addLine}>
                  <Plus size={14} aria-hidden />
                  Add line
                </button>
              </td>
              <td className="b-num b-mono">{invalidAmount ? "—" : money(debits, code)}</td>
              <td className="b-num b-mono">{invalidAmount ? "—" : money(credits, code)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div className="b-composer-receipt">
          {receipt ? (
            <div className="b-chip">
              {preview ? <img src={preview} alt="" /> : <FileText size={14} aria-hidden />}
              <span className="b-truncate">{receipt.name}</span>
              <button type="button" className="b-icon-btn" aria-label="Remove receipt" onClick={() => setReceipt(null)}>
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          ) : (
            <button type="button" className="b-btn b-btn-ghost b-btn-sm" onClick={() => fileInput.current?.click()}>
              <Paperclip size={14} aria-hidden />
              Attach receipt
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            hidden
            aria-label="Receipt (PDF or image, optional)"
            accept={RECEIPT_TYPES}
            onChange={(event) => {
              setReceipt(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
        </div>
        {error ? (
          <p className="b-form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
