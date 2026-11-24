import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "dohc/app";
import { Button, Callout, EmptyState, ProgressBar } from "dohc/ui";
import {
  errorMessage,
  formatDay,
  invoke,
  loadPages,
  refusalCode,
  useLoader,
  type ClientAsset,
  type Gallery,
  type Note,
} from "./api";
import { FilterBar, PhotoGrid, useViewer } from "./gallery";
import { Inspector, type NoteRules } from "./inspector";
import type { FileAccess } from "./photo";
import { ToastProvider, useToast } from "./toast";
import "./lightbox.css";

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

function Gate({ error, busy, onOpen }: { error: string | null; busy: boolean; onOpen(code: string): void }) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean) onOpen(clean);
  };
  return (
    <main className="lb-gate">
      <form className="lb-gate-card" onSubmit={submit}>
        <span className="lb-brand">
          <span className="lb-brand-mark" aria-hidden="true" />
          <span>Lightbox</span>
        </span>
        <h1 className="lb-display">Your photos are ready</h1>
        <p>Enter the gallery code your photographer sent you.</p>
        <input
          id="gallery-code"
          className="kit-input lb-gate-input"
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label="Gallery code"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "gate-error" : undefined}
          autoFocus
        />
        {error ? (
          <p className="lb-gate-error" id="gate-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" loading={busy} id="gallery-open" disabled={!code.trim()}>
          Open gallery
        </Button>
      </form>
    </main>
  );
}

interface Loaded {
  gallery: Gallery;
  assets: ClientAsset[];
}

function ClientGallery({ code, data, onLeave, replace }: { code: string; data: Loaded; onLeave(): void; replace(update: (current: Loaded) => Loaded): void }) {
  const client = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [cursor, setCursor] = useState(0);
  const pendingPicks = useRef(new Set<string>());
  const { gallery, assets } = data;
  const viewer = useViewer(assets);
  const closed = gallery.status !== "proofing";
  const files: FileAccess = useMemo(() => ({ operation: "assetFileAccess", input: (photo) => ({ code, assetId: photo.id }) }), [code]);
  const shown = useMemo(
    () =>
      assets.filter((asset) =>
        filter === "picks" ? asset.picked : filter === "notes" ? asset.noteCount > 0 : true,
      ),
    [assets, filter],
  );

  const pick = async (asset: ClientAsset) => {
    if (closed) {
      toast("This gallery is closed for picks.");
      return;
    }
    if (pendingPicks.current.has(asset.id)) return;
    pendingPicks.current.add(asset.id);
    const selected = !asset.picked;
    replace((current) => {
      const next = current.assets.map((item) => (item.id === asset.id ? { ...item, picked: selected } : item));
      return {
        gallery: { ...current.gallery, picksUsed: next.filter((item) => item.picked).length },
        assets: next,
      };
    });
    try {
      const result = await invoke<{ picksUsed: number }>(client, "toggleClientPick", { code, assetId: asset.id, selected });
      pendingPicks.current.delete(asset.id);
      replace((current) => {
        const next = current.assets.map((item) => (item.id === asset.id ? { ...item, picked: selected } : item));
        return {
          gallery: {
            ...current.gallery,
            picksUsed: pendingPicks.current.size === 0 ? result.picksUsed : next.filter((item) => item.picked).length,
          },
          assets: next,
        };
      });
    } catch (error) {
      pendingPicks.current.delete(asset.id);
      replace((current) => {
        const next = current.assets.map((item) => (item.id === asset.id ? { ...item, picked: !selected } : item));
        return {
          gallery: { ...current.gallery, picksUsed: next.filter((item) => item.picked).length },
          assets: next,
        };
      });
      toast(errorMessage(error), {
        tone: "danger",
        retry: refusalCode(error) === "selection_limit_reached" ? undefined : () => void pick(asset),
      });
    }
  };

  const keys = (event: KeyboardEvent | globalThis.KeyboardEvent, asset: ClientAsset) => {
    if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return false;
    void pick(assets.find((item) => item.id === asset.id) ?? asset);
    return true;
  };

  const rules: NoteRules = {
    load: async (photo) =>
      (await loadPages<Note>(client, "listAnnotations", { code, assetId: photo.id }, (page) => page.annotations)).items,
    add: async (photo, draft) => {
      const note = await invoke<Note>(client, "addPinnedAnnotation", { code, assetId: photo.id, ...draft });
      replace((current) => ({
        ...current,
        assets: current.assets.map((item) =>
          item.id === photo.id
            ? { ...item, noteCount: item.noteCount + 1, openNoteCount: item.openNoteCount + 1 }
            : item,
        ),
      }));
      return note;
    },
    closedReason: closed ? "This gallery is closed for notes." : undefined,
    askName: true,
  };

  const left = gallery.selectionLimit - gallery.picksUsed;
  return (
    <main className="lb-portal">
      <header className="lb-portal-head">
        <div>
          <span className="lb-eyebrow">
            For {gallery.clientName} · {formatDay(gallery.shotOn)}
          </span>
          <h1 className="lb-display">{gallery.title}</h1>
          <p className="lb-portal-intro">
            {closed
              ? "Your photographer has delivered this gallery."
              : `Heart up to ${gallery.selectionLimit} favorites. Click a spot on any photo to leave a note right there.`}
          </p>
        </div>
        <div className="lb-portal-picks">
          <ProgressBar
            value={Math.min(gallery.picksUsed, gallery.selectionLimit)}
            max={gallery.selectionLimit}
            label="Your picks"
            valueLabel={`${gallery.picksUsed} of ${gallery.selectionLimit}`}
            tone={left <= 0 ? "success" : "neutral"}
          />
          <span className="lb-portal-left">
            {left > 0 ? `${left} pick${left === 1 ? "" : "s"} left` : "You've used all your picks."}
          </span>
          <button type="button" className="lb-link" onClick={onLeave}>
            Use another code
          </button>
        </div>
      </header>
      {closed ? (
        <Callout tone="success" title="Delivered">
          Picks and notes are closed. You can still browse every photo.
        </Callout>
      ) : null}
      <div className="lb-toolbar">
        <FilterBar
          label="Show photos"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All", count: assets.length },
            { id: "picks", label: "My picks", count: assets.filter((asset) => asset.picked).length },
            { id: "notes", label: "With notes", count: assets.filter((asset) => asset.noteCount > 0).length },
          ]}
        />
      </div>
      <p className="lb-keys" aria-hidden="true">
        <kbd>←</kbd> <kbd>→</kbd> move · <kbd>Space</kbd> pick · <kbd>Enter</kbd> open · <kbd>C</kbd> compare in the viewer
      </p>
      {shown.length ? (
        <PhotoGrid
          items={shown}
          access={files}
          cursor={cursor}
          onCursor={setCursor}
          onOpen={(index) => viewer.open(shown, index)}
          onKey={keys}
          label="Gallery photos"
          badges={(asset) =>
            asset.noteCount ? (
              <span className="lb-tag lb-tag-note" title={`${asset.noteCount} notes`}>
                ✎ {asset.noteCount}
              </span>
            ) : null
          }
          actions={(asset) => (
            <button
              type="button"
              className={`lb-heart${asset.picked ? " lb-heart-on" : ""}`}
              aria-pressed={asset.picked}
              aria-label={asset.picked ? `Unpick ${asset.title}` : `Pick ${asset.title}`}
              disabled={closed}
              onClick={() => void pick(asset)}
            >
              {asset.picked ? "♥" : "♡"}
            </button>
          )}
        />
      ) : (
        <EmptyState
          title={assets.length ? "Nothing here yet" : "No photos yet"}
          description={
            assets.length
              ? filter === "picks"
                ? "Heart a photo to add it to your picks."
                : "Photos with notes show up here."
              : "Your photographer hasn't published any photos yet."
          }
          action={assets.length ? <Button onClick={() => setFilter("all")}>Show all</Button> : undefined}
        />
      )}
      {viewer.current ? (
        <Inspector
          items={viewer.items}
          index={viewer.index}
          onIndex={(index) => {
            viewer.move(index);
            setCursor(shown.findIndex((asset) => asset.id === viewer.items[index]?.id));
          }}
          onClose={viewer.close}
          access={files}
          eyebrow={gallery.title}
          rules={rules}
          onKey={keys}
          caption={(asset) => <span className="lb-caption">{asset.picked ? "♥ In your picks" : "Not picked"}</span>}
          controls={(asset) => (
            <div className="lb-controls">
              <Button
                variant={asset.picked ? "secondary" : "primary"}
                onClick={() => void pick(asset)}
                disabled={closed}
                aria-pressed={asset.picked}
                id="pick-toggle"
              >
                {asset.picked ? `♥ Picked · ${asset.title}` : `♡ Pick ${asset.title}`}
              </Button>
              <span className="lb-control-hint">
                {gallery.picksUsed} of {gallery.selectionLimit} picks used · Space toggles
              </span>
            </div>
          )}
        />
      ) : null}
    </main>
  );
}

function Portal() {
  const [code, setCode] = useState(readCode);
  const loaded = useLoader<Loaded>(code || null, (client) =>
    loadPages<ClientAsset, { gallery: Gallery }>(client, "listPublishedAssets", { code }, (page) => page.assets).then(
      ({ items, first }) => ({ gallery: first.gallery, assets: items }),
    ),
  );
  const leave = () => {
    saveCode("");
    setCode("");
  };
  if (!code || !loaded.data) {
    const failed = Boolean(code && loaded.error);
    const notFound = refusalCode(loaded.error) === "gallery_not_found";
    return (
      <>
        <Gate
          busy={Boolean(code) && loaded.loading}
          error={failed ? errorMessage(loaded.error) : null}
          onOpen={(next) => {
            saveCode(next);
            if (next === code) loaded.reload();
            else setCode(next);
          }}
        />
        {failed && !notFound ? (
          <div className="lb-gate-retry">
            <Button onClick={loaded.reload}>Try again</Button>
          </div>
        ) : null}
      </>
    );
  }
  return <ClientGallery code={code} data={loaded.data} onLeave={leave} replace={loaded.replace} />;
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
