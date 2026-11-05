import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { Overlay } from "../Overlay";
import { modalFocusableElements } from "../modalFocus";
import { DangerButton, PrimaryButton, SecondaryButton } from "./controls";

type Intent = "default" | "danger";

type ConfirmDialogProps = {
  title: string;
  /** The glyph that names the action, such as Trash2 for a delete. */
  icon: LucideIcon;
  /** The sentences a screen reader reads after the title. */
  children: ReactNode;
  /** Lists and controls under the sentences, left out of what is read. */
  details?: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
  cancelTestId: string;
  confirmTestId: string;
  /** Confirm waits for a choice the dialog asks for. */
  confirmDisabled?: boolean;
  /** `danger` when confirming removes or revokes something. */
  intent?: Intent;
};

// The dialog's buttons show the global ring whenever Chromium's
// :focus-visible matches, so a dialog opened from the keyboard shows at once
// where Enter acts. The dohc-interface skill states the rule.
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-focus";

// Every confirmation: a tile tinted by intent beside one text column. The
// title, the sentences, lists, escape steps and the buttons all start at the
// title's edge. The parts of the column sit 24px apart.
export function ConfirmationCard(props: {
  icon: LucideIcon;
  intent?: Intent;
  labelledBy: string;
  describedBy?: string;
  testId?: string;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div
      data-testid={props.testId}
      className="dohc-elevated flex w-[min(440px,calc(100vw-32px))] gap-3 rounded-xl border border-line bg-panel p-6 text-ink"
      role="dialog"
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
    >
      <div
        aria-hidden
        className={`grid size-8 shrink-0 place-items-center rounded-lg ${props.intent === "danger" ? "bg-danger-tint text-danger" : "bg-panel-2 text-muted"}`}
      >
        <Icon size={16} />
      </div>
      {/* pt-1 centers the title's first line on the tile. */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 pt-1">{props.children}</div>
    </div>
  );
}

/** The title and the sentences read after it. */
export function ConfirmationHead(props: { titleId: string; bodyId: string; title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 id={props.titleId} className="m-0 break-words text-base font-semibold text-ink">
        {props.title}
      </h2>
      <div id={props.bodyId} className="flex flex-col gap-1 text-[13px] text-muted">{props.children}</div>
    </div>
  );
}

/** A step that saves something before the decision, such as Copy the
 * record, beside the sentence that says what it keeps. The step is a row-size
 * button. */
export function ConfirmEscape(props: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <p className="m-0 min-w-0 flex-1 text-[13px] text-muted">{props.children}</p>
      {props.action}
    </div>
  );
}

/** Cancel and the confirm, at the end of the column. Nothing else sits here. */
export function ConfirmActions(props: { children: ReactNode }) {
  return <div data-confirm-actions className="flex justify-end gap-2">{props.children}</div>;
}

// The card alone. ConfirmDialog puts it in an Overlay; the states page
// renders it over a frame with no keyboard behavior.
export function ConfirmDialogCard(props: ConfirmDialogProps & { confirmRef?: Ref<HTMLButtonElement> }) {
  // The states page shows one card in each theme, so ids come from useId.
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const Confirm = props.intent === "danger" ? DangerButton : PrimaryButton;
  return (
    <ConfirmationCard icon={props.icon} intent={props.intent} labelledBy={titleId} describedBy={bodyId} testId={props.testId}>
      <ConfirmationHead titleId={titleId} bodyId={bodyId} title={props.title}>
        {props.children}
      </ConfirmationHead>
      {props.details}
      <ConfirmActions>
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
      </ConfirmActions>
    </ConfirmationCard>
  );
}

const ARROW_STEP: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

// A held Enter never confirms: it may be the key that opened the dialog,
// repeating. The arrow keys move between the dialog's buttons, as in a native
// dialog, and from the panel itself reach the first or the last button.
export function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
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

// Where someone may be typing: a text field, editable text, or an app's
// frame, whose fields the renderer can't see. A dialog that opens there,
// such as one that waited for a list, keeps focus on its panel, so their
// next Enter does nothing.
const TEXT_ENTRY =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), [contenteditable]:not([contenteditable="false"]), iframe, webview';

// Focuses what `pick` returns when the dialog opens, unless it opened while
// someone was typing. Call it in the component that renders the Overlay, so
// it runs after the Overlay focuses its panel.
export function useOpeningFocus(pick: () => HTMLElement | null | undefined): void {
  // Read before the dialog takes focus.
  const [openedWhileTyping] = useState(() => document.activeElement?.closest(TEXT_ENTRY) != null);
  useLayoutEffect(() => {
    if (!openedWhileTyping) pick()?.focus();
  }, []);
}

// Focus starts on the confirm button, so Enter confirms and Escape cancels.
// A confirm that waits for a choice starts on the dialog's first control.
export function ConfirmDialog(props: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useOpeningFocus(() => {
    const panel = panelRef.current;
    return props.confirmDisabled ? panel && modalFocusableElements(panel)[0] : confirmRef.current;
  });
  return (
    <Overlay onClose={props.onCancel} panelRef={panelRef} panelProps={{ onKeyDown: onDialogKeyDown }}>
      <ConfirmDialogCard {...props} confirmRef={confirmRef} />
    </Overlay>
  );
}
