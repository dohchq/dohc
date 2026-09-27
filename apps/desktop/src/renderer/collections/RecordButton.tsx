import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import type { IrreversibleAction } from "@dohc/automation-executor/automation-buttons";
import { useButtonView, type AutomationButtons } from "./useAutomationButtons";

// One Button field on one record: a native button named for the field and
// the record. A button that cannot run says why in its description, which a
// pointer sees on hover and the keyboard sees on focus. The words sit in the
// page's body, outside table rows that move by transform and cells that
// clip, and stay inside the window.
//
// A button whose run changes what dohc cannot undo, such as a dataset action,
// asks first in the same place: Run runs it, and Cancel or Escape returns to
// the button (AGENTS.md: warn before an irreversible action runs).

const EDGE = 8;
const GAP = 4;
const list = new Intl.ListFormat("en", { type: "conjunction" });

export function RecordButton(props: {
  buttons: AutomationButtons;
  field: string;
  recordId: string;
  /** The record's name, as in "Mark paid for Invoice 12". */
  recordLabel: string;
}) {
  const { state, running, note } = useButtonView(props.buttons, props.field, props.recordId);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const words = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0, visibility: "hidden" });
  // Focus that a click gives shows nothing, as for any control.
  const pointer = useRef(false);
  const description = note ?? (state !== null && state.kind !== "ready" ? state.reason : null);
  const blocked = running || state === null || state.kind !== "ready";
  const irreversible = state?.kind === "ready" ? state.irreversible ?? [] : [];
  const [asking, setAsking] = useState<readonly IrreversibleAction[] | null>(null);
  const confirmId = useId();
  const warningId = useId();
  const open = asking !== null || (description !== null && (hovered || focused));
  const run = useRef<HTMLButtonElement>(null);
  const press = (confirmed: readonly IrreversibleAction[] = []) => void props.buttons.press(props.field, { id: props.recordId, label: props.recordLabel }, undefined, confirmed.map((action) => action.name));
  // Closing the question gives focus back to the button when focus was in
  // it, so it never falls to the page.
  const stopAsking = () => {
    const inside = words.current?.contains(document.activeElement) ?? false;
    setAsking(null);
    if (inside || document.activeElement === document.body) button.current?.focus();
  };
  // The question is about the actions it named: when the button can no
  // longer run, or would run other actions, it goes away.
  const warned = irreversible.map((action) => action.name).join("\u0000");
  useEffect(() => {
    if (asking !== null && (blocked || asking.map((action) => action.name).join("\u0000") !== warned)) stopAsking();
  }, [blocked, warned]);
  useEffect(() => {
    if (asking !== null) run.current?.focus();
  }, [asking !== null]);

  useLayoutEffect(() => {
    if (!open || !button.current || !words.current) return;
    const anchor = button.current.getBoundingClientRect();
    const size = words.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - size.width - EDGE));
    const below = anchor.bottom + GAP;
    const top = below + size.height + EDGE <= window.innerHeight ? below : Math.max(EDGE, anchor.top - GAP - size.height);
    setPlace({ position: "fixed", left, top });
  }, [open, description, asking !== null]);

  useEffect(() => {
    if (!open) {
      setPlace({ position: "fixed", left: 0, top: 0, visibility: "hidden" });
      return;
    }
    // Words placed from the button's box would drift as the page moves, so they close.
    const close = () => {
      setHovered(false);
      setFocused(false);
      if (asking !== null) stopAsking();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, asking !== null]);

  return (
    <span className="inline-flex min-w-0 max-w-full" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <SecondaryButton
        ref={button}
        size="row"
        aria-label={`${props.field} for ${props.recordLabel}`}
        aria-disabled={blocked || undefined}
        aria-busy={running || undefined}
        aria-describedby={description === null ? undefined : id}
        onPointerDown={() => {
          pointer.current = true;
        }}
        onFocus={() => {
          if (!pointer.current) setFocused(true);
          pointer.current = false;
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          // A held key presses once.
          if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
          if (event.key === "Escape" && open && asking === null) {
            // Escape closes the words, not the surface around the button.
            event.stopPropagation();
            setFocused(false);
            setHovered(false);
          }
        }}
        aria-expanded={irreversible.length === 0 ? undefined : asking !== null}
        aria-controls={asking !== null ? confirmId : undefined}
        onClick={() => {
          if (blocked) return;
          if (irreversible.length === 0) press();
          else setAsking((current) => (current === null ? irreversible : null));
        }}
      >
        {/* An invisible copy of the label, with room for the spinner, sits under the label, so the button keeps its width while it runs. */}
        <span data-label={props.field} className="grid min-w-0 grid-cols-1 before:invisible before:col-start-1 before:row-start-1 before:min-w-0 before:truncate before:pl-4 before:content-[attr(data-label)]">
          <span className="col-start-1 row-start-1 flex min-w-0 items-center justify-center gap-1">
            {running ? <LoaderCircle aria-hidden size={12} strokeWidth={1.9} className="shrink-0 animate-spin" /> : null}
            <span className="truncate">{props.field}</span>
          </span>
        </span>
      </SecondaryButton>
      {asking !== null ? createPortal(
        <span
          ref={words}
          id={confirmId}
          role="dialog"
          aria-label={`Run ${props.field} for ${props.recordLabel}`}
          aria-describedby={warningId}
          style={place}
          onKeyDown={(event) => {
            // A held key opened the question; it does not answer it.
            if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
            // Tab stays in the question, which sits at the end of the page.
            if (event.key === "Tab") {
              const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button")];
              const at = controls.indexOf(document.activeElement as HTMLElement);
              const next = controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
              if (next) {
                event.preventDefault();
                next.focus();
              }
            }
            if (event.key === "Escape") {
              event.stopPropagation();
              stopAsking();
            }
          }}
          onBlur={(event) => {
            // Focus that leaves both the question and its button answers Cancel.
            const next = event.relatedTarget;
            if (next instanceof Node && (event.currentTarget.contains(next) || next === button.current)) return;
            if (next === null) stopAsking();
            else setAsking(null);
          }}
          className="dohc-popover dohc-pop-in z-50 flex w-max max-w-64 flex-col gap-2 rounded-lg border border-line bg-panel p-2 text-left text-[12px] font-normal text-ink"
        >
          <span id={warningId}>{list.format(asking.map((action) => action.label))} can't be undone.</span>
          <span className="flex justify-end gap-1.5">
            <SecondaryButton size="compact" onClick={stopAsking}>Cancel</SecondaryButton>
            <PrimaryButton ref={run} size="compact" onClick={() => {
              const confirmed = asking;
              setAsking(null);
              button.current?.focus();
              if (!blocked) press(confirmed);
            }}>Run</PrimaryButton>
          </span>
        </span>,
        document.body,
      ) : description === null ? null : createPortal(
        <span
          ref={words}
          id={id}
          role="tooltip"
          hidden={!open}
          style={place}
          className="dohc-popover dohc-pop-in z-50 w-max max-w-64 rounded-lg border border-line bg-panel px-2 py-1 text-left text-[12px] font-normal text-ink"
        >
          {description}
        </span>,
        document.body,
      )}
    </span>
  );
}
