import { Cloud, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";

// First launch is a working tool, not a marketing page: pick where your
// files live, create the folder, start working. No account exists here.
export function DesktopFirstRun(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState(false);

  useEffect(() => {
    void bridge().getDefaultWorkspaceRoot().then(setRoot);
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setRoot(picked);
  }

  async function createWorkspace() {
    if (!root || creating) return;
    setCreating(true);
    try {
      const workspace = await bridge().createLocalWorkspace({
        rootPath: `${root}/personal`,
        kind: "personal",
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  return (
    <div className="app-chrome flex h-screen flex-col items-center justify-center gap-6 bg-bg text-ink">
      <div className="flex flex-col items-center gap-1">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">dohc</h1>
        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
      </div>

      <div className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-subtle">
            Workspace location
          </span>
          <div className="flex items-start justify-between gap-2">
            {/* The whole point of this screen is where files live: never
                truncate the path. */}
            <code className="break-all font-mono text-[13px] leading-snug text-ink">
              {root ?? "…"}
            </code>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              <FolderOpen size={13} aria-hidden />
              Choose a different folder
            </button>
          </div>
        </div>

        <button
          type="button"
          disabled={!root || creating}
          onClick={() => void createWorkspace()}
          className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create workspace"}
        </button>

        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}

        <div className="flex items-center justify-between gap-4">
          <p className="m-0 text-xs text-subtle">
            Works offline, no account needed. Cloud sync is optional.
          </p>
          <button
            type="button"
            onClick={() => setCloudNote((open) => !open)}
            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
          >
            <Cloud size={12} aria-hidden />
            Enable dohc Cloud sync
          </button>
        </div>
        {cloudNote ? (
          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
            teams. Your workspace stays fully functional locally, and you can
            connect it later without moving anything.
          </p>
        ) : null}
      </div>
    </div>
  );
}
