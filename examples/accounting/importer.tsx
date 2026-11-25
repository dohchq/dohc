import { useEffect, useMemo, useRef, useState } from "react";
import { mutationKey } from "dohc/app";
import { parseCsv } from "dohc/csv";
import { FileText } from "dohc/icons";
import { Modal } from "dohc/ui";
import { cx, problem, shortDate } from "./shared";
import { useBooksContext, useMutate, useToast } from "./parts";
import { importIdFor, mapStatement, statementBatches, type DateOrder } from "./statement";
import { minorDigits } from "./amounts";

export function ImportSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { accounts, currency: bookCurrency } = useBooksContext();
  const mutate = useMutate();
  const toast = useToast();
  const banks = accounts.filter((account) => account.isBank && !account.archived);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [bankAccountId, setBankAccountId] = useState(banks[0]?.id ?? "");
  const [currency, setCurrency] = useState(bookCurrency);
  const [skipHeader, setSkipHeader] = useState(true);
  const [dateOrder, setDateOrder] = useState<DateOrder>("ymd");
  const [columns, setColumns] = useState({ date: 0, description: 1, amount: 2, credit: -1 });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reading = useRef(0);
  const parsed = useMemo(() => {
    if (!text) return { table: [] as string[][], error: null as string | null };
    try {
      return {
        table: parseCsv(text).filter((row) => row.some((cell) => cell.trim())),
        error: null,
      };
    } catch (failure) {
      return { table: [] as string[][], error: problem(failure) };
    }
  }, [text]);
  const table = parsed.table;
  const body = useMemo(() => (skipHeader ? table.slice(1) : table), [table, skipHeader]);
  const header = skipHeader ? table[0] : undefined;
  const width = Math.max(0, ...table.slice(0, 20).map((row) => row.length));
  const digits = minorDigits(currency);
  const mapped = useMemo(
    () => mapStatement(body, columns, dateOrder, digits),
    [body, columns, dateOrder, digits],
  );
  const choices = Array.from({ length: width }, (_, index) => ({
    index,
    label: header?.[index] || `Column ${index + 1}`,
  }));
  const read = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    const token = ++reading.current;
    setText("");
    setFileName("");
    if (file.size > 20 * 1024 * 1024) {
      setError(
        `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Import files up to 20 MB.`,
      );
      return;
    }
    file.text().then(
      (value) => {
        if (token !== reading.current) return;
        setColumns({ date: 0, description: 1, amount: 2, credit: -1 });
        setFileName(file.name);
        setText(value);
      },
      (failure: unknown) =>
        token === reading.current && setError(`Could not read ${file.name}. ${problem(failure)}`),
    );
  };
  const running = useRef(false);
  const mounted = useRef(true);
  const shown = useRef({ rows: mapped.rows, bankAccountId, currency });
  shown.current = { rows: mapped.rows, bankAccountId, currency };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = () => {
    if (!mapped.rows.length || mapped.errors.length) return;
    const importId = importIdFor(`${bankAccountId}
${currency}
${text}
${JSON.stringify(mapped.rows)}`);
    void upload({ importId, bankAccountId, currency, rows: mapped.rows });
  };
  async function upload(job: {
    importId: string;
    bankAccountId: string;
    currency: string;
    rows: typeof mapped.rows;
  }) {
    if (running.current) return;
    running.current = true;
    const here = () =>
      mounted.current &&
      shown.current.rows === job.rows &&
      shown.current.bankAccountId === job.bankAccountId &&
      shown.current.currency === job.currency;
    const attempt = mutationKey("stageBankRows");
    let added = 0;
    let duplicates = 0;
    let already = 0;
    let closed = 0;
    let line = 1;
    if (here()) {
      setError(null);
      setProgress({ done: 0, total: job.rows.length });
    }
    try {
      const { rows: all, ...envelope } = job;
      for (const rows of statementBatches(all, envelope)) {
        const result = await mutate<{
          added: number;
          duplicates: number;
          closed: number;
          alreadyStaged: number;
        }>("stageBankRows", { ...envelope, firstLine: line, rows }, `${attempt}:${line}`);
        added += result.added;
        duplicates += result.duplicates;
        closed += result.closed;
        already += result.alreadyStaged;
        line += rows.length;
        if (here()) setProgress({ done: line - 1, total: job.rows.length });
      }
      toast({
        message: `Imported ${added} new ${added === 1 ? "row" : "rows"}`,
        detail:
          [
            duplicates
              ? duplicates === 1
                ? "1 looks like a row imported before"
                : `${duplicates} look like rows imported before`
              : "",
            closed ? `${closed} in closed months, skipped` : "",
            already ? `${already} imported before` : "",
          ]
            .filter(Boolean)
            .join(", ") || undefined,
      });
      onDone();
      if (here()) onClose();
    } catch (failure) {
      if (here())
        setError(
          `${problem(failure)} Import again to continue from line ${line}. Rows already sent are not duplicated.`,
        );
      toast({
        tone: "error",
        message: "Could not finish the import",
        detail: problem(failure),
        action: { label: "Try again", run: () => void upload(job) },
      });
    } finally {
      running.current = false;
      if (mounted.current) setProgress(null);
    }
  }
  const ready =
    Boolean(bankAccountId) &&
    /^[A-Z]{3}$/.test(currency) &&
    mapped.rows.length > 0 &&
    mapped.errors.length === 0;
  return (
    <Modal
      open
      title="Import a bank statement"
      onClose={() => (progress ? undefined : onClose())}
      footer={
        <div className="b-composer-foot">
          <span className="b-balance-label">
            {progress
              ? `Imported ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} rows`
              : table.length
                ? `${mapped.rows.length.toLocaleString()} rows ready${mapped.errors.length ? `, ${mapped.errors.length} to fix` : ""}`
                : null}
          </span>
          <button
            type="button"
            className="b-btn b-btn-primary"
            disabled={!ready || Boolean(progress)}
            aria-busy={Boolean(progress) || undefined}
            onClick={start}
          >
            {progress
              ? "Importing…"
              : `Import ${mapped.rows.length ? mapped.rows.length.toLocaleString() : ""} rows`}
          </button>
        </div>
      }
    >
      <div className="b-import">
        <div
          className={cx("b-drop b-drop-wide", over && "is-over", fileName && "has-file")}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            read(event.dataTransfer.files[0]);
          }}
        >
          <FileText size={18} aria-hidden />
          <span>{fileName || "Drop a CSV file from your bank"}</span>
          <button
            type="button"
            className="b-btn b-btn-sm"
            onClick={() => fileInput.current?.click()}
          >
            {fileName ? "Choose another" : "Choose file"}
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            aria-label="CSV file"
            accept=".csv,text/csv"
            onChange={(event) => {
              read(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
        <div className="b-form-grid">
          <label className="b-field">
            <span className="b-field-label">Bank account</span>
            <select
              className="b-select"
              value={bankAccountId}
              onChange={(event) => setBankAccountId(event.target.value)}
            >
              {banks.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.id} {account.name}
                </option>
              ))}
            </select>
          </label>
          <label className="b-field">
            <span className="b-field-label">Currency</span>
            <input
              className="b-input b-input-currency"
              value={currency}
              maxLength={3}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          </label>
          {table.length ? (
            <>
              <label className="b-field">
                <span className="b-field-label">Date format</span>
                <select
                  className="b-select"
                  value={dateOrder}
                  onChange={(event) => setDateOrder(event.target.value as DateOrder)}
                >
                  <option value="ymd">2026-03-31</option>
                  <option value="mdy">03/31/2026</option>
                  <option value="dmy">31/03/2026</option>
                </select>
              </label>
              <label className="b-check">
                <input
                  type="checkbox"
                  checked={skipHeader}
                  onChange={(event) => setSkipHeader(event.target.checked)}
                />
                First row is a header
              </label>
              {(["date", "description", "amount"] as const).map((key) => (
                <label className="b-field" key={key}>
                  <span className="b-field-label">
                    {key === "amount"
                      ? columns.credit < 0
                        ? "Amount"
                        : "Money out"
                      : key === "date"
                        ? "Date column"
                        : "Description"}
                  </span>
                  <select
                    className="b-select"
                    value={columns[key]}
                    onChange={(event) =>
                      setColumns({ ...columns, [key]: Number(event.target.value) })
                    }
                  >
                    {choices.map((choice) => (
                      <option key={choice.index} value={choice.index}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="b-field">
                <span className="b-field-label">Money in</span>
                <select
                  className="b-select"
                  value={columns.credit}
                  onChange={(event) =>
                    setColumns({ ...columns, credit: Number(event.target.value) })
                  }
                >
                  <option value={-1}>Signed amount column</option>
                  {choices.map((choice) => (
                    <option key={choice.index} value={choice.index}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
        {parsed.error ? (
          <p className="b-form-error" role="alert">
            This file is not valid CSV. {parsed.error}
          </p>
        ) : null}
        {mapped.errors.length ? (
          <p className="b-form-error" role="alert">
            {mapped.errors.slice(0, 3).join(" ")}
            {mapped.errors.length > 3 ? ` And ${mapped.errors.length - 3} more.` : ""}
          </p>
        ) : null}
        {mapped.rows.length ? (
          <table className="b-grid is-compact">
            <thead>
              <tr>
                <th className="col-date">Date</th>
                <th>Description</th>
                <th className="b-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {mapped.rows.slice(0, 5).map((row, at) => (
                <tr key={at}>
                  <td className="col-date b-date">{shortDate(row[0])}</td>
                  <td>{row[1]}</td>
                  <td className="b-num">{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {progress ? (
          <div
            className="b-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        ) : null}
        {error ? (
          <p className="b-form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
