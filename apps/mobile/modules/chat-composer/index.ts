import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** Asks the field to clear itself if its text has not changed since `revision`. Each new `token` asks once. */
export interface ClearRequest {
  readonly revision: number;
  readonly token: number;
}

/** A change to the field's text. */
export interface FieldChange {
  readonly text: string;
  /** Counts every change to the text, the field's own clears included, so an edit away and back still counts. */
  readonly revision: number;
  /** The `token` of the request whose clear made this change, or 0 for an edit. */
  readonly cleared: number;
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
  onChangeText: (event: { nativeEvent: FieldChange }) => void;
  /** The height the text needs at the field's width, in points, sent when it changes. */
  onContentHeight: (event: { nativeEvent: { height: number } }) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The composer's text field: a native multiline text view, UITextView on iOS and EditText on Android, at the body text
 * size with Dynamic Type. Return is a new line. The field keeps its own text. It reports each change with its revision,
 * and clears only on a request whose revision is still its own, so text typed while a send was on its way stays, even
 * when it was typed away and back.
 * Keep it to layout styles; the screen draws the field's background.
 */
export const ChatComposerField: ComponentType<ChatComposerFieldProps> =
  requireNativeView<ChatComposerFieldProps>("ChatComposer");
