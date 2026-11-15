import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** Asks the field to clear itself if its text has not changed since `revision`. Each new `token` asks once. */
export interface ClearRequest {
  readonly revision: number;
  readonly token: number;
}

/**
 * Asks the field to replace `start` until `end`, in UTF-16 code units, with `replacement`, and put its caret at `caret`,
 * an offset in the text that results. The field does it only while it is just as the report numbered `sequence` saw it:
 * its text at `revision`, `expected` in that range, the caret alone at `end`, nothing being composed, and the field
 * editable. Each new `token` asks once, and the field answers each once, in `replaced`.
 */
export interface ReplaceRequest {
  readonly token: number;
  readonly revision: number;
  readonly sequence: number;
  readonly start: number;
  readonly end: number;
  readonly expected: string;
  readonly replacement: string;
  readonly caret: number;
}

/** The field's answer to a `ReplaceRequest`: `applied` when it made the edit, or false when it changed nothing. */
export interface ReplaceAnswer {
  readonly token: number;
  readonly applied: boolean;
}

/** A UTF-16 range of the field's text, `end` excluded. */
export interface FieldRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A report of the field's text, selection and composition. The field reports each change to any of them, and each
 * answer to a request, in order.
 */
export interface FieldChange {
  readonly text: string;
  /** Counts every change to the text, the field's own clears included, so an edit away and back still counts. */
  readonly revision: number;
  /** Counts every report. A selection or composition alone raises it, and leaves `revision` as it was. */
  readonly sequence: number;
  /** The selection, in UTF-16 code units. A caret alone has both at the same offset. */
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** The text an input method is still composing, as marked text, or absent when none is. */
  readonly composing?: FieldRange;
  /** The `token` of the request whose clear made this change, or 0 for an edit. */
  readonly cleared: number;
  /** The `token` of a request the field refused, reported without a change to its text or revision, or 0. */
  readonly refused: number;
  /** The field's answer to a `ReplaceRequest`, only on the report it answers. */
  readonly replaced?: ReplaceAnswer;
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
  /** Token 0 asks nothing. */
  replaceIf: ReplaceRequest;
  /**
   * Text kept elsewhere, as a draft, that the field shows once, only while it's still empty and unedited. It reports it
   * as an edit, with a new revision, so the screen's text matches. "" shows nothing.
   */
  initialText: string;
  onChangeText: (event: { nativeEvent: FieldChange }) => void;
  /** The height the text needs at the field's width, in points, sent when it changes. */
  onContentHeight: (event: { nativeEvent: { height: number } }) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The composer's text field: a native multiline text view, UITextView on iOS and EditText on Android, at the body text
 * size with Dynamic Type. Return is a new line. The field keeps its own text. It reports each change with its revision,
 * and clears only on a request whose revision is still its own, so text typed while a send was on its way stays, even
 * when it was typed away and back. It also reports its selection and composition, and replaces a range only on a
 * request made from its latest report, as one edit that one undo reverses.
 * Keep it to layout styles; the screen draws the field's background.
 */
export const ChatComposerField: ComponentType<ChatComposerFieldProps> =
  requireNativeView<ChatComposerFieldProps>("ChatComposer");
