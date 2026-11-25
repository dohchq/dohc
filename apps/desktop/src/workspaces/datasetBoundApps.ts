import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import {
  datasetRevisionsPreserveAccess,
  type AppDatasetCapability,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import { assessAppDatasetDrift } from "@dohc/security-contract/dataset-authorization";
import type { DatasetBoundApp, DatasetPermissionsPage } from "@dohc/cli/dataset";
import type { LocalAppRow } from "./localAppStore";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";

export interface ShareLinkPublication {
  publicationId: string;
  active: boolean;
  linkCurrent?: boolean;
  operatorTakedown?: boolean;
  authorityRevision: number;
  shareId: string;
  grantId: string;
  candidate: unknown;
}

export function parseShareLinkPublication(
  workspaceId: string,
  ownerUserId: string,
  publicationId: string,
  raw: unknown,
): ShareLinkPublication | null {
  const row = raw as Record<string, unknown> | null;
  const owner = row?.owner as Record<string, unknown> | undefined;
  return !row ||
    row.publicationId !== publicationId ||
    typeof row.active !== "boolean" ||
    (row.linkCurrent !== undefined && typeof row.linkCurrent !== "boolean") ||
    !Number.isSafeInteger(row.authorityRevision) ||
    (row.authorityRevision as number) < 1 ||
    owner?.workspaceId !== workspaceId ||
    owner.ownerUserId !== ownerUserId ||
    typeof owner.shareId !== "string" ||
    owner.shareId.length < 1 ||
    owner.shareId.length > 200 ||
    typeof owner.grantId !== "string" ||
    owner.grantId.length < 1 ||
    owner.grantId.length > 200
    ? null
    : {
        publicationId,
        active: row.active,
        linkCurrent: row.linkCurrent !== false,
        operatorTakedown: Boolean(row.operatorTakedown),
        authorityRevision: row.authorityRevision as number,
        shareId: owner.shareId,
        grantId: owner.grantId,
        candidate: row.candidate,
      };
}

const capFor = (capabilities: readonly unknown[], datasetId: string) =>
  capabilities.find(
    (c): c is AppDatasetCapability =>
      Boolean(c) &&
      typeof c === "object" &&
      (c as AppDatasetCapability).kind === "dataset" &&
      (c as AppDatasetCapability).datasetId === datasetId,
  );

export async function discoverDatasetBoundApps(input: {
  datasetId: string;
  targetRevision: DatasetRevision | (() => Promise<DatasetRevision>);
  previousRevision?: DatasetRevision;
  initialPermissionsPage?: DatasetPermissionsPage;
  permissionsPage?(): Promise<DatasetPermissionsPage>;
  historyRevision?(sha: string): Promise<{ revision: DatasetRevision }>;
  lookupLocalApps?(ids: readonly string[]): Promise<ReadonlyMap<string, LocalAppRow> | null>;
  readShareLinkPublication?(id: string, signal: AbortSignal): Promise<ShareLinkPublication | null>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ boundApps: DatasetBoundApp[]; boundAppsIncomplete?: true }> {
  input.signal.throwIfAborted();
  const bounded = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 5_000)]);
  const boundApps: DatasetBoundApp[] = [];
  let incomplete = false;
  const finish = () =>
    incomplete ? { boundApps, boundAppsIncomplete: true as const } : { boundApps };
  const safe = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    if (input.signal.aborted) input.signal.throwIfAborted();
    if (bounded.aborted) {
      incomplete = true;
      return fallback;
    }
    let onAbort: (() => void) | undefined;
    try {
      const pending = work();
      pending.catch(() => {});
      const value = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(bounded.reason ?? new Error("Discovery timed out."));
          bounded.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      input.signal.throwIfAborted();
      return value;
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      incomplete = true;
      return fallback;
    } finally {
      if (onAbort) bounded.removeEventListener("abort", onAbort);
    }
  };

  const page =
    input.initialPermissionsPage ??
    (input.permissionsPage ? await safe(input.permissionsPage, undefined) : undefined);
  if (!page) return finish();
  if (page.nextCursor !== null) incomplete = true;
  const bindings = page.permissions.filter((e) => e.kind === "app");
  if (bindings.length === 0) return finish();

  const target =
    typeof input.targetRevision === "function"
      ? await safe(input.targetRevision, undefined)
      : input.targetRevision;
  if (!target) return { boundApps: [], boundAppsIncomplete: true };

  const localRows = input.lookupLocalApps
    ? await safe(() => input.lookupLocalApps!(bindings.map((e) => e.principal)), null)
    : new Map<string, LocalAppRow>();
  if (localRows === null) incomplete = true;

  const preservesAccess =
    input.previousRevision === undefined ||
    datasetRevisionsPreserveAccess(input.previousRevision, target);
  const history = new Map<string, DatasetRevision | undefined>([
    [target.revisionSha256, target],
    ...(input.previousRevision
      ? [[input.previousRevision.revisionSha256, input.previousRevision] as const]
      : []),
  ]);
  const add = async (
    meta: Pick<
      DatasetBoundApp,
      "scope" | "publicationId" | "authorityRevision" | "appRoot" | "shareId" | "grantId"
    >,
    cap: AppDatasetCapability,
    bindingCurrent: boolean,
  ) => {
    let pinnedRevision: DatasetRevision | undefined;
    const sha = cap.revisionSha256;
    if (history.has(sha)) pinnedRevision = history.get(sha);
    else if (input.historyRevision && !bounded.aborted) {
      const saved = await safe(() => input.historyRevision!(sha), undefined);
      pinnedRevision =
        saved?.revision.datasetId === input.datasetId && saved.revision.revisionSha256 === sha
          ? saved.revision
          : undefined;
      if (!pinnedRevision) incomplete = true;
      history.set(sha, pinnedRevision);
    } else if (bounded.aborted) {
      incomplete = true;
    }
    const drift = assessAppDatasetDrift(cap, target, {
      scope: meta.scope,
      bindingCurrent,
      preservesAccess,
      pinnedRevision,
    });
    boundApps.push({
      ...meta,
      ...(cap.alias !== undefined ? { alias: cap.alias } : {}),
      pinnedRevision: cap.revision,
      pinnedRevisionSha256: cap.revisionSha256,
      operationIds: [...cap.operationIds],
      status: drift.status,
      ...(drift.reasons.length > 0 ? { reasons: drift.reasons } : {}),
    });
  };

  const remote = [];
  for (const e of bindings) {
    const row = localRows?.get(e.principal);
    const cap = row ? capFor(row.candidate.capabilities, input.datasetId) : undefined;
    if (row && cap) {
      try {
        await add(
          {
            scope: "local",
            publicationId: e.principal,
            authorityRevision: row.authorityRevision,
            appRoot: row.appRoot,
          },
          cap,
          e.current,
        );
      } catch (error) {
        if (input.signal.aborted) throw error;
        incomplete = true;
      }
    } else remote.push(e);
  }

  if (remote.length > 0 && !input.readShareLinkPublication) incomplete = true;
  for (let i = 0; input.readShareLinkPublication && i < remote.length; i += 4) {
    input.signal.throwIfAborted();
    if (bounded.aborted) {
      incomplete = true;
      break;
    }
    const batch = await Promise.all(
      remote.slice(i, i + 4).map(async (e) => ({
        e,
        found: await safe(() => input.readShareLinkPublication!(e.principal, bounded), null),
      })),
    );
    for (const { e, found } of batch) {
      if (!found) {
        incomplete = true;
        continue;
      }
      if (!found.active || found.operatorTakedown || found.linkCurrent === false) continue;
      try {
        const cand = parseAppPublicationCandidate(found.candidate, APP_PUBLICATION_LIMITS);
        const cap = capFor(cand.capabilities, input.datasetId);
        if (!cap) {
          incomplete = true;
          continue;
        }
        await add(
          {
            scope: "link",
            publicationId: e.principal,
            authorityRevision: found.authorityRevision,
            appRoot: cand.appRoot,
            shareId: found.shareId,
            grantId: found.grantId,
          },
          cap,
          e.current,
        );
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error;
        incomplete = true;
      }
    }
  }

  boundApps.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.appRoot.localeCompare(b.appRoot) ||
      a.publicationId.localeCompare(b.publicationId),
  );
  return finish();
}
