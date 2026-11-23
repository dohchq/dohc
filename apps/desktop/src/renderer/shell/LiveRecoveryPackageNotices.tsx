import { useEffect } from "react";
import type { ListOwnerLiveRecoveryPackagesResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

export type LiveRecoveryPackage = ListOwnerLiveRecoveryPackagesResult["packages"][number];

export function LiveRecoveryPackageNotices(props: {
  workspaceId: string;
  show: (kept: LiveRecoveryPackage) => void;
  fail: (error: unknown, retry: () => void) => void;
}): null {
  const { workspaceId, show, fail } = props;
  const { value, error, retry } = useWorkspaceQuery(useWorkspaceSession(), {
    key: workspaceId,
    load: () => bridge().listOwnerLiveRecoveryPackages({ workspaceId }),
  });
  useEffect(() => {
    for (const kept of value?.packages ?? []) show(kept);
  }, [show, value]);
  useEffect(() => {
    if (error) fail(error, () => void retry());
  }, [error, fail, retry]);
  return null;
}
