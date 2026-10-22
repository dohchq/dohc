import { rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { durableBatch } from "@dohc/automation-executor/durable-batch";
import { restoreRequestId } from "../workspaces/restoreWriteIdentity";
import { isCaptureRecoveryOrigin } from "@dohc/workspace-contracts/engine";
import { join } from "node:path";
import { z } from "zod";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import type { CollectionAutomations, KeptAutomationField } from "@dohc/automation-executor/collection-automations";
import type { PendingRestore } from "@dohc/automation-executor/automation-run-store";
import type { ServerRuns } from "../automations/serverRuns";
import {
  LiveDocumentMutationError,
  RestoreFolderInUseError,
  RestoreHeadChangedError,
  RestoreLocalChangesError,
  RestorePolicyRefusalError,
  type WorkspaceEngineCapture,
} from "../workspaces/workspaceEngineCapture";
import { restoreDirectWrites, UndoRunsStopped, type DirectWriteFile, type UndoneRuns } from "../workspaces/stopAndRestore";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import { folderEntriesOrNone } from "../workspaces/folderEntries";
import {
  StopAndRestorePayload,
  stopAndRestoreRecoveryOperations,
  StopAndRestoreResult,
  UndoStopAndRestorePayload,
  UndoStopAndRestoreResult,
  type DeleteWorkspacePathPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { registerOperations } from "./operationTable";
import { readError } from "./errorWords";
import { createOwnerRelayShareHandler } from "./ownerRelayShareHandler";

// A refused file's reason, as the person reads it. A file History no longer
// tracks is refused in dohc's words. Unreadable rules are their own typed
// outcome, which names the files and leaves the parser's text out.
function refusalDetail(error: Error): string {
  return error instanceof RestorePolicyRefusalError ? readError(error).words ?? error.message : error.message;
}

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
// Stop and restore undoes runs in at most this many passes; each after the
// first puts back at least one field, or ends.
const UNDO_PASSES = 8;

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
      publicPrincipalId: ID.optional(),
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
  hasOtherWorkspaceWindow?(sender: Sender, workspaceId: string): boolean;
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
    capture: Pick<WorkspaceEngineCapture, "readMoment" | "listObjectMomentsAfter" | "restoreFileToBeforeMoment" | "findRestoreReceipt" | "publicationApplied">;
  }>;
  /** The person a request is made by, read from main's own account when it arrives. */
  localPerson(): Promise<LocalPersonAuthor>;
  /** Asks the workspace's sync to pull now. */
  queuePull(workspaceId: string): void;
  /** Runs one sync pass of the workspace now, pushing and pulling, and throws when it did not sync. */
  syncNow(workspaceId: string): Promise<void>;
  /** A person's delete: the OS trash, or the workspace's .dohc/local/trash. */
  deletePath(event: Event, payload: DeleteWorkspacePathPayload): Promise<unknown>;
  notifyRenderer(input: { workspaceId: string }): void;
  /** Only the original workspace has grants to stop. */
  assertOriginalWorkspace(workspace: Workspace): void;
  /** The owner's self-hosted server's runs. */
  serverRuns: Pick<ServerRuns, "restore" | "releaseRestore">;
  /** Resolve the current attachment each time; never retain an attachment across a network request. */
  currentAutomations(workspaceId: string): CollectionAutomations | undefined;
  canReleaseRuns(workspaceId: string): boolean;
}): {retryServerReleases(): void} {
  const { registerHandler, assertTrustedSender, relayJson } = dependencies;
  const ownerRelayShareHandler = createOwnerRelayShareHandler<Sender, Workspace, Operation, Credentials>({
    withWorkspaceOperation: dependencies.withRendererWorkspaceOperation,
    remoteForWorkspace: dependencies.remoteForWorkspace,
    credentialGeneration: dependencies.currentCredentialGeneration,
  });

  // Per workspace and person or link, the fields each computer's runs kept at
  // its last pass that finished. A try that stops before a computer's pass
  // finishes keeps that computer's earlier fields instead of counting none.
  const keptByTarget = new Map<string, { server: KeptAutomationField[]; here: KeptAutomationField[]; latest: "server" | "here" }>();
  const knownKept = (target: string): KeptAutomationField[] => {
    const kept = keptByTarget.get(target);
    if (!kept) return [];
    const earlier = kept.latest === "here" ? kept.server : kept.here;
    return [...new Map([...earlier, ...kept[kept.latest]].map((field) => [field.id, field])).values()];
  };
  const restoreId = (target: {kind: "person"; userId: string} | {kind: "link"; grantId: string}) =>
    target.kind === "person" ? `person:${target.userId}` : `link:${target.grantId}`;
  const interrupted = (): Extract<StopAndRestoreResult, {status: "restored"}> => ({status: "restored", restored: [], review: [], runsUndone: 0,
    runsLeft: 0, runChangesKept: 0, wroteAutomations: false, sendsMessages: false, keptFields: [], fieldsMissing: 0,
    unfinished: {step: "files", message: "dohc has not finished restoring files."}});
  const releaseWorkspaces = new Set<string>();
  const releasing = new Set<string>();
  const retryRequested = new Set<string>();
  const activeUndos = new Map<string, {released: boolean}>();
  const retryServerReleases = (workspaceId: string) => {
    releaseWorkspaces.add(workspaceId);
    if (!dependencies.canReleaseRuns(workspaceId)) return;
    if (releasing.has(workspaceId)) {retryRequested.add(workspaceId); return;}
    releasing.add(workspaceId);
    void (async () => {
      const automations = dependencies.currentAutomations(workspaceId);
      if (!automations) return;
      for (const entry of await automations.pendingRestores()) {
        if (!entry.serverRelease || activeUndos.has(entry.id)) continue;
        try {
          if (!dependencies.canReleaseRuns(workspaceId) || !dependencies.currentAutomations(workspaceId)) return;
          if (await dependencies.serverRuns.releaseRestore(workspaceId, entry.id)) {
            await dependencies.currentAutomations(workspaceId)?.removePendingRestore(entry.id);
          }
        } catch { /* Keep the release queued for the next recovery or sign-in. */ }
      }
    })().catch(() => undefined).finally(() => {
      releasing.delete(workspaceId);
      if (retryRequested.delete(workspaceId)) retryServerReleases(workspaceId);
    });
  };
  const releasePending = async (workspaceId: string, automations: CollectionAutomations, entry: PendingRestore, reason: "complete" | "dismiss" = "complete") => {
    if (reason !== "dismiss" && entry.session?.undoingFiles) {
      throw new Error("dohc has not finished undoing these files. Try again.");
    }
    const active = activeUndos.get(entry.id);
    if (active) active.released = true;
    await automations.savePendingRestore({id: entry.id, claims: [], session: undefined, serverRelease: true});
    retryServerReleases(workspaceId);
  };
  registerOperations<typeof stopAndRestoreRecoveryOperations, Event, Operation>({
    handle: registerHandler,
    assertTrustedSender,
    withActiveWorkspace: (event: Event, workspaceId, inactiveMessage, work) =>
      dependencies.withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
  }, stopAndRestoreRecoveryOperations, {
    dismissStopAndRestore: async (input, {operation}) => {
      dependencies.assertOriginalWorkspace(operation.workspace);
      for (const entry of await operation.state.collectionAutomations.pendingRestores()) {
        if (entry.session && restoreId(entry.session.target) === restoreId(input.target)) {
          await releasePending(operation.workspace.workspaceId, operation.state.collectionAutomations, entry, "dismiss");
          operation.assertCurrent();
        }
      }
    },
    pendingStopAndRestores: async (_input, { operation }) => {
      dependencies.assertOriginalWorkspace(operation.workspace);
      retryServerReleases(operation.workspace.workspaceId);
      const pending = await operation.state.collectionAutomations.pendingRestores();
      operation.assertCurrent();
      return pending.flatMap(entry => {
        if (!entry.session) return [];
        const result = StopAndRestoreResult.parse(entry.session.result);
        return [{...entry.session, result: result.status === "restored"
          ? {...result, canUndoFiles: entry.session.receipts.length > 0 || (entry.session.intents?.length ?? 0) > 0} : result}];
      });
    },
  });

  /**
   * Undoes the runs of these definitions on the owner's server and here. A
   * run on one of them may have written a field after a run on the other,
   * in an order neither records, so Undo keeps a field that no longer holds
   * what its run wrote. Each later pass syncs, then tries only the kept
   * fields again, and stops when a pass puts nothing back: a field goes back
   * only while it holds what the run wrote, so a repeat changes nothing else.
   */
  async function undoRunsHereAndOnServer(
    workspaceId: string,
    target: string,
    definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>,
    undoHere: (again: boolean) => ReturnType<CollectionAutomations["undoRunsOf"]>,
    retentionId: string,
    automations: CollectionAutomations,
  ): Promise<UndoneRuns> {
    const counts = { undone: 0, left: 0, missing: 0, otherKept: 0, errorMessage: null, sharedReversals: [] as NonNullable<UndoneRuns["sharedReversals"]> };
    // The fields each computer's runs still keep, by identity: one kept on both appears once.
    const kept = keptByTarget.get(target) ?? { server: [], here: [], latest: "here" as const };
    keptByTarget.set(target, kept);
    const total = (): UndoneRuns => ({ ...counts, keptFields: knownKept(target) });
    const add = (host: "server" | "here", pass: UndoneRuns, again: boolean) => {
      if (!again) {
        counts.undone += pass.undone;
        counts.left += pass.left;
      }
      counts.missing += pass.missing;
      counts.otherKept += pass.otherKept;
      counts.sharedReversals.push(...(pass.sharedReversals ?? []));
      if (pass.errorMessage !== null) throw new UndoRunsStopped(pass.errorMessage, total());
      kept[host] = pass.keptFields;
      kept.latest = host;
    };
    const active = {released: false};
    activeUndos.set(retentionId, active);
    const stillPending = async () => {
      if (active.released) return false;
      const current = dependencies.currentAutomations(workspaceId);
      if (current !== automations) throw new Error("This workspace was closed. Open it again.");
      const entry = (await current.pendingRestores()).find(entry => entry.id === retentionId);
      active.released = !entry?.session || entry.serverRelease === true;
      return !active.released;
    };
    try {
      for (let pass = 0; pass < UNDO_PASSES; pass += 1) {
        if (!await stillPending()) break;
        const again = pass > 0;
        let server: Awaited<ReturnType<ServerRuns["restore"]>>;
        try {
          server = await dependencies.serverRuns.restore(workspaceId, definitions, again, retentionId).catch((error: unknown) => {
            if (error instanceof z.ZodError) throw new Error("Your server runs a different version of dohc. Update it, then try again.");
            throw error;
          });
        }
        finally {
          // A retain may land after dismissal's release. Queue its release again, including on a lost response.
          if (!await stillPending()) {
            const current = dependencies.currentAutomations(workspaceId);
            if (current) await releasePending(workspaceId, current, {id: retentionId, claims: []});
          }
        }
        if (active.released) break;
        add("server", server, again);
        // What the server put back reaches this computer, and what this one puts back reaches the server.
        await dependencies.syncNow(workspaceId);
        if (!await stillPending()) break;
        const here = await undoHere(again);
        add("here", here, again);
        await dependencies.syncNow(workspaceId);
        if (again && server.reverted + here.reverted === 0) break;
      }
    } catch (error) {
      // What it undid before it stopped is reported with why it stopped.
      throw new UndoRunsStopped(error instanceof z.ZodError
        ? "dohc could not finish undoing these runs."
        : error instanceof Error ? error.message : String(error), total());
    } finally {
      activeUndos.delete(retentionId);
      if (active.released) retryServerReleases(workspaceId);
    }
    return total();
  }

  registerHandler(CHANNELS.stopAndRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = StopAndRestorePayload.parse(payload);
    const person = await dependencies.localPerson();
    return ownerRelayShareHandler(event.sender, input.workspaceId, async (operation, credentials, session) => {
      const workspaceId = operation.workspace.workspaceId;
      const relay = <Result>(path: string, init?: RequestInit) => session.run(() => relayJson<Result>(credentials, path, init));
      const automations = operation.state.collectionAutomations;
      const targetKey = restoreId(input.target);
      // Finish the old Undo without losing a Stop for newly granted access.
      // An unreadable store must still let Stop revoke access before reporting it.
      let entries = await automations.pendingRestores().then(pending => pending.filter(entry =>
        entry.session && restoreId(entry.session.target) === targetKey)).catch(() => undefined);
      let interruptedUndo = entries?.find(entry => entry.session?.undoingFiles || entry.session?.nextGrants?.length);
      let followingRestore = entries?.find(entry => entry.session?.restoreGrants?.length);
      let nextRestoreId = interruptedUndo ? `${interruptedUndo.id}:next` : undefined;
      const releaseTarget = async () => {
        for (const entry of await automations.pendingRestores()) {
          if (entry.session && restoreId(entry.session.target) === targetKey) await releasePending(workspaceId, automations, entry);
        }
      };
      let fresh = false;
      let stoppedGrants: string[] = [];
      const rememberNextGrants = async (grants: string[]) => {
        if (!interruptedUndo || grants.every(grant => interruptedUndo?.session?.nextGrants?.includes(grant))) return;
        const progress = interruptedUndo.session!;
        progress.nextGrants = [...new Set([...(progress.nextGrants ?? []), ...grants])].sort();
        try { await automations.savePendingRestore({id: interruptedUndo.id, session: progress}); }
        catch (cause) { throw new Error("dohc could not save Stop and restore progress. Try again.", {cause}); }
      };

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
        if (grants.length === 0 && !interruptedUndo && !followingRestore) {
          await releaseTarget();
          throw new Error("This person no longer has a share of this workspace.");
        }
        const writing = grants.filter((grant) => grant.revokedAtMs === null && WRITING_ACCESS.has(grant.access));
        stoppedGrants = writing.map(grant => grant.grantId);
        fresh = writing.length > 0;
        await rememberNextGrants(stoppedGrants);
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
            if (link === null) {
              if (interruptedUndo || followingRestore) break;
              await releaseTarget();
              throw new Error("This share link no longer exists.");
            }
            if (link.status === "revoked") break;
            await rememberNextGrants([grantId]);
            ended = true;
            fresh = true;
            stoppedGrants = [grantId];
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

      // Fresh Stop saves progress after revocation; resumed Undo also saves its next grants before it.
      try {
        if (entries === undefined) {
          entries = (await automations.pendingRestores()).filter(entry => entry.session && restoreId(entry.session.target) === targetKey);
          interruptedUndo = entries.find(entry => entry.session?.undoingFiles || entry.session?.nextGrants?.length);
          followingRestore = entries.find(entry => entry.session?.restoreGrants?.length);
          nextRestoreId = interruptedUndo ? `${interruptedUndo.id}:next` : undefined;
        }
      } catch (cause) {
        throw new Error("Access stopped. dohc could not read unfinished Stop and restore progress.", {cause});
      }
      const grants = [...grantIds].sort();
      const previous = interruptedUndo ?? (fresh ? undefined : entries.find(entry => JSON.stringify(entry.session!.grants) === JSON.stringify(grants))
        ?? (followingRestore && grants.every(grant => followingRestore.session!.grants.includes(grant)) ? followingRestore : undefined));
      try {
        for (const entry of entries) if (entry !== previous && entry.id !== nextRestoreId) await releasePending(workspaceId, automations, entry);
      } catch (cause) { throw new Error("Access stopped. dohc could not save Stop and restore progress.", {cause}); }
      const id = previous?.id ?? `restore:${randomUUID()}`;
      const pending: PendingRestore = previous ?? {id, claims: [], session: {
        grants, target: input.target, label: input.label ?? (input.target.kind === "person" ? "This person" : "Edit link"),
        definitions: [], filesUndone: false, receipts: [], result: interrupted(),
      }};
      const progress = pending.session!;
      if (interruptedUndo) {
        const next = [...stoppedGrants, ...grants.filter(grant => !progress.grants.includes(grant))];
        if (next.length) progress.nextGrants = [...new Set([...(progress.nextGrants ?? []), ...next])].sort();
      }
      try { await automations.savePendingRestore({id, session: progress}); }
      catch (cause) { throw new Error("Access stopped. dohc could not save Stop and restore progress.", {cause}); }

      // Access is stopped. Anything that fails from here is said as what is
      // still to finish, so the owner knows access stays stopped. A try that
      // stops before undoing runs reports the fields earlier tries found kept.
      const target = JSON.stringify([workspaceId, input.target]);
      if (fresh && !interruptedUndo) keptByTarget.delete(target);
      const undoHere = (definitions: typeof progress.definitions, again: boolean) => automations.undoRunsOf(definitions, async relativePath => {
        operation.assertCurrent();
        await dependencies.deletePath(event, {workspaceId, relativePath});
      }, again, id);
      const finish = async (outcome: StopAndRestoreResult) => {
        if (progress.restoreGrants?.length && outcome.status === "restored") {
          const earlier = StopAndRestoreResult.parse(progress.result);
          if (earlier.status === "restored") outcome = {...outcome, review: [...new Map(
            [...earlier.review, ...outcome.review].map(file => [file.path, file]),
          ).values()].sort((a, b) => a.path.localeCompare(b.path))};
        }
        if (outcome.status === "restored" && outcome.unfinished?.step === "files" && (progress.receipts.length || progress.intents?.length)) {
          outcome = {...outcome, canUndoFiles: true};
        }
        if (outcome.status === "restored" && outcome.unfinished === null) {
          if (progress.nextGrants?.length) {
            const nextId = `${id}:next`;
            const unfinished = {step: "files" as const, message: "Access stopped. Try again to restore changes made through the new access."};
            const next = entries.find(entry => entry.id === nextId)?.session ?? {
              grants: [], restoreGrants: [], target: progress.target, label: progress.label,
              definitions: [], filesUndone: false, receipts: [], result: {
                ...outcome, unfinished,
              },
            };
            next.grants = [...new Set([...next.grants, ...progress.grants, ...grants, ...progress.nextGrants])].sort();
            next.restoreGrants = [...new Set([...(next.restoreGrants ?? []), ...progress.nextGrants])].sort();
            await automations.savePendingRestore({id: nextId, session: next}, id);
            const saved = (await automations.pendingRestores()).find(entry => entry.id === nextId);
            await releasePending(workspaceId, automations, pending);
            keptByTarget.delete(target);
            return saved?.session && !saved.serverRelease ? {...outcome, unfinished} : outcome;
          }
          await releasePending(workspaceId, automations, pending);
        }
        else {
          const earlier = StopAndRestoreResult.parse(progress.result);
          progress.result = outcome.status === "waiting" && progress.restoreGrants?.length && earlier.status === "restored" ? earlier
            : outcome.status === "restored" && earlier.status === "restored" ? {
            ...outcome, restored: progress.receipts, runsUndone: earlier.runsUndone + outcome.runsUndone,
            fieldsMissing: earlier.fieldsMissing + outcome.fieldsMissing,
            runChangesKept: earlier.runChangesKept - earlier.keptFields.length + outcome.runChangesKept,
          } : outcome;
          await automations.savePendingRestore({id, session: progress});
        }
        return outcome;
      };
      try {
        if (progress.undoingFiles) {
          const undone = await undoFiles(event, operation, person, {workspaceId, target: input.target, restoredMomentIds: [], reviewPaths: input.reviewPaths});
          const updated = (await automations.pendingRestores()).find(entry => entry.id === id)?.session;
          if (updated) {Object.assign(progress, updated); progress.undoingFiles = updated.undoingFiles;}
          if (undone.errorMessage !== null || !progress.filesUndone) {
            return finish({...interrupted(), unfinished: {step: "files", message: undone.errorMessage ?? "dohc has not finished undoing these files. Try again."}});
          }
        }
        if (progress.filesUndone) {
          const before = StopAndRestoreResult.parse(progress.result);
          let runs: UndoneRuns;
          try { runs = await undoRunsHereAndOnServer(workspaceId, target, progress.definitions, again => undoHere(progress.definitions, again), id, automations); }
          catch (error) { if (!(error instanceof UndoRunsStopped)) throw error; runs = {...error.runs, errorMessage: error.message}; }
          return finish({...interrupted(), ...(before.status === "restored" ? before : {}), status: "restored", restored: [],
            runsUndone: runs.undone, runsLeft: runs.left, keptFields: runs.keptFields, fieldsMissing: runs.missing,
            runChangesKept: runs.keptFields.length + runs.missing + runs.otherKept,
            unfinished: runs.errorMessage === null ? null : {step: "runs", message: runs.errorMessage}});
        }
        const outcome = await restoreGrantWrites(progress.restoreGrants ?? grantIds);
        if (outcome.status !== "restored" || outcome.unfinished?.step !== "files") return finish(outcome);
        const kept = knownKept(target);
        return finish({ ...outcome, keptFields: kept, runChangesKept: outcome.runChangesKept + kept.length });
      } catch (error) {
        const kept = knownKept(target);
        return finish(StopAndRestoreResult.parse({
          status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, runChangesKept: kept.length,
          wroteAutomations: false, sendsMessages: false, keptFields: kept, fieldsMissing: 0,
          unfinished: {
            step: progress.filesUndone ? "runs" : "files",
            message: error instanceof z.ZodError ? "dohc could not read the relay's list of their changes."
              : error instanceof Error ? error.message : String(error),
          },
        }));
      }

      async function restoreGrantWrites(grantIds: readonly string[]): Promise<StopAndRestoreResult> {
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
        let retentionError: string | null = null;
        const outcome = await restoreDirectWrites({
          recordDefinitions: async definitions => {
            progress.definitions = [...definitions];
            await automations.savePendingRestore({id, session: progress});
            try { await automations.retainRunsForRestore(definitions, id); }
            catch (error) { retentionError = error instanceof Error ? error.message : String(error); }
          },
          replayRequestId: previous ? momentId => restoreRequestId(id, momentId) : undefined,
          recordedRestores: progress.receipts,
          findRestoreReceipt: (momentId, requestId) => capture.findRestoreReceipt(momentId, requestId),
          publicationApplied: (momentId, requestId) => capture.publicationApplied(momentId, requestId),
          recordRestoreIntents: async momentIds => {
            await automations.recordRestoreIntents(id, momentIds);
            progress.intents = [...new Set([...(progress.intents ?? []), ...momentIds])];
          },
          recordRestores: async (receipts, originalMomentIds) => {
            const known = new Set(progress.receipts.map(receipt => receipt.restoredMomentId));
            const added = receipts.filter(receipt => !known.has(receipt.restoredMomentId));
            if (added.length) await automations.recordRestoreReceipts(id, added, originalMomentIds);
            progress.receipts.push(...added);
            progress.intents = progress.intents?.filter(id => !originalMomentIds.includes(id));
          },
          reviewPath: path => dependencies.hasOtherWorkspaceWindow?.(event.sender, workspaceId)
            ? "Open in another window. Close that window and try again."
            : input.reviewPaths?.includes(path) ? "Changed on this device since the last saved version" : null,
          moment: async (momentId) => {
            const detail = await capture.readMoment(momentId);
            if (detail && !detail.protected && isCaptureRecoveryOrigin(detail.moment.metadata.origin)) return null;
            return detail?.protected ? "protected" : detail?.moment ?? null;
          },
          momentsAfter: (objectId, momentId) => capture.listObjectMomentsAfter(objectId, momentId),
          assertCurrent: () => operation.assertCurrent(),
          restore: async (momentId, expectedHeadMomentId, aloneInFolder) => {
            try {
              const { path, restoredMomentId } = await capture.restoreFileToBeforeMoment(momentId, person, {
                requestId: restoreRequestId(id, momentId),
                expectedHeadMomentId,
                ...(aloneInFolder ? { aloneInFolder: true } : {}),
              });
              return { kind: "restored", receipt: { path, restoredMomentId } };
            } catch (error) {
              if (error instanceof RestoreHeadChangedError) return { kind: "changed" };
              if (error instanceof RestoreLocalChangesError) return { kind: "refused", detail: error.message };
              if (error instanceof RestoreFolderInUseError) return { kind: "folder-in-use" };
              if (error instanceof RestorePolicyRefusalError && error.reason === "policy-unreadable") {
                return { kind: "rules-unreadable", unreadable: [...error.unreadable] };
              }
              if (error instanceof LiveDocumentMutationError || error instanceof RestorePolicyRefusalError) return { kind: "refused", detail: refusalDetail(error) };
              throw error;
            }
          },
          folderEntries: (path) => folderEntriesOrNone(join(root, path)),
          removeEmptyFolder: async (path) => await rmdir(join(root, path)).catch(() => undefined),
          undoRuns: (definitions) => retentionError !== null
            ? Promise.resolve({undone: 0, left: 0, keptFields: [], missing: 0, otherKept: 0,
              errorMessage: retentionError})
            : undoRunsHereAndOnServer(workspaceId, target, definitions, (again) =>
            operation.state.collectionAutomations.undoRunsOf(definitions, async (relativePath) => {
              await dependencies.deletePath(event, { workspaceId, relativePath });
            }, again, id), id, automations),
        }, writes.flatMap((write) => write.files));
        if (outcome.status === "waiting") dependencies.queuePull(workspaceId);
        else dependencies.notifyRenderer({ workspaceId });
        return StopAndRestoreResult.parse(outcome);
      }
    }, dependencies.assertOriginalWorkspace);
  });

  async function undoFiles(event: Event, operation: Operation, person: LocalPersonAuthor, input: z.infer<typeof UndoStopAndRestorePayload>): Promise<z.infer<typeof UndoStopAndRestoreResult>> {
    const { capture } = await dependencies.requireEngineCapture(operation.workspace.workspaceId);
    const automations = operation.state.collectionAutomations;
    const pending = input.target ? (await automations.pendingRestores()).find(entry => entry.session && restoreId(entry.session.target) === restoreId(input.target!)) : undefined;
    const publishedRecoveries: Array<{path: string; restoredMomentId: string; removed?: boolean}> = [];
    const paths = new Map<string, string>();
    const files: UndoStopAndRestoreResult["files"] = [];
    const receipts = durableBatch<UndoStopAndRestoreResult["files"][number]>(async batch => {
      const successful = batch.filter(file => file.kind === "restored");
      if (successful.length) {
        if (pending?.session) {
          const ids = successful.map(file => file.momentId);
          await automations.undoRestoreReceipts(pending.id, ids);
          pending.session.receipts = pending.session.receipts.filter(file => !ids.includes(file.restoredMomentId));
        } else await automations.makeWritesDurable();
      }
      files.push(...batch);
    });
    try {
      const ids = new Set(input.restoredMomentIds);
      if (pending?.session) {
        for (const receipt of pending.session.receipts) ids.add(receipt.restoredMomentId);
        if (ids.size || pending.session.intents?.length) {
          pending.session.undoingFiles = true;
          pending.session.filesUndone = false;
          await automations.savePendingRestore({id: pending.id, session: pending.session});
        }
        const notWritten: string[] = [];
        const resolved = durableBatch<{originalId: string; receipt: {path: string; restoredMomentId: string; removed?: boolean}}>(async batch => {
          const receipts = batch.map(item => item.receipt), originals = batch.map(item => item.originalId);
          await automations.recordRestoreReceipts(pending.id, receipts, originals);
          pending.session!.receipts = [...new Map([...pending.session!.receipts, ...receipts].map(receipt => [receipt.restoredMomentId, receipt])).values()];
          pending.session!.intents = pending.session!.intents?.filter(id => !originals.includes(id));
          publishedRecoveries.push(...receipts);
        });
        for (const originalId of pending.session.intents ?? []) {
          operation.assertCurrent();
          const found = await capture.findRestoreReceipt(originalId, restoreRequestId(pending.id, originalId));
          if (found) {
            ids.add(found.restoredMomentId);
            await resolved.add({originalId, receipt: {path: found.path, restoredMomentId: found.restoredMomentId, ...(found.restored === "deleted" ? {removed: true} : {})}});
          } else notWritten.push(originalId);
        }
        await resolved.flush();
        if (notWritten.length) {
          pending.session.intents = pending.session.intents?.filter(id => !notWritten.includes(id));
          await automations.savePendingRestore({id: pending.id, session: pending.session});
        }
      }
      for (const receipt of pending?.session?.receipts ?? []) paths.set(receipt.restoredMomentId, receipt.path);
      for (const momentId of [...ids].reverse()) {
        operation.assertCurrent();
        try {
          const detail = await capture.readMoment(momentId);
          const path = detail?.moment.path;
          if (dependencies.hasOtherWorkspaceWindow?.(event.sender, operation.workspace.workspaceId)) throw new RestoreLocalChangesError(path ?? "", "Open in another window. Close that window and try again.");
          if (path && input.reviewPaths?.includes(path)) throw new RestoreLocalChangesError(path);
          const receipt = await capture.restoreFileToBeforeMoment(momentId, person, {
            expectedHeadMomentId: momentId, requestId: restoreRequestId(`undo:${operation.workspace.workspaceId}`, momentId),
          });
          await receipts.add({ momentId, kind: "restored", receipt: { path: receipt.path, restoredMomentId: receipt.restoredMomentId } });
        } catch (error) {
          if (!(error instanceof RestorePolicyRefusalError || error instanceof LiveDocumentMutationError ||
            error instanceof RestoreHeadChangedError || error instanceof RestoreLocalChangesError || error instanceof RestoreFolderInUseError)) throw error;
          await receipts.add(error instanceof RestorePolicyRefusalError && error.reason === "policy-unreadable"
            ? { momentId, kind: "rules-unreadable", unreadable: [...error.unreadable] }
            : { momentId, kind: "refused", detail: refusalDetail(error).slice(0, 500) });
        }
      }
      await receipts.flush();
      if (pending?.session?.undoingFiles && !pending.session.intents?.length) {
        const saved = StopAndRestoreResult.parse(pending.session.result);
        const before = saved.status === "restored" ? saved : interrupted();
        const review = new Map(before.review.map(file => [file.path, file]));
        for (const file of files) {
          const path = paths.get(file.momentId);
          if (!path) continue;
          if (file.kind === "restored") review.delete(path);
          else review.set(path, file.kind === "rules-unreadable"
            ? {path, reason: "rules-unreadable", unreadable: file.unreadable}
            : {path, reason: "restore-refused", detail: file.detail});
        }
        pending.session.result = {...before, review: [...review.values()].sort((a, b) => a.path.localeCompare(b.path))};
        pending.session.filesUndone = true;
        delete pending.session.undoingFiles;
        await automations.savePendingRestore({id: pending.id, session: pending.session});
      }
      return UndoStopAndRestoreResult.parse({ files, ...(publishedRecoveries.length ? {recovered: publishedRecoveries} : {}), errorMessage: null });
    } catch (error) {
      try { await receipts.flush(); }
      catch (flushError) { error = flushError; }
      return UndoStopAndRestoreResult.parse({ files, ...(publishedRecoveries.length ? {recovered: publishedRecoveries} : {}), errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) });
    } finally {
      dependencies.notifyRenderer({ workspaceId: operation.workspace.workspaceId });
    }
  }

  // Undo for a stop and restore: each file goes back to how the person left
  // it, newest restore first. Access stays stopped.
  registerHandler(CHANNELS.undoStopAndRestore, async (event, payload) => {
    assertTrustedSender(event);
    const input = UndoStopAndRestorePayload.parse(payload);
    const person = await dependencies.localPerson();
    return dependencies.withRendererWorkspaceOperation(
      event.sender, input.workspaceId, "Undo stopped because this window changed workspaces.",
      operation => undoFiles(event, operation, person, input),
    );
  });
  return {retryServerReleases: () => {
    for (const workspaceId of releaseWorkspaces) retryServerReleases(workspaceId);
  }};
}
