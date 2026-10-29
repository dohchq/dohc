import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { ownAgentNamed, type DesktopUserSettings } from "../../settings/userSettings";
import { launchCommand } from "../../agents/agentToolCatalog";
import { useAgentInk } from "./ChatAvatar";

export const AgentSettingsContext = createContext<DesktopUserSettings | null>(null);

export function AgentSettingsProvider(props: {
  settings: DesktopUserSettings | null;
  children: ReactNode;
}) {
  return <AgentSettingsContext.Provider value={props.settings}>{props.children}</AgentSettingsContext.Provider>;
}

type AgentAuthor = {
  authorDisplayName: string;
  authorOwnerDisplayName?: string;
  authorUserId?: string;
};

export function AgentBadge(props: {
  testIdPrefix: string;
  author: AgentAuthor;
  // The agent's token where its avatar shows, so the sparkle takes the avatar's hue.
  // Its `self` says the message is your person's, which a name alone never proves.
  presentation?: ActorPresentation;
}) {
  const settings = useContext(AgentSettingsContext);
  const ink = useAgentInk(props.presentation);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  const ownAgent = props.presentation?.self && settings ? ownAgentNamed(settings, author.authorDisplayName) : null;
  const command = ownAgent?.launch ? launchCommand(ownAgent.launch) : undefined;
  return (
    <span
      className={`relative inline-flex ${ink}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onClick={(event) => {
        event.stopPropagation();
        setOpen(true);
      }}
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
        className="inline-flex rounded"
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
          {command ? <span className="break-all text-[11px] text-muted">Current local command: <code className="font-mono">{command}</code></span> : null}
        </span>
      ) : null}
    </span>
  );
}
