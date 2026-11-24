import type { LegendListRef } from "@legendapp/list/react-native";
import { createContext, useCallback, useRef, type RefObject } from "react";
import type { ViewInstance } from "react-native";

/** The docked composer's bar, which lies over the list's end. */
export const ComposerBar = createContext<RefObject<ViewInstance | null> | null>(null);

/** Scrolls the conversation until a view a message opened, such as its reaction choices, shows above the composer. */
export const RevealAboveComposer = createContext<((view: Measurable) => void) | null>(null);

type Measurable = Pick<ViewInstance, "measureInWindow">;

const GAP = 8;

export function useRevealAboveComposer(list: RefObject<LegendListRef | null>) {
  const bar = useRef<ViewInstance>(null);
  const reveal = useCallback(
    (view: Measurable) => {
      view.measureInWindow((_x, y, _width, height) => {
        bar.current?.measureInWindow((_barX, top) => {
          const hidden = y + height + GAP - top;
          const scroller = list.current;
          if (hidden > 0 && scroller)
            void scroller.scrollToOffset({ offset: scroller.getState().scroll + hidden });
        });
      });
    },
    [list],
  );
  return { bar, reveal };
}
