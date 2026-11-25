import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  Copy,
  Download,
  Heart,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "dohc/icons";
import { copyText } from "dohc/app";
import { describeExposure } from "./camera";
import {
  formatBytes,
  formatDay,
  type ColorLabel,
  type Shoot,
  type StudioAsset,
} from "./portal/api";
import { CloseGlyph } from "./portal/glyphs";
import { NoteRail, type NotesState } from "./portal/notes";
import { Photo, useSize } from "./portal/photo";
import { useToast } from "./portal/toast";
import {
  Histogram,
  LABEL_TITLES,
  LabelInput,
  STATUS_TEXT,
  STUDIO_FILES,
  Section,
  StarInput,
  StatusMark,
  aspect,
  fileName,
  formatCode,
  plural,
  wideScreen,
  type Library,
  type Zoom,
} from "./studio-parts";

const STATUSES = ["draft", "proofing", "delivered"] as const;

function SheetHead({ title, onClose }: { title: string; onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <div className="st-sheet-head">
      <strong>{title}</strong>
      <button
        type="button"
        className="st-mini"
        aria-label={`Close ${title.toLowerCase()}`}
        title="Close"
        onClick={onClose}
      >
        <CloseGlyph size={14} />
      </button>
    </div>
  );
}

function Navigator({
  photo,
  zoom,
  viewport,
  onZoom,
}: {
  photo: StudioAsset | null;
  zoom: Zoom;
  viewport: { width: number; height: number };
  onZoom(zoom: Zoom): void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const size = useSize(box);
  if (!photo || !size.width || !size.height) return <div className="st-navigator" ref={box} />;
  const ratio = photo.width / photo.height;
  const frame =
    size.width / size.height > ratio
      ? { width: size.height * ratio, height: size.height }
      : { width: size.width, height: size.width / ratio };
  const fitScale =
    viewport.width && viewport.height
      ? Math.min(viewport.width / photo.width, viewport.height / photo.height)
      : 0;
  const scale = zoom.level === "fit" ? fitScale : Math.max(fitScale, zoom.level);
  const shownW = scale ? Math.min(1, viewport.width / (photo.width * scale)) : 1;
  const shownH = scale ? Math.min(1, viewport.height / (photo.height * scale)) : 1;
  const zoomed = shownW < 1 || shownH < 1;
  const centerX = Math.min(1 - shownW / 2, Math.max(shownW / 2, zoom.x));
  const centerY = Math.min(1 - shownH / 2, Math.max(shownH / 2, zoom.y));
  const aim = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    onZoom({ level: zoom.level === "fit" ? 1 : zoom.level, x, y });
  };
  const rect: CSSProperties = {
    left: `${(centerX - shownW / 2) * 100}%`,
    top: `${(centerY - shownH / 2) * 100}%`,
    width: `${shownW * 100}%`,
    height: `${shownH * 100}%`,
  };
  return (
    <div className="st-navigator" ref={box}>
      <div
        className="st-navigator-frame"
        style={frame}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          aim(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) aim(event);
        }}
        title="Click or drag to look at this spot"
      >
        <Photo photo={photo} access={STUDIO_FILES} size="thumb" />
        {zoomed ? <span className="st-navigator-rect" style={rect} /> : null}
      </div>
    </div>
  );
}

export function LibraryRail({
  shoots,
  shoot,
  onShoot,
  onNewShoot,
  counts,
  library,
  onLibrary,
  minRating,
  onMinRating,
  labelFilter,
  onLabelFilter,
  current,
  zoom,
  viewport,
  onZoom,
  onStatus,
  onFinalPicks,
  onSettings,
  onRefresh,
  onClose,
}: {
  shoots: readonly Shoot[];
  shoot: Shoot;
  onShoot(id: string): void;
  onNewShoot(): void;
  counts: Record<Library, number>;
  library: Library;
  onLibrary(library: Library): void;
  minRating: number;
  onMinRating(rating: number): void;
  labelFilter: ColorLabel | null;
  onLabelFilter(label: ColorLabel | null): void;
  current: StudioAsset | null;
  zoom: Zoom;
  viewport: { width: number; height: number };
  onZoom(zoom: Zoom): void;
  onStatus(status: Shoot["status"]): void;
  onFinalPicks(): void;
  onSettings(): void;
  onRefresh(): void;
  onClose?: () => void;
}) {
  const toast = useToast();
  const [selectingCode, setSelectingCode] = useState(false);
  const libraries: Array<[Library, string]> = [
    ["all", "All photographs"],
    ["picks", "Client picks"],
    ["annotated", "Annotated"],
    ["drafts", "Drafts"],
  ];
  const code = formatCode(shoot.accessCode);
  return (
    <nav className="st-left" aria-label="Library">
      <SheetHead title="Library" onClose={onClose} />
      <Section title="Navigator">
        <Navigator photo={current} zoom={zoom} viewport={viewport} onZoom={onZoom} />
      </Section>
      <Section
        title="Shoots"
        action={
          <span className="st-section-actions">
            <button
              type="button"
              className="st-mini"
              id="refresh-shoot"
              aria-label="Refresh"
              title="Refresh"
              onClick={onRefresh}
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              className="st-mini"
              id="new-shoot"
              aria-label="New shoot"
              title="New shoot"
              onClick={onNewShoot}
            >
              <Plus size={13} />
            </button>
          </span>
        }
      >
        <ul className="st-list">
          {shoots.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`st-row${item.id === shoot.id ? " st-row-on" : ""}`}
                aria-current={item.id === shoot.id ? "true" : undefined}
                onClick={() => onShoot(item.id)}
                title={`${item.title}, ${STATUS_TEXT[item.status]}`}
              >
                <StatusMark status={item.status} />
                <span className="st-row-text">{item.title}</span>
                <span className="st-row-count">{item.assetCount}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Library">
        <ul className="st-list" role="radiogroup" aria-label="Library">
          {libraries.map(([id, text]) => (
            <li key={id}>
              <button
                type="button"
                role="radio"
                aria-checked={library === id}
                className={`st-row${library === id ? " st-row-on" : ""}`}
                onClick={() => onLibrary(id)}
              >
                <span className="st-row-text">{text}</span>
                <span className="st-row-count">{counts[id]}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="st-filter-row">
          <span className="st-filter-label">Rating</span>
          <StarInput value={minRating} onChange={onMinRating} label="Minimum rating" />
          <span className="st-filter-hint">{minRating ? `${minRating}+` : "Any"}</span>
        </div>
        <div className="st-filter-row">
          <span className="st-filter-label">Label</span>
          <LabelInput
            value={labelFilter ?? "none"}
            onChange={(label) => onLabelFilter(label === "none" ? null : label)}
            label="Show label"
          />
          <span className="st-filter-hint">{labelFilter ? LABEL_TITLES[labelFilter] : "Any"}</span>
        </div>
      </Section>
      <Section title="Client gallery">
        <div className="st-status-picker" role="radiogroup" aria-label="Gallery status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="radio"
              aria-checked={shoot.status === status}
              className={shoot.status === status ? "st-on" : undefined}
              onClick={() => shoot.status !== status && onStatus(status)}
            >
              <StatusMark status={status} />
              {STATUS_TEXT[status]}
            </button>
          ))}
        </div>
        <div className="st-code">
          <span className="st-filter-label">Code</span>
          {selectingCode ? (
            <input
              id="gallery-code-value"
              className="st-code-value st-code-input"
              readOnly
              value={code}
              aria-label="Gallery code"
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => setSelectingCode(false)}
            />
          ) : (
            <span className="st-code-value" id="gallery-code-value">
              {code}
            </span>
          )}
          <button
            type="button"
            className="st-mini"
            aria-label="Copy gallery code"
            title="Copy gallery code"
            onClick={() =>
              void copyText(code).then(
                () => toast("Gallery code copied."),
                () => {
                  setSelectingCode(true);
                  toast("Selected the code. Press Ctrl+C or Cmd+C to copy it.");
                },
              )
            }
          >
            <Copy size={12} />
          </button>
        </div>
        <dl className="st-facts">
          <dt>Picked</dt>
          <dd>
            {shoot.pickedAssetCount} of {shoot.publishedCount} published
          </dd>
          <dt>Reviewers</dt>
          <dd>
            {shoot.reviewerCount}, up to {shoot.selectionLimit} picks each
          </dd>
          <dt>Sent</dt>
          <dd>
            {shoot.sentCount
              ? `${shoot.sentCount} of ${plural(shoot.reviewerCount, "reviewer")}`
              : "None yet"}
          </dd>
          <dt>Notes</dt>
          <dd>
            {shoot.openNoteCount} open of {shoot.noteCount}
          </dd>
        </dl>
        <div className="st-rail-actions">
          <button type="button" className="st-tool-button" id="export-picks" onClick={onFinalPicks}>
            <Download size={13} />
            <span>Final picks</span>
          </button>
          <button
            type="button"
            className="st-tool-button"
            title="Shoot settings"
            onClick={onSettings}
          >
            <Settings size={13} />
            <span>Settings</span>
          </button>
        </div>
      </Section>
    </nav>
  );
}

export function Inspector({
  asset,
  shoot,
  position,
  total,
  notes,
  onRate,
  onLabel,
  onPublish,
  onDelete,
  pinHint,
  onClose,
  selection,
}: {
  asset: StudioAsset | null;
  shoot: Shoot;
  position: number;
  total: number;
  notes: NotesState | null;
  onRate(rating: number): void;
  onLabel(label: ColorLabel): void;
  onPublish(): void;
  onDelete(): void;
  pinHint: string;
  onClose?: () => void;
  selection: readonly StudioAsset[];
}) {
  if (!asset)
    return (
      <aside className="st-right" aria-label="Inspector">
        <SheetHead title="Inspector" onClose={onClose} />
        <p className="st-right-empty">Select a photo to see its details.</p>
      </aside>
    );
  const count = selection.length;
  const sumOf = (key: "pickCount" | "noteCount" | "openNoteCount") =>
    (count > 1 ? selection : [asset]).reduce((sum, item) => sum + item[key], 0);
  const picks = sumOf("pickCount");
  const noteTotal = sumOf("noteCount");
  const openTotal = sumOf("openNoteCount");
  const shared = <K extends "rating" | "colorLabel" | "published">(key: K): StudioAsset[K] | null =>
    selection.every((item) => item[key] === asset[key]) ? asset[key] : null;
  const rating = shared("rating");
  const colorLabel = shared("colorLabel");
  const published = shared("published");
  const mixed = <span className="st-mixed">Mixed</span>;
  return (
    <aside className="st-right" aria-label="Inspector">
      <SheetHead title="Inspector" onClose={onClose} />
      <Section title="Histogram" open={wideScreen()}>
        <Histogram photo={asset} access={STUDIO_FILES} />
        <div className="st-capture">
          <span>
            {asset.width} × {asset.height}
          </span>
          <span>{aspect(asset)}</span>
          <span>{asset.fileId ? formatBytes(asset.byteLength) : "Sample"}</span>
        </div>
        {describeExposure(asset.capture).length ? (
          <div className="st-exposure" aria-label="Camera settings">
            {describeExposure(asset.capture).map((part) => (
              <span key={part}>{part}</span>
            ))}
          </div>
        ) : null}
        {asset.capture.camera || asset.capture.lens ? (
          <div className="st-camera">
            {[asset.capture.camera, asset.capture.lens].filter(Boolean).join(" · ")}
          </div>
        ) : null}
      </Section>
      <Section title="Photo">
        <div className="st-meta-title">
          <strong>{fileName(asset)}</strong>
          <span>
            {position} of {total} · {formatDay(shoot.shotOn)}
          </span>
        </div>
        {count > 1 ? <p className="st-batch">Changes apply to {count} photos.</p> : null}
        <div className="st-field-row">
          <span className="st-filter-label">Rating</span>
          <StarInput value={rating} onChange={onRate} />
          {rating === null ? mixed : null}
        </div>
        <div className="st-field-row">
          <span className="st-filter-label">Label</span>
          <LabelInput value={colorLabel} onChange={onLabel} />
          {colorLabel === null ? mixed : null}
        </div>
        <div className="st-field-row">
          <span className="st-filter-label" id="publish-label">
            Client
          </span>
          <button
            type="button"
            role={published === null ? "checkbox" : "switch"}
            id="publish-toggle"
            aria-checked={published ?? "mixed"}
            aria-labelledby="publish-label publish-state"
            className={`st-switch${published ? " st-on" : ""}${published === null ? " st-switch-mixed" : ""}`}
            title="Show in the client gallery (P)"
            onClick={onPublish}
          >
            <span className="st-switch-knob" />
          </button>
          <span className="st-switch-text" id="publish-state">
            {published === null ? "Some in the gallery" : published ? "In the gallery" : "Draft"}
          </span>
        </div>
        <div className="st-client-facts">
          <span className={picks ? "st-fact-on" : undefined}>
            <Heart size={12} fill={picks ? "currentColor" : "none"} />
            {count > 1
              ? `${picks ? plural(picks, "client pick") : "No client picks"} across ${count} photos`
              : picks
                ? `Picked by ${plural(picks, "reviewer")}`
                : "No client picks"}
          </span>
          <span>
            <MessageSquare size={12} />
            {noteTotal ? `${plural(noteTotal, "note")}, ${openTotal} open` : "No notes"}
            {count > 1 ? ` across ${count} photos` : ""}
          </span>
        </div>
      </Section>
      <section className="st-section st-notes-section">
        {notes ? <NoteRail notes={notes} hint={pinHint} /> : null}
      </section>
      <div className="st-right-foot">
        <button type="button" className="st-tool-button st-quiet-danger" onClick={onDelete}>
          <Trash2 size={13} />
          <span>{count > 1 ? `Delete ${count} photos` : "Delete photo"}</span>
        </button>
      </div>
    </aside>
  );
}
