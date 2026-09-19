import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { EmptyState, SecondaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";

export type LiveDocumentRow = {
  path: string;
  status: "ready" | "preparing" | "paused" | "unavailable" | "retired";
  reason?: "document-unavailable" | "workspace-changed";
  canResume: boolean;
};

/** One read: the latest active documents, then the next page of stopped ones. */
export type LiveDocumentPage = {
  documents: LiveDocumentRow[];
  nextCursor: string | null;
};

export type LiveDocumentsDialogProps = {
  workspaceId: string;
  load: (workspaceId: string, retiredAfter?: string) => Promise<LiveDocumentPage>;
  stop: (workspaceId: string, path: string) => Promise<void>;
  resume: (workspaceId: string, path: string) => Promise<void>;
  onClose: () => void;
  /** Reported to the shell, which owns the toast and the Notices row. The
   * retry returns false once this workspace scope is gone, so the shell can
   * offer to reopen the dialog instead of running work nobody can see. */
  onError: (message: string, error: unknown, retry: () => boolean) => void;
};

type Work =
  | { kind: "reload" }
  | { kind: "more"; cursor: string }
  | { kind: "stop"; path: string }
  | { kind: "resume"; path: string };
type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: LiveDocumentRow[]; nextCursor: string | null }
  | { kind: "unknown" };
type Scope = { live: boolean };

const readFailedMessage = "dohc could not load the live documents for this workspace.";

function isMutation(work: Work): work is { kind: "stop" | "resume"; path: string } {
  return work.kind === "stop" || work.kind === "resume";
}

// A page lists the newest row for a path first, and every page carries a fresh
// read of the active documents. So the first row of the newest response wins,
// and it replaces the older row in place rather than moving it down the list.
// Keep current documents above stopped history, including resumed paths.
function mergeRows(
  existing: LiveDocumentRow[],
  incoming: LiveDocumentRow[],
): LiveDocumentRow[] {
  const currentPaths = new Set(incoming.map((row) => row.path));
  const merged = existing.filter((row) => row.status === "retired" || currentPaths.has(row.path));
  const positions = new Map(merged.map((row, index) => [row.path, index]));
  const taken = new Set<string>();
  for (const row of incoming) {
    if (taken.has(row.path)) continue;
    taken.add(row.path);
    const at = positions.get(row.path);
    if (at === undefined) {
      positions.set(row.path, merged.length);
      merged.push(row);
    } else merged[at] = row;
  }
  return [
    ...merged.filter((row) => row.status !== "retired"),
    ...merged.filter((row) => row.status === "retired"),
  ];
}

function statusLabel(row: LiveDocumentRow): string {
  if (row.reason === "document-unavailable") return "File moved or removed";
  if (row.reason === "workspace-changed") return "Workspace changed";
  switch (row.status) {
    case "ready":
      return "Live";
    case "preparing":
      return "Preparing";
    case "paused":
      return "Paused";
    case "retired":
      return "Stopped";
    default:
      return "Unavailable";
  }
}

function statusTone(row: LiveDocumentRow): string {
  if (row.status === "ready") return "text-success";
  if (row.status === "unavailable") return "text-warning";
  return "text-muted";
}

/** A stopped document is already stopped; everything else can be stopped. */
function canStop(row: LiveDocumentRow): boolean {
  return row.status !== "retired";
}

/** Resuming needs a document dohc can still open in this workspace. */
function canResume(row: LiveDocumentRow): boolean {
  return (row.status === "retired" || row.status === "paused") && row.canResume && !row.reason;
}

function busyLabel(work: Work): string {
  switch (work.kind) {
    case "reload":
      return "Loading live documents…";
    case "more":
      return "Loading more live documents…";
    case "stop":
      return `Stopping live editing for ${work.path}…`;
    default:
      return `Resuming live editing for ${work.path}…`;
  }
}

function failureMessage(work: Work, readFailed: boolean): string {
  if (readFailed || !isMutation(work)) return readFailedMessage;
  return work.kind === "stop"
    ? `dohc could not stop live editing for ${work.path}.`
    : `dohc could not resume live editing for ${work.path}.`;
}

export function LiveDocumentsDialog({
  workspaceId,
  load,
  stop,
  resume,
  onClose,
  onError,
}: LiveDocumentsDialogProps) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState<Work | null>(null);
  const [shownWorkspaceId, setShownWorkspaceId] = useState(workspaceId);
  const request = useRequestSequence([workspaceId]);
  const running = useRef(false);
  const pendingRetry = useRef<(() => boolean) | null>(null);
  // Bumped whenever the list is replaced or a document changes, so a retry can
  // tell "the failure the user is looking at" from one they have overtaken.
  const operation = useRef(0);
  const scope = useRef<Scope>({ live: true });

  // Reset while rendering, not in an effect: the next workspace must never
  // show the previous workspace's rows, not even for one frame.
  if (shownWorkspaceId !== workspaceId) {
    scope.current.live = false;
    scope.current = { live: true };
    running.current = false;
    pendingRetry.current = null;
    setShownWorkspaceId(workspaceId);
    setState({ kind: "loading" });
    setBusy(null);
  }

  function perform(work: Work): void {
    // Synchronous, so a second click in the same tick cannot start a second
    // request before React re-renders the disabled buttons.
    if (running.current || !scope.current.live) return;
    running.current = true;
    const startedIn = scope.current;
    const token = request.next();
    const isCurrent = () => startedIn.live && request.isCurrent(token);
    // A "more" read extends the list it was started from, so it does not
    // change the context a pending retry was offered for.
    const startedOperation = work.kind === "more" ? operation.current : ++operation.current;
    setBusy(work);

    void (async () => {
      let mutated = false;
      try {
        if (isMutation(work)) {
          await (work.kind === "stop" ? stop : resume)(workspaceId, work.path);
          if (!isCurrent()) return;
          mutated = true;
        }
        const cursor = work.kind === "more" ? work.cursor : undefined;
        const page = await load(workspaceId, cursor);
        if (!isCurrent()) return;
        setState((previous) => ({
          kind: "ready",
          rows: mergeRows(
            cursor !== undefined && previous.kind === "ready" ? previous.rows : [],
            page.documents,
          ),
          nextCursor: page.nextCursor,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        // Only a failed read leaves the list unproven. A refused action and a
        // failed "more" both keep the rows the last successful read proved.
        if (work.kind === "reload" || mutated) setState({ kind: "unknown" });
        const retry = (): boolean => {
          if (!startedIn.live) return false;
          if (running.current) {
            pendingRetry.current = retry;
            return true;
          }
          const overtaken = operation.current !== startedOperation;
          perform(overtaken || mutated ? { kind: "reload" } : work);
          return true;
        };
        onError(failureMessage(work, mutated), error, retry);
      } finally {
        if (isCurrent()) {
          running.current = false;
          setBusy(null);
          const retry = pendingRetry.current;
          pendingRetry.current = null;
          retry?.();
        }
      }
    })();
  }

  useEffect(() => {
    scope.current = { live: true };
    running.current = false;
    pendingRetry.current = null;
    perform({ kind: "reload" });
    return () => { scope.current.live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  function close(): void {
    scope.current.live = false;
    pendingRetry.current = null;
    request.next();
    onClose();
  }

  const nextCursor = state.kind === "ready" ? state.nextCursor : null;

  return (
    <Overlay
      onClose={close}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": "live-documents-title",
        "data-testid": "live-documents-dialog",
        className:
          "dohc-elevated dohc-pop-in w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5",
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="live-documents-title" className="m-0 text-sm font-semibold text-ink">
            Live documents
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Stopping live editing keeps the file and its history. Share permissions stay unchanged.
          </p>
        </div>
        <SecondaryButton
          size="compact"
          disabled={busy !== null}
          data-testid="live-documents-reload"
          onClick={() => perform({ kind: "reload" })}
        >
          Reload
        </SecondaryButton>
      </div>

      <p role="status" aria-live="polite" className="mt-3 h-4 truncate text-[12px] text-muted">
        {busy ? busyLabel(busy) : ""}
      </p>

      {state.kind === "ready" ? (
        state.rows.length ? (
          <ul
            aria-busy={busy !== null}
            aria-label="Live documents"
            className="max-h-[50vh] overflow-y-auto divide-y divide-line border-y border-line"
          >
            {state.rows.map((row) => (
              <li
                key={row.path}
                data-testid={`live-document-row-${row.path}`}
                className="flex flex-wrap items-center gap-3 py-2"
              >
                <span
                  title={row.path}
                  className="min-w-0 basis-full truncate font-mono text-[12px] text-ink sm:flex-1 sm:basis-0"
                >
                  {row.path}
                </span>
                <span className={`shrink-0 text-[12px] ${statusTone(row)}`}>
                  {statusLabel(row)}
                </span>
                {canResume(row) ? (
                  <SecondaryButton
                    size="compact"
                    className="shrink-0"
                    disabled={busy !== null}
                    aria-label={`Resume live editing for ${row.path}`}
                    onClick={() => perform({ kind: "resume", path: row.path })}
                  >
                    Resume live editing
                  </SecondaryButton>
                ) : null}
                {canStop(row) ? (
                  <SecondaryButton
                    size="compact"
                    className="shrink-0"
                    disabled={busy !== null}
                    aria-label={`Stop live editing for ${row.path}`}
                    onClick={() => perform({ kind: "stop", path: row.path })}
                  >
                    Stop live editing
                  </SecondaryButton>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex py-10">
            <EmptyState
              title="No live documents in this workspace."
              hint="Reload after a document starts live editing."
            />
          </div>
        )
      ) : null}

      {state.kind === "unknown" ? (
        <p className="py-6 text-[13px] text-muted">
          This list is not current. Reload to see this workspace's live documents.
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {nextCursor !== null ? (
          <SecondaryButton
            className="mr-auto"
            disabled={busy !== null}
            data-testid="live-documents-more"
            onClick={() => perform({ kind: "more", cursor: nextCursor })}
          >
            Load more
          </SecondaryButton>
        ) : null}
        <SecondaryButton onClick={close}>Close</SecondaryButton>
      </div>
    </Overlay>
  );
}
