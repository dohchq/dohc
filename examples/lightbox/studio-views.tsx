import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { EyeOff, Heart, Info, Lock, MessageSquare, PenLine } from "dohc/icons";
import { describeExposure } from "./camera";
import type { StudioAsset } from "./portal/api";
import { SwapGlyph } from "./portal/glyphs";
import { Pins, type NotesState } from "./portal/notes";
import { Photo, useSize } from "./portal/photo";
import { FIT, LABEL_TITLES, LabelInput, LabelMark, Rating, STUDIO_FILES, StarInput, plural, type Zoom, type ZoomLevel } from "./studio-parts";

function clampFocus(value: number, view: number, total: number) {
  if (total <= view) return 0.5;
  const half = view / 2 / total;
  return Math.min(1 - half, Math.max(half, value));
}

function describe(asset: StudioAsset) {
  return [
    asset.title,
    asset.rating ? plural(asset.rating, "star") : null,
    asset.colorLabel !== "none" ? `${LABEL_TITLES[asset.colorLabel]} label` : null,
    asset.published ? null : "draft",
    asset.pickCount ? `${plural(asset.pickCount, "client pick")}` : null,
    asset.openNoteCount ? `${plural(asset.openNoteCount, "open note")}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function ZoomStage({
  photo,
  zoom,
  onZoom,
  zoomTo,
  notes,
  pinMode = false,
  onPinned,
  onViewport,
  onActivate,
}: {
  photo: StudioAsset;
  zoom: Zoom;
  onZoom(zoom: Zoom): void;
  zoomTo: Exclude<ZoomLevel, "fit">;
  notes?: NotesState | null;
  pinMode?: boolean;
  onPinned?: () => void;
  onViewport?: (size: { width: number; height: number }) => void;
  onActivate?: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const view = useSize(box);
  const drag = useRef<{ x: number; y: number; zoom: Zoom; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fitScale = view.width && view.height ? Math.min(view.width / photo.width, view.height / photo.height) : 0;
  const scale = zoom.level === "fit" ? fitScale : Math.max(fitScale, zoom.level);
  const zoomed = scale > fitScale + 0.001;
  const width = photo.width * scale;
  const height = photo.height * scale;
  const x = clampFocus(zoom.x, view.width, width);
  const y = clampFocus(zoom.y, view.height, height);
  const left = width > view.width ? view.width / 2 - x * width : (view.width - width) / 2;
  const top = height > view.height ? view.height / 2 - y * height : (view.height - height) / 2;

  const reports = Boolean(onViewport);
  useEffect(() => {
    onViewport?.(view);
  }, [view.width, view.height, reports]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { fx: (event.clientX - rect.left - left) / width, fy: (event.clientY - rect.top - top) / height };
  };

  return (
    <div
      ref={box}
      className={`st-zoom${zoomed ? " st-zoomed" : ""}${pinMode ? " st-pinning" : ""}${dragging ? " st-dragging" : ""}`}
      onPointerDown={(event) => {
        onActivate?.();
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, zoom: { ...zoom, x, y }, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        if (!zoomed) return;
        if (!start.moved) setDragging(true);
        start.moved = true;
        onZoom({
          level: zoom.level,
          x: clampFocus(start.zoom.x - dx / width, view.width, width),
          y: clampFocus(start.zoom.y - dy / height, view.height, height),
        });
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        setDragging(false);
        if (!start || start.moved) return;
        const { fx, fy } = point(event);
        const inside = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
        if (pinMode && notes) {
          if (inside) {
            notes.setDraft({ xPct: Math.round(fx * 10000) / 100, yPct: Math.round(fy * 10000) / 100 });
            onPinned?.();
          }
          return;
        }
        if (zoom.level === "fit" || !zoomed) onZoom({ level: zoomTo, x: inside ? fx : 0.5, y: inside ? fy : 0.5 });
        else onZoom(FIT);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      {fitScale ? (
        <div className="st-zoom-photo" style={{ width, height, transform: `translate3d(${left}px, ${top}px, 0)` }}>
          <Photo photo={photo} access={STUDIO_FILES} size="full" />
          {notes ? <Pins notes={notes} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function CellMarks({ asset }: { asset: StudioAsset }) {
  return (
    <span className="st-marks" aria-hidden="true">
      {!asset.published ? (
        <span className="st-mark" title="Draft, not in the client gallery">
          <EyeOff size={12} />
        </span>
      ) : null}
      {asset.published && asset.pickCount ? (
        <span className="st-mark st-mark-pick" title={plural(asset.pickCount, "client pick")}>
          <Heart size={12} fill="currentColor" />
          {asset.pickCount > 1 ? asset.pickCount : null}
        </span>
      ) : null}
      {asset.noteCount ? (
        <span className={`st-mark${asset.openNoteCount ? " st-mark-open" : ""}`} title={`${plural(asset.noteCount, "note")}, ${asset.openNoteCount} open`}>
          <MessageSquare size={12} />
          {asset.openNoteCount || asset.noteCount}
        </span>
      ) : null}
    </span>
  );
}

function Fitted({ asset, inset }: { asset: StudioAsset; inset?: boolean }) {
  const style = { "--r": asset.width / asset.height } as CSSProperties;
  return (
    <span className={`st-fitted${inset ? " st-fitted-inset" : ""}`}>
      <span className="st-fitted-photo" style={style}>
        <Photo photo={asset} access={STUDIO_FILES} size="thumb" />
      </span>
    </span>
  );
}

type SelectHow = { toggle: boolean; range: boolean };

const how = (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): SelectHow => ({
  toggle: event.metaKey || event.ctrlKey,
  range: event.shiftKey,
});

export function GridView({
  items,
  allCount,
  currentId,
  chosen,
  cellSize,
  onSelect,
  onOpen,
  onColumns,
}: {
  items: readonly StudioAsset[];
  allCount: number;
  currentId: string | null;
  chosen: ReadonlySet<string>;
  cellSize: number;
  onSelect(id: string, how: SelectHow): void;
  onOpen(id: string): void;
  onColumns(columns: number): void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const { width } = useSize(box);
  const gap = cellSize < 150 ? 4 : 6;
  const columns = Math.max(1, Math.floor((width - 24 + gap) / (cellSize + gap)));
  useEffect(() => onColumns(columns), [columns]);
  useLayoutEffect(() => {
    if (!currentId) return;
    const cell = box.current?.querySelector<HTMLElement>(`[data-asset="${currentId}"]`);
    cell?.scrollIntoView({ block: "nearest" });
    const active = document.activeElement;
    const dropped = Boolean(focused.current && !focused.current.isConnected) && (!active || active === document.body);
    if (cell && (dropped || box.current?.contains(active)) && active !== cell) cell.focus({ preventScroll: true });
  }, [currentId]);
  return (
    <div
      className="st-grid-scroll"
      data-scroll-root
      ref={box}
      onFocus={(event) => {
        focused.current = event.target;
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !box.current?.contains(event.relatedTarget)) focused.current = null;
      }}
    >
      <div
        className="st-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}
        role="listbox"
        aria-multiselectable="true"
        aria-label={`Photos, ${items.length} of ${allCount}`}
      >
        {items.map((asset, index) => (
          <button
            key={asset.id}
            type="button"
            role="option"
            aria-selected={asset.id === currentId || chosen.has(asset.id)}
            data-asset={asset.id}
            tabIndex={asset.id === currentId || (!currentId && index === 0) ? 0 : -1}
            className={`st-cell${asset.id === currentId ? " st-cell-on" : ""}${chosen.size > 1 && chosen.has(asset.id) ? " st-cell-chosen" : ""}${asset.published ? "" : " st-cell-draft"} st-tint-${asset.colorLabel}`}
            aria-label={describe(asset)}
            onMouseDown={(event) => {
              if (event.shiftKey) event.preventDefault();
            }}
            onClick={(event) => onSelect(asset.id, how(event))}
            onDoubleClick={() => onOpen(asset.id)}
          >
            <span className="st-cell-index" aria-hidden="true">
              {index + 1}
            </span>
            <CellMarks asset={asset} />
            <Fitted asset={asset} inset />
            <span className="st-cell-foot" aria-hidden="true">
              <Rating value={asset.rating} />
              <LabelMark label={asset.colorLabel} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Filmstrip({
  items,
  currentId,
  chosen,
  candidateId,
  onSelect,
  onOpen,
  header,
}: {
  items: readonly StudioAsset[];
  currentId: string | null;
  chosen: ReadonlySet<string>;
  candidateId: string | null;
  onSelect(id: string, how: SelectHow): void;
  onOpen(id: string): void;
  header: ReactNode;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = strip.current?.querySelector<HTMLElement>(`[data-film="${candidateId ?? currentId}"]`);
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentId, candidateId]);
  return (
    <footer className="st-film" aria-label="Filmstrip">
      <div className="st-film-head">{header}</div>
      <div className="st-film-strip" ref={strip} data-scroll-root>
        {items.map((asset, index) => (
          <button
            key={asset.id}
            type="button"
            data-film={asset.id}
            className={`st-film-cell${asset.id === currentId ? " st-film-on" : chosen.has(asset.id) ? " st-film-chosen" : ""}${asset.id === candidateId ? " st-film-candidate" : ""}${asset.published ? "" : " st-cell-draft"} st-tint-${asset.colorLabel}`}
            aria-label={`${index + 1}. ${describe(asset)}`}
            aria-current={asset.id === currentId ? "true" : undefined}
            onMouseDown={(event) => {
              if (event.shiftKey) event.preventDefault();
            }}
            onClick={(event) => onSelect(asset.id, how(event))}
            onDoubleClick={() => onOpen(asset.id)}
            tabIndex={-1}
          >
            <Fitted asset={asset} />
            <span className="st-film-foot" aria-hidden="true">
              <Rating value={asset.rating} quiet />
              {asset.colorLabel !== "none" ? <span className={`st-label st-label-${asset.colorLabel}`} /> : null}
              {asset.published && asset.pickCount ? <Heart size={10} fill="currentColor" className="st-film-heart" /> : null}
            </span>
          </button>
        ))}
      </div>
    </footer>
  );
}

function ZoomPicker({ zoom, onZoom }: { zoom: Zoom; onZoom(level: ZoomLevel): void }) {
  const levels: Array<[ZoomLevel, string]> = [
    ["fit", "Fit"],
    [1, "100%"],
    [2, "200%"],
  ];
  return (
    <div className="st-zoom-picker" role="radiogroup" aria-label="Zoom">
      {levels.map(([level, text]) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={zoom.level === level}
          className={zoom.level === level ? "st-on" : undefined}
          title={level === "fit" ? "Fit (Z)" : `${text}, click the photo to zoom here`}
          onClick={() => onZoom(level)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Loupe({
  photo,
  position,
  total,
  zoom,
  zoomTo,
  onZoom,
  onZoomLevel,
  notes,
  pinMode,
  onPinMode,
  info,
  onInfo,
  onViewport,
  canPin,
  pinHint,
}: {
  photo: StudioAsset;
  position: number;
  total: number;
  zoom: Zoom;
  zoomTo: Exclude<ZoomLevel, "fit">;
  onZoom(zoom: Zoom): void;
  onZoomLevel(level: ZoomLevel): void;
  notes: NotesState;
  pinMode: boolean;
  onPinMode(on: boolean): void;
  info: boolean;
  onInfo(): void;
  onViewport(size: { width: number; height: number }): void;
  canPin: boolean;
  pinHint: string;
}) {
  return (
    <div className="st-loupe">
      <div className="st-loupe-stage">
        <ZoomStage
          photo={photo}
          zoom={zoom}
          onZoom={onZoom}
          zoomTo={zoomTo}
          notes={notes}
          pinMode={pinMode}
          onPinned={() => onPinMode(false)}
          onViewport={onViewport}
        />
        {info ? (
          <div className="st-loupe-info" aria-hidden="true">
            <strong>{photo.title}</strong>
            <span>
              {position} of {total} · {photo.width} × {photo.height}
              {photo.rating ? ` · ${"★".repeat(photo.rating)}` : ""}
              {photo.published ? "" : " · Draft"}
            </span>
            {describeExposure(photo.capture).length ? <span>{describeExposure(photo.capture).join(" · ")}</span> : null}
          </div>
        ) : null}
        {pinMode ? <div className="st-loupe-pinhint">Click the photo where the note belongs. Esc cancels.</div> : null}
      </div>
      <div className="st-toolbar">
        <ZoomPicker zoom={zoom} onZoom={onZoomLevel} />
        <button
          type="button"
          className={`st-tool-button${pinMode ? " st-on" : ""}`}
          aria-pressed={pinMode}
          disabled={!canPin}
          title={canPin ? "Pin a note (N)" : pinHint}
          onClick={() => onPinMode(!pinMode)}
        >
          <PenLine size={14} />
          <span>Pin note</span>
        </button>
        <button type="button" className={`st-tool-button st-icon-only${info ? " st-on" : ""}`} aria-pressed={info} aria-label="Info overlay" title="Info overlay (I)" onClick={onInfo}>
          <Info size={14} />
        </button>
        <span className="st-toolbar-spacer" />
        <span className="st-toolbar-text">
          {position} of {total}
        </span>
      </div>
    </div>
  );
}

export function CompareView({
  select,
  candidate,
  active,
  onActive,
  zoom,
  zoomTo,
  onZoom,
  onZoomLevel,
  linked,
  onLinked,
  onSwap,
  onMakeSelect,
  onRate,
  onLabel,
  onViewport,
}: {
  select: StudioAsset;
  candidate: StudioAsset;
  active: "select" | "candidate";
  onActive(side: "select" | "candidate"): void;
  zoom: { select: Zoom; candidate: Zoom };
  zoomTo: Exclude<ZoomLevel, "fit">;
  onZoom(side: "select" | "candidate", zoom: Zoom): void;
  onZoomLevel(level: ZoomLevel): void;
  linked: boolean;
  onLinked(): void;
  onSwap(): void;
  onMakeSelect(): void;
  onRate(asset: StudioAsset, rating: number): void;
  onLabel(asset: StudioAsset, label: StudioAsset["colorLabel"]): void;
  onViewport(size: { width: number; height: number }): void;
}) {
  const panes = [
    { side: "select" as const, asset: select, title: "Select" },
    { side: "candidate" as const, asset: candidate, title: "Candidate" },
  ];
  return (
    <div className="st-compare">
      <div className="st-compare-panes">
        {panes.map(({ side, asset, title }) => (
          <section
            key={side}
            className={`st-pane${active === side ? " st-pane-on" : ""}`}
            aria-label={`${title}: ${describe(asset)}`}
            onFocusCapture={() => onActive(side)}
            onPointerDownCapture={() => onActive(side)}
          >
            <header className="st-pane-head">
              <span className="st-pane-role">{title}</span>
              <span className="st-pane-title">{asset.title}</span>
              <CellMarks asset={asset} />
            </header>
            <div className="st-pane-stage">
              <ZoomStage
                photo={asset}
                zoom={zoom[side]}
                onZoom={(next) => onZoom(side, next)}
                zoomTo={zoomTo}
                onActivate={() => onActive(side)}
                onViewport={active === side ? onViewport : undefined}
              />
            </div>
            <footer className="st-pane-foot">
              <StarInput value={asset.rating} onChange={(rating) => onRate(asset, rating)} label={`${title} rating`} />
              <LabelInput value={asset.colorLabel} onChange={(label) => onLabel(asset, label)} label={`${title} label`} />
            </footer>
          </section>
        ))}
      </div>
      <div className="st-toolbar">
        <ZoomPicker zoom={zoom[active]} onZoom={onZoomLevel} />
        <button type="button" className={`st-tool-button${linked ? " st-on" : ""}`} aria-pressed={linked} title="Link zoom and pan" onClick={onLinked}>
          <Lock size={13} />
          <span>Link</span>
        </button>
        <span className="st-toolbar-spacer" />
        <button type="button" className="st-tool-button" title="Swap select and candidate (X)" onClick={onSwap}>
          <SwapGlyph size={14} />
          <span>Swap</span>
        </button>
        <button type="button" className="st-tool-button" title="Make the candidate the select (↑)" onClick={onMakeSelect}>
          <span>Make select</span>
        </button>
      </div>
    </div>
  );
}
