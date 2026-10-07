import {decodeWorkspaceResult, WORKSPACE_METHOD} from "@dohc/workspace-engine-client";
import type {AutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import type {AutomationReplica} from "./automationReplicas";

export class AutomationRecordPresserChanged extends Error {
  constructor() {
    super("Automation record delivery claim changed.");
    this.name = "AutomationRecordPresserChanged";
  }
}

/** The durable claim binds a queued write to its original authenticated recipient authority. */
export async function automationRecordPresser(
  replica: Pick<AutomationReplica, "workspace" | "nextRequestId"> & {readonly client: Pick<AutomationReplica["client"], "sendRequest">},
  declaration: AutomationDeclaration | undefined,
  signal: AbortSignal,
): Promise<{readonly hostPressId: string; readonly automationId: string} | {readonly grantId: string; readonly grantGeneration: number} | undefined> {
  if (!declaration || declaration.attribution.onBehalfOf === undefined) return undefined;
  const run = declaration.attribution.run;
  if (!run) throw new AutomationRecordPresserChanged();
  let claimId = run.claimId;
  let automationId = declaration.automationId;
  const seen = new Set<string>();
  while (!seen.has(claimId)) {
    seen.add(claimId);
    const response = await replica.client.sendRequest({id: replica.nextRequestId(), workspace: replica.workspace,
      method: WORKSPACE_METHOD.automationsGetClaim, params: {claimId}}, signal);
    const {claim} = decodeWorkspaceResult(WORKSPACE_METHOD.automationsGetClaim, response.result);
    if (!claim || claim.claimId !== claimId || claim.automationId !== automationId ||
      (claim.change.onBehalfOf ?? undefined) !== declaration.attribution.onBehalfOf) {
      throw new AutomationRecordPresserChanged();
    }
    if (claim.change.kind === "button") {
      const key = "key" in claim.trigger ? claim.trigger.key : "";
      const bound = /^press:([^.]+)\.([0-9a-f]{16})\.([0-9a-f]{16})$/u.exec(key);
      if (!bound) throw new AutomationRecordPresserChanged();
      return {hostPressId: bound[1]!, automationId: claim.automationId};
    }
    const author = claim.change.sharedAuthor;
    if (author?.kind === "named" && author.userId === declaration.attribution.onBehalfOf) {
      return {grantId: author.grantId, grantGeneration: author.grantGeneration};
    }
    if (!claim.parentClaimId || claim.change.actorKind !== "automation" || !claim.change.authorOriginId) {
      throw new AutomationRecordPresserChanged();
    }
    claimId = claim.parentClaimId;
    automationId = claim.change.authorOriginId;
  }
  throw new AutomationRecordPresserChanged();
}
