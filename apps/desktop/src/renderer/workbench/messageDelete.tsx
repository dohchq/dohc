import { Trash2 } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MembersResult } from "@dohc/cli/members";
import { MESSAGE_DELETE_FAILED } from "@dohc/security-contract/workspace-members";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { DangerButton, FieldError, SecondaryButton } from "../ui/controls";
import {
  ConfirmActions,
  ConfirmationCard,
  ConfirmationHead,
  confirmPanel,
  FOCUS_RING,
  useOpeningFocus,
} from "../ui/ConfirmDialog";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { chatAuthorLabel, TOOLBAR_BUTTON } from "./chatMessages";

type Role = Extract<MembersResult, { status: "ready" }>["view"]["viewer"]["role"];

// The reader's role in the open workspace, or null where they delete nothing.
const DeleteRole = createContext<Role | null>(null);

/**
 * Reads the reader's role once main admits this window's workspace, and again
 * when `refreshKey` changes: the workspace reconnected, or the relay named a
 * new membership role. Main refuses a read made before it admits the window.
 * A failed read also tries again on each "current" event from
 * `shareAccessCurrent`, the shared view's access check. A workspace that
 * never synced lists no Members, so it offers no Delete: deleting asks the
 * server to stop serving the text.
 */
export function MessageDeleteRole(props: {
  workspaceId: string;
  refreshKey: string;
  admitted: boolean;
  shareAccessCurrent?: EventTarget;
  children: ReactNode;
}) {
  const { workspaceId, refreshKey, admitted, shareAccessCurrent } = props;
  const members = useWorkspaceQuery(useWorkspaceSession(), {
    key: `message-delete:${workspaceId}`,
    load: () => bridge().workspaceMembers({ workspaceId, request: { action: "list" } }),
    manual: !admitted,
  });
  const { retry } = members;
  // A new workspace starts its own read.
  const readFor = useRef({ workspaceId, refreshKey, admitted });
  useEffect(() => {
    const previous = readFor.current;
    readFor.current = { workspaceId, refreshKey, admitted };
    if (previous.workspaceId !== workspaceId || !admitted) return;
    if (!previous.admitted || previous.refreshKey !== refreshKey) void retry();
  }, [workspaceId, refreshKey, admitted, retry]);
  const failed = members.error !== null;
  useEffect(() => {
    if (!failed || !shareAccessCurrent) return;
    const tryAgain = () => void retry();
    shareAccessCurrent.addEventListener("current", tryAgain);
    return () => shareAccessCurrent.removeEventListener("current", tryAgain);
  }, [failed, shareAccessCurrent, retry]);
  const role = members.value?.status === "ready" ? members.value.view.viewer.role : null;
  return <DeleteRole.Provider value={role}>{props.children}</DeleteRole.Provider>;
}

/**
 * Delete for the messages of a Group or a file's Comments. The reader sees it
 * on their own messages, and as the owner or an admin on every message. The
 * relay decides each delete; this only leaves Delete off where it would
 * refuse.
 */
export function useMessageDelete(input: {
  workspaceId: string;
  // Who the reader is in this chat, as its reactions name them.
  viewerAuthorId: string;
  // False where no one deletes, such as a chat with an agent.
  enabled: boolean;
}): {
  action: (message: ChatMessageRecord, testId: string) => ReactNode;
  dialog: ReactNode;
} {
  const { workspaceId, viewerAuthorId, enabled } = input;
  const workspaceRole = useContext(DeleteRole);
  const role = enabled ? workspaceRole : null;
  const [asking, setAsking] = useState<{ message: ChatMessageRecord; own: boolean } | null>(null);
  const action = useCallback(
    (message: ChatMessageRecord, testId: string) => {
      if (role === null || message.deletedAtMs !== undefined) return null;
      const own =
        message.authorKind === "human" &&
        viewerAuthorId !== "" &&
        message.authorUserId === viewerAuthorId;
      if (role === "member" && !own) return null;
      return (
        <button
          type="button"
          data-testid={testId}
          aria-label="Delete message"
          title="Delete message"
          onClick={() => setAsking({ message, own })}
          className={TOOLBAR_BUTTON}
        >
          <Trash2 size={14} strokeWidth={1.9} aria-hidden />
        </button>
      );
    },
    [role, viewerAuthorId],
  );
  const dialog = asking ? (
    <MessageDeleteDialog
      key={asking.message.id}
      workspaceId={workspaceId}
      message={asking.message}
      own={asking.own}
      onClose={() => setAsking(null)}
    />
  ) : null;
  return { action, dialog };
}

function MessageDeleteDialog(props: {
  workspaceId: string;
  message: ChatMessageRecord;
  // The reader's own message keeps "this"; another's names its author.
  own: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useOpeningFocus(() => confirmRef.current);
  // The confirm was disabled while the delete ran; Try again takes focus back.
  useEffect(() => {
    if (failure) confirmRef.current?.focus();
  }, [failure]);

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setFailure(null);
    try {
      // Nothing here changes until the relay answers. The line turns into
      // "Message deleted" when this copy pulls the delete.
      await bridge().workspaceMembers({
        workspaceId: props.workspaceId,
        request: {
          action: "deleteMessage",
          threadId: props.message.threadId,
          messageId: props.message.id,
        },
      });
      if (alive.current) props.onClose();
    } catch (cause) {
      if (!alive.current) return;
      // What failed leads, whatever the cause's words say.
      const words = ipcErrorMessage(cause, MESSAGE_DELETE_FAILED);
      setFailure(
        words.startsWith(MESSAGE_DELETE_FAILED) ? words : `${MESSAGE_DELETE_FAILED} ${words}`,
      );
      setDeleting(false);
    }
  }

  const quote = props.message.body.replace(/\s+/gu, " ").trim();
  return (
    <Overlay
      // While the delete runs, only its answer closes the dialog.
      onClose={deleting ? undefined : props.onClose}
      panelRef={panelRef}
      panelProps={confirmPanel(`${id}-title`, `${id}-body`)}
    >
      <ConfirmationCard icon={Trash2} intent="danger" testId="message-delete">
        <ConfirmationHead
          titleId={`${id}-title`}
          bodyId={`${id}-body`}
          title={
            props.own
              ? "Delete this message?"
              : `Delete ${chatAuthorLabel(props.message)}'s message?`
          }
        >
          {/* The dialog covers the message, so it shows what it deletes. */}
          {quote ? (
            <p
              data-testid="message-delete-quote"
              className="m-0 truncate border-l-2 border-line pl-2"
            >
              {quote}
            </p>
          ) : null}
          <p className="m-0">
            This removes the message from this conversation for everyone. You can't undo it. People
            who already read it may keep a copy.
          </p>
        </ConfirmationHead>
        {failure ? (
          <FieldError id={`${id}-error`} testId="message-delete-error">
            {failure}
          </FieldError>
        ) : null}
        <ConfirmActions>
          <SecondaryButton
            data-testid="message-delete-cancel"
            className={FOCUS_RING}
            disabled={deleting}
            onClick={props.onClose}
          >
            Cancel
          </SecondaryButton>
          <DangerButton
            ref={confirmRef}
            data-testid="message-delete-confirm"
            className={FOCUS_RING}
            disabled={deleting}
            onClick={() => void remove()}
          >
            {deleting ? "Deleting…" : failure ? "Try again" : "Delete"}
          </DangerButton>
        </ConfirmActions>
      </ConfirmationCard>
    </Overlay>
  );
}
