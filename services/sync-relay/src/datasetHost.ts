import {
  isShareAccessValue,
  shareAccessRank,
  visibleSharePath,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
import { createDatasetAutomations, createDatasetAutomationAuthority } from "./datasetAutomations";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import {
  resolveCompatibleDatasetRevision,
  createDatasetHost,
  DatasetHostError,
  frozen,
  type DatasetAuthority,
  type DatasetAccess,
  type DatasetHostOptions,
  type DatasetDataGrant,
  type DatasetGovernor,
} from "@dohc/app-backend-runtime/dataset-host";
import type { AppBackendJson, AppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { PublicEditRelease } from "@dohc/security-contract";
import { createDatasetJournal } from "@dohc/app-backend-runtime/journal";
import { createDatasetAttempts } from "@dohc/app-backend-runtime/dataset-attempts";
import type { DatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import {
  createDatasetSupervisor,
  type DatasetSupervisorOptions,
} from "@dohc/app-backend-runtime/supervisor";
import { createRecoveryInstaller } from "@dohc/app-backend-runtime/recovery-install";
import {
  datasetColumnFields,
  type AppDatasetCapability,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";
import {
  verifyAppDatasetCapability,
  hasGeneratedDatasetRevision,
} from "@dohc/security-contract/dataset-authorization";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import {
  parseAppPublicationCandidate,
  type AppPublicationCandidate,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import type { AppBackendAuth } from "./appBackendAuthority";
import type { StorageContext } from "./storage/context";
import { assertWorkspaceQuota } from "./storage/workspaces";
import {
  activateOwnerPublication,
  publicationIdOf,
  requireLinkAppPublication,
  WHOLE_WORKSPACE,
} from "./storage/publications";
import {
  getWorkspaceMembership,
  workspaceMemberGrantId,
  workspaceRoleOf,
} from "./storage/workspaceMembers";
import { readCurrentShareGrant } from "./storage/currentShareGrant";
import { linkWriteRefusal } from "./storage/linkEnrollment";
import { authorizeShareGrantAction, authorizeShareAction } from "./shareAuthorization";
import {
  effectiveShareSelector,
  isWorkspaceSelector,
  MAIN_VERSION_ID,
  parseStoredAnyShareSelectorJson,
  targetVersionId,
} from "./shareFilter";
import { badRequest, notFound, relayError, RelayError } from "./errors";
import {
  memberAppConsent,
  workspaceAppPage,
  memberAppIdOf,
  memberAppRow,
  memberAppScopeDigest,
  memberAppSetting,
  MemberAppRefusal,
  recordMemberAppConsent,
  writeMemberApp,
  type WriteMemberAppInput,
  type MemberAppScopeCollection,
} from "./storage/memberApps";
import { deletePhoneAppLaunches } from "./storage/phoneApps";
import { createDatasetFiles } from "./storage/datasetFiles";
import { accountName } from "./storage/accountNames";
import { createDatasetRecoveryFiles } from "./storage/datasetRecoveryFiles";
import { collectionFilePaths, collectionFilePresent } from "./storage/collectionFilePresence";
import type { MemberReach } from "./storage/memberReach";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const lowerAccess = (a: ShareAccess, b: ShareAccess) =>
  shareAccessRank(a) < shareAccessRank(b) ? a : b;
const ownerPrincipalKey = (workspaceId: string) =>
  hash(JSON.stringify(["dohc-dataset-owner-v1", workspaceId]));
// A moved folder can reach the server as a delete and a later write, and a deleted file can come straight back.
const COLLECTION_MISSING_GRACE_MS = 120_000;
export interface RelayDatasetHostOptions {
  storage: StorageContext;
  directory: string;
  limits: AppPublicationLimits;
  /** Whether Edit links are released. An Edit link reaches an app's data only when they are. */
  publicEditRelease: PublicEditRelease | undefined;
  nowMs?: () => number;
  runtime?: DatasetSupervisorOptions["runtime"];
  maxWorkers?: number;
  maxParticipantsPerGrant?: number;
  compileOperations?: DatasetHostOptions<AppBackendAuth>["compileOperations"];
  onShutdownError(error: unknown): void;
  /** The deployment writer lock must be held before startup stage maintenance runs. */
  startupExclusive?: boolean;
}

export function datasetReferenceReadContainsRecord(
  result: unknown,
  primaryKeyFieldId: string,
  recordId: string | number,
): boolean {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows))
    return false;
  return result.rows.some((row) => {
    if (!row || typeof row !== "object" || !("values" in row)) return false;
    const values = row.values;
    return (
      !!values &&
      typeof values === "object" &&
      !Array.isArray(values) &&
      (values as Record<string, unknown>)[primaryKeyFieldId] === recordId
    );
  });
}

const DEFAULT_LEVELS = ["view", "comment", "edit"] as const;
/** A Collection's workspace defaults: the operations each folder level holds, chosen under one revision of its rules. */
export type CollectionWorkspaceDefaults = Record<(typeof DEFAULT_LEVELS)[number], string[]> & {
  revision: number;
  revisionSha256: string;
};
type Defaults = CollectionWorkspaceDefaults;

/** What an app's row on the server holds besides the app itself, counted as a binding's is. */
const localAppBytes = (appId: string) => Buffer.byteLength(appId) + 256;

/** The existing relay connection owns every authoritative dataset transaction. */
const outsideAppRoot = (candidate: AppPublicationCandidate) =>
  candidate.inputs.some((file) => !file.path.startsWith(`${candidate.appRoot}/`));

export async function createRelayDatasetHost(options: RelayDatasetHostOptions) {
  const { storage, limits, publicEditRelease } = options,
    nowMs = options.nowMs ?? Date.now;
  // Only artifact-verified revisions read from this host's catalog reach this cache.
  const generatedVerdicts = new Map<string, boolean>();
  function generatedRevision(approved: DatasetRevision): boolean {
    const cached = generatedVerdicts.get(approved.revisionSha256);
    if (cached !== undefined) return cached;
    const verdict = hasGeneratedDatasetRevision(approved);
    if (generatedVerdicts.size >= 64)
      generatedVerdicts.delete(generatedVerdicts.keys().next().value!);
    generatedVerdicts.set(approved.revisionSha256, verdict);
    return verdict;
  }
  const maxParticipantsPerGrant = options.maxParticipantsPerGrant ?? 1000;
  if (!Number.isSafeInteger(maxParticipantsPerGrant) || maxParticipantsPerGrant < 1)
    throw new Error("Invalid dataset participant limit.");
  const standing = storage.captureStanding();
  const transaction = <T>(run: () => T): T => storage.tx(run);
  const journal = createDatasetJournal({ db: storage.db, transaction, nowMs });
  storage.tx(() =>
    storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_dataset_usage (
    workspace_id TEXT NOT NULL, dataset_id TEXT NOT NULL, storage_bytes INTEGER NOT NULL CHECK(storage_bytes>=0),
    PRIMARY KEY(workspace_id,dataset_id),
    FOREIGN KEY(workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_dataset_participants(
    workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,grant_id TEXT NOT NULL,principal_key TEXT NOT NULL,
    PRIMARY KEY(workspace_id,dataset_id,grant_id,principal_key),
    FOREIGN KEY(workspace_id,dataset_id) REFERENCES sync_relay_dataset_usage(workspace_id,dataset_id) ON DELETE CASCADE) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_local_dataset_apps(
    workspace_id TEXT NOT NULL,app_id TEXT NOT NULL,dataset_id TEXT,owner_user_id TEXT NOT NULL,
    candidate TEXT NOT NULL,authority_revision INTEGER NOT NULL CHECK(authority_revision>=1),
    PRIMARY KEY(workspace_id,app_id),
    FOREIGN KEY(workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,dataset_id) REFERENCES sync_relay_dataset_usage(workspace_id,dataset_id) ON DELETE CASCADE) STRICT;`),
  );
  // Apps approved on owners' computers before the server counted them toward storage are counted
  // once, so withdrawing one gives back only what was counted.
  storage.tx(() => {
    const marker = "local-dataset-app-storage-v1";
    if (storage.db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker))
      return;
    const collection = storage.db.prepare(
      "UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes+? WHERE workspace_id=? AND dataset_id=?",
    );
    const workspace = storage.db.prepare(
      "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?",
    );
    for (const row of storage.db
      .prepare(
        "SELECT workspace_id,dataset_id,app_id,candidate FROM sync_relay_local_dataset_apps WHERE dataset_id IS NOT NULL",
      )
      .all()) {
      const bytes = localAppBytes(String(row.app_id)) + Buffer.byteLength(String(row.candidate));
      collection.run(bytes, row.workspace_id, row.dataset_id);
      workspace.run(bytes, row.workspace_id);
    }
    storage.db
      .prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
      .run(marker, Date.now());
  });
  storage.tx(() => {
    const marker = "local-dataset-app-multi-v1";
    if (storage.db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker))
      return;
    storage.db.exec(`CREATE TABLE sync_relay_local_dataset_apps_new(
      workspace_id TEXT NOT NULL,app_id TEXT NOT NULL,dataset_id TEXT,owner_user_id TEXT NOT NULL,
      candidate TEXT NOT NULL,authority_revision INTEGER NOT NULL CHECK(authority_revision>=1),
      PRIMARY KEY(workspace_id,app_id),
      FOREIGN KEY(workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id,dataset_id) REFERENCES sync_relay_dataset_usage(workspace_id,dataset_id) ON DELETE CASCADE) STRICT;
    INSERT INTO sync_relay_local_dataset_apps_new
      SELECT workspace_id,app_id,dataset_id,owner_user_id,candidate,authority_revision
      FROM sync_relay_local_dataset_apps;
    DROP TABLE sync_relay_local_dataset_apps;
    ALTER TABLE sync_relay_local_dataset_apps_new RENAME TO sync_relay_local_dataset_apps;`);
    storage.db
      .prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
      .run(marker, Date.now());
  });
  storage.tx(() =>
    storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_local_dataset_app_datasets(
      workspace_id TEXT NOT NULL,app_id TEXT NOT NULL,dataset_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,app_id,dataset_id),
      FOREIGN KEY(workspace_id,app_id) REFERENCES sync_relay_local_dataset_apps(workspace_id,app_id) ON DELETE CASCADE) STRICT;
    CREATE TABLE IF NOT EXISTS dohc_dataset_workspace_defaults(
      workspace_id TEXT NOT NULL,dataset_id TEXT NOT NULL,defaults_json TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>=1),
      PRIMARY KEY(workspace_id,dataset_id),
      FOREIGN KEY(workspace_id,dataset_id) REFERENCES sync_relay_dataset_usage(workspace_id,dataset_id) ON DELETE CASCADE) STRICT;`),
  );
  // The relay's own private folder, which it keeps at the path it was given.
  await mkdir(options.directory, { recursive: true });
  const workers = await realpath(options.directory);
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: async () => workers,
    runtime: options.runtime,
    maxWorkers: options.maxWorkers,
    nowMs,
    onMaintenanceError(scope) {
      console.warn("dataset_materialization_deferred", scope);
    },
    maintenanceStorage: {
      authorize: current,
      account: (allocation) =>
        account(allocation.scope.workspaceId, allocation.scope.datasetId, allocation.bytes),
    },
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      storage.unavailable.removeEventListener("abort", unavailable);
      closing = supervisor.close();
    }
    return closing;
  };
  const unavailable = () => {
    void close().catch((error) => options.onShutdownError(error));
  };
  storage.unavailable.addEventListener("abort", unavailable, { once: true });
  if (storage.unavailable.aborted) {
    await close();
    standing();
  }

  function current(): void {
    standing();
    if (closing) throw new Error("Dataset host is closed.");
  }
  const automationAuthority = createDatasetAutomationAuthority(current, storage);
  const automationListeners = new Set<(workspaceId: string, failed: boolean) => void>();
  function account(workspaceId: string, datasetId: string, bytes: number, create = false): void {
    current();
    if (!Number.isSafeInteger(bytes)) throw new Error("Invalid dataset allocation.");
    assertWorkspaceQuota(storage, workspaceId, bytes);
    if (create)
      storage.db
        .prepare("INSERT INTO sync_relay_dataset_usage VALUES(?,?,?)")
        .run(workspaceId, datasetId, bytes);
    else {
      const changed = storage.db
        .prepare(
          "UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes+? WHERE workspace_id=? AND dataset_id=?",
        )
        .run(bytes, workspaceId, datasetId);
      if (Number(changed.changes) !== 1) throw new Error("Dataset usage counter is missing.");
    }
    const changed = storage.db
      .prepare(
        "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?",
      )
      .run(bytes, workspaceId);
    if (Number(changed.changes) !== 1) throw new Error("Workspace usage counter is missing.");
  }
  function accountWorkspace(workspaceId: string, bytes: number): void {
    current();
    if (!Number.isSafeInteger(bytes)) throw new Error("Invalid dataset allocation.");
    assertWorkspaceQuota(storage, workspaceId, bytes);
    const changed = storage.db
      .prepare(
        "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes+? WHERE workspace_id=?",
      )
      .run(bytes, workspaceId);
    if (Number(changed.changes) !== 1) throw new Error("Workspace usage counter is missing.");
  }
  function resolveTargetCapability(
    capabilities: readonly AppDatasetCapability[],
    dataset?: string,
  ): AppDatasetCapability {
    if (capabilities.length === 1) {
      const only = capabilities[0]!;
      if (dataset !== undefined && only.alias !== dataset) throw notFound();
      return only;
    }
    if (capabilities.length > 1) {
      if (dataset === undefined)
        throw badRequest("Choose which Collection this app action targets.");
      const matched = capabilities.find((cap) => cap.alias === dataset);
      if (!matched) throw notFound();
      return matched;
    }
    throw notFound();
  }
  /** The authority with a phone launch's checks, which the host runs at admission, before each commit and inside it. */
  function launched(auth: AppBackendAuth, authority: DatasetAuthority): DatasetAuthority {
    const launch = auth.kind === "named" ? auth.launch : undefined;
    return launch
      ? {
          ...authority,
          authorizeOperation: () => launch.authorizeOperation(),
          beforeCommit: () => launch.recheck(),
        }
      : authority;
  }
  function owner(auth: AppBackendAuth, workspaceId: string): DatasetAuthority {
    current();
    if (
      auth.kind !== "named" ||
      auth.workspaceId !== workspaceId ||
      !storage.workspaceIsOwnedBy(workspaceId, auth.userId)
    )
      throw notFound();
    const launch = auth.launch;
    return {
      caller: { kind: "owner", userId: auth.userId },
      principalKey: ownerPrincipalKey(workspaceId),
      person: auth.userId,
      ...(launch
        ? {
            authorizeOperation: () => launch.authorizeOperation(),
            beforeCommit: () => launch.recheck(),
          }
        : {}),
    };
  }
  // Who sets a Collection's grants and defaults: its Owner, or an Admin acting for them on grants alone.
  // Callers pass the result straight to the host, so the role read here cannot go stale.
  function grantManager(auth: AppBackendAuth, workspaceId: string): AppBackendAuth {
    current();
    if (auth.kind === "named" && auth.workspaceId === workspaceId && !auth.launch) {
      const role = workspaceRoleOf(storage, workspaceId, auth.userId);
      const ownerRow = storage.db
        .prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id=?")
        .get(workspaceId);
      if (
        role?.role === "admin" &&
        ownerRow &&
        (auth.grantId === undefined ||
          auth.grantId === workspaceMemberGrantId(storage, workspaceId, auth.userId))
      )
        return { kind: "named", workspaceId, userId: String(ownerRow.owner_user_id) };
    }
    owner(auth, workspaceId);
    return auth;
  }
  function governor(
    auth: AppBackendAuth,
    key: { workspaceId: string; datasetId: string },
  ): DatasetGovernor {
    current();
    if (
      auth.kind === "named" &&
      auth.workspaceId === key.workspaceId &&
      !auth.agent &&
      !auth.launch &&
      !storage.workspaceIsOwnedBy(key.workspaceId, auth.userId)
    ) {
      const role = workspaceRoleOf(storage, key.workspaceId, auth.userId),
        grantId = workspaceMemberGrantId(storage, key.workspaceId, auth.userId);
      if (
        role?.role !== "admin" ||
        !grantId ||
        (auth.grantId !== undefined && auth.grantId !== grantId)
      )
        throw new DatasetHostError(
          "not_authorized",
          "Only the Owner or an Admin can change this Collection's rules.",
        );
      const generation = storage.getShareGrant(grantId)?.generation ?? null;
      return {
        role: "admin",
        userId: auth.userId,
        token: JSON.stringify(["admin", role.memberId, grantId, generation]),
      };
    }
    const authority = resolveAuthority(auth, { ...key, access: { kind: "data" } });
    if (authority.caller.kind !== "owner" || authority.agent)
      throw new DatasetHostError("not_authorized", "You do not have access to this Collection.");
    return { role: "owner", userId: authority.caller.userId, token: JSON.stringify(authority) };
  }
  function approval(
    workspaceId: string,
    result: {
      revisionSha256: string;
      approvedBy: { userId: string | null; role: "owner" | "admin"; approvedAtMs: number } | null;
    },
  ) {
    const by = result.approvedBy;
    if (!by)
      return {
        revisionSha256: result.revisionSha256,
        approvedBy: null,
        needsOwnerConfirmation: false,
      };
    const role = by.userId === null ? null : workspaceRoleOf(storage, workspaceId, by.userId)?.role;
    const former = by.role === "admin" && role !== "admin" && role !== "owner";
    return {
      revisionSha256: result.revisionSha256,
      approvedBy: {
        role: by.role,
        name: by.userId === null ? null : accountName(storage, by.userId),
        former,
        approvedAtMs: by.approvedAtMs,
      },
      needsOwnerConfirmation: former,
    };
  }
  function enroll(workspaceId: string, datasetId: string, authority: DatasetAuthority) {
    if (authority.caller.kind !== "link") return;
    const grantId = authority.caller.grantId;
    storage.tx(() => {
      current();
      if (
        storage.db
          .prepare(
            "SELECT 1 FROM sync_relay_dataset_participants WHERE workspace_id=? AND dataset_id=? AND grant_id=? AND principal_key=?",
          )
          .get(workspaceId, datasetId, grantId, authority.principalKey)
      )
        return;
      const count = Number(
        storage.db
          .prepare(
            "SELECT count(*) AS n FROM sync_relay_dataset_participants WHERE workspace_id=? AND dataset_id=? AND grant_id=?",
          )
          .get(workspaceId, datasetId, grantId)!.n,
      );
      if (count >= maxParticipantsPerGrant)
        throw relayError("quota_exceeded", "App participant limit reached.");
      account(
        workspaceId,
        datasetId,
        Buffer.byteLength(
          JSON.stringify([workspaceId, datasetId, grantId, authority.principalKey]),
        ) + 128,
      );
      storage.db
        .prepare("INSERT INTO sync_relay_dataset_participants VALUES(?,?,?,?)")
        .run(workspaceId, datasetId, grantId, authority.principalKey);
    });
  }
  function namedGrant(workspaceId: string, grantId: string, userId: string) {
    const result = authorizeShareGrantAction({
      storage,
      grantId,
      principal: { kind: "user", userId },
      action: "read",
    });
    if (
      !result.ok ||
      result.share.workspaceId !== workspaceId ||
      !isShareAccessValue(result.grant.access)
    )
      throw notFound();
    return {
      result,
      access: result.grant.access,
      reach: isWorkspaceSelector(result.effectiveSelector) ? result.effectiveSelector.reach : null,
    };
  }
  function collectionLevel(
    reach: MemberReach,
    workspaceId: string,
    datasetId: string,
  ): ShareAccess | null {
    const paths = collectionFilePaths(storage, workspaceId, datasetId);
    if (!paths) return null;
    const current = paths.current ?? (paths.unnamed ? paths.approved : null);
    const approved = reach.levelAt(paths.approved),
      moved = current === null ? null : reach.levelAt(current);
    return approved && moved && lowerAccess(approved, moved);
  }
  function readWorkspaceDefaults(workspaceId: string, datasetId: string) {
    const row = storage.db
      .prepare(
        "SELECT generation,defaults_json FROM dohc_dataset_workspace_defaults WHERE workspace_id=? AND dataset_id=?",
      )
      .get(workspaceId, datasetId);
    return row
      ? {
          generation: Number(row.generation),
          ...(JSON.parse(String(row.defaults_json)) as Defaults),
        }
      : null;
  }
  // The operations a member holds by level, while the Collection's rules still match the ones they were chosen under.
  function workspaceDefaults(workspaceId: string, datasetId: string, level: ShareAccess) {
    const defaults = readWorkspaceDefaults(workspaceId, datasetId);
    if (!defaults) return { generation: 0, operationIds: [] as string[] };
    try {
      resolveCompatibleDatasetRevision(storage.db, { workspaceId, datasetId }, defaults);
    } catch (error) {
      if (error instanceof DatasetHostError)
        return { generation: defaults.generation, operationIds: [] };
      throw error;
    }
    const levels = DEFAULT_LEVELS.filter((at) => shareAccessRank(at) <= shareAccessRank(level));
    return {
      generation: defaults.generation,
      operationIds: [...new Set(levels.flatMap((at) => defaults[at]))],
    };
  }
  // `publication` names a Workspace Publication's paths, which the member must still reach.
  function named(
    workspaceId: string,
    grantId: string,
    userId: string,
    datasetId?: string,
    publication?: { paths: readonly string[]; authorityRevision: number },
  ): DatasetAuthority {
    const { result, access, reach } = namedGrant(workspaceId, grantId, userId);
    if (publication && (!reach || publication.paths.some((path) => !reach.levelAt(path))))
      throw notFound();
    const level =
      reach && datasetId !== undefined ? collectionLevel(reach, workspaceId, datasetId) : access;
    if (level === null) {
      if (publication) throw notFound();
      throw new DatasetHostError("not_authorized", "You do not have access to this Collection.");
    }
    const effective = lowerAccess(access, level);
    const defaults =
      reach && datasetId !== undefined
        ? workspaceDefaults(workspaceId, datasetId, effective)
        : null;
    return {
      caller: { kind: "named", userId, grantId, access: effective, helper: false },
      principalKey: datasetPrincipalKey(workspaceId, grantId, userId),
      authorityToken: hash(
        JSON.stringify([
          result.grant.generation,
          result.share.selectorJson,
          effective,
          defaults?.generation ?? 0,
          publication?.authorityRevision ?? null,
        ]),
      ),
      ...(defaults?.operationIds.length ? { defaultOperationIds: defaults.operationIds } : {}),
      ...(publication
        ? { operationCeiling: { grantedOnly: true, readOnlyOnly: effective !== "edit" } }
        : {}),
    };
  }
  function workspacePublication(
    auth: Extract<AppBackendAuth, { kind: "named" }>,
    publicationId: string,
    row: Record<string, unknown>,
    candidate: AppPublicationCandidate,
  ) {
    const publisher = {
      workspaceId: auth.workspaceId,
      shareId: String(row.share_id),
      ownerUserId: String(row.owner_user_id),
    };
    if (
      getWorkspaceMembership(storage, auth.workspaceId)?.shareId !== publisher.shareId ||
      storage.getShare(publisher.shareId)?.granterUserId !== publisher.ownerUserId ||
      candidate.versionId !== MAIN_VERSION_ID ||
      publicationIdOf(publisher, hash(JSON.stringify(candidate))) !== publicationId
    )
      throw notFound();
    const authorityRevision = Number(row.authority_revision);
    if (auth.userId === publisher.ownerUserId) {
      const authority = {
        ...owner(auth, auth.workspaceId),
        authorityToken: String(authorityRevision),
      };
      return { candidate, authorityRevision, resolveAuthority: () => authority };
    }
    const paths = [candidate.appRoot, ...candidate.inputs.map((file) => file.path)];
    const resolve = (datasetId?: string) => {
      const grantId = workspaceMemberGrantId(storage, auth.workspaceId, auth.userId);
      if (!grantId || (auth.grantId !== undefined && auth.grantId !== grantId)) throw notFound();
      return launched(
        auth,
        named(auth.workspaceId, grantId, auth.userId, datasetId, { paths, authorityRevision }),
      );
    };
    resolve();
    return { candidate, authorityRevision, resolveAuthority: resolve };
  }
  function ownPublication(
    auth: Extract<AppBackendAuth, { kind: "named" }>,
    publicationId: string,
    row: Record<string, unknown>,
    candidate: AppPublicationCandidate,
  ) {
    const publisher = { workspaceId: auth.workspaceId, ownerUserId: String(row.owner_user_id) };
    if (
      auth.userId !== publisher.ownerUserId ||
      auth.grantId !== undefined ||
      (!auth.launch && !auth.device) ||
      candidate.versionId !== MAIN_VERSION_ID ||
      candidate.appRoot !== row.app_root ||
      publicationIdOf(publisher, hash(JSON.stringify(candidate))) !== publicationId
    )
      throw notFound();
    const authorityRevision = Number(row.authority_revision);
    const authority = {
      ...owner(auth, auth.workspaceId),
      authorityToken: String(authorityRevision),
    };
    return { candidate, authorityRevision, resolveAuthority: () => authority };
  }
  function memberReach(workspaceId: string, userId: string, datasetId: string | undefined) {
    const role = workspaceRoleOf(storage, workspaceId, userId)?.role;
    if (role === "owner") return { access: "edit" as ShareAccess, operationIds: null, token: role };
    const grantId = workspaceMemberGrantId(storage, workspaceId, userId);
    if (!grantId) return null;
    let authority: DatasetAuthority;
    try {
      authority = named(workspaceId, grantId, userId, datasetId);
    } catch (error) {
      if (
        error instanceof DatasetHostError ||
        (error instanceof RelayError && error.code === "not_found")
      )
        return null;
      throw error;
    }
    if (authority.caller.kind !== "named") return null;
    const operationIds = new Set(authority.defaultOperationIds);
    const row =
      datasetId === undefined
        ? undefined
        : storage.db
            .prepare(
              "SELECT grant_json,token FROM dohc_dataset_data_grants WHERE workspace_id=? AND dataset_id=? AND principal_key=?",
            )
            .get(workspaceId, datasetId, authority.principalKey);
    if (row) {
      const grant = JSON.parse(String(row.grant_json)) as DatasetDataGrant;
      try {
        resolveCompatibleDatasetRevision(storage.db, { workspaceId, datasetId: datasetId! }, grant);
        for (const id of grant.operationIds) operationIds.add(id);
      } catch (error) {
        if (!(error instanceof DatasetHostError)) throw error;
      }
    }
    return {
      access: authority.caller.access,
      operationIds,
      token: [grantId, authority.authorityToken, row?.token ?? null],
    };
  }
  function memberScope(
    workspaceId: string,
    publicationId: string,
    authorityRevision: number,
    candidate: AppPublicationCandidate,
    authorUserId: string,
    viewerUserId: string,
  ) {
    const author = workspaceRoleOf(storage, workspaceId, authorUserId)?.role;
    const setting = memberAppSetting(storage, workspaceId);
    if (
      !workspaceRoleOf(storage, workspaceId, viewerUserId) ||
      !author ||
      author === "owner" ||
      (author === "member" && !setting.membersCanShare)
    )
      return null;
    if (
      outsideAppRoot(candidate) ||
      !memberReach(workspaceId, authorUserId, undefined) ||
      !memberReach(workspaceId, viewerUserId, undefined)
    )
      return null;
    const scope: Array<MemberAppScopeCollection & { access: ShareAccess }> = [];
    const tokens: unknown[] = [author, setting.generation, authorityRevision];
    for (const declared of candidate.capabilities) {
      if (declared.kind !== "dataset") return null;
      const reaches = [
        memberReach(workspaceId, authorUserId, declared.datasetId),
        memberReach(workspaceId, viewerUserId, declared.datasetId),
      ];
      let verified: AppDatasetCapability;
      try {
        requireDatasetActiveForApproval(workspaceId, declared.datasetId);
        verified = capability(candidate, workspaceId, declared.datasetId);
      } catch (error) {
        if (error instanceof RelayError || error instanceof DatasetHostError) return null;
        throw error;
      }
      if (!reaches[0] || !reaches[1]) return null;
      const access = lowerAccess(reaches[0].access, reaches[1].access);
      const operationIds = verified.operations
        .filter(
          (operation) =>
            operation.access !== "owner" &&
            (access === "edit" || operation.readOnly) &&
            reaches.every(
              (reach) => !reach!.operationIds || reach!.operationIds.has(operation.operationId),
            ),
        )
        .map((operation) => operation.operationId)
        .sort();
      if (!operationIds.length) return null;
      scope.push({ datasetId: declared.datasetId, operationIds, access });
      tokens.push(reaches[0].token, reaches[1].token);
    }
    const digest = memberAppScopeDigest(publicationId, scope);
    return { scope, digest, token: hash(JSON.stringify([...tokens, digest])) };
  }
  function memberPublication(
    auth: Extract<AppBackendAuth, { kind: "named" }>,
    publicationId: string,
    row: Record<string, unknown>,
    candidate: AppPublicationCandidate,
    reviewing: boolean,
  ) {
    const { workspaceId } = auth,
      authorUserId = String(row.owner_user_id),
      authorityRevision = Number(row.authority_revision);
    const slug = String(row.member_slug);
    const viewerGrantId = workspaceMemberGrantId(storage, workspaceId, auth.userId);
    if (
      (auth.grantId !== undefined && auth.grantId !== viewerGrantId) ||
      getWorkspaceMembership(storage, workspaceId)?.shareId !== row.share_id ||
      memberAppIdOf(workspaceId, authorUserId, slug, hash(JSON.stringify(candidate))) !==
        publicationId
    )
      throw notFound();
    let reviewed:
      | (NonNullable<ReturnType<typeof memberScope>> & {
          consent: ReturnType<typeof memberAppConsent>;
        })
      | undefined;
    const review = () => (reviewed ??= check());
    const check = () => {
      const current = memberScope(
        workspaceId,
        publicationId,
        authorityRevision,
        candidate,
        authorUserId,
        auth.userId,
      );
      if (!current) throw notFound();
      const consent =
        auth.userId === authorUserId
          ? ("current" as const)
          : memberAppConsent(
              storage,
              { workspaceId, viewerUserId: auth.userId, publicationId },
              current.scope,
            );
      if (!reviewing && consent !== "current") throw new MemberAppRefusal(consent);
      return { ...current, consent };
    };
    const resolve = (datasetId?: string): DatasetAuthority => {
      const current = review();
      const entry = current.scope.find((value) => value.datasetId === datasetId);
      if (datasetId !== undefined && !entry) throw notFound();
      const operationIds = entry?.operationIds ?? [];
      return {
        caller: {
          kind: "named",
          userId: auth.userId,
          grantId: viewerGrantId ?? "owner",
          access: entry?.access ?? "view",
          helper: false,
        },
        principalKey: viewerGrantId
          ? datasetPrincipalKey(workspaceId, viewerGrantId, auth.userId)
          : ownerPrincipalKey(workspaceId),
        authorityToken: current.token,
        defaultOperationIds: operationIds,
        operationCeiling: {
          grantedOnly: true,
          readOnlyOnly: entry?.access !== "edit",
          operationIds,
        },
        ...(auth.launch
          ? {
              authorizeOperation: () => auth.launch!.authorizeOperation(),
              beforeCommit: () => auth.launch!.recheck(),
            }
          : {}),
      };
    };
    return {
      candidate,
      authorityRevision,
      resolveAuthority: resolve,
      member: { slug, publisherUserId: authorUserId, ...review() },
    };
  }
  function namedPublication(
    auth: Extract<AppBackendAuth, { kind: "named" }>,
    publicationId: string,
    reviewing = false,
  ): {
    candidate: AppPublicationCandidate;
    authorityRevision: number;
    resolveAuthority: (datasetId?: string) => DatasetAuthority;
    member?: ReturnType<typeof memberPublication>["member"];
  } {
    const row = storage.db
      .prepare(
        "SELECT p.*,m.slug AS member_slug FROM sync_relay_app_publications p LEFT JOIN sync_relay_member_apps m USING(publication_id) WHERE p.workspace_id=? AND p.publication_id=?",
      )
      .get(auth.workspaceId, publicationId);
    if (
      !row ||
      row.active !== 1 ||
      (row.member_slug === null &&
        !storage.workspaceIsOwnedBy(auth.workspaceId, String(row.owner_user_id)))
    )
      throw notFound();
    const bytes = storage.getBlob(auth.workspaceId, String(row.manifest_sha256));
    if (!bytes || bytes.byteLength > limits.maxMetadataBytes || hash(bytes) !== row.manifest_sha256)
      throw notFound();
    const candidate = parseAppPublicationCandidate(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
      limits,
    );
    if (row.member_slug !== null)
      return memberPublication(auth, publicationId, row, candidate, reviewing);
    if (row.audience === "workspace")
      return workspacePublication(auth, publicationId, row, candidate);
    if (row.audience === "owner") return ownPublication(auth, publicationId, row, candidate);
    const currentGrant = readCurrentShareGrant(storage, {
      grantId: String(row.grant_id),
      generation: Number(row.grant_generation),
    });
    if (
      !currentGrant ||
      currentGrant.share.shareId !== row.share_id ||
      currentGrant.share.workspaceId !== auth.workspaceId ||
      currentGrant.share.granterUserId !== row.owner_user_id
    )
      throw notFound();
    const { share, grant } = currentGrant;
    const parsed = parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector = parsed && effectiveShareSelector(parsed, grant.access);
    if (
      !selector ||
      "kind" in selector ||
      targetVersionId(selector) !== candidate.versionId ||
      visibleSharePath(selector, candidate.appRoot) !== candidate.appRoot ||
      candidate.inputs.some((file) => visibleSharePath(selector, file.path) !== file.path)
    )
      throw notFound();
    const publicationOwner = {
      workspaceId: auth.workspaceId,
      shareId: share.shareId,
      grantId: grant.grantId,
      generation: grant.generation,
      ownerUserId: String(row.owner_user_id),
    };
    if (publicationIdOf(publicationOwner, hash(JSON.stringify(candidate))) !== publicationId)
      throw notFound();
    const authorityRevision = Number(row.authority_revision);
    if (auth.userId === row.owner_user_id) {
      const authority = {
        ...owner(auth, auth.workspaceId),
        authorityToken: String(authorityRevision),
      };
      return { candidate, authorityRevision, resolveAuthority: () => authority };
    }
    const authorized = authorizeShareAction({
      storage,
      actorUserId: auth.userId,
      shareId: share.shareId,
      action: "read",
    });
    const grantId = auth.grantId ?? (authorized.ok ? authorized.grant.grantId : undefined);
    if (!grantId) throw notFound();
    const authority = named(auth.workspaceId, grantId, auth.userId);
    const namedGrant = storage.getShareGrant(grantId);
    const namedSelector = parsed && namedGrant && effectiveShareSelector(parsed, namedGrant.access);
    if (
      !namedGrant ||
      namedGrant.shareId !== share.shareId ||
      !namedSelector ||
      "kind" in namedSelector ||
      targetVersionId(namedSelector) !== candidate.versionId ||
      visibleSharePath(namedSelector, candidate.appRoot) !== candidate.appRoot
    )
      throw notFound();
    const recipient = {
      ...authority,
      authorityToken: hash(JSON.stringify([authority.authorityToken, row.authority_revision])),
    };
    return { candidate, authorityRevision, resolveAuthority: () => recipient };
  }
  // An app the owner approved on their own computer, over a Collection this
  // server holds. It runs as itself here, for the owner alone. Null for an id
  // that names no such app.
  function localApp(auth: Extract<AppBackendAuth, { kind: "named" }>, appId: string) {
    const row = storage.db
      .prepare(
        "SELECT candidate,authority_revision,owner_user_id FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=?",
      )
      .get(auth.workspaceId, appId);
    // A withdrawn app keeps its row with no app in it.
    if (!row || row.candidate === "") return null;
    if (auth.grantId || row.owner_user_id !== auth.userId) throw notFound();
    const authority = owner(auth, auth.workspaceId);
    return {
      candidate: parseAppPublicationCandidate(JSON.parse(String(row.candidate)), limits),
      authorityRevision: Number(row.authority_revision),
      authority: {
        ...authority,
        // The key the owner's computer gave the app's changes, so a retry of one made there before its Collection
        // came here finds it.
        principalKey: `${authority.principalKey}:app:${appId}`,
        authorityToken: `local:${String(row.authority_revision)}`,
        ...(auth.agent ? { agent: auth.agent } : {}),
      },
    };
  }
  // In memory, on this server's clock: a restart allows one more grace period.
  const missingSince = new Map<string, number>();
  function requireCollectionFile(workspaceId: string, datasetId: string): void {
    const key = JSON.stringify([workspaceId, datasetId]),
      now = nowMs();
    if (collectionFilePresent(storage, workspaceId, datasetId, now)) {
      missingSince.delete(key);
      return;
    }
    const since = missingSince.get(key);
    if (since !== undefined) {
      if (now - since >= COLLECTION_MISSING_GRACE_MS) throw relayError("app_collection_missing");
      return;
    }
    if (missingSince.size >= 1024) missingSince.delete(missingSince.keys().next().value!);
    missingSince.set(key, now);
  }
  function datasetRevision(workspaceId: string, datasetId: string): number {
    const head = storage.db
      .prepare("SELECT revision FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?")
      .get(workspaceId, datasetId);
    return head ? Number(head.revision) : 0;
  }
  const verifiedCapabilities = new WeakMap<DatasetRevision, Map<string, AppDatasetCapability>>();
  function capability(
    candidate: AppPublicationCandidate,
    workspaceId: string,
    datasetId: string,
  ): AppDatasetCapability {
    const requested = candidate.capabilities.find(
      (value) => value.kind === "dataset" && value.datasetId === datasetId,
    );
    if (!requested || requested.kind !== "dataset") throw notFound();
    let revision;
    try {
      revision = resolveCompatibleDatasetRevision(
        storage.db,
        { workspaceId, datasetId },
        requested,
      );
    } catch (error) {
      if (error instanceof DatasetHostError && error.code === "not_authorized") throw notFound();
      throw error;
    }
    let verified = verifiedCapabilities.get(revision);
    if (!verified) verifiedCapabilities.set(revision, (verified = new Map()));
    const key = JSON.stringify(requested);
    const hit = verified.get(key);
    if (hit) return hit;
    const result = frozen(verifyAppDatasetCapability(requested, revision, generatedRevision));
    if (verified.size >= 64) verified.delete(verified.keys().next().value!);
    verified.set(key, result);
    return result;
  }
  function requireDatasetActiveForApproval(workspaceId: string, datasetId: string): void {
    const head = storage.db
      .prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?")
      .get(workspaceId, datasetId);
    if (!head || head.active !== 1)
      throw new DatasetHostError(
        "conflict",
        "This Collection is not active on this server. Activate or restore it before approving the app.",
      );
    const state = storage.db
      .prepare("SELECT archived FROM dohc_dataset_lifecycle WHERE workspace_id=? AND dataset_id=?")
      .get(workspaceId, datasetId);
    if (state?.archived === 1)
      throw new DatasetHostError(
        "conflict",
        "This Collection is archived. Restore it before approving the app.",
      );
  }
  function requireDatasetLiveAndBound(workspaceId: string, datasetId: string, appId: string): void {
    const binding = storage.db
      .prepare(
        "SELECT 1 FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?",
      )
      .get(workspaceId, datasetId, appId);
    if (!binding) throw notFound();
    const head = storage.db
      .prepare("SELECT active FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?")
      .get(workspaceId, datasetId);
    if (!head || head.active !== 1) throw notFound();
    const state = storage.db
      .prepare("SELECT archived FROM dohc_dataset_lifecycle WHERE workspace_id=? AND dataset_id=?")
      .get(workspaceId, datasetId);
    if (state?.archived === 1) throw notFound();
  }
  function bindingOf(
    candidate: AppPublicationCandidate,
    workspaceId: string,
    datasetId: string,
    appId: string,
  ) {
    requireCollectionFile(workspaceId, datasetId);
    const {
      operations: _operations,
      name: _name,
      alias: _alias,
      ...binding
    } = capability(candidate, workspaceId, datasetId);
    return { datasetId, appId, binding };
  }
  type VerifiedManifest = { candidate: AppPublicationCandidate; manifestHash: string };
  const verifiedManifests = new WeakMap<AppBackendAuth, Map<string, VerifiedManifest>>();
  function loadAppPublication(auth: AppBackendAuth, publicationId: string, reviewing = false) {
    if (auth.kind === "link") {
      let manifests = verifiedManifests.get(auth);
      if (!manifests) verifiedManifests.set(auth, (manifests = new Map()));
      const published = requireLinkAppPublication(
        storage,
        { ...auth, publicationId, limits, publicEditRelease, nowMs: nowMs() },
        manifests.get(publicationId),
      );
      const { candidate, manifestHash } = published;
      manifests.set(publicationId, { candidate, manifestHash });
      return {
        workspaceId: published.workspaceId,
        candidate: published.candidate,
        authorityRevision: published.result.descriptor.authorityRevision,
        local: false,
        resolveAuthority(datasetId?: string): DatasetAuthority {
          if (linkWriteRefusal(published.enrollment)) throw notFound();
          return {
            caller: {
              kind: "link",
              grantId: published.result.grantId,
              principalId: `dataset_${hash(JSON.stringify([published.workspaceId, datasetId, published.result.grantId, auth.profileTokenHash]))}`,
            },
            principalKey: datasetPrincipalKey(
              published.workspaceId,
              published.result.grantId,
              auth.profileTokenHash,
            ),
            authorityToken: hash(
              JSON.stringify([
                published.result.generation,
                published.result.descriptor.authorityRevision,
              ]),
            ),
          };
        },
      };
    }
    const own = localApp(auth, publicationId);
    const published = own
      ? { ...own, resolveAuthority: (_datasetId?: string) => own.authority }
      : namedPublication(auth, publicationId, reviewing);
    return {
      workspaceId: auth.workspaceId,
      candidate: published.candidate,
      authorityRevision: published.authorityRevision,
      local: own !== null,
      resolveAuthority: published.resolveAuthority,
      member: "member" in published ? published.member : undefined,
    };
  }
  function app(auth: AppBackendAuth, workspaceId: string, datasetId: string, appId: string) {
    current();
    const loaded = loadAppPublication(auth, appId);
    if (loaded.workspaceId !== workspaceId) throw notFound();
    const authority = loaded.resolveAuthority(datasetId);
    const verified = capability(loaded.candidate, workspaceId, datasetId);
    requireCollectionFile(workspaceId, datasetId);
    if (loaded.candidate.capabilities.length > 1) {
      for (const bound of loaded.candidate.capabilities) {
        if (bound.kind !== "dataset") throw notFound();
        if (bound.datasetId !== datasetId) {
          loaded.resolveAuthority(bound.datasetId);
          capability(loaded.candidate, workspaceId, bound.datasetId);
          requireCollectionFile(workspaceId, bound.datasetId);
        }
        if (loaded.local) requireDatasetLiveAndBound(workspaceId, bound.datasetId, appId);
      }
    }
    return { capability: verified, authority: { ...authority, appId } };
  }
  function resolveAuthority(
    auth: AppBackendAuth,
    request: { workspaceId: string; datasetId?: string; access: DatasetAccess },
  ): DatasetAuthority {
    current();
    const automation = automationAuthority.resolve(auth, request.workspaceId, request.access.kind);
    if (automation !== null) return automation;
    if (request.access.kind === "app") {
      if (!request.datasetId) throw notFound();
      return app(auth, request.workspaceId, request.datasetId, request.access.appId).authority;
    }
    if (auth.kind !== "named" || auth.workspaceId !== request.workspaceId) throw notFound();
    if (storage.workspaceIsOwnedBy(auth.workspaceId, auth.userId))
      return auth.agent
        ? { ...owner(auth, auth.workspaceId), agent: auth.agent }
        : owner(auth, auth.workspaceId);
    if (!auth.grantId || auth.agent) throw notFound();
    const authority = launched(
      auth,
      named(auth.workspaceId, auth.grantId, auth.userId, request.datasetId),
    );
    return adminOf(auth)
      ? {
          ...authority,
          authorityToken: hash(JSON.stringify([authority.authorityToken, "admin"])),
          adminReads: true,
        }
      : authority;
  }
  function adminOf(auth: Extract<AppBackendAuth, { kind: "named" }>) {
    return (
      !auth.launch &&
      workspaceRoleOf(storage, auth.workspaceId, auth.userId)?.role === "admin" &&
      auth.grantId === workspaceMemberGrantId(storage, auth.workspaceId, auth.userId)
    );
  }
  function publication(auth: AppBackendAuth, publicationId: string, reviewing = false) {
    current();
    const loaded = loadAppPublication(auth, publicationId, reviewing);
    const requested = loaded.candidate.capabilities.filter(
      (value): value is AppDatasetCapability => value.kind === "dataset",
    );
    if (requested.length === 0) return null;
    const authorities: DatasetAuthority[] = [];
    const capabilities: AppDatasetCapability[] = [];
    for (const cap of requested) {
      authorities.push(loaded.resolveAuthority(cap.datasetId));
      capabilities.push(capability(loaded.candidate, loaded.workspaceId, cap.datasetId));
      requireCollectionFile(loaded.workspaceId, cap.datasetId);
      if (loaded.local && requested.length > 1)
        requireDatasetLiveAndBound(loaded.workspaceId, cap.datasetId, publicationId);
    }
    return {
      workspaceId: loaded.workspaceId,
      datasetId: capabilities.length === 1 ? capabilities[0]!.datasetId : null,
      authorityRevision: loaded.authorityRevision,
      capability: capabilities.length === 1 ? capabilities[0]! : null,
      capabilities,
      authority: { ...authorities[0]!, appId: publicationId },
      candidate: loaded.candidate,
      /** An app the owner approved on their own computer. */
      local: loaded.local,
      member: loaded.member,
    };
  }
  // An app that calls outside services, for a caller who can still open it.
  function externalPublication(auth: AppBackendAuth, publicationId: string) {
    current();
    const loaded = loadAppPublication(auth, publicationId);
    if (loaded.member || !loaded.candidate.external) throw notFound();
    publication(auth, publicationId);
    return {
      workspaceId: loaded.workspaceId,
      local: loaded.local,
      authorityRevision: loaded.authorityRevision,
      external: loaded.candidate.external,
      caller: loaded.resolveAuthority().caller,
    };
  }
  // The app whose files a named caller may load: a dataset app, or a publication that requests nothing in the
  // workspace and so has no dataset. Null for any other app.
  function servedPublication(auth: AppBackendAuth, publicationId: string, reviewing = false) {
    const dataset = publication(auth, publicationId, reviewing);
    if (dataset || auth.kind !== "named") return dataset;
    const published = namedPublication(auth, publicationId, reviewing);
    if (published.candidate.capabilities.length) return null;
    return {
      workspaceId: auth.workspaceId,
      datasetId: null,
      authorityRevision: published.authorityRevision,
      capability: null,
      capabilities: [] as AppDatasetCapability[],
      authority: published.resolveAuthority(),
      candidate: published.candidate,
      local: false,
      member: "member" in published ? published.member : undefined,
    };
  }
  try {
    const recoveryDirectory = join(options.directory, "recovery");
    await mkdir(recoveryDirectory, { recursive: true });
    const files = createDatasetFiles(storage, account, nowMs);
    const attempts = createDatasetAttempts({
      db: storage.db,
      transaction,
      account(scope, bytes) {
        account(scope.workspaceId, scope.datasetId, bytes);
      },
    });
    const recoveryFiles = createDatasetRecoveryFiles(
      storage,
      (scope, bytes) => account(scope.workspaceId, scope.datasetId, bytes),
      current,
    );
    createRecoveryInstaller({ db: storage.db, transaction, journal });
    // An import that ended without its Collection leaves an empty usage row, which would refuse creating the Collection here.
    const dropEmptyUsage = (workspaceId: string, datasetId: string) =>
      storage.tx(() => {
        storage.db
          .prepare(`DELETE FROM sync_relay_dataset_usage WHERE workspace_id=? AND dataset_id=? AND storage_bytes=0
        AND NOT EXISTS(SELECT 1 FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?)
        AND NOT EXISTS(SELECT 1 FROM dohc_dataset_imports WHERE workspace_id=? AND dataset_id=?)`)
          .run(workspaceId, datasetId, workspaceId, datasetId, workspaceId, datasetId);
      });
    if (options.startupExclusive) {
      // An import the relay left when it stopped blocks every retry. This process holds the
      // deployment writer lock and has no host to serve requests yet, so no import is running.
      const stopped = createRecoveryInstaller<undefined>({
        db: storage.db,
        transaction,
        journal,
        account(_context, allocation) {
          account(allocation.workspaceId, allocation.datasetId, allocation.bytes);
        },
        discardAttachments(_context, input) {
          return recoveryFiles.discard(input);
        },
      });
      for (;;) {
        const row = storage.db
          .prepare(
            "SELECT import_id,workspace_id,dataset_id FROM dohc_dataset_imports WHERE phase NOT IN ('installed','claimed') LIMIT 1",
          )
          .get();
        if (!row) break;
        const workspaceId = String(row.workspace_id),
          datasetId = String(row.dataset_id);
        await stopped.discard(undefined, {
          workspaceId,
          datasetId,
          transferId: String(row.import_id),
          authorize: current,
        });
        dropEmptyUsage(workspaceId, datasetId);
      }
      let stageCursor: string | undefined;
      do {
        stageCursor = journal.reclaimCheckpointStages({
          after: stageCursor,
          authorize: current,
          retain: (stage) =>
            Boolean(
              storage.db
                .prepare("SELECT 1 FROM dohc_dataset_import_checkpoints WHERE stage_id=?")
                .get(stage.stageId),
            ),
          account: (allocation) =>
            account(allocation.scope.workspaceId, allocation.scope.datasetId, allocation.bytes),
        }).after;
        if (stageCursor) await new Promise<void>((resolve) => setImmediate(resolve));
      } while (stageCursor);
    }
    const host = createDatasetHost<AppBackendAuth>({
      db: storage.db,
      transaction,
      journal,
      supervisor,
      resolveAuthority,
      resolveGovernor: governor,
      compileOperations: options.compileOperations,
      persistentRuntime: options.runtime,
      recovery: {
        directory: async () => recoveryDirectory,
        limits: { maxTotalBytes: storage.options.workspaceQuotaBytes },
        captureAttachments(auth, key, cursor) {
          owner(auth, key.workspaceId);
          return recoveryFiles.capture(key, cursor);
        },
        openAttachment(auth, key, file) {
          owner(auth, key.workspaceId);
          return recoveryFiles.open(key, file);
        },
        install: {
          account(auth, allocation) {
            owner(auth, allocation.workspaceId);
            storage.db
              .prepare("INSERT OR IGNORE INTO sync_relay_dataset_usage VALUES(?,?,0)")
              .run(allocation.workspaceId, allocation.datasetId);
            account(allocation.workspaceId, allocation.datasetId, allocation.bytes);
          },
          installAttachment(auth, input) {
            owner(auth, input.workspaceId);
            return recoveryFiles.install(input);
          },
          commitAttachments(auth, input) {
            owner(auth, input.workspaceId);
            recoveryFiles.commit(input);
          },
          discardAttachments(auth, input) {
            owner(auth, input.workspaceId);
            return recoveryFiles.discard(input);
          },
        },
      },
      accountCreation(_auth, allocation) {
        account(allocation.workspaceId, allocation.datasetId, allocation.bytes, true);
      },
      accountMigration(_auth, allocation) {
        account(allocation.workspaceId, allocation.datasetId, allocation.bytes);
      },
      accountCheckpointStage(_auth, allocation) {
        account(allocation.scope.workspaceId, allocation.scope.datasetId, allocation.bytes);
      },
      accountMetadata(_auth, allocation) {
        account(allocation.workspaceId, allocation.datasetId, allocation.bytes);
      },
      wakeAutomations(scope, failed) {
        for (const wake of automationListeners) wake(scope.workspaceId, failed);
      },
      accountAutomations(allocation) {
        account(allocation.workspaceId, allocation.datasetId, allocation.bytes);
      },
      deleteResources(_auth, key) {
        const unbindSiblings = (appId: string) => {
          const siblingBindings = storage.db
            .prepare(
              "SELECT dataset_id, binding_json FROM dohc_dataset_bindings WHERE workspace_id=? AND app_id=? AND dataset_id<>?",
            )
            .all(key.workspaceId, appId, key.datasetId) as Array<{
            dataset_id: string;
            binding_json: string;
          }>;
          for (const sibling of siblingBindings) {
            storage.db
              .prepare(
                "DELETE FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?",
              )
              .run(key.workspaceId, sibling.dataset_id, appId);
            account(
              key.workspaceId,
              sibling.dataset_id,
              -(Buffer.byteLength(sibling.binding_json) + Buffer.byteLength(appId) + 256),
            );
          }
        };
        for (const row of storage.db
          .prepare(
            `SELECT binding.app_id FROM dohc_dataset_bindings binding JOIN sync_relay_app_publications publication
             ON publication.workspace_id=binding.workspace_id AND publication.publication_id=binding.app_id
             WHERE binding.workspace_id=? AND binding.dataset_id=?`,
          )
          .all(key.workspaceId, key.datasetId))
          unbindSiblings(String(row.app_id));
        const multiRows = storage.db
          .prepare(
            `SELECT app.app_id, app.candidate
             FROM sync_relay_local_dataset_apps app
             WHERE app.workspace_id = ? AND app.dataset_id IS NULL
               AND (
                 EXISTS (
                   SELECT 1 FROM dohc_dataset_bindings binding
                   WHERE binding.workspace_id = app.workspace_id AND binding.dataset_id = ? AND binding.app_id = app.app_id
                 )
                 OR EXISTS (
                   SELECT 1 FROM sync_relay_local_dataset_app_datasets link
                   WHERE link.workspace_id = app.workspace_id AND link.dataset_id = ? AND link.app_id = app.app_id
                 )
               )`,
          )
          .all(key.workspaceId, key.datasetId, key.datasetId) as Array<{
          app_id: string;
          candidate: string;
        }>;
        for (const row of multiRows) {
          unbindSiblings(row.app_id);
          storage.db
            .prepare(
              "DELETE FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=? AND dataset_id IS NULL",
            )
            .run(key.workspaceId, row.app_id);
          accountWorkspace(
            key.workspaceId,
            -(Buffer.byteLength(row.candidate) + localAppBytes(row.app_id)),
          );
        }
        storage.db
          .prepare("DELETE FROM sync_relay_dataset_usage WHERE workspace_id=? AND dataset_id=?")
          .run(key.workspaceId, key.datasetId);
      },
      operationResources(_auth, request) {
        enroll(request.workspaceId, request.datasetId, request.authority);
        return files.resources(request, request.authority, request.input);
      },
    });
    storage.tx(() =>
      storage.db.exec(`DROP TRIGGER IF EXISTS sync_relay_dataset_delete;
      CREATE TRIGGER sync_relay_dataset_delete
      AFTER DELETE ON sync_relay_dataset_usage BEGIN
        DELETE FROM dohc_dataset_bindings WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_data_grants WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_lifecycle WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_catalog WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_catalog_history WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_lifecycle WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_receipts WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_attempts WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_cancelled_attempts WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_events WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_materializations WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_checkpoint_history WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_checkpoint_times WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_journals WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_checkpoint_chunks WHERE stage_id IN (
          SELECT stage_id FROM dohc_dataset_checkpoints WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_checkpoints WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM sync_relay_dataset_import_files WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_import_records WHERE import_id IN (SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_import_metadata WHERE import_id IN (SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_import_checkpoints WHERE import_id IN (SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_recovered_permissions WHERE import_id IN (SELECT import_id FROM dohc_dataset_imports WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id);
        DELETE FROM dohc_dataset_imports WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_review_generations WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_automation_subscriptions WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_automation_claims WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_automation_revisions WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_revision_actors WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_approvers WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_automation_presses WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_automation_failure_generations WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        DELETE FROM dohc_dataset_workspace_defaults WHERE workspace_id=OLD.workspace_id AND dataset_id=OLD.dataset_id;
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-OLD.storage_bytes WHERE workspace_id=OLD.workspace_id;
      END;
      DROP TRIGGER IF EXISTS sync_relay_app_publication_unbind;
      CREATE TRIGGER sync_relay_app_publication_unbind
      AFTER UPDATE OF active ON sync_relay_app_publications WHEN OLD.active=1 AND NEW.active=0 BEGIN
        UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes-(
          SELECT length(CAST(b.binding_json AS BLOB))+length(CAST(b.app_id AS BLOB))+256 FROM dohc_dataset_bindings b
          WHERE b.workspace_id=sync_relay_dataset_usage.workspace_id AND b.dataset_id=sync_relay_dataset_usage.dataset_id AND b.app_id=NEW.publication_id)
        WHERE workspace_id=NEW.workspace_id AND dataset_id IN (
          SELECT dataset_id FROM dohc_dataset_bindings WHERE workspace_id=NEW.workspace_id AND app_id=NEW.publication_id);
        UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-(
          SELECT coalesce(sum(length(CAST(binding_json AS BLOB))+length(CAST(app_id AS BLOB))+256),0) FROM dohc_dataset_bindings
          WHERE workspace_id=NEW.workspace_id AND app_id=NEW.publication_id) WHERE workspace_id=NEW.workspace_id;
        DELETE FROM dohc_dataset_bindings WHERE workspace_id=NEW.workspace_id AND app_id=NEW.publication_id;
      END;`),
    );
    storage.workReferenceDatasetAccess = async (input) => {
      try {
        current();
        const auth: AppBackendAuth = input.linkAuth ?? {
          kind: "named",
          workspaceId: input.workspaceId,
          userId: input.userId!,
          grantId: input.grantId,
        };
        const key = { workspaceId: input.workspaceId, datasetId: input.target.datasetId };
        let request: Parameters<typeof host.authorize>[1] | undefined;
        let primaryKeyFieldId: string | undefined;
        if (auth.kind === "named") {
          const description = host.describe(auth, key);
          const table = description.tables.find((table) => table.tableId === input.target.tableId);
          const operation = description.operations.find(
            (operation) =>
              operation.tableId === input.target.tableId &&
              operation.kind === "read" &&
              operation.readOnly &&
              (input.target.kind === "transactionalCollection" ||
                (!!table?.primaryKeyFieldId &&
                  operation.fieldIds.includes(table.primaryKeyFieldId))),
          );
          if (!table || !operation) return null;
          primaryKeyFieldId = table.primaryKeyFieldId;
          request = {
            ...key,
            revision: description.revision,
            revisionSha256: description.revisionSha256,
            operationId: operation.operationId,
          };
        } else {
          const publications = storage.db
            .prepare(
              "SELECT publication_id FROM sync_relay_app_publications WHERE workspace_id=? AND grant_id=? AND active=1 LIMIT 64",
            )
            .all(key.workspaceId, input.grantId!);
          for (const row of publications) {
            try {
              const capability = publication(auth, String(row.publication_id))?.capabilities.find(
                (capability) => capability.datasetId === key.datasetId,
              );
              if (!capability) continue;
              for (const operation of capability.operations.filter(
                (operation) => operation.readOnly,
              )) {
                const candidate = {
                  ...key,
                  revision: capability.revision,
                  revisionSha256: capability.revisionSha256,
                  operationId: operation.operationId,
                  access: { kind: "app" as const, appId: String(row.publication_id) },
                };
                const permitted = host.authorize(auth, candidate);
                if (
                  permitted.operation.kind !== "read" ||
                  permitted.operation.tableId !== input.target.tableId
                )
                  continue;
                const table = permitted.revision.definition.tables.find(
                  (table) => table.tableId === input.target.tableId,
                )!;
                const primary = datasetColumnFields(table).find(
                  (field) => field.sqlColumn === table.primaryKey,
                );
                if (
                  input.target.kind === "transactionalRecord" &&
                  (!primary || !permitted.operation.fieldIds.includes(primary.fieldId))
                )
                  continue;
                request = candidate;
                primaryKeyFieldId = primary?.fieldId;
                break;
              }
              if (request) break;
            } catch {
              continue;
            }
          }
          if (!request) return null;
        }
        if (!request) return null;
        const readRequest = request;
        const authorization = host.authorize(auth, readRequest);
        if (
          input.target.kind === "transactionalRecord" &&
          !generatedRevision(authorization.revision)
        )
          return () => false;
        const admitted = JSON.stringify(authorization);
        const recordId =
          input.target.kind === "transactionalRecord" ? input.target.recordId : undefined;
        return await host.readOperation(
          auth,
          {
            ...readRequest,
            idempotencyKey: randomUUID(),
            signal: storage.unavailable,
            input:
              recordId === undefined
                ? { limit: 1 }
                : { limit: 1, filters: [{ fieldId: primaryKeyFieldId!, value: recordId }] },
          },
          (result, revision) => {
            const found =
              recordId === undefined ||
              datasetReferenceReadContainsRecord(result, primaryKeyFieldId!, recordId);
            return () => {
              try {
                current();
                if (JSON.stringify(host.authorize(auth, readRequest)) !== admitted) return false;
                const head = storage.db
                  .prepare(
                    "SELECT revision,active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?",
                  )
                  .get(key.workspaceId, key.datasetId);
                return (
                  found &&
                  head?.active === 1 &&
                  head.revision === revision &&
                  head.approved_revision_hash === readRequest.revisionSha256
                );
              } catch {
                return false;
              }
            };
          },
        );
      } catch {
        return null;
      }
    };
    function approveLocalApp(
      auth: AppBackendAuth,
      input: { workspaceId: string; datasetId: string; candidate: unknown },
    ): { publicationId: string; authorityRevision: number } {
      owner(auth, input.workspaceId);
      if (auth.kind !== "named" || auth.grantId) throw notFound();
      let candidate: AppPublicationCandidate;
      try {
        candidate = parseAppPublicationCandidate(input.candidate, limits);
      } catch {
        throw badRequest("Invalid app approval.");
      }
      if (
        candidate.capabilities.length !== 1 ||
        candidate.capabilities[0]!.kind !== "dataset" ||
        candidate.capabilities[0]!.datasetId !== input.datasetId
      )
        throw badRequest("Invalid app approval.");
      const {
        operations: _operations,
        name: _name,
        alias: _alias,
        ...binding
      } = capability(candidate, input.workspaceId, input.datasetId);
      const appId = hash(
        JSON.stringify(["dohc-local-dataset-app-v1", input.workspaceId, candidate]),
      );
      const approved = storage.db
        .prepare(
          "SELECT app.authority_revision FROM sync_relay_local_dataset_apps app JOIN dohc_dataset_bindings binding ON binding.workspace_id=app.workspace_id AND binding.dataset_id=app.dataset_id AND binding.app_id=app.app_id WHERE app.workspace_id=? AND app.dataset_id=? AND app.app_id=? AND app.owner_user_id=?",
        )
        .get(input.workspaceId, input.datasetId, appId, auth.userId);
      if (approved) {
        requireDatasetActiveForApproval(input.workspaceId, input.datasetId);
        return { publicationId: appId, authorityRevision: Number(approved.authority_revision) };
      }
      let authorityRevision = 1;
      host.setBinding(
        auth,
        { workspaceId: input.workspaceId, datasetId: input.datasetId, appId, binding },
        () => {
          requireDatasetActiveForApproval(input.workspaceId, input.datasetId);
          const row = storage.db
            .prepare(
              "SELECT authority_revision,candidate FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=?",
            )
            .get(input.workspaceId, appId);
          authorityRevision = row ? Number(row.authority_revision) + 1 : 1;
          const kept = JSON.stringify(candidate);
          account(
            input.workspaceId,
            input.datasetId,
            Buffer.byteLength(kept) -
              (row ? Buffer.byteLength(String(row.candidate)) : -localAppBytes(appId)),
          );
          storage.db
            .prepare(
              "INSERT INTO sync_relay_local_dataset_apps VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,app_id) DO UPDATE SET candidate=excluded.candidate,authority_revision=excluded.authority_revision",
            )
            .run(input.workspaceId, appId, input.datasetId, auth.userId, kept, authorityRevision);
        },
      );
      return { publicationId: appId, authorityRevision };
    }
    function withdrawLocalAppWorkspace(
      auth: AppBackendAuth,
      input: { workspaceId: string; publicationId: string },
    ): void {
      owner(auth, input.workspaceId);
      if (auth.kind !== "named" || auth.grantId) throw notFound();
      const row = storage.db
        .prepare(
          "SELECT dataset_id,candidate,owner_user_id FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=?",
        )
        .get(input.workspaceId, input.publicationId);
      if (!row || row.owner_user_id !== auth.userId) throw notFound();
      if (row.candidate === "") return;
      if (row.dataset_id !== null) {
        const singleDatasetId = String(row.dataset_id);
        host.setBinding(
          auth,
          {
            workspaceId: input.workspaceId,
            datasetId: singleDatasetId,
            appId: input.publicationId,
            binding: null,
          },
          () => {
            const currentRow = storage.db
              .prepare(
                "SELECT candidate FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND dataset_id=? AND app_id=?",
              )
              .get(input.workspaceId, singleDatasetId, input.publicationId);
            if (!currentRow || currentRow.candidate === "") return;
            storage.db
              .prepare(
                "UPDATE sync_relay_local_dataset_apps SET candidate='' WHERE workspace_id=? AND dataset_id=? AND app_id=?",
              )
              .run(input.workspaceId, singleDatasetId, input.publicationId);
            account(
              input.workspaceId,
              singleDatasetId,
              -Buffer.byteLength(String(currentRow.candidate)),
            );
          },
        );
        return;
      }
      const datasetIds = (
        storage.db
          .prepare(
            "SELECT dataset_id FROM dohc_dataset_bindings WHERE workspace_id=? AND app_id=? ORDER BY dataset_id",
          )
          .all(input.workspaceId, input.publicationId) as Array<{ dataset_id: string }>
      ).map((entry) => entry.dataset_id);
      const clearCandidate = () => {
        const currentRow = storage.db
          .prepare(
            "SELECT candidate FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=? AND dataset_id IS NULL",
          )
          .get(input.workspaceId, input.publicationId);
        if (!currentRow || currentRow.candidate === "") return;
        storage.db
          .prepare(
            "UPDATE sync_relay_local_dataset_apps SET candidate='' WHERE workspace_id=? AND app_id=? AND dataset_id IS NULL",
          )
          .run(input.workspaceId, input.publicationId);
        accountWorkspace(input.workspaceId, -Buffer.byteLength(String(currentRow.candidate)));
      };
      if (datasetIds.length === 0) {
        storage.tx(clearCandidate);
        return;
      }
      host.setBindings(
        auth,
        {
          workspaceId: input.workspaceId,
          operations: datasetIds.map((id) => ({
            datasetId: id,
            appId: input.publicationId,
            binding: null,
          })),
        },
        clearCandidate,
      );
    }
    return {
      /** An active Admin acting as themselves or on their own member grant, not through a phone launch. */
      memberAdmin: (auth: Extract<AppBackendAuth, { kind: "named" }>, workspaceId: string) =>
        auth.workspaceId === workspaceId &&
        adminOf({
          ...auth,
          grantId:
            auth.grantId ?? workspaceMemberGrantId(storage, workspaceId, auth.userId) ?? undefined,
        }),
      keeps: (workspaceId: string, datasetId: string) =>
        storage.db
          .prepare("SELECT 1 FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?")
          .get(workspaceId, datasetId) !== undefined,
      automations: createDatasetAutomations({
        host,
        storage,
        current,
        authority: automationAuthority,
      }),
      observeAutomationClaims(wake: (workspaceId: string, failed: boolean) => void) {
        automationListeners.add(wake);
        return () => {
          automationListeners.delete(wake);
        };
      },
      offlineAccessFingerprint(auth: Extract<AppBackendAuth, { kind: "named" }>) {
        current();
        if (!auth.grantId) throw notFound();
        const verified = named(auth.workspaceId, auth.grantId, auth.userId);
        const { reach } = namedGrant(auth.workspaceId, auth.grantId, auth.userId);
        const digest = createHash("sha256").update(
          JSON.stringify([
            "named-dataset-copy-v1",
            auth.workspaceId,
            verified.principalKey,
            verified.authorityToken,
            adminOf(auth),
          ]),
        );
        // Stream metadata only: no record counts, source, or other principals' grants enter the response.
        for (const row of storage.db
          .prepare(`SELECT g.dataset_id,g.token,g.grant_json,
          json_extract(c.revision_json,'$.revisionSha256') AS revision,COALESCE(l.generation,0) AS lifecycle
          FROM dohc_dataset_data_grants g JOIN dohc_dataset_catalog c
          ON c.workspace_id=g.workspace_id AND c.dataset_id=g.dataset_id
          LEFT JOIN dohc_dataset_lifecycle l ON l.workspace_id=g.workspace_id AND l.dataset_id=g.dataset_id
          WHERE g.workspace_id=? AND g.principal_key=? ORDER BY g.dataset_id`)
          .all(auth.workspaceId, verified.principalKey)) {
          const level = reach && collectionLevel(reach, auth.workspaceId, String(row.dataset_id));
          if (reach && level === null) continue;
          digest.update(JSON.stringify(reach ? [row, level] : row));
        }
        for (const row of reach
          ? storage.db
              .prepare(
                `SELECT d.dataset_id,d.generation,
                json_extract(c.revision_json,'$.revisionSha256') AS revision,COALESCE(l.generation,0) AS lifecycle
                FROM dohc_dataset_workspace_defaults d JOIN dohc_dataset_catalog c
                ON c.workspace_id=d.workspace_id AND c.dataset_id=d.dataset_id
                LEFT JOIN dohc_dataset_lifecycle l ON l.workspace_id=d.workspace_id AND l.dataset_id=d.dataset_id
                WHERE d.workspace_id=? ORDER BY d.dataset_id`,
              )
              .all(auth.workspaceId)
          : []) {
          const level = collectionLevel(reach!, auth.workspaceId, String(row.dataset_id));
          if (level !== null) digest.update(JSON.stringify(["defaults", row, level]));
        }
        return digest.digest("hex");
      },
      activate(auth: AppBackendAuth, input: Parameters<typeof host.activate>[1]) {
        return host.activate(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      prepareMigration(auth: AppBackendAuth, input: Parameters<typeof host.prepareMigration>[1]) {
        return host.prepareMigration(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      approveMigration(auth: AppBackendAuth, input: Parameters<typeof host.approveMigration>[1]) {
        return host.approveMigration(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      migrationPreviewPage(
        auth: AppBackendAuth,
        input: Parameters<typeof host.migrationPreviewPage>[1],
      ) {
        return host.migrationPreviewPage(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      discardMigration(auth: AppBackendAuth, input: Parameters<typeof host.discardMigration>[1]) {
        return host.discardMigration(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      describe: host.describe,
      list: host.list,
      approvedArtifacts: host.approvedArtifacts,
      approval: (auth: AppBackendAuth, scope: { workspaceId: string; datasetId: string }) =>
        approval(scope.workspaceId, host.approval(auth, scope)),
      confirmApproval: (
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId: string; revisionSha256: string },
      ) => approval(input.workspaceId, host.confirmApproval(auth, input)),
      history: host.history,
      historyRevision: host.historyRevision,
      publication,
      servedPublication,
      externalPublication,
      /** The revisions of a published app's Collections that the caller can run one of its reads on now. */
      appEventRevisions(auth: AppBackendAuth, publicationId: string, authorityRevision: number) {
        const published = publication(auth, publicationId);
        if (!published || published.local || published.authorityRevision !== authorityRevision)
          throw notFound();
        const { workspaceId } = published;
        const readable = (cap: AppDatasetCapability) =>
          cap.operations.some((operation) => {
            if (!operation.readOnly) return false;
            try {
              host.authorize(auth, {
                workspaceId,
                datasetId: cap.datasetId,
                revision: cap.revision,
                revisionSha256: cap.revisionSha256,
                operationId: operation.operationId,
                access: { kind: "app", appId: publicationId },
              });
              return true;
            } catch (error) {
              if (error instanceof DatasetHostError) return false;
              if (error instanceof RelayError && error.code === "not_found") return false;
              throw error;
            }
          });
        const collections = published.capabilities.filter(readable).map((cap) => ({
          dataset: cap.alias ?? "",
          datasetId: cap.datasetId,
          revision: datasetRevision(workspaceId, cap.datasetId),
        }));
        const caller = published.authority.caller;
        const actor =
          auth.kind === "named"
            ? `named:${workspaceId}:${auth.userId}`
            : caller.kind === "link"
              ? `link:${caller.grantId}`
              : null;
        if (!actor || !collections.length) throw notFound();
        return { workspaceId, actor, collections };
      },
      datasetRevision,
      requireCollectionFile,
      lifecycle: host.lifecycle,
      archiveDataset: host.archiveDataset,
      restoreDataset: host.restoreDataset,
      deletePreview: host.deletePreview,
      deleteDataset: host.deleteDataset,
      deletionStatus: host.deletionStatus,
      pendingAttempts: host.pendingAttempts,
      reconcileAttempt: host.reconcileAttempt,
      cancelAttempt: host.cancelAttempt,
      exportRecovery: host.exportRecovery,
      recoveryImportStatus: host.recoveryStatus,
      async importRecovery(auth: AppBackendAuth, input: Parameters<typeof host.importRecovery>[1]) {
        try {
          return await host.importRecovery(auth, input);
        } finally {
          if (!storage.unavailable.aborted) dropEmptyUsage(input.workspaceId, input.datasetId);
        }
      },
      replicaCapture: host.replicaCapture,
      replicaPage: host.replicaPage,
      replicaBlob: host.replicaBlob,
      invoke(auth: AppBackendAuth, input: Parameters<typeof host.invoke>[1]) {
        return host.invoke(auth, {
          ...input,
          signal: AbortSignal.any([storage.unavailable, ...(input.signal ? [input.signal] : [])]),
        });
      },
      attempt(
        auth: AppBackendAuth,
        publicationId: string,
        input: {
          authorityRevision: number;
          operation: string;
          dataset?: string;
          request: DatasetAttemptRequest;
        },
        signal?: AbortSignal,
      ) {
        const published = publication(auth, publicationId);
        if (!published || published.authorityRevision !== input.authorityRevision) throw notFound();
        const capability = resolveTargetCapability(published.capabilities, input.dataset);
        const { workspaceId } = published;
        const datasetId = capability.datasetId;
        const operation = capability.operations.find((value) => value.name === input.operation);
        if (!operation || operation.readOnly) throw notFound();
        const scope = {
          workspaceId,
          datasetId,
          revision: capability.revision,
          revisionSha256: capability.revisionSha256,
          operationId: operation.operationId,
          access: { kind: "app" as const, appId: publicationId },
        };
        const captured = host.authorize(auth, scope);
        return attempts.request(
          { ...scope, appId: publicationId, principalKey: captured.authority.principalKey },
          input.request,
          () => {
            signal?.throwIfAborted();
            current();
            const latest = publication(auth, publicationId);
            if (
              !latest ||
              latest.authorityRevision !== input.authorityRevision ||
              JSON.stringify(host.authorize(auth, scope).authority) !==
                JSON.stringify(captured.authority)
            )
              throw notFound();
            const head = storage.db
              .prepare(
                "SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?",
              )
              .get(workspaceId, datasetId);
            if (
              !head ||
              head.active !== 1 ||
              head.approved_revision_hash !== host.authorize(auth, scope).revision.revisionSha256
            )
              throw notFound();
          },
        );
      },
      upload(
        auth: AppBackendAuth,
        publicationId: string,
        input: AppBackendUploadRequest,
        signal?: AbortSignal,
      ) {
        const published = publication(auth, publicationId);
        if (!published || published.authorityRevision !== input.authorityRevision) throw notFound();
        const capability = resolveTargetCapability(published.capabilities, input.dataset);
        const { workspaceId } = published;
        const datasetId = capability.datasetId;
        const scope = {
          workspaceId,
          datasetId,
          revision: capability.revision,
          revisionSha256: capability.revisionSha256,
          access: { kind: "app" as const, appId: publicationId },
        };
        let permitted: ReturnType<typeof host.authorize> | undefined;
        for (const operation of capability.operations.filter((operation) => !operation.readOnly)) {
          try {
            permitted = host.authorize(auth, { ...scope, operationId: operation.operationId });
            break;
          } catch (error) {
            if (!(error instanceof DatasetHostError) || error.code !== "not_authorized")
              throw error;
          }
        }
        if (!permitted) throw notFound();
        const captured = permitted;
        enroll(workspaceId, datasetId, captured.authority);
        const { dataset: _dataset, ...uploadInput } = input;
        return files.upload(scope, captured.authority, uploadInput, () => {
          signal?.throwIfAborted();
          current();
          const checked = host.authorize(auth, {
            ...scope,
            operationId: captured.operation.operationId,
          });
          if (JSON.stringify(checked.authority) !== JSON.stringify(captured.authority))
            throw notFound();
          const head = storage.db
            .prepare(
              "SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?",
            )
            .get(workspaceId, datasetId);
          if (
            !head ||
            head.active !== 1 ||
            head.approved_revision_hash !== checked.revision.revisionSha256
          )
            throw notFound();
        });
      },
      ownerUpload(
        auth: AppBackendAuth,
        input: Omit<AppBackendUploadRequest, "authorityRevision"> & {
          workspaceId: string;
          datasetId: string;
          revision: number;
          revisionSha256: string;
        },
        signal?: AbortSignal,
      ) {
        const scope = { workspaceId: input.workspaceId, datasetId: input.datasetId };
        const authorize = () => {
          signal?.throwIfAborted();
          const authority = owner(auth, input.workspaceId);
          const description = host.describe(auth, scope);
          const head = storage.db
            .prepare(
              "SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?",
            )
            .get(scope.workspaceId, scope.datasetId);
          if (
            !head ||
            head.active !== 1 ||
            head.approved_revision_hash !== input.revisionSha256 ||
            description.revision !== input.revision ||
            description.revisionSha256 !== input.revisionSha256
          )
            throw new DatasetHostError(
              "conflict",
              "Dataset revision is stale. Reload it before uploading.",
            );
          return authority;
        };
        return files.upload(
          scope,
          authorize(),
          {
            authorityRevision: input.revision,
            idempotencyKey: input.idempotencyKey,
            name: input.name,
            contentType: input.contentType,
            bytesBase64: input.bytesBase64,
          },
          authorize,
        );
      },
      dataUpload(
        auth: AppBackendAuth,
        input: Omit<AppBackendUploadRequest, "authorityRevision"> & {
          workspaceId: string;
          datasetId: string;
          revision: number;
          revisionSha256: string;
          fieldId: string;
        },
        signal?: AbortSignal,
      ) {
        const scope = { workspaceId: input.workspaceId, datasetId: input.datasetId };
        const description = host.describe(auth, scope);
        const operation = description.operations.find(
          (operation) => !operation.readOnly && operation.fieldIds.includes(input.fieldId),
        );
        const field = description.tables
          .find((table) => table.tableId === operation?.tableId)
          ?.fields.find((field) => field.fieldId === input.fieldId);
        if (!operation || field?.type !== "attachment") throw notFound();
        const request = {
          ...scope,
          revision: input.revision,
          revisionSha256: input.revisionSha256,
          operationId: operation.operationId,
        };
        const admitted = host.authorize(auth, request);
        return files.upload(
          scope,
          admitted.authority,
          {
            authorityRevision: input.revision,
            idempotencyKey: input.idempotencyKey,
            name: input.name,
            contentType: input.contentType,
            bytesBase64: input.bytesBase64,
          },
          () => {
            signal?.throwIfAborted();
            current();
            if (
              JSON.stringify(host.authorize(auth, request).authority) !==
              JSON.stringify(admitted.authority)
            )
              throw notFound();
            const head = storage.db
              .prepare(
                "SELECT active,approved_revision_hash FROM dohc_dataset_journals WHERE workspace_id=? AND dataset_id=?",
              )
              .get(scope.workspaceId, scope.datasetId);
            if (
              !head ||
              head.active !== 1 ||
              head.approved_revision_hash !== host.authorize(auth, request).revision.revisionSha256
            )
              throw notFound();
          },
        );
      },
      dataReadFile(
        auth: AppBackendAuth,
        input: {
          workspaceId: string;
          datasetId: string;
          revision: number;
          revisionSha256: string;
          fileId: string;
          fieldId: string;
          operationId: string;
          input: AppBackendJson;
        },
        signal?: AbortSignal,
      ) {
        const admitted = host.authorize(auth, input),
          operation = admitted.operation;
        const field = admitted.revision.definition.tables
          .find((table) => table.tableId === operation.tableId)
          ?.fields.find((field) => field.fieldId === input.fieldId);
        if (
          !operation.readOnly ||
          !operation.fieldIds.includes(input.fieldId) ||
          field?.type !== "attachment"
        )
          throw notFound();
        return host.readOperation(
          auth,
          {
            ...input,
            idempotencyKey: randomUUID(),
            signal: AbortSignal.any([storage.unavailable, ...(signal ? [signal] : [])]),
          },
          (result) => {
            if (
              !result ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              !Array.isArray(result.rows) ||
              !result.rows.some((row) => {
                if (
                  !row ||
                  typeof row !== "object" ||
                  Array.isArray(row) ||
                  !row.values ||
                  typeof row.values !== "object" ||
                  Array.isArray(row.values)
                )
                  return false;
                return row.values[input.fieldId] === input.fileId;
              })
            )
              throw notFound();
            return files.readAttached(input, input.fileId, { fileId: input.fileId });
          },
        );
      },
      ownerReadFile(
        auth: AppBackendAuth,
        input: {
          workspaceId: string;
          datasetId: string;
          revision: number;
          revisionSha256: string;
          fileId: string;
        },
        signal?: AbortSignal,
      ) {
        return storage.tx(() => {
          owner(auth, input.workspaceId);
          signal?.throwIfAborted();
          const description = host.describe(auth, input);
          if (
            description.revision !== input.revision ||
            description.revisionSha256 !== input.revisionSha256
          )
            throw new DatasetHostError(
              "conflict",
              "Dataset revision is stale. Reload it before reading.",
            );
          return files.readOwner(input, input.fileId);
        });
      },
      readFile(
        auth: AppBackendAuth,
        publicationId: string,
        input: {
          authorityRevision: number;
          fileId: string;
          operation: string;
          input: AppBackendJson;
          dataset?: string;
        },
        signal?: AbortSignal,
      ) {
        const published = publication(auth, publicationId);
        if (!published || published.authorityRevision !== input.authorityRevision) throw notFound();
        const capability = resolveTargetCapability(published.capabilities, input.dataset);
        const { workspaceId } = published,
          datasetId = capability.datasetId,
          operation = capability.operations.find((operation) => operation.name === input.operation);
        if (!operation?.readOnly) throw notFound();
        host.authorize(auth, {
          workspaceId,
          datasetId,
          revision: capability.revision,
          revisionSha256: capability.revisionSha256,
          operationId: operation.operationId,
          access: { kind: "app", appId: publicationId },
        });
        return host.readOperation(
          auth,
          {
            workspaceId,
            datasetId,
            revision: capability.revision,
            revisionSha256: capability.revisionSha256,
            operationId: operation.operationId,
            input: input.input,
            idempotencyKey: randomUUID(),
            access: { kind: "app", appId: publicationId },
            signal: AbortSignal.any([storage.unavailable, ...(signal ? [signal] : [])]),
          },
          (result) => files.readAttached({ workspaceId, datasetId }, input.fileId, result),
        );
      },
      /** Binds every Collection a shared publication names, together, and returns their ids. */
      bindPublication(
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId?: string; publicationId: string },
      ): string[] {
        owner(auth, input.workspaceId);
        if (memberAppRow(storage, input.publicationId)) throw notFound();
        const loaded = loadAppPublication(auth, input.publicationId);
        if (loaded.local || loaded.workspaceId !== input.workspaceId) throw notFound();
        const operations = loaded.candidate.capabilities.map((declared) => {
          if (declared.kind !== "dataset") throw notFound();
          return bindingOf(
            loaded.candidate,
            input.workspaceId,
            declared.datasetId,
            input.publicationId,
          );
        });
        if (
          !operations.length ||
          (input.datasetId !== undefined &&
            !operations.some((entry) => entry.datasetId === input.datasetId))
        )
          throw notFound();
        host.setBindings(auth, { workspaceId: input.workspaceId, operations }, () => {
          for (const { datasetId } of operations)
            requireDatasetActiveForApproval(input.workspaceId, datasetId);
          activateOwnerPublication(storage, input.publicationId, nowMs());
        });
        return operations.map((entry) => entry.datasetId);
      },
      /** Shares a verified Member app revision to the workspace, binding all its Collections and superseding its slot. */
      publishMemberApp(
        auth: AppBackendAuth,
        input: Omit<
          WriteMemberAppInput,
          "publisherUserId" | "publicationId" | "manifest" | "manifestHash" | "nowMs"
        >,
      ) {
        current();
        const { workspaceId, candidate } = input;
        if (auth.kind !== "named" || auth.workspaceId !== workspaceId || auth.launch)
          throw notFound();
        if (
          candidate.versionId !== MAIN_VERSION_ID ||
          [candidate.appRoot, ...candidate.inputs.map((file) => file.path)].some(
            (path) => visibleSharePath(WHOLE_WORKSPACE, path) !== path,
          )
        )
          throw badRequest("Share apps from the main version of visible files.");
        if (outsideAppRoot(candidate))
          throw badRequest(
            `Keep every file of ${candidate.appRoot} inside its folder to share it.`,
          );
        const manifest = Buffer.from(JSON.stringify(candidate)),
          manifestHash = hash(manifest);
        const publicationId = memberAppIdOf(workspaceId, auth.userId, input.slug, manifestHash);
        const operations = candidate.capabilities.map((declared) => {
          if (declared.kind !== "dataset")
            throw badRequest("Member apps can't create Collections.");
          if (declared.linkReads) throw badRequest("Member apps can't read for share links.");
          if (!memberReach(workspaceId, auth.userId, declared.datasetId)) throw notFound();
          if (
            capability(candidate, workspaceId, declared.datasetId).operations.some(
              (operation) => operation.access === "owner",
            )
          )
            throw badRequest("Member apps can't use owner-only actions.");
          return bindingOf(candidate, workspaceId, declared.datasetId, publicationId);
        });
        const write = () => {
          const written = writeMemberApp(storage, {
            ...input,
            publisherUserId: auth.userId,
            publicationId,
            manifest,
            manifestHash,
            nowMs: nowMs(),
          });
          if (!memberScope(workspaceId, publicationId, 1, candidate, auth.userId, auth.userId))
            throw notFound();
          return written;
        };
        const workspaceOwner = storage.db
          .prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id=?")
          .get(workspaceId);
        if (!workspaceOwner) throw notFound();
        const shared = storage.db
          .prepare("SELECT 1 FROM sync_relay_app_publications WHERE publication_id=? AND active=1")
          .get(publicationId);
        let written: ReturnType<typeof writeMemberApp> | undefined;
        if (!operations.length || shared) written = storage.tx(write);
        else
          host.setBindings(
            { kind: "named", workspaceId, userId: String(workspaceOwner.owner_user_id) },
            { workspaceId, operations },
            () => {
              for (const { datasetId } of operations)
                requireDatasetActiveForApproval(workspaceId, datasetId);
              written = write();
            },
          );
        return written!;
      },
      /**
       * The official Workspace Publications this person can open, then the Member apps they can open. The Owner and
       * Admins also see every Member app, and authors their own, so they can withdraw one that stopped working.
       */
      memberApps(auth: AppBackendAuth, input: { workspaceId: string; cursor?: string }) {
        current();
        if (auth.kind !== "named" || auth.workspaceId !== input.workspaceId) throw notFound();
        return storage.readTx(() => {
          const role = workspaceRoleOf(storage, input.workspaceId, auth.userId)?.role;
          if (!role) throw notFound();
          const page = workspaceAppPage(storage, input.workspaceId, input.cursor ?? "");
          const reachable = <T>(load: () => T) => {
            try {
              return load();
            } catch (error) {
              if (!(error instanceof RelayError || error instanceof DatasetHostError)) throw error;
              return null;
            }
          };
          const apps = page.rows.flatMap((row) => {
            if (row.kind === "workspace") {
              const served = reachable(() => servedPublication(auth, row.publicationId));
              if (!served) return [];
              return [
                {
                  ...row,
                  name: served.candidate.appRoot.split("/").at(-1)!,
                  reachable: true,
                  consent: null,
                  canWithdraw: false,
                },
              ];
            }
            const member =
              reachable(() => namedPublication(auth, row.publicationId, true))?.member ?? null;
            const own = row.publisherUserId === auth.userId;
            if (!member && role === "member" && !own) return [];
            return [
              {
                ...row,
                name: row.slug!,
                reachable: member !== null,
                consent: member?.consent ?? null,
                canWithdraw: role !== "member" || own,
              },
            ];
          });
          return { apps, nextCursor: page.nextCursor };
        });
      },
      /** Records that this person allowed the operations they reviewed. Only a person allows, never an agent. */
      consentMemberApp(auth: AppBackendAuth, publicationId: string, scopeDigest: string) {
        current();
        if (auth.kind !== "named" || auth.launch) throw notFound();
        if (!auth.person) throw new MemberAppRefusal("browser");
        return storage.tx(() => {
          const published = namedPublication(auth, publicationId, true);
          if (!published.member) throw notFound();
          const { scope, digest, consent } = published.member;
          if (digest !== scopeDigest) throw new MemberAppRefusal("changed");
          if (consent !== "current")
            deletePhoneAppLaunches(storage, {
              userId: auth.userId,
              workspaceId: auth.workspaceId,
              publicationId,
            });
          recordMemberAppConsent(storage, {
            workspaceId: auth.workspaceId,
            viewerUserId: auth.userId,
            publicationId,
            scopeDigest,
            scope,
            nowMs: nowMs(),
          });
          return { publicationId, scopeDigest, consent: "current" as const };
        });
      },
      unbindPublication(
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId: string; publicationId: string },
      ): void {
        if (memberAppRow(storage, input.publicationId)) throw notFound();
        const multi = storage.db
          .prepare(
            "SELECT candidate,owner_user_id FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=? AND dataset_id IS NULL",
          )
          .get(input.workspaceId, input.publicationId);
        if (multi) {
          owner(auth, input.workspaceId);
          if (auth.kind !== "named" || auth.grantId || multi.owner_user_id !== auth.userId)
            throw notFound();
          const bound = storage.db
            .prepare(
              "SELECT 1 FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?",
            )
            .get(input.workspaceId, input.datasetId, input.publicationId);
          if (!bound) return;
          withdrawLocalAppWorkspace(auth, {
            workspaceId: input.workspaceId,
            publicationId: input.publicationId,
          });
          return;
        }
        host.setBinding(auth, { ...input, appId: input.publicationId, binding: null }, () => {
          const scope = [input.workspaceId, input.datasetId, input.publicationId] as const;
          const row = storage.db
            .prepare(
              "SELECT candidate FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND dataset_id=? AND app_id=?",
            )
            .get(...scope);
          if (!row || row.candidate === "") return;
          // The app goes, and its row stays with its revision, so approving it again gives the
          // next one, and a change sent under this approval never runs under that one.
          storage.db
            .prepare(
              "UPDATE sync_relay_local_dataset_apps SET candidate='' WHERE workspace_id=? AND dataset_id=? AND app_id=?",
            )
            .run(...scope);
          account(input.workspaceId, input.datasetId, -Buffer.byteLength(String(row.candidate)));
        });
      },
      approveLocalApp,
      approveLocalAppWorkspace(
        auth: AppBackendAuth,
        input: { workspaceId: string; candidate: unknown },
      ): { publicationId: string; authorityRevision: number } {
        owner(auth, input.workspaceId);
        if (auth.kind !== "named" || auth.grantId) throw notFound();
        let candidate: AppPublicationCandidate;
        try {
          candidate = parseAppPublicationCandidate(input.candidate, limits);
        } catch {
          throw badRequest("Invalid app approval.");
        }
        if (
          (candidate.capabilities.length === 0 && !candidate.external) ||
          candidate.capabilities.some((cap) => cap.kind !== "dataset")
        )
          throw badRequest("Invalid app approval.");
        const datasetCaps = candidate.capabilities as AppDatasetCapability[];
        if (datasetCaps.length === 1) {
          return approveLocalApp(auth, {
            workspaceId: input.workspaceId,
            datasetId: datasetCaps[0]!.datasetId,
            candidate: input.candidate,
          });
        }
        const bindings = datasetCaps.map((declared) => {
          const verified = capability(candidate, input.workspaceId, declared.datasetId);
          const { operations: _operations, name: _name, alias: _alias, ...binding } = verified;
          return { datasetId: verified.datasetId, binding };
        });
        const appId = hash(
          JSON.stringify([
            datasetCaps.length ? "dohc-local-dataset-app-v1" : "dohc-local-unconnected-app-v1",
            input.workspaceId,
            candidate,
          ]),
        );
        const existingApp = storage.db
          .prepare(
            "SELECT authority_revision,candidate,owner_user_id FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=?",
          )
          .get(input.workspaceId, appId);
        if (
          existingApp &&
          existingApp.owner_user_id === auth.userId &&
          existingApp.candidate !== "" &&
          bindings.every((entry) =>
            Boolean(
              storage.db
                .prepare(
                  "SELECT 1 FROM dohc_dataset_bindings WHERE workspace_id=? AND dataset_id=? AND app_id=?",
                )
                .get(input.workspaceId, entry.datasetId, appId),
            ),
          )
        ) {
          for (const entry of bindings)
            requireDatasetActiveForApproval(input.workspaceId, entry.datasetId);
          return {
            publicationId: appId,
            authorityRevision: Number(existingApp.authority_revision),
          };
        }
        let authorityRevision = 1;
        const approve = () => {
          for (const entry of bindings)
            requireDatasetActiveForApproval(input.workspaceId, entry.datasetId);
          const row = storage.db
            .prepare(
              "SELECT authority_revision,candidate FROM sync_relay_local_dataset_apps WHERE workspace_id=? AND app_id=?",
            )
            .get(input.workspaceId, appId);
          authorityRevision = row ? Number(row.authority_revision) + 1 : 1;
          const kept = JSON.stringify(candidate);
          accountWorkspace(
            input.workspaceId,
            Buffer.byteLength(kept) -
              (row ? Buffer.byteLength(String(row.candidate)) : -localAppBytes(appId)),
          );
          storage.db
            .prepare(
              "INSERT INTO sync_relay_local_dataset_apps VALUES(?,?,NULL,?,?,?) ON CONFLICT(workspace_id,app_id) DO UPDATE SET candidate=excluded.candidate,authority_revision=excluded.authority_revision",
            )
            .run(input.workspaceId, appId, auth.userId, kept, authorityRevision);
          const recordAppDataset = storage.db.prepare(
            "INSERT OR IGNORE INTO sync_relay_local_dataset_app_datasets VALUES(?,?,?)",
          );
          for (const entry of bindings)
            recordAppDataset.run(input.workspaceId, appId, entry.datasetId);
        };
        if (bindings.length === 0) storage.tx(approve);
        else
          host.setBindings(
            auth,
            {
              workspaceId: input.workspaceId,
              operations: bindings.map((entry) => ({
                datasetId: entry.datasetId,
                appId,
                binding: entry.binding,
              })),
            },
            approve,
          );
        return { publicationId: appId, authorityRevision };
      },
      withdrawLocalAppWorkspace,
      setDataGrant(
        auth: AppBackendAuth,
        input: {
          workspaceId: string;
          datasetId: string;
          grantId: string;
          grant: DatasetDataGrant | null;
        },
      ): void {
        const manager = grantManager(auth, input.workspaceId);
        const target = storage.getShareGrant(input.grantId);
        if (!target || target.principalKind !== "user" || !target.principalUserId) throw notFound();
        const key =
          input.grant === null
            ? datasetPrincipalKey(input.workspaceId, input.grantId, target.principalUserId)
            : named(input.workspaceId, input.grantId, target.principalUserId).principalKey;
        host.setDataGrant(manager, { ...input, principalKey: key });
      },
      removeDataGrant(
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId: string; principalKey: string },
      ): void {
        host.setDataGrant(grantManager(auth, input.workspaceId), { ...input, grant: null });
      },
      /** A Collection's grants, with its workspace defaults, for its Owner or an Admin. */
      permissions(
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId: string; after?: string; limit?: number },
      ) {
        const manager = grantManager(auth, input.workspaceId);
        const page = host.permissions(manager, input);
        const approved = host.approvedRevision(manager, input);
        return {
          ...page,
          defaults: readWorkspaceDefaults(input.workspaceId, input.datasetId),
          rules: {
            revision: approved.revision,
            revisionSha256: approved.revisionSha256,
            actions: approved.definition.operations
              .filter((operation) => operation.access !== "owner")
              .map(({ operationId, name, readOnly }) => ({ operationId, name, readOnly })),
          },
        };
      },
      /** Sets the operations each folder level holds by default. View and Comment hold only reads; no level holds an `owner` operation. */
      setWorkspaceDefaults(
        auth: AppBackendAuth,
        input: { workspaceId: string; datasetId: string; defaults: Defaults },
      ): { generation: number } {
        const manager = grantManager(auth, input.workspaceId);
        const { workspaceId, datasetId, defaults } = input;
        return storage.tx(() => {
          owner(manager, workspaceId);
          const approved = resolveCompatibleDatasetRevision(
            storage.db,
            { workspaceId, datasetId },
            defaults,
          );
          if (
            approved.revision !== defaults.revision ||
            approved.revisionSha256 !== defaults.revisionSha256
          )
            throw new DatasetHostError(
              "conflict",
              "The Collection's rules changed after you chose this access. Choose it again.",
            );
          for (const level of DEFAULT_LEVELS)
            for (const operationId of defaults[level]) {
              const operation = approved.definition.operations.find(
                (operation) => operation.operationId === operationId,
              );
              if (!operation || operation.access === "owner")
                throw badRequest("Choose actions this Collection offers to members.");
              if (level !== "edit" && !operation.readOnly)
                throw badRequest(
                  `"${operation.name}" changes data, so only people with Edit access can get it by default.`,
                );
            }
          const json = JSON.stringify({
            view: defaults.view,
            comment: defaults.comment,
            edit: defaults.edit,
            revision: defaults.revision,
            revisionSha256: defaults.revisionSha256,
          });
          const row = storage.db
            .prepare(
              "SELECT generation,defaults_json FROM dohc_dataset_workspace_defaults WHERE workspace_id=? AND dataset_id=?",
            )
            .get(workspaceId, datasetId);
          account(
            workspaceId,
            datasetId,
            Buffer.byteLength(json) - (row ? Buffer.byteLength(String(row.defaults_json)) : -128),
          );
          const generation = row ? Number(row.generation) + 1 : 1;
          storage.db
            .prepare(
              "INSERT INTO dohc_dataset_workspace_defaults VALUES(?,?,?,?) ON CONFLICT(workspace_id,dataset_id) DO UPDATE SET defaults_json=excluded.defaults_json,generation=excluded.generation",
            )
            .run(workspaceId, datasetId, json, generation);
          return { generation };
        });
      },
      async deleteWorkspaces(datasets: readonly { workspaceId: string; datasetId: string }[]) {
        for (const scope of datasets) await host.retireScope(scope);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type RelayDatasetHost = Awaited<ReturnType<typeof createRelayDatasetHost>>;
