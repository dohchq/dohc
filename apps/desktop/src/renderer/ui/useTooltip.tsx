import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * Words for a mark that has none of its own, such as a ⚡. They show while
 * the pointer is over the mark or its words, or while the mark's control has
 * focus, and Escape hides them.
 *
 * `hoverProps` go on an element that holds both the mark and the words, so
 * moving onto the words keeps them open. `focusProps` go on the control that
 * takes focus, and name the words as its description.
 */
export function useTooltip() {
  const id = useId();
  const [open, setOpen] = useState(false);
  return {
    hoverProps: {
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
    },
    focusProps: {
      "aria-describedby": id,
      onFocus: () => setOpen(true),
      onBlur: () => setOpen(false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape" || !open) return;
        // Escape closes the words, not the surface around them.
        event.stopPropagation();
        setOpen(false);
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
