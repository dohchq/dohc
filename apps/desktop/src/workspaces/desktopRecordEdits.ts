import { join } from "node:path";
import {
  runCollectionRecordCreation,
  type CollectionRecordEditAdapter,
  type CollectionRecordEditContext,
  type CreateCollectionRecordInput,
} from "@dohc/automation-executor/collection-record-edits";
import { readWorkspaceText } from "./workspaceAssets";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { requirePublishedWrite, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

/** This computer's person, with main's signed evidence for one workspace. */
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

/**
 * The record edit context over this desktop's capture. A record opens as the
 * capture's live document session. Creation goes through the engine with the
 * author main admitted. Each settled capture pass announces record adoption.
 * Every write in the context carries the one person the host read, so an
 * account change during the write cannot relabel any of its updates.
 */
export function desktopRecordEditContext(host: DesktopRecordEditHost): CollectionRecordEditContext {
  const { capture, workspaceRoot, signal, person } = host;
  const pinned = person.authorContext === undefined ? {} : { authorContext: person.authorContext };
  return {
    openRecord: (path) => capture.openRecordSession(path, person.authorContext),
    async createFile(path, text, author) {
      const admittedAuthor = author.kind === "automation" || author.kind === "agent"
        ? { ...author, ...pinned } : person;
      requirePublishedWrite(path, await capture.writeAuthoredFile(join(workspaceRoot, path), text, admittedAuthor, {
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
  input: Omit<CreateCollectionRecordInput, "author"> & { workspaceId: string },
  host: {
    author: CreateCollectionRecordInput["author"];
    localPerson(workspaceId: string): Promise<LocalPersonAuthor>;
    withWorkspaceOperation<T>(work: (operation: Operation) => Promise<T>): Promise<T>;
    editContext(operation: Operation, person: LocalPersonAuthor): Promise<CollectionRecordEditContext>;
  },
): ReturnType<typeof runCollectionRecordCreation> {
  const person = await host.localPerson(input.workspaceId);
  return runCollectionRecordCreation(work => host.withWorkspaceOperation(async operation =>
    work(await host.editContext(operation, person))), { ...input, author: host.author });
}
