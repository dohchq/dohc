import { Check, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";

// One step in a short gated sequence (join a synced workspace, open a
// share). A numbered marker, a title, and a body rendered only while the
// step is current. Done steps show a check and one line of what was
// decided; pending steps show the title dimmed.
export function Step(props: {
  number: number;
  title: string;
  state: "done" | "current" | "pending";
  summary?: string;
  last?: boolean;
  children?: ReactNode;
}) {
  const marker =
    props.state === "done"
      ? "border-success bg-panel text-success"
      : props.state === "current"
        ? "border-ink bg-ink text-bg"
        : "border-line bg-panel text-subtle";
  return (
    <div className={`relative grid grid-cols-[24px_1fr] gap-x-3 ${props.last ? "" : "pb-5"}`}>
      {props.last ? null : (
        <span aria-hidden className="absolute bottom-0 left-[11.5px] top-7 w-px bg-line" />
      )}
      <span
        aria-hidden
        className={`grid size-6 place-items-center rounded-full border font-mono text-[11px] font-medium ${marker}`}
      >
        {props.state === "done" ? <Check size={12} strokeWidth={2.4} /> : props.number}
      </span>
      <div className="flex min-w-0 flex-col gap-2 pt-0.5">
        <span
          className={`text-[13px] leading-5 ${
            props.state === "pending" ? "font-medium text-subtle" : "font-semibold text-ink"
          }`}
        >
          {props.title}
        </span>
        {props.state === "done" && props.summary ? (
          <span className="truncate font-mono text-[12px] text-muted">{props.summary}</span>
        ) : null}
        {props.state === "current" ? props.children : null}
      </div>
    </div>
  );
}

// The folder picker chip shared by every step that needs an empty folder:
// icon, the chosen path in the OS's own spelling, and a Browse or Change
// affordance so it reads as a control at rest.
export function FolderChip(props: {
  folder: string | null;
  placeholder: string;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.folder ? "Change folder" : "Choose folder"}
      onClick={props.onClick}
      className="group flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-bg px-3 text-left transition-colors hover:border-ink"
    >
      <FolderOpen size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
      <code
        className={`min-w-0 flex-1 truncate font-mono text-[13px] leading-snug group-hover:text-ink ${
          props.folder ? "text-ink" : "text-subtle"
        }`}
      >
        {props.folder ?? props.placeholder}
      </code>
      <span aria-hidden className="shrink-0 text-[11px] text-subtle group-hover:text-ink">
        {props.folder ? "Change" : "Browse"}
      </span>
    </button>
  );
}
