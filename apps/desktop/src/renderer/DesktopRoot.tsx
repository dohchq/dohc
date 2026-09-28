import { useRequestSequence } from "./useRequestSequence";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DesktopUserSettingsResult,
  ShareHandoffStatus,
  WorkspaceRegistryResult,
  type DesktopUserSettingsResult as DesktopUserSettingsSnapshot,
  type ShareHandoffStatus as ShareHandoffStatusSnapshot,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { applyLookSettings, differsOnlyInLook } from "./theme";
import { WorkspaceManager } from "./WorkspaceManager";
import { DevPanel } from "./DevPanel";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";
import { ChevronRight } from "lucide-react";
import { readError } from "../ipc/errorWords";
import { CopyDetailsButton, errorDetails } from "./shell/copyDetails";
import { useSentNotices } from "./shell/useSentNotices";
import { useStatesPageOpen } from "./dev/statesRoute";

// Development only, and its own chunk: the app's bundle does not carry it.
const LazyStatesPage = lazy(() =>
  import("./dev/StatesPage").then((module) => ({ default: module.StatesPage })),
);

export function DesktopRoot() {
  const [loaded, setLoaded] = useState(false);
  // What the registry read said, and the error as it arrived for the details.
  const [loadError, setLoadError] = useState<{ message: string; cause: string | null } | null>(null);
  const [loadDetailsOpen, setLoadDetailsOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const isManagerWindow = bridge().windowRole === "manager";
  const statesPageOpen = useStatesPageOpen(bridge().devTools);
  const [userSettings, setUserSettings] = useState<DesktopUserSettingsSnapshot | null>(
    null,
  );
  const [shareHandoffStatus, setShareHandoffStatus] =
    useState<ShareHandoffStatusSnapshot>({ status: "idle" });
  const registryRequest = useRef(0);
  const committedRegistryRequest = useRef(0);
  const userSettingsRequests = useRequestSequence();
  const shareHandoffRevision = useRef(0);
  const sentNotices = useSentNotices(!isManagerWindow);
  // A file to open once the workspace a notice's Open switched to is ready.
  const [openOnSwitch, setOpenOnSwitch] = useState<{
    workspaceId: string;
    path: string;
  } | null>(null);

  const refreshWorkspaceRegistry = useCallback(async (): Promise<Workspace[]> => {
    const request = ++registryRequest.current;
    const registry = WorkspaceRegistryResult.parse(
      await bridge().getWorkspaceRegistry(),
    );
    if (request < committedRegistryRequest.current) return registry.workspaces;
    // Whichever response commits first is startup: it may pick the opening
    // workspace, since the mount read below loses if this one wins.
    const startup = committedRegistryRequest.current === 0;
    committedRegistryRequest.current = request;
    setWorkspaces(registry.workspaces);
    // An open workspace that left the registry (forgotten, or its binding
    // retired) must not keep the shell alive with nothing to open: drop to
    // first run, or to whichever workspace remains. Once first run is
    // visible, a newly registered workspace is only listed; a join or share
    // still populating it activates it when it finishes.
    setWorkspace((current) => {
      if (startup) return current ?? registry.workspaces[0] ?? null;
      if (!current || registry.workspaces.length === 0) return null;
      return (
        registry.workspaces.find((candidate) => candidate.workspaceId === current.workspaceId) ??
        registry.workspaces[0] ??
        null
      );
    });
    setLoadError(null);
    setLoaded(true);
    return registry.workspaces;
  }, []);

  // The look applies to the document directly. The shell keeps the copy it
  // has when nothing else changed, so a save that only restyles the window,
  // such as the accent or the editor font, does not render it again. Its
  // look settings may then be older; saves send only what they change.
  const acceptUserSettings = useCallback((result: DesktopUserSettingsSnapshot) => {
    applyLookSettings(result.settings);
    setUserSettings((current) =>
      current !== null && differsOnlyInLook(current, result) ? current : result);
  }, []);

  const refreshUserSettings = useCallback(async () => {
    const request = userSettingsRequests.next();
    const result = DesktopUserSettingsResult.parse(await bridge().getUserSettings());
    if (userSettingsRequests.isCurrent(request)) acceptUserSettings(result);
    return result;
  }, [acceptUserSettings]);

  const dismissShareHandoff = useCallback(() => {
    if (shareHandoffStatus.status === "idle") return;
    const { statusId } = shareHandoffStatus;
    shareHandoffRevision.current += 1;
    setShareHandoffStatus((current) =>
      current.status !== "idle" && current.statusId === statusId
        ? { status: "idle" }
        : current,
    );
    void bridge().dismissShareHandoff({ statusId }).catch(() => undefined);
  }, [shareHandoffStatus]);

  useEffect(() => {
    let active = true;
    const api = bridge();
    const unsubscribe = api.onShareHandoffStatus((rawStatus) => {
      const status = ShareHandoffStatus.safeParse(rawStatus);
      if (!active || !status.success) return;
      shareHandoffRevision.current += 1;
      setShareHandoffStatus(status.data);
    });
    const snapshotRevision = shareHandoffRevision.current;
    void api
      .getShareHandoffStatus()
      .then((rawStatus) => {
        const status = ShareHandoffStatus.safeParse(rawStatus);
        if (
          !active ||
          !status.success ||
          shareHandoffRevision.current !== snapshotRevision
        ) {
          return;
        }
        setShareHandoffStatus(status.data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      shareHandoffRevision.current += 1;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const request = ++registryRequest.current;
    void bridge()
      .getWorkspaceRegistry()
      .then((rawRegistry) => {
        const registry = WorkspaceRegistryResult.parse(rawRegistry);
        if (request < committedRegistryRequest.current) return;
        committedRegistryRequest.current = request;
        setWorkspaces((known) => {
          const next = [...registry.workspaces];
          for (const workspace of known) {
            if (!next.some((entry) => entry.workspaceId === workspace.workspaceId)) {
              next.push(workspace);
            }
          }
          return next;
        });
        setWorkspace((current) => current ?? registry.workspaces[0] ?? null);
        setLoaded(true);
      })
      // The registry deliberately refuses corrupt/newer-version files instead
      // of clobbering them — that refusal must reach the user as a message,
      // never a permanently blank window.
      .catch((cause) => {
        if (request < committedRegistryRequest.current) return;
        const { words, cause: arrived } = readError(cause);
        setLoadError({
          message: words ?? "dohc could not read the file that lists your workspaces.",
          cause: arrived,
        });
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    const unsubscribe = bridge().onUserSettingsChanged((result) => {
      userSettingsRequests.next();
      acceptUserSettings(result);
      // The broadcast is the writer's authoritative result. Re-read as a
      // backstop for an external edit that landed beside that write.
      void refreshUserSettings().catch(() => undefined);
    });
    void refreshUserSettings().catch(() => undefined);
    return () => {
      userSettingsRequests.next();
      unsubscribe();
    };
  }, [acceptUserSettings, refreshUserSettings]);

  useEffect(
    () =>
      bridge().onWorkspaceActivity((event) => {
        if (event.workspaceId !== undefined) return;
        void refreshWorkspaceRegistry().catch(() => undefined);
      }),
    [refreshWorkspaceRegistry],
  );

  useEffect(() => {
    return bridge().onWorkspaceActivated((next) => {
      setWorkspaces((known) =>
        known.some((entry) => entry.workspaceId === next.workspaceId)
          ? known
          : [...known, next],
      );
      setOpenOnSwitch(null);
      setWorkspace(next);
    });
  }, []);

  // Signal first paint when real content is about to mount (not while the
  // registry IPC is still pending and the root renders null).
  useEffect(() => {
    if (loaded) {
      requestAnimationFrame(() => window.dohcDesktopInternal?.firstPaint());
    }
  }, [loaded]);

  if (statesPageOpen) {
    return (
      <Suspense fallback={null}>
        <LazyStatesPage />
      </Suspense>
    );
  }
  if (!loaded) return null;
  if (loadError) {
    const loadDetailsText = errorDetails([
      ["Error", "dohc couldn't read its workspace registry"],
      ["Detail", loadError.message],
      ["Cause", loadError.cause],
      ["Platform", bridge().platform],
    ]);
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-bg px-8 text-center">
        <span className="text-sm font-semibold text-ink">
          dohc couldn't read its workspace registry
        </span>
        <span className="max-w-lg text-xs leading-relaxed text-muted">
          {loadError.message}
        </span>
        <span className="max-w-lg text-xs text-subtle">
          Your files are untouched. Fix or move the registry file named in the
          technical details, then relaunch dohc.
        </span>
        <button
          type="button"
          aria-expanded={loadDetailsOpen}
          onClick={() => setLoadDetailsOpen((open) => !open)}
          className="mt-1 flex items-center gap-1 rounded text-[12px] text-subtle transition-colors hover:text-ink"
        >
          <ChevronRight
            size={12}
            strokeWidth={1.9}
            aria-hidden
            className={`transition-transform duration-100 ${loadDetailsOpen ? "rotate-90" : ""}`}
          />
          {loadDetailsOpen ? "Hide technical details" : "Show technical details"}
        </button>
        {loadDetailsOpen ? (
          <section
            aria-label="Technical details"
            className="w-full max-w-md rounded-lg border border-line bg-panel text-left"
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="dohc-section-label">Technical details</span>
              <CopyDetailsButton label="Copy" iconOnly details={() => loadDetailsText} />
            </div>
            <pre className="m-0 select-text cursor-text whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-snug text-ink">
              {loadDetailsText}
            </pre>
          </section>
        ) : null}
      </div>
    );
  }
  if (isManagerWindow) {
    // The manager window: pick a workspace and it opens in its own window,
    // then this one closes. Nothing else ever renders here.
    return (
      <WorkspaceManager
        workspaces={workspaces}
        current={null}
        handoffStatus={shareHandoffStatus}
        onDismissShareHandoff={dismissShareHandoff}
        onShareHandoffOpened={dismissShareHandoff}
        onForgot={refreshWorkspaceRegistry}
        onOpenWorkspace={(next) =>
          bridge()
            .openWorkspaceWindow({ workspaceId: next.workspaceId })
            .then(() => bridge().closeThisWindow())
        }
      />
    );
  }
  if (!workspace) {
    return (
      <>
        <WorkspaceManager
          workspaces={workspaces}
          current={null}
          handoffStatus={shareHandoffStatus}
          onDismissShareHandoff={dismissShareHandoff}
          onShareHandoffOpened={dismissShareHandoff}
          onForgot={refreshWorkspaceRegistry}
          onOpenWorkspace={(next) => {
            setWorkspaces((known) =>
              known.some((entry) => entry.workspaceId === next.workspaceId)
                ? known
                : [...known, next],
            );
            setWorkspace(next);
          }}
        />
        <DevPanel />
      </>
    );
  }
  return (
    <>
    <DesktopWorkspaceShell
      // Remount on switch: file list and selection are workspace-local and
      // must never leak from workspace A into workspace B.
      key={workspace.workspaceId}
      workspace={workspace}
      workspaces={workspaces}
      userSettings={userSettings}
      handoffStatus={shareHandoffStatus}
      onDismissShareHandoff={dismissShareHandoff}
      onShareHandoffOpened={dismissShareHandoff}
      refreshWorkspaceRegistry={refreshWorkspaceRegistry}
      onManageWorkspaces={() => bridge().openWorkspaceManager()}
      sentNotices={sentNotices}
      {...(openOnSwitch?.workspaceId === workspace.workspaceId
        ? { openPathOnReady: openOnSwitch.path }
        : {})}
      onSwitchWorkspace={(next, openPath) => {
        // File ▸ Open Workspace… can hand us a workspace the registry list
        // didn't know yet — keep the switcher list complete.
        setWorkspaces((known) =>
          known.some((entry) => entry.workspaceId === next.workspaceId)
            ? known
            : [...known, next],
        );
        setOpenOnSwitch(openPath ? { workspaceId: next.workspaceId, path: openPath } : null);
        setWorkspace(next);
      }}
    />
    <DevPanel workspaceId={workspace.workspaceId} />
    </>
  );
}
