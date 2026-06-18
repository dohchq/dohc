import { Archive, CheckCircle2, Download, Upload, X } from "lucide-react";
import type { DragEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { bridge } from "./bridge";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function pluralFile(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

export function ImportExportDialog(props: {
  workspaceId: string;
  activePath: string | null;
  selectedText?: string;
  onImported: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragActive, setDragActive] = useState(false);
  const [fragmentText, setFragmentText] = useState(props.selectedText ?? "");
  const canUseActivePath = useMemo(
    () => typeof props.activePath === "string" && props.activePath.length > 0,
    [props.activePath],
  );

  useEffect(() => {
    setFragmentText(props.selectedText ?? "");
  }, [props.selectedText]);

  async function importPaths(droppedPaths?: string[]) {
    setStatus({ kind: "busy", label: "Importing..." });
    try {
      const result = await bridge().importWorkspaceFiles({
        workspaceId: props.workspaceId,
        ...(droppedPaths ? { droppedPaths } : {}),
      });
      props.onImported();
      setStatus({
        kind: "success",
        message:
          result.imported.length > 0
            ? `Imported ${pluralFile(result.imported.length)}.`
            : "No files imported.",
      });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  async function exportZip(relativePath?: string) {
    setStatus({ kind: "busy", label: "Exporting..." });
    try {
      const result = await bridge().exportWorkspaceZip({
        workspaceId: props.workspaceId,
        ...(relativePath ? { relativePath } : {}),
      });
      setStatus({
        kind: "success",
        message: result.path ? `Exported ${result.path}.` : "Export canceled.",
      });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  async function copyFragment() {
    const body = fragmentText.trim().length > 0 ? fragmentText : (props.selectedText ?? "");
    if (body.trim().length === 0) {
      setStatus({ kind: "error", message: "Select or enter data to export." });
      return;
    }
    setStatus({ kind: "busy", label: "Exporting fragment..." });
    const payload = {
      kind: "dohc.fragment.v1",
      sourcePath: props.activePath,
      body,
      createdAt: new Date().toISOString(),
    };
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatus({
        kind: "success",
        message: "Copied data fragment.",
      });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  async function importFragment() {
    if (!canUseActivePath || !props.activePath) {
      setStatus({ kind: "error", message: "Open a file before importing data." });
      return;
    }
    const body = parseFragmentBody(fragmentText);
    if (body.trim().length === 0) {
      setStatus({ kind: "error", message: "Paste data to import." });
      return;
    }
    setStatus({ kind: "busy", label: "Importing fragment..." });
    try {
      const current = await bridge().readWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.activePath,
      });
      const separator =
        current.text.length === 0 || current.text.endsWith("\n") ? "" : "\n";
      await bridge().writeWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.activePath,
        text: `${current.text}${separator}${body}`,
      });
      props.onImported();
      setStatus({ kind: "success", message: "Imported data fragment." });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const paths = bridge().getDroppedFilePaths([...event.dataTransfer.files]);
    if (paths.length === 0) {
      setStatus({ kind: "success", message: "No files imported." });
      return;
    }
    void importPaths(paths);
  }

  const busy = status.kind === "busy";

  return (
    <section
      data-testid="import-export-dialog"
      className="flex w-[min(560px,calc(100vw-32px))] flex-col rounded-md border border-line bg-panel text-sm text-ink shadow-lg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Archive size={15} aria-hidden className="text-subtle" />
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">Import / export</h2>
          <p className="m-0 truncate font-mono text-[11px] text-subtle">
            {props.activePath ?? "Workspace"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close import export dialog"
          onClick={props.onClose}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      </header>

      <div className="space-y-3 p-4">
        <section className="rounded border border-line bg-bg p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0">
              <p className="m-0 text-xs font-medium text-ink">Data fragment</p>
              <p className="m-0 truncate font-mono text-[11px] text-subtle">
                {props.activePath ?? "No file selected"}
              </p>
            </div>
            <button
              type="button"
              data-testid="export-fragment-action"
              disabled={busy}
              onClick={() => void copyFragment()}
              className="ml-auto h-8 shrink-0 rounded bg-accent px-3 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
            >
              Export selection
            </button>
          </div>
          <textarea
            data-testid="fragment-text"
            value={fragmentText}
            onChange={(event) => setFragmentText(event.target.value)}
            placeholder="Paste or select data"
            spellCheck={false}
            className="mt-3 h-24 w-full resize-none rounded border border-line bg-panel px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              data-testid="import-fragment-action"
              disabled={busy || !canUseActivePath}
              onClick={() => void importFragment()}
              className="h-8 rounded border border-line px-3 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
            >
              Import into file
            </button>
          </div>
        </section>

        <div
          data-testid="import-drop-zone"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`flex min-h-20 items-center gap-3 rounded border border-dashed px-3 py-3 ${
            dragActive ? "border-ink bg-line/40" : "border-line bg-bg"
          }`}
        >
          <Upload size={16} aria-hidden className="shrink-0 text-subtle" />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-xs font-medium text-ink">Import files</p>
            <p className="m-0 truncate text-[11px] text-subtle">Drop files here or use the picker.</p>
          </div>
          <button
            type="button"
            data-testid="import-files-action"
            disabled={busy}
            onClick={() => void importPaths()}
            className="h-8 shrink-0 rounded bg-accent px-3 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
          >
            Import
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            data-testid="export-workspace-action"
            disabled={busy}
            onClick={() => void exportZip()}
            className="flex h-11 items-center gap-2 rounded border border-line bg-bg px-3 text-left text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
          >
            <Download size={15} aria-hidden className="shrink-0" />
            <span className="min-w-0">
              <span className="block font-medium text-ink">Export workspace</span>
              <span className="block truncate text-[11px] text-subtle">Zip archive</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="export-current-action"
            disabled={busy || !canUseActivePath}
            onClick={() => void exportZip(props.activePath ?? undefined)}
            className="flex h-11 items-center gap-2 rounded border border-line bg-bg px-3 text-left text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
          >
            <Download size={15} aria-hidden className="shrink-0" />
            <span className="min-w-0">
              <span className="block font-medium text-ink">Export current file</span>
              <span className="block truncate font-mono text-[11px] text-subtle">
                {props.activePath ?? "No file selected"}
              </span>
            </span>
          </button>
        </div>

        {status.kind !== "idle" ? (
          <div
            data-testid="import-export-status"
            role={status.kind === "error" ? "alert" : "status"}
            className={`flex min-h-8 items-center gap-2 rounded border px-3 py-2 text-xs ${
              status.kind === "error"
                ? "border-danger/30 text-danger"
                : "border-line text-muted"
            }`}
          >
            {status.kind === "busy" ? (
              <span className="size-2 rounded-full bg-subtle" aria-hidden />
            ) : status.kind === "success" ? (
              <CheckCircle2 size={13} aria-hidden className="shrink-0 text-success" />
            ) : null}
            <span className="min-w-0 truncate">
              {status.kind === "busy" ? status.label : status.message}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function parseFragmentBody(value: string): string {
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; body?: unknown };
    if (parsed.kind === "dohc.fragment.v1" && typeof parsed.body === "string") {
      return parsed.body;
    }
  } catch {
    // Plain text is a valid fragment input.
  }
  return value;
}
