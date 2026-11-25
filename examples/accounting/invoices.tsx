import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Banknote, CircleX, Download, FileText, Pencil, Plus, Send, Trash2 } from "dohc/icons";
import { Modal } from "dohc/ui";
import { Failure, Loading, Tablist, cx, downloadPrintableHtml, longDate, problem, shortDate, today, useBooks } from "./shared";
import { AccountPicker, Empty, Kbd, MOD, Topbar, useAction, useBooksContext, useInitialFocus, useKeys, useMutate, useToast } from "./parts";
import { centsInput, money, parseAmount } from "./amounts";

interface InvoiceSummary {
  id: string;
  number: string | null;
  clientName: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  status: "draft" | "issued" | "paid" | "void";
  paidOn: string | null;
  version: number;
}
interface InvoicePage {
  invoices: InvoiceSummary[];
  counts: Record<string, number>;
  status: Filter | null;
  offset: number;
  nextOffset: number | null;
}
interface Invoice extends InvoiceSummary {
  clientId: string;
  clientEmail: string | null;
  clientAddress: string | null;
  taxRateBp: number;
  subtotalCents: number;
  taxCents: number;
  notes: string | null;
  journalEntryId: string | null;
  voidEntryId: string | null;
  voidFrom: string;
  saleNumber: number | null;
  voidNumber: number | null;
  balanceCents: number;
  payments: Payment[];
  seller: Seller | null;
  lines: Array<{ lineNo: number; description: string; quantityMilli: number; unitPriceCents: number; amountCents: number; revenueAccountId: string }>;
}
interface Payment {
  entryId: string;
  number: number;
  date: string;
  amountCents: number;
}
interface Seller {
  name: string;
  email: string | null;
  address: string | null;
}
interface Client {
  id: string;
  name: string;
  email: string | null;
  address: string | null;
}
type Filter = "all" | "draft" | "issued" | "overdue" | "paid" | "void";

const PAGE = 100;

function displayStatus(invoice: Pick<InvoiceSummary, "status" | "dueDate" | "paidCents">, now: string) {
  if (invoice.status !== "issued") return invoice.status;
  return invoice.dueDate < now ? "overdue" : invoice.paidCents > 0 ? "partial" : "issued";
}

function StatusPill({ status, partial = false }: { status: string; partial?: boolean }) {
  const label: Record<string, string> = { draft: "Draft", issued: "Open", partial: "Part paid", overdue: "Overdue", paid: "Paid", void: "Void" };
  return <span className={cx("b-pill", `is-${status}`)}>{status === "overdue" && partial ? "Overdue · part paid" : (label[status] ?? status)}</span>;
}

export function Invoices() {
  const { route, go, overview } = useBooksContext();
  const now = overview?.today ?? today();
  const [filter, setFilter] = useState<Filter>((["all", "draft", "issued", "overdue", "paid", "void"] as const).find((id) => id === route.show) ?? "all");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Invoice | "new" | null>(null);
  const list = useBooks<InvoicePage>("listInvoices", { limit: PAGE, offset, today: now, ...(filter === "all" ? {} : { status: filter }) }, { keep: true });
  const rows = list.data?.invoices ?? [];
  const page = list.data && list.data.offset === offset && (list.data.status ?? "all") === filter ? list.data : undefined;
  const selected = route.invoice ?? null;
  const counts = list.data?.counts ?? {};
  const [cursorId, setCursorId] = useState<string | null>(selected);
  const cursor = Math.max(0, rows.findIndex((row) => row.id === (selected ?? cursorId)));
  const open = (id: string | null) => go({ view: "invoices", show: filter === "all" ? undefined : filter, invoice: id ?? undefined });
  const move = (step: number) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, cursor + step))];
    if (!next) return;
    setCursorId(next.id);
    if (selected) open(next.id);
  };
  useEffect(() => {
    if (selected) setCursorId(selected);
  }, [selected]);
  useKeys((event) => {
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if ((event.key === "Enter" || event.key === "o") && rows[cursor]) {
      event.preventDefault();
      open(rows[cursor]!.id);
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      open(null);
    } else if (event.key === "c") {
      event.preventDefault();
      setEditing("new");
    }
  });
  return (
    <>
      <Topbar title="Invoices" meta={overview?.receivables.open ? `${money(overview.receivables.openCents, overview.currency)} outstanding` : undefined}>
        <button type="button" className="b-btn b-btn-primary" onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden />
          New invoice
          <Kbd>C</Kbd>
        </button>
      </Topbar>
      <div className="b-filters">
        <Tablist
          label="Invoice status"
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setOffset(0);
            go({ view: "invoices", show: next === "all" ? undefined : next });
          }}
          items={[
            { id: "all", label: "All" },
            { id: "draft", label: "Draft", count: counts.draft ?? 0 },
            { id: "issued", label: "Open", count: counts.issued ?? 0 },
            { id: "overdue", label: "Overdue", count: counts.overdue ?? 0 },
            { id: "paid", label: "Paid", count: counts.paid ?? 0 },
            { id: "void", label: "Void", count: counts.void ?? 0 },
          ]}
        />
        {list.refreshing ? <span className="b-spinner" aria-label="Updating" /> : null}
      </div>
      <div className={cx("b-split b-invoices", selected && "has-inspector")}>
        <div className="b-table-wrap">
          {list.error && !list.data ? (
            <div className="b-pad">
              <Failure error={list.error} retry={list.reload} title="Could not load invoices" />
            </div>
          ) : !list.data ? (
            <div className="b-pad">
              <Loading rows={10} />
            </div>
          ) : rows.length === 0 ? (
            <Empty
              icon={<FileText size={20} aria-hidden />}
              title={filter === "all" ? "No invoices yet" : `No ${filter === "issued" ? "open" : filter} invoices`}
              action={
                filter === "all" ? (
                  <button type="button" className="b-btn b-btn-primary" onClick={() => setEditing("new")}>
                    <Plus size={14} aria-hidden />
                    New invoice
                  </button>
                ) : undefined
              }
            >
              {filter === "all" ? "Issuing an invoice posts it to receivables. Its payment clears it." : null}
            </Empty>
          ) : (
            <table className="b-grid" aria-label="Invoices">
              <thead>
                <tr>
                  <th className="col-inv">Number</th>
                  <th>Client</th>
                  <th className="col-date col-issued">Issued</th>
                  <th className="col-date col-due">Due</th>
                  <th className="col-status">Status</th>
                  <th className="b-num col-amt">Amount</th>
                  <th className="b-num col-amt col-balance">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.id}
                    aria-selected={row.id === selected}
                    className={cx(index === cursor && (selected || cursorId) && "is-cursor", row.status === "void" && "is-muted")}
                    onClick={() => (setCursorId(row.id), open(row.id))}
                  >
                    <td className="col-inv b-mono">
                      <button type="button" className="b-row-link" tabIndex={-1} onClick={(event) => (event.stopPropagation(), open(row.id))}>
                        {row.number ?? "Draft"}
                      </button>
                    </td>
                    <td className="b-truncate">{row.clientName}</td>
                    <td className="col-date col-issued b-date">{row.status === "draft" ? null : shortDate(row.issueDate)}</td>
                    <td className={cx("col-date col-due b-date", displayStatus(row, now) === "overdue" && "is-negative")}>{row.status === "draft" ? null : shortDate(row.dueDate)}</td>
                    <td className="col-status">
                      <StatusPill status={displayStatus(row, now)} partial={row.paidCents > 0} />
                    </td>
                    <td className="b-num col-amt">
                      {money(row.totalCents, row.currency)}
                      {row.status === "issued" && row.paidCents ? <span className="b-amt-due">{money(row.totalCents - row.paidCents, row.currency)} due</span> : null}
                    </td>
                    <td
                      className="b-num col-amt col-balance"
                      title={row.paidCents ? `${money(row.paidCents, row.currency)} paid of ${money(row.totalCents, row.currency)}` : undefined}
                    >
                      {row.status === "issued" ? money(row.totalCents - row.paidCents, row.currency) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list.data && (offset > 0 || list.data.nextOffset !== null) ? (
            <div className="b-pager">
              <button type="button" className="b-btn b-btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </button>
              <button type="button" className="b-btn b-btn-sm" disabled={!page || page.nextOffset === null} onClick={() => page?.nextOffset != null && setOffset(page.nextOffset)}>
                Next
              </button>
            </div>
          ) : null}
        </div>
        {selected ? <InvoicePane key={selected} id={selected} now={now} onClose={() => open(null)} onEdit={setEditing} /> : null}
      </div>
      {editing ? <InvoiceEditor invoice={editing === "new" ? undefined : editing} onClose={(id) => (setEditing(null), id ? open(id) : undefined)} /> : null}
    </>
  );
}

function InvoicePane({ id, now, onClose, onEdit }: { id: string; now: string; onClose: () => void; onEdit: (invoice: Invoice) => void }) {
  const { data, error, reload } = useBooks<Invoice>("getInvoice", { id });
  const { accounts, go, overview } = useBooksContext();
  const { run, pending } = useAction();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const toast = useToast();
  const [mode, setMode] = useState<"pay" | "void" | "delete" | null>(null);
  const banks = accounts.filter((account) => account.isBank && !account.archived);
  const [paidOn, setPaidOn] = useState(now);
  const [amount, setAmount] = useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState(banks[0]?.id ?? "");
  const [voidDate, setVoidDate] = useState("");
  const paper = useRef<HTMLDivElement>(null);
  const back = (
    <button type="button" className="b-icon-btn b-insp-back" aria-label="Back to invoices" onClick={onClose}>
      <ArrowLeft size={16} aria-hidden />
    </button>
  );
  const close = (
    <button type="button" className="b-btn b-btn-ghost b-btn-sm b-insp-close" onClick={onClose}>
      Close <Kbd>Esc</Kbd>
    </button>
  );
  if (error)
    return (
      <aside className="b-inspector b-invoice-pane">
        <header className="b-insp-head b-no-print">
          {back}
          {close}
        </header>
        <div className="b-pad">
          <Failure error={error} retry={reload} title="Could not load this invoice" />
        </div>
      </aside>
    );
  if (!data)
    return (
      <aside className="b-inspector b-invoice-pane" aria-busy="true">
        <header className="b-insp-head b-no-print">
          {back}
          {close}
        </header>
        <div className="b-pad">
          <Loading rows={10} />
        </div>
      </aside>
    );
  const version = { id: data.id, expectedVersion: data.version };
  const lockedThrough = overview?.periods.lockedThrough;
  const voidDefault = lockedThrough && data.voidFrom.slice(0, 7) <= lockedThrough ? now : data.voidFrom;
  const label = data.number ?? "draft";
  const amountText = amount ?? centsInput(data.balanceCents, data.currency);
  const amountCents = parseAmount(amountText, data.currency);
  const amountOk = amountCents !== null && amountCents > 0 && amountCents <= data.balanceCents;
  const pay = () => {
    if (!amountOk || !bankAccountId || !paidOn) return;
    void run<{ paymentEntryId: string; balanceCents: number }>("recordPayment", { ...version, date: paidOn, bankAccountId, amountCents }, {
      failed: "Could not record the payment",
      after: (result) => {
        setMode(null);
        setAmount(null);
        toast({
          message: result.balanceCents ? `Recorded ${money(amountCents, data.currency)}, ${money(result.balanceCents, data.currency)} still due` : `${label} is paid in full`,
          undo: () => void run("reverseJournalEntry", { entryId: result.paymentEntryId }, { done: `Reversed, ${label} is open again`, failed: "Could not undo the payment" }),
        });
      },
    });
  };
  return (
    <aside className="b-inspector b-invoice-pane" aria-label={`Invoice ${label}`}>
      <header className="b-insp-head b-no-print">
        {back}
        <div className="b-insp-actions">
          {data.status === "draft" ? (
            <>
              <button type="button" className="b-btn b-btn-primary" disabled={pending !== null} onClick={() => void run("issueInvoice", version, { done: "Issued and posted to receivables", failed: "Could not issue the invoice" })}>
                <Send size={14} aria-hidden />
                Issue
              </button>
              <button type="button" className="b-btn" onClick={() => onEdit(data)}>
                <Pencil size={14} aria-hidden />
                Edit
              </button>
              <button type="button" className="b-icon-btn" aria-label="Delete draft" onClick={() => setMode(mode === "delete" ? null : "delete")}>
                <Trash2 size={15} aria-hidden />
              </button>
            </>
          ) : null}
          {data.status === "issued" ? (
            <>
              <button type="button" className="b-btn b-btn-primary" onClick={() => setMode(mode === "pay" ? null : "pay")}>
                <Banknote size={14} aria-hidden />
                Record payment
              </button>
              <button
                type="button"
                className="b-btn"
                disabled={data.paidCents > 0}
                title={data.paidCents > 0 ? "Reverse its payments before voiding" : undefined}
                onClick={() => setMode(mode === "void" ? null : "void")}
              >
                <CircleX size={14} aria-hidden />
                Void
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="b-btn"
            onClick={() => downloadPrintableHtml(`invoice-${label}.html`, `Invoice ${label}`, paper.current)}
            title="Download a printable copy"
          >
            <Download size={14} aria-hidden />
            Printable
          </button>
        </div>
        {close}
      </header>
      {data.status === "issued" && data.paidCents > 0 ? <p className="b-hint b-touch-only">Reverse its payments to void this invoice.</p> : null}
      {mode === "pay" ? (
        <form
          className="b-sheet-form b-no-print"
          onSubmit={(event) => {
            event.preventDefault();
            pay();
          }}
        >
          <label className="b-inline-field">
            <span>Amount</span>
            <input
              className={cx("b-input b-input-amount", !amountOk && "is-invalid")}
              inputMode="decimal"
              aria-label="Payment amount"
              value={amountText}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="b-inline-field">
            <span>Paid on</span>
            <input className="b-input b-input-date" type="date" min={data.issueDate} max={now} value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </label>
          <label className="b-inline-field">
            <span>Into</span>
            <select className="b-select" value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>
              {banks.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.id} {account.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="b-btn b-btn-primary" disabled={!amountOk || !bankAccountId || !paidOn || pending !== null}>
            Post {amountOk ? money(amountCents, data.currency) : "payment"}
          </button>
        </form>
      ) : null}
      {mode === "void" ? (
        <div className="b-sheet-form is-danger b-no-print">
          <p>The invoice keeps its number, and a reversing entry cancels the sale.</p>
          <label className="b-inline-field">
            <span>Void on</span>
            <input className="b-input b-input-date" type="date" min={data.voidFrom} max={now} value={voidDate || voidDefault} onChange={(event) => setVoidDate(event.target.value)} />
          </label>
          <button type="button" className="b-btn" onClick={() => setMode(null)}>
            Keep
          </button>
          <button
            type="button"
            className="b-btn b-btn-danger"
            disabled={pending !== null}
            onClick={() =>
              void run("voidInvoice", { ...version, ...((voidDate || voidDefault) !== data.voidFrom ? { date: voidDate || voidDefault } : {}) }, { done: `Voided ${label}`, failed: "Could not void the invoice", after: () => setMode(null) })
            }
          >
            Void {label}
          </button>
        </div>
      ) : null}
      {mode === "delete" ? (
        <div className="b-sheet-form is-danger b-no-print">
          <p>Delete this draft? It was never posted, so the books don't change.</p>
          <button type="button" className="b-btn" onClick={() => setMode(null)}>
            Keep
          </button>
          <button type="button" className="b-btn b-btn-danger" disabled={pending !== null} onClick={() => void run("deleteDraftInvoice", version, { done: "Draft deleted", failed: "Could not delete the draft", after: () => alive.current && onClose() })}>
            Delete draft
          </button>
        </div>
      ) : null}
      {data.journalEntryId ? (
        <nav className="b-doc-links b-no-print" aria-label="Journal entries">
          <span className="b-subtle">In the books</span>
          {[
            ["Sale", data.journalEntryId, data.saleNumber] as const,
            ...data.payments.map((payment) => ["Payment", payment.entryId, payment.number] as const),
            ["Void", data.voidEntryId, data.voidNumber] as const,
          ].map(([kind, entry, number]) =>
            entry ? (
              <button key={entry} type="button" className="b-link" onClick={() => go({ view: "register", entry })}>
                {kind} · entry {number}
              </button>
            ) : null,
          )}
        </nav>
      ) : null}
      <div className="b-insp-scroll b-paper-desk">
        <div ref={paper}>
          <InvoiceDocument invoice={data} status={displayStatus(data, now)} />
        </div>
      </div>
    </aside>
  );
}

interface DocumentData {
  number: string | null;
  clientName: string;
  clientEmail: string | null;
  clientAddress: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  taxRateBp: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
  paidOn: string | null;
  paidCents: number;
  seller: Seller | null;
  lines: Array<{ lineNo: number; description: string; quantityMilli: number; unitPriceCents: number; amountCents: number }>;
}

function quantity(milli: number) {
  return (milli / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function InvoiceDocument({ invoice, status }: { invoice: DocumentData; status: string }) {
  return (
    <article className="b-invoice">
      <header className="b-invoice-head">
        <div>
          <p className="b-invoice-kicker">Invoice</p>
          <div className="b-invoice-number">
            <h2 className="b-mono">{invoice.number ?? "Draft"}</h2>
            <StatusPill status={status} partial={invoice.paidCents > 0 && !invoice.paidOn} />
          </div>
        </div>
        {invoice.seller ? (
          <address className="b-invoice-from">
            <strong>{invoice.seller.name}</strong>
            {invoice.seller.address ? <span className="b-pre">{invoice.seller.address}</span> : null}
            {invoice.seller.email ? <span>{invoice.seller.email}</span> : null}
          </address>
        ) : null}
      </header>
      <dl className="b-invoice-meta">
        <div>
          <dt>Billed to</dt>
          <dd>
            <strong>{invoice.clientName || "Client"}</strong>
            {invoice.clientAddress ? <span className="b-pre">{invoice.clientAddress}</span> : null}
            {invoice.clientEmail ? <span>{invoice.clientEmail}</span> : null}
          </dd>
        </div>
        <div>
          <dt>{status === "draft" ? "Dated" : "Issued"}</dt>
          <dd>{longDate(invoice.issueDate)}</dd>
          <dt>Due</dt>
          <dd>{longDate(invoice.dueDate)}</dd>
        </div>
        <div className="b-invoice-due">
          <dt>{status === "void" ? "Void" : invoice.paidOn ? "Paid" : "Amount due"}</dt>
          <dd className={cx("b-mono", status === "void" && "is-void")}>
            {money(status === "void" || invoice.paidOn ? invoice.totalCents : invoice.totalCents - invoice.paidCents, invoice.currency)}
          </dd>
        </div>
      </dl>
      <table className="b-invoice-lines">
        <thead>
          <tr>
            <th>Description</th>
            <th className="b-num">Qty</th>
            <th className="b-num">Unit price</th>
            <th className="b-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.lineNo}>
              <td>{line.description || " "}</td>
              <td className="b-num">{quantity(line.quantityMilli)}</td>
              <td className="b-num">{money(line.unitPriceCents, invoice.currency)}</td>
              <td className="b-num">{money(line.amountCents, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Subtotal</td>
            <td className="b-num">{money(invoice.subtotalCents, invoice.currency)}</td>
          </tr>
          {invoice.taxRateBp ? (
            <tr>
              <td colSpan={3}>Sales tax {(invoice.taxRateBp / 100).toLocaleString()}%</td>
              <td className="b-num">{money(invoice.taxCents, invoice.currency)}</td>
            </tr>
          ) : null}
          <tr className="b-invoice-total">
            <td colSpan={3}>Total</td>
            <td className="b-num">{money(invoice.totalCents, invoice.currency)}</td>
          </tr>
          {invoice.paidCents > 0 && !invoice.paidOn ? (
            <>
              <tr>
                <td colSpan={3}>Paid</td>
                <td className="b-num">{money(-invoice.paidCents, invoice.currency)}</td>
              </tr>
              <tr className="b-invoice-total">
                <td colSpan={3}>Amount due</td>
                <td className="b-num">{money(invoice.totalCents - invoice.paidCents, invoice.currency)}</td>
              </tr>
            </>
          ) : null}
        </tfoot>
      </table>
      {invoice.notes ? <p className="b-invoice-notes b-pre">{invoice.notes}</p> : null}
      {invoice.paidOn ? <p className="b-invoice-paid">Paid in full on {longDate(invoice.paidOn)}. Thank you.</p> : null}
    </article>
  );
}

interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  price: string;
  revenueAccountId: string;
}

const MAX_INVOICE_CENTS = 1_000_000_000_000;

function InvoiceEditor({ invoice, onClose }: { invoice?: Invoice; onClose: (id?: string) => void }) {
  const { accounts, overview } = useBooksContext();
  const clients = useBooks<Client[]>("listClients", {});
  const business = useBooks<Seller | null>("getBusiness", {});
  const [sellerDraft, setSellerDraft] = useState<{ name: string; email: string; address: string } | null>(null);
  const editingSeller = sellerDraft ?? (business.data === null ? { name: "", email: "", address: "" } : null);
  const editSeller = (patch: Partial<{ name: string; email: string; address: string }>) => setSellerDraft({ ...editingSeller!, ...patch });
  const mutate = useMutate();
  const toast = useToast();
  const now = overview?.today ?? today();
  const plus30 = new Date(Date.parse(`${now}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const income = accounts.find((account) => account.type === "income" && !account.archived)?.id ?? "";
  const [pickedClient, setClientId] = useState(invoice?.clientId ?? "");
  const [newClient, setNewClient] = useState({ name: "", email: "", address: "" });
  const typeClient = (patch: Partial<typeof newClient>) => {
    setNewClient((typed) => ({ ...typed, ...patch }));
    setClientId((picked) => picked || "new");
  };
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? now);
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? plus30);
  const [currency, setCurrency] = useState(invoice?.currency ?? overview?.currency ?? "USD");
  const [taxRate, setTaxRate] = useState(invoice ? String(invoice.taxRateBp / 100) : "0");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const nextKey = useRef((invoice?.lines.length ?? 1) + 1);
  const [lines, setLines] = useState<LineDraft[]>(
    invoice?.lines.map((line, index) => ({
      key: index + 1,
      description: line.description,
      quantity: String(line.quantityMilli / 1000),
      price: centsInput(line.unitPriceCents, invoice.currency),
      revenueAccountId: line.revenueAccountId,
    })) ?? [{ key: 1, description: "", quantity: "1", price: "", revenueAccountId: income }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useInitialFocus<HTMLSelectElement>();
  const focusLast = useRef(false);
  const lastLine = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focusLast.current) {
      lastLine.current?.focus();
      focusLast.current = false;
    }
  });
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const parsed = lines.map((line) => {
    const qty = Number(line.quantity);
    const milli = Math.round(qty * 1000);
    const price = parseAmount(line.price, code);
    const quantityOk = Number.isFinite(qty) && Math.abs(qty * 1000 - milli) <= 1e-6 && milli >= 1 && milli <= 1_000_000_000;
    const product = price !== null && quantityOk ? milli * price : null;
    return {
      description: line.description.trim(),
      quantity: qty,
      quantityOk,
      unitPriceCents: price,
      revenueAccountId: line.revenueAccountId,
      amountCents: product !== null && Number.isSafeInteger(product) ? Math.floor((product + 500) / 1000) : null,
    };
  });
  const taxRateBp = Math.round(Number(taxRate) * 100);
  const subtotal = parsed.reduce((sum, line) => sum + (line.amountCents ?? 0), 0);
  const taxProduct = subtotal * taxRateBp;
  const tax = Number.isSafeInteger(taxProduct) ? Math.floor((taxProduct + 5000) / 10000) : 0;
  const tooLarge = parsed.some((line) => line.quantityOk && line.unitPriceCents !== null && line.amountCents === null) || !Number.isSafeInteger(taxProduct) || subtotal + tax > MAX_INVOICE_CENTS;
  const clientId = pickedClient || (invoice ? "" : (clients.data?.[0]?.id ?? ""));
  const creating = clientId === "new" || (!clientId && !clients.data?.length);
  const client = clients.data?.find((row) => row.id === clientId);
  const sellerTyped = Boolean(editingSeller && (editingSeller.name.trim() || editingSeller.email.trim() || editingSeller.address.trim()));
  const seller: Seller | null =
    editingSeller && sellerTyped
      ? { name: editingSeller.name.trim(), email: editingSeller.email.trim() || null, address: editingSeller.address.trim() || null }
      : (business.data ?? null);
  const reason = editingSeller && !editingSeller.name.trim()
    ? "Name your business"
    : creating && !newClient.name.trim()
    ? "Name the client"
    : !creating && !clientId
      ? "Choose a client"
      : !/^[A-Z]{3}$/.test(currency)
        ? "Enter a three-letter currency code"
      : !Number.isFinite(taxRateBp) || taxRateBp < 0 || taxRateBp > 10000
        ? "Enter a tax rate from 0 to 100"
        : dueDate < issueDate
          ? "The due date is before the issue date"
          : parsed.some((line) => !line.description)
            ? "Describe each line"
            : parsed.some((line) => !line.quantityOk)
              ? "Enter each quantity with up to three decimals"
              : parsed.some((line) => line.unitPriceCents === null || line.unitPriceCents < 0)
                ? "Fix the prices"
                : parsed.some((line) => !line.revenueAccountId)
                  ? "Choose an income account for each line"
                  : tooLarge
                    ? "The invoice total is too large"
                    : null;
  async function save() {
    if (reason || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await mutate<{ id: string }>("saveDraftInvoice", {
        ...(invoice ? { id: invoice.id, expectedVersion: invoice.version } : {}),
        ...(editingSeller && seller
          ? { business: { name: seller.name, ...(seller.email ? { email: seller.email } : {}), ...(seller.address ? { address: seller.address } : {}) } }
          : {}),
        ...(creating
          ? {
              client: {
                name: newClient.name.trim(),
                ...(newClient.email.trim() ? { email: newClient.email.trim() } : {}),
                ...(newClient.address.trim() ? { address: newClient.address.trim() } : {}),
              },
            }
          : { clientId }),
        issueDate,
        dueDate,
        currency,
        taxRateBp,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: parsed.map((line) => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents!, revenueAccountId: line.revenueAccountId })),
      });
      toast({ message: invoice ? "Draft saved" : "Draft created" });
      onClose(result.id);
    } catch (failure) {
      setError(problem(failure));
    } finally {
      setSaving(false);
    }
  }
  const update = (index: number, patch: Partial<LineDraft>) => setLines((list) => list.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  const addLine = () => {
    focusLast.current = true;
    setLines((list) => [...list, { key: nextKey.current++, description: "", quantity: "1", price: "", revenueAccountId: list[list.length - 1]?.revenueAccountId ?? income }]);
  };
  return (
    <Modal
      open
      title={invoice ? `Edit draft ${invoice.number ?? ""}`.trim() : "New invoice"}
      onClose={() => (saving ? undefined : onClose())}
      footer={
        <div className="b-composer-foot">
          <span className="b-balance-label">{reason ?? `Total ${money(subtotal + tax, code)}`}</span>
          <button type="button" className="b-btn b-btn-primary" disabled={Boolean(reason) || saving} aria-busy={saving || undefined} onClick={() => void save()}>
            {saving ? "Saving…" : "Save draft"}
            {saving ? null : <Kbd>{MOD} ↵</Kbd>}
          </button>
        </div>
      }
    >
      <div
        className="b-invoice-editor"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <div className="b-invoice-form">
          {editingSeller ? (
            <div className="b-form-grid">
              <label className="b-field">
                <span className="b-field-label">From</span>
                <input className="b-input" value={editingSeller.name} maxLength={150} placeholder="Your business name" onChange={(event) => editSeller({ name: event.target.value })} />
              </label>
              <label className="b-field">
                <span className="b-field-label">Your email</span>
                <input className="b-input" type="email" value={editingSeller.email} maxLength={200} onChange={(event) => editSeller({ email: event.target.value })} />
              </label>
              <label className="b-field b-span-2">
                <span className="b-field-label">Your address</span>
                <textarea className="b-input" rows={2} value={editingSeller.address} maxLength={500} onChange={(event) => editSeller({ address: event.target.value })} />
              </label>
            </div>
          ) : business.data ? (
            <div className="b-field">
              <span className="b-field-label">From</span>
              <div className="b-from">
                <span className="b-truncate">{business.data.name}</span>
                <button
                  type="button"
                  className="b-link"
                  onClick={() => setSellerDraft({ name: business.data!.name, email: business.data!.email ?? "", address: business.data!.address ?? "" })}
                >
                  Edit
                </button>
              </div>
            </div>
          ) : null}
          <label className="b-field">
            <span className="b-field-label">Client</span>
            {clients.error ? (
              <Failure error={clients.error} retry={clients.reload} title="Could not load clients" />
            ) : (
              <select className="b-select" value={creating ? "new" : clientId} onChange={(event) => setClientId(event.target.value)} ref={first}>
                {clients.data?.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
                <option value="new">New client…</option>
              </select>
            )}
          </label>
          {creating ? (
            <div className="b-form-grid">
              <label className="b-field">
                <span className="b-field-label">Client name</span>
                <input className="b-input" value={newClient.name} maxLength={150} onChange={(event) => typeClient({ name: event.target.value })} />
              </label>
              <label className="b-field">
                <span className="b-field-label">Email</span>
                <input className="b-input" type="email" value={newClient.email} maxLength={200} onChange={(event) => typeClient({ email: event.target.value })} />
              </label>
              <label className="b-field b-span-2">
                <span className="b-field-label">Address</span>
                <textarea className="b-input" rows={2} value={newClient.address} maxLength={500} onChange={(event) => typeClient({ address: event.target.value })} />
              </label>
            </div>
          ) : null}
          <div className="b-form-grid is-4">
            <label className="b-field">
              <span className="b-field-label">Issued</span>
              <input className="b-input b-input-date" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
            </label>
            <label className="b-field">
              <span className="b-field-label">Due</span>
              <input className="b-input b-input-date" type="date" min={issueDate} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </label>
            <label className="b-field">
              <span className="b-field-label">Currency</span>
              <input className="b-input b-input-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
            </label>
            <label className="b-field">
              <span className="b-field-label">Tax %</span>
              <input className="b-input b-input-amount" inputMode="decimal" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} />
            </label>
          </div>
          <table className="b-composer-lines b-invoice-edit-lines">
            <thead>
              <tr>
                <th>Description</th>
                <th className="b-num">Qty</th>
                <th className="b-num">Price</th>
                <th>Income account</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td>
                    <input
                      className="b-input"
                      aria-label={`Description on line ${index + 1}`}
                      placeholder="Description"
                      ref={index === lines.length - 1 ? lastLine : undefined}
                      value={line.description}
                      maxLength={300}
                      onChange={(event) => update(index, { description: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="b-input b-input-amount b-input-qty"
                      aria-label={`Quantity on line ${index + 1}`}
                      placeholder="Qty"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => update(index, { quantity: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className={cx("b-input b-input-amount", parsed[index]!.unitPriceCents === null && "is-invalid")}
                      aria-label={`Price on line ${index + 1}`}
                      placeholder="Price"
                      inputMode="decimal"
                      value={line.price}
                      onChange={(event) => update(index, { price: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && index === lines.length - 1) {
                          event.preventDefault();
                          addLine();
                        }
                      }}
                    />
                  </td>
                  <td className="b-cell-account">
                    <AccountPicker
                      accounts={accounts}
                      value={line.revenueAccountId}
                      onChange={(revenueAccountId) => update(index, { revenueAccountId })}
                      label={`Income account on line ${index + 1}`}
                      filter={(account) => account.type === "income"}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="b-icon-btn"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={lines.length <= 1}
                      onClick={() => {
                        focusLast.current = true;
                        setLines((list) => list.filter((_, at) => at !== index));
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="b-btn b-btn-ghost b-btn-sm" onClick={addLine}>
            <Plus size={14} aria-hidden />
            Add line
          </button>
          <label className="b-field">
            <span className="b-field-label">Notes</span>
            <textarea className="b-input" rows={2} value={notes} maxLength={1000} placeholder="Payment terms, bank details, or a thank-you" onChange={(event) => setNotes(event.target.value)} />
          </label>
          {error ? (
            <p className="b-form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="b-invoice-preview" aria-label="Preview">
          <InvoiceDocument
            status="draft"
            invoice={{
              number: invoice?.number ?? null,
              clientName: creating ? newClient.name : (client?.name ?? ""),
              clientEmail: creating ? newClient.email || null : (client?.email ?? null),
              clientAddress: creating ? newClient.address || null : (client?.address ?? null),
              issueDate,
              dueDate,
              currency: code,
              taxRateBp: Number.isFinite(taxRateBp) ? taxRateBp : 0,
              subtotalCents: subtotal,
              taxCents: tax,
              totalCents: subtotal + tax,
              notes: notes.trim() || null,
              paidOn: null,
              paidCents: 0,
              seller,
              lines: parsed.map((line, index) => ({
                lineNo: index + 1,
                description: line.description,
                quantityMilli: line.quantityOk ? Math.round(line.quantity * 1000) : 0,
                unitPriceCents: line.unitPriceCents ?? 0,
                amountCents: line.amountCents ?? 0,
              })),
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
