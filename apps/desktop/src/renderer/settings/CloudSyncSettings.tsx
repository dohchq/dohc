import { useEffect, useMemo, useState } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { buildSyncCode } from "../../workspaces/syncCode";
import { bridge } from "../bridge";
import { SYNC_PAUSED_FOR_ACCOUNT } from "../cloudSyncWords";
import { ipcErrorMessage } from "../ipcError";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { CopyField, type CopySecret } from "../ui/CopyButton";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { CloudAccountRow } from "./CloudAccountRow";
import { SettingRow, SwitchControl } from "./SettingRow";

const SYNC_CODE_SECRET: CopySecret = { what: "the workspace code", again: "Copy it again from Settings." };
const MIN_PASSPHRASE_LENGTH = 8;

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
};

type WorkspaceSync = Required<Pick<
  CloudStatusResult,
  "workspaceSynced" | "workspaceSyncConnected" | "workspaceSecretState"
>>;

type PassphrasePurpose = "protect" | "unlock";

// Settings' Sync and sharing page: the signed-in account with Disconnect, and
// whether this workspace syncs. Connecting a server is a flow, not a setting,
// so a page with nobody signed in offers the button that opens it.
export function CloudSyncSettings(props: {
  workspaceId: string;
  sharedView?: boolean;
  cloud: CloudSettings;
}) {
  const { status } = props.cloud;
  // A successful enable shows at once, until the shell's next read replaces it.
  const [enabled, setEnabled] = useState<WorkspaceSync | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [passphrasePurpose, setPassphrasePurpose] = useState<PassphrasePurpose | null>(null);
  const [passphrase, setPassphrase] = useState("");
  // Bumped on a workspace switch and when the page closes, so an answer that
  // arrives after either paints nothing here.
  const requests = useRequestSequence([props.workspaceId]);

  useEffect(() => {
    setSyncBusy(false);
    setSyncError(null);
    setPassphrasePurpose(null);
    setPassphrase("");
  }, [props.workspaceId]);
  useEffect(() => setEnabled(null), [status, props.workspaceId]);

  const sync: WorkspaceSync = enabled ?? {
    workspaceSynced: status?.workspaceSynced ?? false,
    workspaceSyncConnected: status?.workspaceSyncConnected ?? false,
    workspaceSecretState: status?.workspaceSecretState ?? "none",
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
    // The callbacks of the workspace this attempt is for. The page can close
    // before main answers, and the result still matters: the shell's status
    // and its notices hear it, for this workspace only.
    const cloud = props.cloud;
    const here = () => requests.isCurrent(request);
    const purpose = passphrasePurpose;
    setSyncBusy(true);
    setSyncError(null);
    try {
      await bridge().cloudEnableSync({
        workspaceId: props.workspaceId,
        ...(purpose ? { passphrase } : {}),
      });
      if (here()) {
        setEnabled({
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
      if (here()) setSyncBusy(false);
    }
  }

  if (!status) {
    if (!props.cloud.unreadable) {
      return <SkeletonRows rows={2} label="Checking your server connection…" testId="settings-cloud-checking" />;
    }
    // The shell already raised the failure, with its reason and Try again.
    return (
      <SettingRow title="Server" testId="settings-row-server">
        <SecondaryButton size="compact" onClick={props.cloud.onChanged}>
          Try again
        </SecondaryButton>
      </SettingRow>
    );
  }

  if (!status.connected) {
    return (
      <SettingRow title="Server" testId="settings-row-server">
        <PrimaryButton size="compact" data-testid="settings-cloud-connect" onClick={props.cloud.onConnect}>
          Connect server
        </PrimaryButton>
      </SettingRow>
    );
  }

  const paused = sync.workspaceSynced && !sync.workspaceSyncConnected;
  const secretState = sync.workspaceSynced && sync.workspaceSyncConnected ? sync.workspaceSecretState : "none";

  return (
    <>
      <CloudAccountRow
        email={status.email ?? ""}
        serverUrl={status.serverUrl ?? ""}
        networkAccess={status.networkAccess ?? null}
        onSettled={props.cloud.onChanged}
        onError={props.cloud.onAccountError}
      />
      {/* Main refuses to enroll a shared view: it syncs through its share. */}
      {props.sharedView ? null : (
        <>
          <SettingRow
            title="Sync this workspace"
            testId="settings-row-sync-workspace"
            description={
              paused ? (
                <span data-testid="cloud-workspace-relink" className="text-danger">
                  {SYNC_PAUSED_FOR_ACCOUNT}
                </span>
              ) : undefined
            }
          >
            {/* Enabling again reads this account's saved session, which
                resumes sync when it owns the workspace. Another account
                gets main's reason in a notice, and Disconnect above is the
                way to the right one. */}
            {paused ? (
              <SecondaryButton
                size="compact"
                data-testid="cloud-relink-workspace"
                disabled={syncBusy}
                onClick={() => void enableSync()}
              >
                Try again
              </SecondaryButton>
            ) : null}
            {/* Main has no way to stop syncing one workspace yet, so on
                reads as on and stays on. Disconnect stops sync for every
                workspace. */}
            <SwitchControl
              label="Sync this workspace"
              checked={sync.workspaceSynced || (syncBusy && passphrasePurpose === null)}
              readOnly={sync.workspaceSynced}
              disabled={!sync.workspaceSynced && (syncBusy || passphrasePurpose !== null)}
              onChange={() => void enableSync()}
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
              busy={syncBusy}
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
            className="h-7 w-40 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
          />
          <PrimaryButton
            type="submit"
            size="compact"
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
          size="compact"
          data-testid="cloud-protect-secrets"
          onClick={() => props.onStart("protect")}
        >
          Protect with a passphrase
        </SecondaryButton>
      ) : (
        <SecondaryButton
          size="compact"
          data-testid="cloud-unlock-secrets"
          onClick={() => props.onStart("unlock")}
        >
          Unlock protected files
        </SecondaryButton>
      )}
    </SettingRow>
  );
}
