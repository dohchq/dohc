import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { DesktopFirstRun } from "./DesktopFirstRun";
import { DesktopWorkspaceShell, type Workspace } from "./DesktopWorkspaceShell";

export function DesktopRoot() {
  const [loaded, setLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    void bridge()
      .getWorkspaceRegistry()
      .then((registry) => {
        setWorkspaces(registry.workspaces);
        setWorkspace(registry.workspaces[0] ?? null);
        setLoaded(true);
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
      onSwitchWorkspace={setWorkspace}
    />
  );
}
