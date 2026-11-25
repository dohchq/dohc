import { useEffect, useRef, useState } from "react";
import { useApp, type useDatasetQuery } from "dohc/app";
import { Upload } from "dohc/icons";
import { Button, Callout, formatNumber } from "dohc/ui";
import { CsvError, importObservations, type ImportProgress } from "./ingest";
import { count } from "./report/format";
import type { Overview } from "./types";

export function Importer({
  open,
  setOpen,
  overview,
  onBusy,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  overview: ReturnType<typeof useDatasetQuery<Overview>>;
  onBusy: (busy: boolean) => void;
}) {
  const client = useApp();
  const [dragging, setDragging] = useState(false);
  const [activity, setActivity] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);
  const inFlight = useRef(false);
  const retry = useRef<(() => void) | null>(null);
  const [retryable, setRetryable] = useState(true);

  async function run(label: string, task: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusy(true);
    setActivity(label);
    setError("");
    setProgress(null);
    retry.current = () => void run(label, task);
    try {
      await task();
    } catch (caught) {
      setRetryable(!(caught instanceof CsvError));
      setError(caught instanceof Error ? caught.message : "The CSV import stopped.");
    } finally {
      inFlight.current = false;
      setActivity("");
      onBusy(false);
      overview.reload();
    }
  }

  useEffect(() => {
    if (!overview.data || overview.data.observations > 0 || seeded.current) return;
    seeded.current = true;
    void run("Loading sample observations", () => client.invoke("seedDemo"));
  }, [overview.data]);

  const importFile = (file: File | undefined) => {
    if (file)
      void run("Reading CSV", async () =>
        importObservations(
          file.name,
          await file.arrayBuffer(),
          async (chunk) =>
            (
              await client.invoke<{ received: number; complete: boolean; inserted: number }>(
                "importChunk",
                chunk,
              )
            ).result,
          setProgress,
        ),
      );
  };

  return (
    <>
      {open && (
        <div
          className="import-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <button
            type="button"
            disabled={Boolean(activity)}
            className={`drop-zone${dragging ? " dragging" : ""}`}
            onClick={() => input.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              importFile(event.dataTransfer.files[0]);
            }}
          >
            <Upload size={16} aria-hidden="true" />
            <strong>Choose a CSV file or drop one here</strong>
            <code>series, observed_at, value</code>
            <small>Optional: name, unit, domain, tags_json</small>
          </button>
        </div>
      )}
      <input
        type="file"
        accept=".csv,text/csv"
        ref={input}
        hidden
        aria-label="CSV file"
        onChange={(event) => {
          importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {activity && (
        <div className="import-status" role="status">
          <span>{progress ? `Importing ${progress.filename}` : activity}</span>
          {progress && (
            <>
              <progress
                aria-label="CSV import progress"
                value={progress.received}
                max={progress.total}
              />
              <span className="num">
                {count(progress.received)} / {count(progress.total)}
              </span>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="import-error">
          <Callout
            tone="danger"
            title="Could not load observations"
            action={
              retryable ? (
                <Button size="sm" variant="secondary" onClick={() => retry.current?.()}>
                  Try again
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
                  Choose another file
                </Button>
              )
            }
          >
            {error}
          </Callout>
        </div>
      )}
      {!activity && !error && progress && (
        <div className="import-status" role="status">
          <span>
            {progress.inserted
              ? `Imported ${count(progress.inserted)} rows`
              : "CSV already imported"}
          </span>
          <span className="num" title={`${progress.commits} requests`}>
            {progress.filename} ·{" "}
            {formatNumber(progress.elapsedMs / 1000, { maximumFractionDigits: 1 })} s
          </span>
        </div>
      )}
    </>
  );
}
