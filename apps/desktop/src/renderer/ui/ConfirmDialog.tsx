import type { ReactNode } from "react";
import { Overlay } from "../Overlay";
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

// The card alone. ConfirmDialog puts it in an Overlay; the states page
// renders it over a frame with no keyboard behavior.
export function ConfirmDialogCard(props: ConfirmDialogProps) {
  const titleId = `${props.testId}-title`;
  const Confirm = props.intent === "danger" ? DangerButton : PrimaryButton;
  return (
    <div
      data-testid={props.testId}
      className="w-[min(420px,calc(100vw-32px))] rounded border border-line bg-panel p-4 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="m-0 text-sm font-semibold text-ink">
        {props.title}
      </h3>
      {props.children}
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton data-testid={props.cancelTestId} onClick={props.onCancel} className="h-8 py-0">
          Cancel
        </SecondaryButton>
        <Confirm data-testid={props.confirmTestId} disabled={props.confirmDisabled} onClick={props.onConfirm} className="h-8 py-0 text-xs">
          {props.confirmLabel}
        </Confirm>
      </div>
    </div>
  );
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Overlay onClose={props.onCancel}>
      <ConfirmDialogCard {...props} />
    </Overlay>
  );
}
