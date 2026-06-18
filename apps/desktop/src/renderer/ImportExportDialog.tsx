import {
  CheckCircle2,
  Cloud,
  Inbox,
  Send,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DataFragmentSummary } from "../ipc/bridgeContract";
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

export function ImportExportDialog(props: {
  workspaceId: string;
  activePath: string | null;
  selectedText?: string;
  onImported: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fragmentText, setFragmentText] = useState(props.selectedText ?? "");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [cloudReady, setCloudReady] = useState<boolean | null>(null);
  const [cloudLabel, setCloudLabel] = useState("Checking dohc Cloud...");
  const [sharedFragments, setSharedFragments] = useState<DataFragmentSummary[]>([]);
  const [selectedFragmentId, setSelectedFragmentId] = useState("");
  const canUseActivePath = useMemo(
    () => typeof props.activePath === "string" && props.activePath.length > 0,
    [props.activePath],
  );
  const hasFragmentText = fragmentText.trim().length > 0;
  const selectedFragment = sharedFragments.find(
    (fragment) => fragment.fragmentId === selectedFragmentId,
  );

  useEffect(() => {
    setFragmentText(props.selectedText ?? "");
  }, [props.selectedText]);

  useEffect(() => {
    let cancelled = false;
    setCloudReady(null);
    setCloudLabel("Checking dohc Cloud...");
    setSharedFragments([]);
    setSelectedFragmentId("");
    bridge()
      .cloudStatus({ workspaceId: props.workspaceId })
      .then(async (cloud) => {
        if (cancelled) return;
        if (!cloud.connected) {
          setCloudReady(false);
          setCloudLabel("Sign in to dohc Cloud to exchange data fragments.");
          return;
        }
        if (!cloud.workspaceSynced) {
          setCloudReady(false);
          setCloudLabel("Sync this workspace to dohc Cloud to exchange data fragments.");
          return;
        }
        setCloudReady(true);
        setCloudLabel(cloud.email ? `Connected as ${cloud.email}` : "Connected to dohc Cloud");
        const result = await bridge().listDataFragments({
          workspaceId: props.workspaceId,
        });
        if (cancelled) return;
        setSharedFragments(result.fragments);
        setSelectedFragmentId(result.fragments[0]?.fragmentId ?? "");
      })
      .catch((cause) => {
        if (cancelled) return;
        setCloudReady(false);
        setCloudLabel(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId]);

  async function exportDataFragment() {
    const body = fragmentText.trim().length > 0 ? fragmentText : (props.selectedText ?? "");
    if (body.trim().length === 0) {
      setStatus({ kind: "error", message: "Select or enter data to export." });
      return;
    }
    const email = recipientEmail.trim();
    if (email.length === 0) {
      setStatus({ kind: "error", message: "Enter a recipient email." });
      return;
    }
    try {
      setStatus({ kind: "busy", label: "Exporting selected data..." });
      const result = await bridge().createDataFragment({
        workspaceId: props.workspaceId,
        ...(props.activePath ? { sourcePath: props.activePath } : {}),
        body,
        contentType: "text/plain",
        recipientEmail: email,
      });
      setStatus({
        kind: "success",
        message: `Exported selected data to ${result.fragment.recipientEmail ?? email}.`,
      });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  async function importSharedData() {
    if (!canUseActivePath || !props.activePath) {
      setStatus({ kind: "error", message: "Open a file before importing data." });
      return;
    }
    if (!selectedFragmentId) {
      setStatus({ kind: "error", message: "Choose shared data to import." });
      return;
    }
    try {
      setStatus({ kind: "busy", label: "Importing shared data..." });
      const fragment = await bridge().readDataFragment({
        workspaceId: props.workspaceId,
        fragmentId: selectedFragmentId,
      });
      const current = await bridge().readWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.activePath,
      });
      const separator =
        current.text.length === 0 || current.text.endsWith("\n") ? "" : "\n";
      await bridge().writeWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.activePath,
        text: `${current.text}${separator}${fragment.fragment.body}`,
      });
      props.onImported();
      setStatus({
        kind: "success",
        message: `Inserted shared data into ${props.activePath}.`,
      });
    } catch (cause) {
      setStatus({ kind: "error", message: errorMessage(cause) });
    }
  }

  const busy = status.kind === "busy";
  const cloudAvailable = cloudReady === true;

  return (
    <section
      data-testid="import-export-dialog"
      className="flex w-[min(560px,calc(100vw-32px))] flex-col rounded-md border border-line bg-panel text-sm text-ink shadow-lg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Cloud size={15} aria-hidden className="text-subtle" />
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold">Data fragments</h2>
          <p className="m-0 truncate font-mono text-[11px] text-subtle">
            {props.activePath ?? "No target file"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close data fragments dialog"
          onClick={props.onClose}
          className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      </header>

      <div className="space-y-3 p-4">
        <section className="rounded border border-ink/20 bg-bg p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <p className="m-0 text-xs font-semibold text-ink">Cloud data fragment</p>
              <p className="m-0 truncate font-mono text-[11px] text-subtle">
                {props.activePath ?? "No file selected"}
              </p>
            </div>
            <div
              data-testid="fragment-cloud-status"
              className={`ml-auto flex min-w-0 max-w-56 items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                cloudReady === false
                  ? "border-danger/30 text-danger"
                  : "border-line text-subtle"
              }`}
            >
              <Cloud size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{cloudLabel}</span>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink">
                <Send size={13} aria-hidden />
                <span>Export selected data</span>
              </div>
              <textarea
                data-testid="fragment-text"
                value={fragmentText}
                onChange={(event) => setFragmentText(event.target.value)}
                placeholder="Selected data to export"
                spellCheck={false}
                className="h-24 w-full resize-none rounded border border-line bg-panel px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
              />
              <div className="mt-2 flex gap-2">
                <input
                  data-testid="fragment-recipient-email"
                  value={recipientEmail}
                  onChange={(event) => setRecipientEmail(event.target.value)}
                  placeholder="recipient@company.com"
                  type="email"
                  className="h-8 min-w-0 flex-1 rounded border border-line bg-panel px-2 text-xs text-ink outline-none focus:border-ink"
                />
                <button
                  type="button"
                  data-testid="export-fragment-action"
                  disabled={busy || !cloudAvailable || !hasFragmentText || recipientEmail.trim().length === 0}
                  onClick={() => void exportDataFragment()}
                  className="h-8 shrink-0 rounded bg-accent px-3 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
                >
                  Export
                </button>
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink">
                <Inbox size={13} aria-hidden />
                <span>Import shared data</span>
              </div>
              <select
                data-testid="shared-fragment-select"
                value={selectedFragmentId}
                onChange={(event) => setSelectedFragmentId(event.target.value)}
                disabled={busy || !cloudAvailable || sharedFragments.length === 0}
                className="h-8 w-full rounded border border-line bg-panel px-2 text-xs text-ink outline-none focus:border-ink disabled:opacity-40"
              >
                {sharedFragments.length === 0 ? (
                  <option value="">No shared data</option>
                ) : null}
                {sharedFragments.map((fragment) => (
                  <option key={fragment.fragmentId} value={fragment.fragmentId}>
                    {fragment.title}
                  </option>
                ))}
              </select>
              <p
                data-testid="shared-fragment-preview"
                className="mt-2 line-clamp-2 min-h-8 text-[11px] text-subtle"
              >
                {selectedFragment?.preview ?? "Nothing shared to this account yet."}
              </p>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  data-testid="import-fragment-action"
                  disabled={busy || !cloudAvailable || !canUseActivePath || !selectedFragmentId}
                  onClick={() => void importSharedData()}
                  className="h-8 rounded border border-line px-3 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
                >
                  Insert into this file
                </button>
              </div>
            </div>
          </div>
        </section>

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
