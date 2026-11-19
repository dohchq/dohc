import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAccount } from "../account/AccountProvider";
import { alertTarget, type AlertsState } from "./alerts";

const UNAVAILABLE: AlertsState = { status: "unavailable" };
const none = { subscribe: () => () => undefined, state: () => UNAVAILABLE };

/** Opens a tapped alert's message, at launch too, once the workspace list and the alerts' row are read. */
export function AlertTaps() {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const { alerts, workspaces, chooseWorkspace } = useAccount();
  const alertsState = useSyncExternalStore((alerts ?? none).subscribe, (alerts ?? none).state);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { request } = response.notification;
    if (handled.current === request.identifier) return;
    if (workspaces.status === "loading" || alertsState.status === "loading") return;
    handled.current = request.identifier;
    Notifications.clearLastNotificationResponse();
    const target = alertTarget(request.content.data, alerts?.generation() ?? null, workspaces);
    if (!target) return router.navigate("/home");
    chooseWorkspace(target.workspaceId);
    router.push({
      pathname: "/chat/[id]",
      params: {
        id: target.threadId,
        thread: "1",
        workspace: target.workspaceId,
        message: target.messageId,
      },
    });
  }, [response, workspaces, alerts, alertsState, chooseWorkspace, router]);
  return null;
}
