import { LegendList } from "@legendapp/list/react";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

// Posts and Home share a top-down card list. Keep focused cards and their
// neighbors mounted so scrolling cannot discard a control's keyboard focus.
export function PostFeedList<T>({
  items, itemKey, renderItem, header, footer, empty, columnClassName = "",
  testId, bottomPadding = 48, topPadding = 12,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  header?: ReactElement;
  footer?: ReactElement;
  empty?: ReactElement;
  columnClassName?: string;
  testId?: string;
  bottomPadding?: number;
  topPadding?: number;
}) {
  const viewport = useRef<HTMLElement>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusedIndex = focusedKey === null
    ? -1
    : items.findIndex((item) => itemKey(item) === focusedKey);
  useEffect(() => {
    const retainSelection = () => {
      const selection = window.getSelection();
      const rowKey = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element || !viewport.current?.contains(element)) return undefined;
        return element.closest<HTMLElement>("[data-post-feed-key]")?.dataset.postFeedKey;
      };
      const anchor = selection && !selection.isCollapsed ? rowKey(selection.anchorNode) : undefined;
      const focus = selection && !selection.isCollapsed ? rowKey(selection.focusNode) : undefined;
      const start = items.findIndex((item) => itemKey(item) === anchor);
      const end = items.findIndex((item) => itemKey(item) === focus);
      const next = start < 0 || end < 0
        ? []
        : items.slice(Math.min(start, end), Math.max(start, end) + 1).map(itemKey);
      setSelectedKeys((current) =>
        current.length === next.length && current.every((key, index) => key === next[index])
          ? current
          : next,
      );
    };
    document.addEventListener("selectionchange", retainSelection);
    return () => document.removeEventListener("selectionchange", retainSelection);
  }, [items, itemKey]);
  const alwaysRender = useMemo(() => ({
    keys: selectedKeys,
    indices: focusedIndex < 0 ? [] : [focusedIndex - 1, focusedIndex, focusedIndex + 1]
      .filter((index) => index >= 0 && index < items.length),
  }), [focusedIndex, items.length, selectedKeys]);
  const column = (node: ReactNode) => (
    <div className={`px-3 sm:px-4 ${columnClassName}`}>{node}</div>
  );
  return (
    <LegendList
      refScrollView={(value) => {
        const node = value instanceof HTMLElement ? value : value?.getScrollableNode();
        viewport.current = node instanceof HTMLElement ? node : null;
      }}
      data-testid={testId}
      role="list"
      className="min-h-0 flex-1"
      style={{ paddingTop: topPadding, paddingBottom: bottomPadding }}
      data={items}
      keyExtractor={itemKey}
      estimatedItemSize={220}
      drawDistance={400}
      recycleItems={false}
      maintainVisibleContentPosition
      alwaysRender={alwaysRender}
      extraData={renderItem}
      ListHeaderComponent={header ? column(header) : undefined}
      ListFooterComponent={footer ? column(footer) : undefined}
      ListEmptyComponent={empty ? column(empty) : undefined}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-post-feed-key]");
        setFocusedKey(row?.dataset.postFeedKey ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
      }}
      renderItem={({ item, index }) => (
        <div
          data-post-feed-key={itemKey(item)}
          role="listitem"
          aria-posinset={index + 1}
          aria-setsize={items.length}
          className={`px-3 sm:px-4 ${columnClassName}`}
          style={{ paddingBottom: index + 1 < items.length ? 12 : 0 }}
        >
          {renderItem(item)}
        </div>
      )}
    />
  );
}
