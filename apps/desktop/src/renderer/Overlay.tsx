import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
// panel that swallows clicks. Used by the command palette, quick-open, new
// file dialog, cloud panel, and plugin uninstall dialog so close/backdrop
// behavior — and this keyboard behavior — stays identical everywhere.
export function Overlay(props: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  // A ref, not a dependency, so Escape and Tab always call this render's
  // onClose even though the keydown listener itself is only ever attached
  // once (CodeRabbit #779 R32).
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    function focusableElements(): HTMLElement[] {
      const panel = panelRef.current;
      return panel ? [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)] : [];
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const insidePanel = active !== null && panelRef.current?.contains(active);
      if (event.shiftKey) {
        if (!insidePanel || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!insidePanel || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div
      data-dohc-modal="true"
      className="fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-black/20 p-4 pt-24 backdrop-blur-[1.5px]"
      onClick={props.onClose}
    >
      <div
        ref={panelRef}
        className="dohc-pop-in"
        onClick={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}
