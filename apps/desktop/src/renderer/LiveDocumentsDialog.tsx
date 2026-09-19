import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { CopyDetailsButton, errorDetails } from "./shell/copyDetails";
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

/** A share whose live editing did not start. */
export type LiveRefusalRow = {
  shareId: string;
  paths: string[];
  code: string;
  message: string;
};

/** One page of refused shares. Only the cursor says whether more exist: an
 * empty page proves nothing about the next one. */
export type LiveRefusalPage = {
  refusals: LiveRefusalRow[];
  nextCursor: string | null;
};

export type LiveDocumentsDialogProps = {
  workspaceId: string;
  load: (workspaceId: string, retiredAfter?: string) => Promise<LiveDocumentPage>;
  stop: (workspaceId: string, path: string) => Promise<void>;
  resume: (workspaceId: string, path: string) => Promise<void>;
  /** One page of refused shares, from the share id the previous page ended on. */
  loadRefusals: (workspaceId: string, after?: string) => Promise<LiveRefusalPage>;
  /** Asks the engine to enrol one refused share again. */
  retryRefusal: (workspaceId: string, shareId: string) => Promise<void>;
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
// Refresh repeats both reads without enrolling a share twice.
type RefusalWork =
  | { kind: "page"; cursor?: string }
  | { kind: "retry"; shareId: string; label: string }
  | { kind: "refresh" };
type RefusalState =
  | { kind: "loading" }
  | { kind: "ready"; rows: LiveRefusalRow[]; nextCursor: string | null }
  | { kind: "unknown" };
type Scope = { live: boolean };

const readFailedMessage = "dohc could not load the live documents for this workspace.";
const refusalsReadFailedMessage =
  "dohc could not load the shares that could not start live editing.";
// What did not happen, in the words this dialog owns.
const REFUSAL_SENTENCE = "This share could not start live editing automatically.";
// Enough files to recognize the share without turning a row into a listing.
const REFUSAL_PATHS_SHOWN = 5;

const REFUSAL_REASONS: Record<string, string> = {
  quota_exceeded: "A server limit is preventing live editing. Stop live editing for unused documents or check the server limits.",
  bad_request: "The server could not accept this share for live editing. Copy the details to check the server setup.",
  conflict: "This share no longer matches the current workspace or document. Check its files and sync before trying again.",
  not_found: "The server could not find this share or workspace. Check the share before trying again.",
};
const SAFE_REFUSAL_MESSAGES = new Set([
  "This share has too many files for live editing.",
  "This server supports up to 64 live documents.",
  "Service host enrollment capacity is full.",
  "The server has no room for more live documents. Stop live editing for unused documents, then try again.",
  "Sync this workspace before enabling live editing.",
  "Service host enrollment belongs to an obsolete workspace identity.",
  "Service host enrollment requires an owner edit share covering this path.",
  "Service host enrollment requires a current main document.",
  "Service host enrollment document moved from its retained path.",
  "Service host enrollment path belongs to another document.",
]);

function refusalReason(row: LiveRefusalRow): string {
  return Object.hasOwn(REFUSAL_REASONS, row.code)
    ? REFUSAL_REASONS[row.code]!
    : "Copy the details to check the server setup before trying again.";
}

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

/** What to call a refused share: its first file, or the share itself when the
 * engine returned no paths for it. */
function refusalLabel(row: LiveRefusalRow): string {
  return row.paths[0] ?? "this share";
}

function refusalBusyLabel(work: RefusalWork): string {
  if (work.kind === "retry") return `Retrying live editing for ${work.label}…`;
  if (work.kind === "refresh") return "Loading live documents…";
  return "Loading shares that could not start live editing…";
}

/** A read that covers both lists speaks for the dialog's main list; only an
 * ask that was itself refused names the share it was made for. */
function refusalFailureMessage(work: RefusalWork, retried: boolean): string {
  if (work.kind === "page") return refusalsReadFailedMessage;
  if (retried || work.kind === "refresh") return readFailedMessage;
  return `dohc could not retry live editing for ${work.label}.`;
}

/** Copy known diagnostics without forwarding arbitrary server text. */
function refusalDetails(row: LiveRefusalRow, workspaceId: string): string {
  return errorDetails([
    ["Live editing", REFUSAL_SENTENCE],
    ["Detail", refusalReason(row)],
    ["Reason code", Object.hasOwn(REFUSAL_REASONS, row.code) ? row.code : "unknown"],
    ["Server detail", SAFE_REFUSAL_MESSAGES.has(row.message) ? row.message : "No safe server detail available."],
    ["Files", row.paths.join(", ")],
    ["Workspace id", workspaceId],
    ["Time", new Date().toISOString()],
  ]);
}

export function LiveDocumentsDialog({
  workspaceId,
  load,
  stop,
  resume,
  loadRefusals,
  retryRefusal,
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
  // Refused shares read on the same scope, one page at a time.
  const [refusalState, setRefusalState] = useState<RefusalState>({ kind: "loading" });
  const [refusalBusy, setRefusalBusy] = useState<RefusalWork | null>(null);
  const refusalRequest = useRequestSequence([workspaceId]);
  const refusalRunning = useRef(false);
  const refusalPendingRetry = useRef<(() => boolean) | null>(null);
  // The cursor the page on screen was read with, so a retry refreshes that
  // page rather than jumping back to the first one.
  const refusalCursor = useRef<string | undefined>(undefined);

  // Reset while rendering, not in an effect: the next workspace must never
  // show the previous workspace's rows, not even for one frame.
  if (shownWorkspaceId !== workspaceId) {
    scope.current.live = false;
    scope.current = { live: true };
    running.current = false;
    pendingRetry.current = null;
    refusalRunning.current = false;
    refusalPendingRetry.current = null;
    refusalCursor.current = undefined;
    setShownWorkspaceId(workspaceId);
    setState({ kind: "loading" });
    setBusy(null);
    setRefusalState({ kind: "loading" });
    setRefusalBusy(null);
  }

  // Drain both queues; a busy retry waits for the current operation.
  function drainRetries(): void {
    const documentRetry = pendingRetry.current;
    pendingRetry.current = null;
    documentRetry?.();
    const refusalRetry = refusalPendingRetry.current;
    refusalPendingRetry.current = null;
    refusalRetry?.();
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
          drainRetries();
        }
      }
    })();
  }

  function performRefusals(work: RefusalWork): void {
    // Enrollment and refresh share both request gates and paint atomically.
    const both = work.kind !== "page";
    if (refusalRunning.current || !scope.current.live) return;
    if (both && running.current) return;
    refusalRunning.current = true;
    const startedIn = scope.current;
    const refusalToken = refusalRequest.next();
    const documentToken = both ? request.next() : null;
    if (both) {
      running.current = true;
      // The document list is about to be replaced: a queued retry for it is
      // overtaken and reloads instead of replaying its action.
      operation.current += 1;
    }
    const isCurrent = () =>
      startedIn.live &&
      refusalRequest.isCurrent(refusalToken) &&
      (documentToken === null || request.isCurrent(documentToken));
    // A page read names its own cursor; the others refresh the page on screen.
    const cursor = work.kind === "page" ? work.cursor : refusalCursor.current;
    setRefusalBusy(work);

    void (async () => {
      let retried = false;
      try {
        if (work.kind === "retry") {
          await retryRefusal(workspaceId, work.shareId);
          if (!isCurrent()) return;
          retried = true;
        }
        const [documents, page] = await Promise.all([
          both ? load(workspaceId, undefined) : null,
          loadRefusals(workspaceId, cursor),
        ]);
        if (!isCurrent()) return;
        refusalCursor.current = cursor;
        if (documents) {
          setState({
            kind: "ready",
            rows: mergeRows([], documents.documents),
            nextCursor: documents.nextCursor,
          });
        }
        // The page replaces what was on screen, and its cursor is the only
        // word on whether more exist: an empty page can still have a next one.
        setRefusalState({ kind: "ready", rows: page.refusals, nextCursor: page.nextCursor });
      } catch (error) {
        if (!isCurrent()) return;
        // A refused ask leaves both lists as they were; a failed read leaves
        // what it was reading unproven.
        if (work.kind !== "retry" || retried) {
          setRefusalState({ kind: "unknown" });
          if (both) setState({ kind: "unknown" });
        }
        const retry = (): boolean => {
          if (!startedIn.live) return false;
          if (refusalRunning.current || running.current) {
            refusalPendingRetry.current = retry;
            return true;
          }
          // The share was already asked, so only the reads are left to repeat.
          performRefusals(retried ? { kind: "refresh" } : work);
          return true;
        };
        onError(refusalFailureMessage(work, retried), error, retry);
      } finally {
        if (isCurrent()) {
          refusalRunning.current = false;
          if (both) running.current = false;
          setRefusalBusy(null);
          drainRetries();
        }
      }
    })();
  }

  useEffect(() => {
    scope.current = { live: true };
    running.current = false;
    pendingRetry.current = null;
    refusalRunning.current = false;
    refusalPendingRetry.current = null;
    refusalCursor.current = undefined;
    perform({ kind: "reload" });
    // One page of refusals on open; every later page is asked for by hand.
    performRefusals({ kind: "page" });
    return () => { scope.current.live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  function close(): void {
    scope.current.live = false;
    pendingRetry.current = null;
    refusalPendingRetry.current = null;
    request.next();
    refusalRequest.next();
    onClose();
  }

  const nextCursor = state.kind === "ready" ? state.nextCursor : null;
  const refusalRows = refusalState.kind === "ready" ? refusalState.rows : [];
  const refusalNextCursor =
    refusalState.kind === "ready" ? refusalState.nextCursor : null;
  // A proven-empty last page keeps the section out of the dialog.
  const refusalsShown =
    refusalState.kind === "unknown" ||
    refusalRows.length > 0 ||
    refusalNextCursor !== null;
  // An enrollment retry owns the document list too, so its controls rest.
  const listBusy = busy !== null || (refusalBusy !== null && refusalBusy.kind !== "page");

  return (
    <Overlay
      onClose={close}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": "live-documents-title",
        "data-testid": "live-documents-dialog",
        // Account for the overlay's 96px top and 16px bottom insets.
        className:
          "dohc-elevated dohc-pop-in max-h-[calc(100vh-112px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-line bg-panel p-5",
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
          disabled={listBusy}
          data-testid="live-documents-reload"
          onClick={() => {
            perform({ kind: "reload" });
            // Back to the first page: Reload means "what is true now".
            performRefusals({ kind: "page" });
          }}
        >
          Reload
        </SecondaryButton>
      </div>

      {/* One live region for the dialog, so two announcements never overlap. */}
      <p role="status" aria-live="polite" className="mt-3 h-4 truncate text-[12px] text-muted">
        {busy ? busyLabel(busy) : refusalBusy ? refusalBusyLabel(refusalBusy) : ""}
      </p>

      {state.kind === "ready" ? (
        state.rows.length ? (
          <ul
            aria-busy={listBusy}
            aria-label="Live documents"
            className="divide-y divide-line border-y border-line"
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
                    disabled={listBusy}
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
                    disabled={listBusy}
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

      {/* Its own section: these shares are not editing live, so they must
          never read as rows of the list above. */}
      {refusalsShown ? (
        <section data-testid="live-refusals" className="mt-5">
          <h3 className="m-0 text-[13px] font-semibold text-ink">
            Shares that could not start live editing
          </h3>
          {refusalState.kind === "unknown" ? (
            <p className="mt-2 text-[13px] text-muted">
              This list is not current. Reload to check these shares again.
            </p>
          ) : refusalRows.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted">
              No refused shares on this page. Load more to keep looking.
            </p>
          ) : (
            <ul
              aria-busy={refusalBusy !== null}
              aria-label="Shares that could not start live editing"
              className="mt-2 divide-y divide-line border-y border-line"
            >
              {refusalRows.map((row) => (
                <li
                  key={row.shareId}
                  data-testid={`live-refusal-row-${row.shareId}`}
                  className="flex flex-wrap items-start gap-3 py-2"
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-0">
                    <p className="m-0 text-[12px] text-ink">{REFUSAL_SENTENCE}</p>
                    <p className="mb-1 mt-1 text-[12px] text-muted">{refusalReason(row)}</p>
                    {row.paths.slice(0, REFUSAL_PATHS_SHOWN).map((path) => (
                      <p
                        key={path}
                        title={path}
                        className="m-0 truncate font-mono text-[12px] text-muted"
                      >
                        {path}
                      </p>
                    ))}
                    {row.paths.length > REFUSAL_PATHS_SHOWN ? (
                      <p className="m-0 text-[12px] text-subtle">
                        {`and ${row.paths.length - REFUSAL_PATHS_SHOWN} more files`}
                      </p>
                    ) : null}
                  </div>
                  <SecondaryButton
                    size="compact"
                    className="shrink-0"
                    disabled={listBusy || refusalBusy !== null}
                    aria-label={`Retry live editing for ${refusalLabel(row)}`}
                    onClick={() =>
                      performRefusals({
                        kind: "retry",
                        shareId: row.shareId,
                        label: refusalLabel(row),
                      })
                    }
                  >
                    Try again
                  </SecondaryButton>
                  <CopyDetailsButton
                    iconOnly
                    label={`Copy details for ${refusalLabel(row)}`}
                    data-testid={`live-refusal-copy-${row.shareId}`}
                    details={() => refusalDetails(row, workspaceId)}
                  />
                </li>
              ))}
            </ul>
          )}
          {refusalNextCursor !== null ? (
            <div className="mt-3 flex">
              <SecondaryButton
                disabled={refusalBusy !== null}
                data-testid="live-refusals-more"
                onClick={() =>
                  performRefusals({ kind: "page", cursor: refusalNextCursor })
                }
              >
                Load more
              </SecondaryButton>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {nextCursor !== null ? (
          <SecondaryButton
            className="mr-auto"
            disabled={listBusy}
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
