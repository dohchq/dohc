import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { buildSyncCode } from "../../workspaces/syncCode";
import { bridge } from "../bridge";
import { SYNC_UNCONFIRMED_ACCOUNT } from "../cloudSyncWords";
import { ipcErrorMessage } from "../ipcError";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { formatChatTime } from "../time";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { CopyField, type CopySecret } from "../ui/CopyButton";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { CloudAccountRow } from "./CloudAccountRow";
import { SettingRow, SwitchControl } from "./SettingRow";

const SYNC_CODE_SECRET: CopySecret = { what: "the workspace code", again: "Copy it again from Settings." };
const MIN_PASSPHRASE_LENGTH = 8;
// What turning sync off leaves alone. Groups and received shares sync on
// their own, so a pause here does not reach them.
export const SYNC_OFF_KEEPS = "Turning this off keeps your work, history, and shares; groups you joined keep syncing.";
export const SYNC_OFF_KEEPS_WITH_RECEIVED =
  "Turning this off keeps your work, history, and shares; groups you joined and files shared with you keep syncing.";
// Why the switch cannot turn on while nobody is signed in. Connect server sits
// in the row above.
export const SYNC_ON_NEEDS_SERVER = "Connect your server to turn sync on.";

// The shell's own read of this workspace's server connection, so opening
// Settings reads nothing new.
export type CloudSettings = {
  // Null while the shell reads it, or after the read failed.
  status: CloudStatusResult | null;
  unreadable: boolean;
  // Reads the status again. The shell ignores a call made for a workspace
  // it no longer shows.
  onChanged: () => void;
  // Opens the connect flow.
  onConnect: () => void;
  // The same guard as onChanged applies.
  onError: (error: ConnectionErrorReport) => void;
  // A failure that reaches every workspace, such as Disconnect's. It goes to
  // whichever workspace is open when it arrives, with no workspace guard.
  onAccountError: (error: ConnectionErrorReport) => void;
  // Whether shared-with-me holds a received share, which keeps syncing while
  // this workspace's sync is off.
  hasReceivedShares?: boolean;
  // Opens the deletion review. The shell owns it, so it outlives this page
  // and the account row.
  onDeleteAccount: (account: { email: string; server: string }) => void;
};

type SyncPause = NonNullable<CloudStatusResult["syncPause"]>;

type WorkspaceSync = Required<Pick<
  CloudStatusResult,
  "workspaceSynced" | "workspaceSyncConnected" | "workspaceSecretState"
>> & { syncPause?: SyncPause };

type PassphrasePurpose = "protect" | "unlock";

// Settings' Sync and sharing page: the server account and this workspace's
// local sync setting. Pausing needs no account.
export function CloudSyncSettings(props: {
  workspaceId: string;
  sharedView?: boolean;
  cloud: CloudSettings;
}) {
  const { status } = props.cloud;
  // A successful enable or stop shows at once, until the shell's next read
  // replaces it.
  const [changed, setChanged] = useState<WorkspaceSync | null>(null);
  const [syncBusy, setSyncBusy] = useState<"enable" | "stop" | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [passphrasePurpose, setPassphrasePurpose] = useState<PassphrasePurpose | null>(null);
  const [passphrase, setPassphrase] = useState("");
  // Bumped on a workspace switch and when the page closes, so an answer that
  // arrives after either paints nothing here.
  const requests = useRequestSequence([props.workspaceId]);
  // Protect and Unlock turn sync on, which needs an account, so signing out
  // also drops an enable still waiting: its answer must not reopen the form.
  // Counted apart from requests, so stops and enables still supersede each other.
  const signedOut = status?.connected === false;
  const signOuts = useRef(0);

  useEffect(() => {
    setSyncBusy(null);
    setSyncError(null);
    setPassphrasePurpose(null);
    setPassphrase("");
  }, [props.workspaceId]);
  useEffect(() => setChanged(null), [status, props.workspaceId]);
  useEffect(() => {
    if (!signedOut) return;
    signOuts.current += 1;
    setSyncBusy((busy) => (busy === "enable" ? null : busy));
    setSyncError(null);
    setPassphrasePurpose(null);
    setPassphrase("");
  }, [signedOut]);

  const sync: WorkspaceSync = changed ?? {
    workspaceSynced: status?.workspaceSynced ?? false,
    workspaceSyncConnected: status?.workspaceSyncConnected ?? false,
    workspaceSecretState: status?.workspaceSecretState ?? "none",
    ...(status?.syncPause ? { syncPause: status.syncPause } : {}),
  };
  const relayUrl = status?.relayUrl?.trim() ?? "";
  // The join handle: one copyable line carrying the workspace id and its
  // relay. Absent when anything it needs is missing.
  const syncCode = useMemo(() => {
    if (!sync.workspaceSynced || !sync.workspaceSyncConnected || !relayUrl) return null;
    try {
      return buildSyncCode({ workspaceId: props.workspaceId, relayUrl });
    } catch {
      return null;
    }
  }, [props.workspaceId, relayUrl, sync.workspaceSyncConnected, sync.workspaceSynced]);

  async function enableSync() {
    const request = requests.next();
    const signOutsAtStart = signOuts.current;
    // The callbacks of the workspace this attempt is for. The page can close
    // before main answers, and the result still matters: the shell's status
    // and its notices hear it, for this workspace only.
    const cloud = props.cloud;
    const here = () => requests.isCurrent(request) && signOuts.current === signOutsAtStart;
    const purpose = passphrasePurpose;
    setSyncBusy("enable");
    setSyncError(null);
    try {
      await bridge().cloudEnableSync({
        workspaceId: props.workspaceId,
        ...(purpose ? { passphrase } : {}),
      });
      if (here()) {
        setChanged({
          workspaceSynced: true,
          workspaceSyncConnected: true,
          workspaceSecretState: purpose === "unlock" ? "protected-key-present" : sync.workspaceSecretState,
        });
        setPassphrasePurpose(null);
        setPassphrase("");
      }
      cloud.onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (here() && /passphrase/i.test(message)) {
        setPassphrasePurpose(/unlock/i.test(message) ? "unlock" : "protect");
        setSyncError(
          /could not/i.test(message)
            ? "That passphrase couldn't unlock synced secrets."
            : "Enter at least 8 characters to protect synced secrets.",
        );
        return;
      }
      // Nothing on this page can fix an engine, relay, or claim failure, so
      // it leaves with the toast and Notices row every operational failure
      // uses. So does any failure that arrives after the page closed. Its
      // retry then opens the page again.
      cloud.onError({
        message: ipcErrorMessage(cause, "dohc could not enable sync for this workspace."),
        cause,
        serverUrl: null,
        retry: () => {
          if (!here()) return false;
          void enableSync();
          return true;
        },
      });
    } finally {
      if (here()) setSyncBusy(null);
    }
  }

  // A local pause: main keeps the workspace's relay claim, shares, and history,
  // and turning sync on again resumes it.
  async function stopSync() {
    const request = requests.next();
    const cloud = props.cloud;
    const workspaceId = props.workspaceId;
    const here = () => requests.isCurrent(request);
    const secretState = sync.workspaceSecretState;
    setSyncBusy("stop");
    setSyncError(null);
    try {
      const result = await bridge().cloudStopSync();
      if (here() && result.workspaceId === workspaceId) {
        setChanged({
          workspaceSynced: false,
          workspaceSyncConnected: false,
          workspaceSecretState: secretState,
          ...(result.syncPause ? { syncPause: result.syncPause } : {}),
        });
        setPassphrasePurpose(null);
        setPassphrase("");
      }
      cloud.onChanged();
    } catch (cause) {
      cloud.onError({
        message: ipcErrorMessage(cause, "dohc could not pause sync for this workspace."),
        cause,
        serverUrl: null,
        retry: () => {
          if (!here()) return false;
          void stopSync();
          return true;
        },
      });
    } finally {
      if (here()) setSyncBusy(null);
    }
  }

  if (!status) {
    if (!props.cloud.unreadable) {
      return <SkeletonRows rows={2} label="Checking your server connection…" testId="settings-cloud-checking" />;
    }
    // The shell already raised the failure, with its reason and Try again.
    return (
      <SettingRow title="Server" testId="settings-row-server">
        <SecondaryButton onClick={props.cloud.onChanged}>
          Try again
        </SecondaryButton>
      </SettingRow>
    );
  }

  const connectRow = (
    <SettingRow title="Server" testId="settings-row-server">
      <PrimaryButton data-testid="settings-cloud-connect" onClick={props.cloud.onConnect}>
        Connect server
      </PrimaryButton>
    </SettingRow>
  );
  // Signed out, a workspace this computer's person owns still offers its
  // switch: pausing needs no account, and turning sync on does.
  if (!status.connected && !status.workspaceSyncOwned) return connectRow;

  const unconfirmed = sync.workspaceSynced && !sync.workspaceSyncConnected;
  const syncPause = sync.workspaceSynced ? undefined : sync.syncPause;
  const needsServer = !status.connected && !sync.workspaceSynced;
  const secretState = sync.workspaceSynced && sync.workspaceSyncConnected ? sync.workspaceSecretState : "none";

  return (
    <>
      {status.connected ? (
        <CloudAccountRow
          email={status.email ?? ""}
          presentation={status.ownPresentation}
          serverUrl={status.serverUrl ?? ""}
          networkAccess={status.networkAccess ?? null}
          onSettled={props.cloud.onChanged}
          onError={props.cloud.onAccountError}
          onDelete={props.cloud.onDeleteAccount}
        />
      ) : connectRow}
      {/* Main refuses to enroll a shared view: it syncs through its share. */}
      {props.sharedView ? null : (
        <>
          <SettingRow
            title="Sync this workspace"
            testId="settings-row-sync-workspace"
            description={
              unconfirmed ? (
                <span data-testid="cloud-workspace-relink" className="text-danger">
                  {SYNC_UNCONFIRMED_ACCOUNT}
                </span>
              ) : syncPause || needsServer ? (
                <>
                  {syncPause ? <SyncPausedLine pause={syncPause} /> : null}
                  {needsServer ? (
                    <span data-testid="cloud-sync-needs-server" className="block">
                      {SYNC_ON_NEEDS_SERVER}
                    </span>
                  ) : null}
                </>
              ) : sync.workspaceSynced ? (
                props.cloud.hasReceivedShares ? SYNC_OFF_KEEPS_WITH_RECEIVED : SYNC_OFF_KEEPS
              ) : undefined
            }
          >
            {/* Enabling again reads this account's saved session, which
                resumes sync when it owns the workspace. Another account
                gets main's reason in a notice, and Disconnect above is the
                way to the right one. */}
            {unconfirmed && status.connected ? (
              <SecondaryButton
                data-testid="cloud-relink-workspace"
                disabled={syncBusy !== null}
                onClick={() => void enableSync()}
              >
                Try again
              </SecondaryButton>
            ) : null}
            {/* Off pauses sync on this computer, and on resumes it, so
                neither asks first. The switch moves at the click and holds
                still until main answers. */}
            <SwitchControl
              label="Sync this workspace"
              checked={syncBusy === "stop" ? false : sync.workspaceSynced || (syncBusy === "enable" && passphrasePurpose === null)}
              busy={syncBusy !== null}
              disabled={syncBusy !== null || needsServer || (!sync.workspaceSynced && passphrasePurpose !== null)}
              onChange={(on) => void (on ? enableSync() : stopSync())}
            />
          </SettingRow>
          {syncCode ? (
            <SettingRow title="Workspace code" testId="cloud-sync-code-block">
              <div className="w-56">
                <CopyField copyTestId="cloud-copy-sync-code" getText={() => syncCode} sensitive={SYNC_CODE_SECRET}>
                  <code data-testid="cloud-sync-code" title={syncCode}>{syncCode}</code>
                </CopyField>
              </div>
            </SettingRow>
          ) : null}
          {passphrasePurpose !== null || secretState !== "none" ? (
            <ProtectedFilesRow
              secretState={secretState}
              purpose={passphrasePurpose}
              passphrase={passphrase}
              error={syncError}
              busy={syncBusy !== null}
              onStart={setPassphrasePurpose}
              onPassphrase={setPassphrase}
              onSubmit={() => void enableSync()}
            />
          ) : null}
        </>
      )}
    </>
  );
}

// Who paused this workspace's sync, and when. An agent carries the agent mark.
function SyncPausedLine(props: { pause: SyncPause }) {
  const { author } = props.pause;
  const time = formatChatTime(props.pause.atMs);
  // A person pause from another installation id (a copied or reset registry) names nobody.
  const by = author.kind === "agent" ? (
    <span className="text-agent">
      <Sparkles size={12} strokeWidth={1.9} aria-hidden className="mr-0.5 inline align-[-2px]" />
      <span className="sr-only">agent </span>
      {author.agentId}
    </span>
  ) : author.self ? "you" : null;
  return (
    <span data-testid="cloud-sync-paused">
      Paused{by ? <> by {by}</> : null}
      {" · "}
      <time dateTime={time.iso}>{time.label}</time>
    </span>
  );
}

// Protect and Unlock, and the passphrase field either one opens.
export function ProtectedFilesRow(props: {
  secretState: WorkspaceSync["workspaceSecretState"];
  purpose: PassphrasePurpose | null;
  passphrase: string;
  error: string | null;
  busy: boolean;
  onStart: (purpose: PassphrasePurpose) => void;
  onPassphrase: (passphrase: string) => void;
  onSubmit: () => void;
}) {
  const tooShort =
    props.purpose === "protect"
      ? props.passphrase.length < MIN_PASSPHRASE_LENGTH
      : props.passphrase.length === 0;
  return (
    <SettingRow
      title="Protected files"
      testId="settings-row-protected-files"
      description={
        props.error ? (
          <span data-testid="cloud-sync-error" role="alert" className="text-danger">
            {props.error}
          </span>
        ) : undefined
      }
    >
      {props.purpose !== null ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.busy && !tooShort) props.onSubmit();
          }}
        >
          <input
            type="password"
            spellCheck={false}
            aria-label="Passphrase"
            aria-invalid={props.error !== null}
            data-testid="cloud-sync-passphrase"
            value={props.passphrase}
            onChange={(event) => props.onPassphrase(event.currentTarget.value)}
            className="h-8 w-40 rounded-md border border-line bg-bg px-2 text-[13px] text-ink focus:border-ink"
          />
          <PrimaryButton
            type="submit"
            data-testid="cloud-sync-passphrase-submit"
            disabled={props.busy || tooShort}
          >
            {props.purpose === "protect"
              ? props.busy ? "Protecting…" : "Protect"
              : props.busy ? "Unlocking…" : "Unlock"}
          </PrimaryButton>
        </form>
      ) : props.secretState === "protected-key-present" ? (
        <SecondaryButton
          data-testid="cloud-protect-secrets"
          onClick={() => props.onStart("protect")}
        >
          Protect with a passphrase
        </SecondaryButton>
      ) : (
        <SecondaryButton
          data-testid="cloud-unlock-secrets"
          onClick={() => props.onStart("unlock")}
        >
          Unlock protected files
        </SecondaryButton>
      )}
    </SettingRow>
  );
}
