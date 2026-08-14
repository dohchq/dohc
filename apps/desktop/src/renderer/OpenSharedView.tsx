import { ArrowLeft, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import { IconButton, PrimaryButton } from "./ui/controls";

// "Open a share" (PR 18 + share mounts): the receive side of an external
// share grant. Paste the code someone sent you and either ADD it to the
// current workspace (a read-only shared-with-me/<label>/ folder that
// live-follows the share — the default when opened from inside a workspace)
// or open it as a separate read-only view in an empty folder. Mirrors
// JoinSyncedWorkspace's session gate and unmount guard.

function shareErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return message.length > 0 ? message : "Couldn't open the share.";
}

type Gate =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; email: string };

export function OpenSharedView(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
  // Present when opened from inside a workspace: enables the default
  // "Add to this workspace" mode (a shared-with-me/ mount). Absent on
  // first-run, where there is no workspace to mount into yet.
  mountInto?: {
    workspaceId: string;
    onMounted: (label: string) => void;
  };
}) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [mode, setMode] = useState<"mount" | "separate">(
    props.mountInto ? "mount" : "separate",
  );
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(0);
  const cancelledRef = useRef(false);

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
    cancelledRef.current = false;
    checkSession();
    return () => {
      sessionRef.current += 1;
      cancelledRef.current = true;
    };
    // Session check runs once on mount; CloudLogin's onConnected re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setFolder(picked);
  }

  const mounting = mode === "mount" && !!props.mountInto;

  async function open() {
    if (opening || code.trim().length === 0) return;
    if (!mounting && !folder) return;
    setOpening(true);
    setError(null);
    try {
      if (mounting && props.mountInto) {
        const result = await bridge().mountShare({
          workspaceId: props.mountInto.workspaceId,
          shareCode: code.trim(),
        });
        if (cancelledRef.current) return;
        props.mountInto.onMounted(result.mount.label);
      } else {
        const result = await bridge().openSharedView({
          shareCode: code.trim(),
          rootPath: folder!,
        });
        if (cancelledRef.current) return;
        props.onWorkspaceReady(result.workspace);
      }
    } catch (cause) {
      if (cancelledRef.current) return;
      setError(shareErrorMessage(cause));
    } finally {
      if (!cancelledRef.current) setOpening(false);
    }
  }

  const canOpen =
    gate.kind === "signed-in" &&
    !opening &&
    code.trim().length > 0 &&
    (mounting || folder !== null);

  return (
    <div
      data-testid="open-shared-view"
      className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <IconButton
          aria-label="Back"
          disabled={opening}
          onClick={props.onBack}
          className="shrink-0"
        >
          <ArrowLeft size={13} aria-hidden />
        </IconButton>
        <h2 className="m-0 text-sm font-semibold text-ink">Open a share</h2>
      </div>

      {gate.kind === "checking" ? (
        <p className="m-0 text-xs text-subtle">Checking your dohc Cloud connection…</p>
      ) : null}

      {gate.kind === "signed-out" ? (
        <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            Shares are addressed to your dohc Cloud account — sign in first, then
            paste the code you received.
          </p>
          <CloudLogin onConnected={checkSession} embedded />
        </>
      ) : null}

      {gate.kind === "signed-in" ? (
        <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            {/* No level claim here: the share states its own level, and this
                screen has not read it yet. The banner says it after open. */}
            {mounting
              ? "Paste the share code you received. The shared files appear in this workspace under shared-with-me/."
              : "Paste the share code you received. You get a separate view of the shared files."}
          </p>
          <label className="block text-[11px] font-medium text-subtle">
            Share code
            <input
              data-testid="open-share-code"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder="dohc-share:…"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-subtle focus:border-ink"
            />
          </label>
          {props.mountInto ? (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-subtle">How to open it</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label="How to open it">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "mount"}
                  data-testid="open-share-mode-mount"
                  onClick={() => setMode("mount")}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    mode === "mount"
                      ? "border-ink bg-panel-2 text-ink"
                      : "border-line bg-panel text-muted hover:text-ink"
                  }`}
                >
                  Add to this workspace
                  <span className="block text-[10px] text-subtle">
                    Appears under shared-with-me/
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "separate"}
                  data-testid="open-share-mode-separate"
                  onClick={() => setMode("separate")}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    mode === "separate"
                      ? "border-ink bg-panel-2 text-ink"
                      : "border-line bg-panel text-muted hover:text-ink"
                  }`}
                >
                  Open separately
                  <span className="block text-[10px] text-subtle">
                    A separate view in its own folder
                  </span>
                </button>
              </div>
            </div>
          ) : null}
          {!mounting ? (
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
                data-testid="open-share-choose-folder"
                onClick={() => void chooseFolder()}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted transition-colors hover:text-ink"
              >
                <FolderOpen size={13} aria-hidden />
                Choose folder
              </button>
            </div>
          </div>
          ) : null}
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
          {error ? (
            <p data-testid="open-share-error" role="alert" className="m-0 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
