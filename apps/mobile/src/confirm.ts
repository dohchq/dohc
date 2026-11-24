import { confirmWords } from "@dohc/interface-words/confirmations";
import { ActionSheetIOS, Alert, Platform } from "react-native";

export interface Choice {
  readonly label: string;
  readonly destructive?: boolean;
}

export interface Choices {
  readonly title?: string;
  readonly message?: string;
  readonly options: readonly Choice[];
  /** "Cancel", except "Go back" when leaving a screen would lose typed work, such as an unsent draft. */
  readonly cancel?: string;
}

type Sheet = (choices: Choices, answer: (index: number | null) => void) => void;
let sheet: Sheet | null = null;

/** Android's menu sheet registers here while it's mounted (src/ChoiceSheet.tsx); the returned function unregisters. */
export function showSheetWith(show: Sheet): () => void {
  sheet = show;
  return () => {
    if (sheet === show) sheet = null;
  };
}

// The platform's own sheet: an action sheet on iOS. On Android, a menu of two or more choices is a Material bottom
// sheet, and a confirmation of one action an alert. Resolves the chosen option's index, or null when cancelled.
export function choose({
  title,
  message,
  options,
  cancel = confirmWords.cancel,
}: Choices): Promise<number | null> {
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      const destructive = options.flatMap((option, index) => (option.destructive ? [index] : []));
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          message,
          options: [...options.map((option) => option.label), cancel],
          cancelButtonIndex: options.length,
          destructiveButtonIndex: destructive,
        },
        (index) => resolve(index < options.length ? index : null),
      );
      return;
    }
    if (options.length > 1 && sheet) {
      sheet({ title, message, options, cancel }, resolve);
      return;
    }
    Alert.alert(
      title ?? "",
      message,
      [
        { text: cancel, style: "cancel", onPress: () => resolve(null) },
        ...options.map((option, index) => ({
          text: option.label,
          style: option.destructive ? ("destructive" as const) : ("default" as const),
          onPress: () => resolve(index),
        })),
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

export interface Confirmation {
  readonly title: string;
  readonly message?: string;
  readonly confirm: string;
  readonly destructive?: boolean;
  readonly cancel?: string;
}

/** A sheet with one action. Resolves true only on confirm. */
export async function confirm({
  confirm: label,
  destructive,
  ...rest
}: Confirmation): Promise<boolean> {
  return (await choose({ ...rest, options: [{ label, destructive }] })) === 0;
}
