import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import type { CollectionAutomations } from "../automations/collectionAutomations";
import {
  LiveDocumentMutationError,
  RestoreFolderInUseError,
  RestoreHeadChangedError,
  type WorkspaceEngineCapture,
} from "../workspaces/workspaceEngineCapture";
import { restoreDirectWrites, type DirectWriteFile } from "../workspaces/stopAndRestore";
import { folderEntriesOrNone } from "../workspaces/folderEntries";
import {
  StopAndRestorePersonPayload,
  StopAndRestorePersonResult,
  UndoStopAndRestorePayload,
  type DeleteWorkspacePathPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { createOwnerRelayShareHandler } from "./ownerRelayShareHandler";

// Stop and restore (ADR 0013) in main. The renderer names a person; main
// finds that person's grants on this workspace from the relay's own listing,
// revokes each that can write, reads every direct write they made from the
// relay's ledger, and restores through the engine. The relay answers the
// ledger to the workspace's owner only.

// Grants that can write a Collection's files directly: Edit on files, or a
// Group's read-write.
const WRITING_ACCESS = new Set(["edit", "read-write"]);
// A grant's ledger in pages of 100 writes; past this many pages dohc stops.
const MAX_LEDGER_PAGES = 1_000;

const ID = z.string().min(1).max(512);
const GrantedListing = z.object({ granted: z.array(z.unknown()) });
// A person's grant as the relay lists it. A row of another shape, such as a
// link's, is no person's grant.
const PersonGrant = z.object({
  shareId: ID,
  workspaceId: ID,
  grantId: ID,
  recipientUserId: ID,
  access: z.string(),
  revokedAtMs: z.number().nullable(),
});
const LedgerPage = z.object({
  writes: z.array(z.object({
    committedAtMs: z.number(),
    files: z.array(z.object({
      // Main reads and removes folders by these paths, so none leaves the workspace.
      path: z.string().max(4096).refine(isNormalizedRelativePath),
      objectId: ID,
      momentId: ID,
      created: z.boolean(),
    })),
  })),
  nextAfterOriginSeq: z.number().int().nullable(),
});

export function registerStopAndRestoreIpc<
  Sender,
  Event extends { sender: Sender },
  Workspace extends { workspaceId: string; rootPath: string; shareView?: unknown },
  Operation extends {
    workspace: Workspace;
    readonly state: { readonly collectionAutomations: CollectionAutomations };
    assertCurrent(): void;
  },
  Credentials,
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: Credentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayJson<Result>(credentials: Credentials, path: string, init?: RequestInit): Promise<Result>;
  /** A grant changed on the relay: the share roster lists again. */
  sharesChanged(workspaceId: string): void;
  requireEngineCapture(workspaceId: string): Promise<{
    capture: Pick<WorkspaceEngineCapture, "readMoment" | "listObjectMomentsAfter" | "restoreFileToBeforeMoment">;
  }>;
  /** Asks the workspace's sync to pull now. */
  queuePull(workspaceId: string): void;
  /** A person's delete: the OS trash, or the workspace's .dohc/trash. */
  deletePath(event: Event, payload: DeleteWorkspacePathPayload): Promise<unknown>;
  notifyRenderer(input: { workspaceId: string }): void;
  /** Only the original workspace has grants to stop. */
  assertOriginalWorkspace(workspace: Workspace): void;
}): void {
  const { registerHandler, assertTrustedSender, relayJson } = dependencies;
  const ownerRelayShareHandler = createOwnerRelayShareHandler<Sender, Workspace, Operation, Credentials>({
    withWorkspaceOperation: dependencies.withRendererWorkspaceOperation,
    remoteForWorkspace: dependencies.remoteForWorkspace,
    credentialGeneration: dependencies.currentCredentialGeneration,
  });

  registerHandler(CHANNELS.stopAndRestorePerson, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopAndRestorePersonPayload.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const workspaceId = operation.workspace.workspaceId;
      const listing = GrantedListing.parse(await session.run(() => relayJson<unknown>(credentials, "/sync/shares")));
      const grants = listing.granted.flatMap((row) => {
        const grant = PersonGrant.safeParse(row);
        return grant.success && grant.data.workspaceId === workspaceId && grant.data.recipientUserId === input.userId
          ? [grant.data]
          : [];
      });
      if (grants.length === 0) throw new Error("dohc found no share of this workspace with this person.");

      // Stop first, so no write lands while the files go back.
      const writing = grants.filter((grant) => grant.revokedAtMs === null && WRITING_ACCESS.has(grant.access));
      try {
        for (const grant of writing) {
          await session.run(() => relayJson<unknown>(
            credentials,
            `/sync/shares/${encodeURIComponent(grant.shareId)}/grants/${encodeURIComponent(grant.grantId)}/revoke`,
            { method: "POST", body: JSON.stringify({ workspaceId }) },
          ));
        }
      } finally {
        if (writing.length > 0) dependencies.sharesChanged(workspaceId);
      }

      const writes: Array<{ committedAtMs: number; files: DirectWriteFile[] }> = [];
      for (const grant of grants) {
        let after: number | null = -1;
        for (let page = 0; after !== null; page += 1) {
          if (page === MAX_LEDGER_PAGES) throw new Error("This person made more direct changes than dohc can restore at once.");
          const answer = LedgerPage.parse(await session.run(() => relayJson<unknown>(
            credentials,
            `/sync/${encodeURIComponent(workspaceId)}/collection-writes/${encodeURIComponent(grant.grantId)}?afterOriginSeq=${after}`,
          )));
          writes.push(...answer.writes);
          after = answer.nextAfterOriginSeq;
        }
      }
      writes.sort((left, right) => left.committedAtMs - right.committedAtMs);

      const { capture } = await dependencies.requireEngineCapture(workspaceId);
      const root = operation.workspace.rootPath;
      const outcome = await restoreDirectWrites({
        moment: async (momentId) => {
          const detail = await capture.readMoment(momentId);
          if (detail?.protected) {
            throw new Error(`dohc cannot restore ${detail.moment.path} here because its contents are protected. Restore it from its History.`);
          }
          return detail?.moment ?? null;
        },
        momentsAfter: (objectId, momentId) => capture.listObjectMomentsAfter(objectId, momentId),
        assertCurrent: () => operation.assertCurrent(),
        restore: async (momentId, expectedHeadMomentId, aloneInFolder) => {
          try {
            const { path, restoredMomentId } = await capture.restoreFileToBeforeMoment(momentId, {
              expectedHeadMomentId,
              ...(aloneInFolder ? { aloneInFolder: true } : {}),
            });
            return { kind: "restored", receipt: { path, restoredMomentId } };
          } catch (error) {
            if (error instanceof RestoreHeadChangedError) return { kind: "changed" };
            if (error instanceof RestoreFolderInUseError) return { kind: "folder-in-use" };
            if (error instanceof LiveDocumentMutationError) return { kind: "refused", detail: error.message };
            throw error;
          }
        },
        folderEntries: (path) => folderEntriesOrNone(join(root, path)),
        removeEmptyFolder: async (path) => await rmdir(join(root, path)).catch(() => undefined),
        undoRuns: (definitions) => operation.state.collectionAutomations.undoRunsOf(definitions, async (relativePath) => {
          await dependencies.deletePath(event, { workspaceId, relativePath });
        }),
      }, writes.flatMap((write) => write.files));
      if (outcome.status === "waiting") dependencies.queuePull(workspaceId);
      else dependencies.notifyRenderer({ workspaceId });
      return StopAndRestorePersonResult.parse(outcome);
    }, dependencies.assertOriginalWorkspace);
  });

  // Undo for a stop and restore: each file goes back to how the person left
  // it, newest restore first. Access stays stopped.
  registerHandler(CHANNELS.undoStopAndRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = UndoStopAndRestorePayload.parse(payload);
    await dependencies.withRendererWorkspaceOperation(
      event.sender, input.workspaceId, "Undo stopped because this window changed workspaces.",
      async (operation) => {
        const { capture } = await dependencies.requireEngineCapture(operation.workspace.workspaceId);
        try {
          for (const momentId of [...input.restoredMomentIds].reverse()) {
            operation.assertCurrent();
            await capture.restoreFileToBeforeMoment(momentId);
          }
        } finally {
          dependencies.notifyRenderer({ workspaceId: operation.workspace.workspaceId });
        }
      },
    );
  });
}
