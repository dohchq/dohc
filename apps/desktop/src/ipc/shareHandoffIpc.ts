import type { ShareHandoffRedemptionCoordinator } from "../shareHandoffRedemption";
import type { ShareHandoffStatus } from "./bridgeContract";
import type { shareHandoffOperations } from "./shareOperations";
import type { OperationHandlers } from "./operationTable";

// One window takes a handoff: the one a link lands in. A card in every
// window would act in every window at once, so the others show none.
export function shareHandoffStatusFor(takesHandoff: boolean, status: ShareHandoffStatus): ShareHandoffStatus {
  return takesHandoff ? status : { status: "idle" };
}

export function sendShareHandoffStatus<Window>(input: {
  windows: readonly Window[];
  takesHandoff(window: Window): boolean;
  status: ShareHandoffStatus;
  send(window: Window, status: ShareHandoffStatus): void;
}): void {
  for (const window of input.windows) {
    input.send(window, shareHandoffStatusFor(input.takesHandoff(window), input.status));
  }
}

export function createShareHandoffIpcHandlers<Event>(dependencies: {
  shareHandoffRedemption: Pick<
    ShareHandoffRedemptionCoordinator,
    "status" | "accept" | "retry" | "dismiss"
  >;
  // Whether the window that asks is the one that takes a handoff.
  takesHandoff(event: Event): boolean;
}): OperationHandlers<typeof shareHandoffOperations, Event> {
  const { shareHandoffRedemption, takesHandoff } = dependencies;
  return {
    getShareHandoffStatus: (_input, { event }) =>
      shareHandoffStatusFor(takesHandoff(event), shareHandoffRedemption.status()),
    acceptShareHandoff: (input) => { shareHandoffRedemption.accept(input.statusId); },
    retryShareHandoff: () => { shareHandoffRedemption.retry(); },
    dismissShareHandoff: (input) => { shareHandoffRedemption.dismiss(input.statusId); },
  };
}
