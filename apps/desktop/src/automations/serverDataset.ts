import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { AUTOMATION_SERVER_INSTALL_ID } from "@dohc/workspace-contracts/relay";
import type { ServerDataset } from "@dohc/automation-executor/collection-automations";
import type { OwnerDatasetData } from "../workspaces/remoteDataset";
import { computersOfAnswer, hostOfAnswer } from "./automationHost";

// A Collection on the workspace's server, as the ⚡ panel and its buttons
// read it: the server's approved rules and data grants, and what the server
// runs. The server runs its automations; this computer never does.

/**
 * What the server runs, from its answer to the owner's automation host read:
 * the relay lists the server among the computers only while it runs
 * automations, and it runs schedules and Group messages only while the host
 * record names it. Null for an answer dohc cannot read.
 */
export function serverRunsOfAnswer(answer: { status: number; body: unknown }): ServerDataset["runs"] {
  const host = hostOfAnswer(answer), computers = computersOfAnswer(answer);
  if (host === undefined || computers === undefined) return null;
  if (!computers.some((computer) => computer.kind === "server")) return "off";
  return host?.installId === AUTOMATION_SERVER_INSTALL_ID && host.handoverFrom === null ? "all" : "no-schedules";
}

/**
 * The Collection with this id on the server, or null when the server has
 * stopped running it, as for an archived one. `automationHost` reads the
 * owner's automation host state; a failed read leaves what the server runs
 * unknown.
 */
export async function readServerDataset(
  workspaceId: string,
  datasetId: string,
  data: Pick<OwnerDatasetData, "approvedArtifacts"> & { permissions: NonNullable<OwnerDatasetData["permissions"]> },
  automationHost: () => Promise<{ status: number; body: unknown }>,
): Promise<ServerDataset | null> {
  const [approved, grants, runs] = await Promise.all([
    data.approvedArtifacts(datasetId),
    (async () => {
      const grants: Array<{ principalKey: string; operationIds: string[] }> = [];
      for (let after: string | undefined; ;) {
        const page = await data.permissions({ action: "permissions", workspaceId, datasetId, ...(after === undefined ? {} : { after }), limit: 100 });
        for (const permission of page.permissions) {
          if (permission.kind === "data" && permission.current) grants.push({ principalKey: permission.principal, operationIds: [...permission.metadata.operationIds] });
        }
        if (page.nextCursor === null) return grants;
        after = page.nextCursor;
      }
    })(),
    automationHost().then(serverRunsOfAnswer, () => null),
  ]);
  if (!approved.active) return null;
  return {
    approved: approved.revision,
    generated: hasGeneratedDatasetOperations(approved.operationSource, approved.revision.definition),
    grants: { workspaceId, grants },
    runs,
  };
}
