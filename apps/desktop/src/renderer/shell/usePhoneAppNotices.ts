import { useEffect, useRef } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

type NotSent = NonNullable<SyncStatusResult["appsNotSent"]>;

export function usePhoneAppNotices(input: {
  workspaceId: string;
  apps: SyncStatusResult["appsNotSent"] | null;
  report: ReturnType<typeof useShellError>["reportShellFailure"];
  clear: ReturnType<typeof useShellError>["clearIdentity"];
}) {
  const { workspaceId, report, clear } = input;
  const listed = useRef<string[]>([]);
  const key = input.apps === null ? null : JSON.stringify(input.apps ?? []);
  useEffect(() => {
    if (key === null) return;
    const rows = JSON.parse(key) as NotSent;
    const identities = rows.map((row) => `phone-app:${row.appRoot ?? ""}`);
    for (const identity of listed.current) if (!identities.includes(identity)) clear(identity);
    listed.current = identities;
    for (const { appRoot, reason } of rows) {
      const subject = appRoot ?? "your apps";
      report({
        title: appRoot === null ? "Apps not sent to your phones" : "App not sent to your phones",
        message: `dohc could not send ${subject} to your phones. ${reason}`,
        identity: `phone-app:${appRoot ?? ""}`,
        repeat: true,
        retry: () =>
          void bridge()
            .retryPhoneApp({ workspaceId, appRoot })
            .catch((cause: unknown) =>
              report({ message: `dohc could not send ${subject} to your phones.`, cause }),
            ),
      });
    }
  }, [key, workspaceId, report, clear]);
}
