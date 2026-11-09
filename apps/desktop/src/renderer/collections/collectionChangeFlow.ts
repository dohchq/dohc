import { datasetDefinitionDigestContent, datasetRevisionDigestContent, parseDatasetDefinition, type DatasetDefinition } from "@dohc/security-contract/dataset";
import type { DohcDesktopBridge, EngineMomentRecord } from "../../ipc/bridgeContract";
import {
  attributeCollectionChangeRows, collectionChangeDeletes, collectionChangeProposal, CollectionChangeProposal, collectionReviewRows, sameCollectionChange,
  type CollectionChangeAuthor, type CollectionChangeRow, type CollectionChangeStep,
} from "../../workspaces/collectionChange";
import { engineMomentAuthorName } from "../workbench/EngineHistory";

export type CollectionChangeApi = Pick<DohcDesktopBridge, "dataset" | "readWorkspaceText" | "listFileChats" | "listEngineMoments" | "readEngineMoment" | "createWorkspaceFile">;
type Api = CollectionChangeApi;
type Deletes = ReturnType<typeof collectionChangeDeletes>;

/** A file `dohc dataset askToApply` writes beside a Collection's dataset.json. */
export const COLLECTION_CHANGE_FILE = /(?:^|\/)changes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

export type CollectionChangeState =
  | { kind: "waiting" }
  /** The files no longer make the change shown. `by` and `atMs` name History's latest edit to them after the message. */
  | { kind: "edited"; by: CollectionChangeAuthor | null; atMs: number | null }
  /** `current`: the change is still the Collection's rules, so History can still reverse it. */
  | { kind: "applied"; current: boolean };
export interface CollectionChange { proposal: CollectionChangeProposal; rows: CollectionChangeRow[]; state: CollectionChangeState }

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** `datasetChangeDigest` of `describeDatasetRevision`, for the renderer, which has no node:crypto. */
export async function collectionChangeDigest(input: { definition: unknown; revision: number; schemaSql: string; operationSource: string; migrationSql: string }): Promise<string> {
  const definition = parseDatasetDefinition(input.definition);
  const [definitionSha256, schemaSha256, operationsSha256, migrationSha256] = await Promise.all([
    sha256(datasetDefinitionDigestContent(definition)), sha256(input.schemaSql), sha256(input.operationSource), sha256(input.migrationSql)]);
  const revisionSha256 = await sha256(datasetRevisionDigestContent({ datasetId: definition.datasetId, revision: input.revision, definition,
    definitionSha256, schemaSha256, operationsSha256, revisionSha256: "0".repeat(64) }));
  return sha256(JSON.stringify(["dohc-dataset-change-v1", revisionSha256, migrationSha256]));
}

/** Who made a saved version of a file, by the name its History row shows. */
export function momentAuthor(moment: EngineMomentRecord): CollectionChangeAuthor | null {
  const name = engineMomentAuthorName(moment);
  return name === undefined ? null : { name, agent: moment.agentAuthorName !== undefined };
}

async function readText(api: Api, workspaceId: string, relativePath: string): Promise<string | null> {
  try {
    const result = await api.readWorkspaceText({ workspaceId, relativePath });
    return result.truncated ? null : result.text;
  } catch { return null; }
}

/** A file's History, newest first. Attribution is best effort, so a file History can't read has none. */
async function momentsOf(api: Api, workspaceId: string, path: string): Promise<EngineMomentRecord[]> {
  try {
    const chats = await api.listFileChats({ workspaceId, path });
    if (!("fileObjectId" in chats) || chats.fileObjectId === null) return [];
    const page = await api.listEngineMoments({ workspaceId, objectId: chats.fileObjectId, limit: 50 });
    return "moments" in page ? page.moments : [];
  } catch { return []; }
}

const sameDefinition = (a: DatasetDefinition, b: DatasetDefinition) => datasetDefinitionDigestContent(a) === datasetDefinitionDigestContent(b);
const definitionOf = (text: string | null | undefined): DatasetDefinition | null => {
  if (typeof text !== "string") return null;
  try { return parseDatasetDefinition(JSON.parse(text)); } catch { return null; }
};

/**
 * The saved versions of dataset.json from the approved definition to the one
 * the message asked about, oldest first, with who saved each.
 */
async function definitionSteps(api: Api, workspaceId: string, moments: readonly EngineMomentRecord[], base: DatasetDefinition): Promise<CollectionChangeStep[]> {
  const newer: CollectionChangeStep[] = [];
  for (const moment of moments.slice(0, 20)) {
    if (moment.operation !== "write") continue;
    const read = await api.readEngineMoment({ workspaceId, momentId: moment.id }).catch(() => null);
    const definition = definitionOf(read && "moment" in read ? read.moment?.afterText : null);
    if (!definition) continue;
    if (sameDefinition(definition, base)) break;
    newer.push({ definition, author: momentAuthor(moment), atMs: moment.recordedAtMs });
  }
  return [{ definition: base, author: null, atMs: null }, ...newer.reverse()];
}

/** Who made each row, from the files' History up to `untilMs`. */
async function attribute(api: Api, workspaceId: string, proposal: CollectionChangeProposal, base: DatasetDefinition, untilMs: number) {
  const paths = [proposal.datasetPath, base.schemaPath, base.operationsPath, proposal.migrationPath];
  const history = new Map(await Promise.all(paths.map(async path => [path, await momentsOf(api, workspaceId, path)] as const)));
  const before = (path: string) => (history.get(path) ?? []).filter(moment => moment.recordedAtMs <= untilMs);
  const files = Object.fromEntries(paths.map(path => {
    const latest = before(path)[0];
    return [path, { author: latest ? momentAuthor(latest) : null, atMs: latest?.recordedAtMs ?? null }];
  }));
  const rows = attributeCollectionChangeRows(proposal.rows, { definitionPath: proposal.datasetPath, operationsPath: base.operationsPath, files,
    steps: await definitionSteps(api, workspaceId, before(proposal.datasetPath), base) });
  return { rows, paths, history };
}

/** A message's attached change file, which names its Collection. Null when the file isn't one. */
export async function readCollectionChangeProposal(api: Api, workspaceId: string, path: string): Promise<CollectionChangeProposal | null> {
  const text = await readText(api, workspaceId, path);
  if (text === null) return null;
  try { return CollectionChangeProposal.parse(JSON.parse(text)); } catch { return null; }
}

/** What applying a change file does, with who made each part and whether it still waits. */
export async function loadCollectionChange(api: Api, input: { workspaceId: string; proposal: CollectionChangeProposal; postedAtMs: number }): Promise<CollectionChange> {
  const { workspaceId, proposal, postedAtMs } = input;
  const selection = { workspaceId, datasetPath: proposal.datasetPath, expectedDatasetId: proposal.datasetId };
  const described = await api.dataset({ ...selection, action: "describe" });
  const saved = await api.dataset({ ...selection, action: "historyRevision", revisionSha256: proposal.base.revisionSha256 });
  if (described.kind !== "description" || saved.kind !== "history-revision") throw new Error(`dohc could not read ${proposal.name}.`);
  const head = described.dataset, base = saved.revision.definition;
  const { rows, paths, history } = await attribute(api, workspaceId, proposal, base, postedAtMs);
  const state = await changeState(api, { proposal, head, paths, history, postedAtMs, selection });
  return { proposal, rows, state };
}

async function changeState(api: Api, input: {
  proposal: CollectionChangeProposal; head: { revision: number; revisionSha256: string }; paths: readonly string[];
  history: ReadonlyMap<string, readonly EngineMomentRecord[]>; postedAtMs: number; selection: { workspaceId: string; datasetPath: string; expectedDatasetId: string };
}): Promise<CollectionChangeState> {
  const { proposal, head, selection } = input;
  if (head.revisionSha256 === proposal.revisionSha256) return { kind: "applied", current: true };
  if (head.revision > proposal.base.revision) {
    const saved = await api.dataset({ ...selection, action: "historyRevision", revisionSha256: proposal.revisionSha256 }).catch(() => null);
    if (saved?.kind === "history-revision") return { kind: "applied", current: false };
  }
  const definitionText = await readText(api, selection.workspaceId, proposal.datasetPath);
  const definition = definitionOf(definitionText);
  if (definition) {
    const [schemaSql, operationSource, migrationSql] = await Promise.all([definition.schemaPath, definition.operationsPath, proposal.migrationPath]
      .map(path => readText(api, selection.workspaceId, path)));
    if (schemaSql !== null && operationSource !== null && migrationSql !== null) {
      const digest = await collectionChangeDigest({ definition, revision: head.revision + 1, schemaSql, operationSource, migrationSql }).catch(() => null);
      if (digest === proposal.changeSha256) return { kind: "waiting" };
    }
  }
  const latest = input.paths.flatMap(path => input.history.get(path) ?? []).filter(moment => moment.recordedAtMs > input.postedAtMs)
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs)[0];
  return { kind: "edited", by: latest ? momentAuthor(latest) : null, atMs: latest?.recordedAtMs ?? null };
}

/**
 * Applies the change the card shows. It prepares the Collection's files
 * afresh and applies them only when they make the rows shown, with the digest
 * shown, so an edit to the files or to the attached file after the card loaded
 * can't change what Apply does. Records can come and go since then, which
 * changes only the counts, but it applies nothing that now deletes more than
 * shown. It returns the change it applied, counted as it applied it.
 *
 * A change can land without its confirmation arriving. Try again then finds
 * it already applied and returns it, since preparing it a second time can fail.
 */
export async function applyCollectionChange(api: Pick<Api, "dataset">, workspaceId: string,
  shown: { proposal: CollectionChangeProposal; rows: readonly CollectionChangeRow[] }): Promise<{ kind: "applied"; proposal: CollectionChangeProposal } | { kind: "edited" } | { kind: "deletes-more"; was: Deletes; now: Deletes }> {
  const { proposal } = shown;
  const selection = { workspaceId, datasetPath: proposal.datasetPath, expectedDatasetId: proposal.datasetId };
  const described = await api.dataset({ ...selection, action: "describe" });
  if (described.kind === "description" && described.dataset.revisionSha256 === proposal.revisionSha256) return { kind: "applied", proposal };
  const prepared = await api.dataset({ ...selection, action: "prepareMigration", migrationPath: proposal.migrationPath });
  if (prepared.kind !== "migration-prepared") throw new Error("dohc could not prepare this change.");
  let approving = false;
  try {
    let fresh: CollectionChangeProposal | null = null;
    try { fresh = collectionChangeProposal(prepared, { datasetPath: proposal.datasetPath, migrationPath: proposal.migrationPath, note: proposal.note }); }
    catch { fresh = null; }
    if (!fresh || fresh.changeSha256 !== proposal.changeSha256 || !sameCollectionChange(shown.rows, fresh.rows, { counts: false })) return { kind: "edited" };
    const was = collectionChangeDeletes(shown.rows), now = collectionChangeDeletes(fresh.rows);
    if (now.records > was.records || now.values > was.values) return { kind: "deletes-more", was, now };
    approving = true;
    const result = await api.dataset({ workspaceId, action: "approveMigration", preparationId: prepared.preparationId,
      revisionSha256: prepared.revision.revisionSha256, approvalDigest: prepared.approvalDigest, changeSha256: proposal.changeSha256 });
    if (result.kind !== "migrated") throw new Error("dohc could not confirm this change. Refresh the Collection.");
    return { kind: "applied", proposal: fresh };
  } finally {
    if (!approving) await api.dataset({ workspaceId, action: "discardMigration", preparationId: prepared.preparationId }).catch(() => undefined);
  }
}

/** Reverses an applied change that is still the Collection's rules, through History. */
export async function undoCollectionChange(api: Pick<Api, "dataset">, workspaceId: string, proposal: CollectionChangeProposal): Promise<void> {
  const selection = { workspaceId, datasetPath: proposal.datasetPath, expectedDatasetId: proposal.datasetId };
  const described = await api.dataset({ ...selection, action: "describe" });
  if (described.kind !== "description") throw new Error(`dohc could not read ${proposal.name}.`);
  if (described.dataset.revisionSha256 !== proposal.revisionSha256) throw new Error(`${proposal.name} changed after this change. Undo it from History.`);
  const prepared = await api.dataset({ ...selection, action: "prepareHistoryRestore", revision: described.dataset.revision, revisionSha256: described.dataset.revisionSha256,
    targetRevisionSha256: proposal.base.revisionSha256, changedRevisionSha256: proposal.revisionSha256 });
  if (prepared.kind !== "migration-prepared") throw new Error("dohc could not prepare the undo.");
  const result = await api.dataset({ workspaceId, action: "approveMigration", preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256, approvalDigest: prepared.approvalDigest });
  if (result.kind !== "migrated") throw new Error("dohc could not confirm the undo. Refresh the Collection.");
}

/** A change prepared for the review dialog: what applying it does now, and each changed file before and after. */
export interface CollectionChangeReview {
  change: CollectionChange;
  preparation: { preparationId: string; revisionSha256: string; approvalDigest: string };
  files: Array<{ path: string; before: string; after: string }>;
}

/**
 * Prepares the change the files make now, which can differ from the one the
 * message asked about. The dialog shows and applies this preparation, so what
 * it applies is what it shows. Discard it with `discardCollectionChangeReview`.
 */
export async function prepareCollectionChangeReview(api: Api, workspaceId: string, asked: CollectionChangeProposal): Promise<CollectionChangeReview> {
  const selection = { workspaceId, datasetPath: asked.datasetPath, expectedDatasetId: asked.datasetId };
  const prepared = await api.dataset({ ...selection, action: "prepareMigration", migrationPath: asked.migrationPath });
  if (prepared.kind !== "migration-prepared") throw new Error("dohc could not prepare this change.");
  try {
    const proposal = collectionChangeProposal(prepared, { datasetPath: asked.datasetPath, migrationPath: asked.migrationPath, note: asked.note });
    const saved = await api.dataset({ ...selection, action: "historyRevision", revisionSha256: prepared.previousRevision.revisionSha256 });
    if (saved.kind !== "history-revision") throw new Error(`dohc could not read ${asked.name}.`);
    const { schemaPath, operationsPath } = prepared.revision.definition;
    const listed = { ...proposal, rows: collectionReviewRows(proposal.rows, { files: proposal.files, schemaPath, operationsPath }) };
    const { rows } = await attribute(api, workspaceId, listed, saved.revision.definition, Number.MAX_SAFE_INTEGER);
    const definition = (value: DatasetDefinition) => `${JSON.stringify(value, null, 2)}\n`;
    const sides: Record<string, { before: string; after: string }> = {
      [asked.datasetPath]: { before: definition(prepared.previousRevision.definition), after: definition(prepared.revision.definition) },
      [schemaPath]: { before: saved.schemaSql, after: prepared.schemaSql },
      [operationsPath]: { before: saved.operationSource, after: prepared.operationSource },
      [asked.migrationPath]: { before: "", after: prepared.migrationSql },
    };
    return { change: { proposal, rows, state: { kind: "waiting" } },
      preparation: { preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256, approvalDigest: prepared.approvalDigest },
      files: proposal.files.map(path => ({ path, ...sides[path]! })) };
  } catch (error) {
    await api.dataset({ workspaceId, action: "discardMigration", preparationId: prepared.preparationId }).catch(() => undefined);
    throw error;
  }
}

/** Applies the reviewed preparation, bound to the change the dialog showed. */
export async function applyCollectionChangeReview(api: Pick<Api, "dataset">, workspaceId: string, review: CollectionChangeReview): Promise<void> {
  const result = await api.dataset({ workspaceId, action: "approveMigration", ...review.preparation, changeSha256: review.change.proposal.changeSha256 });
  if (result.kind !== "migrated") throw new Error("dohc could not confirm this change. Refresh the Collection.");
}

/**
 * Saves a reviewed change that differs from the one asked, as a change file
 * beside the Collection's, so the reply that applied it can attach it.
 */
export async function recordCollectionChange(api: Pick<Api, "createWorkspaceFile">, workspaceId: string, proposal: CollectionChangeProposal): Promise<string> {
  const folder = proposal.datasetPath.includes("/") ? proposal.datasetPath.slice(0, proposal.datasetPath.lastIndexOf("/") + 1) : "";
  const created = await api.createWorkspaceFile({ workspaceId, relativePath: `${folder}changes/${crypto.randomUUID()}.json`,
    initialText: `${JSON.stringify(proposal, null, 2)}\n`, exclusive: true });
  return created.path;
}

export async function discardCollectionChangeReview(api: Pick<Api, "dataset">, workspaceId: string, review: CollectionChangeReview): Promise<void> {
  await api.dataset({ workspaceId, action: "discardMigration", preparationId: review.preparation.preparationId });
}
