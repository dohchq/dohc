// How long a landed message keeps `dohc-target-flash`, the wash it fades
// over. With reduced motion the wash holds this long, then clears.
export const TARGET_FLASH_MS = 900;

// Moves focus to the message a person asked to see, once it is on screen,
// so the keyboard and a screen reader start there.
export function focusMessage(root: ParentNode, messageId: string): void {
  const node = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find((candidate) => candidate.dataset.messageId === messageId);
  if (!node) return;
  if (!node.hasAttribute("tabindex")) node.tabIndex = -1;
  node.focus({ preventScroll: true });
}
