import { LogOut, Network } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { canonicalCloudOrigin } from "../../workspaces/cloudConfiguration";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { SettingRow } from "./SettingRow";

export const PRIVATE_NETWORK_EXPLANATION =
  "Everyone you share with needs access to this private network, from every device they use.";
export const DISCONNECT_EXPLANATION =
  "Stops sync for every workspace on this machine. Your files stay where they are.";

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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef(props);
  latest.current = props;
  const server = canonicalCloudOrigin(props.serverUrl) ?? props.serverUrl.trim();

  async function disconnect() {
    const request = requests.next();
    const here = () => mounted.current && requests.isCurrent(request);
    let failed = false;
    if (here()) setBusy(true);
    // Main announces the logout itself with no session. A session announced
    // after it is a new sign-in, which this attempt's retry must not end.
    let signedInSince = false;
    const stopWatching = bridge().onCloudSessionChanged((event) => {
      if (event.phase === "ready" && event.sessionKey !== null) signedInSince = true;
    });
    try {
      await bridge().cloudLogout();
      stopWatching();
    } catch (cause) {
      failed = true;
      // Main announces the logout before the step that failed, and a host
      // that drops this row on that news must still hear the failure.
      // Disconnect reaches the whole installation, so it is news anywhere.
      latest.current.onError({
        message: ipcErrorMessage(cause, "dohc could not finish disconnecting."),
        cause,
        serverUrl: null,
        retry: () => {
          stopWatching();
          if (signedInSince) return false;
          void disconnect();
          return true;
        },
      });
    } finally {
      if (here()) {
        setBusy(false);
        latest.current.onSettled(failed);
      }
    }
  }

  return (
    <SettingRow
      title={props.email}
      lead={<ChatAvatar name={props.email} kind="human" own size="row" />}
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span data-testid="cloud-connected-server" className="font-mono">{server}</span>
          {props.networkAccess === "private" ? (
            <Explained explanation={PRIVATE_NETWORK_EXPLANATION} testId="cloud-network-access-explanation">
              {(target) => (
                <span
                  {...target}
                  data-testid="cloud-network-access"
                  tabIndex={0}
                  // The mark does nothing else, so any focus shows its words,
                  // a tap's included: a tap has no hover.
                  onFocus={target.show}
                  className="flex items-center gap-1 rounded"
                >
                  <Network size={11} aria-hidden />
                  Private network
                </span>
              )}
            </Explained>
          ) : null}
        </span>
      }
      testId="settings-row-account"
    >
      <Explained explanation={DISCONNECT_EXPLANATION} testId="cloud-disconnect-explanation">
        {({ show: _show, ...target }) => (
          <SecondaryButton
            {...target}
            size="compact"
            data-testid="cloud-disconnect"
            disabled={busy}
            onClick={() => void disconnect()}
            className="flex items-center gap-1.5"
          >
            <LogOut size={12} aria-hidden />
            {busy ? "Disconnecting…" : "Disconnect"}
          </SecondaryButton>
        )}
      </Explained>
    </SettingRow>
  );
}

// Words a mark or a button cannot carry. They show beside it on hover and
// keyboard focus, and a screen reader reads them with it at any time.
function Explained(props: {
  explanation: string;
  testId: string;
  children: (target: {
    "aria-describedby": string;
    // Overlay leaves an Escape to the target while the words show.
    "data-tooltip-open"?: "";
    show: () => void;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {props.children({
        "aria-describedby": id,
        ...(open ? { "data-tooltip-open": "" as const } : {}),
        show: () => setOpen(true),
      })}
      <span
        id={id}
        data-testid={props.testId}
        {...(open ? { role: "tooltip" } : {})}
        className={
          open
            ? "dohc-popover dohc-pop-in absolute right-0 top-full z-50 mt-1 w-max max-w-72 rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink"
            : "sr-only"
        }
      >
        {props.explanation}
      </span>
    </span>
  );
}
