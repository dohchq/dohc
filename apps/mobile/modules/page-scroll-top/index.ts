import { requireNativeView } from "expo";
import type { ComponentType, ReactNode } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

type PageScrollTopProps = {
  /** The page is the screen in front. Only then does a status-bar tap reach it. */
  active: boolean;
  /** The page has its web view and has drawn. Before that a tap would do nothing. */
  ready: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Holds a page's web view, its only child. On iOS, while active and ready, a status-bar tap scrolls the page to its
 * top; the web view's own scroll views never take the tap. Elsewhere it's a plain view. Keep it to layout styles. */
export const PageScrollTop: ComponentType<PageScrollTopProps> =
  Platform.OS === "ios" ? requireNativeView<PageScrollTopProps>("PageScrollTop") : View;
