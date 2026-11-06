import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plug, Sparkles } from "lucide-react";
import type { ActorPresentation, ChatReportedAgentRecord } from "../../ipc/bridgeContract";
import { listAgents, type DesktopUserSettings } from "../../settings/userSettings";
import { AGENT_TOOLS, launchCommand } from "../../agents/agentToolCatalog";
import { useAgentInk } from "./ChatAvatar";
import { AS_REPORTED, reportedAgentLine } from "./reportedAgent";
import { resolveFloatingMenuPosition } from "../editor/floatingMenuPosition";

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
  authorReported?: ChatReportedAgentRecord;
  // Your agent's run records its id. A name an agent gives itself never makes it yours.
  authorAgentId?: string;
  // An agent that signed in with a share link: no owner here, and the default agent color.
  linkAgent?: boolean;
};

export function AgentBadge(props: {
  testIdPrefix: string;
  author: AgentAuthor;
  // The agent's token where its avatar shows, so the sparkle takes the avatar's hue.
  // Its `self` says the message is your person's, which a name alone never proves.
  presentation?: ActorPresentation;
  // What shows in place of the sparkle, such as the agent's face, which
  // then says whose agent it is on hover or focus.
  children?: ReactNode;
}) {
  const settings = useContext(AgentSettingsContext);
  const ink = useAgentInk(props.author.linkAgent ? undefined : props.presentation);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  // A connected agent wrote outside a run dohc started: the plug, and a card
  // that names it as reported. A share's agent post could be either kind, so
  // it takes the plug and its card claims no kind.
  const plug = props.presentation?.connected;
  const connected = plug === true;
  const label = connected ? "connected agent" : "agent";
  const Mark = plug ? Plug : Sparkles;
  const ownAgent = !plug && props.presentation?.self && settings && author.authorAgentId
    ? listAgents(settings).find(({ id }) => id === author.authorAgentId) ?? null
    : null;
  // Only your agent runs on this computer, so only its card names how: its
  // tool, or your runner command. The full command is the line's tooltip.
  const launch = ownAgent?.launch;
  const command = launch ? launchCommand(launch) : undefined;
  const runsWith = !launch ? undefined : "tool" in launch
    ? `${AGENT_TOOLS.find((tool) => tool.id === launch.tool)?.name ?? "Its tool"} on this computer`
    : "Your runner command";
  const reported = reportedAgentLine(author.authorReported);
  const trigger = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof resolveFloatingMenuPosition> | null>(null);
  useLayoutEffect(() => {
    const badge = trigger.current;
    const card = tooltip.current;
    if (!open || !badge || !card) return;
    // Like Menu and the reaction picker, use the top layer to escape each
    // virtualized feed row's paint containment.
    card.showPopover?.();
    const position = (event?: Event) => {
      if (event?.target instanceof Node && card.contains(event.target)) return;
      setPlace(resolveFloatingMenuPosition({
        cursorRect: badge.getBoundingClientRect(),
        menuWidth: card.offsetWidth,
        menuMaxHeight: card.scrollHeight + card.offsetHeight - card.clientHeight,
        margin: 4,
        gap: 4,
        // Above, so it covers neither the agent's message nor the box under it.
        prefer: "above",
      }));
    };
    position();
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      setPlace(null);
    };
  }, [open, reported, command]);
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
        ref={trigger}
        data-testid={`${props.testIdPrefix}-agent-badge`}
        data-chat-escape-local="true"
        tabIndex={0}
        aria-label={label}
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
        {props.children ?? <Mark size={12} strokeWidth={1.9} aria-hidden />}
        <span className="sr-only">{label}</span>
      </span>
      {open ? (
        <span
          ref={tooltip}
          id={descriptionId}
          popover="manual"
          role="tooltip"
          style={{
            margin: 0,
            inset: "auto",
            left: place?.x,
            top: place?.bottom === undefined ? place?.y : "auto",
            bottom: place?.bottom ?? "auto",
            maxHeight: place?.maxHeight,
          }}
          className="dohc-popover dohc-pop-in fixed z-50 flex w-max max-w-72 flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink"
        >
          <span className="font-medium">
            {author.authorDisplayName}
            {plug ? <span className="text-muted"> {AS_REPORTED}</span> : null}
          </span>
          {author.linkAgent || plug === "unknown" ? null : (
            <span className="text-muted">
              {connected ? "Connected agent"
                : author.authorOwnerDisplayName ? `Owned by ${author.authorOwnerDisplayName}` : "Owner name unavailable"}
            </span>
          )}
          {runsWith ? <span data-testid={`${props.testIdPrefix}-agent-runs-with`} title={command} className="text-muted">{runsWith}</span> : null}
          {reported ? (
            <span data-testid={`${props.testIdPrefix}-agent-reported`} className="wrap-anywhere text-muted">
              {reported.slice(0, -AS_REPORTED.length)}<span className="whitespace-nowrap">{AS_REPORTED}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
