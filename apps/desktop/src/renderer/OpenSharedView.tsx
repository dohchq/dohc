import { useRequestSequence } from "./useRequestSequence";
import { ipcErrorMessage } from "./ipcError";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import { parseShareCode } from "../workspaces/syncCode";
import { IconButton, PrimaryButton } from "./ui/controls";
import { FolderChip } from "./ui/Step";

// "Open a share": the receive side of an external share grant. One card:
// the code someone sent, where it goes, and Open. Signing in is dohc's
// requirement, not the person's task, so it appears inline only when Open
// is pressed without a session. Opening as a separate view defaults to a
// folder next to the default workspace root, named after the share, so
// nobody has to pick a folder to see the files.

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
  // The folder the person chose, or the default dohc suggested for this
  // share. `chosen` wins; `suggested` follows the share id.
  const [chosen, setChosen] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [mode, setMode] = useState<"mount" | "separate">(
    props.mountInto && !props.liveEditing ? "mount" : "separate",
  );
  const [signingIn, setSigningIn] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRequestSequence();
  const folderRequestRef = useRequestSequence();
  const suggestRequestRef = useRequestSequence();
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
        if (status.connected) setSigningIn(false);
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
      suggestRequestRef.next();
    };
    // Session check runs once on mount; CloudLogin's onConnected re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mounting = mode === "mount" && !!props.mountInto;
  const shareCode = props.resolvedShare?.shareCode ?? code.trim();
  const shareId = props.resolvedShare?.shareId ?? parseShareCode(shareCode)?.shareId ?? null;

  // Ask main for the default folder whenever the share id changes. Main
  // approves the path, so opening into it needs no dialog.
  useEffect(() => {
    if (mounting || shareId === null) {
      setSuggested(null);
      return;
    }
    const request = suggestRequestRef.next();
    void bridge()
      .getDefaultShareRoot({ shareId })
      .then((root) => {
        if (suggestRequestRef.isCurrent(request)) setSuggested(root);
      })
      .catch(() => {
        if (suggestRequestRef.isCurrent(request)) setSuggested(null);
      });
    // suggestRequestRef is a stable ref holder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounting, shareId]);

  const folder = chosen ?? suggested;

  async function chooseFolder() {
    const request = folderRequestRef.next();
    const picked = await bridge().pickWorkspaceRoot();
    if (picked && folderRequestRef.isCurrent(request)) setChosen(picked);
  }

  async function open() {
    if (opening || shareCode.length === 0) return;
    if (!mounting && !folder) return;
    if (gate.kind !== "signed-in") {
      // Sign-in is a gate, not a step: open the panel inline and let the
      // person come back to Open once the session lands.
      setSigningIn(true);
      return;
    }
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
      setError(ipcErrorMessage(cause).trim() || "Couldn't open the share.");
    } finally {
      if (actionRequests.isCurrent(actionRequest)) setOpening(false);
    }
  }

  const canOpen =
    gate.kind !== "checking" &&
    !opening &&
    shareCode.length > 0 &&
    (mounting || folder !== null);

  return (
    <div
      data-testid="open-shared-view"
      className="dohc-elevated flex w-105 flex-col gap-4 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back" onClick={props.onBack} className="shrink-0">
          <ArrowLeft size={13} aria-hidden />
        </IconButton>
        <h2 className="m-0 text-sm font-semibold text-ink">Open a share</h2>
      </div>

      {props.resolvedShare ? null : (
        <input
          data-testid="open-share-code"
          aria-label="Share code"
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void open();
          }}
          placeholder="Share code, dohc-share:…"
          spellCheck={false}
          autoFocus
          className="h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
        />
      )}

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
      >
        {opening
          ? mounting
            ? "Adding the share…"
            : "Opening the share…"
          : mounting
            ? "Add share"
            : "Open share"}
      </PrimaryButton>

      {signingIn && gate.kind !== "signed-in" ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3">
          <p className="sr-only">
            Shares are addressed to your dohc Drive account — sign in first, then enter the code you received.
          </p>
          <CloudLogin onConnected={checkSession} embedded untitled />
        </div>
      ) : null}
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
    </div>
  );
}
