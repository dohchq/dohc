import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { DesktopFirstRun } from "./DesktopFirstRun";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

export function DesktopRoot() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    void bridge()
      .getWorkspaceRegistry()
      .then((registry) => {
        setWorkspaces(registry.workspaces);
        setWorkspace(registry.workspaces[0] ?? null);
        setLoaded(true);
      })
      // The registry deliberately refuses corrupt/newer-version files instead
      // of clobbering them — that refusal must reach the user as a message,
      // never a permanently blank window.
      .catch((cause) => {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
        setLoaded(true);
      });
  }, []);

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
