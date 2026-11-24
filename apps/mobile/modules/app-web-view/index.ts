import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import { Platform, type StyleProp, type ViewStyle } from "react-native";

type AppWebViewProps = {
  /** The app's bootstrap address, HTTPS. The view posts `handoff` to it once. */
  bootstrap: string;
  handoff: string;
  /** A link the person tapped, which hasn't left dohc. */
  onOpenLink(event: { nativeEvent: { url: string } }): void;
  /** The app's web process is gone; the view shows nothing more. */
  onEnd(): void;
  style?: StyleProp<ViewStyle>;
};

/** Android's view for a running app (android/.../AppWebViewModule.kt). Null on iOS, which runs apps in react-native-webview. */
export const AppWebView: ComponentType<AppWebViewProps> | null =
  Platform.OS === "android" ? requireNativeView<AppWebViewProps>("AppWebView") : null;
