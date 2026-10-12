import {afterEach, expect, it} from "vitest";
import * as Y from "yjs";
import {registered, cleanupLiveDeliveryFixtures} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import type {LiveAuthorContext} from "@dohc/live-session-contract";

import {createLiveJournalHistoryAuthority} from "./liveJournalHistory";
function setup() {
  const f = registered();
  f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "owner-credit-tests", reconciled: true}));
  return f;
}
afterEach(cleanupLiveDeliveryFixtures);
function credit(f: ReturnType<typeof registered>, bytes: Uint8Array, id: string, context?: LiveAuthorContext, named = false) {
  const input = f.capture(bytes, id, named ? {kind: "named", userId: "reader", grantId: "grant"} : f.actor);
  return f.storage.commitLiveUpdateJournal({...input, trustedAccount: {accountId: named ? "reader" : "owner", name: "Relay name"},
    metadata: {...input.metadata, ...(context ? {authorContext: context} : {})}});
}
it.each([false, true])("admits a two-client owner entry unattributed, with context=%s", declared => {
  const f = setup();
  try {
    const before = Y.encodeStateVector(f.doc);
    f.doc.clientID = 100; f.update("first");
    f.doc.clientID = 200; f.update("second");
    const context = declared ? {kind: "account" as const, accountId: "owner"} : undefined;
    const input = Y.encodeStateAsUpdate(f.doc, before);
    const result = credit(f, input, "two-clients", context);
    expect(result.result.kind).toBe("accepted");
    expect(result.admitted?.metadata.authorSnapshot).toEqual([]);
    expect(JSON.parse(String(f.journalRows().journal.at(-1)!.author_context_json ?? "null"))).toEqual(context ?? null);
    expect(credit(f, input, "two-clients", context).result).toMatchObject({kind: "accepted", replayed: true});
  } finally {f.close();}
});
it("admits an agent on the owner's bound client unattributed without changing the submitted context", () => {
  const f = setup();
  try {
    const person = credit(f, f.update("person"), "person", {kind: "account", accountId: "owner"});
    expect(person.admitted?.metadata.authorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Relay name"}]);
    const context = {kind: "account" as const, accountId: "owner", agent: {agentId: "agent", depth: 0}};
    const bytes = f.update("agent");
    const result = credit(f, bytes, "agent", context);
    expect(result.result.kind).toBe("accepted");
    expect(result.admitted?.metadata.authorSnapshot).toEqual([]);
    expect(JSON.parse(String(f.journalRows().journal.at(-1)!.author_context_json ?? "null"))).toEqual(context ?? null);
    expect(credit(f, bytes, "agent", context).result).toMatchObject({kind: "accepted", replayed: true});
  } finally {f.close();}
});
it("keeps a trusted automation on the owner's bound client refused, so its retry can't conflict", () => {
  const f = setup();
  try {
    expect(credit(f, f.update("person"), "person", {kind: "account", accountId: "owner"}).result.kind).toBe("accepted");
    const input = f.capture(f.update("automation"), "automation");
    const automation = {...input, trustedAutomation: {automationId: "collection:Tasks#stamp", attribution: {actorKind: "automation" as const, depth: 0}}};
    expect(f.storage.commitLiveUpdateJournal(automation).result).toMatchObject({kind: "refused", reason: "provenance-refused"});
    expect(f.storage.commitLiveUpdateJournal(automation).result).toMatchObject({kind: "refused", reason: "provenance-refused"});
    expect(f.journalRows().journal.some(row => row.delivery_id === input.metadata.deliveryId)).toBe(false);
  } finally {f.close();}
});
it("keeps recipient client binding strict", () => {
  const f = setup();
  try {
    expect(credit(f, f.update("owner"), "owner", {kind: "account", accountId: "owner"}).result.kind).toBe("accepted");
    expect(credit(f, f.update("recipient"), "recipient", {kind: "account", accountId: "reader"}, true).result)
      .toMatchObject({kind: "refused", reason: "provenance-refused"});
  } finally {f.close();}
});
