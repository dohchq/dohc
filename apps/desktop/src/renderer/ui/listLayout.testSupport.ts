import { vi } from "vitest";

/**
 * jsdom has no layout. Lays every option of a listbox out 28px apart under 4px
 * of padding, in a list that shows `listHeight` pixels, and returns the
 * restore. Options are counted in their listbox's document order.
 */
export function mockListLayout(listHeight: number): () => void {
  const spies = [
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const list = this.closest('[role="listbox"]');
      if (!list || list === this) return 0;
      return 4 + [...list.querySelectorAll('[role="option"]')].indexOf(this) * 28;
    }),
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28),
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(listHeight),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

/** Whether `row` lies wholly inside the scrolled view of `list`. */
export function inListView(list: HTMLElement, row: HTMLElement): boolean {
  return row.offsetTop >= list.scrollTop && row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight;
}
