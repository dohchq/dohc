import { useMouseBackButton } from "./useMouseBackButton";
import { useRequestSequence } from "./useRequestSequence";
import { ipcErrorMessage } from "./ipcError";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import type { ConnectionNoticeHost } from "./shell/connectionNotices";
import { IconButton, PrimaryButton } from "./ui/controls";
import { FolderChip, Step } from "./ui/Step";

// "Join a synced workspace": the second-machine half of multi-machine sync.
// Three real gates, shown as three steps so the whole cost is visible up
// front: sign in, enter the code from the machine that has the workspace,
// pick an empty folder. Joining needs a server session, so step one embeds
// the normal connect panel until one exists.

type Gate =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string };

function isWindows(): boolean {
  return bridge().platform === "win32";
}

function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

export function JoinSyncedWorkspace(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
} & ConnectionNoticeHost) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  useMouseBackButton(warning === null && !joining ? props.onBack : undefined);
  const joinedRef = useRef<Workspace | null>(null);
  const sessionRef = useRequestSequence();
  // Guards the async join against unmount: if the parent swaps this view
  // away while cloudJoinWorkspace is in flight, the resolved promise must not
  // navigate the app into the joined workspace the user just backed out of.
  const actionRequests = useRequestSequence();

  function checkSession() {
    const session = sessionRef.next();
    void bridge()
      .cloudStatus({})
      .then((status) => {
        if (!sessionRef.isCurrent(session)) return;
        setGate(
          status.connected
            ? { kind: "signed-in", email: status.email ?? "" }
            : { kind: "signed-out" },
        );
      })
      .catch(() => {
        if (sessionRef.isCurrent(session)) setGate({ kind: "signed-out" });
      });
  }

  useEffect(() => {
    checkSession();
    return () => {
      sessionRef.next();
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
    const actionRequest = actionRequests.next();
    setJoining(true);
    setError(null);
    try {
      const result = await bridge().cloudJoinWorkspace({
        syncCode: code.trim(),
        rootPath: folder,
        ...(needsPassphrase ? { passphrase } : {}),
      });
      if (!actionRequests.isCurrent(actionRequest)) return;
      if (result.warning) {
        // The workspace was added but its first sync didn't finish. Say so
        // and let the user open it deliberately.
        joinedRef.current = result.workspace;
        setWarning(result.warning);
        return;
      }
      props.onWorkspaceReady(result.workspace);
    } catch (cause) {
      if (!actionRequests.isCurrent(actionRequest)) return;
      const message = ipcErrorMessage(cause).trim() || "Couldn't join the workspace.";
      if (/passphrase required to unlock synced secrets/i.test(message)) {
        setNeedsPassphrase(true);
        setFolder(null);
        setError(
          `This workspace has protected files. Enter the protected-file passphrase. Files remain in ${folder}. Choose another empty folder to try again.`,
        );
      } else {
        setError(message);
      }
    } finally {
      if (actionRequests.isCurrent(actionRequest)) setJoining(false);
    }
  }

  const signedIn = gate.kind === "signed-in";
  const hasCode = code.trim().length > 0;
  const canJoin =
    signedIn &&
    !joining &&
    hasCode &&
    folder !== null &&
    (!needsPassphrase || passphrase.length > 0);

  // Both fields stay visible and editable after sign-in.
  const codeState = !signedIn ? "pending" : "current";
  const folderState = !signedIn ? "pending" : "current";

  return (
    <div
      data-testid="join-synced-workspace"
      className="dohc-elevated flex w-105 flex-col gap-5 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        {warning === null ? (
          // Gated while a join is in flight (the request cannot be
          // cancelled) and gone once the workspace exists (warning state):
          // the only honest affordance left then is "Open workspace".
          <IconButton
            aria-label="Back"
            disabled={joining}
            onClick={props.onBack}
            className="shrink-0"
          >
            <ArrowLeft size={13} aria-hidden />
          </IconButton>
        ) : null}
        <h2 className="m-0 text-sm font-semibold text-ink">Join a synced workspace</h2>
      </div>

      {warning !== null ? (
        <>
          <p data-testid="join-warning" className="m-0 text-xs leading-relaxed text-warning">
            {warning} The workspace was already added on this machine, so the
            only way forward is to open it.
          </p>
          <PrimaryButton
            data-testid="join-open-anyway"
            onClick={() => {
              if (joinedRef.current) props.onWorkspaceReady(joinedRef.current);
            }}
          >
            Open workspace
          </PrimaryButton>
        </>
      ) : (
        // Not a <form>: the embedded sign-in panel owns one, and nested forms
        // collapse so Connect would submit the join instead. Enter in either
        // join field submits through onKeyDown.
        <div className="flex flex-col">
          <Step
            number={1}
            title="Connect your server"
            state={gate.kind === "signed-in" ? "done" : "current"}
            summary={gate.kind === "signed-in" ? gate.email : undefined}
          >
            {gate.kind === "checking" ? (
              <p className="m-0 text-xs text-subtle">Checking your server connection…</p>
            ) : (
              <>
                <p className="sr-only">Connect your server first, then enter the code from your other machine.</p>
                <CloudLogin
                  onConnected={checkSession}
                  embedded
                  untitled
                  onConnectionError={props.onConnectionError}
                  initialServerUrl={props.initialServerUrl}
                />
              </>
            )}
          </Step>

          <Step number={2} title="Enter the code from your other machine" state={codeState}>
            <input
              data-testid="join-sync-code"
              aria-label="Workspace code"
              value={code}
              onChange={(event) => {
                setCode(event.currentTarget.value);
                setNeedsPassphrase(false);
                setPassphrase("");
                setError(null);
              }}
              placeholder="dohc-sync:…"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Enter") void join();
              }}
              className="h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
            {needsPassphrase ? (
              <label className="flex flex-col gap-1.5 text-[11px] font-medium text-subtle">
                Protected-file passphrase
                <input
                  data-testid="join-sync-passphrase"
                  value={passphrase}
                  type="password"
                  spellCheck={false}
                  onChange={(event) => setPassphrase(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void join();
                  }}
                  className="h-9 w-full rounded-md border border-line bg-bg px-3 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
                />
              </label>
            ) : null}
          </Step>

          <Step number={3} title="Choose an empty folder on this machine" state={folderState} last>
            <FolderChip
              folder={folder ? displayPath(folder) : null}
              placeholder="Choose an empty folder"
              testId="join-choose-folder"
              onClick={() => void chooseFolder()}
            />

            <PrimaryButton
              type="button"
              data-testid="join-workspace-start"
              onClick={() => void join()}
              disabled={!canJoin}
              className="mt-2"
            >
              {joining ? "Bringing your workspace over…" : "Join workspace"}
            </PrimaryButton>
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
          </Step>
        </div>
      )}
    </div>
  );
}
