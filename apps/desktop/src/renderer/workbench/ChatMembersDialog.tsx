import { Eye, X } from "lucide-react";
import { useId, useState } from "react";
import type { ChatChannelShareGrantRow } from "../../ipc/bridgeContract";
import { Overlay } from "../Overlay";
import { GhostButton, IconButton, PrimaryButton } from "../ui/controls";
import { useRadioGroup } from "../ui/SegmentedControl";
import { ChatAvatar } from "./ChatAvatar";
import { neutralPresentation } from "./actorPresentation";
import { ShareReadFailureNotice, type ShareReadFailure } from "./ChatsControls";

type Access = "post" | "view";

const ACCESS: ReadonlyArray<{ value: Access; label: string }> = [
  { value: "post", label: "Can post" },
  { value: "view", label: "View only" },
];

// A group's members, and the one field that adds another. Adding keeps the
// dialog open with the field empty, so several people go in a row. Remove
// hands its Undo to the toast; the dialog stays open on the shorter list.
export function ChatMembersDialog(props: {
  groupName: string;
  members: ReadonlyArray<ChatChannelShareGrantRow>;
  readFailure: ShareReadFailure | null;
  // Over the relay's listing cap a new member would only deepen the state.
  blocked: boolean;
  // Resolves true once the person is a member. A failure reports itself.
  onAdd: (input: { email: string; viewOnly: boolean }) => Promise<boolean>;
  onRemove: (member: ChatChannelShareGrantRow) => void;
  onRetryRead: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<Access>("post");
  const [busy, setBusy] = useState(false);
  const group = useRadioGroup({ value: access, options: ACCESS, onChange: setAccess, disabled: props.blocked });
  const id = useId();
  const typed = email.trim().length > 0;

  async function add() {
    if (busy || props.blocked || !typed) return;
    setBusy(true);
    try {
      if (await props.onAdd({ email: email.trim(), viewOnly: access === "view" })) {
        setEmail("");
        setAccess("post");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="chats-share-panel"
        className="dohc-elevated flex w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <div className="flex items-center gap-2">
          <h2 id={`${id}-title`} className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-ink">
            Add members to {props.groupName}
          </h2>
          <IconButton aria-label="Close" title="Close" data-testid="chats-share-close" onClick={props.onClose}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="sr-only" htmlFor={`${id}-email`}>
            Add a member by email
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${id}-email`}
              data-testid="chats-share-email"
              type="email"
              autoFocus
              value={email}
              disabled={props.blocked}
              maxLength={320}
              placeholder="name@example.com"
              spellCheck={false}
              onChange={(event) => setEmail(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-60"
            />
            <PrimaryButton type="submit" data-testid="chats-share-submit" disabled={busy || props.blocked || !typed}>
              Add
            </PrimaryButton>
          </div>
          <div
            role="radiogroup"
            aria-label="Access"
            onKeyDown={group.onKeyDown}
            className="flex self-start rounded-lg border border-line bg-panel-2 p-0.5"
          >
            {ACCESS.map((option, index) => (
              <button
                key={option.value}
                {...group.radio(index)}
                data-testid={option.value === "view" ? "chats-share-readonly" : "chats-share-canpost"}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                  access === option.value ? "bg-bg text-ink shadow-sm" : "text-muted enabled:hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </form>
        {props.readFailure || props.members.length > 0 ? (
          <div className="flex flex-col gap-2">
            {props.members.length > 0 ? (
              <h3 className="dohc-section-label m-0">Members · {props.members.length}</h3>
            ) : null}
            {props.readFailure ? (
              <ShareReadFailureNotice
                testId="chats-share-members-unreadable"
                failure={props.readFailure}
                stale={props.members.length > 0}
                onRetry={props.onRetryRead}
                className="rounded-lg bg-panel-2 px-3 py-2"
              />
            ) : null}
            {props.members.length > 0 ? (
              <ul className="-mx-2 my-0 max-h-80 list-none overflow-y-auto p-0 [&_:focus-visible]:-outline-offset-2">
                {props.members.map((member) => (
                  <li
                    key={member.shareId}
                    data-testid="chats-share-member"
                    className="group flex h-8 items-center gap-2 rounded-md px-2 hover:bg-hover"
                  >
                    <ChatAvatar presentation={neutralPresentation} name={member.recipientEmail ?? "?"} kind="human" size="strip" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={member.recipientEmail ?? undefined}>
                      {member.recipientEmail ?? "Invited"}
                    </span>
                    {member.access === "read-only" ? (
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                        <Eye size={12} aria-hidden />
                        View only
                      </span>
                    ) : null}
                    <GhostButton
                      data-testid="chats-share-revoke"
                      aria-label={`Remove ${member.recipientEmail ?? "the invited person"}`}
                      onClick={() => props.onRemove(member)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      Remove
                    </GhostButton>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Overlay>
  );
}
