import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { isTopOverlay, pushOverlay, removeOverlay } from "./guestBlockingUi";
import { trapModalTabKey } from "./modalFocus";

// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
// panel that swallows clicks. Used by the command palette, quick-open, new
// file dialog, cloud panel, and plugin uninstall dialog so close/backdrop
// behavior — and this keyboard behavior — stays identical everywhere.
export function Overlay(props: {
  onClose: () => void;
  children: ReactNode;
  panelProps?: Omit<
    HTMLAttributes<HTMLDivElement>,
    "children" | "className" | "onClick" | "tabIndex"
  > & { "data-testid"?: string };
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // A ref, not a dependency, so Escape and Tab always call this render's
  // onClose even though the keydown listener itself is only ever attached
  // once (CodeRabbit #779 R32).
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const idRef = useRef(Symbol("overlay"));

  useEffect(() => {
    const id = idRef.current;
    pushOverlay(id);
    return () => removeOverlay(id);
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isTopOverlay(idRef.current)) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      trapModalTabKey(event, panelRef.current);
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
        {...props.panelProps}
        ref={panelRef}
        tabIndex={-1}
        className="dohc-pop-in"
        onClick={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}
