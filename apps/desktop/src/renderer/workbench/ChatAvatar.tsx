import { Sparkles } from "lucide-react";
import { IDENTITY_HUES, type IdentityHue } from "../tokens";

// One avatar for every chat surface: a person's initials on a tint of their
// own hue, or the agent's sparkle in the olive voice. Sized by the caller;
// 36px on a post, 28px on a comment, 18px in a strip.

const SIZES = {
  post: "size-9 text-[14px]",
  comment: "size-7 text-[11px]",
  strip: "size-[18px] text-[9px]",
} as const;

const ICON = { post: 16, comment: 12, strip: 10 } as const;

// Spelled out so Tailwind sees every class.
const HUE_CLASSES: Record<IdentityHue, string> = {
  rust: "bg-hue-rust/15 text-hue-rust",
  amber: "bg-hue-amber/15 text-hue-amber",
  olive: "bg-hue-olive/15 text-hue-olive",
  teal: "bg-hue-teal/15 text-hue-teal",
  blue: "bg-hue-blue/15 text-hue-blue",
  indigo: "bg-hue-indigo/15 text-hue-indigo",
  plum: "bg-hue-plum/15 text-hue-plum",
  rose: "bg-hue-rose/15 text-hue-rose",
};

// FNV-1a over the display name, the one key every surface has, so a person
// keeps one hue from the rail to their posts.
export function identityHue(key: string): IdentityHue {
  let hash = 0x811c9dc5;
  for (const char of key) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return IDENTITY_HUES[(hash >>> 0) % IDENTITY_HUES.length];
}

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
  kind: "human" | "agent";
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const size = props.size ?? "post";
  const agent = props.kind === "agent";
  return (
    <span
      aria-hidden
      title={props.name}
      className={`inline-grid shrink-0 place-items-center rounded-full border font-mono font-semibold ${
        SIZES[size]
      } ${
        agent
          ? "border-agent/50 bg-bg text-agent"
          : `border-line ${HUE_CLASSES[identityHue(props.name)]}`
      } ${props.className ?? ""}`}
    >
      {agent ? <Sparkles size={ICON[size]} strokeWidth={1.9} aria-hidden /> : initials(props.name)}
    </span>
  );
}
