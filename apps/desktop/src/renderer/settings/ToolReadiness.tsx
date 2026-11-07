import { Check } from "lucide-react";
import type { ReactNode } from "react";

// One look for whether a tool can run an agent, in Add agent and on the
// Agents page: green with a check when it can, amber when a step comes first.
export type ReadinessTone = "ready" | "blocked" | "unknown";

const TONE: Record<ReadinessTone, string> = { ready: "text-success", blocked: "text-warning", unknown: "text-muted" };

export function ToolReadiness(props: { tone: ReadinessTone; className: string; children: ReactNode }) {
  return (
    <span className={`flex items-center gap-1 ${props.className} ${TONE[props.tone]}`}>
      {props.tone === "ready" ? <Check size={12} aria-hidden className="shrink-0" /> : null}
      {props.children}
    </span>
  );
}
