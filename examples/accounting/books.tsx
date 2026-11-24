import { useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, mutationKey, useApp } from "dohc/app";
import { BarChart } from "dohc/charts";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Grid,
  Input,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  Skeleton,
  Stack,
  StatCard,
  Tabs,
  Textarea,
} from "dohc/ui";
import {
  Failure,
  RefreshProvider,
  Reports,
  Table,
  downloadPrintableHtml,
  money,
  parseMoney,
  problem,
  today,
  useBooks,
  useRefresh,
  type AccountType,
} from "./shared";
import { importIdFor, mapStatement, parseCsv, statementBatches, type DateOrder } from "./statement";
import "./books.css";

interface Account {
  id: string;
  name: string;
  type: AccountType;
  role: string | null;
  isBank: boolean;
  archived: boolean;
  used: boolean;
}
interface Overview {
  today: string;
  currency: string;
  currencies: string[];
  cash: Array<{ id: string; name: string; balanceCents: number }>;
  cashCents: number;
  receivables: { open: number; openCents: number; overdue: number; overdueCents: number };
  newBankRows: number;
  yearToDate: {
    incomeCents: number;
    expenseCents: number;
    netIncomeCents: number;
    months: Array<{ month: string; incomeCents: number; expenseCents: number }>;
  };
  hasPeriods: boolean;
}
interface EntrySummary {
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
  accounts: string | null;
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
  reversedByEntryId: string | null;
  totalCents: number;
  receiptFileId: string | null;
  lines: Array<{ lineNo: number; accountId: string; accountName: string; debitCents: number; creditCents: number; memo: string | null }>;
}
interface Period {
  id: string;
  startDate: string;
  endDate: string;
  status: "open" | "locked";
  entries: number;
}
interface BankRow {
  id: string;
  importId: string;
  lineNo: number;
  bankAccountId: string;
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  status: string;
  journalEntryId: string | null;
  rowHash: string;
}
interface Client {
  id: string;
  name: string;
  email: string | null;
  address: string | null;
}
interface InvoiceSummary {
  id: string;
  number: string | null;
  clientName: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalCents: number;
  status: "draft" | "issued" | "paid" | "void";
  version: number;
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
  paymentEntryId: string | null;
  voidEntryId: string | null;
  paidOn: string | null;
  lines: Array<{ lineNo: number; description: string; quantityMilli: number; unitPriceCents: number; amountCents: number; revenueAccountId: string }>;
}

const STATUS_TONE = { draft: "neutral", issued: "warning", paid: "success", void: "danger" } as const;

function useRun() {
  const client = useApp();
  const bump = useRefresh();
  return async function run<T>(operation: string, input: unknown, key = mutationKey(operation), refresh = true) {
    const reply = await client.invoke<T>(operation, input, key);
    if (refresh) bump();
    return reply.result;
  };
}

function useAction() {
  const run = useRun();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act<T>(operation: string, input: unknown, done?: (result: T) => void, refresh = true) {
    setPending(true);
    setError(null);
    try {
      const result = await run<T>(operation, input, undefined, refresh);
      done?.(result);
      return result;
    } catch (failure) {
      setError(problem(failure));
      return undefined;
    } finally {
      setPending(false);
    }
  }
  return { act, pending, error, clear: () => setError(null) };
}

function ActionError({ error }: { error: string | null }) {
  return error ? <Callout tone="danger">{error}</Callout> : null;
}

function useAccounts() {
  return useBooks<Account[]>("listAccounts", {});
}

function AccountSelect({ accounts, value, onChange, id, filter, placeholder = "Choose an account" }: {
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  filter?: (account: Account) => boolean;
  placeholder?: string;
}) {
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-label={placeholder}>
      <option value="">{placeholder}</option>
      {accounts
        .filter((account) => !account.archived && (!filter || filter(account)))
        .map((account) => (
          <option key={account.id} value={account.id}>
            {account.id} {account.name}
          </option>
        ))}
    </Select>
  );
}

function OverviewPanel({ go }: { go: (tab: string) => void }) {
  const { data, loading, error, reload } = useBooks<Overview>("overview", { today: today() });
  const { act, pending, error: openError } = useAction();
  if (error) return <Failure error={error} retry={reload} />;
  if (loading || !data) return <Skeleton height={320} />;
  if (!data.hasPeriods) {
    const year = Number(today().slice(0, 4));
    return (
      <Card>
        <EmptyState
          title="Open your first fiscal year"
          description="Entries need an open period. Opening a year adds twelve monthly periods that you can lock when each month is closed."
          action={
            <Stack gap={8}>
              <Button loading={pending} onClick={() => void act("addFiscalYear", { year })}>
                Open {year}
              </Button>
              <ActionError error={openError} />
            </Stack>
          }
        />
      </Card>
    );
  }
  const code = data.currency;
  const months = data.yearToDate.months;
  return (
    <Stack gap={16}>
      <Grid cols={4}>
        <StatCard label="Cash" value={money(data.cashCents, code)} hint={data.cash.map((row) => row.name).join(", ") || "No bank activity"} />
        <StatCard
          label="Owed to you"
          value={money(data.receivables.openCents, code)}
          hint={`${data.receivables.open} open, ${data.receivables.overdue} overdue`}
          tone={data.receivables.overdue ? "warning" : "neutral"}
        />
        <StatCard
          label="Net income this year"
          value={money(data.yearToDate.netIncomeCents, code)}
          tone={data.yearToDate.netIncomeCents < 0 ? "danger" : "success"}
        />
        <StatCard
          label="Bank rows to review"
          value={String(data.newBankRows)}
          footer={
            data.newBankRows ? (
              <Button size="sm" variant="ghost" onClick={() => go("bank")}>
                Review
              </Button>
            ) : undefined
          }
        />
      </Grid>
      <Card title="Income and expenses" subtitle={`${data.today.slice(0, 4)} by month, ${code}`}>
        {months.length ? (
          <BarChart
            labels={months.map((row) => row.month)}
            series={[
              { name: "Income", values: months.map((row) => row.incomeCents / 100) },
              { name: "Expenses", values: months.map((row) => row.expenseCents / 100) },
            ]}
            height={220}
            formatValue={(value) => money(Math.round(value * 100), code)}
            ariaLabel="Income and expenses by month"
          />
        ) : (
          <EmptyState title="No income or expenses yet" description="Post an entry, import a bank statement, or issue an invoice." />
        )}
      </Card>
    </Stack>
  );
}

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
}
function EntryForm({ onClose }: { onClose: () => void }) {
  const accounts = useAccounts();
  const app = useApp();
  const run = useRun();
  const [date, setDate] = useState(today());
  const [currency, setCurrency] = useState("USD");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { accountId: "", debit: "", credit: "" },
    { accountId: "", debit: "", credit: "" },
  ]);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ fingerprint: string; uploadKey: string; uploadedFileId?: string; postKey: string } | null>(null);
  const parsed = lines.map((line) => ({
    accountId: line.accountId,
    debitCents: line.debit.trim() ? parseMoney(line.debit) : 0,
    creditCents: line.credit.trim() ? parseMoney(line.credit) : 0,
  }));
  const debits = parsed.reduce((sum, line) => sum + (line.debitCents ?? 0), 0);
  const credits = parsed.reduce((sum, line) => sum + (line.creditCents ?? 0), 0);
  const invalidAmount = parsed.some(
    (line) => line.debitCents === null || line.creditCents === null || (line.debitCents ?? 0) < 0 || (line.creditCents ?? 0) < 0,
  );
  const balanced = !invalidAmount && debits === credits && debits > 0;
  const ready = balanced && memo.trim() && parsed.every((line) => line.accountId && (line.debitCents || line.creditCents));
  const update = (index: number, patch: Partial<DraftLine>) =>
    setLines((list) => list.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const fingerprint = JSON.stringify({
      date,
      currency,
      memo: memo.trim(),
      lines: parsed,
      receipt: receipt ? [receipt.name, receipt.size, receipt.lastModified] : null,
    });
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = {
        fingerprint,
        uploadKey: mutationKey("receipt"),
        postKey: mutationKey("postJournalEntry"),
      };
    }
    const current = attempt.current;
    try {
      let receiptFileId = current.uploadedFileId;
      if (receipt && !receiptFileId) {
        receiptFileId = (await app.upload(receipt, current.uploadKey)).file.fileId;
        current.uploadedFileId = receiptFileId;
      }
      await run(
        "postJournalEntry",
        {
          date,
          currency,
          memo: memo.trim(),
          lines: parsed.map((line) => ({
            accountId: line.accountId,
            ...(line.debitCents ? { debitCents: line.debitCents } : {}),
            ...(line.creditCents ? { creditCents: line.creditCents } : {}),
          })),
          ...(receiptFileId ? { receiptFileId } : {}),
        },
        current.postKey,
      );
      onClose();
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
  return (
    <Modal
      open
      title="New journal entry"
      onClose={dismiss}
      footer={
        <Stack direction="horizontal" justify="flex-end" gap={8}>
          <Button variant="ghost" disabled={submitting} onClick={dismiss}>
            Cancel
          </Button>
          <Button disabled={!ready || submitting} loading={submitting} onClick={() => void submit()}>
            Post entry
          </Button>
        </Stack>
      }
    >
      {accounts.error ? (
        <Failure error={accounts.error} retry={accounts.reload} />
      ) : !accounts.data ? (
        <Skeleton height={200} />
      ) : (
        <Stack gap={12}>
          <div className="books-controls">
            <Field label="Date" htmlFor="entry-date">
              <Input id="entry-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </Field>
            <Field label="Currency" htmlFor="entry-currency">
              <Input
                id="entry-currency"
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            </Field>
          </div>
          <Field label="Memo" htmlFor="entry-memo">
            <Input id="entry-memo" value={memo} maxLength={500} onChange={(event) => setMemo(event.target.value)} />
          </Field>
          <Table form>
            <thead>
              <tr>
                <th>Account</th>
                <th className="books-num">Debit</th>
                <th className="books-num">Credit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index}>
                  <td>
                    <AccountSelect accounts={accounts.data!} value={line.accountId} onChange={(accountId) => update(index, { accountId })} />
                  </td>
                  <td>
                    <Input
                      inputMode="decimal"
                      aria-label={`Debit on line ${index + 1}`}
                      value={line.debit}
                      onChange={(event) => update(index, { debit: event.target.value, credit: event.target.value ? "" : line.credit })}
                    />
                  </td>
                  <td>
                    <Input
                      inputMode="decimal"
                      aria-label={`Credit on line ${index + 1}`}
                      value={line.credit}
                      onChange={(event) => update(index, { credit: event.target.value, debit: event.target.value ? "" : line.debit })}
                    />
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={lines.length <= 2}
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => setLines((list) => list.filter((_, at) => at !== index))}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
              <tr className="books-total">
                <td>
                  <Button size="sm" variant="secondary" onClick={() => setLines((list) => [...list, { accountId: "", debit: "", credit: "" }])}>
                    Add line
                  </Button>
                </td>
                <td className="books-num">{invalidAmount ? "—" : money(debits, /^[A-Z]{3}$/.test(currency) ? currency : "USD")}</td>
                <td className="books-num">{invalidAmount ? "—" : money(credits, /^[A-Z]{3}$/.test(currency) ? currency : "USD")}</td>
                <td>
                  <Badge tone={balanced ? "success" : "warning"}>{balanced ? "Balanced" : "Not balanced"}</Badge>
                </td>
              </tr>
            </tbody>
          </Table>
          <Field label="Receipt (PDF or image, optional)" htmlFor="entry-receipt">
            <Input
              id="entry-receipt"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,image/heic"
              onChange={(event) => setReceipt(event.target.files?.[0] ?? null)}
            />
          </Field>
          <ActionError error={error} />
        </Stack>
      )}
    </Modal>
  );
}

function ReceiptPreview({ entryId, fileId }: { entryId: string; fileId: string }) {
  const app = useApp();
  const [state, setState] = useState<{ url?: string; type?: string; name?: string; error?: string; loading?: boolean }>({});
  async function open() {
    setState({ loading: true });
    try {
      const reply = await app.file(fileId, "receiptAccess", { entryId });
      const url = URL.createObjectURL(reply.blob());
      setState({ url, type: reply.file.contentType, name: reply.file.name });
    } catch (failure) {
      setState({ error: problem(failure) });
    }
  }
  if (state.error) return <Callout tone="danger">{state.error}</Callout>;
  if (!state.url)
    return (
      <Button size="sm" variant="secondary" loading={state.loading} onClick={() => void open()}>
        Show receipt
      </Button>
    );
  return state.type?.startsWith("image/") ? (
    <img className="books-receipt" src={state.url} alt={`Receipt ${state.name ?? ""}`} />
  ) : (
    <a href={state.url} download={state.name}>
      Download {state.name}
    </a>
  );
}

function EntryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, loading, error, reload } = useBooks<Entry>("getEntry", { id });
  const app = useApp();
  const { act, pending, error: actionError } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [reverseDate, setReverseDate] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const attachingRef = useRef(false);
  async function attach(file: File) {
    if (attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    setUploadError(null);
    let fileId: string;
    try {
      fileId = (await app.upload(file, mutationKey("receipt"))).file.fileId;
      await act("attachReceipt", { entryId: id, fileId });
    } catch (failure) {
      setUploadError(problem(failure));
    } finally {
      attachingRef.current = false;
      setAttaching(false);
    }
  }
  return (
    <Modal
      open
      title={data ? `Entry ${data.number}` : "Journal entry"}
      onClose={() => {
        if (!attachingRef.current) onClose();
      }}
    >
      {error ? (
        <Failure error={error} retry={reload} />
      ) : loading || !data ? (
        <Skeleton height={200} />
      ) : (
        <Stack gap={12}>
          <p>
            {data.date} · {data.memo} · <Badge>{data.source}</Badge>{" "}
            {data.reversedByEntryId ? <Badge tone="warning">Reversed</Badge> : null}
            {data.reversesEntryId ? <Badge tone="warning">Reversal</Badge> : null}
          </p>
          <Table>
            <thead>
              <tr>
                <th>Account</th>
                <th className="books-num">Debit</th>
                <th className="books-num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.lineNo}>
                  <td>
                    <span className="books-code">{line.accountId}</span> {line.accountName}
                  </td>
                  <td className="books-num">{line.debitCents ? money(line.debitCents, data.currency) : ""}</td>
                  <td className="books-num">{line.creditCents ? money(line.creditCents, data.currency) : ""}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {data.receiptFileId ? (
            <ReceiptPreview entryId={data.id} fileId={data.receiptFileId} />
          ) : (
            <Field label="Attach a receipt (PDF or image)" htmlFor="attach-receipt">
              <Input
                id="attach-receipt"
                type="file"
                disabled={attaching}
                accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,image/heic"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attach(file);
                }}
              />
            </Field>
          )}
          {data.reversedByEntryId || data.reversesEntryId || data.source === "invoice" ? null : confirm ? (
            <Callout
              tone="warning"
              title="Post a reversing entry?"
              action={
                <Stack direction="horizontal" gap={8}>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                  <Button
                    variant="danger"
                    loading={pending}
                    onClick={() => void act("reverseJournalEntry", { entryId: id, ...(reverseDate ? { date: reverseDate } : {}) }, () => setConfirm(false))}
                  >
                    Reverse
                  </Button>
                </Stack>
              }
            >
              <Stack gap={8}>
                <span>Posted entries never change. A new entry with every debit and credit swapped cancels this one, and both stay in the books.</span>
                <Field label="Reversal date" htmlFor="reverse-date" hint={`Leave empty to use ${data.date}.`}>
                  <Input id="reverse-date" type="date" value={reverseDate} onChange={(event) => setReverseDate(event.target.value)} />
                </Field>
              </Stack>
            </Callout>
          ) : (
            <div>
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                Reverse entry
              </Button>
            </div>
          )}
          {data.source === "invoice" ? <p className="books-muted">Void the invoice to reverse this entry.</p> : null}
          <ActionError error={uploadError ?? actionError} />
        </Stack>
      )}
    </Modal>
  );
}

function JournalPanel() {
  const [pages, setPages] = useState<Array<number | undefined>>([undefined]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Stack gap={12}>
      <Stack direction="horizontal" justify="space-between" align="center">
        <h2 className="books-h2">Journal</h2>
        <Button onClick={() => setAdding(true)}>New entry</Button>
      </Stack>
      {pages.map((beforeNumber, index) => (
        <JournalPage
          key={index}
          beforeNumber={beforeNumber}
          onOpen={setOpen}
          onMore={index === pages.length - 1 ? (next) => setPages((list) => [...list, next]) : undefined}
        />
      ))}
      {adding ? <EntryForm onClose={() => setAdding(false)} /> : null}
      {open ? <EntryDetail id={open} onClose={() => setOpen(null)} /> : null}
    </Stack>
  );
}
function JournalPage({ beforeNumber, onOpen, onMore }: { beforeNumber?: number; onOpen: (id: string) => void; onMore?: (next: number) => void }) {
  const { data, loading, error, reload } = useBooks<{ entries: EntrySummary[]; nextBeforeNumber: number | null }>("listEntries", {
    limit: 100,
    ...(beforeNumber === undefined ? {} : { beforeNumber }),
  });
  if (error) return <Failure error={error} retry={reload} />;
  return (
    <>
      <DataTable
        rows={data?.entries ?? []}
        loading={loading}
        rowKey={(row) => row.id}
        onRowClick={(row) => onOpen(row.id)}
        emptyTitle="No entries yet"
        emptyDescription="Post an entry, import a bank statement, or issue an invoice."
        columns={[
          { key: "number", header: "No.", sortValue: (row) => row.number },
          { key: "date", header: "Date" },
          {
            key: "memo",
            header: "Memo",
            render: (row) => (
              <span>
                {row.memo} {row.reversed ? <Badge tone="warning">Reversed</Badge> : null}
                {row.reversesEntryId ? <Badge tone="warning">Reversal</Badge> : null}
                {row.hasReceipt ? <Badge tone="success">Receipt</Badge> : null}
              </span>
            ),
          },
          { key: "accounts", header: "Accounts", render: (row) => <span className="books-muted">{row.accounts}</span> },
          { key: "source", header: "Source", render: (row) => <Badge>{row.source}</Badge> },
          {
            key: "total",
            header: "Amount",
            align: "right",
            sortValue: (row) => row.totalCents,
            render: (row) => <span className="books-amount">{money(row.totalCents, row.currency)}</span>,
          },
        ]}
      />
      {data?.nextBeforeNumber && onMore ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => onMore(data.nextBeforeNumber!)}>
            Show older entries
          </Button>
        </div>
      ) : null}
    </>
  );
}

function BankImport({ accounts }: { accounts: Account[] }) {
  const run = useRun();
  const refresh = useRefresh();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [bankAccountId, setBankAccountId] = useState(accounts.find((account) => account.isBank)?.id ?? "");
  const [currency, setCurrency] = useState("USD");
  const [skipHeader, setSkipHeader] = useState(true);
  const [dateOrder, setDateOrder] = useState<DateOrder>("ymd");
  const [columns, setColumns] = useState({ date: 0, description: 1, amount: 2, credit: -1 });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const table = useMemo(() => (text ? parseCsv(text) : []), [text]);
  const body = skipHeader ? table.slice(1) : table;
  const header = skipHeader ? table[0] : undefined;
  const width = Math.max(0, ...table.slice(0, 20).map((row) => row.length));
  const mapped = useMemo(() => mapStatement(body, columns, dateOrder), [body, columns, dateOrder]);
  const choices = Array.from({ length: width }, (_, index) => ({ index, label: header?.[index] || `Column ${index + 1}` }));
  async function start() {
    if (!mapped.rows.length || mapped.errors.length) return;
    setError(null);
    setOutcome(null);
    const importId = importIdFor(`${bankAccountId}\n${currency}\n${JSON.stringify(mapped.rows)}`);
    const batches = statementBatches(mapped.rows, { importId, bankAccountId, currency });
    const attempt = mutationKey("stageBankRows");
    let added = 0;
    let duplicates = 0;
    let already = 0;
    let line = 1;
    setProgress({ done: 0, total: mapped.rows.length });
    try {
      for (const rows of batches) {
        const result = await run<{ added: number; duplicates: number; alreadyStaged: number; nextLine: number }>(
          "stageBankRows",
          { importId, bankAccountId, currency, firstLine: line, rows },
          `${attempt}:${line}`,
          false,
        );
        added += result.added;
        duplicates += result.duplicates;
        already += result.alreadyStaged;
        line += rows.length;
        setProgress({ done: line - 1, total: mapped.rows.length });
      }
      setOutcome(
        `${added} new ${added === 1 ? "row" : "rows"}, ${duplicates} already in the books${already ? `, ${already} imported before from this file` : ""}.`,
      );
    } catch (failure) {
      setError(`${problem(failure)} Import again to continue from line ${line}. Rows already sent are not duplicated.`);
    } finally {
      setProgress(null);
      refresh();
    }
  }
  return (
    <Card title="Import a bank statement" subtitle="CSV from your bank. Rows already in the books are recognized and skipped.">
      <Stack gap={12}>
        <div className="books-controls">
          <Field label="CSV file" htmlFor="bank-file">
            <Input
              id="bank-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setOutcome(null);
                setError(null);
                if (!file) return;
                if (file.size > 20 * 1024 * 1024) {
                  setError(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Import files up to 20 MB.`);
                  return;
                }
                setFileName(file.name);
                void file.text().then(setText);
              }}
            />
          </Field>
          <Field label="Bank account" htmlFor="bank-account">
            <AccountSelect id="bank-account" accounts={accounts} value={bankAccountId} onChange={setBankAccountId} filter={(account) => account.isBank} />
          </Field>
          <Field label="Currency" htmlFor="bank-currency">
            <Input id="bank-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
          </Field>
        </div>
        {table.length ? (
          <>
            <div className="books-controls">
              <Checkbox label="First row is a header" checked={skipHeader} onChange={(event) => setSkipHeader(event.target.checked)} />
              <Field label="Date format" htmlFor="bank-date-order">
                <Select id="bank-date-order" value={dateOrder} onChange={(event) => setDateOrder(event.target.value as DateOrder)}>
                  <option value="ymd">2026-03-31</option>
                  <option value="mdy">03/31/2026</option>
                  <option value="dmy">31/03/2026</option>
                </Select>
              </Field>
              {(["date", "description", "amount"] as const).map((key) => (
                <Field key={key} label={key === "amount" ? "Amount (or money out)" : key === "date" ? "Date" : "Description"} htmlFor={`bank-${key}`}>
                  <Select id={`bank-${key}`} value={columns[key]} onChange={(event) => setColumns({ ...columns, [key]: Number(event.target.value) })}>
                    {choices.map((choice) => (
                      <option key={choice.index} value={choice.index}>
                        {choice.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
              <Field label="Money in (optional)" htmlFor="bank-credit">
                <Select id="bank-credit" value={columns.credit} onChange={(event) => setColumns({ ...columns, credit: Number(event.target.value) })}>
                  <option value={-1}>Amount column has signs</option>
                  {choices.map((choice) => (
                    <option key={choice.index} value={choice.index}>
                      {choice.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="books-muted">
              {fileName}: {mapped.rows.length} rows ready
              {mapped.errors.length ? `, ${mapped.errors.length} to fix` : ""}.
            </p>
            {mapped.errors.length ? (
              <Callout tone="warning" title="Some rows cannot be read">
                {mapped.errors.slice(0, 5).join(" ")}
                {mapped.errors.length > 5 ? ` And ${mapped.errors.length - 5} more.` : ""}
              </Callout>
            ) : null}
            <Table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="books-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {mapped.rows.slice(0, 5).map((row, index) => (
                  <tr key={index}>
                    <td className="books-date">{row[0]}</td>
                    <td>{row[1]}</td>
                    <td className="books-num">{row[2]}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {progress ? <ProgressBar value={progress.done} max={progress.total} label={`Imported ${progress.done} of ${progress.total} rows`} /> : null}
            <div>
              <Button disabled={!bankAccountId || !/^[A-Z]{3}$/.test(currency) || !mapped.rows.length || mapped.errors.length > 0} loading={!!progress} onClick={() => void start()}>
                Import {mapped.rows.length} rows
              </Button>
            </div>
          </>
        ) : null}
        {outcome ? <Callout tone="success">{outcome}</Callout> : null}
        <ActionError error={error} />
      </Stack>
    </Card>
  );
}

function BankReview({ accounts }: { accounts: Account[] }) {
  const PAGE_SIZE = 100;
  const [status, setStatus] = useState("new");
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useBooks<{ rows: BankRow[]; counts: Record<string, number>; nextOffset: number | null }>("listBankRows", {
    status,
    limit: PAGE_SIZE,
    offset,
  });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const { act, pending, error: actionError } = useAction();
  const rows = data?.rows ?? [];
  const total = data?.counts[status] ?? 0;
  const picked = rows.filter((row) => selected[row.id]);
  const ready = picked.length > 0 && picked.every((row) => choices[row.id]);
  const onMutateDone = () => {
    setSelected({});
    if (offset > 0 && rows.length <= picked.length) setOffset(Math.max(0, offset - PAGE_SIZE));
  };
  return (
    <Card
      title="Bank rows"
      subtitle="Choose the other account for each row, then post. Each row becomes one balanced entry."
      action={
        <Select
          aria-label="Show rows"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setOffset(0);
            setSelected({});
          }}
        >
          {["new", "posted", "ignored", "duplicate"].map((value) => (
            <option key={value} value={value}>
              {value[0]!.toUpperCase() + value.slice(1)} ({data?.counts[value] ?? 0})
            </option>
          ))}
        </Select>
      }
    >
      {error ? (
        <Failure error={error} retry={reload} />
      ) : (
        <Stack gap={12}>
          {status === "new" && rows.length ? (
            <Stack direction="horizontal" gap={8} wrap>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelected(Object.fromEntries(rows.map((row) => [row.id, true])))}
              >
                Select all {rows.length}
              </Button>
              <Button
                size="sm"
                disabled={!ready}
                loading={pending}
                onClick={() =>
                  void act("postBankRows", { rows: picked.map((row) => ({ id: row.id, accountId: choices[row.id] })) }, onMutateDone)
                }
              >
                Post {picked.length || ""} selected
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!picked.length}
                onClick={() => void act("setBankRowsIgnored", { ids: picked.map((row) => row.id), ignored: true }, onMutateDone)}
              >
                Ignore selected
              </Button>
            </Stack>
          ) : null}
          <ActionError error={actionError} />
          <DataTable
            rows={rows}
            loading={loading}
            rowKey={(row) => row.id}
            searchable
            searchText={(row) => `${row.description} ${row.date}`}
            emptyTitle={status === "new" ? "Nothing to review" : `No ${status} rows`}
            columns={[
              ...(status === "new"
                ? [
                    {
                      key: "pick",
                      header: "",
                      render: (row: BankRow) => (
                        <Checkbox
                          label=""
                          aria-label={`Select ${row.description}`}
                          checked={!!selected[row.id]}
                          onChange={(event) => setSelected({ ...selected, [row.id]: event.target.checked })}
                        />
                      ),
                    },
                  ]
                : []),
              { key: "date", header: "Date" },
              { key: "description", header: "Description" },
              {
                key: "amount",
                header: "Amount",
                align: "right" as const,
                sortValue: (row: BankRow) => row.amountCents,
                render: (row: BankRow) => (
                  <span className={row.amountCents < 0 ? "books-amount books-out" : "books-amount"}>{money(row.amountCents, row.currency)}</span>
                ),
              },
              ...(status === "new"
                ? [
                    {
                      key: "account",
                      header: "Other account",
                      render: (row: BankRow) => (
                        <AccountSelect
                          accounts={accounts}
                          value={choices[row.id] ?? ""}
                          onChange={(value) => {
                            setChoices({ ...choices, [row.id]: value });
                            if (value) setSelected({ ...selected, [row.id]: true });
                          }}
                          filter={(account) => account.id !== row.bankAccountId}
                          placeholder={row.amountCents > 0 ? "Income or source" : "Expense or use"}
                        />
                      ),
                    },
                  ]
                : status === "duplicate"
                  ? [
                      {
                        key: "keep",
                        header: "",
                        render: (row: BankRow) => (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={pending}
                            onClick={() => void act("keepDuplicateBankRow", { id: row.id })}
                          >
                            Keep as new
                          </Button>
                        ),
                      },
                    ]
                  : status === "ignored"
                    ? [
                        {
                          key: "restore",
                          header: "",
                          render: (row: BankRow) => (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={pending}
                              onClick={() =>
                                void act("setBankRowsIgnored", { ids: [row.id], ignored: false }, () => {
                                  if (offset > 0 && rows.length <= 1) setOffset(Math.max(0, offset - PAGE_SIZE));
                                })
                              }
                            >
                              Restore
                            </Button>
                          ),
                        },
                      ]
                    : [{ key: "hash", header: "Row SHA-256", render: (row: BankRow) => <code className="books-hash">{row.rowHash.slice(0, 12)}</code> }]),
            ]}
          />
          {offset > 0 || data?.nextOffset !== null ? (
            <Stack direction="horizontal" justify="space-between" align="center" gap={8}>
              <span className="books-muted">
                Showing {rows.length ? offset + 1 : 0}-{offset + rows.length} of {total}
              </span>
              <Stack direction="horizontal" gap={8}>
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={data?.nextOffset === null || data?.nextOffset === undefined}
                  onClick={() => {
                    if (data?.nextOffset !== null && data?.nextOffset !== undefined) setOffset(data.nextOffset);
                  }}
                >
                  Next
                </Button>
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      )}
    </Card>
  );
}

function BankPanel() {
  const accounts = useAccounts();
  if (accounts.error) return <Failure error={accounts.error} retry={accounts.reload} />;
  if (!accounts.data) return <Skeleton height={240} />;
  return (
    <Stack gap={16}>
      <BankImport accounts={accounts.data} />
      <BankReview accounts={accounts.data} />
    </Stack>
  );
}

interface InvoiceLineDraft {
  description: string;
  quantity: string;
  price: string;
  revenueAccountId: string;
}
function InvoiceEditor({ invoice, onClose }: { invoice?: Invoice; onClose: (id?: string) => void }) {
  const accounts = useAccounts();
  const clients = useBooks<Client[]>("listClients", {});
  const { act, pending, error } = useAction();
  const [clientId, setClientId] = useState(invoice?.clientId ?? "");
  const [newClient, setNewClient] = useState({ name: "", email: "", address: "" });
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? today());
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? today());
  const [currency, setCurrency] = useState(invoice?.currency ?? "USD");
  const [taxRate, setTaxRate] = useState(invoice ? String(invoice.taxRateBp / 100) : "0");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [lines, setLines] = useState<InvoiceLineDraft[]>(
    invoice?.lines.map((line) => ({
      description: line.description,
      quantity: String(line.quantityMilli / 1000),
      price: (line.unitPriceCents / 100).toFixed(2),
      revenueAccountId: line.revenueAccountId,
    })) ?? [{ description: "", quantity: "1", price: "", revenueAccountId: "4000" }],
  );
  const parsed = lines.map((line) => ({
    description: line.description.trim(),
    quantity: Number(line.quantity),
    unitPriceCents: parseMoney(line.price),
    revenueAccountId: line.revenueAccountId,
  }));
  const taxRateBp = Math.round(Number(taxRate) * 100);
  const subtotal = parsed.reduce(
    (sum, line) => sum + (line.unitPriceCents !== null && Number.isFinite(line.quantity) ? Math.round(line.quantity * line.unitPriceCents) : 0),
    0,
  );
  const valid =
    (clientId || newClient.name.trim()) &&
    Number.isFinite(taxRateBp) &&
    taxRateBp >= 0 &&
    parsed.every((line) => line.description && line.quantity > 0 && line.unitPriceCents !== null && line.unitPriceCents >= 0 && line.revenueAccountId);
  async function save() {
    let client = clientId;
    if (!client) {
      const created = await act<{ id: string }>("saveClient", {
        name: newClient.name.trim(),
        ...(newClient.email.trim() ? { email: newClient.email.trim() } : {}),
        ...(newClient.address.trim() ? { address: newClient.address.trim() } : {}),
      }, undefined, false);
      if (!created) return;
      client = created.id;
      setClientId(client);
    }
    await act<{ id: string }>(
      "saveDraftInvoice",
      {
        ...(invoice ? { id: invoice.id, expectedVersion: invoice.version } : {}),
        clientId: client,
        issueDate,
        dueDate,
        currency,
        taxRateBp,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: parsed.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          revenueAccountId: line.revenueAccountId,
        })),
      },
      (result) => onClose(result.id),
    );
  }
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return (
    <Modal
      open
      title={invoice ? "Edit draft invoice" : "New invoice"}
      onClose={() => onClose()}
      footer={
        <Stack direction="horizontal" justify="flex-end" gap={8}>
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={pending} onClick={() => void save()}>
            Save draft
          </Button>
        </Stack>
      }
    >
      {accounts.error || clients.error ? (
        <Failure error={(accounts.error ?? clients.error)!} retry={() => (accounts.reload(), clients.reload())} />
      ) : !accounts.data || !clients.data ? (
        <Skeleton height={240} />
      ) : (
        <Stack gap={12}>
          <Field label="Client" htmlFor="invoice-client">
            <Select id="invoice-client" value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">New client</option>
              {clients.data.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
          </Field>
          {clientId ? null : (
            <div className="books-controls">
              <Field label="Client name" htmlFor="client-name">
                <Input id="client-name" value={newClient.name} onChange={(event) => setNewClient({ ...newClient, name: event.target.value })} />
              </Field>
              <Field label="Email" htmlFor="client-email">
                <Input id="client-email" type="email" value={newClient.email} onChange={(event) => setNewClient({ ...newClient, email: event.target.value })} />
              </Field>
              <Field label="Address" htmlFor="client-address">
                <Input id="client-address" value={newClient.address} onChange={(event) => setNewClient({ ...newClient, address: event.target.value })} />
              </Field>
            </div>
          )}
          <div className="books-controls">
            <Field label="Issue date" htmlFor="invoice-issue">
              <Input id="invoice-issue" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
            </Field>
            <Field label="Due date" htmlFor="invoice-due">
              <Input id="invoice-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </Field>
            <Field label="Currency" htmlFor="invoice-currency">
              <Input id="invoice-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
            </Field>
            <Field label="Sales tax %" htmlFor="invoice-tax">
              <Input id="invoice-tax" inputMode="decimal" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} />
            </Field>
          </div>
          <Table form>
            <thead>
              <tr>
                <th>Description</th>
                <th className="books-num">Qty</th>
                <th className="books-num">Unit price</th>
                <th>Revenue account</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const update = (patch: Partial<InvoiceLineDraft>) =>
                  setLines((list) => list.map((item, at) => (at === index ? { ...item, ...patch } : item)));
                return (
                  <tr key={index}>
                    <td>
                      <Input aria-label={`Description on line ${index + 1}`} value={line.description} onChange={(event) => update({ description: event.target.value })} />
                    </td>
                    <td>
                      <Input aria-label={`Quantity on line ${index + 1}`} inputMode="decimal" value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} />
                    </td>
                    <td>
                      <Input aria-label={`Unit price on line ${index + 1}`} inputMode="decimal" value={line.price} onChange={(event) => update({ price: event.target.value })} />
                    </td>
                    <td>
                      <AccountSelect
                        accounts={accounts.data!}
                        value={line.revenueAccountId}
                        onChange={(revenueAccountId) => update({ revenueAccountId })}
                        filter={(account) => account.type === "income"}
                      />
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lines.length <= 1}
                        aria-label={`Remove line ${index + 1}`}
                        onClick={() => setLines((list) => list.filter((_, at) => at !== index))}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Stack direction="horizontal" justify="space-between" align="center">
            <Button size="sm" variant="secondary" onClick={() => setLines((list) => [...list, { description: "", quantity: "1", price: "", revenueAccountId: "4000" }])}>
              Add line
            </Button>
            <span className="books-muted">Subtotal about {money(subtotal, code)}. The books round each line and the tax to whole cents.</span>
          </Stack>
          <Field label="Notes" htmlFor="invoice-notes">
            <Textarea id="invoice-notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <ActionError error={error} />
        </Stack>
      )}
    </Modal>
  );
}

function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  return (
    <article className="books-invoice">
      <header>
        <div>
          <h2>Invoice {invoice.number ?? "(draft)"}</h2>
          <p className="books-muted">
            Issued {invoice.issueDate} · Due {invoice.dueDate}
          </p>
        </div>
        <Badge tone={STATUS_TONE[invoice.status]}>{invoice.status}</Badge>
      </header>
      <section>
        <p className="books-muted">Bill to</p>
        <p className="books-strong">{invoice.clientName}</p>
        {invoice.clientAddress ? <p>{invoice.clientAddress}</p> : null}
        {invoice.clientEmail ? <p>{invoice.clientEmail}</p> : null}
      </section>
      <Table>
        <thead>
          <tr>
            <th>Description</th>
            <th className="books-num">Qty</th>
            <th className="books-num">Unit price</th>
            <th className="books-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.lineNo}>
              <td>{line.description}</td>
              <td className="books-num">{line.quantityMilli / 1000}</td>
              <td className="books-num">{money(line.unitPriceCents, invoice.currency)}</td>
              <td className="books-num">{money(line.amountCents, invoice.currency)}</td>
            </tr>
          ))}
          <tr className="books-total">
            <td colSpan={3}>Subtotal</td>
            <td className="books-num">{money(invoice.subtotalCents, invoice.currency)}</td>
          </tr>
          <tr>
            <td colSpan={3}>Sales tax ({invoice.taxRateBp / 100}%)</td>
            <td className="books-num">{money(invoice.taxCents, invoice.currency)}</td>
          </tr>
          <tr className="books-grand">
            <td colSpan={3}>Total due</td>
            <td className="books-num">{money(invoice.totalCents, invoice.currency)}</td>
          </tr>
        </tbody>
      </Table>
      {invoice.notes ? <p>{invoice.notes}</p> : null}
      {invoice.paidOn ? <p className="books-muted">Paid {invoice.paidOn}. Thank you.</p> : null}
    </article>
  );
}

function InvoiceView({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, loading, error, reload } = useBooks<Invoice>("getInvoice", { id });
  const accounts = useAccounts();
  const { act, pending, error: actionError } = useAction();
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const [bankAccountId, setBankAccountId] = useState("1000");
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voidDate, setVoidDate] = useState("");
  const invoiceRef = useRef<HTMLDivElement>(null);
  if (error) return <Failure error={error} retry={reload} />;
  if (loading || !data) return <Skeleton height={320} />;
  const version = { id: data.id, expectedVersion: data.version };
  return (
    <Stack gap={12}>
      <div className="books-no-print">
        <Stack direction="horizontal" gap={8} wrap>
          <Button variant="ghost" onClick={onBack}>
            All invoices
          </Button>
          {data.status === "draft" ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button loading={pending} onClick={() => void act("issueInvoice", version)}>
                Issue and post
              </Button>
              <Button variant="ghost" onClick={() => void act("deleteDraftInvoice", version, onBack)}>
                Delete draft
              </Button>
            </>
          ) : null}
          {data.status === "issued" ? (
            <>
              <Button onClick={() => setPaying(true)}>Record payment</Button>
              <Button variant="ghost" onClick={() => setConfirmVoid(true)}>
                Void
              </Button>
            </>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => downloadPrintableHtml(`invoice-${data.number ?? "draft"}.html`, `Invoice ${data.number ?? "draft"}`, invoiceRef.current)}
          >
            Download printable HTML
          </Button>
        </Stack>
      </div>
      <ActionError error={actionError} />
      {paying ? (
        <Card title="Record payment" className="books-no-print">
          <div className="books-controls">
            <Field label="Paid on" htmlFor="paid-on">
              <Input id="paid-on" type="date" value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
            </Field>
            <Field label="Into bank account" htmlFor="paid-into">
              {accounts.error ? (
                <Failure error={accounts.error} retry={accounts.reload} title="Could not load bank accounts" />
              ) : accounts.data ? (
                <AccountSelect id="paid-into" accounts={accounts.data} value={bankAccountId} onChange={setBankAccountId} filter={(account) => account.isBank} />
              ) : (
                <Skeleton height={32} />
              )}
            </Field>
            <Button loading={pending} disabled={!bankAccountId} onClick={() => void act("recordPayment", { ...version, date: paidOn, bankAccountId }, () => setPaying(false))}>
              Post payment of {money(data.totalCents, data.currency)}
            </Button>
          </div>
        </Card>
      ) : null}
      {confirmVoid ? (
        <Callout
          tone="warning"
          title={`Void invoice ${data.number}?`}
          action={
            <Stack direction="horizontal" gap={8}>
              <Button variant="ghost" onClick={() => setConfirmVoid(false)}>
                Keep
              </Button>
              <Button
                variant="danger"
                loading={pending}
                disabled={Boolean(voidDate && voidDate < data.issueDate)}
                onClick={() => void act("voidInvoice", { ...version, ...(voidDate ? { date: voidDate } : {}) }, () => setConfirmVoid(false))}
              >
                Void
              </Button>
            </Stack>
          }
        >
          <Stack gap={8}>
            <span>The invoice keeps its number. A reversing entry cancels its sale in the books.</span>
            <Field label="Void date" htmlFor="void-date" hint={`Leave empty to use ${data.issueDate}, or pick a later date in an open period if that month is locked.`}>
              <Input id="void-date" type="date" min={data.issueDate} value={voidDate} onChange={(event) => setVoidDate(event.target.value)} />
            </Field>
          </Stack>
        </Callout>
      ) : null}
      <Card>
        <div ref={invoiceRef}>
          <InvoiceDocument invoice={data} />
        </div>
      </Card>
      {editing ? <InvoiceEditor invoice={data} onClose={() => setEditing(false)} /> : null}
    </Stack>
  );
}

function InvoicesPanel() {
  const PAGE_SIZE = 100;
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useBooks<{ invoices: InvoiceSummary[]; nextOffset: number | null }>("listInvoices", {
    limit: PAGE_SIZE,
    offset,
  });
  if (open) return <InvoiceView id={open} onBack={() => setOpen(null)} />;
  const invoices = data?.invoices ?? [];
  return (
    <Stack gap={12}>
      <Stack direction="horizontal" justify="space-between" align="center">
        <h2 className="books-h2">Invoices</h2>
        <Button onClick={() => setCreating(true)}>New invoice</Button>
      </Stack>
      {error ? <Failure error={error} retry={reload} /> : null}
      <DataTable
        rows={invoices}
        loading={loading}
        rowKey={(row) => row.id}
        onRowClick={(row) => setOpen(row.id)}
        searchable
        searchText={(row) => `${row.number ?? ""} ${row.clientName}`}
        emptyTitle="No invoices yet"
        emptyDescription="Issuing an invoice posts it to receivables and revenue in one step."
        columns={[
          { key: "number", header: "Number", render: (row) => row.number ?? <span className="books-muted">Draft</span> },
          { key: "clientName", header: "Client" },
          { key: "issueDate", header: "Issued" },
          { key: "dueDate", header: "Due" },
          { key: "status", header: "Status", render: (row) => <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge> },
          {
            key: "total",
            header: "Total",
            align: "right",
            sortValue: (row) => row.totalCents,
            render: (row) => <span className="books-amount">{money(row.totalCents, row.currency)}</span>,
          },
        ]}
      />
      {offset > 0 || data?.nextOffset !== null ? (
        <Stack direction="horizontal" justify="space-between" align="center" gap={8}>
          <span className="books-muted">
            Showing {invoices.length ? offset + 1 : 0}-{offset + invoices.length}
          </span>
          <Stack direction="horizontal" gap={8}>
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={data?.nextOffset === null || data?.nextOffset === undefined}
              onClick={() => {
                if (data?.nextOffset !== null && data?.nextOffset !== undefined) setOffset(data.nextOffset);
              }}
            >
              Next
            </Button>
          </Stack>
        </Stack>
      ) : null}
      {creating ? (
        <InvoiceEditor
          onClose={(id) => {
            setCreating(false);
            if (id) setOpen(id);
          }}
        />
      ) : null}
    </Stack>
  );
}

function SetupPanel() {
  const accounts = useAccounts();
  const periods = useBooks<Period[]>("listPeriods", {});
  const { act, pending, error } = useAction();
  const [draft, setDraft] = useState({ id: "", name: "", type: "expense" as AccountType, isBank: false });
  const nextYear = periods.data?.length ? Number(periods.data[periods.data.length - 1]!.endDate.slice(0, 4)) + 1 : Number(today().slice(0, 4));
  const [yearInput, setYearInput] = useState("");
  const chosenYear = yearInput.trim() ? Number(yearInput) : nextYear;
  const validYear = Number.isInteger(chosenYear) && chosenYear >= 1900 && chosenYear <= 2998;
  const firstOpen = periods.data?.find((period) => period.status === "open");
  return (
    <Stack gap={16}>
      <ActionError error={error} />
      <Card
        title="Fiscal periods"
        subtitle="Lock a month once it is closed. Locked months refuse new entries, reversals, and receipts. Locking cannot be undone."
        action={
          <Stack direction="horizontal" align="center" gap={8}>
            <Input
              aria-label="Fiscal year to open"
              inputMode="numeric"
              placeholder={String(nextYear)}
              value={yearInput}
              onChange={(event) => setYearInput(event.target.value)}
              style={{ width: 96 }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!validYear}
              loading={pending}
              onClick={() => void act("addFiscalYear", { year: chosenYear }, () => setYearInput(""))}
            >
              Open {validYear ? chosenYear : "year"}
            </Button>
          </Stack>
        }
      >
        {periods.error ? (
          <Failure error={periods.error} retry={periods.reload} />
        ) : (
          <DataTable
            rows={periods.data ?? []}
            loading={periods.loading}
            rowKey={(row) => row.id}
            emptyTitle="No fiscal periods"
            columns={[
              { key: "id", header: "Period" },
              { key: "startDate", header: "Starts" },
              { key: "endDate", header: "Ends" },
              { key: "entries", header: "Entries", align: "right" },
              {
                key: "status",
                header: "Status",
                render: (row) =>
                  row.status === "locked" ? (
                    <Badge>Locked</Badge>
                  ) : row.id === firstOpen?.id ? (
                    <Button size="sm" variant="secondary" onClick={() => void act("lockPeriod", { periodId: row.id })}>
                      Lock {row.id}
                    </Button>
                  ) : (
                    <Badge tone="success">Open</Badge>
                  ),
              },
            ]}
          />
        )}
      </Card>
      <Card title="Chart of accounts" subtitle="Accounts with postings keep their type. Archive an account to stop new postings.">
        {accounts.error ? (
          <Failure error={accounts.error} retry={accounts.reload} />
        ) : (
          <Stack gap={12}>
            <div className="books-controls">
              <Field label="Code" htmlFor="account-code">
                <Input id="account-code" value={draft.id} maxLength={12} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
              </Field>
              <Field label="Name" htmlFor="account-name">
                <Input id="account-name" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </Field>
              <Field label="Type" htmlFor="account-type">
                <Select id="account-type" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as AccountType, isBank: false })}>
                  {["asset", "liability", "equity", "income", "expense"].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </Select>
              </Field>
              {draft.type === "asset" ? (
                <Checkbox label="Bank account" checked={draft.isBank} onChange={(event) => setDraft({ ...draft, isBank: event.target.checked })} />
              ) : null}
              <Button
                disabled={!draft.id.trim() || !draft.name.trim()}
                loading={pending}
                onClick={() => void act("addAccount", draft, () => setDraft({ id: "", name: "", type: draft.type, isBank: false }))}
              >
                Add account
              </Button>
            </div>
            <DataTable
              rows={accounts.data ?? []}
              loading={accounts.loading}
              rowKey={(row) => row.id}
              searchable
              searchText={(row) => `${row.id} ${row.name} ${row.type}`}
              columns={[
                { key: "id", header: "Code" },
                { key: "name", header: "Name" },
                { key: "type", header: "Type" },
                {
                  key: "flags",
                  header: "",
                  render: (row) => (
                    <span>
                      {row.isBank ? <Badge>Bank</Badge> : null} {row.role ? <Badge>{row.role.replace("_", " ")}</Badge> : null}{" "}
                      {row.archived ? <Badge tone="warning">Archived</Badge> : null}
                    </span>
                  ),
                },
                {
                  key: "archive",
                  header: "",
                  render: (row) =>
                    row.role ? null : (
                      <Button size="sm" variant="ghost" onClick={() => void act("updateAccount", { id: row.id, archived: !row.archived })}>
                        {row.archived ? "Restore" : "Archive"}
                      </Button>
                    ),
                },
              ]}
            />
          </Stack>
        )}
      </Card>
    </Stack>
  );
}

function Books() {
  const [tab, setTab] = useState("overview");
  const panels: Record<string, ReactNode> = {
    overview: <OverviewPanel go={setTab} />,
    journal: <JournalPanel />,
    bank: <BankPanel />,
    invoices: <InvoicesPanel />,
    reports: <Reports bookName="Books" />,
    setup: <SetupPanel />,
  };
  return (
    <AppShell width="wide">
      <div className="books-no-print">
        <PageHeader title="Books" subtitle="Double-entry accounting, invoices, and bank imports in your workspace." />
        <Tabs
          label="Books"
          value={tab}
          onChange={setTab}
          items={[
            { id: "overview", label: "Overview" },
            { id: "journal", label: "Journal" },
            { id: "bank", label: "Bank" },
            { id: "invoices", label: "Invoices" },
            { id: "reports", label: "Reports" },
            { id: "setup", label: "Accounts and periods" },
          ]}
        />
      </div>
      <div className="books-panel">{panels[tab]}</div>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <RefreshProvider>
      <Books />
    </RefreshProvider>
  </AppProvider>,
);
