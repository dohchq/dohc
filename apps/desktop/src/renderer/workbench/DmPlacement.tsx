import { AtSign } from "lucide-react";
import { useRef, useState } from "react";
import type { DmRecord, DmRequestRow } from "../../ipc/bridgeContract";
import { Overlay } from "../Overlay";

export type DmWorkspaceOption = { workspaceId: string; label: string };

export function AcceptDmDialog(props: {
  request: DmRequestRow;
  currentWorkspaceId: string;
  workspaces: readonly DmWorkspaceOption[];
  onAccept: (workspaceId: string) => Promise<void>;
  onClose: () => void;
}) {
  const defaultWorkspaceId = props.workspaces.some(
    (workspace) => workspace.workspaceId === props.currentWorkspaceId,
  )
    ? props.currentWorkspaceId
    : (props.workspaces[0]?.workspaceId ?? "");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const chosen = props.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  const title = props.request.granterEmail
    ? `Add your conversation with ${props.request.granterEmail} to a workspace`
    : "Add this conversation to a workspace";

  async function accept() {
    if (!chosen || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await props.onAccept(chosen.workspaceId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-accept-dm-title"
        data-testid="chats-accept-dm-dialog"
        className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="chats-accept-dm-title"
            className="m-0 text-sm font-semibold text-ink"
          >
            {title}
          </h2>
          <p className="m-0 text-xs text-muted">
            The conversation stays in the workspace you pick.
          </p>
        </div>
        <fieldset className="m-0 grid gap-1 border-0 p-0" disabled={busy}>
          <legend className="sr-only">Workspace</legend>
          {props.workspaces.map((workspace) => (
            <label
              key={workspace.workspaceId}
              data-testid="chats-accept-dm-workspace-option"
              data-workspace-id={workspace.workspaceId}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-ink hover:bg-panel-2"
            >
              <input
                type="radio"
                name="chats-accept-dm-workspace"
                value={workspace.workspaceId}
                checked={workspaceId === workspace.workspaceId}
                onChange={() => setWorkspaceId(workspace.workspaceId)}
              />
              <span className="truncate">{workspace.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chats-accept-dm-cancel"
            disabled={busy}
            onClick={props.onClose}
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="chats-accept-dm-confirm"
            disabled={!chosen || busy}
            onClick={() => void accept()}
            className="rounded bg-accent px-3 py-1.5 text-xs text-bg disabled:opacity-50"
          >
            {chosen ? `Add to ${chosen.label}` : "Choose a workspace"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// The DM placement reverse path's confirmation: reversible but
// disruptive, so it states what happens before it runs (product invariant).
export function LeaveDmDialog(props: {
  dm: DmRecord;
  workspaceLabel: string;
  // A send composed for this conversation, still in
  // flight when Leave ends the row, would have its own revalidation reject
  // after the row is gone — and goBack's context change then
  // suppresses that rejection, so the message vanishes with no warning.
  // Disabling confirm until the send settles means the user always sees
  // either the message land or the existing "Could not send" error, never
  // silence.
  sendInFlight: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function confirm() {
    if (busyRef.current || props.sendInFlight) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await props.onConfirm();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-leave-dm-title"
        data-testid="chats-leave-dm-dialog"
        // This dialog owns Escape. Without the marker, the Chats
        // root's own Escape handler (onKeyDownCapture, capture phase — it
        // runs before this) walks the DM view back before this dialog ever
        // sees the key, leaving it open over whatever conversation goBack
        // lands on next.
        data-chat-escape-local="true"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (!busyRef.current) props.onClose();
        }}
        className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="chats-leave-dm-title"
            className="m-0 text-sm font-semibold text-ink"
          >
            {`Leave your conversation with ${props.dm.peerLabel}?`}
          </h2>
          <p className="m-0 text-xs text-muted">
            {`The conversation leaves ${props.workspaceLabel}. It appears again as a message request, so you can add it to a workspace later. Your messages are kept.`}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chats-leave-dm-cancel"
            autoFocus
            disabled={busy}
            onClick={props.onClose}
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="chats-leave-dm-confirm"
            disabled={busy || props.sendInFlight}
            onClick={() => void confirm()}
            className="rounded bg-accent px-3 py-1.5 text-xs text-bg disabled:opacity-50"
          >
            Leave conversation
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function DmRequestListItem(props: {
  request: DmRequestRow;
  state: "pending" | "declined";
  busy: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onRequestAgain?: () => void;
}) {
  const pending = props.state === "pending";
  return (
    <li
      data-testid={pending ? "chats-dm-request-item" : "chats-dm-declined-item"}
      className="border-b border-line"
    >
      <div className="flex items-center gap-1.5 px-3 py-2">
        <AtSign size={13} aria-hidden className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">
            {props.request.granterEmail ?? "A teammate"}
          </span>
          <span className="block text-[10px] text-subtle">
            {pending ? "Wants to message you" : "Declined"}
          </span>
        </span>
        {pending ? (
          <>
            {props.onAccept ? (
              <button
                type="button"
                data-testid="chats-dm-request-accept"
                onClick={props.onAccept}
                className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
              >
                Accept
              </button>
            ) : null}
            {props.onDecline ? (
              <button
                type="button"
                data-testid="chats-dm-request-decline"
                disabled={props.busy}
                onClick={props.onDecline}
                className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
              >
                Decline
              </button>
            ) : null}
          </>
        ) : props.onRequestAgain ? (
          <button
            type="button"
            data-testid="chats-dm-request-again"
            disabled={props.busy}
            onClick={props.onRequestAgain}
            className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
          >
            Move back to requests
          </button>
        ) : null}
      </div>
    </li>
  );
}
