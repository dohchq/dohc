import { LogOut, Network } from "lucide-react";
import { useRef, useState } from "react";
import { canonicalCloudOrigin } from "../../workspaces/cloudConfiguration";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { SettingRow } from "./SettingRow";

// Who this machine is signed in as, on which server, and Disconnect. The
// session belongs to the installation, so Disconnect stops sync for every
// workspace here; Connect server takes its place and signs in again.
export function CloudAccountRow(props: {
  email: string;
  serverUrl: string;
  networkAccess?: "private" | "public" | null;
  // Main drops the cached credentials before the cleanup that can fail, so a
  // rejection says nothing about whether the session survived. The host reads
  // the session again once Disconnect settles.
  onSettled: (failed: boolean) => void;
  onError: (error: ConnectionErrorReport) => void;
}) {
  const [busy, setBusy] = useState(false);
  const requests = useRequestSequence();
  const latest = useRef(props);
  latest.current = props;
  const server = canonicalCloudOrigin(props.serverUrl) ?? props.serverUrl.trim();

  async function disconnect() {
    const request = requests.next();
    let failed = false;
    setBusy(true);
    try {
      await bridge().cloudLogout();
    } catch (cause) {
      failed = true;
      if (!requests.isCurrent(request)) return;
      latest.current.onError({
        message: ipcErrorMessage(cause, "dohc could not finish disconnecting."),
        cause,
        serverUrl: null,
        // Disconnect reaches the whole installation, so its retry needs no
        // row on screen. A notice cannot outlive its workspace.
        retry: () => {
          void disconnect();
          return true;
        },
      });
    } finally {
      if (requests.isCurrent(request)) {
        setBusy(false);
        latest.current.onSettled(failed);
      }
    }
  }

  return (
    <SettingRow
      title={props.email}
      lead={<ChatAvatar name={props.email} kind="human" size="row" />}
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span data-testid="cloud-connected-server" className="font-mono">{server}</span>
          {props.networkAccess === "private" ? (
            <span
              data-testid="cloud-network-access"
              title="Everyone you share with needs access to this private network, from every device they use."
              className="flex items-center gap-1"
            >
              <Network size={11} aria-hidden />
              Private network
            </span>
          ) : null}
        </span>
      }
      testId="settings-row-account"
    >
      <SecondaryButton
        size="compact"
        data-testid="cloud-disconnect"
        title="Stops sync for every workspace on this machine. Your files stay where they are."
        disabled={busy}
        onClick={() => void disconnect()}
        className="flex items-center gap-1.5"
      >
        <LogOut size={12} aria-hidden />
        {busy ? "Disconnecting…" : "Disconnect"}
      </SecondaryButton>
    </SettingRow>
  );
}
