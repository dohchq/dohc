import { useSyncExternalStore, type ReactNode } from "react";
import { Link2, Sparkles, Zap } from "lucide-react";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { agentTextClass, presentationClasses, subscribePresentation } from "./actorPresentation";

/** An agent's name or mark in its avatar's hue, repainting with it. Olive without a token. */
export function useAgentInk(token: ActorPresentation | undefined): string {
  return useSyncExternalStore(subscribePresentation, () => token ? agentTextClass(token) : "text-agent");
}

type ChatAuthorKind = "human" | "agent" | "automation" | "link";

/** An author's name beside their avatar: an agent's in its avatar's hue, anyone else's as it is. */
export function AgentName(props: { kind: ChatAuthorKind; presentation: ActorPresentation; children: ReactNode }) {
  const ink = useAgentInk(props.kind === "agent" ? props.presentation : undefined);
  return props.kind === "agent" ? <span className={ink}>{props.children}</span> : <>{props.children}</>;
}

// One avatar for every chat surface: a person's initial on a tint of their
// admitted hue, the agent's sparkle in the agent voice, an automation's bare
// lightning mark, the same mark as the Automations button, or a link holder's
// initial in a share link's dashed ring. Sized by the caller; 36px in the
// composer, 32px on a feed row or an opening post, 28px on a comment, 18px in
// a strip.

const SIZES = {
  post: "size-9 text-[14px]",
  row: "size-8 text-[13px]",
  comment: "size-7 text-[11px]",
  strip: "size-[18px] text-[9px]",
} as const;

const ICON = { post: 16, row: 14, comment: 12, strip: 10 } as const;

// An agent is a rounded square and a person is round, whatever their colors.
// The drawing rounds a 28px square by 8px; an 18px strip takes 4px.
const AGENT_RADIUS = { post: "rounded-lg", row: "rounded-lg", comment: "rounded-lg", strip: "rounded" } as const;

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function firstGrapheme(word: string): string | undefined {
  return segmenter
    ? segmenter.segment(word)[Symbol.iterator]().next().value?.segment
    : Array.from(word)[0];
}

// The first letter of a name.
function initial(name: string): string {
  return firstGrapheme(name.trim())?.toUpperCase() ?? "?";
}

export function ChatAvatar(props: {
  name: string;
  kind: ChatAuthorKind;
  presentation: ActorPresentation;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const size = props.size ?? "post";
  const kind = props.kind;
  const classes = useSyncExternalStore(subscribePresentation, () =>
    presentationClasses(props.presentation, kind === "agent" ? "agent" : "human"));
  if (kind === "link") {
    // A link holder has no account, so no identity color: only their name.
    return (
      <span
        aria-hidden
        data-author-kind="link"
        title={props.name}
        className={`inline-grid shrink-0 place-items-center rounded-full border border-dashed border-subtle bg-bg font-semibold text-muted ${
          SIZES[size]
        } ${props.className ?? ""}`}
      >
        {initial(props.name)}
      </span>
    );
  }
  if (kind === "automation") {
    // No border, fill, or identity color: an automation is not a person or an agent.
    return (
      <span
        aria-hidden
        title={props.name}
        className={`inline-grid shrink-0 place-items-center text-muted ${SIZES[size]} ${props.className ?? ""}`}
      >
        <Zap size={ICON[size]} strokeWidth={1.9} aria-hidden />
      </span>
    );
  }
  const agent = kind === "agent";
  return (
    <span
      aria-hidden
      title={props.name}
      className={`inline-grid shrink-0 place-items-center border font-semibold ${
        SIZES[size]
      } ${
        agent
          ? `${AGENT_RADIUS[size]} ${classes}`
          : `rounded-full border-line ${classes}`
      } ${props.className ?? ""}`}
    >
      {agent ? <Sparkles size={ICON[size]} strokeWidth={1.9} aria-hidden /> : initial(props.name)}
    </span>
  );
}

// Beside a link holder's name: the share link's mark, named for screen readers.
export function LinkHolderMark(props: { testId?: string }) {
  return (
    <span data-testid={props.testId} title="Link holder" className="inline-flex shrink-0 self-center text-subtle">
      <Link2 size={12} strokeWidth={1.9} aria-hidden />
      <span className="sr-only">Link holder</span>
    </span>
  );
}

// A share link has no face: a dashed ring around the link mark, at the strip size.
export function LinkMark() {
  return (
    <span
      aria-hidden
      className="inline-grid size-[18px] shrink-0 place-items-center rounded-full border border-dashed border-subtle text-subtle"
    >
      <Link2 size={10} />
    </span>
  );
}
