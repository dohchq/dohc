import { useId, useRef, useState, type PointerEvent } from "react";
import { formatNumber } from "dohc/ui";

export type Series = {
  id: string;
  slug: string;
  name: string;
  unit: string;
  domain: string;
  color: number;
};

export type Bar = {
  bucket: string;
  count: number;
  mean: number;
  total: number;
  low: number;
  high: number;
  open: number;
  close: number;
  ma7: number | null;
  ma30: number | null;
};

export type Grain = "day" | "week" | "month" | "year";
export type Snapshot = {
  start: string;
  end: string;
  grain: Grain;
  series: Array<Series & { bars: Bar[] }>;
};

export type Pair = { day: string; y_day: string; x: number; y: number };
export const seriesColor = (color: number) => `var(--kit-chart-${color})`;
const digits = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });
const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const chartWidth = 900;
const chartHeight = 300;
const chart = { left: 74, right: 826, top: 26, bottom: 258 };

function extent(values: number[]) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min)) return [0, 1];
  const padding = (max - min || Math.abs(max) || 1) * 0.1;
  min -= padding;
  max += padding;
  return [min, max];
}

function scale(domain: number[], start: number, end: number) {
  return (value: number) =>
    start + (end - start) * ((value - domain[0]) / (domain[1] - domain[0] || 1));
}

function ticks([min, max]: number[], steps: number) {
  return Array.from({ length: steps + 1 }, (_, i) => min + ((max - min) * i) / steps);
}

function line(
  bars: Bar[],
  get: (bar: Bar) => number | null,
  x: (day: number) => number,
  y: (value: number) => number,
) {
  let penDown = false;
  return bars
    .map((bar) => {
      const value = get(bar);
      if (value === null) {
        penDown = false;
        return "";
      }
      const point = `${penDown ? "L" : "M"}${x(Date.parse(bar.bucket)).toFixed(2)},${y(value).toFixed(2)}`;
      penDown = true;
      return point;
    })
    .join(" ");
}

export function Trend({
  snapshot,
  rolling,
  onBrush,
}: {
  snapshot: Snapshot;
  rolling: "ma7" | "ma30" | null;
  onBrush: (start: string, end: string) => void;
}) {
  const gradient = useId();
  const hoverLabel = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const pointerStart = useRef<number | null>(null);
  const dates = [
    ...new Set(snapshot.series.flatMap((series) => series.bars.map((bar) => bar.bucket))),
  ].sort();
  if (!dates.length) return <p className="empty-chart">No observations in this date range.</p>;
  const dateDomain = [Date.parse(dates[0]), Date.parse(dates[dates.length - 1])];
  const x =
    dateDomain[0] === dateDomain[1]
      ? () => (chart.left + chart.right) / 2
      : scale(dateDomain, chart.left, chart.right);
  const datePositions = dates.map((day) => x(Date.parse(day)));
  const series = snapshot.series.map((entry) => {
    const domain = extent(
      entry.bars.flatMap((bar) => {
        const average = rolling ? bar[rolling] : null;
        return average === null ? [bar.mean] : [bar.mean, average];
      }),
    );
    const y = scale(domain, chart.bottom, chart.top);
    return { ...entry, domain, y, colorValue: seriesColor(entry.color) };
  });
  const first = series[0];
  const second = series[1];
  const activeIndex = hover === null ? null : Math.max(0, Math.min(dates.length - 1, hover));
  const activeDate = activeIndex === null ? null : dates[activeIndex];
  const activeX = activeIndex === null ? null : datePositions[activeIndex];
  const activeBars = series.flatMap((entry) => {
    const bar = entry.bars.find((item) => item.bucket === activeDate);
    return bar ? [{ entry, bar }] : [];
  });
  const primaryPath = line(first.bars, (bar) => bar.mean, x, first.y);
  const firstBar = first.bars[0];
  const lastBar = first.bars[first.bars.length - 1];
  const area =
    firstBar &&
    lastBar &&
    `${primaryPath} L${x(Date.parse(lastBar.bucket))},${chart.bottom}
    L${x(Date.parse(firstBar.bucket))},${chart.bottom} Z`;
  const indexAt = (event: PointerEvent<SVGSVGElement>) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - left) * chartWidth) / width;
    return datePositions.reduce(
      (best, at, i) =>
        Math.abs(at - position) < Math.abs(datePositions[best] - position) ? i : best,
      0,
    );
  };
  return (
    <>
      <div className="chart-scroll">
        <div className="chart-canvas">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="trend"
            role="group"
            aria-label="Time series. Move with the arrow keys or drag to select a date range."
            aria-describedby={activeDate ? hoverLabel : undefined}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Escape") setHover(null);
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setHover((index) =>
                  Math.min(
                    dates.length - 1,
                    Math.max(
                      0,
                      (index ?? (event.key === "ArrowLeft" ? dates.length : -1)) +
                        (event.key === "ArrowLeft" ? -1 : 1),
                    ),
                  ),
                );
              }
            }}
            onPointerMove={(event) => {
              const index = indexAt(event);
              setHover(index);
              if (pointerStart.current !== null)
                setBrush({ start: pointerStart.current, end: index });
            }}
            onPointerLeave={() => {
              if (pointerStart.current === null) setHover(null);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const index = indexAt(event);
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerStart.current = index;
              setBrush({ start: index, end: index });
            }}
            onPointerUp={(event) => {
              const start = pointerStart.current;
              const end = indexAt(event);
              pointerStart.current = null;
              setBrush(null);
              if (start !== null && start !== end)
                onBrush(dates[Math.min(start, end)], dates[Math.max(start, end)]);
            }}
            onPointerCancel={() => {
              pointerStart.current = null;
              setBrush(null);
            }}
          >
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={first.colorValue} stopOpacity="0.21" />
                <stop offset="100%" stopColor={first.colorValue} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {ticks(first.domain, 4).map((tick, i) => (
              <g key={i} transform={`translate(0 ${first.y(tick)})`}>
                <line className="grid-line" x1={chart.left} x2={chart.right} />
                <text x={chart.left - 10} y={4} textAnchor="end" fill={first.colorValue}>
                  {digits(tick)}
                </text>
                {second && (
                  <text x={chart.right + 10} y={4} fill={second.colorValue}>
                    {digits(ticks(second.domain, 4)[i])}
                  </text>
                )}
              </g>
            ))}
            {(dates.length === 1 ? [dateDomain[0]] : ticks(dateDomain, 5)).map((tick) => (
              <text key={tick} className="axis-label" x={x(tick)} y={284} textAnchor="middle">
                {dayLabel.format(tick)}
              </text>
            ))}
            {area && <path d={area} fill={`url(#${gradient})`} />}
            {series.map((entry, index) => (
              <g key={entry.id} fill="none" stroke={entry.colorValue} strokeWidth="2">
                <path
                  d={line(entry.bars, (bar) => bar.mean, x, entry.y)}
                  strokeDasharray={index === 1 ? "5 3" : undefined}
                />
                {entry.bars.length === 1 && (
                  <circle
                    cx={x(Date.parse(entry.bars[0].bucket))}
                    cy={entry.y(entry.bars[0].mean)}
                    r={3}
                    fill={entry.colorValue}
                  />
                )}
                {rolling && (
                  <path
                    d={line(entry.bars, (bar) => bar[rolling], x, entry.y)}
                    strokeDasharray="2 4"
                    opacity={0.72}
                  />
                )}
              </g>
            ))}
            {brush && (
              <rect
                className="chart-brush"
                x={datePositions[Math.min(brush.start, brush.end)]}
                y={chart.top}
                width={Math.abs(datePositions[brush.start] - datePositions[brush.end])}
                height={chart.bottom - chart.top}
              />
            )}
            {activeX !== null && (
              <line
                className="chart-cursor"
                x1={activeX}
                x2={activeX}
                y1={chart.top}
                y2={chart.bottom}
              />
            )}
            {activeX !== null &&
              activeBars.map(({ entry, bar }) => (
                <circle
                  key={entry.id}
                  cx={activeX}
                  cy={entry.y(bar.mean)}
                  r={4}
                  fill={entry.colorValue}
                  className="chart-dot"
                />
              ))}
          </svg>
          {activeX !== null && !brush && (
            <div
              role="tooltip"
              id={hoverLabel}
              className={`chart-tooltip${activeX > chartWidth / 2 ? " chart-tooltip-left" : ""}`}
              style={{ left: `${(activeX * 100) / chartWidth}%` }}
            >
              <strong>{activeDate}</strong>
              {activeBars.map(({ entry, bar }) => (
                <span key={entry.id}>
                  <b style={{ color: entry.colorValue }}>{entry.name}</b> {digits(bar.mean)}{" "}
                  {entry.unit}
                  {rolling && bar[rolling] !== null && <small>Avg {digits(bar[rolling])}</small>}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="chart-legend">
        <span className="chart-date">
          {snapshot.start} / {snapshot.end}
        </span>
        {series.map((entry, index) => (
          <span key={entry.id}>
            <i
              className={index ? "legend-dash" : "legend-solid"}
              style={{ color: entry.colorValue }}
            />
            {entry.name} {entry.unit && `(${entry.unit})`}
          </span>
        ))}
      </div>
      {activeDate && (
        <div className="bucket-details" aria-live="polite">
          {activeBars.map(({ entry, bar }) => (
            <span key={entry.id}>
              {entry.name} · O {digits(bar.open)} · H {digits(bar.high)} · L {digits(bar.low)} · C{" "}
              {digits(bar.close)} · Sum {digits(bar.total)} · n {bar.count}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export function Scatter({
  points,
  xSeries,
  ySeries,
}: {
  points: Pair[];
  xSeries: Series;
  ySeries: Series;
}) {
  if (!points.length) return <p className="empty-chart">No paired days in this date range.</p>;
  const xDomain = extent(points.map((point) => point.x));
  const yDomain = extent(points.map((point) => point.y));
  const x = scale(xDomain, 60, 392);
  const y = scale(yDomain, 146, 16);
  return (
    <figure className="scatter">
      <figcaption>
        {ySeries.name} {ySeries.unit && `(${ySeries.unit})`}
      </figcaption>
      <svg viewBox="0 0 412 174" aria-label="Scatter plot of paired daily means" role="img">
        {ticks(yDomain, 4).map((value) => (
          <g key={value} transform={`translate(0 ${y(value)})`}>
            <line className="grid-line" x1={60} x2={392} />
            <text className="axis-label" x={52} y={4} textAnchor="end">
              {digits(value)}
            </text>
          </g>
        ))}
        {ticks(xDomain, 4).map((value) => (
          <g key={value} transform={`translate(${x(value)} 0)`}>
            <line className="grid-line" y1={16} y2={146} />
            <text className="axis-label" y={165} textAnchor="middle">
              {digits(value)}
            </text>
          </g>
        ))}
        {points.map((point) => (
          <circle
            key={point.day}
            cx={x(point.x)}
            cy={y(point.y)}
            r={3}
            fill={seriesColor(ySeries.color)}
            fillOpacity={0.55}
          >
            <title>
              {point.day} / {point.y_day} · {digits(point.x)}, {digits(point.y)}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption>
        {xSeries.name} {xSeries.unit && `(${xSeries.unit})`}
      </figcaption>
    </figure>
  );
}
