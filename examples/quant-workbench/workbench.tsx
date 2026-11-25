import { useEffect, useMemo, useRef, useState } from "react";
import { useDatasetMutation, useDatasetQuery } from "dohc/app";
import { FileText, RotateCcw, Share2 } from "dohc/icons";
import { Outliers, Correlation } from "./analysis";
import { RangePicker, Shortcuts } from "./controls";
import { useDebounced, useMedia, useSticky, typing } from "./hooks";
import { Importer } from "./importer";
import { Notes, useNotebook, type Drawer } from "./notes";
import { QueryError } from "./query-error";
import { Rail } from "./rail";
import {
  DAY,
  GRAIN_NAMES,
  type Focus,
  type Grain,
  type Overlays,
  type Snapshot,
} from "./report/model";
import { Trend } from "./report/trend";
import type { Analysis, CatalogEntry, Comparison, Outlier, Overview, Preset, Range } from "./types";

const PRESETS: Record<Preset, number> = { "30D": 30, "90D": 90, "1Y": 365, All: 0 };
const PRESET_KEYS: Record<string, Preset> = { "1": "30D", "2": "90D", "3": "1Y", "4": "All" };
const GRAIN_KEYS: Record<string, Grain> = { d: "day", w: "week", m: "month" };
const dateText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const DEFAULT_PAIR = ["sample-sleep-hours", "sample-resting-hr"];

function getRange(entries: CatalogEntry[], preset: Preset): Range {
  if (!entries.length) return { start: "", end: "" };
  const start = entries.map((entry) => entry.start).sort()[0];
  const end = entries
    .map((entry) => entry.end)
    .sort()
    .at(-1)!;
  const days = PRESETS[preset];
  return {
    start: days ? [start, dateText(Date.parse(end) - (days - 1) * DAY)].sort()[1] : start,
    end,
  };
}

export function Workbench() {
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<[string, string] | null>(null);
  const [seriesQuery, setSeriesQuery] = useState("");
  const settledQuery = useDebounced(seriesQuery.trim(), 160);
  const overview = useDatasetQuery<Overview>(
    "overview",
    { query: settledQuery, include: selection?.filter(Boolean) ?? DEFAULT_PAIR },
    { live: !busy },
  );
  const catalog = useSticky(overview.data, "catalog");
  const [preset, setPreset] = useState<Preset>("90D");
  const [custom, setCustom] = useState<Range | null>(null);
  const [grain, setGrain] = useState<Grain>("day");
  const [overlays, setOverlays] = useState<Overlays>({ ma7: true, ma30: false });
  const [lag, setLag] = useState(0);
  const [focus, setFocus] = useState<Outlier | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const notebook = useNotebook();
  const docked = useMedia("(min-width: 1400px)");
  const covered = Boolean(drawer) && !docked;
  const [importOpen, setImportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const saveShortcuts = useDatasetMutation<{ enabled: boolean }, { enabled: boolean }>(
    "setShortcuts",
  );
  const [shortcutChoice, setShortcutChoice] = useState<{
    enabled: boolean;
    from: typeof catalog;
  } | null>(null);
  const shortcuts = shortcutChoice?.enabled ?? catalog?.shortcuts ?? true;
  useEffect(() => {
    if (shortcutChoice && !saveShortcuts.pending && catalog !== shortcutChoice.from)
      setShortcutChoice(null);
  }, [shortcutChoice, saveShortcuts.pending, catalog]);
  const opener = useRef<HTMLElement | SVGElement | null>(null);
  const chartRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const entries = catalog?.series ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const settled = overview.data !== undefined;
  const left = byId.get(selection?.[0] ?? DEFAULT_PAIR[0]) ?? (settled ? entries[0] : undefined);
  const requested = byId.get(selection?.[1] ?? DEFAULT_PAIR[1]);
  const right =
    selection?.[1] === ""
      ? undefined
      : requested && requested.id !== left?.id
        ? requested
        : settled
          ? entries.find((entry) => entry.id !== left?.id)
          : undefined;
  const active = [left, right].filter((entry): entry is CatalogEntry => entry !== undefined);
  const range = custom ?? getRange(active, preset);
  const validRange = Boolean(range.start && range.end && range.start <= range.end);
  const ids = active.map((entry) => entry.id);
  const settledLag = useDebounced(lag, 140);
  const analysis = useDatasetQuery<Analysis>(
    "analyze",
    { ids, ...range, grain },
    { enabled: ids.length > 0 && validRange, live: !busy },
  );
  const comparison = useDatasetQuery<Comparison>(
    "compare",
    { ids, ...range, lag: settledLag },
    { enabled: ids.length === 2 && validRange, live: !busy },
  );
  const retained = useSticky(analysis.data, ids.join("|"));
  const data = validRange ? retained : undefined;
  const outlierRows = data?.outliers;
  const focused = useMemo<Focus | null>(
    () =>
      focus && outlierRows?.some((row) => row.id === focus.id)
        ? {
            day: focus.observed_at.slice(0, 10),
            seriesId: focus.series_id,
            value: focus.value,
            at: focus.observed_at.slice(11, 16),
          }
        : null,
    [focus, outlierRows],
  );
  const rollups = data?.rollups;
  const canSave = Boolean(analysis.data?.rollups.series.some((series) => series.bars.length));

  useEffect(() => {
    if (!selection && settled && left) setSelection([left.id, right?.id ?? ""]);
  }, [selection, settled, left, right]);

  function assign(id: string, axis: "L" | "R") {
    if (!left) return;
    const next: [string, string] =
      axis === "L"
        ? [id, id === right?.id ? left.id : (right?.id ?? "")]
        : id === right?.id
          ? [left.id, ""]
          : id === left.id
            ? [right?.id ?? id, right ? id : ""]
            : [left.id, id];
    if (next[0] === left.id && next[1] === (right?.id ?? "")) return;
    setFocus(null);
    setSelection(next);
  }

  function openDrawer(mode: Drawer) {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    setHelpOpen(false);
    setDrawer(mode);
  }

  useEffect(() => {
    if (drawer || !opener.current) return;
    opener.current.focus();
    opener.current = null;
  }, [drawer]);

  function toggleDrawer(mode: Drawer) {
    if (drawer === mode) setDrawer(null);
    else openDrawer(mode);
  }

  function zoom(next: Range | null) {
    setFocus(null);
    setCustom(next);
  }

  function choosePreset(value: Preset) {
    setPreset(value);
    zoom(null);
  }

  function openSnapshot(snapshot: Snapshot) {
    const [first, second] = snapshot.series.map((series) => series.id);
    setSelection([first, second ?? ""]);
    setCustom({ start: snapshot.start, end: snapshot.end });
    setGrain(snapshot.grain === "year" ? "month" : snapshot.grain);
    setLag(snapshot.comparison?.lag ?? 0);
    setFocus(null);
    setDrawer(null);
  }

  async function toggleShortcuts(enabled: boolean) {
    setShortcutChoice({ enabled, from: catalog });
    try {
      await saveShortcuts.mutate({ enabled });
    } catch {
      setShortcutChoice(null);
    }
  }

  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    if (event.key === "Escape") {
      if (helpOpen) setHelpOpen(false);
      else if (drawer) setDrawer(null);
      else if (importOpen) setImportOpen(false);
      else if (focus) setFocus(null);
      else return;
      event.preventDefault();
      return;
    }
    if (
      !shortcuts ||
      covered ||
      (!(event.ctrlKey && event.altKey && /^[[\]]$/.test(event.key)) &&
        (event.ctrlKey || event.metaKey || event.altKey)) ||
      (event.shiftKey && event.key !== "?") ||
      typing(event.target)
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "?" && !drawer) setHelpOpen(!helpOpen);
    else if (PRESET_KEYS[key]) choosePreset(PRESET_KEYS[key]);
    else if (GRAIN_KEYS[key]) setGrain(GRAIN_KEYS[key]);
    else if (key === "z") {
      if (custom) zoom(null);
    } else if (key === "n") toggleDrawer("notes");
    else if (key === "i") setImportOpen((open) => !open);
    else if (key === "[" && right) setLag((value) => Math.max(-30, value - 1));
    else if (key === "]" && right) setLag((value) => Math.min(30, value + 1));
    else return;
    event.preventDefault();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const names = active.map((entry) => entry.name);
  return (
    <div className={drawer && docked ? "signalbook with-drawer" : "signalbook"}>
      <Rail
        overview={overview}
        catalog={catalog}
        query={seriesQuery}
        settled={settledQuery}
        onQuery={setSeriesQuery}
        left={left}
        right={right}
        onAssign={assign}
        importOpen={importOpen}
        onImport={() => setImportOpen(!importOpen)}
        importer={
          <Importer
            open={importOpen}
            setOpen={setImportOpen}
            overview={overview}
            onBusy={setBusy}
          />
        }
        inert={covered}
      />
      <main className="main" data-scroll-main inert={covered}>
        <div className="toolbar" role="toolbar" aria-label="Chart" ref={toolbarRef}>
          <div className="sb-segments" role="group" aria-label="Date range">
            {(Object.keys(PRESETS) as Preset[]).map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={!custom && preset === value}
                title={`${value === "All" ? "All observations" : value} (${index + 1})`}
                aria-keyshortcuts={String(index + 1)}
                onClick={() => choosePreset(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="sb-segments" role="group" aria-label="Bucket size">
            {(["day", "week", "month"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={(rollups?.grain ?? grain) === value}
                data-auto={rollups && rollups.grain === value && grain !== value ? "" : undefined}
                title={
                  rollups && rollups.grain === value && grain !== value
                    ? `Wide ranges use ${GRAIN_NAMES[value].toLowerCase()} buckets`
                    : `${GRAIN_NAMES[value]} buckets (${value[0].toUpperCase()})`
                }
                aria-keyshortcuts={value[0].toUpperCase()}
                onClick={() => setGrain(value)}
              >
                {GRAIN_NAMES[value]}
              </button>
            ))}
          </div>
          <div className="toolbar-group" role="group" aria-label="Moving averages">
            <button
              type="button"
              className="sb-toggle"
              aria-pressed={overlays.ma7}
              onClick={() => setOverlays({ ...overlays, ma7: !overlays.ma7 })}
              title="7-day moving average"
            >
              <span className="sb-dash" aria-hidden="true" />
              MA 7
            </button>
            <button
              type="button"
              className="sb-toggle"
              aria-pressed={overlays.ma30}
              onClick={() => setOverlays({ ...overlays, ma30: !overlays.ma30 })}
              title="30-day moving average"
            >
              <span className="sb-dot" aria-hidden="true" />
              MA 30
            </button>
          </div>
          <div className="range-fields">
            <RangePicker range={range} custom={Boolean(custom)} onChange={zoom} />
            {custom && (
              <button
                type="button"
                className="sb-toggle zoom-reset"
                onClick={() => zoom(null)}
                title={`Return to the ${preset} range (Z or double-click the chart)`}
                aria-keyshortcuts="Z"
                aria-label={`Back to ${preset}`}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>
                  <span className="zoom-reset-word">Back to </span>
                  {preset}
                </span>
              </button>
            )}
          </div>
          <div className="toolbar-end">
            <button
              type="button"
              className="sb-toggle"
              aria-pressed={drawer === "notes"}
              onClick={() => toggleDrawer("notes")}
              title="Research notes (N)"
              aria-keyshortcuts="N"
            >
              <FileText size={13} aria-hidden="true" />
              <span className="toolbar-label">Notes</span>
            </button>
            <button
              type="button"
              className="sb-toggle"
              aria-pressed={drawer === "share"}
              onClick={() => toggleDrawer("share")}
              title="Share a saved snapshot as a report"
            >
              <Share2 size={13} aria-hidden="true" />
              <span className="toolbar-label">Share</span>
            </button>
            <Shortcuts
              enabled={shortcuts}
              setEnabled={toggleShortcuts}
              error={saveShortcuts.error}
              open={helpOpen}
              setOpen={setHelpOpen}
            />
          </div>
        </div>
        <section className="chart" ref={chartRef} aria-label="Time series">
          {analysis.error ? (
            <div className="chart-message">
              <QueryError
                error={analysis.error}
                reload={analysis.reload}
                message="Could not load rollups"
              />
            </div>
          ) : rollups ? (
            <div className={analysis.loading ? "chart-body stale" : "chart-body"}>
              <Trend
                snapshot={rollups}
                overlays={overlays}
                label="Time series. Move with the arrow keys or drag to select a date range."
                focus={focused}
                onBrush={
                  analysis.loading
                    ? undefined
                    : (start, end) => {
                        const from = start < range.start ? range.start : start;
                        const to = end > range.end ? range.end : end;
                        if (from > to) return;
                        zoom({ start: from, end: to });
                      }
                }
                onReset={analysis.loading || !custom ? undefined : () => zoom(null)}
              />
            </div>
          ) : (
            <p className="sb-empty chart-message" role="status">
              {analysis.loading || overview.loading || busy
                ? "Loading time series"
                : !left
                  ? "Import a CSV to plot a series"
                  : "Choose a start date before the end date"}
            </p>
          )}
        </section>
        <div
          className={(analysis.loading || analysis.error) && data ? "deck stale" : "deck"}
          aria-busy={analysis.loading}
        >
          <Correlation
            left={left}
            right={right}
            profile={data?.profile ?? null}
            lag={lag}
            setLag={setLag}
            comparison={comparison}
            valid={validRange}
          />
          <Outliers
            rows={data?.outliers}
            byId={byId}
            left={left}
            focused={focus?.id ?? null}
            onFocus={(row, keyboard) => {
              const selecting = focus?.id !== row.id;
              setFocus(selecting ? row : null);
              const chart = chartRef.current;
              const bar = toolbarRef.current;
              if (!chart) return;
              chart.style.scrollMarginTop =
                bar && getComputedStyle(bar).position === "sticky" ? `${bar.offsetHeight}px` : "";
              chart.scrollIntoView({ block: "nearest" });
              if (keyboard && selecting)
                chart.querySelector<SVGSVGElement>(".sb-trend-svg")?.focus({ preventScroll: true });
            }}
          />
        </div>
      </main>
      {covered && (
        <div className="drawer-scrim" aria-hidden="true" onClick={() => setDrawer(null)} />
      )}
      {drawer && (
        <Notes
          mode={drawer}
          onMode={setDrawer}
          onClose={() => setDrawer(null)}
          onOpen={openSnapshot}
          modal={!docked}
          notebook={notebook}
          view={{ ...range, ids, grain: rollups?.grain ?? grain, lag, names }}
          canSave={canSave}
        />
      )}
    </div>
  );
}
