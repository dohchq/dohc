import {
  APP_PUBLICATION_CAPABILITIES,
  APP_RESPONSE_CAPABILITIES,
  CLI_CAPABILITIES,
  DECLARED_VERBS,
  DECLARED_WRITES,
  type CliRequest,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { DATASET_CAPABILITIES, type DatasetRequest } from "@dohc/cli/dataset";
import { MEMBERS_CAPABILITIES } from "@dohc/cli/members";
import { CAPABILITIES, type CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS } from "@dohc/workspace-contracts/usage";
import { RENDERER_USAGE_COVERAGE } from "./rendererUsage";
import { AUTOMATION_USAGE_ACTION_IDS } from "@dohc/automation-executor/automation-usage";

type ActionId = (typeof USAGE_ACTION_IDS)[number];
export type CliUsageInvocation = { capabilityId: ActionId; door: "cli" | "mcp" };
// Show and search are reads. Invoke can run a read operation, with no result
// signal distinguishing it from a mutation, so it remains uncovered.
const reads = new Set<CapabilityId>(["chat.show", "chat.search", "dataset.operation.invoke"]);
export const CLI_USAGE_ACTION_IDS = USAGE_ACTION_IDS.filter(
  (id) =>
    !reads.has(id) &&
    Object.values(CLI_CAPABILITIES).some((ids) => (ids as readonly CapabilityId[]).includes(id)),
);
const covered = new Set<CapabilityId>(CLI_USAGE_ACTION_IDS);
// MCP also uses fileWrite for app.create and data.import, so its file.write
// count cannot distinguish those capabilities.
const mcpCovered = new Set<CapabilityId>(CLI_USAGE_ACTION_IDS.filter((id) => id !== "file.write"));
// Automation coverage for dataset.operation.invoke counts successful invocations
// of write-capable actions, including no-ops. The change signal is not kept
// through receipt replay or the saved run.
const automationCovered = new Set<CapabilityId>(AUTOMATION_USAGE_ACTION_IDS);
export const DESKTOP_USAGE_COVERAGE = RENDERER_USAGE_COVERAGE.map((pair) => ({
  ...pair,
  status:
    (pair.door === "cli" && covered.has(pair.capabilityId)) ||
    (pair.door === "automation" && automationCovered.has(pair.capabilityId)) ||
    (pair.door === "mcp" &&
      mcpCovered.has(pair.capabilityId) &&
      Object.values(CAPABILITIES[pair.capabilityId].mcp).some(
        (tools) => Array.isArray(tools) && tools.length > 0,
      ))
      ? ("covered" as const)
      : pair.status,
}));

export function cliCapabilityId(request: CliRequest): CapabilityId {
  return request.verb === "dataset"
    ? DATASET_CAPABILITIES[request.args.request.action]
    : request.verb === "appPublication"
      ? APP_PUBLICATION_CAPABILITIES[request.args.request.action]
      : request.verb === "ownerAppResponses"
        ? APP_RESPONSE_CAPABILITIES[request.args.request.action]
        : request.verb === "members"
          ? MEMBERS_CAPABILITIES[request.args.request.action]
          : CLI_CAPABILITIES[request.verb][0];
}

const DATASET_WRITE_ACTIONS: Readonly<Record<DatasetRequest["action"], boolean>> = {
  list: false,
  describe: false,
  types: true,
  history: false,
  historyRevision: false,
  prepareHistoryRestore: true,
  lifecycle: false,
  deletePreview: false,
  delete: true,
  archive: true,
  restore: true,
  pendingAttempts: false,
  reconcileAttempt: true,
  cancelAttempt: true,
  permissions: false,
  setGrant: true,
  setDefaults: true,
  removeGrant: true,
  export: true,
  prepareRecovery: true,
  claimRecovery: true,
  discardRecovery: true,
  upload: true,
  file: false,
  createForm: true,
  prepareRelationChoices: true,
  create: true,
  prepare: true,
  approve: true,
  discard: true,
  prepareMigration: true,
  askToApply: true,
  migrationPreviewPage: false,
  prepareSchemaChange: true,
  approveMigration: true,
  discardMigration: true,
  approval: false,
  confirmApproval: true,
  invoke: true,
  cancelInvoke: true,
  sql: false,
  trace: false,
};

const APP_PUBLICATION_WRITE_ACTIONS: Readonly<
  Record<keyof typeof APP_PUBLICATION_CAPABILITIES, boolean>
> = {
  verifyFrontend: false,
  createLink: true,
  personalFolder: false,
  listLocal: false,
  checkLocal: false,
  prepareLocal: true,
  stage: true,
  listStaged: false,
  approveStaged: true,
  discardStaged: true,
  launchLocal: true,
  list: false,
  prepare: true,
  approve: true,
  cancel: true,
  withdraw: true,
  revokeCollection: true,
  reviewReactivation: true,
};

type DeclaredVerb = keyof typeof DECLARED_VERBS | keyof typeof DECLARED_WRITES;
type DynamicVerb =
  | "dataset"
  | "members"
  | "appPublication"
  | "ownerAppResponses"
  | "heldNoteChange"
  | "show";
type StaticLegacyVerb = Exclude<CliVerb, DeclaredVerb | DynamicVerb>;

const STATIC_LEGACY_WRITES: Readonly<Record<StaticLegacyVerb, boolean>> = {
  stopSync: true,
  link: false,
  shareCopy: false,
  shareAgents: false,
  shareDisconnect: true,
  accountDeletePreview: false,
  accountDelete: true,
  accessRefresh: true,
  accessObject: false,
  accessSharing: false,
  groups: false,
  groupCreate: true,
  threads: false,
  watch: false,
  inbox: false,
  notices: false,
  post: true,
  reply: true,
  nothingToReport: true,
  react: true,
  chatDelete: true,
  grep: false,
  export: true,
  moments: false,
  historyOperation: false,
  historyUndo: true,
  moment: false,
  fileChats: false,
  chat: false,
  groupsFull: false,
  collectionQuery: false,
  collectionRecord: false,
  collectionSetFields: true,
  collectionCreateRecord: true,
  fileWrite: true,
  fileDuplicate: true,
  fileMove: true,
  fileDelete: true,
  documentRead: false,
  documentHeld: false,
  versionList: false,
  versionCompare: false,
  versionConflicts: false,
  versionCreate: true,
  versionSwitch: true,
  versionMerge: true,
  versionUpdate: true,
  versionArchive: true,
  versionResolve: true,
  keptCopies: false,
  collectionsWaiting: false,
  sharedFilesHeld: false,
  syncFailure: false,
  saveKeptCopy: true,
  discardProtectedCopy: true,
  retainedCopies: false,
  deleteRetainedCopies: true,
  liveKeptEdits: false,
  saveRecoveryCopy: true,
  retryKeptEdits: true,
  stopAgain: true,
  keepOutsideChange: true,
  liveDocuments: false,
  liveStop: true,
  documentEdit: true,
  documentCreate: true,
  fileChatStart: true,
  automationRuns: false,
  automationList: false,
  automationHost: false,
  webhookList: false,
  automationSwitch: true,
  automationRun: false,
  automationRetry: true,
  automationPress: true,
  automationButtons: false,
};

export function isDatasetWriteAction(action: string): boolean {
  return Object.hasOwn(DATASET_WRITE_ACTIONS, action)
    ? DATASET_WRITE_ACTIONS[action as DatasetRequest["action"]]
    : false;
}

export function isCliWriteRequest(request: CliRequest): boolean {
  if (Object.hasOwn(DECLARED_VERBS, request.verb)) return false;
  if (Object.hasOwn(DECLARED_WRITES, request.verb)) return true;
  switch (request.verb) {
    case "dataset":
      return DATASET_WRITE_ACTIONS[request.args.request.action];
    case "members":
      return !(
        request.args.request.action === "list" ||
        (request.args.request.action === "group" && request.args.request.level === undefined)
      );
    case "appPublication":
      return APP_PUBLICATION_WRITE_ACTIONS[request.args.request.action];
    case "ownerAppResponses":
      return request.args.request.action !== "list";
    case "heldNoteChange":
      return request.args.action !== "review";
    case "show":
      return !request.args.peek;
    default:
      return STATIC_LEGACY_WRITES[request.verb as StaticLegacyVerb];
  }
}

// Called only with the dispatcher's validated result. The collector receives
// the aggregate pair, never arguments, content, paths or result objects.
export function cliUsageInvocation(
  request: CliRequest,
  result: CliResultByVerb[CliRequest["verb"]],
): CliUsageInvocation | null {
  if (result === null) return null;
  const id = cliCapabilityId(request);
  if (!covered.has(id)) return null;
  if (request.door === "mcp" && !mcpCovered.has(id)) return null;
  if ("ok" in result && !result.ok) return null;
  if ("replayed" in result && result.replayed) return null;
  if ("kind" in result && (result.kind === "refused" || result.kind === "partial")) return null;
  if (request.verb === "saveKeptCopy" && (!("status" in result) || result.status !== "saved"))
    return null;
  if (request.verb === "documentEdit" && (!("changed" in result) || !result.changed)) return null;
  if (
    request.verb === "automationSwitch" &&
    (!("result" in result) ||
      !result.result ||
      typeof result.result !== "object" ||
      !("status" in result.result) ||
      result.result.status !== "written")
  )
    return null;
  if (request.verb === "automationPress" && "outcome" in result && result.outcome !== null)
    return null;
  if ("kind" in result && result.kind === "recovery-prepared" && result.recovery === null)
    return null;
  if (
    request.verb === "ownerAppResponses" &&
    (!("items" in result) ||
      !result.items.length ||
      result.items.some((item) => item.status !== "deleted" && item.status !== "already-absent") ||
      !result.items.some((item) => item.status === "deleted"))
  )
    return null;
  return { capabilityId: id as ActionId, door: request.door ?? "cli" };
}
