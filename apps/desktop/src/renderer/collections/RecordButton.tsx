import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { SecondaryButton } from "../ui/controls";
import { useButtonView, type AutomationButtons } from "./useAutomationButtons";

// One Button field on one record: a native button named for the field and
// the record. A button that cannot run says why in its description, which a
// pointer sees on hover and the keyboard sees on focus. The words sit in the
// page's body, outside table rows that move by transform and cells that
// clip, and stay inside the window.

const EDGE = 8;
const GAP = 4;

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
  const open = description !== null && (hovered || focused);

  useLayoutEffect(() => {
    if (!open || !button.current || !words.current) return;
    const anchor = button.current.getBoundingClientRect();
    const size = words.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - size.width - EDGE));
    const below = anchor.bottom + GAP;
    const top = below + size.height + EDGE <= window.innerHeight ? below : Math.max(EDGE, anchor.top - GAP - size.height);
    setPlace({ position: "fixed", left, top });
  }, [open, description]);

  useEffect(() => {
    if (!open) {
      setPlace({ position: "fixed", left: 0, top: 0, visibility: "hidden" });
      return;
    }
    // Words placed from the button's box would drift as the page moves, so they close.
    const close = () => {
      setHovered(false);
      setFocused(false);
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
  }, [open]);

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
          if (event.key === "Escape" && open) {
            // Escape closes the words, not the surface around the button.
            event.stopPropagation();
            setFocused(false);
            setHovered(false);
          }
        }}
        onClick={() => {
          if (!blocked) void props.buttons.press(props.field, { id: props.recordId, label: props.recordLabel });
        }}
      >
        {running ? <LoaderCircle aria-hidden size={12} strokeWidth={1.9} className="shrink-0 animate-spin" /> : null}
        <span className="truncate">{props.field}</span>
      </SecondaryButton>
      {description === null ? null : createPortal(
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
