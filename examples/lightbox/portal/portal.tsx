import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "dohc/app";
import { ArrowDown, Check, Heart, MessageSquare } from "dohc/icons";
import {
  errorMessage,
  formatDay,
  invoke,
  loadPages,
  type Paged,
  refusalCode,
  useLoader,
  type ClientAsset,
  type Gallery,
  type Note,
} from "./api";
import { ApertureGlyph, CompareGlyph } from "./glyphs";
import type { NoteRules } from "./notes";
import { Photo, useSize, type FileAccess } from "./photo";
import { sceneUrl } from "./scenes";
import { ToastProvider, useToast } from "./toast";
import { Viewer } from "./viewer";
import "./base.css";
import "./portal.css";

function readCode() {
  try {
    return localStorage.getItem("lightbox.code") ?? "";
  } catch {
    return "";
  }
}

function saveCode(code: string) {
  try {
    if (code) localStorage.setItem("lightbox.code", code);
    else localStorage.removeItem("lightbox.code");
  } catch {
    return;
  }
}

function Brand() {
  return (
    <span className="pt-brand">
      <ApertureGlyph size={16} strokeWidth={1.5} />
      <span>Lightbox</span>
    </span>
  );
}

function GateImage() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    sceneUrl("couple:8", 1200, 1600, 1600).then(
      (next) => current && setUrl(next),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <div className="pt-gate-image" aria-hidden="true">
      {url ? <img src={url} alt="" /> : null}
    </div>
  );
}

function Gate({
  error,
  busy,
  onOpen,
  onRetry,
}: {
  error: string | null;
  busy: boolean;
  onOpen(code: string): void;
  onRetry?: () => void;
}) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean) onOpen(clean);
  };
  return (
    <main className="pt-gate">
      <GateImage />
      <form className="pt-gate-form" onSubmit={submit}>
        <Brand />
        <div className="pt-gate-copy">
          <h1 className="pt-serif">Your gallery is ready</h1>
          <p>
            Enter the gallery code from your photographer to see your photos, choose favorites, and
            leave notes.
          </p>
        </div>
        <label className="pt-gate-label" htmlFor="gallery-code">
          Gallery code
        </label>
        <input
          id="gallery-code"
          className="pt-gate-input"
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "gate-error" : undefined}
          autoFocus
        />
        {error ? (
          <p className="pt-gate-error" id="gate-error" role="alert">
            {error}
            {onRetry ? (
              <button type="button" className="lb-text-button" onClick={onRetry}>
                Try again
              </button>
            ) : null}
          </p>
        ) : null}
        <button
          type="submit"
          id="gallery-open"
          className="pt-gate-button"
          disabled={!code.trim() || busy}
          aria-busy={busy}
        >
          {busy ? "Opening…" : "View gallery"}
        </button>
      </form>
    </main>
  );
}

interface GalleryData {
  gallery: Gallery;
  assets: ClientAsset[];
}

interface Row {
  readonly items: readonly ClientAsset[];
  readonly height: number;
  readonly full: boolean;
}

function justify(items: readonly ClientAsset[], width: number, target: number, gap: number): Row[] {
  if (width <= 0) return [];
  const rows: Row[] = [];
  let row: ClientAsset[] = [];
  let ratios = 0;
  for (const item of items) {
    row.push(item);
    ratios += item.width / item.height;
    if (ratios * target + gap * (row.length - 1) >= width) {
      rows.push({ items: row, height: (width - gap * (row.length - 1)) / ratios, full: true });
      row = [];
      ratios = 0;
    }
  }
  if (row.length) rows.push({ items: row, height: target, full: false });
  return rows;
}

type Filter = "all" | "favorites" | "annotated";

function Wall({
  items,
  access,
  closed,
  choosing,
  onOpen,
  onPick,
  onChoose,
}: {
  items: readonly ClientAsset[];
  access: FileAccess;
  closed: boolean;
  choosing: readonly string[] | null;
  onOpen(index: number): void;
  onPick(asset: ClientAsset): void;
  onChoose(asset: ClientAsset): void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const { width } = useSize(box);
  const [cursor, setCursor] = useState(0);
  const narrow = width < 640;
  const rows = useMemo(
    () => justify(items, width, narrow ? 170 : 330, narrow ? 3 : 6),
    [items, width, narrow],
  );
  const at = Math.min(cursor, items.length - 1);

  const focusAt = (next: number) => {
    const target = items[next];
    if (!target) return;
    setCursor(next);
    box.current?.querySelector<HTMLElement>(`[data-asset="${target.id}"]`)?.focus();
  };

  const vertical = (from: number, delta: -1 | 1) => {
    const tiles = [...(box.current?.querySelectorAll<HTMLElement>("[data-asset]") ?? [])];
    const here = tiles[from]?.getBoundingClientRect();
    if (!here) return from;
    const center = here.left + here.width / 2;
    const ahead = tiles
      .map((tile, position) => ({ position, rect: tile.getBoundingClientRect() }))
      .filter(({ rect }) =>
        delta > 0 ? rect.top >= here.bottom - 1 : rect.bottom <= here.top + 1,
      );
    if (!ahead.length) return from;
    const edge =
      delta > 0
        ? Math.min(...ahead.map(({ rect }) => rect.top))
        : Math.max(...ahead.map(({ rect }) => rect.bottom));
    const row = ahead.filter(
      ({ rect }) => Math.abs((delta > 0 ? rect.top : rect.bottom) - edge) < 2,
    );
    const distance = ({ rect }: { rect: DOMRect }) => Math.abs(rect.left + rect.width / 2 - center);
    return row.reduce((best, tile) => (distance(tile) < distance(best) ? tile : best)).position;
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>, position: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const asset = items[position]!;
    if (event.key === "ArrowRight") focusAt(Math.min(items.length - 1, position + 1));
    else if (event.key === "ArrowLeft") focusAt(Math.max(0, position - 1));
    else if (event.key === "ArrowDown") focusAt(vertical(position, 1));
    else if (event.key === "ArrowUp") focusAt(vertical(position, -1));
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else if ((event.key === " " || event.key.toLowerCase() === "h") && !choosing) onPick(asset);
    else return;
    event.preventDefault();
  };

  let position = -1;
  return (
    <div className="pt-wall" ref={box} role="list" aria-label="Photos">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="pt-row" style={{ height: row.height }}>
          {row.items.map((asset) => {
            position += 1;
            const here = position;
            const ratio = asset.width / asset.height;
            const chosen = choosing?.includes(asset.id) ?? false;
            return (
              <div
                key={asset.id}
                role="listitem"
                className={`pt-tile${asset.picked ? " pt-picked" : ""}${chosen ? " pt-chosen" : ""}${choosing ? " pt-choosing" : ""}`}
                style={
                  row.full
                    ? { flexGrow: ratio, flexBasis: 0 }
                    : { width: ratio * row.height, flexGrow: 0 }
                }
              >
                <button
                  type="button"
                  className="pt-tile-open"
                  data-asset={asset.id}
                  tabIndex={here === at ? 0 : -1}
                  aria-label={`${asset.title}${asset.picked ? ", favorite" : ""}${asset.noteCount ? `, ${asset.noteCount} notes` : ""}`}
                  aria-pressed={choosing ? chosen : undefined}
                  onFocus={() => setCursor(here)}
                  onKeyDown={(event) => keyDown(event, here)}
                  onClick={() => (choosing ? onChoose(asset) : onOpen(here))}
                >
                  <Photo photo={asset} access={access} size="thumb" />
                </button>
                {choosing ? (
                  <span className="pt-tile-check" aria-hidden="true">
                    {chosen ? <Check size={14} strokeWidth={2.5} /> : null}
                  </span>
                ) : (
                  <>
                    {asset.noteCount ? (
                      <span className="pt-tile-notes" aria-hidden="true">
                        <MessageSquare size={13} />
                        {asset.noteCount}
                      </span>
                    ) : null}
                    {closed ? (
                      asset.picked ? (
                        <span className="pt-tile-heart pt-tile-heart-mark" aria-hidden="true">
                          <Heart size={18} strokeWidth={1.75} fill="currentColor" />
                        </span>
                      ) : null
                    ) : (
                      <button
                        type="button"
                        tabIndex={-1}
                        className="pt-tile-heart"
                        aria-pressed={asset.picked}
                        aria-label={
                          asset.picked
                            ? `Remove ${asset.title} from favorites`
                            : `Add ${asset.title} to favorites`
                        }
                        title={asset.picked ? "Remove from favorites" : "Add to favorites"}
                        onClick={() => onPick(asset)}
                      >
                        <Heart
                          size={18}
                          strokeWidth={1.75}
                          fill={asset.picked ? "currentColor" : "none"}
                        />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ClientGallery({
  code,
  data,
  tick,
  onLeave,
  replace,
  reload,
}: {
  code: string;
  data: GalleryData;
  tick: number;
  onLeave(): void;
  replace(update: (current: GalleryData) => GalleryData): void;
  reload(): void;
}) {
  const client = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [choosing, setChoosing] = useState<string[] | null>(null);
  const [view, setView] = useState<{
    ids: readonly string[];
    id: string;
    compareId: string | null;
  } | null>(null);
  const pendingPicks = useRef(new Map<string, { request: Promise<unknown>; selected: boolean }>());
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  const sentToast = useRef<(() => void) | null>(null);
  const wallTop = useRef<HTMLDivElement | null>(null);
  const hero = useRef<HTMLElement | null>(null);
  const footer = useRef<HTMLElement | null>(null);
  const [inHero, setInHero] = useState(true);
  const [atFooter, setAtFooter] = useState(false);
  const { gallery } = data;
  const assets = useMemo(
    () =>
      data.assets.map((asset) => {
        const pending = pendingPicks.current.get(asset.id);
        return pending && pending.selected !== asset.picked
          ? { ...asset, picked: pending.selected }
          : asset;
      }),
    [data.assets],
  );
  const assetsNow = useRef(assets);
  assetsNow.current = assets;
  const pickFailures = useRef(new Map<string, { selected: boolean; dismiss: () => void }>());
  const sendFailure = useRef<(() => void) | null>(null);
  const sendLatest = useRef<() => Promise<void>>(async () => undefined);
  const closed = gallery.status !== "proofing";
  const delivered = gallery.status === "delivered";
  const files: FileAccess = useMemo(
    () => ({
      operation: "assetFileAccess",
      fullSize: delivered,
      input: (photo) => ({ code, assetId: photo.id }),
    }),
    [code, delivered],
  );
  const favorites = assets.filter((asset) => asset.picked);
  const picksUsed = favorites.length;
  const annotated = assets.filter((asset) => asset.noteCount > 0);
  const shown = filter === "favorites" ? favorites : filter === "annotated" ? annotated : assets;
  const cover = assets.find((asset) => asset.width > asset.height) ?? assets[0];

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const viewItems = view ? view.ids.flatMap((id) => byId.get(id) ?? []) : [];
  const viewIndex = view ? viewItems.findIndex((asset) => asset.id === view.id) : -1;
  const compareIndex = view?.compareId
    ? viewItems.findIndex((asset) => asset.id === view.compareId)
    : -1;
  const viewGone = Boolean(view) && viewIndex < 0;

  useEffect(() => {
    for (const [assetId, failure] of pickFailures.current) {
      if (assets.find((asset) => asset.id === assetId)?.picked !== failure.selected) continue;
      failure.dismiss();
      pickFailures.current.delete(assetId);
    }
  }, [assets]);

  useEffect(() => {
    if (!viewGone) return;
    setView(null);
    toast("That photo is no longer in the gallery.");
  }, [viewGone]);

  const refused = (error: unknown): boolean => {
    const code = refusalCode(error);
    if (code === "gallery_closed" || code === "selection_changed") reload();
    return code !== null;
  };
  const write = async <T,>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      refused(error);
      throw error;
    }
  };

  const setPicked = (current: GalleryData, assetId: string, selected: boolean): GalleryData => ({
    ...current,
    assets: current.assets.map((item) =>
      item.id === assetId ? { ...item, picked: selected } : item,
    ),
  });

  const pick = async (asset: ClientAsset) => {
    if (closed) {
      toast("This gallery is closed for favorites.");
      return;
    }
    if (pendingPicks.current.has(asset.id)) return;
    if (sendingNow.current) {
      toast("Your favorites are sending. Change them once they are sent.");
      return;
    }
    sentToast.current?.();
    sentToast.current = null;
    sendFailure.current?.();
    sendFailure.current = null;
    pickFailures.current.get(asset.id)?.dismiss();
    pickFailures.current.delete(asset.id);
    const selected = !asset.picked;
    const request = invoke(client, "toggleClientPick", { code, assetId: asset.id, selected });
    pendingPicks.current.set(asset.id, { request, selected });
    replace((current) => setPicked(current, asset.id, selected));
    try {
      await request;
      pendingPicks.current.delete(asset.id);
      replace((current) => setPicked(current, asset.id, selected));
    } catch (error) {
      pendingPicks.current.delete(asset.id);
      replace((current) => setPicked(current, asset.id, !selected));
      const final = refused(error);
      const change = sendingNow.current
        ? `${selected ? "add" : "remove"} ${asset.title}, so nothing was sent`
        : selected
          ? `add ${asset.title} to your favorites`
          : `remove ${asset.title} from your favorites`;
      const retry = () => {
        const live = assetsNow.current.find((item) => item.id === asset.id);
        if (live && live.picked !== selected) void pick(live);
      };
      pickFailures.current.set(asset.id, {
        selected,
        dismiss: toast(`Could not ${change}. ${errorMessage(error)}`, {
          tone: "danger",
          retry: final ? undefined : retry,
        }),
      });
    }
  };
  const send = async () => {
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    sendFailure.current?.();
    sendFailure.current = null;
    const assetIds = assets.filter((asset) => asset.picked).map((asset) => asset.id);
    try {
      const saved = await Promise.allSettled(
        [...pendingPicks.current.values()].map((pending) => pending.request),
      );
      if (saved.some((result) => result.status === "rejected")) return;
      const next = await invoke<Gallery>(client, "submitSelection", { code, assetIds });
      const accepted = new Set(assetIds);
      replace((current) => ({
        ...current,
        gallery: next,
        assets: current.assets.map((item) => ({ ...item, sent: accepted.has(item.id) })),
      }));
      sentToast.current?.();
      sentToast.current = toast(
        next.picksUsed
          ? `Sent ${next.picksUsed} ${next.picksUsed === 1 ? "favorite" : "favorites"} to your photographer.`
          : "Your photographer now knows you have no favorites.",
      );
    } catch (error) {
      const final = refused(error);
      sendFailure.current = toast(`Could not send your favorites. ${errorMessage(error)}`, {
        tone: "danger",
        retry: final ? undefined : () => void sendLatest.current(),
      });
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  };
  sendLatest.current = send;
  const sentOn = gallery.sentAtMs
    ? new Date(gallery.sentAtMs).toLocaleDateString(undefined, { month: "long", day: "numeric" })
    : null;
  const changedSinceSent = assets.some((asset) => asset.picked !== asset.sent);
  const sentNow = sentOn !== null && !changedSinceSent;
  const pickCurrent = (asset: ClientAsset) => void pick(byId.get(asset.id) ?? asset);

  const rules: NoteRules = {
    load: async (photo) =>
      (
        await loadPages(
          client,
          "listAnnotations",
          { code, assetId: photo.id },
          (page: Paged<"annotations", Note>) => page.annotations,
        )
      ).items,
    add: (photo, draft, key) =>
      write(
        invoke<Note>(
          client,
          "addPinnedAnnotation",
          { code, assetId: photo.id, ...draft },
          `addPinnedAnnotation:${key}`,
        ),
      ),
    update: (note, body) =>
      write(invoke<Note>(client, "updateOwnNote", { code, annotationId: note.id, body })),
    remove: async (note) => {
      await write(invoke(client, "deleteOwnNote", { code, annotationId: note.id }));
    },
    restore: (note) =>
      write(invoke<Note>(client, "restoreOwnNote", { code, annotationId: note.id })),
    counted: (assetId, counts) => {
      const asset = assetsNow.current.find((item) => item.id === assetId);
      if (
        !asset ||
        (asset.noteCount === counts.noteCount && asset.openNoteCount === counts.openNoteCount)
      )
        return;
      replace((current) => ({
        ...current,
        assets: current.assets.map((item) => (item.id === assetId ? { ...item, ...counts } : item)),
      }));
    },
    closedReason: closed ? "This gallery is delivered, so notes are closed." : undefined,
    tick,
  };

  const choose = (asset: ClientAsset) =>
    setChoosing((current) => {
      if (!current) return current;
      if (current.includes(asset.id)) return current.filter((id) => id !== asset.id);
      return [...current, asset.id].slice(-2);
    });

  const startCompare = () => {
    if (!choosing || choosing.length !== 2) return;
    const index = shown.findIndex((asset) => asset.id === choosing[0]);
    const other = shown.findIndex((asset) => asset.id === choosing[1]);
    setChoosing(null);
    if (index >= 0 && other >= 0)
      setView({ ids: shown.map((asset) => asset.id), id: choosing[0]!, compareId: choosing[1]! });
  };

  const showFilter = (next: Filter) => {
    setFilter(next);
    setChoosing(null);
    if (wallTop.current && wallTop.current.getBoundingClientRect().top < 0)
      wallTop.current.scrollIntoView({ block: "start" });
  };

  useEffect(() => {
    const element = hero.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInHero(entry.intersectionRatio > 0.4),
      { threshold: [0.4] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = footer.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setAtFooter(entry.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const picksLabel = `${picksUsed} / ${gallery.selectionLimit} selected`;
  const tabs: Array<{ id: Filter; label: string; count: number; limit?: number }> = [
    { id: "all", label: "All photos", count: assets.length },
    { id: "favorites", label: "Favorites", count: favorites.length, limit: gallery.selectionLimit },
    { id: "annotated", label: "Annotated", count: annotated.length },
  ];

  return (
    <div className="pt-page">
      <header className="pt-hero" ref={hero}>
        {cover ? (
          <Photo photo={cover} access={files} size="full" className="pt-hero-photo" />
        ) : null}
        <div className="pt-hero-shade" aria-hidden="true" />
        <div className="pt-hero-text">
          <span className="pt-eyebrow">
            {gallery.clientName} · {formatDay(gallery.shotOn)}
          </span>
          <h1 className="pt-serif">{gallery.title}</h1>
          <button
            type="button"
            className="pt-hero-enter"
            onClick={() =>
              wallTop.current?.scrollIntoView({
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "auto"
                  : "smooth",
                block: "start",
              })
            }
          >
            View gallery
            <ArrowDown size={14} />
          </button>
        </div>
        <div className="pt-hero-brand">
          <Brand />
        </div>
      </header>

      <div ref={wallTop} className="pt-anchor" />
      <nav className="pt-nav" aria-label="Gallery">
        <span className="pt-nav-title pt-serif">{gallery.title}</span>
        <div
          className="pt-tabs"
          role="tablist"
          aria-label="Show photos"
          onKeyDown={(event) => {
            const at = tabs.findIndex((tab) => tab.id === filter);
            const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[
              event.key
            ];
            if (to === undefined) return;
            event.preventDefault();
            const index = (to + tabs.length) % tabs.length;
            showFilter(tabs[index]!.id);
            event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[index]?.focus();
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`pt-tab-${tab.id}`}
              aria-controls="pt-panel"
              aria-selected={filter === tab.id}
              tabIndex={filter === tab.id ? 0 : -1}
              className={`pt-tab${filter === tab.id ? " pt-tab-on" : ""}`}
              onClick={() => showFilter(tab.id)}
            >
              {tab.label}
              <span className="pt-tab-count">
                {tab.count}
                {tab.limit ? <span className="pt-tab-limit"> / {tab.limit}</span> : null}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`pt-tab pt-tab-action${choosing ? " pt-tab-on" : ""}`}
          aria-pressed={Boolean(choosing)}
          title="Compare two photos"
          disabled={shown.length < 2}
          onClick={() => setChoosing(choosing ? null : [])}
        >
          <CompareGlyph size={15} />
          <span className="pt-tab-action-text">Compare</span>
        </button>
      </nav>

      {closed ? (
        <p className="pt-delivered" role="status">
          This gallery is delivered. Open any photo to download it. Favorites and notes are closed.
        </p>
      ) : null}

      <main className="pt-main">
        {filter === "favorites" && (picksUsed > 0 || sentOn) && (!closed || sentOn) ? (
          <div className={`pt-send${sentNow ? " pt-send-done" : ""}`} role="status">
            {sentNow ? <Check size={16} strokeWidth={2} /> : <Heart size={16} strokeWidth={1.75} />}
            <span>
              {closed
                ? gallery.sentPicks
                  ? `Your photographer has the favorites you sent on ${sentOn}.`
                  : `You told your photographer on ${sentOn} that you have no favorites.`
                : sentNow
                  ? gallery.sentPicks
                    ? `Sent to your photographer on ${sentOn}. You can still change them until the gallery is delivered.`
                    : `You cleared your favorites on ${sentOn}. You can still add some until the gallery is delivered.`
                  : sentOn
                    ? picksUsed
                      ? `You changed your favorites after sending them on ${sentOn}.`
                      : `You removed every favorite after sending them on ${sentOn}. Send the update so your photographer knows.`
                    : "Done choosing? Send your favorites so your photographer knows."}
            </span>
            {!closed && !sentNow ? (
              <button
                type="button"
                className="lb-button lb-button-solid"
                id="send-favorites"
                disabled={sending}
                onClick={() => void send()}
              >
                {sending
                  ? "Sending…"
                  : sentOn
                    ? "Send the update"
                    : `Send ${picksUsed} ${picksUsed === 1 ? "favorite" : "favorites"}`}
              </button>
            ) : null}
          </div>
        ) : null}
        <div id="pt-panel" role="tabpanel" aria-labelledby={`pt-tab-${filter}`}>
          {shown.length ? (
            <Wall
              items={shown}
              access={files}
              closed={closed}
              choosing={choosing}
              onOpen={(index) =>
                setView({
                  ids: shown.map((asset) => asset.id),
                  id: shown[index]!.id,
                  compareId: null,
                })
              }
              onPick={pickCurrent}
              onChoose={choose}
            />
          ) : (
            <div className="pt-empty">
              {filter === "favorites" ? (
                <Heart size={20} strokeWidth={1.5} />
              ) : (
                <MessageSquare size={20} strokeWidth={1.5} />
              )}
              <h2 className="pt-serif">
                {assets.length
                  ? filter === "favorites"
                    ? `No favorites${closed ? "" : " yet"}`
                    : `No notes${closed ? "" : " yet"}`
                  : "No photos yet"}
              </h2>
              <p>
                {!assets.length
                  ? "Your photographer has not published any photos yet."
                  : closed
                    ? filter === "favorites"
                      ? "No favorites were picked before favorites closed."
                      : "No notes were left before notes closed."
                    : filter === "favorites"
                      ? "Tap the heart on any photo to add it to your favorites."
                      : "Open a photo and click a spot on it to leave a note there."}
              </p>
              {assets.length ? (
                <button type="button" className="lb-button" onClick={() => showFilter("all")}>
                  Show all photos
                </button>
              ) : null}
            </div>
          )}
        </div>
      </main>

      <footer className="pt-footer" ref={footer}>
        <Brand />
        <span>
          Photographed for {gallery.clientName}, {formatDay(gallery.shotOn)}
        </span>
        <button type="button" className="lb-text-button" onClick={onLeave}>
          Use another code
        </button>
      </footer>

      {choosing ? (
        <div className="pt-float pt-float-compare" role="status">
          <span>
            {choosing.length === 2
              ? "2 photos chosen"
              : `Choose ${2 - choosing.length} more to compare`}
          </span>
          <button type="button" className="pt-float-quiet" onClick={() => setChoosing(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="pt-float-action"
            disabled={choosing.length !== 2}
            onClick={startCompare}
          >
            Compare
          </button>
        </div>
      ) : inHero || atFooter || closed ? null : (
        <div
          className={`pt-float${picksUsed >= gallery.selectionLimit ? " pt-float-full" : ""}${(picksUsed || sentOn) && !sentNow ? " pt-float-send" : ""}`}
        >
          <button
            type="button"
            className="pt-float-open"
            onClick={() => showFilter("favorites")}
            aria-label={`${picksLabel}${sentNow ? ", sent" : ""}. Show favorites`}
          >
            <Heart size={15} fill={picksUsed ? "currentColor" : "none"} />
            <span className="pt-float-count">
              <strong>{picksUsed}</strong> / {gallery.selectionLimit}
            </span>
            <span className="pt-float-label">{sentNow ? "sent" : "selected"}</span>
          </button>
          {(picksUsed || sentOn) && !sentNow ? (
            <button
              type="button"
              className="pt-float-action"
              id="float-send"
              disabled={sending}
              onClick={() => void send()}
            >
              {sending ? "Sending…" : sentOn ? "Send update" : "Send"}
            </button>
          ) : null}
        </div>
      )}

      {view && viewIndex >= 0 ? (
        <Viewer
          items={viewItems}
          index={viewIndex}
          compare={compareIndex >= 0 ? compareIndex : null}
          onView={(index, compare) =>
            setView(
              (current) =>
                current && {
                  ...current,
                  id: viewItems[index]!.id,
                  compareId: compare === null ? null : viewItems[compare]!.id,
                },
            )
          }
          onClose={() => setView(null)}
          access={files}
          rules={rules}
          closed={closed}
          onPick={pickCurrent}
          picksLabel={picksLabel}
          onRefused={reload}
        />
      ) : null}
    </div>
  );
}

function Portal() {
  const [code, setCode] = useState(readCode);
  const loaded = useLoader<GalleryData>(code || null, (client) =>
    loadPages(
      client,
      "listPublishedAssets",
      { code },
      (page: Paged<"assets", ClientAsset> & { gallery: Gallery }) => page.assets,
    ).then(({ items, first }) => ({
      gallery: first.gallery,
      assets: items,
    })),
  );
  const { reload } = loaded;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!code) return;
    let last = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 1000) return;
      last = Date.now();
      reload();
      setTick((value) => value + 1);
    };
    const timer = setInterval(refresh, 30000);
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [code, reload]);
  const leave = () => {
    saveCode("");
    setCode("");
  };
  const notFound = refusalCode(loaded.error) === "gallery_not_found";
  if (!code || !loaded.data || notFound) {
    const failed = Boolean(code && loaded.error);
    return (
      <Gate
        busy={Boolean(code) && loaded.loading}
        error={failed ? errorMessage(loaded.error) : null}
        onRetry={failed && !notFound ? loaded.reload : undefined}
        onOpen={(next) => {
          saveCode(next);
          if (next === code) loaded.reload();
          else setCode(next);
        }}
      />
    );
  }
  return (
    <ClientGallery
      code={code}
      data={loaded.data}
      tick={tick}
      onLeave={leave}
      replace={loaded.replace}
      reload={reload}
    />
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <ToastProvider>
        <Portal />
      </ToastProvider>
    </AppProvider>,
  );
}
