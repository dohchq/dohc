import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AXIS_COLORS, MIN_PAIRS, type LagPoint, type Series } from "./report/model";
import {
  axisFormat,
  count,
  formatDay,
  formatR,
  formatValue,
  niceDomain,
  unitSuffix,
} from "./report/format";
import { useSize } from "./report/use-size";
import { dayT, lagText, peakLag, supported } from "./stats";
import type { Line, Pair, Point } from "./types";

function axisTitle(series: Series, day: string, width: number) {
  const suffix = `${series.unit ? ` (${series.unit})` : ""}, day ${day}`;
  const room = Math.floor(width / 6) - suffix.length;
  const name =
    series.name.length <= room
      ? series.name
      : `${series.name.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
  return (
    <>
      <title>{series.name + suffix}</title>
      {name + suffix}
    </>
  );
}

export function LagProfile({
  profile,
  lag,
  onLag,
}: {
  profile: LagPoint[];
  lag: number;
  onLag: (lag: number) => void;
}) {
  const [frame, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 64;
  const top = 18;
  const { byLag, peak, floor } = useMemo(() => {
    const floor = supported(profile);
    return {
      byLag: new Map(profile.map((point) => [point.lag, point])),
      peak: peakLag(profile, floor),
      floor,
    };
  }, [profile]);
  const slot = width / 61;
  const mid = top + height / 2;
  const at = hover ?? lag;
  const shown = byLag.get(at) ?? { lag: at, n: 0, r: null };
  const lagAt = (clientX: number, element: Element) =>
    Math.max(
      -30,
      Math.min(30, Math.floor((clientX - element.getBoundingClientRect().left) / slot) - 30),
    );
  return (
    <div className="lag-profile" ref={frame}>
      {width > 0 && (
        <svg
          width={width}
          height={top + height + 16}
          role="img"
          aria-label={
            peak?.r != null
              ? `Correlation by lag. Strongest r ${formatR(peak.r)} at ${lagText(peak.lag)}.`
              : "Correlation by lag"
          }
          onPointerMove={(event) => {
            if (event.pointerType !== "touch") setHover(lagAt(event.clientX, event.currentTarget));
          }}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => onLag(lagAt(event.clientX, event.currentTarget))}
        >
          <line className="lag-zero" x1={0} x2={width} y1={mid} y2={mid} />
          {Array.from({ length: 61 }, (_, index) => {
            const at = index - 30;
            const point = byLag.get(at);
            const r = point?.r ?? 0;
            const barHeight = Math.abs(r) * (height / 2 - 2);
            return (
              <rect
                key={at}
                className={`lag-bar${at === lag ? " lag-current" : ""}${at === peak?.lag ? " lag-peak" : ""}`}
                data-thin={(point?.n ?? 0) < floor || undefined}
                data-hover={at === hover || undefined}
                x={index * slot + 1}
                width={Math.max(1, slot - 2)}
                y={r >= 0 ? mid - barHeight : mid}
                height={Math.max(1, barHeight)}
              />
            );
          })}
          {peak?.r != null && peak.lag !== lag && (
            <circle
              className="lag-peak-mark"
              cx={(peak.lag + 30.5) * slot}
              cy={
                peak.r >= 0
                  ? mid - Math.abs(peak.r) * (height / 2 - 2) - 5
                  : mid + Math.abs(peak.r) * (height / 2 - 2) + 5
              }
              r={2.5}
            >
              <title>Strongest supported lag</title>
            </circle>
          )}
          {[-30, -15, 0, 15, 30].map((tick) => (
            <text
              key={tick}
              className="lag-tick"
              x={tick === -30 ? 0 : tick === 30 ? 61 * slot : (tick + 30.5) * slot}
              y={top + height + 12}
              textAnchor={tick === -30 ? "start" : tick === 30 ? "end" : "middle"}
            >
              {tick === 0 ? "0" : lagText(tick)}
            </text>
          ))}
          <text className="lag-readout" x={width} y={11} textAnchor="end" aria-hidden="true">
            {shown.n < MIN_PAIRS
              ? `${lagText(shown.lag)} · n ${count(shown.n)} · too few pairs`
              : shown.r === null
                ? `${lagText(shown.lag)} · n ${count(shown.n)} · one series is constant`
                : `${lagText(shown.lag)} · r ${formatR(shown.r)} · n ${count(shown.n)}${shown.n < floor ? " · below peak support" : ""}`}
          </text>
          <text className="lag-caption" x={0} y={11} aria-hidden="true">
            r by lag
          </text>
        </svg>
      )}
    </div>
  );
}

const SCATTER_HEIGHT = 252;
const SCATTER_TOP = 24;
const SCATTER_PLOT_HEIGHT = SCATTER_HEIGHT - SCATTER_TOP - 46;

export function Scatter({
  points,
  line,
  xSeries,
  ySeries,
  lag,
  total,
}: {
  points: Pair[];
  line: Line | null;
  xSeries: Series;
  ySeries: Series;
  lag: number;
  total: number;
}) {
  const clip = useId();
  const [frame, { width }] = useSize<HTMLElement>();
  const [active, setActive] = useState<string | null>(null);
  const surface = useRef<SVGSVGElement>(null);
  const engaged = active !== null;
  useEffect(() => {
    if (!engaged) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return;
      setActive(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [engaged]);
  const axis = useMemo(() => {
    const yd = niceDomain(
      points.map((point) => point.y),
      Math.max(4, Math.round(SCATTER_PLOT_HEIGHT / 40)),
    );
    const yFormat = axisFormat(yd);
    const widest = Math.max(...yd.ticks.map((tick) => yFormat.tick(tick).length));
    return { yd, yFormat, left: Math.max(56, Math.ceil(widest * 6.5 + 18)) };
  }, [points]);
  const margin = { top: SCATTER_TOP, right: 12, bottom: 46, left: axis.left };
  const plotHeight = SCATTER_PLOT_HEIGHT;
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const model = useMemo(() => {
    const { yd, left } = axis;
    const xd = niceDomain(
      points.map((point) => point.x),
      Math.max(4, Math.round(plotWidth / 90)),
    );
    const x = (value: number) =>
      left + ((value - xd.domain[0]) / (xd.domain[1] - xd.domain[0])) * plotWidth;
    const y = (value: number) =>
      SCATTER_TOP +
      SCATTER_PLOT_HEIGHT -
      ((value - yd.domain[0]) / (yd.domain[1] - yd.domain[0])) * SCATTER_PLOT_HEIGHT;
    const projected = points.map((point) => ({ day: point.day, cx: x(point.x), cy: y(point.y) }));
    const dots = projected.map((point) => (
      <circle
        key={point.day}
        className="scatter-dot"
        cx={point.cx}
        cy={point.cy}
        r={2.6}
        fill={AXIS_COLORS[1]}
      />
    ));
    return { xd, yd, xFormat: axisFormat(xd), x, y, projected, dots };
  }, [points, plotWidth, axis]);
  const { x, y, yd } = model;
  const yFormat = axis.yFormat;
  if (!points.length) return <p className="sb-empty">No paired days in this date range</p>;
  const nearest = (clientX: number, clientY: number, element: Element) => {
    const box = element.getBoundingClientRect();
    let best: string | null = null;
    let distance = 24 * 24;
    for (const point of model.projected) {
      const d = (point.cx - (clientX - box.left)) ** 2 + (point.cy - (clientY - box.top)) ** 2;
      if (d < distance) {
        distance = d;
        best = point.day;
      }
    }
    return best;
  };
  const shown = active === null ? null : (points.find((point) => point.day === active) ?? null);
  const sampled = total > points.length;
  const plotted = sampled
    ? `${count(points.length)} of ${count(total)} paired days, sampled across the range`
    : `${count(points.length)} paired days`;
  return (
    <figure className="scatter" ref={frame}>
      {width > 0 && (
        <svg
          width={width}
          height={SCATTER_HEIGHT}
          ref={surface}
          role="img"
          aria-label={`${ySeries.name} on day ${dayT(lag)} against ${xSeries.name} on day t. Scatter plot of ${plotted}. ${total < MIN_PAIRS ? "Too few pairs for r or a fit line." : line === null ? "One series is constant, so there is no r or fit line." : `r and the fit line use all ${count(total)} pairs.`}`}
          onPointerMove={(event) =>
            setActive(nearest(event.clientX, event.clientY, event.currentTarget))
          }
          onPointerDown={(event) =>
            setActive(nearest(event.clientX, event.clientY, event.currentTarget))
          }
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") setActive(null);
          }}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          {yd.ticks.map((tick) => (
            <g key={tick} transform={`translate(0 ${y(tick).toFixed(1)})`}>
              <line className="sb-grid" x1={margin.left} x2={margin.left + plotWidth} />
              <text className="sb-tick" x={margin.left - 8} y={4} textAnchor="end">
                {yFormat.tick(tick)}
              </text>
            </g>
          ))}
          {model.xd.ticks.map((tick) => (
            <g key={tick} transform={`translate(${x(tick).toFixed(1)} 0)`}>
              <line className="sb-grid sb-grid-x" y1={margin.top} y2={margin.top + plotHeight} />
              <text className="sb-tick" y={margin.top + plotHeight + 16} textAnchor="middle">
                {model.xFormat.tick(tick)}
              </text>
            </g>
          ))}
          <g clipPath={`url(#${clip})`}>
            {model.dots}
            {shown && (
              <circle
                className="scatter-dot"
                cx={x(shown.x)}
                cy={y(shown.y)}
                r={2.6}
                fill={AXIS_COLORS[1]}
                data-active
              />
            )}
            {line && (
              <line
                className="scatter-fit"
                x1={x(line[0][0])}
                x2={x(line[1][0])}
                y1={y(line[0][1])}
                y2={y(line[1][1])}
              />
            )}
          </g>
          {shown && <circle className="scatter-ring" cx={x(shown.x)} cy={y(shown.y)} r={6} />}
          <text
            className="scatter-axis"
            x={margin.left + plotWidth}
            y={SCATTER_HEIGHT - 4}
            textAnchor="end"
          >
            {axisTitle(xSeries, "t", plotWidth)}
          </text>
          <text className="scatter-axis" x={margin.left} y={12}>
            {axisTitle(ySeries, dayT(lag), width - margin.left)}
          </text>
        </svg>
      )}
      {shown && (
        <div
          className="scatter-tip"
          role="tooltip"
          style={{
            left:
              x(shown.x) + 182 > width ? Math.max(margin.left, x(shown.x) - 182) : x(shown.x) + 12,
            top:
              y(shown.y) < margin.top + plotHeight / 2
                ? y(shown.y) + 12
                : Math.max(0, y(shown.y) - 64),
          }}
        >
          <strong>{formatDay(shown.day)}</strong>
          <span>
            <i style={{ background: AXIS_COLORS[0] }} />
            {formatValue(shown.x, xSeries.unit)}
            {unitSuffix(xSeries.unit)}
          </span>
          <span>
            <i style={{ background: AXIS_COLORS[1] }} />
            {formatValue(shown.y, ySeries.unit)}
            {unitSuffix(ySeries.unit)}
            {lag !== 0 && <small> {formatDay(shown.y_day)}</small>}
          </span>
        </div>
      )}
      {sampled && <figcaption className="scatter-caption num">Showing {plotted}</figcaption>}
    </figure>
  );
}

export function Spark({ points, color, label }: { points: Point[]; color: string; label: string }) {
  const width = 76;
  const height = 22;
  if (points.length < 2)
    return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  const values = points.map((point) => point[1]);
  const oldest = Math.max(...points.map((point) => point[0])) || 1;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const xy = points.map(([ago, value]) => [
    ((oldest - ago) / oldest) * (width - 2) + 1,
    height - 2 - ((value - min) / span) * (height - 4),
  ]);
  const last = xy.at(-1)!;
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label={label}>
      <polyline
        points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="1.75" fill={color} />
    </svg>
  );
}
