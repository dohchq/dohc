import type { ShareHandoffRedemptionCoordinator } from "../shareHandoffRedemption";
import type { shareHandoffOperations } from "./shareOperations";
import type { OperationHandlers } from "./operationTable";

export function createShareHandoffIpcHandlers(dependencies: {
  shareHandoffRedemption: Pick<
    ShareHandoffRedemptionCoordinator,
    "status" | "accept" | "retry" | "dismiss"
  >;
}): OperationHandlers<typeof shareHandoffOperations> {
  const { shareHandoffRedemption } = dependencies;
  return {
    getShareHandoffStatus: () => shareHandoffRedemption.status(),
    acceptShareHandoff: (input) => { shareHandoffRedemption.accept(input.statusId); },
    retryShareHandoff: () => { shareHandoffRedemption.retry(); },
    dismissShareHandoff: (input) => { shareHandoffRedemption.dismiss(input.statusId); },
  };
}
