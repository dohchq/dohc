import { LogOut, Network, Trash2 } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { canonicalCloudOrigin } from "../../workspaces/cloudConfiguration";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ConnectionErrorReport } from "../shell/connectionNotices";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { ChatAvatar } from "../workbench/ChatAvatar";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { ownPresentation } from "../workbench/actorPresentation";
import { SettingRow } from "./SettingRow";

export const PRIVATE_NETWORK_EXPLANATION =
  "Everyone you share with needs access to this private network, from every device they use.";
export const DISCONNECT_EXPLANATION =
  "Stops sync for every workspace on this machine. Your files stay where they are.";

// Sign-ins this window has heard of, counted by one listener for the life of
// the window. Main announces a logout with no session, and every sign-in
// with its session from the first announcement on, before it finishes. A
// retry held across a sign-in declines when the count moved.
let signIns = 0;
let watchingSignIns = false;
export function signInCount(): number {
  if (!watchingSignIns) {
    watchingSignIns = true;
    bridge().onCloudSessionChanged((event) => {
      if (event.sessionKey !== null) signIns += 1;
    });
  }
  return signIns;
}

// Ends this installation's session, and answers whether that failed. A
// failure is reported even when nothing on screen asked: Disconnect reaches
// every workspace, and main announces the logout before the step that
// failed, so the row that asked may be gone. Its retry declines once anyone
// has signed in since, so it never ends a newer session.
async function endSession(report: (error: ConnectionErrorReport) => void): Promise<boolean> {
  const before = signInCount();
  try {
    await bridge().cloudLogout();
    return false;
  } catch (cause) {
    report({
      message: ipcErrorMessage(cause, "dohc could not finish disconnecting."),
      cause,
      serverUrl: null,
      retry: () => {
        if (signInCount() !== before) return false;
        void endSession(report);
        return true;
      },
    });
    return true;
  }
}

// Who this machine is signed in as, on which server, and Disconnect. The
// session belongs to the installation, so Disconnect stops sync for every
// workspace here; Connect server takes its place and signs in again.
export function CloudAccountRow(props: {
  // The account's own presentation from the cloud status; the app-wide one when absent.
  presentation?: ActorPresentation;
  email: string;
  serverUrl: string;
  networkAccess?: "private" | "public" | null;
  // Main drops the cached credentials before the cleanup that can fail, so a
  // rejection says nothing about whether the session survived. The host reads
  // the session again once Disconnect settles.
  onSettled: (failed: boolean) => void;
  onError: (error: ConnectionErrorReport) => void;
  // Opens the review of what deleting this account on its server removes.
  // Only Settings offers it.
  onDelete?: (account: { email: string; server: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Bumped when the row unmounts, so an answer after that paints nothing.
  const requests = useRequestSequence();
  const latest = useRef(props);
  latest.current = props;
  const server =
    canonicalCloudOrigin(props.serverUrl, bridge().insecureLoopbackServersForTests) ?? props.serverUrl.trim();

  async function disconnect() {
    const request = requests.next();
    setBusy(true);
    // The handler current when the failure arrives: Disconnect reaches every
    // workspace, so a failure is news for whichever one is open by then.
    const failed = await endSession((error) => latest.current.onError(error));
    if (!requests.isCurrent(request)) return;
    setBusy(false);
    latest.current.onSettled(failed);
  }

  return (
    <SettingRow
      title={props.email}
      lead={<ChatAvatar presentation={props.presentation ?? ownPresentation} name={props.email} kind="human" size="row" />}
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span data-testid="cloud-connected-server" className="font-mono">{server}</span>
          {props.networkAccess === "private" ? (
            <Explained explanation={PRIVATE_NETWORK_EXPLANATION} testId="cloud-network-access-explanation" align="start">
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
      <Explained explanation={DISCONNECT_EXPLANATION} testId="cloud-disconnect-explanation" align="end">
        {({ show: _show, ...target }) => (
          <SecondaryButton
            {...target}
            data-testid="cloud-disconnect"
            disabled={busy}
            onClick={() => void disconnect()}
            className="flex items-center gap-2"
          >
            <LogOut size={12} aria-hidden />
            {busy ? "Disconnecting…" : "Disconnect"}
          </SecondaryButton>
        )}
      </Explained>
      {props.onDelete ? (
        // The secondary recipe in the danger color: it ends the account.
        <button
          type="button"
          data-testid="cloud-delete-account"
          disabled={busy}
          onClick={() => props.onDelete?.({ email: props.email, server })}
          className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 text-[13px] text-danger hover:bg-hover disabled:cursor-wait disabled:opacity-50"
        >
          <Trash2 size={12} aria-hidden />
          Delete account…
        </button>
      ) : null}
    </SettingRow>
  );
}

// Words a mark or a button cannot carry. They show beside it on hover and
// keyboard focus, and a screen reader reads them with it at any time. They
// open from the edge that keeps them inside the page: the start edge for
// something on the row's left, the end edge for its control.
function Explained(props: {
  explanation: string;
  testId: string;
  align: "start" | "end";
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
            ? `dohc-popover dohc-pop-in absolute top-full z-50 mt-1 w-max max-w-72 rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink ${
                props.align === "start" ? "left-0" : "right-0"
              }`
            : "sr-only"
        }
      >
        {props.explanation}
      </span>
    </span>
  );
}
