import { requireNativeView } from "expo";
import type { ComponentType, ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

type BarBandProps = {
  coverHeight: number;
  /** iOS only: the space between the bar's resting edge and the tab bar, sent when it changes, never while scrolling. */
  onSpace?: (event: { nativeEvent: { height: number } }) => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Holds a list, its first child, and the band drawn over it, its second. On iOS the native host tells iOS the band's
 * strip is covered, keeps the band at the bar's bottom, has VoiceOver read the band first, and reports the space the
 * band's height is capped by. Elsewhere it's a plain
 * view, and the screen places the band itself. Keep it to layout styles. */
export const BarBand: ComponentType<BarBandProps> =
  Platform.OS === "ios" ? requireNativeView<BarBandProps>("BarBand") : View;

/** Whether the native host does the covering and placing on this platform. */
export const nativeBarBand = Platform.OS === "ios";
