import type { ReactNode } from "react";

// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
// panel that swallows clicks. Used by the command palette, quick-open, new
// file dialog, and cloud panel so close/backdrop behavior stays identical.
export function Overlay(props: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-start justify-center bg-black/20 pt-24"
      onClick={props.onClose}
    >
      <div onClick={(event) => event.stopPropagation()}>{props.children}</div>
    </div>
  );
}
