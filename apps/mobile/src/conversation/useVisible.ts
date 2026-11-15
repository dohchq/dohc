import { useIsFocused } from "expo-router";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";

const subscribeAppState = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";

/** The screen is focused and the app is in the foreground. */
export function useVisible(): boolean {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, appActive);
  return focused && active;
}

/**
 * Takes, at a press, a check that the screen still shows what it showed then: true from the commit that made it
 * visible until the commit that hides it or closes it. Shown again later is another showing, and the check stays false.
 */
export function useShowing(visible: boolean): () => () => boolean {
  const showing = useRef<object | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    showing.current = {};
    return () => {
      showing.current = null;
    };
  }, [visible]);
  return useCallback(() => {
    const at = showing.current;
    return () => at !== null && showing.current === at;
  }, []);
}
