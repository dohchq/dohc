import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shareCaptureNoticeState } from "../../workspaces/shareCaptureNotice";
import type { ShareUnconfirmedChanges } from "../../workspaces/shareViewInfo";
import { CreationPartialError, creationPartialNotice } from "@dohc/cli/creation";
import type { ReportKinds } from "../../ipc/bridgeContract";
import type { ReportButtonError } from "../collections/useAutomationButtons";
import { isPrivacyDenied, KEEPABLE_COLLECTIONS_REFUSALS, readCollectionsRefusal, readError, UNKNOWN_ERROR_WORDS, USE_THIS_COMPUTER, withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { SETTLEMENT_BINDING_CHANGED } from "../../notices/settlementRefusal";
import { MAX_OPEN_TABS } from "../workbench/workbenchState";
import type { ErrorDetailField } from "./copyDetails";
import { reportsNoticeText } from "./useReportsNotice";
import type { DirectWriteNotice, DirectWriteNoticeKind } from "./useShareDirectWrites";

// A file dohc kept while it saved, as its Notices row reads, and the step
// that moves it to a visible copy.
export interface KeptCopyNotice {
  id: number;
  message: string;
  save: () => void;
}

// Typing capture kept in History when its file changed outside dohc, as its
// Notices row reads. `raise` puts the row back, with its toast, in answer to
// something the person just did.
export interface CaptureRecoveryNotice {
  momentId: string;
  path: string;
  title: string;
  message: string;
  raise: boolean;
  open: () => void;
  dismiss: () => void;
}

export type SettingsFileKind = "user-settings-file" | "workspace-settings-file";
export type ShellErrorKind =
  | "typing-checkpoint"
  | "typing-import"
  | "capture-recovery"
  | "capture-held"
  | "outside-copy-read"
  | "live-edit-refused"
  | "chat-no-runner"
  | "chat-budget-paused"
  | "chat-restricted"
  | "singleton-tab-split"
  | "tab-limit"
  | "workspace-search"
  | "cloud-sync"
  | "collections-waiting"
  | "collection-copies-left"
  | "sync-refusal"
  | "import-files"
  | "share-refresh"
  | "share-capture"
  | "kept-copies-summary"
  | "kept-copies-more"
  | "drive-no-atomic-placement"
  | "network-share"
  | "file-recovery-unavailable"
  | "kept-files"
  | "retained-copies"
  | "record-history"
  | "record-history-run"
  | "reports"
  | "schedule-host"
  | DirectWriteNoticeKind
  | SettingsFileKind;

// A message the toast and the Notices row can hold. A protocol response or a
// validation reason can run long; the report Copy makes keeps the rest.
export const SHELL_ERROR_MAX_CHARS = 500;

const shareCaptureNotices = new Map<string, { key: string; dismissed: boolean }>();

// One workspace error the notice center shows: a toast when it arrives, a
// row in Notices until it is retried or dismissed. An error that names a
// value the user can see owes them a way to ask again (AGENTS.md), so a
// retry rides with it; errors that are already over carry none.
export interface ShellError {
  // Omitted for a failure. A warning needs the person, though nothing failed.
  tone?: "success" | "warning";
  // A success toast that stays until it is closed, rather than fading.
  stays?: boolean;
  id: string;
  title?: string;
  message: string;
  // A line after the message that no clamp hides, such as how many more
  // files a list leaves out.
  lastLine?: string;
  // Facts for a report, one "label: value" line each, such as the error as
  // it arrived. They go into Copy details, not the text a person reads.
  details?: ReadonlyArray<ErrorDetailField>;
  // Answers false when it could not run, so the row stays.
  retry: (() => void | false) | null;
  // A step offered beside Try again: one that fixes the cause, such as
  // opening the file it names, or a success notice's Undo. A step that
  // `ends` the notice removes its row when it runs.
  action?: { label: string; run: () => void; ends?: boolean; additional?: {label: string; run: () => void}[] };
  onDismiss?: () => void;
  kind?: ShellErrorKind;
  // A kept copy's row: it stays while the engine lists that copy.
  keptCopyId?: number;
  // The reports notice's row: the reports its words name.
  reports?: ReportKinds;
  // What the row is about, such as one record a creation left part way or
  // one person's Stop and restore. A row replaces only a row of the same
  // identity, whatever its message.
  identity?: string;
  atMs: number;
  // The toast was closed; the row in Notices stays until dismissed there.
  seen: boolean;
}

// The error hook a notice owner hands to a shared part that reports its own
// failure, such as a copy the clipboard refused: `reportShellFailure`, for a
// failure the part has already worded. Outside an owner, the part says it in
// place only.
export type ReportShellFailure = (failure: {
  message: string;
  cause?: unknown;
  retry?: (() => void) | null;
}) => void;
export const ShellErrorReporter = createContext<ReportShellFailure | null>(null);

export function useShellError(workspaceId: string) {
  const [shellErrors, setShellErrors] = useState<readonly ShellError[]>([]);
  const shellErrorsRef = useRef(shellErrors);
  shellErrorsRef.current = shellErrors;
  const nextId = useRef(0);
  // Kept copies already shown in this workspace. A row the person dismissed
  // stays dismissed until the workspace opens again.
  const shownKeptCopies = useRef(new Set<number>());
  const shownKeptCopiesMore = useRef(false);
  // Sibling notices restored from local storage have a row without a toast.
  const shownOutsideCopies = useRef(new Map<string, string>());
  // Listed kept typing already shown in this workspace.
  const shownCaptureRecoveries = useRef(new Set<string>());
  const shownCaptureHolds = useRef(new Set<string>());

  // A new error replaces an older one that says the same thing, or one of
  // the same kind, so a read that keeps failing is one row, not a pile.
  // `seen` files the row without a toast; "keep" gives it the seen state of
  // the row of its kind it replaces, so an open toast stays open, and files
  // it quietly when there is none.
  // "repeat" keeps an unchanged message's toast, and toasts a new message.
  // "quiet" updates the row it replaces where it stands, with its id, time
  // and toast, so it never takes the toast from a newer row; with no row to
  // replace it files one without a toast.
  const push = useCallback(
    (error: Omit<ShellError, "id" | "atMs" | "seen">, seen: boolean | "keep" | "repeat" | "quiet" = false) => {
      nextId.current += 1;
      const id = `shell-error-${nextId.current}`;
      const atMs = Date.now();
      const message =
        error.message.length > SHELL_ERROR_MAX_CHARS
          ? `${error.message.slice(0, SHELL_ERROR_MAX_CHARS - 1)}…`
          : error.message;
      setShellErrors((current) => {
        const matches = (existing: ShellError) =>
          error.identity !== undefined || existing.identity !== undefined
            ? error.identity === existing.identity
            : existing.message === message || (error.kind !== undefined && existing.kind === error.kind);
        const replaced = current.find(matches);
        if (seen === "quiet" && replaced) {
          const updated: ShellError = { ...error, message, id: replaced.id, atMs: replaced.atMs, seen: replaced.seen };
          return current.flatMap((existing) => existing === replaced ? [updated] : matches(existing) ? [] : [existing]);
        }
        const repeated = seen === "repeat" && replaced?.message === message ? replaced : undefined;
        const next: ShellError = {
          ...error,
          message,
          id: repeated?.id ?? id,
          atMs: repeated?.atMs ?? atMs,
          seen: seen === "repeat" ? (repeated?.seen ?? false) : seen === "keep" || seen === "quiet" ? (replaced?.seen ?? true) : seen,
        };
        return [
          ...current.filter((existing) => !matches(existing)),
          next,
        ];
      });
    },
    [],
  );
  // The step a macOS privacy refusal offers: the pane where a person allows
  // dohc the folder. A pane macOS would not open files its own notice, in the
  // workspace that asked.
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const privacySettingsAction = useMemo<NonNullable<ShellError["action"]>>(() => {
    const run = (): void => {
      const owner = currentWorkspace.current;
      bridge().openSystemPrivacySettings({}).catch((error: unknown) => {
        if (currentWorkspace.current !== owner) return;
        const { cause } = readError(error);
        push({
          message: withErrorWords("dohc could not open System Settings.", error),
          ...(cause ? { details: [["Cause", cause]] } : {}),
          retry: run,
          identity: "open-system-settings",
        });
      });
    };
    return { label: "Open System Settings", run };
  }, [push]);
  // Keeps the workspace's Collections on this computer, then runs `then`,
  // such as the step that was refused. Main asks first when another
  // computer may have them, and nothing runs when the person cancels. A
  // failure files its own row.
  const keepCollectionsHere = useCallback((then: (() => void) | null) => {
    const owner = currentWorkspace.current;
    const run = (): void => {
      bridge().keepCollectionsHere({ workspaceId: owner }).then(({ kept }) => {
        if (kept && currentWorkspace.current === owner) then?.();
      }, (error: unknown) => {
        if (currentWorkspace.current !== owner) return;
        const { cause } = readError(error);
        push({
          message: withErrorWords("dohc could not keep the Collections on this computer.", error),
          ...(cause ? { details: [["Cause", cause]] } : {}),
          retry: run,
          identity: "keep-collections",
        });
      });
    };
    run();
  }, [push]);
  const clearIdentity = useCallback((identity: string) => {
    setShellErrors((current) =>
      current.some((error) => error.identity === identity) ? current.filter((error) => error.identity !== identity) : current,
    );
  }, []);
  const clearKind = useCallback((...kinds: ShellErrorKind[]) => {
    setShellErrors((current) =>
      current.some((error) => error.kind !== undefined && kinds.includes(error.kind))
        ? current.filter((error) => error.kind === undefined || !kinds.includes(error.kind))
        : current,
    );
  }, []);

  const filedShareCapture = useRef<string | null>(null);
  const reportShareCapture = useCallback((shareId: string, paths: readonly string[] | null | undefined,
    snapshot?: ShareUnconfirmedChanges, ended = true) => {
    const identity = `share-capture:${workspaceId}:${shareId}`;
    const { filePaths: sortedPaths, unchecked, checked, key } = shareCaptureNoticeState(paths, snapshot, ended);
    if (snapshot?.dismissedKey === key || (!unchecked && sortedPaths.length === 0)) {
      shareCaptureNotices.delete(identity);
      filedShareCapture.current = null;
      clearKind("share-capture");
      return;
    }
    const previous = shareCaptureNotices.get(identity);
    if (previous?.key === key && (previous.dismissed || filedShareCapture.current === `${identity}:${key}`)) return;
    const notice = { key, dismissed: false };
    shareCaptureNotices.set(identity, notice);
    filedShareCapture.current = `${identity}:${key}`;
    push({
      identity,
      kind: "share-capture",
      title: sortedPaths.length ? ended ? "Changes kept on this computer" : "Changes to copy now" : "Share check incomplete",
      message: [
        ...(unchecked ? [checked > 0 || sortedPaths.length > 0
          ? "dohc checked only some of this share's files." : "dohc couldn't check this share's files."] : []),
        ...(sortedPaths.length ? ["dohc couldn't confirm these changes reached the share.",
          ...(ended ? ["They are kept on this computer."]
            : ["A later change from the owner can replace these files.", "Your saved changes stay in History."])] : []),
        unchecked ? sortedPaths.length ? "Copy these files and any others you changed to another workspace now." : "Copy any files you changed to another workspace now."
          : ended ? "Copy these files to another workspace." : "Copy these files to another workspace now.",
      ].join(" "),
      details: sortedPaths.length ? sortedPaths.map(path => ["File", path, path.length] as const) : undefined,
      retry: null,
      onDismiss: () => { notice.dismissed = true; },
    }, previous?.key === key ? true : false);
  }, [workspaceId, clearKind, push]);

  const showTabLimitError = useCallback(
    (
      openTabCount: number,
      nextAction: "open this file" | "open another tab" | "create an editor group",
    ) => {
      push({
        message: `This workspace has ${openTabCount} open tabs; the limit is ${MAX_OPEN_TABS}. Close a tab to ${nextAction}.`,
        retry: null,
        kind: "tab-limit",
      });
    },
    [push],
  );
  const clearTabLimitError = useCallback(() => clearKind("tab-limit"), [clearKind]);
  const showSingletonTabSplitError = useCallback(() => {
    push({
      message:
        "This tab owns its process and cannot be split. Open another tab before you create an editor group.",
      retry: null,
      kind: "singleton-tab-split",
    });
  }, [push]);
  const clearEditorGroupRefusalError = useCallback(
    () => clearKind("singleton-tab-split", "tab-limit"),
    [clearKind],
  );

  useEffect(() => {
    setShellErrors([]);
    shownOutsideCopies.current = new Map();
    shownKeptCopies.current = new Set();
    shownKeptCopiesMore.current = false;
    shownCaptureRecoveries.current = new Set();
    shownCaptureHolds.current = new Set();
    filedShareCapture.current = null;
  }, [workspaceId]);

  const reportShellError = useCallback(
    (
      fallback: string,
      error: unknown,
      retry: (() => void) | null = null,
      kind?: ShellErrorKind,
      identity?: string,
    ) => {
      const { cause, title, words } = readError(error);
      const partial = error instanceof CreationPartialError ? error.partial : undefined;
      const details: ReadonlyArray<ErrorDetailField> = partial ? [
        ...partial.created.map((path): ErrorDetailField => ["Created", path, path.length]),
        ["Stage", partial.failedStage],
        ["Record ID", partial.retry.recordId],
        ["Reason", partial.reason, partial.reason.length],
        ["Next", partial.retry.instruction, partial.retry.instruction.length],
      ] : cause ? [["Cause", cause]] : [];
      push({
        ...(title ? { title } : {}),
        message: title && words ? words : partial ? creationPartialNotice(partial) : withErrorWords(fallback, error),
        ...(partial ? { identity: partial.retry.recordId
          ? `record:${partial.retry.recordId}`
          : `form:${partial.created[0]!.split("/").slice(0, -1).join("/")}` } : identity !== undefined ? { identity } : {}),
        ...(details.length ? { details } : {}),
        retry,
        ...(isPrivacyDenied(error) ? { action: privacySettingsAction }
          : KEEPABLE_COLLECTIONS_REFUSALS.includes(readCollectionsRefusal(error)?.kind ?? "changed") ? { action: { label: USE_THIS_COMPUTER, run: () => keepCollectionsHere(retry), ends: true } }
          : {}),
        ...(kind ? { kind } : {}),
      });
    },
    [push, privacySettingsAction, keepCollectionsHere],
  );
  // The error hook the shell hands its parts (ReportButtonError): no kind, and
  // an identity when the part names what failed.
  const reportButtonError = useCallback<ReportButtonError>(
    (fallback, error, retry, identity) => reportShellError(fallback, error, retry, undefined, identity),
    [reportShellError],
  );
  // A failure already worded for the person. Report facts, such as a raw
  // cause, go into Copy details only; so does `cause`, the error that caused
  // the words. Text that arrives raw is read into words the same way. A kind
  // makes a newer message replace the row of an older one, such as one
  // import's result replacing the last; an identity does the same for one
  // thing, such as one folder. `repeat` keeps an unchanged message's row
  // and toast state. A changed message, or a missing row, toasts again.
  // `quiet` files the row without a new toast, for a failure the person was
  // already told about; a toast still open stays open.
  const reportShellFailure = useCallback(
    (failure: {
      title?: string;
      tone?: ShellError["tone"];
      repeat?: boolean;
      quiet?: boolean;
      message: string;
      cause?: unknown;
      details?: ReadonlyArray<ErrorDetailField>;
      retry?: ShellError["retry"];
      onDismiss?: () => void;
      action?: ShellError["action"];
      kind?: ShellErrorKind;
      identity?: string;
    }) => {
      const shown = readError(failure.message);
      const cause = failure.cause === undefined ? shown.cause : readError(failure.cause).cause;
      const action = failure.action ??
        (isPrivacyDenied(failure.message) || isPrivacyDenied(failure.cause) ? privacySettingsAction : undefined);
      const details: ReadonlyArray<ErrorDetailField> = [
        ...(failure.details ?? []),
        ...(cause ? [["Cause", cause] as const] : []),
      ];
      push({
        ...(failure.title ? { title: failure.title } : {}),
        ...(failure.tone ? { tone: failure.tone } : {}),
        message: shown.words ?? UNKNOWN_ERROR_WORDS,
        retry: failure.retry ?? null,
        ...(details.length ? { details } : {}),
        ...(failure.onDismiss ? { onDismiss: failure.onDismiss } : {}),
        ...(action ? { action } : {}),
        ...(failure.kind ? { kind: failure.kind } : {}),
        ...(failure.identity !== undefined ? { identity: failure.identity } : {}),
      }, failure.quiet ? "quiet" : failure.repeat ? "repeat" : false);
    },
    [push, privacySettingsAction],
  );
  // Content search lives in the shell so its results survive panel switches.
  // Invocation failures use the shell's persistent error and retry contract;
  // they must not look like a successful search with no matches.
  const reportSearchError = useCallback(
    (error: unknown, retry: () => void) =>
      reportShellError(
        "dohc could not search this workspace.",
        error,
        retry,
        "workspace-search",
      ),
    [reportShellError],
  );
  const clearSearchError = useCallback(() => clearKind("workspace-search"), [clearKind]);
  // One sync failure at a time: a new report replaces the last one. A toast
  // interrupts; otherwise the row keeps whatever toast its predecessor had.
  const reportSyncFailure = useCallback(
    (
      notice: { message: string; detail: string; toast: boolean },
      retry: () => void,
    ) =>
      push(
        { message: notice.message, details: [["Detail", notice.detail]], retry, kind: "cloud-sync" },
        notice.toast ? false : "quiet",
      ),
    [push],
  );
  const clearSyncFailure = useCallback(() => clearKind("cloud-sync"), [clearKind]);
  // One row while Collection updates wait for an unfinished pull. A newer
  // report replaces it, keeping its toast unless the report toasts. The wait
  // itself is a warning; a reopen that failed is a failure.
  const reportCollectionsWaiting = useCallback(
    (notice: { message: string; toast: boolean; failed: boolean }, retry: () => void, openSyncSettings: () => void) =>
      push(
        {
          ...(notice.failed ? {} : { tone: "warning" as const }),
          message: notice.message,
          retry,
          action: { label: "Sync settings", run: openSyncSettings },
          kind: "collections-waiting",
        },
        notice.toast ? false : "keep",
      ),
    [push],
  );
  const clearCollectionsWaiting = useCallback(() => clearKind("collections-waiting"), [clearKind]);
  const showSyncRefusals = useCallback((notices: readonly import("../../ipc/bridgeContract").NoticeRow[], retry: () => void, openFile?: (path: string) => void) => {
    setShellErrors(current => [
      ...current.filter(error => error.kind !== "sync-refusal"),
      ...notices.map(notice => {
        const prior = current.find(error => error.id === notice.noticeId);
        const bindingChanged = notice.detail?.split("\n")[0] === SETTLEMENT_BINDING_CHANGED;
        const path = notice.target?.path;
        return { id: notice.noticeId, kind: "sync-refusal" as const, message: notice.body.slice(0, SHELL_ERROR_MAX_CHARS),
          title: bindingChanged ? notice.title : undefined,
          details: [["Detail", notice.detail ?? notice.body]] as const, atMs: notice.createdAtMs, seen: prior?.seen ?? notice.readAtMs !== null,
          retry: bindingChanged ? null : retry,
          ...(bindingChanged && path && openFile ? { action: { label: "Open", run: () => openFile(path) } } : {}) };
      }),
    ]);
  }, []);
  // A drive limit: one row that a remount files again without a toast.
  const reportDriveLimit = useCallback(
    (notice: { message: string; toast: boolean }) =>
      push(
        {
          message: notice.message,
          details: [["Detail", "no-atomic-placement"]],
          retry: null,
          kind: "drive-no-atomic-placement",
        },
        !notice.toast,
      ),
    [push],
  );
  // A workspace on a network share: one warning row. Nothing failed, so it
  // offers no Try again.
  const reportNetworkShare = useCallback(
    (notice: { title: string; message: string; toast: boolean }) =>
      push(
        {
          tone: "warning",
          title: notice.title,
          message: notice.message,
          details: [["Detail", "network-share"]],
          retry: null,
          kind: "network-share",
        },
        !notice.toast,
      ),
    [push],
  );
  const reportRecoveryUnavailable = useCallback(
    (unavailable: boolean, retry: () => void, openFolder: () => void) => {
      if (!unavailable) {
        clearKind("file-recovery-unavailable");
        return;
      }
      push({
        message: "dohc could not read the recovery folder. File recovery is waiting. Check folder access, then try again.",
        details: [["Folder", ".dohc/engine/displaced"]],
        retry,
        action: { label: "Show recovery folder", run: openFolder },
        kind: "file-recovery-unavailable",
      });
    },
    [clearKind, push],
  );
  // An import that skipped sources: a title, then a line for each one. dohc
  // wrote every line, so the lines are shown as they are.
  const reportImportSkips = useCallback(
    (notice: { title: string; lines: readonly string[]; lastLine?: string; details: ReadonlyArray<ErrorDetailField> }) => {
      push({
        title: notice.title,
        message: notice.lines.join("\n"),
        ...(notice.lastLine ? { lastLine: notice.lastLine } : {}),
        details: notice.details,
        retry: null,
        kind: "import-files",
      });
    },
    [push],
  );
  const reportKeptFiles = useCallback(
    (notice: { paths: readonly (readonly [string, string])[]; toast: boolean }, openFolder: () => void) => {
      if (!notice.paths.length) {
        clearKind("kept-files");
        return;
      }
      push({
        message: "dohc kept recovery copies of files. Review the copies in .dohc/engine/displaced inside your workspace folder.",
        details: notice.paths.map(([original, copy]) => [original || "Copy", copy] as const),
        retry: null,
        action: { label: "Show recovery folder", run: openFolder },
        kind: "kept-files",
      }, !notice.toast);
    },
    [clearKind, push],
  );
  // Old file copies on a drive that cannot tell dohc whether a program
  // still uses them: one warning per workspace, updated where it stands.
  // `toast` files it with a toast, once each time the copies pass the size;
  // otherwise it updates the row, or files it quietly. Null clears it.
  const showRetainedCopies = useCallback(
    (notice: {
      title: string;
      message: string;
      action: { label: string; run: () => void };
      onDismiss: () => void;
    } | null, toast: boolean) => {
      if (notice === null) {
        clearKind("retained-copies");
        return;
      }
      push({
        tone: "warning",
        title: notice.title,
        message: notice.message,
        retry: null,
        action: notice.action,
        onDismiss: notice.onDismiss,
        kind: "retained-copies",
      }, toast ? false : "quiet");
    },
    [clearKind, push],
  );
  // Snapshot lanes share one surface. Keep the lane in the message so the
  // user can tell which value went stale, then show the cause and a retry.
  //
  // The retry matters most on the first load. A sibling that fails while the
  // page succeeds renders the timeline, which hides History's own Try again —
  // so without this the lane had no way back at all, and its value could sit
  // stale until unrelated workspace activity happened to refresh it.
  const reportLaneFailure = useCallback(
    (lane: string, error: unknown, retry: () => void) => {
      const { cause } = readError(error);
      push({ message: withErrorWords(lane, error), ...(cause ? { details: [["Cause", cause]] } : {}), retry });
    },
    [push],
  );

  // One row per settings file: a newer read replaces it, and a read with
  // nothing to report clears it. Try again reads the file again; the action
  // opens it.
  const showSettingsFileNotice = useCallback(
    (
      kind: SettingsFileKind,
      message: string | null,
      steps: { retry: () => void; open: () => void },
    ) => {
      if (message === null) clearKind(kind);
      else {
        push({
          message,
          retry: steps.retry,
          action: { label: "Open settings file", run: steps.open },
          kind,
        });
      }
    },
    [clearKind, push],
  );
  // One row per kind of direct-write answer. Sending the waiting changes
  // answers every row that offered it, so it clears them.
  const showDirectWriteNotice = useCallback(
    (notice: DirectWriteNotice) => {
      const { send } = notice;
      push({
        message: notice.message,
        retry: notice.retry,
        ...(send
          ? {
              action: {
                label: send.label,
                run: () => {
                  clearKind("direct-write-stale", "direct-write-refused", "direct-write-unavailable");
                  send.run();
                },
              },
            }
          : {}),
        kind: notice.kind,
      });
    },
    [clearKind, push],
  );
  // A settings file's row stays: the file is still wrong until the person
  // saves it. An Undo's row goes, so it runs once.
  const runShellErrorAction = useCallback((id: string, index = 0) => {
    const target = shellErrorsRef.current.find((error) => error.id === id);
    if (index > 0) {target?.action?.additional?.[index - 1]?.run(); return;}
    if (target?.action?.ends) setShellErrors((current) => current.filter((error) => error.id !== id));
    target?.action?.run();
  }, []);
  // A kind makes a newer message replace the row of an older one, such as
  // one import's result replacing the last import's.
  const showSuccessNotice = useCallback(
    (message: string, undo?: () => void, kind?: ShellErrorKind, action?: ShellError["action"]) => {
      push({
        message,
        retry: null,
        tone: "success",
        ...(kind ? { kind } : {}),
        ...(action ? { action } : undo ? { action: { label: "Undo", run: undo, ends: true } } : {}),
      });
    },
    [push],
  );
  // One row for where this workspace's schedules run, while that needs the
  // person: a warning while another computer runs them, and an error, with
  // Try again, while none does. A read that says the same keeps its toast's
  // state; null clears the row.
  const showScheduleHostNotice = useCallback((notice: {
    message: string;
    failed: boolean;
    cause?: string;
    retry: () => void;
    takeOver: () => void;
  } | null) => {
    if (notice === null) {
      clearKind("schedule-host");
      return;
    }
    push({
      message: notice.message,
      ...(notice.failed ? {} : { tone: "warning" as const }),
      ...(notice.cause ? { details: [["Cause", notice.cause]] } : {}),
      retry: notice.failed ? notice.retry : null,
      action: { label: "Take over now", run: notice.takeOver, ends: true },
      kind: "schedule-host",
    }, "repeat");
  }, [clearKind, push]);
  const showWarningNotice = useCallback((message: string) => {
    push({message, retry: null, tone: "warning"});
  }, [push]);
  // The one-time notice about the reports this launch sends, with the way
  // to turn them off. It stays until the person closes it.
  const showReportsNotice = useCallback((reports: ReportKinds, openPrivacy: () => void) => {
    push({
      message: reportsNoticeText(reports),
      retry: null,
      tone: "success",
      stays: true,
      kind: "reports",
      reports,
      action: { label: "Privacy settings", run: openPrivacy },
    });
  }, [push]);
  // One row per kept copy the engine lists. A copy listed for the first time
  // arrives as a toast; several at once arrive as one summary toast instead.
  // A copy no longer listed, because it was saved, loses its row. `more`
  // says the engine kept copies past its list, and holds one row of its own.
  const showKeptCopies = useCallback((copies: readonly KeptCopyNotice[], more: boolean) => {
    const listed = new Set(copies.map((copy) => copy.id));
    const atMs = Date.now();
    const row = (fields: Omit<ShellError, "id" | "atMs">): ShellError => {
      nextId.current += 1;
      return { ...fields, id: `shell-error-${nextId.current}`, atMs };
    };
    const arrived = copies.filter((copy) => !shownKeptCopies.current.has(copy.id));
    for (const copy of arrived) shownKeptCopies.current.add(copy.id);
    const summarized = arrived.length > 1;
    const fresh: ShellError[] = arrived.map((copy) => row({
      message: copy.message,
      retry: null,
      action: { label: "Save copy", run: copy.save },
      keptCopyId: copy.id,
      seen: summarized,
    }));
    if (summarized) {
      fresh.push(row({
        message: `dohc kept ${arrived.length} copies of files other programs changed.`,
        retry: null,
        kind: "kept-copies-summary",
        seen: false,
      }));
    }
    const addMore = more && !shownKeptCopiesMore.current;
    shownKeptCopiesMore.current = more;
    const moreRow = row({
      message: "dohc kept more copies than Notices can list. Save these copies to see the rest.",
      retry: null,
      kind: "kept-copies-more",
      seen: true,
    });
    setShellErrors((current) => {
      const added = addMore ? [...fresh, moreRow] : fresh;
      const stays = current.filter((error) =>
        (error.keptCopyId === undefined || listed.has(error.keptCopyId)) &&
        (error.kind !== "kept-copies-more" || more) &&
        (error.kind !== "kept-copies-summary" || (copies.length > 0 && !summarized)));
      return added.length === 0 && stays.length === current.length
        ? current
        : [...stays, ...added];
    });
  }, []);
  // One row per kept typing the engine lists. One listed for the first time,
  // or raised, arrives as a toast and replaces its row. Otherwise its row
  // stays as it is, or stays dismissed, and one no longer listed goes.
  const showCaptureRecoveries = useCallback((recoveries: readonly CaptureRecoveryNotice[]) => {
    const identityOf = (momentId: string) => `capture-recovery:${momentId}`;
    const listed = new Set(recoveries.map((recovery) => identityOf(recovery.momentId)));
    for (const momentId of shownCaptureRecoveries.current) {
      if (!listed.has(identityOf(momentId))) shownCaptureRecoveries.current.delete(momentId);
    }
    const atMs = Date.now();
    const fresh = recoveries.flatMap((recovery): ShellError[] => {
      if (shownCaptureRecoveries.current.has(recovery.momentId) && !recovery.raise) return [];
      shownCaptureRecoveries.current.add(recovery.momentId);
      nextId.current += 1;
      return [{
        id: `shell-error-${nextId.current}`,
        identity: identityOf(recovery.momentId),
        kind: "capture-recovery",
        tone: "warning",
        title: recovery.title,
        message: recovery.message,
        details: [["File", recovery.path, recovery.path.length], ["Change id", recovery.momentId]],
        retry: null,
        action: { label: "Open History", run: recovery.open },
        onDismiss: recovery.dismiss,
        atMs,
        seen: false,
      }];
    });
    const replaced = new Set(fresh.map((error) => error.identity));
    setShellErrors((current) => {
      const stays = current.filter((error) => error.kind !== "capture-recovery" ||
        (listed.has(error.identity ?? "") && !replaced.has(error.identity)));
      return fresh.length === 0 && stays.length === current.length ? current : [...stays, ...fresh];
    });
  }, []);
  // Visible sibling copies open directly; native displacements use Save copy.
  const showOutsideCopies = useCallback((copies: readonly (readonly [string, string, string])[], open: (path: string) => void) => {
    const key = `dohc:outside-write-copies:${workspaceId}`;
    let saved: Record<string, { copy: string; dismissed: boolean }> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [path, value] of Object.entries(parsed)) {
          if (value && typeof value === "object" && "copy" in value && typeof value.copy === "string" &&
              "dismissed" in value && typeof value.dismissed === "boolean") saved[path] = { copy: value.copy, dismissed: value.dismissed };
        }
      }
    } catch { /* A denied browser store leaves notices usable in this run. */ }
    const persist = () => {
      try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Keep the in-session notice. */ }
    };
    const latest = new Map(copies.map(([path, copy, id]) => [path, { copy, id }]));
    const present = new Set(copies.map(([, , id]) => id));
    for (const entry of Object.keys(saved)) if (!present.has(entry)) delete saved[entry];
    for (const path of shownOutsideCopies.current.keys()) if (!latest.has(path)) shownOutsideCopies.current.delete(path);
    const listed = new Set([...latest].filter(([, { id }]) => !saved[id]?.dismissed).map(([path]) => `outside-copy:${path}`));
    setShellErrors(current => current.filter(row => !row.identity?.startsWith("outside-copy:") || listed.has(row.identity)));
    for (const [path, { copy, id }] of latest) {
      const identity = `outside-copy:${path}`;
      const shownKey = id;
      if (shownOutsideCopies.current.get(path) === id) continue;
      shownOutsideCopies.current.set(path, id);
      const previous = saved[shownKey];
      if (previous?.copy === copy && previous.dismissed) continue;
      const seen = previous?.copy === copy;
      saved[shownKey] = { copy, dismissed: false };
      const dismiss = () => {
        // Read current state so an old row cannot dismiss a newer copy.
        try { saved = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { /* Use the current run's state. */ }
        if (saved[shownKey]?.copy === copy) { saved[shownKey]!.dismissed = true; persist(); }
      };
      push({ identity, title: `Kept a copy of ${path}`,
        message: `It changed outside dohc. That change is now in ${copy}.`,
        retry: null, tone: "warning", onDismiss: dismiss,
        action: { label: "Open copy", run: () => { open(copy); dismiss(); }, ends: true } }, seen);
    }
    persist();
  }, [push, workspaceId]);
  // A native copy that was saved opens from its new path.
  const showKeptCopySaved = useCallback(
    (message: string, open: (() => void) | null) => {
      push({
        message,
        retry: null,
        tone: "success",
        ...(open ? { action: { label: "Open", run: open, ends: true } } : {}),
      });
    },
    [push],
  );
  // The toast closes; the row in Notices stays.
  const hideShellError = useCallback((id: string) => {
    setShellErrors((current) =>
      current.map((error) => (error.id === id ? { ...error, seen: true } : error)),
    );
  }, []);
  const dismissShellError = useCallback((id: string) => {
    shellErrorsRef.current.find((error) => error.id === id)?.onDismiss?.();
    setShellErrors((current) => current.filter((error) => error.id !== id));
  }, []);
  const showCaptureHolds = useCallback((files: readonly { path: string; message: string; retry: () => void }[]) => {
    const listed = new Set(files.map(file => file.path));
    for (const path of shownCaptureHolds.current) {
      if (!listed.has(path)) shownCaptureHolds.current.delete(path);
    }
    const arrived = files.filter(file => !shownCaptureHolds.current.has(file.path));
    for (const file of arrived) shownCaptureHolds.current.add(file.path);
    const fresh = arrived.map((file): ShellError => ({
      id: `shell-error-${++nextId.current}`, identity: `capture-held:${file.path}`, kind: "capture-held", tone: "warning",
      title: "Outside edit not recorded", message: file.message,
      details: [["File", file.path, file.path.length]], retry: file.retry, atMs: Date.now(), seen: false,
    }));
    setShellErrors(current => {
      const stays = current.filter(row => row.kind !== "capture-held" || listed.has(row.identity!.slice("capture-held:".length)));
      return fresh.length === 0 && stays.length === current.length ? current : [...stays, ...fresh];
    });
  }, []);

  const retryShellError = useCallback((id: string) => {
    const target = shellErrorsRef.current.find((error) => error.id === id);
    // A retry that could not run leaves every row where it stands.
    if (target?.retry?.() === false) return;
    // Clearing is what shows the control took: the read is on its way, and
    // a failure that is being retried is no longer the newest thing this
    // surface knows. The retry runs once, outside the updater. Only the row
    // retried goes, so a failure the retry has already reported again stays.
    setShellErrors(current => target?.kind === "sync-refusal" || target?.kind === "capture-held" || target?.kind === "outside-copy-read"
      ? current
      : current.filter(error => error !== target));
  }, []);

  return {
    shellErrors,
    clearKind,
    clearIdentity,
    reportShellError,
    reportButtonError,
    reportShellFailure,
    reportShareCapture,
    reportLaneFailure,
    reportSearchError,
    clearSearchError,
    reportSyncFailure,
    showSyncRefusals,
    clearSyncFailure,
    reportCollectionsWaiting,
    clearCollectionsWaiting,
    reportDriveLimit,
    reportNetworkShare,
    reportKeptFiles,
    reportImportSkips,
    showRetainedCopies,
    reportRecoveryUnavailable,
    showTabLimitError,
    clearTabLimitError,
    showSingletonTabSplitError,
    clearEditorGroupRefusalError,
    showSettingsFileNotice,
    showDirectWriteNotice,
    showSuccessNotice,
    showWarningNotice,
    showScheduleHostNotice,
    showReportsNotice,
    showKeptCopies,
    showKeptCopySaved,
    showOutsideCopies,
    showCaptureRecoveries,
    showCaptureHolds,
    hideShellError,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
    privacySettingsAction,
    keepCollectionsHere,
  };
}
