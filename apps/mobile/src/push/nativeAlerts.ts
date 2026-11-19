import * as Notifications from "expo-notifications";
import type { Account, AccountState } from "../server/account";
import type { NativeAlerts, Permission } from "./alerts";

const permission = (status: Notifications.NotificationPermissionsStatus): Permission =>
  status.status === Notifications.PermissionStatus.GRANTED
    ? "granted"
    : status.status === Notifications.PermissionStatus.DENIED
      ? "denied"
      : "undetermined";

const hex = (token: Notifications.DevicePushToken) => String(token.data).toLowerCase();

export const nativeAlerts: NativeAlerts = {
  permission: async () => permission(await Notifications.getPermissionsAsync()),
  ask: async () =>
    permission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    ),
  token: async () => hex(await Notifications.getDevicePushTokenAsync()),
  onToken(listener) {
    const subscription = Notifications.addPushTokenListener((token) => listener(hex(token)));
    return () => subscription.remove();
  },
};

const phase = (state: AccountState) =>
  state.status === "signed-in"
    ? "in"
    : state.status === "unreadable" || (state.status === "signed-out" && state.pendingSignOut)
      ? "pending"
      : "out";

export function clearAlertsAtSignOut(account: Pick<Account, "state" | "subscribe">): () => void {
  let was: ReturnType<typeof phase> = "out";
  const check = () => {
    const now = phase(account.state());
    if (now !== "in" && (was === "in" || (now === "pending" && was !== "pending"))) {
      void Notifications.dismissAllNotificationsAsync().catch(() => undefined);
      void Notifications.unregisterForNotificationsAsync().catch(() => undefined);
    }
    was = now;
  };
  check();
  return account.subscribe(check);
}
