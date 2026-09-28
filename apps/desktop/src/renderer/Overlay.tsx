import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { useFocusReturn } from "./ui/focusReturn";
import { isTopOverlay, pushOverlay, removeOverlay } from "./overlayStack";
import { trapModalTabKey } from "./modalFocus";

type PanelProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "tabIndex"> & {
  "data-testid"?: string;
};

// The backdrop and panel alone, without the keyboard and stack behavior.
// Overlay adds that; the states page renders this to show the scrim.
export function OverlayFrame(props: {
  appearance?: "standard" | "warning";
  panelRef: RefObject<HTMLDivElement | null>;
  panelProps?: PanelProps;
  onBackdropClick?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-dohc-modal="true"
      className={props.appearance === "warning"
        ? "fixed inset-0 z-50 grid place-items-center bg-scrim"
        : "fixed inset-0 z-30 flex items-start justify-center overflow-auto bg-scrim p-4 pt-24 backdrop-blur-[1.5px]"}
      onClick={props.onBackdropClick}
    >
      <div
        {...props.panelProps}
        ref={props.panelRef}
        tabIndex={-1}
        data-focus-surface="dialog"
        className={props.panelProps?.className ?? "dohc-pop-in"}
        onClick={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}

// Shared modal scaffold: dimmed backdrop that closes on click, with an inner
// panel that swallows clicks. Used by the command palette, quick-open, new
// file dialog, and cloud panel so close/backdrop behavior — and this keyboard behavior — stays identical everywhere.
export function Overlay(props: {
  onClose?: () => void;
  children: ReactNode;
  appearance?: "standard" | "warning";
  panelRef?: RefObject<HTMLDivElement | null>;
  panelProps?: PanelProps;
}) {
  const defaultPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = props.panelRef ?? defaultPanelRef;
  useFocusReturn(true, panelRef);
  // A ref, not a dependency, so Escape and Tab always call this render's
  // onClose even though the keydown listener itself is only ever attached
  // once.
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
    if (panel && (props.appearance === "warning" || !panel.contains(document.activeElement))) panel.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isTopOverlay(idRef.current)) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      trapModalTabKey(event, panelRef.current);
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <OverlayFrame
      appearance={props.appearance}
      panelRef={panelRef}
      panelProps={props.panelProps}
      onBackdropClick={props.onClose}
    >
      {props.children}
    </OverlayFrame>
  );
}
