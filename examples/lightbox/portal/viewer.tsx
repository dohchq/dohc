import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApp } from "dohc/app";
import { ChevronLeft, ChevronRight, Download, Heart, MessageSquare } from "dohc/icons";
import { acquirePhotoFileUrl, errorMessage, isTyping, refusalCode, type ClientAsset, type PhotoFileLease } from "./api";
import { CloseGlyph, CompareGlyph, SwapGlyph } from "./glyphs";
import { NoteRail, Pins, pointOn, useNotes, type NoteRules, type NotesState } from "./notes";
import { Photo, fit, useSize, type FileAccess } from "./photo";
import { sceneUrl } from "./scenes";
import { ToastStack, useToast } from "./toast";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function wideScreen() {
  try {
    return window.matchMedia("(min-width: 960px)").matches;
  } catch {
    return true;
  }
}

function Canvas({ photo, access, notes }: { photo: ClientAsset; access: FileAccess; notes: NotesState | null }) {
  const box = useRef<HTMLDivElement | null>(null);
  const size = fit(photo, useSize(box));
  const pinnable = Boolean(notes?.canPin);
  return (
    <div className="pt-stage-box" ref={box} style={{ ["--pt-ratio" as string]: String(photo.width / photo.height) }}>
      <div
        className={`pt-canvas${pinnable ? " pt-canvas-pin" : ""}`}
        style={{ width: size.width, height: size.height }}
        onClick={(event) => {
          if (!notes || !pinnable) return;
          const point = pointOn(event, event.currentTarget);
          if (point) notes.setDraft(point);
        }}
      >
        <Photo photo={photo} access={access} size="full" className="pt-canvas-photo" />
        {notes ? <Pins notes={notes} /> : null}
      </div>
    </div>
  );
}

function HeartToggle({ asset, closed, onPick, id }: { asset: ClientAsset; closed: boolean; onPick(asset: ClientAsset): void; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      className={`pt-heart-toggle${asset.picked ? " pt-on" : ""}`}
      aria-pressed={asset.picked}
      aria-label={asset.picked ? `Remove ${asset.title} from favorites` : `Add ${asset.title} to favorites`}
      title={closed ? "Favorites are closed" : asset.picked ? "Remove from favorites (Space)" : "Add to favorites (Space)"}
      disabled={closed}
      onClick={() => onPick(asset)}
    >
      <Heart size={16} fill={asset.picked ? "currentColor" : "none"} />
      <span>{asset.picked ? "Favorited" : "Favorite"}</span>
    </button>
  );
}

export function Viewer({
  items,
  index,
  compare,
  onView,
  onClose,
  access,
  rules,
  closed,
  onPick,
  picksLabel,
  onRefused,
}: {
  items: readonly ClientAsset[];
  index: number;
  compare: number | null;
  onView(index: number, compare: number | null): void;
  onClose(): void;
  access: FileAccess;
  rules: NoteRules;
  closed: boolean;
  onPick(asset: ClientAsset): void;
  picksLabel: string;
  onRefused(): void;
}) {
  const photo = items[index]!;
  const [railOpen, setRailOpen] = useState(wideScreen);
  const root = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const swipe = useRef<{ x: number; y: number; done: boolean } | null>(null);
  const candidate = compare !== null ? items[compare] : undefined;
  const notes = useNotes(photo, rules, !candidate);
  const client = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (asset: ClientAsset) => {
    setSaving(true);
    let lease: PhotoFileLease | null = null;
    try {
      lease = asset.fileId ? acquirePhotoFileUrl(client, asset.fileId, access.operation, access.input(asset), asset.mimeType, "high") : null;
      const url = lease ? await lease.promise : await sceneUrl(asset.demoScene ?? "village:1", asset.width, asset.height, Math.max(asset.width, asset.height));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${asset.title}.${asset.fileId ? (EXTENSIONS[asset.mimeType] ?? "jpg") : "jpg"}`;
      link.click();
    } catch (error) {
      const refused = refusalCode(error);
      if (refused) onRefused();
      toast(`Could not download ${asset.title}. ${errorMessage(error)}`, { tone: "danger", retry: refused ? undefined : () => void save(asset) });
    } finally {
      const held = lease;
      if (held) setTimeout(() => held.release(), 1000);
      setSaving(false);
    }
  };

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    const others = [...(root.current?.parentElement?.children ?? [])].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root.current && !element.inert);
    for (const element of others) element.inert = true;
    return () => {
      for (const element of others) element.inert = false;
      opener.current?.focus();
    };
  }, []);

  useEffect(() => {
    const element = root.current;
    if (element && !element.contains(document.activeElement)) element.focus();
  });

  useEffect(() => {
    if (notes.draft || notes.selected) setRailOpen(true);
  }, [notes.draft, notes.selected]);

  const stepCandidate = (from: number, delta: -1 | 1): number | null => {
    let next = from + delta;
    if (next === index) next += delta;
    return next >= 0 && next < items.length ? next : null;
  };
  const step = (delta: -1 | 1) => {
    if (compare !== null) {
      const next = stepCandidate(compare, delta);
      if (next !== null) onView(index, next);
    } else if (index + delta >= 0 && index + delta < items.length) onView(index + delta, null);
  };
  const canPrev = compare !== null ? stepCandidate(compare, -1) !== null : index > 0;
  const canNext = compare !== null ? stepCandidate(compare, 1) !== null : index < items.length - 1;
  const toggleCompare = () => {
    if (items.length < 2) return;
    onView(index, compare === null ? (index + 1 < items.length ? index + 1 : index - 1) : null);
  };
  const swap = () => {
    if (compare !== null) onView(compare, index);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab" && root.current) {
      const focusable = [
        ...root.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last) {
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const onControl = event.target instanceof HTMLElement && Boolean(event.target.closest("button"));
    if (onControl && (event.key === " " || event.key === "Enter")) return;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      if (notes.draft) notes.setDraft(null);
      else if (compare !== null) onView(index, null);
      else onClose();
    } else if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (key === "c") toggleCompare();
    else if (key === "x" && compare !== null) swap();
    else if (key === "i" && compare === null) setRailOpen((value) => !value);
    else if (key === "d" && closed && compare === null && !saving) void save(photo);
    else if (key === "n" && compare === null && notes.canPin) notes.setDraft({ xPct: 50, yPct: 50 });
    else if ((event.key === " " || key === "h") && !closed) onPick(candidate ?? photo);
    else return;
    event.preventDefault();
  };

  const openCount = (notes.list ?? []).filter((note) => !note.resolved).length;
  return (
    <div
      className={`pt-viewer${candidate ? " pt-viewer-compare" : ""}${railOpen && !candidate ? " pt-viewer-rail" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={candidate ? `Comparing ${photo.title} and ${candidate.title}` : `${photo.title}, photo ${index + 1} of ${items.length}`}
      tabIndex={-1}
      ref={root}
      onKeyDown={keyDown}
    >
      <header className="pt-viewer-bar">
        <div className="pt-viewer-where">
          <span className="pt-viewer-count">
            {candidate ? "Compare" : `${index + 1} / ${items.length}`}
          </span>
          <span className="pt-viewer-title">{candidate ? `${photo.title}  ·  ${candidate.title}` : photo.title}</span>
        </div>
        <div className="pt-viewer-tools">
          {closed ? null : (
            <span className="pt-viewer-picks" aria-label={picksLabel}>
              <Heart className="pt-viewer-picks-heart" size={12} strokeWidth={2} aria-hidden="true" />
              {picksLabel.replace(/ selected$/, "")}
              <span className="pt-viewer-picks-word" aria-hidden="true">
                {" "}
                selected
              </span>
            </span>
          )}
          {candidate || closed ? null : <HeartToggle asset={photo} closed={closed} onPick={onPick} id="pick-toggle" />}
          {closed && !candidate ? (
            <button
              type="button"
              id="photo-download"
              className="pt-tool pt-tool-label"
              aria-label={`Download ${photo.title}`}
              title="Download this photo (D)"
              disabled={saving}
              onClick={() => void save(photo)}
            >
              <Download size={16} />
              <span>{saving ? "Downloading…" : "Download"}</span>
            </button>
          ) : null}
          {candidate ? (
            <button type="button" className="pt-tool" aria-label="Swap sides" title="Swap sides (X)" onClick={swap}>
              <SwapGlyph size={18} />
            </button>
          ) : null}
          <button
            type="button"
            id="compare-toggle"
            className={`pt-tool${candidate ? " pt-tool-on" : ""}`}
            aria-pressed={Boolean(candidate)}
            aria-label="Compare side by side"
            title="Compare side by side (C)"
            disabled={items.length < 2}
            onClick={toggleCompare}
          >
            <CompareGlyph size={18} />
          </button>
          {candidate ? null : (
            <button
              type="button"
              className={`pt-tool pt-notes-tool${railOpen ? " pt-tool-on" : ""}`}
              aria-pressed={railOpen}
              aria-label={`Notes, ${openCount} open`}
              title="Notes (I)"
              onClick={() => setRailOpen((value) => !value)}
            >
              <MessageSquare size={18} />
              {notes.list?.length ? <span className="pt-tool-count">{notes.list.length}</span> : null}
            </button>
          )}
          <button type="button" id="inspector-close" className="pt-tool" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <CloseGlyph size={18} />
          </button>
        </div>
      </header>
      <div className="pt-viewer-body">
        {candidate ? (
          <div className="pt-compare">
            {[photo, candidate].map((asset, side) => (
              <figure key={side} className="pt-compare-pane">
                <Canvas photo={asset} access={access} notes={null} />
                <figcaption>
                  <span>{asset.title}</span>
                  {closed ? null : <HeartToggle asset={asset} closed={closed} onPick={onPick} />}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div
            className="pt-stage"
            onPointerDown={(event) => {
              swipe.current = event.pointerType === "touch" ? { x: event.clientX, y: event.clientY, done: false } : null;
            }}
            onPointerUp={(event) => {
              const start = swipe.current;
              if (!start) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
              start.done = true;
              step(dx < 0 ? 1 : -1);
            }}
            onClickCapture={(event) => {
              if (!swipe.current?.done) return;
              swipe.current = null;
              event.stopPropagation();
              event.preventDefault();
            }}
          >
            <Canvas photo={photo} access={access} notes={notes} />
          </div>
        )}
        <button type="button" className="pt-edge pt-edge-prev" aria-label="Previous photo" title="Previous (←)" disabled={!canPrev} onClick={() => step(-1)}>
          <ChevronLeft size={22} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className={`pt-edge pt-edge-next${railOpen && !candidate ? " pt-edge-rail" : ""}`}
          aria-label="Next photo"
          title="Next (→)"
          disabled={!canNext}
          onClick={() => step(1)}
        >
          <ChevronRight size={22} strokeWidth={1.5} />
        </button>
        {!candidate && railOpen ? (
          <aside className="pt-rail">
            <NoteRail
              notes={notes}
              hint={
                <>
                  <span className="pt-hint-pointer">
                    Click anywhere on the photo to pin a note there. <kbd>N</kbd> pins one in the center.
                  </span>
                  <span className="pt-hint-touch">Tap anywhere on the photo to pin a note there.</span>
                </>
              }
            />
          </aside>
        ) : null}
      </div>
      <ToastStack />
    </div>
  );
}
