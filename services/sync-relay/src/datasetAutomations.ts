import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DatasetHostError, resolveCompatibleDatasetRevision, type createDatasetHost, type DatasetAuthority } from "@dohc/app-backend-runtime/dataset-host";
import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDescription, DatasetDefinition } from "@dohc/security-contract/dataset";
import type { CollectionAutomations, DatasetAutomationHost } from "@dohc/automation-executor/collection-automations";
import type { AppBackendAuth } from "./appBackendAuthority";
import { currentCollectionEditGrant, grantEditsCollection } from "./collectionEditGrant";
import { notFound } from "./errors";
import type { StorageContext } from "./storage/context";

type Host = ReturnType<typeof createDatasetHost<AppBackendAuth>>;
type Context = ReturnType<DatasetAutomationHost["context"]>;
export type DatasetServerPress = Omit<Parameters<CollectionAutomations["pressDataset"]>[0], "pressedBy">;
type Named = Extract<AppBackendAuth, { kind: "named" }>;

/** In-process capabilities. Copying a context's fields never copies its authority. */
export function createDatasetAutomationAuthority(current: () => void, storage: StorageContext) {
  const contexts = new WeakMap<Context, AppBackendAuth>();
  const callers = new WeakMap<object, { auth: Named; context: Context; signal: AbortSignal }>();
  return {
    context(auth: Named, input: Context, signal: AbortSignal): Context {
      current(); signal.throwIfAborted();
      const context = Object.freeze({ automationId: input.automationId, claimId: input.claimId, depth: input.depth, person: input.person });
      const caller = Object.freeze({ ...auth });
      contexts.set(context, caller);
      callers.set(caller, { auth, context, signal });
      return context;
    },
    auth(context: Context): AppBackendAuth {
      const held = contexts.get(context);
      if (!held) throw notFound();
      return held;
    },
    resolve(context: object, workspaceId: string, access: string): DatasetAuthority | null {
      const held = callers.get(context);
      if (!held) return null;
      current(); held.signal.throwIfAborted();
      if (access !== "data" || held.auth.workspaceId !== workspaceId || !storage.workspaceIsOwnedBy(workspaceId, held.auth.userId)) throw notFound();
      return { caller: { kind: "automation", automationId: held.context.automationId }, chainDepth: held.context.depth, ...(held.context.person === null ? {} : { person: held.context.person }),
        principalKey: createHash("sha256").update(JSON.stringify(["dohc-dataset-automation-v1", workspaceId, held.context.automationId])).digest("hex") };
    },
  };
}

export function createDatasetAutomations(input: {
  host: Host; storage: StorageContext; current(): void;
  authority: ReturnType<typeof createDatasetAutomationAuthority>;
}) {
  const { host, storage, current, authority } = input;
  storage.tx(() => storage.db.exec("CREATE INDEX IF NOT EXISTS sync_relay_automation_files ON sync_relay_current_files(workspace_id,path) WHERE path='automations.yaml' OR path GLOB '*/automations.yaml'"));
  const presses = new AsyncLocalStorage<{ auth: Named; datasetId: string; descriptions: Map<string, DatasetDescription>; generation: number | null; signal: AbortSignal }>();
  function owner(workspaceId: string): Named {
    current();
    const row = storage.db.prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id=?").get(workspaceId);
    if (!row || !storage.workspaceIsOwnedBy(workspaceId, String(row.owner_user_id))) throw notFound();
    return { kind: "named", workspaceId, userId: String(row.owner_user_id) };
  }
  function pressDescription(auth: Named, datasetId: string): DatasetDescription {
    current();
    if (!storage.workspaceIsOwnedBy(auth.workspaceId, auth.userId)) {
      const grant = auth.grantId && storage.getShareGrant(auth.grantId);
      if (!grant) throw notFound();
      const allowed = currentCollectionEditGrant(storage, { shareId: grant.shareId, grantId: grant.grantId,
        grantGeneration: grant.generation, userId: auth.userId });
      const definition = host.approvedRevision(owner(auth.workspaceId), { workspaceId: auth.workspaceId, datasetId }).definition;
      if (allowed.share.workspaceId !== auth.workspaceId || !grantEditsCollection(storage, allowed, posix.dirname(definition.schemaPath))) throw notFound();
    }
    return host.describe(auth, { workspaceId: auth.workspaceId, datasetId });
  }
  return {
    /** Also enroll dataset-only workspaces when a computer hosts their schedules. */
    wantedWorkspaces(): string[] {
      current();
      return storage.db.prepare(
        `SELECT DISTINCT c.workspace_id FROM sync_relay_current_files f
         CROSS JOIN dohc_dataset_catalog c ON c.workspace_id=f.workspace_id
           AND substr(json_extract(c.revision_json,'$.definition.schemaPath'),1,length(f.path)-length('automations.yaml')) = substr(f.path,1,length(f.path)-length('automations.yaml'))
         JOIN dohc_dataset_journals j ON j.workspace_id=c.workspace_id AND j.dataset_id=c.dataset_id
         WHERE (f.path='automations.yaml' OR f.path GLOB '*/automations.yaml') AND j.active=1
           AND instr(substr(json_extract(c.revision_json,'$.definition.schemaPath'),length(f.path)-length('automations.yaml')+1),'/')=0
         ORDER BY c.workspace_id`
      ).all().map(row => String(row.workspace_id));
    },
    /** Dataset metadata changes require re-indexing, ordinary claims require only a drain. */
    metadata(workspaceId: string): string {
      current();
      return JSON.stringify([
        storage.db.prepare("SELECT dataset_id,json_extract(revision_json,'$.revisionSha256') AS revision FROM dohc_dataset_catalog WHERE workspace_id=? ORDER BY dataset_id").all(workspaceId),
        storage.db.prepare("SELECT dataset_id,generation FROM dohc_dataset_lifecycle WHERE workspace_id=? ORDER BY dataset_id").all(workspaceId),
        storage.db.prepare("SELECT dataset_id,principal_key,token FROM dohc_dataset_data_grants WHERE workspace_id=? ORDER BY dataset_id,principal_key").all(workspaceId),
      ]);
    },
    async press<T>(auth: Named, datasetId: string, signal: AbortSignal, work: (describe: (datasetId: string) => Promise<DatasetDescription>) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const descriptions = new Map([[datasetId, pressDescription(auth, datasetId)]]);
      const generation = auth.grantId ? storage.getShareGrant(auth.grantId)?.generation ?? null : null;
      return presses.run({ auth, datasetId, descriptions, generation, signal }, async () => {
        const result = await work(async targetId => {
          current(); signal.throwIfAborted();
          const description = descriptions.get(targetId) ?? host.describe(auth, { workspaceId: auth.workspaceId, datasetId: targetId });
          descriptions.set(targetId, description);
          return description;
        });
        signal.throwIfAborted();
        pressDescription(auth, datasetId);
        return result;
      });
    },
    workspace(workspaceId: string, ownerUserId: string, signal: AbortSignal): DatasetAutomationHost {
      const auth = owner(workspaceId);
      if (auth.userId !== ownerUserId) throw notFound();
      const check = (running = true) => {
        current(); if (running) signal.throwIfAborted();
        if (!storage.workspaceIsOwnedBy(workspaceId, ownerUserId)) throw notFound();
      };
      const scope = (datasetId: string) => ({ workspaceId, datasetId });
      return {
        context(value) { check(); return authority.context(auth, value, signal); },
        invoke(context, invocation) {
          check();
          return host.invoke(authority.auth(context), { ...invocation, workspaceId,
            signal: AbortSignal.any([signal, storage.unavailable, ...(invocation.signal ? [invocation.signal] : [])]) });
        },
        invokeAsOwner(invocation) { check(); return host.invoke(auth, { ...invocation, workspaceId, signal: AbortSignal.any([signal, ...(invocation.signal ? [invocation.signal] : [])]) }); },
        datasets() {
          check();
          const definitions: DatasetDefinition[] = [], failures: Array<{ datasetId: string; error: unknown }> = [];
          for (const datasetId of host.datasetIds(auth, { workspaceId })) {
            try { definitions.push(host.approvedRevision(auth, scope(datasetId)).definition); }
            catch (error) { failures.push({ datasetId, error }); }
          }
          return { definitions, failures };
        },
        revision(datasetId) { check(); return host.approvedRevision(auth, scope(datasetId)); },
        generated(datasetId) {
          check(); const approved = host.approvedArtifacts(auth, scope(datasetId));
          return hasGeneratedDatasetOperations(approved.operationSource, approved.revision.definition);
        },
        resolves(reference) {
          check();
          try { resolveCompatibleDatasetRevision(storage.db, scope(reference.datasetId), reference); return true; }
          catch (error) { if (error instanceof DatasetHostError) return false; throw error; }
        },
        dataGrants(datasetId) {
          check();
          const grants: Array<{ principalKey: string; operationIds: string[] }> = [];
          for (let after: string | undefined; ;) {
            const page = host.permissions(auth, { ...scope(datasetId), after, limit: 100 });
            for (const permission of page.permissions) {
              const operationIds = (permission.metadata as { operationIds?: unknown }).operationIds;
              if (permission.kind === "data" && permission.current && Array.isArray(operationIds)) {
                grants.push({ principalKey: permission.principal, operationIds: operationIds.filter((value): value is string => typeof value === "string") });
              }
            }
            if (page.nextCursor === null) return { workspaceId, grants };
            after = page.nextCursor;
          }
        },
        subscribe(datasetId, subscription) { check(); host.automationClaims.subscribe(scope(datasetId), subscription); },
        unsubscribe(datasetId, automationId) { check(); host.automationClaims.unsubscribe(scope(datasetId), automationId); },
        subscriptions() { check(); return host.automationClaims.subscriptions(workspaceId); },
        next() { check(); return host.automationClaims.next(workspaceId); },
        settle(started, outcome) { check(false); return host.automationClaims.settle({ workspaceId, claimId: started.claimId, attempts: started.attempts }, outcome); },
        release(started) { check(false); host.automationClaims.release({ workspaceId, claimId: started.claimId, attempts: started.attempts }); },
        retry(claimId) { check(); return host.automationClaims.retry({ workspaceId, claimId }); },
        claims(automationId, page) { check(false); return host.automationClaims.claims(workspaceId, automationId, page); },
        pruneHistory(keep) { check(false); return host.automationClaims.pruneHistory(workspaceId, keep); },
        claim(automationId, claimId) { check(false); return host.automationClaims.claim(workspaceId, automationId, claimId); },
        failures() { check(); return host.automationClaims.failures(workspaceId); },
        pressed(pressId) { check(); return host.automationClaims.pressed(workspaceId, pressId); },
        assertPressable(datasetId, button) { check(); host.automationClaims.assertPressable({ ...scope(datasetId), ...button }); },
        press(datasetId, request) {
          const { pressedBy, by, ...press } = request;
          const agent = by.kind === "agent" ? { agent: { depth: by.depth } } : {};
          return host.automationClaims.press({ ...scope(datasetId), ...press,
            presser: { kind: storage.workspaceIsOwnedBy(workspaceId, pressedBy) ? "owner" : "named", userId: pressedBy, ...agent } }, () => {
            check();
            const held = presses.getStore();
            if (!held || held.auth.workspaceId !== workspaceId || held.datasetId !== datasetId || held.auth.userId !== pressedBy) throw notFound();
            held.signal.throwIfAborted();
            if (held.auth.grantId && storage.getShareGrant(held.auth.grantId)?.generation !== held.generation) throw notFound();
            for (const [targetId, description] of held.descriptions) {
              const currentDescription = targetId === datasetId ? pressDescription(held.auth, targetId)
                : host.describe(held.auth, { workspaceId, datasetId: targetId });
              if (!isDeepStrictEqual(currentDescription, description)) throw notFound();
            }
          });
        },
      };
    },
  };
}
