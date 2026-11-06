import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { ActorPresentation, ChatReportedAgentRecord } from "../../ipc/bridgeContract";
import { ownAgentNamed, type DesktopUserSettings } from "../../settings/userSettings";
import { launchCommand } from "../../agents/agentToolCatalog";
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
  const ink = useAgentInk(props.presentation);
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  const ownAgent = props.presentation?.self && settings ? ownAgentNamed(settings, author.authorDisplayName) : null;
  const command = ownAgent?.launch ? launchCommand(ownAgent.launch) : undefined;
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
    setPlace(resolveFloatingMenuPosition({
      cursorRect: badge.getBoundingClientRect(),
      menuWidth: card.offsetWidth,
      menuMaxHeight: card.offsetHeight,
      margin: 4,
      gap: 4,
    }));
    const close = (event: Event) => {
      if (event.target instanceof Node && card.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
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
        {props.children ?? <Sparkles size={12} strokeWidth={1.9} aria-hidden />}
        <span className="sr-only">agent</span>
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
            top: place?.bottom === undefined ? place?.y : undefined,
            bottom: place?.bottom,
            maxHeight: place?.maxHeight,
          }}
          className="dohc-popover dohc-pop-in fixed z-50 flex w-max max-w-72 flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink"
        >
          <span className="font-medium">{author.authorDisplayName}</span>
          <span className="text-muted">
            {author.authorOwnerDisplayName ? `Owned by ${author.authorOwnerDisplayName}` : "Owner name unavailable"}
          </span>
          {reported ? (
            <span data-testid={`${props.testIdPrefix}-agent-reported`} className="wrap-anywhere text-muted">
              {reported.slice(0, -AS_REPORTED.length)}<span className="whitespace-nowrap">{AS_REPORTED}</span>
            </span>
          ) : null}
          {command ? <span className="break-all text-[11px] text-muted">Current local command: <code className="font-mono">{command}</code></span> : null}
        </span>
      ) : null}
    </span>
  );
}
