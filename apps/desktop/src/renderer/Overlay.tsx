import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useFocusReturn } from "./ui/focusReturn";
import { focusedElementIn } from "./ui/focusedElement";
import { isTopOverlay, pushOverlay, removeOverlay } from "./overlayStack";
import { switchModalRegion, trapModalTabKey } from "./modalFocus";
import { matchesShortcut } from "../shortcuts/shortcutRegistry";
import { menuClosingPresses } from "./ui/useDismiss";

// A field marks itself data-unsaved while it holds what it can't save yet:
// a value it refused, a save that failed, or typing that waits for its own
// button.
const HELD_FIELD = "[data-unsaved]";

type PanelProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "tabIndex"> & {
  "data-testid"?: string;
};

// The backdrop and panel alone, without the keyboard and stack behavior.
// Overlay adds that; the states page renders this to show the scrim.
//
// Toasts sit above the dialog, so the dialog keeps its actions clear of them.
// NoticeCenter sets --dohc-toast-room to how far the toasts reach up from the
// window's bottom edge. A standard dialog leaves that room below itself: its
// top spacer gives up to 5rem of its 6rem so a short window still shows the
// actions above the toasts, and a dialog taller than the window scrolls, with
// a focused control scrolled clear of the toasts. The panel never shrinks.
// A warning dialog centers in the space above the toasts, and scrolls the
// same way when it is taller than that space.
export function OverlayFrame(props: {
  appearance?: "standard" | "warning";
  panelRef: RefObject<HTMLDivElement | null>;
  panelProps?: PanelProps;
  onBackdropClick?: () => void;
  children: ReactNode;
}) {
  // A click closes only when its press began on the backdrop and closed no
  // menu. Text selected in a field and dragged out of the panel keeps the
  // dialog, and so does the press that closes a menu inside it.
  const pressedBackdrop = useRef(false);
  return (
    <div
      data-dohc-modal="true"
      className={props.appearance === "warning"
        ? "fixed inset-0 z-50 grid place-items-center-safe overflow-auto bg-scrim pb-[var(--dohc-toast-room,0px)] scroll-pb-[var(--dohc-toast-room,0px)]"
        : "fixed inset-0 z-30 flex flex-col items-center overflow-auto bg-scrim px-4 pb-[calc(var(--dohc-toast-room,0px)+1rem)] scroll-pb-[var(--dohc-toast-room,0px)]"}
      {...(props.onBackdropClick ? {
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
          const target = event.target instanceof Node ? event.target : null;
          pressedBackdrop.current = target !== null && event.currentTarget.contains(target) &&
            !props.panelRef.current?.contains(target) && !menuClosingPresses.has(event.nativeEvent);
        },
        onClick: () => {
          if (pressedBackdrop.current) props.onBackdropClick?.();
          pressedBackdrop.current = false;
        },
      } : {})}
    >
      {props.appearance === "warning" ? null : <div aria-hidden className="min-h-4 shrink grow-0 basis-24" />}
      <div
        {...props.panelProps}
        ref={props.panelRef}
        tabIndex={-1}
        data-focus-surface="dialog"
        // The panel holds focus only until Tab reaches its controls, which
        // show their own ring, so the whole dialog never wears one.
        className={`${props.panelProps?.className ?? "dohc-pop-in"} shrink-0 outline-none`}
        onClick={(event) => event.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}

// Shared modal scaffold: a dimmed backdrop and a panel, with one close and
// keyboard behavior everywhere. Escape, ⌘W on macOS, and the dialog's own
// controls close it; a press on the backdrop does nothing, so a stray click never throws
// away what someone typed. A dialog whose fields save as the person leaves
// them, such as Settings or a picker, sets closeOnBackdrop. A field marked
// data-unsaved then keeps the dialog open and takes focus, so its problem
// shows.
export function Overlay(props: {
  onClose?: () => void;
  closeOnBackdrop?: boolean;
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
    if (panel && (props.appearance === "warning" || !panel.contains(focusedElementIn(panel)))) panel.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isTopOverlay(idRef.current)) return;
      if (switchModalRegion(event, panelRef.current)) return;
      if (event.key === "Escape") {
        // One Escape closes one surface: a menu or a control's tooltip open
        // inside the dialog takes this one, and the next reaches the dialog.
        if (event.target instanceof Element && event.target.closest("[role='menu'], [data-tooltip-open]")) return;
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      // macOS closes a dialog with ⌘W, as it closes a window. A dialog with no
      // onClose still takes the chord, so the menu never closes what is behind it.
      if (window.dohcDesktop?.platform === "darwin" && matchesShortcut(event, "close-tab", "darwin")) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      trapModalTabKey(event, panelRef.current);
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const closeFromBackdrop = () => {
    const held = panelRef.current?.querySelector<HTMLElement>(HELD_FIELD);
    if (held) held.focus();
    else onCloseRef.current?.();
  };

  return (
    <OverlayFrame
      appearance={props.appearance}
      panelRef={panelRef}
      panelProps={props.panelProps}
      onBackdropClick={props.closeOnBackdrop ? closeFromBackdrop : undefined}
    >
      {props.children}
    </OverlayFrame>
  );
}
