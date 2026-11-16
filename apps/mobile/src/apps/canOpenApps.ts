import { Platform } from "react-native";
import { phoneWrites } from "../server/phoneWrites";

// Whether this build may run an app. An app can write its Collection through the server, so running one waits for
// phone writes, as Approve does. Only iOS: on Android, react-native-webview doesn't ask about every frame's loads and
// saves downloads, so the runner's rules don't hold there.
export const canOpenApps = phoneWrites && Platform.OS === "ios";
