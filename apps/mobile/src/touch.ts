import { Platform, type PressableAndroidRippleConfig } from "react-native";
import type { Theme } from "./theme";

// The smallest touch target: 44 pt on iOS, Material's 48 dp on Android.
export const TOUCH = Platform.OS === "android" ? 48 : 44;

// Material's press feedback on Android: a ripple of ink at 12%, bounded by the control, or round past an icon's edges
// when `borderless`. iOS shows its own feedback.
export function ripple(theme: Theme, borderless = false): PressableAndroidRippleConfig | undefined {
  return Platform.OS === "android" ? { color: `${theme.ink}1f`, borderless } : undefined;
}

// The vertical slop that brings a control `height` tall up to TOUCH.
export function slopTo(height: number): { top: number; bottom: number } {
  const extra = Math.max(0, (TOUCH - height) / 2);
  return { top: extra, bottom: extra };
}
