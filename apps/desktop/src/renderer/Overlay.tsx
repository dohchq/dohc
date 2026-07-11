import type { ReactNode } from "react";

// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
// panel that swallows clicks. Used by the command palette, quick-open, new
// file dialog, and cloud panel so close/backdrop behavior stays identical.
export function Overlay(props: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      data-dohc-modal="true"
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-black/20 p-4 pt-24 backdrop-blur-[1.5px]"
      onClick={props.onClose}
    >
      <div className="dohc-pop-in" onClick={(event) => event.stopPropagation()}>
        {props.children}
      </div>
    </div>
  );
}
