import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SentencePart } from "./automationSentence";

// Small parts the ⚡ panel and the builder share.

/** An automation's sentence: words, with formulas as code. */
export function Sentence({ parts }: { parts: readonly SentencePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "code" ? (
          <code key={index} className="rounded bg-panel-2 px-1 font-mono text-[11px] text-ink">{part.text}</code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** One status fact under an automation, with its mark. */
export function StatusLine(props: { tone: "muted" | "warning" | "danger"; icon: LucideIcon; label: string; children: ReactNode }) {
  const color = props.tone === "danger" ? "text-danger" : props.tone === "warning" ? "text-warning" : "text-subtle";
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
      <props.icon size={12} aria-label={props.label} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
