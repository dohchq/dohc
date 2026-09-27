import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { configuredRunnerCommand } from "../../agents/agentToolCatalog";

export const AgentSettingsContext = createContext<DesktopUserSettings | null>(null);

type YourNames = Pick<DesktopUserSettings["profile"], "preferredName" | "agentName">;
// Your names alone. Every settings save is a new settings object, and the
// chat lists that ask whose message it is must not render again for a save
// that leaves the names as they were.
const YourNamesContext = createContext<YourNames>({});

export function AgentSettingsProvider(props: {
  settings: DesktopUserSettings | null;
  children: ReactNode;
}) {
  const preferredName = props.settings?.profile.preferredName;
  const agentName = props.settings?.profile.agentName;
  const names = useMemo(() => ({ preferredName, agentName }), [preferredName, agentName]);
  return (
    <AgentSettingsContext.Provider value={props.settings}>
      <YourNamesContext.Provider value={names}>{props.children}</YourNamesContext.Provider>
    </AgentSettingsContext.Provider>
  );
}

type AgentAuthor = {
  authorDisplayName: string;
  authorOwnerDisplayName?: string;
  authorUserId?: string;
};

/**
 * Whether you, or your agent, wrote a message. A signed-in message carries
 * the verified id of the person who sent it, or who owns the agent that did.
 * A signed-out message was written on this computer, so its names decide:
 * the names main records, which default to "You" and "Agent".
 */
export function isOwnAuthor(
  kind: "human" | "agent",
  author: AgentAuthor,
  viewerAuthorId: string | undefined,
  profile: YourNames | undefined,
): boolean {
  if (author.authorUserId) return author.authorUserId === viewerAuthorId;
  const yourName = profile?.preferredName ?? "You";
  return kind === "human"
    ? author.authorDisplayName === yourName
    : author.authorDisplayName === (profile?.agentName ?? "Agent") &&
      author.authorOwnerDisplayName === yourName;
}

/** isOwnAuthor with this window's names, the same function until they change. */
export function useIsOwnAuthor(): (
  kind: "human" | "agent" | "automation",
  author: AgentAuthor,
  viewerAuthorId: string | undefined,
) => boolean {
  const names = useContext(YourNamesContext);
  return useCallback(
    (kind, author, viewerAuthorId) =>
      kind !== "automation" && isOwnAuthor(kind, author, viewerAuthorId, names),
    [names],
  );
}

export function AgentBadge(props: {
  testIdPrefix: string;
  author: AgentAuthor;
  viewerAuthorId?: string;
}) {
  const settings = useContext(AgentSettingsContext);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  const ownAgent = isOwnAuthor("agent", author, props.viewerAuthorId, settings?.profile);
  const command = ownAgent && settings ? configuredRunnerCommand(settings.runner) : undefined;
  return (
    <span
      className="relative inline-flex text-agent"
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
          {command ? <span className="break-all font-mono text-[11px] text-muted">Current local command: {command}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
