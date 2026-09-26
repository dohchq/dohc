import { useRequestSequence } from "./useRequestSequence";
import { Check, Cloud, Copy, ExternalLink, LogOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CloudStatusResult } from "../ipc/bridgeContract";
import { canonicalCloudOrigin } from "../workspaces/cloudConfiguration";
import { buildSyncCode } from "../workspaces/syncCode";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { openLinkExternally } from "./linkActivation";
import {
  ConnectionNotices,
  useConnectionNotices,
  type ConnectionNoticeHost,
} from "./shell/connectionNotices";
import { Pill, PrimaryButton, SecondaryButton } from "./ui/controls";

const SETUP_GUIDE_URL =
  "https://github.com/dohc-ai/dohc/blob/main/docs/how-to/self-host.md";

type WorkspaceSyncState = Required<Pick<
  CloudStatusResult,
  "workspaceSynced" | "workspaceSyncConnected" | "workspaceSecretState"
>>;
const UNSYNCED: WorkspaceSyncState = {
  workspaceSynced: false,
  workspaceSyncConnected: false,
  workspaceSecretState: "none",
};

function normalizeWorkspaceSyncState(
  status: CloudStatusResult,
): WorkspaceSyncState {
  return {
    workspaceSynced: status.workspaceSynced ?? false,
    workspaceSyncConnected: status.workspaceSyncConnected ?? false,
    workspaceSecretState: status.workspaceSecretState ?? "none",
  };
}

type PassphrasePurpose = "enable" | "protect" | "unlock";
const MIN_PASSPHRASE_LENGTH = 8;

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

// canonicalCloudOrigin takes https anywhere but http only on loopback, so say
// which of those two rules the address missed.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkServerAddress(
  value: string,
): { origin: string } | { problem: string } {
  const typed = value.trim();
  if (!typed) return { problem: "Enter the address of your server." };
  const origin = canonicalCloudOrigin(typed);
  if (origin) return { origin };
  try {
    const url = new URL(typed);
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      return {
        problem: "Enter an https address. dohc allows http only for localhost.",
      };
    }
  } catch {
    // Not a URL at all — the example address is the useful correction.
  }
  return { problem: "Enter the server address like https://dohc.example.com." };
}

// Sync and sharing: one server address, then the device-authorization flow.
// Show a short code, send the user to the browser to approve it, poll until
// the session lands. The token never reaches this process — main stores it
// encrypted; we only ever render status, server, and email. Main discovers the
// sync relay from the server, so there is no relay field here. Local work
// needs none of this: this panel only ever adds sync and sharing on top.
// The session belongs to the installation rather than to one workspace, so
// connecting and disconnecting here reach every workspace on this machine.
export function CloudLogin(props: {
  workspaceId?: string;
  // Fired when a device-flow login completes inside this panel (the join
  // surface re-checks its own gate on it).
  onConnected?: () => void;
  // Nested inside another elevated card (join/open-shared/handoff signed-out
  // gates): drop this panel's own frame so cards never stack elevation, and
  // drop the standalone explanation the host surface already gives.
  embedded?: boolean;
  // The host already titles the step (a step title, a section header): drop
  // this panel's own heading so the name is not said twice.
  untitled?: boolean;
  // onConnectionError decides where a failed connect, poll, status check, or
  // disconnect goes. A host that takes it owns the toast and the Notices row,
  // so the failure outlives this panel and survives the route change that
  // closes it. Without it the panel raises its own through the same
  // components.
} & ConnectionNoticeHost) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [codeCopied, setCodeCopied] = useState(false);
  const [workspaceSyncState, setWorkspaceSyncState] = useState(UNSYNCED);
  const { workspaceSynced, workspaceSyncConnected, workspaceSecretState } =
    workspaceSyncState;
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrasePurpose, setPassphrasePurpose] = useState<PassphrasePurpose>("enable");
  const [passphrase, setPassphrase] = useState("");
  const [statusAttempt, setStatusAttempt] = useState(0);
  // Inline only for what the user can fix in the field in front of them.
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(props.initialServerUrl ?? "");
  // Kept from the connected session only — the sync code carries the relay the
  // other machine joins through, and main is the one that discovers it.
  const [relayUrl, setRelayUrl] = useState("");
  // Reported by the server itself: the name it calls itself, and whether it
  // answers from the open internet or only from a private network.
  const [serverName, setServerName] = useState("");
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
  const protectPassphraseTooShort =
    needsPassphrase &&
    passphrasePurpose === "protect" &&
    passphrase.length < MIN_PASSPHRASE_LENGTH;

  function clearPollTimer() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function statusQuery() {
    return props.workspaceId ? { workspaceId: props.workspaceId } : {};
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

  // Main owns the truth about the session. The address and relay only move
  // when main reports them, so a status without them leaves what the user
  // typed in place to retry with.
  function applyStatus(status: CloudStatusResult, email?: string) {
    setWorkspaceSyncState(normalizeWorkspaceSyncState(status));
    if (status.serverUrl) setServerUrl(status.serverUrl);
    if (status.relayUrl) setRelayUrl(status.relayUrl);
    setServerName(status.serverName ?? "");
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
    // mount or a workspace switch is not news: the host ran its own check.
    const announceSession = recheckRef.current;
    recheckRef.current = false;
    clearPollTimer();
    setPhase({ kind: "loading" });
    setWorkspaceSyncState(UNSYNCED);
    setSyncBusy(false);
    setSyncError(null);
    setNeedsPassphrase(false);
    setPassphrasePurpose("enable");
    setPassphrase("");
    setAddressProblem(null);
    setDisconnectBusy(false);
    setServerUrl(props.initialServerUrl ?? "");
    setRelayUrl("");
    setServerName("");
    setNetworkAccess(null);
    void bridge()
      .cloudStatus(statusQuery())
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
  }, [props.workspaceId, props.initialServerUrl, statusAttempt]);

  async function enableSync() {
    if (!props.workspaceId || syncBusy) return;
    const session = sessionRef.current();
    setSyncBusy(true);
    setSyncError(null);
    try {
      await bridge().cloudEnableSync({
        workspaceId: props.workspaceId,
        ...(needsPassphrase ? { passphrase } : {}),
      });
      if (sessionRef.isCurrent(session)) {
        setWorkspaceSyncState((current) => ({
          workspaceSynced: true,
          workspaceSyncConnected: true,
          workspaceSecretState:
            passphrasePurpose === "unlock"
              ? "protected-key-present"
              : current.workspaceSecretState,
        }));
        setNeedsPassphrase(false);
        setPassphrase("");
      }
    } catch (cause) {
      if (!sessionRef.isCurrent(session)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/passphrase/i.test(message)) {
        setNeedsPassphrase(true);
        setPassphrasePurpose(/unlock/i.test(message) ? "unlock" : "protect");
        setSyncError(
          /could not/i.test(message)
            ? "That passphrase couldn't unlock synced secrets."
            : "Enter at least 8 characters to protect synced secrets.",
        );
      } else {
        // Nothing in this panel can fix an engine, relay, or claim failure,
        // so it leaves with the same toast and Notices row every other
        // operational failure uses.
        reportConnectionError({
          message: ipcErrorMessage(cause, "dohc could not enable sync for this workspace."),
          cause,
          serverUrl: null,
          retry: retryFor(session, () => void enableSync()),
        });
      }
    } finally {
      if (sessionRef.isCurrent(session)) setSyncBusy(false);
    }
  }

  function startSecretPassphrase(purpose: PassphrasePurpose) {
    if (syncBusy) return;
    if (needsPassphrase && passphrasePurpose === purpose) {
      void enableSync();
      return;
    }
    setPassphrasePurpose(purpose);
    setNeedsPassphrase(true);
    setPassphrase("");
    setSyncError(null);
  }

  function pollUntilDone(session: number, origin: string) {
    pollTimer.current = setTimeout(() => {
      void bridge()
        .cloudLoginPoll()
        .then((result) => {
          if (!sessionRef.isCurrent(session)) return;
          if (result.status === "pending") return pollUntilDone(session, origin);
          if (result.status === "complete") {
            void bridge()
              .cloudStatus(statusQuery())
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
    setServerName("");
    setNetworkAccess(null);
    setRelayUrl("");
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

  // The join handle for a synced workspace: one copyable line carrying the
  // workspace id and its relay. Null when anything needed is missing (an
  // unsynced workspace, or a session without a relay) — the block simply
  // doesn't render rather than showing a broken code.
  const syncCode = useMemo(() => {
    if (
      !props.workspaceId ||
      !workspaceSynced ||
      !workspaceSyncConnected ||
      !relayUrl.trim()
    ) {
      return null;
    }
    try {
      return buildSyncCode({ workspaceId: props.workspaceId, relayUrl: relayUrl.trim() });
    } catch {
      return null;
    }
  }, [
    props.workspaceId,
    relayUrl,
    workspaceSyncConnected,
    workspaceSynced,
  ]);

  // The server the session actually uses, in the form the user typed it.
  const connectedServer = canonicalCloudOrigin(serverUrl) ?? serverUrl.trim();

  async function copySyncCode() {
    if (!syncCode) return;
    try {
      await navigator.clipboard.writeText(syncCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      // Clipboard can be denied; the code stays visible and selectable.
    }
  }

  // Main drops the cached credentials before the cleanup that can fail, so a
  // rejection here says nothing about whether the session survived. Report the
  // reason, then ask main what the state actually is.
  async function disconnect() {
    if (disconnectBusy) return;
    const session = sessionRef.current();
    setDisconnectBusy(true);
    try {
      await bridge().cloudLogout();
      if (!sessionRef.isCurrent(session)) return;
      clearPollTimer();
      setPhase({ kind: "disconnected" });
      setDisconnectBusy(false);
      sessionRef.next();
    } catch (cause) {
      if (!sessionRef.isCurrent(session)) return;
      clearPollTimer();
      reportConnectionError({
        message: ipcErrorMessage(cause, "dohc could not finish disconnecting."),
        cause,
        serverUrl: null,
        retry: retryFor(session, () => void disconnect()),
      });
      try {
        const status = await bridge().cloudStatus(statusQuery());
        if (sessionRef.isCurrent(session)) applyStatus(status);
      } catch {
        // The disconnect failure is already reported. A second notice for the
        // recheck would say the same thing twice, so the panel just stops
        // claiming to know.
        if (sessionRef.isCurrent(session)) setPhase({ kind: "unknown" });
      }
    } finally {
      if (sessionRef.isCurrent(session)) setDisconnectBusy(false);
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
        <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Cloud size={14} aria-hidden className="text-subtle" />
          Sync and sharing
        </h2>
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
        <div data-testid="cloud-connected">
          {/* The session covers the installation, so say so once here rather
              than leaving "connected" to read as a property of this
              workspace. The server names itself; the origin stays visible
              underneath because that is the part the user typed and can
              check. */}
          <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
            This machine is connected
            {serverName ? (
              <>
                {" to "}
                <span data-testid="cloud-connected-server-name" className="text-ink">
                  {serverName}
                </span>
              </>
            ) : null}{" "}
            as{" "}
            <span data-testid="cloud-connected-email" className="text-ink">
              {phase.email}
            </span>
            .
          </p>
          {connectedServer ? (
            <p
              data-testid="cloud-connected-server"
              className="mb-0 mt-1 font-mono text-[11px] text-subtle"
            >
              {connectedServer}
            </p>
          ) : null}
          {networkAccess === "private" ? (
            <p
              data-testid="cloud-network-access"
              className="mb-0 mt-2 text-[11px] leading-relaxed text-muted"
            >
              This server is on a private network. Everyone you share with
              needs access to that network, from every device they use.
            </p>
          ) : null}
          {props.workspaceId ? (
            workspaceSynced ? (
              <>
                {workspaceSyncConnected ? (
                  <>
                    <p
                      data-testid="cloud-workspace-synced"
                      className="mb-0 mt-2 text-xs text-success"
                    >
                      This workspace syncs to the server — edits flow
                      automatically.
                    </p>
                    {syncCode ? (
                      <div
                        data-testid="cloud-sync-code-block"
                        className="mt-3 rounded-lg border border-line bg-panel-2 p-3"
                      >
                        <p className="m-0 text-[11px] font-semibold text-ink">
                          Add this workspace on another machine
                        </p>
                        <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
                          On the other machine, sign in with the same account,
                          choose “Join a synced workspace”, and paste this code.
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <code
                            data-testid="cloud-sync-code"
                            className="min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1 font-mono text-[11px] text-ink"
                            title={syncCode}
                          >
                            {syncCode}
                          </code>
                          <button
                            type="button"
                            data-testid="cloud-copy-sync-code"
                            onClick={() => void copySyncCode()}
                            className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-transparent px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                          >
                            {codeCopied ? (
                              <Check size={11} aria-hidden />
                            ) : (
                              <Copy size={11} aria-hidden />
                            )}
                            {codeCopied ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {workspaceSecretState === "protected-key-present" ? (
                      <SecondaryButton
                        type="button"
                        data-testid="cloud-protect-secrets"
                        disabled={
                          syncBusy || protectPassphraseTooShort
                        }
                        onClick={() => startSecretPassphrase("protect")}
                        className="mt-3"
                      >
                        {syncBusy && passphrasePurpose === "protect"
                          ? "Protecting…"
                          : "Protect sync with a passphrase"}
                      </SecondaryButton>
                    ) : null}
                    {workspaceSecretState === "protected-key-missing" ? (
                      <SecondaryButton
                        type="button"
                        data-testid="cloud-unlock-secrets"
                        disabled={
                          syncBusy ||
                          (needsPassphrase &&
                            passphrasePurpose === "unlock" &&
                            passphrase.length === 0)
                        }
                        onClick={() => startSecretPassphrase("unlock")}
                        className="mt-3"
                      >
                        {syncBusy && passphrasePurpose === "unlock"
                          ? "Unlocking…"
                          : "Unlock protected files"}
                      </SecondaryButton>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p
                      data-testid="cloud-workspace-relink"
                      className="mb-0 mt-2 text-xs text-danger"
                    >
                      Sync is paused until dohc verifies this account.
                    </p>
                    <p className="mb-0 mt-1 text-xs leading-relaxed text-muted">
                      Check your connection and account, then retry.
                    </p>
                    <SecondaryButton
                      type="button"
                      data-testid="cloud-relink-workspace"
                      disabled={syncBusy}
                      onClick={() => void enableSync()}
                      className="mt-3"
                    >
                      {syncBusy ? "Reconnecting…" : "Retry sync"}
                    </SecondaryButton>
                  </>
                )}
              </>
            ) : (
              <PrimaryButton
                type="button"
                data-testid="cloud-enable-sync"
                disabled={
                  syncBusy || protectPassphraseTooShort
                }
                onClick={() => void enableSync()}
                className="mt-3"
              >
                {syncBusy ? "Turning on sync…" : "Sync this workspace"}
              </PrimaryButton>
            )
          ) : null}
          {needsPassphrase ? (
            <label className="mt-3 block text-[11px] font-medium text-subtle">
              Passphrase
              <input
                spellCheck={false}
                data-testid="cloud-sync-passphrase"
                value={passphrase}
                type="password"
                onChange={(event) => setPassphrase(event.currentTarget.value)}
                className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-subtle focus:border-ink"
              />
            </label>
          ) : null}
          {syncError ? (
            <p data-testid="cloud-sync-error" className="mb-0 mt-2 text-xs text-danger">
              {syncError}
            </p>
          ) : null}
          <p className="mb-0 mt-4 text-[11px] leading-relaxed text-subtle">
            Disconnecting stops sync for every workspace on this machine. Your
            files stay where they are.
          </p>
          <SecondaryButton
            data-testid="cloud-disconnect"
            disabled={disconnectBusy}
            onClick={() => void disconnect()}
            className="mt-2 flex items-center gap-1.5"
          >
            <LogOut size={12} aria-hidden />
            {disconnectBusy ? "Disconnecting…" : "Disconnect"}
          </SecondaryButton>
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
        onRetry={ownNotices.retryNotice}
        onHide={ownNotices.hideNotice}
        onDismiss={ownNotices.dismissNotice}
      />
    </>
  );
}
