import {expect, it, vi} from "vitest";
import type {AutomationClaimSummary} from "@dohc/workspace-engine-client";
import type {AutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import {AutomationRecordPresserChanged, automationRecordPresser} from "./automationRecordPresser";

const declaration: AutomationDeclaration = {automationId: "collection:Tasks#mark", attribution: {
  actorKind: "automation", onBehalfOf: "reader", depth: 1, run: {claimId: "claim", automationName: "Mark done"},
}};
const claim: AutomationClaimSummary = {claimId: "claim", automationId: declaration.automationId,
  trigger: {key: `press:relay-press.${"a".repeat(16)}.${"b".repeat(16)}`}, recordId: "record", collectionPath: null,
  depth: 1, state: "running", attempts: 1, run: 1, createdAtMs: 1, updatedAtMs: 1,
  change: {kind: "button", actorKind: "human", onBehalfOf: "reader", authorOriginId: null, sharedAuthor: null, liveCursor: null}};
function fixture(value: AutomationClaimSummary | null = claim) {
  const sendRequest = vi.fn(async () => ({id: 1, result: {claim: value}}));
  const replica = {client: {sendRequest}, workspace: "replica", nextRequestId: () => 1};
  return {replica, sendRequest};
}
it("resolves the original relay press from the durable queued claim", async () => {
  const f = fixture(), signal = new AbortController().signal;
  expect(await automationRecordPresser(f.replica, declaration, signal)).toEqual({hostPressId: "relay-press", automationId: claim.automationId});
  expect(f.sendRequest).toHaveBeenCalledWith({id: 1, workspace: "replica", method: "automations.getClaim", params: {claimId: "claim"}}, signal);
});
it("leaves owner Undo and scheduled automation writes under owner authority", async () => {
  const undo = fixture();
  expect(await automationRecordPresser(undo.replica, undefined, new AbortController().signal)).toBeUndefined();
  const {onBehalfOf: _person, ...scheduledAttribution} = declaration.attribution;
  expect(await automationRecordPresser(undo.replica, {...declaration, attribution: scheduledAttribution}, new AbortController().signal)).toBeUndefined();
  expect(undo.sendRequest).not.toHaveBeenCalled();
  const group = fixture({...claim, change: {...claim.change, kind: "changed"}, trigger: {historyId: 1}});
  await expect(automationRecordPresser(group.replica, declaration, new AbortController().signal)).rejects.toBeInstanceOf(AutomationRecordPresserChanged);
});
it.each([null, {...claim, automationId: "collection:Private#mark"}, {...claim, change: {...claim.change, onBehalfOf: "someone-else"}},
  {...claim, trigger: {key: "press:unbound-recipient"}}])(
  "refuses a missing or changed durable claim", async value => {
    const f = fixture(value);
    await expect(automationRecordPresser(f.replica, declaration, new AbortController().signal)).rejects.toBeInstanceOf(AutomationRecordPresserChanged);
  },
);

it.each(["message", "changed"] as const)("binds a %s recipient claim to its original named grant", async kind => {
  const f = fixture({...claim, change: {...claim.change, kind, sharedAuthor: {kind: "named", userId: "reader", grantId: "original", grantGeneration: 4}}, trigger: {historyId: 1}});
  expect(await automationRecordPresser(f.replica, declaration, new AbortController().signal)).toEqual({grantId: "original", grantGeneration: 4});
});

it("follows a recipient record-change chain to its authenticated Button", async () => {
  const parent = {...claim, claimId: "parent"};
  const child = {...claim, parentClaimId: "parent", automationId: "collection:Tasks#stamp", trigger: {historyId: 1},
    change: {...claim.change, kind: "changed" as const, actorKind: "automation" as const, authorOriginId: parent.automationId}};
  const f = fixture(child);
  f.sendRequest.mockResolvedValueOnce({id: 1, result: {claim: child}}).mockResolvedValueOnce({id: 1, result: {claim: parent}});
  expect(await automationRecordPresser(f.replica, {...declaration, automationId: child.automationId}, new AbortController().signal))
    .toEqual({hostPressId: "relay-press", automationId: parent.automationId});
  expect(f.sendRequest).toHaveBeenCalledTimes(2);
});
it("refuses a cyclic parent claim", async () => {
  const child = {...claim, parentClaimId: "claim", trigger: {historyId: 1},
    change: {...claim.change, kind: "changed" as const, actorKind: "automation" as const, authorOriginId: claim.automationId}};
  const f = fixture(child);
  await expect(automationRecordPresser(f.replica, declaration, new AbortController().signal)).rejects.toBeInstanceOf(AutomationRecordPresserChanged);
});
