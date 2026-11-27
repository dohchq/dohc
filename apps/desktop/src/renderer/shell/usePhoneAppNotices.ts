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
  const reported = useRef(new Map<string, string>());
  useEffect(() => {
    if (apps === null) return;
    const rows = new Map((apps ?? []).map((row) => [`phone-app:${row.appRoot ?? ""}`, row]));
    for (const identity of reported.current.keys()) {
      if (rows.has(identity)) continue;
      reported.current.delete(identity);
      clear(identity);
    }
    for (const [identity, { appRoot, reason }] of rows) {
      if (reported.current.get(identity) === reason) continue;
      reported.current.set(identity, reason);
      const subject = appRoot ?? "your apps";
      report({
        title: appRoot === null ? "Apps not sent to your phones" : "App not sent to your phones",
        message: `dohc could not send ${subject} to your phones. ${reason}`,
        identity,
        retry: () => {
          reported.current.delete(identity);
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
