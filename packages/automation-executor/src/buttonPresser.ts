import { effectiveDatasetOperations } from "@dohc/security-contract/dataset-authorization";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { describeApprovedDataset, type DatasetDescription, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import { AutomationRunWait } from "./automationRunWait";
export { AutomationRunWait };

export const SHARED_BUTTON_DENIED = "This button cannot use the requested Collection or operations.";
export const SHARED_BUTTON_MOVED = "This Collection moved. Its files will update here soon.";
export const SHARED_BUTTON_FIELD_CHANGED = "This field is no longer a Button. The Collection's files will update here soon.";
export const SHARED_BUTTON_FAILED = "This button did not finish. Check its automation, then press it again.";
export const SHARED_BUTTON_UNCHECKED = "dohc cannot check this button now. Try again when its host is available.";

export interface PresserDatasetHost {
  revision(datasetId: string): DatasetRevision;
  dataGrants(datasetId: string): { workspaceId: string; grants: readonly { principalKey: string; operationIds: readonly string[] }[] };
}

/** Intersect live named share authority with current permissions on the authoritative dataset host. */
export function describeButtonPresser(host: PresserDatasetHost, authority: RelayButtonAuthority, datasetId: string): DatasetDescription {
  try { return describeCurrentPresser(host, authority, datasetId); }
  catch (error) {
    if (error instanceof AutomationRunWait) throw error;
    if (error instanceof DatasetHostError || error instanceof Error && error.message === SHARED_BUTTON_DENIED) throw new Error(SHARED_BUTTON_DENIED);
    throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED);
  }
}

function describeCurrentPresser(host: PresserDatasetHost, authority: RelayButtonAuthority, datasetId: string): DatasetDescription {
  const revision = host.revision(datasetId);
  const permissions = host.dataGrants(datasetId);
  if (revision.datasetId !== datasetId || permissions.workspaceId !== authority.workspaceId) throw new Error(SHARED_BUTTON_DENIED);
  const allowed = new Set<string>();
  for (const principal of authority.principals) {
    if (principal.userId !== authority.userId) throw new Error(SHARED_BUTTON_DENIED);
    const key = datasetPrincipalKey(authority.workspaceId, principal.grantId, principal.userId);
    const grant = permissions.grants.find(candidate => candidate.principalKey === key);
    if (!grant || grant.operationIds.length === 0) continue;
    for (const operation of effectiveDatasetOperations({ kind: "dataset", datasetId, revision: revision.revision,
      revisionSha256: revision.revisionSha256, operationIds: grant.operationIds }, revision,
    { kind: "named", userId: principal.userId, grantId: principal.grantId, access: principal.access, helper: true })) allowed.add(operation.operationId);
  }
  return describeApprovedDataset(revision, revision.definition.operations.filter(operation => allowed.has(operation.operationId)));
}

export type DatasetOperationCeiling = (datasetId: string, operationId: string) => void;
