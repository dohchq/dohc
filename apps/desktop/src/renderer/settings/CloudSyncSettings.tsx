import { useEffect, useMemo, useRef, useState } from "react";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { buildSyncCode } from "../../workspaces/syncCode";
import { bridge } from "../bridge";
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
  // Reads the status again.
  onChanged: () => void;
  // Opens the connect flow.
  onConnect: () => void;
  onError: (error: ConnectionErrorReport) => void;
};

type WorkspaceSync = Required<Pick<
  CloudStatusResult,
  "workspaceSynced" | "workspaceSyncConnected" | "workspaceSecretState"
>>;

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
  const [passphrasePurpose, setPassphrasePurpose] = useState<"protect" | "unlock" | null>(null);
  const [passphrase, setPassphrase] = useState("");
  // Bumped on a workspace switch, so an answer for the last workspace never
  // paints this one.
  const requests = useRequestSequence([props.workspaceId]);
  const latest = useRef(props.cloud);
  latest.current = props.cloud;

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
    const purpose = passphrasePurpose;
    setSyncBusy(true);
    setSyncError(null);
    try {
      await bridge().cloudEnableSync({
        workspaceId: props.workspaceId,
        ...(purpose ? { passphrase } : {}),
      });
      if (!requests.isCurrent(request)) return;
      setEnabled({
        workspaceSynced: true,
        workspaceSyncConnected: true,
        workspaceSecretState: purpose === "unlock" ? "protected-key-present" : sync.workspaceSecretState,
      });
      setPassphrasePurpose(null);
      setPassphrase("");
      latest.current.onChanged();
    } catch (cause) {
      if (!requests.isCurrent(request)) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/passphrase/i.test(message)) {
        setPassphrasePurpose(/unlock/i.test(message) ? "unlock" : "protect");
        setSyncError(
          /could not/i.test(message)
            ? "That passphrase couldn't unlock synced secrets."
            : "Enter at least 8 characters to protect synced secrets.",
        );
      } else {
        // Nothing on this page can fix an engine, relay, or claim failure, so
        // it leaves with the toast and Notices row every operational failure
        // uses.
        latest.current.onError({
          message: ipcErrorMessage(cause, "dohc could not enable sync for this workspace."),
          cause,
          serverUrl: null,
          retry: () => {
            if (!requests.isCurrent(request)) return false;
            void enableSync();
            return true;
          },
        });
      }
    } finally {
      if (requests.isCurrent(request)) setSyncBusy(false);
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
  const passphraseTooShort =
    passphrasePurpose === "protect"
      ? passphrase.length < MIN_PASSPHRASE_LENGTH
      : passphrase.length === 0;
  const secretState = sync.workspaceSynced && sync.workspaceSyncConnected ? sync.workspaceSecretState : "none";

  return (
    <>
      <CloudAccountRow
        email={status.email ?? ""}
        serverUrl={status.serverUrl ?? ""}
        networkAccess={status.networkAccess ?? null}
        onSettled={props.cloud.onChanged}
        onError={props.cloud.onError}
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
                  Paused until dohc verifies this account.
                </span>
              ) : undefined
            }
          >
            {paused ? (
              <SecondaryButton
                size="compact"
                data-testid="cloud-relink-workspace"
                disabled={syncBusy}
                onClick={() => void enableSync()}
              >
                {syncBusy ? "Reconnecting…" : "Retry sync"}
              </SecondaryButton>
            ) : null}
            {/* Main has no way to stop syncing one workspace, so on stays on.
                Disconnect stops sync for every workspace. */}
            <SwitchControl
              label="Sync this workspace"
              checked={sync.workspaceSynced || (syncBusy && passphrasePurpose === null)}
              disabled={sync.workspaceSynced || syncBusy || passphrasePurpose !== null}
              onChange={() => void enableSync()}
            />
          </SettingRow>
          {syncCode ? (
            <SettingRow
              title="Workspace code"
              description="On your other machine, choose Join from another machine and paste this code."
              testId="cloud-sync-code-block"
            >
              <div className="w-56">
                <CopyField copyTestId="cloud-copy-sync-code" getText={() => syncCode} sensitive={SYNC_CODE_SECRET}>
                  <code data-testid="cloud-sync-code" title={syncCode}>{syncCode}</code>
                </CopyField>
              </div>
            </SettingRow>
          ) : null}
          {passphrasePurpose !== null || secretState !== "none" ? (
            <SettingRow
              title="Protected files"
              testId="settings-row-protected-files"
              description={
                syncError ? (
                  <span data-testid="cloud-sync-error" role="alert" className="text-danger">
                    {syncError}
                  </span>
                ) : undefined
              }
            >
              {passphrasePurpose !== null ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!syncBusy && !passphraseTooShort) void enableSync();
                  }}
                >
                  <input
                    type="password"
                    spellCheck={false}
                    aria-label="Passphrase"
                    data-testid="cloud-sync-passphrase"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.currentTarget.value)}
                    className="h-7 w-40 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
                  />
                  <PrimaryButton
                    type="submit"
                    size="compact"
                    data-testid="cloud-sync-passphrase-submit"
                    disabled={syncBusy || passphraseTooShort}
                  >
                    {passphrasePurpose === "protect"
                      ? syncBusy ? "Protecting…" : "Protect"
                      : syncBusy ? "Unlocking…" : "Unlock"}
                  </PrimaryButton>
                </form>
              ) : secretState === "protected-key-present" ? (
                <SecondaryButton
                  size="compact"
                  data-testid="cloud-protect-secrets"
                  onClick={() => setPassphrasePurpose("protect")}
                >
                  Protect with a passphrase
                </SecondaryButton>
              ) : (
                <SecondaryButton
                  size="compact"
                  data-testid="cloud-unlock-secrets"
                  onClick={() => setPassphrasePurpose("unlock")}
                >
                  Unlock protected files
                </SecondaryButton>
              )}
            </SettingRow>
          ) : null}
        </>
      )}
    </>
  );
}
