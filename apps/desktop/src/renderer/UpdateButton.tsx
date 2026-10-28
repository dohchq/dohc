import { Download, RefreshCw, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStateEvent } from "../ipc/bridgeContract";
import { readError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { onRestartStopped, requestGuardedUpdateInstall } from "./RecoveryCloseGuard";
import type { ErrorDetailField } from "./shell/copyDetails";
import type { ReportShellFailure, ShellErrorKind } from "./shell/useShellError";
import { useDesktopUpdateStateFeed } from "./useDesktopUpdateStateFeed";

export type UpdateAction = "check" | "download" | "install";

// One step of updating dohc, as every update control shows it: the title
// bar, Settings, and the stopped workspace. Nothing downloads until a person
// presses Update, and nothing installs until they press Restart to update.
export interface UpdateStep {
  // What pressing it does; null while the step runs.
  action: UpdateAction | null;
  label: string;
  // The download's progress, shown after the label.
  percent?: number;
  // The step with its version, for the tooltip and the icon-only name.
  title: string;
  // The title bar shows only the steps with an icon: from a found update
  // to the restart.
  Icon: LucideIcon | null;
}

export function updateStep(state: UpdateStateEvent | null, pending: "check" | "install" | null): UpdateStep | null {
  if (!state) return null;
  const version = state.version ?? "";
  if (pending === "install") {
    return { action: null, label: "Restarting…", title: `Restarting to install update ${version}`, Icon: RefreshCw };
  }
  switch (state.status) {
    case "available":
      return { action: "download", label: "Update", title: `Download update ${version}`, Icon: Download };
    case "downloading": {
      if (state.percent === undefined) {
        return { action: null, label: "Downloading…", title: `Downloading update ${version}`, Icon: Download };
      }
      const percent = Math.round(state.percent);
      return { action: null, label: "Downloading", percent, title: `Downloading update ${version}, ${percent}%`, Icon: Download };
    }
    case "ready":
      return { action: "install", label: "Restart to update", title: `Restart to install update ${version}`, Icon: RefreshCw };
    case "checking":
      return { action: null, label: "Checking…", title: "Checking for updates", Icon: null };
    default:
      return pending === "check"
        ? { action: null, label: "Checking…", title: "Checking for updates", Icon: null }
        : { action: state.canCheck === false ? null : "check", label: "Check for updates", title: "Check for updates", Icon: null };
  }
}

export function updateFailureTitle(step: UpdateAction, version: string | undefined): string {
  if (step === "check") return "dohc could not check for updates";
  return `dohc could not ${step === "download" ? "download" : "install"} update ${version ?? ""}`.trimEnd();
}

// The updater's sentence, or the step that failed when main reports one.
export function updateStatusLine(state: UpdateStateEvent): string {
  if (!state.failure) return state.message;
  const title = updateFailureTitle(state.failure.step, state.version);
  return readError(state.message).words ? `${title}. ${state.message}` : `${title}.`;
}

/** The step's label, with a download's progress in fixed-width digits so
 * the control does not change width as it counts. */
export function UpdateStepLabel(props: { step: UpdateStep; className?: string }) {
  const { step } = props;
  return (
    <span className={props.className}>
      {step.label}
      {step.percent === undefined ? null : (
        <>
          {" "}
          <span className="inline-block w-[4ch] text-left tabular-nums">{step.percent}%</span>
        </>
      )}
    </span>
  );
}

export interface DesktopUpdate {
  state: UpdateStateEvent | null;
  step: UpdateStep | null;
  run: (action: UpdateAction) => Promise<void>;
}

/** The updater's state and the step a person can take next. A failure main
 * reports arrives in the state; `report` hears only a request that never
 * reached the updater. */
export function useDesktopUpdate(report: ReportShellFailure | null): DesktopUpdate {
  const { updateState, acceptUpdateResult } = useDesktopUpdateStateFeed();
  const [pending, setPending] = useState<"check" | "install" | null>(null);
  const reportRef = useRef(report);
  reportRef.current = report;
  const versionRef = useRef(updateState?.version);
  versionRef.current = updateState?.version;
  // A failed install ends the restart.
  const failureId = updateState?.failure?.id;
  useEffect(() => {
    if (failureId !== undefined) setPending(null);
  }, [failureId]);
  // So does a person going back on a restart a late draft stopped.
  useEffect(() => onRestartStopped(() => setPending(null)), []);

  const run = useCallback(async function run(action: UpdateAction): Promise<void> {
    const failed = (cause: unknown) =>
      reportRef.current?.({
        message: `${updateFailureTitle(action, versionRef.current)}.`,
        cause,
        retry: () => void run(action),
      });
    if (action === "download") {
      try {
        acceptUpdateResult((await bridge().downloadUpdate()).state);
      } catch (error) {
        failed(error);
      }
      return;
    }
    setPending(action);
    let restarting = false;
    try {
      if (action === "check") {
        acceptUpdateResult((await bridge().checkForUpdates()).state);
        return;
      }
      // Through the guard: with set-aside drafts present the recovery
      // dialog opens instead of the one-shot install. Null means the dialog
      // took over or someone went back.
      const result = await requestGuardedUpdateInstall();
      if (result === null) return;
      acceptUpdateResult(result.state);
      restarting = result.accepted;
      if (!result.accepted && !result.state.failure) {
        failed(result.reason === undefined ? undefined : new Error(result.reason));
      }
    } catch (error) {
      failed(error);
    } finally {
      if (!restarting) setPending(null);
    }
  }, [acceptUpdateResult]);

  return { state: updateState, step: updateStep(updateState, pending), run };
}

type ReportUpdateFailure = (failure: {
  kind: ShellErrorKind;
  title?: string;
  message: string;
  command?: string;
  details: ReadonlyArray<ErrorDetailField>;
  retry: () => void;
  quiet?: boolean;
}) => void;

// Failure ids this renderer already toasted. The workspace shell remounts on
// every switch, so a failure it showed returns as a row without a toast.
const toastedFailures = new Set<number>();

/** A toast and one Notices row for each failure main reports. A background
 * check that fails as the last one did keeps its id, so it does not toast
 * again; the row goes once the step works. `scope` is the notice owner's
 * workspace, whose change clears its rows. */
export function useUpdateFailureNotices(
  update: DesktopUpdate,
  scope: string,
  report: ReportUpdateFailure,
  clear: () => void,
): void {
  const shown = useRef<string | null>(null);
  const { state, run } = update;
  useEffect(() => {
    if (!state) return;
    const failure = state.failure;
    if (!failure) {
      // A check that runs again may fail as before; its row waits.
      if (state.status === "checking" || shown.current === null) return;
      shown.current = null;
      clear();
      return;
    }
    const key = `${scope}:${failure.id}`;
    if (shown.current === key) return;
    shown.current = key;
    const quiet = toastedFailures.has(failure.id);
    toastedFailures.add(failure.id);
    const title = updateFailureTitle(failure.step, state.version);
    report({
      kind: "update",
      quiet,
      ...(readError(state.message).words ? { title, message: state.message } : { message: `${title}.` }),
      ...(state.installCommand ? { command: state.installCommand } : {}),
      details: [["Cause", state.message]],
      retry: () => void run(failure.step),
    });
  }, [state, scope, report, clear, run]);
}

/** The title bar's update button, from a found update to the restart.
 * Where its box is narrower than "Restart to update" needs, it shows only
 * its icon, and its words become its name. */
export function TitlebarUpdateButton(props: { update: DesktopUpdate }) {
  const step = props.update.step;
  if (!step?.Icon) return null;
  const { action, Icon } = step;
  return (
    <button
      type="button"
      data-testid="titlebar-update"
      data-update-status={props.update.state?.status}
      title={step.title}
      aria-disabled={action === null ? true : undefined}
      onClick={action === null ? undefined : () => void props.update.run(action)}
      className={`titlebar-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-semibold dohc-focus-visible focus-visible:outline-offset-1 @min-[9.75rem]:px-2.5 ${
        action === null
          ? "cursor-default border border-line text-muted"
          : "cursor-pointer bg-accent text-bg hover:opacity-90"
      }`}
    >
      <Icon size={12} aria-hidden className="shrink-0" />
      <UpdateStepLabel step={step} className="hidden @min-[9.75rem]:inline" />
      <span className="sr-only @min-[9.75rem]:hidden">{step.title}</span>
    </button>
  );
}
