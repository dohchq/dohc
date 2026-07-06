import { ArrowLeft, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";

// "Join a synced workspace" (0P-C): the second-machine half of multi-machine
// sync. Paste the code copied from the machine that already has the
// workspace, pick an empty folder, and the workspace arrives — files,
// history, and chats. Joining needs a signed-in dohc Cloud session, so the
// panel gates on that first and embeds the normal sign-in when absent.

// Electron wraps handler rejections as "Error invoking remote method ...".
function joinErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return message.length > 0 ? message : "Couldn't join the workspace.";
}

type Gate =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string };

export function JoinSyncedWorkspace(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
}) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const joinedRef = useRef<Workspace | null>(null);
  const sessionRef = useRef(0);

  function checkSession() {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    void bridge()
      .cloudStatus({})
      .then((status) => {
        if (session !== sessionRef.current) return;
        setGate(
          status.connected
            ? { kind: "signed-in", email: status.email ?? "" }
            : { kind: "signed-out" },
        );
      })
      .catch(() => {
        if (session === sessionRef.current) setGate({ kind: "signed-out" });
      });
  }

  useEffect(() => {
    checkSession();
    return () => {
      sessionRef.current += 1;
    };
    // Session check runs once on mount; CloudLogin's onConnected re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setFolder(picked);
  }

  async function join() {
    if (!folder || joining || code.trim().length === 0) return;
    setJoining(true);
    setError(null);
    try {
      const result = await bridge().cloudJoinWorkspace({
        syncCode: code.trim(),
        rootPath: folder,
      });
      if (result.warning) {
        // The workspace was added but its first sync didn't finish. Say so
        // and let the user open it deliberately instead of vanishing the
        // message under the workspace shell.
        joinedRef.current = result.workspace;
        setWarning(result.warning);
        return;
      }
      props.onWorkspaceReady(result.workspace);
    } catch (cause) {
      setError(joinErrorMessage(cause));
    } finally {
      setJoining(false);
    }
  }

  const canJoin =
    gate.kind === "signed-in" && !joining && code.trim().length > 0 && folder !== null;

  return (
    <div
      data-testid="join-synced-workspace"
      className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={props.onBack}
          className="grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <ArrowLeft size={13} aria-hidden />
        </button>
        <h2 className="m-0 text-sm font-semibold">Join a synced workspace</h2>
      </div>

      {gate.kind === "checking" ? (
        <p className="m-0 text-xs text-subtle">Checking your dohc Cloud connection…</p>
      ) : null}

      {gate.kind === "signed-out" ? (
        <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            The workspace you're joining belongs to your dohc Cloud account —
            sign in first, then paste the code from your other machine.
          </p>
          <CloudLogin onConnected={checkSession} />
        </>
      ) : null}

      {gate.kind === "signed-in" && warning === null ? (
        <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            On the machine that already has the workspace, open dohc Cloud and
            copy the code under "Add this workspace on another machine".
          </p>
          <label className="block text-[11px] font-medium text-subtle">
            Workspace code
            <input
              data-testid="join-sync-code"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder="dohc-sync:…"
              spellCheck={false}
              className="mt-1 w-full rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-subtle">
              Where it should live on this machine
            </span>
            <div className="flex items-start justify-between gap-2">
              <code className="break-all font-mono text-[12px] leading-snug text-ink">
                {folder ?? "Choose an empty folder"}
              </code>
              <button
                type="button"
                data-testid="join-choose-folder"
                onClick={() => void chooseFolder()}
                className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
              >
                <FolderOpen size={13} aria-hidden />
                Choose folder
              </button>
            </div>
          </div>
          <button
            type="button"
            data-testid="join-workspace-start"
            disabled={!canJoin}
            onClick={() => void join()}
            className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            {joining ? "Bringing your workspace over…" : "Join workspace"}
          </button>
          {joining ? (
            <p className="m-0 text-xs text-subtle" role="status">
              Downloading files, history, and chats. This can take a moment for
              larger workspaces.
            </p>
          ) : null}
          {error ? (
            <p data-testid="join-error" role="alert" className="m-0 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </>
      ) : null}

      {warning !== null ? (
        <>
          <p data-testid="join-warning" className="m-0 text-xs leading-relaxed text-warning">
            {warning}
          </p>
          <button
            type="button"
            data-testid="join-open-anyway"
            onClick={() => {
              if (joinedRef.current) props.onWorkspaceReady(joinedRef.current);
            }}
            className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Open workspace
          </button>
        </>
      ) : null}
    </div>
  );
}
