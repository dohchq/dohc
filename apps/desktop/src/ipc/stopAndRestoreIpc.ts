import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import {
  LiveDocumentMutationError,
  RestoreFolderInUseError,
  RestoreHeadChangedError,
  type WorkspaceEngineCapture,
} from "../workspaces/workspaceEngineCapture";
import { restoreDirectWrites, type DirectWriteFile } from "../workspaces/stopAndRestore";
import { folderEntriesOrNone } from "../workspaces/folderEntries";
import {
  StopAndRestorePayload,
  StopAndRestoreResult,
  UndoStopAndRestorePayload,
  type DeleteWorkspacePathPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { createOwnerRelayShareHandler } from "./ownerRelayShareHandler";

// Stop and restore (ADR 0013) in main. The renderer names a person or an
// Edit share link; main finds the grants on this workspace from the relay's
// own listings, revokes each that can write, reads every direct write they
// made from the relay's ledger, and restores through the engine. The relay
// answers the ledger to the workspace's owner only.
//
// A link is ended as a whole, with everyone who opened it in dohc: blocking
// one of its holders would leave the others writing. Its ledger holds the
// writes of every generation of its grant.

// Grants that can write a Collection's files directly: Edit on files, or a
// Group's read-write.
const WRITING_ACCESS = new Set(["edit", "read-write"]);
// A grant's ledger in pages of 100 writes; past this many pages dohc stops.
const MAX_LEDGER_PAGES = 1_000;
// The owner's links in pages of 1,000; past this many pages dohc stops.
const MAX_LINK_PAGES = 50;
// Ending a link names its dependents. Someone who opens it meanwhile changes
// them, so dohc lists again and retries this many times.
const LINK_END_ATTEMPTS = 3;

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
// A link as the owner's link listing shows it.
const LinkRow = z.object({
  shareId: ID,
  grantId: ID,
  status: z.enum(["active", "revoked"]),
  dependents: z.array(z.object({ grantId: ID })),
});
const LinkPage = z.object({ links: z.array(z.unknown()), nextCursor: z.string().min(1).max(1024).optional() });
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
  /** Ends a link, or answers that its dependents changed since they were listed. */
  endLink(credentials: Credentials, path: string, init: RequestInit): Promise<"ended" | "dependents-changed">;
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

  registerHandler(CHANNELS.stopAndRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopAndRestorePayload.parse(payload);
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const workspaceId = operation.workspace.workspaceId;
      const relay = <Result>(path: string, init?: RequestInit) => session.run(() => relayJson<Result>(credentials, path, init));

      // Stop first, so no write lands while the files go back.
      let grantIds: string[];
      if (input.target.kind === "person") {
        const { userId } = input.target;
        const listing = GrantedListing.parse(await relay<unknown>("/sync/shares"));
        const grants = listing.granted.flatMap((row) => {
          const grant = PersonGrant.safeParse(row);
          return grant.success && grant.data.workspaceId === workspaceId && grant.data.recipientUserId === userId
            ? [grant.data]
            : [];
        });
        if (grants.length === 0) throw new Error("dohc found no share of this workspace with this person.");
        const writing = grants.filter((grant) => grant.revokedAtMs === null && WRITING_ACCESS.has(grant.access));
        try {
          for (const grant of writing) {
            await relay<unknown>(
              `/sync/shares/${encodeURIComponent(grant.shareId)}/grants/${encodeURIComponent(grant.grantId)}/revoke`,
              { method: "POST", body: JSON.stringify({ workspaceId }) },
            );
          }
        } finally {
          if (writing.length > 0) dependencies.sharesChanged(workspaceId);
        }
        grantIds = grants.map((grant) => grant.grantId);
      } else {
        const { grantId } = input.target;
        const findLink = async () => {
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LINK_PAGES; page += 1) {
            const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
            const answer = LinkPage.parse(await relay<unknown>(`/sync/${encodeURIComponent(workspaceId)}/shares/links${query}`));
            for (const value of answer.links) {
              const link = LinkRow.safeParse(value);
              if (link.success && link.data.grantId === grantId) return link.data;
            }
            cursor = answer.nextCursor;
            if (cursor === undefined) return null;
          }
          throw new Error("This workspace has more share links than dohc can read at once.");
        };
        let ended = false;
        try {
          for (let attempt = 1; ; attempt += 1) {
            const link = await findLink();
            if (link === null) throw new Error("dohc found no share link of this workspace with this id.");
            if (link.status === "revoked") break;
            ended = true;
            const answer = await session.run(() => dependencies.endLink(
              credentials,
              `/sync/shares/${encodeURIComponent(link.shareId)}/revoke`,
              {
                method: "POST",
                body: JSON.stringify({
                  grantId, workspaceId, expectedDependentGrantIds: link.dependents.map((dependent) => dependent.grantId),
                }),
              },
            ));
            if (answer === "ended") break;
            // Someone opened the link meanwhile; list its dependents again.
            if (attempt === LINK_END_ATTEMPTS) {
              throw new Error("People kept opening this link while dohc ended it. Try again.");
            }
          }
        } finally {
          if (ended) dependencies.sharesChanged(workspaceId);
        }
        grantIds = [grantId];
      }

      const writes: Array<{ committedAtMs: number; files: DirectWriteFile[] }> = [];
      for (const grantId of grantIds) {
        let after: number | null = -1;
        for (let page = 0; after !== null; page += 1) {
          if (page === MAX_LEDGER_PAGES) throw new Error("dohc cannot restore this many direct changes at once.");
          const answer = LedgerPage.parse(await relay<unknown>(
            `/sync/${encodeURIComponent(workspaceId)}/collection-writes/${encodeURIComponent(grantId)}?afterOriginSeq=${after}`,
          ));
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
      return StopAndRestoreResult.parse(outcome);
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
