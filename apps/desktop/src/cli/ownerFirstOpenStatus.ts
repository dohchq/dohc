import {cliResultSchemas} from "@dohc/cli/protocol";
import {z} from "zod";
import {assertOriginalWorkspace, createOwnerRelayShareOperation} from "../ipc/ownerRelayShareHandler";
import type {OwnerLiveDocumentActionDependencies} from "../ipc/relaySharesIpc";
import type {CloudCredentials} from "../workspaces/cloudCredentialStore";

/** The owner list's agent projection. Bindings and relay credentials stay in main. */
export function createOwnerFirstOpenStatusReader<Workspace extends {workspaceId: string; shareView?: unknown}, Operation extends {workspace: Workspace; assertCurrent(): void}>(
  dependencies: Pick<OwnerLiveDocumentActionDependencies<Workspace>, "remoteForWorkspace" | "currentCredentialGeneration" | "relayShareJsonWithCredentials">,
) {
  const owner = createOwnerRelayShareOperation<Workspace, Operation, CloudCredentials>({
    remoteForWorkspace: dependencies.remoteForWorkspace, credentialGeneration: dependencies.currentCredentialGeneration,
  });
  return (operation: Operation) => owner(operation, async (operation, credentials, session) => {
    const raw = await session.run(() => dependencies.relayShareJsonWithCredentials<unknown>(credentials,
      `/sync/${encodeURIComponent(operation.workspace.workspaceId)}/live-host`));
    const {documents} = z.object({ok: z.literal(true), documents: z.array(z.unknown())}).parse(raw);
    const result = documents.flatMap(document => {
      const row = z.record(z.string(), z.unknown()).safeParse(document);
      if (!row.success) return [];
      const {path, objectId, status, reason, firstOpen} = row.data;
      const parsed = cliResultSchemas.liveDocuments.safeParse({ok: true, documents: [{
        path, objectId, status, ...(reason === undefined ? {} : {reason}), ...(firstOpen === undefined ? {} : {firstOpen}),
      }]});
      return parsed.success && parsed.data.ok ? parsed.data.documents : [];
    });
    for (const document of result) {
      const source = document.firstOpen?.source;
      if (source && (source.workspaceId !== operation.workspace.workspaceId || source.objectId !== document.objectId || source.path !== document.path)) {
        throw new Error("The live document list changed. Refresh the list and try again.");
      }
    }
    return result;
  }, assertOriginalWorkspace);
}
