import { afterEach, expect, it, vi } from "vitest";
import { AGENT_ONLY_MAX_DOCUMENTS, AGENT_ONLY_MAX_WORKSPACES } from "./liveHostingLimits";
import { binding, scope } from "./liveTickets.test-helper";
import { personalRouteFixture, type PersonalRouteFixtureOptions } from "./personalLiveDocumentRoutes.test-helper";
import { request } from "./testing";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const ready = { ok: true, status: "ready", objectId: binding.objectId, binding };
const preparing = { ok: true, status: "preparing" };

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect((await response.json()).code).toBe(code);
}

async function body(response: Response, status: number): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(status);
  return await response.json();
}

const fixture = (options: PersonalRouteFixtureOptions = {}) => personalRouteFixture(close => { cleanup.push(close); }, options);

// Proves: an agent needs Edit to ask for hosting. At Comment its open writes
// nothing; at Edit the same open answers with the document's binding.
it("refuses an agent at Comment without writing, and answers an agent at Edit with the document's binding", async () => {
  const f = await fixture(), commenter = f.agent("commenter", "comment"), editor = f.agent("editor");
  f.ready();
  await expectCode(await commenter.open(), 403, "personal_agent_edit_needed");
  expect(f.read()).toBeNull();
  expect(await body(await editor.open(), 200)).toEqual(ready);
  expect(f.read()).toMatchObject({ shareId: null, enabled: true, ownerDemand: false, demandAtMs: 2_000 });
});

// Proves: a document with no native history needs its owner, so the open
// ends at once. One with desktop history, no share and no relay activation
// yet waits until the host has it ready.
it("refuses a document with no native history at once, and holds one with no share or activation until it is ready", async () => {
  const f = await fixture(), a = f.agent("editor");
  f.revoke();
  f.blocked.set(binding.objectId, "without-lineage");
  await expectCode(await a.open(), 409, "live-document-without-lineage");
  expect(f.route.held()).toEqual({ waiters: 0, documents: 0 });
  f.blocked.clear();
  const held = a.open();
  await f.holding(1, 1);
  f.ready();
  f.route.evaluateWaiting();
  expect(await body(await held, 200)).toEqual(ready);
  expect(f.route.held()).toEqual({ waiters: 0, documents: 0 });
});

// Proves: an agent's open never undoes the owner's Stop. A document that
// retired without one, as revoked access leaves it, is enrolled again.
it("answers live_paused_by_owner for a Stopped document, and enrolls one retired without a Stop again", async () => {
  const stopped = await fixture();
  stopped.storage.ensureOwnedLiveDocument({ intent: "share", ...stopped.input });
  stopped.storage.setServiceHostEnrollmentEnabled({ ...stopped.input, enabled: false, retire: true, nowMs: 20 });
  const before = stopped.read();
  await expectCode(await stopped.agent("editor").open(), 409, "live_paused_by_owner");
  expect(stopped.read()).toEqual(before);

  const retired = await fixture();
  retired.storage.ensureOwnedLiveDocument({ intent: "share", ...retired.input });
  retired.revoke();
  expect(retired.release()).toMatchObject({ retired: true, ownerStop: null });
  const held = retired.agent("editor").open();
  await retired.holding(1, 1);
  expect(retired.read()).toMatchObject({ enabled: true, retired: false, ownerStop: null, ownerDemand: false, demandAtMs: 2_000 });
  retired.ready();
  retired.route.evaluateWaiting();
  expect(await body(await held, 200)).toEqual(ready);
});

// Proves: agents alone keep at most 48 documents hosted. The owner's Resume
// of a document no share covers is not one of them.
it("refuses an agent's open once agents alone keep 48 documents, and hosts the owner's Resume of a shareless one", async () => {
  const f = await fixture(), a = f.agent("editor");
  f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  f.revoke();
  expect(f.release()).toMatchObject({ retired: true, ownerStop: null });
  for (let document = 0; document < AGENT_ONLY_MAX_DOCUMENTS; document++) f.agentOnly(scope.workspaceId, `agent-object-${document}`, `notes/${document}.md`);
  await expectCode(await a.open(), 409, "live_host_full");
  expect(f.read()).toMatchObject({ retired: true, demandAtMs: null });
  expect(f.storage.ensureOwnedLiveDocument({ intent: "owner-resume", ...f.input, nowMs: 30 }))
    .toMatchObject({ enabled: true, retired: false, ownerDemand: true, demandAtMs: 30 });
});

// Proves: agents alone keep documents in at most 12 workspaces. A share in
// another workspace still fits, within the host's 16.
it("refuses an agent's open in a 13th workspace only agents keep, and fits a share there", async () => {
  const f = await fixture(), a = f.agent("editor");
  for (let workspace = 0; workspace < AGENT_ONLY_MAX_WORKSPACES; workspace++) f.agentOnly(`agent-workspace-${workspace}`, "agent-object", "notes/a.md");
  f.seed("notes/b.md", "object-b");
  await expectCode(await a.open({ workspaceId: scope.workspaceId, path: "notes/b.md" }), 409, "live_host_full");
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input })).toMatchObject({ enabled: true, shareId: scope.shareId });
});

// Proves: the owner's Sign out ends a held open as it commits, releasing its
// waiter and slot. An agent still signed in waits until the document is ready.
it("ends a held open when its owner signs the agent out, and answers one whose agent stays signed in", async () => {
  const f = await fixture(), leaving = f.agent("leaving"), staying = f.agent("staying");
  const left = leaving.open(), stays = staying.open();
  await f.holding(2, 1);
  expect((await f.h(request("owner-1", `/sync/personal-agents/${leaving.agentId}/sign-out`, { method: "POST" }))).status).toBe(200);
  expect((await left).status).toBe(404);
  expect(f.route.held()).toEqual({ waiters: 1, documents: 1 });
  f.ready();
  f.route.evaluateWaiting();
  expect(await body(await stays, 200)).toEqual(ready);
  expect(f.route.held()).toEqual({ waiters: 0, documents: 0 });
});

// Proves: past the relay's held-open limit, an open has still committed and
// answers at once. Below it, the open waits for the document.
it("answers at once past the relay's held-open limit, and holds an open below it", async () => {
  const f = await fixture({ limits: { waiters: 1 } }), first = f.agent("first"), second = f.agent("second");
  const held = first.open();
  await f.holding(1, 1);
  expect(await body(await second.open(), 202)).toEqual(preparing);
  expect(f.route.held()).toEqual({ waiters: 1, documents: 1 });
  f.ready();
  f.route.evaluateWaiting();
  expect(await body(await held, 200)).toEqual(ready);
});

// Proves: one agent holds at most its own limit of opens. Another agent's
// open of the same document joins the same waiters, and one read answers both.
it("answers an agent at once past its own held-open limit, and holds another agent's open of the same document", async () => {
  const f = await fixture({ limits: { perAgent: 1 } }), first = f.agent("first"), second = f.agent("second");
  const held = first.open();
  await f.holding(1, 1);
  expect(await body(await first.open(), 202)).toEqual(preparing);
  const other = second.open();
  await f.holding(2, 1);
  f.ready();
  f.route.evaluateWaiting();
  for (const response of await Promise.all([held, other])) expect(await body(response, 200)).toEqual(ready);
});

// Proves: a client that leaves takes its waiter and counts with it. One
// that stays gets the answer.
it("releases a held open's waiter and counts when its client leaves, and answers one that stays", async () => {
  const f = await fixture(), leaving = f.agent("leaving"), staying = f.agent("staying");
  const client = new AbortController();
  const left = leaving.open(undefined, client), stays = staying.open();
  await f.holding(2, 1);
  client.abort();
  expect((await left).status).toBe(404);
  expect(f.route.held()).toEqual({ waiters: 1, documents: 1 });
  f.ready();
  f.route.evaluateWaiting();
  expect(await body(await stays, 200)).toEqual(ready);
  expect(f.route.held()).toEqual({ waiters: 0, documents: 0 });
});

// Proves: only a relay running the self-hosted live host hosts documents for
// agents. Elsewhere every open refuses before any write.
it("refuses an open without the self-hosted live host before any write, and answers it with one", async () => {
  for (const options of [{ live: false }, { control: "device" }] as const) {
    const f = await fixture(options);
    f.ready();
    await expectCode(await f.agent("editor").open(), 409, "live_hosting_unsupported");
    expect(f.read()).toBeNull();
  }
  const f = await fixture();
  f.ready();
  expect(await body(await f.agent("editor").open(), 200)).toEqual(ready);
});

// Proves: two agents opening one document at once enroll it once, and both
// get the same binding.
it("enrolls a document once when two agents open it at once, and gives both the same binding", async () => {
  const f = await fixture(), first = f.agent("first"), second = f.agent("second");
  f.ready();
  const responses = await Promise.all([first.open(), second.open()]);
  for (const response of responses) expect(await body(response, 200)).toEqual(ready);
  expect(f.storage.listServiceHostEnrollments()).toEqual([f.read()]);
});

// Proves: an open never follows a rename to a different enrollment. At the
// document's new path it is a conflict; at its enrolled path it is ready.
it("refuses an open at a renamed document's new path, and answers ready at the path it is enrolled at", async () => {
  const f = await fixture(), a = f.agent("editor");
  f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  f.ready();
  expect(await body(await a.open(), 200)).toEqual(ready);
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  await expectCode(await a.open({ workspaceId: scope.workspaceId, path: "docs/moved.md" }), 409, "conflict");
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual([binding.currentPath]);
});

// Proves: while Postgres can't read the agent's fence, the open is 503 and
// writes nothing. Once it can, the same open succeeds.
it("answers 503 while Postgres can't read the agent's fence, and opens once it can", async () => {
  const f = await fixture(), a = f.agent("editor");
  f.ready();
  f.fence.down = true;
  await expectCode(await a.open(), 503, "personal_agent_unavailable");
  expect(f.read()).toBeNull();
  f.fence.down = false;
  expect(await body(await a.open(), 200)).toEqual(ready);
});
