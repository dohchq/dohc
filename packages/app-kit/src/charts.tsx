import "./tokens.css";
import { useEffect, useId, useState, type KeyboardEvent } from "react";

const SERIES_COLORS = [
  "var(--kit-chart-1)",
  "var(--kit-chart-2)",
  "var(--kit-chart-3)",
  "var(--kit-chart-4)",
  "var(--kit-chart-5)",
  "var(--kit-chart-6)",
];

const colorAt = (index: number, explicit?: string) =>
  explicit ?? SERIES_COLORS[index % SERIES_COLORS.length]!;

const finiteOrNull = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function smoothCurvePath(points: ReadonlyArray<{ x: number; y: number }>): string {
  const n = points.length;
  if (n < 3) return points.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x},${pt.y}`).join(" ");
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const step = points[i + 1]!.x - points[i]!.x;
    dx.push(step);
    const slope = step > 1e-6 ? (points[i + 1]!.y - points[i]!.y) / step : 0;
    m.push(Number.isFinite(slope) ? slope : 0);
  }
  const t = new Array<number>(n).fill(0);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1]! * m[i]! > 0) {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      const denom = w1 / m[i - 1]! + w2 / m[i]!;
      t[i] = denom !== 0 && Number.isFinite(denom) ? (w1 + w2) / denom : 0;
    }
  }
  let d = `M ${points[0]!.x},${points[0]!.y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [p0, p1, step] = [points[i]!, points[i + 1]!, dx[i]!];
    d +=
      step <= 1e-6
        ? ` L ${p1.x},${p1.y}`
        : ` C ${p0.x + step / 3},${p0.y + (t[i]! * step) / 3} ${p1.x - step / 3},${p1.y - (t[i + 1]! * step) / 3} ${p1.x},${p1.y}`;
  }
  return d;
}

function useContainerWidth(fallback = 560) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    if (!node) return;
    const updateWidth = (raw: number) => {
      const next = Math.round(raw);
      if (next > 0) setWidth(next);
    };
    updateWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entryWidth = entries[0]?.contentRect.width ?? 0;
      updateWidth(entryWidth > 0 ? entryWidth : node.getBoundingClientRect().width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref: setNode, width };
}

function scaleRatio(value: number, min: number, max: number): number {
  const span = max - min;
  if (Number.isFinite(span)) {
    return span === 0 ? 0 : (value - min) / span;
  }
  const halfSpan = max / 2 - min / 2;
  return halfSpan === 0 ? 0 : (value / 2 - min / 2) / halfSpan;
}

function niceScale(minValue: number, maxValue: number, ticks = 4) {
  const safeTicks = Math.max(1, Math.floor(ticks));
  const finiteMin = Number.isFinite(minValue) ? minValue : 0;
  const finiteMax = Number.isFinite(maxValue) ? maxValue : 1;
  const low = Math.min(0, finiteMin);
  const high = finiteMax <= low ? (Number.isFinite(low + 1) ? low + 1 : 0) : Math.max(0, finiteMax);
  const rawStep = high / safeTicks - low / safeTicks;
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return { min: low, max: high, values: low === high ? [low] : [low, high] };
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
    const fallbackValues: number[] = [];
    for (let index = 0; index <= safeTicks; index += 1) {
      const ratio = index / safeTicks;
      const value = low * (1 - ratio) + high * ratio;
      fallbackValues.push(Number.isFinite(value) ? value : index === 0 ? low : high);
    }
    return { min: low, max: high, values: fallbackValues };
  }
  const count = Math.min(Math.round((max - min) / step), safeTicks * 3 + 2);
  const values: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    const current = min + index * step;
    if (!Number.isFinite(current)) break;
    values.push(Math.abs(current) < step * 1e-9 ? 0 : Number(current.toPrecision(12)));
  }
  return { min, max, values: values.length > 0 ? values : [min, max] };
}

function stepIndex(
  event: KeyboardEvent<HTMLDivElement>,
  count: number,
  current: number | null,
  setIndex: (index: number) => void,
) {
  if (count <= 0) return;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    setIndex(current === null ? 0 : (current + 1) % count);
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    setIndex(current === null ? count - 1 : (current - 1 + count) % count);
  } else if (event.key === "Home") {
    event.preventDefault();
    setIndex(0);
  } else if (event.key === "End") {
    event.preventDefault();
    setIndex(count - 1);
  }
}

function tooltipLeft(anchorX: number, containerWidth: number): number {
  const estimated = Math.min(200, Math.max(120, containerWidth - 16));
  return Math.max(8, Math.min(anchorX - estimated / 2, containerWidth - estimated - 8));
}

export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
  readonly color?: string;
}

export interface ChartPoint {
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}

export interface LineChartProps {
  readonly labels?: readonly string[];
  readonly series?: readonly ChartSeries[];
  readonly data?: readonly ChartPoint[];
  readonly variant?: "line" | "area";
  readonly curve?: "linear" | "smooth";
  readonly height?: number;
  readonly goal?: { readonly value: number; readonly label?: string };
  readonly formatValue?: (value: number) => string;
  readonly ariaLabel?: string;
  readonly markerIndex?: number;
}

export function LineChart({
  labels: rawLabels,
  series: rawSeries,
  data,
  variant = "line",
  curve = "linear",
  height = 240,
  goal,
  formatValue = (value) => value.toLocaleString(),
  ariaLabel = "Trend chart",
  markerIndex,
}: LineChartProps) {
  const chartId = useId();
  const { ref, width } = useContainerWidth(560);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const labels = rawLabels ?? data?.map((item) => item.label) ?? [];
  const series: readonly ChartSeries[] =
    rawSeries ?? (data ? [{ name: "Value", values: data.map((item) => item.value) }] : []);
  const selected =
    activeIndex !== null && activeIndex >= 0 && activeIndex < labels.length ? activeIndex : null;
  const marker =
    markerIndex !== undefined &&
    Number.isInteger(markerIndex) &&
    markerIndex >= 0 &&
    markerIndex < labels.length
      ? markerIndex
      : null;

  const validGoal = goal && Number.isFinite(goal.value) ? goal : undefined;
  const finiteValues = [
    ...series.flatMap((entry) =>
      labels
        .map((_, index) => finiteOrNull(entry.values[index]))
        .filter((v): v is number => v !== null),
    ),
    ...(validGoal ? [validGoal.value] : []),
  ];

  if (labels.length === 0 || series.length === 0 || finiteValues.length === 0) {
    return (
      <div className="kit-chart-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  const scale = niceScale(Math.min(...finiteValues, 0), Math.max(...finiteValues, 0), 4);
  const pad = { top: 14, right: 16, bottom: 28, left: 54 };
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const xOf = (index: number) =>
    labels.length === 1 ? pad.left + plotW / 2 : pad.left + (index / (labels.length - 1)) * plotW;
  const yOf = (value: number) => pad.top + plotH - scaleRatio(value, scale.min, scale.max) * plotH;
  const baselineY = yOf(Math.max(scale.min, Math.min(scale.max, 0)));

  const maxLabels = Math.max(2, Math.floor(plotW / 52));
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  const lastRegularLabel = Math.floor((labels.length - 1) / labelStep) * labelStep;
  const areaTopOpacity = series.length > 1 ? 0.09 : 0.18;

  const readout =
    !keyboardFocused || selected === null
      ? ""
      : `${labels[selected]}: ${series
          .map((entry) => {
            const val = finiteOrNull(entry.values[selected]);
            return `${entry.name} ${val === null ? "no data" : formatValue(val)}`;
          })
          .join(", ")}`;

  return (
    <div
      ref={ref}
      className="kit-chart"
      role="group"
      aria-label={marker === null ? ariaLabel : `${ariaLabel}, marked ${labels[marker]}`}
      tabIndex={0}
      onFocus={() => {
        setKeyboardFocused(true);
        setActiveIndex((current) =>
          current !== null && current >= 0 && current < labels.length ? current : 0,
        );
      }}
      onBlur={() => {
        setKeyboardFocused(false);
        setActiveIndex(null);
      }}
      onKeyDown={(event) => {
        setKeyboardFocused(true);
        stepIndex(event, labels.length, selected, setActiveIndex);
      }}
    >
      <span className="kit-sr-only" aria-live="polite">
        {readout}
      </span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        onMouseLeave={() => setActiveIndex(null)}
      >
        {variant === "area" ? (
          <defs>
            {series.map((entry, seriesIndex) => {
              const stroke = colorAt(seriesIndex, entry.color);
              const zeroPct = Math.max(0, Math.min(100, ((baselineY - pad.top) / plotH) * 100));
              return (
                <linearGradient
                  key={`grad-${seriesIndex}`}
                  id={`${chartId}-area-${seriesIndex}`}
                  gradientUnits="userSpaceOnUse"
                  x1={0}
                  y1={pad.top}
                  x2={0}
                  y2={pad.top + plotH}
                >
                  {zeroPct > 0 ? (
                    <stop offset="0%" stopColor={stroke} stopOpacity={areaTopOpacity} />
                  ) : null}
                  <stop offset={`${zeroPct}%`} stopColor={stroke} stopOpacity={0} />
                  {zeroPct < 100 ? (
                    <stop offset="100%" stopColor={stroke} stopOpacity={areaTopOpacity} />
                  ) : null}
                </linearGradient>
              );
            })}
          </defs>
        ) : null}

        {scale.values.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line
                x1={pad.left}
                y1={y}
                x2={pad.left + plotW}
                y2={y}
                className={tick === 0 ? "kit-chart-zero" : "kit-chart-grid"}
              />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" className="kit-chart-axis">
                {formatValue(tick)}
              </text>
            </g>
          );
        })}

        {validGoal ? (
          <g>
            <line
              x1={pad.left}
              y1={yOf(validGoal.value)}
              x2={pad.left + plotW}
              y2={yOf(validGoal.value)}
              stroke="var(--kit-warning)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
            {validGoal.label ? (
              <text
                x={pad.left + plotW}
                y={yOf(validGoal.value) - 6}
                textAnchor="end"
                className="kit-chart-axis"
              >
                {validGoal.label}
              </text>
            ) : null}
          </g>
        ) : null}

        {marker !== null ? (
          <line
            className="kit-chart-marker"
            x1={xOf(marker)}
            y1={pad.top}
            x2={xOf(marker)}
            y2={pad.top + plotH}
            stroke="var(--kit-ink)"
            strokeOpacity={0.4}
            strokeWidth={1.5}
          />
        ) : null}

        {series.map((entry, seriesIndex) => {
          const stroke = colorAt(seriesIndex, entry.color);
          const segments: Array<Array<{ index: number; value: number }>> = [];
          let current: Array<{ index: number; value: number }> = [];
          for (let index = 0; index < labels.length; index += 1) {
            const val = finiteOrNull(entry.values[index]);
            if (val === null) {
              if (current.length > 0) {
                segments.push(current);
                current = [];
              }
            } else {
              current.push({ index, value: val });
            }
          }
          if (current.length > 0) segments.push(current);

          return (
            <g key={`${seriesIndex}-${entry.name}`}>
              {segments.map((segment, segIndex) => {
                const pts = segment.map((pt) => ({ x: xOf(pt.index), y: yOf(pt.value) }));
                const linePath =
                  curve === "smooth"
                    ? smoothCurvePath(pts)
                    : `M ${pts.map((pt) => `${pt.x},${pt.y}`).join(" L ")}`;
                const areaPath = `${linePath} L ${pts[pts.length - 1]!.x},${baselineY} L ${pts[0]!.x},${baselineY} Z`;
                return (
                  <g key={`${seriesIndex}-seg-${segIndex}`}>
                    {variant === "area" && segment.length > 1 ? (
                      <path d={areaPath} fill={`url(#${chartId}-area-${seriesIndex})`} />
                    ) : null}
                    {segment.length > 1 ? (
                      <path
                        d={linePath}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ) : null}
                  </g>
                );
              })}
              {labels.map((_, index) => {
                const value = finiteOrNull(entry.values[index]);
                if (value === null) return null;
                const emphasized = selected === index || marker === index;
                return (
                  <circle
                    key={`${seriesIndex}-pt-${index}`}
                    cx={xOf(index)}
                    cy={yOf(value)}
                    r={emphasized ? 4.5 : 2.5}
                    fill={stroke}
                    stroke={emphasized ? "var(--kit-panel)" : undefined}
                    strokeWidth={emphasized ? 1.75 : undefined}
                  />
                );
              })}
            </g>
          );
        })}

        {selected !== null ? (
          <line
            x1={xOf(selected)}
            y1={pad.top}
            x2={xOf(selected)}
            y2={pad.top + plotH}
            stroke="var(--kit-subtle)"
            strokeDasharray="2 3"
          />
        ) : null}

        {labels.map((label, index) => {
          const x = xOf(index);
          const sliceW = labels.length === 1 ? plotW : plotW / (labels.length - 1);
          const showLabel =
            index % labelStep === 0 ||
            (index === labels.length - 1 && index - lastRegularLabel >= Math.ceil(labelStep * 0.6));
          return (
            <g key={`${label}-${index}`}>
              {showLabel ? (
                <text x={x} y={height - 6} textAnchor="middle" className="kit-chart-axis">
                  {label}
                </text>
              ) : null}
              <rect
                x={Math.max(pad.left, x - sliceW / 2)}
                y={pad.top}
                width={Math.min(sliceW, plotW)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => {
                  setKeyboardFocused(false);
                  setActiveIndex(index);
                }}
              />
            </g>
          );
        })}
      </svg>

      {selected !== null ? (
        <div
          className="kit-chart-tooltip"
          style={{ left: tooltipLeft(xOf(selected), width), top: 8 }}
        >
          <strong>{labels[selected]}</strong>
          {series.map((entry, seriesIndex) => {
            const val = finiteOrNull(entry.values[selected]);
            return (
              <div key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
                <span
                  className="kit-chart-swatch"
                  style={{ background: colorAt(seriesIndex, entry.color) }}
                />
                <span>
                  {series.length > 1 ? `${entry.name}: ` : ""}
                  {val === null ? "—" : formatValue(val)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {series.length > 1 ? (
        <div className="kit-chart-legend">
          {series.map((entry, seriesIndex) => (
            <span key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
              <span
                className="kit-chart-swatch"
                style={{ background: colorAt(seriesIndex, entry.color) }}
              />
              <span>{entry.name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface BarChartProps {
  readonly labels?: readonly string[];
  readonly series?: readonly ChartSeries[];
  readonly data?: readonly ChartPoint[];
  readonly orientation?: "vertical" | "horizontal";
  readonly stacked?: boolean;
  readonly height?: number;
  readonly formatValue?: (value: number) => string;
  readonly ariaLabel?: string;
}

export function BarChart({
  labels: rawLabels,
  series: rawSeries,
  data,
  orientation = "vertical",
  stacked = false,
  height = 240,
  formatValue = (value) => value.toLocaleString(),
  ariaLabel = "Bar chart",
}: BarChartProps) {
  const { ref, width } = useContainerWidth(560);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const labels = rawLabels ?? data?.map((item) => item.label) ?? [];
  const series: readonly ChartSeries[] =
    rawSeries ?? (data ? [{ name: "Value", values: data.map((item) => item.value) }] : []);
  const selected =
    activeIndex !== null && activeIndex >= 0 && activeIndex < labels.length ? activeIndex : null;

  const rawValues = series.map((entry) =>
    labels.map((_, index) => finiteOrNull(entry.values[index])),
  );
  const cleanValues = rawValues.map((row) => row.map((value) => value ?? 0));
  const hasAnyFinite = rawValues.some((row) => row.some((value) => value !== null));

  if (labels.length === 0 || series.length === 0 || !hasAnyFinite) {
    return (
      <div className="kit-chart-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  let domainMin = 0;
  let domainMax = 0;
  if (stacked) {
    for (let index = 0; index < labels.length; index += 1) {
      let pos = 0;
      let neg = 0;
      for (let s = 0; s < series.length; s += 1) {
        const val = cleanValues[s]![index]!;
        if (val >= 0) pos += val;
        else neg += val;
      }
      if (pos > domainMax) domainMax = pos;
      if (neg < domainMin) domainMin = neg;
    }
  } else {
    for (const row of cleanValues) {
      for (const val of row) {
        if (val > domainMax) domainMax = val;
        if (val < domainMin) domainMin = val;
      }
    }
  }
  const scale = niceScale(domainMin, domainMax, 4);

  const readout =
    !keyboardFocused || selected === null
      ? ""
      : `${labels[selected]}: ${series
          .map((entry, s) => {
            const val = rawValues[s]![selected]!;
            return `${entry.name} ${val === null ? "no data" : formatValue(val)}`;
          })
          .join(", ")}`;

  if (orientation === "horizontal") {
    const barsPerRow = stacked ? 1 : series.length;
    const barH = stacked ? 16 : Math.max(10, Math.min(14, Math.floor(28 / barsPerRow)));
    const rowHeight = Math.max(32, barsPerRow * (barH + 3) + 12);
    const svgHeight = Math.max(height, labels.length * rowHeight + 28);
    const pad = { top: 8, right: 68, bottom: 20, left: 108 };
    const plotW = Math.max(100, width - pad.left - pad.right);
    const xOf = (value: number) => pad.left + scaleRatio(value, scale.min, scale.max) * plotW;
    const zeroX = xOf(0);

    return (
      <div
        ref={ref}
        className="kit-chart"
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        onFocus={() => {
          setKeyboardFocused(true);
          setActiveIndex((current) =>
            current !== null && current >= 0 && current < labels.length ? current : 0,
          );
        }}
        onBlur={() => {
          setKeyboardFocused(false);
          setActiveIndex(null);
        }}
        onKeyDown={(event) => {
          setKeyboardFocused(true);
          stepIndex(event, labels.length, selected, setActiveIndex);
        }}
      >
        <span className="kit-sr-only" aria-live="polite">
          {readout}
        </span>
        <svg
          width={width}
          height={svgHeight}
          viewBox={`0 0 ${width} ${svgHeight}`}
          aria-hidden="true"
          onMouseLeave={() => setActiveIndex(null)}
        >
          <line
            x1={zeroX}
            y1={pad.top}
            x2={zeroX}
            y2={svgHeight - pad.bottom}
            className="kit-chart-zero"
          />
          {labels.map((label, index) => {
            const rowTop = pad.top + index * rowHeight;
            let posCursor = 0;
            let negCursor = 0;
            const hasRowFinite = rawValues.some((row) => row[index] !== null);
            const total = cleanValues.reduce((sum, row) => sum + row[index]!, 0);
            const maxBarRight = stacked
              ? xOf(cleanValues.reduce((sum, row) => sum + Math.max(0, row[index]!), 0))
              : xOf(Math.max(0, ...cleanValues.map((row) => row[index]!)));
            const labelX = Math.min(maxBarRight + 6, width - 4);
            const labelAnchor = maxBarRight + 6 > width - 48 ? "end" : "start";

            return (
              <g
                key={`${label}-${index}`}
                onMouseEnter={() => {
                  setKeyboardFocused(false);
                  setActiveIndex(index);
                }}
              >
                {selected === index ? (
                  <path
                    className="kit-chart-hover-band"
                    d={`M ${pad.left},${rowTop} H ${pad.left + plotW} V ${rowTop + rowHeight} H ${pad.left} Z`}
                  />
                ) : null}
                <text
                  x={pad.left - 8}
                  y={rowTop + rowHeight / 2 + 4}
                  textAnchor="end"
                  className="kit-chart-axis"
                >
                  {label}
                </text>
                {series.map((entry, seriesIndex) => {
                  const val = rawValues[seriesIndex]![index]!;
                  if (val === null) return null;
                  const fill =
                    series.length === 1 && data?.[index]?.color
                      ? data[index]!.color
                      : colorAt(seriesIndex, entry.color);
                  let x0: number;
                  let x1: number;
                  let y: number;
                  if (stacked) {
                    y = rowTop + (rowHeight - barH) / 2;
                    if (val >= 0) {
                      x0 = xOf(posCursor);
                      posCursor += val;
                      x1 = xOf(posCursor);
                    } else {
                      x1 = xOf(negCursor);
                      negCursor += val;
                      x0 = xOf(negCursor);
                    }
                  } else {
                    y = rowTop + 6 + seriesIndex * (barH + 3);
                    x0 = val >= 0 ? zeroX : xOf(val);
                    x1 = val >= 0 ? xOf(val) : zeroX;
                  }
                  const barW = Math.abs(x1 - x0);
                  return (
                    <rect
                      key={`${seriesIndex}-${entry.name}-${index}`}
                      x={Math.min(x0, x1)}
                      y={y}
                      width={Math.max(val === 0 ? 0 : 1, barW)}
                      height={barH}
                      rx={4}
                      fill={fill}
                      opacity={selected === null || selected === index ? 1 : 0.42}
                    />
                  );
                })}
                {stacked || series.length === 1 ? (
                  <text
                    x={labelAnchor === "end" ? width - 4 : labelX}
                    y={rowTop + rowHeight / 2 + 4}
                    textAnchor={labelAnchor}
                    className="kit-chart-axis"
                  >
                    {hasRowFinite ? formatValue(total) : "—"}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {selected !== null ? (
          <div
            className="kit-chart-tooltip"
            style={{ left: tooltipLeft(pad.left + plotW / 2, width), top: 8 }}
          >
            <strong>{labels[selected]}</strong>
            {series.map((entry, seriesIndex) => {
              const val = rawValues[seriesIndex]![selected]!;
              return (
                <div key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
                  <span
                    className="kit-chart-swatch"
                    style={{ background: colorAt(seriesIndex, entry.color) }}
                  />
                  <span>
                    {series.length > 1 ? `${entry.name}: ` : ""}
                    {val === null ? "—" : formatValue(val)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {series.length > 1 ? (
          <div className="kit-chart-legend">
            {series.map((entry, seriesIndex) => (
              <span key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
                <span
                  className="kit-chart-swatch"
                  style={{ background: colorAt(seriesIndex, entry.color) }}
                />
                <span>{entry.name}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const pad = { top: 14, right: 16, bottom: 28, left: 54 };
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);
  const groupW = plotW / labels.length;
  const maxLabels = Math.max(2, Math.floor(plotW / 52));
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  const lastRegularLabel = Math.floor((labels.length - 1) / labelStep) * labelStep;
  const yOf = (value: number) => pad.top + plotH - scaleRatio(value, scale.min, scale.max) * plotH;
  const zeroY = yOf(0);

  return (
    <div
      ref={ref}
      className="kit-chart"
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      onFocus={() => {
        setKeyboardFocused(true);
        setActiveIndex((current) =>
          current !== null && current >= 0 && current < labels.length ? current : 0,
        );
      }}
      onBlur={() => {
        setKeyboardFocused(false);
        setActiveIndex(null);
      }}
      onKeyDown={(event) => {
        setKeyboardFocused(true);
        stepIndex(event, labels.length, selected, setActiveIndex);
      }}
    >
      <span className="kit-sr-only" aria-live="polite">
        {readout}
      </span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        onMouseLeave={() => setActiveIndex(null)}
      >
        {scale.values.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line
                x1={pad.left}
                y1={y}
                x2={pad.left + plotW}
                y2={y}
                className={tick === 0 ? "kit-chart-zero" : "kit-chart-grid"}
              />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" className="kit-chart-axis">
                {formatValue(tick)}
              </text>
            </g>
          );
        })}

        {labels.map((label, index) => {
          const groupX = pad.left + index * groupW;
          const innerPad = Math.min(10, groupW * 0.16);
          const usableW = Math.max(0, groupW - innerPad * 2);
          const maxBar = stacked || series.length === 1 ? 42 : 26;
          const rawSlotW = usableW / series.length;
          const gap = !stacked && series.length > 1 ? Math.min(4, rawSlotW * 0.22) : 0;
          const barW = stacked
            ? Math.min(usableW, maxBar)
            : Math.min(Math.max(0, rawSlotW - gap), maxBar);
          const clusterW = stacked ? barW : barW * series.length + gap * (series.length - 1);
          const clusterStart = groupX + (groupW - clusterW) / 2;
          const showLabel =
            index % labelStep === 0 ||
            (index === labels.length - 1 && index - lastRegularLabel >= Math.ceil(labelStep * 0.6));
          let posCursor = 0;
          let negCursor = 0;

          return (
            <g
              key={`${label}-${index}`}
              onMouseEnter={() => {
                setKeyboardFocused(false);
                setActiveIndex(index);
              }}
            >
              <path
                className={selected === index ? "kit-chart-hover-band" : undefined}
                fill={selected === index ? undefined : "transparent"}
                d={`M ${groupX + 2},${pad.top} H ${groupX + groupW - 2} V ${pad.top + plotH} H ${groupX + 2} Z`}
              />
              {series.map((entry, seriesIndex) => {
                const value = rawValues[seriesIndex]![index]!;
                if (value === null) return null;
                const x = stacked ? clusterStart : clusterStart + seriesIndex * (barW + gap);
                let yTop: number;
                let yBottom: number;
                if (stacked) {
                  if (value >= 0) {
                    yBottom = yOf(posCursor);
                    posCursor += value;
                    yTop = yOf(posCursor);
                  } else {
                    yTop = yOf(negCursor);
                    negCursor += value;
                    yBottom = yOf(negCursor);
                  }
                } else if (value >= 0) {
                  yTop = yOf(value);
                  yBottom = zeroY;
                } else {
                  yTop = zeroY;
                  yBottom = yOf(value);
                }
                const barH = Math.abs(yBottom - yTop);
                return (
                  <rect
                    key={`${seriesIndex}-${entry.name}-${index}`}
                    x={x}
                    y={Math.min(yTop, yBottom)}
                    width={barW}
                    height={Math.max(value === 0 ? 0 : 1, barH)}
                    rx={4}
                    fill={
                      series.length === 1 && data?.[index]?.color
                        ? data[index]!.color
                        : colorAt(seriesIndex, entry.color)
                    }
                    opacity={selected === null || selected === index ? 1 : 0.42}
                  />
                );
              })}
              {showLabel ? (
                <text
                  x={groupX + groupW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="kit-chart-axis"
                >
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {selected !== null ? (
        <div
          className="kit-chart-tooltip"
          style={{
            left: tooltipLeft(pad.left + selected * groupW + groupW / 2, width),
            top: 8,
          }}
        >
          <strong>{labels[selected]}</strong>
          {series.map((entry, seriesIndex) => {
            const val = rawValues[seriesIndex]![selected]!;
            return (
              <div key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
                <span
                  className="kit-chart-swatch"
                  style={{ background: colorAt(seriesIndex, entry.color) }}
                />
                <span>
                  {series.length > 1 ? `${entry.name}: ` : ""}
                  {val === null ? "—" : formatValue(val)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {series.length > 1 ? (
        <div className="kit-chart-legend">
          {series.map((entry, seriesIndex) => (
            <span key={`${seriesIndex}-${entry.name}`} className="kit-chart-legend-item">
              <span
                className="kit-chart-swatch"
                style={{ background: colorAt(seriesIndex, entry.color) }}
              />
              <span>{entry.name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface DonutChartProps {
  readonly data: readonly ChartPoint[];
  readonly size?: number;
  readonly centerLabel?: string;
  readonly centerValue?: string;
  readonly formatValue?: (value: number) => string;
  readonly ariaLabel?: string;
}

export function DonutChart({
  data,
  size = 180,
  centerLabel,
  centerValue,
  formatValue = (value) => value.toLocaleString(),
  ariaLabel = "Breakdown chart",
}: DonutChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const items = data.filter((item) => Number.isFinite(item.value) && item.value > 0);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const selected =
    activeIndex !== null && activeIndex >= 0 && activeIndex < items.length ? activeIndex : null;

  if (items.length === 0 || total <= 0) {
    return (
      <div className="kit-chart-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;
  const focused = selected !== null ? items[selected]! : null;
  const readout =
    keyboardFocused && focused
      ? `${focused.label}: ${formatValue(focused.value)} (${Math.round((focused.value / total) * 100)}%)`
      : "";

  return (
    <div
      className="kit-chart kit-donut-layout"
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      onFocus={() => {
        setKeyboardFocused(true);
        setActiveIndex((current) =>
          current !== null && current >= 0 && current < items.length ? current : 0,
        );
      }}
      onBlur={() => {
        setKeyboardFocused(false);
        setActiveIndex(null);
      }}
      onKeyDown={(event) => {
        setKeyboardFocused(true);
        stepIndex(event, items.length, selected, setActiveIndex);
      }}
    >
      <span className="kit-sr-only" aria-live="polite">
        {readout}
      </span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={{ width: size, height: size, flexShrink: 0 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--kit-panel-2)"
          strokeWidth={15}
        />
        {items.map((item, index) => {
          const share = item.value / total;
          const length = share * circumference;
          const offset = -consumed * circumference;
          consumed += share;
          return (
            <circle
              key={`${item.label}-${index}`}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={colorAt(index, item.color)}
              strokeWidth={selected === index ? 19 : 15}
              strokeDasharray={`${Math.max(0, length - 2)} ${circumference}`}
              strokeDashoffset={offset}
              opacity={selected === null || selected === index ? 1 : 0.55}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              onMouseEnter={() => {
                setKeyboardFocused(false);
                setActiveIndex(index);
              }}
            />
          );
        })}
        <text
          x={size / 2}
          y={size / 2 - 2}
          textAnchor="middle"
          fill="var(--kit-ink)"
          fontSize={18}
          fontWeight={650}
          style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}
        >
          {focused ? formatValue(focused.value) : (centerValue ?? formatValue(total))}
        </text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="kit-chart-axis">
          {focused ? focused.label : (centerLabel ?? "Total")}
        </text>
      </svg>

      <div className="kit-donut-legend">
        {items.map((item, index) => {
          const share = Math.round((item.value / total) * 100);
          return (
            <div
              key={`${item.label}-${index}`}
              className={
                selected === index ? "kit-donut-row kit-donut-row-active" : "kit-donut-row"
              }
              onMouseEnter={() => {
                setKeyboardFocused(false);
                setActiveIndex(index);
              }}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="kit-chart-legend-item">
                <span
                  className="kit-chart-swatch"
                  style={{ background: colorAt(index, item.color) }}
                />
                <span>{item.label}</span>
              </span>
              <span className="kit-donut-meta">
                <span>{formatValue(item.value)}</span>
                <span className="kit-donut-share">{share}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface SparklineProps {
  readonly values: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly tone?: "accent" | "success" | "warning" | "danger";
  readonly area?: boolean;
  readonly ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 32,
  tone = "accent",
  area = true,
  ariaLabel = "Sparkline",
}: SparklineProps) {
  const sparkId = useId();
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;

  const stroke =
    tone === "accent"
      ? "var(--kit-chart-1)"
      : tone === "success"
        ? "var(--kit-success)"
        : tone === "warning"
          ? "var(--kit-warning)"
          : "var(--kit-danger)";

  if (finite.length === 1) {
    const pad = 2;
    const onlyIndex = values.findIndex((value) => Number.isFinite(value));
    const cx =
      values.length === 1 ? width / 2 : pad + (onlyIndex / (values.length - 1)) * (width - pad * 2);
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        style={{ display: "block", width, height }}
      >
        <circle cx={cx} cy={height / 2} r={3} fill={stroke} />
      </svg>
    );
  }

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const pad = 3;
  const denom = Math.max(1, values.length - 1);

  const segments: Array<Array<{ readonly x: number; readonly y: number }>> = [];
  let current: Array<{ readonly x: number; readonly y: number }> = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (Number.isFinite(value)) {
      const x = pad + (index / denom) * (width - pad * 2);
      const y = pad + (1 - (value - min) / span) * (height - pad * 2);
      current.push({ x, y });
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  const lastSegment = segments[segments.length - 1];
  const terminal =
    lastSegment && lastSegment.length > 1 ? lastSegment[lastSegment.length - 1] : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block", width, height }}
    >
      {area ? (
        <defs>
          <linearGradient
            id={`${sparkId}-fill`}
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={pad}
            x2={0}
            y2={height - pad}
          >
            <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
      ) : null}
      {segments.map((segment, segmentIndex) => {
        if (segment.length === 1) {
          return (
            <circle
              key={`dot-${segmentIndex}`}
              cx={segment[0]!.x}
              cy={segment[0]!.y}
              r={2}
              fill={stroke}
            />
          );
        }
        const linePath = `M ${segment.map((pt) => `${pt.x},${pt.y}`).join(" L ")}`;
        const first = segment[0]!;
        const last = segment[segment.length - 1]!;
        const areaPath = `${linePath} L ${last.x},${height - pad} L ${first.x},${height - pad} Z`;
        return (
          <g key={`seg-${segmentIndex}`}>
            {area ? <path d={areaPath} fill={`url(#${sparkId}-fill)`} /> : null}
            <path
              d={linePath}
              fill="none"
              stroke={stroke}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
      {terminal ? <circle cx={terminal.x} cy={terminal.y} r={2.5} fill={stroke} /> : null}
    </svg>
  );
}
