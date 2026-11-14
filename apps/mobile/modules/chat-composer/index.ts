import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** Asks the field to clear itself if it still holds `text`. Each new `token` asks once. */
export interface ClearRequest {
  readonly text: string;
  readonly token: number;
}

type ChatComposerFieldProps = {
  placeholder: string;
  /** The field's accessible name, which stays when the placeholder goes. */
  fieldLabel: string;
  editable: boolean;
  /** `#rrggbb`. */
  textColor: string;
  placeholderColor: string;
  clearIf: ClearRequest;
  onChangeText: (event: { nativeEvent: { text: string } }) => void;
  /** The height the text needs at the field's width, in points, sent when it changes. */
  onContentHeight: (event: { nativeEvent: { height: number } }) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The composer's text field: a native multiline text view, UITextView on iOS and EditText on Android, at the body text
 * size with Dynamic Type. Return is a new line. The field keeps its own text. It reports each change, and clears only on
 * a request whose text still matches, so text typed while a send was on its way stays. Keep it to layout styles; the
 * screen draws the field's background.
 */
export const ChatComposerField: ComponentType<ChatComposerFieldProps> =
  requireNativeView<ChatComposerFieldProps>("ChatComposer");
