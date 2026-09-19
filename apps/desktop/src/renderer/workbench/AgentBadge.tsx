import { createContext, useContext, useId, useState } from "react";
import { Sparkles } from "lucide-react";
import type { DesktopUserSettings } from "../../settings/userSettings";

export const AgentSettingsContext = createContext<DesktopUserSettings | null>(null);

type AgentAuthor = {
  authorDisplayName: string;
  authorOwnerDisplayName?: string;
  authorUserId?: string;
};

export function AgentBadge(props: {
  testIdPrefix: string;
  author: AgentAuthor;
  viewerAuthorId?: string;
}) {
  const settings = useContext(AgentSettingsContext);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  const ownAgent = author.authorUserId
    ? author.authorUserId === props.viewerAuthorId
    : author.authorDisplayName === settings?.profile.agentName &&
      author.authorOwnerDisplayName === (settings?.profile.preferredName ?? "You");
  const command = ownAgent ? settings?.runner.command.trim() : undefined;
  return (
    <span
      className="relative inline-flex text-agent"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        data-testid={`${props.testIdPrefix}-agent-badge`}
        data-chat-escape-local="true"
        tabIndex={0}
        aria-label="agent"
        aria-describedby={open ? descriptionId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className="inline-flex rounded font-mono text-[10px]"
      >
        <Sparkles size={12} strokeWidth={1.9} aria-hidden />
        <span className="sr-only">agent</span>
      </span>
      {open ? (
        <span
          id={descriptionId}
          role="tooltip"
          className="dohc-popover dohc-pop-in absolute left-0 top-full z-50 mt-1 flex w-max max-w-72 flex-col gap-1 rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink"
        >
          <span className="font-medium">{author.authorDisplayName}</span>
          <span className="text-muted">
            {author.authorOwnerDisplayName ? `Owned by ${author.authorOwnerDisplayName}` : "Owner name unavailable"}
          </span>
          {command ? <span className="break-all font-mono text-[11px] text-muted">{command}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
