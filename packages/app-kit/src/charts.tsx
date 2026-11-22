import "./ui.css";
import { useEffect, useRef, useState } from "react";

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

function useContainerWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function niceScale(minValue: number, maxValue: number, ticks = 4) {
  const low = Math.min(0, minValue);
  const high = maxValue <= low ? low + 1 : maxValue;
  const span = high - low;
  const rawStep = span / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const values: number[] = [];
  for (let current = min; current <= max + step * 0.001; current += step) {
    values.push(Number(current.toFixed(6)));
  }
  return { min, max, values };
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
  readonly height?: number;
  readonly goal?: { readonly value: number; readonly label?: string };
  readonly formatValue?: (value: number) => string;
  readonly ariaLabel?: string;
}

export function LineChart({
  labels: rawLabels,
  series: rawSeries,
  data,
  variant = "line",
  height = 240,
  goal,
  formatValue = (value) => value.toLocaleString(),
  ariaLabel = "Trend chart",
}: LineChartProps) {
  const { ref, width } = useContainerWidth(560);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const labels = rawLabels ?? data?.map((item) => item.label) ?? [];
  const series: readonly ChartSeries[] =
    rawSeries ?? (data ? [{ name: "Value", values: data.map((item) => item.value) }] : []);

  if (labels.length === 0 || series.length === 0) {
    return (
      <div className="kit-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  const allValues = [...series.flatMap((entry) => entry.values), ...(goal ? [goal.value] : [])];
  const scale = niceScale(Math.min(...allValues, 0), Math.max(...allValues, 0), 4);
  const pad = { top: 14, right: 16, bottom: 28, left: 54 };
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);

  const xOf = (index: number) =>
    labels.length === 1 ? pad.left + plotW / 2 : pad.left + (index / (labels.length - 1)) * plotW;
  const yOf = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const baselineY = yOf(Math.max(scale.min, 0));

  const maxLabels = Math.max(2, Math.floor(plotW / 52));
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));

  return (
    <div ref={ref} className="kit-chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {scale.values.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line x1={pad.left} y1={y} x2={pad.left + plotW} y2={y} className="kit-chart-grid" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" className="kit-chart-axis">
                {formatValue(tick)}
              </text>
            </g>
          );
        })}

        {goal ? (
          <g>
            <line
              x1={pad.left}
              y1={yOf(goal.value)}
              x2={pad.left + plotW}
              y2={yOf(goal.value)}
              stroke="var(--kit-warning)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
            />
            {goal.label ? (
              <text
                x={pad.left + plotW}
                y={yOf(goal.value) - 5}
                textAnchor="end"
                className="kit-chart-axis"
              >
                {goal.label}
              </text>
            ) : null}
          </g>
        ) : null}

        {series.map((entry, seriesIndex) => {
          const stroke = colorAt(seriesIndex, entry.color);
          const points = entry.values.map((value, index) => `${xOf(index)},${yOf(value)}`);
          const linePath = `M ${points.join(" L ")}`;
          const areaPath = `${linePath} L ${xOf(entry.values.length - 1)},${baselineY} L ${xOf(0)},${baselineY} Z`;
          return (
            <g key={entry.name}>
              {variant === "area" ? <path d={areaPath} fill={stroke} fillOpacity={0.14} /> : null}
              <path
                d={linePath}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {entry.values.map((value, index) => (
                <circle
                  key={`${entry.name}-${index}`}
                  cx={xOf(index)}
                  cy={yOf(value)}
                  r={activeIndex === index ? 4.5 : 2.5}
                  fill={stroke}
                />
              ))}
            </g>
          );
        })}

        {activeIndex !== null ? (
          <line
            x1={xOf(activeIndex)}
            y1={pad.top}
            x2={xOf(activeIndex)}
            y2={pad.top + plotH}
            stroke="var(--kit-subtle)"
            strokeDasharray="2 3"
          />
        ) : null}

        {labels.map((label, index) => {
          const x = xOf(index);
          const sliceW = labels.length === 1 ? plotW : plotW / (labels.length - 1);
          const showLabel = index % labelStep === 0 || index === labels.length - 1;
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
                tabIndex={0}
                className="kit-chart-focus"
                aria-label={`${label}: ${series
                  .map((entry) => `${entry.name} ${formatValue(entry.values[index] ?? 0)}`)
                  .join(", ")}`}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              />
            </g>
          );
        })}
      </svg>

      {activeIndex !== null ? (
        <div
          className="kit-chart-tooltip"
          style={{
            left: Math.min(Math.max(8, xOf(activeIndex) - 50), Math.max(8, width - 160)),
            top: 8,
          }}
        >
          <strong>{labels[activeIndex]}</strong>
          {series.map((entry, seriesIndex) => (
            <div key={entry.name} className="kit-chart-legend-item">
              <span
                className="kit-chart-swatch"
                style={{ background: colorAt(seriesIndex, entry.color) }}
              />
              <span>
                {series.length > 1 ? `${entry.name}: ` : ""}
                {formatValue(entry.values[activeIndex] ?? 0)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {series.length > 1 ? (
        <div className="kit-chart-legend">
          {series.map((entry, seriesIndex) => (
            <span key={entry.name} className="kit-chart-legend-item">
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

  const labels = rawLabels ?? data?.map((item) => item.label) ?? [];
  const series: readonly ChartSeries[] =
    rawSeries ?? (data ? [{ name: "Value", values: data.map((item) => item.value) }] : []);

  if (labels.length === 0 || series.length === 0) {
    return (
      <div className="kit-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  const maxVal = stacked
    ? Math.max(
        0,
        ...labels.map((_, index) =>
          series.reduce((sum, entry) => sum + Math.max(0, entry.values[index] ?? 0), 0),
        ),
      )
    : Math.max(0, ...series.flatMap((entry) => entry.values));
  const scale = niceScale(0, maxVal, 4);

  if (orientation === "horizontal") {
    const rowHeight = 32;
    const svgHeight = Math.max(height, labels.length * rowHeight + 28);
    const pad = { top: 8, right: 56, bottom: 20, left: 108 };
    const plotW = Math.max(100, width - pad.left - pad.right);

    return (
      <div ref={ref} className="kit-chart">
        <svg
          width={width}
          height={svgHeight}
          viewBox={`0 0 ${width} ${svgHeight}`}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setActiveIndex(null)}
        >
          {labels.map((label, index) => {
            const y = pad.top + index * rowHeight;
            const total = series.reduce(
              (sum, entry) => sum + Math.max(0, entry.values[index] ?? 0),
              0,
            );
            let offset = pad.left;
            return (
              <g key={`${label}-${index}`}>
                <text x={pad.left - 8} y={y + 18} textAnchor="end" className="kit-chart-axis">
                  {label}
                </text>
                {series.map((entry, seriesIndex) => {
                  const val = Math.max(0, entry.values[index] ?? 0);
                  const w = (val / (scale.max || 1)) * plotW;
                  const x = offset;
                  offset += w;
                  return (
                    <rect
                      key={`${entry.name}-${index}`}
                      x={x}
                      y={y + 6}
                      width={Math.max(1, w)}
                      height={16}
                      rx={3}
                      fill={
                        series.length === 1 && data?.[index]?.color
                          ? data[index]!.color
                          : colorAt(seriesIndex, entry.color)
                      }
                      opacity={activeIndex === null || activeIndex === index ? 1 : 0.45}
                      tabIndex={0}
                      className="kit-chart-focus"
                      aria-label={`${label} ${entry.name}: ${formatValue(val)}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onFocus={() => setActiveIndex(index)}
                      onBlur={() => setActiveIndex(null)}
                    />
                  );
                })}
                <text x={offset + 6} y={y + 18} className="kit-chart-axis">
                  {formatValue(total)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  const pad = { top: 14, right: 16, bottom: 28, left: 54 };
  const plotW = Math.max(120, width - pad.left - pad.right);
  const plotH = Math.max(80, height - pad.top - pad.bottom);
  const groupW = plotW / labels.length;
  const yOf = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;

  return (
    <div ref={ref} className="kit-chart">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {scale.values.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line x1={pad.left} y1={y} x2={pad.left + plotW} y2={y} className="kit-chart-grid" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" className="kit-chart-axis">
                {formatValue(tick)}
              </text>
            </g>
          );
        })}

        {labels.map((label, index) => {
          const groupX = pad.left + index * groupW;
          const innerPad = Math.min(10, groupW * 0.16);
          const usableW = Math.max(8, groupW - innerPad * 2);
          let stackedHeight = 0;

          return (
            <g key={`${label}-${index}`}>
              {series.map((entry, seriesIndex) => {
                const value = Math.max(0, entry.values[index] ?? 0);
                const barH = (value / (scale.max || 1)) * plotH;
                const barW = stacked
                  ? usableW
                  : usableW / series.length - (series.length > 1 ? 2 : 0);
                const x = stacked
                  ? groupX + innerPad
                  : groupX + innerPad + seriesIndex * (usableW / series.length);
                const y = stacked ? pad.top + plotH - stackedHeight - barH : pad.top + plotH - barH;
                stackedHeight += barH;

                return (
                  <rect
                    key={`${entry.name}-${index}`}
                    x={x}
                    y={y}
                    width={Math.max(2, barW)}
                    height={Math.max(1, barH)}
                    rx={3}
                    fill={
                      series.length === 1 && data?.[index]?.color
                        ? data[index]!.color
                        : colorAt(seriesIndex, entry.color)
                    }
                    opacity={activeIndex === null || activeIndex === index ? 1 : 0.5}
                    tabIndex={0}
                    className="kit-chart-focus"
                    aria-label={`${label} ${entry.name}: ${formatValue(value)}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onBlur={() => setActiveIndex(null)}
                  />
                );
              })}
              <text
                x={groupX + groupW / 2}
                y={height - 6}
                textAnchor="middle"
                className="kit-chart-axis"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {activeIndex !== null ? (
        <div
          className="kit-chart-tooltip"
          style={{
            left: Math.min(
              Math.max(8, pad.left + activeIndex * groupW + groupW / 2 - 50),
              Math.max(8, width - 160),
            ),
            top: 8,
          }}
        >
          <strong>{labels[activeIndex]}</strong>
          {series.map((entry, seriesIndex) => (
            <div key={entry.name} className="kit-chart-legend-item">
              <span
                className="kit-chart-swatch"
                style={{ background: colorAt(seriesIndex, entry.color) }}
              />
              <span>
                {series.length > 1 ? `${entry.name}: ` : ""}
                {formatValue(entry.values[activeIndex] ?? 0)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {series.length > 1 ? (
        <div className="kit-chart-legend">
          {series.map((entry, seriesIndex) => (
            <span key={entry.name} className="kit-chart-legend-item">
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
  const items = data.filter((item) => item.value > 0);
  const total = items.reduce((sum, item) => sum + item.value, 0);

  if (items.length === 0 || total <= 0) {
    return (
      <div className="kit-empty" role="img" aria-label={ariaLabel}>
        No chart data yet.
      </div>
    );
  }

  const radius = size / 2 - 14;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;
  const focused = activeIndex !== null ? items[activeIndex] : null;

  return (
    <div className="kit-donut-layout">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
        style={{ width: size, height: size, flexShrink: 0 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--kit-panel-2)"
          strokeWidth={18}
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
              strokeWidth={activeIndex === index ? 22 : 18}
              strokeDasharray={`${Math.max(0, length - 1.5)} ${circumference}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              tabIndex={0}
              className="kit-chart-focus"
              aria-label={`${item.label}: ${formatValue(item.value)} (${Math.round(share * 100)}%)`}
              onMouseEnter={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
            />
          );
        })}
        <text
          x={size / 2}
          y={size / 2 - 4}
          textAnchor="middle"
          fill="var(--kit-ink)"
          fontSize={16}
          fontWeight={650}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {focused ? formatValue(focused.value) : (centerValue ?? formatValue(total))}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" className="kit-chart-axis">
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
                activeIndex === index ? "kit-donut-row kit-donut-row-active" : "kit-donut-row"
              }
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="kit-chart-legend-item">
                <span
                  className="kit-chart-swatch"
                  style={{ background: colorAt(index, item.color) }}
                />
                <span>{item.label}</span>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--kit-muted)" }}>
                {formatValue(item.value)} · {share}%
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
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const stroke =
    tone === "accent"
      ? "var(--kit-chart-1)"
      : tone === "success"
        ? "var(--kit-success)"
        : tone === "warning"
          ? "var(--kit-warning)"
          : "var(--kit-danger)";

  const coords = values.map((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return `${x},${y}`;
  });
  const linePath = `M ${coords.join(" L ")}`;
  const areaPath = `${linePath} L ${width - pad},${height - pad} L ${pad},${height - pad} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block", width, height }}
    >
      {area ? <path d={areaPath} fill={stroke} fillOpacity={0.14} /> : null}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
