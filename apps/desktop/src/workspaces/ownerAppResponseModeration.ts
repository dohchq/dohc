import {createHash} from "node:crypto";

export interface AppResponseAcceptance {
  acceptanceId: string; objectId: string; momentId: string; publicPrincipalId: string;
  versionId: string; collectionPath: string; path: string;
}
export interface BulkUndoAppResponsesInput {
  workspaceId: string; grantId: string; publicPrincipalId?: string;
  operationId: string; afterAcceptanceId?: string; limit: number;
}
export type AppResponseUndoResult = {
  acceptanceId: string; status: "deleted" | "already-absent" | "conflict" | "failed"; momentId?: string;
};
export interface AppResponseUndoSelection extends AppResponseAcceptance {grantId:string; requestId:string}

const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

/** The owner lists immutable acceptances; capture rechecks their native history before deleting. */
export async function bulkUndoAppResponses(input: BulkUndoAppResponsesInput, dependencies: {
  assertCurrent(): void;
  readAcceptances(input: Omit<BulkUndoAppResponsesInput,"operationId">): Promise<{acceptances:AppResponseAcceptance[];nextAcceptanceId:string|null}>;
  undoAcceptedResponse(selection: AppResponseUndoSelection): Promise<Omit<AppResponseUndoResult,"acceptanceId">>;
}): Promise<{items:AppResponseUndoResult[];nextCursor:string|null}> {
  if (!id(input.workspaceId) || !id(input.grantId) || !id(input.operationId) ||
      (input.publicPrincipalId!==undefined && !id(input.publicPrincipalId)) ||
      (input.afterAcceptanceId!==undefined && !id(input.afterAcceptanceId)) ||
      !Number.isSafeInteger(input.limit) || input.limit<1 || input.limit>100) throw new Error("Choose a valid response selection and try again.");
  dependencies.assertCurrent();
  const {operationId,...pageInput}=input;
  const page=await dependencies.readAcceptances(pageInput);
  dependencies.assertCurrent();
  if (!Array.isArray(page.acceptances) || page.acceptances.length>input.limit ||
      (page.nextAcceptanceId!==null && !id(page.nextAcceptanceId))) throw new Error("dohc could not read the selected responses. Refresh and try again.");
  const items:AppResponseUndoResult[]=[];
  const seen=new Set<string>();
  for(const accepted of page.acceptances) {
    if (!id(accepted.acceptanceId) || seen.has(accepted.acceptanceId) ||
        (input.publicPrincipalId!==undefined && accepted.publicPrincipalId!==input.publicPrincipalId)) throw new Error("The response selection changed. Refresh and try again.");
    seen.add(accepted.acceptanceId);
    dependencies.assertCurrent();
    const requestId=`app-response-undo:${createHash("sha256").update(JSON.stringify([input.workspaceId,input.grantId,operationId,accepted.acceptanceId])).digest("hex")}`;
    try {
      const result=await dependencies.undoAcceptedResponse({...accepted,grantId:input.grantId,requestId});
      items.push({acceptanceId:accepted.acceptanceId,...result});
    } catch {
      dependencies.assertCurrent();
      items.push({acceptanceId:accepted.acceptanceId,status:"failed"});
    }
    dependencies.assertCurrent();
  }
  return {items,nextCursor:page.nextAcceptanceId};
}
