import { useRequestSequence } from "./useRequestSequence";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DesktopUserSettingsResult,
  ShareHandoffStatus,
  WorkspaceRegistryResult,
  type DesktopUserSettingsResult as DesktopUserSettingsSnapshot,
  type ShareHandoffStatus as ShareHandoffStatusSnapshot,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { DesktopFirstRun } from "./DesktopFirstRun";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

export function DesktopRoot() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userSettings, setUserSettings] = useState<DesktopUserSettingsSnapshot | null>(
    null,
  );
  const [shareHandoffStatus, setShareHandoffStatus] =
    useState<ShareHandoffStatusSnapshot>({ status: "idle" });
  const registryRequest = useRef(0);
  const committedRegistryRequest = useRef(0);
  const userSettingsRequests = useRequestSequence();
  const shareHandoffRevision = useRef(0);

  const refreshWorkspaceRegistry = useCallback(async (): Promise<Workspace[]> => {
    const request = ++registryRequest.current;
    const registry = WorkspaceRegistryResult.parse(
      await bridge().getWorkspaceRegistry(),
    );
    if (request < committedRegistryRequest.current) return registry.workspaces;
    committedRegistryRequest.current = request;
    setWorkspaces(registry.workspaces);
    setWorkspace((current) =>
      current
        ? (registry.workspaces.find(
            (candidate) => candidate.workspaceId === current.workspaceId,
          ) ?? current)
        : (registry.workspaces[0] ?? null),
    );
    setLoadError(null);
    setLoaded(true);
    return registry.workspaces;
  }, []);

  const refreshUserSettings = useCallback(async () => {
    const request = userSettingsRequests.next();
    const result = DesktopUserSettingsResult.parse(await bridge().getUserSettings());
    if (userSettingsRequests.isCurrent(request)) setUserSettings(result);
    return result;
  }, []);

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
        setLoadError(cause instanceof Error ? cause.message : String(cause));
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    const unsubscribe = bridge().onUserSettingsChanged((rawResult) => {
      const result = DesktopUserSettingsResult.safeParse(rawResult);
      if (!result.success) return;
      userSettingsRequests.next();
      setUserSettings(result.data);
      // The broadcast is the writer's authoritative result. Re-read as a
      // backstop for an external edit that landed beside that write.
      void refreshUserSettings().catch(() => undefined);
    });
    void refreshUserSettings().catch(() => undefined);
    return () => {
      userSettingsRequests.next();
      unsubscribe();
    };
  }, [refreshUserSettings]);

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

  if (!loaded) return null;
  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-bg px-8 text-center">
        <span className="text-sm font-semibold text-ink">
          dohc couldn't read its workspace registry
        </span>
        <span className="max-w-lg text-xs leading-relaxed text-muted">
          {loadError}
        </span>
        <span className="max-w-lg text-xs text-subtle">
          Your files are untouched. Fix or move the registry file named above,
          then relaunch dohc.
        </span>
      </div>
    );
  }
  if (!workspace) {
    return (
      <DesktopFirstRun
        handoffStatus={shareHandoffStatus}
        onDismissShareHandoff={dismissShareHandoff}
        onShareHandoffOpened={dismissShareHandoff}
        onWorkspaceReady={(created) => {
          setWorkspaces([created]);
          setWorkspace(created);
        }}
      />
    );
  }
  return (
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
      onSwitchWorkspace={(next) => {
        // File ▸ Open Workspace… can hand us a workspace the registry list
        // didn't know yet — keep the switcher list complete.
        setWorkspaces((known) =>
          known.some((entry) => entry.workspaceId === next.workspaceId)
            ? known
            : [...known, next],
        );
        setWorkspace(next);
      }}
    />
  );
}
