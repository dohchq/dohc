import { useEffect, useRef, type ReactNode } from "react";
import type { useDatasetQuery } from "dohc/app";
import { ArrowDown, ArrowUp, ChartLine, Minus, Upload } from "dohc/icons";
import { Input } from "dohc/ui";
import { Spark } from "./charts";
import { QueryError } from "./query-error";
import { AXIS_COLORS } from "./report/model";
import {
  count,
  formatDelta,
  formatRange,
  formatValue,
  unitSuffix,
  visibleChange,
} from "./report/format";
import type { CatalogEntry, Overview } from "./types";

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const SEARCH_FROM = 20;

function Delta({ value, base, unit }: { value: number; base: number; unit: string }) {
  const direction = visibleChange(value, unit, base) ? Math.sign(value) : 0;
  const Icon = direction > 0 ? ArrowUp : direction < 0 ? ArrowDown : Minus;
  const pct = base && unit !== "%" ? Math.round((value / Math.abs(base)) * 1000) / 10 : null;
  return (
    <span className="delta" title="7-day average vs the 7 days before">
      <Icon size={11} strokeWidth={2.4} aria-hidden="true" />
      {direction ? formatDelta(value, unit, base) : formatValue(0, unit, base)}
      {direction !== 0 && pct !== null && pct !== 0 && Math.abs(pct) < 1000 && (
        <small>{` ${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`}</small>
      )}
    </span>
  );
}

export function Rail({
  overview,
  catalog,
  query,
  settled,
  onQuery,
  left,
  right,
  onAssign,
  importer,
  onImport,
  importOpen,
  inert,
}: {
  overview: ReturnType<typeof useDatasetQuery<Overview>>;
  catalog: Overview | undefined;
  query: string;
  settled: string;
  onQuery: (query: string) => void;
  left?: CatalogEntry;
  right?: CatalogEntry;
  onAssign: (id: string, axis: "L" | "R") => void;
  importer: ReactNode;
  onImport: () => void;
  importOpen: boolean;
  inert: boolean;
}) {
  const entries = catalog?.series ?? [];
  const domains = [...new Set(entries.map((entry) => entry.domain))];
  const list = useRef<HTMLDivElement>(null);
  const picked = useRef<string | null>(null);
  const placed = useRef(false);
  const assign = (id: string, axis: "L" | "R") => {
    if (left && (id !== left.id || (axis === "R" && right))) picked.current = id;
    onAssign(id, axis);
  };
  useEffect(() => {
    const rail = list.current;
    const target = picked.current;
    if (!catalog || !rail || (placed.current && !target)) return;
    const cards = [
      ...rail.querySelectorAll(
        target ? `.rail-row[data-series="${CSS.escape(target)}"]` : ".rail-row[data-axis]",
      ),
    ].map((card) => card.getBoundingClientRect());
    if (!cards.length) return;
    placed.current = true;
    picked.current = null;
    const box = rail.getBoundingClientRect();
    const header = rail.querySelector(".rail-group")?.getBoundingClientRect().height ?? 0;
    const [first] = cards;
    const last = cards.at(-1)!;
    const fit = (start: number, end: number, low: number, high: number) =>
      start < low || end - start > high - low ? start - low : end > high ? end - high : 0;
    rail.scrollLeft += fit(first.left, last.right, box.left, box.right);
    rail.scrollTop += fit(first.top, last.bottom, box.top + header, box.bottom);
  }, [left?.id, right?.id, catalog]);
  return (
    <aside className="rail" aria-label="Series" inert={inert}>
      <div className="rail-head">
        <div className="brand">
          <ChartLine size={16} aria-hidden="true" />
          <h1>SignalBook</h1>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-expanded={importOpen}
          onClick={onImport}
          title="Import CSV (I)"
          aria-keyshortcuts="I"
        >
          <Upload size={14} aria-hidden="true" />
          <span>Import CSV</span>
        </button>
      </div>
      <div className="rail-meta">
        <span>
          <b id="observation-count">{catalog ? count(catalog.observations) : "…"}</b> observations
        </span>
        <span>
          <b>{catalog ? count(catalog.total) : "…"}</b> series
        </span>
        <span className="rail-key">Changes: 7-day average vs the 7 days before</span>
      </div>
      {importer}
      {catalog && (catalog.total > SEARCH_FROM || query) && (
        <div className="rail-search">
          <Input
            type="search"
            aria-label="Find a series"
            placeholder="Find a series"
            maxLength={80}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {overview.data?.matches === 0 && query.trim() && query.trim() === settled ? (
            <p className="rail-note" role="status">
              No series match “{query.trim()}”
            </p>
          ) : (
            catalog.matches > catalog.shown && (
              <p className="rail-note" role="status">
                Showing {count(catalog.shown)} of {count(catalog.matches)}. Refine the search to see
                the rest.
              </p>
            )
          )}
        </div>
      )}
      {overview.error && (
        <div className="rail-error">
          <QueryError
            error={overview.error}
            reload={overview.reload}
            message="Could not load series"
          />
        </div>
      )}
      <div className="rail-list" ref={list}>
        {!catalog &&
          !overview.error &&
          Array.from({ length: 6 }, (_, index) => <div key={index} className="rail-skeleton" />)}
        {catalog?.total === 0 && <p className="rail-empty">Import a CSV to add a series</p>}
        {domains.map((domain) => (
          <section key={domain} aria-label={domain}>
            <h2 className="rail-group">{domain}</h2>
            {entries
              .filter((entry) => entry.domain === domain)
              .map((entry) => {
                const axis = entry.id === left?.id ? "L" : entry.id === right?.id ? "R" : null;
                const recent = entry.spark.filter(([ago]) => ago < 7).map((point) => point[1]);
                const prior = entry.spark
                  .filter(([ago]) => ago >= 7 && ago < 14)
                  .map((point) => point[1]);
                return (
                  <div
                    key={entry.id}
                    className="rail-row"
                    data-series={entry.id}
                    data-axis={axis ?? undefined}
                  >
                    <button
                      type="button"
                      className="rail-main"
                      onClick={() => assign(entry.id, "L")}
                      title={`${entry.name}: latest reading ${entry.latest_at.slice(0, 16).replace("T", " ")} UTC · ${formatRange(entry.start, entry.end)} · ${count(entry.count)} observations`}
                    >
                      <span className="rail-name">{entry.name}</span>
                      <span className="rail-value">
                        {formatValue(entry.latest, entry.unit)}
                        <small>{unitSuffix(entry.unit)}</small>
                      </span>
                      <Spark
                        points={entry.spark}
                        color={
                          axis === "L"
                            ? AXIS_COLORS[0]
                            : axis === "R"
                              ? AXIS_COLORS[1]
                              : "var(--sb-faint)"
                        }
                        label={`${entry.name}, last 30 days`}
                      />
                      {prior.length > 0 && recent.length > 0 && (
                        <Delta
                          value={mean(recent) - mean(prior)}
                          base={mean(prior)}
                          unit={entry.unit}
                        />
                      )}
                    </button>
                    <span className="axis-pills">
                      <button
                        type="button"
                        className="pill pill-l"
                        aria-pressed={axis === "L"}
                        aria-label={`Left axis: ${entry.name}`}
                        title="Plot on the left axis"
                        onClick={() => assign(entry.id, "L")}
                      >
                        L
                      </button>
                      <button
                        type="button"
                        className="pill pill-r"
                        aria-pressed={axis === "R"}
                        aria-label={`Right axis: ${entry.name}`}
                        title={
                          axis === "R" ? "Remove from the right axis" : "Compare on the right axis"
                        }
                        onClick={() => assign(entry.id, "R")}
                      >
                        R
                      </button>
                    </span>
                  </div>
                );
              })}
          </section>
        ))}
      </div>
    </aside>
  );
}
