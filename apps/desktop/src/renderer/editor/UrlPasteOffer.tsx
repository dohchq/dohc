import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { EditorView } from "@tiptap/pm/view";
import { Link as LinkIcon, Type, Undo2, type LucideIcon } from "lucide-react";
import { MENU_ENTER, menuEnterFrom } from "../ui/Menu";
import { resolveFloatingMenuPosition } from "./floatingMenuPosition";
import type { UrlForm, UrlPasteOfferState } from "./urlPaste";

const FORMS: ReadonlyArray<{ form: UrlForm; label: string; icon: LucideIcon; testId: string }> = [
  { form: "link", label: "Link", icon: LinkIcon, testId: "url-paste-link" },
  { form: "plain", label: "Plain text", icon: Type, testId: "url-paste-plain" },
];

const ROW_BUTTON =
  "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-75";
const ROW_BUTTON_TONE = { rest: "text-muted hover:bg-hover hover:text-ink", current: "bg-selected text-ink" };

// The row itself, without a place: the editor floats it under the pasted
// line, and the states page draws it in place. Before a choice it offers the
// two forms, the current one pressed; after one, Undo.
export const UrlPasteOfferRow = forwardRef<HTMLDivElement, {
  form: UrlForm;
  chosen: boolean;
  className?: string;
  style?: CSSProperties;
  onChoose?: (form: UrlForm) => void;
  onUndo?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
}>(function UrlPasteOfferRow(props, ref) {
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Pasted link"
      data-testid="url-paste-offer"
      data-form={props.form}
      data-chosen={props.chosen ? "true" : undefined}
      className={`dohc-popover flex w-max items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5 ${props.className ?? ""}`}
      style={props.style}
      onKeyDown={props.onKeyDown}
      onBlur={props.onBlur}
      // The editor keeps its focus and selection under a pointer.
      onMouseDown={(event) => event.preventDefault()}
    >
      {props.chosen ? (
        <button
          type="button"
          data-testid="url-paste-undo"
          className={`${ROW_BUTTON} ${ROW_BUTTON_TONE.rest}`}
          onClick={props.onUndo}
        >
          <Undo2 size={13} aria-hidden />
          Undo
        </button>
      ) : (
        FORMS.map(({ form, label, icon: Icon, testId }) => (
          <button
            key={form}
            type="button"
            data-testid={testId}
            aria-pressed={props.form === form}
            className={`${ROW_BUTTON} ${props.form === form ? ROW_BUTTON_TONE.current : ROW_BUTTON_TONE.rest}`}
            onClick={() => props.onChoose?.(form)}
          >
            <Icon size={13} aria-hidden />
            {label}
          </button>
        ))
      )}
    </div>
  );
});

// The URL offer under its line. It never takes focus from the editor; Mod+K
// in the editor moves focus here (`rowRef`). Escape, a click elsewhere and
// focus leaving the row dismiss it, and focus goes back to the editor.
export function UrlPasteOffer(props: {
  offer: UrlPasteOfferState | null;
  view: EditorView | null;
  rowRef: RefObject<HTMLDivElement | null>;
  onChoose: (form: UrlForm) => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { offer, view, rowRef, onDismiss } = props;
  const [, reposition] = useReducer((count: number) => count + 1, 0);
  const focusUndo = useRef(false);
  const open = offer !== null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) onDismiss();
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, onDismiss, rowRef]);

  // A choice made from the keyboard replaces the buttons that had focus.
  useLayoutEffect(() => {
    if (!offer?.chosen || !focusUndo.current) return;
    focusUndo.current = false;
    rowRef.current?.querySelector<HTMLButtonElement>("[data-testid='url-paste-undo']")?.focus();
  }, [offer?.chosen, rowRef]);

  if (!offer || !view) return null;
  let coords: { left: number; top: number; bottom: number };
  try {
    coords = view.coordsAtPos(offer.from);
  } catch {
    return null;
  }
  const position = resolveFloatingMenuPosition({ cursorRect: coords, menuWidth: 200, menuMaxHeight: 32, gap: 4 });
  const leave = () => {
    onDismiss();
    view.focus();
  };
  return (
    <UrlPasteOfferRow
      ref={rowRef}
      form={offer.form}
      chosen={offer.chosen}
      className={MENU_ENTER}
      style={{ position: "fixed", left: position.x, top: position.y, zIndex: 60, ...menuEnterFrom(position.placement) }}
      // A choice of the current form and Undo close the row: focus they held
      // goes back to the editor, at its caret.
      onChoose={(form) => {
        const focused = rowRef.current?.contains(document.activeElement) ?? false;
        if (form === offer.form) {
          props.onChoose(form);
          if (focused) view.focus();
          return;
        }
        focusUndo.current = focused;
        props.onChoose(form);
      }}
      onUndo={() => {
        const focused = rowRef.current?.contains(document.activeElement) ?? false;
        props.onUndo();
        if (focused) view.focus();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          leave();
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const buttons = [...event.currentTarget.querySelectorAll("button")];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[(at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
        event.preventDefault();
        next?.focus();
      }}
      // Focus that moves outside the row dismisses it. A choice's buttons
      // unmount with focus inside, which moves it nowhere.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) onDismiss();
      }}
    />
  );
}
