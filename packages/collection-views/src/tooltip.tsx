import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Words for a mark that has none of its own, such as a ⚡. They show while
 * the pointer is over the mark or its words, or while the mark's control has
 * keyboard focus. Escape hides them wherever focus is. Hover and focus are
 * tracked apart, so leaving one keeps the words the other opened.
 *
 * `hoverProps` go on an element that holds both the mark and the words, so
 * moving onto the words keeps them open. `focusProps` go on the control that
 * takes focus, and name the words as its description.
 */
export function useTooltip() {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // A pointer press gives focus as a side effect, as when a click sorts a
  // column. That focus shows nothing.
  const pressed = useRef(false);
  const open = hovered || focused;
  const close = () => {
    setHovered(false);
    setFocused(false);
  };
  useEffect(() => {
    if (!open) return;
    // The pointer may have opened the words while focus is elsewhere.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return {
    hoverProps: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
    focusProps: {
      "aria-describedby": id,
      onPointerDown: () => {
        pressed.current = true;
      },
      onPointerUp: () => {
        pressed.current = false;
      },
      onFocus: () => {
        if (!pressed.current) setFocused(true);
        pressed.current = false;
      },
      onBlur: () => setFocused(false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape" || !open) return;
        // Escape on the mark's own control closes the words, not the surface around them.
        event.stopPropagation();
        close();
      },
    },
    tooltipProps: { id, open },
  };
}

/** The words, below the element that holds them, with no gap to cross. */
export function Tooltip(props: { id: string; open: boolean; children: ReactNode }) {
  return (
    <span id={props.id} role="tooltip" hidden={!props.open} className="absolute left-0 top-full z-20 pt-1">
      <span className="dohc-popover block w-max max-w-64 rounded-lg border border-line bg-panel px-2 py-1 text-left text-[12px] font-normal text-ink">
        {props.children}
      </span>
    </span>
  );
}
