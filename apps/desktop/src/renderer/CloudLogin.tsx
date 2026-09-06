import { useRequestSequence } from "./useRequestSequence";
import { Check, Cloud, Copy, ExternalLink, LogOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { canonicalCloudOrigin } from "../workspaces/cloudConfiguration";
import { buildSyncCode } from "../workspaces/syncCode";
import { bridge } from "./bridge";
import { openLinkExternally } from "./linkActivation";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

type WorkspaceSecretState = "none" | "protected-key-present" | "protected-key-missing";
type PassphrasePurpose = "enable" | "protect" | "unlock";
type ManagedCloudStatus = "unknown" | "ready" | "unconfigured" | "invalid";
type ConnectionMode = "managed" | "self-host";
type ConnectionError = {
  message: string;
  invalid: "both" | "server" | "relay";
};
const MIN_PASSPHRASE_LENGTH = 8;

type Phase =
  | { kind: "loading" }
  | { kind: "status-failed" }
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
  // Fired when a device-flow login completes inside this panel (the join
  // surface re-checks its own gate on it).
  onConnected?: () => void;
  // Nested inside another elevated card (join/open-shared signed-out gates):
  // drop this panel's own frame so cards never stack elevation.
  embedded?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [codeCopied, setCodeCopied] = useState(false);
  const [workspaceSynced, setWorkspaceSynced] = useState(false);
  const [workspaceSyncConnected, setWorkspaceSyncConnected] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrasePurpose, setPassphrasePurpose] = useState<PassphrasePurpose>("enable");
  const [passphrase, setPassphrase] = useState("");
  const [workspaceSecretState, setWorkspaceSecretState] =
    useState<WorkspaceSecretState>("none");
  const [managedCloudStatus, setManagedCloudStatus] =
    useState<ManagedCloudStatus>("unknown");
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("self-host");
  const [connectionError, setConnectionError] = useState<ConnectionError | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverUrlInput = useRef<HTMLInputElement | null>(null);
  const relayUrlInput = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRequestSequence();
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

  useEffect(() => {
    const session = sessionRef.next();
    clearPollTimer();
    setPhase({ kind: "loading" });
    setWorkspaceSynced(false);
    setWorkspaceSyncConnected(false);
    setSyncBusy(false);
    setSyncError(null);
    setNeedsPassphrase(false);
    setPassphrasePurpose("enable");
    setPassphrase("");
    setWorkspaceSecretState("none");
    setManagedCloudStatus("unknown");
    setConnectionMode("self-host");
    setConnectionError(null);
    setServerUrl("");
    setRelayUrl("");
    void bridge()
      .cloudStatus(props.workspaceId ? { workspaceId: props.workspaceId } : {})
      .then((status) => {
        if (!sessionRef.isCurrent(session)) return;
        setWorkspaceSynced(status.workspaceSynced ?? false);
        setWorkspaceSyncConnected(status.workspaceSyncConnected ?? false);
        setWorkspaceSecretState(status.workspaceSecretState ?? "none");
        const configuredStatus = status.managedCloudStatus;
        setManagedCloudStatus(configuredStatus);
        setConnectionMode(configuredStatus === "ready" ? "managed" : "self-host");
        if (status.serverUrl) setServerUrl(status.serverUrl);
        if (status.relayUrl) setRelayUrl(status.relayUrl);
        setPhase(
          status.connected
            ? { kind: "connected", email: status.email ?? "" }
            : { kind: "disconnected" },
        );
      })
      .catch(() => {
        if (sessionRef.isCurrent(session)) setPhase({ kind: "status-failed" });
      });
    return () => {
      if (sessionRef.isCurrent(session)) sessionRef.next();
      clearPollTimer();
    };
  }, [props.workspaceId, statusAttempt]);

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
        setWorkspaceSynced(true);
        setWorkspaceSyncConnected(true);
        if (passphrasePurpose === "unlock") {
          setWorkspaceSecretState("protected-key-present");
        }
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
        setSyncError(/already claimed/i.test(message) ? message : "Couldn't enable sync.");
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

  function pollUntilDone(session: number) {
    pollTimer.current = setTimeout(() => {
      void bridge()
        .cloudLoginPoll()
        .then((result) => {
          if (!sessionRef.isCurrent(session)) return;
          if (result.status === "pending") return pollUntilDone(session);
          if (result.status === "complete") {
            void bridge()
              .cloudStatus(props.workspaceId ? { workspaceId: props.workspaceId } : {})
              .then((status) => {
                if (!sessionRef.isCurrent(session)) return;
                setWorkspaceSynced(status.workspaceSynced ?? false);
                setWorkspaceSyncConnected(status.workspaceSyncConnected ?? false);
                setWorkspaceSecretState(status.workspaceSecretState ?? "none");
                if (status.serverUrl) setServerUrl(status.serverUrl);
                if (status.relayUrl) setRelayUrl(status.relayUrl);
                setPhase({ kind: "connected", email: result.email ?? status.email ?? "" });
                props.onConnected?.();
              })
              .catch(() => {
                if (!sessionRef.isCurrent(session)) return;
                setWorkspaceSyncConnected(false);
                setPhase({ kind: "connected", email: result.email ?? "" });
                props.onConnected?.();
              });
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
          if (sessionRef.isCurrent(session)) {
            setPhase({ kind: "failed", reason: "Couldn't reach the server." });
          }
        });
    }, 3000);
  }

  async function connect() {
    let connection: { serverUrl: string; relayUrl: string } | undefined;
    if (connectionMode === "self-host") {
      const normalizedServerUrl = canonicalCloudOrigin(serverUrl);
      const normalizedRelayUrl = canonicalCloudOrigin(relayUrl);
      const missingServer = !serverUrl.trim();
      const missingRelay = !relayUrl.trim();
      if (missingServer || missingRelay) {
        setConnectionError({
          message:
            missingServer && missingRelay
              ? "Enter the cloud server URL and sync relay URL."
              : missingServer
                ? "Enter the cloud server URL."
                : "Enter the sync relay URL.",
          invalid:
            missingServer && missingRelay
              ? "both"
              : missingServer
                ? "server"
                : "relay",
        });
        (missingServer ? serverUrlInput : relayUrlInput).current?.focus();
        return;
      }
      if (!normalizedServerUrl) {
        setConnectionError({
          message: "Enter the cloud server URL as an HTTP or HTTPS origin.",
          invalid: "server",
        });
        serverUrlInput.current?.focus();
        return;
      }
      if (!normalizedRelayUrl) {
        setConnectionError({
          message: "Enter the sync relay URL as an HTTP or HTTPS origin.",
          invalid: "relay",
        });
        relayUrlInput.current?.focus();
        return;
      }
      connection = {
        serverUrl: normalizedServerUrl,
        relayUrl: normalizedRelayUrl,
      };
    }

    const session = sessionRef.next();
    clearPollTimer();
    setConnectionError(null);
    setPhase({ kind: "loading" });
    try {
      const started = await bridge().cloudLoginStart(connection ?? {});
      if (!sessionRef.isCurrent(session)) return;
      setPhase({ kind: "code", ...started });
      pollUntilDone(session);
    } catch {
      if (sessionRef.isCurrent(session)) {
        setPhase({
          kind: "failed",
          reason:
            connectionMode === "managed"
              ? "dohc could not reach dohc Cloud. Check your connection, then try again."
              : "dohc could not reach this self-hosted server. Check both URLs, then try again.",
        });
      }
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

  async function disconnect() {
    const session = sessionRef.next();
    clearPollTimer();
    try {
      await bridge().cloudLogout();
      if (sessionRef.isCurrent(session)) setPhase({ kind: "disconnected" });
    } catch {
      if (sessionRef.isCurrent(session)) {
        setPhase({ kind: "failed", reason: "Couldn't disconnect from dohc Cloud." });
      }
    }
  }

  return (
    <div
      data-testid="cloud-sync-panel"
      className={
        props.embedded
          ? "w-full"
          : "dohc-elevated w-105 max-w-[80vw] rounded-xl border border-line bg-panel p-5"
      }
    >
      <h2 className="m-0 flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Cloud size={14} aria-hidden className="text-subtle" />
        dohc Cloud
      </h2>

      {phase.kind === "loading" ? (
        <p className="mb-0 mt-2 text-xs text-subtle">Checking connection…</p>
      ) : null}

      {phase.kind === "status-failed" ? (
        <div>
          <p
            data-testid="cloud-status-error"
            role="alert"
            className="mb-0 mt-2 text-xs text-danger"
          >
            dohc could not check the cloud connection.
          </p>
          <SecondaryButton
            type="button"
            data-testid="cloud-status-retry"
            onClick={() => setStatusAttempt((attempt) => attempt + 1)}
            className="mt-3"
          >
            Retry
          </SecondaryButton>
        </div>
      ) : null}

      {phase.kind === "disconnected" || phase.kind === "failed" ? (
        <>
          {phase.kind === "failed" ? (
            <p data-testid="cloud-login-error" className="mb-0 mt-2 text-xs text-danger">
              {phase.reason}
            </p>
          ) : null}
          {managedCloudStatus === "ready" && connectionMode === "managed" ? (
            <>
              <p className="mb-0 mt-2 text-xs leading-relaxed text-muted">
                Connect to dohc Cloud for sync and sharing. Your workspace keeps
                working locally without a connection.
              </p>
              <PrimaryButton
                data-testid="cloud-connect-start"
                onClick={() => void connect()}
                className="mt-3"
              >
                Connect to dohc Cloud
              </PrimaryButton>
              <SecondaryButton
                type="button"
                data-testid="cloud-use-self-host"
                onClick={() => {
                  setConnectionMode("self-host");
                  setConnectionError(null);
                }}
                className="ml-2 mt-3"
              >
                Use a self-hosted server
              </SecondaryButton>
            </>
          ) : (
            <>
              {managedCloudStatus === "unconfigured" ? (
                <p
                  data-testid="cloud-managed-unconfigured"
                  className="mb-0 mt-2 text-xs leading-relaxed text-muted"
                >
                  dohc Cloud isn't configured in this build. You can still connect
                  to a self-hosted server.
                </p>
              ) : null}
              {managedCloudStatus === "invalid" ? (
                <>
                  <p
                    data-testid="cloud-managed-invalid"
                    className="mb-0 mt-2 text-xs leading-relaxed text-danger"
                  >
                    dohc Cloud is unavailable because this build has incomplete
                    server settings.
                  </p>
                  <p className="mb-0 mt-1 text-xs leading-relaxed text-muted">
                    Connect a self-hosted server instead.
                  </p>
                </>
              ) : null}
              {managedCloudStatus === "ready" ? (
                <SecondaryButton
                  type="button"
                  data-testid="cloud-use-managed"
                  onClick={() => {
                    setConnectionMode("managed");
                    setConnectionError(null);
                  }}
                  className="mt-3"
                >
                  Use dohc Cloud
                </SecondaryButton>
              ) : null}
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
              >
                <p className="mb-0 mt-3 text-[11px] font-semibold text-ink">
                  Self-hosted server
                </p>
                <p className="mb-0 mt-1 text-[11px] leading-relaxed text-subtle">
                  Enter the server and sync relay origins from your administrator.
                  Origins cannot include paths, queries, fragments, or sign-in details.
                </p>
                <label className="mt-3 block text-[11px] font-medium text-subtle">
                  Cloud server URL
                  <input
                    ref={serverUrlInput}
                    spellCheck={false}
                    aria-invalid={
                      connectionError?.invalid === "both" ||
                      connectionError?.invalid === "server"
                    }
                    aria-describedby={
                      connectionError?.invalid === "both" ||
                      connectionError?.invalid === "server"
                        ? "cloud-connection-error"
                        : undefined
                    }
                    data-testid="cloud-server-url"
                    value={serverUrl}
                    onChange={(event) => {
                      setServerUrl(event.currentTarget.value);
                      setConnectionError(null);
                    }}
                    placeholder="https://cloud.example.com"
                    className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
                  />
                </label>
                <label className="mt-2 block text-[11px] font-medium text-subtle">
                  Sync relay URL
                  <input
                    ref={relayUrlInput}
                    spellCheck={false}
                    aria-invalid={
                      connectionError?.invalid === "both" ||
                      connectionError?.invalid === "relay"
                    }
                    aria-describedby={
                      connectionError?.invalid === "both" ||
                      connectionError?.invalid === "relay"
                        ? "cloud-connection-error"
                        : undefined
                    }
                    data-testid="cloud-relay-url"
                    value={relayUrl}
                    onChange={(event) => {
                      setRelayUrl(event.currentTarget.value);
                      setConnectionError(null);
                    }}
                    placeholder="https://relay.example.com"
                    className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink"
                  />
                </label>
                {connectionError ? (
                  <p
                    id="cloud-connection-error"
                    data-testid="cloud-connection-error"
                    role="alert"
                    className="mb-0 mt-2 text-xs text-danger"
                  >
                    {connectionError.message}
                  </p>
                ) : null}
                <PrimaryButton
                  type="submit"
                  data-testid="cloud-connect-start"
                  className="mt-3"
                >
                  Connect
                </PrimaryButton>
              </form>
            </>
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
                {workspaceSyncConnected ? (
                  <>
                    <p
                      data-testid="cloud-workspace-synced"
                      className="mb-0 mt-2 text-xs text-success"
                    >
                      This workspace syncs to the cloud — edits flow
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
          <SecondaryButton
            data-testid="cloud-disconnect"
            onClick={() => void disconnect()}
            className="mt-3 flex items-center gap-1.5"
          >
            <LogOut size={12} aria-hidden />
            Disconnect
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
}
