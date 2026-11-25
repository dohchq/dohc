import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, type AppClient } from "dohc/app";
import { CircleHelp, Image, Info, Menu, Upload } from "dohc/icons";
import {
  errorMessage,
  refusalCode,
  formatBytes,
  formatDay,
  invoke,
  isTyping,
  loadPages,
  revokePhotoFileUrl,
  type Paged,
  useLoader,
  UPLOAD_LIMIT_BYTES,
  type ColorLabel,
  type Note,
  type PhotoSource,
  type Shoot,
  type StudioAsset,
} from "./portal/api";
import { ApertureGlyph, CompareGlyph, GridGlyph, LoupeGlyph, PanelGlyph } from "./portal/glyphs";
import { useNotes, type NoteRules } from "./portal/notes";
import { samplePhoto } from "./portal/scenes";
import { ToastProvider, ToastStack, useToast } from "./portal/toast";
import { DeleteDialog, FinalPicks, ShootForm, Shortcuts } from "./studio-dialogs";
import { Inspector, LibraryRail } from "./studio-panels";
import {
  BATCH,
  FIT,
  LABEL_KEYS,
  LABEL_TITLES,
  LabelInput,
  STUDIO_FILES,
  StarInput,
  UNDO_KEY,
  fileName,
  names,
  useWide,
  wideScreen,
  plural,
  type Library,
  type Mode,
  type Zoom,
  type ZoomLevel,
} from "./studio-parts";
import { CompareView, Filmstrip, GridView, Loupe } from "./studio-views";
import { useUploads } from "./studio-uploads";
import { useAssetWrites } from "./studio-writes";
import "./portal/base.css";
import "./studio.css";

const NO_PHOTO: PhotoSource = { id: "", title: "", fileId: null, previewFileId: null, demoScene: null, width: 3, height: 2 };

type Dialog = { kind: "settings" } | { kind: "picks" } | { kind: "shortcuts" } | { kind: "delete"; assets: readonly StudioAsset[] } | null;
type Side = "select" | "candidate";


const LIMIT_TEXT = `JPEG, PNG, or WebP up to ${formatBytes(UPLOAD_LIMIT_BYTES)} each.`;

function matches(asset: StudioAsset, library: Library) {
  if (library === "picks") return asset.published && asset.pickCount > 0;
  if (library === "annotated") return asset.noteCount > 0;
  if (library === "drafts") return !asset.published;
  return true;
}

function Workspace({
  shoot,
  shoots,
  onChoose,
  onSaved,
  onNewShoot,
  onRefreshShoots,
}: {
  shoot: Shoot;
  shoots: readonly Shoot[];
  onChoose(id: string): void;
  onSaved(shoot?: Shoot): void;
  onNewShoot(): void;
  onRefreshShoots(): void;
}) {
  const client = useApp();
  const toast = useToast();
  const assets = useLoader(`assets:${shoot.id}`, (app) =>
    loadPages(app, "studioAssets", { shootId: shoot.id }, (page: Paged<"assets", StudioAsset>) => page.assets).then(({ items }) => items),
  );
  const [mode, setMode] = useState<Mode>("grid");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [active, setActive] = useState<Side>("select");
  const [library, setLibrary] = useState<Library>("all");
  const [minRating, setMinRating] = useState(0);
  const [labelFilter, setLabelFilter] = useState<ColorLabel | null>(null);
  const clearFilters = () => {
    setLibrary("all");
    setMinRating(0);
    setLabelFilter(null);
  };
  const wide = useWide();
  const [cellSize, setCellSize] = useState(() => (wideScreen() ? 140 : 112));
  const [columns, setColumns] = useState(4);
  const [zoom, setZoom] = useState<Zoom>(FIT);
  const [candidateZoom, setCandidateZoom] = useState<Zoom>(FIT);
  const [linked, setLinked] = useState(true);
  const [zoomTo, setZoomTo] = useState<1 | 2>(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [info, setInfo] = useState(wideScreen);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dragging, setDragging] = useState(false);
  const [hud, setHud] = useState<{ id: number; text: string; undo: boolean } | null>(null);
  const [panels, setPanels] = useState({ left: wide, right: wide });
  const fileInput = useRef<HTMLInputElement | null>(null);
  const hudId = useRef(0);
  const refocused = useRef(false);
  const flash = (text: string, undo = false) => setHud({ id: ++hudId.current, text, undo });
  const { uploads, addFiles } = useUploads(shoot.id, assets, () => onSaved());
  const { all, saving, rate, label, publish, toggleLabel, undoLast } = useAssetWrites({
    assets,
    flash,
    onSaved: () => onSaved(),
    beforeChange: (list, next) => stepAway(list, next),
  });

  useEffect(() => setPanels({ left: wide, right: wide }), [wide]);
  useEffect(() => {
    if (mode !== "grid") setChosen([]);
  }, [mode]);

  const inLibrary = all.filter((asset) => matches(asset, library));
  const shown = inLibrary.filter((asset) => asset.rating >= minRating && (!labelFilter || asset.colorLabel === labelFilter));
  const shownKey = shown.map((asset) => asset.id).join(" ");
  const shownBefore = useRef<string[]>([]);
  const chosenNow = useRef(chosen);
  chosenNow.current = chosen;
  useEffect(() => {
    const ids = shownKey ? shownKey.split(" ") : [];
    const visible = new Set(ids);
    const before = shownBefore.current;
    shownBefore.current = ids;
    const keepsChosen = chosenNow.current.some((id) => visible.has(id));
    setChosen((list) => (list.every((id) => visible.has(id)) ? list : list.filter((id) => visible.has(id))));
    setCurrentId((id) => {
      if (!id || visible.has(id)) return id;
      if (keepsChosen) return null;
      const at = before.indexOf(id);
      return before.slice(at + 1).find((other) => visible.has(other)) ?? before.slice(0, Math.max(at, 0)).findLast((other) => visible.has(other)) ?? null;
    });
  }, [shownKey]);
  const chosenSet = new Set(chosen);
  const current = shown.find((asset) => asset.id === currentId) ?? shown.find((asset) => chosenSet.has(asset.id)) ?? shown[0] ?? null;
  const position = current ? shown.indexOf(current) + 1 : 0;
  const candidate =
    mode === "compare" && current
      ? (shown.find((asset) => asset.id === candidateId && asset.id !== current.id) ?? shown[position] ?? shown[position - 2] ?? null)
      : null;
  const comparing = mode === "compare" && candidate !== null;
  const target = comparing && active === "candidate" ? candidate : current;
  const chosenIds = new Set(shown.flatMap((asset) => (chosenSet.has(asset.id) ? [asset.id] : [])));
  const selection =
    mode === "grid" && current && chosenIds.has(current.id) && chosenIds.size > 1 ? shown.filter((asset) => chosenIds.has(asset.id)) : target ? [target] : [];
  const pinMode = mode === "loupe" && pinFor !== null && pinFor === current?.id;
  const setPinMode = (on: boolean) => setPinFor(on && current ? current.id : null);
  const drafts = all.filter((asset) => !asset.published);
  const counts: Record<Library, number> = {
    all: all.length,
    picks: all.filter((asset) => matches(asset, "picks")).length,
    annotated: all.filter((asset) => matches(asset, "annotated")).length,
    drafts: drafts.length,
  };

  const closedReason = !target
    ? undefined
    : shoot.status !== "proofing"
      ? "Notes open while the gallery is in proofing."
      : !target.published
        ? "Publish this photo to pin notes the client can see."
        : undefined;

  const noteRules: NoteRules = {
    load: async (photo) => (await loadPages(client, "studioAnnotations", { assetId: photo.id }, (page: Paged<"annotations", Note>) => page.annotations)).items,
    resolve: async (note, resolved) => {
      await invoke(client, "resolveAnnotation", { annotationId: note.id, resolved });
    },
    authorName: "Photographer",
    add: (photo, draft, key) =>
      invoke<Note>(client, "addPinnedAnnotation", { code: shoot.accessCode, assetId: photo.id, ...draft }, `addPinnedAnnotation:${key}`),
    update: (note, body) => invoke<Note>(client, "updateOwnNote", { code: shoot.accessCode, annotationId: note.id, body }),
    remove: async (note) => {
      await invoke(client, "deleteOwnNote", { code: shoot.accessCode, annotationId: note.id });
    },
    restore: (note) => invoke<Note>(client, "restoreOwnNote", { code: shoot.accessCode, annotationId: note.id }),
    counted: (assetId, counts) => {
      const asset = assets.data?.find((item) => item.id === assetId);
      if (!asset || (asset.noteCount === counts.noteCount && asset.openNoteCount === counts.openNoteCount)) return;
      assets.replace((list) => list.map((item) => (item.id === assetId ? { ...item, ...counts } : item)));
      onSaved();
    },
    closedReason,
  };
  const notes = useNotes(target ?? NO_PHOTO, noteRules, Boolean(target));
  useEffect(() => {
    if (notes.draft || notes.selected) setPanels((value) => (wideScreen() ? { ...value, right: true } : { left: false, right: true }));
  }, [notes.draft, notes.selected]);
  useEffect(() => {
    if (mode === "compare" && shown.length < 2) setMode(shown.length ? "loupe" : "grid");
  }, [mode, shown.length]);
  const pinHint =
    closedReason ??
    (mode === "compare"
      ? "Switch to Loupe (E) to pin a note."
      : !wide
        ? mode === "grid"
          ? "Open this photo in Loupe to pin a note."
          : "Use Pin note, then tap the photo where the note belongs."
        : mode === "grid"
          ? "Press N to open this photo in Loupe and pin a note."
          : "Press N or use Pin note, then click the photo.");

  useEffect(() => {
    if (!hud) return;
    const timer = setTimeout(() => setHud(null), hud.undo ? 3200 : 1200);
    return () => clearTimeout(timer);
  }, [hud]);

  const visible = (asset: StudioAsset) => matches(asset, library) && asset.rating >= minRating && (!labelFilter || asset.colorLabel === labelFilter);

  const stepAway = (list: readonly StudioAsset[], next: Partial<StudioAsset>) => {
    if (comparing || !current || !list.some((asset) => asset.id === current.id) || visible({ ...current, ...next })) return;
    const leaving = new Set(list.map((asset) => asset.id));
    const stays = (asset: StudioAsset) => !leaving.has(asset.id) || visible({ ...asset, ...next });
    const at = shown.indexOf(current);
    const after = shown.slice(at + 1).find(stays) ?? shown.slice(0, at).reverse().find(stays);
    if (!after) return;
    focus(after.id);
    refocused.current = true;
  };

  const remove = async (list: readonly StudioAsset[]) => {
    setDialog(null);
    const gone = new Set<string>();
    const after = current && list.some((asset) => asset.id === current.id) ? shown.slice(shown.indexOf(current)) : [];
    const before = current ? shown.slice(0, shown.indexOf(current)).reverse() : [];
    try {
      for (let start = 0; start < list.length; start += BATCH) {
        const chunk = list.slice(start, start + BATCH);
        await invoke(client, "deleteAssets", { assetIds: chunk.map((asset) => asset.id) });
        for (const asset of chunk) {
          gone.add(asset.id);
          for (const fileId of [asset.fileId, asset.previewFileId]) if (fileId) revokePhotoFileUrl(STUDIO_FILES.operation, fileId);
        }
      }
      flash(`Deleted ${names(list)}`);
    } catch (error) {
      const left = list.filter((asset) => !gone.has(asset.id));
      toast(`Could not delete ${names(left)}. ${errorMessage(error)}`, { tone: "danger", retry: refusalCode(error) ? undefined : () => void remove(left) });
    }
    if (!gone.size) return;
    const next = [...after, ...before].find((asset) => !gone.has(asset.id));
    assets.replace((items) => items.filter((item) => !gone.has(item.id)));
    setChosen((ids) => ids.filter((id) => !gone.has(id)));
    if (next && after.length) focus(next.id);
    onSaved();
  };

  const setStatus = async (status: Shoot["status"]) => {
    try {
      onSaved(await invoke<Shoot>(client, "updateShoot", { shootId: shoot.id, status }));
      toast(
        status === "proofing"
          ? "The gallery is open. Send the client the gallery code."
          : status === "delivered"
            ? "Delivered. The client can still look, but picks and notes are closed."
            : "Back to draft. The client gallery is closed.",
      );
    } catch (error) {
      toast(errorMessage(error), { tone: "danger", retry: refusalCode(error) ? undefined : () => void setStatus(status) });
    }
  };

  const focus = (id: string) => {
    setCurrentId(id);
    setChosen([id]);
    setAnchorId(id);
  };
  const select = (id: string, how: { toggle: boolean; range: boolean } = { toggle: false, range: false }) => {
    if (how.range && current) {
      const anchor = shown.findIndex((asset) => asset.id === anchorId);
      const from = anchor >= 0 ? anchor : shown.indexOf(current);
      const to = shown.findIndex((asset) => asset.id === id);
      const [low, high] = from < to ? [from, to] : [to, from];
      setChosen(shown.slice(low, high + 1).map((asset) => asset.id));
      setCurrentId(id);
    } else if (how.toggle) {
      const base = chosen.length ? chosen : current ? [current.id] : [];
      if (base.includes(id) && base.length > 1) {
        const rest = base.filter((item) => item !== id);
        setChosen(rest);
        if (id === current?.id) setCurrentId(rest[rest.length - 1]!);
      } else {
        setChosen([...base.filter((item) => item !== id), id]);
        setCurrentId(id);
        setAnchorId(id);
      }
    } else focus(id);
  };
  const openLoupe = (id = comparing && active === "candidate" ? candidate?.id : undefined) => {
    if (id) focus(id);
    if (comparing && active === "candidate") setZoom(candidateZoom);
    if (shown.length) setMode("loupe");
  };
  const sideZoom = (side: Side, next: Zoom) => {
    if (linked || side === "select") setZoom(next);
    if (linked || side === "candidate") setCandidateZoom(next);
  };
  const startCompare = () => {
    if (shown.length < 2 || !current) return;
    const pair = selection.length === 2 ? selection.find((asset) => asset.id !== current.id) : undefined;
    setCandidateId((pair ?? shown[position] ?? shown[position - 2])!.id);
    setActive("select");
    setCandidateZoom(zoom);
    setMode("compare");
  };
  const move = (delta: number) => {
    if (!shown.length) return;
    if (comparing && candidate) {
      let index = shown.indexOf(candidate) + delta;
      if (shown[index]?.id === current?.id) index += Math.sign(delta);
      const next = shown[index];
      if (!next) return;
      setCandidateId(next.id);
      setActive("candidate");
      return;
    }
    const next = shown[Math.max(0, Math.min(shown.length - 1, position - 1 + delta))];
    if (next) focus(next.id);
  };
  const jump = (index: number) => {
    if (comparing && candidate) {
      const step = index ? -1 : 1;
      const next = shown[index]?.id === current?.id ? shown[index + step] : shown[index];
      if (!next) return;
      setCandidateId(next.id);
      setActive("candidate");
      return;
    }
    const next = shown[index];
    if (next) focus(next.id);
  };
  const swap = () => {
    if (!current || !candidate) return;
    setCurrentId(candidate.id);
    setCandidateId(current.id);
    setZoom(candidateZoom);
    setCandidateZoom(zoom);
    setActive((side) => (side === "select" ? "candidate" : "select"));
  };
  const makeSelect = () => {
    if (!candidate) return;
    const index = shown.indexOf(candidate);
    const after = shown[index + 1] ?? shown[index - 1];
    setCurrentId(candidate.id);
    setZoom(candidateZoom);
    if (!after || after.id === candidate.id) return;
    setCandidateId(after.id);
    setCandidateZoom(linked ? candidateZoom : after.id === current?.id ? zoom : FIT);
  };
  const toggleZoom = () => {
    const apply = (value: Zoom) => (value.level === "fit" ? { ...value, level: zoomTo } : FIT);
    if (comparing) {
      const next = apply(active === "select" ? zoom : candidateZoom);
      if (linked || active === "select") setZoom(next);
      if (linked || active === "candidate") setCandidateZoom(next);
    } else setZoom(apply(zoom));
  };
  const zoomLevel = (level: ZoomLevel) => {
    if (level !== "fit") setZoomTo(level);
    const next = (value: Zoom): Zoom => ({ ...value, level });
    if (!comparing || linked || active === "select") setZoom(next);
    if (comparing && (linked || active === "candidate")) setCandidateZoom(next);
  };

  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (event: KeyboardEvent) => {
    if (dialog || event.defaultPrevented) return;
    const element = event.target instanceof HTMLElement ? event.target : null;
    if (isTyping(element) || element?.closest(".kit-modal-backdrop")) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoLast();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a" && mode === "grid") {
      event.preventDefault();
      setChosen(shown.map((asset) => asset.id));
      flash(`${plural(shown.length, "photo")} selected`);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const onCell = Boolean(element?.closest(".st-cell"));
    const onControl = Boolean(element?.closest("button, a, [role='radio'], [role='switch'], input")) && !onCell;
    if (onControl && (event.key === " " || event.key === "Enter")) return;
    const group = element?.closest("[role='radiogroup']");
    if (group && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
      const radios = [...group.querySelectorAll<HTMLElement>("[role='radio']:not(:disabled)")];
      const at = radios.indexOf(element!.closest<HTMLElement>("[role='radio']")!);
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      radios[(at + step + radios.length) % radios.length]?.focus();
      event.preventDefault();
      return;
    }
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const digit = /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : null;
    const advance = event.shiftKey && digit !== null;
    const value = digit ?? key;
    const narrow = !wide;
    if (key === "Escape") {
      if (pinMode) setPinMode(false);
      else if (notes.draft) notes.setDraft(null);
      else if (selection.length > 1 && current) setChosen([current.id]);
      else if (narrow && (panels.left || panels.right)) setPanels({ left: false, right: false });
      else if (mode === "compare") setMode("loupe");
      else if (mode === "loupe") setMode("grid");
      else return;
    } else if (key === "?") setDialog({ kind: "shortcuts" });
    else if (key === "g") setMode("grid");
    else if (key === "e") openLoupe();
    else if (key === "c") startCompare();
    else if (key === "ArrowRight") move(1);
    else if (key === "ArrowLeft") move(-1);
    else if (key === "ArrowDown" && mode === "grid") move(columns);
    else if (key === "ArrowUp" && mode === "grid") move(-columns);
    else if (key === "ArrowUp" && comparing) makeSelect();
    else if (key === "Home") jump(0);
    else if (key === "End") jump(shown.length - 1);
    else if (key === "Enter" && mode === "grid") openLoupe();
    else if (key === " " && mode === "grid") openLoupe();
    else if ((key === " " || key === "z") && mode !== "grid") toggleZoom();
    else if (key === "i" && mode === "loupe") setInfo((value) => !value);
    else if (key === "x" && comparing) swap();
    else if (key === "n" && current && !closedReason && !comparing) {
      setMode("loupe");
      setPinFor(current.id);
    } else if (selection.length && /^[0-5]$/.test(value)) {
      refocused.current = false;
      void rate(selection, Number(value));
      if (advance && !refocused.current) move(1);
    } else if (selection.length && LABEL_KEYS[value]) {
      refocused.current = false;
      void toggleLabel(selection, LABEL_KEYS[value]!);
      if (advance && !refocused.current) move(1);
    } else if (selection.length && key === "p") void publish(selection);
    else if (selection.length && (key === "Delete" || key === "Backspace")) setDialog({ kind: "delete", assets: selection });
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const filtersOn = minRating > 0 || labelFilter !== null;
  const loading = !assets.data && !assets.error;
  const narrowPanels = (side: "left" | "right") =>
    setPanels((value) => (wide ? { ...value, [side]: !value[side] } : { left: side === "left" ? !value.left : false, right: side === "right" ? !value.right : false }));

  const modes: Array<[Mode, string, string, typeof GridGlyph]> = [
    ["grid", "Grid", "G", GridGlyph],
    ["loupe", "Loupe", "E", LoupeGlyph],
    ["compare", "Compare", "C", CompareGlyph],
  ];

  let stage;
  if (assets.error && !assets.data) {
    stage = (
      <div className="st-empty" role="alert">
        <h2>Could not load photos</h2>
        <p>{errorMessage(assets.error)}</p>
        <button type="button" className="lb-button" onClick={assets.reload}>
          Try again
        </button>
      </div>
    );
  } else if (loading) {
    stage = (
      <div className="st-grid-scroll" aria-hidden="true">
        <div className="st-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cellSize}px, 1fr))`, gap: 6 }}>
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} className="st-cell st-cell-loading" />
          ))}
        </div>
      </div>
    );
  } else if (!all.length) {
    stage = (
      <div className="st-empty">
        <Upload size={22} strokeWidth={1.5} />
        <h2>Drop photos here</h2>
        <p>{LIMIT_TEXT} New photos stay drafts until you publish them.</p>
        <div className="st-empty-actions">
          <button type="button" className="lb-button lb-button-solid" onClick={() => fileInput.current?.click()}>
            Upload photos
          </button>
          <button type="button" className="lb-button" onClick={() => void samplePhoto(all.length + 1).then((file) => addFiles([file]))}>
            Add a sample photo
          </button>
        </div>
      </div>
    );
  } else if (!shown.length || !current) {
    stage = (
      <div className="st-empty">
        <h2>No photos match</h2>
        <p>{plural(all.length, "photo")} in this shoot, none with these filters.</p>
        <button
          type="button"
          className="lb-button"
          onClick={clearFilters}
        >
          Clear filters
        </button>
      </div>
    );
  } else if (mode === "grid") {
    stage = (
      <>
        {filtersOn || library !== "all" ? (
          <div className="st-filterbar">
            <span>
              Showing {shown.length} of {all.length}
            </span>
            {library !== "all" ? <span className="st-chip">{{ picks: "Client picks", annotated: "Annotated", drafts: "Drafts" }[library]}</span> : null}
            {minRating ? <span className="st-chip">{minRating}+ stars</span> : null}
            {labelFilter ? <span className="st-chip">{LABEL_TITLES[labelFilter]} label</span> : null}
            <button
              type="button"
              className="lb-text-button"
              onClick={clearFilters}
            >
              Clear
            </button>
          </div>
        ) : null}
        <GridView
          items={shown}
          allCount={all.length}
          currentId={current.id}
          chosen={chosenIds}
          cellSize={cellSize}
          onSelect={select}
          onOpen={openLoupe}
          onColumns={setColumns}
        />
        <div className="st-toolbar">
          <span className="st-toolbar-text">
            {selection.length > 1 ? `${selection.length} selected · ` : ""}
            {plural(shown.length, "photo")} · {shown.filter((asset) => matches(asset, "picks")).length} picked · {plural(shown.filter((asset) => !asset.published).length, "draft")}
          </span>
          <span className="st-toolbar-spacer" />
          <label className="st-slider">
            <span>Thumbnails</span>
            <input type="range" min={110} max={300} step={2} value={cellSize} onChange={(event) => setCellSize(Number(event.target.value))} />
          </label>
        </div>
      </>
    );
  } else if (comparing && candidate) {
    stage = (
      <CompareView
        select={current}
        candidate={candidate}
        active={active}
        onActive={setActive}
        zoom={{ select: zoom, candidate: candidateZoom }}
        zoomTo={zoomTo}
        onZoom={sideZoom}
        onViewport={setViewport}
        onZoomLevel={zoomLevel}
        linked={linked}
        onLinked={() => {
          if (!linked) {
            const shared = active === "candidate" ? candidateZoom : zoom;
            setZoom(shared);
            setCandidateZoom(shared);
          }
          setLinked(!linked);
        }}
        onSwap={swap}
        onMakeSelect={makeSelect}
        onRate={(asset, rating) => void rate([asset], rating)}
        onLabel={(asset, value) => void label([asset], value)}
      />
    );
  } else {
    stage = (
      <Loupe
        photo={current}
        position={position}
        total={shown.length}
        zoom={zoom}
        zoomTo={zoomTo}
        onZoom={setZoom}
        onZoomLevel={zoomLevel}
        notes={notes}
        pinMode={pinMode}
        onPinMode={setPinMode}
        info={info}
        onInfo={() => setInfo((value) => !value)}
        onViewport={setViewport}
        canPin={!closedReason}
        pinHint={pinHint}
      />
    );
  }

  return (
    <div
      className={`st-app st-mode-${mode}${panels.left ? " st-left-open" : ""}${panels.right ? " st-right-open" : ""}`}
      onMouseDown={(event) => {
        if (!(event.target instanceof Element && event.target.closest("[role='radio']"))) return;
        event.preventDefault();
        if (isTyping(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={drop}
    >
      <header className="st-top">
        <button type="button" className="st-icon st-only-narrow" aria-label="Library" title="Library" aria-expanded={panels.left} onClick={() => narrowPanels("left")}>
          <Menu size={17} />
        </button>
        <span className="st-brand">
          <ApertureGlyph size={16} strokeWidth={1.5} />
          <span>Lightbox</span>
        </span>
        <span className="st-crumb">
          <strong>{shoot.title}</strong>
          <span>
            {shoot.clientName} · {formatDay(shoot.shotOn)}
          </span>
        </span>
        <div className="st-modes" role="radiogroup" aria-label="View">
          {modes.map(([id, text, key, Glyph]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? "st-on" : undefined}
              title={`${text} (${key})`}
              aria-label={text}
              disabled={id === "compare" ? shown.length < 2 : id === "loupe" ? !shown.length : false}
              onClick={() => (id === "compare" ? startCompare() : id === "loupe" ? openLoupe() : setMode("grid"))}
            >
              <Glyph size={15} />
              <span className="st-mode-text">{text}</span>
              <kbd className="st-mode-key">{key}</kbd>
            </button>
          ))}
        </div>
        <div className="st-top-actions">
          <span className="st-saving" role="status">
            {saving > 0 ? `Saving ${saving}…` : ""}
          </span>
          <button type="button" className="st-icon st-hide-narrow" id="add-sample" aria-label="Add a sample photo" title="Add a sample photo" onClick={() => void samplePhoto(all.length + 1).then((file) => addFiles([file]))}>
            <Image size={16} />
          </button>
          <button
            type="button"
            className="st-button"
            id="upload"
            onClick={() => fileInput.current?.click()}
            aria-busy={uploads > 0}
            aria-label={uploads > 0 ? `Uploading ${plural(uploads, "photo")}` : "Upload photos"}
            title="Upload photos, or drop them anywhere"
          >
            <Upload size={14} />
            <span className="st-hide-narrow">{uploads > 0 ? `Uploading ${uploads}…` : "Upload"}</span>
          </button>
          <button
            type="button"
            className="st-button st-button-primary st-hide-narrow"
            disabled={!drafts.length}
            title={drafts.length ? `Publish ${plural(drafts.length, "draft")} to the client gallery` : "Every photo is in the client gallery"}
            onClick={() => void publish(drafts, true)}
          >
            {drafts.length ? `Publish ${drafts.length}` : "Published"}
          </button>
          <button type="button" className="st-icon st-hide-narrow" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setDialog({ kind: "shortcuts" })}>
            <CircleHelp size={16} />
          </button>
          <button
            type="button"
            className={`st-icon${panels.right ? " st-on" : ""}`}
            aria-label="Inspector"
            title="Inspector"
            aria-expanded={panels.right}
            onClick={() => narrowPanels("right")}
          >
            <span className="st-hide-narrow">
              <PanelGlyph size={16} />
            </span>
            <span className="st-only-narrow">
              <Info size={17} />
            </span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      {panels.left ? (
        <LibraryRail
          shoots={shoots}
          shoot={shoot}
          onShoot={onChoose}
          onNewShoot={onNewShoot}
          counts={counts}
          library={library}
          onLibrary={setLibrary}
          minRating={minRating}
          onMinRating={setMinRating}
          labelFilter={labelFilter}
          onLabelFilter={setLabelFilter}
          current={target}
          zoom={mode === "grid" ? FIT : comparing && active === "candidate" ? candidateZoom : zoom}
          viewport={viewport}
          onZoom={(next) => {
            if (comparing) sideZoom(active, next);
            else setZoom(next);
            if (mode === "grid") openLoupe();
          }}
          onStatus={(status) => void setStatus(status)}
          onFinalPicks={() => setDialog({ kind: "picks" })}
          onSettings={() => setDialog({ kind: "settings" })}
          onRefresh={() => {
            assets.reload();
            onRefreshShoots();
          }}
          onClose={wide ? undefined : () => setPanels({ left: false, right: false })}
        />
      ) : null}

      <main className="st-stage" aria-label={mode === "grid" ? "Grid" : mode === "loupe" ? "Loupe" : "Compare"}>
        {stage}
        <ToastStack />
        {hud ? (
          <div key={hud.id} className={`st-hud${hud.undo ? " st-hud-long" : ""}${mode === "grid" ? " st-hud-low" : comparing ? " st-hud-bar" : ""}`} role="status">
            <span>{hud.text}</span>
            {hud.undo ? (
              <button type="button" className="st-hud-undo" title={`Undo (${UNDO_KEY})`} onClick={undoLast}>
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </main>

      {panels.right ? (
        <Inspector
          asset={target}
          shoot={shoot}
          position={target ? shown.indexOf(target) + 1 : 0}
          total={shown.length}
          notes={target ? notes : null}
          selection={selection}
          onRate={(rating) => void rate(selection, rating)}
          onLabel={(value) => void label(selection, value)}
          onPublish={() => void publish(selection)}
          onDelete={() => selection.length && setDialog({ kind: "delete", assets: selection })}
          pinHint={pinHint}
          onClose={wide ? undefined : () => setPanels({ left: false, right: false })}
        />
      ) : null}

      {(mode !== "grid" || wide) && shown.length && current ? (
        <Filmstrip
          items={shown}
          currentId={current.id}
          candidateId={comparing ? (candidate?.id ?? null) : null}
          chosen={comparing ? new Set<string>() : chosenIds}
          onSelect={(id, how) => {
            if (comparing) {
              if (id !== current.id) setCandidateId(id);
              setActive(id === current.id ? "select" : "candidate");
            } else select(id, mode === "grid" ? how : undefined);
          }}
          onOpen={(id) => {
            focus(id);
            setMode("loupe");
          }}
          header={
            <>
              {!wide && mode === "loupe" && target ? (
                <span className="st-quick">
                  <StarInput value={target.rating} onChange={(rating) => void rate([target], rating)} />
                  <LabelInput value={target.colorLabel} onChange={(value) => void label([target], value)} />
                </span>
              ) : (
                <span className="st-film-path">
                  {shoot.title} / {library === "all" && !filtersOn ? "All photographs" : `Filtered, ${shown.length} of ${all.length}`}
                </span>
              )}
              <span className="st-film-name">
                {target ? shown.indexOf(target) + 1 : 0} of {shown.length} · {fileName(target)}
              </span>
            </>
          }
        />
      ) : null}

      {!wide && panels.left ? <button type="button" className="st-scrim" aria-label="Close panel" onClick={() => setPanels({ left: false, right: false })} /> : null}

      {dragging ? (
        <div className="st-drop" aria-hidden="true">
          <div className="st-drop-card">
            <Upload size={26} strokeWidth={1.4} />
            <strong>Drop to add to {shoot.title}</strong>
            <span>{LIMIT_TEXT} They arrive as drafts.</span>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "settings" ? (
        <ShootForm
          shoot={shoot}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            onSaved(saved);
            toast("Shoot saved.");
          }}
        />
      ) : null}
      {dialog?.kind === "picks" ? <FinalPicks shoot={shoot} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "shortcuts" ? <Shortcuts onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "delete" ? <DeleteDialog assets={dialog.assets} onClose={() => setDialog(null)} onDelete={() => void remove(dialog.assets)} /> : null}
    </div>
  );
}

function loadShoots(client: AppClient) {
  return loadPages(client, "listShoots", {}, (page: Paged<"shoots", Shoot>) => page.shoots).then(({ items }) => items);
}

function Studio() {
  const shoots = useLoader("shoots", loadShoots);
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const list = useMemo(() => shoots.data ?? [], [shoots.data]);
  const shoot = list.find((item) => item.id === chosen) ?? list.find((item) => item.status === "proofing") ?? list[0];
  const update = (saved?: Shoot) => {
    if (saved)
      shoots.replace((current) =>
        current.map((item) =>
          item.id === saved.id
            ? {
                ...item,
                title: saved.title,
                clientName: saved.clientName,
                shotOn: saved.shotOn,
                selectionLimit: saved.selectionLimit,
                status: saved.status,
                internalRateCents: saved.internalRateCents,
              }
            : item,
        ),
      );
    shoots.reload();
  };
  const form = creating ? (
    <ShootForm
      shoot={null}
      onClose={() => setCreating(false)}
      onSaved={(saved) => {
        setCreating(false);
        shoots.replace((current) => [saved, ...current]);
        setChosen(saved.id);
        shoots.reload();
        toast(`Created ${saved.title}. Upload photos, then open the gallery.`);
      }}
    />
  ) : null;
  if (shoot)
    return (
      <>
        <Workspace key={shoot.id} shoot={shoot} shoots={list} onChoose={setChosen} onSaved={update} onNewShoot={() => setCreating(true)} onRefreshShoots={shoots.reload} />
        {form}
      </>
    );
  return (
    <div className="st-app st-app-blank">
      <header className="st-top">
        <span className="st-brand">
          <ApertureGlyph size={16} strokeWidth={1.5} />
          <span>Lightbox</span>
        </span>
      </header>
      <main className="st-stage">
        {shoots.error && !shoots.data ? (
          <div className="st-empty" role="alert">
            <h2>Could not load shoots</h2>
            <p>{errorMessage(shoots.error)}</p>
            <button type="button" className="lb-button" onClick={shoots.reload}>
              Try again
            </button>
          </div>
        ) : shoots.data ? (
          <div className="st-empty">
            <h2>No shoots yet</h2>
            <p>Create a shoot, upload photos, then send the client the gallery code.</p>
            <button type="button" className="lb-button lb-button-solid" id="new-shoot" onClick={() => setCreating(true)}>
              New shoot
            </button>
          </div>
        ) : null}
      </main>
      {form}
    </div>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <ToastProvider>
        <Studio />
      </ToastProvider>
    </AppProvider>,
  );
}
