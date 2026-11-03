import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Overlay } from "../Overlay";
import { modalFocusableElements } from "../modalFocus";
import { DangerButton, PrimaryButton, SecondaryButton } from "./controls";

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
  cancelTestId: string;
  confirmTestId: string;
  /** Confirm waits for a choice the dialog asks for. */
  confirmDisabled?: boolean;
  /** `danger` when confirming removes or revokes something. */
  intent?: "default" | "danger";
};

// The dialog's buttons show the global ring whenever Chromium's
// :focus-visible matches, so a dialog opened from the keyboard shows at once
// where Enter acts. The dohc-interface skill states the rule.
const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-focus";

// The card alone. ConfirmDialog puts it in an Overlay; the states page
// renders it over a frame with no keyboard behavior.
export function ConfirmDialogCard(props: ConfirmDialogProps & { confirmRef?: Ref<HTMLButtonElement> }) {
  const titleId = `${props.testId}-title`;
  const Confirm = props.intent === "danger" ? DangerButton : PrimaryButton;
  return (
    <div
      data-testid={props.testId}
      className="dohc-elevated flex w-[min(420px,calc(100vw-32px))] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div>
        <h3 id={titleId} className="m-0 break-words text-base font-semibold text-ink">
          {props.title}
        </h3>
        {props.children}
      </div>
      <div data-confirm-actions className="flex justify-end gap-2">
        <SecondaryButton data-testid={props.cancelTestId} className={FOCUS_RING} onClick={props.onCancel}>
          Cancel
        </SecondaryButton>
        <Confirm
          ref={props.confirmRef}
          data-testid={props.confirmTestId}
          className={FOCUS_RING}
          disabled={props.confirmDisabled}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </Confirm>
      </div>
    </div>
  );
}

const ARROW_STEP: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

// A held Enter never confirms: it may be the key that opened the dialog,
// repeating. The arrow keys move between the dialog's buttons, as in a native
// dialog, and from the panel itself reach the first or the last button.
function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key === "Enter" && event.repeat) {
    event.preventDefault();
    return;
  }
  const step = ARROW_STEP[event.key];
  if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-confirm-actions] button:enabled")];
  const from = event.target === event.currentTarget ? null : buttons.indexOf(event.target as HTMLButtonElement);
  if (from === -1 || buttons.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  buttons[from === null ? (step === 1 ? 0 : buttons.length - 1) : (from + step + buttons.length) % buttons.length]!.focus();
}

// Where someone types. A dialog that opens there, such as one that waited
// for a list, keeps focus on its panel, so their next Enter does nothing.
const TEXT_ENTRY =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), [contenteditable]:not([contenteditable="false"])';

// Focus starts on the confirm button, so Enter confirms and Escape cancels.
// A confirm that waits for a choice starts on the dialog's first control.
export function ConfirmDialog(props: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Read before the dialog takes focus.
  const [openedWhileTyping] = useState(() => document.activeElement?.closest(TEXT_ENTRY) != null);
  useLayoutEffect(() => {
    if (openedWhileTyping) return;
    const panel = panelRef.current;
    (props.confirmDisabled ? panel && modalFocusableElements(panel)[0] : confirmRef.current)?.focus();
  }, []);
  return (
    <Overlay onClose={props.onCancel} panelRef={panelRef} panelProps={{ onKeyDown: onDialogKeyDown }}>
      <ConfirmDialogCard {...props} confirmRef={confirmRef} />
    </Overlay>
  );
}
