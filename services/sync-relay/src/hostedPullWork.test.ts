import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {hostedRelayState, hostedReplicaQuiet, type HostedPullDuties} from "./hostedPullWork";
import {parseLogOp} from "./relayLogInputs";
import {fenceAccount, initializeAccountDeletion} from "./storage/accountDeletion";
import type {StorageContext} from "./storage/context";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

const quiet: HostedPullDuties = {pulls: 3, confirmed: 3, announced: [{required: 2, reached: 3}], last: "done", listsWrapped: true, departedNone: true,
  waiting: {parking: 0, leaving: 0, recovering: 0, movedRestores: 0, retained: 0, retiring: 0, held: 0}};
const waiting = (reason: keyof HostedPullDuties["waiting"]): HostedPullDuties => ({...quiet, waiting: {...quiet.waiting, [reason]: 1}});

// Proves: a ready workspace's replica skips its pull only when no work the host started waits on one.
it("counts a replica quiet only when nothing it started waits on a later pull", () => {
  expect(hostedReplicaQuiet(quiet)).toBe(true);
  expect(hostedReplicaQuiet({...quiet, announced: []})).toBe(true);
});
it.each<[string, HostedPullDuties]>([
  ["before any pull", {...quiet, pulls: 0, confirmed: 0, last: undefined}],
  ["after a failed pull", {...quiet, last: "failed"}],
  ["after a pull with more pages", {...quiet, last: "more"}],
  ["while a pull it started is unconfirmed", {...quiet, pulls: 4}],
  ["while an announced departure waits for a later pull", {...quiet, announced: [{required: 4, reached: 0}]}],
  ["while no departed list reached an announced departure", {...quiet, announced: [{required: 2, reached: 1}]}],
  ["while its held or departed lists have not wrapped", {...quiet, listsWrapped: false}],
  ["while its replica lists a departed document", {...quiet, departedNone: false}],
  ["while a document waits to park", waiting("parking")],
  ["while a document is leaving", waiting("leaving")],
  ["while a document resumes work an earlier daemon left", waiting("recovering")],
  ["while a moved document's restore or retirement continues", waiting("movedRestores")],
  ["while a document is retained for its recovery copy", waiting("retained")],
  ["while a retirement is open", waiting("retiring")],
  ["while a pull left a document held", waiting("held")],
])("keeps pulling %s", (_name, duties) => {
  expect(hostedReplicaQuiet(duties)).toBe(false);
});

async function enrolled() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.storage.ensureOwnedLiveDocument({intent: "share", workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}});
  f.raw.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES ('workspace-2','owner-1',0)").run();
  const append = (workspaceId: string) => f.storage.appendLogBatch({workspaceId, originId: "device",
    ops: [parseLogOp({originSeq: f.storage.maxOriginSeq(workspaceId, "device") + 1, opKind: "workspace.init", recordedAtMs: 1, payload: {}})]});
  const state = () => hostedRelayState(f.storage, scope.workspaceId);
  const shared = () => f.storage.readServiceHostFeedScope(scope.workspaceId)?.shared.has(binding.objectId);
  return {...f, append, state, shared};
}

// Proves: writes that change nothing the hosted feed answers from leave the reading unchanged, so they schedule no pull.
it("reads the same relay state across writes to another workspace", async () => {
  const f = await enrolled(), before = f.state();
  expect(f.shared()).toBe(true);
  f.append("workspace-2");
  expect(f.state()).toBe(before);
  f.append(scope.workspaceId);
  expect(f.state()).not.toBe(before);
});

// The reviewer's raw-SQL paths: each ends the document's last Edit grant without a log append, so only the scope shows it.
it.each<[string, (f: Awaited<ReturnType<typeof enrolled>>) => void]>([
  ["its share is revoked", f => {expect(f.storage.revokeShare(scope.shareId, 20)).toBe(true);}],
  ["its Edit grant is revoked", f => {expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20}).ok).toBe(true);}],
  ["the grantee's account is fenced for removal", f => {
    initializeAccountDeletion(f.storage as StorageContext, "fence");
    fenceAccount(f.storage as StorageContext, "fence", scope.userId, "reader@example.com");
  }],
])("reads a new relay state once %s", async (_name, change) => {
  const f = await enrolled(), before = f.state(), head = f.storage.automationWorkspaceLogHead(scope.workspaceId);
  change(f);
  expect(f.shared()).toBe(false);
  expect(f.storage.automationWorkspaceLogHead(scope.workspaceId)).toBe(head);
  expect(f.state()).not.toBe(before);
});
