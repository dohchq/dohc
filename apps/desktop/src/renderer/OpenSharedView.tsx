import { ArrowLeft, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";

// "Open a share" (PR 18): the receive side of an external share grant.
// Paste the code someone sent you, pick an empty folder, and a READ-ONLY
// shared view arrives: browsable, searchable, refreshable — never editable.
// Mirrors JoinSyncedWorkspace's session gate and unmount guard.

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
}) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [code, setCode] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
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

  async function open() {
    if (!folder || opening || code.trim().length === 0) return;
    setOpening(true);
    setError(null);
    try {
      const result = await bridge().openSharedView({
        shareCode: code.trim(),
        rootPath: folder,
      });
      if (cancelledRef.current) return;
      props.onWorkspaceReady(result.workspace);
    } catch (cause) {
      if (cancelledRef.current) return;
      setError(shareErrorMessage(cause));
    } finally {
      if (!cancelledRef.current) setOpening(false);
    }
  }

  const canOpen =
    gate.kind === "signed-in" && !opening && code.trim().length > 0 && folder !== null;

  return (
    <div
      data-testid="open-shared-view"
      className="flex w-105 flex-col gap-3 rounded-lg border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          disabled={opening}
          onClick={props.onBack}
          className="grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink disabled:opacity-50"
        >
          <ArrowLeft size={13} aria-hidden />
        </button>
        <h2 className="m-0 text-sm font-semibold">Open a share</h2>
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
          <CloudLogin onConnected={checkSession} />
        </>
      ) : null}

      {gate.kind === "signed-in" ? (
        <>
          <p className="m-0 text-xs leading-relaxed text-muted">
            Paste the share code you received. You'll get a read-only view of what
            was shared — it updates when you refresh, and only the person who shared
            it can change the files.
          </p>
          <label className="block text-[11px] font-medium text-subtle">
            Share code
            <input
              data-testid="open-share-code"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder="dohc-share:…"
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
                data-testid="open-share-choose-folder"
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
            data-testid="open-share-start"
            disabled={!canOpen}
            onClick={() => void open()}
            className="rounded bg-accent px-3 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            {opening ? "Opening the share…" : "Open share"}
          </button>
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
