import { Cloud, ExternalLink, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";

type Phase =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "code"; userCode: string; verificationUri: string }
  | { kind: "connected"; email: string }
  | { kind: "failed"; reason: string };

// Device-flow login panel inside the cloud overlay: show a short code, send
// the user to the browser to approve it, poll until the session lands. The
// token never reaches this process — main stores it encrypted; we only ever
// render status + email. Local-only use never opens this panel.
export function CloudLogin(props: {
  workspaceId?: string;
  onManageWorkspace?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [workspaceSynced, setWorkspaceSynced] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(0);

  function clearPollTimer() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  useEffect(() => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    clearPollTimer();
    setPhase({ kind: "loading" });
    setWorkspaceSynced(false);
    setSyncBusy(false);
    setSyncError(null);
    void bridge()
      .cloudStatus(props.workspaceId ? { workspaceId: props.workspaceId } : {})
      .then((status) => {
        if (session !== sessionRef.current) return;
        setWorkspaceSynced(status.workspaceSynced ?? false);
        if (status.serverUrl) setServerUrl(status.serverUrl);
        if (status.relayUrl) setRelayUrl(status.relayUrl);
        setPhase(
          status.connected
            ? { kind: "connected", email: status.email ?? "" }
            : { kind: "disconnected" },
        );
      })
      .catch(() => {
        if (session === sessionRef.current) setPhase({ kind: "disconnected" });
      });
    return () => {
      if (sessionRef.current === session) sessionRef.current += 1;
      clearPollTimer();
    };
  }, [props.workspaceId]);

  async function enableSync() {
    if (!props.workspaceId || syncBusy) return;
    const session = sessionRef.current;
    setSyncBusy(true);
    setSyncError(null);
    try {
      await bridge().cloudEnableSync({ workspaceId: props.workspaceId });
      if (session === sessionRef.current) setWorkspaceSynced(true);
    } catch (cause) {
      if (session !== sessionRef.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setSyncError(/already claimed/i.test(message) ? message : "Couldn't enable sync.");
    } finally {
      if (session === sessionRef.current) setSyncBusy(false);
    }
  }

  function pollUntilDone(session: number) {
    pollTimer.current = setTimeout(() => {
      void bridge()
        .cloudLoginPoll()
        .then((result) => {
          if (session !== sessionRef.current) return;
          if (result.status === "pending") return pollUntilDone(session);
          if (result.status === "complete") {
            setPhase({ kind: "connected", email: result.email ?? "" });
          } else {
            setPhase({
              kind: "failed",
              reason:
                result.status === "denied"
                  ? "The request was denied in the browser."
                  : "The code expired — start again.",
            });
          }
        })
        .catch(() => {
          if (session === sessionRef.current) {
            setPhase({ kind: "failed", reason: "Couldn't reach the server." });
          }
        });
    }, 3000);
  }

  async function connect() {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    clearPollTimer();
    setPhase({ kind: "loading" });
    try {
      const started = await bridge().cloudLoginStart({
        ...(serverUrl.trim() ? { serverUrl: serverUrl.trim() } : {}),
        ...(relayUrl.trim() ? { relayUrl: relayUrl.trim() } : {}),
      });
      if (session !== sessionRef.current) return;
      setPhase({ kind: "code", ...started });
      pollUntilDone(session);
    } catch {
      if (session === sessionRef.current) {
        setPhase({
          kind: "failed",
          reason: "Couldn't reach the server. Is dohc Cloud (or your self-host) running?",
        });
      }
    }
  }

  async function disconnect() {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    clearPollTimer();
    try {
      await bridge().cloudLogout();
      if (session === sessionRef.current) setPhase({ kind: "disconnected" });
    } catch {
      if (session === sessionRef.current) {
        setPhase({ kind: "failed", reason: "Couldn't disconnect from dohc Cloud." });
      }
    }
  }

  return (
    <div
      data-testid="cloud-sync-panel"
      className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-4 shadow-lg"
    >
      <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold">
        <Cloud size={14} aria-hidden />
        dohc Cloud
      </h2>

      {phase.kind === "loading" ? (
        <p className="mb-0 mt-2 text-xs text-subtle">Checking connection…</p>
      ) : null}

      {phase.kind === "disconnected" || phase.kind === "failed" ? (
        <>
          <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
            Sync this workspace for sharing, backup, and team collaboration.
            Everything keeps working locally — cloud is additive, never required.
          </p>
          {phase.kind === "failed" ? (
            <p data-testid="cloud-login-error" className="mb-0 mt-2 text-xs text-danger">
              {phase.reason}
            </p>
          ) : null}
          <label className="mt-3 block text-[11px] font-medium text-subtle">
            Cloud server URL
            <input
              data-testid="cloud-server-url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.currentTarget.value)}
              placeholder="http://localhost:1786"
              className="mt-1 w-full rounded border border-line bg-panel-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="mt-2 block text-[11px] font-medium text-subtle">
            Sync relay URL
            <input
              data-testid="cloud-relay-url"
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.currentTarget.value)}
              placeholder="http://localhost:1788"
              className="mt-1 w-full rounded border border-line bg-panel-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            data-testid="cloud-connect-start"
            onClick={() => void connect()}
            className="mt-3 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
          >
            Connect
          </button>
        </>
      ) : null}

      {phase.kind === "code" ? (
        <div data-testid="cloud-login-pending">
          <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
            Approve this device in your browser with the code:
          </p>
          <p
            data-testid="cloud-user-code"
            className="my-3 text-center font-mono text-2xl font-semibold tracking-[0.3em] text-ink"
          >
            {phase.userCode}
          </p>
          <button
            type="button"
            data-testid="cloud-open-browser"
            onClick={() => void bridge().openExternalUrl({ url: phase.verificationUri })}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90"
          >
            <ExternalLink size={12} aria-hidden />
            Open browser
          </button>
          <p className="mb-0 mt-2 text-[11px] text-subtle">
            Waiting for approval — this updates by itself.
          </p>
        </div>
      ) : null}

      {phase.kind === "connected" ? (
        <div data-testid="cloud-connected">
          <p className="mb-0 mt-2 text-xs text-muted">
            Connected as{" "}
            <span data-testid="cloud-connected-email" className="text-ink">
              {phase.email}
            </span>
            .
          </p>
          {props.workspaceId ? (
            workspaceSynced ? (
              <>
                <p data-testid="cloud-workspace-synced" className="mb-0 mt-2 text-xs text-success">
                  This workspace syncs to the cloud — edits flow automatically.
                </p>
                {props.onManageWorkspace ? (
                  <button
                    type="button"
                    data-testid="cloud-manage-workspace"
                    onClick={props.onManageWorkspace}
                    className="mt-3 rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    Manage workspace
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="cloud-enable-sync"
                  disabled={syncBusy}
                  onClick={() => void enableSync()}
                  className="mt-3 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50"
                >
                  {syncBusy ? "Enabling sync…" : "Sync this workspace"}
                </button>
                {syncError ? (
                  <p data-testid="cloud-sync-error" className="mb-0 mt-2 text-xs text-danger">
                    {syncError}
                  </p>
                ) : null}
              </>
            )
          ) : null}
          <button
            type="button"
            data-testid="cloud-disconnect"
            onClick={() => void disconnect()}
            className="mt-3 flex items-center gap-1.5 rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
          >
            <LogOut size={12} aria-hidden />
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
