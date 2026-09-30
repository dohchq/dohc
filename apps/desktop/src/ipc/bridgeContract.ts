import { nameByteLength } from "@dohc/workspace-contracts/names";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import type {OwnerRestoreRequest, OwnerRestoreAction, OwnerRestoreResult} from "./ownerRestoreContract";
import type {OwnerAppPublicationRequest, OwnerAppPublicationResult} from "./ownerAppPublicationContract";
import type { DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type {OwnerAppResponsesRequest,OwnerAppResponsesResult} from "@dohc/cli/app-responses";
import { normalizeShareDiscussionBody } from "@dohc/security-contract/share-discussion";
import { SHARE_ACCESS_VALUES, shareAccessRank } from "@dohc/security-contract/share-selector";
import {
  hasEngineIgnoredSegment,
  WORKSPACE_KINDS,
  WORKSPACE_MODES,
} from "@dohc/workspace-core";
import { z } from "zod";
import type { AgentToolsResult } from "../agents/agentToolCatalog";
import type { Automation, AutomationDiagnostic } from "@dohc/workspace-contracts/automations";
import type {
  CollectionAutomationHolds,
  CollectionAutomationButton,
  CollectionAutomationRetry,
  CollectionAutomationRun,
  CollectionAutomationShareStop,
  CollectionAutomationsFile,
  CollectionAutomationStop,
  CollectionFieldMark,
  CollectionAutomationGroup,
  CollectionAutomationPeople,
  CollectionAutomationTarget,
  CollectionAutomationUndo,
  PressSettled,
  PressWaitReason,
} from "@dohc/automation-executor/collection-automations";
import { MAX_VERSIONED_BINARY_FILE_BYTES } from "@dohc/workspace-contracts/engine";
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_ID_MAX_CHARS,
  NOTICE_SENDER_LABEL_MAX_CHARS,
  NOTICE_TARGET_FIELD_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
} from "@dohc/workspace-contracts/relay";
import {
  COLLECTION_SCHEMA_REASON_CODES,
  FIELD_VALUE_REASON_CODES,
} from "@dohc/workspace-contracts/collection";
import { MAX_SCHEMA_COLLECTION_ITEMS } from "@dohc/workspace-contracts/collection-values";
import type {
  CollectionGetResult as CollectionGetResultContract,
  CollectionListResult as CollectionListResultContract,
  CollectionQueryCursor,
  CollectionQueryFilter,
  CollectionQueryResult as CollectionQueryResultContract,
  CollectionQuerySort,
  CollectionRecord,
  CollectionSchema as CollectionSchemaContract,
  CollectionSummary as CollectionSummaryContract,
  CollectionValue,
  FieldDefinition,
  ViewDefinition,
} from "@dohc/workspace-contracts/collection";
import type {
  ArtifactAssetDescriptor,
  EngineStoreRefusal,
} from "@dohc/workspace-engine-client";
export type { EngineStoreRefusal } from "@dohc/workspace-engine-client";
import {
  isChatsTabPath,
  canonicalSingletonEditorTabPath,
  isSiteTabPath,
  isSingletonEditorTabPath,
  MAX_COLLECTION_VIEWS,
  MAX_EXPANDED_FOLDERS,
  MAX_EDITOR_GROUPS,
  MAX_EDITOR_GROUP_ID_CHARS,
  MAX_OPEN_TABS,
  MAX_PINNED_PATHS,
  MAX_RECENT_FILES,
  CHATS_MAX_WIDTH,
  CHATS_MIN_WIDTH,
  OPEN_EDITORS_MAX_HEIGHT,
  OPEN_EDITORS_MIN_HEIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  APP_VIEW_ID_PREFIX,
  parseAppViewId,
  VIEW_IDS,
} from "../renderer/workbench/workbenchState";
import {
  EXPLORER_MENU_COMMANDS,
  MENU_COMMANDS,
  ENGINE_YDOC_SESSION_ID_MAX_CHARS,
  ENGINE_YDOC_UPDATE_MAX_BYTES,
  SEARCH_EVENT_MAX_ENTRIES,
  SEARCH_EVENT_MAX_ID_CHARS,
  SEARCH_EVENT_MAX_NOTICE_CHARS,
  SEARCH_EVENT_MAX_PREVIEW_CHARS,
  WORKBENCH_MENU_COMMANDS,
  ENGINE_YDOC_SAVE_STATES,
} from "./channels";
import { UPDATE_CHANNELS, UPDATE_STATUSES } from "../updates/updateMachine";
import type { OperationBridge, OperationTable } from "./operationTable";
import { isLoopbackHostname } from "../security/loopback";
import {
  DesktopUserSettings as DesktopUserSettingsSchema,
  DesktopUserSettingsResult as DesktopUserSettingsResultSchema,
  ZOOM_STEPS,
} from "../settings/userSettings";
import type {
  DesktopUserSettings as DesktopUserSettingsType,
  DesktopUserSettingsResult as DesktopUserSettingsResultType,
} from "../settings/userSettings";
import {
  WorkspaceSettings as WorkspaceSettingsSchema,
  WorkspaceSettingsPatch as WorkspaceSettingsPatchSchema,
  WorkspaceSettingsResult as WorkspaceSettingsResultSchema,
} from "../workspaces/workspaceSettings";
import type {
  WorkspaceSettings as WorkspaceSettingsType,
  WorkspaceSettingsResult as WorkspaceSettingsResultType,
} from "../workspaces/workspaceSettings";
import {
  utf8ByteLength,
  WORKSPACE_TEXT_EDITOR_MAX_BYTES,
  workspaceTextLimitReason,
} from "../workspaces/workspaceTextLimits";

// Typed contract for everything the preload bridge exposes. Main-process
// handlers validate payloads on arrival and results before returning them.
// The renderer never sees raw Electron APIs.

const OPAQUE_ID = z.string().min(1).max(200);
const CHAT_CHANNEL_SLUG = z.string().min(1).refine(value => nameByteLength(value) <= 200);

// Length caps: IPC payloads are untrusted; bound every renderer-supplied
// string so a hostile/buggy caller cannot cause memory/latency pressure.
// workspaceId doubles as the dohc-file:// URL HOSTNAME, so it must be
// hostname-safe and lowercase (URL hostnames lowercase silently — a
// case-variant id would break asset serving or alias another workspace).
// Our own ids are UUIDs; a foreign manifest with any other shape is rejected
// at attach time with a visible error.
const WORKSPACE_ID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "workspace id must be lowercase alphanumeric/hyphens");
const PATH_STRING = z.string().min(1).max(4096);
// Lexically safe workspace-relative path: forward-slashed, no null bytes, no
// backslashes, no empty/dot/dot-dot segments, not absolute. Main validates
// containment before sending; this is the closed gate the preload re-applies
// to every path that crosses main→renderer.
export function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
const SAFE_RELATIVE_PATH = PATH_STRING.refine(
  isSafeRelativePath,
  "path must be a safe workspace-relative path",
);
const WORKSPACE_EDITOR_TEXT = z.string().superRefine((text, ctx) => {
  const observedBytes = utf8ByteLength(text);
  if (observedBytes <= WORKSPACE_TEXT_EDITOR_MAX_BYTES) return;
  ctx.addIssue({
    code: "custom",
    message: workspaceTextLimitReason(observedBytes),
  });
});

// Stored-body fields are the exception to the caps above. Every RESPONSE field
// on this schema carries text the ENGINE already accepted, not text a renderer
// supplied. The engine accepts a text write up to MAX_TEXT_BYTES — 10 MiB of
// UTF-8 (`crates/dohc-engine-domain/src/store.rs`) — and it never gates a
// settle on the smaller in-band response cap
// (`crates/dohc-engine-runtime/src/actor.rs` settle), so an over-cap document
// lands on disk like any other. The bound below is the engine's own, so the
// bridge is never the gate that rejects a stored body. Zod counts UTF-16 code
// units and UTF-8 never spends less than one byte per code unit, so this
// character bound admits every body the engine could hold.
//
// Matching the storage contract does not promise that every stored body
// arrives. The daemon caps one wire string at 8 MiB (`WireLimits`,
// `crates/dohc-engine-protocol/src/limits.rs`), so a larger body reaches the
// renderer only by blob hydration. `versionedText.read`, the moment timeline,
// compare rows, and conflict listing all hydrate withheld bodies — see
// VERSION_TEXT.
//
// One REQUEST field shares the schema — the combined conflict resolution at
// VERSION_TEXT. There this bound is only a ceiling on what crosses IPC; the
// engine owns the real limit and re-checks it.
export const ENGINE_TEXT_MAX_CHARS = 10 * 1024 * 1024;
function engineStoredText(label: string) {
  return z.string().superRefine((text, ctx) => {
    if (text.length <= ENGINE_TEXT_MAX_CHARS) return;
    ctx.addIssue({
      code: "custom",
      message:
        `${label} is ${text.length} characters; the IPC bridge carries at most ` +
        `${ENGINE_TEXT_MAX_CHARS} characters (the engine's 10 MiB UTF-8 text cap)`,
    });
  });
}

const SITE_ROOT_STRING = PATH_STRING.superRefine((value, ctx) => {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === ".." || (segment === "." && value !== "."))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "site root must be a safe workspace-relative path",
    });
  }
});

// Enums derive from the workspace-core tuples (single source of truth) so a
// new kind/mode cannot make the type and the runtime validator disagree.
const KIND_ENUM = z.enum(WORKSPACE_KINDS);
const MODE_ENUM = z.enum(WORKSPACE_MODES);

export const PickWorkspaceRootResult = PATH_STRING.nullable();
export type PickWorkspaceRootResult = z.infer<typeof PickWorkspaceRootResult>;

// The level a recipient holds on a path/version share, from the same
// one place the relay and the engine read it. All three levels read the same
// files today; PR2 opens comment and edit to chat, PR3 opens edit to writes.
// The chat grant's own binary access is a different field.
const SHARE_ACCESS = z.enum(SHARE_ACCESS_VALUES);
export type ShareAccess = z.infer<typeof SHARE_ACCESS>;

// Ops a share pull skipped, and why. Durable state, not a status: the pull
// commits its cursor past a refused op, so that content never arrives again
// unless the granter writes the same path a second time.
export const ShareSkippedOpsSummary = z.object({
  ops: z
    .array(
      z.object({
        originId: z.string().min(1).max(512),
        originSeq: z.number().int().nonnegative(),
        opKind: z.string().min(1).max(128),
        code: z.string().min(1).max(128),
        detail: z.string().min(1).max(2048),
        atMs: z.number().int().nonnegative(),
      }),
    )
    .max(20),
  more: z.number().int().nonnegative(),
  // Bumped whenever a pull adds a skipped op. A dismissal names the
  // generation the user saw, so a refusal recorded between the render and the
  // click survives it.
  generation: z.number().int().nonnegative(),
  // The generation the user has seen. Dismissing raises this and deletes
  // nothing, so the warning is hidden while the evidence stays.
  acknowledgedGeneration: z.number().int().nonnegative().optional(),
  // `more` may over-report past the tracked-origin bound; the copy says "at
  // least" rather than a number it cannot stand behind.
  inexact: z.boolean().optional(),
});
export type ShareSkippedOpsSummary = z.infer<typeof ShareSkippedOpsSummary>;

export const WorkspaceSummary = z.object({
  workspaceId: WORKSPACE_ID,
  rootPath: PATH_STRING,
  kind: KIND_ENUM,
  mode: MODE_ENUM,
  // Epoch ms of the last open in any window; absent when never stamped.
  lastOpenedAt: z.number().int().nonnegative().optional(),
  // Present only on a shared VIEW received through a relay share grant:
  // the workspace is read-only, refreshed from the share, and
  // carries who shared it for honest copy. `ended` marks a revoked share.
  shareView: z
    .object({
      // Absent only on a `damaged` marker whose stored record had no readable
      // id. Never invented: a placeholder id is a lie the rest of the app
      // could act on. A marker without one is damaged by definition — every
      // live-share action (refresh, dismiss) is addressed by share id, so a
      // marker that cannot name itself cannot be presented as a live share.
      shareId: OPAQUE_ID.optional(),
      subjectName: z.string().max(320).nullable().optional(),
      sharerName: z.string().max(320).nullable().optional(),
      granterEmail: z.string().min(3).max(320).nullable(),
      // The pinned level. Absent only when `damaged` says the stored
      // grant could not be read. The banner states the level; it never
      // decides anything with it.
      access: SHARE_ACCESS.optional(),
      genericChatWritable: z.boolean().optional(),
      // The stored grant is unreadable. The marker still stands, because a
      // share view whose grant cannot be read must not present as an ordinary
      // workspace: the restrictive stance is what fails closed. The shell
      // keeps the view read-only, keeps the share surfaces hidden, skips the
      // refresh it has no grant to pull with, and says so in the banner.
      damaged: z.literal(true).optional(),
      ended: z.boolean().optional(),
      skippedOps: ShareSkippedOpsSummary.optional(),
    })
    .optional(),
  // Share mounts: received shares materialized into this workspace's
  // shared-with-me/<label>/ as ordinary read-only files. `ended` marks a
  // revoked share (the mounted copy stays readable, stops refreshing).
  shareMounts: z
    .array(
      z.object({
        // Both required, damaged or not: they are what the Remove action is
        // addressed by (`shareId`) and what names the folder on disk
        // (`label`). A row that cannot supply them cannot be acted on, so it
        // is the one shape that is dropped instead of kept.
        shareId: OPAQUE_ID,
        label: z.string().min(1).max(64),
        granterEmail: z.string().min(3).max(320).nullable(),
        // The pinned level, so a mount the relay no longer lists can
        // still say what it grants. Absent only when `damaged` says the
        // stored grant could not be read.
        access: SHARE_ACCESS.optional(),
        // The stored grant is unreadable. The row is kept so the mount stays
        // removable: its folder is on disk, and dropping the row would strand
        // it with no way back through the UI. It shows no level, refreshes
        // nothing, and says what happened.
        damaged: z.literal(true).optional(),
        ended: z.boolean().optional(),
        skippedOps: ShareSkippedOpsSummary.optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceRegistryResult = z.object({
  workspaces: z.array(WorkspaceSummary),
});
export type WorkspaceRegistryResult = z.infer<typeof WorkspaceRegistryResult>;

export const DefaultWorkspaceRootResult = PATH_STRING;

// Where a share opened as its own view goes when the person does not pick a
// folder: a sibling of the default workspace root, named after the share.
// The main process approves the path so the open can use it without a
// dialog; the renderer never invents roots.
export const DefaultShareRootPayload = z.object({
  shareId: z.string().min(1).max(128),
});
export type DefaultShareRootPayload = z.infer<typeof DefaultShareRootPayload>;
export const DefaultShareRootResult = PATH_STRING;

export const CreateLocalWorkspacePayload = z.object({
  rootPath: PATH_STRING,
  kind: z.enum(["personal", "shared"]),
});
export type CreateLocalWorkspacePayload = z.infer<
  typeof CreateLocalWorkspacePayload
>;

export const AttachWorkspaceFolderPayload = z.object({
  rootPath: PATH_STRING,
});
export type AttachWorkspaceFolderPayload = z.infer<
  typeof AttachWorkspaceFolderPayload
>;

export const WorkspaceIdPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type WorkspaceIdPayload = z.infer<typeof WorkspaceIdPayload>;

export const RevealWorkspaceFolderPayload = WorkspaceIdPayload.extend({
  recoveryCopies: z.boolean().optional(),
});
export type RevealWorkspaceFolderPayload = z.infer<typeof RevealWorkspaceFolderPayload>;

// Who asked for a sync pass now. A person's retry counts toward the attempts
// a failure's notice weighs; a retry on reconnecting or waking does not.
export const RetryCloudSyncPayload = WorkspaceIdPayload.extend({
  reason: z.enum(["person", "reconnect"]),
});
export type RetryCloudSyncPayload = z.infer<typeof RetryCloudSyncPayload>;

export const OwnerLiveDocument = z.object({
  path: SAFE_RELATIVE_PATH,
  status: z.enum(["ready", "preparing", "paused", "unavailable", "retired"]),
  reason: z.enum(["document-unavailable", "workspace-changed"]).optional(),
  canResume: z.boolean(),
}).strict();
export type OwnerLiveDocument = z.infer<typeof OwnerLiveDocument>;
export const ListOwnerLiveDocumentsPayload = WorkspaceIdPayload.extend({
  retiredAfter: SAFE_RELATIVE_PATH.optional(),
}).strict();
export type ListOwnerLiveDocumentsPayload = z.infer<typeof ListOwnerLiveDocumentsPayload>;
export const OwnerLiveDocumentsResult = z.object({
  documents: z.array(OwnerLiveDocument).max(128),
  nextCursor: SAFE_RELATIVE_PATH.nullable(),
}).strict();
export type OwnerLiveDocumentsResult = z.infer<typeof OwnerLiveDocumentsResult>;
export const OwnerLiveDocumentActionPayload = WorkspaceIdPayload.extend({path: SAFE_RELATIVE_PATH}).strict();
export type OwnerLiveDocumentActionPayload = z.infer<typeof OwnerLiveDocumentActionPayload>;

const OWNER_LIVE_SHARE_ID = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
export const OwnerLiveRefusal = z.object({
  shareId: OWNER_LIVE_SHARE_ID,
  paths: z.array(SAFE_RELATIVE_PATH).max(100),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1024),
}).strict();
export type OwnerLiveRefusal = z.infer<typeof OwnerLiveRefusal>;
export const ListOwnerLiveRefusalsPayload = WorkspaceIdPayload.extend({after: OWNER_LIVE_SHARE_ID.optional()}).strict();
export type ListOwnerLiveRefusalsPayload = z.infer<typeof ListOwnerLiveRefusalsPayload>;
export const OwnerLiveRefusalsResult = z.object({
  refusals: z.array(OwnerLiveRefusal).max(64),
  nextCursor: OWNER_LIVE_SHARE_ID.nullable(),
}).strict();
export type OwnerLiveRefusalsResult = z.infer<typeof OwnerLiveRefusalsResult>;
export const RetryOwnerLiveSharePayload = WorkspaceIdPayload.extend({shareId: OWNER_LIVE_SHARE_ID}).strict();
export type RetryOwnerLiveSharePayload = z.infer<typeof RetryOwnerLiveSharePayload>;

export const ListWorkspaceFilesPayload = WorkspaceIdPayload.extend({
  // Activity refreshes may reuse main's last complete listing. Every other
  // caller omits this and forces a disk/share walk, so direct mutations and
  // the Explorer's explicit refresh cannot observe a pre-watcher cache.
  allowCached: z.literal(true).optional(),
});
export type ListWorkspaceFilesPayload = z.infer<
  typeof ListWorkspaceFilesPayload
>;

export const WorkspaceFileEntry = z.object({
  path: PATH_STRING,
  kind: z.enum(["file", "database"]),
  // Optional page emoji, read from the file's `icon` frontmatter key. The
  // explorer shows it in place of the generic file glyph. Read-only metadata,
  // bounded on the main side; absent for files without an icon.
  icon: z.string().max(64).optional(),
});
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntry>;

export const ListWorkspaceFilesResult = z.object({
  files: z.array(WorkspaceFileEntry),
  // Directories ride along so empty folders
  // appear in the tree. Optional so older fixtures/consumers keep parsing;
  // the main-side walk always provides it.
  folders: z.array(PATH_STRING).optional(),
  // Hit-only presentation provenance. Absence means this request performed
  // the owned-workspace walk; a cached answer must be revalidated before the
  // renderer uses it as evidence that a path is missing.
  cached: z.literal(true).optional(),
});
export type ListWorkspaceFilesResult = z.infer<typeof ListWorkspaceFilesResult>;

// ---- Collections ----
//
// list/get/query delegate to the engine's collection index through the
// workspace-engine client. Results are the engine's contract shapes from
// @dohc/workspace-contracts/collection, revalidated at this boundary like
// every other result. Values are JSON-shaped plus bigint, which Electron's
// structured clone carries across IPC intact.

// The engine rejects values deeper than MAX_COLLECTION_FIELD_VALUE_DEPTH (24,
// crates/dohc-engine-domain); 32 adds transport headroom and matches
// SDK_PARAMS_MAX_DEPTH and PRESENCE_STATE_MAX_DEPTH.
export const COLLECTION_VALUE_MAX_DEPTH = 32;

// Zod's recursive z.lazy union does not bound depth, so an iterative pre-check
// (mirroring sdkParamsIssue and presenceStateWithinCap) rejects a
// thousands-deep payload before the recursive parse can overflow the stack.
// A cycle keeps incrementing depth on every revisit, so the cap terminates it.
function collectionValueWithinDepth(root: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > COLLECTION_VALUE_MAX_DEPTH) return false;
    if (typeof value !== "object" || value === null) continue;
    const children = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

const CollectionValueNodeSchema: z.ZodType<CollectionValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.bigint(),
    z.string().max(100_000),
    z.array(CollectionValueNodeSchema).max(1_000),
    z.record(z.string().max(500), CollectionValueNodeSchema),
  ]),
);

const CollectionValueSchema: z.ZodType<CollectionValue> = z
  .unknown()
  .superRefine((value, ctx) => {
    if (collectionValueWithinDepth(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `collection value nesting exceeds ${COLLECTION_VALUE_MAX_DEPTH} levels`,
    });
  })
  .pipe(CollectionValueNodeSchema);

const CollectionSchemaReason = z.object({
  code: z.enum(COLLECTION_SCHEMA_REASON_CODES),
  path: z.string().max(4096),
});

// Shared by the summary and the details result: z.ZodType-annotated schemas
// have no .extend, so the shape is the reusable piece.
const collectionSummaryShape = {
  path: PATH_STRING,
  objectId: z.string().min(1).max(256),
  status: z.enum(["valid", "degraded"]),
  reasons: z.array(CollectionSchemaReason).max(MAX_SCHEMA_COLLECTION_ITEMS),
  omittedReasons: z.number().int().nonnegative().optional(),
} as const;

export const CollectionSummarySchema: z.ZodType<CollectionSummaryContract> =
  z.object(collectionSummaryShape);

const COLLECTION_NAME = z.string().min(1).max(200);

const ScalarFieldDefinitionSchema = z.object({
  name: COLLECTION_NAME,
  type: z.enum(["text", "number", "checkbox", "date", "person", "url", "button"]),
});
const SelectFieldDefinitionSchema = z.object({
  name: COLLECTION_NAME,
  type: z.enum(["select", "multi-select"]),
  options: z.array(z.string().max(500)).max(MAX_SCHEMA_COLLECTION_ITEMS),
});
const RelationFieldDefinitionSchema = z.object({
  name: COLLECTION_NAME,
  type: z.literal("relation"),
  collection: PATH_STRING,
  many: z.boolean(),
});
export const CollectionFieldDefinitionSchema: z.ZodType<FieldDefinition> =
  z.union([
    SelectFieldDefinitionSchema,
    RelationFieldDefinitionSchema,
    ScalarFieldDefinitionSchema,
  ]);

const CollectionQuerySortSchema: z.ZodType<CollectionQuerySort> = z.object({
  field: COLLECTION_NAME,
  direction: z.enum(["asc", "desc"]),
});

const CollectionViewDefinitionSchema: z.ZodType<ViewDefinition> = z.object({
  name: COLLECTION_NAME,
  kind: z.enum(["table", "board", "calendar"]),
  groupBy: COLLECTION_NAME.nullable(),
  sort: z.array(CollectionQuerySortSchema).max(20),
  visibleFields: z.array(COLLECTION_NAME).max(MAX_SCHEMA_COLLECTION_ITEMS).nullable(),
  dateField: COLLECTION_NAME.nullable(),
});

export const CollectionSchemaSchema: z.ZodType<CollectionSchemaContract> =
  z.object({
    name: z.string().max(500).nullable(),
    description: z.string().max(5_000).nullable(),
    fields: z.array(CollectionFieldDefinitionSchema).max(MAX_SCHEMA_COLLECTION_ITEMS),
    views: z.array(CollectionViewDefinitionSchema).max(MAX_SCHEMA_COLLECTION_ITEMS),
  });

const CollectionFieldValueReason = z.object({
  code: z.enum(FIELD_VALUE_REASON_CODES),
  path: z.string().max(4096),
});

const CollectionIndexedValueValidation = z.union([
  z.object({ status: z.literal("valid") }),
  z.object({ status: z.literal("flagged"), reason: CollectionFieldValueReason }),
  z.object({ status: z.literal("untyped") }),
]);

const CollectionResolvedRelation = z.object({
  recordId: OPAQUE_ID,
  label: z.string().max(2_000),
});

const CollectionIndexedValueSchema = z.object({
  field: COLLECTION_NAME,
  value: CollectionValueSchema,
  validation: CollectionIndexedValueValidation,
  // The shared schema limit bounds both: a record carries at most one value
  // per schema field, and a relation resolves at most one label per target.
  resolvedRelations: z.array(CollectionResolvedRelation).max(MAX_SCHEMA_COLLECTION_ITEMS),
});

export const CollectionRecordSchema: z.ZodType<CollectionRecord> = z.object({
  id: OPAQUE_ID,
  path: PATH_STRING,
  conflicted: z.boolean(),
  values: z.array(CollectionIndexedValueSchema).max(MAX_SCHEMA_COLLECTION_ITEMS),
});

const CollectionRecordGroupSchema = z.object({
  value: CollectionValueSchema,
  records: z.array(CollectionRecordSchema),
});

const CollectionQueryCursorSchema: z.ZodType<CollectionQueryCursor> = z.object({
  sortValues: z
    .array(z.object({ present: z.boolean(), value: CollectionValueSchema }))
    .max(20),
  recordPath: PATH_STRING,
  recordId: OPAQUE_ID,
});

const CollectionQueryFilterSchema: z.ZodType<CollectionQueryFilter> = z.object({
  field: COLLECTION_NAME,
  operator: z.enum(["equals", "contains"]),
  value: CollectionValueSchema,
});

export const ListCollectionsPayload = WorkspaceIdPayload;
export type ListCollectionsPayload = z.infer<typeof ListCollectionsPayload>;

export const ListCollectionsResult: z.ZodType<CollectionListResultContract> =
  z.object({ collections: z.array(CollectionSummarySchema).max(10_000) });
export type ListCollectionsResult = CollectionListResultContract;

export const GetCollectionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
});
export type GetCollectionPayload = z.infer<typeof GetCollectionPayload>;

export const GetCollectionResult: z.ZodType<CollectionGetResultContract> =
  z.object({
    ...collectionSummaryShape,
    schema: CollectionSchemaSchema,
    recordCount: z.number().int().nonnegative(),
  });
export type GetCollectionResult = CollectionGetResultContract;

export const QueryCollectionRecordsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
  filter: CollectionQueryFilterSchema.optional(),
  sort: z.array(CollectionQuerySortSchema).max(20).optional(),
  groupBy: COLLECTION_NAME.optional(),
  resolveRelations: z.boolean().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
  cursor: CollectionQueryCursorSchema.optional(),
});
export type QueryCollectionRecordsPayload = z.infer<
  typeof QueryCollectionRecordsPayload
>;

export const QueryCollectionRecordsResult: z.ZodType<CollectionQueryResultContract> =
  z.object({
    collection: CollectionSummarySchema,
    records: z.array(CollectionRecordSchema),
    groups: z.array(CollectionRecordGroupSchema).nullable(),
    nextCursor: CollectionQueryCursorSchema.nullable(),
  });
export type QueryCollectionRecordsResult = CollectionQueryResultContract;

export const CreateCollectionRecordPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
  name: z.string().min(1).max(200),
  recordId: z.string().regex(/^rec_[a-z2-7]{26}$/).optional(),
}).strict();
export type CreateCollectionRecordPayload = z.infer<typeof CreateCollectionRecordPayload>;

export const CreateWorkspaceFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  initialText: WORKSPACE_EDITOR_TEXT,
});
export type CreateWorkspaceFilePayload = z.infer<
  typeof CreateWorkspaceFilePayload
>;

export const CreateWorkspaceFileResult = z.object({
  path: PATH_STRING,
});
export type CreateWorkspaceFileResult = z.infer<
  typeof CreateWorkspaceFileResult
>;

// Phase E3 file-management surfaces. Every op mirrors createWorkspaceFile's
// handler shape (assertTrustedSender → parse → requireWorkspace → op →
// result parse) and the workspaceFiles containment sandwich on every path.

export const CreateWorkspaceFolderPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type CreateWorkspaceFolderPayload = z.infer<
  typeof CreateWorkspaceFolderPayload
>;

// rename === move: one engine — F2, inline rename, and drag-drop all call it.
export const MoveWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  fromPath: PATH_STRING,
  toPath: PATH_STRING,
});
export type MoveWorkspacePathPayload = z.infer<typeof MoveWorkspacePathPayload>;

export const DeleteWorkspacePathPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type DeleteWorkspacePathPayload = z.infer<
  typeof DeleteWorkspacePathPayload
>;

// trashed: true = OS trash; false = the .dohc/trash fallback (cross-
// filesystem mounts where g_file_trash rejects), which is recoverable too — or
// a share view, whose delete removes the projection of a moment rather than a
// file the workspace owns. There the change is what can be taken back: the
// granter's copy is untouched until they accept it.
export const DeleteWorkspacePathResult = z.object({
  trashed: z.boolean(),
});
export type DeleteWorkspacePathResult = z.infer<typeof DeleteWorkspacePathResult>;

// relativePath absent = export the whole workspace. The output path comes
// from a MAIN-process save dialog — the renderer never names one. null =
// the user cancelled the dialog.
export const ExportWorkspaceZipPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING.optional(),
});
export type ExportWorkspaceZipPayload = z.infer<typeof ExportWorkspaceZipPayload>;

export const ExportWorkspaceZipResult = z.object({
  path: PATH_STRING.nullable(),
});
export type ExportWorkspaceZipResult = z.infer<typeof ExportWorkspaceZipResult>;

// Document export ("Copy as Markdown" ships purely through the renderer's own
// clipboard call — no IPC needed). Markdown/HTML/PDF export all land through
// this one channel. For `kind: "markdown"` the content is the document's raw
// markdown (frontmatter included), written verbatim to a .md file — the
// text-first export. For HTML/PDF the renderer builds the same self-contained
// HTML (title + rendered body + inline styles, no external assets); main
// either writes it verbatim (`kind: "html"`) or renders it in a hidden
// offscreen window and writes the resulting PDF bytes (`kind: "pdf"`). The
// output path — like ExportWorkspaceZipPayload — comes from a MAIN-process
// save dialog outside the workspace, since export is explicitly
// user-directed; null = cancelled.
const EXPORT_DOCUMENT_SUGGESTED_NAME = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[/\\\0]/.test(value), {
    message: "suggested export name must not contain path separators",
  });

export const ExportDocumentFilePayload = z.object({
  workspaceId: WORKSPACE_ID,
  suggestedName: EXPORT_DOCUMENT_SUGGESTED_NAME,
  // kind "markdown": the raw document markdown, written verbatim.
  // kind "html"/"pdf": the rendered, self-contained HTML document — for a PDF
  // export this is the source main prints, not the output bytes. Bounded
  // generously; a document this large has no business round-tripping through
  // IPC as a single string.
  content: z.string().min(1).max(20 * 1024 * 1024),
  kind: z.enum(["markdown", "html", "pdf"]),
});
export type ExportDocumentFilePayload = z.infer<typeof ExportDocumentFilePayload>;

export const ExportDocumentFileResult = z.object({
  path: PATH_STRING.nullable(),
});
export type ExportDocumentFileResult = z.infer<typeof ExportDocumentFileResult>;

// Explorer context menu: the renderer names what was right-clicked, main
// builds the native Menu from main-owned labels over the closed
// EXPLORER_MENU_COMMANDS tuple and resolves the same invoke
// with the chosen id (null = dismissed). No event channel needed.
export const ShowExplorerMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // Absent for the root (container background) menu.
  path: PATH_STRING.optional(),
  kind: z.enum(["file", "folder", "root"]),
  pinned: z.boolean(),
});
export type ShowExplorerMenuPayload = z.infer<typeof ShowExplorerMenuPayload>;

export const ExplorerMenuCommand = z.enum(EXPLORER_MENU_COMMANDS);
export type ExplorerMenuCommand = z.infer<typeof ExplorerMenuCommand>;

export const ShowExplorerMenuResult = ExplorerMenuCommand.nullable();
export type ShowExplorerMenuResult = z.infer<typeof ShowExplorerMenuResult>;

export const ShowWorkbenchMenuPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // A pinned app's menu names the app's folder as its path.
  context: z.enum(["tab", "editor", "status", "pinned-app"]),
  path: PATH_STRING.optional(),
  groupId: z.string().min(1).max(MAX_EDITOR_GROUP_ID_CHARS).optional(),
  canCloseEditorGroup: z.boolean().optional(),
});
export type ShowWorkbenchMenuPayload = z.infer<typeof ShowWorkbenchMenuPayload>;

export const WorkbenchMenuCommand = z.enum(WORKBENCH_MENU_COMMANDS);
export type WorkbenchMenuCommand = z.infer<typeof WorkbenchMenuCommand>;

export const ShowWorkbenchMenuResult = WorkbenchMenuCommand.nullable();
export type ShowWorkbenchMenuResult = z.infer<typeof ShowWorkbenchMenuResult>;

export const ImportWorkspaceFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // OS drag-in: absolute source paths resolved by the PRELOAD
  // (webUtils.getPathForFile) from a drop event. TRUST DELTA vs the dialog
  // flow: these are renderer-supplied — main re-validates every one through
  // the picker-grade import path (importDroppedPaths: regular files only,
  // never a registered workspace's .dohc) and the count is capped here.
  droppedPaths: z.array(PATH_STRING).max(100).optional(),
  // Destination folder for the import, workspace-relative ("" / absent =
  // root — the empty string is legal here, unlike PATH_STRING). Files land
  // where the user aimed: the folder that was dropped on, or the folder
  // whose context menu ran "Import Files…". Renderer-supplied, so main
  // re-validates it end to end (resolveImportDestination: lexical
  // validation, every component a real non-symlink directory, realpath
  // containment) before any copy.
  targetDir: z.string().max(4096).optional(),
});
export type ImportWorkspaceFilesPayload = z.infer<
  typeof ImportWorkspaceFilesPayload
>;

export const ImportWorkspaceFilesResult = z.object({
  imported: z.array(PATH_STRING),
  // Sources that did not land (invalid basename, screened-out drop source,
  // collision budget exhausted) — surfaced so the import summary can say
  // "2 skipped" instead of the batch silently shrinking.
  skipped: z.number().int().min(0),
  // Some files landed before the import stopped: a copy failed, or the owner
  // lost a trustworthy completion result. This is not an ordinary skip: the
  // Explorer must refresh before the user decides what, if anything, to
  // retry, and importing the same sources again would copy the landed files
  // a second time.
  interrupted: z.literal(true).optional(),
  // An ordinary import stopped at a failed copy: the source file's name, and
  // either the filesystem's error code or a refusal dohc makes itself
  // (`refusal`), with raw text that only goes into copied details.
  stop: z
    .object({
      file: z.string().min(1).max(4096),
      code: z.string().min(1).max(64).optional(),
      detail: z.string().min(1).max(500).optional(),
      refusal: z.enum(["dangling-link"]).optional(),
    })
    .optional(),
});
export type ImportWorkspaceFilesResult = z.infer<
  typeof ImportWorkspaceFilesResult
>;

const OpenWorkspacePayload = z.object({
  workspaceId: WORKSPACE_ID,
});
type OpenWorkspacePayload = z.infer<typeof OpenWorkspacePayload>;

// Preload adds one identity for its renderer document. It is intentionally not
// part of DohcDesktopBridge: renderer code cannot choose or reuse it across a
// reload, while main can distinguish a late invoke from the outgoing document.
export const OpenWorkspaceRequestPayload = OpenWorkspacePayload.extend({
  rendererDocumentId: z.uuid(),
});
export const ReloadRendererRequestPayload = z.object({
  rendererDocumentId: z.uuid(),
});

export const ReadWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceTextPayload = z.infer<typeof ReadWorkspaceTextPayload>;

const WORKSPACE_TEXT_CONTENT_HASH = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "content hash must be a lowercase SHA-256 digest");

export const OpenFileExternallyPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type OpenFileExternallyPayload = z.infer<
  typeof OpenFileExternallyPayload
>;

export const WriteWorkspaceTextPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  // Editor saves are bounded like reads; the handler re-checks UTF-8 bytes.
  text: WORKSPACE_EDITOR_TEXT,
  // SHA-256 of the exact bytes returned by the last complete read. Main uses
  // it for optimistic conflict detection immediately before replacement.
  expectedContentHash: WORKSPACE_TEXT_CONTENT_HASH,
});
export type WriteWorkspaceTextPayload = z.infer<typeof WriteWorkspaceTextPayload>;

// Image bytes pasted/dropped into the editor cross IPC as a raw Uint8Array
// (structured clone). z.custom (not z.instanceof) keeps the inferred type a
// plain `Uint8Array` and enforces the same 20MB bound the main-process writer
// re-checks. Bounded like the text write path so a huge paste can't stream
// unbounded bytes through IPC.
export const WRITE_ASSET_MAX_BYTES = 20 * 1024 * 1024;
const WORKSPACE_ASSET_BYTES = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array &&
    value.byteLength > 0 &&
    value.byteLength <= WRITE_ASSET_MAX_BYTES,
  "Asset bytes are not a Uint8Array within the 20MB write bound.",
);

export const WriteWorkspaceAssetPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  bytes: WORKSPACE_ASSET_BYTES,
});
export type WriteWorkspaceAssetPayload = z.infer<
  typeof WriteWorkspaceAssetPayload
>;

// The `/image` slash command's file picker. A renderer <input type="file">
// cannot be opened at a chosen starting directory (browser security), so the
// picker is a MAIN-process dialog that opens at the workspace ROOT — where a
// user's images actually live. Main reads the chosen files itself (it already
// has fs access), so the whole pick is one round trip: the renderer gets the
// bytes it needs for the existing write+insert path, never learns an absolute
// path, and needs no second read IPC.
export const PickImageFilesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type PickImageFilesPayload = z.infer<typeof PickImageFilesPayload>;

// One picked image: its original basename (never a path — the renderer only
// slugifies it into an asset filename), the media type main resolved from the
// extension, and the bytes under the same 20MB bound the asset write enforces.
// Oversize picks are dropped in main exactly as paste drops them in the
// renderer, so this array only ever carries files that are writable.
const PICKED_IMAGE_NAME = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[/\\\0]/.test(value), {
    message: "picked image name must be a basename, not a path",
  });

export const PickedImageFile = z.object({
  name: PICKED_IMAGE_NAME,
  mediaType: z.string().min(1).max(120),
  bytes: WORKSPACE_ASSET_BYTES,
});
export type PickedImageFile = z.infer<typeof PickedImageFile>;

// A single `/image` invocation is a handful of images, not a photo library:
// bounded so one pick can't stream hundreds of megabytes through IPC.
export const MAX_PICKED_IMAGES = 20;

export const PickImageFilesResult = z.object({
  // Empty = the user cancelled, or every pick was refused as oversize.
  files: z.array(PickedImageFile).max(MAX_PICKED_IMAGES),
});
export type PickImageFilesResult = z.infer<typeof PickImageFilesResult>;

export const ReadWorkspaceTextResult = z.discriminatedUnion("truncated", [
  z.object({
    text: z.string(),
    truncated: z.literal(false),
    contentHash: WORKSPACE_TEXT_CONTENT_HASH,
  }),
  // Capped: text views are for human-scale files; very large files fall back
  // to a download affordance rather than streaming megabytes through IPC.
  z.object({
    text: z.string(),
    truncated: z.literal(true),
    contentHash: z.null(),
  }),
]);
export type ReadWorkspaceTextResult = z.infer<typeof ReadWorkspaceTextResult>;

export const WriteWorkspaceTextResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("written"),
    contentHash: WORKSPACE_TEXT_CONTENT_HASH,
  }),
  z.object({
    status: z.literal("conflict"),
    currentContentHash: WORKSPACE_TEXT_CONTENT_HASH.nullable(),
  }),
]);
export type WriteWorkspaceTextResult = z.infer<typeof WriteWorkspaceTextResult>;

const WorkspaceGraphNodeBase = z.object({
  path: PATH_STRING,
  title: z.string().max(120),
  outgoing: z.number().int().nonnegative(),
  incoming: z.number().int().nonnegative(),
});
const WorkspaceGraphFileNode = WorkspaceGraphNodeBase.extend({
  // Legacy file graphs predate `kind`; accepting its absence keeps the base
  // graph contract compatible while still rejecting chat/heading metadata.
  kind: z.literal("file").optional(),
  filePath: PATH_STRING.optional(),
  threadId: z.never().optional(),
  channelId: z.never().optional(),
  channelWireId: z.never().optional(),
  channelName: z.never().optional(),
  channelSlug: z.never().optional(),
  channelKind: z.never().optional(),
  headingAnchor: z.never().optional(),
}).strict();
const WorkspaceGraphHeadingNode = WorkspaceGraphNodeBase.extend({
  kind: z.literal("heading"),
  filePath: PATH_STRING,
  headingAnchor: z.string().min(1).max(400),
  threadId: z.never().optional(),
  channelId: z.never().optional(),
  channelWireId: z.never().optional(),
  channelName: z.never().optional(),
  channelSlug: z.never().optional(),
  channelKind: z.never().optional(),
}).strict();
const WorkspaceGraphChatThreadNode = WorkspaceGraphNodeBase.extend({
  kind: z.literal("chat-thread"),
  threadId: OPAQUE_ID,
  channelId: OPAQUE_ID.optional(),
  channelWireId: z.string().min(1).max(256).optional(),
  channelName: z.string().min(1).max(100).optional(),
  channelSlug: CHAT_CHANNEL_SLUG.optional(),
  channelKind: z.enum(["channel", "dm", "agent"]).optional(),
  filePath: z.never().optional(),
  headingAnchor: z.never().optional(),
}).strict();
const WorkspaceGraphNode = z.union([
  WorkspaceGraphHeadingNode,
  WorkspaceGraphChatThreadNode,
  WorkspaceGraphFileNode,
]);

const WorkspaceGraphEdge = z.object({
  source: PATH_STRING,
  target: PATH_STRING,
  kind: z.enum([
    "wikilink",
    "markdown",
    "chat-mentions-file",
    "chat-mentions-heading",
    "heading-in-file",
  ]),
});

export const ReadWorkspaceGraphPayload = z.object({
  workspaceId: WORKSPACE_ID,
  includeChatMentions: z.boolean().optional(),
});
export type ReadWorkspaceGraphPayload = z.infer<typeof ReadWorkspaceGraphPayload>;

export const WorkspaceGraphResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult.
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  nodes: z.array(WorkspaceGraphNode).max(2000),
  edges: z.array(WorkspaceGraphEdge).max(10000),
  unresolvedLinks: z.number().int().nonnegative(),
  scannedFileCount: z.number().int().nonnegative(),
  omittedFileCount: z.number().int().nonnegative(),
  truncatedFileCount: z.number().int().nonnegative(),
});
export type WorkspaceGraphResult = z.infer<typeof WorkspaceGraphResult>;

// Backlinks ("Linked mentions"): the open document's inbound links, derived
// read-only in main from the same source graph. `path` is the open file; the
// result lists every other file that links to it with a highlighted snippet per
// mention. Bounds mirror workspaceGraph's MAX_BACKLINK_* caps (kept as literals
// here so this shared contract never imports the main-only fs module).
export const GetBacklinksPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type GetBacklinksPayload = z.infer<typeof GetBacklinksPayload>;

const BacklinkSnippet = z.object({
  // A single source line, trimmed/windowed to ~160 chars (+ ellipses).
  text: z.string().max(400),
  line: z.number().int().positive(),
  // [start, end) of the link within `text`; the UI marks this range.
  highlightStart: z.number().int().nonnegative(),
  highlightEnd: z.number().int().nonnegative(),
});

const BacklinkSource = z.object({
  sourcePath: PATH_STRING,
  sourceTitle: z.string().max(120),
  snippets: z.array(BacklinkSnippet).max(20),
});

export const GetBacklinksResult = z.object({
  sources: z.array(BacklinkSource).max(500),
});
export type GetBacklinksResult = z.infer<typeof GetBacklinksResult>;

export const ListWorkspaceHeadingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListWorkspaceHeadingsPayload = z.infer<
  typeof ListWorkspaceHeadingsPayload
>;

export const WorkspaceHeadingRecord = z.object({
  text: z.string().min(1).max(300),
  level: z.number().int().min(1).max(6),
  anchor: z.string().min(1).max(400),
  occurrence: z.number().int().nonnegative(),
  line: z.number().int().positive(),
});
export type WorkspaceHeadingRecord = z.infer<typeof WorkspaceHeadingRecord>;

export const ListWorkspaceHeadingsResult = z.object({
  headings: z.array(WorkspaceHeadingRecord).max(2000),
});
export type ListWorkspaceHeadingsResult = z.infer<
  typeof ListWorkspaceHeadingsResult
>;

// Visible SQLite: the studio reads a snapshot (tables/columns/bounded rows),
// edits rows in place, and imports a source file into a new database. The
// on-disk .sqlite is canonical; raw bytes never CRDT-sync (edits flow as an
// op log). Identifiers are bounded — IPC payloads are untrusted.
const SQL_IDENT = z.string().min(1).max(256);

const DatabaseColumnView = z.object({
  name: z.string(),
  type: z.string(),
  primaryKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

const DatabaseTableView = z.object({
  name: z.string(),
  columns: z.array(DatabaseColumnView),
  rows: z.array(z.record(z.string(), z.unknown())),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const DatabaseSnapshotResult = z.object({
  path: z.string(),
  tables: z.array(DatabaseTableView),
});
export type DatabaseSnapshotResult = z.infer<typeof DatabaseSnapshotResult>;

export const ReadWorkspaceDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
});
export type ReadWorkspaceDatabasePayload = z.infer<typeof ReadWorkspaceDatabasePayload>;

export const ReadWorkspaceDatabasePagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  table: SQL_IDENT,
  offset: z.number().int().nonnegative(),
});
export type ReadWorkspaceDatabasePagePayload = z.infer<
  typeof ReadWorkspaceDatabasePagePayload
>;

export const DatabasePageResult = z.object({
  path: z.string(),
  table: z.string(),
  offset: z.number().int().nonnegative(),
  rows: z.array(z.record(z.string(), z.unknown())),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type DatabasePageResult = z.infer<typeof DatabasePageResult>;

export const ApplyDatabaseEditPayload = z.object({
  workspaceId: WORKSPACE_ID,
  relativePath: PATH_STRING,
  edit: z.object({
    table: SQL_IDENT,
    op: z.enum(["insert", "update", "upsert", "delete"]),
    pkColumn: SQL_IDENT,
    rowId: z.union([z.string().max(4096), z.number()]),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApplyDatabaseEditPayload = z.infer<typeof ApplyDatabaseEditPayload>;

export const DatabaseEditResult = z.object({
  path: z.string(),
  table: z.string(),
  page: z.object({
    offset: z.number().int().nonnegative(),
    rows: z.array(z.record(z.string(), z.unknown())),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  version: z.number().int().nonnegative(),
});
export type DatabaseEditResult = z.infer<typeof DatabaseEditResult>;

export const ImportToDatabasePayload = z.object({
  workspaceId: WORKSPACE_ID,
  sourceRelativePath: PATH_STRING,
  databaseRelativePath: PATH_STRING,
  tableName: SQL_IDENT,
});
export type ImportToDatabasePayload = z.infer<typeof ImportToDatabasePayload>;

export const ImportToDatabaseResult = z.object({
  path: z.string(),
  tableName: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type ImportToDatabaseResult = z.infer<typeof ImportToDatabaseResult>;

// The renderer cannot import the engine client package, so the list lives
// here and the type check keeps it complete.
const ENGINE_STORE_REFUSALS = [
  "unsupported-fingerprint",
  "foreign-database",
  "migration-failed",
  "migrated-by-newer-build",
] as const satisfies readonly EngineStoreRefusal[];
type AssertNever<T extends never> = T;
type _AllEngineStoreRefusalsRepresented = AssertNever<
  Exclude<EngineStoreRefusal, (typeof ENGINE_STORE_REFUSALS)[number]>
>;

const SYNC_STATUS_BASE_FIELDS = {
  state: z.enum([
    "synced",
    "syncing",
    "local-changes",
    "conflict",
    "sync-failed",
    "cloud-disconnected",
  ]),
  pendingChangeCount: z.number().int().nonnegative(),
  lastSyncedAtMs: z.number().nullable(),
  // How many files conflict, not just that
  // one does. Fed from the sync-engine snapshot in workspaceActivity —
  // optional so older producers/fixtures keep parsing.
  conflictCount: z.number().int().nonnegative().optional(),
  // Sync stopped because the server does not serve this dohc's relay API
  // version: "app" means update dohc, "server" means the server is older.
  updateRequired: z.enum(["app", "server"]).optional(),
  claimingIdentity: z.boolean().optional(),
  // True when the recorder could not be built at workspace open. Required:
  // an omitted boolean reads as false, and a producer that cannot say which
  // cause it means must not compile.
  historyRecordingUnavailable: z.boolean(),
  // True when this workspace is a shared view, fed by the share's pull
  // and never a recorder of its own. A capability, not a failure. Required
  // for the same reason as its neighbour.
  historyShareView: z.boolean(),
  // True when the workspace's drive cannot refuse to replace a file (FAT,
  // exFAT, some network shares), so a save can lose another program's change
  // made at the same moment. Optional, unlike its neighbours: an omitted
  // warning reads as "no warning", which is the safe reading.
  atomicPlacementUnavailable: z.boolean().optional(),
  recoveryUnavailable: z.boolean().optional(),
  keptFiles: z.array(z.tuple([z.string(), z.string()])).optional(),
  // Why the last sync pass failed, present until a pass succeeds. Local work
  // is saved either way. A refused claim waits for Try again; network failures back off.
  syncFailure: z
    .object({
      cause: z.enum(["server-unreachable", "claim-refused", "unknown"]),
      detail: z.string(),
      // When this failure began, and how many passes have failed since.
      sinceMs: z.number(),
      attempts: z.number().int().positive(),
    })
    .optional(),
  // Active describes owner live delivery, not a fully synchronized workspace.
  ownerLiveDelivery: z.enum(["preparing", "active", "retrying"]).optional(),
  ownerLiveDeliveryReason: z.enum(["document-unavailable", "workspace-changed", "restart-required"]).optional(),
  hasOwnerLiveRefusals: z.boolean().optional(),
  // A shared view can have canonical file state that has not yet
  // reached its local folder. The producer bounds each path sample while the
  // counts report the full repair debt.
  shareProjection: z
    .discriminatedUnion("state", [
      z.object({ state: z.literal("current") }),
      z.object({
        state: z.literal("pending"),
        pendingPathCount: z.number().int().nonnegative(),
        pendingPaths: z.array(PATH_STRING),
        collisionPathCount: z.number().int().nonnegative(),
        collisionPaths: z.array(PATH_STRING),
        pullInFlight: z.boolean(),
      }),
    ])
    .optional(),
  // Increments whenever main retires this workspace's live
  // editor sessions. Every renderer re-reads status after an activity ping,
  // so the generation makes every mounted editor release its retired session.
  // Required because workspaceActivity includes it in every status.
  liveSessionsGeneration: z.number().int().nonnegative(),
  // Files that are safe locally but cannot fit in the relay's
  // encoded payload limit. The notice center keeps this visible until a
  // later successful sync no longer reports the path.
  ownerAdmissionPending: z.array(z.object({workspaceId: z.string(), originId: z.string(), originSeq: z.number().int().nonnegative(),
    versionId: z.string(), objectId: z.string(), path: PATH_STRING})).optional(),
  sharingDeclined: z
    .array(
      z.object({
        path: PATH_STRING,
        constraint: z.string().min(1).max(200),
        limitBytes: z.number().int().nonnegative(),
        observedBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
};

export const SyncStatusResult = z.union([
  z.object({
    ...SYNC_STATUS_BASE_FIELDS,
    historyCaptureFailed: z.literal(true),
    // A failed producer must say whether the engine refused the store. Null
    // means history capture failed for another reason.
    engineStoreRefused: z.enum(ENGINE_STORE_REFUSALS).nullable(),
    // The engine's own words for the refusal, when it gave them.
    engineStoreRefusedDetail: z.string().min(1).max(500).optional(),
  }),
  z
    .object({
      ...SYNC_STATUS_BASE_FIELDS,
      historyCaptureFailed: z.literal(false).optional(),
      engineStoreRefused: z.never().optional(),
      engineStoreRefusedDetail: z.never().optional(),
    })
    .superRefine((status, context) => {
      if (Object.hasOwn(status, "engineStoreRefused")) {
        context.addIssue({
          code: "custom",
          path: ["engineStoreRefused"],
          message: "A healthy status must omit the store refusal field.",
        });
      }
    }),
]);
export type SyncStatusResult = z.infer<typeof SyncStatusResult>;

export const ENGINE_STORE_BACKUP_DIR = ".dohc/engine/pre-v2-backup";

export function engineStoreRefusalSentence(cause: EngineStoreRefusal): string {
  switch (cause) {
    case "unsupported-fingerprint":
      return "This workspace's data store is not in the format this version of dohc uses.";
    case "foreign-database":
      return "dohc cannot read this workspace's data store.";
    case "migration-failed":
      return "dohc could not update this workspace's data store to this version.";
    case "migrated-by-newer-build":
      return "A newer version of dohc updated this workspace's data store.";
  }
}

// What the refusal needs. A store from another format, or a file that is not
// a dohc database, is rebuilt from the workspace files. A store this build
// could not migrate, or one a newer build migrated, is intact and waits for a
// build that can open it.
export function engineStoreRefusalRecovery(
  cause: EngineStoreRefusal,
): "rebuild" | "update" {
  switch (cause) {
    case "unsupported-fingerprint":
    case "foreign-database":
      return "rebuild";
    case "migration-failed":
    case "migrated-by-newer-build":
      return "update";
  }
}

export const ENGINE_STORE_UPDATE_NEXT_STEP =
  "Update dohc to continue. Your files are unchanged.";

// The sentence and its next step, for surfaces that show no control.
export function engineStoreRefusalCopy(cause: EngineStoreRefusal): string {
  const next =
    engineStoreRefusalRecovery(cause) === "rebuild"
      ? "Open Notices and choose Rebuild to review recovery options."
      : ENGINE_STORE_UPDATE_NEXT_STEP;
  return `${engineStoreRefusalSentence(cause)} ${next}`;
}

export const RebuildEngineStorePayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type RebuildEngineStorePayload = z.infer<
  typeof RebuildEngineStorePayload
>;

export const RebuildEngineStoreResult = z.object({
  outcome: z.enum(["moved", "backup-exists"]),
  reopenFailed: z.string().min(1).max(2000).optional(),
});
export type RebuildEngineStoreResult = z.infer<typeof RebuildEngineStoreResult>;

// Engine history: the timeline reads engine moments. Every handler is gated
// in main on the workspace's engine capture.

const MOMENT_TEXT = engineStoredText("moment body");

export const EngineMomentRecord = z.object({
  id: OPAQUE_ID,
  versionId: OPAQUE_ID,
  path: PATH_STRING,
  recordedAtMs: z.number(),
  operation: z.enum(["write", "rename", "delete"]),
  origin: z.enum(["api", "local-file", "restore", "sync", "unknown", "ydoc"]),
  // Present only when a dohc-tracked agent run authored the moment; main
  // resolves the configured agent name for local runs.
  agentAuthorName: z.string().min(1).max(500).optional(),
  publicAuthor: z.object({kind: z.literal("public"), principalId: z.string().min(1).max(500), grantId: z.string().min(1).max(500)}).strict().optional(),
  // Present when a Collection automation authored the moment: its name as
  // this computer's automations.yaml has it, and the Collection it belongs to.
  // `collection` is left out once this computer no longer has the automation's Collection.
  automationAuthor: z.object({ name: z.string().min(1).max(4096), collection: z.string().min(1).max(4096).optional() }).strict().optional(),
  // Present when a person the owner shared with wrote the moment directly
  // (ADR 0013): main names them from the owner's share roster. The user id
  // picks them for Stop and restore.
  namedAuthor: z.object({
    userId: z.string().min(1).max(256),
    label: z.string().min(1).max(400),
  }).strict().optional(),
  // Present when an Edit share link wrote the moment directly (ADR 0013).
  // The grant names the link, and the principal the browser session that
  // used it; neither names a person.
  linkAuthor: z.object({
    kind: z.literal("link"),
    grantId: z.string().min(1).max(500),
    grantGeneration: z.number().int().positive(),
    principalId: z.string().min(1).max(500),
  }).strict().optional(),
  summary: z.string().max(500).optional(),
  correlationId: z.string().max(200).optional(),
  // Workspace-global recording order: the pagination cursor and a monotonic
  // refresh key. Real moments always have a nonnegative order.
  momentOrder: z.number().int().nonnegative(),
  // Secret-backed file moment: metadata-only by construction — the
  // row renders with a lock and its diff page shows "Contents are protected".
  protected: z.boolean().optional(),
  contentKind: z.enum(["text", "binary"]).optional(),
  byteLength: z.number().int().nonnegative().optional(),
});
export type EngineMomentRecord = z.infer<typeof EngineMomentRecord>;

export const ListEngineMomentsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  limit: z.number().int().min(1).max(500).optional(),
  beforeMomentOrder: z.number().int().nonnegative().optional(),
});
export type ListEngineMomentsPayload = z.infer<typeof ListEngineMomentsPayload>;

export const ListEngineMomentsResult = z.object({
  moments: z.array(EngineMomentRecord),
  nextBeforeMomentOrder: z.number().int().nonnegative().nullable(),
  // -1 is the store's honest "no moments yet" sentinel for an empty
  // timeline; anything below that is malformed.
  latestMomentOrder: z.number().int().min(-1),
  activeVersionId: OPAQUE_ID,
  protectedTruncated: z.boolean(),
});
export type ListEngineMomentsResult = z.infer<typeof ListEngineMomentsResult>;

// `history.page` can answer that its capture flush is still settling. Main
// classifies that typed daemon refusal before Electron serializes it into a
// generic rejected invoke, then sends this small progress result instead.
const ListEngineMomentsUpdatingResult = z.object({
  status: z.literal("updating"),
});
type ListEngineMomentsUpdatingResult = z.infer<
  typeof ListEngineMomentsUpdatingResult
>;
export const ListEngineMomentsResponse = z.union([
  ListEngineMomentsResult,
  ListEngineMomentsUpdatingResult,
]);
export type ListEngineMomentsResponse = z.infer<
  typeof ListEngineMomentsResponse
>;

export const ReadEngineMomentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  momentId: OPAQUE_ID,
});
export type ReadEngineMomentPayload = z.infer<typeof ReadEngineMomentPayload>;

// One payload side of a moment whose content is binary: presented as bytes
// (byteLength, plus the content hash when the store recorded one) — a binary
// side never serves text.
const ENGINE_MOMENT_BINARY_SIDE = z.object({
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().min(1).max(128).optional(),
});

export const EngineMomentDetailRecord = EngineMomentRecord.omit({
  momentOrder: true,
}).extend({
  // null before-text = the moment created the file OR the before side is
  // binary (then beforeBinary is set); delete moments carry the removed
  // content as beforeText and null afterText. Protected moments are
  // metadata-only: both sides are always null and the page renders
  // "Contents are protected" / "Binary contents" instead of a diff.
  beforeText: MOMENT_TEXT.nullable(),
  afterText: MOMENT_TEXT.nullable(),
  // Per-side content kinds (WS-G1): a text/binary transition moment has one
  // text side and one binary side; each side presents by its own kind.
  beforeBinary: ENGINE_MOMENT_BINARY_SIDE.optional(),
  afterBinary: ENGINE_MOMENT_BINARY_SIDE.optional(),
});
export type EngineMomentDetailRecord = z.infer<typeof EngineMomentDetailRecord>;

export const ReadEngineMomentResult = z.object({
  moment: EngineMomentDetailRecord.nullable(),
});
export type ReadEngineMomentResult = z.infer<typeof ReadEngineMomentResult>;

export const RestoreEngineMomentFilePayload = ReadEngineMomentPayload;
export type RestoreEngineMomentFilePayload = z.infer<
  typeof RestoreEngineMomentFilePayload
>;

export const RestoreEngineMomentFileResult = z.object({
  restored: z.enum(["text", "deleted"]),
  // The forward moment the restore recorded; undoing = restoring to before
  // this moment through the same channel.
  restoredMomentId: OPAQUE_ID,
  path: PATH_STRING,
});
export type RestoreEngineMomentFileResult = z.infer<
  typeof RestoreEngineMomentFileResult
>;

// Linked Chats (PR 0M-5): per-file Chats stored in
// the engine, linked to the file's stable engine object id so the link
// survives renames. The renderer never supplies identity — main derives the
// author for every sent message.
const CHAT_BODY = z.string().min(1).max(65_536);
const CHAT_HEADING_TEXT = z.string().trim().min(1).max(300);
const CHAT_HEADING_ANCHOR = z.string().trim().min(1).max(400);

export const ChatThreadRecord = z.object({
  id: OPAQUE_ID,
  title: z.string().min(1).max(200),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type ChatThreadRecord = z.infer<typeof ChatThreadRecord>;

export const ChatAttachmentRecord = z.object({
  attachmentId: OPAQUE_ID,
  threadId: OPAQUE_ID,
  messageId: OPAQUE_ID,
  targetKind: z.literal("file"),
  objectId: OPAQUE_ID.optional(),
  pathHint: PATH_STRING.optional(),
  headingText: CHAT_HEADING_TEXT.optional(),
  headingAnchor: CHAT_HEADING_ANCHOR.optional(),
  headingOccurrence: z.number().int().nonnegative().optional(),
  createdAtMs: z.number(),
}).superRefine((attachment, ctx) => {
  if (attachment.headingOccurrence !== undefined && !attachment.headingAnchor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["headingOccurrence"],
      message: "heading occurrence requires a heading anchor",
    });
  }
});
export type ChatAttachmentRecord = z.infer<typeof ChatAttachmentRecord>;

// Renderer references paths/headings; main resolves them to stable engine
// object ids and validates the heading against the current canonical file.
// Identity and authorization never cross this renderer boundary.
export const ChatFileReferenceInput = z.object({
  path: PATH_STRING,
  headingAnchor: CHAT_HEADING_ANCHOR.optional(),
  headingOccurrence: z.number().int().nonnegative().optional(),
}).superRefine((reference, ctx) => {
  if (reference.headingOccurrence !== undefined && !reference.headingAnchor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["headingOccurrence"],
      message: "heading occurrence requires a heading anchor",
    });
  }
});
export type ChatFileReferenceInput = z.infer<typeof ChatFileReferenceInput>;

// Messages and their authors as the renderer shows them. Only the automation
// executor in main writes an automation's message; the renderer never sends one.
const CHAT_MESSAGE_AUTHOR_KIND = z.enum(["human", "agent", "automation"]);
// Which automation wrote a message, when it ran on this computer, and
// where its Collection is now: null once this computer no longer has it.
const CHAT_MESSAGE_AUTOMATION = z.object({
  automationId: z.string().min(1).max(1024),
  collectionPath: SAFE_RELATIVE_PATH.nullable(),
});

export const ChatMessageRecord = z.object({
  id: OPAQUE_ID,
  threadId: OPAQUE_ID,
  authorKind: CHAT_MESSAGE_AUTHOR_KIND,
  authorDisplayName: z.string().min(1).max(200),
  authorOwnerDisplayName: z.string().min(1).max(200).optional(),
  authorUserId: z.string().min(1).max(256).optional(),
  parentMessageId: OPAQUE_ID.optional(),
  origin: z.literal("cli").optional(),
  body: CHAT_BODY,
  createdAtMs: z.number(),
  automation: CHAT_MESSAGE_AUTOMATION.optional(),
  // Optional on the wire so pre-phase-4 fixture objects and stored messages
  // remain compatible. Main includes the engine's authoritative array.
  attachments: z.array(ChatAttachmentRecord).optional(),
});
export type ChatMessageRecord = z.infer<typeof ChatMessageRecord>;

export const ListChatFileMentionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListChatFileMentionsPayload = z.infer<
  typeof ListChatFileMentionsPayload
>;

export const ChatFileMentionRecord = z.object({
  attachment: ChatAttachmentRecord,
  message: ChatMessageRecord,
  thread: ChatThreadRecord,
  channelId: OPAQUE_ID.optional(),
  channelWireId: z.string().min(1).max(256).optional(),
  channelName: z.string().min(1).max(100).optional(),
  channelSlug: CHAT_CHANNEL_SLUG.optional(),
  channelKind: z.enum(["channel", "dm", "agent"]).optional(),
});
export type ChatFileMentionRecord = z.infer<typeof ChatFileMentionRecord>;

export const ListChatFileMentionsResult = z.object({
  // These responses are built from the local store after one bounded
  // shared-channel sync pass. This is how many joined rows that pass did not
  // leave fresh — the ones its window never reached, plus the ones it reached
  // and could not sync (offline, relay hiccup). A pass that died outright, or
  // never ran because the account is signed out, reports every live row.
  // Absent means the pass that ran left no row behind, which is the only claim
  // of full freshness this field ever makes.
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  mentions: z.array(ChatFileMentionRecord).max(2000),
});
export type ListChatFileMentionsResult = z.infer<
  typeof ListChatFileMentionsResult
>;

const CHAT_BOOKMARK_RECORD_BASE = z.object({
  bookmarkId: OPAQUE_ID,
  mode: z.enum(["live", "snapshot"]),
  destinationPath: PATH_STRING,
  state: z.enum(["active", "archived"]),
  projectionState: z.enum(["pending", "ready", "failed", "stale"]),
  generation: z.number().int().nonnegative(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export const ChatBookmarkRecord = z
  .discriminatedUnion("targetKind", [
    CHAT_BOOKMARK_RECORD_BASE.extend({
      targetKind: z.literal("thread"),
      targetId: OPAQUE_ID,
      threadId: OPAQUE_ID,
      messageId: z.undefined().optional(),
    }),
    CHAT_BOOKMARK_RECORD_BASE.extend({
      targetKind: z.literal("message"),
      targetId: OPAQUE_ID,
      threadId: OPAQUE_ID,
      messageId: OPAQUE_ID,
    }),
  ])
  .superRefine((bookmark, ctx) => {
    const canonicalTargetId =
      bookmark.targetKind === "thread" ? bookmark.threadId : bookmark.messageId;
    if (bookmark.targetId !== canonicalTargetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: `bookmark targetId must match its ${bookmark.targetKind} id`,
      });
    }
  });
export type ChatBookmarkRecord = z.infer<typeof ChatBookmarkRecord>;

export const ListChatBookmarksPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ListChatBookmarksPayload = z.infer<typeof ListChatBookmarksPayload>;
export const ListChatBookmarksResult = z.object({
  bookmarks: z.array(ChatBookmarkRecord).max(5000),
});
export type ListChatBookmarksResult = z.infer<typeof ListChatBookmarksResult>;

export const SaveChatBookmarkPayload = z.object({
  workspaceId: WORKSPACE_ID,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), threadId: OPAQUE_ID }),
    z.object({
      kind: z.literal("message"),
      threadId: OPAQUE_ID,
      messageId: OPAQUE_ID,
    }),
  ]),
  mode: z.enum(["live", "snapshot"]).default("live"),
});
export type SaveChatBookmarkPayload = z.infer<typeof SaveChatBookmarkPayload>;
export const SaveChatBookmarkResult = z.object({ bookmark: ChatBookmarkRecord });
export type SaveChatBookmarkResult = z.infer<typeof SaveChatBookmarkResult>;

export const ArchiveChatBookmarkPayload = z.object({
  workspaceId: WORKSPACE_ID,
  bookmarkId: OPAQUE_ID,
});
export type ArchiveChatBookmarkPayload = z.infer<typeof ArchiveChatBookmarkPayload>;
export const ArchiveChatBookmarkResult = z.object({ bookmark: ChatBookmarkRecord });
export type ArchiveChatBookmarkResult = z.infer<typeof ArchiveChatBookmarkResult>;

export const ListFileChatsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListFileChatsPayload = z.infer<typeof ListFileChatsPayload>;

export const ListFileChatsResult = z.object({
  // null when the engine does not own the file (yet) — the rail explains
  // rather than failing.
  fileObjectId: OPAQUE_ID.nullable(),
  threads: z.array(ChatThreadRecord),
});
export type ListFileChatsResult = z.infer<typeof ListFileChatsResult>;

// Main classifies the daemon's typed refusal before Electron turns a rejected
// invoke into a message-only Error. The renderer receives this closed result,
// so retry behavior never depends on user-facing daemon copy.
export const ListFileChatsResponse = z.union([
  ListFileChatsResult,
  z
    .object({
      status: z.literal("refused"),
      code: z.literal("workspace-updating"),
    })
    .strict(),
]);
export type ListFileChatsResponse = z.infer<typeof ListFileChatsResponse>;

export const CreateFileChatPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
  title: z.string().min(1).max(200),
});
export type CreateFileChatPayload = z.infer<typeof CreateFileChatPayload>;

export const CreateFileChatResult = z.object({
  thread: ChatThreadRecord,
});
export type CreateFileChatResult = z.infer<typeof CreateFileChatResult>;

export const ListChatMessagesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type ListChatMessagesPayload = z.infer<typeof ListChatMessagesPayload>;

export const ListChatMessagesResult = z.object({
  messages: z.array(ChatMessageRecord),
});
export type ListChatMessagesResult = z.infer<typeof ListChatMessagesResult>;

export const GetChatThreadRevisionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type GetChatThreadRevisionPayload = z.infer<
  typeof GetChatThreadRevisionPayload
>;

export const GetChatThreadRevisionResult = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type GetChatThreadRevisionResult = z.infer<
  typeof GetChatThreadRevisionResult
>;

export const SendChatMessagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
  parentMessageId: OPAQUE_ID.optional(),
  body: CHAT_BODY,
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type SendChatMessagePayload = z.infer<typeof SendChatMessagePayload>;

export const SendChatMessageResult = z.object({
  message: ChatMessageRecord,
});
export type SendChatMessageResult = z.infer<typeof SendChatMessageResult>;

export const ChatDecisionRecord = z.object({
  threadId: OPAQUE_ID,
  messageId: OPAQUE_ID,
  state: z.enum(["open", "resolved"]),
  resolvedByMessageId: OPAQUE_ID.optional(),
  atMs: z.number(),
  // A poll's choices, in order. Absent for a bare question.
  options: z.array(z.string().min(1).max(200)).max(12).optional(),
  chosenOption: z.string().min(1).max(200).optional(),
});
export type ChatDecisionRecord = z.infer<typeof ChatDecisionRecord>;

export const ListChatThreadDecisionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type ListChatThreadDecisionsPayload = z.infer<
  typeof ListChatThreadDecisionsPayload
>;

export const ListChatThreadDecisionsResult = z.object({
  decisions: z.array(ChatDecisionRecord),
});
export type ListChatThreadDecisionsResult = z.infer<
  typeof ListChatThreadDecisionsResult
>;

export const ResolveChatDecisionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
  messageId: OPAQUE_ID,
  resolvedByMessageId: OPAQUE_ID,
  chosenOption: z.string().min(1).max(200).optional(),
});
export type ResolveChatDecisionPayload = z.infer<
  typeof ResolveChatDecisionPayload
>;

export const ResolveChatDecisionResult = z.object({
  decision: ChatDecisionRecord,
});
export type ResolveChatDecisionResult = z.infer<
  typeof ResolveChatDecisionResult
>;

export const ListChatThreadAttachmentsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type ListChatThreadAttachmentsPayload = z.infer<
  typeof ListChatThreadAttachmentsPayload
>;

export const ListChatThreadAttachmentsResult = z.object({
  attachments: z.array(ChatAttachmentRecord),
});
export type ListChatThreadAttachmentsResult = z.infer<
  typeof ListChatThreadAttachmentsResult
>;

export const ChatRunRecord = z.object({
  runId: OPAQUE_ID,
  threadId: OPAQUE_ID,
  triggerMessageId: OPAQUE_ID,
  command: z.string().min(1),
  startedAtMs: z.number(),
  endedAtMs: z.number().optional(),
  exitCode: z.number().int().optional(),
  logPath: PATH_STRING.optional(),
});
export type ChatRunRecord = z.infer<typeof ChatRunRecord>;

export const ChatRunRecordsForThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type ChatRunRecordsForThreadPayload = z.infer<
  typeof ChatRunRecordsForThreadPayload
>;

export const ChatRunRecordsForThreadResult = z.object({
  runs: z.record(z.string(), ChatRunRecord).describe(
    "Run records linked to messages from the thread's 200 most recent runs, newest first.",
  ),
});
export type ChatRunRecordsForThreadResult = z.infer<
  typeof ChatRunRecordsForThreadResult
>;

// Reactions (WS-MU-C2). A reaction is durable, commutative chat data — an
// emoji reaction by an author on a message. The renderer never supplies
// identity: main derives the reactor from the local user, exactly like a sent
// message. Emojis are short graphemes, never message bodies.
//
// This schema is the TRUST BOUNDARY for chat.reaction.set payloads — including
// future replicated writes from other peers per the PR's forward-compat design.
// A length bound alone accepts URLs, profanity, and arbitrary ASCII text as an
// "emoji"; a hostile/buggy peer could inject those to render as reaction pills.
// So we validate the actual codepoints: a single emoji grapheme cluster — one
// pictographic (with optional variation selector / skin-tone modifier /
// keycap), a regional-indicator pair (flag), and ZWJ sequences thereof.
//
// Unicode property escapes (\p{…}) with the `u` flag are ES2018 and supported by
// every Node/Electron runtime this repo targets (tsconfig `target`/`lib` are
// ES2022), so `\p{Extended_Pictographic}` is safe here.
const EMOJI_ATOM =
  "(?:[#*0-9]\\uFE0F?\\u20E3|\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}|\\p{Regional_Indicator}\\p{Regional_Indicator}|\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F\\u20E3]*)";
const EMOJI_GRAPHEME_PATTERN = new RegExp(
  `^${EMOJI_ATOM}(?:\\u200D${EMOJI_ATOM})*$`,
  "u",
);
const CHAT_EMOJI = z
  .string()
  .min(1)
  .max(32)
  .regex(EMOJI_GRAPHEME_PATTERN, "must be a single emoji grapheme");

// One active reaction as the renderer paints it. The UI groups these by
// (messageId, emoji) into pills; `authorId` lets it mark the viewer's own.
export const ChatReactionRecord = z.object({
  reactionId: OPAQUE_ID,
  messageId: OPAQUE_ID,
  threadId: OPAQUE_ID,
  emoji: CHAT_EMOJI,
  authorId: OPAQUE_ID,
  authorKind: z.enum(["human", "agent"]),
  authorDisplayName: z.string().min(1).max(200),
});
export type ChatReactionRecord = z.infer<typeof ChatReactionRecord>;

// Chats channels (PR 12/13, WS-E): workspace-wide Chats organized in
// channels, plus per-thread monotonic read cursors. Same gate as the file
// rail: every handler needs the workspace's engine capture.
const CHAT_CHANNEL_NAME_MAX = 80;

export const ChatChannelRecord = z.object({
  id: OPAQUE_ID,
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  slug: CHAT_CHANNEL_SLUG,
  kind: z.enum(["channel", "dm", "agent"]),
  // What the group holds and why it exists. Older fixtures omit them.
  type: z.enum(["posts", "chat", "both"]).optional(),
  purpose: z.string().max(200).optional(),
  folderPath: PATH_STRING.optional(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  threadCount: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
  // MU-C4: the channel's cross-machine wire identity — what shared-channel
  // grants key on. Absent/null for channels with no recorded wire mapping.
  wireId: z.string().min(1).max(256).nullable().optional(),
});
export type ChatChannelRecord = z.infer<typeof ChatChannelRecord>;

export const ChannelThreadRecord = ChatThreadRecord.extend({
  channelId: OPAQUE_ID,
  messageCount: z.number().int().min(0),
  lastReadSequence: z.number().int().min(0),
  unreadCount: z.number().int().min(0),
  // Main always supplies the engine-derived count. Optionality keeps older
  // renderer fixtures and pre-phase-4 bridge consumers source-compatible.
  openDecisionCount: z.number().int().min(0).optional(),
  // Feed-only opening-message data. Optional + nullable keeps older bridge
  // fixtures compatible while allowing an empty/corrupt legacy thread to be
  // represented without fabricating a message.
  openingMessage: z
    .object({
      id: OPAQUE_ID,
      authorKind: CHAT_MESSAGE_AUTHOR_KIND,
      authorDisplayName: z.string().min(1).max(200),
      authorOwnerDisplayName: z.string().min(1).max(200).optional(),
      authorUserId: z.string().min(1).max(256).optional(),
      createdAtMs: z.number(),
      bodySnippet: z.string().min(1).max(500),
      automation: CHAT_MESSAGE_AUTOMATION.optional(),
      reactions: z.array(ChatReactionRecord),
    })
    .nullable()
    .optional(),
});
export type ChannelThreadRecord = z.infer<typeof ChannelThreadRecord>;

// A file-linked Chat as the Chats view lists it: the current path when the
// engine can resolve the stable object id, else the captured hint.
export const FileChatThreadRecord = ChatThreadRecord.extend({
  path: PATH_STRING.nullable(),
});
export type FileChatThreadRecord = z.infer<typeof FileChatThreadRecord>;

export const ListChatChannelsPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListChatChannelsPayload = z.infer<typeof ListChatChannelsPayload>;

export const ListChatChannelsResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult.
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  channels: z.array(ChatChannelRecord),
  // The "Files" grouping: file-linked Chats listed read-only beside the
  // channels (they live in the file rail; the Chats view cross-links).
  fileThreads: z.array(FileChatThreadRecord),
});
export type ListChatChannelsResult = z.infer<typeof ListChatChannelsResult>;

const CHAT_FOLLOW_TARGET_KIND = z.enum(["person", "agent", "channel", "thread"]);
const CHAT_FOLLOW_STATE = z.enum(["following", "unfollowed"]);

const ChatFollowRecord = z.object({
  targetKind: CHAT_FOLLOW_TARGET_KIND,
  targetId: z.string().min(1).max(300),
  state: CHAT_FOLLOW_STATE,
  updatedAtMs: z.number(),
});
type ChatFollowRecord = z.infer<typeof ChatFollowRecord>;

export const ListChatFollowsPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ListChatFollowsPayload = z.infer<typeof ListChatFollowsPayload>;
export const ListChatFollowsResult = z.object({
  follows: z.array(ChatFollowRecord).max(5000),
});
export type ListChatFollowsResult = z.infer<typeof ListChatFollowsResult>;

export const SetChatFollowPayload = z.object({
  workspaceId: WORKSPACE_ID,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("channel"), channelId: OPAQUE_ID }),
    z.object({ kind: z.literal("thread"), threadId: OPAQUE_ID }),
    z.object({
      kind: z.literal("author"),
      threadId: OPAQUE_ID,
      messageId: OPAQUE_ID,
    }),
  ]),
  state: CHAT_FOLLOW_STATE,
});
export type SetChatFollowPayload = z.infer<typeof SetChatFollowPayload>;
export const SetChatFollowResult = z.object({ follow: ChatFollowRecord });
export type SetChatFollowResult = z.infer<typeof SetChatFollowResult>;

const ChatFeedChannelRecord = z.object({
  id: OPAQUE_ID,
  wireId: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  slug: CHAT_CHANNEL_SLUG,
  kind: z.enum(["channel", "dm", "agent"]),
});

export const ChatFeedItemRecord = z.object({
  message: ChatMessageRecord,
  thread: ChatThreadRecord,
  channel: ChatFeedChannelRecord.optional(),
  // Opaque, relay-verified identity used only to correlate persisted follow
  // state across this author's posts. It is never an email/display name.
  authorFollowTarget: z
    .object({
      targetKind: z.enum(["person", "agent"]),
      targetId: z.string().min(1).max(300),
    })
    .optional(),
  parentMessage: ChatMessageRecord.optional(),
  openingMessage: ChatMessageRecord.optional(),
  reactions: z.array(ChatReactionRecord),
  // Who the viewer is in this item's thread: the grant's account in a joined
  // channel, the owner elsewhere. The reactions are normalized to it, the
  // way listChatReactions does. Optional for older fixtures.
  viewerAuthorId: OPAQUE_ID.optional(),
  matchedBy: z.array(CHAT_FOLLOW_TARGET_KIND).max(4),
});
export type ChatFeedItemRecord = z.infer<typeof ChatFeedItemRecord>;

export const ListPersonalChatFeedPayload = z.object({
  workspaceId: WORKSPACE_ID,
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type ListPersonalChatFeedPayload = z.infer<typeof ListPersonalChatFeedPayload>;
export const ListPersonalChatFeedResult = z.object({
  // Partial-freshness marker; see ListChatFileMentionsResult.
  sharedChannelRowsUncovered: z.number().int().positive().optional(),
  items: z.array(ChatFeedItemRecord).max(50),
  nextCursor: z.string().max(1000).optional(),
  headCursor: z.string().max(1000).optional(),
});
export type ListPersonalChatFeedResult = z.infer<
  typeof ListPersonalChatFeedResult
>;

export const MarkPersonalChatFeedSeenPayload = z.object({
  workspaceId: WORKSPACE_ID,
  headCursor: z.string().min(1).max(1000),
});
export type MarkPersonalChatFeedSeenPayload = z.infer<
  typeof MarkPersonalChatFeedSeenPayload
>;

export const CreateChatChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  type: z.enum(["posts", "chat", "both"]).optional(),
  purpose: z.string().max(200).optional(),
  // The group's folder. When absent main derives it from the name.
  folderPath: PATH_STRING.optional(),
});
export type CreateChatChannelPayload = z.infer<typeof CreateChatChannelPayload>;

export const CreateChatChannelResult = z.object({
  channel: ChatChannelRecord,
});
export type CreateChatChannelResult = z.infer<typeof CreateChatChannelResult>;

export const ListChannelThreadsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: OPAQUE_ID,
  // The posts lane unless named.
  lane: z.enum(["posts", "chat"]).optional(),
});
export type ListChannelThreadsPayload = z.infer<typeof ListChannelThreadsPayload>;

export const ListChannelThreadsResult = z.object({
  threads: z.array(ChannelThreadRecord),
  // Main-derived, shared by every opening-message reaction summary in this
  // response. Optional for older callers/fixtures; main always supplies it.
  viewerAuthorId: OPAQUE_ID.optional(),
});
export type ListChannelThreadsResult = z.infer<typeof ListChannelThreadsResult>;

// The fast composer: body only, NO title. Untitled threads display their
// first-message snippet (the anti-forum rule) — main never asks for a title.
export const StartChannelThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: OPAQUE_ID,
  body: CHAT_BODY,
  lane: z.enum(["posts", "chat"]).optional(),
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type StartChannelThreadPayload = z.infer<typeof StartChannelThreadPayload>;

export const StartChannelThreadResult = z.object({
  thread: ChannelThreadRecord,
  message: ChatMessageRecord,
  // Main derives this from the author identity used for the opening message.
  viewerAuthorId: OPAQUE_ID,
});
export type StartChannelThreadResult = z.infer<typeof StartChannelThreadResult>;

export const MarkChatThreadReadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
  // Monotonic: the store clamps to the thread's message count and never
  // moves the cursor backwards; the revision is server-owned.
  upToSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type MarkChatThreadReadPayload = z.infer<typeof MarkChatThreadReadPayload>;

export const MarkChatThreadReadResult = z.object({
  lastReadSequence: z.number().int().min(0),
  revision: z.number().int().min(0),
});
export type MarkChatThreadReadResult = z.infer<typeof MarkChatThreadReadResult>;

export const ListChatReactionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
});
export type ListChatReactionsPayload = z.infer<typeof ListChatReactionsPayload>;

export const ListChatReactionsResult = z.object({
  reactions: z.array(ChatReactionRecord),
  // The viewer's own reactor id (main-derived), so the renderer can highlight
  // "your" reactions and toggle them without ever learning another identity.
  viewerAuthorId: OPAQUE_ID,
});
export type ListChatReactionsResult = z.infer<typeof ListChatReactionsResult>;

export const SetChatReactionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
  messageId: OPAQUE_ID,
  emoji: CHAT_EMOJI,
  // add or remove your reaction. The store is a set-membership CRDT: this is
  // the observed cell state, resolved by LWW-per-cell.
  state: z.enum(["added", "removed"]),
});
export type SetChatReactionPayload = z.infer<typeof SetChatReactionPayload>;

export const SetChatReactionResult = z.object({
  reaction: ChatReactionRecord.extend({ state: z.enum(["added", "removed"]) }),
  viewerAuthorId: OPAQUE_ID,
});
export type SetChatReactionResult = z.infer<typeof SetChatReactionResult>;

const EMAIL_STRING = z.email().max(320);

// Direct messages (WS-MU-C3). A DM is a `kind:"dm"` channel plus one MU-C4
// chat grant per participant, riding the shared-channel lane. The
// whole surface is gated on collaboration (signed in + relay): a solo user
// sees none of it. Identity is always main-derived — the renderer never
// supplies who is sending or who a grant belongs to.
export const DmRecord = z.object({
  channelId: OPAQUE_ID,
  channelWireId: z.string().min(1).max(256),
  name: z.string().min(1).max(CHAT_CHANNEL_NAME_MAX),
  // What this viewer calls the DM: the owner sees the recipients they
  // addressed; a participant sees the granter (the replicated channel name
  // is the owner's recipient list — often the participant's own address).
  peerLabel: z.string().min(1).max(320),
  role: z.enum(["owner", "participant"]),
  // The chat grant a PARTICIPANT joined this DM through — the presence
  // SHARE scope both sides converge on (the relay maps it to the granter's
  // workspace, where the owner publishes). Null for the OWNER (who publishes
  // into their own workspace scope) and until a participant's grant registers.
  shareId: OPAQUE_ID.nullable(),
  // The single running conversation (the anti-forum rule). Null only in the
  // brief window before the creator's first message replicates.
  threadId: OPAQUE_ID.nullable(),
  unreadCount: z.number().int().min(0),
  // False for a participant whose grant ended: already-replayed messages
  // stay readable, sending is closed.
  connected: z.boolean(),
});
export type DmRecord = z.infer<typeof DmRecord>;

export const DmRequestRow = z.object({
  shareId: OPAQUE_ID,
  granterEmail: EMAIL_STRING.nullable(),
});
export type DmRequestRow = z.infer<typeof DmRequestRow>;

export const SyncDmsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The DM the caller is reading, when it is reading one. The shared-channel
  // pass is bounded, so a poll that names its open conversation keeps that one
  // fresh instead of waiting for the rotation to reach it.
  openChannelId: OPAQUE_ID.optional(),
  // True for the renderer's own scheduled refreshes: the list and conversation
  // timers, and the first refresh when Chats or a conversation opens. Main
  // pulls this workspace's own relay log for these, where members' replies to
  // owned DMs and Groups land. A refresh that reacts to a workspace activity
  // event leaves it unset, because the pull's own events would refresh again.
  poll: z.boolean().optional(),
});
export type SyncDmsPayload = z.infer<typeof SyncDmsPayload>;

export const SyncDmsResult = z.object({
  // False when signed out / no relay: the renderer hides the whole DM
  // surface (solo zero-bloat).
  available: z.boolean(),
  dms: z.array(DmRecord),
  pending: z.array(DmRequestRow),
  declined: z.array(DmRequestRow),
  // True when the request listing or the shared-channel pass failed as a
  // whole. One failing share does not count. The renderer holds the syncs
  // nobody asked for instead of trying again at once.
  failed: z.boolean(),
});
export type SyncDmsResult = z.infer<typeof SyncDmsResult>;

export const AcceptDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: OPAQUE_ID,
});
export type AcceptDmPayload = z.infer<typeof AcceptDmPayload>;

export const AcceptDmResult = z.object({ dm: DmRecord });
export type AcceptDmResult = z.infer<typeof AcceptDmResult>;

export const DeclineDmPayload = z.object({ shareId: OPAQUE_ID });
export type DeclineDmPayload = z.infer<typeof DeclineDmPayload>;

export const RequestDmAgainPayload = z.object({ shareId: OPAQUE_ID });
export type RequestDmAgainPayload = z.infer<typeof RequestDmAgainPayload>;

// A participant's reverse path for where an accepted DM lives: ends
// the same JoinedSharedChannel row leaveSharedChannel ends, keyed by DM
// shareId. The owner side has no shareId (DmRecord.shareId is null for the
// owner) and never calls this.
export const LeaveDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: OPAQUE_ID,
});
export type LeaveDmPayload = z.infer<typeof LeaveDmPayload>;

export const StartDmPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // One or more recipient emails ("a@x.com, b@y.com") — parsed/validated in
  // main; grants are addressed per recipient.
  recipients: z.string().min(3).max(2000),
  body: CHAT_BODY,
  fileReferences: z.array(ChatFileReferenceInput).max(20).optional(),
});
export type StartDmPayload = z.infer<typeof StartDmPayload>;

export const StartDmResult = z.object({
  dm: DmRecord,
  message: ChatMessageRecord,
});
export type StartDmResult = z.infer<typeof StartDmResult>;

// Ephemeral presence (MU-C1 / MU-C5). The renderer's presence transport is
// IPC-PROXIED so the relay bearer token never reaches the renderer: main holds
// cachedCredentials.token and makes the actual relay presence request. These
// payloads carry only the scope, an opaque display state, and the long-poll
// bookkeeping. The scope is authorized in MAIN (the caller's own workspace, or
// a share they hold a grant for) before the relay — which re-authorizes from
// the bearer independently.
export const PresenceScopeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: WORKSPACE_ID }),
  z.object({
    kind: z.literal("share"),
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
  }),
]);
export type PresenceScopeInput = z.infer<typeof PresenceScopeInput>;

// Bounds mirror the relay's presence parser (MAX_PRESENCE_TOPIC_CHARS /
// MAX_CLIENT_ID_CHARS): reject early rather than round-trip an over-long value.
const PRESENCE_TOPIC = z.string().min(1).max(1024);
const PRESENCE_CLIENT_ID = z.string().min(1).max(128);
const PRESENCE_INCARNATION_ID = z.uuid();
const PRESENCE_POLL_ID = z.string().min(1).max(128);

// Cap the opaque presence state at the IPC boundary, mirroring the relay's
// MAX_PRESENCE_STATE_BYTES (services/sync-relay). Presence carries small display
// data ({ displayName, typing }); bounding it here stops a renderer from forcing
// main to JSON.stringify an attacker-sized (or cyclic / non-JSON) payload before
// the relay's own cap applies.
export const PRESENCE_STATE_MAX_BYTES = 8 * 1024;
const PRESENCE_STATE_MAX_DEPTH = 32;

// A cheap, short-circuiting size guard: it walks the already-deserialized value
// accumulating an UPPER BOUND on the serialized UTF-8 byte size and bails the
// moment it exceeds the cap — so an oversized payload is rejected without a full
// JSON.stringify. Returns false for cycles, over-depth nesting, and non-JSON
// values (bigint), which the relay would reject or main would throw on anyway.
// Printable ASCII minus `"` and `\` — characters JSON serializes verbatim.
const SAFE_JSON_STRING_CHARS = /^[ !#-\[\]-~]*$/;

export function presenceStateWithinCap(
  value: unknown,
  maxBytes: number = PRESENCE_STATE_MAX_BYTES,
): boolean {
  let budget = maxBytes;
  const seen = new Set<object>();
  const spend = (n: number): boolean => {
    budget -= n;
    return budget >= 0;
  };
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > PRESENCE_STATE_MAX_DEPTH) return false;
    if (v === null) return spend(4); // "null"
    switch (typeof v) {
      case "boolean":
        return spend(5); // up to "false"
      case "number":
        return spend(v && Number.isFinite(v) ? 24 : 4); // non-finite → "null"
      case "string":
        // Every JSON string costs at least its quotes plus one byte per
        // UTF-16 code unit — charge that floor first so a huge string still
        // bails without being scanned. Safe printable ASCII (the base64
        // awareness update) serializes at exactly the floor; anything else
        // may need a "\uXXXX" escape or multi-byte UTF-8, and 6 bytes per
        // code unit covers the worst case.
        if (!spend(2 + v.length)) return false;
        return SAFE_JSON_STRING_CHARS.test(v) || spend(v.length * 5);
      case "object": {
        const obj = v as object;
        if (seen.has(obj)) return false; // cycle → reject as over-cap
        seen.add(obj);
        try {
          if (Array.isArray(v)) {
            if (!spend(2)) return false; // []
            for (const item of v) {
              if (!spend(1)) return false; // element separator
              if (!walk(item, depth + 1)) return false;
            }
            return true;
          }
          if (!spend(2)) return false; // {}
          for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
            if (item === undefined) continue; // omitted by JSON.stringify
            if (!spend(4 + key.length * 6)) return false; // "key": plus separator
            if (!walk(item, depth + 1)) return false;
          }
          return true;
        } finally {
          seen.delete(obj);
        }
      }
      default:
        // bigint isn't JSON-serializable (JSON.stringify throws); undefined /
        // function / symbol are omitted and cost nothing.
        return typeof v !== "bigint";
    }
  };
  return walk(value, 0);
}

export const PresencePublishPayload = z.object({
  scope: PresenceScopeInput,
  topic: PRESENCE_TOPIC,
  clientId: PRESENCE_CLIENT_ID,
  incarnationId: PRESENCE_INCARNATION_ID,
  // Opaque display payload (e.g. { displayName, typing }) — forwarded verbatim
  // to the relay, which caps its serialized size. Absent on a leave; bounded
  // here so main never serializes an attacker-sized payload.
  state: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || presenceStateWithinCap(v), {
      message: "presence state exceeds the size cap",
    }),
  leave: z.boolean().optional(),
});
export type PresencePublishPayload = z.infer<typeof PresencePublishPayload>;
export const PresencePublishRequestPayload = PresencePublishPayload.extend({
  rendererDocumentId: z.uuid(),
});

export const PresencePollPayload = z.object({
  scope: PresenceScopeInput,
  topic: PRESENCE_TOPIC,
  since: z.number().int().min(0),
  // Renderer-minted correlation id so an in-flight long-poll can be aborted
  // over IPC (presenceCancel) on unmount / workspace switch.
  pollId: PRESENCE_POLL_ID,
});
export type PresencePollPayload = z.infer<typeof PresencePollPayload>;

export const PresenceCancelPayload = z.object({
  pollId: PRESENCE_POLL_ID,
});
export type PresenceCancelPayload = z.infer<typeof PresenceCancelPayload>;

const PresencePeerRecord = z.object({
  userId: z.string().max(256),
  clientId: z.string().max(128),
  // Opaque peer display payload — the renderer's resolvePeerDisplayName is the
  // sole guard that turns it into a shown name.
  state: z.unknown(),
  updatedAtMs: z.number(),
});
const PresenceSnapshotRecord = z.object({
  version: z.number(),
  peers: z.array(PresencePeerRecord),
});

// Discriminated so a dropped session / no-relay / aborted long-poll is a
// well-defined "unavailable"/"aborted" result the renderer treats as dormant,
// never a thrown IPC error that would churn a retry loop.
export const PresenceResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: PresenceSnapshotRecord }),
  z.object({ ok: z.literal(false), reason: z.enum(["unavailable", "aborted"]) }),
]);
export type PresenceResult = z.infer<typeof PresenceResult>;

// Named versions (PR 0M-4). Product vocabulary only:
// a Version is a live parallel line of work; Main is the default one. All of
// these handlers are gated in main on the workspace's engine capture being
// attached.
const WORKSPACE_VERSION_NAME_MAX = 80;
// Conflict and compare sides are the same hydrated stored bodies the timeline
// carries, passed through verbatim (`engineHistoryIpc.ts` versionConflictForIpc,
// `versionCompare.ts`), so they carry the engine's own text contract.
//
// Compare rows use this bound to its full height: `compareVersionFilesPage`
// hydrates each differing path by `readTextFile` -> `readTextBlob`, so a
// compare side at the engine's contract does arrive.
//
// Conflict listing keeps up too: a row past 8 MiB minus envelope
// headroom is degraded to withheld metadata rather than refused
// (`conflicts_list`, crates/dohc-workspace-engine/src/lib.rs), and
// `listTextConflicts` hydrates each withheld side through
// `versionedText.readBlob`. So a conflict side at the engine's storage
// contract arrives on every lane this bound covers.
//
// The bound stays the engine's storage contract rather than any transport
// ceiling: a second hand-copied constant is the drift #517 was filed about.
// The one place the client mirrors the frame cap is `engineTextLimits.ts`,
// where `CONFLICT_ROW_HARD_CAP_BYTES` is derived from the frame constant the
// drift guard already covers.
//
// The combined resolution (`keep-combined` below) is the one REQUEST use, and
// its contract is not this one: the engine bounds a combined resolution by the
// control frame that carries the whole request, measured in JSON-ENCODED bytes
// (`crates/dohc-workspace-engine/src/lib.rs`, `resolve_request_encoded_bytes`).
// Encoded, so escaping counts: a newline-heavy body is twice its raw size on
// the wire, and this character bound cannot see that. This bound only keeps an
// unbounded string off the wire; the engine decides what applies.
const VERSION_TEXT = engineStoredText("version text");

export const WorkspaceVersionRecord = z.object({
  id: OPAQUE_ID,
  name: z.string().min(1).max(200),
  kind: z.enum(["main", "named"]),
  createdAtMs: z.number(),
  // False for versions created from another named version — the alpha merge
  // surface only combines a version with the Main it was created from.
  canMergeIntoMain: z.boolean(),
});
export type WorkspaceVersionRecord = z.infer<typeof WorkspaceVersionRecord>;

export const ListWorkspaceVersionsResult = z.object({
  versions: z.array(WorkspaceVersionRecord),
  activeVersionId: OPAQUE_ID,
});
export type ListWorkspaceVersionsResult = z.infer<typeof ListWorkspaceVersionsResult>;

export const CreateWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  name: z
    .string()
    .min(1)
    .max(WORKSPACE_VERSION_NAME_MAX)
    .refine((value) => value.trim() === value && value.length > 0, {
      message: "version name must not start or end with spaces",
    }),
});
export type CreateWorkspaceVersionPayload = z.infer<typeof CreateWorkspaceVersionPayload>;

export const SwitchWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  versionId: OPAQUE_ID,
});
export type SwitchWorkspaceVersionPayload = z.infer<typeof SwitchWorkspaceVersionPayload>;

export const SwitchWorkspaceVersionResult = z.object({
  activeVersionId: OPAQUE_ID,
  changedFileCount: z.number().int().min(0),
});
export type SwitchWorkspaceVersionResult = z.infer<typeof SwitchWorkspaceVersionResult>;

export const WorkspaceVersionFileChange = z.object({
  path: PATH_STRING,
  status: z.enum(["added", "modified", "deleted"]),
  // Main's side; absent when the file only exists in the compared version.
  currentText: VERSION_TEXT.optional(),
  // The compared version's side; absent when the file only exists in Main.
  incomingText: VERSION_TEXT.optional(),
  // Secret-backed file: the compare view renders "Protected file
  // changed" — both text sides are always absent when this is set.
  protected: z.boolean().optional(),
  // Binary files are byte-versioned but comparison is metadata-only.
  binary: z.boolean().optional(),
});
export type WorkspaceVersionFileChange = z.infer<typeof WorkspaceVersionFileChange>;

export const CompareWorkspaceVersionsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  versionId: OPAQUE_ID,
  // Continuation from the previous page's nextAfterPath; absent for the
  // first page.
  afterPath: PATH_STRING.optional(),
});
export type CompareWorkspaceVersionsPayload = z.infer<
  typeof CompareWorkspaceVersionsPayload
>;

// Page-shaped: the rows carry full text sides, so the message is
// bounded by main's page budget (`COMPARE_PAGE_TEXT_BYTE_BUDGET`,
// workspace-core versionCompare.ts) and the rest rides the continuation.
export const CompareWorkspaceVersionsResult = z.object({
  files: z.array(WorkspaceVersionFileChange),
  // Non-null: more differing files exist past this page. Pass it back as
  // afterPath to fetch them.
  nextAfterPath: PATH_STRING.nullable(),
});
export type CompareWorkspaceVersionsResult = z.infer<
  typeof CompareWorkspaceVersionsResult
>;

export const WorkspaceVersionConflict = z.object({
  conflictId: OPAQUE_ID,
  path: PATH_STRING,
  sourceVersionId: OPAQUE_ID,
  targetVersionId: OPAQUE_ID,
  // Additive (0P-C): where the conflict came from — a version merge, or two
  // machines editing the same file while apart ("sync"). The review UI
  // labels the sides accordingly ("On this machine" / "On another machine").
  origin: z.enum(["merge", "sync"]).default("merge"),
  contentKind: z.enum(["text", "binary"]).default("text"),
  // null means "no file on that side" (added on one side, deleted on the
  // other). Raw texts only — the UI renders sides, never conflict markers.
  currentText: VERSION_TEXT.nullable(),
  incomingText: VERSION_TEXT.nullable(),
  baseText: VERSION_TEXT.nullable(),
  currentBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
  incomingBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
  baseBinary: z
    .object({ byteLength: z.number().int().nonnegative(), sha256: z.string().min(1).max(128) })
    .nullable()
    .optional(),
});
export type WorkspaceVersionConflict = z.infer<typeof WorkspaceVersionConflict>;

export const MergeWorkspaceVersionPayload = SwitchWorkspaceVersionPayload;
export type MergeWorkspaceVersionPayload = z.infer<typeof MergeWorkspaceVersionPayload>;


// Every conflict-carrying result is page-shaped: the daemon pages
// `conflicts.list` under a byte budget, and these results pass one such page
// through. Non-null nextAfterConflictId: more open conflicts exist past this
// page — pass it back as afterConflictId to fetch them.
export const MergeWorkspaceVersionResult = z.object({
  mergedFileCount: z.number().int().min(0),
  unchangedFileCount: z.number().int().min(0),
  // How many files this merge left in conflict. The rows below are the first
  // page of all open conflicts (a sync conflict can be among them), so the
  // stage decision reads this count — unrelated open conflicts must not turn
  // a clean merge into a conflicted one. The count sentence over the cards
  // reads the loaded rows instead: it describes what the user is looking at.
  conflictCount: z.number().int().min(0),
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: OPAQUE_ID.nullable(),
});
export type MergeWorkspaceVersionResult = z.infer<typeof MergeWorkspaceVersionResult>;

export const ListWorkspaceVersionConflictsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  afterConflictId: OPAQUE_ID.optional(),
});
export type ListWorkspaceVersionConflictsPayload = z.infer<
  typeof ListWorkspaceVersionConflictsPayload
>;

export const ListWorkspaceVersionConflictsResult = z.object({
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: OPAQUE_ID.nullable(),
});
export type ListWorkspaceVersionConflictsResult = z.infer<
  typeof ListWorkspaceVersionConflictsResult
>;

export const ResolveWorkspaceVersionConflictPayload = z.object({
  workspaceId: WORKSPACE_ID,
  conflictId: OPAQUE_ID,
  resolution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("keep-current") }),
    z.object({ kind: z.literal("keep-incoming") }),
    z.object({ kind: z.literal("keep-combined"), text: VERSION_TEXT }),
  ]),
});
export type ResolveWorkspaceVersionConflictPayload = z.infer<
  typeof ResolveWorkspaceVersionConflictPayload
>;

// The first page of the conflicts still open after the resolution.
export const ResolveWorkspaceVersionConflictResult = z.object({
  conflicts: z.array(WorkspaceVersionConflict),
  nextAfterConflictId: OPAQUE_ID.nullable(),
});
export type ResolveWorkspaceVersionConflictResult = z.infer<
  typeof ResolveWorkspaceVersionConflictResult
>;

// "Try it in a version" (PR 0N-2): one gesture — fork a version named after
// the task, switch into it, start a dohc-tracked agent run. Gated in main on
// the workspace's engine capture like every version operation.
const TRY_IN_VERSION_TASK_MAX = 2000;

export const TryInWorkspaceVersionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  task: z
    .string()
    .min(1)
    .max(TRY_IN_VERSION_TASK_MAX)
    .refine((value) => value.trim().length > 0, {
      message: "task must not be blank",
    }),
});
export type TryInWorkspaceVersionPayload = z.infer<
  typeof TryInWorkspaceVersionPayload
>;

export const TryInWorkspaceVersionResult = z.object({
  versionId: OPAQUE_ID,
  versionName: z.string().min(1).max(200),
  runId: OPAQUE_ID,
});
export type TryInWorkspaceVersionResult = z.infer<
  typeof TryInWorkspaceVersionResult
>;

export const TryInVersionRunState = z.object({
  status: z.enum(["running", "review"]),
  task: z.string().min(1).max(TRY_IN_VERSION_TASK_MAX),
  versionId: OPAQUE_ID,
  versionName: z.string().min(1).max(200),
  runId: OPAQUE_ID,
  startedAtMs: z.number(),
  endedAtMs: z.number().optional(),
  runOutcome: z.enum(["complete", "failed"]).optional(),
  // Review only. null = the count could not be computed; the card says so
  // rather than guessing.
  changedFileCount: z.number().int().min(0).nullable().optional(),
  mergeAvailable: z.boolean(),
});
export type TryInVersionRunState = z.infer<typeof TryInVersionRunState>;

export const TryInVersionStateResult = z.object({
  state: TryInVersionRunState.nullable(),
});
export type TryInVersionStateResult = z.infer<typeof TryInVersionStateResult>;

// Files dohc moved aside while it saved, because another program changed
// them meanwhile. Each waits in the engine's staging directory until
// saveKeptCopy moves it to a visible copy. That answer is `saved` with the
// copy's path, `gone` when nothing is kept under the id any more, or
// `no-valid-name` when no name beside the file fits, so the copy stays kept.
export const KeptCopy = z.object({
  id: z.number().int(),
  path: z.string().min(1),
  keptAtMs: z.number().int().nonnegative(),
});
export type KeptCopy = z.infer<typeof KeptCopy>;
export const ListKeptCopiesResult = z.object({
  keptCopies: z.array(KeptCopy),
  more: z.boolean(),
});
export type ListKeptCopiesResult = z.infer<typeof ListKeptCopiesResult>;
export const SaveKeptCopyPayload = z.object({
  workspaceId: WORKSPACE_ID,
  id: z.number().int(),
});
export const SaveKeptCopyResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), path: z.string().min(1) }),
  z.object({ status: z.literal("gone") }),
  z.object({ status: z.literal("no-valid-name") }),
]);
export type SaveKeptCopyResult = z.infer<typeof SaveKeptCopyResult>;

// A window works only on the versions of the workspace open in it.
const versionGuard = {
  guard: "active-workspace",
  inactiveMessage:
    "Versions stopped because this window changed workspaces. Open the workspace and try again.",
} as const;

export const workspaceVersionOperations = {
  listWorkspaceVersions: {
    channel: "desktop:list-workspace-versions",
    payload: WorkspaceIdPayload, result: ListWorkspaceVersionsResult, ...versionGuard,
  },
  createWorkspaceVersion: {
    channel: "desktop:create-workspace-version",
    payload: CreateWorkspaceVersionPayload, result: ListWorkspaceVersionsResult, ...versionGuard,
  },
  switchWorkspaceVersion: {
    channel: "desktop:switch-workspace-version",
    payload: SwitchWorkspaceVersionPayload, result: SwitchWorkspaceVersionResult, ...versionGuard,
  },
  compareWorkspaceVersions: {
    channel: "desktop:compare-workspace-versions",
    payload: CompareWorkspaceVersionsPayload, result: CompareWorkspaceVersionsResult, ...versionGuard,
  },
  mergeWorkspaceVersion: {
    channel: "desktop:merge-workspace-version",
    payload: MergeWorkspaceVersionPayload, result: MergeWorkspaceVersionResult, ...versionGuard,
  },
  listWorkspaceVersionConflicts: {
    channel: "desktop:list-workspace-version-conflicts",
    payload: ListWorkspaceVersionConflictsPayload, result: ListWorkspaceVersionConflictsResult, ...versionGuard,
  },
  resolveWorkspaceVersionConflict: {
    channel: "desktop:resolve-workspace-version-conflict",
    payload: ResolveWorkspaceVersionConflictPayload, result: ResolveWorkspaceVersionConflictResult, ...versionGuard,
  },
  listKeptCopies: {
    channel: "desktop:list-kept-copies",
    payload: WorkspaceIdPayload, result: ListKeptCopiesResult, ...versionGuard,
  },
  saveKeptCopy: {
    channel: "desktop:save-kept-copy",
    payload: SaveKeptCopyPayload, result: SaveKeptCopyResult, ...versionGuard,
  },
  tryInWorkspaceVersion: {
    channel: "desktop:try-in-workspace-version",
    payload: TryInWorkspaceVersionPayload, result: TryInWorkspaceVersionResult, ...versionGuard,
  },
  getTryInVersionState: {
    channel: "desktop:get-try-in-version-state",
    payload: WorkspaceIdPayload, result: TryInVersionStateResult, ...versionGuard,
  },
  dismissTryInVersionReview: {
    channel: "desktop:dismiss-try-in-version-review",
    payload: WorkspaceIdPayload, ...versionGuard,
  },
} satisfies OperationTable;

const SiteDiagnostic = z.object({
  path: PATH_STRING.optional(),
  severity: z.enum(["warning", "error"]),
  code: z.string().min(1).max(100),
  message: z.string().max(10_000).optional(),
});
export type SiteDiagnostic = z.infer<typeof SiteDiagnostic>;

const SiteScripts = z.object({
  predev: z.string().optional(),
  dev: z.string().optional(),
  postdev: z.string().optional(),
  prestart: z.string().optional(),
  start: z.string().optional(),
  poststart: z.string().optional(),
  build: z.string().optional(),
});
export type SiteScripts = z.infer<typeof SiteScripts>;

const SitePackageScripts = z.record(
  z.string().min(1).max(200),
  z.string().max(10_000),
);

const SiteSharePath = SITE_ROOT_STRING.refine((path) => path !== ".", {
  message: "site share paths must name a file",
});

const SiteShareMountRoot = SITE_ROOT_STRING.refine((path) => path !== ".", {
  message: "site share mount roots must name the mounted share",
});

const SiteShareManifest = z
  .object({
    entryPath: SiteSharePath,
    assets: z.array(SiteSharePath).max(99),
  })
  .superRefine((manifest, ctx) => {
    const paths = [manifest.entryPath, ...manifest.assets];
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "site share manifest paths must be unique",
      });
    }
  });

const SiteShareManifestResult = z.union([
  z.object({ ok: z.literal(true), manifest: SiteShareManifest }),
  z.object({ ok: z.literal(false), reason: z.literal("no-runnable-artifact") }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("byte-budget"),
    limitBytes: z.number().int().positive(),
    observedBytes: z.number().int().positive(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("file-count"),
    limitFiles: z.number().int().positive(),
    observedFiles: z.number().int().positive(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("path-too-long"),
    limitChars: z.number().int().positive(),
    observedChars: z.number().int().positive(),
    path: SiteSharePath,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("unreadable"),
    path: SiteSharePath,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("non-file-reference"),
    path: SiteSharePath,
  }),
]);

const SitePackageInfo = z
  .object({
    root: PATH_STRING,
    title: z.string().min(1).max(200),
    kind: z.enum(["static", "package", "configured"]),
    confidence: z.enum(["high", "medium", "low"]),
    entryPath: PATH_STRING.nullable(),
    configPath: PATH_STRING.nullable(),
    packagePath: PATH_STRING.nullable(),
    packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
    scripts: SitePackageScripts,
    configuredScripts: SiteScripts,
    configuredPreviewMode: z.enum(["static", "dev", "build"]).nullable(),
    configuredBuildOutput: PATH_STRING.nullable(),
    buildOutputs: z.array(PATH_STRING).max(100),
    sourceFiles: z.array(PATH_STRING),
    shareManifest: SiteShareManifestResult,
    diagnostics: z.array(SiteDiagnostic).max(100),
    authority: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace") }),
      z.object({ kind: z.literal("share"), mountRoot: SiteShareMountRoot }),
    ]),
  })
  .superRefine((site, ctx) => {
    if (
      site.authority.kind === "share" &&
      site.root !== site.authority.mountRoot &&
      !site.root.startsWith(`${site.authority.mountRoot}/`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "shared site roots must stay inside their authority mount root",
        path: ["root"],
      });
    }
    if (!site.shareManifest.ok) return;
    const manifest = site.shareManifest.manifest;
    const paths = [manifest.entryPath, ...manifest.assets];
    for (const path of paths) {
      if (!site.sourceFiles.includes(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "site share manifest paths must exist in sourceFiles",
          path: ["shareManifest", "manifest"],
        });
        return;
      }
      if (site.root !== "." && !path.startsWith(`${site.root}/`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "site share manifest paths must stay inside the site root",
          path: ["shareManifest", "manifest"],
        });
        return;
      }
    }
    if (!/\.html?$/i.test(manifest.entryPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "site share manifest entryPath must be HTML",
        path: ["shareManifest", "manifest", "entryPath"],
      });
    }
  });
export type SitePackageInfo = z.infer<typeof SitePackageInfo>;

export const ListSitesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListSitesPayload = z.infer<typeof ListSitesPayload>;

export const ListSitesResult = z.object({
  sites: z.array(SitePackageInfo),
});
export type ListSitesResult = z.infer<typeof ListSitesResult>;

export const SitePreviewMode = z.enum(["static", "dev", "build"]);
export type SitePreviewMode = z.infer<typeof SitePreviewMode>;

export const SitePackagePayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
  // The mode the caller is actually previewing right now (a stored per-tab
  // choice, or the renderer's own automatic pick) — share-what-you-
  // previewed needs this to select the same artifact the preview serves,
  // not just whatever dohc.json happens to pin. Omitted (or null) falls
  // back to the dohc.json pin alone, matching every other caller (site
  // listings, etc.) that has no single "current tab" to report.
  effectivePreviewMode: SitePreviewMode.nullable().optional(),
});
export type SitePackagePayload = z.infer<typeof SitePackagePayload>;

export const SitePackageResult = SitePackageInfo.nullable();
export type SitePackageResult = z.infer<typeof SitePackageResult>;

// One surface showing an app's preview: a tab or a pinned panel.
const SITE_PREVIEW_HOLDER_ID = z.string().min(1).max(100);

export const StartSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
  mode: SitePreviewMode,
  holderId: SITE_PREVIEW_HOLDER_ID,
  // True when the person asked for this start, which starts the preview
  // again even when it is running. Otherwise the surface shares it.
  restart: z.boolean(),
});
export type StartSitePreviewPayload = z.infer<typeof StartSitePreviewPayload>;

const SiteLogEntry = z.object({
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string().max(10_000),
  at: z.number(),
});
export type SiteLogEntry = z.infer<typeof SiteLogEntry>;

const LoopbackPreviewUrl = z.string().min(1).max(2048).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid URL" });
    return;
  }
  const port = Number(url.port);
  const hasExplicitPort = url.port !== "";
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    (hasExplicitPort && (!Number.isInteger(port) || port < 1 || port > 65535))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview URL must be an unauthenticated loopback HTTP URL",
    });
  }
});

export const StartSitePreviewResult = z.object({
  siteRoot: SITE_ROOT_STRING,
  mode: SitePreviewMode,
  url: LoopbackPreviewUrl,
  logs: z.array(SiteLogEntry).max(500),
  exited: z.boolean(),
  // Which start of the app's preview this is. Every surface showing the app
  // shows the newest one it has heard of.
  generation: z.number().int().nonnegative(),
  build: z
    .object({
      ok: z.boolean(),
      command: z.string(),
      args: z.array(z.string()),
      outputPath: z.string().nullable(),
      exitCode: z.number().nullable(),
    })
    .optional(),
});
export type StartSitePreviewResult = z.infer<typeof StartSitePreviewResult>;

// What a start answers: the preview, or that another surface replaced this
// start with a newer one before it finished. The newer start's preview then
// arrives as a SitePreviewReplacedEvent.
export const StartSitePreviewAnswer = z.union([
  StartSitePreviewResult,
  z.object({ replaced: z.literal(true) }).strict(),
]);
export type StartSitePreviewAnswer = z.infer<typeof StartSitePreviewAnswer>;

// Another surface started the app's preview again. The surface named here
// shows `preview` from now on, or nothing when no preview runs.
export const SitePreviewReplacedEvent = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
  holderId: SITE_PREVIEW_HOLDER_ID,
  generation: z.number().int().nonnegative(),
  preview: StartSitePreviewResult.nullable(),
});
export type SitePreviewReplacedEvent = z.infer<typeof SitePreviewReplacedEvent>;

export const GetSitePreviewLogsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
});
export type GetSitePreviewLogsPayload = z.infer<
  typeof GetSitePreviewLogsPayload
>;

export const GetSitePreviewLogsResult = z.object({
  logs: z.array(SiteLogEntry).max(500),
  exited: z.boolean(),
});
export type GetSitePreviewLogsResult = z.infer<
  typeof GetSitePreviewLogsResult
>;

// The surface stops showing the preview. The preview stops when no surface
// shows it.
export const StopSitePreviewPayload = z.object({
  workspaceId: WORKSPACE_ID,
  siteRoot: SITE_ROOT_STRING,
  holderId: SITE_PREVIEW_HOLDER_ID,
});
export type StopSitePreviewPayload = z.infer<typeof StopSitePreviewPayload>;
const StopSitePreviewResult = z.void();
type StopSitePreviewResult = z.infer<typeof StopSitePreviewResult>;

// The daemon caps its own capture event at this many paths; a merged or
// oversized set stops being a useful hint and the payload omits it
// ("refresh broadly"). One constant for the schema, the broadcaster, and
// the capture aggregation.
export const MAX_ACTIVITY_EVENT_PATHS = 32;

// What one workspace-activity ping says happened. Main already filters the
// send by each window's active workspace, so `workspaceId` is context for a
// path-scoped refresh, not an authorization fact. Absent workspaceId = a
// global event (logout, registry change, daemon relaunch) delivered to every
// window. `paths` is a bounded hint from the daemon's capture payload; a
// batch too large to enumerate omits it and means "refresh broadly".
export const WorkspaceActivityEvent = z
  .object({
    workspaceId: z.string().min(1).optional(),
    paths: z.array(z.string()).max(MAX_ACTIVITY_EVENT_PATHS).optional(),
  })
  .strict();
export type WorkspaceActivityEvent = z.infer<typeof WorkspaceActivityEvent>;

// Shared by main's complete-listing cache and the renderer's activity
// debounce. Keeping this decision beside the event prevents either side from
// broadening its idea of a visible path without the other.
export function activityPathsAffectWorkspaceListing(
  paths: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  return paths.some((path) => !hasEngineIgnoredSegment(path, platform));
}

// An activity ping must never be dropped on a schema failure: under-notifying is the staleness bug the channel exists to
// prevent. A malformed payload degrades to the global, payload-free ping.
export function parseWorkspaceActivityEventForIpc(
  value: unknown,
): WorkspaceActivityEvent {
  const parsed = WorkspaceActivityEvent.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// Server login (device-authorization flow): the desktop shows a short
// code, the user approves in the system browser, the desktop polls. The
// session token never reaches the renderer — main stores it via safeStorage
// and the renderer only ever sees connection status + email.
export const OpenExternalUrlPayload = z.object({
  url: z.string().min(1).max(2048),
});
export type OpenExternalUrlPayload = z.infer<typeof OpenExternalUrlPayload>;

export const CloudLoginStartPayload = z.object({
  serverUrl: z.url().max(2048),
}).strict();
export type CloudLoginStartPayload = z.infer<typeof CloudLoginStartPayload>;

export const CloudLoginStartResult = z.object({
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
});
export type CloudLoginStartResult = z.infer<typeof CloudLoginStartResult>;

export const CloudLoginPollResult = z.object({
  status: z.enum(["pending", "complete", "denied", "expired"]),
  email: z.string().optional(),
});
export type CloudLoginPollResult = z.infer<typeof CloudLoginPollResult>;

export const CloudStatusPayload = z.object({
  workspaceId: WORKSPACE_ID.optional(),
});
export type CloudStatusPayload = z.infer<typeof CloudStatusPayload>;

export const CloudStatusResult = z.object({
  connected: z.boolean(),
  email: z.string().optional(),
  serverUrl: z.string().optional(),
  relayUrl: z.string().optional(),
  serverName: z.string().max(100).optional(),
  networkAccess: z.enum(["private", "public"]).optional(),
  // Whether the named workspace has cloud sync enabled (registry remote set).
  workspaceSynced: z.boolean().optional(),
  // Whether that remote is pinned to the current signed-in account.
  workspaceSyncConnected: z.boolean().optional(),
  workspaceSecretState: z
    .enum(["none", "protected-key-present", "protected-key-missing"])
    .optional(),
});
export type CloudStatusResult = z.infer<typeof CloudStatusResult>;


export const ShareHandoffStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }).strict(),
  z
    .object({
      status: z.literal("waiting-for-sign-in"),
      statusId: OPAQUE_ID,
    })
    .strict(),
  z
    .object({
      status: z.literal("waiting-for-acceptance"),
      statusId: OPAQUE_ID,
      email: z.string().min(1).max(320),
    })
    .strict(),
  z
    .object({ status: z.literal("redeeming"), statusId: OPAQUE_ID })
    .strict(),
  z
    .object({
      status: z.literal("failed-wrong-server"),
      statusId: OPAQUE_ID,
      linkRelayUrl: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed-refused"),
      statusId: OPAQUE_ID,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed-busy"),
      statusId: OPAQUE_ID,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed-network"),
      statusId: OPAQUE_ID,
    })
    .strict(),
  z
    .object({
      status: z.literal("done"),
      statusId: OPAQUE_ID,
      shareId: OPAQUE_ID,
    })
    .strict(),
]);
export type ShareHandoffStatus = z.infer<typeof ShareHandoffStatus>;

export const AcceptShareHandoffPayload = z
  .object({ statusId: OPAQUE_ID })
  .strict();
export type AcceptShareHandoffPayload = z.infer<
  typeof AcceptShareHandoffPayload
>;

export const DismissShareHandoffPayload = z
  .object({ statusId: OPAQUE_ID })
  .strict();
export type DismissShareHandoffPayload = z.infer<
  typeof DismissShareHandoffPayload
>;

export const CloudEnableSyncPayload = z.object({
  workspaceId: WORKSPACE_ID,
  passphrase: z.string().optional(),
});
export type CloudEnableSyncPayload = z.infer<typeof CloudEnableSyncPayload>;

// Join a synced workspace on this machine (0P-C): a sync code copied from
// the machine that already has the workspace, plus a local folder chosen
// through the picker (main re-validates the approved-root provenance).
export const CloudJoinWorkspacePayload = z.object({
  syncCode: z.string().min(1).max(4096),
  rootPath: z.string().min(1).max(4096),
  passphrase: z.string().max(4096).optional(),
});
export type CloudJoinWorkspacePayload = z.infer<typeof CloudJoinWorkspacePayload>;

export const CloudJoinWorkspaceResult = z.object({
  workspace: WorkspaceSummary,
  // Set when the workspace was added but its first sync did not finish —
  // the workspace exists locally and sync keeps retrying.
  warning: z.string().min(1).max(500).optional(),
});
export type CloudJoinWorkspaceResult = z.infer<typeof CloudJoinWorkspaceResult>;

// ---- Relay shares (PR 18, the engine-native cloud) ----
// A share grant lives on the SYNC RELAY: an explicit path list and/or a
// version snapshot, addressed to another relay account by email. The grant
// side gets back a copyable share code (dohc-share:<shareId>:<relayUrl>);
// the receive side opens it as a read-only shared view workspace.

export const RelayShareSelector = z.object({
  paths: z.array(PATH_STRING).max(100),
  versionId: z.string().min(1).max(128).nullable(),
});
export type RelayShareSelector = z.infer<typeof RelayShareSelector>;

const RelayShareReadableState = z.object({
  selector: RelayShareSelector,
  access: SHARE_ACCESS,
  damaged: z.never().optional(),
});

const RelayShareDamagedState = z.object({
  selector: z.null(),
  // Damage reports carry the raw stored value so Settings can keep the
  // reverse path available without treating that value as authority.
  access: z.string().max(64),
  damaged: z.literal(true),
});

const RelayShareGrantedRowBase = z.object({
  subjectName: z.string().max(320).nullable().optional(),
  sharerName: z.string().max(320).nullable().optional(),
  shareId: OPAQUE_ID,
  // The workspace coordinate. This device need not have that workspace in
  // its local registry.
  workspaceId: z.string().min(1).max(256),
  // null for a pending email invite (an addressed email that has no dohc
  // account yet); the recipientEmail carries who it was shared with.
  recipientUserId: z.string().min(1).max(256).nullable(),
  recipientEmail: EMAIL_STRING.nullable(),
  grantId: OPAQUE_ID,
  generation: z.number().int().min(1),
  createdAtMs: z.number().int().nonnegative(),
  revokedAtMs: z.number().int().nonnegative().nullable(),
  shareCode: z.string().min(1).max(4096),
  browserInvitationUrl: z.string().url().max(4096).optional(),
});

export const RelayShareGrantedRow = z.union([
  RelayShareGrantedRowBase.extend(RelayShareReadableState.shape),
  RelayShareGrantedRowBase.extend(RelayShareDamagedState.shape),
]);
export type RelayShareGrantedRow = z.infer<typeof RelayShareGrantedRow>;

// A path/version share granted TO this account (the receive side). The
// relay deliberately omits the granter's workspace id; the selector and
// granter identity are all a recipient ever sees.
const RelayShareReceivedRowBase = z.object({
  subjectName: z.string().max(320).nullable().optional(),
  sharerName: z.string().max(320).nullable().optional(),
  shareId: OPAQUE_ID,
  granterEmail: EMAIL_STRING.nullable(),
  genericChatWritable: z.boolean(),
  grantId: OPAQUE_ID,
  generation: z.number().int().min(1),
  createdAtMs: z.number().int().nonnegative(),
  shareCode: z.string().min(1).max(4096),
});

export const RelayShareReceivedRow = z.union([
  RelayShareReceivedRowBase.extend(RelayShareReadableState.shape),
  RelayShareReceivedRowBase.extend(RelayShareDamagedState.shape),
]);
export type RelayShareReceivedRow = z.infer<typeof RelayShareReceivedRow>;

export const GetRelayReceivedSharePayload = z
  .object({
    shareId: OPAQUE_ID,
  })
  .strict();
export type GetRelayReceivedSharePayload = z.infer<
  typeof GetRelayReceivedSharePayload
>;

export const GetRelayReceivedShareResult = z.discriminatedUnion("found", [
  z
    .object({
      found: z.literal(false),
      // Present when the authenticated exact lookup confirms owner removal.
      removed: z
        .object({
          message: z.string().min(1).max(500),
          removedAtMs: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      found: z.literal(true),
      share: RelayShareReceivedRow,
    })
    .strict(),
]);
export type GetRelayReceivedShareResult = z.infer<
  typeof GetRelayReceivedShareResult
>;

// A grant the owner removed from this account. The relay keeps the row apart
// from `received`, which stays active-only, and words the reason itself.
export const RelayShareRemovedRow = z.object({
  shareId: OPAQUE_ID,
  grantId: OPAQUE_ID,
  message: z.string().min(1).max(500),
  removedAtMs: z.number().int().nonnegative(),
});
export type RelayShareRemovedRow = z.infer<typeof RelayShareRemovedRow>;

export const ListRelaySharesResult = z.object({
  granted: z.array(RelayShareGrantedRow).max(1000),
  // Path/version shares addressed to this account (chat grants are
  // listed through listChatChannelShares).
  received: z.array(RelayShareReceivedRow).max(1000).default([]),
  removed: z.array(RelayShareRemovedRow).max(1000).default([]),
});
export type ListRelaySharesResult = z.infer<typeof ListRelaySharesResult>;

export const CreateRelaySharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  recipientEmail: EMAIL_STRING,
  paths: z.array(PATH_STRING).min(1).max(100).optional(),
  versionId: z.string().min(1).max(128).optional(),
  // Required. There is no default at either boundary: the relay
  // refuses a create that names no level, and so does this one. A caller that
  // sends nothing has not chosen `view`, it has failed to say what the share
  // grants.
  access: SHARE_ACCESS,
});
export type CreateRelaySharePayload = z.infer<typeof CreateRelaySharePayload>;

export const CreateRelayShareResult = z.object({
  shareId: OPAQUE_ID,
  grantId: OPAQUE_ID,
  browserInvitationUrl: z.string().url().max(4096).optional(),
  shareCode: z.string().min(1).max(4096),
  recipientEmail: EMAIL_STRING,
});
export type CreateRelayShareResult = z.infer<typeof CreateRelayShareResult>;

export const RevokeRelaySharePayload = z.object({
  shareId: OPAQUE_ID,
});
export type RevokeRelaySharePayload = z.infer<typeof RevokeRelaySharePayload>;

// The relay's receipt for a removal it can put back. It restores the grants
// the removal ended, as they were; it never makes a new grant or link. The
// relay forgets the receipt at `expiresAtMs`, 10 minutes after the removal.
export const RelayShareUndoReceipt = z
  .object({
    undoId: z.string().min(1).max(256),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type RelayShareUndoReceipt = z.infer<typeof RelayShareUndoReceipt>;

export const RevokeRelayShareResult = z
  .object({ undo: RelayShareUndoReceipt.optional() })
  .strict();
export type RevokeRelayShareResult = z.infer<typeof RevokeRelayShareResult>;

export const RelayShareRevokeResponse = z.object({
  ok: z.literal(true),
  undo: RelayShareUndoReceipt.optional(),
});

export const UndoRelaySharePayload = z
  .object({
    shareId: OPAQUE_ID,
    undoId: RelayShareUndoReceipt.shape.undoId,
  })
  .strict();
export type UndoRelaySharePayload = z.infer<typeof UndoRelaySharePayload>;

export const UndoRelayShareResult = z.object({ shareId: OPAQUE_ID }).strict();
export type UndoRelayShareResult = z.infer<typeof UndoRelayShareResult>;

export const RelayShareUndoResponse = z.object({
  ok: z.literal(true),
  shareId: OPAQUE_ID,
});

const RELAY_SHARE_LINK_ACCESS = z.enum(["view", "comment", "edit"]);

// The main process creates the share and its first link together. The
// renderer must name the exact public level; there is no default at this
// boundary once Comment exists.
export const CreateRelayShareLinkPayload = z.union([
  z
    .object({
      workspaceId: WORKSPACE_ID,
      paths: z.array(PATH_STRING).min(1).max(100),
      versionId: z.never().optional(),
      access: RELAY_SHARE_LINK_ACCESS,
    })
    .strict(),
  z
    .object({
      workspaceId: WORKSPACE_ID,
      paths: z.never().optional(),
      versionId: z.string().min(1).max(128),
      access: z.enum(["view", "comment"]),
    })
    .strict(),
]);
export type CreateRelayShareLinkPayload = z.infer<
  typeof CreateRelayShareLinkPayload
>;

const RELAY_SHARE_LINK_URL = z.url().max(4096);

export const CreateRelayShareLinkResult = z.object({
  shareId: OPAQUE_ID,
  grantId: OPAQUE_ID,
  url: RELAY_SHARE_LINK_URL,
});
export type CreateRelayShareLinkResult = z.infer<
  typeof CreateRelayShareLinkResult
>;

export const AddRelayShareLinkPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    access: RELAY_SHARE_LINK_ACCESS,
  })
  .strict();
export type AddRelayShareLinkPayload = z.infer<
  typeof AddRelayShareLinkPayload
>;

export const AddRelayShareLinkResult = CreateRelayShareLinkResult;
export type AddRelayShareLinkResult = z.infer<
  typeof AddRelayShareLinkResult
>;

const RELAY_SHARE_LINK_CURSOR = z.string().min(1).max(1024);

export const ListRelayShareLinksPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    cursor: RELAY_SHARE_LINK_CURSOR.optional(),
    independentGrantCursor: RELAY_SHARE_LINK_CURSOR.optional(),
  })
  .strict();
export type ListRelayShareLinksPayload = z.infer<
  typeof ListRelayShareLinksPayload
>;

export const RelayShareLinkDependent = z.object({
  grantId: OPAQUE_ID,
  recipientUserId: z.string().min(1).max(256).nullable(),
  recipientEmail: EMAIL_STRING.nullable(),
  access: SHARE_ACCESS,
  generation: z.number().int().min(1),
  createdAtMs: z.number().int().nonnegative(),
});
export type RelayShareLinkDependent = z.infer<
  typeof RelayShareLinkDependent
>;

const RelayShareLinkRowBase = z.object({
  shareId: OPAQUE_ID,
  grantId: OPAQUE_ID,
  generation: z.number().int().min(1),
  status: z.enum(["active", "revoked"]),
  createdAtMs: z.number().int().nonnegative(),
  revokedAtMs: z.number().int().nonnegative().nullable(),
  lastUsedAtMs: z.number().int().nonnegative().nullable(),
  urlIssuedAtMs: z.number().int().nonnegative().nullable(),
  dependents: z.array(RelayShareLinkDependent).max(1000),
});

export const RelayShareLinkRow = z.union([
  RelayShareLinkRowBase.extend({
    selector: RelayShareSelector,
    access: SHARE_ACCESS,
    damaged: z.never().optional(),
  }),
  RelayShareLinkRowBase.extend({
    selector: z.null(),
    access: z.string().max(64),
    damaged: z.literal(true),
  }),
]);
export type RelayShareLinkRow = z.infer<typeof RelayShareLinkRow>;

export const RelayShareLinkIndependentGrant = z
  .object({
    shareId: OPAQUE_ID,
    grantId: OPAQUE_ID,
    recipientUserId: z.string().min(1).max(256).nullable(),
    recipientEmail: EMAIL_STRING.nullable(),
  })
  .strict();
export type RelayShareLinkIndependentGrant = z.infer<
  typeof RelayShareLinkIndependentGrant
>;

export const ListRelayShareLinksResult = z.object({
  supportedLinkAccess: z.union([z.tuple([z.literal("view"), z.literal("comment")]), z.tuple([z.literal("view"), z.literal("comment"), z.literal("edit")])]),
  links: z.array(RelayShareLinkRow).max(1000),
  independentGrants: z.array(RelayShareLinkIndependentGrant).max(1000),
  nextCursor: RELAY_SHARE_LINK_CURSOR.optional(),
  nextIndependentGrantCursor: RELAY_SHARE_LINK_CURSOR.optional(),
});
export type ListRelayShareLinksResult = z.infer<
  typeof ListRelayShareLinksResult
>;

const RelayShareLinkMutationPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    grantId: OPAQUE_ID,
    expectedDependentGrantIds: z.array(OPAQUE_ID).max(1000),
  })
  .strict();

export const RotateRelayShareLinkPayload = RelayShareLinkMutationPayload;
export type RotateRelayShareLinkPayload = z.infer<
  typeof RotateRelayShareLinkPayload
>;

export const RevokeRelayShareLinkPayload = RelayShareLinkMutationPayload;
export type RevokeRelayShareLinkPayload = z.infer<
  typeof RevokeRelayShareLinkPayload
>;

export const RetuneRelayShareLinkPayload = RelayShareLinkMutationPayload.extend({
  access: RELAY_SHARE_LINK_ACCESS,
});
export type RetuneRelayShareLinkPayload = z.infer<
  typeof RetuneRelayShareLinkPayload
>;

export const RelayShareLinkDependentConflict = z.object({
  ok: z.literal(false),
  code: z.literal("dependents_changed"),
  dependents: z.array(RelayShareLinkDependent).max(1000),
});
export type RelayShareLinkDependentConflict = z.infer<
  typeof RelayShareLinkDependentConflict
>;

export const RelayShareLinkCreateResponse = CreateRelayShareLinkResult.extend({
  ok: z.literal(true),
});

export const RelayShareLinkListResponse = ListRelayShareLinksResult.extend({
  ok: z.literal(true),
});

export const RelayShareLinkRotateResponse = z.object({
  ok: z.literal(true),
  url: RELAY_SHARE_LINK_URL,
});

export const RelayShareLinkRetuneWidenResponse = z.object({
  ok: z.literal(true),
  access: SHARE_ACCESS.refine((access) => shareAccessRank(access) > shareAccessRank("view")),
  url: RELAY_SHARE_LINK_URL,
});

export const RelayShareLinkRetuneNarrowResponse = z.object({
  ok: z.literal(true),
  access: SHARE_ACCESS,
  url: z.never().optional(),
});

export const RelayShareLinkEndResponse = z.object({
  ok: z.literal(true),
  undo: RelayShareUndoReceipt,
});

const RelayShareLinkDependentsChangedOutcome = z
  .object({
    outcome: z.literal("dependents-changed"),
    dependents: z.array(RelayShareLinkDependent).max(1000),
  })
  .strict();

export const RotateRelayShareLinkResult = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("rotated"),
      url: RELAY_SHARE_LINK_URL,
    })
    .strict(),
  RelayShareLinkDependentsChangedOutcome,
]);
export type RotateRelayShareLinkResult = z.infer<
  typeof RotateRelayShareLinkResult
>;

export const RetuneRelayShareLinkResult = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("widened"),
      url: RELAY_SHARE_LINK_URL,
    })
    .strict(),
  z.object({ outcome: z.literal("narrowed") }).strict(),
  RelayShareLinkDependentsChangedOutcome,
]);
export type RetuneRelayShareLinkResult = z.infer<
  typeof RetuneRelayShareLinkResult
>;

export const RevokeRelayShareLinkResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ended"), undo: RelayShareUndoReceipt }).strict(),
  RelayShareLinkDependentsChangedOutcome,
]);
export type RevokeRelayShareLinkResult = z.infer<
  typeof RevokeRelayShareLinkResult
>;

const RELAY_SHARE_DISCUSSION_CURSOR = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u, "discussion cursor must be base64url");
const RELAY_SHARE_DISCUSSION_HANDLE = z.string().min(1).max(512);
const RELAY_SHARE_DISCUSSION_DISPLAY_NAME = z.string().min(1).max(512);
const RELAY_SHARE_DISCUSSION_BODY = z.string().superRefine((body, ctx) => {
  if (normalizeShareDiscussionBody(body) !== null) return;
  ctx.addIssue({
    code: "custom",
    message: "discussion body exceeds the relay limit",
  });
});
const RELAY_SHARE_DISCUSSION_IDEMPOTENCY_KEY = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x20-\x7e]+$/u, "idempotency key must be printable ASCII");

const RelayShareDiscussionNamedAuthor = z
  .object({
    kind: z.literal("named"),
    displayName: RELAY_SHARE_DISCUSSION_DISPLAY_NAME,
  })
  .strict();
const RelayShareDiscussionLinkAuthor = z
  .object({
    kind: z.literal("link"),
    displayName: RELAY_SHARE_DISCUSSION_DISPLAY_NAME,
    unverified: z.literal(true),
  })
  .strict();
const RelayShareDiscussionLinkModeration = z
  .object({
    linkGrantId: RELAY_SHARE_DISCUSSION_HANDLE,
    linkPrincipalId: RELAY_SHARE_DISCUSSION_HANDLE,
    blocked: z.boolean(),
  })
  .strict();
const RelayShareDiscussionMessageBase = {
  messageId: RELAY_SHARE_DISCUSSION_HANDLE,
  createdAtMs: z.number().int().nonnegative(),
};

export const RelayShareDiscussionMessage = z.union([
  z
    .object({
      ...RelayShareDiscussionMessageBase,
      deleted: z.literal(false),
      body: RELAY_SHARE_DISCUSSION_BODY,
      author: RelayShareDiscussionNamedAuthor,
    })
    .strict(),
  z
    .object({
      ...RelayShareDiscussionMessageBase,
      deleted: z.literal(false),
      body: RELAY_SHARE_DISCUSSION_BODY,
      author: RelayShareDiscussionLinkAuthor,
      moderation: RelayShareDiscussionLinkModeration,
    })
    .strict(),
  z
    .object({
      ...RelayShareDiscussionMessageBase,
      deleted: z.literal(true),
      author: RelayShareDiscussionNamedAuthor,
    })
    .strict(),
  z
    .object({
      ...RelayShareDiscussionMessageBase,
      deleted: z.literal(true),
      author: RelayShareDiscussionLinkAuthor,
      moderation: RelayShareDiscussionLinkModeration,
    })
    .strict(),
]);
export type RelayShareDiscussionMessage = z.infer<
  typeof RelayShareDiscussionMessage
>;

export const ListRelayShareDiscussionPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    direction: z.literal("newest-first"),
    cursor: RELAY_SHARE_DISCUSSION_CURSOR.optional(),
  })
  .strict();
export type ListRelayShareDiscussionPayload = z.infer<
  typeof ListRelayShareDiscussionPayload
>;

export const ListRelayShareDiscussionResult = z
  .object({
    activityRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    linkCommentsPaused: z.boolean(),
    messages: z.array(RelayShareDiscussionMessage).max(100),
    nextCursor: RELAY_SHARE_DISCUSSION_CURSOR.nullable(),
  })
  .strict();
export type ListRelayShareDiscussionResult = z.infer<
  typeof ListRelayShareDiscussionResult
>;

export const RelayShareDiscussionPageResponse = ListRelayShareDiscussionResult.extend({
  ok: z.literal(true),
}).strict();

const RelayShareDiscussionActivityPrincipal = z
  .object({
    principalId: RELAY_SHARE_DISCUSSION_HANDLE,
    blocked: z.boolean(),
  })
  .strict();

export const PollRelayShareDiscussionActivityPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    since: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hold: z.number().int().min(0).max(30_000),
    limit: z.number().int().min(1).max(100),
    pollId: z.uuid(),
  })
  .strict();
export type PollRelayShareDiscussionActivityPayload = z.infer<
  typeof PollRelayShareDiscussionActivityPayload
>;

const RelayShareDiscussionActivityResultShape = {
  latestRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cursorRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hasMore: z.boolean(),
  messages: z.array(RelayShareDiscussionMessage).max(100),
  principals: z.array(RelayShareDiscussionActivityPrincipal).max(100),
  linkCommentsPaused: z.boolean(),
};

function relayShareDiscussionActivityCursorMatchesProgress(result: {
  latestRevision: number;
  cursorRevision: number;
  hasMore: boolean;
}): boolean {
  return result.hasMore
    ? result.cursorRevision < result.latestRevision
    : result.cursorRevision === result.latestRevision;
}

const RELAY_SHARE_DISCUSSION_ACTIVITY_CURSOR_ISSUE = {
  message: "activity cursor must match the progress flag",
  path: ["cursorRevision"],
};

export const PollRelayShareDiscussionActivityResult = z
  .object(RelayShareDiscussionActivityResultShape)
  .strict()
  .refine(
    relayShareDiscussionActivityCursorMatchesProgress,
    RELAY_SHARE_DISCUSSION_ACTIVITY_CURSOR_ISSUE,
  );
export type PollRelayShareDiscussionActivityResult = z.infer<
  typeof PollRelayShareDiscussionActivityResult
>;

export const RelayShareDiscussionActivityResponse = z
  .object({ ok: z.literal(true), ...RelayShareDiscussionActivityResultShape })
  .strict()
  .refine(
    relayShareDiscussionActivityCursorMatchesProgress,
    RELAY_SHARE_DISCUSSION_ACTIVITY_CURSOR_ISSUE,
  );

export const CancelRelayShareDiscussionActivityPayload = z
  .object({ pollId: z.uuid() })
  .strict();
export type CancelRelayShareDiscussionActivityPayload = z.infer<
  typeof CancelRelayShareDiscussionActivityPayload
>;

export const AppendRelayShareDiscussionPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    body: RELAY_SHARE_DISCUSSION_BODY,
    idempotencyKey: RELAY_SHARE_DISCUSSION_IDEMPOTENCY_KEY,
  })
  .strict();
export type AppendRelayShareDiscussionPayload = z.infer<
  typeof AppendRelayShareDiscussionPayload
>;

export const AppendRelayShareDiscussionResult = z
  .object({ message: RelayShareDiscussionMessage })
  .strict();
export type AppendRelayShareDiscussionResult = z.infer<
  typeof AppendRelayShareDiscussionResult
>;

export const RelayShareDiscussionAppendResponse = AppendRelayShareDiscussionResult.extend({
  ok: z.literal(true),
}).strict();

const RelayShareDiscussionTargetPayload = z
  .object({ workspaceId: WORKSPACE_ID, shareId: OPAQUE_ID })
  .strict();

export const DeleteRelayShareDiscussionMessagePayload =
  RelayShareDiscussionTargetPayload.extend({
    messageId: RELAY_SHARE_DISCUSSION_HANDLE,
  });
export type DeleteRelayShareDiscussionMessagePayload = z.infer<
  typeof DeleteRelayShareDiscussionMessagePayload
>;

export const BlockRelayShareDiscussionPrincipalPayload =
  RelayShareDiscussionTargetPayload.extend({
    principalId: RELAY_SHARE_DISCUSSION_HANDLE,
  });
export type BlockRelayShareDiscussionPrincipalPayload = z.infer<
  typeof BlockRelayShareDiscussionPrincipalPayload
>;

export const UnblockRelayShareDiscussionPrincipalPayload =
  BlockRelayShareDiscussionPrincipalPayload;
export type UnblockRelayShareDiscussionPrincipalPayload = z.infer<
  typeof UnblockRelayShareDiscussionPrincipalPayload
>;

export const PauseRelayShareDiscussionPayload = RelayShareDiscussionTargetPayload;
export type PauseRelayShareDiscussionPayload = z.infer<
  typeof PauseRelayShareDiscussionPayload
>;

export const ResumeRelayShareDiscussionPayload = RelayShareDiscussionTargetPayload;
export type ResumeRelayShareDiscussionPayload = z.infer<
  typeof ResumeRelayShareDiscussionPayload
>;

const RelayShareDiscussionDeleteTombstone = z
  .object({
    messageId: RELAY_SHARE_DISCUSSION_HANDLE,
    createdAtMs: z.number().int().nonnegative(),
    deleted: z.literal(true),
  })
  .strict();

export const DeleteRelayShareDiscussionMessageResult = z
  .object({ message: RelayShareDiscussionDeleteTombstone })
  .strict();
export type DeleteRelayShareDiscussionMessageResult = z.infer<
  typeof DeleteRelayShareDiscussionMessageResult
>;

export const RelayShareDiscussionDeleteResponse =
  DeleteRelayShareDiscussionMessageResult.extend({ ok: z.literal(true) }).strict();

export const BlockRelayShareDiscussionPrincipalResult = z
  .object({ blocked: z.literal(true) })
  .strict();
export type BlockRelayShareDiscussionPrincipalResult = z.infer<
  typeof BlockRelayShareDiscussionPrincipalResult
>;

export const UnblockRelayShareDiscussionPrincipalResult = z
  .object({ blocked: z.literal(false) })
  .strict();
export type UnblockRelayShareDiscussionPrincipalResult = z.infer<
  typeof UnblockRelayShareDiscussionPrincipalResult
>;

export const RelayShareDiscussionBlockResponse = z
  .object({ ok: z.literal(true), blocked: z.boolean() })
  .strict();

export const PauseRelayShareDiscussionResult = z
  .object({ linkCommentsPaused: z.literal(true) })
  .strict();
export type PauseRelayShareDiscussionResult = z.infer<
  typeof PauseRelayShareDiscussionResult
>;

export const ResumeRelayShareDiscussionResult = z
  .object({ linkCommentsPaused: z.literal(false) })
  .strict();
export type ResumeRelayShareDiscussionResult = z.infer<
  typeof ResumeRelayShareDiscussionResult
>;

export const RelayShareDiscussionPauseResponse = z
  .object({ ok: z.literal(true), linkCommentsPaused: z.boolean() })
  .strict();

export const PromoteRelayShareGrantPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    grantId: OPAQUE_ID,
    expectedParentGrantId: OPAQUE_ID,
    expectedParentGeneration: z.number().int().min(1),
  })
  .strict();
export type PromoteRelayShareGrantPayload = z.infer<
  typeof PromoteRelayShareGrantPayload
>;

export const RevokeRelayShareGrantPayload = z
  .object({
    workspaceId: WORKSPACE_ID,
    shareId: OPAQUE_ID,
    grantId: OPAQUE_ID,
  })
  .strict();
export type RevokeRelayShareGrantPayload = z.infer<
  typeof RevokeRelayShareGrantPayload
>;

const RelayShareNamedGrantTransitionBase = {
  grantId: OPAQUE_ID,
  access: SHARE_ACCESS,
  generation: z.number().int().min(1),
  parentGrantId: z.null(),
};

export const PromoteRelayShareGrantResult = z
  .object({
    ...RelayShareNamedGrantTransitionBase,
    status: z.literal("active"),
    revokedAtMs: z.null(),
  })
  .strict();
export type PromoteRelayShareGrantResult = z.infer<
  typeof PromoteRelayShareGrantResult
>;

export const RevokeRelayShareGrantResult = z
  .object({
    ...RelayShareNamedGrantTransitionBase,
    status: z.literal("revoked"),
    revokedAtMs: z.number().int().nonnegative(),
    undo: RelayShareUndoReceipt,
  })
  .strict();
export type RevokeRelayShareGrantResult = z.infer<
  typeof RevokeRelayShareGrantResult
>;

export const RelayShareGrantPromotionResponse = PromoteRelayShareGrantResult.extend({
  ok: z.literal(true),
}).strict();

export const RelayShareGrantRevokeResponse = RevokeRelayShareGrantResult.extend({
  ok: z.literal(true),
}).strict();

// ---- Share changes ----
// An edit-level recipient edits its own share view and sends the result. The
// granter reads the changes and accepts or declines them; nothing lands in
// the granter's files without that act. The user-facing noun is `changes`
// throughout; `proposal` is code and storage only.

const SHARE_PROPOSAL_ID = z.string().min(1).max(128);

// A proposal carries at most what one submit carries, and that number is
// measured rather than borrowed from a paging bound
// (`@dohc/security-contract/share-proposal-bound`; the evidence is in
// the share-submit bound test in packages/security-contract). A body over the
// cap is relay damage, not a listing this surface should try to render.
//
// This surface can hold the number because it no longer renders content to do
// it: the rows carry paths, drift and sizes, and a file's text is fetched only
// when the granter opens that file.
// Rows a share-changes listing may carry, bounding a body dohc did not write
// and must parse in one go. Same class of thing and the same number as the
// chat-share lanes' own cap (MAX_CHAT_CHANNEL_SHARE_ROWS, declared below):
// relay-supplied rows this surface renders. Nothing here measured a smaller
// healthy range, so nothing here may state one.
const MAX_SHARE_PROPOSAL_ROWS = 4096;

export const ShareProposalState = z.enum([
  "open",
  "accepted",
  "declined",
  "withdrawn",
]);
export type ShareProposalState = z.infer<typeof ShareProposalState>;

// What one op does to one file, net. A rename is a write at the after path.
export const ShareProposalOperation = z.enum(["write", "delete"]);
export type ShareProposalOperation = z.infer<typeof ShareProposalOperation>;

export const ListShareProposalsPayload = z.object({
  // The GRANTER's own workspace. A share view is refused this channel.
  workspaceId: WORKSPACE_ID,
});
export type ListShareProposalsPayload = z.infer<typeof ListShareProposalsPayload>;

const ShareProposalFileRow = z.object({
  // Position in the submit, dense from 0, so the last valid index is one
  // below the number of files a submit may carry.
  opIndex: z.number().int().nonnegative().max(MAX_SHARE_PROPOSAL_OPS - 1),
  path: PATH_STRING,
  operation: ShareProposalOperation,
  // The granter's copy changed since the recipient sent this. Accepting still
  // works; it opens a conflict with a correct three-way base.
  drifted: z.boolean(),
  // How big the incoming side is. A row states this so the granter can judge a
  // file before opening it, and so the surface never has to fetch content to
  // describe it. null for a delete and for a size the relay did not state.
  afterByteLength: z.number().int().nonnegative().nullable(),
});
type ShareProposalFileRow = z.infer<typeof ShareProposalFileRow>;

export const ShareProposalRow = z.object({
  proposalId: SHARE_PROPOSAL_ID,
  shareId: OPAQUE_ID,
  // null when the relay could not state who sent the changes. The row stays
  // listed: reviewing them is still possible, and a missing email is damage
  // to state rather than a name to invent.
  proposedByEmail: EMAIL_STRING.nullable(),
  createdAtMs: z.number().int().nonnegative(),
  // How many files, not which ones. A timer polls this listing and renders a
  // sender and a count; carrying the rows made every tick cost the relay a
  // base resolution per file of every open proposal, to build rows no surface
  // read. `readShareProposalChanges` states the rows, for the one proposal a
  // granter opened.
  ops: z.number().int().nonnegative().max(MAX_SHARE_PROPOSAL_OPS),
});
export type ShareProposalRow = z.infer<typeof ShareProposalRow>;

export const ListShareProposalsResult = z.object({
  proposals: z.array(ShareProposalRow).max(MAX_SHARE_PROPOSAL_ROWS),
});
export type ListShareProposalsResult = z.infer<typeof ListShareProposalsResult>;

// One read for the whole review, and it carries NO content.
//
// It used to carry both sides' text for every file, which made opening a
// review cost one relay blob fetch and one local file read per file, all
// before the first row appeared — about 19 MB over this channel for a
// 500-file review, and the parse that would have refused an oversized body ran
// only after all of that work was already done. A review of a repository-sized
// folder was not openable at all.
//
// Now the read states what the rows say, and `readShareProposalFileContent`
// fetches one file's text when the granter opens that file.
export const ReadShareProposalChangesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  proposalId: SHARE_PROPOSAL_ID,
});
export type ReadShareProposalChangesPayload = z.infer<
  typeof ReadShareProposalChangesPayload
>;

export const ReadShareProposalChangesResult = z.object({
  proposedByEmail: EMAIL_STRING.nullable(),
  files: z.array(ShareProposalFileRow).max(MAX_SHARE_PROPOSAL_OPS),
});
export type ReadShareProposalChangesResult = z.infer<
  typeof ReadShareProposalChangesResult
>;

// One file's two sides, fetched when the granter opens that file.
export const ReadShareProposalFileContentPayload = z.object({
  workspaceId: WORKSPACE_ID,
  proposalId: SHARE_PROPOSAL_ID,
  // Which file, by its position in the submit. The renderer never names a
  // path: a path from the renderer is a path this process would then read, and
  // the granter's own files are what it would read them from.
  opIndex: z.number().int().nonnegative().max(MAX_SHARE_PROPOSAL_OPS - 1),
});
export type ReadShareProposalFileContentPayload = z.infer<
  typeof ReadShareProposalFileContentPayload
>;

export const ReadShareProposalFileContentResult = z.object({
  // The GRANTER's content now. null when the granter does not have the file,
  // or when it is not text this surface can show.
  currentText: WORKSPACE_EDITOR_TEXT.nullable(),
  // The proposal's after content. null for a delete, for binary content, for
  // content over the editor's text bound, and for content the relay would not
  // serve — every one of which the review states as "no preview" rather than
  // failing, because the granter can still decline what it cannot read.
  incomingText: WORKSPACE_EDITOR_TEXT.nullable(),
});
export type ReadShareProposalFileContentResult = z.infer<
  typeof ReadShareProposalFileContentResult
>;

export const SettleShareProposalPayload = z.object({
  workspaceId: WORKSPACE_ID,
  proposalId: SHARE_PROPOSAL_ID,
  decision: z.enum(["accept", "decline"]),
});
export type SettleShareProposalPayload = z.infer<
  typeof SettleShareProposalPayload
>;

export const SettleShareProposalResult = z.object({
  state: z.enum(["accepted", "declined"]),
});
export type SettleShareProposalResult = z.infer<typeof SettleShareProposalResult>;

export const SubmitShareChangesPayload = z.object({
  // The SHARE VIEW. Main resolves the share and its pinned grant from the
  // registry; a client-supplied share id is never trusted.
  workspaceId: WORKSPACE_ID,
});
export type SubmitShareChangesPayload = z.infer<typeof SubmitShareChangesPayload>;

// What a successful submit did. The new proposal's id is not among these
// facts: the surface re-reads its own sent changes right after, and an id that
// arrived by two routes would be two answers to one question.
const SubmitShareChangesSuccessResult = z.object({
  ok: z.literal(true),
  submitted: z.number().int().nonnegative(),
  // Local changes the submit's capture pass journaled or repaired. Repairs can
  // change the projection, so the renderer uses this count to repaint files.
  capturedLocalChanges: z.number().int().nonnegative(),
  // Files this submit did not offer because they are not part of this share.
  // The count does not distinguish a file that left the shared paths from one
  // that was never in them — both are the same fact to the person who pressed
  // send. Silently dropping them is the failure this states: some of their
  // work is not sent, and nothing says so.
  skippedOutsideShare: z.number().int().nonnegative().max(MAX_SHARE_PROPOSAL_OPS),
  // More changes are waiting than one submit carries. A flag rather than a
  // count: the scan stops AT the bound, so it never measures the remainder.
  morePending: z.boolean(),
});

// Capture happens before the relay submit. A relay failure can therefore
// leave local repair or materialization changes that the renderer still has
// to repaint. Electron does not preserve custom Error properties across
// ipcMain.handle/ipcRenderer.invoke, so the failure is an ordinary result.
const SubmitShareChangesFailureResult = z.object({
  ok: z.literal(false),
  capturedLocalChanges: z.number().int().nonnegative(),
  errorMessage: z.string(),
});

export const SubmitShareChangesResult = z.discriminatedUnion("ok", [
  SubmitShareChangesSuccessResult,
  SubmitShareChangesFailureResult,
]);
export type SubmitShareChangesResult = z.infer<typeof SubmitShareChangesResult>;

export async function resolveSubmitShareChangesResult(
  capturedLocalChanges: number,
  submit: () => Promise<{
    submitted: number;
    skippedOutsideShare: number;
    morePending: boolean;
  }>,
): Promise<SubmitShareChangesResult> {
  try {
    return SubmitShareChangesResult.parse({
      ok: true,
      ...(await submit()),
      capturedLocalChanges,
    });
  } catch (error) {
    return SubmitShareChangesResult.parse({
      ok: false,
      capturedLocalChanges,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export const PushShareDirectWritesPayload = z.object({
  // The SHARE VIEW, resolved to its share and pinned grant in main, like
  // SubmitShareChangesPayload.
  workspaceId: WORKSPACE_ID,
});
export type PushShareDirectWritesPayload = z.infer<typeof PushShareDirectWritesPayload>;

// A new Collection's batch is the largest write: its schema, an automations
// file, and 500 records.
const DirectWritePaths = z.array(z.string().min(1)).min(1).max(502);

// How one direct write to a Collection's own files ended (ADR 0013). A stale
// or refused write stays for Send changes.
export const DirectWriteRow = z.discriminatedUnion("result", [
  z.object({ result: z.literal("written"), paths: DirectWritePaths }),
  z.object({ result: z.literal("stale"), paths: DirectWritePaths, stalePath: z.string().min(1) }),
  z.object({ result: z.literal("refused"), paths: DirectWritePaths, reason: z.string() }),
]);
export type DirectWriteRow = z.infer<typeof DirectWriteRow>;

// One push's answer carries at most this many rows, over all its passes.
export const MAX_DIRECT_WRITE_ROWS = MAX_SHARE_PROPOSAL_OPS;
const DirectWriteRows = z.array(DirectWriteRow).max(MAX_DIRECT_WRITE_ROWS);

// What one push did. A failure is an ordinary result, for the reason a failed
// submit is one: Electron does not carry custom Error properties across IPC.
// `unavailable`: the relay knows no Edit grant of this person's on the share,
// because the owner ended the share or stopped them. `failed` keeps the writes answered before it;
// `lasting` says trying again will not help, as when the grant is not Edit.
export const PushShareDirectWritesResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pushed"), writes: DirectWriteRows }),
  z.object({ status: z.literal("unavailable") }),
  z.object({
    status: z.literal("failed"),
    writes: DirectWriteRows,
    errorMessage: z.string(),
    lasting: z.boolean(),
  }),
]);
export type PushShareDirectWritesResult = z.infer<typeof PushShareDirectWritesResult>;

// A direct push main ran after a save in this share view finished.
export const ShareDirectWritesPushedEvent = z.object({
  workspaceId: WORKSPACE_ID,
  result: PushShareDirectWritesResult,
});
export type ShareDirectWritesPushedEvent = z.infer<typeof ShareDirectWritesPushedEvent>;

export const ListMyShareChangesPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type ListMyShareChangesPayload = z.infer<typeof ListMyShareChangesPayload>;

export const MyShareChangeRow = z.object({
  proposalId: SHARE_PROPOSAL_ID,
  state: ShareProposalState,
  createdAtMs: z.number().int().nonnegative(),
  files: z.number().int().nonnegative().max(MAX_SHARE_PROPOSAL_OPS),
});
export type MyShareChangeRow = z.infer<typeof MyShareChangeRow>;

export const ListMyShareChangesResult = z.object({
  proposals: z.array(MyShareChangeRow).max(MAX_SHARE_PROPOSAL_ROWS),
});
export type ListMyShareChangesResult = z.infer<typeof ListMyShareChangesResult>;

export const WithdrawShareChangesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  proposalId: SHARE_PROPOSAL_ID,
});
export type WithdrawShareChangesPayload = z.infer<
  typeof WithdrawShareChangesPayload
>;

export const WithdrawShareChangesResult = z.object({
  state: z.literal("withdrawn"),
});
export type WithdrawShareChangesResult = z.infer<
  typeof WithdrawShareChangesResult
>;

// ---- Shared channels (MU-C4) ----
// A chat grant: a whole channel (threads + messages + reactions)
// shared to another relay account, read-write by default, read-only as the
// broadcast opt-in. Granted rows manage who a channel is shared with;
// received rows are invitations addressed to this account; joined rows are
// the ones pulled into a local workspace's chat store.

export const ChatShareAccess = z.enum(["read-write", "read-only"]);
export type ChatShareAccess = z.infer<typeof ChatShareAccess>;

const CHANNEL_WIRE_ID = z.string().min(1).max(256);

export const ShareChatChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  channelId: OPAQUE_ID,
  recipientEmail: EMAIL_STRING,
  access: ChatShareAccess.optional(),
});
export type ShareChatChannelPayload = z.infer<typeof ShareChatChannelPayload>;

export const ShareChatChannelResult = z.object({
  shareId: OPAQUE_ID,
});
export type ShareChatChannelResult = z.infer<typeof ShareChatChannelResult>;

// How many rows the RELAY lanes may carry in one listing. It bounds a body
// dohc did not write and must parse in one go, and readRelayChatShareLanes
// applies it before this schema sees them: a relay-controlled body over the
// cap would otherwise fail the parse below, reject the IPC call, and clear
// every cached row on the sharing surface.
//
// It does not gate joining. #640 deleted that use: the joined lane is now
// answered per channel the caller names, so its response size no longer
// depends on how many channels the account has ever joined, and nothing about
// the read needs a join to be refused. See scopeJoinedChannels.
export const MAX_CHAT_CHANNEL_SHARE_ROWS = 4096;

export const ChatChannelShareGrantRow = z.object({
  shareId: OPAQUE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  recipientEmail: EMAIL_STRING.nullable(),
  revokedAtMs: z.number().int().nonnegative().nullable(),
});
export type ChatChannelShareGrantRow = z.infer<typeof ChatChannelShareGrantRow>;

export const ChatChannelShareReceivedRow = z.object({
  subjectName: z.string().max(320).nullable().optional(),
  sharerName: z.string().max(320).nullable().optional(),
  shareId: OPAQUE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  granterEmail: EMAIL_STRING.nullable(),
});
export type ChatChannelShareReceivedRow = z.infer<typeof ChatChannelShareReceivedRow>;

export const JoinedSharedChannelRow = z.object({
  shareId: OPAQUE_ID,
  channelWireId: CHANNEL_WIRE_ID,
  access: ChatShareAccess,
  granterEmail: EMAIL_STRING.nullable(),
  ended: z.boolean(),
});
export type JoinedSharedChannelRow = z.infer<typeof JoinedSharedChannelRow>;

// The joined lane, answered one channel at a time.
//
// A caller names the channels it is showing and gets one answer per name:
// the registry row that gates that channel, or null when this workspace holds
// none. So the response is bounded by the caller's view, not by how many
// channels the account has ever joined — which is what lets tombstones be
// kept for as long as the write gate needs them, with no reaping and no
// compaction.
//
// A wire id the caller did not name is absent, and absent means UNKNOWN.
// Unknown locks the channel, exactly as an unresolved listing does: the
// renderer must never read a channel it has no gate row for as one it owns.
export const JoinedChannelAnswer = z.object({
  channelWireId: CHANNEL_WIRE_ID,
  joined: JoinedSharedChannelRow.nullable(),
});
export type JoinedChannelAnswer = z.infer<typeof JoinedChannelAnswer>;

// The wire ids a caller is showing. No cap, and it must not gain one: it is
// the caller's own channel list (ListChatChannelsResult carries no cap
// either), so a cap here could only reject a workspace for having channels.
const SHOWN_CHANNEL_WIRE_IDS = z.array(CHANNEL_WIRE_ID);

export const ListChatChannelSharesPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The channels the caller is showing. The answer covers these plus the
  // received invitations it returns — the caller cannot name those yet,
  // because this call is what tells it they exist.
  channelWireIds: SHOWN_CHANNEL_WIRE_IDS,
});
export type ListChatChannelSharesPayload = z.infer<typeof ListChatChannelSharesPayload>;

// The granted/received rows live on the relay; the joined rows are local.
// The relay side carries which of three different facts it learned, because
// each one means something different for cached rows:
//  - "answered": the relay's rows, authoritative (empty means no shares).
//  - "unreachable": the relay did not answer. Not an empty listing — the
//    caller keeps what it already knows.
//  - "signed-out": there is no valid session (signed out, expired, switched
//    account). Account-scoped rows do not exist for this caller, so cached
//    rows must clear — another account's invitations and recipient emails
//    must not survive a logout.
export const ListChatChannelSharesResult = z.object({
  // One answer per channel this listing covers: the caller's own
  // channelWireIds plus the received invitations below, because the sharing
  // surface shows those too and decides for each one whether this workspace
  // has already joined it.
  //
  // NO row cap, and it must not gain one. These are dohc's own registry rows
  // and they are the authority for channelIsLocked: a read that refuses them
  // rejects the whole IPC call, the renderer reads an unknown listing, and
  // every channel goes read-only. Nothing needs a cap here now — the
  // caller's view bounds the size.
  joined: z.array(JoinedChannelAnswer),
  // The account the relay lanes are scoped to (server + stable user id), or
  // null when no session exists. Cached relay rows are preservable only
  // within the same session: an unreachable answer under a different account
  // must never preserve another account's rows.
  sessionKey: z.string().nullable(),
  relay: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("answered"),
      granted: z.array(ChatChannelShareGrantRow).max(MAX_CHAT_CHANNEL_SHARE_ROWS),
      received: z.array(ChatChannelShareReceivedRow).max(MAX_CHAT_CHANNEL_SHARE_ROWS),
      // Share ids whose owner removed this account, as the relay confirms.
      // Only this lane may say "the owner removed your access".
      removed: z.array(OPAQUE_ID).max(1000).default([]),
    }),
    z.object({ state: z.literal("unreachable") }),
    // Over the per-lane cap. Not "unreachable": that word means dohc could not
    // read the answer, and a retry is the right next step for it. This answer
    // arrived and will arrive again identically, so a surface that shows it as
    // an outage offers a Try again that can never work and never says what is
    // wrong — the defect, reintroduced for the one condition dohc's own
    // cap creates. It carries what it observed and the configured limit so the
    // surface can name the constraint. Like "unreachable" it is not
    // authoritative: cached rows stand.
    z.object({
      state: z.literal("over-limit"),
      lanes: z
        .array(
          z.object({
            lane: z.enum(["granted", "received"]),
            rows: z.number().int().nonnegative(),
          }),
        )
        .min(1)
        .max(2),
      limit: z.number().int().positive(),
    }),
    z.object({ state: z.literal("signed-out") }),
  ]),
});
export type ListChatChannelSharesResult = z.infer<typeof ListChatChannelSharesResult>;

// The joined rows alone, read from the local registry. listChatChannelShares
// answers the same rows, but it asks the relay for the grant side first, so a
// caller that only needs to know what this machine joined would wait on the
// network for an answer the network does not hold.
export const ListJoinedSharedChannelsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // The channels the caller is showing. This read talks to nothing but the
  // registry, so it answers exactly these and nothing else.
  channelWireIds: SHOWN_CHANNEL_WIRE_IDS,
});
export type ListJoinedSharedChannelsPayload = z.infer<
  typeof ListJoinedSharedChannelsPayload
>;

export const ListJoinedSharedChannelsResult = z.object({
  // One answer per named channel, and no row cap — see
  // ListChatChannelSharesResult.
  joined: z.array(JoinedChannelAnswer),
});
export type ListJoinedSharedChannelsResult = z.infer<
  typeof ListJoinedSharedChannelsResult
>;

export const JoinSharedChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: OPAQUE_ID,
});
export type JoinSharedChannelPayload = z.infer<typeof JoinSharedChannelPayload>;

export const JoinSharedChannelResult = z.object({
  joined: JoinedSharedChannelRow,
});
export type JoinSharedChannelResult = z.infer<typeof JoinSharedChannelResult>;

export const LeaveSharedChannelPayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: OPAQUE_ID,
});
export type LeaveSharedChannelPayload = z.infer<typeof LeaveSharedChannelPayload>;

export const OpenSharedViewPayload = z.object({
  shareCode: z.string().min(1).max(4096),
  rootPath: PATH_STRING,
});
export type OpenSharedViewPayload = z.infer<typeof OpenSharedViewPayload>;

export const OpenSharedViewResult = z.object({
  workspace: WorkspaceSummary,
});
export type OpenSharedViewResult = z.infer<typeof OpenSharedViewResult>;

export const RefreshSharedViewPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type RefreshSharedViewPayload = z.infer<typeof RefreshSharedViewPayload>;

// Clearing a share's durable skip record. The content those ops carried is
// still missing — this says the user has seen the warning, which is the only
// honest recovery this surface can offer.
export const DismissShareSkipsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  // Absent clears the workspace's own shared view; a shareId clears one
  // mounted share's record.
  shareId: OPAQUE_ID.optional(),
  // The generation the user saw. A refusal recorded after that render has a
  // higher generation, so it stays unacknowledged and speaks up again.
  generation: z.number().int().nonnegative(),
});
export type DismissShareSkipsPayload = z.infer<typeof DismissShareSkipsPayload>;

// ---- Collection automations (the ⚡ panel) ----
// Main parses and writes automations.yaml, so the renderer never loads the
// file contract. A shared view holds no executor, so it answers
// "unavailable": its automations run on the owner's computer.
const COLLECTION_AUTOMATION_ID = z.string().min(1).max(4096);

export const ListCollectionAutomationsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
});
export type ListCollectionAutomationsPayload = z.infer<typeof ListCollectionAutomationsPayload>;
export type ListCollectionAutomationsResult = CollectionAutomationsFile | { status: "unavailable" };

// One page of an automation's runs, newest first. `before` is the `next`
// of the page before; `next` is null after the oldest.
export const ListCollectionAutomationRunsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
  before: z.string().min(1).max(512).optional(),
});
export type ListCollectionAutomationRunsPayload = z.infer<typeof ListCollectionAutomationRunsPayload>;
// A shared view keeps no runs: its automations run on the owner's computer.
export type ListCollectionAutomationRunsResult =
  | { status: "listed"; runs: CollectionAutomationRun[]; next: string | null }
  | { status: "unavailable" };

// One run however old, as run history lists it, such as the run a notice opens.
export const GetCollectionAutomationRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
  claimId: z.string().min(1).max(256),
  onServer: z.boolean(),
});
export type GetCollectionAutomationRunPayload = z.infer<typeof GetCollectionAutomationRunPayload>;
export type GetCollectionAutomationRunResult =
  | { status: "found"; run: CollectionAutomationRun }
  | { status: "missing" }
  | { status: "unavailable" };

// The runs the owner's self-hosted server made, newest first. Read apart
// from this computer's, so those show without waiting on the server. Null
// when the server has no copy of the workspace, or this computer cannot ask
// as its owner.
export const ListServerAutomationRunsPayload = ListCollectionAutomationRunsPayload;
export type ListServerAutomationRunsPayload = z.infer<typeof ListServerAutomationRunsPayload>;
export type ListServerAutomationRunsResult = { runs: CollectionAutomationRun[] | null; next: string | null };

// Try again for a failed run. `startOver` confirms running an automation
// that changed since the run began from its first step. `onServer` names a
// run the owner's self-hosted server made, which runs again there.
export const RetryCollectionAutomationPayload = z.object({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
  claimId: z.string().min(1).max(256),
  startOver: z.boolean(),
  onServer: z.boolean(),
});
export type RetryCollectionAutomationPayload = z.infer<typeof RetryCollectionAutomationPayload>;
export type RetryCollectionAutomationResult = CollectionAutomationRetry;

// The builder's Collection picker: every Collection, with why a step in
// this Collection's automations cannot reach it, or null.
export const ListAutomationTargetsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
});
export type ListAutomationTargetsPayload = z.infer<typeof ListAutomationTargetsPayload>;
export type ListAutomationTargetsResult = { collections: CollectionAutomationTarget[] } | { status: "unavailable" };

// The builder's Group pickers: the Groups on this computer, with why one
// cannot start this Collection's automations or take their posts, or null.
// A shared view gets none: its automations run on the owner's computer.
export const ListAutomationGroupsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
});
export type ListAutomationGroupsPayload = z.infer<typeof ListAutomationGroupsPayload>;
export type ListAutomationGroupsResult = { groups: CollectionAutomationGroup[] } | { status: "unavailable" };

// The builder's people pickers, for Direct message and Notify steps: this
// computer's person and each person who accepted a share, by the name the
// owner knows them by, with why a step cannot reach one, or null. A shared
// view gets nobody: its automations run on the owner's computer.
export const ListAutomationPeoplePayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
});
export type ListAutomationPeoplePayload = z.infer<typeof ListAutomationPeoplePayload>;
export type ListAutomationPeopleResult = CollectionAutomationPeople | { status: "unavailable" };

// The builder checks a draft the way saving would: what the file contract
// refuses, the syntax error of each formula and message in it, at its JSON
// Pointer from the automation, why dohc would not run it in its
// Collection, and the code files its steps name that the Collection's
// folder lacks. Neither stops a save. Nothing runs.
export const CheckCollectionAutomationPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
  automation: z.custom<Automation>((value) => typeof value === "object" && value !== null && !Array.isArray(value)),
});
export type CheckCollectionAutomationPayload = z.infer<typeof CheckCollectionAutomationPayload>;
export type CheckCollectionAutomationResult = {
  diagnostics: AutomationDiagnostic[];
  formulaProblems: Array<{ path: string; problem: string } | { path: string; code: AutomationDiagnostic["code"] }>;
  cannotRun: string | null;
  /** Each code file a step names, relative to the Collection's folder, that dohc cannot find. */
  missingFiles: string[];
};

// Undo for a finished run, as the person who clicked it. `deletes` is null
// until the person confirms the preview of a run that added dataset records;
// then it carries that preview's token and the delete they chose for each
// choice it asked.
export const UndoCollectionAutomationRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
  claimId: z.string().min(1).max(256),
  deletes: z.object({
    token: z.string().min(1).max(128),
    chosen: z.array(z.object({ key: z.string().min(1).max(16_384), operationId: z.string().min(1).max(256) })).max(64),
  }).nullable(),
  onServer: z.boolean(),
});
export type UndoCollectionAutomationRunPayload = z.infer<typeof UndoCollectionAutomationRunPayload>;
export type UndoCollectionAutomationRunResult = CollectionAutomationUndo;

// Stop and restore (ADR 0013): the owner stops a person they shared with,
// or ends an Edit share link, and puts back what it wrote directly. Main
// finds the grants on this workspace from the relay; the renderer names only
// the person or the link's grant.
export const StopAndRestoreTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("link"), grantId: OPAQUE_ID }).strict(),
]);
export type StopAndRestoreTarget = z.infer<typeof StopAndRestoreTarget>;
export const StopAndRestorePayload = z.object({
  workspaceId: WORKSPACE_ID,
  target: StopAndRestoreTarget,
}).strict();
export type StopAndRestorePayload = z.infer<typeof StopAndRestorePayload>;
export const StopAndRestoreResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("restored"),
    // Each file put back, with the forward moment its Undo restores before.
    restored: z.array(z.object({ path: PATH_STRING, restoredMomentId: OPAQUE_ID })),
    // Files left for the owner to check, each with why.
    review: z.array(z.discriminatedUnion("reason", [
      z.object({ path: PATH_STRING, reason: z.literal("changed-since") }).strict(),
      z.object({ path: PATH_STRING, reason: z.literal("folder-in-use") }).strict(),
      z.object({ path: PATH_STRING, reason: z.literal("restore-refused"), detail: z.string().max(2_000) }).strict(),
    ])),
    // Runs of the person's automations undone, and those Undo could not undo.
    runsUndone: z.number().int().nonnegative(),
    runsLeft: z.number().int().nonnegative(),
    // Changes the undone runs made that stay as they are.
    runChangesKept: z.number().int().nonnegative(),
    // They wrote automations: runs another computer holds are not undone here.
    wroteAutomations: z.boolean(),
    // One of those automations sends messages, which no Undo takes back.
    sendsMessages: z.boolean(),
    // Fields those runs wrote that kept a later value, and fields on records
    // no longer in their Collection.
    fieldsKept: z.number().int().nonnegative(),
    fieldsMissing: z.number().int().nonnegative(),
    // What stopped the restore part way; the files above were restored.
    errorMessage: z.string().nullable(),
  }).strict(),
  // Access stopped, but this computer has not received every change the
  // person wrote yet. Nothing was restored; trying again continues.
  z.object({ status: z.literal("waiting") }).strict(),
]);
export type StopAndRestoreResult = z.infer<typeof StopAndRestoreResult>;
export const UndoStopAndRestorePayload = z.object({
  workspaceId: WORKSPACE_ID,
  restoredMomentIds: z.array(OPAQUE_ID).min(1).max(20_000),
}).strict();
export type UndoStopAndRestorePayload = z.infer<typeof UndoStopAndRestorePayload>;

// A current editor allows a step that became reachable only because an
// editor left. `seq` names the hold the person saw.
export const ConfirmCollectionAutomationStepPayload = z.object({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
  definitionHash: z.string().regex(/^[a-f0-9]{16}$/),
  step: z.string().min(1).max(512),
  seq: z.number().int().nonnegative(),
  // A person a formula named, or a Collection a code step named, whose hold this is.
  recipient: z.string().min(1).max(1_024).optional(),
  // The step waits on the owner's self-hosted server.
  onServer: z.boolean(),
});
export type ConfirmCollectionAutomationStepPayload = z.infer<typeof ConfirmCollectionAutomationStepPayload>;
export type ConfirmCollectionAutomationStepResult = { status: "confirmed" | "changed" };

// Steps waiting for a current editor to allow them, one notice each, and
// steps a narrower share stopped, one notice for all of them.
export const ListAutomationHoldsPayload = z.object({ workspaceId: WORKSPACE_ID, retryPath: z.string().optional() });
export type ListAutomationHoldsPayload = z.infer<typeof ListAutomationHoldsPayload>;
export type ListAutomationHoldsResult = CollectionAutomationHolds;

// Steps the owner's self-hosted server holds for Allow. Read apart from this
// computer's own holds, so showing those never waits on the server.
export const ListServerAutomationHoldsPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ListServerAutomationHoldsPayload = z.infer<typeof ListServerAutomationHoldsPayload>;
export type ListServerAutomationHoldsResult = { holds: CollectionAutomationHolds["holds"] };

// After the saved verdicts could not be read, hold every step the roster
// allows now. "roster-unknown" means dohc cannot check who can edit yet.
export const ResetAutomationHoldsPayload = z.object({ workspaceId: WORKSPACE_ID });
export type ResetAutomationHoldsPayload = z.infer<typeof ResetAutomationHoldsPayload>;
export type ResetAutomationHoldsResult = { status: "reset" | "roster-unknown" };
export const RevealAutomationHoldsPayload = z.object({ workspaceId: WORKSPACE_ID });
export type RevealAutomationHoldsPayload = z.infer<typeof RevealAutomationHoldsPayload>;
// Dismisses the stopped-steps notice. `seq` names each step's verdict the
// person saw, so a step that stopped again since keeps its notice.
export const DismissAutomationStopsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  stops: z.array(z.object({
    automationId: COLLECTION_AUTOMATION_ID,
    definitionHash: z.string().regex(/^[a-f0-9]{16}$/),
    step: z.string().min(1).max(512),
    seq: z.number().int().nonnegative(),
  })).max(1_000),
});
export type DismissAutomationStopsPayload = z.infer<typeof DismissAutomationStopsPayload>;

// The automation steps a share with these paths and access would stop,
// asked before the share is made. `recipientEmail` is null for a link,
// which makes an editor of whoever opens it.
export const AutomationShareImpactPayload = z.object({
  workspaceId: WORKSPACE_ID,
  recipientEmail: EMAIL_STRING.nullable(),
  paths: z.array(PATH_STRING).min(1).max(100),
  access: SHARE_ACCESS,
});
export type AutomationShareImpactPayload = z.infer<typeof AutomationShareImpactPayload>;
export type AutomationShareImpactResult = { stops: CollectionAutomationShareStop[] };

// The fields in one Collection that switched-on automations set, for the
// ⚡ marks on the table and the record's properties. A document Collection
// is named by its folder, and a dataset Collection by its id and table.
export const ListCollectionFieldMarksPayload = z.union([
  z.strictObject({ workspaceId: WORKSPACE_ID, collectionPath: PATH_STRING }),
  z.strictObject({ workspaceId: WORKSPACE_ID, datasetId: z.uuid(), table: z.string().min(1).max(256) }),
]);
export type ListCollectionFieldMarksPayload = z.infer<typeof ListCollectionFieldMarksPayload>;
export type ListCollectionFieldMarksResult = { marks: CollectionFieldMark[] };

// The folder that holds a dataset Collection's automations.yaml, which the
// ⚡ panel reads and saves, or why dohc cannot run its automations. A
// shared view holds no executor: its automations run on the owner's computer.
export const FindDatasetCollectionPayload = z.strictObject({
  workspaceId: WORKSPACE_ID,
  datasetId: z.uuid(),
});
export type FindDatasetCollectionPayload = z.infer<typeof FindDatasetCollectionPayload>;
export type FindDatasetCollectionResult =
  | { status: "found"; collectionPath: string }
  | { status: "cannot-run"; reason: string }
  | { status: "unavailable" };

// Where an automation's Collection is now, found by its Collection id, so
// Open automation follows a Collection that moved. A shared view holds no
// executor.
export const FindAutomationCollectionPayload = z.strictObject({
  workspaceId: WORKSPACE_ID,
  automationId: COLLECTION_AUTOMATION_ID,
});
export type FindAutomationCollectionPayload = z.infer<typeof FindAutomationCollectionPayload>;
export type FindAutomationCollectionResult =
  | { status: "found"; collectionPath: string }
  | { status: "missing" }
  | { status: "unavailable" };

// Replaces the file's automations with these, over the content the panel
// read (null when the file did not exist). `reformat` is the person's
// agreement to lose the file's comments and hand formatting.
export const WriteCollectionAutomationsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  collectionPath: PATH_STRING,
  expectedContentHash: WORKSPACE_TEXT_CONTENT_HASH.nullable(),
  // The shape is only checked here; main's writer reads its own text back
  // and refuses anything the file contract would not produce.
  automations: z.array(z.custom<Automation>((value) => typeof value === "object" && value !== null && !Array.isArray(value))).max(50),
  reformat: z.boolean(),
});
export type WriteCollectionAutomationsPayload = z.infer<typeof WriteCollectionAutomationsPayload>;
export type WriteCollectionAutomationsResult =
  | { status: "written"; contentHash: string }
  | { status: "conflict" }
  // The file has entries dohc cannot read; it has to be fixed by hand.
  | { status: "unreadable" }
  // The writer would lose the file's comments or hand formatting, and the
  // person has not agreed to that. Nothing was written.
  | { status: "reformats" }
  | { status: "refused"; diagnostics: AutomationDiagnostic[] }
  | { status: "unavailable" };

// ---- Button fields ----
// Main decides which automation a button runs and who may press it. A window
// makes a UUID for each press and sends it again after a lost reply. The
// person a press acts for is main's own signed-in person, never a value a
// window sends. A document Collection is named by its folder, and a dataset
// Collection by its id.
export const ListAutomationButtonsPayload = z.union([
  z.strictObject({ workspaceId: WORKSPACE_ID, collectionPath: PATH_STRING }),
  z.strictObject({ workspaceId: WORKSPACE_ID, datasetId: z.uuid() }),
]);
export type ListAutomationButtonsPayload = z.infer<typeof ListAutomationButtonsPayload>;
/** A Button field, with its dataset table's name; null in a document Collection. */
export type ListedAutomationButton = CollectionAutomationButton & { table: string | null };
export type ListAutomationButtonsResult = { buttons: ListedAutomationButton[] };

// The record an open file is, and its Collection's buttons. Null when the
// file is not a record in a Collection.
export const ListRecordButtonsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  path: PATH_STRING,
});
export type ListRecordButtonsPayload = z.infer<typeof ListRecordButtonsPayload>;
export type ListRecordButtonsResult =
  | { record: null }
  | { record: CollectionRecord; collectionPath: string; buttons: CollectionAutomationButton[] };

const PressedButton = {
  workspaceId: WORKSPACE_ID,
  field: z.string().min(1).max(256),
  // A document record's id, or a dataset record's primary key as JSON.
  recordId: z.string().min(1).max(1024),
  pressId: z.uuid(),
};
export const PressAutomationButtonPayload = z.union([
  z.strictObject({ ...PressedButton, collectionPath: PATH_STRING }),
  // `confirmed` holds the operation names of the actions the person was told can't be undone and chose to run.
  z.strictObject({ ...PressedButton, datasetId: z.uuid(), table: z.string().min(1).max(256), confirmed: z.array(z.string().max(256)).max(64).optional() }),
]);
export type PressAutomationButtonPayload = z.infer<typeof PressAutomationButtonPayload>;
export type PressAutomationButtonResult =
  // `settled` is set when a press sent again finds its run already ended;
  // otherwise the window hears the end as an automation run event.
  | { busy: false; claimId: string; settled: Omit<PressSettled, "claimId"> | null }
  // A shared view's press went to the relay, to run on the owner's computer.
  // Its changes arrive as synced edits, and a failure as a notice.
  | { busy: false; relayed: true }
  // The button is running on this record for someone else.
  | { busy: true; reason: string };

/** Main to the pressing window: the engine settled the press's run. */
export type AutomationRunSettledEvent = PressSettled & { workspaceId: string };
/** Main to the pressing window: the run waits, and why. */
export type AutomationRunWaitingEvent = { workspaceId: string; claimId: string; reason: PressWaitReason };

const RefreshSharedViewSuccessResult = z.object({
  ok: z.literal(true),
  // "ended" means the granter revoked the share: the local view stays
  // readable but stops refreshing, and the UI says so honestly.
  status: z.enum(["updated", "unchanged", "ended"]),
  changedPaths: z.number().int().nonnegative(),
  excludedPaths: z.array(z.string()),
  unjournalablePaths: z.array(
    z.object({
      path: z.string(),
      reason: z.enum([
        "oversized-text",
        "oversized-binary",
        "non-utf8",
        "non-file-replacement",
        "local-collision",
        "unreadable",
      ]),
    }),
  ),
  collisionRecordQuarantined: z.boolean().optional(),
  // Ops the pull refused. It skips them and keeps going, so a view that
  // quietly stopped carrying part of the share is invisible without this.
  refusedOps: z.number().int().nonnegative(),
  // The first refusal's engine message, for the banner's title attribute and
  // the log. Null when nothing was refused.
  refusedDetail: z.string().nullable(),
});

const RefreshSharedViewFailureResult = z.object({
  ok: z.literal(false),
  // Capture runs before the pull. A failed pull can still leave repaired
  // projection files that the renderer must repaint.
  changedPaths: z.number().int().nonnegative(),
  errorMessage: z.string(),
});

export const RefreshSharedViewResult = z.discriminatedUnion("ok", [
  RefreshSharedViewSuccessResult,
  RefreshSharedViewFailureResult,
]);
export type RefreshSharedViewResult = z.infer<typeof RefreshSharedViewResult>;

// ---- Share mounts ----
// The receive side of a relay share materialized inside a host workspace as
// shared-with-me/<label>/ — ordinary read-only files (agent-readable through
// normal tools) that live-follow the share. Mounting/refreshing/unmounting
// are host-workspace operations; every path and label is re-validated in
// main before any disk effect.

export const MountSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareCode: z.string().min(1).max(4096),
});
export type MountSharePayload = z.infer<typeof MountSharePayload>;

export const ShareMountStatusRow = z.object({
  shareId: OPAQUE_ID,
  label: z.string().min(1).max(64),
  // "damaged": this mount's stored pin cannot be read, so it will never
  // refresh again. Permanent, like an ended share, and reported per ROW so
  // one damaged record cannot stop the other mounts refreshing — which it
  // could not do at all until this schema carried the word.
  status: z.enum(["updated", "unchanged", "ended", "damaged"]),
  changedPaths: z.number().int().nonnegative(),
});
export type ShareMountStatusRow = z.infer<typeof ShareMountStatusRow>;

export const MountShareResult = z.object({
  workspace: WorkspaceSummary,
  mount: ShareMountStatusRow,
});
export type MountShareResult = z.infer<typeof MountShareResult>;

export const RefreshShareMountsPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type RefreshShareMountsPayload = z.infer<typeof RefreshShareMountsPayload>;

export const RefreshShareMountsResult = z.object({
  results: z.array(ShareMountStatusRow).max(200),
});
export type RefreshShareMountsResult = z.infer<typeof RefreshShareMountsResult>;

export const UnmountSharePayload = z.object({
  workspaceId: WORKSPACE_ID,
  shareId: OPAQUE_ID,
});
export type UnmountSharePayload = z.infer<typeof UnmountSharePayload>;

export const UnmountShareResult = z.object({
  workspace: WorkspaceSummary,
  // The registry record was removed but its folder was left on disk, because
  // the record's label is not one this app would ever materialize through.
  // Removing a folder named by an unusable label is exactly what the label
  // validator exists to prevent, so the record is cleaned up and the folder
  // is reported instead of touched.
  folderLeft: z.literal(true).optional(),
});
export type UnmountShareResult = z.infer<typeof UnmountShareResult>;

// Local agent integration. An agent run is a LOCAL concept: a small
// record persisted to .dohc/agent-runs.json. Enabling a run (optionally) spawns
// the managed MCP stdio child for the workspace and sets the watcher's
// active-run slot, so the run's writes are attributed to the agent.
export const AgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
});
export type AgentRunPayload = z.infer<typeof AgentRunPayload>;

export const EndAgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  runId: OPAQUE_ID,
  status: z.enum(["complete", "failed"]).optional(),
});
export type EndAgentRunPayload = z.infer<typeof EndAgentRunPayload>;

const AgentRunRecordSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  agentId: z.string(),
  onBehalfOf: z.string(),
  status: z.enum(["running", "complete", "failed"]),
});

export const StartAgentRunResult = AgentRunRecordSchema;
export type StartAgentRunResult = z.infer<typeof StartAgentRunResult>;

export const AgentRunStatusResult = z.object({
  mcpEnabled: z.boolean(),
  activeRun: AgentRunRecordSchema.nullable(),
  lastRun: AgentRunRecordSchema.nullable(),
});
export type AgentRunStatusResult = z.infer<typeof AgentRunStatusResult>;

// The copyable MCP config the user pastes into their AI tool. Main owns the
// real command/args (the renderer never invents a path or argv).
export const McpConfigResult = z.union([
  z.object({
    unavailable: z.literal(true),
    message: z.string(),
  }),
  z.object({
    command: z.string(),
    args: z.array(z.string()),
    workspacePath: z.string(),
    home: z.string(),
  }),
]);
export type McpConfigResult = z.infer<typeof McpConfigResult>;

export const RunnerSelfTestPayload = z.object({
  workspaceId: WORKSPACE_ID,
}).strict();
export type RunnerSelfTestPayload = z.infer<typeof RunnerSelfTestPayload>;

export const StopAgentRunPayload = z.object({
  workspaceId: WORKSPACE_ID,
  runId: OPAQUE_ID,
}).strict();
export type StopAgentRunPayload = z.infer<typeof StopAgentRunPayload>;

export const ResumeThreadDispatchPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
}).strict();
export type ResumeThreadDispatchPayload = z.infer<
  typeof ResumeThreadDispatchPayload
>;

export const ChatDispatchStateForThreadPayload = z.object({
  workspaceId: WORKSPACE_ID,
  threadId: OPAQUE_ID,
}).strict();
export type ChatDispatchStateForThreadPayload = z.infer<
  typeof ChatDispatchStateForThreadPayload
>;

export const ChatDispatchStateForThreadResult = z.object({
  liveRunId: OPAQUE_ID.nullable(),
  pendingCount: z.number().int().nonnegative(),
  paused: z.boolean(),
  pausedReason: z.string().min(1).max(500).optional(),
}).strict();
export type ChatDispatchStateForThreadResult = z.infer<
  typeof ChatDispatchStateForThreadResult
>;

export const RunnerSelfTestResult = z.object({
  ok: z.boolean(),
  detail: z.string().min(1).max(2_000),
}).strict();
export type RunnerSelfTestResult = z.infer<typeof RunnerSelfTestResult>;

export const DesktopUserSettings = DesktopUserSettingsSchema;
export const DesktopUserSettingsResult = DesktopUserSettingsResultSchema;
export type DesktopUserSettings = DesktopUserSettingsType;
export type DesktopUserSettingsResult = DesktopUserSettingsResultType;

// `base` is the settings the caller changed. Main writes only the difference,
// so a caller that has not yet seen an edit made in the file cannot undo it.
// Pins or unpins one app in one workspace's sidebar.
export const SetAppPinnedPayload = z.object({
  workspaceId: WORKSPACE_ID,
  appRoot: SITE_ROOT_STRING,
  pinned: z.boolean(),
}).strict();
export type SetAppPinnedPayload = z.infer<typeof SetAppPinnedPayload>;

export const SetUserSettingsPayload = z.object({
  settings: DesktopUserSettingsSchema,
  base: DesktopUserSettingsSchema,
}).strict();
export type SetUserSettingsPayload = z.infer<typeof SetUserSettingsPayload>;

export const WorkspaceSettings = WorkspaceSettingsSchema;
export const WorkspaceSettingsResult = WorkspaceSettingsResultSchema;
export type WorkspaceSettings = WorkspaceSettingsType;
export type WorkspaceSettingsResult = WorkspaceSettingsResultType;

export const WorkspaceSettingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
}).strict();
export type WorkspaceSettingsPayload = z.infer<typeof WorkspaceSettingsPayload>;

// A save carries the changed controls, not the whole file: main merges them
// onto the settings on disk, so a stale caller cannot write back fields it
// never touched.
export const SetWorkspaceSettingsPayload = z.object({
  workspaceId: WORKSPACE_ID,
  patch: WorkspaceSettingsPatchSchema,
}).strict();
export type SetWorkspaceSettingsPayload = z.infer<typeof SetWorkspaceSettingsPayload>;

export const WriteClipboardTextPayload = z.object({
  text: z.string().min(1).max(20_000),
}).strict();
export type WriteClipboardTextPayload = z.infer<typeof WriteClipboardTextPayload>;

// Native window chrome. The renderer mirrors its theme flip to
// main so the OS titleBarOverlay (Windows/Linux) re-tints with the app; main
// feature-detects overlay support and no-ops where it doesn't exist.
export const SetTitlebarThemePayload = z.object({
  theme: z.enum(["light", "dark"]),
});
export type SetTitlebarThemePayload = z.infer<typeof SetTitlebarThemePayload>;

// One zoom mutation, owned by main: it persists appearance.zoomLevel before
// applying it to the windows, and answers with the settings now on disk so
// the caller can paint the level in effect. The menu accelerators call the
// same mutation directly in main; this channel is for the palette and the
// Settings stepper.
export const StepWindowZoomPayload = z.object({
  step: z.enum(ZOOM_STEPS),
}).strict();
export type StepWindowZoomPayload = z.infer<typeof StepWindowZoomPayload>;

// Application-menu commands. The menu sends these names and the shell routes
// them through the same command registry the palette uses — menu items never
// grow their own action definitions.
export const MenuCommand = z.enum(MENU_COMMANDS);
export type MenuCommand = z.infer<typeof MenuCommand>;

// Main→renderer auto-update event. Only public status/action metadata crosses
// the boundary; feed URLs and updater configuration stay main-process-only.
export const UpdateStateEvent = z.object({
  status: z.enum(UPDATE_STATUSES),
  message: z.string().min(1).max(500),
  currentVersion: z.string().min(1).max(200).optional(),
  channel: z.enum(UPDATE_CHANNELS).optional(),
  canCheck: z.boolean().optional(),
  canInstall: z.boolean().optional(),
  version: z.string().min(1).max(200).optional(),
  percent: z.number().finite().min(0).max(100).optional(),
});
export type UpdateStateEvent = z.infer<typeof UpdateStateEvent>;

export const UpdateActionResult = z.object({
  accepted: z.boolean(),
  // True when the exit round was cancelled: a window's recovery dialog
  // went back. A decision, not an install failure.
  cancelled: z.boolean().optional(),
  state: UpdateStateEvent,
});
export type UpdateActionResult = z.infer<typeof UpdateActionResult>;

// One exit round message from main. `request` asks this window whether a
// quit or update may lose its set-aside drafts; `proceed` and `cancelled`
// close the round.
export const ExitRoundMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("request"),
    roundId: z.number().int().positive(),
    exit: z.enum(["quit", "update"]),
  }),
  z.object({ kind: z.literal("proceed"), roundId: z.number().int().positive() }),
  z.object({ kind: z.literal("cancelled"), roundId: z.number().int().positive() }),
]);
export type ExitRoundMessage = z.infer<typeof ExitRoundMessage>;
export const ExitRoundAnswerPayload = z.object({
  roundId: z.number().int().positive(),
  decision: z.enum(["clear", "hold", "cancel"]),
});
export type ExitRoundAnswerPayload = z.infer<typeof ExitRoundAnswerPayload>;

export const UpdateCheckResult = z.object({
  checked: z.boolean(),
  state: UpdateStateEvent,
});
export type UpdateCheckResult = z.infer<typeof UpdateCheckResult>;

// Per-workspace UI state persisted to .dohc/ui-state.json by MAIN (the
// renderer cannot write .dohc through writeWorkspaceText by design —
// validateUserWritePath refuses reserved paths). The clamp/cap constants are
// the pure workbench model's, so contract and model can never disagree.
const WorkspaceEditorGroup = z
  .object({
    id: z.string().min(1).max(MAX_EDITOR_GROUP_ID_CHARS),
    tabs: z.array(PATH_STRING).max(MAX_OPEN_TABS),
    activeTab: PATH_STRING.nullable(),
    size: z.number().finite().positive().max(1),
  })
  .superRefine((group, context) => {
    const uniqueTabs = new Set(group.tabs);
    if (uniqueTabs.size !== group.tabs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tabs"],
        message: "Editor group tabs must be unique.",
      });
    }
    if (
      (group.tabs.length === 0 && group.activeTab !== null) ||
      (group.tabs.length > 0 &&
        (group.activeTab === null || !uniqueTabs.has(group.activeTab)))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeTab"],
        message: "The active tab must belong to its editor group.",
      });
    }
  });

const WorkspaceEditorGroups = z.preprocess(
  (value, context) => {
    if (Array.isArray(value) && value.length > MAX_EDITOR_GROUPS) {
      context.addIssue({
        code: "custom",
        message: `Editor groups exceed the configured limit of ${MAX_EDITOR_GROUPS} groups (observed ${value.length} groups).`,
      });
      return z.NEVER;
    }
    return value;
  },
  z.array(WorkspaceEditorGroup).min(1),
);

// A pinned app's view: its folder, where each character can encode to nine.
const APP_VIEW_ID = z
  .string()
  .max(APP_VIEW_ID_PREFIX.length + 4096 * 9)
  .refine((value) => parseAppViewId(value) !== null);

export const WorkspaceUiState = z.object({
  version: z.literal(3),
  // dohc's own views or a pinned app. The catch keeps a stored id that names
  // neither from failing the file.
  activeView: z.union([z.enum(VIEW_IDS), APP_VIEW_ID]).catch("explorer"),
  sidebarVisible: z.boolean(),
  sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  editorGroups: WorkspaceEditorGroups,
  activeEditorGroup: z.string().min(1).max(MAX_EDITOR_GROUP_ID_CHARS),
  // The right-hand Chats panel. Optional fields degrade independently when a
  // version-3 file is hand-edited or lacks a newer cosmetic setting.
  chatsVisible: z.boolean().optional(),
  chatsWidth: z.number().int().min(CHATS_MIN_WIDTH).max(CHATS_MAX_WIDTH).optional(),
  // The catch keeps a foreign height from nulling an otherwise valid file.
  openEditorsHeight: z
    .number()
    .int()
    .min(OPEN_EDITORS_MIN_HEIGHT)
    .max(OPEN_EDITORS_MAX_HEIGHT)
    .optional()
    .catch(undefined),
  // Explorer and quick-open fields remain optional cosmetic state.
  expandedFolders: z.array(PATH_STRING).max(MAX_EXPANDED_FOLDERS).optional(),
  pinned: z.array(PATH_STRING).max(MAX_PINNED_PATHS).optional(),
  // The last ~20 opened files, most recent first.
  recentFiles: z.array(PATH_STRING).max(MAX_RECENT_FILES).optional(),
  // Which view each collection tab shows, keyed by the collection folder path.
  collectionViews: z
    .record(PATH_STRING, z.string().min(1).max(4096))
    .refine(
      (views) => Object.keys(views).length <= MAX_COLLECTION_VIEWS,
      { message: "Too many collection view entries." },
    )
    .optional(),
}).superRefine((state, context) => {
  const groupIds = new Set<string>();
  const singletonOwners = new Set<string>();
  let tabCount = 0;
  let totalSize = 0;
  for (let groupIndex = 0; groupIndex < state.editorGroups.length; groupIndex++) {
    const group = state.editorGroups[groupIndex];
    if (groupIds.has(group.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["editorGroups", groupIndex, "id"],
        message: "Editor group IDs must be unique.",
      });
    }
    groupIds.add(group.id);
    const groupSingletons = new Set<string>();
    for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
      const tab = group.tabs[tabIndex];
      if (!isSingletonEditorTabPath(tab)) continue;
      const identity = canonicalSingletonEditorTabPath(tab);
      if (identity === null || identity !== tab) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["editorGroups", groupIndex, "tabs", tabIndex],
          message: "Process-owning preview tab paths must use canonical encoding.",
        });
      }
      if (identity === null || groupSingletons.has(identity)) continue;
      groupSingletons.add(identity);
      if (singletonOwners.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["editorGroups", groupIndex, "tabs", tabIndex],
          message:
            isChatsTabPath(tab)
              ? "Each chat can be open in only one editor group."
              : isSiteTabPath(tab)
                ? "An app preview can be open in only one editor group."
                : "This tab can be open in only one editor group.",
        });
      } else {
        singletonOwners.add(identity);
      }
    }
    totalSize += group.size;
    tabCount += group.tabs.length;
  }
  if (tabCount > MAX_OPEN_TABS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["editorGroups"],
      message: `Open tabs exceed the configured limit of ${MAX_OPEN_TABS} tabs (observed ${tabCount} tabs).`,
    });
  }
  if (!groupIds.has(state.activeEditorGroup)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeEditorGroup"],
      message: "The active editor group must exist.",
    });
  }
  if (Math.abs(totalSize - 1) > 1e-6) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["editorGroups"],
      message: "Editor group sizes must sum to 1.",
    });
  }
});
export type WorkspaceUiState = z.infer<typeof WorkspaceUiState>;

// Reads preserve the bounded file's raw fields for parseUiState to repair one
// field at a time. Writes remain strict through WorkspaceUiState above.
export const GetWorkspaceUiStateResult = z.object({}).passthrough().nullable();
export type GetWorkspaceUiStateResult = z.infer<typeof GetWorkspaceUiStateResult>;

export const SetWorkspaceUiStatePayload = z.object({
  workspaceId: WORKSPACE_ID,
  state: WorkspaceUiState,
});
export type SetWorkspaceUiStatePayload = z.infer<typeof SetWorkspaceUiStatePayload>;

// Workspace content search. The renderer mints a bounded
// searchId per search; main spawns ripgrep rooted at the real workspace root
// and STREAMS batches back over the desktop:search-results event channel.
// SearchResultsEvent is parsed before send and again in the preload.
const SEARCH_ID = z.string().min(1).max(SEARCH_EVENT_MAX_ID_CHARS);

export const SearchResultsEventEntry = z
  .object({
    path: SAFE_RELATIVE_PATH,
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    preview: z.string().max(SEARCH_EVENT_MAX_PREVIEW_CHARS),
    matchStart: z.number().int().nonnegative(),
    matchEnd: z.number().int().nonnegative(),
    surface: z.enum(["file", "chat"]).optional(),
    threadId: OPAQUE_ID.optional(),
    objectId: OPAQUE_ID.optional(),
    title: z.string().min(1).max(500).optional(),
  })
  .refine(
    (entry) => entry.matchEnd >= entry.matchStart && entry.matchEnd <= entry.preview.length,
    "match offsets must be ordered and inside the preview",
  );
export type SearchResultsEventEntry = z.infer<typeof SearchResultsEventEntry>;

export const SearchResultsEvent = z.object({
  searchId: SEARCH_ID,
  entries: z.array(SearchResultsEventEntry).max(SEARCH_EVENT_MAX_ENTRIES),
  done: z.boolean(),
  limitHit: z.boolean(),
  // A search that is fail-closed by a broken policy file (or otherwise paused)
  // carries a short notice so the panel can explain the empty result.
  notice: z.string().min(1).max(SEARCH_EVENT_MAX_NOTICE_CHARS).optional(),
});
export type SearchResultsEvent = z.infer<typeof SearchResultsEvent>;

export const WorkspaceSearchPayload = z.object({
  workspaceId: WORKSPACE_ID,
  searchId: SEARCH_ID,
  // Bounded like every IPC string: a pattern is a line of text, never a blob.
  query: z.string().min(1).max(1000),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  regex: z.boolean().optional(),
  includeGlob: z.string().min(1).max(256).optional(),
  excludeGlob: z.string().min(1).max(256).optional(),
});
export type WorkspaceSearchPayload = z.infer<typeof WorkspaceSearchPayload>;

// Main classifies the daemon's typed refusal before Electron turns a rejected
// invoke into a message-only Error. The renderer receives this closed result,
// so retry behavior never depends on user-facing daemon copy.
export const WorkspaceSearchStartResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z
    .object({
      status: z.literal("refused"),
      code: z.literal("workspace-updating"),
    })
    .strict(),
]);
export type WorkspaceSearchStartResult = z.infer<
  typeof WorkspaceSearchStartResult
>;

export const CancelWorkspaceSearchPayload = z.object({
  searchId: SEARCH_ID,
});
export type CancelWorkspaceSearchPayload = z.infer<
  typeof CancelWorkspaceSearchPayload
>;

// Workspace content search answers accepted once the rg child spawns, or a
// typed refusal while initial capture runs. Results stream separately through
// onSearchResults, and a new search cancels the previous one in main. The
// search's workspace operation outlives the answer, so the start handler holds
// that operation itself instead of taking the active-workspace guard.
export const workspaceSearchOperations = {
  searchWorkspace: {
    channel: "desktop:search-workspace",
    payload: WorkspaceSearchPayload, result: WorkspaceSearchStartResult, guard: "trusted-sender",
  },
  cancelWorkspaceSearch: {
    channel: "desktop:cancel-workspace-search",
    payload: CancelWorkspaceSearchPayload, guard: "trusted-sender",
  },
} satisfies OperationTable;

// Crash reports. Main keeps each crash on this computer as plain text and
// sends nothing on its own. A report leaves only after the person confirms
// in main's own dialog, which names where it goes and can show the exact
// text. One report holds the problems recorded since the last send or
// dismiss.
export const CrashReportSource = z.enum(["main", "window", "gpu", "utility", "engine"]);
export type CrashReportSource = z.infer<typeof CrashReportSource>;
// Five problems of at most 6,000 characters each, with the header.
export const CRASH_REPORT_MAX_CHARS = 32_768;
export const CrashReportView = z.object({
  // Changes whenever the text does.
  revision: z.number().int().positive(),
  // The last problem in this text. Dismiss removes up to it, so a newer
  // problem stays.
  through: z.number().int().positive(),
  // Where the newest problem happened. The notice names it.
  source: CrashReportSource,
  problems: z.number().int().positive(),
  atMs: z.number().int().nonnegative(),
  text: z.string().min(1).max(CRASH_REPORT_MAX_CHARS),
});
export type CrashReportView = z.infer<typeof CrashReportView>;
export const ReadCrashReportResult = z.object({
  report: CrashReportView.nullable(),
  // The host a sent report goes to. Null when this build has no report
  // server, so the notice offers only Copy report.
  sendTo: z.string().min(1).max(255).nullable(),
});
export type ReadCrashReportResult = z.infer<typeof ReadCrashReportResult>;
export const CrashReportChangedEvent = z.undefined();

export const crashReportOperations = {
  readCrashReport: {
    channel: "desktop:read-crash-report",
    payload: z.object({}), result: ReadCrashReportResult, guard: "trusted-sender",
  },
  dismissCrashReport: {
    channel: "desktop:dismiss-crash-report",
    payload: z.object({ through: z.number().int().positive() }), guard: "trusted-sender",
  },
  // Opens main's dialog. Sent is true only when the person confirmed there
  // and the server took the report.
  sendCrashReport: {
    channel: "desktop:send-crash-report",
    payload: z.object({}), result: z.object({ sent: z.boolean() }), guard: "trusted-sender",
  },
} satisfies OperationTable;

// Notices sent to a person. "account" rows come from the signed-in account's
// notice list on the relay and reach all of that person's computers. "local"
// rows stay on this computer: nobody is signed in, the workspace does not sync
// through the signed-in server, or the server has no notice list. Dismissed
// rows are not listed. Lengths count code points, as the relay does.
export const NoticeStoreName = z.enum(["local", "account"]);
const codePoints = (min: number, max: number) =>
  z.string().refine((value) => {
    const length = [...value].length;
    return length >= min && length <= max;
  });
const NOTICE_TARGET_FIELD = codePoints(1, NOTICE_TARGET_FIELD_MAX_CHARS).optional();
export const NoticeTargetShape = z.object({
  path: NOTICE_TARGET_FIELD,
  record: NOTICE_TARGET_FIELD,
  thread: NOTICE_TARGET_FIELD,
  message: NOTICE_TARGET_FIELD,
  share: NOTICE_TARGET_FIELD,
  automation: NOTICE_TARGET_FIELD,
  run: NOTICE_TARGET_FIELD,
});
export const RefusalCoordinate = z.object({ originId: z.string(), originSeq: z.number().int() });
export type RefusalCoordinate = z.infer<typeof RefusalCoordinate>;
export const NoticeRow = z.object({
  store: NoticeStoreName,
  refusalCoordinates: z.array(RefusalCoordinate).optional(),
  noticeId: codePoints(1, NOTICE_ID_MAX_CHARS),
  kind: z.string().min(1).max(64),
  // A local row names this computer's workspace. An account row names the
  // workspace, or the share the person reads it through when it is not theirs.
  workspaceId: z.string().min(1).max(1_024).nullable(),
  recipientShareId: z.string().min(1).max(128).nullable(),
  senderKind: z.enum(["person", "agent", "automation"]).nullable(),
  senderLabel: codePoints(1, NOTICE_SENDER_LABEL_MAX_CHARS).nullable(),
  title: codePoints(1, NOTICE_TITLE_MAX_CHARS),
  body: codePoints(0, NOTICE_BODY_MAX_CHARS),
  detail: z.string().max(262_144).optional(),
  // Null once the person can no longer open what the notice pointed at.
  target: NoticeTargetShape.nullable(),
  createdAtMs: z.number().int().nonnegative(),
  readAtMs: z.number().int().nonnegative().nullable(),
  // This person posted it from this computer. Try again on a failed run
  // works only here, where the run's claim is.
  postedHere: z.boolean(),
});
export type NoticeRow = z.infer<typeof NoticeRow>;
export const NoticeRef = z.object({
  store: NoticeStoreName,
  refusalCoordinates: NoticeRow.shape.refusalCoordinates,
  noticeId: codePoints(1, NOTICE_ID_MAX_CHARS),
});
export type NoticeRef = z.infer<typeof NoticeRef>;
// The signed-in account a list shows, the same key cloudSessionChanged
// carries, or null when nobody is signed in.
const NoticeAccountKey = z.string().min(1).max(8_192).nullable();
export const ListNoticesResult = z.object({
  account: NoticeAccountKey,
  notices: z.array(NoticeRow),
});
export const NOTICE_MARK_BATCH_MAX = 500;
// One notice as it opens or is dismissed, or every unread one for "Mark all
// read", in batches. Account rows are marked only while the account the
// list showed is still signed in.
export const MarkNoticesPayload = z.object({
  account: NoticeAccountKey,
  mark: z.enum(["read", "dismissed"]),
  notices: z.array(NoticeRef).min(1).max(NOTICE_MARK_BATCH_MAX),
});
export type MarkNoticesPayload = z.infer<typeof MarkNoticesPayload>;
export const NoticesChangedEvent = z.undefined();
// Run now on a skipped schedule's notice, from the list for `account`.
export const RunSkippedScheduleNowPayload = z.object({
  account: NoticeAccountKey,
  notice: NoticeRef,
});
// `note` is null once the run started on this computer, or says why not.
export const RunSkippedScheduleNowResult = z.object({ note: z.string().max(500).nullable() });
// Try again on a failed run's notice, from the list for `account`.
// `startOver` confirms running a changed automation from the beginning.
export const RetryAutomationNoticePayload = z.object({
  account: NoticeAccountKey,
  notice: NoticeRef,
  startOver: z.boolean(),
});
export const RetryAutomationNoticeResult = z.union([
  z.object({ status: z.literal("queued"), press: z.boolean() }),
  z.object({ status: z.literal("definition-changed"), repeatsMessages: z.boolean() }),
  z.object({ status: z.literal("refused"), reason: z.string().min(1).max(2_000) }),
]);

// Which of the owner's computers runs a workspace's schedules.
const ScheduleHostWorkspace = z.object({ workspaceId: z.string().min(1).max(256) });
const ScheduleHostComputer = z.object({
  installId: z.string().min(1).max(256),
  // "server" for the dohc server, listed first while it runs automations.
  kind: z.enum(["computer", "server"]),
  label: z.string().min(1).max(64),
  lastSeenMs: z.number().int().nonnegative(),
  thisComputer: z.boolean(),
});
export type ScheduleHostComputer = z.infer<typeof ScheduleHostComputer>;
export const ScheduleHostResult = z.discriminatedUnion("kind", [
  // A workspace that never synced runs its schedules here, its only computer.
  z.object({ kind: z.literal("this-computer") }),
  // A shared view never runs schedules.
  z.object({ kind: z.literal("none") }),
  // dohc cannot ask the relay; `message` says what to do.
  z.object({ kind: z.literal("note"), message: z.string().min(1).max(300) }),
  z.object({
    kind: z.literal("relay"),
    // Rises on every change; choose and take over name the one they read.
    generation: z.number().int().nonnegative(),
    hostInstallId: z.string().min(1).max(256).nullable(),
    // The computer that is handing over, while a handover waits.
    handoverFrom: z.string().min(1).max(256).nullable(),
    // Most recently seen first.
    computers: z.array(ScheduleHostComputer).max(64),
  }),
]);
export type ScheduleHostResult = z.infer<typeof ScheduleHostResult>;
// The workspace whose schedule host changed.
export const ScheduleHostChangedEvent = z.string().min(1).max(256);
export const ChatDispatchNotice = z.object({
  id: z.string().min(1),
  reason: z.enum(["no-runner", "budget-paused"]),
  threadId: z.string().min(1),
  runId: z.string().min(1).optional(),
  logPath: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type ChatDispatchNotice = z.infer<typeof ChatDispatchNotice>;
export const ChatDispatchNoticesEvent = z.object({
  workspaceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  notices: z.array(ChatDispatchNotice).max(3),
});
export type ChatDispatchNoticesEvent = z.infer<typeof ChatDispatchNoticesEvent>;
export const chatDispatchNoticeOperations = {
  registerChatDispatchNotices: {
    channel: "desktop:register-chat-dispatch-notices",
    payload: WorkspaceIdPayload, result: ChatDispatchNoticesEvent,
    guard: "active-workspace", inactiveMessage: "Open this workspace to read its dispatch notices.",
  },
  dismissChatDispatchNotice: {
    channel: "desktop:dismiss-chat-dispatch-notice",
    payload: WorkspaceIdPayload.extend({ id: z.string().min(1) }),
    guard: "active-workspace", inactiveMessage: "Open this workspace to dismiss its dispatch notice.",
  },
} as const satisfies OperationTable;

export const scheduleHostOperations = {
  readScheduleHost: {
    channel: "desktop:read-schedule-host",
    payload: ScheduleHostWorkspace, result: ScheduleHostResult, guard: "trusted-sender",
  },
  // Starts a handover to another of the owner's computers.
  chooseScheduleHost: {
    channel: "desktop:choose-schedule-host",
    payload: ScheduleHostWorkspace.extend({
      installId: z.string().min(1).max(256),
      generation: z.number().int().nonnegative(),
    }),
    result: ScheduleHostResult, guard: "trusted-sender",
  },
  // Ends a handover without the old computer. A run can repeat if it is still on.
  takeOverScheduleHost: {
    channel: "desktop:take-over-schedule-host",
    payload: ScheduleHostWorkspace.extend({ generation: z.number().int().nonnegative() }),
    result: ScheduleHostResult, guard: "trusted-sender",
  },
} satisfies OperationTable;

export const noticeOperations = {
  listNotices: {
    channel: "desktop:list-notices",
    payload: z.object({}), result: ListNoticesResult, guard: "trusted-sender",
  },
  markNotices: {
    channel: "desktop:mark-notices",
    payload: MarkNoticesPayload, guard: "trusted-sender",
  },
  runSkippedScheduleNow: {
    channel: "desktop:run-skipped-schedule-now",
    payload: RunSkippedScheduleNowPayload, result: RunSkippedScheduleNowResult, guard: "trusted-sender",
  },
  retryAutomationNotice: {
    channel: "desktop:retry-automation-notice",
    payload: RetryAutomationNoticePayload, result: RetryAutomationNoticeResult, guard: "trusted-sender",
  },
} satisfies OperationTable;

// WS-G2-C-2 engine Y.Doc binding IPC. The renderer mints a bounded sessionId
// per open; main constructs the node-only live session (through the workspace's
// engine capture, reusing its store) and STREAMS remote CRDT deltas back over
// the desktop:engine-ydoc-remote-update event channel. Updates cross IPC as raw
// Uint8Array (structured clone).
const ENGINE_YDOC_SESSION_ID = z.string().min(1).max(ENGINE_YDOC_SESSION_ID_MAX_CHARS);
// z.custom (not z.instanceof) so the inferred type is a plain `Uint8Array`
// (ArrayBufferLike) — matching yjs's update type and the transport — rather than
// the ArrayBuffer-narrowed shape z.instanceof yields.
const ENGINE_YDOC_UPDATE = z
  .custom<Uint8Array>(
    (value) => value instanceof Uint8Array,
    "Y.Doc update must be a Uint8Array.",
  )
  .superRefine((value, context) => {
    if (value.byteLength === 0) {
      context.addIssue({
        code: "custom",
        message: "Y.Doc update must not be empty.",
      });
    }
    if (value.byteLength > ENGINE_YDOC_UPDATE_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          `ENGINE_YDOC_UPDATE_MAX_BYTES is ${ENGINE_YDOC_UPDATE_MAX_BYTES} bytes; ` +
          `the update is ${value.byteLength} bytes.`,
      });
    }
  });
const ENGINE_YDOC_INITIAL_UPDATE = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.byteLength <= ENGINE_YDOC_UPDATE_MAX_BYTES,
  "Y.Doc initial update is not a Uint8Array within the IPC byte bound.",
);

const ARTIFACT_ASSET_DESCRIPTOR: z.ZodType<ArtifactAssetDescriptor> = z.object({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  created: z.number().int().nonnegative(),
  ref: SAFE_RELATIVE_PATH,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  lastRetrieved: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional(),
});

export const OpenEngineYDocSessionPayload = z.object({
  workspaceId: WORKSPACE_ID,
  sessionId: ENGINE_YDOC_SESSION_ID,
  path: PATH_STRING,
});
export type OpenEngineYDocSessionPayload = z.infer<typeof OpenEngineYDocSessionPayload>;

export const OpenEngineYDocSessionResult = z.object({
  available: z.boolean(),
  initialUpdate: ENGINE_YDOC_INITIAL_UPDATE.optional(),
  objectId: z.string().min(1).optional(),
  versionId: z.string().min(1).optional(),
  artifactAssets: z.array(ARTIFACT_ASSET_DESCRIPTOR).optional(),
  lineageGeneration: z.number().int().positive().optional(),
  // The path is not in the version the workspace is on — a version switch
  // removed it while this open was queued behind that switch.
  // This reason must not downgrade to the writable plain editor, because that
  // editor would autosave the path back into the version as a phantom file.
  notInVersion: z.boolean().optional(),
  // Main could no longer resolve the live file at the path the renderer read.
  // The caller must not recreate it through the writable plain editor.
  documentUnavailable: z.boolean().optional(),
  liveHostUnavailable: z.boolean().optional(),
  // The open did not land, and a session for this document may still be the
  // engine's. It is raised by an open that hit its retry deadline while the
  // engine was unreachable, an open whose refusal could not release its
  // own session, and a session main holds whose close failed. Like
  // notInVersion, it must not downgrade to the writable plain editor: a plain
  // autosave beside a session the engine still binds takes the disk path #533
  // closed. The caller stays read-only, states the reason, and offers a retry —
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: z.boolean().optional(),
  // The engine committed the drawing, but its image records conflict with
  // authoritative storage. The drawing stays read-only. Retrying cannot
  // repair this terminal state.
  artifactAssetsInvalid: z.boolean().optional(),
  // A delete or move owns this path for an interval. The renderer must stay
  // read-only and offer a retry, without claiming that the operation finished.
  removalInProgress: z
    .object({
      operation: z.enum(["delete", "move"]),
      message: z.string().min(1),
    })
    .optional(),
});
export type OpenEngineYDocSessionResult = z.infer<typeof OpenEngineYDocSessionResult>;

export const ReadEngineYDocArtifactAssetPayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  // The full descriptor, not just the id: after a lineage replacement one id
  // can name both the winner's asset and a retired lineage's. The descriptor
  // selects among the descriptors main has pinned for this session — main
  // hydrates from its own pinned copy, never from these fields.
  descriptor: ARTIFACT_ASSET_DESCRIPTOR,
});
export type ReadEngineYDocArtifactAssetPayload = z.infer<
  typeof ReadEngineYDocArtifactAssetPayload
>;

export const ReadEngineYDocArtifactAssetResult = z.object({
  descriptor: ARTIFACT_ASSET_DESCRIPTOR,
  bytes: z.custom<Uint8Array>(
    (value) =>
      value instanceof Uint8Array &&
      value.byteLength <= MAX_VERSIONED_BINARY_FILE_BYTES,
    `Artifact asset bytes must fit the engine's MAX_VERSIONED_BINARY_FILE_BYTES limit of ${MAX_VERSIONED_BINARY_FILE_BYTES} bytes.`,
  ),
});
export type ReadEngineYDocArtifactAssetResult = z.infer<
  typeof ReadEngineYDocArtifactAssetResult
>;

export const ApplyEngineYDocUpdatePayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  update: ENGINE_YDOC_UPDATE,
  lineageGeneration: z.number().int().positive(),
  // Monotonic per-session local-edit counter. Main echoes the seq a settle
  // started at back on the save-state channel so the renderer never shows
  // "Saved" for a settle that predates the user's latest keystroke.
  //
  // Defaulted, never required: this handler is a hardened boundary whose
  // contract is an inert no-op for an unknown/foreign/read-only session — it
  // must never throw. A required field would reject at the schema, before the
  // session lookup, converting that silent refusal into an exception.
  seq: z.number().int().nonnegative().default(0),
});
export type ApplyEngineYDocUpdatePayload = z.infer<typeof ApplyEngineYDocUpdatePayload>;

export const ApplyEngineYDocUpdateResult = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true) }),
  z.object({
    accepted: z.literal(false),
    reason: z.enum([
      "session-unavailable",
      "lineage-transition",
      "deleted",
      "object-changed",
      "read-only",
    ]),
  }),
]);
export type ApplyEngineYDocUpdateResult = z.infer<
  typeof ApplyEngineYDocUpdateResult
>;

export const AcknowledgeEngineYDocLineageReplacementPayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  lineageGeneration: z.number().int().positive(),
});
export type AcknowledgeEngineYDocLineageReplacementPayload = z.infer<
  typeof AcknowledgeEngineYDocLineageReplacementPayload
>;
export const AcknowledgeEngineYDocLineageReplacementResult =
  z.discriminatedUnion("accepted", [
    z.object({
      accepted: z.literal(true),
      updates: z.array(ENGINE_YDOC_UPDATE),
    }),
    z.object({
      accepted: z.literal(false),
      reason: z.enum(["session-unavailable", "lineage-transition"]),
    }),
  ]);
export type AcknowledgeEngineYDocLineageReplacementResult = z.infer<
  typeof AcknowledgeEngineYDocLineageReplacementResult
>;

export const CloseEngineYDocSessionPayload = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
});
export const EngineYDocOwnerHandoff = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  lineageGeneration: z.number().int().positive(),
}).strict();
export type EngineYDocOwnerHandoff = z.infer<typeof EngineYDocOwnerHandoff>;
export type CloseEngineYDocSessionPayload = z.infer<typeof CloseEngineYDocSessionPayload>;

export const EngineYDocRemoteUpdateEvent = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  update: ENGINE_YDOC_UPDATE,
  lineageGeneration: z.number().int().positive(),
});
export type EngineYDocRemoteUpdateEvent = z.infer<typeof EngineYDocRemoteUpdateEvent>;

export const EngineYDocLineageReplacementEvent = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  update: ENGINE_YDOC_UPDATE,
  recoveredPaths: z.array(SAFE_RELATIVE_PATH),
  artifactAssets: z.array(ARTIFACT_ASSET_DESCRIPTOR),
  lineageGeneration: z.number().int().positive(),
});
export type EngineYDocLineageReplacementEvent = z.infer<
  typeof EngineYDocLineageReplacementEvent
>;

// seq is the highest applyLocalUpdate seq main had journaled when this settle
// STARTED. The renderer clears to "saved" only once this covers its latest
// local edit — otherwise an in-flight settle's success would claim edits it
// never carried.
export const EngineYDocSaveStateEvent = z.object({
  sessionId: ENGINE_YDOC_SESSION_ID,
  state: z.enum(ENGINE_YDOC_SAVE_STATES),
  seq: z.number().int().nonnegative(),
});
export type EngineYDocSaveStateEvent = z.infer<typeof EngineYDocSaveStateEvent>;

// Test-only snapshot of the main-process mark/measure recorder:
// named marks as wall-clock epochs, measures as durations between marks.
export const DesktopMarksResult = z.object({
  marks: z.record(z.string(), z.number()),
  measures: z.record(z.string(), z.number()),
});
export type DesktopMarksResult = z.infer<typeof DesktopMarksResult>;

export const DevRevealPathPayload = z.object({
  target: z.enum(["workspace", "state-dir"]),
  workspaceId: WORKSPACE_ID.optional(),
});
export type DevRevealPathPayload = z.infer<typeof DevRevealPathPayload>;
export const DevForgetWorkspacesResult = z.object({ forgot: z.number().int().nonnegative() });
export type DevForgetWorkspacesResult = z.infer<typeof DevForgetWorkspacesResult>;

export const LaunchMarksResult = z.object({
  appReadyMs: z.number().positive(),
  // The daemon handshake and the renderer's first paint race each other, so a
  // snapshot taken after paint may not have the daemon mark yet.
  daemonReadyMs: z.number().positive().optional(),
  firstWindowMs: z.number().positive(),
  firstPaintMs: z.number().positive(),
  shellVisibleMs: z.number().positive().optional(),
});
export type LaunchMarksResult = z.infer<typeof LaunchMarksResult>;

export interface DohcDesktopBridge
  extends OperationBridge<typeof workspaceVersionOperations>,
    OperationBridge<typeof workspaceSearchOperations>,
    OperationBridge<typeof crashReportOperations>,
    OperationBridge<typeof noticeOperations>,
    OperationBridge<typeof scheduleHostOperations>,
    OperationBridge<typeof chatDispatchNoticeOperations> {
  listOwnerLiveDocuments(payload: ListOwnerLiveDocumentsPayload): Promise<OwnerLiveDocumentsResult>;
  listOwnerLiveRefusals(payload: ListOwnerLiveRefusalsPayload): Promise<OwnerLiveRefusalsResult>;
  retryOwnerLiveShare(payload: RetryOwnerLiveSharePayload): Promise<void>;
  stopOwnerLiveDocument(payload: OwnerLiveDocumentActionPayload): Promise<void>;
  resumeOwnerLiveDocument(payload: OwnerLiveDocumentActionPayload): Promise<void>;
  publishOwnerApp(payload: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult>;
  ownerAppResponses(payload:OwnerAppResponsesRequest):Promise<OwnerAppResponsesResult>;
  dataset(payload: DatasetRequest): Promise<DatasetResult>;
  ownerRestore<Action extends OwnerRestoreAction>(payload: OwnerRestoreRequest & {action: Action}): Promise<OwnerRestoreResult<Action>>;
  // Constant, not a call: the titlebar lays out around macOS traffic lights
  // on darwin vs the window-controls overlay everywhere else.
  platform: NodeJS.Platform;
  // Constant: which surface this window renders. "manager" is the workspace
  // manager window; "workspace" is an ordinary window. Read from the load
  // URL by the preload, never from the renderer.
  windowRole: "workspace" | "manager";
  // Constant: main's own dev-tools decision (DOHC_DEV_TOOLS=1 in an
  // unpackaged build), handed to the preload at window creation. The
  // renderer shows the debug panel on it; every dev channel is separately
  // gated in main, so this is a hint, not authority.
  devTools: boolean;
  reloadRenderer(): Promise<void>;
  devForgetWorkspaces(): Promise<DevForgetWorkspacesResult>;
  devRevealPath(payload: DevRevealPathPayload): Promise<void>;
  pickWorkspaceRoot(): Promise<PickWorkspaceRootResult>;
  getWorkspaceRegistry(): Promise<WorkspaceRegistryResult>;
  getDefaultWorkspaceRoot(): Promise<string>;
  getDefaultShareRoot(payload: DefaultShareRootPayload): Promise<string>;
  createLocalWorkspace(
    payload: CreateLocalWorkspacePayload,
  ): Promise<WorkspaceSummary>;
  attachWorkspaceFolder(
    payload: AttachWorkspaceFolderPayload,
  ): Promise<WorkspaceSummary>;
  forgetWorkspace(payload: WorkspaceIdPayload): Promise<void>;
  revealWorkspaceFolder(payload: RevealWorkspaceFolderPayload): Promise<void>;
  // Opens (or focuses) a window for the workspace and leaves this window as
  // it is. The manager window closes itself after.
  openWorkspaceWindow(payload: WorkspaceIdPayload): Promise<void>;
  // Opens (or focuses) the workspace manager in its own window.
  openWorkspaceManager(): Promise<void>;
  closeThisWindow(): Promise<void>;
  listWorkspaceFiles(
    payload: ListWorkspaceFilesPayload,
  ): Promise<ListWorkspaceFilesResult>;
  createCollectionRecord(payload: CreateCollectionRecordPayload): Promise<{ path: string; recordId: string; kept?: Record<string, unknown> } | import("@dohc/cli/creation").CreationPartial>;
  createWorkspaceFile(
    payload: CreateWorkspaceFilePayload,
  ): Promise<CreateWorkspaceFileResult>;
  createWorkspaceFolder(
    payload: CreateWorkspaceFolderPayload,
  ): Promise<CreateWorkspaceFileResult>;
  moveWorkspacePath(
    payload: MoveWorkspacePathPayload,
  ): Promise<CreateWorkspaceFileResult>;
  deleteWorkspacePath(
    payload: DeleteWorkspacePathPayload,
  ): Promise<DeleteWorkspacePathResult>;
  exportWorkspaceZip(
    payload: ExportWorkspaceZipPayload,
  ): Promise<ExportWorkspaceZipResult>;
  // Document export ("Copy as Markdown" / "Export as HTML" / "Export as
  // PDF" menu, ViewHeader). See the payload's comment for the kind split.
  exportDocumentFile(
    payload: ExportDocumentFilePayload,
  ): Promise<ExportDocumentFileResult>;
  // Native explorer context menu; resolves with the chosen closed-tuple
  // command (validated in the preload against ExplorerMenuCommand) or null.
  showExplorerMenu(
    payload: ShowExplorerMenuPayload,
  ): Promise<ShowExplorerMenuResult>;
  showWorkbenchMenu(
    payload: ShowWorkbenchMenuPayload,
  ): Promise<ShowWorkbenchMenuResult>;
  // OS drag-in: maps dropped File objects to absolute paths via
  // webUtils.getPathForFile in the PRELOAD (sandboxed renderers have no
  // File.path since Electron 32). The paths feed importWorkspaceFiles'
  // droppedPaths — see the trust-delta note on that payload.
  getDroppedFilePaths(files: File[]): string[];
  importWorkspaceFiles(
    payload: ImportWorkspaceFilesPayload,
  ): Promise<ImportWorkspaceFilesResult>;
  readWorkspaceText(
    payload: ReadWorkspaceTextPayload,
  ): Promise<ReadWorkspaceTextResult>;
  writeWorkspaceText(
    payload: WriteWorkspaceTextPayload,
  ): Promise<WriteWorkspaceTextResult>;
  writeWorkspaceAsset(payload: WriteWorkspaceAssetPayload): Promise<void>;
  // `/image`: a MAIN-process open dialog rooted at the workspace directory,
  // returning the chosen files' bytes (see PickImageFilesPayload).
  pickImageFiles(payload: PickImageFilesPayload): Promise<PickImageFilesResult>;
  openFileExternally(payload: OpenFileExternallyPayload): Promise<void>;
  readWorkspaceGraph(
    payload: ReadWorkspaceGraphPayload,
  ): Promise<WorkspaceGraphResult>;
  getBacklinks(payload: GetBacklinksPayload): Promise<GetBacklinksResult>;
  listWorkspaceHeadings(
    payload: ListWorkspaceHeadingsPayload,
  ): Promise<ListWorkspaceHeadingsResult>;
  listChatFileMentions(
    payload: ListChatFileMentionsPayload,
  ): Promise<ListChatFileMentionsResult>;
  listChatBookmarks(payload: ListChatBookmarksPayload): Promise<ListChatBookmarksResult>;
  saveChatBookmark(payload: SaveChatBookmarkPayload): Promise<SaveChatBookmarkResult>;
  archiveChatBookmark(
    payload: ArchiveChatBookmarkPayload,
  ): Promise<ArchiveChatBookmarkResult>;
  // Collections: the engine's collection index, read-only.
  // Writes ride the live document's frontmatter map, not a bridge method.
  listCollections(payload: ListCollectionsPayload): Promise<ListCollectionsResult>;
  getCollection(payload: GetCollectionPayload): Promise<GetCollectionResult>;
  queryCollectionRecords(
    payload: QueryCollectionRecordsPayload,
  ): Promise<QueryCollectionRecordsResult>;
  readWorkspaceDatabase(
    payload: ReadWorkspaceDatabasePayload,
  ): Promise<DatabaseSnapshotResult>;
  readWorkspaceDatabasePage(
    payload: ReadWorkspaceDatabasePagePayload,
  ): Promise<DatabasePageResult>;
  applyDatabaseEdit(
    payload: ApplyDatabaseEditPayload,
  ): Promise<DatabaseEditResult>;
  importToDatabase(
    payload: ImportToDatabasePayload,
  ): Promise<ImportToDatabaseResult>;
  listSites(payload: ListSitesPayload): Promise<ListSitesResult>;
  getSitePackage(payload: SitePackagePayload): Promise<SitePackageResult>;
  startSitePreview(payload: StartSitePreviewPayload): Promise<StartSitePreviewAnswer>;
  getSitePreviewLogs(
    payload: GetSitePreviewLogsPayload,
  ): Promise<GetSitePreviewLogsResult>;
  stopSitePreview(payload: StopSitePreviewPayload): Promise<StopSitePreviewResult>;
  onSitePreviewReplaced(
    listener: (event: SitePreviewReplacedEvent) => void,
  ): () => void;
  openExternalUrl(payload: OpenExternalUrlPayload): Promise<void>;
  cloudLoginStart(payload: CloudLoginStartPayload): Promise<CloudLoginStartResult>;
  cloudLoginPoll(): Promise<CloudLoginPollResult>;
  cloudStatus(payload?: CloudStatusPayload): Promise<CloudStatusResult>;
  cloudLogout(): Promise<void>;
  getShareHandoffStatus(): Promise<ShareHandoffStatus>;
  acceptShareHandoff(payload: AcceptShareHandoffPayload): Promise<void>;
  retryShareHandoff(): Promise<void>;
  dismissShareHandoff(payload: DismissShareHandoffPayload): Promise<void>;
  onShareHandoffStatus(
    listener: (status: ShareHandoffStatus) => void,
  ): () => void;
  cloudEnableSync(payload: CloudEnableSyncPayload): Promise<SyncStatusResult>;
  cloudJoinWorkspace(
    payload: CloudJoinWorkspacePayload,
  ): Promise<CloudJoinWorkspaceResult>;
  // Relay shares: grant side.
  createRelayShare(payload: CreateRelaySharePayload): Promise<CreateRelayShareResult>;
  listRelayShares(): Promise<ListRelaySharesResult>;
  getRelayReceivedShare(
    payload: GetRelayReceivedSharePayload,
  ): Promise<GetRelayReceivedShareResult>;
  revokeRelayShare(payload: RevokeRelaySharePayload): Promise<RevokeRelayShareResult>;
  // Puts back what a removal ended, using its receipt. Owner only.
  undoRelayShare(payload: UndoRelaySharePayload): Promise<UndoRelayShareResult>;
  createRelayShareLink(
    payload: CreateRelayShareLinkPayload,
  ): Promise<CreateRelayShareLinkResult>;
  addRelayShareLink(
    payload: AddRelayShareLinkPayload,
  ): Promise<AddRelayShareLinkResult>;
  listRelayShareLinks(
    payload: ListRelayShareLinksPayload,
  ): Promise<ListRelayShareLinksResult>;
  rotateRelayShareLink(
    payload: RotateRelayShareLinkPayload,
  ): Promise<RotateRelayShareLinkResult>;
  retuneRelayShareLink(
    payload: RetuneRelayShareLinkPayload,
  ): Promise<RetuneRelayShareLinkResult>;
  revokeRelayShareLink(
    payload: RevokeRelayShareLinkPayload,
  ): Promise<RevokeRelayShareLinkResult>;
  listRelayShareDiscussion(
    payload: ListRelayShareDiscussionPayload,
  ): Promise<ListRelayShareDiscussionResult>;
  pollRelayShareDiscussionActivity(
    payload: PollRelayShareDiscussionActivityPayload,
  ): Promise<PollRelayShareDiscussionActivityResult>;
  cancelRelayShareDiscussionActivity(
    payload: CancelRelayShareDiscussionActivityPayload,
  ): Promise<void>;
  appendRelayShareDiscussion(
    payload: AppendRelayShareDiscussionPayload,
  ): Promise<AppendRelayShareDiscussionResult>;
  deleteRelayShareDiscussionMessage(
    payload: DeleteRelayShareDiscussionMessagePayload,
  ): Promise<DeleteRelayShareDiscussionMessageResult>;
  blockRelayShareDiscussionPrincipal(
    payload: BlockRelayShareDiscussionPrincipalPayload,
  ): Promise<BlockRelayShareDiscussionPrincipalResult>;
  unblockRelayShareDiscussionPrincipal(
    payload: UnblockRelayShareDiscussionPrincipalPayload,
  ): Promise<UnblockRelayShareDiscussionPrincipalResult>;
  pauseRelayShareDiscussion(
    payload: PauseRelayShareDiscussionPayload,
  ): Promise<PauseRelayShareDiscussionResult>;
  resumeRelayShareDiscussion(
    payload: ResumeRelayShareDiscussionPayload,
  ): Promise<ResumeRelayShareDiscussionResult>;
  promoteRelayShareGrant(
    payload: PromoteRelayShareGrantPayload,
  ): Promise<PromoteRelayShareGrantResult>;
  revokeRelayShareGrant(
    payload: RevokeRelayShareGrantPayload,
  ): Promise<RevokeRelayShareGrantResult>;
  shareChatChannel(payload: ShareChatChannelPayload): Promise<ShareChatChannelResult>;
  listChatChannelShares(
    payload: ListChatChannelSharesPayload,
  ): Promise<ListChatChannelSharesResult>;
  listJoinedSharedChannels(
    payload: ListJoinedSharedChannelsPayload,
  ): Promise<ListJoinedSharedChannelsResult>;
  joinSharedChannel(payload: JoinSharedChannelPayload): Promise<JoinSharedChannelResult>;
  leaveSharedChannel(payload: LeaveSharedChannelPayload): Promise<void>;
  // Relay shares: receive side — read-only shared views.
  openSharedView(payload: OpenSharedViewPayload): Promise<OpenSharedViewResult>;
  refreshSharedView(payload: RefreshSharedViewPayload): Promise<RefreshSharedViewResult>;
  dismissShareSkips(payload: DismissShareSkipsPayload): Promise<void>;
  // Collection automations, for the ⚡ panel.
  listCollectionAutomations(payload: ListCollectionAutomationsPayload): Promise<ListCollectionAutomationsResult>;
  listCollectionAutomationRuns(payload: ListCollectionAutomationRunsPayload): Promise<ListCollectionAutomationRunsResult>;
  getCollectionAutomationRun(payload: GetCollectionAutomationRunPayload): Promise<GetCollectionAutomationRunResult>;
  listServerAutomationRuns(payload: ListServerAutomationRunsPayload): Promise<ListServerAutomationRunsResult>;
  retryCollectionAutomation(payload: RetryCollectionAutomationPayload): Promise<RetryCollectionAutomationResult>;
  undoCollectionAutomationRun(payload: UndoCollectionAutomationRunPayload): Promise<UndoCollectionAutomationRunResult>;
  listAutomationTargets(payload: ListAutomationTargetsPayload): Promise<ListAutomationTargetsResult>;
  listAutomationGroups(payload: ListAutomationGroupsPayload): Promise<ListAutomationGroupsResult>;
  listAutomationPeople(payload: ListAutomationPeoplePayload): Promise<ListAutomationPeopleResult>;
  checkCollectionAutomation(payload: CheckCollectionAutomationPayload): Promise<CheckCollectionAutomationResult>;
  stopAndRestore(payload: StopAndRestorePayload): Promise<StopAndRestoreResult>;
  undoStopAndRestore(payload: UndoStopAndRestorePayload): Promise<void>;
  confirmCollectionAutomationStep(payload: ConfirmCollectionAutomationStepPayload): Promise<ConfirmCollectionAutomationStepResult>;
  listAutomationHolds(payload: ListAutomationHoldsPayload): Promise<ListAutomationHoldsResult>;
  listServerAutomationHolds(payload: ListServerAutomationHoldsPayload): Promise<ListServerAutomationHoldsResult>;
  resetAutomationHolds(payload: ResetAutomationHoldsPayload): Promise<ResetAutomationHoldsResult>;
  revealAutomationHolds(payload: RevealAutomationHoldsPayload): Promise<void>;
  dismissAutomationStops(payload: DismissAutomationStopsPayload): Promise<void>;
  automationShareImpact(payload: AutomationShareImpactPayload): Promise<AutomationShareImpactResult>;
  listCollectionFieldMarks(payload: ListCollectionFieldMarksPayload): Promise<ListCollectionFieldMarksResult>;
  findDatasetCollection(payload: FindDatasetCollectionPayload): Promise<FindDatasetCollectionResult>;
  findAutomationCollection(payload: FindAutomationCollectionPayload): Promise<FindAutomationCollectionResult>;
  writeCollectionAutomations(payload: WriteCollectionAutomationsPayload): Promise<WriteCollectionAutomationsResult>;
  listAutomationButtons(payload: ListAutomationButtonsPayload): Promise<ListAutomationButtonsResult>;
  listRecordButtons(payload: ListRecordButtonsPayload): Promise<ListRecordButtonsResult>;
  pressAutomationButton(payload: PressAutomationButtonPayload): Promise<PressAutomationButtonResult>;
  // Share changes: the granter reviews and settles.
  listShareProposals(
    payload: ListShareProposalsPayload,
  ): Promise<ListShareProposalsResult>;
  readShareProposalChanges(
    payload: ReadShareProposalChangesPayload,
  ): Promise<ReadShareProposalChangesResult>;
  readShareProposalFileContent(
    payload: ReadShareProposalFileContentPayload,
  ): Promise<ReadShareProposalFileContentResult>;
  settleShareProposal(
    payload: SettleShareProposalPayload,
  ): Promise<SettleShareProposalResult>;
  // Share changes: the recipient sends, tracks, and takes back.
  submitShareChanges(
    payload: SubmitShareChangesPayload,
  ): Promise<SubmitShareChangesResult>;
  // Writes the share view's changes to a Collection's own files straight
  // into the owner's workspace. Every other change waits for Send changes.
  pushShareDirectWrites(
    payload: PushShareDirectWritesPayload,
  ): Promise<PushShareDirectWritesResult>;
  onShareDirectWritesPushed(listener: (event: ShareDirectWritesPushedEvent) => void): () => void;
  listMyShareChanges(
    payload: ListMyShareChangesPayload,
  ): Promise<ListMyShareChangesResult>;
  withdrawShareChanges(
    payload: WithdrawShareChangesPayload,
  ): Promise<WithdrawShareChangesResult>;
  // Share mounts: a received share materialized into a host workspace's
  // shared-with-me/<label>/ as ordinary read-only files.
  mountShare(payload: MountSharePayload): Promise<MountShareResult>;
  refreshShareMounts(
    payload: RefreshShareMountsPayload,
  ): Promise<RefreshShareMountsResult>;
  unmountShare(payload: UnmountSharePayload): Promise<UnmountShareResult>;
  openWorkspace(payload: OpenWorkspacePayload): Promise<SyncStatusResult>;
  // Engine history + linked Chats. Gated in main on the workspace's engine
  // capture.
  listEngineMoments(
    payload: ListEngineMomentsPayload,
  ): Promise<ListEngineMomentsResponse>;
  readEngineMoment(
    payload: ReadEngineMomentPayload,
  ): Promise<ReadEngineMomentResult>;
  restoreEngineMomentFile(
    payload: RestoreEngineMomentFilePayload,
  ): Promise<RestoreEngineMomentFileResult>;
  listFileChats(payload: ListFileChatsPayload): Promise<ListFileChatsResponse>;
  createFileChat(payload: CreateFileChatPayload): Promise<CreateFileChatResult>;
  listChatMessages(
    payload: ListChatMessagesPayload,
  ): Promise<ListChatMessagesResult>;
  getChatThreadRevision(
    payload: GetChatThreadRevisionPayload,
  ): Promise<GetChatThreadRevisionResult>;
  sendChatMessage(payload: SendChatMessagePayload): Promise<SendChatMessageResult>;
  listChatThreadDecisions(
    payload: ListChatThreadDecisionsPayload,
  ): Promise<ListChatThreadDecisionsResult>;
  resolveChatDecision(
    payload: ResolveChatDecisionPayload,
  ): Promise<ResolveChatDecisionResult>;
  listChatThreadAttachments(
    payload: ListChatThreadAttachmentsPayload,
  ): Promise<ListChatThreadAttachmentsResult>;
  chatRunRecordsForThread(
    payload: ChatRunRecordsForThreadPayload,
  ): Promise<ChatRunRecordsForThreadResult>;
  // Chats channels (PR 12/13, WS-E) — same flag gate as the file rail.
  listChatChannels(
    payload: ListChatChannelsPayload,
  ): Promise<ListChatChannelsResult>;
  listChatFollows(payload: ListChatFollowsPayload): Promise<ListChatFollowsResult>;
  setChatFollow(payload: SetChatFollowPayload): Promise<SetChatFollowResult>;
  listPersonalChatFeed(
    payload: ListPersonalChatFeedPayload,
  ): Promise<ListPersonalChatFeedResult>;
  markPersonalChatFeedSeen(payload: MarkPersonalChatFeedSeenPayload): Promise<void>;
  createChatChannel(
    payload: CreateChatChannelPayload,
  ): Promise<CreateChatChannelResult>;
  listChannelThreads(
    payload: ListChannelThreadsPayload,
  ): Promise<ListChannelThreadsResult>;
  startChannelThread(
    payload: StartChannelThreadPayload,
  ): Promise<StartChannelThreadResult>;
  markChatThreadRead(
    payload: MarkChatThreadReadPayload,
  ): Promise<MarkChatThreadReadResult>;
  // Reactions (WS-MU-C2): list active reactions for a thread and add/remove
  // the viewer's own. Same gate as the rest of chat.
  listChatReactions(
    payload: ListChatReactionsPayload,
  ): Promise<ListChatReactionsResult>;
  setChatReaction(
    payload: SetChatReactionPayload,
  ): Promise<SetChatReactionResult>;
  // Direct messages (WS-MU-C3): reconcile DM state with the relay and list the
  // workspace's DMs; start (or continue) a DM with a recipient set.
  syncDms(payload: SyncDmsPayload): Promise<SyncDmsResult>;
  acceptDm(payload: AcceptDmPayload): Promise<AcceptDmResult>;
  declineDm(payload: DeclineDmPayload): Promise<void>;
  requestDmAgain(payload: RequestDmAgainPayload): Promise<void>;
  startDm(payload: StartDmPayload): Promise<StartDmResult>;
  leaveDm(payload: LeaveDmPayload): Promise<void>;
  // Ephemeral presence (MU-C5): IPC-proxied so the relay bearer token stays in
  // main. publish (or leave) a presence state and long-poll for peer changes;
  // presenceCancel aborts an in-flight poll on unmount / workspace switch.
  presencePublish(payload: PresencePublishPayload): Promise<PresenceResult>;
  presencePoll(payload: PresencePollPayload): Promise<PresenceResult>;
  presenceCancel(payload: PresenceCancelPayload): Promise<void>;
  getSyncStatus(payload: WorkspaceIdPayload): Promise<SyncStatusResult>;
  retryOwnerLiveDelivery(payload: WorkspaceIdPayload): Promise<void>;
  retryFileRecovery(payload: WorkspaceIdPayload): Promise<void>;
  // Runs a cloud sync pass now and answers with the status after it.
  retryCloudSync(payload: RetryCloudSyncPayload): Promise<SyncStatusResult>;
  rebuildEngineStore(
    payload: RebuildEngineStorePayload,
  ): Promise<RebuildEngineStoreResult>;
  startAgentRun(payload: AgentRunPayload): Promise<StartAgentRunResult>;
  endAgentRun(payload: EndAgentRunPayload): Promise<void>;
  getAgentRunStatus(payload: AgentRunPayload): Promise<AgentRunStatusResult>;
  getMcpConfig(payload: AgentRunPayload): Promise<McpConfigResult>;
  stopAgentRun(payload: StopAgentRunPayload): Promise<void>;
  resumeThreadDispatch(payload: ResumeThreadDispatchPayload): Promise<void>;
  chatDispatchStateForThread(
    payload: ChatDispatchStateForThreadPayload,
  ): Promise<ChatDispatchStateForThreadResult>;
  runnerSelfTest(payload: RunnerSelfTestPayload): Promise<RunnerSelfTestResult>;
  detectAgentTools(payload: AgentRunPayload): Promise<AgentToolsResult>;
  getUserSettings(): Promise<DesktopUserSettingsResult>;
  setUserSettings(payload: SetUserSettingsPayload): Promise<DesktopUserSettingsResult>;
  resetUserSettings(): Promise<DesktopUserSettingsResult>;
  // Reads the settings file again, applies it, and answers what is in effect.
  reloadUserSettings(): Promise<DesktopUserSettingsResult>;
  setAppPinned(payload: SetAppPinnedPayload): Promise<DesktopUserSettingsResult>;
  getUserSettingsFilePath(): Promise<string>;
  // Opens the settings file in the system's editor, creating it first when
  // there is none.
  openUserSettingsFile(): Promise<void>;
  // Opens this workspace's .dohc/settings.local.json in the system's editor.
  openWorkspaceSettingsFile(payload: WorkspaceSettingsPayload): Promise<void>;
  getWorkspaceSettings(
    payload: WorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  setWorkspaceSettings(
    payload: SetWorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  resetWorkspaceSettings(
    payload: WorkspaceSettingsPayload,
  ): Promise<WorkspaceSettingsResult>;
  writeClipboardText(payload: WriteClipboardTextPayload): Promise<void>;
  setTitlebarTheme(payload: SetTitlebarThemePayload): Promise<void>;
  onUserSettingsChanged(
    listener: (result: DesktopUserSettingsResult) => void,
  ): () => void;
  stepWindowZoom(
    payload: StepWindowZoomPayload,
  ): Promise<DesktopUserSettingsResult>;
  // Per-workspace workbench UI state (.dohc/ui-state.json), main-owned.
  getWorkspaceUiState(
    payload: WorkspaceIdPayload,
  ): Promise<GetWorkspaceUiStateResult>;
  setWorkspaceUiState(payload: SetWorkspaceUiStatePayload): Promise<void>;
  // Live push: main signals the renderer when the active workspace's files
  // or history changed (settled filesystem batch recorded). Main filters by
  // each window's active workspace, so a window only hears about its own
  // workspace plus global events. The payload is additive context — a
  // subscriber may ignore it. Returns an unsubscribe function.
  onWorkspaceActivity(listener: (event: WorkspaceActivityEvent) => void): () => void;
  // Live push: an automation claim failed or a retry queued one, so run
  // history changed. A poke, not the record; the subscriber reads the runs
  // again, guarded by its own workspace. Returns an unsubscribe function.
  onAutomationRunsChanged(
    listener: (event: { workspaceId: string }) => void,
  ): () => void;
  // Live push: the crash report changed. A poke, not the report; the
  // subscriber reads it again. Returns an unsubscribe function.
  onCrashReportChanged(listener: () => void): () => void;
  // Live push: the notices listNotices returns changed. A poke, not the
  // rows. Returns an unsubscribe function.
  onNoticesChanged(listener: () => void): () => void;
  // Which computer runs a workspace's schedules changed, as when a handover
  // finished in the background.
  onScheduleHostChanged(listener: (workspaceId: string) => void): () => void;
  onChatDispatchNotices(listener: (event: ChatDispatchNoticesEvent) => void): () => void;
  // A step started or stopped waiting for a current editor, or a share
  // stopped a step: re-list holds and stops.
  onAutomationHoldsChanged(
    listener: (event: { workspaceId: string }) => void,
  ): () => void;
  // The automations main read from the workspace changed: re-read field marks.
  onCollectionAutomationsChanged(
    listener: (event: { workspaceId: string }) => void,
  ): () => void;
  // A press this window made settled, or waits. Each event names its
  // workspace; a window on another workspace drops it.
  onAutomationRunSettled(listener: (event: AutomationRunSettledEvent) => void): () => void;
  onAutomationRunWaiting(listener: (event: AutomationRunWaitingEvent) => void): () => void;
  // Live push: main signals a cloud session transition (login, logout,
  // account switch, or a relay proving the session dead). Account-scoped
  // renderer caches — the relay-backed share rows — refresh on this signal;
  // the generic activity ping deliberately reaches only cheap local
  // refreshes. The event carries the new session's key (null when signed
  // out) so a same-account token rotation invalidates nothing. Returns an
  // unsubscribe function.
  // The phase completes the two-moment transition contract: "changing" is
  // transition start (preserve same-session state, ask for nothing — the
  // credential cache is mid-transition), "ready" is adoption end (run the
  // one revalidation against the settled session).
  onCloudSessionChanged(
    listener: (event: {
      sessionKey: string | null;
      phase: "changing" | "ready";
    }) => void,
  ): () => void;
  // Application-menu clicks, validated against MenuCommand in the preload
  // before they reach renderer code. Returns an unsubscribe function.
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  // Native Open Recent / OS "Open with dohc" activation. Main sends a full
  // workspace summary; the preload strips and validates it before the root
  // swaps workspaces.
  onWorkspaceActivated(listener: (workspace: WorkspaceSummary) => void): () => void;
  // Auto-update state pushes from main, validated against UpdateStateEvent in
  // the preload before they reach renderer code. Returns an unsubscribe function.
  onUpdateState(listener: (state: UpdateStateEvent) => void): () => void;
  // Explicit update actions. The renderer can ask main to check or install;
  // it cannot set feed URLs or mutate update channels.
  getUpdateState(): Promise<UpdateStateEvent>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(): Promise<UpdateActionResult>;
  // Exit rounds: before a quit proceeds or an update installs, main asks
  // every workspace window whether set-aside drafts would be lost.
  // electron-updater's quitAndInstall is one-shot, so the decision comes
  // before any destructive call. Each window answers clear, hold (its
  // dialog owns the decision), or cancel (the user went back) with the
  // round id it was asked under.
  onExitRound(listener: (message: ExitRoundMessage) => void): () => void;
  answerExitRound(payload: ExitRoundAnswerPayload): Promise<void>;
  // A late draft vetoes an approved exit's unload; the renderer tells main
  // the approval is off, and resumes the quit once the user confirms.
  holdQuit(): Promise<void>;
  resumeQuit(): Promise<void>;
  // Streamed result batches, validated batch-by-batch in the preload. Returns
  // an unsubscribe function. The searchId round-trips so the renderer drops
  // batches that belong to a superseded search.
  onSearchResults(listener: (batch: SearchResultsEvent) => void): () => void;
  // WS-G2-C-2 engine Y.Doc editor binding. The renderer mints a sessionId and
  // opens a live engine Y.Doc session for a supported live file; main constructs the
  // node-only session through the workspace's engine capture (reusing its
  // store). available:false => not engine-backed
  // (shared view, secret path, missing file, or already live) — the
  // caller falls back to the plain local autosave editor. On success
  // initialUpdate seeds the renderer's mirror doc.
  openEngineYDocSession(
    payload: OpenEngineYDocSessionPayload,
  ): Promise<OpenEngineYDocSessionResult>;
  readEngineYDocArtifactAsset(
    payload: ReadEngineYDocArtifactAssetPayload,
  ): Promise<ReadEngineYDocArtifactAssetResult>;
  // Ship a local editor CRDT update to main (journaled via recordUpdate +
  // debounced settle). A refusal is explicit so the renderer can preserve the
  // mirror instead of treating a dropped update as durable.
  applyEngineYDocUpdate(
    payload: ApplyEngineYDocUpdatePayload,
  ): Promise<ApplyEngineYDocUpdateResult>;
  // Completes the replacement handoff only after the renderer detached the
  // losing mirror and durably preserved any edit that did not reach main.
  acknowledgeEngineYDocLineageReplacement(
    payload: AcknowledgeEngineYDocLineageReplacementPayload,
  ): Promise<AcknowledgeEngineYDocLineageReplacementResult>;
  prepareEngineYDocOwnerHandoff(payload: EngineYDocOwnerHandoff): Promise<void>;
  onEngineYDocOwnerHandoff(listener: (event: EngineYDocOwnerHandoff) => void): () => void;
  // Settle + close the session in main (releases the single-canonical
  // reservation so the same object can reopen on a version/file switch).
  closeEngineYDocSession(payload: CloseEngineYDocSessionPayload): Promise<void>;
  // Remote CRDT deltas main forwards (a co-editor's edit routed through the
  // engine), validated in the preload. The sessionId round-trips so the
  // renderer applies only deltas for the
  // session currently bound. Returns an unsubscribe function.
  onEngineYDocRemoteUpdate(
    listener: (event: EngineYDocRemoteUpdateEvent) => void,
  ): () => void;
  onEngineYDocLineageReplacement(
    listener: (event: EngineYDocLineageReplacementEvent) => void,
  ): () => void;
  // The document's real save state, pushed on every settle outcome. The editor
  // must never claim "Saved" from anything else: a settle can fail (and used to
  // fail silently) while the renderer's own timer said the doc was safe.
  onEngineYDocSaveState(
    listener: (event: EngineYDocSaveStateEvent) => void,
  ): () => void;
}
