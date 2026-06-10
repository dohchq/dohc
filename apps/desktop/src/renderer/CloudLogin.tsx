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
export function CloudLogin() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge()
      .cloudStatus()
      .then((status) => {
        if (cancelled) return;
        setPhase(
          status.connected
            ? { kind: "connected", email: status.email ?? "" }
            : { kind: "disconnected" },
        );
      })
      .catch(() => !cancelled && setPhase({ kind: "disconnected" }));
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  function pollUntilDone() {
    pollTimer.current = setTimeout(() => {
      void bridge()
        .cloudLoginPoll()
        .then((result) => {
          if (result.status === "pending") return pollUntilDone();
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
        .catch(() => setPhase({ kind: "failed", reason: "Couldn't reach the server." }));
    }, 3000);
  }

  async function connect() {
    setPhase({ kind: "loading" });
    try {
      const started = await bridge().cloudLoginStart({});
      setPhase({ kind: "code", ...started });
      pollUntilDone();
    } catch {
      setPhase({
        kind: "failed",
        reason: "Couldn't reach the server. Is dohc Cloud (or your self-host) running?",
      });
    }
  }

  async function disconnect() {
    await bridge().cloudLogout();
    setPhase({ kind: "disconnected" });
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
