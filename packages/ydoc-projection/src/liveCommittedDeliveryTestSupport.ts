import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import * as Y from "yjs";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { markdownToYDoc } from "./import-export.js";
import {
  createLiveMarkdownRegistrationValidator,
  createLiveMarkdownJournalValidator,
} from "./liveDocumentValidation.js";
import {
  openSyncRelayStorage,
  type LiveUpdateJournalCommitInput,
  type LiveHostConnectionCoordinate,
} from "../../../services/sync-relay/src/storage.js";
import { initializeRelayDeployment, openRelayDeployment } from "../../../services/sync-relay/src/relayDeployment.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";

export const policy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
};
const validate = createLiveMarkdownRegistrationValidator(policy);
const validateJournal = createLiveMarkdownJournalValidator(policy);
export const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
export const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const host = {
  mode: "device",
  hostId: "host",
  hostEpoch: parseHostEpoch(1),
  instanceId: "instance",
  connectionId: "connection",
} as const;
const roots: string[] = [];
export function cleanupLiveDeliveryFixtures() {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}

function checkpoint(
  markdown = "Hello",
  edit?: (doc: Y.Doc) => void,
): Uint8Array {
  const doc = markdownToYDoc(markdown);
  try {
    edit?.(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
function validated(
  bytes = checkpoint(),
  currentPath = "docs/a.md",
  objectId = "object",
) {
  const captured = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const document = {
    workspaceId: "workspace",
    mainVersionId: "main",
    objectId,
    lineageClaimId: hash(captured),
  };
  const result = validate({ document, currentPath, checkpoint: captured });
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
  const baselineBytes = Uint8Array.from(captured);
  expect(hash(baselineBytes)).toBe(result.evidence.checkpoint.updateDigest);
  return {
    host: { ...host },
    evidence: result.evidence,
    baselineBytes,
    registeredAtMs: 10,
  };
}
function fixture(options: { workspaceQuotaBytes?: number; deployment?: boolean } = {}, configuredHost: LiveHostConnectionCoordinate = host) {
  const root = mkdtempSync(join(tmpdir(), "dohc-baseline-storage-"));
  roots.push(root);
  const path = join(root, "volume", "relay.sqlite");
  const configPath = join(root, "deployment.json");
  if (options.deployment) initializeRelayDeployment({ configPath, relayPath: path, continuityDirectory: join(root, "continuity") });
  const storage = options.deployment ? openRelayDeployment(configPath, options).storage : openSyncRelayStorage(path, options);
  const raw = new DatabaseSync(path, { readOnly: options.deployment === true });
  const write = (run: (db: StorageContext["db"]) => void) => {
    const context = storage as StorageContext;
    context.tx(() => run(context.db));
  };
  try {
    write(db => { db
      .prepare(
        "INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)",
      )
      .run("workspace", "owner", 0); });
    storage.provisionLiveHostControl({
      mode: configuredHost.mode,
      hostId: configuredHost.hostId,
      updatedAtMs: 1,
      guard() {},
    });
    storage.registerLiveHost({ ...configuredHost, updatedAtMs: 2, guard() {} });
  } catch (error) {
    raw.close();
    storage.close();
    throw error;
  }
  const moment = (
    input: Pick<ReturnType<typeof validated>, "evidence">,
    sequence = 1,
    changes: Record<string, unknown> = {},
  ) => {
    const row = {
      workspace_id: "workspace",
      object_id: input.evidence.document.objectId,
      relay_seq: sequence,
      moment_id: `moment-${sequence}`,
      version_id: "main",
      path: input.evidence.currentPath,
      blob_sha256: input.evidence.projectedMarkdownSha256,
      content_kind: "text",
      byte_length: input.evidence.projectedMarkdownByteLength,
      recorded_at_ms: sequence,
      ...changes,
    };
    write(db => { db
      .prepare(
        `INSERT INTO sync_relay_object_moments (${Object.keys(row).join(",")}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .run(...(Object.values(row) as Array<string | number | null>)); });
  };
  const rows = () => ({
    documents: raw
      .prepare(
        "SELECT * FROM sync_relay_live_documents ORDER BY lineage_claim_id",
      )
      .all(),
    ranges: raw
      .prepare(
        "SELECT * FROM sync_relay_live_document_baseline_ranges ORDER BY client_id, start_clock",
      )
      .all(),
  });
  return {
    storage,
    raw,
    path,
    configPath,
    write,
    moment,
    rows,
    close() {
      raw.close();
      storage.close();
    },
  };
}

export function registered(
  options: {
    workspaceQuotaBytes?: number;
    baselineBytes?: Uint8Array;
    journalPolicy?: typeof policy;
    host?: LiveHostConnectionCoordinate;
    deployment?: boolean;
  } = {},
) {
  const f = fixture(options, options.host),
    input = { ...validated(options.baselineBytes), host: { ...(options.host ?? host) } };
  f.moment(input);
  expect(f.storage.registerLiveDocumentBaseline(input).kind).toBe("registered");
  f.write(db => { db
    .prepare(
      `INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
    VALUES ('share','workspace','owner',?,0)`,
    )
    .run(JSON.stringify({ paths: ["docs"], versionId: null })); });
  f.write(db => { db
    .exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('grant','share','user','reader',NULL,'edit',4,'active',0,NULL,NULL)`); });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, input.baselineBytes);
  const actor = { kind: "owner", userId: "owner", shareId: "share" } as const;
  const update = (key = "title", value = "Changed") => {
    const before = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set(key, value);
    return Y.encodeStateAsUpdate(doc, before);
  };
  const capture = (
    bytes: Uint8Array,
    deliveryId = "delivery",
    candidateActor: LiveUpdateJournalCommitInput["actor"] = actor,
    onStateCapture?: () => void,
  ): LiveUpdateJournalCommitInput => {
    const current = f.storage.resolveCurrentLiveDocumentBinding({
      document: input.evidence.document,
      actor: candidateActor,
    });
    if (current.kind !== "current") throw new Error(JSON.stringify(current));
    const cut = f.storage.readLiveUpdateJournalCut({
      document: input.evidence.document,
    });
    if (cut.kind !== "cut") throw new Error(JSON.stringify(cut));
    const captured = Uint8Array.from(bytes),
      digest = hash(captured);
    const validation = (
      options.journalPolicy
        ? createLiveMarkdownJournalValidator(options.journalPolicy)
        : validateJournal
    )({
      document: cut.cut.document,
      currentPath: cut.cut.currentPath,
      checkpoint: cut.cut.checkpoint.bytes,
      suffix: cut.cut.suffix.map((row) => row.bytes),
      candidate: captured,
    });
    const due =
      cut.cut.suffixCount + 1 === 4095 ||
      cut.cut.suffixBytes + captured.byteLength >= 20_971_520;
    const state =
      validation.kind === "accepted" && due
        ? (() => {
            onStateCapture?.();
            return { stateUpdate: validation.evidence.stateUpdate };
          })()
        : {};
    const owned =
      validation.kind === "accepted"
        ? {
            kind: validation.kind,
            evidence: {
              version: validation.evidence.version,
              document: validation.evidence.document,
              currentPath: validation.evidence.currentPath,
              checkpointDigest: validation.evidence.checkpointDigest, checkpointRanges: validation.evidence.checkpointRanges,
              suffixDigests: validation.evidence.suffixDigests,
              candidate: validation.evidence.candidate,
              ...state,
              stateUpdateSha256: validation.evidence.stateUpdateSha256,
              stateUpdateByteLength: validation.evidence.stateUpdateByteLength,
            },
          }
        : validation;
    expect(hash(captured)).toBe(digest);
    if (owned.kind === "accepted")
      expect(owned.evidence.candidate.updateDigest).toBe(digest);
    return {
      host: current.host,
      actor: candidateActor,
      expectedAuthority: current.authority,
      metadata: { deliveryId, updateDigest: digest, binding: current.binding },
      cutToken: cut.cut,
      validation: owned,
      updateBytes: Uint8Array.from(captured),
      receivedAtMs: 30,
    };
  };
  const journalRows = () => ({
    journal: f.raw
      .prepare(
        "SELECT * FROM sync_relay_live_update_journal ORDER BY journal_cursor",
      )
      .all(),
    provenance: f.raw
      .prepare(
        "SELECT * FROM sync_relay_live_update_struct_provenance ORDER BY client_id,start_clock",
      )
      .all(),
    usage: f.raw
      .prepare(
        "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
      )
      .get()!.usage_bytes,
  });
  return {
    ...f,
    input,
    actor,
    doc,
    update,
    capture,
    journalRows,
    close() {
      doc.destroy();
      f.close();
    },
  };
}
