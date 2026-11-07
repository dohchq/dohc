// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useImperativeHandle, useRef, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListProps, LegendListRef, OnViewableItemsChangedInfo } from "@legendapp/list/react";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { ChatMessageList } from "./chatMessages";
import { formatChatDay } from "../time";

// jsdom has no layout or IntersectionObserver. This list reports its visible
// rows on demand, and the fake observer delivers the entries a browser would.
let reportViewable: ((info: OnViewableItemsChangedInfo<ChatMessageRecord>) => void) | null = null;
vi.mock("@legendapp/list/react", () => ({
  LegendList: function LegendList(props: LegendListProps<ChatMessageRecord> & { ref?: Ref<Pick<LegendListRef, "getScrollableNode">> }) {
    const root = useRef<HTMLDivElement>(null);
    useImperativeHandle(props.ref, () => ({ getScrollableNode: () => root.current! }));
    reportViewable = props.onViewableItemsChanged ?? null;
    return <div ref={root} role="list">{props.data?.map((item, index) =>
      <div key={item.id}>{props.renderItem?.({ item, index, data: props.data!, extraData: props.extraData, type: undefined })}</div>)}</div>;
  },
}));

class FakeObserver {
  static current: FakeObserver | null = null;
  readonly observed = new Set<Element>();
  readonly observe = vi.fn((target: Element) => { this.observed.add(target); });
  readonly unobserve = vi.fn((target: Element) => { this.observed.delete(target); });
  readonly disconnect = vi.fn(() => { this.observed.clear(); });
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.current = this;
  }
  // A divider whose top sits `top` px below the pane's top edge.
  deliver(target: Element, top: number) {
    const entry = { target, boundingClientRect: { top }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry;
    act(() => this.callback([entry], this as unknown as IntersectionObserver));
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeObserver.current = null;
  reportViewable = null;
});

const day = 86_400_000;
const start = new Date(2026, 9, 1, 12).getTime();
const message = (id: string, createdAtMs: number): ChatMessageRecord => ({
  presentation: { group: "fixture", hue: null, self: false },
  id, threadId: "thread", authorKind: "human", authorDisplayName: "Reader", createdAtMs, body: `Message ${id}.`,
});
// The second message starts a new day and is long enough to fill the pane.
const messages = [message("m-0", start), message("m-1", start + 2 * day), message("m-2", start + 2 * day + 60_000)];

function showTop(index: number) {
  const item = messages[index]!;
  act(() => reportViewable?.({
    viewableItems: [{ item, index, key: item.id, isViewable: true, containerId: 0 }],
    changed: [],
    start: index,
    end: index,
    startBuffered: 0,
    endBuffered: messages.length - 1,
  }));
}

describe("ChatMessageList pinned day", () => {
  it("shows the top row's day once its divider has jumped above the pane without a threshold entry", () => {
    render(<ChatMessageList testIdPrefix="list" messages={messages} loading={false} emptyLabel="Empty" />);
    const observer = FakeObserver.current!;
    const divider = screen.getAllByTestId("list-day").find(node => node.dataset.dayDivider === "m-1")!;
    expect(observer.observed.has(divider)).toBe(true);

    // First seen below the pane, so not clipped.
    observer.deliver(divider, 620);
    showTop(0);
    expect(screen.queryByTestId("list-sticky-day")).toBeNull();

    // An 800 px jump puts it above the pane. Both positions sit outside the
    // pane, so the browser reports nothing until dohc observes it again.
    observer.observe.mockClear();
    showTop(1);
    expect(observer.unobserve).toHaveBeenCalledWith(divider);
    expect(observer.observe).toHaveBeenCalledWith(divider);
    expect(screen.queryByTestId("list-sticky-day")).toBeNull();

    observer.deliver(divider, -180);
    expect(screen.getByTestId("list-sticky-day").textContent).toBe(formatChatDay(messages[1]!.createdAtMs));

    // Scrolled back so the divider is fully in view: the label hides.
    observer.deliver(divider, 40);
    expect(screen.queryByTestId("list-sticky-day")).toBeNull();
  });

  it("steps aside while the next day's divider passes under it", () => {
    render(<ChatMessageList testIdPrefix="list" messages={messages} loading={false} emptyLabel="Empty" />);
    const observer = FakeObserver.current!;
    const dividers = screen.getAllByTestId("list-day");
    const first = dividers.find(node => node.dataset.dayDivider === "m-0")!;
    const next = dividers.find(node => node.dataset.dayDivider === "m-1")!;
    const nextMark = next.querySelector<HTMLElement>("[data-day-mark]")!;
    expect(observer.observed.has(nextMark)).toBe(true);

    // The first day's divider is above the pane, its rows still at the top.
    observer.deliver(first, -60);
    showTop(0);
    expect(screen.getByTestId("list-sticky-day").textContent).toBe(formatChatDay(messages[0]!.createdAtMs));

    // The next day's divider reaches the pinned copy's bottom edge: its mark
    // rises past the line, and the copy steps aside.
    observer.deliver(nextMark, -1);
    expect(screen.queryByTestId("list-sticky-day")).toBeNull();

    // It rises past the line itself and becomes the pinned day.
    observer.deliver(next, -1);
    showTop(1);
    expect(screen.getByTestId("list-sticky-day").textContent).toBe(formatChatDay(messages[1]!.createdAtMs));
  });

  it("shows the day for a top row whose day started further up", () => {
    render(<ChatMessageList testIdPrefix="list" messages={messages} loading={false} emptyLabel="Empty" />);
    showTop(2);
    expect(screen.getByTestId("list-sticky-day").textContent).toBe(formatChatDay(messages[2]!.createdAtMs));
  });
});
