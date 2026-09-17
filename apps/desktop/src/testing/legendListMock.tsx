import { Fragment, createElement, useImperativeHandle, useRef, type Ref, type ComponentType, type ReactElement } from "react";
import { vi } from "vitest";
import type { LegendListProps, LegendListRef } from "@legendapp/list/react";

// jsdom has no layout. Host unit tests render the rows and exercise actions;
// the browser and Electron suites verify actual virtualization and scrolling.
vi.mock("@legendapp/list/react", () => ({
  LegendList: function LegendList<Item>(props: LegendListProps<Item> & { ref?: Ref<Pick<LegendListRef, "getScrollableNode" | "scrollToEnd" | "scrollToIndex">> }) {
    const root = useRef<HTMLDivElement>(null);
    useImperativeHandle(props.ref, () => ({
      getScrollableNode: () => root.current!,
      scrollToEnd: async () => { root.current?.lastElementChild?.scrollIntoView({ block: "end" }); },
      scrollToIndex: async ({ index }: { index: number }) => { root.current?.children[index]?.scrollIntoView({ block: "center" }); },
    }));
    const renderComponent = (component: ComponentType | ReactElement | null | undefined) => typeof component === "function" ? createElement(component) : component;
    return <div ref={root} role={props.role} className={props.className} data-testid={(props as { "data-testid"?: string })["data-testid"]} onFocusCapture={props.onFocusCapture} onBlurCapture={props.onBlurCapture}>
      {renderComponent(props.ListHeaderComponent)}
      {!props.data?.length ? renderComponent(props.ListEmptyComponent) : null}
      {props.data?.map((item, index) => <Fragment key={props.keyExtractor?.(item, index) ?? index}>
        {props.renderItem?.({ item, index, data: props.data ?? [], extraData: props.extraData, type: undefined })}
      </Fragment>)}
      {renderComponent(props.ListFooterComponent)}
    </div>;
  },
}));
