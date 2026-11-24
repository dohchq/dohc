import { accountWords, type ServerProblemKind } from "@dohc/interface-words/account";
import { noticesWords } from "@dohc/interface-words/notices";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount } from "../account/AccountProvider";
import { Toast } from "../notices/Toast";
import { serverName } from "../server/origin";
import { openTap, tapData, type AlertsState } from "./alerts";

const UNAVAILABLE: AlertsState = { status: "unavailable" };
const none = { subscribe: () => () => undefined, state: () => UNAVAILABLE };

export function AlertTaps() {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const { state, alerts, workspaceList, chooseWorkspace } = useAccount();
  const signIn = state.status === "signed-in" ? state.signIn : null;
  const alertsState = useSyncExternalStore((alerts ?? none).subscribe, (alerts ?? none).state);
  const handled = useRef<string | null>(null);
  const [failed, setFailed] = useState<ServerProblemKind | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { request } = response.notification;
    if (!signIn || handled.current === request.identifier || alertsState.status === "loading")
      return;
    handled.current = request.identifier;
    setFailed(null);
    const generation = () => alerts?.generation() ?? null;
    void openTap(signIn, tapData(request), generation, workspaceList).then((target) => {
      if (handled.current !== request.identifier) return;
      if (target === null || target === "offline" || target === "server-busy") {
        handled.current = null;
        return setFailed(target);
      }
      Notifications.clearLastNotificationResponse();
      if (target === "home") return router.navigate("/home");
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
    });
  }, [response, signIn, alerts, alertsState, attempt, workspaceList, chooseWorkspace, router]);

  if (!failed || !signIn) return null;
  return (
    <Toast
      message={{
        tone: "failure",
        title: accountWords.problem(failed, serverName(signIn.origin)),
        action: {
          label: noticesWords.tryAgain,
          onPress: () => setAttempt((count) => count + 1),
        },
      }}
      onClose={() => setFailed(null)}
    />
  );
}
