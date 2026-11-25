import type { useDatasetQuery } from "dohc/app";
import { LagProfile, Scatter } from "./charts";
import { useSticky } from "./hooks";
import { QueryError } from "./query-error";
import { AXIS_COLORS, MIN_PAIRS, interval, type LagPoint } from "./report/model";
import {
  count,
  formatDelta,
  formatInterval,
  formatR,
  formatValue,
  unitSuffix,
} from "./report/format";
import { dayT, lagText, peakLag, strength, supported } from "./stats";
import type { CatalogEntry, Comparison, Outlier } from "./types";

const stampFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const stamp = (iso: string) => stampFormat.format(Date.parse(iso)).replace(",", "");

export function Correlation({
  left,
  right,
  profile,
  lag,
  setLag,
  comparison,
  valid,
}: {
  left?: CatalogEntry;
  right?: CatalogEntry;
  profile: LagPoint[] | null;
  lag: number;
  setLag: (lag: number) => void;
  comparison: ReturnType<typeof useDatasetQuery<Comparison>>;
  valid: boolean;
}) {
  const point = profile?.find((entry) => entry.lag === lag);
  const n = point?.n ?? 0;
  const r = point?.r ?? null;
  const independent = point?.effective ?? null;
  const chip = strength(r, n, independent);
  const range = r === null ? null : interval(r, independent);
  const floor = profile ? supported(profile) : 0;
  const peak = profile ? peakLag(profile, floor) : null;
  const tried = profile?.filter((point) => point.r !== null && point.n >= floor).length ?? 0;
  const retained = useSticky(comparison.data, `${left?.id}|${right?.id}`);
  const points = valid ? retained : undefined;
  return (
    <section className="deck-panel correlation" aria-labelledby="compare-title">
      <header className="deck-head">
        <h2 id="compare-title">Lag correlation</h2>
        {right && profile && <span className={`chip chip-${chip.tone}`}>{chip.label}</span>}
      </header>
      {!left || !right ? (
        <p className="sb-empty">Choose a series for the right axis (R) to compare</p>
      ) : (
        <>
          <p className="pairing">
            <i style={{ background: AXIS_COLORS[0] }} />
            {left.name} on day t <span>vs</span>
            <i style={{ background: AXIS_COLORS[1] }} />
            {right.name} on day {dayT(lag)}
          </p>
          <div className="lag-control">
            <label htmlFor="lag">Lag</label>
            <input
              id="lag"
              type="range"
              min={-30}
              max={30}
              step={1}
              value={lag}
              aria-label="Right series lag"
              aria-valuetext={`${lag} days`}
              onChange={(event) => setLag(Number(event.target.value))}
            />
            <output htmlFor="lag" className="num">
              {lagText(lag)}
            </output>
          </div>
          <dl className="stats">
            <div>
              <dt>r</dt>
              <dd>{r === null ? "n/a" : formatR(r)}</dd>
            </div>
            <div>
              <dt>R²</dt>
              <dd>{r === null ? "n/a" : (r * r).toFixed(3)}</dd>
            </div>
            <div>
              <dt>95% CI</dt>
              <dd aria-describedby={profile ? "ci-note" : undefined}>
                {range ? formatInterval(range) : "n/a"}
              </dd>
            </div>
            <div>
              <dt>n</dt>
              <dd>
                {count(n)} <small>paired days</small>
                {n > 0 && independent !== null && (
                  <small> · ≈{count(Math.round(independent))} independent</small>
                )}
              </dd>
            </div>
            {peak?.r != null && (
              <div className="stat-peak">
                <dt>Peak</dt>
                <dd>
                  <button type="button" className="link-button" onClick={() => setLag(peak.lag)}>
                    {formatR(peak.r)} at {lagText(peak.lag)}
                  </button>
                  <small>
                    {" "}
                    · strongest of {tried} supported {tried === 1 ? "lag" : "lags"}
                    {Math.abs(peak.lag) === 30 && ", at the edge of the window"}
                  </small>
                </dd>
              </div>
            )}
          </dl>
          {profile && (
            <p className="stat-note" id="ci-note">
              {n < MIN_PAIRS
                ? "No interval: too few paired days."
                : r === null
                  ? "No interval: one series is constant."
                  : independent === null
                    ? "No interval: too few of the paired days are consecutive to estimate day-to-day persistence."
                    : !range
                      ? "No interval: fewer than 4 independent days."
                      : `The interval allows for each series' day-to-day persistence.${peak?.lag === lag && tried > 1 ? " This is the strongest lag, so its interval is optimistic." : ""}`}
              {!comparison.loading &&
                !comparison.error &&
                points?.lag === lag &&
                points.detrended !== null &&
                ` Both series trend over this range. With each straight-line trend removed, r is ${formatR(points.detrended)}.`}
            </p>
          )}
          {profile && <LagProfile profile={profile} lag={lag} onLag={setLag} />}
          {comparison.error ? (
            <QueryError
              error={comparison.error}
              reload={comparison.reload}
              message="Could not compare series"
            />
          ) : !valid ? (
            <p className="sb-empty">Choose a start date before the end date</p>
          ) : points ? (
            <div
              className={comparison.loading || points.lag !== lag ? "stale" : undefined}
              aria-busy={comparison.loading || points.lag !== lag}
            >
              <Scatter
                points={points.points}
                line={points.line}
                xSeries={left}
                ySeries={right}
                lag={points.lag}
                total={points.n}
              />
            </div>
          ) : (
            <p className="sb-empty" role="status">
              Loading pairs
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function Outliers({
  rows,
  byId,
  left,
  focused,
  onFocus,
}: {
  rows: Outlier[] | undefined;
  byId: Map<string, CatalogEntry>;
  left?: CatalogEntry;
  focused: number | null;
  onFocus: (row: Outlier, keyboard: boolean) => void;
}) {
  const spread = Math.max(0.5, Math.abs(rows?.[0]?.z ?? 0) - 2);
  return (
    <section className="deck-panel outliers" aria-labelledby="outlier-title">
      <header className="deck-head">
        <h2 id="outlier-title">Outliers</h2>
        <span className="deck-note">
          {rows?.length
            ? `${rows.length > 30 ? "30+" : rows.length} with |z| > 2 in this range`
            : ""}
        </span>
      </header>
      {rows && rows.length === 0 && <p className="sb-empty">No outliers in this date range</p>}
      {rows && rows.length > 0 && (
        <p className="sb-sr">
          Bars scale from |z| 2 to the largest |z| listed, or to 2.5 if that is larger.
        </p>
      )}
      {rows && rows.length > 0 && (
        <div className="outlier-table" role="list">
          <div className="outlier-row outlier-header" aria-hidden="true">
            <span>UTC</span>
            <span>Series</span>
            <span>Value</span>
            <span title="Gap from the trailing 30-day average, less this series' typical gap in the range">
              vs expected
            </span>
            <span>z</span>
          </div>
          {rows.slice(0, 30).map((row) => {
            const series = byId.get(row.series_id);
            const unit = series?.unit ?? "";
            const color = row.series_id === left?.id ? AXIS_COLORS[0] : AXIS_COLORS[1];
            const reference = Math.max(Math.abs(row.value), Math.abs(row.mean));
            const gap = formatDelta(row.value - row.mean, unit, reference);
            const versus = `${formatValue(Math.abs(row.value - row.mean), unit, reference)}${unitSuffix(unit)} ${row.value >= row.mean ? "above" : "below"} expected`;
            return (
              <div role="listitem" key={row.id} className="outlier-item">
                <button
                  type="button"
                  data-outlier=""
                  className="outlier-row"
                  aria-pressed={focused === row.id}
                  aria-label={`${series?.name ?? row.series_id} ${formatValue(row.value, unit, reference)}${unitSuffix(unit)} on ${row.observed_at.slice(0, 16).replace("T", " ")} UTC, ${versus}, z ${row.z.toFixed(2)}. Show on chart.`}
                  onClick={(event) => onFocus(row, event.detail === 0)}
                >
                  <time dateTime={row.observed_at}>
                    {stamp(row.observed_at).slice(0, -6)}{" "}
                    <span className="outlier-hour">{stamp(row.observed_at).slice(-5)}</span>
                  </time>
                  <span className="outlier-series">
                    <i style={{ background: color }} />
                    <span className="outlier-name">{series?.name ?? row.series_id}</span>
                  </span>
                  <span className="num">
                    {formatValue(row.value, unit, reference)}
                    <small>{unitSuffix(unit)}</small>
                    <span className="outlier-gap" aria-hidden="true">
                      {versus}
                    </span>
                  </span>
                  <span className="num">
                    {gap}
                    <small>{unitSuffix(unit)}</small>
                  </span>
                  <span className="z">
                    <span className="z-bar" aria-hidden="true">
                      <span style={{ width: `${8 + 92 * ((Math.abs(row.z) - 2) / spread)}%` }} />
                    </span>
                    <span className="num">
                      {row.z > 0 ? "+" : "−"}
                      {Math.abs(row.z).toFixed(2)}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
