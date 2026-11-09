import { EmptyState, GhostButton, Pill, RetryRow, SecondaryButton, PrimaryButton } from "../ui/controls";
import { EMPTY_ART } from "./EmptyArt";
import { useRequestSequence } from "../useRequestSequence";
import { ipcErrorMessage } from "../ipcError";
import { isMergeStoppedPartway, isWorkspaceUpdatingError, isConflictStaleTarget, readError, versionNameRefusal } from "../../ipc/errorWords";
import { SyncedDeletionRevivalError, SyncedDeletionStaleError } from "../../workspaces/syncedDeletionRefusal";
import { ChevronDown, ChevronsUpDown, CircleAlert, Diff, FileArchive, FileText, Hourglass, Layers, Lock, Merge, Plus, RefreshCw, Share2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ResolveWorkspaceVersionConflictResult,
  WorkspaceVersionConflict,
  WorkspaceVersionFileChange,
  WorkspaceVersionRecord,
} from "../../ipc/bridgeContract";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../../workspaces/workspaceEngineCaptureLimits";
import {
  exceedsUtf8Bytes,
  utf8ByteLength,
} from "../../workspaces/workspaceTextLimits";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import { errorDetails } from "../shell/copyDetails";
import { SectionLabel } from "../ui/controls";
import { MENU_SEPARATOR, Menu, type MenuEntry } from "../ui/Menu";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import { createActivityCoalescer } from "../workspaceActivityCoalescer";
import {
  CONFLICT_COMBINED_EDIT_MAX_BYTES,
  applyCombinedChange,
  conflictPreview,
} from "./conflictPane";
import { UnifiedDiffLines, buildUnifiedDiffLines, computeTextDiff } from "./unifiedDiff";
import { versionDotClass } from "./versionHue";

// Named versions surface. Product vocabulary only: Version, Main, compare,
// merge, keep — never git terms. The shell mounts it only for a workspace
// with a capture, and every async response is gated by a liveness token before it
// touches state (plan-level non-negotiable: a slow response for one
// workspace must never repaint another).

export interface WorkspaceVersionsSnapshot {
  versions: WorkspaceVersionRecord[];
  activeVersionId: string;
}

function versionName(
  snapshot: WorkspaceVersionsSnapshot | null,
  versionId: string | null,
): string {
  if (!versionId) return "Main";
  return (
    snapshot?.versions.find((version) => version.id === versionId)?.name ?? "Main"
  );
}

const VERSION_LOAD_RETRY_MS = 1_000;
const VERSION_LOAD_FAILURE_ATTEMPTS = 5;

// How long a read waits for its answer. The engine can leave a read with no
// answer while the workspace's engine thread is stuck (#3318), so the
// Versions reads give up, in the words of the engine's own deadline.
const READ_DEADLINE_MS = 30_000;

// The read, or a failure once it has gone READ_DEADLINE_MS with no answer. An
// answer after that is dropped.
export function withDeadline<T>(read: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${what} got no answer in ${READ_DEADLINE_MS} ms.`);
      error.name = "EngineRequestDeadlineError";
      reject(error);
    }, READ_DEADLINE_MS);
    read.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

// A version's merge notice, so a later merge of the same version takes it back.
function mergeIdentity(workspaceId: string, versionId: string): string {
  return `version-merge:${workspaceId}:${versionId}`;
}

// A merge's notice, whose Try again waits while a merge dialog is open.
export function isVersionMergeIdentity(identity: string | undefined): boolean {
  return identity?.startsWith("version-merge:") === true;
}

// How a merge answered after its dialog closed.
type MergeAnswer =
  // A null count: the merge left files to decide, and they were all decided
  // before the answer came.
  | { kind: "merged"; mergedFileCount: number | null; replacedProtectedPaths: string[] }
  | { kind: "decide"; conflictCount: number; replacedProtectedPaths: string[] }
  | { kind: "failed"; error: unknown };

// A merge that answered after its dialog closed, as a toast and a Notices
// row. A merge that left files to decide names its version, so the shell can
// offer the review and take the row back once none of them wait.
export interface VersionMergeNotice {
  identity: string;
  tone?: "success" | "warning";
  title?: string;
  message: string;
  cause?: unknown;
  // The protected files it replaced, one per line under the message.
  paths?: readonly string[];
  // Answers false when it could not merge again, so the row stays.
  retry?: (() => void | false) | null;
  decideFrom?: string;
  // It stopped partway, and History shows which files are in Main.
  offersHistory?: true;
}

// Whether a merge from this version still has files to decide. It reads the
// open conflicts page by page and stops at the first one.
export async function mergeFilesWait(workspaceId: string, sourceVersionId: string): Promise<boolean> {
  let afterConflictId: string | undefined;
  do {
    const page = await bridge().listWorkspaceVersionConflicts({
      workspaceId,
      ...(afterConflictId === undefined ? {} : { afterConflictId }),
    });
    if (page.conflicts.some((conflict) => conflict.origin === "merge" && conflict.sourceVersionId === sourceVersionId)) return true;
    afterConflictId = page.nextAfterConflictId ?? undefined;
  } while (afterConflictId !== undefined);
  return false;
}

function protectedCopyWords(paths: readonly string[], sourceName: string): string {
  return `${paths.length === 1 ? "One protected file" : `${paths.length} protected files`} took ${sourceName}'s copy.`;
}

const AFTER_STORE_FIX = "Fix the data store problem in Notices, then merge again.";

// The notice for a merge that answered after its dialog closed. A null
// retry means capture stopped. That happens when the data store was
// refused, and its own notice says how to fix it.
function mergeNotice(
  identity: string,
  source: WorkspaceVersionRecord,
  answer: MergeAnswer,
  retry: (() => void | false) | null,
): VersionMergeNotice {
  if (answer.kind === "failed") {
    if (isMergeStoppedPartway(answer.error)) {
      const title = `dohc could not finish merging ${source.name} into Main`;
      return retry === null
        ? { identity, title, message: `Some of ${source.name}'s changes are in Main. ${AFTER_STORE_FIX}`, cause: answer.error }
        : { identity, title, message: `Some of ${source.name}'s changes are in Main, and History shows which.`, cause: answer.error, retry, offersHistory: true };
    }
    const title = `dohc could not merge ${source.name} into Main`;
    if (retry === null) return { identity, title, message: AFTER_STORE_FIX, cause: answer.error };
    const { words } = readError(answer.error);
    return { identity, ...(words ? { title, message: words } : { message: `${title}.` }), cause: answer.error, retry };
  }
  const protectedPaths = answer.replacedProtectedPaths;
  const protectedLine = protectedPaths.length > 0 ? protectedCopyWords(protectedPaths, source.name) : null;
  const paths = protectedPaths.length > 0 ? { paths: protectedPaths } : {};
  if (answer.kind === "decide") {
    return {
      identity,
      tone: "warning",
      title: `Merging ${source.name} into Main needs a decision`,
      message: [conflictCountCopy(answer.conflictCount, false), protectedLine].filter(Boolean).join(" "),
      ...paths,
      decideFrom: source.id,
    };
  }
  const { mergedFileCount } = answer;
  const said =
    mergedFileCount === null
      ? `Merged ${source.name} into Main`
      : mergedFileCount === 0
        ? `No files from ${source.name} merged into Main`
        : `Merged ${mergedFileCount} file${mergedFileCount === 1 ? "" : "s"} from ${source.name} into Main`;
  return {
    identity,
    tone: "success",
    ...(protectedLine === null ? { message: said } : { title: said, message: protectedLine, ...paths }),
  };
}

export interface WorkspaceVersionsOptions {
  workspaceId: string;
  // False while the workspace has no capture: nothing loads and no dialog shows.
  enabled: boolean;
  activeTabDirty: boolean;
  // Settles drafts and queued collection writes, and pauses new cell edits
  // until the returned release runs. Each operation holds the release across
  // its version IPCs so no cell edit lands between the drain and the
  // lineage change; a rejection means an unresolved write refused the
  // operation, with the user-facing line as the error message.
  beginLineageOperation: () => Promise<() => void>;
  // Fired after any operation that may have changed disk or history state so
  // the shell refreshes files/history and reloads open editors.
  // Pass the version that is active now when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string, lineageChanged?: boolean) => void;
  // A create or merge failure names what failed, and a later success of the
  // same create or merge takes its notice back, whichever control ran it.
  onError: (message: string, cause: unknown, retry?: () => void, identity?: string) => void;
  clearError: (identity: string) => void;
  // A merge that answered after its dialog closed.
  onMergeNotice: (notice: VersionMergeNotice) => void;
  // Whether a merge dialog is open, so a merge notice's Try again waits.
  onMergeOpenChange?: (open: boolean) => void;
  // A merge that stopped partway offers History, which shows what is in Main.
  onOpenHistory?: () => void;
  // A conflict choice in the merge dialog reports a fallback and the error,
  // so a refusal can show its own title and instructions.
  onConflictError: (fallback: string, error: unknown) => void;
  // Bumped by the shell when version state changed outside these controls,
  // so they re-read the active version instead of showing a stale name.
  refreshKey?: number;
}

// How the name field that started a create hears how it went.
export interface VersionNameField {
  // dohc can't use the name. The field keeps it and shows why.
  refuse(reason: ReactNode): void;
  created(): void;
  // A failure notice's Try again opens the field again with the name, then creates.
  reopen(name: string): void;
}

// The workspace's versions and what changes them, shared by the titlebar menu
// and the Versions page, so a switch, create or merge runs once whichever
// surface started it, and both show it.
export interface WorkspaceVersions {
  snapshot: WorkspaceVersionsSnapshot | null;
  active: WorkspaceVersionRecord | null;
  onMain: boolean;
  busy: "switch" | "create" | null;
  // Every load attempt failed, and reload tries again.
  loadFailed: boolean;
  reload(): void;
  requestSwitch(versionId: string): void;
  create(name: string, field: VersionNameField): void;
  openMerge(version: WorkspaceVersionRecord): void;
  // The save-first prompt and the merge dialog. The shell renders them once.
  dialogs: ReactNode;
}

export function useWorkspaceVersions(props: WorkspaceVersionsOptions): WorkspaceVersions {
  const { workspaceId, enabled } = props;
  const [snapshot, setSnapshot] = useState<WorkspaceVersionsSnapshot | null>(null);
  const [busy, setBusy] = useState<"switch" | "create" | null>(null);
  // Dirty-editor guard: the version id waiting on "Save and switch".
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // The version the merge dialog is open for, and whether it merges as it
  // opens, for a notice's Try again.
  const [merge, setMerge] = useState<{ source: WorkspaceVersionRecord; runOnOpen: boolean } | null>(null);
  const mergeOpen = useRef(false);
  mergeOpen.current = merge !== null;
  const { onMergeOpenChange } = props;
  const mergeIsOpen = merge !== null;
  // Once when it opens, and once when it closes or the menu goes.
  useEffect(() => {
    if (!mergeIsOpen) return;
    onMergeOpenChange?.(true);
    return () => onMergeOpenChange?.(false);
  }, [mergeIsOpen, onMergeOpenChange]);
  // Whether capture is still on, so a merge notice's Try again can open the
  // dialog again.
  const captureLive = useRef(false);
  useEffect(() => {
    captureLive.current = enabled;
    return () => {
      captureLive.current = false;
    };
  }, [enabled]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Two questions, and they are not the same one.
  //
  // May this read still write the snapshot? A newer read answers no — from a
  // re-key, an unmount, or a mutation about to change what the read describes.
  const snapshotToken = useRef(0);
  // Is this mutation still the one running? Only another mutation, an
  // unmount, or losing the capture answers no. A re-key must not: the
  // announcement that a switch succeeded is itself what re-keys the reads, so
  // a shared counter let the switch invalidate its own token — its finally
  // then skipped, and the selector sat disabled on "Switching…" for the rest
  // of the session.
  const operationToken = useRequestSequence([workspaceId, enabled]);
  // A mutation supersedes both: it is the running operation now, and any read
  // issued before it describes the world it is about to change.
  const beginOperation = useCallback(() => {
    snapshotToken.current += 1;
    return operationToken.next();
  }, []);
  // One switch or create at a time, whichever surface asks. A second would
  // take the first's token, so the first could neither finish its update nor
  // clear its busy state.
  const runningOperation = useRef<number | null>(null);
  const operationRunning = useCallback(
    () => runningOperation.current !== null && operationToken.isCurrent(runningOperation.current),
    [],
  );

  const refresh = useCallback(async () => {
    const token = snapshotToken.current;
    const result = await withDeadline(bridge().listWorkspaceVersions({ workspaceId }), "listWorkspaceVersions");
    if (token !== snapshotToken.current) return null;
    setSnapshot(result);
    return result;
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled) {
      // Losing the capture ends whatever was running, as unmounting the menu did.
      setSnapshot(null);
      setBusy(null);
      setPendingSwitch(null);
      setMerge(null);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    // The first load can race the workspace open. A large fresh import has an
    // engine-owned bound but may take much longer than a renderer retry
    // ladder, so keep waiting for that exact refusal. Other failures retain a
    // small bounded retry before the shell reports them.
    void (async () => {
      let lastError: unknown = null;
      let failureAttempts = 0;
      while (!cancelled) {
        try {
          await refresh();
          if (!cancelled) setLoadFailed(false);
          return;
        } catch (error) {
          lastError = error;
          // An initial import may outlive any fixed renderer deadline, so the
          // engine's still-updating refusal is waited out; every other error
          // gets a bounded retry and then the visible failure.
          if (!isWorkspaceUpdatingError(error)) {
            failureAttempts += 1;
            if (failureAttempts >= VERSION_LOAD_FAILURE_ATTEMPTS) break;
          }
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, VERSION_LOAD_RETRY_MS),
          );
        }
      }
      // Every attempt failed: say so instead of silently dropping the whole
      // versions surface for the session.
      if (!cancelled) {
        setLoadFailed(true);
        props.onError(
          ipcErrorMessage(lastError, "dohc could not load this workspace's versions."),
          lastError,
        );
      }
    })();
    return () => {
      cancelled = true;
      snapshotToken.current += 1;
    };
  }, [enabled, refresh, props.refreshKey, loadAttempt]);
  const reload = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  const active = useMemo(
    () =>
      snapshot?.versions.find((version) => version.id === snapshot.activeVersionId) ??
      null,
    [snapshot],
  );
  const onMain = (active?.kind ?? "main") === "main";
  // The version this workspace is on, readable inside async continuations
  // without a stale closure (assigned during render, readOnlyRef precedent).
  // performSwitch's failure path compares against it: a switch that never
  // took must not be announced as a version change.
  const activeVersionIdRef = useRef<string | null>(null);
  activeVersionIdRef.current = snapshot?.activeVersionId ?? null;

  const performSwitch = useCallback(
    async (versionId: string) => {
      if (operationRunning()) return;
      const token = beginOperation();
      runningOperation.current = token;
      const before = activeVersionIdRef.current;
      // Did the switch IPC start? The failure path below keys on this, not
      // on whether the version moved: main settles and closes live Y.Doc
      // sessions before it sets the active version, so a switch that failed
      // mid-way leaves the version unchanged and the sessions dead — only
      // the reopen re-binds them.
      let switchIssued = false;
      // The success path announces before its selector refresh, so a refresh
      // that fails must not announce again. A second
      // announcement bumps the version epoch a second time, and that
      // same-version reopen moves a freshly typed edit into set-aside
      // recovery — a notice the user then has to answer — for a
      // selector-refresh failure that changed nothing.
      let announced = false;
      setBusy("switch");
      let releaseOperation: (() => void) | null = null;
      try {
        releaseOperation = await props.beginLineageOperation();
        // Re-check liveness after every awaited step: the begin (or the
        // switch) may resolve after this panel was unmounted or superseded,
        // and a stale continuation must not mutate or repaint.
        if (!operationToken.isCurrent(token)) return;
        switchIssued = true;
        await bridge().switchWorkspaceVersion({ workspaceId, versionId });
        if (!operationToken.isCurrent(token)) return;
        // The switch succeeded, so this IS the active version now — say so
        // before awaiting anything else. Main notifies the renderer before
        // this invoke returns, so a history refresh for the old version can
        // already be in flight, and every await between here and the
        // announcement is a window it can answer in.
        props.onWorkspaceStateChanged(versionId);
        announced = true;
        await refresh();
      } catch (error) {
        if (!operationToken.isCurrent(token)) return;
        props.onError(ipcErrorMessage(error, "dohc could not switch versions."), error);
        // The switch may have partially applied before failing; make the
        // selector and editors reflect reality. Whatever stuck is what the
        // re-read reports, and if that read fails too, nobody knows.
        const recovered = await refresh().catch(() => null);
        if (!operationToken.isCurrent(token)) return;
        // Suppress the reopen only when the failure happened before the
        // switch IPC started (the pre-switch flush): nothing main-side ran,
        // the live sessions are untouched, and a reopen would set the
        // pending draft aside on the same version for nothing (#579 review,
        // r4). Once the switch IPC has started, announce even if the version
        // never moved — main may have closed the live sessions on its way to
        // the failure, and without the reopen the editor keeps a Y.Doc whose
        // session is gone. An unknown outcome (the re-read
        // failed too) also announces: showing an uncertain reality beats
        // staying blind.
        if (announced) return;
        if (
          !switchIssued &&
          recovered !== null &&
          recovered.activeVersionId === before
        ) {
          return;
        }
        props.onWorkspaceStateChanged(
          recovered?.activeVersionId,
          recovered === null ? switchIssued : recovered.activeVersionId !== before,
        );
      } finally {
        releaseOperation?.();
        if (runningOperation.current === token) runningOperation.current = null;
        if (operationToken.isCurrent(token)) setBusy(null);
      }
    },
    [beginOperation, operationRunning, props.beginLineageOperation, props.onError, props.onWorkspaceStateChanged, refresh, workspaceId],
  );

  const requestSwitch = useCallback(
    (versionId: string) => {
      if (versionId === snapshot?.activeVersionId) return;
      if (props.activeTabDirty) {
        // Save-first prompt: switching always saves into the current version
        // first, and the user should know that before it happens.
        setPendingSwitch(versionId);
        return;
      }
      void performSwitch(versionId);
    },
    [performSwitch, props.activeTabDirty, snapshot?.activeVersionId],
  );

  // A refused name stays in the field with its reason. Any other failure is
  // a notice whose Try again reopens the field with the name and creates.
  const performCreate = useCallback(
    async (name: string, field: VersionNameField) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        field.refuse("Enter a name for the version.");
        return;
      }
      if (operationRunning()) return;
      const identity = `version-create:${workspaceId}:${trimmed}`;
      const token = beginOperation();
      runningOperation.current = token;
      setBusy("create");
      let releaseOperation: (() => void) | null = null;
      try {
        releaseOperation = await props.beginLineageOperation();
        if (!operationToken.isCurrent(token)) return;
        const result = await bridge().createWorkspaceVersion({
          workspaceId,
          name: trimmed,
        });
        if (!operationToken.isCurrent(token)) return;
        setSnapshot(result);
        // Create-and-switch: the new version is the active one.
        props.onWorkspaceStateChanged(result.activeVersionId);
        props.clearError(identity);
        field.created();
      } catch (error) {
        if (!operationToken.isCurrent(token)) return;
        const refusal = versionNameRefusal(error);
        if (refusal !== null) {
          field.refuse(refusal === "taken"
            ? <>Another version is called <span className="font-medium">{trimmed}</span>. Choose another name.</>
            : "dohc can't use that name. Choose another name.");
          return;
        }
        props.onError(ipcErrorMessage(error, `dohc could not create the version ${trimmed}.`), error, () => {
          field.reopen(trimmed);
          void performCreate(trimmed, field);
        }, identity);
      } finally {
        releaseOperation?.();
        if (runningOperation.current === token) runningOperation.current = null;
        if (operationToken.isCurrent(token)) setBusy(null);
      }
    },
    [beginOperation, operationRunning, props.beginLineageOperation, props.clearError, props.onError, props.onWorkspaceStateChanged, workspaceId],
  );
  const create = useCallback((name: string, field: VersionNameField) => void performCreate(name, field), [performCreate]);

  // The dialog shows a merge's answer while it is open. Closed first, by the
  // person or because capture stopped, the merge keeps going and its answer
  // is a notice. This hook stays with the shell while capture comes and goes,
  // so a failure's Try again opens the dialog and merges again whenever
  // capture is on to do it.
  const answerMergeAway = useCallback(
    (version: WorkspaceVersionRecord, answer: MergeAnswer) => {
      const retry = () => {
        if (!captureLive.current || mergeOpen.current) return false;
        setMerge({ source: version, runOnOpen: true });
      };
      props.onMergeNotice(mergeNotice(mergeIdentity(workspaceId, version.id), version, answer, captureLive.current ? retry : null));
    },
    [props.onMergeNotice, workspaceId],
  );
  const openMerge = useCallback((version: WorkspaceVersionRecord) => setMerge({ source: version, runOnOpen: false }), []);

  const activeName = active?.name ?? "Main";
  const dialogs = !enabled || snapshot === null ? null : (
    <>
      {pendingSwitch !== null ? (
        // The panel holds focus, so a screen reader reads the title and body
        // before Tab reaches Cancel.
        <ConfirmDialog
          icon={Layers}
          title={`Switch to ${versionName(snapshot, pendingSwitch)}?`}
          confirmLabel="Save and switch"
          testId="version-switch-save-confirm"
          cancelTestId="version-switch-save-cancel"
          confirmTestId="version-switch-save-continue"
          onCancel={() => setPendingSwitch(null)}
          onConfirm={() => {
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (target) void performSwitch(target);
          }}
        >
          <p>
            dohc saves your changes in <span className="font-medium text-ink">{activeName}</span> first.
          </p>
        </ConfirmDialog>
      ) : null}

      {merge ? (
        <VersionMergeDialog
          workspaceId={workspaceId}
          source={merge.source}
          runOnOpen={merge.runOnOpen}
          {...(props.onOpenHistory ? { onOpenHistory: props.onOpenHistory } : {})}
          beginLineageOperation={props.beginLineageOperation}
          onWorkspaceStateChanged={props.onWorkspaceStateChanged}
          onMerged={() => props.clearError(mergeIdentity(workspaceId, merge.source.id))}
          onAnsweredAway={(answer) => answerMergeAway(merge.source, answer)}
          onConflictError={props.onConflictError}
          onClose={() => {
            setMerge(null);
            void refresh().catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );

  return { snapshot, active, onMain, busy, loadFailed, reload, requestSwitch, create, openMerge, dialogs };
}

// The version breadcrumb in the titlebar: shows the active version, switches
// on click, creates inline, and opens compare, merge and the Versions page.
export function VersionMenu(props: {
  versions: WorkspaceVersions;
  // The workspace is not ready for a version change.
  disabled?: boolean;
  onOpenCompare: (versionId: string) => void;
  onOpenAllVersions?: () => void;
  // "Share this version…": present only when the shell can open the
  // share dialog (synced, non-shared-view workspaces).
  onShareVersion?: (version: { id: string; name: string }) => void;
}) {
  const { snapshot, active, onMain, busy } = props.versions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  // Why the field or the engine refused the name being typed.
  const [nameError, setNameError] = useState<ReactNode>(null);

  // Every way the menu closes drops the name being typed and its error.
  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (open) return;
    setNewName(null);
    setNameError(null);
  }, []);
  const field = useMemo<VersionNameField>(() => ({
    refuse: setNameError,
    created: () => setMenu(false),
    reopen: (name) => {
      setMenuOpen(true);
      setNewName(name);
      setNameError(null);
    },
  }), [setMenu]);

  if (!snapshot) return null;

  const activeName = active?.name ?? "Main";
  const items: MenuEntry[] = [
    ...snapshot.versions.map((version) => ({
      id: `version:${version.id}`,
      // The chip's dot, so a person matches the chip to its row. Main keeps
      // the dot's space, so every name starts at the same place.
      label: (
        <>
          <span
            data-testid="version-item-dot"
            aria-hidden
            className={`mr-2 inline-block size-1.5 rounded-full align-middle ${version.kind === "main" ? "" : versionDotClass(version.id)}`}
          />
          {version.name}
        </>
      ),
      checked: version.id === snapshot.activeVersionId,
      // With only Main, one line under it says what a version is for.
      ...(snapshot.versions.length === 1 ? { description: "Try changes without touching Main." } : {}),
      testId: "version-item",
      data: { "data-version-id": version.id, "data-version-name": version.name },
      onSelect: () => {
        setMenu(false);
        props.versions.requestSwitch(version.id);
      },
    })),
    newName === null
      ? {
          id: "new",
          // No ellipsis: it opens a field in place, not a dialog.
          label: "New version",
          icon: <Plus size={14} aria-hidden />,
          testId: "version-new",
          onSelect: () => {
            setNameError(null);
            setNewName("");
          },
        }
      : {
          id: "new",
          field: {
            label: "New version name",
            value: newName,
            onChange: (value) => {
              setNewName(value);
              setNameError(null);
            },
            onSubmit: () => {
              setNameError(null);
              props.versions.create(newName, field);
            },
            onCancel: () => {
              setNewName(null);
              setNameError(null);
            },
            maxLength: 80,
            busy: busy === "create",
            error: nameError,
            errorTestId: "version-menu-error",
            hint: busy === "create" ? "Creating…" : <NewVersionHint versions={props.versions} first={snapshot.versions.length === 1} />,
            testId: "version-new-input",
          },
        },
  ];
  const actions: MenuEntry[] = [];
  if (!onMain && active) {
    actions.push(
      {
        id: "compare",
        label: "Compare with Main",
        icon: <Diff size={14} aria-hidden />,
        testId: "version-compare",
        onSelect: () => {
          setMenu(false);
          props.onOpenCompare(active.id);
        },
      },
      {
        id: "merge",
        label: "Merge into Main…",
        icon: <Merge size={14} aria-hidden />,
        testId: "version-merge",
        disabled: !active.canMergeIntoMain,
        description: active.canMergeIntoMain ? undefined : "Only versions made from Main can merge into Main.",
        onSelect: () => {
          setMenu(false);
          props.versions.openMerge(active);
        },
      },
    );
  }
  if (props.onShareVersion) {
    const share = props.onShareVersion;
    actions.push({
      id: "share",
      label: "Share this version…",
      icon: <Share2 size={14} aria-hidden />,
      testId: "version-share",
      onSelect: () => {
        setMenu(false);
        share({ id: active?.id ?? "main", name: activeName });
      },
    });
  }
  if (actions.length > 0) items.push(MENU_SEPARATOR, ...actions);
  if (props.onOpenAllVersions) {
    const openAll = props.onOpenAllVersions;
    items.push(MENU_SEPARATOR, {
      id: "all",
      label: "All versions",
      icon: <Layers size={14} aria-hidden />,
      testId: "version-all",
      onSelect: () => {
        setMenu(false);
        openAll();
      },
    });
  }

  return (
    <div className="relative flex min-w-0 items-center">
      {/* Every row but New version answers by closing the menu itself. */}
      <Menu
        label="Versions"
        menuTestId="version-menu"
        open={menuOpen}
        onOpenChange={setMenu}
        width={256}
        closeOnPick={false}
        items={items}
        trigger={(trigger) => (
          <button
            {...trigger}
            type="button"
            data-testid="version-menu-button"
            aria-label={`Version: ${activeName}${onMain ? "" : " (not Main)"}`}
            title={`You're working in the ${activeName} version`}
            disabled={busy !== null || props.disabled}
            className="titlebar-no-drag flex h-7 min-w-0 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-ink focus-visible:-outline-offset-2 disabled:cursor-wait disabled:opacity-60"
          >
            <Layers size={12} aria-hidden className="shrink-0" />
            {active !== null && !onMain ? (
              <span data-testid="version-menu-dot" aria-hidden className={`size-1.5 shrink-0 rounded-full ${versionDotClass(active.id)}`} />
            ) : null}
            <span data-testid="version-menu-active" className="min-w-0 truncate">
              {busy === "switch" ? "Switching…" : activeName}
            </span>
            <ChevronsUpDown size={12} aria-hidden className="shrink-0 text-subtle" />
          </button>
        )}
      />
    </div>
  );
}

// A no-break space keeps each number on the same line as its unit.
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)}\u00a0MB`;
// What a version leaves alone. The sizes are the engine's capture caps:
// larger files stay as they are on disk.
export const SAME_IN_EVERY_VERSION =
  `Chats, text files over ${megabytes(MAX_ENGINE_CAPTURE_TEXT_BYTES)}, other files over ${megabytes(MAX_ENGINE_CAPTURE_BINARY_BYTES)} and files History doesn't track stay the same in every version.`;

// Where a new version starts: it forks from the version you're in. Before the
// first version, a second line says what every version leaves alone.
export function NewVersionHint(props: { versions: Pick<WorkspaceVersions, "active" | "onMain">; first?: boolean }) {
  if (!props.versions.onMain) {
    return <>Starts from <span className="font-medium">{props.versions.active?.name ?? "Main"}</span>, so it can't merge into Main.</>;
  }
  if (!props.first) return <>Starts from Main</>;
  // A screen reader reads the hint as one run, so a hidden full stop ends the
  // first line's sentence.
  return (
    <>
      Starts from Main<span className="sr-only">.</span>{" "}
      <span data-testid="version-new-same" className="block text-muted">{SAME_IN_EVERY_VERSION}</span>
    </>
  );
}


type MergeStage =
  // A failure stays in the dialog, above the button that merges again.
  | { stage: "confirm"; failure?: { error: unknown } }
  | { stage: "running" }
  | { stage: "clean"; mergedFileCount: number }
  // One loaded window of the open-conflict listing: the rows shown so
  // far, and the continuation for the rest. Resolving replaces the window
  // with the first page of what remains.
  | {
      stage: "conflicts";
      conflicts: WorkspaceVersionConflict[];
      nextAfterConflictId: string | null;
    }
  | { stage: "resolved-all" };

export function VersionMergeDialog(props: {
  workspaceId: string;
  source: WorkspaceVersionRecord;
  // VersionMenu's contract: drain writes, hold the release across the IPC.
  beginLineageOperation: () => Promise<() => void>;
  // Pass the version that is active now when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  // The merge ran. The owner takes back an earlier failure's notice.
  onMerged: () => void;
  // The merge answered after the dialog closed. The owner reports it.
  onAnsweredAway: (answer: MergeAnswer) => void;
  // A notice's Try again: the dialog opens merging.
  runOnOpen?: boolean;
  onOpenHistory?: () => void;
  // The merge lists every open conflict, sync ones included, so their
  // refusals need the shell's toast and Notices row.
  onConflictError: (message: string, cause: unknown) => void;
  onClose: () => void;
}) {
  const { workspaceId, source } = props;
  const [stage, setStage] = useState<MergeStage>({ stage: props.runOnOpen ? "running" : "confirm" });
  // The person closed the dialog while it merged. The merge keeps going.
  const closedWhileMerging = useRef(false);
  // Protected files this merge gave the version's copy. They never become
  // conflicts, so whichever stage the merge ends in lists them once.
  const [replacedProtectedPaths, setReplacedProtectedPaths] = useState<string[]>([]);
  const liveToken = useRequestSequence();
  // Whether the dialog is still open when a merge answers.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Which loaded conflict window a "Show more" answer belongs to. Every
  // replacement of the window (the merge result, each resolution's remaining
  // page) advances it: a stale page for a replaced window would append rows
  // the replacement already repositioned (the renderer async-state
  // invariant).
  const windowGeneration = useRef(0);

  const runMerge = useCallback(async () => {
    const token = liveToken.next();
    setStage({ stage: "running" });
    let releaseOperation: (() => void) | null = null;
    try {
      releaseOperation = await props.beginLineageOperation();
      // Closed by its owner before the merge started, nothing ran. Closed by
      // the person, the merge they asked for still runs.
      if (mounted.current ? !liveToken.isCurrent(token) : !closedWhileMerging.current) return;
      const result = await bridge().mergeWorkspaceVersion({
        workspaceId,
        versionId: source.id,
      });
      props.onWorkspaceStateChanged();
      props.onMerged();
      // The merge's own count decides the stage: the rows are the first page
      // of all open conflicts, and a lingering sync conflict must not turn a
      // clean merge into a conflicted one. The rows gate it too: a count
      // with an empty terminal page means every conflict was already
      // resolved elsewhere between the merge and the listing — painting a
      // zero-card decide stage over that would ask for decisions that no
      // longer exist.
      const decide =
        result.conflictCount > 0 &&
        (result.conflicts.length > 0 || result.nextAfterConflictId !== null);
      if (!mounted.current) {
        const { replacedProtectedPaths } = result;
        props.onAnsweredAway(
          decide
            ? { kind: "decide", conflictCount: result.conflictCount, replacedProtectedPaths }
            : { kind: "merged", mergedFileCount: result.conflictCount > 0 ? null : result.mergedFileCount, replacedProtectedPaths },
        );
        return;
      }
      if (!liveToken.isCurrent(token)) return;
      setReplacedProtectedPaths(result.replacedProtectedPaths);
      if (decide) {
        windowGeneration.current += 1;
        setStage({
          stage: "conflicts",
          conflicts: result.conflicts,
          nextAfterConflictId: result.nextAfterConflictId,
        });
      } else if (result.conflictCount > 0) {
        setStage({ stage: "resolved-all" });
      } else {
        setStage({ stage: "clean", mergedFileCount: result.mergedFileCount });
      }
    } catch (error) {
      // Open, the dialog shows the failure. Gone before the answer, it leaves
      // the failure to the owner's notice.
      if (!mounted.current) props.onAnsweredAway({ kind: "failed", error });
      else if (liveToken.isCurrent(token)) setStage({ stage: "confirm", failure: { error } });
    } finally {
      releaseOperation?.();
    }
  }, [props.beginLineageOperation, props.onAnsweredAway, props.onMerged, props.onWorkspaceStateChanged, source.id, workspaceId]);

  // A notice's Try again merges once, as the dialog opens.
  useEffect(() => {
    if (props.runOnOpen) void runMerge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A failure takes focus to Merge into Main, which merges again. The button
  // is described by the failure, so a screen reader reads both once.
  const confirmButton = useRef<HTMLButtonElement>(null);
  const failureId = useId();
  const failure = stage.stage === "confirm" ? stage.failure : undefined;
  // Some of the version's files are in Main. Merging again isn't proven to
  // finish it, so the button says only that it merges again.
  const partway = failure !== undefined && isMergeStoppedPartway(failure.error);
  useEffect(() => {
    if (failure !== undefined) confirmButton.current?.focus();
  }, [failure]);

  const onResolved = useCallback(
    (remaining: ResolveWorkspaceVersionConflictResult) => {
      windowGeneration.current += 1;
      setStage(
        remaining.conflicts.length > 0 || remaining.nextAfterConflictId !== null
          ? {
              stage: "conflicts",
              conflicts: remaining.conflicts,
              nextAfterConflictId: remaining.nextAfterConflictId,
            }
          : { stage: "resolved-all" },
      );
    },
    [],
  );

  const loadMoreConflicts = useCallback(async () => {
    if (stage.stage !== "conflicts" || stage.nextAfterConflictId === null) return;
    const token = liveToken.current();
    const generation = windowGeneration.current;
    const page = await bridge().listWorkspaceVersionConflicts({
      workspaceId,
      afterConflictId: stage.nextAfterConflictId,
    });
    if (!liveToken.isCurrent(token)) return;
    // A resolution replaced the window while this page was in flight; its
    // rows belong to the window that asked, not the one that remains.
    if (generation !== windowGeneration.current) return;
    setStage((current) =>
      current.stage === "conflicts"
        ? {
            stage: "conflicts",
            conflicts: [...current.conflicts, ...page.conflicts],
            nextAfterConflictId: page.nextAfterConflictId,
          }
        : current,
    );
  }, [stage, workspaceId]);

  // Closing while merging leaves the merge running, and its answer comes as a
  // notice. While conflicts are open, closing is explicit only ("Finish
  // later"): Escape must not unmount ConflictResolver and discard a
  // hand-written combined copy.
  const canCloseByEscape = stage.stage !== "conflicts";

  const finish = useCallback(() => {
    if (stage.stage === "running") closedWhileMerging.current = true;
    props.onClose();
  }, [stage.stage, props.onClose]);
  // The merge disables the button that started it, so focus goes to Close,
  // the one control left.
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (stage.stage === "running") closeButton.current?.focus();
  }, [stage.stage]);
  const hasProtected = replacedProtectedPaths.length > 0;

  if (stage.stage === "conflicts") {
    // The one stage whose body scrolls, so it alone gets bands.
    return (
      <Overlay onClose={() => undefined}>
        <div
          data-testid="version-merge-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="version-merge-title"
          className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel"
        >
          <header className="border-b border-line px-6 py-4">
            <h3 id="version-merge-title" className="m-0 text-base font-semibold text-ink">
              Decide what Main should keep
            </h3>
            <p className="m-0 mt-1 text-[13px] leading-5 text-muted" role="status" data-testid="version-merge-status">
              {conflictCountCopy(stage.conflicts.length, stage.nextAfterConflictId !== null)}
            </p>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6">
            {hasProtected ? (
              <ReplacedProtectedFiles paths={replacedProtectedPaths} sourceName={source.name} collapsible />
            ) : null}
            <ConflictList
              workspaceId={workspaceId}
              beginLineageOperation={props.beginLineageOperation}
              onWorkspaceStateChanged={props.onWorkspaceStateChanged}
              conflicts={stage.conflicts}
              hasMore={stage.nextAfterConflictId !== null}
              onLoadMore={loadMoreConflicts}
              sourceNameFor={() => source.name}
              onResolved={onResolved}
              onError={props.onConflictError}
            />
          </div>
          <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
            <SecondaryButton data-testid="version-merge-done" onClick={finish}>
              Finish later
            </SecondaryButton>
          </footer>
        </div>
      </Overlay>
    );
  }

  // Every other stage is one card. Main is out of sight from here, so the
  // result stays: the title becomes the result above one Done, which takes
  // focus so Enter or Escape closes it.
  const result = stage.stage === "clean" || stage.stage === "resolved-all";
  const title =
    stage.stage === "clean"
      ? stage.mergedFileCount === 0
        ? "No files merged into Main"
        : `Merged ${stage.mergedFileCount} file${stage.mergedFileCount === 1 ? "" : "s"} into Main`
      : stage.stage === "resolved-all"
        ? `Merged ${source.name} into Main`
        : `Merge ${source.name} into Main`;
  return (
    <Overlay onClose={() => (canCloseByEscape ? finish() : undefined)}>
      <div
        data-testid="version-merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-merge-title"
        className="dohc-elevated flex w-[min(420px,calc(100vw-32px))] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <div>
          <div {...(result ? { role: "status", "data-testid": "version-merge-status" } : {})}>
            <h3 id="version-merge-title" className="m-0 break-words text-base font-semibold text-ink">
              {title}
            </h3>
          </div>
          {result ? (
            hasProtected ? (
              <div className="mt-1">
                <ReplacedProtectedFiles paths={replacedProtectedPaths} sourceName={source.name} />
              </div>
            ) : null
          ) : (
            <p className="m-0 mt-1 text-[13px] leading-5 text-muted">
              You can keep working in <span className="font-medium text-ink">{source.name}</span>.
            </p>
          )}
        </div>
        {failure !== undefined ? <MergeFailure wordsId={failureId} error={failure.error} sourceName={source.name} /> : null}
        <div className="flex justify-end gap-2">
          {partway && props.onOpenHistory ? (
            <SecondaryButton
              data-testid="version-merge-open-history"
              className="mr-auto"
              onClick={() => {
                props.onOpenHistory?.();
                finish();
              }}
            >
              Open History
            </SecondaryButton>
          ) : null}
          {result ? (
            // Keyed so React makes a new button that takes focus, rather than
            // reusing Cancel's, which autoFocus never reaches.
            <SecondaryButton key="done" data-testid="version-merge-done" autoFocus onClick={finish}>
              Done
            </SecondaryButton>
          ) : (
            <>
              {/* Closing doesn't stop a merge, so it isn't Cancel while one runs. */}
              <SecondaryButton ref={closeButton} data-testid="version-merge-cancel" onClick={finish}>
                {stage.stage === "running" ? "Close" : "Cancel"}
              </SecondaryButton>
              <PrimaryButton
                ref={confirmButton}
                data-testid="version-merge-confirm"
                aria-describedby={failure !== undefined ? failureId : undefined}
                disabled={stage.stage === "running"}
                onClick={() => void runMerge()}
              >
                {stage.stage === "running" ? "Merging…" : partway ? "Merge again" : "Merge into Main"}
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}

// A merge's failure, in the dialog that ran it: what failed, then Details
// when the copy text holds more than the words show.
function MergeFailure(props: { wordsId: string; error: unknown; sourceName: string }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const words = isMergeStoppedPartway(props.error)
    ? `dohc could not finish the merge. Some of ${props.sourceName}'s changes are in Main, and History shows which.`
    : ipcErrorMessage(props.error, `dohc could not merge ${props.sourceName} into Main.`);
  const { cause } = readError(props.error);
  const details = errorDetails([["Error", words], ["Cause", cause]]);
  return (
    <div data-testid="version-merge-failure">
      <p id={props.wordsId} data-testid="version-merge-failure-words" className="m-0 flex items-start gap-2 text-[13px] leading-5 text-ink">
        <CircleAlert size={14} aria-hidden className="mt-[3px] shrink-0 text-danger" />
        <span className="min-w-0 flex-1 break-words">{words}</span>
      </p>
      {cause ? (
        // The button's words line up with the failure's.
        <div className="mt-1 pl-[14px]">
          <GhostButton
            data-testid="version-merge-failure-details"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((current) => !current)}
          >
            Details
            <ChevronDown size={12} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </GhostButton>
          {open ? (
            <div id={detailsId} className="ml-2 mt-1 flex items-start gap-2">
              <p className="m-0 min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-[12px] leading-4 text-muted">{details}</p>
              <CopyButton iconOnly label="Copy error details" getText={() => details} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The protected files a merge replaced. They never become conflicts, so the
// merge's last stage names them: one line in the body style, then an inset
// box of paths from the workspace root. A long path gives up its folders
// before its file name, with the whole path on hover, and the box scrolls
// after five rows. The box is open on every result. Only the conflict stage,
// where the cards are the task, keeps it behind "Show files".
function ReplacedProtectedFiles(props: { paths: string[]; sourceName: string; collapsible?: boolean }) {
  const [open, setOpen] = useState(!props.collapsible);
  const count = props.paths.length;
  return (
    <div data-testid="version-merge-protected">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 text-[13px] leading-5 text-muted">
          {count === 1 ? "This protected file" : `These ${count} protected files`} took{" "}
          <span className="font-medium text-ink">{props.sourceName}</span>'s copy.
        </p>
        {props.collapsible ? (
          <GhostButton
            data-testid="version-merge-protected-toggle"
            aria-expanded={open}
            aria-controls="version-merge-protected-list"
            className="shrink-0"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Hide files" : "Show files"}
            <ChevronDown size={12} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </GhostButton>
        ) : null}
      </div>
      {open ? (
        <ul
          id="version-merge-protected-list"
          aria-label="Protected files"
          tabIndex={count > 5 ? 0 : undefined}
          className="m-0 mt-2 max-h-[calc(5*1.75rem+2px)] list-none overflow-y-auto rounded-lg border border-line p-0"
        >
          {props.paths.map((path) => {
            const slash = path.lastIndexOf("/");
            return (
              <li key={path} title={path} className="flex h-7 min-w-0 items-center gap-2 px-2 text-[13px]">
                <Lock size={12} aria-hidden className="shrink-0 text-subtle" />
                <span className="flex min-w-0">
                  <span className="min-w-0 truncate text-muted">{path.slice(0, slash + 1)}</span>
                  <span className="max-w-full shrink-0 truncate text-ink">{path.slice(slash + 1)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function ConflictSidePane(props: {
  heading: string;
  text: string | null;
  /// What the pane says when it has no text to show: this side is a binary
  /// copy, or this side has no file at all.
  note: string;
}) {
  // How many preview windows this side is showing. One press of "Show more"
  // adds one, so the pane paints a bounded amount per press and the rest of
  // the side stays reachable.
  const [windows, setWindows] = useState(1);
  const preview = useMemo(
    () => (props.text === null ? null : conflictPreview(props.text, windows)),
    [props.text, windows],
  );
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
      <SectionLabel as="div" className="border-b border-line bg-panel-2 px-2 py-1">
        {props.heading}
      </SectionLabel>
      {preview === null ? (
        <p className="m-0 px-2 py-2 text-[11px] italic leading-4 text-subtle">
          {props.note}
        </p>
      ) : (
        <>
          <pre
            data-testid="version-conflict-side-text"
            className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-4 text-muted"
          >
            {preview.text}
          </pre>
          {preview.hiddenChars > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-line bg-panel-2 px-2 py-1">
              <span
                data-testid="version-conflict-side-hidden"
                className="text-[10px] leading-4 text-subtle"
              >
                {preview.hiddenChars.toLocaleString("en-US")} more characters
                hidden
              </span>
              <button
                type="button"
                data-testid="version-conflict-side-show-more"
                onClick={() => setWindows((shown) => shown + 1)}
                className="h-5 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-muted hover:bg-hover hover:text-ink"
              >
                Show more
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// What one side says when it carries no text: its size when it is a binary
// copy, or the side's own "no file here" line. A side is never described by
// its sibling's kind — a mixed conflict shows the readable text on one side
// and the size on the other.
function sideNote(
  binary: { byteLength: number } | null | undefined,
  missingNote: string,
): string {
  return binary ? `Binary copy, ${binary.byteLength} bytes` : missingNote;
}

// Side labels depend on where the conflict came from: a version merge names
// the versions ("On Main" / "In Client Draft"); a sync divergence names the
// machines ("On this machine" / "On your other machine") — never sync
// jargon, and never a misleading version name for a two-machine conflict.
// Takes the ORIGIN, not the whole conflict, because it is the only field that
// decides the labels — and because a caller memoizing on the whole conflict
// object would recompute on every render for no reason.
function conflictSideLabels(
  origin: WorkspaceVersionConflict["origin"],
  sourceName: string,
): {
  currentHeading: string;
  incomingHeading: string;
  /// Each side's owner, as a possessive subject: "Keep Main's copy",
  /// "Started from this machine's copy". One name per side, so the two
  /// sentences can never call the same side different things.
  currentName: string;
  incomingName: string;
  keepCurrent: string;
  keepIncoming: string;
  currentMissing: string;
  incomingMissing: string;
} {
  if (origin === "sync") {
    return {
      currentHeading: "On this machine",
      incomingHeading: "On your other machine",
      currentName: "this machine",
      incomingName: "your other machine",
      keepCurrent: "Keep this machine's copy",
      keepIncoming: "Keep your other machine's copy",
      currentMissing: "This machine doesn't have this file.",
      incomingMissing: "Your other machine removed this file.",
    };
  }
  return {
    currentHeading: "On Main",
    incomingHeading: `In ${sourceName}`,
    currentName: "Main",
    incomingName: sourceName,
    keepCurrent: "Keep Main's copy",
    keepIncoming: `Keep ${sourceName}'s copy`,
    currentMissing: "Main doesn't have this file.",
    incomingMissing: `${sourceName} removed this file.`,
  };
}

/// One side, as a candidate to start a hand-written combined copy from.
type SeedCandidate = {
  /// null means the side has no file at all, which is a legitimate — and
  /// zero-byte — place to start from.
  text: string | null;
  /// Whose copy it is, for "Started from Main's copy."
  name: string;
  /// What that side says when it has no file, for the sentence that explains
  /// an empty start.
  missing: string;
};

/// Where "Combine by hand" starts, and the line that says where that is.
type CombineSeed = { text: string; startedFrom: string };

/// Pick where "Combine by hand" starts: the first side, in preference order,
/// that the engine could actually apply — or an empty copy, which it always
/// can.
///
/// There is no unavailable case, because `apply-merged` measures the submitted
/// text and nothing else (`lib.rs:7587-7594`). Whatever the two sides weigh, a
/// user writing a short replacement by hand is posting a body the engine
/// takes. So the sides only decide what the box is PREFILLED with, never
/// whether the affordance exists.
///
/// Three ways that prefill is chosen, in order. A side that fits wins — and a
/// side over the cap loses to its smaller SIBLING, because a 5 MiB incoming
/// copy beside a 3 KB copy on Main is still a conflict a user can combine.
/// Failing that, a side with no file is a zero-byte start. Failing that, both
/// copies are too large to load into the box, and it starts empty — which is
/// a worse start, but not a refusal.
function chooseCombineSeed(candidates: SeedCandidate[]): CombineSeed {
  const present = candidates.filter(
    (candidate): candidate is SeedCandidate & { text: string } => candidate.text !== null,
  );
  const fitting = present.find(
    (candidate) => !exceedsUtf8Bytes(candidate.text, CONFLICT_COMBINED_EDIT_MAX_BYTES),
  );
  if (fitting) {
    return { text: fitting.text, startedFrom: `Started from ${fitting.name}'s copy.` };
  }
  // Ranked below every present side: starting empty must never beat starting
  // from a copy the user could have edited.
  const absent = candidates.find((candidate) => candidate.text === null);
  if (absent) {
    return { text: "", startedFrom: `${absent.missing} This starts empty.` };
  }
  return {
    text: "",
    startedFrom:
      `Both copies are larger than ` +
      `${CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")} bytes, so this ` +
      `starts empty. That is the largest copy you can combine by hand.`,
  };
}

// One conflict card. Expanded, it paints two side panes; collapsed, only its
// header row — so a workspace with many open conflicts paints two panes, not
// two per conflict. The card stays MOUNTED while collapsed, so a
// hand-written combined copy survives being collapsed.
function ConflictResolver(props: {
  workspaceId: string;
  onError?: (message: string, cause: unknown) => void;
  beginLineageOperation: () => Promise<() => void>;
  onWorkspaceStateChanged: () => void;
  conflict: WorkspaceVersionConflict;
  sourceName: string;
  expanded: boolean;
  onToggle: () => void;
  onResolved: (remaining: ResolveWorkspaceVersionConflictResult) => void;
}) {
  const { conflict, expanded, sourceName, workspaceId } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [combined, setCombined] = useState<string | null>(null);
  // The last change refused for being over the apply cap, in bytes. See the
  // change handler: the combined copy in state is never over the cap, so this
  // is how the attempt is reported.
  const [refusedBytes, setRefusedBytes] = useState<number | null>(null);
  const isBinary = conflict.contentKind === "binary";
  const labels = conflictSideLabels(conflict.origin, sourceName);
  const { currentName, incomingName, currentMissing, incomingMissing } = labels;
  // What "Combine by hand" would start from, and whether the engine could
  // apply it. The seed prefers the incoming side, as it always has, but a side
  // the engine would refuse is not a usable seed — so a side that fits wins
  // over the preference, and the affordance only disappears when no side does.
  //
  // Gated on `expanded` because it is only read there, and because it is not
  // free: an over-cap side needs an exact byte count for its message, and a
  // dialog can hold hundreds of collapsed cards. Counting all of them on mount
  // was 750 ms for twenty 10 MiB sides against 79 ms for this — the cost this
  // whole change exists to remove, reintroduced one layer up.
  //
  // The dependencies are the PRIMITIVES this reads, never the labels object:
  // that object is rebuilt every render, so depending on it made every local
  // rerender — the one after "Keep Main's copy" sets busy, the one after a
  // refusal — rescan every byte of both sides. A memo that recomputes every
  // render is not a memo.
  const combineSeed = useMemo<CombineSeed | null>(
    () =>
      expanded && !isBinary
        ? chooseCombineSeed([
            {
              text: conflict.incomingText,
              name: incomingName,
              missing: incomingMissing,
            },
            { text: conflict.currentText, name: currentName, missing: currentMissing },
          ])
        : null,
    [
      conflict.currentText,
      conflict.incomingText,
      expanded,
      isBinary,
      currentName,
      incomingName,
      currentMissing,
      incomingMissing,
    ],
  );
  const liveToken = useRequestSequence([workspaceId, conflict.conflictId]);

  // The combined copy in state is never over the apply cap: every value it can
  // hold comes from here or from a seed that already fits, so the controlled
  // textarea is never handed an oversized body. A refused change keeps the box
  // at its last good content and names the size the user tried. Opening the
  // box is the one place that clears the last refusal; the warning only
  // renders inside the box, so a clear on Cancel would be dead code.
  const startCombine = useCallback((seed: string) => {
    setRefusedBytes(null);
    setCombined(seed);
  }, []);

  const onCombinedChange = useCallback((next: string) => {
    const change = applyCombinedChange(next);
    if (!change.accepted) {
      setRefusedBytes(change.refusedBytes);
      return;
    }
    setRefusedBytes(null);
    setCombined(change.text);
  }, []);

  const resolve = useCallback(
    async (
      resolution:
        | { kind: "keep-current" }
        | { kind: "keep-incoming" }
        | { kind: "keep-combined"; text: string },
    ) => {
      const token = liveToken.next();
      setBusy(true);
      setError(null);
      let releaseOperation: (() => void) | null = null;
      // Main closes the open documents before it resolves, so once the
      // resolve has started, a failure reopens the editors too, as a failed
      // switch does.
      let resolveIssued = false;
      try {
        releaseOperation = await props.beginLineageOperation();
        if (!liveToken.isCurrent(token)) return;
        resolveIssued = true;
        const result = await bridge().resolveWorkspaceVersionConflict({
          workspaceId,
          conflictId: conflict.conflictId,
          resolution,
        });
        props.onWorkspaceStateChanged();
        if (!liveToken.isCurrent(token)) return;
        props.onResolved(result);
      } catch (caught) {
        if (resolveIssued) props.onWorkspaceStateChanged();
        if (!liveToken.isCurrent(token)) return;
        const error = readError(caught).refusal === "synced-deletion"
          ? new SyncedDeletionRevivalError(conflict.path, { cause: caught })
          : conflict.origin === "sync" && conflict.contentKind === "text" && conflict.currentText !== null && conflict.incomingText === null && isConflictStaleTarget(caught)
            ? new SyncedDeletionStaleError(conflict.path, { cause: caught }) : caught;
        setError(readError(error).title ?? ipcErrorMessage(error, "dohc could not apply that choice."));
        props.onError?.("dohc could not apply that choice.", error);
        setBusy(false);
      } finally {
        releaseOperation?.();
      }
    },
    [conflict.conflictId, conflict.path, conflict.origin, conflict.contentKind, conflict.currentText, conflict.incomingText, props.beginLineageOperation, props.onError, props.onResolved, props.onWorkspaceStateChanged, workspaceId],
  );

  return (
    <section
      data-testid="version-conflict"
      data-conflict-path={conflict.path}
      aria-label={`Conflict in ${conflict.path}`}
      className="rounded-lg border border-line bg-bg p-2"
    >
      <button
        type="button"
        data-testid="version-conflict-toggle"
        aria-expanded={expanded}
        onClick={props.onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded text-left hover:text-ink"
      >
        {isBinary ? (
          <FileArchive size={12} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <FileText size={12} aria-hidden className="shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
          {conflict.path}
        </span>
        {!expanded && combined !== null ? (
          <span
            data-testid="version-conflict-draft-marker"
            className="shrink-0 text-[10px] text-subtle"
          >
            Combined copy in progress
          </span>
        ) : null}
        <ChevronDown
          size={12}
          aria-hidden
          className={`shrink-0 text-subtle ${expanded ? "" : "-rotate-90"}`}
        />
      </button>
      {expanded ? (
        <div className="pt-2">
          {conflict.origin === "sync" && conflict.waitingVersion ? (
            <p
              data-testid="version-conflict-waiting"
              className="mb-2 mt-0 flex items-start gap-1.5 text-[11px] leading-4 text-muted"
            >
              <Hourglass size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              A newer version from another machine is waiting. It comes in after you resolve this conflict.
            </p>
          ) : null}
          {isBinary ? (
            <div
              data-testid="version-conflict-binary"
              className="mb-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[11px] leading-4 text-muted"
            >
              Binary file. Choose which copy to keep.
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <ConflictSidePane
                heading={labels.currentHeading}
                text={conflict.currentText}
                note={sideNote(conflict.currentBinary, labels.currentMissing)}
              />
              <SecondaryButton size="compact"
                type="button"
                data-testid="version-conflict-keep-current"
                disabled={busy}
                onClick={() => void resolve({ kind: "keep-current" })}
                className="px-2"
              >
                {labels.keepCurrent}
              </SecondaryButton>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <ConflictSidePane
                heading={labels.incomingHeading}
                text={conflict.incomingText}
                note={sideNote(conflict.incomingBinary, labels.incomingMissing)}
              />
              <SecondaryButton size="compact"
                type="button"
                data-testid="version-conflict-keep-incoming"
                disabled={busy}
                onClick={() => void resolve({ kind: "keep-incoming" })}
                className="px-2"
              >
                {labels.keepIncoming}
              </SecondaryButton>
            </div>
          </div>
          {combined === null && combineSeed !== null ? (
            <button
              type="button"
              data-testid="version-conflict-combine"
              disabled={busy}
              onClick={() => startCombine(combineSeed.text)}
              className="mt-2 h-7 cursor-pointer rounded-md px-2 text-[11px] text-subtle hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-50"
            >
              Combine by hand instead…
            </button>
          ) : !isBinary ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <label
                className="dohc-section-label"
                htmlFor={`combined-${conflict.conflictId}`}
              >
                Combined copy
              </label>
              {combineSeed !== null ? (
                <p
                  data-testid="version-conflict-combined-source"
                  className="m-0 text-[11px] leading-4 text-subtle"
                >
                  {combineSeed.startedFrom}
                </p>
              ) : null}
              <textarea
                id={`combined-${conflict.conflictId}`}
                data-testid="version-conflict-combined-input"
                value={combined ?? ""}
                disabled={busy}
                rows={6}
                onChange={(event) => onCombinedChange(event.target.value)}
                className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] leading-4 text-ink dohc-focus-input"
              />
              {refusedBytes !== null ? (
                <p
                  data-testid="version-conflict-combined-too-large"
                  role="alert"
                  className="mb-0 text-[11px] leading-4 text-danger"
                >
                  That change would make the combined copy{" "}
                  {refusedBytes.toLocaleString("en-US")} bytes. Combining by hand
                  works up to{" "}
                  {CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")} bytes.
                  Add less text.
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="version-conflict-combine-cancel"
                  disabled={busy}
                  onClick={() => setCombined(null)}
                  className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
                >
                  Cancel
                </button>
                <PrimaryButton size="compact"
                  type="button"
                  data-testid="version-conflict-apply-combined"
                  disabled={busy}
                  onClick={() => void resolve({ kind: "keep-combined", text: combined ?? "" })}
                  className="px-2"
                >
                  Use this combined copy
                </PrimaryButton>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {/*
        outside the collapsible region on purpose. A resolution can be running,
        or can have failed, while the card is collapsed — nothing stops the
        user opening another conflict mid-request — and a refusal that renders
        only inside the expanded body tells them nothing at all.
      */}
      {error ? (
        <p
          data-testid="version-conflict-error"
          role="alert"
          className="mb-0 mt-2 text-[11px] leading-4 text-danger"
        >
          {error}
        </p>
      ) : null}
      {busy ? (
        <p
          data-testid="version-conflict-busy"
          role="status"
          className="mb-0 mt-2 text-[11px] leading-4 text-subtle"
        >
          Applying…
        </p>
      ) : null}
    </section>
  );
}

// The loaded window of open conflicts, one card each, one of them expanded.
// Both conflict surfaces render through this: the merge dialog and
// the standalone review dialog. The window is one or more engine pages:
// "Show more files" fetches the next page, and resolving replaces
// the window with the first page of what remains.
function ConflictList(props: {
  workspaceId: string;
  onError?: (message: string, cause: unknown) => void;
  beginLineageOperation: () => Promise<() => void>;
  onWorkspaceStateChanged: () => void;
  conflicts: WorkspaceVersionConflict[];
  // Whether a continuation exists past the loaded window.
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  sourceNameFor: (conflict: WorkspaceVersionConflict) => string;
  onResolved: (remaining: ResolveWorkspaceVersionConflictResult) => void;
}) {
  // `undefined` means the user has not chosen yet. `null` means the user
  // collapsed the open card, which is a state they are allowed to be in — the
  // two must not be the same value, or closing a card reopens the first one.
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const openId = openConflictId(props.conflicts, chosenId);
  const { conflicts, onLoadMore } = props;
  // The pending flag belongs to the loaded window: when the
  // window changes identity (a resolution replaced it, or a page appended),
  // any in-flight Show more belongs to the old window — clear the flag now
  // rather than when the abandoned request settles (indefinitely, if it
  // never does), and let its settle repaint nothing.
  const loadToken = useRef(0);
  useEffect(() => {
    loadToken.current += 1;
    setLoadingMore(false);
    setLoadMoreError(null);
  }, [conflicts]);
  const loadMore = useCallback(() => {
    const token = ++loadToken.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void onLoadMore()
      .catch((error) => {
        if (token !== loadToken.current) return;
        setLoadMoreError(
          ipcErrorMessage(error, "dohc could not load more files."),
        );
      })
      .finally(() => {
        if (token === loadToken.current) setLoadingMore(false);
      });
  }, [onLoadMore]);

  return (
    <div className="flex flex-col gap-3">
      {props.conflicts.map((conflict) => (
        <ConflictResolver
          key={conflict.conflictId}
          workspaceId={props.workspaceId}
          onError={props.onError}
          beginLineageOperation={props.beginLineageOperation}
          onWorkspaceStateChanged={props.onWorkspaceStateChanged}
          conflict={conflict}
          sourceName={props.sourceNameFor(conflict)}
          expanded={conflict.conflictId === openId}
          onToggle={() =>
            setChosenId(conflict.conflictId === openId ? null : conflict.conflictId)
          }
          onResolved={props.onResolved}
        />
      ))}
      {props.hasMore ? (
        <div className="flex flex-col items-start gap-1">
          <SecondaryButton size="compact"
            type="button"
            data-testid="conflict-list-show-more"
            disabled={loadingMore}
            onClick={loadMore}
            className="px-2"
          >
            {loadingMore ? "Loading…" : "Show more files"}
          </SecondaryButton>
          {loadMoreError ? (
            <p className="m-0 text-[11px] leading-4 text-danger" role="alert">
              {loadMoreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/// The count sentence both conflict surfaces open with. The loaded window may
/// not be the whole listing: while a continuation is open more
/// conflicts exist past the window, so the sentence says "more than" — never
/// a number that could be under the truth.
export function conflictCountCopy(count: number, hasMore: boolean): string {
  if (hasMore) {
    return count === 1
      ? "More than one file has two copies."
      : `More than ${count} files have two copies.`;
  }
  return count === 1
    ? "One file has two copies."
    : `${count} files have two copies.`;
}

/// Which conflict is expanded. Exported for its own tests: the three states it
/// distinguishes are not obvious from either call site.
export function openConflictId(
  conflicts: WorkspaceVersionConflict[],
  chosenId: string | null | undefined,
): string | null {
  const firstId = conflicts[0]?.conflictId ?? null;
  // Untouched: the first file to decide opens by itself.
  if (chosenId === undefined) return firstId;
  // Collapsed on purpose: leave every card closed.
  if (chosenId === null) return null;
  // A resolved conflict leaves the list, so a chosen id that is no longer in
  // it hands the turn to the next file to decide.
  return conflicts.some((conflict) => conflict.conflictId === chosenId)
    ? chosenId
    : firstId;
}

function changeStatusLabel(status: WorkspaceVersionFileChange["status"]): string {
  if (status === "added") return "Added";
  if (status === "deleted") return "Removed";
  return "Changed";
}

// One compared file's text diff. Its own component so the diff is built once
// per pair of bodies instead of on every render of the whole compare page —
// the same bound the history diff page relies on (see unifiedDiff.tsx).
function CompareFileDiff(props: { currentText?: string; incomingText?: string }) {
  const lines = useMemo(
    () => buildUnifiedDiffLines(computeTextDiff(props.currentText, props.incomingText, 800)),
    [props.currentText, props.incomingText],
  );
  return <UnifiedDiffLines lines={lines} testId="version-compare-diff-lines" />;
}

// Full-page comparison of a version against Main (virtual editor tab).
// Mirrors the history diff page's rendering so diffs look the same
// everywhere.
export function VersionComparePage(props: {
  workspaceId: string;
  versionId: string;
}) {
  const { workspaceId, versionId } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        versionName: string;
        // The loaded window of the comparison: one or more pages, and
        // the continuation for the rest.
        files: WorkspaceVersionFileChange[];
        nextAfterPath: string | null;
      }
  >({ status: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Which loaded window a page answer belongs to. Every replacement of the
  // window (a refresh, a new version) advances it, and a "Show more" answer
  // may only append to the window that asked — a cursor value alone cannot
  // tell two generations apart, because a refreshed comparison can hand out
  // the same cursor again (the renderer async-state invariant).
  const windowGeneration = useRef(0);

  useAsyncResponseEffect(
    async () => {
      windowGeneration.current += 1;
      setState({ status: "loading" });
      // The pending flag belongs to the window too: without this
      // reset, a replaced window inherits an abandoned page's "Loading…" until
      // the stale request settles — indefinitely, if it never does.
      setLoadingMore(false);
      setLoadMoreError(null);
      return Promise.all([
        bridge().listWorkspaceVersions({ workspaceId }),
        bridge().compareWorkspaceVersions({ workspaceId, versionId }),
      ]);
    },
    {
      onSuccess: ([versions, comparison]) => {
        const name =
          versions.versions.find((version) => version.id === versionId)?.name ??
          "This version";
        setState({
          status: "ready",
          versionName: name,
          files: comparison.files,
          nextAfterPath: comparison.nextAfterPath,
        });
      },
      onError: (error) => {
        setState({
          status: "error",
          message: ipcErrorMessage(error, "Could not compare with Main."),
        });
      },
    },
    [workspaceId, versionId, refreshNonce],
  );

  const loadMore = useCallback(() => {
    if (state.status !== "ready" || state.nextAfterPath === null) return;
    const afterPath = state.nextAfterPath;
    const generation = windowGeneration.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void bridge()
      .compareWorkspaceVersions({ workspaceId, versionId, afterPath })
      .then((page) => {
        // A refresh replaced the window while this page was in flight. The
        // refreshed comparison can reuse the same cursor value, so only the
        // generation can prove this answer still has a window to append to.
        if (windowGeneration.current !== generation) return;
        setState((current) =>
          current.status === "ready"
            ? {
                ...current,
                files: [...current.files, ...page.files],
                nextAfterPath: page.nextAfterPath,
              }
            : current,
        );
      })
      .catch((error) => {
        if (windowGeneration.current !== generation) return;
        setLoadMoreError(
          ipcErrorMessage(error, "Couldn't load more changed files."),
        );
      })
      .finally(() => {
        // Only this generation's pending flag: the effect already cleared it
        // for a replaced window, and a stale settle must not repaint it.
        if (windowGeneration.current === generation) setLoadingMore(false);
      });
  }, [state, workspaceId, versionId]);

  return (
    <section
      data-testid="version-compare-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
    >
      {/* The tab says Compare with Main, so the header names the version and
          what the list is, the words the Versions page counts, and counts the
          files that differ. The empty state says when none do. */}
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <Layers size={14} aria-hidden className="shrink-0 text-subtle" />
        <h2 className="m-0 flex min-w-0 items-baseline gap-2 text-[14px] font-semibold text-ink">
          {state.status === "ready" ? (
            <>
              <span className="min-w-0 truncate">{state.versionName}</span>{" "}
              <span data-testid="version-compare-subject" className="shrink-0 text-[12px] font-normal text-muted">Differences with Main</span>
            </>
          ) : (
            <span className="min-w-0 truncate">Comparing with Main</span>
          )}
        </h2>
        {state.status === "ready" && state.files.length > 0 ? (
          <span data-testid="version-compare-count" className="shrink-0">
            <Pill>
              {state.nextAfterPath !== null
                ? `${state.files.length}+ files`
                : state.files.length === 1 ? "1 file" : `${state.files.length} files`}
            </Pill>
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          data-testid="version-compare-refresh"
          aria-label="Refresh comparison"
          title="Refresh comparison"
          disabled={state.status === "loading"}
          onClick={() => setRefreshNonce((nonce) => nonce + 1)}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line text-muted hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto overflow-x-hidden p-4">
        {state.status === "loading" ? (
          <p className="m-0 text-center text-sm text-subtle" role="status">
            Comparing…
          </p>
        ) : state.status === "error" ? (
          <p className="m-0 text-center text-sm text-danger" role="alert">
            {state.message}
          </p>
        ) : state.files.length === 0 ? (
          <div className="flex pt-16">
            <EmptyState
              data-testid="version-compare-empty"
              picture={EMPTY_ART.versions}
              title={`Everything in ${state.versionName} matches Main.`}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {state.files.map((file) => (
              <section
                key={file.path}
                data-testid="version-compare-file"
                data-compare-path={file.path}
                className="overflow-hidden rounded-lg border border-line bg-bg [contain-intrinsic-size:auto_250px] [content-visibility:auto]"
              >
                <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
                  {file.protected ? (
                    <Lock size={13} aria-hidden className="shrink-0 text-subtle" />
                  ) : file.binary ? (
                    <FileArchive size={13} aria-hidden className="shrink-0 text-subtle" />
                  ) : (
                    <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">
                    {changeStatusLabel(file.status)}
                  </span>
                </div>
                {file.protected ? (
                  // Secret-backed file: the comparison is metadata-only.
                  <div
                    data-testid="version-compare-protected"
                    className="flex flex-col items-center gap-1 px-4 py-8 text-center"
                  >
                    <Lock size={14} aria-hidden className="text-subtle" />
                    <span className="text-sm text-muted">Protected file changed</span>
                    <span className="text-xs text-subtle">
                      This file follows the version, but its contents are never
                      shown in comparisons.
                    </span>
                  </div>
                ) : file.binary ? (
                  <div
                    data-testid="version-compare-binary"
                    className="flex flex-col items-center gap-1 px-4 py-8 text-center"
                  >
                    <FileArchive size={14} aria-hidden className="text-subtle" />
                    <span className="text-sm text-muted">Binary file changed</span>
                    <span className="text-xs text-subtle">
                      This file follows the version byte-for-byte, but contents are
                      not shown in text diffs.
                    </span>
                  </div>
                ) : (
                  <CompareFileDiff
                    currentText={file.currentText}
                    incomingText={file.incomingText}
                  />
                )}
              </section>
            ))}
            {state.nextAfterPath !== null ? (
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  data-testid="version-compare-show-more"
                  disabled={loadingMore}
                  onClick={loadMore}
                  className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Show more files"}
                </button>
                {loadMoreError ? (
                  <p className="m-0 text-[11px] leading-4 text-danger" role="alert">
                    {loadMoreError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

// Standalone review of every open conflict (0P-C). The merge dialog handles
// conflicts born inside a merge; this dialog is how conflicts reach the user
// outside that flow — two machines editing the same file while apart, or a
// merge closed with "Finish later". Opened from the notice center's conflict
// notice; reuses the exact ConflictResolver cards so choosing what stays
// looks the same everywhere.
export function ConflictReviewDialog(props: {
  workspaceId: string;
  onError?: (message: string, cause: unknown) => void;
  beginLineageOperation: () => Promise<() => void>;
  // Pass the version that is active now when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  onClose: () => void;
}) {
  const { workspaceId } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | {
        status: "ready";
        conflicts: WorkspaceVersionConflict[];
        nextAfterConflictId: string | null;
        resolvedAny: boolean;
      }
  >({ status: "loading" });
  const [versionNames, setVersionNames] = useState<Map<string, string>>(new Map());
  // Bumped by Try again after a failed read.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const liveToken = useRequestSequence();
  // Same rule as the merge dialog: a "Show more" answer may only append to
  // the window that asked, and every window change (the initial load, each
  // resolution's remaining page, each reread, each append) advances this.
  const windowGeneration = useRef(0);
  // The window a "Show more" in flight belongs to. A reread of that window
  // waits for it, so neither answer discards the other. A page that a
  // resolution abandoned holds nothing up.
  const pageWindow = useRef<number | null>(null);

  useEffect(() => {
    const token = liveToken.next();
    void (async () => {
      try {
        const [result, versions] = await Promise.all([
          bridge().listWorkspaceVersionConflicts({ workspaceId }),
          // Version names label merge-origin conflicts; a failure here only
          // degrades labels, never the review itself.
          bridge()
            .listWorkspaceVersions({ workspaceId })
            .catch(() => null),
        ]);
        if (!liveToken.isCurrent(token)) return;
        setVersionNames(
          new Map(
            (versions?.versions ?? []).map((version) => [version.id, version.name]),
          ),
        );
        windowGeneration.current += 1;
        setState({
          status: "ready",
          conflicts: result.conflicts,
          nextAfterConflictId: result.nextAfterConflictId,
          resolvedAny: false,
        });
      } catch {
        if (!liveToken.isCurrent(token)) return;
        setState({ status: "error" });
      }
    })();
  }, [workspaceId, loadAttempt]);

  const onResolved = useCallback(
    (remaining: ResolveWorkspaceVersionConflictResult) => {
      windowGeneration.current += 1;
      setState({
        status: "ready",
        conflicts: remaining.conflicts,
        nextAfterConflictId: remaining.nextAfterConflictId,
        resolvedAny: true,
      });
    },
    [],
  );

  const loadMoreConflicts = useCallback(async () => {
    if (state.status !== "ready" || state.nextAfterConflictId === null) return;
    const token = liveToken.current();
    const generation = windowGeneration.current;
    pageWindow.current = generation;
    try {
      const page = await bridge().listWorkspaceVersionConflicts({
        workspaceId,
        afterConflictId: state.nextAfterConflictId,
      });
      if (!liveToken.isCurrent(token)) return;
      // A resolution replaced the window while this page was in flight; its
      // rows belong to the window that asked, not the one that remains.
      if (generation !== windowGeneration.current) return;
      windowGeneration.current += 1;
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              conflicts: [...current.conflicts, ...page.conflicts],
              nextAfterConflictId: page.nextAfterConflictId,
            }
          : current,
      );
    } finally {
      if (pageWindow.current === generation) pageWindow.current = null;
    }
  }, [state, workspaceId]);

  // A sync pass can hold a newer version behind a conflict on screen. Each
  // pass signals without paths, so read the loaded window again then. Keys
  // stay the conflict ids, so the open card and its combined copy survive.
  // A signal during the first load or a Show more, or a window that changes
  // during the reread, reads again once the window settles.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const refresh = createActivityCoalescer(() => {
      const shown = stateRef.current;
      if (shown.status === "loading" || pageWindow.current === windowGeneration.current) {
        refresh.schedule();
        return;
      }
      if (shown.status !== "ready") return;
      const token = liveToken.current();
      const generation = windowGeneration.current;
      void (async () => {
        const rows: WorkspaceVersionConflict[] = [];
        let after: string | null = null;
        try {
          do {
            const page = await bridge().listWorkspaceVersionConflicts({
              workspaceId,
              ...(after === null ? {} : { afterConflictId: after }),
            });
            if (!liveToken.isCurrent(token)) return;
            if (generation !== windowGeneration.current) {
              refresh.schedule();
              return;
            }
            rows.push(...page.conflicts);
            after = page.nextAfterConflictId;
          } while (after !== null && rows.length < shown.conflicts.length);
        } catch {
          // The window on screen stays; the next change reads it again.
          return;
        }
        if (pageWindow.current === windowGeneration.current) {
          refresh.schedule();
          return;
        }
        windowGeneration.current += 1;
        const nextAfterConflictId = after;
        setState((current) =>
          current.status === "ready"
            ? { ...current, conflicts: rows, nextAfterConflictId }
            : current,
        );
      })();
    });
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId !== undefined && event.workspaceId !== workspaceId) return;
      if (event.paths?.length) return;
      refresh.schedule();
    });
    return () => {
      refresh.cancel();
      unsubscribe();
    };
  }, [workspaceId]);

  const conflicts = state.status === "ready" ? state.conflicts : [];
  const hasMoreConflicts =
    state.status === "ready" && state.nextAfterConflictId !== null;
  // A continuation with an empty window still means open conflicts exist —
  // the empty state and the close discipline must not read it as "all done".
  const anyOpen = conflicts.length > 0 || hasMoreConflicts;
  // Same close discipline as the merge dialog: while conflicts are open,
  // closing is explicit only — Escape must not discard a hand-written
  // combined copy.
  const canCloseByEscape = state.status !== "ready" || !anyOpen;

  return (
    <Overlay onClose={() => (canCloseByEscape ? props.onClose() : undefined)}>
      <div
        data-testid="conflict-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-review-title"
        className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel"
      >
        <header className="border-b border-line px-6 py-4">
          <h3 id="conflict-review-title" className="m-0 text-base font-semibold text-ink">
            Decide what to keep
          </h3>
          {state.status === "ready" && conflicts.length > 0 ? (
            <p className="m-0 mt-1 text-[13px] leading-5 text-muted">
              {conflictCountCopy(conflicts.length, hasMoreConflicts)}
            </p>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {state.status === "loading" ? (
            <p className="m-0 text-[13px] leading-5 text-muted" role="status">
              Looking for files with two copies…
            </p>
          ) : null}
          {state.status === "error" ? (
            <RetryRow
              testId="conflict-review-retry"
              onRetry={() => {
                setState({ status: "loading" });
                setLoadAttempt((attempt) => attempt + 1);
              }}
            />
          ) : null}
          {state.status === "ready" && !anyOpen ? (
            <p
              data-testid="conflict-review-empty"
              className="m-0 text-[13px] leading-5 text-muted"
              role="status"
            >
              {state.resolvedAny
                ? "You chose a copy for every file."
                : "No files have two copies."}
            </p>
          ) : null}
          {state.status === "ready" && conflicts.length > 0 ? (
            <ConflictList
              workspaceId={workspaceId}
              onError={props.onError}
              beginLineageOperation={props.beginLineageOperation}
              onWorkspaceStateChanged={props.onWorkspaceStateChanged}
              conflicts={conflicts}
              hasMore={hasMoreConflicts}
              onLoadMore={loadMoreConflicts}
              sourceNameFor={(conflict) =>
                versionNames.get(conflict.sourceVersionId) ?? "the other version"
              }
              onResolved={onResolved}
            />
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">
          <SecondaryButton data-testid="conflict-review-done" onClick={props.onClose}>
            {anyOpen ? "Finish later" : "Done"}
          </SecondaryButton>
        </footer>
      </div>
    </Overlay>
  );
}
