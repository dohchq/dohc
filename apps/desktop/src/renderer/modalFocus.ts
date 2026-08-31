const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

export function trapModalTabKey(
  event: KeyboardEvent,
  container: HTMLElement | null,
): void {
  if (event.key !== "Tab" || !container) return;
  const focusable = [
    ...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ].filter((element) => element.closest('[aria-hidden="true"]') === null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
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
