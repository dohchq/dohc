import { useMouseBackButton } from "./useMouseBackButton";
import { useRequestSequence } from "./useRequestSequence";
import { ipcErrorMessage } from "./ipcError";
import { ArrowLeft, Check, FolderInput, FolderOpen, AppWindow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { RelayShareReceivedRow, ShareAccess } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { parseShareCode } from "../workspaces/syncCode";
import type { ConnectionNoticeHost } from "./shell/connectionNotices";
import { IconButton, PrimaryButton, SectionLabel } from "./ui/controls";
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

// Edit on the live version is the grant a separate view can edit. A folder
// added to a workspace is read-only at every level.
export function opensForLiveEditing(share: RelayShareReceivedRow): boolean {
  return (
    share.access === "edit" &&
    share.selector !== null &&
    (share.selector.versionId === null || share.selector.versionId === "main")
  );
}

function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

// One half of the segmented "how to open it" control: icon and label, the
// checked half raised on the panel colour.
function ModeOption(props: {
  checked: boolean;
  testId: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      data-testid={props.testId}
      onClick={props.onClick}
      className={`flex h-9 items-center justify-center gap-2 rounded-md text-[12.5px] font-medium transition-colors ${
        props.checked
          ? "border border-line bg-panel text-ink shadow-[0_1px_2px_rgba(28,27,24,0.06)]"
          : "border border-transparent text-muted hover:text-ink"
      }`}
    >
      {props.icon}
      {props.label}
    </button>
  );
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
    // The pinned access, null when the pin could not be read.
    onMounted: (label: string, access: ShareAccess | null) => void;
  };
} & ConnectionNoticeHost) {
  const [gate, setGate] = useState<Gate>(
    props.resolvedShare
      ? { kind: "signed-in", email: "" }
      : { kind: "checking" },
  );
  const [code, setCode] = useState("");
  // The folder the person chose, or the default dohc suggested for this
  // share. `chosen` wins; `suggested` counts only for the share it answers.
  const [chosen, setChosen] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<{ shareId: string; root: string } | null>(null);
  // The mode the person chose. Until they choose, the grant decides.
  const [pickedMode, setPickedMode] = useState<"mount" | "separate" | null>(null);
  // Whether each pasted share opens for live editing, asked once per share
  // id while this dialog is open. A failed lookup counts as no.
  const [pastedLiveEditing, setPastedLiveEditing] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const accessLookups = useRef(new Map<string, Promise<boolean>>());
  const [signingIn, setSigningIn] = useState(false);
  const signInPanel = useRef<HTMLDivElement>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useMouseBackButton(props.onBack);
  const sessionRef = useRequestSequence();
  const folderRequestRef = useRequestSequence();
  const suggestRequestRef = useRequestSequence();
  const actionRequests = useRequestSequence();
  const accessRequests = useRequestSequence();

  useEffect(() => {
    if (signingIn) signInPanel.current?.focus();
  }, [signingIn]);

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

  const shareCode = props.resolvedShare?.shareCode ?? code.trim();
  const shareId = props.resolvedShare?.shareId ?? parseShareCode(shareCode)?.shareId ?? null;
  const liveEditing = props.resolvedShare
    ? !!props.liveEditing
    : shareId !== null && pastedLiveEditing.get(shareId) === true;
  // Edit defaults to Open separately, as the browser handoff does, because
  // a folder added to this workspace cannot be edited.
  const mode = pickedMode ?? (props.mountInto && !liveEditing ? "mount" : "separate");
  const mounting = mode === "mount" && !!props.mountInto;

  // Only a pasted code has an unknown grant, and only a signed-in session
  // can ask the relay about it. A mode the person picked needs no answer.
  const accessShareId =
    props.mountInto && !props.resolvedShare && pickedMode === null && gate.kind === "signed-in"
      ? shareId
      : null;
  const checkingAccess = accessShareId !== null && !pastedLiveEditing.has(accessShareId);
  useEffect(() => {
    const request = accessRequests.next();
    if (accessShareId === null) return;
    // One relay request per share id: a code pasted again reuses its answer.
    let lookup = accessLookups.current.get(accessShareId);
    if (lookup === undefined) {
      lookup = bridge()
        .getRelayReceivedShare({ shareId: accessShareId })
        .then((result) => result.found && opensForLiveEditing(result.share))
        .catch(() => false);
      accessLookups.current.set(accessShareId, lookup);
    }
    void lookup.then((live) => {
      if (!accessRequests.isCurrent(request)) return;
      setPastedLiveEditing((current) => new Map(current).set(accessShareId, live));
    });
  }, [accessShareId, accessRequests]);

  // Ask main for the default folder whenever the share id changes. Main
  // approves the path, so opening into it needs no dialog. Any change
  // retires the request in flight, so an old answer never lands.
  useEffect(() => {
    const request = suggestRequestRef.next();
    if (mounting || shareId === null) return;
    void bridge()
      .getDefaultShareRoot({ shareId })
      .then((root) => {
        if (suggestRequestRef.isCurrent(request)) setSuggested({ shareId, root });
      })
      .catch(() => {
        if (suggestRequestRef.isCurrent(request)) setSuggested(null);
      });
    // suggestRequestRef is a stable ref holder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounting, shareId]);

  const folder =
    chosen ?? (!mounting && suggested?.shareId === shareId ? suggested.root : null);

  async function chooseFolder() {
    const request = folderRequestRef.next();
    const picked = await bridge().pickWorkspaceRoot();
    if (picked && folderRequestRef.isCurrent(request)) setChosen(picked);
  }

  async function open() {
    // Enter reaches here without the button, so the lookup gates both.
    if (opening || checkingAccess || shareCode.length === 0) return;
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
        const pinned = result.workspace.shareMounts?.find(
          (mount) => mount.shareId === result.mount.shareId,
        );
        props.mountInto.onMounted(result.mount.label, pinned?.access ?? null);
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
    !checkingAccess &&
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
        <h2 className="m-0 text-[15px] font-semibold text-ink">Open a share</h2>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>Share code</SectionLabel>
        {props.resolvedShare ? (
          <div className="flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-bg px-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
              {props.resolvedShare.shareId}
            </code>
            <Check size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-success" />
          </div>
        ) : (
          <div
            className="flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-bg px-3 transition-colors focus-within:border-ink"
          >
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
              placeholder="dohc-share:…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoFocus
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-ink outline-none placeholder:text-subtle"
            />
            {shareId !== null ? (
              <Check
                size={13}
                strokeWidth={2.2}
                aria-label="Valid share code"
                className="shrink-0 text-success"
              />
            ) : null}
          </div>
        )}
      </div>

      {props.mountInto ? (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Open it</SectionLabel>
          <div
            className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-bg p-1"
            role="radiogroup"
            aria-label="How to open it"
          >
            <ModeOption
              checked={mode === "mount"}
              testId="open-share-mode-mount"
              icon={<FolderInput size={14} strokeWidth={1.9} aria-hidden />}
              label="Add to this workspace"
              onClick={() => setPickedMode("mount")}
            />
            <ModeOption
              checked={mode === "separate"}
              testId="open-share-mode-separate"
              icon={<AppWindow size={14} strokeWidth={1.9} aria-hidden />}
              label="Open separately"
              onClick={() => setPickedMode("separate")}
            />
          </div>
        </div>
      ) : null}

      {liveEditing && props.mountInto ? (
        <p className="m-0 text-xs leading-relaxed text-muted">
          Open separately to edit shared Markdown. Adding it to this workspace creates a read-only folder.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <SectionLabel>{mounting ? "Goes under" : "Folder"}</SectionLabel>
        {mounting ? (
          // Plain text, not a chip: there is nothing to change here.
          <p className="m-0 flex h-9 items-center gap-2 px-0.5 text-[13px]">
            <FolderOpen size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
            <code className="font-mono text-ink">shared-with-me{isWindows() ? "\\" : "/"}</code>
          </p>
        ) : (
          <FolderChip
            folder={folder ? displayPath(folder) : null}
            placeholder="Choose an empty folder"
            testId="open-share-choose-folder"
            onClick={() => void chooseFolder()}
          />
        )}
      </div>

      <PrimaryButton
        type="button"
        data-testid="open-share-start"
        disabled={!canOpen}
        onClick={() => void open()}
      >
        {/* The busy label is the disabled button's reason, as it is while
            opening, and it names no mode before the grant decides one. */}
        {checkingAccess
          ? "Checking the share…"
          : opening
          ? mounting
            ? "Adding the share…"
            : "Opening the share…"
          : mounting
            ? "Add share"
            : "Open share"}
      </PrimaryButton>

      {signingIn && gate.kind !== "signed-in" ? (
        <div
          ref={signInPanel}
          tabIndex={-1}
          aria-describedby="open-share-sign-in-description"
          className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3"
        >
          <p id="open-share-sign-in-description" className="sr-only">
            Shares are addressed to your account on the server. Connect that server to open this share.
          </p>
          <CloudLogin
            onConnected={checkSession}
            embedded
            untitled
            onConnectionError={props.onConnectionError}
            initialServerUrl={props.initialServerUrl}
          />
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
