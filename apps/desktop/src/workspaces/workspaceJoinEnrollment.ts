import type { RelayWorkspaceIdentity } from "@dohc/workspace-contracts/relay";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";

export async function bootstrapJoinedWorkspace(input: {
  workspaceId: string;
  identity: RelayWorkspaceIdentity | null;
  passphrase?: string;
  transport: EngineRelayWorkspaceClient;
  installDataKey: (dataKey: Buffer) => Promise<void>;
}): Promise<void> {
  await input.transport.bootstrapJoinIdentity(input.identity, async () => {
    await enrollWorkspaceKeyEnvelope({
      workspaceId: input.workspaceId,
      dataKey: null,
      ...(input.passphrase === undefined
        ? {}
        : { passphrase: input.passphrase }),
      transport: input.transport,
      installDataKey: input.installDataKey,
    });
  });
}
