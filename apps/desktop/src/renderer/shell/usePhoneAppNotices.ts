import { useEffect, useRef } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

export function usePhoneAppNotices(input: {
  workspaceId: string;
  apps: SyncStatusResult["appsNotSent"] | null;
  report: ReturnType<typeof useShellError>["reportShellFailure"];
  clear: ReturnType<typeof useShellError>["clearIdentity"];
}) {
  const { workspaceId, apps, report, clear } = input;
  const shown = useRef(new Map<string | null, string>());
  useEffect(() => {
    if (apps === null) return;
    const rows = new Map((apps ?? []).map((app) => [app.appRoot, app.reason]));
    for (const appRoot of shown.current.keys()) {
      if (rows.has(appRoot)) continue;
      shown.current.delete(appRoot);
      clear(`phone-app:${appRoot ?? ""}`);
    }
    for (const [appRoot, reason] of rows) {
      if (shown.current.get(appRoot) === reason) continue;
      shown.current.set(appRoot, reason);
      const subject = appRoot ?? "your apps";
      report({
        title: appRoot === null ? "Apps not sent to your phones" : "App not sent to your phones",
        message: `dohc could not send ${subject} to your phones. ${reason}`,
        identity: `phone-app:${appRoot ?? ""}`,
        retry: () => {
          shown.current.delete(appRoot);
          void bridge()
            .retryPhoneApp({ workspaceId, appRoot })
            .catch((cause: unknown) =>
              report({ message: `dohc could not send ${subject} to your phones.`, cause }),
            );
        },
      });
    }
  }, [workspaceId, apps, report, clear]);
}
