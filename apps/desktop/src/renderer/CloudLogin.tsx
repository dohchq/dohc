import { useRequestSequence } from "./useRequestSequence";
import { Cloud, ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CloudStatusResult } from "../ipc/bridgeContract";
import { canonicalCloudOrigin } from "../workspaces/cloudConfiguration";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { openLinkExternally } from "./linkActivation";
import { CloudAccountRow } from "./settings/CloudAccountRow";
import {
  ConnectionNotices,
  useConnectionNotices,
  type ConnectionNoticeHost,
} from "./shell/connectionNotices";
import { IconButton, Pill, PrimaryButton } from "./ui/controls";

const SETUP_GUIDE_URL =
  "https://github.com/dohchq/dohc/blob/main/docs/how-to/self-host.md";

type Phase =
  | { kind: "loading" }
  // Main could not say whether this machine has a session. Say that rather
  // than guessing "disconnected"; the notice carries the failure and Try again.
  | { kind: "unknown" }
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "code"; userCode: string; verificationUri: string }
  | { kind: "connected"; email: string }
  // The browser answered and refused the code. That is an outcome of the flow
  // the user just watched, not an error to route elsewhere, so it stays here
  // next to the form that restarts it.
  | { kind: "refused"; reason: string };

function checkServerAddress(
  value: string,
): { origin: string } | { problem: string } {
  const typed = value.trim();
  if (!typed) return { problem: "Enter the address of your server." };
  const origin = canonicalCloudOrigin(typed, bridge().insecureLoopbackServersForTests);
  if (origin) return { origin };
  try {
    if (new URL(typed).protocol === "http:") {
      return { problem: "dohc connects to servers only over https. Enter an https address." };
    }
  } catch {
    // Not a URL at all — the example address is the useful correction.
  }
  return { problem: "Enter the server address like https://dohc.example.com." };
}

// Connecting a server: one server address, then the device-authorization
// flow. Show a short code, send the user to the browser to approve it, poll
// until the session lands. The token never reaches this process — main stores
// it encrypted; we only ever render status, server, and email. Main discovers
// the sync relay from the server, so there is no relay field here. Local work
// needs none of this: this panel only ever adds sync and sharing on top.
// Syncing a workspace is a setting, on Settings' Sync and sharing page. Hosts
// outside a workspace have no such page, so a session found here shows its
// account row, the same one that page shows.
export function CloudLogin(props: {
  // Fired when a device-flow login completes inside this panel (the join
  // surface re-checks its own gate on it; the shell moves on to Settings).
  onConnected?: () => void;
  // Also fire onConnected when the first check finds a session already here.
  // The shell's dialog uses it to hand an existing session to Settings, where
  // its account row and sync switch live.
  handOffSession?: boolean;
  // Nested inside another elevated card (join/open-shared/handoff signed-out
  // gates): drop this panel's own frame so cards never stack elevation, and
  // drop the standalone explanation the host surface already gives.
  embedded?: boolean;
  // The host already titles the step (a step title, a section header): drop
  // this panel's own heading so the name is not said twice.
  untitled?: boolean;
  // A dialog host passes its close for the X beside the heading.
  onClose?: () => void;
  // onConnectionError decides where a failed connect, poll, status check, or
  // disconnect goes. A host that takes it owns the toast and the Notices row,
  // so the failure outlives this panel and survives the route change that
  // closes it. Without it the panel raises its own through the same
  // components.
} & ConnectionNoticeHost) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [statusAttempt, setStatusAttempt] = useState(0);
  // Inline only for what the user can fix in the field in front of them.
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(props.initialServerUrl ?? "");
  // Reported by the server itself: whether it answers from the open internet
  // or only from a private network.
  const [networkAccess, setNetworkAccess] = useState<"private" | "public" | null>(
    null,
  );
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set only by a Try again on a failed status check, read by the check it
  // starts.
  const recheckRef = useRef(false);
  const serverUrlInput = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRequestSequence();
  // Used only when nothing above this panel owns connection notices, so a
  // panel rendered on its own still reaches the same toast and Notices row.
  const ownNotices = useConnectionNotices();
  const ownsNotices = props.onConnectionError === undefined;
  const reportOwnError = useMemo(
    () => ownNotices.reporter(),
    [ownNotices.reporter],
  );
  const reportConnectionError = props.onConnectionError ?? reportOwnError;

  function clearPollTimer() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  // Runs the status check again. The ref is what tells that run it was asked
  // for, so a session it finds reaches the host like a fresh sign-in does.
  function recheckStatus() {
    recheckRef.current = true;
    setStatusAttempt((attempt) => attempt + 1);
  }

  // A retry the owner can hold after this panel closes. It answers false once
  // the panel is gone or has started a newer attempt, and the owner reopens
  // the panel instead of rerunning an attempt nothing is watching.
  function retryFor(session: number, run: () => void): () => boolean {
    return () => {
      if (!sessionRef.isCurrent(session)) return false;
      run();
      return true;
    };
  }

  // Main owns the truth about the session. The address only moves when main
  // reports it, so a status without one leaves what the user typed in place
  // to retry with.
  function applyStatus(status: CloudStatusResult, email?: string) {
    if (status.serverUrl) setServerUrl(status.serverUrl);
    setNetworkAccess(status.networkAccess ?? null);
    setPhase(
      status.connected
        ? { kind: "connected", email: email ?? status.email ?? "" }
        : { kind: "disconnected" },
    );
  }

  useEffect(() => {
    const session = sessionRef.next();
    // Only a user-asked recheck tells the host about a session it found. A
    // mount is not news: the host ran its own check, unless it asked to hear.
    const announceSession = recheckRef.current || props.handOffSession === true;
    recheckRef.current = false;
    clearPollTimer();
    setPhase({ kind: "loading" });
    setAddressProblem(null);
    setServerUrl(props.initialServerUrl ?? "");
    setNetworkAccess(null);
    void bridge()
      .cloudStatus()
      .then((status) => {
        if (!sessionRef.isCurrent(session)) return;
        applyStatus(status);
        if (announceSession && status.connected) props.onConnected?.();
      })
      .catch((cause: unknown) => {
        if (!sessionRef.isCurrent(session)) return;
        // Nothing on screen can recover this one, so the notice carries the
        // only way back: run the check again.
        setPhase({ kind: "unknown" });
        reportConnectionError({
          // Main rejects a status check with an engine or IPC failure, not
          // with a sentence for the user. Say what dohc could not do.
          message: "dohc could not check this connection.",
          cause,
          serverUrl: null,
          retry: retryFor(session, recheckStatus),
        });
      });
    return () => {
      if (sessionRef.isCurrent(session)) sessionRef.next();
      clearPollTimer();
    };
    // A notice can retry a different address while this panel is already open.
  }, [props.initialServerUrl, statusAttempt]);

  function pollUntilDone(session: number, origin: string) {
    pollTimer.current = setTimeout(() => {
      void bridge()
        .cloudLoginPoll()
        .then((result) => {
          if (!sessionRef.isCurrent(session)) return;
          if (result.status === "pending") return pollUntilDone(session, origin);
          if (result.status === "complete") {
            void bridge()
              .cloudStatus()
              .then((status) => {
                if (!sessionRef.isCurrent(session)) return;
                // Main owns the session, and this answer is newer than the
                // poll. A browser approval that did not leave a session on
                // this machine has to read as disconnected.
                applyStatus(status, result.email ?? status.email ?? "");
                if (status.connected) props.onConnected?.();
              })
              .catch((cause: unknown) => {
                if (!sessionRef.isCurrent(session)) return;
                // The approval happened, but nothing here can say what the
                // session is now. Do not announce a connection main has not
                // confirmed; the notice carries the way to ask again.
                setPhase({ kind: "unknown" });
                reportConnectionError({
                  message: "dohc could not check this connection after sign-in.",
                  cause,
                  serverUrl: origin,
                  retry: retryFor(session, recheckStatus),
                });
              });
          } else {
            setPhase({
              kind: "refused",
              reason:
                result.status === "denied"
                  ? "The request was denied in the browser."
                  : "The code expired. Start again.",
            });
          }
        })
        .catch((cause) => {
          if (!sessionRef.isCurrent(session)) return;
          // The code on screen is unreachable now, so the form comes back and
          // a retry starts the whole flow again at the same address.
          setPhase({ kind: "disconnected" });
          reportConnectionError({
            message: ipcErrorMessage(cause, "dohc could not reach the server."),
            cause,
            serverUrl: origin,
            retry: retryFor(session, () => void connect(origin)),
          });
        });
    }, 3000);
  }

  function submitConnect() {
    const address = checkServerAddress(serverUrl);
    if ("problem" in address) {
      setAddressProblem(address.problem);
      serverUrlInput.current?.focus();
      return;
    }
    void connect(address.origin);
  }

  // Takes the canonical origin rather than reading the field, so a retry runs
  // the address that failed even after the field moved on or went away.
  async function connect(origin: string) {
    const session = sessionRef.next();
    clearPollTimer();
    setAddressProblem(null);
    setServerUrl(origin);
    setNetworkAccess(null);
    setPhase({ kind: "connecting" });
    try {
      const started = await bridge().cloudLoginStart({ serverUrl: origin });
      if (!sessionRef.isCurrent(session)) return;
      setPhase({ kind: "code", ...started });
      pollUntilDone(session, origin);
    } catch (cause) {
      if (!sessionRef.isCurrent(session)) return;
      setPhase({ kind: "disconnected" });
      reportConnectionError({
        // Main reports the concrete validation or discovery failure. The
        // fallback only covers a rejection that carries no message.
        message: ipcErrorMessage(
          cause,
          "dohc could not reach this server. Check the address, then choose Try again.",
        ),
        cause,
        serverUrl: origin,
        retry: retryFor(session, () => void connect(origin)),
      });
    }
  }

  // A failed disconnect is already reported, so the read after it raises no
  // second notice: the panel just stops claiming to know.
  async function settleDisconnect(failed: boolean) {
    const session = sessionRef.next();
    clearPollTimer();
    if (!failed) {
      setPhase({ kind: "disconnected" });
      return;
    }
    try {
      const status = await bridge().cloudStatus();
      if (sessionRef.isCurrent(session)) applyStatus(status);
    } catch {
      if (sessionRef.isCurrent(session)) setPhase({ kind: "unknown" });
    }
  }

  const panel = (
    <div
      data-testid="cloud-sync-panel"
      className={
        props.embedded
          ? "w-full"
          : "dohc-elevated w-105 max-w-[80vw] rounded-xl border border-line bg-panel p-5"
      }
    >
      {props.untitled ? null : (
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex flex-1 items-center gap-1.5 text-sm font-semibold text-ink">
            <Cloud size={14} aria-hidden className="text-subtle" />
            Sync and sharing
          </h2>
          {props.onClose ? (
            <IconButton aria-label="Close" title="Close" onClick={props.onClose}>
              <X size={14} aria-hidden />
            </IconButton>
          ) : null}
        </div>
      )}

      {phase.kind === "loading" ? (
        <p className="mb-0 mt-2 text-xs text-subtle">Checking your connection…</p>
      ) : null}

      {phase.kind === "connecting" ? (
        <p data-testid="cloud-connecting" className="mb-0 mt-2 text-xs text-subtle">
          Connecting to the server…
        </p>
      ) : null}

      {/* The check failed, so this panel cannot say what the session is. The
          notice holds the reason and the way to ask again. */}
      {phase.kind === "unknown" ? (
        <p
          data-testid="cloud-connection-unknown"
          className="mb-0 mt-2 text-xs text-muted"
        >
          dohc doesn’t know whether this machine is connected.
        </p>
      ) : null}

      {phase.kind === "disconnected" || phase.kind === "refused" ? (
        <>
          {props.embedded ? null : (
            <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
              Your workspaces already work on this machine. Connect one server
              here to sync and share them.
            </p>
          )}
          {/* The browser's own answer, next to the form that starts over. */}
          {phase.kind === "refused" ? (
            <p
              data-testid="cloud-login-refused"
              role="alert"
              className="mb-0 mt-2 text-xs text-danger"
            >
              {phase.reason}
            </p>
          ) : null}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submitConnect();
            }}
          >
            <label className="mt-3 block text-[11px] font-medium text-subtle">
              Server address
              <input
                ref={serverUrlInput}
                spellCheck={false}
                aria-invalid={addressProblem !== null}
                aria-describedby={
                  addressProblem !== null ? "cloud-connection-error" : undefined
                }
                data-testid="cloud-server-url"
                value={serverUrl}
                onChange={(event) => {
                  setServerUrl(event.currentTarget.value);
                  setAddressProblem(null);
                }}
                placeholder="https://dohc.example.com"
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
              />
            </label>
            {/* The one error that stays inline: the field in front of the user
                is the thing to fix. */}
            {addressProblem ? (
              <p
                id="cloud-connection-error"
                data-testid="cloud-connection-error"
                role="alert"
                className="mb-0 mt-2 text-xs text-danger"
              >
                {addressProblem}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <PrimaryButton type="submit" data-testid="cloud-connect-start">
                Connect server
              </PrimaryButton>
              <button
                type="button"
                data-testid="cloud-setup-guide"
                onClick={() => void openLinkExternally(SETUP_GUIDE_URL)}
                className="flex items-center gap-1 text-[11px] text-muted underline underline-offset-2 transition-colors hover:text-ink"
              >
                <ExternalLink size={11} aria-hidden />
                How to set up a server
              </button>
            </div>
          </form>
          {props.embedded ? null : (
            <div
              data-testid="cloud-drive-coming-soon"
              className="mt-4 border-t border-line pt-3"
            >
              <p className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-ink">
                dohc Drive
                <Pill>Coming soon</Pill>
              </p>
              <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
                Hosting, setup, and maintenance managed by dohc.
              </p>
            </div>
          )}
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
          <PrimaryButton
            data-testid="cloud-open-browser"
            onClick={() => void openLinkExternally(phase.verificationUri)}
            className="flex items-center gap-1.5"
          >
            <ExternalLink size={12} aria-hidden />
            Open browser
          </PrimaryButton>
          <p className="mb-0 mt-2 text-[11px] text-subtle">
            Waiting for approval. This updates by itself.
          </p>
        </div>
      ) : null}

      {phase.kind === "connected" ? (
        <div data-testid="cloud-connected" className="mt-2">
          <CloudAccountRow
            email={phase.email}
            serverUrl={serverUrl}
            networkAccess={networkAccess}
            onSettled={settleDisconnect}
            onError={reportConnectionError}
          />
        </div>
      ) : null}
    </div>
  );

  if (!ownsNotices) return panel;
  return (
    <>
      {panel}
      <ConnectionNotices
        notices={ownNotices.notices}
        reportFailure={ownNotices.reportFailure}
        onRetry={ownNotices.retryNotice}
        onHide={ownNotices.hideNotice}
        onDismiss={ownNotices.dismissNotice}
      />
    </>
  );
}
