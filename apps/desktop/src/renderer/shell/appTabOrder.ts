import type { FocusEvent } from "react";
import { hasBlockingModal, modalFocusableElements } from "../modalFocus";

// Each app's page sits after every editor group in the DOM and shows over its group's slot. Tab and Shift+Tab
// follow the screen instead: a group's app comes between that group's controls and the next group's.
const PAGE = "[data-app-group-id]";
// An app runs in a webview and a static site's preview in an iframe. Tab enters either, but neither matches the
// focusable selector.
const FRAME = "webview, iframe";
const byPlace = (a: Node, b: Node) =>
  a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

// What Tab reaches in document order, and the same stops in screen order, with each shown page at its slot.
function tabOrders() {
  const dom = [...modalFocusableElements(document.body), ...document.querySelectorAll<HTMLElement>(`${PAGE} webview, ${PAGE} iframe`)]
    .filter((item) => !item.closest(`${PAGE}.hidden`))
    .sort(byPlace);
  // Each stop's slot is looked up once, not on every comparison.
  const screen = dom
    .map((item) => {
      const page = item.closest<HTMLElement>(PAGE);
      return { item, place: (page && document.querySelector(`[aria-owns="${page.id}"]`)) || item };
    })
    .sort((a, b) => byPlace(a.place, b.place) || byPlace(a.item, b.item))
    .map(({ item }) => item);
  return { dom, screen };
}

let entering: HTMLElement | null = null;

export function routeAppTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || hasBlockingModal() || !document.querySelector(`${PAGE}:not(.hidden)`)) return;
  const { dom, screen } = tabOrders();
  if (!screen.includes(active)) return;
  const step = (order: HTMLElement[]) => order[(order.indexOf(active) + (event.shiftKey ? order.length - 1 : 1)) % order.length];
  const next = step(screen);
  const page = next.closest(PAGE);
  // Shift+Tab into a page from outside it would land on the page's end stop, which sends focus forward again.
  const intoPage = event.shiftKey && page !== null && !page.contains(active);
  if (intoPage && next.matches(FRAME)) {
    // To go into a frame at its end, focus moves to the end stop, and the browser goes on from there into the
    // frame's last control.
    entering = page?.querySelector<HTMLElement>("[data-app-stop]") ?? null;
    entering?.focus();
    entering = null;
    return;
  }
  if (next === step(dom) && !intoPage) return;
  next.focus();
  if (document.activeElement === next) event.preventDefault();
}

// Tab out of a page's last control, or its frame's, lands on the page's end stop, which hands focus on to what
// follows the page on screen.
export function leaveAppPage(event: FocusEvent<HTMLElement>) {
  if (event.currentTarget === entering) return;
  const page = event.currentTarget.closest(PAGE);
  const { screen } = tabOrders();
  const last = screen.map((item) => page?.contains(item) ?? false).lastIndexOf(true);
  screen[(last + 1) % screen.length]?.focus();
}
