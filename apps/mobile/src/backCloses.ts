import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Platform } from "react-native";

// Android's Back closes what is open on the screen, such as a picker or a draft's extra field, before it leaves the
// screen, as Material asks. Only while the screen is in front, so Back on a screen above it doesn't reach it.
export function useBackCloses(open: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useFocusEffect(
    useCallback(() => {
      if (!open || Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        latest.current();
        return true;
      });
      return () => subscription.remove();
    }, [open]),
  );
}
