import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ImagePlus, Paperclip, Trash2, X } from "lucide-react";
import {
  INBOX_PASTED_IMAGE_MIME_TYPES,
  MAX_INBOX_IMAGE_BYTES,
  MAX_INBOX_PASTED_IMAGES,
  type InboxCapturedItem,
  type InboxPastedImage,
  type InboxPastedImageMimeType,
  type InboxSkippedFile,
} from "@dohc/workspace-contracts/inbox";
import { readError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { FieldError, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";

export interface QuickCaptureOutcome {
  items: InboxCapturedItem[];
  skipped: number;
  skippedSources: InboxSkippedFile[];
  createdInbox: boolean;
}

export interface QuickCaptureDialogProps {
  workspaceId: string;
  resolveDroppedFilePaths(files: File[]): string[];
  onClose(): void;
  onCaptured(outcome: QuickCaptureOutcome): void;
}

const INPUT_CLASS =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-accent focus:outline-none";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isAllowedImageMime(type: string): type is InboxPastedImageMimeType {
  return (INBOX_PASTED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

export function QuickCaptureDialog(props: QuickCaptureDialogProps) {
  return <ScopedQuickCaptureDialog key={props.workspaceId} {...props} />;
}

function ScopedQuickCaptureDialog({
  workspaceId,
  resolveDroppedFilePaths,
  onClose,
  onCaptured,
}: QuickCaptureDialogProps) {
  const titleId = useId();
  const errorId = useId();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [pastedImages, setPastedImages] = useState<InboxPastedImage[]>([]);
  const [droppedPaths, setDroppedPaths] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    titleInputRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && isAllowedImageMime(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (imageFiles.length === 0) return;

    event.preventDefault();
    setError(null);
    const next: InboxPastedImage[] = [];
    for (const file of imageFiles) {
      if (pastedImages.length + next.length >= MAX_INBOX_PASTED_IMAGES) {
        setError(`You can attach up to ${MAX_INBOX_PASTED_IMAGES} pasted images at once.`);
        break;
      }
      if (file.size > MAX_INBOX_IMAGE_BYTES) {
        setError(
          `${file.name || "Pasted image"} exceeds ${Math.round(MAX_INBOX_IMAGE_BYTES / (1024 * 1024))} MiB. Use a smaller image.`,
        );
        continue;
      }
      const mimeType = file.type;
      if (!isAllowedImageMime(mimeType)) continue;
      const bytesBase64 = arrayBufferToBase64(await file.arrayBuffer());
      next.push({
        name: file.name || `clipboard-${Date.now()}.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        bytesBase64,
      });
    }
    if (alive.current && next.length > 0) {
      setPastedImages((current) => [...current, ...next]);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    const paths = resolveDroppedFilePaths(files);
    if (paths.length === 0) return;
    setError(null);
    setDroppedPaths((current) => [...new Set([...current, ...paths])]);
  }

  async function handlePickFiles() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await bridge().inboxCaptureFiles({
        workspaceId,
        pick: true,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(body.trim() ? { body } : {}),
        ...(pastedImages.length > 0 ? { pastedImages } : {}),
        ...(droppedPaths.length > 0 ? { droppedPaths } : {}),
      });
      if (!alive.current) return;
      if (outcome.items.length === 0 && outcome.skipped === 0) {
        setPending(false);
        return;
      }
      onCaptured(outcome);
    } catch (cause) {
      if (alive.current) setError(readError(cause).words);
    } finally {
      if (alive.current) setPending(false);
    }
  }

  async function handleSubmit() {
    if (pending) return;
    const hasText = Boolean(title.trim() || url.trim() || body.trim());
    const hasFiles = pastedImages.length > 0 || droppedPaths.length > 0;
    if (!hasText && !hasFiles) {
      setError("Enter a note, link, or attach a file to capture.");
      titleInputRef.current?.focus();
      return;
    }

    setPending(true);
    setError(null);
    try {
      if (hasFiles) {
        const outcome = await bridge().inboxCaptureFiles({
          workspaceId,
          ...(droppedPaths.length > 0 ? { droppedPaths } : {}),
          ...(pastedImages.length > 0 ? { pastedImages } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(body.trim() ? { body } : {}),
        });
        if (!alive.current) return;
        onCaptured(outcome);
        return;
      }

      const added = await bridge().inboxAdd({
        workspaceId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(body.trim() ? { body } : {}),
      });
      if (!alive.current) return;
      onCaptured({
        items: [
          { path: added.path, recordId: added.recordId, title: added.title, attachments: [] },
        ],
        skipped: 0,
        skippedSources: [],
        createdInbox: added.createdInbox,
      });
    } catch (cause) {
      if (alive.current) setError(readError(cause).words);
    } finally {
      if (alive.current) setPending(false);
    }
  }

  return (
    <Overlay onClose={pending ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="quick-capture-dialog"
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void handleSubmit();
          }
        }}
        className={`dohc-elevated dohc-pop-in flex max-h-[85vh] w-[540px] max-w-[92vw] flex-col overflow-hidden rounded-xl border bg-panel transition-colors ${
          dragOver ? "border-accent ring-2 ring-accent/30" : "border-line"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="m-0 flex-1 text-sm font-semibold text-ink">
            Capture to Inbox
          </h2>
          <IconButton aria-label="Close" title="Close" disabled={pending} onClick={onClose}>
            <X size={14} strokeWidth={1.9} aria-hidden />
          </IconButton>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Title
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              disabled={pending}
              placeholder="Optional title"
              onChange={(event) => {
                setTitle(event.target.value);
                if (error) setError(null);
              }}
              onPaste={(event) => void handlePaste(event)}
              className={INPUT_CLASS}
            />
          </label>

          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Link
            <input
              type="url"
              value={url}
              disabled={pending}
              placeholder="https://…"
              onChange={(event) => {
                setUrl(event.target.value);
                if (error) setError(null);
              }}
              className={INPUT_CLASS}
            />
          </label>

          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Note
            <textarea
              rows={5}
              value={body}
              disabled={pending}
              placeholder="Write a note, drop files here, or paste an image…"
              onChange={(event) => {
                setBody(event.target.value);
                if (error) setError(null);
              }}
              onPaste={(event) => void handlePaste(event)}
              className={`${INPUT_CLASS} resize-y`}
            />
          </label>

          {pastedImages.length > 0 || droppedPaths.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="quick-capture-attachments">
              {pastedImages.map((image, index) => (
                <span
                  key={`img-${index}-${image.name}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink"
                >
                  <ImagePlus size={12} className="text-muted" aria-hidden />
                  <span className="max-w-[180px] truncate">{image.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    disabled={pending}
                    onClick={() =>
                      setPastedImages((current) => current.filter((_, at) => at !== index))
                    }
                    className="text-muted hover:text-ink"
                  >
                    <Trash2 size={12} aria-hidden />
                  </button>
                </span>
              ))}
              {droppedPaths.map((filePath) => {
                const label = filePath.split(/[\\/]/u).at(-1) ?? filePath;
                return (
                  <span
                    key={filePath}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink"
                  >
                    <Paperclip size={12} className="text-muted" aria-hidden />
                    <span className="max-w-[180px] truncate">{label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${label}`}
                      disabled={pending}
                      onClick={() =>
                        setDroppedPaths((current) => current.filter((entry) => entry !== filePath))
                      }
                      className="text-muted hover:text-ink"
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}

          {error ? <FieldError id={errorId}>{error}</FieldError> : null}

          <div className="flex items-center justify-between gap-2 pt-1">
            <SecondaryButton
              type="button"
              disabled={pending}
              className="inline-flex items-center gap-1.5"
              onClick={() => void handlePickFiles()}
            >
              <Paperclip size={13} strokeWidth={1.9} aria-hidden />
              Add files…
            </SecondaryButton>

            <div className="flex items-center gap-2">
              <SecondaryButton type="button" disabled={pending} onClick={onClose}>
                Cancel
              </SecondaryButton>
              <PrimaryButton type="submit" disabled={pending}>
                {pending ? "Capturing…" : "Capture"}
              </PrimaryButton>
            </div>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
