const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

// Toasts sit above every dialog. F6 moves focus from the dialog to its toasts
// and back, and Tab cycles within whichever of the two holds focus, so focus
// never reaches the workbench behind the dialog.
const TOASTS_SELECTOR = "[data-dohc-toasts]";

function toastRegion(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>(TOASTS_SELECTOR) ?? null;
}

// Where F6 left each dialog, so F6 or Escape from a toast goes back there,
// and the dialog it left last, which need not be an Overlay: the page icon
// picker is a bare dialog with its own trap.
const leftAt = new WeakMap<HTMLElement, HTMLElement>();
let leftLast: WeakRef<HTMLElement> | null = null;

export function trapModalTabKey(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !dialog) return;
  const container = toastRegion(document.activeElement) ?? dialog;
  const focusable = modalFocusableElements(container);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const active = document.activeElement;
  const activeIsInside = active !== null && container.contains(active);
  if (event.shiftKey) {
    if (!activeIsInside || active === container || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else if (!activeIsInside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

// Moves focus between a dialog and the toasts above it, and answers whether it
// did. Escape in a toast goes back too, so it never closes the dialog.
export function switchModalRegion(event: KeyboardEvent, dialog: HTMLElement | null): boolean {
  if (!dialog || (event.key !== "F6" && event.key !== "Escape")) return false;
  const active = document.activeElement;
  if (toastRegion(active)) {
    event.preventDefault();
    event.stopPropagation();
    const back = leftAt.get(dialog);
    (back?.isConnected && dialog.contains(back) ? back : dialog).focus();
    return true;
  }
  if (event.key !== "F6") return false;
  const toast = [...document.querySelectorAll<HTMLElement>(TOASTS_SELECTOR)].flatMap(modalFocusableElements)[0];
  if (!toast) return false;
  event.preventDefault();
  if (active instanceof HTMLElement && dialog.contains(active)) leftAt.set(dialog, active);
  leftLast = new WeakRef(dialog);
  toast.focus();
  return true;
}

export function modalFocusableElements(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ].filter(
    (element) =>
      element.closest('[aria-hidden="true"]') === null &&
      !element.matches(":disabled"),
  );
}

const BLOCKING_MODAL_SELECTOR = "[role='dialog'], [data-dohc-modal='true']";

export function hasBlockingModal() {
  return document.querySelector(BLOCKING_MODAL_SELECTOR) !== null;
}

// The panel of the dialog on top, if one is open.
export function topModalPanel(): HTMLElement | null {
  const panels = document.querySelectorAll<HTMLElement>("[data-dohc-modal='true'] > [data-focus-surface='dialog']");
  return panels[panels.length - 1] ?? null;
}

// Where focus goes back to from a toast: the control F6 left from, in the
// dialog F6 left last while that dialog is open, or else the dialog itself.
// With no such dialog, the panel of the Overlay on top.
export function modalReturnTarget(): HTMLElement | null {
  const left = leftLast?.deref();
  const dialog = left?.isConnected ? left : topModalPanel();
  if (!dialog) return null;
  const back = leftAt.get(dialog);
  return back?.isConnected && dialog.contains(back) ? back : dialog;
}
