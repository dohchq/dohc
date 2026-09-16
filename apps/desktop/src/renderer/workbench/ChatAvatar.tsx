import { Sparkles } from "lucide-react";

// One avatar for every chat surface: a person's initial in a ring, or the
// agent's sparkle in the olive voice. Sized by the caller; 36px on a post,
// 28px on a comment, 18px in a strip.

const SIZES = {
  post: "size-9 text-[14px]",
  comment: "size-7 text-[11px]",
  strip: "size-[18px] text-[9px]",
} as const;

const ICON = { post: 16, comment: 12, strip: 10 } as const;

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
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
          : "border-line bg-panel-2 text-muted"
      } ${props.className ?? ""}`}
    >
      {agent ? <Sparkles size={ICON[size]} strokeWidth={1.9} aria-hidden /> : initial(props.name)}
    </span>
  );
}
