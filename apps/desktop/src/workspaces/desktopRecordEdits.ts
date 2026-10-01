import { join } from "node:path";
import {
  runCollectionRecordCreation,
  type CollectionRecordEditAdapter,
  type CollectionRecordEditContext,
  type CreateCollectionRecordInput,
  type RecordEditSession,
} from "@dohc/automation-executor/collection-record-edits";
import { readWorkspaceText } from "./workspaceAssets";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { requirePublishedWrite, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

/** This computer's person, as desktop main read them. */
export type LocalPersonAuthor = Extract<MomentWriteAuthor, { kind: "human" }>;

/** What this desktop's record writes in one workspace run over. Main supplies it. */
export interface DesktopRecordEditHost {
  capture: Pick<WorkspaceEngineCapture, "openRecordSession" | "writeAuthoredFile">;
  workspaceRoot: string;
  /** The person, read when the write was requested. */
  person: LocalPersonAuthor;
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: CollectionRecordEditAdapter) => Promise<T>,
  ): Promise<T | null>;
  /**
   * Subscribes to the engine's announcement of each settled capture pass in
   * this workspace: the paths the pass captured or reconciled, or null when
   * the announcement did not list them all. Returns the unsubscribe.
   */
  onCaptureSettled(listener: (paths: readonly string[] | null) => void): () => void;
  signal: AbortSignal;
}

// A person's field edit names the person main read. An agent's or an
// automation's keeps the person its run names.
function byPerson(session: RecordEditSession, personId: string): RecordEditSession {
  return {
    applyDecidedLocalUpdate: (decide, onArmed, options) => session.applyDecidedLocalUpdate(decide, onArmed,
      options.attribution?.actorKind === "human"
        ? { ...options, actorOriginId: personId, attribution: { actorKind: "human", onBehalfOf: personId, depth: 0 } }
        : options),
    settleNow: options => session.settleNow(options),
    close: () => session.close(),
  };
}

/**
 * The record edit context over this desktop's capture. A record opens as the
 * capture's live document session. Creation goes through the engine. Each
 * settled capture pass announces record adoption. A person's writes in the
 * context name the one person the host read, so an account change during the
 * write cannot relabel them.
 */
export function desktopRecordEditContext(host: DesktopRecordEditHost): CollectionRecordEditContext {
  const { capture, workspaceRoot, signal, person } = host;
  return {
    openRecord: async (path) => byPerson(await capture.openRecordSession(path), person.humanId),
    async createFile(path, text, author) {
      const named = author.kind === "automation" || author.kind === "agent" ? author : person;
      requirePublishedWrite(path, await capture.writeAuthoredFile(join(workspaceRoot, path), text, named, {
        createOnly: true,
        signal,
      }));
      return path;
    },
    readText: (path) => readWorkspaceText(workspaceRoot, path),
    withAdapter: host.withAdapter,
    onRecordsChanged: host.onCaptureSettled,
    signal,
  };
}

/**
 * A person's request to create a record by hand. The person is read when the
 * request arrives, before it waits for its workspace and engine capture.
 */
export async function createRecordByHand<Operation>(
  input: Omit<CreateCollectionRecordInput, "author">,
  host: {
    author: CreateCollectionRecordInput["author"];
    localPerson(): Promise<LocalPersonAuthor>;
    withWorkspaceOperation<T>(work: (operation: Operation) => Promise<T>): Promise<T>;
    editContext(operation: Operation, person: LocalPersonAuthor): Promise<CollectionRecordEditContext>;
  },
): ReturnType<typeof runCollectionRecordCreation> {
  const person = await host.localPerson();
  return runCollectionRecordCreation(work => host.withWorkspaceOperation(async operation =>
    work(await host.editContext(operation, person))), { ...input, author: host.author });
}
