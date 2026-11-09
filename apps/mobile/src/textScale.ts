import { useWindowDimensions } from "react-native";

// The accessibility text sizes start where the font scale reaches 1.6.
const accessibilityScale = 1.6;

/** Whether text is at an accessibility size, where layouts give the text the room it needs. */
export function useAccessibilityTextSize(): boolean {
  return useWindowDimensions().fontScale >= accessibilityScale;
}

// At accessibility text sizes a line clamp would hide what the text says, so the lines run free.
export function useLineClamp(lines: number): number | undefined {
  return useAccessibilityTextSize() ? undefined : lines;
}
