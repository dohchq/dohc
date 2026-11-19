import * as Notifications from "expo-notifications";
import type { Account } from "../server/account";
import type { NativeAlerts, Permission } from "./alerts";

const permission = (status: Notifications.NotificationPermissionsStatus): Permission =>
  status.status === Notifications.PermissionStatus.GRANTED
    ? "granted"
    : status.status === Notifications.PermissionStatus.DENIED
      ? "denied"
      : "undetermined";

export const nativeAlerts: NativeAlerts = {
  permission: async () => permission(await Notifications.getPermissionsAsync()),
  ask: async () =>
    permission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    ),
  token: async () => String((await Notifications.getDevicePushTokenAsync()).data).toLowerCase(),
  onToken(listener) {
    const subscription = Notifications.addPushTokenListener(listener);
    return () => subscription.remove();
  },
};

/** When a sign-in ends, its delivered alerts leave the phone, and the phone stops taking alerts until the next one. */
export function clearAlertsAtSignOut(account: Pick<Account, "state" | "subscribe">): () => void {
  let signedIn = account.state().status === "signed-in";
  return account.subscribe(() => {
    const now = account.state().status === "signed-in";
    if (signedIn && !now) {
      void Notifications.dismissAllNotificationsAsync().catch(() => undefined);
      void Notifications.unregisterForNotificationsAsync().catch(() => undefined);
    }
    signedIn = now;
  });
}
