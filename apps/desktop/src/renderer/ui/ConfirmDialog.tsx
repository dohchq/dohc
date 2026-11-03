import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
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

const ARROW_STEP: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

// The arrow keys move between the dialog's buttons, as in a native dialog.
function moveBetweenButtons(event: KeyboardEvent<HTMLDivElement>): void {
  const step = ARROW_STEP[event.key];
  if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  event.stopPropagation();
  buttons[(at + step + buttons.length) % buttons.length]!.focus();
}

// The dialog's buttons show their ring whenever Chromium shows focus, so the
// button the dialog starts on shows it too.
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
      <div className="flex justify-end gap-2" onKeyDown={moveBetweenButtons}>
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

// Focus starts on the confirm button, so Enter confirms and Escape cancels.
// A confirm that waits for a choice starts on the dialog's first control.
export function ConfirmDialog(props: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    (props.confirmDisabled ? panel && modalFocusableElements(panel)[0] : confirmRef.current)?.focus();
  }, []);
  return (
    <Overlay onClose={props.onCancel} panelRef={panelRef}>
      <ConfirmDialogCard {...props} confirmRef={confirmRef} />
    </Overlay>
  );
}
