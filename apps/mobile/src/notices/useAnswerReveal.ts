import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";
import type { PhoneNotice } from "./phoneNotice";

// A row's open free answer kept above the keyboard on Notices. Its field and Send sit in the row, not docked, so the
// list itself moves: once the keyboard has shown, when the answer opens with the keyboard already up, and when the
// row, or one before it, changes size. Each move is one frame's bottom alignment of the row, just above the list's
// bottom inset, which the sample's list sets to the keyboard's height and the signed-in list's keyboard view keeps.

/** The row whose free answer's field is open, by its visit, or null. A poll's answer has no field. */
export function freeAnswer(
  notices: readonly PhoneNotice[],
): { readonly noticeId: string; readonly visit: string } | null {
  for (const notice of notices) {
    const answer = notice.answer;
    if (!answer || answer.editing === null || answer.question === null) continue;
    if (answer.decision.options.length > 0) continue;
    return { noticeId: notice.id, visit: `${notice.id}:${answer.editing}` };
  }
  return null;
}

/**
 * The keyboard's height, 0 while it's hidden, and the list's `onItemSizeChanged`. `visit` is the open free answer's,
 * `index` its row's in the list's data, and nothing moves unless the screen is `focused`.
 */
export function useAnswerReveal(options: {
  readonly list: RefObject<Pick<LegendListRef, "scrollToIndex"> | null>;
  readonly visit: string | null;
  readonly index: number;
  readonly focused: boolean;
}) {
  const { list, visit, index, focused } = options;
  const [height, setHeight] = useState(() =>
    KeyboardController.isVisible() ? KeyboardController.state().height : 0,
  );
  const latest = useRef({ visit, index, focused, height });
  latest.current = { visit, index, focused, height };
  const frame = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const reveal = useCallback(() => {
    const asked = latest.current;
    if (frame.current !== null || asked.visit === null || !asked.focused || asked.height === 0)
      return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const now = latest.current;
      if (now.visit !== asked.visit || now.index < 0 || !now.focused || now.height === 0) return;
      void list.current?.scrollToIndex({
        index: now.index,
        viewPosition: 1,
        viewOffset: -8,
        animated: false,
      });
    });
  }, [list]);

  useEffect(() => {
    const shown = (next: number) => {
      latest.current = { ...latest.current, height: next };
      setHeight(next);
    };
    const subscriptions = [
      KeyboardEvents.addListener("keyboardWillShow", (event) => shown(event.height)),
      KeyboardEvents.addListener("keyboardDidShow", (event) => {
        shown(event.height);
        reveal();
      }),
      KeyboardEvents.addListener("keyboardDidHide", () => {
        shown(0);
        cancel();
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      cancel();
    };
  }, [reveal, cancel]);

  // An answer opened, or the screen came back, with the keyboard already up. A frame still waiting for an earlier visit
  // gives way to this one.
  useEffect(() => {
    if (visit === null || !focused) return;
    reveal();
    return cancel;
  }, [visit, focused, reveal, cancel]);

  const onItemSizeChanged = useCallback(
    (info: { readonly index: number }) => {
      if (info.index <= latest.current.index) reveal();
    },
    [reveal],
  );
  return { keyboardHeight: height, onItemSizeChanged };
}
