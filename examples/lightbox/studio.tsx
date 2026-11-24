import { useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, type AppClient } from "dohc/app";
import { Button, Callout, EmptyState, Field, Input, Modal, Skeleton, StatCard } from "dohc/ui";
import { BarChart, DonutChart } from "dohc/charts";
import {
  COLOR_LABELS,
  checkPhoto,
  copyText,
  errorMessage,
  formatBytes,
  formatDay,
  invoke,
  loadPages,
  revokePhotoFileUrl,
  uploadPhoto,
  useLoader,
  type ColorLabel,
  type Note,
  type PhotoSource,
  type Shoot,
  type StudioAsset,
} from "./portal/api";
import { FilterBar, PhotoGrid, useViewer, type FilterOption } from "./portal/gallery";
import { Inspector, type NoteRules } from "./portal/inspector";
import { Photo, type FileAccess } from "./portal/photo";
import { samplePhoto } from "./portal/scenes";
import { ToastProvider, useToast } from "./portal/toast";
import "./portal/lightbox.css";

const STUDIO_FILES: FileAccess = { operation: "studioFileAccess", input: (photo) => ({ assetId: photo.id }) };
const STATUSES = ["draft", "proofing", "delivered"] as const;
const STATUS_TEXT = { draft: "Draft", proofing: "Proofing", delivered: "Delivered" };
const LABEL_KEYS: Record<string, ColorLabel> = { "6": "red", "7": "yellow", "8": "green", "9": "blue" };

function formatCode(code: string) {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function Stars({ value }: { value: number }) {
  return (
    <span className="lb-stars" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className={star <= value ? "lb-star-on" : undefined} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

function ShootForm({
  open,
  shoot,
  onClose,
  onSaved,
}: {
  open: boolean;
  shoot: Shoot | null;
  onClose(): void;
  onSaved(shoot: Shoot): void;
}) {
  const client = useApp();
  const [title, setTitle] = useState(shoot?.title ?? "");
  const [clientName, setClientName] = useState(shoot?.clientName ?? "");
  const [shotOn, setShotOn] = useState(shoot?.shotOn ?? new Date().toISOString().slice(0, 10));
  const [limit, setLimit] = useState(String(shoot?.selectionLimit ?? 20));
  const [rate, setRate] = useState(shoot ? String(shoot.internalRateCents / 100) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const fields = {
      title: title.trim(),
      clientName: clientName.trim(),
      shotOn,
      selectionLimit: Number(limit),
      internalRateCents: Math.round(Number(rate || "0") * 100),
    };
    try {
      onSaved(
        shoot
          ? await invoke<Shoot>(client, "updateShoot", { shootId: shoot.id, ...fields })
          : await invoke<Shoot>(client, "createShoot", fields),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      title={shoot ? "Edit shoot" : "New shoot"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="shoot-form" loading={saving} id="shoot-save">
            {shoot ? "Save" : "Create shoot"}
          </Button>
        </>
      }
    >
      <form id="shoot-form" className="lb-form" onSubmit={submit}>
        <Field label="Title" htmlFor="shoot-title">
          <Input id="shoot-title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Client" htmlFor="shoot-client">
          <Input
            id="shoot-client"
            required
            maxLength={120}
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
          />
        </Field>
        <div className="lb-form-row">
          <Field label="Shot on" htmlFor="shoot-day">
            <Input id="shoot-day" type="date" required value={shotOn} onChange={(event) => setShotOn(event.target.value)} />
          </Field>
          <Field label="Picks allowed" htmlFor="shoot-limit" hint="Per reviewer, 1 to 500.">
            <Input
              id="shoot-limit"
              type="number"
              min={1}
              max={500}
              required
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Your rate (USD)" htmlFor="shoot-rate" hint="Only you see this. The client gallery never loads it.">
          <Input id="shoot-rate" type="number" min={0} step="1" value={rate} onChange={(event) => setRate(event.target.value)} />
        </Field>
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

function ExportModal({ shoot, onClose }: { shoot: Shoot; onClose(): void }) {
  const picks = useLoader(`export:${shoot.id}`, (client) =>
    loadPages<
      [string, number],
      { title: string; clientName: string; selectionLimit: number; reviewerCount: number }
    >(client, "exportFinalPicksList", { shootId: shoot.id }, (page) => page.picks).then(({ items, first }) => ({
      ...first,
      picks: items,
    })),
  );
  const text = picks.data
    ? [
        `${picks.data.title} — ${picks.data.clientName}`,
        `${picks.data.picks.length} photos picked by ${picks.data.reviewerCount} reviewer${picks.data.reviewerCount === 1 ? "" : "s"}`,
        "",
        ...picks.data.picks.map(([title, count]) => `${title}${count > 1 ? `  (${count} picks)` : ""}`),
      ].join("\n")
    : "";
  const toast = useToast();
  const exportArea = useRef<HTMLTextAreaElement | null>(null);
  return (
    <Modal
      open
      title="Final picks"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={!picks.data}
            onClick={() =>
              void copyText(text).then((copied) => {
                if (copied) {
                  toast("Picks list copied.");
                } else {
                  exportArea.current?.focus();
                  exportArea.current?.select();
                  toast("Selected the picks list. Press Ctrl+C (or Cmd+C) to copy.");
                }
              })
            }
          >
            Copy list
          </Button>
        </>
      }
    >
      {picks.error ? (
        <Callout tone="danger" action={<Button onClick={picks.reload}>Try again</Button>}>
          {errorMessage(picks.error)}
        </Callout>
      ) : picks.data ? (
        picks.data.picks.length ? (
          <textarea ref={exportArea} className="kit-textarea lb-export" readOnly rows={12} value={text} aria-label="Final picks list" />
        ) : (
          <EmptyState title="No picks yet" description="Picks appear here once the client hearts photos in the gallery." />
        )
      ) : (
        <Skeleton height={180} />
      )}
    </Modal>
  );
}

function ShootStats({ shoot, assets }: { shoot: Shoot; assets: readonly StudioAsset[] }) {
  const published = assets.filter((asset) => asset.published);
  const picked = published.filter((asset) => asset.pickCount > 0);
  const annotated = published.filter((asset) => asset.pickCount === 0 && asset.noteCount > 0);
  const ratings = [0, 1, 2, 3, 4, 5].map((rating) => assets.filter((asset) => asset.rating === rating).length);
  return (
    <section className="lb-stats" aria-label="Shoot summary">
      <div className="lb-stat-cards">
        <StatCard label="In the gallery" value={`${published.length} / ${assets.length}`} hint="Published photos" />
        <StatCard
          label="Client picks"
          value={String(shoot.pickedAssetCount)}
          hint={`${shoot.reviewerCount} reviewer${shoot.reviewerCount === 1 ? "" : "s"}, ${shoot.selectionLimit} picks each`}
        />
        <StatCard
          label="Open notes"
          value={String(shoot.openNoteCount)}
          tone={shoot.openNoteCount ? "warning" : "success"}
          delta={shoot.openNoteCount ? "To do" : "Clear"}
          hint={`${shoot.noteCount} in total`}
        />
        <StatCard label="Your rate" value={formatMoney(shoot.internalRateCents)} hint="Private to you" />
      </div>
      <div className="lb-charts">
        <div className="kit-card lb-chart-card">
          <span className="kit-stat-label">Review state</span>
          <DonutChart
            size={150}
            centerValue={String(assets.length)}
            centerLabel="photos"
            ariaLabel="Photos by review state"
            data={[
              { label: "Picked", value: picked.length, color: "var(--lb-pick)" },
              { label: "Notes only", value: annotated.length, color: "var(--lb-note)" },
              { label: "Waiting", value: published.length - picked.length - annotated.length, color: "var(--kit-chart-2)" },
              { label: "Draft", value: assets.length - published.length, color: "var(--kit-subtle)" },
            ]}
          />
        </div>
        <div className="kit-card lb-chart-card lb-chart-wide">
          <span className="kit-stat-label">Your ratings</span>
          <BarChart
            height={160}
            ariaLabel="Photos by star rating"
            labels={["None", "1★", "2★", "3★", "4★", "5★"]}
            series={[{ name: "Photos", values: ratings, color: "var(--lb-star)" }]}
          />
        </div>
      </div>
    </section>
  );
}

function ShootView({ shoot, onShoot }: { shoot: Shoot; onShoot(shoot?: Shoot): void }) {
  const client = useApp();
  const toast = useToast();
  const assets = useLoader(`assets:${shoot.id}`, (app) =>
    loadPages<StudioAsset>(app, "studioAssets", { shootId: shoot.id }, (page) => page.assets).then(({ items }) => items),
  );
  const [filter, setFilter] = useState("all");
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState<StudioAsset | null>(null);
  const [selectingCode, setSelectingCode] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const all = assets.data ?? [];
  const viewer = useViewer(all);

  const filters: FilterOption[] = [
    { id: "all", label: "All", count: all.length },
    { id: "picks", label: "Client picks", count: all.filter((asset) => asset.published && asset.pickCount > 0).length },
    { id: "notes", label: "Annotated", count: all.filter((asset) => asset.noteCount > 0).length },
    { id: "drafts", label: "Drafts", count: all.filter((asset) => !asset.published).length },
    ...COLOR_LABELS.map((label) => ({
      id: `label:${label}`,
      label: label[0]!.toUpperCase() + label.slice(1),
      swatch: label,
      count: all.filter((asset) => asset.colorLabel === label).length,
    })),
  ];
  const shown = useMemo(
    () =>
      all.filter((asset) =>
        filter === "picks"
          ? asset.published && asset.pickCount > 0
          : filter === "notes"
            ? asset.noteCount > 0
            : filter === "drafts"
              ? !asset.published
              : filter.startsWith("label:")
                ? asset.colorLabel === filter.slice(6)
                : true,
      ),
    [all, filter],
  );

  const patch = (assetId: string, change: Partial<StudioAsset>) =>
    assets.replace((list) => list.map((asset) => (asset.id === assetId ? { ...asset, ...change } : asset)));

  const change = async (asset: StudioAsset, next: Partial<StudioAsset>, operation: string, input: object, done: string) => {
    const keys = Object.keys(next) as Array<keyof StudioAsset>;
    const before = Object.fromEntries(keys.map((key) => [key, asset[key]])) as Partial<StudioAsset>;
    patch(asset.id, next);
    try {
      await invoke(client, operation, input);
      patch(asset.id, next);
      toast(done);
      onShoot();
    } catch (error) {
      assets.replace((list) =>
        list.map((item) => {
          if (item.id !== asset.id) return item;
          const reverted: Partial<StudioAsset> = {};
          for (const key of keys) {
            if (item[key] === next[key]) (reverted as Record<string, unknown>)[key] = before[key];
          }
          return { ...item, ...reverted };
        }),
      );
      toast(errorMessage(error), { tone: "danger", retry: () => void change(asset, next, operation, input, done) });
    }
  };

  const rate = (asset: StudioAsset, rating: number) =>
    change(asset, { rating }, "setOwnerRating", { assetId: asset.id, rating }, rating ? `Rated ${asset.title} ${rating}★.` : `Cleared the rating on ${asset.title}.`);
  const label = (asset: StudioAsset, colorLabel: ColorLabel) =>
    change(
      asset,
      { colorLabel },
      "setColorLabel",
      { assetId: asset.id, colorLabel },
      colorLabel === "none" ? `Removed the label from ${asset.title}.` : `Labelled ${asset.title} ${colorLabel}.`,
    );
  const publish = (asset: StudioAsset) =>
    change(
      asset,
      { published: !asset.published },
      "publishAsset",
      { assetIds: [asset.id], published: !asset.published },
      asset.published ? `${asset.title} is hidden from the client.` : `${asset.title} is in the client gallery.`,
    );

  const publishDrafts = async (drafts: readonly StudioAsset[], priorPublished = 0, total = drafts.length) => {
    if (!drafts.length) return;
    let published = priorPublished;
    for (let offset = 0; offset < drafts.length; offset += 100) {
      const batch = drafts.slice(offset, offset + 100);
      const batchIds = new Set(batch.map((asset) => asset.id));
      try {
        await invoke(client, "publishAsset", { assetIds: [...batchIds], published: true });
        published += batch.length;
        assets.replace((list) => list.map((asset) => (batchIds.has(asset.id) ? { ...asset, published: true } : asset)));
      } catch (error) {
        if (published > priorPublished) onShoot();
        const remaining = drafts.slice(offset);
        const detail = errorMessage(error);
        toast(
          published > 0 ? `Published ${published} of ${total} photos before stopping: ${detail}` : detail,
          { tone: "danger", retry: () => void publishDrafts(remaining, published, total) },
        );
        return;
      }
    }
    toast(`Published ${published} photo${published === 1 ? "" : "s"}.`);
    onShoot();
  };

  const publishAll = () => publishDrafts(all.filter((asset) => !asset.published));

  const keys = (event: KeyboardEvent | globalThis.KeyboardEvent, asset: StudioAsset) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const current = all.find((item) => item.id === asset.id) ?? asset;
    if (/^[0-5]$/.test(event.key)) void rate(current, Number(event.key));
    else if (LABEL_KEYS[event.key]) void label(current, current.colorLabel === LABEL_KEYS[event.key] ? "none" : LABEL_KEYS[event.key]!);
    else if (event.key === " ") void publish(current);
    else return false;
    return true;
  };

  const addFiles = async (files: readonly File[]) => {
    for (const file of files) {
      const problem = checkPhoto(file);
      if (problem) {
        toast(problem, { tone: "danger" });
        continue;
      }
      setUploads((count) => count + 1);
      try {
        const sent = await uploadPhoto(client, file);
        const asset = await invoke<StudioAsset>(client, "uploadAsset", {
          shootId: shoot.id,
          fileId: sent.fileId,
          width: sent.width,
          height: sent.height,
        });
        assets.replace((list) => [...list, asset]);
        toast(`Added ${asset.title} (${formatBytes(sent.bytes)} in ${Math.round(sent.ms)} ms). It stays a draft until you publish it.`);
        onShoot();
      } catch (error) {
        toast(`${file.name}: ${errorMessage(error)}`, { tone: "danger", retry: () => void addFiles([file]) });
      } finally {
        setUploads((count) => count - 1);
      }
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const remove = async (asset: StudioAsset) => {
    setDeleting(null);
    try {
      await invoke(client, "deleteAsset", { assetId: asset.id });
      if (asset.fileId) revokePhotoFileUrl(STUDIO_FILES.operation, asset.fileId);
      assets.replace((list) => list.filter((item) => item.id !== asset.id));
      viewer.close();
      toast(`Deleted ${asset.title}.`);
      onShoot();
    } catch (error) {
      toast(errorMessage(error), { tone: "danger", retry: () => void remove(asset) });
    }
  };

  const setStatus = async (status: Shoot["status"]) => {
    try {
      onShoot(await invoke<Shoot>(client, "updateShoot", { shootId: shoot.id, status }));
      toast(
        status === "proofing"
          ? "The gallery is open. Send the client the gallery code."
          : status === "delivered"
            ? "Delivered. The client can still look, but picks and notes are closed."
            : "Back to draft. The client gallery is closed.",
      );
    } catch (error) {
      toast(errorMessage(error), { tone: "danger", retry: () => void setStatus(status) });
    }
  };

  const noteRules: NoteRules = {
    load: async (photo: PhotoSource) =>
      (await loadPages<Note>(client, "studioAnnotations", { assetId: photo.id }, (page) => page.annotations)).items,
    resolve: async (note, resolved) => {
      await invoke(client, "resolveAnnotation", { annotationId: note.id, resolved });
      assets.replace((list) =>
        list.map((asset) =>
          asset.id === note.assetId ? { ...asset, openNoteCount: asset.openNoteCount + (resolved ? -1 : 1) } : asset,
        ),
      );
      onShoot();
    },
    add: async (photo, draft) => {
      const note = await invoke<Note>(client, "addPinnedAnnotation", { code: shoot.accessCode, assetId: photo.id, ...draft });
      assets.replace((list) =>
        list.map((asset) =>
          asset.id === photo.id
            ? { ...asset, noteCount: asset.noteCount + 1, openNoteCount: asset.openNoteCount + 1 }
            : asset,
        ),
      );
      onShoot();
      return note;
    },
    askName: true,
  };
  const openAsset = viewer.current;
  const closedReason = !openAsset
    ? undefined
    : shoot.status !== "proofing"
      ? "Notes open while the gallery is in proofing."
      : !openAsset.published
        ? "Publish this photo to pin notes the client can see."
        : undefined;

  return (
    <div
      className={`lb-main${dragging ? " lb-dropping" : ""}`}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)}
      onDrop={drop}
    >
      <header className="lb-hero">
        <div className="lb-hero-text">
          <span className="lb-eyebrow">
            {shoot.clientName} · {formatDay(shoot.shotOn)}
          </span>
          <h1 className="lb-display">{shoot.title}</h1>
          <div className="lb-hero-meta">
            <div className="lb-segment" role="radiogroup" aria-label="Gallery status">
              {STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="radio"
                  aria-checked={shoot.status === status}
                  className={`lb-segment-item lb-status-${status}${shoot.status === status ? " lb-segment-on" : ""}`}
                  onClick={() => shoot.status !== status && void setStatus(status)}
                >
                  {STATUS_TEXT[status]}
                </button>
              ))}
            </div>
            {selectingCode ? (
              <label className="lb-code-field">
                <span className="lb-code-label">Gallery code</span>
                <input
                  id="gallery-code-value"
                  className="lb-code-input"
                  readOnly
                  value={formatCode(shoot.accessCode)}
                  aria-label="Gallery code"
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={() => setSelectingCode(false)}
                />
              </label>
            ) : (
              <button
                type="button"
                className="lb-code"
                title="Copy the gallery code"
                onClick={() =>
                  void copyText(formatCode(shoot.accessCode)).then((copied) => {
                    if (copied) {
                      toast("Gallery code copied.");
                    } else {
                      setSelectingCode(true);
                      toast("Selected the gallery code. Press Ctrl+C (or Cmd+C) to copy.");
                    }
                  })
                }
              >
                <span className="lb-code-label">Gallery code</span>
                <span className="lb-code-value" id="gallery-code-value">
                  {formatCode(shoot.accessCode)}
                </span>
              </button>
            )}
          </div>
        </div>
        <div className="lb-hero-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              assets.reload();
              onShoot();
            }}
            id="refresh-shoot"
          >
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit details
          </Button>
          <Button size="sm" onClick={() => setExporting(true)} id="export-picks">
            Final picks
          </Button>
          <Button
            size="sm"
            onClick={() => samplePhoto(all.length + 1).then((file) => addFiles([file]))}
            id="add-sample"
            title="Renders a 2400 × 1600 JPEG in the browser and uploads it like a real photo"
          >
            Add sample photo
          </Button>
          <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()} loading={uploads > 0} id="upload">
            {uploads > 0 ? `Uploading ${uploads}…` : "Upload photos"}
          </Button>
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

      {assets.error && !assets.data ? (
        <Callout tone="danger" title="Couldn't load photos" action={<Button onClick={assets.reload}>Try again</Button>}>
          {errorMessage(assets.error)}
        </Callout>
      ) : !assets.data ? (
        <div className="lb-loading-grid">
          {[1.5, 0.67, 1.5, 1.33, 0.75, 1.5].map((ratio, index) => (
            <div key={index} className="lb-photo-loading" style={{ flexGrow: ratio * 100, aspectRatio: String(ratio) }} />
          ))}
        </div>
      ) : (
        <>
          {assets.error ? (
            <Callout tone="danger" title="Couldn't refresh photos" action={<Button size="sm" onClick={assets.reload}>Try again</Button>}>
              {errorMessage(assets.error)}
            </Callout>
          ) : null}
          <ShootStats shoot={shoot} assets={all} />
          <div className="lb-toolbar">
            <FilterBar options={filters} value={filter} onChange={setFilter} label="Show photos" />
            {all.some((asset) => !asset.published) ? (
              <Button size="sm" variant="ghost" onClick={() => void publishAll()}>
                Publish all drafts
              </Button>
            ) : null}
          </div>
          <p className="lb-keys" aria-hidden="true">
            <kbd>←</kbd> <kbd>→</kbd> move · <kbd>Enter</kbd> inspect · <kbd>1</kbd>–<kbd>5</kbd> rate · <kbd>0</kbd> clear ·{" "}
            <kbd>Space</kbd> publish · <kbd>6</kbd>–<kbd>9</kbd> label
          </p>
          {shown.length ? (
            <PhotoGrid
              items={shown}
              access={STUDIO_FILES}
              cursor={cursor}
              onCursor={setCursor}
              onOpen={(index) => viewer.open(shown, index)}
              onKey={keys}
              label="Photos in this shoot"
              muted={(asset) => !asset.published}
              badges={(asset) => (
                <>
                  {asset.colorLabel !== "none" ? (
                    <span className={`lb-swatch lb-label-${asset.colorLabel}`} title={`${asset.colorLabel} label`} />
                  ) : null}
                  {asset.rating ? <Stars value={asset.rating} /> : null}
                  {!asset.published ? <span className="lb-tag">Draft</span> : null}
                  {asset.published && asset.pickCount ? (
                    <span className="lb-tag lb-tag-pick" title={`${asset.pickCount} client picks`}>
                      ♥ {asset.pickCount}
                    </span>
                  ) : null}
                  {asset.openNoteCount ? (
                    <span className="lb-tag lb-tag-note" title={`${asset.openNoteCount} open notes`}>
                      ✎ {asset.openNoteCount}
                    </span>
                  ) : null}
                </>
              )}
            />
          ) : (
            <EmptyState
              title={all.length ? "Nothing matches this filter" : "No photos yet"}
              description={
                all.length
                  ? "Try another filter."
                  : "Upload JPEG, PNG, or WebP photos up to 5 MB, or drop them here. They stay drafts until you publish them."
              }
              action={
                all.length ? (
                  <Button onClick={() => setFilter("all")}>Show all</Button>
                ) : (
                  <Button variant="primary" onClick={() => fileInput.current?.click()}>
                    Upload photos
                  </Button>
                )
              }
            />
          )}
        </>
      )}

      {openAsset ? (
        <Inspector
          items={viewer.items}
          index={viewer.index}
          onIndex={(index) => {
            viewer.move(index);
            setCursor(shown.findIndex((asset) => asset.id === viewer.items[index]?.id));
          }}
          onClose={viewer.close}
          access={STUDIO_FILES}
          eyebrow={shoot.title}
          rules={{ ...noteRules, closedReason }}
          onKey={keys}
          caption={(asset) => (
            <span className="lb-caption">
              {asset.rating ? <Stars value={asset.rating} /> : "Unrated"} · {asset.pickCount} pick{asset.pickCount === 1 ? "" : "s"}
            </span>
          )}
          controls={(asset) => (
            <div className="lb-controls">
              <div className="lb-control-row">
                <span className="lb-control-label">Rating</span>
                <div className="lb-rate" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      role="radio"
                      aria-checked={asset.rating === star}
                      aria-label={`${star} star${star === 1 ? "" : "s"}`}
                      className={star <= asset.rating ? "lb-star-on" : undefined}
                      onClick={() => void rate(asset, asset.rating === star ? 0 : star)}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>
              <div className="lb-control-row">
                <span className="lb-control-label">Label</span>
                <div className="lb-labels" role="radiogroup" aria-label="Color label">
                  {COLOR_LABELS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={asset.colorLabel === color}
                      aria-label={color}
                      className={`lb-swatch lb-swatch-button lb-label-${color}${asset.colorLabel === color ? " lb-swatch-on" : ""}`}
                      onClick={() => void label(asset, asset.colorLabel === color ? "none" : color)}
                    />
                  ))}
                </div>
              </div>
              <div className="lb-control-row">
                <span className="lb-control-label">Client</span>
                <Button size="sm" variant={asset.published ? "secondary" : "primary"} onClick={() => void publish(asset)} id="publish-toggle">
                  {asset.published ? "Hide from gallery" : "Publish to gallery"}
                </Button>
              </div>
              <dl className="lb-facts">
                <dt>Size</dt>
                <dd>
                  {asset.width} × {asset.height}
                  {asset.fileId ? ` · ${formatBytes(asset.byteLength)}` : " · sample"}
                </dd>
                <dt>Picks</dt>
                <dd>{asset.pickCount}</dd>
              </dl>
              <button type="button" className="lb-link lb-link-danger" onClick={() => setDeleting(asset)}>
                Delete photo
              </button>
            </div>
          )}
        />
      ) : null}

      {editing ? (
        <ShootForm
          open
          shoot={shoot}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onShoot(saved);
            toast("Shoot saved.");
          }}
        />
      ) : null}
      {exporting ? <ExportModal shoot={shoot} onClose={() => setExporting(false)} /> : null}
      <Modal
        open={deleting !== null}
        title="Delete this photo?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)} id="delete-confirm">
              Delete
            </Button>
          </>
        }
      >
        <p>
          {deleting?.title} and its {deleting?.pickCount ?? 0} picks and {deleting?.noteCount ?? 0} notes will be removed. You
          can't undo this.
        </p>
      </Modal>
    </div>
  );
}

function coverPhoto(shoot: Shoot): PhotoSource | null {
  return shoot.cover ? { ...shoot.cover, id: shoot.cover.assetId, title: shoot.title } : null;
}

function loadShoots(client: AppClient) {
  return loadPages<Shoot>(client, "listShoots", {}, (page) => page.shoots).then(({ items }) => items);
}

function Studio() {
  const shoots = useLoader("shoots", loadShoots);
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const list = shoots.data ?? [];
  const shoot =
    list.find((item) => item.id === chosen) ?? list.find((item) => item.status === "proofing") ?? list[0];
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
  return (
    <div className="lb-app">
      <nav className="lb-rail" aria-label="Shoots">
        <div className="lb-brand">
          <span className="lb-brand-mark" aria-hidden="true" />
          <span>Lightbox</span>
        </div>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} id="new-shoot">
          New shoot
        </Button>
        {shoots.error && !shoots.data ? (
          <Callout tone="danger" action={<Button size="sm" onClick={shoots.reload}>Try again</Button>}>
            {errorMessage(shoots.error)}
          </Callout>
        ) : !shoots.data ? (
          <Skeleton height={120} />
        ) : (
          <ul className="lb-shoots">
            {list.map((item) => {
              const cover = coverPhoto(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`lb-shoot${item.id === shoot?.id ? " lb-shoot-on" : ""}`}
                    aria-current={item.id === shoot?.id ? "true" : undefined}
                    onClick={() => setChosen(item.id)}
                  >
                    <span className="lb-shoot-cover">
                      {cover ? <Photo photo={cover} access={STUDIO_FILES} size="thumb" /> : null}
                    </span>
                    <span className="lb-shoot-text">
                      <strong>{item.title}</strong>
                      <span>
                        <span className={`lb-dot lb-status-${item.status}`} aria-hidden="true" /> {STATUS_TEXT[item.status]} ·{" "}
                        {item.assetCount} photos
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      {shoot ? (
        <ShootView key={shoot.id} shoot={shoot} onShoot={update} />
      ) : shoots.data ? (
        <div className="lb-main">
          <EmptyState
            title="No shoots yet"
            description="Create a shoot, upload photos, then send the client the gallery code."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New shoot
              </Button>
            }
          />
        </div>
      ) : (
        <div className="lb-main" />
      )}
      {creating ? (
        <ShootForm
          open
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
      ) : null}
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
