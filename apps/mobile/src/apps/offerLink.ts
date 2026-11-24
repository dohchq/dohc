import { appWords } from "@dohc/interface-words/apps";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { Alert, Linking, Platform } from "react-native";

const ignore = () => undefined;
let asking = false;

/**
 * Asks "Open in Safari?" ("Open in browser?" on Android), naming the link's host, before a link leaves dohc, one question at a time. Pass only an
 * address the external-link rule allowed (appNavigation.ts).
 */
export function offerLink(url: string): void {
  if (asking) return;
  asking = true;
  const done = () => void (asking = false);
  Alert.alert(
    appWords.openOutside[Platform.OS === "ios" ? "ios" : "android"],
    new URL(url).host,
    [
      { text: confirmWords.cancel, style: "cancel", onPress: done },
      {
        text: appWords.open,
        onPress: () => {
          done();
          void Linking.openURL(url).catch(ignore);
        },
      },
    ],
    { onDismiss: done },
  );
}
