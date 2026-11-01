import { Clock, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { SecondaryButton } from "./controls";
import { useShownAfter } from "./useShownAfter";

// Save facts and access/view facts share this presentation map.
//
// The shape says what kind of state it is before the word is read. Filled
// means settled, a clock means settled but old, a ring means dohc is still
// working, a lock means the file is held and no edit is lost, a triangle
// means the person has to act. Nothing animates, so reduced motion needs no
// special case.
//
// A `Record` over the union, so a new state is a compile error here until it
// has a label, and every label is one it can defend from code (see
// StateMark.test.tsx for what each may claim).
export type StateMarkKind = "settled" | "dated" | "working" | "held" | "attention";

export type StatePresentation = {
  label: string;
  mark: StateMarkKind;
  // Absent where the label already says everything.
  title?: string;
};

export const DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE =
  "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/local/trash.";

// dohc cannot tell whether the original was moved or deleted, only that
// another file now has its path.
export const REPLACED_WITHOUT_SET_ASIDE_EDIT_NOTICE =
  "Another file replaced this file while you had it open. Close this tab to open the file now at this path.";

// The states a save chip can show. `recovery`, `read-only-transition`,
// `read-only-unavailable` and `too-large` are the shell's own, not the
// engine's: an unresolved set-aside draft beside a settled document, a
// document that went read-only under an edit, a live session that cannot
// take edits for a reason its own notice states, and a file the bounded read
// cut short so the editor is disabled.
export type SaveStateKey =
  | "saved" | "saving" | "error" | "saved-to-host" | "pending-share" | "file-locked" | "changed-on-disk"
  | "deleted" | "object-changed" | "read-only"
  | "recovery"
  | "reloaded"
  | "read-only-transition"
  | "read-only-unavailable"
  | "too-large";

export const SAVE_STATE: Record<SaveStateKey, StatePresentation> = {
  saved: { label: "Saved", mark: "settled" },
  "saved-to-host": {
    label: "Saved to host",
    mark: "working",
    title: "The server accepted your edits. The local file may still be updating.",
  },
  "pending-share": {
    label: "Saved locally · Pending share",
    mark: "working",
    title: "Your edits are saved on this device. The shared file update is pending.",
  },
  saving: { label: "Saving…", mark: "working" },
  error: {
    label: "Couldn't save",
    mark: "attention",
    title:
      "Your edits are still here, but dohc can't confirm the file on disk matches them. Keep this document open and try another edit.",
  },
  "file-locked": {
    label: "File in use",
    mark: "held",
    title:
      "Another program has this file open, so dohc can't update it on disk. dohc has your edits saved and retries until the file is free.",
  },
  "read-only": {
    label: "Read-only",
    mark: "held",
    title: "This document is shared with you to read.",
  },
  "read-only-transition": {
    label: "Read-only",
    mark: "attention",
    title: "This document became read-only. Your edit was set aside in the notice below.",
  },
  // No title: the cause (still opening, deleted, the engine may hold it,
  // invalid assets, a removal in progress) is stated by its own notice.
  "read-only-unavailable": { label: "Read-only", mark: "held" },
  "too-large": {
    label: "Read-only",
    mark: "held",
    title: "This file is too large to edit in dohc.",
  },
  // Shown for a moment after an open document took in a change made outside
  // dohc. Nothing in it was unsaved.
  reloaded: {
    label: "Reloaded",
    mark: "settled",
    title: "This file changed outside dohc. dohc opened the new version.",
  },
  "changed-on-disk": {
    label: "Changed outside dohc",
    mark: "attention",
    title: "This file changed outside dohc.",
  },
  deleted: {
    label: "Deleted",
    mark: "attention",
    title: DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  },
  "object-changed": {
    label: "Replaced",
    mark: "attention",
    title: REPLACED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  },
  recovery: {
    label: "Edit set aside",
    mark: "attention",
    title: "A set-aside edit is not saved. Copy or dismiss it in the notice below.",
  },
};

// How current a list of who has access is: the access answer's freshness.
// A list main checked within its refresh window is settled. A stale list is
// settled too, but old: no check is running for it. An empty list is never
// "no access", so unknown says so.
export type AccessStateKey = "access-fresh" | "access-stale" | "access-unknown";

export const ACCESS_STATE: Record<AccessStateKey, StatePresentation> = {
  "access-fresh": { label: "Checked", mark: "settled" },
  "access-stale": {
    label: "May be out of date",
    mark: "dated",
    title: "This is the last list of shares dohc received.",
  },
  "access-unknown": {
    label: "Unknown",
    mark: "attention",
    title: "Access information is unavailable for this file. This does not mean that no one has access.",
  },
};

const PRESENTATIONS: Record<SaveStateKey | AccessStateKey, StatePresentation> = { ...SAVE_STATE, ...ACCESS_STATE };

export function saveStatePresentationKey(state: SaveState): SaveStateKey | null {
  switch (state.kind) {
    case "saved-here": return "saved";
    case "unknown": return null;
    default: return state.kind;
  }
}

// Save states that need nothing from the person and pass on their own: an
// edit in flight, and an edit the file or its host has taken. Pending share
// is not one: it can last while the host is away, and until it ends
// collaborators do not have the edits.
const CALM: ReadonlySet<SaveStateKey | AccessStateKey> = new Set(["saved", "saving", "saved-to-host"]);

// A settle that beats the host's acknowledgement passes through pending share
// on its way to saved to host, so its words wait until it has lasted. A host
// that answers within this never makes the row flash; one that does not is
// away, and the person is told.
export const PENDING_SHARE_WORDS_DELAY_MS = 2_000;

const MARK_TONE: Record<StateMarkKind, string> = {
  settled: "text-subtle",
  dated: "text-subtle",
  working: "text-subtle",
  held: "text-muted",
  attention: "text-danger",
};

function Mark(props: { kind: StateMarkKind }) {
  switch (props.kind) {
    case "settled":
      return <span aria-hidden className="size-2 shrink-0 rounded-full bg-current" />;
    case "dated":
      return <Clock size={12} aria-hidden className="shrink-0" />;
    case "working":
      return <span aria-hidden className="size-2 shrink-0 rounded-full border-[1.5px] border-current" />;
    case "held":
      return <Lock size={12} aria-hidden className="shrink-0" />;
    case "attention":
      return <TriangleAlert size={12} aria-hidden className="shrink-0" />;
  }
}

/** A save-state chip: the mark for its kind, then the label. `state` is the
 * store's own value and lands in `data-state` unchanged, so tests and the
 * shell keep reading it. `shown` picks the row to draw when it differs from
 * the stored state, such as a disabled editor over a `saved` draft. `title`
 * replaces the row's title when the caller knows more, such as the engine's
 * own save error. `truncate` lets the label end in an ellipsis where room
 * runs out, such as a narrow file header. While the label is cut short, the
 * chip takes keyboard focus and shows the whole label and its explanation in
 * a tooltip, on focus or hover, in place of the title; with room to spare it
 * is not a tab stop and keeps its title. `quietWhenCalm` keeps a saved,
 * saving or saved-to-host chip for screen readers only: those pass on their
 * own, so typing never changes what the row draws. Words appear when the
 * file is held, a pending share has lasted (and then stay while the person
 * keeps typing), or the state needs the person. `onRetry` puts Try again
 * beside the chip, for a state the person can retry from the editor. */
export function StateMark(props: {
  state: string | SaveState;
  shown: SaveStateKey | AccessStateKey | SaveState;
  title?: string;
  testId: string;
  className?: string;
  truncate?: boolean;
  quietWhenCalm?: boolean;
  onRetry?: () => void;
}) {
  const storedKey = typeof props.shown === "string" ? props.shown : saveStatePresentationKey(props.shown);
  const quiet = props.quietWhenCalm === true;
  // Once a pending share has shown its words, they stay through the saves the
  // person's typing starts, until the share takes the edits or the state
  // otherwise resolves: each keystroke passes through saving, and dropping
  // the words there would hide them for as long as the person types.
  const [shareHeld, setShareHeld] = useState(false);
  const shownKey = quiet && shareHeld && storedKey === "saving" ? "pending-share" : storedKey;
  const pendingShareLasted = useShownAfter(quiet && shownKey === "pending-share", PENDING_SHARE_WORDS_DELAY_MS);
  useEffect(() => {
    if (pendingShareLasted) setShareHeld(true);
    else if (storedKey !== "pending-share" && storedKey !== "saving") setShareHeld(false);
  }, [pendingShareLasted, storedKey]);
  const presentation = shownKey === null ? null : PRESENTATIONS[shownKey];
  const title = props.title ?? presentation?.title;
  const { label, cut } = useCutShort(presentation?.label ?? "", props.truncate === true);
  const [open, setOpen] = useState(false);
  // A focused chip keeps its tab stop when its label stops being cut, so
  // focus never falls to the page; it gives the stop up on blur.
  const [focused, setFocused] = useState(false);
  const explanationId = useId();
  const shown = open && cut;
  const chipRef = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Placed as Menu places its list: measured before the first paint, under
  // the chip with its right edge at the chip's, and kept inside the window,
  // so no pane or panel edge cuts it off. Placed again while it shows,
  // whenever the window, the chip or the tooltip changes size.
  useLayoutEffect(() => {
    const chipElement = chipRef.current;
    if (!shown || !chipElement) return;
    const position = () => {
      const box = chipElement.getBoundingClientRect();
      const width = tooltip.current?.offsetWidth ?? 0;
      const left = Math.max(TOOLTIP_GAP_PX, Math.min(box.right - width, window.innerWidth - TOOLTIP_GAP_PX - width));
      const top = box.bottom + TOOLTIP_GAP_PX;
      setPlace((current) => (current?.left === left && current.top === top ? current : { left, top }));
    };
    position();
    window.addEventListener("resize", position);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(chipElement);
    if (tooltip.current) observer?.observe(tooltip.current);
    return () => {
      window.removeEventListener("resize", position);
      observer?.disconnect();
      setPlace(null);
    };
  }, [shown]);
  if (!presentation) return null;
  const dataState = typeof props.state === "string" ? props.state : props.state.kind === "unknown" ? "unknown" : saveStatePresentationKey(props.state);
  if (quiet && shownKey !== null && (CALM.has(shownKey) || (shownKey === "pending-share" && !pendingShareLasted))) {
    return <span data-testid={props.testId} data-state={dataState ?? undefined} title={title} className="sr-only">{presentation.label}</span>;
  }
  const chip = (
    <span
      ref={chipRef}
      data-testid={props.testId}
      data-state={dataState ?? undefined}
      // Cut short, the tooltip says what the title would, so the browser's
      // own tooltip does not repeat it a moment later.
      title={cut ? undefined : title}
      tabIndex={cut || focused ? 0 : undefined}
      // The chip's words are its label, so only the explanation describes it.
      aria-describedby={shown && title ? explanationId : undefined}
      onFocus={() => {
        setFocused(true);
        setOpen(true);
      }}
      onBlur={() => {
        setFocused(false);
        setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && shown) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      // A 16px line box: the 11px face's default is 16.5px, and a half-pixel
      // chip moves everything under it by half a pixel.
      className={`inline-flex items-center gap-1.5 text-[11px] leading-4 ${MARK_TONE[presentation.mark]} ${props.truncate ? "min-w-0 rounded" : ""} ${props.className ?? ""}`}
    >
      <Mark kind={presentation.mark} />
      {props.truncate ? (
        <span ref={label} className="min-w-0 truncate">
          {presentation.label}
        </span>
      ) : (
        presentation.label
      )}
    </span>
  );
  // One line at its natural width: the chip beside it gives way instead.
  const retry = props.onRetry ? (
    <SecondaryButton size="compact" data-testid={`${props.testId}-retry`} onClick={props.onRetry} className="shrink-0 whitespace-nowrap">
      Try again
    </SecondaryButton>
  ) : null;
  if (!props.truncate) return <>{chip}{retry}</>;
  // The tooltip sits beside the chip, not in it, so the chip's text stays its
  // label while the tooltip is open. Beside Try again, the chip keeps the
  // header's 28px for its mark and an ellipsis.
  const explained = (
    <span
      className={`inline-flex max-w-full ${retry ? "min-w-[28px]" : "min-w-0"}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
    >
      {chip}
      {shown ? (
        <span
          ref={tooltip}
          role="tooltip"
          style={place ?? undefined}
          className={`dohc-popover fixed z-50 flex w-max max-w-72 flex-col gap-1 rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink ${place ? "dohc-pop-in" : "invisible"}`}
        >
          <span className="font-medium">{presentation.label}</span>
          {title ? <span id={explanationId} className="text-muted">{title}</span> : null}
        </span>
      ) : null}
    </span>
  );
  return <>{explained}{retry}</>;
}

// Between the chip and its tooltip, and between the tooltip and the window's edge.
const TOOLTIP_GAP_PX = 4;

// Whether a truncating label is cut short now. Measured again when its box
// changes size or its words change.
function useCutShort(text: string, enabled: boolean) {
  const label = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = label.current;
    if (!enabled || !element) return;
    const measure = () => setCut(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, text]);
  return { label, cut };
}
