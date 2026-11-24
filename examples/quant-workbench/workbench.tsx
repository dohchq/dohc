import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApp, useDatasetMutation, useDatasetQuery } from "dohc/app";
import { Sparkline } from "dohc/charts";
import {
  AppShell,
  Button,
  Callout,
  DataTable,
  Field,
  Input,
  Select,
  Textarea,
  formatNumber,
} from "dohc/ui";
import { Scatter, Trend, type Grain, type Pair, type Series, type Snapshot } from "./charts";
import { importObservations, type ImportProgress } from "./ingest";

type CatalogEntry = Series & { start: string; end: string; count: number };
type Overview = { series: CatalogEntry[]; observations: number; batches: number };
type Comparison = { r: number | null; rSquared: number | null; n: number; points: Pair[] };
type Outlier = { id: number; series_id: string; observed_at: string; value: number; z: number };
type Analysis = { rollups: Snapshot; comparison: Comparison | null; outliers: Outlier[] };
type Range = { start: string; end: string };
type Preset = "30D" | "90D" | "1Y" | "All";
type Note = {
  id: string;
  title: string;
  date_start: string;
  date_end: string;
  grant_id: string | null;
};
type SavedReport = {
  title: string;
  body: string;
  createdAt: number;
  snapshot: Snapshot;
  linked: boolean;
};
const NOTE_PAGE_SIZE = 50;

const PRESETS: Record<Preset, number> = { "30D": 30, "90D": 90, "1Y": 365, All: 0 };
const GRAINS: Record<Grain, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
};
const emptyRange = { start: "", end: "" };
const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const numeric = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });

function getRange(entries: CatalogEntry[], preset: Preset): Range {
  if (!entries.length) return emptyRange;
  const start = entries.map((entry) => entry.start).sort()[0];
  const end = entries
    .map((entry) => entry.end)
    .sort()
    .at(-1)!;
  const days = PRESETS[preset];
  return {
    start: days ? [start, dateText(Date.parse(end) - (days - 1) * 86_400_000)].sort()[1] : start,
    end,
  };
}

function bucketEnd(day: string, grain: Grain) {
  const date = new Date(day);
  if (grain === "week") date.setUTCDate(date.getUTCDate() + 6);
  if (grain === "month") date.setUTCMonth(date.getUTCMonth() + 1, 0);
  if (grain === "year") date.setUTCFullYear(date.getUTCFullYear() + 1, 0, 0);
  return date.toISOString().slice(0, 10);
}

function QueryError({
  error,
  reload,
  message,
}: {
  error: Error;
  reload: () => void;
  message: string;
}) {
  return (
    <Callout
      tone="danger"
      title={message}
      action={
        <Button onClick={reload} variant="secondary">
          Try again
        </Button>
      }
    >
      {error.message}
    </Callout>
  );
}

function Importer({ overview }: { overview: ReturnType<typeof useDatasetQuery<Overview>> }) {
  const client = useApp();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [activity, setActivity] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);
  const inFlight = useRef(false);
  const retry = useRef<(() => void) | null>(null);

  async function run(label: string, task: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setActivity(label);
    setError("");
    setProgress(null);
    retry.current = () => {
      void run(label, task);
    };
    try {
      await task();
      overview.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The CSV import stopped.");
    } finally {
      inFlight.current = false;
      setActivity("");
    }
  }

  useEffect(() => {
    if (!overview.data || overview.data.observations > 0 || seeded.current) return;
    seeded.current = true;
    void run("Loading sample observations", () => client.invoke("seedDemo"));
  }, [overview.data]);

  const importFile = (file: File | undefined) => {
    if (file)
      void run("Reading CSV", async () => {
        await importObservations(
          file.name,
          await file.arrayBuffer(),
          async (chunk) => {
            const reply = await client.invoke<{
              received: number;
              complete: boolean;
              inserted: number;
            }>("importChunk", chunk);
            return reply.result;
          },
          setProgress,
        );
      });
  };

  return (
    <header className="masthead">
      <div className="brand">
        <div>
          <h1>SignalBook</h1>
          <p>Time-series workbench</p>
        </div>
      </div>
      <div className="masthead-actions">
        <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          Import CSV
        </Button>
      </div>
      {open && (
        <div className="import-details">
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
            <strong>Drop a CSV or choose a file</strong>
            <span>
              Required columns <code>series, observed_at, value</code>
            </span>
          </button>
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
        </div>
      )}
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
              <span>
                {numeric(progress.received)} / {numeric(progress.total)} rows
              </span>
            </>
          )}
        </div>
      )}
      {error && (
        <Callout
          tone="danger"
          title="Could not load observations"
          action={
            <Button variant="secondary" onClick={() => retry.current?.()}>
              Try again
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      {!activity && !error && progress && (
        <div className="import-status" role="status">
          <span>
            {progress.inserted
              ? `Imported ${numeric(progress.inserted)} rows`
              : "CSV already imported"}{" "}
            · {progress.filename}
          </span>
          <span>
            {numeric(progress.elapsedMs / 1000)} s ·{" "}
            {progress.inserted > 0 &&
              `${numeric(Math.round((progress.inserted * 1000) / progress.elapsedMs))} rows/s · `}
            {progress.commits} requests · {numeric(progress.maxInputBytes)} B peak input
          </span>
        </div>
      )}
    </header>
  );
}

function Research({
  range,
  ids,
  grain,
  canSave,
}: {
  range: Range;
  ids: string[];
  grain: Grain;
  canSave: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const notes = useDatasetQuery<Note[]>("listNotes", { offset });
  const save = useDatasetMutation<
    Range & { title: string; body: string; ids: string[]; grain: Grain },
    { id: string }
  >("saveNote");
  const setLink = useDatasetMutation<{ id: string; grant: string | null }, { id: string }>(
    "setReportLink",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState("");
  const [grant, setGrant] = useState("");
  const report = useDatasetQuery<SavedReport | null>(
    "readNote",
    { id: selected },
    { enabled: Boolean(selected) },
  );

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    try {
      const saved = save.uncertain
        ? await save.retry()
        : await save.mutate({ title, body, ...range, ids, grain });
      if (!saved) return;
      setTitle("");
      setBody("");
      setSelected(saved.result.id);
      setGrant("");
      setOffset(0);
      notes.reload();
    } catch {
      return;
    }
  }

  async function updateLink(value: string | null) {
    try {
      await setLink.mutate({ id: selected, grant: value });
      setGrant("");
      notes.reload();
      report.reload();
    } catch {
      return;
    }
  }

  return (
    <aside className="panel research" aria-labelledby="research-title">
      <div className="panel-heading">
        <h2 id="research-title">Research notes</h2>
      </div>
      <form className="note-form" onSubmit={saveNote}>
        <Field label="Title" htmlFor="note-title">
          <Input
            id="note-title"
            value={title}
            maxLength={120}
            required
            readOnly={save.uncertain}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What did you find?"
          />
        </Field>
        <Field label="Note" htmlFor="note-body">
          <Textarea
            id="note-body"
            value={body}
            maxLength={6000}
            rows={4}
            required
            readOnly={save.uncertain}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Use Markdown to record your findings."
          />
        </Field>
        {save.error && <Callout tone="danger">{save.error.message}</Callout>}
        <div className="note-save">
          <Button
            type="submit"
            variant="primary"
            disabled={(!canSave && !save.uncertain) || save.pending}
          >
            {save.pending ? "Saving…" : save.uncertain ? "Retry save" : "Save snapshot"}
          </Button>
          <span>
            {canSave ? `${range.start} / ${range.end}` : "Select a range with observations."}
          </span>
        </div>
      </form>
      <div className="note-library">
        <h3>Saved snapshots</h3>
        {notes.error && (
          <QueryError
            error={notes.error}
            reload={notes.reload}
            message="Could not load snapshots"
          />
        )}
        {offset === 0 && notes.data?.length === 0 && <p>No snapshots yet.</p>}
        <div className="note-entries">
          {notes.data?.slice(0, NOTE_PAGE_SIZE).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="note-row"
              aria-pressed={selected === entry.id}
              onClick={() => {
                setSelected(entry.id);
                setGrant("");
              }}
            >
              <span>
                <strong>{entry.title}</strong>
                <small>
                  {entry.date_start} / {entry.date_end}
                </small>
              </span>
              {entry.grant_id && <small>Published</small>}
            </button>
          ))}
        </div>
        {(offset > 0 || (notes.data?.length ?? 0) > NOTE_PAGE_SIZE) && (
          <div className="note-page">
            {offset > 0 && (
              <Button size="sm" onClick={() => setOffset(offset - NOTE_PAGE_SIZE)}>
                Newer snapshots
              </Button>
            )}
            {(notes.data?.length ?? 0) > NOTE_PAGE_SIZE && (
              <Button size="sm" onClick={() => setOffset(offset + NOTE_PAGE_SIZE)}>
                Older snapshots
              </Button>
            )}
          </div>
        )}
      </div>
      {report.error && (
        <QueryError
          error={report.error}
          reload={report.reload}
          message="Could not load this snapshot"
        />
      )}
      {report.data && (
        <div className="note-preview">
          <h3>{report.data.title}</h3>
          <p className="note-body">{report.data.body}</p>
          {report.data.snapshot.series.map((series) => (
            <div className="snapshot-series" key={series.id}>
              <span>{series.name}</span>
              {series.bars.length > 0 && (
                <Sparkline
                  values={series.bars.map((bar) => bar.mean)}
                  width={88}
                  height={25}
                  ariaLabel={`${series.name} snapshot`}
                />
              )}
            </div>
          ))}
          <form
            className="link-form"
            onSubmit={(event) => {
              event.preventDefault();
              void updateLink(grant.trim());
            }}
          >
            {report.data.linked ? (
              <>
                <span className="published">Report linked</span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={setLink.pending}
                  onClick={() => void updateLink(null)}
                >
                  Withdraw report
                </Button>
              </>
            ) : (
              <>
                <Field label="Report link grant ID" htmlFor="report-grant">
                  <Input
                    id="report-grant"
                    value={grant}
                    maxLength={128}
                    required
                    onChange={(event) => setGrant(event.target.value)}
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={setLink.pending}>
                  Link report
                </Button>
              </>
            )}
            {setLink.error && <Callout tone="danger">{setLink.error.message}</Callout>}
          </form>
        </div>
      )}
    </aside>
  );
}

export function Workbench() {
  const overview = useDatasetQuery<Overview>("overview");
  const [selection, setSelection] = useState<[string, string] | null>(null);
  const [preset, setPreset] = useState<Preset>("90D");
  const [custom, setCustom] = useState<Range | null>(null);
  const [grain, setGrain] = useState<Grain>("day");
  const [rolling, setRolling] = useState<"ma7" | "ma30" | null>("ma7");
  const [lag, setLag] = useState(0);
  const entries = overview.data?.series ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const first = byId.get(selection?.[0] ?? "sample-sleep-hours") ?? entries[0];
  const requestedSecond = byId.get(selection?.[1] ?? "sample-resting-hr");
  const second =
    selection?.[1] === ""
      ? undefined
      : requestedSecond && requestedSecond.id !== first?.id
        ? requestedSecond
        : entries.find((entry) => entry.id !== first?.id);
  const active = [first, second].filter((entry): entry is CatalogEntry => entry !== undefined);
  const range = custom ?? getRange(active, preset);
  const validRange = Boolean(range.start && range.end && range.start <= range.end);
  const ids = active.map((entry) => entry.id);
  const query = { ids, ...range, batches: overview.data?.batches };
  const view = { ...query, grain };
  const analysis = useDatasetQuery<Analysis>(
    "analyze",
    { ...view, lag },
    { enabled: ids.length > 0 && validRange },
  );
  const rollups = analysis.data?.rollups;
  const stats = analysis.data?.comparison ?? undefined;
  const outlierRows = analysis.data?.outliers;

  return (
    <AppShell width="wide" className="signalbook">
      <Importer overview={overview} />
      {overview.error && (
        <QueryError
          error={overview.error}
          reload={overview.reload}
          message="Could not load series"
        />
      )}
      <div className="scorecards" aria-label="Summary">
        <div>
          <span>Observations</span>
          <strong id="observation-count">
            {overview.data ? numeric(overview.data.observations) : "…"}
          </strong>
        </div>
        <div>
          <span>Series</span>
          <strong>{entries.length}</strong>
        </div>
        <div>
          <span>Pearson r</span>
          <strong className="stat-color">{stats?.r == null ? "—" : stats.r.toFixed(3)}</strong>
        </div>
        <div>
          <span>R²</span>
          <strong>{stats?.rSquared == null ? "—" : stats.rSquared.toFixed(3)}</strong>
        </div>
      </div>
      <div className="workbench-grid">
        <div className="analysis-grid">
          <section className="panel timeline" aria-labelledby="timeline-title">
            <div className="panel-heading chart-heading">
              <div>
                <h2 id="timeline-title">Time series</h2>
                <p>
                  {rollups ? `${GRAINS[rollups.grain]} mean · UTC` : "Mean by time bucket · UTC"}
                </p>
              </div>
              <div className="segments" aria-label="Date range">
                {(Object.keys(PRESETS) as Preset[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={!custom && preset === value}
                    onClick={() => {
                      setPreset(value);
                      setCustom(null);
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
            {first && (
              <div className="chart-filters">
                <Field label="Left axis" htmlFor="series-x">
                  <Select
                    id="series-x"
                    value={first.id}
                    onChange={(event) => {
                      const id = event.target.value;
                      setSelection([id, id === second?.id ? first.id : (second?.id ?? "")]);
                    }}
                  >
                    {entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name} · {entry.domain}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Right axis" htmlFor="series-y">
                  <Select
                    id="series-y"
                    value={second?.id ?? ""}
                    onChange={(event) => setSelection([first.id, event.target.value])}
                  >
                    <option value="">None</option>
                    {entries
                      .filter((entry) => entry.id !== first.id)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name} · {entry.domain}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Buckets" htmlFor="grain">
                  <Select
                    id="grain"
                    value={grain}
                    onChange={(event) => setGrain(event.target.value as Grain)}
                  >
                    <option value="day">Daily</option>
                    <option value="week">Weekly</option>
                    <option value="month">Monthly</option>
                  </Select>
                </Field>
                <Field label="Rolling mean" htmlFor="rolling">
                  <Select
                    id="rolling"
                    value={rolling ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRolling(value === "ma7" || value === "ma30" ? value : null);
                    }}
                  >
                    <option value="">Off</option>
                    <option value="ma7">7 days</option>
                    <option value="ma30">30 days</option>
                  </Select>
                </Field>
              </div>
            )}
            {analysis.error ? (
              <QueryError
                error={analysis.error}
                reload={analysis.reload}
                message="Could not load rollups"
              />
            ) : rollups ? (
              <Trend
                key={JSON.stringify(view)}
                snapshot={rollups}
                rolling={rolling}
                onBrush={(start, end) => {
                  const finish = bucketEnd(end, rollups.grain);
                  setCustom({
                    start: start < range.start ? range.start : start,
                    end: finish > range.end ? range.end : finish,
                  });
                }}
              />
            ) : (
              <p className="empty-chart" role="status">
                {analysis.loading || overview.loading
                  ? "Loading time series…"
                  : !first
                    ? "Import observations to plot a series."
                    : "Choose a valid date range."}
              </p>
            )}
            {first && (
              <div className="chart-footer">
                <span>Drag across the chart to zoom.</span>
                <label>
                  Start{" "}
                  <Input
                    type="date"
                    value={range.start}
                    onChange={(event) => setCustom({ ...range, start: event.target.value })}
                  />
                </label>
                <label>
                  End{" "}
                  <Input
                    type="date"
                    value={range.end}
                    onChange={(event) => setCustom({ ...range, end: event.target.value })}
                  />
                </label>
              </div>
            )}
          </section>
          <div className="lower-grid">
            <section className="panel comparison" aria-labelledby="compare-title">
              <div className="panel-heading">
                <h2 id="compare-title">Correlation</h2>
                <p>{stats ? `${numeric(stats.n)} paired days` : "Paired daily means"}</p>
              </div>
              <Field label="Right series lag" htmlFor="lag">
                <Select
                  id="lag"
                  disabled={!second}
                  value={lag}
                  onChange={(event) => setLag(Number(event.target.value))}
                >
                  {Array.from({ length: 61 }, (_, index) => index - 30).map((value) => (
                    <option key={value} value={value}>
                      {value > 0 ? "+" : ""}
                      {value} days
                    </option>
                  ))}
                </Select>
              </Field>
              {analysis.error && (
                <QueryError
                  error={analysis.error}
                  reload={analysis.reload}
                  message="Could not compare series"
                />
              )}
              {stats && first && second && (
                <Scatter points={stats.points} xSeries={first} ySeries={second} />
              )}
              {!stats && !analysis.error && (
                <p className="empty-chart">
                  {second
                    ? "Waiting for paired observations."
                    : "Choose a right-axis series to compare."}
                </p>
              )}
            </section>
            <section className="panel outliers" aria-labelledby="outlier-title">
              <div className="panel-heading">
                <h2 id="outlier-title">Outliers</h2>
                <p>Top 30 · |z| &gt; 2</p>
              </div>
              {analysis.error && (
                <QueryError
                  error={analysis.error}
                  reload={analysis.reload}
                  message="Could not load outliers"
                />
              )}
              {outlierRows && (
                <DataTable
                  rows={outlierRows}
                  rowKey={(row) => String(row.id)}
                  columns={[
                    {
                      key: "at",
                      header: "UTC",
                      render: (row) => (
                        <time dateTime={row.observed_at} title={row.observed_at}>
                          {row.observed_at.slice(0, 16).replace("T", " ")}
                        </time>
                      ),
                    },
                    {
                      key: "series",
                      header: "Series",
                      render: (row) => byId.get(row.series_id)?.name ?? row.series_id,
                    },
                    {
                      key: "value",
                      header: "Value",
                      align: "right",
                      render: (row) => numeric(row.value),
                    },
                    {
                      key: "z",
                      header: "z",
                      align: "right",
                      render: (row) => <strong>{row.z.toFixed(2)}</strong>,
                    },
                  ]}
                  emptyTitle="No outliers in this date range"
                />
              )}
            </section>
          </div>
        </div>
        <Research
          range={range}
          ids={ids}
          grain={grain}
          canSave={Boolean(rollups?.series.some((series) => series.bars.length))}
        />
      </div>
    </AppShell>
  );
}
