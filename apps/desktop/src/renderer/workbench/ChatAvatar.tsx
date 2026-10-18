import { useSyncExternalStore } from "react";
import { Sparkles, Zap } from "lucide-react";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { presentationClasses, subscribePresentation } from "./actorPresentation";

// One avatar for every chat surface: a person's initials on a tint of their
// admitted hue, the agent's sparkle in the agent voice, or an automation's bare
// lightning mark, the same mark as the Automations button. Sized by the
// caller; 36px in the composer, 32px on a feed row or an opening post, 28px
// on a comment, 18px in a strip.

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

// The first letter of the first two words. One word gives one letter.
function initials(name: string): string {
  const letters = name.trim().split(/\s+/, 2).flatMap((word) => firstGrapheme(word) ?? []);
  return letters.length ? letters.join("").toUpperCase() : "?";
}

export function ChatAvatar(props: {
  name: string;
  kind: "human" | "agent" | "automation";
  presentation: ActorPresentation;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const size = props.size ?? "post";
  const kind = props.kind;
  const classes = useSyncExternalStore(subscribePresentation, () =>
    presentationClasses(props.presentation, kind === "agent" ? "agent" : "human"));
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
      className={`inline-grid shrink-0 place-items-center border font-mono font-semibold ${
        SIZES[size]
      } ${
        agent
          ? `${AGENT_RADIUS[size]} ${classes}`
          : `rounded-full border-line ${classes}`
      } ${props.className ?? ""}`}
    >
      {agent ? <Sparkles size={ICON[size]} strokeWidth={1.9} aria-hidden /> : initials(props.name)}
    </span>
  );
}
