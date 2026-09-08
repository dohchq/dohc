import { CHANNELS } from "./channels";
import {
  AcceptShareHandoffPayload,
  DismissShareHandoffPayload,
  ShareHandoffStatus,
} from "./bridgeContract";
import type { ShareHandoffRedemptionCoordinator } from "../shareHandoffRedemption";

export function registerShareHandoffIpcHandlers<Event>(dependencies: {
  registerHandler(
    channel: string,
    handler: (event: Event, ...args: unknown[]) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
  shareHandoffRedemption: Pick<
    ShareHandoffRedemptionCoordinator,
    "status" | "accept" | "retry" | "dismiss"
  >;
}): void {
  const { registerHandler, assertTrustedSender, shareHandoffRedemption } = dependencies;
  function assertNoShareHandoffArguments(args: unknown[]): void {
    if (args.length !== 0) {
      throw new Error("Share handoff actions do not accept arguments.");
    }
  }

  registerHandler(CHANNELS.getShareHandoffStatus, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    assertNoShareHandoffArguments(args);
    return ShareHandoffStatus.parse(shareHandoffRedemption.status());
  });

  registerHandler(CHANNELS.acceptShareHandoff, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    if (args.length !== 1) {
      throw new Error("Share handoff acceptance requires one status identity.");
    }
    const input = AcceptShareHandoffPayload.parse(args[0]);
    shareHandoffRedemption.accept(input.statusId);
  });

  registerHandler(CHANNELS.retryShareHandoff, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    assertNoShareHandoffArguments(args);
    shareHandoffRedemption.retry();
  });

  registerHandler(CHANNELS.dismissShareHandoff, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    if (args.length !== 1) {
      throw new Error("Share handoff dismissal requires one status identity.");
    }
    const input = DismissShareHandoffPayload.parse(args[0]);
    shareHandoffRedemption.dismiss(input.statusId);
  });

}
