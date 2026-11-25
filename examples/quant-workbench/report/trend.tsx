import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  AXIS_COLORS,
  DAY,
  bucketEnd,
  bucketStart,
  type Bar,
  type Focus,
  type Grain,
  type Overlays,
  type Series,
  type Snapshot,
} from "./model";
import {
  axisFormat,
  bucketLabel,
  formatDay,
  formatShortDay,
  formatValue,
  niceDomain,
  tickLabel,
  timeTicks,
  unitSuffix,
} from "./format";
import { useSize } from "./use-size";
import "./trend.css";

function ohlcParts(bar: Bar, unit: string, reference: number): Array<[string, string]> {
  return [
    ["Mean of", String(bar.count)],
    ["O", formatValue(bar.open, unit, reference)],
    ["H", formatValue(bar.high, unit, reference)],
    ["L", formatValue(bar.low, unit, reference)],
    ["C", formatValue(bar.close, unit, reference)],
  ];
}

function extraParts(bar: Bar, unit: string, reference: number, overlays: Overlays) {
  return (
    [
      ["Σ", bar.count > 1 && ADDITIVE.has(unit) ? formatValue(bar.total, unit, reference) : null],
      ["MA7", overlays.ma7 && bar.ma7 !== null ? formatValue(bar.ma7, unit, reference) : null],
      ["MA30", overlays.ma30 && bar.ma30 !== null ? formatValue(bar.ma30, unit, reference) : null],
    ] satisfies Array<[string, string | null]>
  ).filter((item): item is [string, string] => item[1] !== null);
}

const textWidth = (parts: Array<[string, string]>) =>
  parts.reduce((sum, [label, value]) => sum + label.length + value.length + 1, 0);
const widest = (lengths: number[]) => lengths.reduce((most, length) => Math.max(most, length), 0);
const HUD_CH = 7;
const HUD_TEXT_PX = 6.2;

const ADDITIVE = new Set(["steps", "shares", "AU", "kcal", "count", "min", "km", "mi"]);
const TAG_GAP = 22;
const TICK_GAP = 20;

function focusMark(x: number, y: number, top: number, bottom: number) {
  if (y < top) return `M${x},${top}l6,10h-12Z`;
  if (y > bottom) return `M${x},${bottom}l6,-10h-12Z`;
  return `M${x},${y - 6}l6,6l-6,6l-6,-6Z`;
}

function path(points: Array<[number, number] | null>) {
  let pen = false;
  let d = "";
  for (const point of points) {
    if (!point) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

function runs(bars: Bar[], grain: Grain) {
  const result: Bar[][] = [];
  for (const bar of bars) {
    const run = result.at(-1);
    const previous = run?.at(-1);
    if (
      run &&
      previous &&
      Date.parse(bar.bucket) <= Date.parse(bucketEnd(previous.bucket, grain)) + DAY
    )
      run.push(bar);
    else result.push([bar]);
  }
  return result;
}

type Plotted = Series & {
  bars: Bar[];
  byBucket: Map<string, Bar>;
  y: (value: number) => number;
  invert: (pixel: number) => number;
  ticks: number[];
  format: ReturnType<typeof axisFormat>;
  color: string;
};

export function Trend({
  snapshot,
  overlays,
  label,
  focus = null,
  onBrush,
  onReset,
}: {
  snapshot: Snapshot;
  overlays: Overlays;
  label: string;
  focus?: Focus | null;
  onBrush?: (start: string, end: string) => void;
  onReset?: () => void;
}) {
  const fill = useId();
  const shownFocus =
    focus && focus.day >= snapshot.start && focus.day <= snapshot.end ? focus : null;
  const [frame, { width, height }] = useSize<HTMLDivElement>();
  const [pointerAt, setHover] = useState<{ day: string; y: number | null } | null>(null);
  const pinned = useRef<{ day: string; y: number | null } | null>(null);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  const press = useRef<{ x: number; index: number; dragging: boolean } | null>(null);
  const surface = useRef<SVGSVGElement>(null);
  const tapped = pointerAt !== null && pointerAt.y === null;
  useEffect(() => {
    if (!tapped) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return;
      setHover(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [tapped]);
  const second = snapshot.series.length > 1;
  const compact = width < 660;
  const hudWidths = useMemo(() => {
    const reference = snapshot.series.map((series) =>
      widest(series.bars.map((bar) => Math.abs(bar.mean))),
    );
    const mean = widest(
      snapshot.series.flatMap((series, index) =>
        series.bars.map(
          (bar) =>
            (formatValue(bar.mean, series.unit, reference[index]) + unitSuffix(series.unit))
              .length + 1,
        ),
      ),
    );
    const ohlc = snapshot.series.map((series, index) =>
      widest(
        series.bars
          .filter((bar) => bar.count > 1)
          .map((bar) => textWidth(ohlcParts(bar, series.unit, reference[index])) + 2),
      ),
    );
    const extra = widest(
      snapshot.series.flatMap((series, index) =>
        series.bars.map((bar) =>
          textWidth(extraParts(bar, series.unit, reference[index], overlays)),
        ),
      ),
    );
    return { reference, mean: Math.max(6, mean), ohlc, widestOhlc: widest(ohlc), extra };
  }, [snapshot, overlays]);
  const multi = hudWidths.widestOhlc > 0;
  const hudStacked =
    compact ||
    (multi &&
      96 + 30 + (hudWidths.mean + hudWidths.widestOhlc + hudWidths.extra) * HUD_CH > width - 160);
  const hudSpan = compact ? width - 24 : width - 160;
  const longestName = widest(snapshot.series.map((series) => series.name.length));
  const extraBelow =
    hudStacked &&
    hudWidths.extra > 0 &&
    Math.min(0.4 * hudSpan, 14 + longestName * HUD_TEXT_PX) +
      (hudWidths.mean + hudWidths.extra) * HUD_TEXT_PX +
      16 >
      hudSpan;
  const top =
    (compact ? 36 : 26) +
    19 * snapshot.series.length +
    (hudStacked ? 17 * hudWidths.ohlc.filter((width) => width > 0).length : 0) +
    (extraBelow ? 17 * snapshot.series.length : 0);
  const plotHeight = Math.max(0, height - top - 28);
  const scales = useMemo(
    () =>
      snapshot.series.map((series) => {
        const values = series.bars.flatMap((bar) => [
          bar.mean,
          ...(overlays.ma7 && bar.ma7 !== null ? [bar.ma7] : []),
          ...(overlays.ma30 && bar.ma30 !== null ? [bar.ma30] : []),
        ]);
        const axis = niceDomain(values, Math.max(3, Math.round(plotHeight / 44)));
        const { domain, ticks } = axis;
        const format = axisFormat(axis, series.unit);
        const widest = Math.max(
          ...ticks.flatMap((tick) => [format.tick(tick).length + 1, format.tag(tick).length]),
        );
        return {
          domain,
          ticks,
          format,
          gutter: Math.max(compact ? 56 : 64, Math.ceil(widest * 6.5 + 16)),
        };
      }),
    [snapshot, overlays.ma7, overlays.ma30, plotHeight, compact],
  );
  const margin = {
    top,
    right: second ? scales[1].gutter : 20,
    bottom: 28,
    left: scales[0]?.gutter ?? 64,
  };
  const plotWidth = Math.max(0, width - margin.left - margin.right);
  const right = margin.left + plotWidth;
  const bottom = margin.top + plotHeight;

  const geometry = useMemo(() => {
    const dates = [
      ...new Set(snapshot.series.flatMap((series) => series.bars.map((bar) => bar.bucket))),
    ].sort();
    const times = dates.map((day) => Date.parse(day));
    const first = dates.length
      ? Math.min(times[0], bucketStart(snapshot.start, snapshot.grain))
      : 0;
    const last = dates.length
      ? Math.max(times.at(-1)!, bucketStart(snapshot.end, snapshot.grain))
      : 0;
    const x = (ms: number) =>
      first === last
        ? margin.left + plotWidth / 2
        : margin.left + ((ms - first) / (last - first)) * plotWidth;
    const xs = times.map(x);
    const plotted: Plotted[] = snapshot.series.map((series, index) => {
      const { domain, ticks, format } = scales[index];
      const y = (value: number) =>
        bottom - ((value - domain[0]) / (domain[1] - domain[0] || 1)) * plotHeight;
      const invert = (pixel: number) =>
        domain[0] + ((bottom - pixel) / (plotHeight || 1)) * (domain[1] - domain[0]);
      return {
        ...series,
        byBucket: new Map(series.bars.map((bar) => [bar.bucket, bar])),
        y,
        invert,
        ticks,
        format,
        color: AXIS_COLORS[index],
      };
    });
    const lines = plotted.map((series) => {
      const segments = runs(series.bars, snapshot.grain);
      const at = (get: (bar: Bar) => number | null) =>
        segments
          .map((run) =>
            path(
              run.map((bar) => {
                const value = get(bar);
                return value === null ? null : [x(Date.parse(bar.bucket)), series.y(value)];
              }),
            ),
          )
          .join("");
      const points = segments.map((run) =>
        run.map((bar): [number, number] => [x(Date.parse(bar.bucket)), series.y(bar.mean)]),
      );
      return {
        points,
        mean: points
          .filter((run) => run.length > 1)
          .map((run) => path(run))
          .join(""),
        dots: points.filter((run) => run.length === 1).map((run) => run[0]),
        ma7: overlays.ma7 ? at((bar) => bar.ma7) : "",
        ma30: overlays.ma30 ? at((bar) => bar.ma30) : "",
      };
    });
    const area = (lines[0]?.points ?? [])
      .filter((run) => run.length > 1)
      .map(
        (run) =>
          `${path(run)}L${run.at(-1)![0].toFixed(1)},${bottom}L${run[0][0].toFixed(1)},${bottom}Z`,
      )
      .join("");
    const time = timeTicks(first, last, Math.max(3, Math.floor(plotWidth / 96)));
    return { dates, xs, x, plotted, lines, area, time };
  }, [snapshot, scales, overlays.ma7, overlays.ma30, plotWidth, plotHeight, margin.left, bottom]);

  const { dates, xs, plotted, lines } = geometry;
  const lastIndex = dates.length - 1;
  const hoverIndex = pointerAt ? dates.indexOf(pointerAt.day) : -1;
  const hover = pointerAt && hoverIndex >= 0 ? { index: hoverIndex, y: pointerAt.y } : null;
  const at = (index: number, y: number | null) => ({ day: dates[index], y });
  const focusIndex = useMemo(() => {
    if (!shownFocus) return null;
    const index = dates.findIndex(
      (day) => day <= shownFocus.day && shownFocus.day <= bucketEnd(day, snapshot.grain),
    );
    return index < 0 ? null : index;
  }, [shownFocus, dates, snapshot.grain]);
  const activeIndex = hover?.index ?? focusIndex;
  const hudIndex = activeIndex ?? lastIndex;
  const hudDay = dates[hudIndex];

  if (!dates.length)
    return (
      <div className="sb-trend" ref={frame}>
        <p className="sb-empty" role="status">
          No observations in this date range
        </p>
      </div>
    );

  const indexAt = (clientX: number, element: Element) => {
    const position = clientX - element.getBoundingClientRect().left;
    let low = 0;
    let high = xs.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (xs[mid] < position) low = mid;
      else high = mid;
    }
    return Math.abs(xs[low] - position) <= Math.abs(xs[high] - position) ? low : high;
  };
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const index = indexAt(event.clientX, event.currentTarget);
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    return { index, y: y >= margin.top && y <= bottom ? y : null };
  };
  const describe = (index: number) =>
    [
      bucketLabel(dates[index], snapshot.grain),
      ...plotted.flatMap((series, at) => {
        const bar = series.byBucket.get(dates[index]);
        if (!bar) return [];
        const value = (number: number) =>
          formatValue(number, series.unit, hudWidths.reference[at]) + unitSuffix(series.unit);
        return [
          [
            `${series.name} ${value(bar.mean)}`,
            ...(bar.count > 1
              ? [
                  `${bar.count} readings`,
                  `open ${value(bar.open)}`,
                  `high ${value(bar.high)}`,
                  `low ${value(bar.low)}`,
                  `close ${value(bar.close)}`,
                  ...(ADDITIVE.has(series.unit) ? [`sum ${value(bar.total)}`] : []),
                ]
              : []),
            ...(overlays.ma7 && bar.ma7 !== null ? [`7-day average ${value(bar.ma7)}`] : []),
            ...(overlays.ma30 && bar.ma30 !== null ? [`30-day average ${value(bar.ma30)}`] : []),
          ].join(", "),
        ];
      }),
    ].join("; ");
  const move = (index: number) => {
    const next = Math.max(0, Math.min(lastIndex, index));
    setHover(at(next, null));
    setAnnounce(describe(next));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = activeIndex ?? lastIndex;
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") move(current - step);
    else if (event.key === "ArrowRight") move(current + step);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(lastIndex);
    else if (event.key === "Escape" && (hover || brush)) {
      press.current = null;
      setBrush(null);
      setHover(null);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const activeX = activeIndex === null ? null : xs[activeIndex];
  const brushDays = (from: number, to: number) =>
    [
      dates[from] < snapshot.start ? snapshot.start : dates[from],
      [bucketEnd(dates[to], snapshot.grain), snapshot.end].sort()[0],
    ] as const;
  const brushRange = brush &&
    Math.max(brush.start, brush.end) <= lastIndex && {
      from: Math.min(brush.start, brush.end),
      to: Math.max(brush.start, brush.end),
    };
  const cursorTags = plotted.map((series) => {
    if (hover?.y != null) return { y: hover.y, value: series.invert(hover.y) };
    const bar = activeIndex === null ? undefined : series.byBucket.get(dates[activeIndex]);
    return bar ? { y: series.y(bar.mean), value: bar.mean } : null;
  });
  const latestTags = plotted.map((series, index) => {
    const bar = series.bars.at(-1);
    const y = bar ? series.y(bar.mean) : null;
    const cursor = cursorTags[index];
    return bar && y !== null && (!cursor || Math.abs(cursor.y - y) > TAG_GAP)
      ? { y, value: bar.mean }
      : null;
  });
  const clear = (index: number, y: number) =>
    [latestTags[index], cursorTags[index]].every((tag) => !tag || Math.abs(tag.y - y) > TICK_GAP);
  const tickText = (index: number, tick: number) => {
    const series = plotted[index];
    const text = series.format.tick(tick);
    const labelled = text + unitSuffix(series.unit);
    const highest = series.ticks.findLast((value) => clear(index, series.y(value)));
    return tick === highest && labelled.length <= Math.max(text.length, compact ? 8 : 9)
      ? labelled
      : text;
  };
  const dateTagX = activeX === null ? null : Math.max(52, Math.min(width - 52, activeX));
  const focusSeries = shownFocus
    ? plotted.find((series) => series.id === shownFocus.seriesId)
    : undefined;
  const valueLabel = (
    series: Plotted,
    value: number,
    y: number,
    side: "left" | "right",
    key: string,
    solid = false,
  ) => (
    <g
      key={key}
      className={`sb-axis-tag${solid ? " sb-axis-tag-solid" : ""}`}
      transform={`translate(${side === "left" ? margin.left - 2 : right + 2} ${y})`}
      style={{ color: series.color }}
    >
      <rect
        x={side === "left" ? 4 - margin.left : 0}
        y={-9}
        width={(side === "left" ? margin.left : margin.right) - 4}
        height={18}
        rx={3}
      />
      <text x={side === "left" ? -6 : 6} y={4} textAnchor={side === "left" ? "end" : "start"}>
        {series.format.tag(value)}
      </text>
    </g>
  );

  return (
    <div className="sb-trend" ref={frame}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          ref={surface}
          className="sb-trend-svg"
          role="group"
          aria-label={label}
          aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover((current) => (current?.y === null ? null : current))}
          onPointerMove={(event) => {
            const touch = event.pointerType === "touch";
            const held = press.current;
            if (held && !held.dragging && (touch || onBrush))
              held.dragging = Math.abs(event.clientX - held.x) >= (touch ? 8 : 3);
            if (touch && !held?.dragging) return;
            const next = pointer(event);
            setHover(at(next.index, touch ? null : next.y));
            if (held?.dragging && !touch) setBrush({ start: held.index, end: next.index });
          }}
          onPointerLeave={(event) => {
            if (press.current === null && event.pointerType !== "touch") setHover(null);
          }}
          onPointerDown={(event) => {
            const next = pointer(event);
            pinned.current = pointerAt;
            if (event.pointerType !== "touch") setHover(at(next.index, next.y));
            if (event.button !== 0) return;
            if (event.pointerType !== "touch")
              event.currentTarget.setPointerCapture(event.pointerId);
            press.current = { x: event.clientX, index: next.index, dragging: false };
          }}
          onPointerUp={(event) => {
            const held = press.current;
            press.current = null;
            setBrush(null);
            if (!held) return;
            const end = pointer(event).index;
            if (event.pointerType === "touch") {
              if (!held.dragging)
                setHover(pinned.current?.day === dates[held.index] ? null : at(held.index, null));
            } else if (held.dragging && held.index !== end && onBrush)
              onBrush(...brushDays(Math.min(held.index, end), Math.max(held.index, end)));
          }}
          onPointerCancel={() => {
            press.current = null;
            setBrush(null);
            setHover(pinned.current);
          }}
          onDoubleClick={() => onReset?.()}
        >
          <defs>
            <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={AXIS_COLORS[0]} stopOpacity="0.16" />
              <stop offset="100%" stopColor={AXIS_COLORS[0]} stopOpacity="0" />
            </linearGradient>
          </defs>
          {plotted[0].ticks.map((tick) => (
            <g key={tick} transform={`translate(0 ${plotted[0].y(tick).toFixed(1)})`}>
              <line className="sb-grid" x1={margin.left} x2={right} />
              {clear(0, plotted[0].y(tick)) && (
                <text className="sb-tick" x={margin.left - 8} y={4} textAnchor="end">
                  {tickText(0, tick)}
                </text>
              )}
            </g>
          ))}
          {plotted[1]?.ticks.map((tick) =>
            clear(1, plotted[1].y(tick)) ? (
              <text key={tick} className="sb-tick" x={right + 8} y={plotted[1].y(tick) + 4}>
                {tickText(1, tick)}
              </text>
            ) : null,
          )}
          {geometry.time.ticks.map((tick) => (
            <g key={tick} transform={`translate(${geometry.x(tick).toFixed(1)} 0)`}>
              <line className="sb-grid sb-grid-x" y1={margin.top} y2={bottom} />
              {(dateTagX === null || Math.abs(geometry.x(tick) - dateTagX) > 76) && (
                <text className="sb-tick" y={bottom + 18} textAnchor="middle">
                  {tickLabel(tick, geometry.time.months)}
                </text>
              )}
            </g>
          ))}
          <line className="sb-baseline" x1={margin.left} x2={right} y1={bottom} y2={bottom} />
          {focusIndex !== null && (
            <rect
              className="sb-focus-band"
              x={xs[focusIndex] - Math.max(3, plotWidth / dates.length / 2)}
              width={Math.max(6, plotWidth / dates.length)}
              y={margin.top}
              height={plotHeight}
            />
          )}
          {geometry.area && <path d={geometry.area} fill={`url(#${fill})`} />}
          {plotted.map((series, index) => (
            <g key={series.id} fill="none" stroke={series.color}>
              {lines[index].ma30 && <path d={lines[index].ma30} className="sb-ma sb-ma30" />}
              {lines[index].ma7 && <path d={lines[index].ma7} className="sb-ma sb-ma7" />}
              <path d={lines[index].mean} className="sb-line" />
              {lines[index].dots.map(([cx, cy]) => (
                <circle key={cx} cx={cx} cy={cy} r={2.5} fill={series.color} stroke="none" />
              ))}
            </g>
          ))}
          {plotted.map((series, index) => {
            const tag = latestTags[index];
            return tag
              ? valueLabel(series, tag.value, tag.y, index ? "right" : "left", "last" + index, true)
              : null;
          })}
          {brushRange && (
            <g className="sb-brush">
              <rect
                x={xs[brushRange.from]}
                width={Math.max(1, xs[brushRange.to] - xs[brushRange.from])}
                y={margin.top}
                height={plotHeight}
              />
              <line x1={xs[brushRange.from]} x2={xs[brushRange.from]} y1={margin.top} y2={bottom} />
              <line x1={xs[brushRange.to]} x2={xs[brushRange.to]} y1={margin.top} y2={bottom} />
            </g>
          )}
          {activeX !== null && (
            <g className="sb-crosshair">
              <line x1={activeX} x2={activeX} y1={margin.top} y2={bottom} />
              {hover?.y != null && <line x1={margin.left} x2={right} y1={hover.y} y2={hover.y} />}
            </g>
          )}
          {activeX !== null &&
            plotted.map((series) => {
              const bar = series.byBucket.get(dates[activeIndex!]);
              return bar ? (
                <circle
                  key={series.id}
                  className="sb-marker"
                  cx={activeX}
                  cy={series.y(bar.mean)}
                  r={4}
                  fill={series.color}
                />
              ) : null;
            })}
          {focusSeries && focusIndex !== null && (
            <path
              className="sb-sample"
              d={focusMark(xs[focusIndex], focusSeries.y(shownFocus!.value), margin.top, bottom)}
              fill={focusSeries.color}
            />
          )}
          {plotted.map((series, index) => {
            const tag = cursorTags[index];
            return tag
              ? valueLabel(series, tag.value, tag.y, index ? "right" : "left", "cursor" + index)
              : null;
          })}
          {dateTagX !== null && (
            <g className="sb-date-tag" transform={`translate(${dateTagX} ${bottom + 1})`}>
              <rect x={-52} width={104} height={20} rx={3} />
              <text y={14} textAnchor="middle">
                {snapshot.grain === "day"
                  ? formatDay(dates[activeIndex!])
                  : bucketLabel(dates[activeIndex!], snapshot.grain).replace("Week of ", "Wk ")}
              </text>
            </g>
          )}
          {brushRange && brushRange.to > brushRange.from && (
            <text
              className="sb-brush-label"
              x={Math.max(
                margin.left + 56,
                Math.min(right - 56, (xs[brushRange.from] + xs[brushRange.to]) / 2),
              )}
              y={margin.top + 16}
              textAnchor="middle"
            >
              {brushDays(brushRange.from, brushRange.to).map(formatShortDay).join(" to ")}
            </text>
          )}
        </svg>
      )}
      {hudDay && (
        <div
          className={
            hudStacked ? `sb-hud sb-hud-compact${extraBelow ? " sb-hud-split" : ""}` : "sb-hud"
          }
          data-testid="chart-hud"
          data-live={activeIndex === null ? "latest" : "cursor"}
          style={{
            left: compact ? 12 : margin.left,
            right: compact ? 12 : margin.right,
            gridTemplateColumns: hudStacked
              ? `fit-content(40%) ${hudWidths.mean}ch minmax(0, 1fr)`
              : `minmax(96px, 170px) ${hudWidths.mean}ch ${hudWidths.widestOhlc}ch minmax(0, 1fr)`,
          }}
        >
          <div className="sb-hud-date">
            <span>{bucketLabel(hudDay, snapshot.grain)}</span>
            {activeIndex === null && <span className="sb-hud-latest">Latest</span>}
            {focusSeries && focusIndex === hudIndex && (
              <span className="sb-hud-sample" style={{ color: focusSeries.color }}>
                {shownFocus!.at} UTC reading{" "}
                {formatValue(
                  shownFocus!.value,
                  focusSeries.unit,
                  hudWidths.reference[plotted.indexOf(focusSeries)],
                )}
                {unitSuffix(focusSeries.unit)}
              </span>
            )}
          </div>
          {plotted.map((series, index) => {
            const bar = series.byBucket.get(hudDay);
            const extras = bar
              ? extraParts(bar, series.unit, hudWidths.reference[index], overlays)
              : [];
            const line =
              2 +
              index +
              (hudStacked
                ? hudWidths.ohlc.slice(0, index).filter((width) => width > 0).length
                : 0) +
              (extraBelow ? index : 0);
            return (
              <div
                className="sb-hud-row"
                key={series.id}
                style={{ "--row": line } as CSSProperties}
              >
                <span className="sb-hud-name">
                  <i style={{ background: series.color }} />
                  <span>{series.name}</span>
                </span>
                <span className="sb-hud-mean" style={{ color: series.color }}>
                  {bar ? (
                    <>
                      {formatValue(bar.mean, series.unit, hudWidths.reference[index])}
                      <small>{unitSuffix(series.unit)}</small>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">–</span>
                      <span className="sb-sr">No observations</span>
                    </>
                  )}
                </span>
                <span className="sb-hud-ohlc">
                  {bar && bar.count > 1
                    ? ohlcParts(bar, series.unit, hudWidths.reference[index]).map(
                        ([label, value], part) => (
                          <span key={label}>
                            {part === 1 && <b aria-hidden="true">·</b>}
                            <b>{label}</b>
                            {value}
                          </span>
                        ),
                      )
                    : hudWidths.ohlc[index] > 0
                      ? "\u00a0"
                      : null}
                </span>
                <span className="sb-hud-extra">
                  {extras.length
                    ? extras.map(([name, value], part) => (
                        <span key={name}>
                          {part > 0 && " "}
                          <b>{name}</b>
                          {value}
                        </span>
                      ))
                    : extraBelow
                      ? "\u00a0"
                      : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="sb-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
