import { useRequestSequence } from "./useRequestSequence";
import { ipcErrorMessage } from "./ipcError";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import { IconButton, PrimaryButton } from "./ui/controls";
import { FolderChip, Step } from "./ui/Step";

// "Open a share": the receive side of an external share grant. Three gates
// shown as three steps, like JoinSyncedWorkspace: sign in, enter the code
// someone sent you, choose where it goes. Inside a workspace the default is
// to add it under shared-with-me/; on first run there is no workspace yet,
// so it opens as a separate read-only view in an empty folder.

function isWindows(): boolean {
  return bridge().platform === "win32";
}

function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

type Gate =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string };

export function OpenSharedView(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
  onOpened?: () => void;
  liveEditing?: boolean;
  resolvedShare?: {
    shareId: string;
    shareCode: string;
  };
  // Present when opened from inside a workspace: enables the default
  // "Add to this workspace" mode (a shared-with-me/ mount). Absent on
  // first-run, where there is no workspace to mount into yet.
  mountInto?: {
    workspaceId: string;
    onMounted: (label: string) => void;
  };
}) {
  const [gate, setGate] = useState<Gate>(
    props.resolvedShare
      ? { kind: "signed-in", email: "" }
      : { kind: "checking" },
  );
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [mode, setMode] = useState<"mount" | "separate">(
    props.mountInto && !props.liveEditing ? "mount" : "separate",
  );
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRequestSequence();
  const folderRequestRef = useRequestSequence();
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
    if (!props.resolvedShare) checkSession();
    return () => {
      sessionRef.next();
      folderRequestRef.next();
    };
    // Session check runs once on mount; CloudLogin's onConnected re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chooseFolder() {
    const request = folderRequestRef.next();
    const picked = await bridge().pickWorkspaceRoot();
    if (
      picked &&
      folderRequestRef.isCurrent(request)
    ) {
      setFolder(picked);
    }
  }

  const mounting = mode === "mount" && !!props.mountInto;
  const shareCode = props.resolvedShare?.shareCode ?? code.trim();

  async function open() {
    if (opening || shareCode.length === 0) return;
    if (!mounting && !folder) return;
    const actionRequest = actionRequests.next();
    setOpening(true);
    setError(null);
    try {
      if (mounting && props.mountInto) {
        const result = await bridge().mountShare({
          workspaceId: props.mountInto.workspaceId,
          shareCode,
        });
        if (!actionRequests.isCurrent(actionRequest)) return;
        props.onOpened?.();
        props.mountInto.onMounted(result.mount.label);
      } else {
        const result = await bridge().openSharedView({
          shareCode,
          rootPath: folder!,
        });
        if (!actionRequests.isCurrent(actionRequest)) return;
        props.onOpened?.();
        props.onWorkspaceReady(result.workspace);
      }
    } catch (cause) {
      if (!actionRequests.isCurrent(actionRequest)) return;
      setError((ipcErrorMessage(cause).trim() || "Couldn't open the share."));
    } finally {
      if (actionRequests.isCurrent(actionRequest)) setOpening(false);
    }
  }

  const canOpen =
    gate.kind === "signed-in" &&
    !opening &&
    shareCode.length > 0 &&
    (mounting || folder !== null);

  const signedIn = gate.kind === "signed-in";
  const laterState = signedIn ? "current" : "pending";
  const codeStep = props.resolvedShare ? null : 2;
  const whereStep = props.resolvedShare ? 2 : 3;

  return (
    <div
      data-testid="open-shared-view"
      className="dohc-elevated flex w-105 flex-col gap-5 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back" onClick={props.onBack} className="shrink-0">
          <ArrowLeft size={13} aria-hidden />
        </IconButton>
        <h2 className="m-0 text-sm font-semibold text-ink">Open a share</h2>
      </div>

      {/* Not a <form>: the embedded sign-in panel owns one for its server
          fields, and nested forms collapse. */}
      <div className="flex flex-col">
        {props.resolvedShare ? null : (
          <Step
            number={1}
            title="Sign in to dohc Drive"
            state={signedIn ? "done" : "current"}
            summary={gate.kind === "signed-in" ? gate.email : undefined}
          >
            {gate.kind === "checking" ? (
              <p className="m-0 text-xs text-subtle">Checking your dohc Drive connection…</p>
            ) : (
              <>
                <p className="sr-only">
                  Shares are addressed to your dohc Drive account — sign in first, then enter the code you received.
                </p>
                <CloudLogin onConnected={checkSession} embedded untitled />
              </>
            )}
          </Step>
        )}

        {codeStep === null ? null : (
          <Step number={codeStep} title="Enter the share code you received" state={laterState}>
            <input
              data-testid="open-share-code"
              aria-label="Share code"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void open();
              }}
              placeholder="dohc-share:…"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
          </Step>
        )}

        <Step
          number={whereStep}
          title={props.mountInto ? "Choose where it goes" : "Choose an empty folder on this machine"}
          state={laterState}
          last
        >
          {props.mountInto ? (
            <div className="flex gap-1.5" role="radiogroup" aria-label="How to open it">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "mount"}
                data-testid="open-share-mode-mount"
                onClick={() => setMode("mount")}
                className={`flex-1 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  mode === "mount"
                    ? "border-ink bg-panel-2 text-ink"
                    : "border-line bg-bg text-muted hover:text-ink"
                }`}
              >
                Add to this workspace
                <span className="block text-[11px] text-subtle">Under shared-with-me/</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "separate"}
                data-testid="open-share-mode-separate"
                onClick={() => setMode("separate")}
                className={`flex-1 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                  mode === "separate"
                    ? "border-ink bg-panel-2 text-ink"
                    : "border-line bg-bg text-muted hover:text-ink"
                }`}
              >
                Open separately
                <span className="block text-[11px] text-subtle">In its own folder</span>
              </button>
            </div>
          ) : null}
          {props.liveEditing && props.mountInto ? (
            <p className="m-0 text-xs leading-relaxed text-muted">
              Open separately to edit shared Markdown. Adding it to this workspace creates a read-only folder.
            </p>
          ) : null}
          {mounting ? null : (
            <FolderChip
              folder={folder ? displayPath(folder) : null}
              placeholder="Choose an empty folder"
              testId="open-share-choose-folder"
              onClick={() => void chooseFolder()}
            />
          )}

          <PrimaryButton
            type="button"
            data-testid="open-share-start"
            disabled={!canOpen}
            onClick={() => void open()}
            className="mt-2"
          >
            {opening
              ? mounting
                ? "Adding the share…"
                : "Opening the share…"
              : mounting
                ? "Add share"
                : "Open share"}
          </PrimaryButton>
          {opening ? (
            <p className="m-0 text-xs text-subtle">
              {mounting
                ? "If you go back, dohc keeps adding the share to shared-with-me/."
                : "If you go back, dohc keeps opening the share into the folder you chose."}
            </p>
          ) : null}
          {error ? (
            <p data-testid="open-share-error" role="alert" className="m-0 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </Step>
      </div>
    </div>
  );
}
