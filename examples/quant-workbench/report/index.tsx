import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useDatasetQuery } from "dohc/app";
import { ChartLine } from "dohc/icons";
import { Button, Callout } from "dohc/ui";
import {
  AXIS_COLORS,
  GRAIN_NAMES,
  MIN_PAIRS,
  summarize,
  type Overlays,
  type Report,
  type SavedSnapshot,
} from "./model";
import {
  count,
  formatDelta,
  formatInterval,
  formatR,
  formatRange,
  formatValue,
  unitSuffix,
  visibleChange,
} from "./format";
import { Trend } from "./trend";
import "./report.css";

const published = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

function Figures({ snapshot }: { snapshot: SavedSnapshot }) {
  return (
    <table className="figures">
      <thead>
        <tr>
          <th scope="col">Series</th>
          <th scope="col">Average</th>
          <th scope="col">7-day avg, first to last</th>
          <th scope="col">Low</th>
          <th scope="col">High</th>
          <th scope="col">Observations</th>
        </tr>
      </thead>
      <tbody>
        {snapshot.series.map((series, index) => {
          const bars = series.bars;
          const observations = bars.reduce((sum, bar) => sum + bar.count, 0);
          const unit = series.unit;
          const reference = Math.max(
            0,
            ...bars.map((bar) => Math.max(Math.abs(bar.low), Math.abs(bar.high))),
          );
          const show = (value: number) =>
            `${formatValue(value, unit, reference)}${unitSuffix(unit)}`;
          const week = snapshot.changes[index];
          return (
            <tr key={series.id}>
              <th scope="row">
                <i style={{ background: AXIS_COLORS[index] }} />
                {series.name}
              </th>
              <td data-label="Average">
                {observations
                  ? show(bars.reduce((sum, bar) => sum + bar.total, 0) / observations)
                  : "n/a"}
              </td>
              <td data-label="7-day avg, first to last">
                {week
                  ? (visibleChange(week.last - week.first, unit, week.first)
                      ? formatDelta(week.last - week.first, unit, week.first)
                      : formatValue(0, unit, week.first)) + unitSuffix(unit)
                  : "n/a"}
              </td>
              <td data-label="Low">
                {observations ? show(Math.min(...bars.map((bar) => bar.low))) : "n/a"}
              </td>
              <td data-label="High">
                {observations ? show(Math.max(...bars.map((bar) => bar.high))) : "n/a"}
              </td>
              <td data-label="Observations">{count(observations)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReportPage() {
  const report = useDatasetQuery<Report | null>("publishedReport");
  const [overlays, setOverlays] = useState<Overlays>({ ma7: false, ma30: true });
  const data = report.data;
  const snapshot = data?.snapshot;
  const names = snapshot?.series.map((series) => series.name) ?? [];
  const finding =
    snapshot?.comparison && names.length === 2 ? summarize(snapshot.comparison) : null;
  const sample = snapshot?.series.filter((series) => series.id.startsWith("sample-")) ?? [];
  return (
    <div className="report">
      <header className="report-mast">
        <span className="report-brand">
          <ChartLine size={14} aria-hidden="true" />
          SignalBook report
        </span>
        {data && (
          <time dateTime={new Date(data.createdAt).toISOString()}>
            Saved {published.format(data.createdAt)} UTC
          </time>
        )}
      </header>
      <main>
        <article className="report-article">
          <h1>{data?.title ?? "SignalBook"}</h1>
          {report.loading && !data && (
            <p className="report-meta" role="status">
              Loading report
            </p>
          )}
          {report.error && (
            <Callout
              tone="danger"
              title="Could not load this report"
              action={
                <Button size="sm" onClick={report.reload} variant="secondary">
                  Try again
                </Button>
              }
            >
              {report.error.message}
            </Callout>
          )}
          {data === null && <p className="report-empty">No report is linked</p>}
          {data && snapshot && (
            <>
              <p className="report-meta">
                {formatRange(snapshot.start, snapshot.end)} · {GRAIN_NAMES[snapshot.grain]} buckets
                · UTC
                {sample.length > 0 &&
                  (sample.length === snapshot.series.length
                    ? " · Built-in sample data"
                    : " · Includes built-in sample data")}
              </p>
              {data.body
                .split(/\n\s*\n/)
                .filter((paragraph) => paragraph.trim())
                .map((paragraph, index) => (
                  <p key={index} className="report-body">
                    {paragraph.trim()}
                  </p>
                ))}
              {finding?.kind === "few" && (
                <p className="report-finding">
                  Too few paired days between {names[0]} and {names[1]} to estimate a correlation (
                  {count(finding.n)} of the {MIN_PAIRS} needed).
                </p>
              )}
              {finding?.kind === "constant" && (
                <p className="report-finding">
                  The correlation between {names[0]} and {names[1]} is undefined: one of them does
                  not change across the {count(finding.n)} paired days.
                </p>
              )}
              {finding?.kind === "fit" && (
                <p className="report-finding">
                  <strong>r = {formatR(finding.r)}</strong> between {names[0]} and {names[1]}
                  {finding.lag
                    ? ` ${Math.abs(finding.lag)} ${Math.abs(finding.lag) === 1 ? "day" : "days"} ${finding.lag > 0 ? "later" : "earlier"}`
                    : " on the same day"}
                  , across {count(finding.n)} paired days
                  {finding.effective !== null &&
                    `, about ${count(Math.round(finding.effective))} of them independent`}{" "}
                  (R²{"\u00a0"}
                  {(finding.r * finding.r).toFixed(3)}
                  {finding.ci &&
                    `, 95% CI ${formatInterval(finding.ci)} allowing for day-to-day persistence`}
                  ).
                  {finding.ci &&
                    " The interval holds for this lag alone and does not correct for trying other lags."}
                </p>
              )}
              <section className="report-figure" aria-label="Chart">
                <div className="report-controls">
                  <p className="report-note">Averages use only the days in this range.</p>
                  <div className="report-toggles" role="group" aria-label="Moving averages">
                    <button
                      type="button"
                      className="sb-toggle"
                      aria-pressed={overlays.ma7}
                      onClick={() => setOverlays({ ...overlays, ma7: !overlays.ma7 })}
                    >
                      <span className="sb-dash" aria-hidden="true" />
                      MA 7
                    </button>
                    <button
                      type="button"
                      className="sb-toggle"
                      aria-pressed={overlays.ma30}
                      onClick={() => setOverlays({ ...overlays, ma30: !overlays.ma30 })}
                    >
                      <span className="sb-dot" aria-hidden="true" />
                      MA 30
                    </button>
                  </div>
                </div>
                <div className="report-chart">
                  <Trend
                    snapshot={snapshot}
                    overlays={overlays}
                    label={`${names.join(" and ")} rollups. Move with the arrow keys.`}
                  />
                </div>
              </section>
              <section aria-labelledby="figures-title">
                <h2 id="figures-title">Key figures</h2>
                <Figures snapshot={snapshot} />
              </section>
              <footer className="report-foot">
                Frozen snapshot of {GRAIN_NAMES[snapshot.grain].toLowerCase()} rollups in UTC. The
                chart plots bucket means; Low and High are single readings.
              </footer>
            </>
          )}
        </article>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <ReportPage />
  </AppProvider>,
);
