import {describe, expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {HostedSyncMethodResultMap} from "@dohc/workspace-engine-client/relay-wire";
import {parseServiceHostedReplicationConfig, ServiceHostedReplication} from "./serviceHostedReplication.js";

const attachment = (maxPagesPerPull = 3) => ({relay: {baseUrl: "https://relay.example", bearerToken: "service-credential"},
  identity: {replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}, maxPagesPerPull});
const held = {objectId: "held-doc", reason: "hosted-backfill-work-waiting" as const};
let issued = 0;
const pass = (patch: Partial<HostedSyncMethodResultMap["sync.pullHosted"]> = {}) => ({fetched: 1, applied: 1, refused: 0, skipped: 0,
  conflictsOpened: 0, hasMore: false, pendingCursor: {kind: "hosted" as const, token: `issued-${++issued}`},
  changedPaths: [{versionId: "main", path: "docs/a.md", operation: "write" as const, contentKind: "text" as const}],
  changedPathsOmitted: 0, refusals: [], refusalsOmitted: 0, sharingDeclined: [], sharingDeclinedOmitted: 0, held: [], heldThrough: null,
  newlyHeld: [], departed: [], departedOmitted: 0, ...patch});
const commit = (patch: Partial<HostedSyncMethodResultMap["sync.commitCursor"]> = {}) =>
  ({committed: true, hasMore: false, retirement: null, departed: [], departedOmitted: 0, sharingDeclined: [], ...patch});
const diverged = () => new EngineRequestError(1, {code: "INVALID_PARAMS", message: "relay-origin-diverged", retry: "no"});

function fixture(config = attachment()) {
  const abort = new AbortController();
  const answers: Record<string, () => unknown> = {
    "sync.createHostedReplica": () => ({hosted: true}),
    "sync.pullHosted": () => pass(),
    "sync.materializePendingCursor": () => ({materialized: true}),
    "sync.commitCursor": () => commit(),
    "sync.push": () => ({status: "complete", pushed: 1, hasMore: false, sharingDeclined: [], ownerAdmissionPending: []}),
  };
  const sendRequest = vi.fn(async (request: Parameters<EngineClient["sendRequest"]>[0]) => ({result: await answers[request.method]!()}));
  let requestId = 0;
  const driver = new ServiceHostedReplication({client: {sendRequest} as unknown as Pick<EngineClient, "sendRequest">,
    workspace: "actual-open-handle", workspaceId: "workspace", nextRequestId: () => ++requestId, deadlineMs: 1000,
    signal: abort.signal, assertCurrent: () => {}}, config);
  return {driver, sendRequest, answers, abort, methods: () => sendRequest.mock.calls.map(([request]) => request.method)};
}

describe("hosted attachment", () => {
  it.each([
    {relay: {baseUrl: "http://relay.example", bearerToken: "secret-bearer"}},
    {relay: {baseUrl: "https://relay.example", bearerToken: "secret-bearer\n"}},
    {identity: {replicationEpoch: "actual-epoch"}},
    {identity: {kind: "join", replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}},
    {identity: {replicationEpoch: "", streamIdentity: "actual-stream"}},
    {maxPagesPerPull: 0},
  ])("rejects malformed configuration without echoing credentials: %j", patch => {
    expect(() => parseServiceHostedReplicationConfig({...attachment(), ...patch})).toThrow();
    try {parseServiceHostedReplicationConfig({...attachment(), ...patch});} catch (error) {expect(String(error)).not.toContain("secret-bearer");}
  });
});

it("creates the hosted replica once under its identity, then commits each pass only after materializing it", async () => {
  const f = fixture();
  expect(await f.driver.pull()).toMatchObject({hasMore: false, pages: [{committed: true, changedPaths: ["docs/a.md"]}]});
  await f.driver.pull();
  expect(f.methods()).toEqual(["sync.createHostedReplica", "sync.pullHosted", "sync.materializePendingCursor", "sync.commitCursor",
    "sync.pullHosted", "sync.materializePendingCursor", "sync.commitCursor"]);
  const [create, , materialize, committed] = f.sendRequest.mock.calls.map(([request]) => request);
  expect(create).toMatchObject({workspace: "actual-open-handle", params: {workspaceId: "workspace", replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}});
  expect(materialize!.params).toEqual(committed!.params);
  expect(committed!.params).toEqual({workspaceId: "workspace", pendingCursor: {kind: "hosted", token: expect.stringMatching(/^issued-/)}});
  expect(JSON.stringify(f.sendRequest.mock.calls)).not.toContain("service-credential");
});

it("pulls again after a pass that adopted a new scope, without materializing or committing it", async () => {
  const f = fixture(), answers = [pass({pendingCursor: null, fetched: 0, applied: 0, changedPaths: [], held: [held]}), pass()];
  f.answers["sync.pullHosted"] = () => answers.shift();
  const heard = vi.fn();
  expect(await f.driver.pull(undefined, heard)).toMatchObject({hasMore: false, pages: [{committed: false, held: [held]}, {committed: true}]});
  expect(heard).toHaveBeenCalledTimes(2);
  expect(f.methods().slice(1)).toEqual(["sync.pullHosted", "sync.pullHosted", "sync.materializePendingCursor", "sync.commitCursor"]);
});

// Proves: however many documents are held, each pass asks after where the last
// one's list stopped, so every hold is named within a few passes, and tells
// its page where its list speaks. A list that reached the last starts the next
// from the first, and one listing a document before where it was asked is refused.
it("asks each pass for the held documents after where the last list stopped", async () => {
  const f = fixture(), work = (objectId: string) => ({objectId, reason: "hosted-backfill-work-waiting" as const});
  const passes = [pass({hasMore: true, held: [work("a"), work("b")], heldThrough: "b"}), pass({hasMore: true, held: [work("c")]}),
    pass({held: [work("a")], heldThrough: "a"})];
  f.answers["sync.pullHosted"] = () => passes.shift();
  const result = await f.driver.pull();
  expect(result.pages.map(page => page.heldWindow)).toEqual([{after: undefined, through: "b"}, {after: "b", through: null},
    {after: undefined, through: "a"}]);
  const asked = () => f.sendRequest.mock.calls.map(([request]) => request).filter(request => request.method === "sync.pullHosted")
    .map(request => request.params);
  expect(asked()).toEqual([{workspaceId: "workspace"}, {workspaceId: "workspace", heldAfter: "b"}, {workspaceId: "workspace"}]);
  f.answers["sync.pullHosted"] = () => pass({held: [work("a")]});
  await expect(f.driver.pull()).rejects.toThrow("hosted sync.pullHosted result");
  expect(asked().at(-1)).toEqual({workspaceId: "workspace", heldAfter: "a"});
  expect(f.methods().at(-1)).toBe("sync.pullHosted");
});

it("pulls again when the scope moved before the commit, and while the commit has more", async () => {
  for (const answer of [commit({committed: false}), commit({hasMore: true})]) {
    const f = fixture(), commits = [answer, commit()];
    f.answers["sync.commitCursor"] = () => commits.shift();
    const result = await f.driver.pull();
    expect(result.hasMore).toBe(false);
    expect(result.pages.map(page => page.committed)).toEqual([answer.committed, true]);
  }
});

/** An answer the engine gives only once the test releases it, as while it validates a released lineage's tails. */
function heldAnswer(f: ReturnType<typeof fixture>, method: string) {
  let release!: () => void, asked!: () => void;
  const reached = new Promise<void>(resolve => {asked = resolve;});
  const original = f.answers[method]!;
  f.answers[method] = () => {
    asked();
    return new Promise(resolve => {release = () => resolve(original());});
  };
  return {reached, release: () => release()};
}

it("keeps its one commit outstanding while the engine validates, and pulls again only after it answers", async () => {
  const f = fixture(), held = heldAnswer(f, "sync.commitCursor");
  const pulled = f.driver.pull();
  await held.reached;
  expect(f.methods()).toEqual(["sync.createHostedReplica", "sync.pullHosted", "sync.materializePendingCursor", "sync.commitCursor"]);
  held.release();
  expect(await pulled).toMatchObject({hasMore: false, pages: [{committed: true}]});
  expect(f.methods().filter(method => method === "sync.pullHosted")).toHaveLength(1);
  expect(f.methods().filter(method => method === "sync.commitCursor")).toHaveLength(1);
});

it("keeps its one pull outstanding while the engine validates", async () => {
  const f = fixture(), held = heldAnswer(f, "sync.pullHosted");
  const pulled = f.driver.pull();
  await held.reached;
  expect(f.methods()).toEqual(["sync.createHostedReplica", "sync.pullHosted"]);
  held.release();
  expect(await pulled).toMatchObject({hasMore: false, pages: [{committed: true}]});
  expect(f.methods()).toEqual(["sync.createHostedReplica", "sync.pullHosted", "sync.materializePendingCursor", "sync.commitCursor"]);
});

it("bounds a pass by its page limit", async () => {
  const f = fixture(attachment(2));
  f.answers["sync.pullHosted"] = () => pass({hasMore: true});
  expect(await f.driver.pull()).toMatchObject({hasMore: true, pages: [{}, {}]});
  expect(f.methods().filter(method => method === "sync.pullHosted")).toHaveLength(2);
});

it("tells the caller of a commit that stands before the retirement after it fails, and retries it on the next pull", async () => {
  const f = fixture(), commits = [commit({retirement: {code: "INTERNAL", message: "hosted file unexpected: docs/a.md", retry: "no"}}), commit()];
  f.answers["sync.commitCursor"] = () => commits.shift();
  const heard = vi.fn();
  await expect(f.driver.pull(undefined, heard)).rejects.toThrow("Hosted retirement failed: hosted file unexpected: docs/a.md");
  expect(heard).toHaveBeenCalledWith(expect.objectContaining({committed: true}));
  expect(await f.driver.pull()).toMatchObject({hasMore: false});
});

it("keeps each departed document the engine still holds until a reply that read them drops it", async () => {
  const f = fixture();
  expect(f.driver.departed("doc-b")).toBeUndefined();
  expect(f.driver.departedNone).toBe(false);
  const passes = [pass({pendingCursor: null, departed: ["doc-b"]}), pass({departed: ["doc-b"]}), pass({departed: ["doc-b"]}), pass()];
  const failed = {code: "INTERNAL", message: "hosted file unexpected: docs/b.md", retry: "no"};
  // The rows retired but the file did not go; then the departed list went unread; then the file went.
  const commits = [commit({hasMore: true, retirement: failed, departed: ["doc-b"]}), commit({hasMore: true, departed: null}), commit()];
  f.answers["sync.pullHosted"] = () => passes.shift();
  f.answers["sync.commitCursor"] = () => commits.shift();
  const seen: Array<boolean | undefined> = [];
  const record = () => seen.push(f.driver.departed("doc-b"));
  await expect(f.driver.pull(undefined, record)).rejects.toThrow("Hosted retirement failed");
  await f.driver.pull(undefined, record);
  expect(seen).toEqual([true, true, true, false]);
  expect(f.driver.departedNone).toBe(true);
});

// Proves: a departed list the engine cut to fit its answer says nothing past
// the last document it names, so none there reads as gone, and the documents
// it leaves out before there are. A later reply that reaches them decides.
it("reads no document past where a cut departed list stops as gone, until a list that reaches it", async () => {
  const f = fixture();
  const passes = [pass({departed: ["doc-b"], departedOmitted: 2}), pass({departed: [], departedOmitted: 3}), pass({departed: ["doc-c"]})];
  const commits = [commit({departed: ["doc-b"], departedOmitted: 2}), commit({departed: null}), commit({departed: ["doc-c"]})];
  f.answers["sync.pullHosted"] = () => passes.shift();
  f.answers["sync.commitCursor"] = () => commits.shift();
  const known = () => ["doc-a", "doc-b", "doc-c", "doc-d"].map(objectId => f.driver.departed(objectId));
  await f.driver.pull();
  expect(known()).toEqual([false, true, undefined, undefined]);
  expect(f.driver.departedNone).toBe(false);
  // Its commit could not read them, so the pass's empty but cut list stands.
  await f.driver.pull();
  expect(known()).toEqual([undefined, undefined, undefined, undefined]);
  expect(f.driver.departedNone).toBe(false);
  await f.driver.pull();
  expect(known()).toEqual([false, false, true, false]);
});

// Proves: a pass whose page activation never heard, as when its commit's
// reply is lost, leaves the held cursor where it was, so the next pass lists
// the same documents again and none is skipped.
it("asks after the last held list activation heard when a pass fails before its page", async () => {
  const f = fixture(), work = (objectId: string) => ({objectId, reason: "hosted-backfill-work-waiting" as const});
  const passes = [pass({held: [work("a")], heldThrough: "a"}), pass({held: [work("a")], heldThrough: "a"}), pass({held: [work("b")]})];
  f.answers["sync.pullHosted"] = () => passes.shift();
  const original = f.answers["sync.commitCursor"]!;
  f.answers["sync.commitCursor"] = () => {f.answers["sync.commitCursor"] = original; throw new Error("the engine stopped answering");};
  const heard = vi.fn();
  await expect(f.driver.pull(undefined, heard)).rejects.toThrow("stopped answering");
  expect(heard).not.toHaveBeenCalled();
  expect(f.driver.heldSweepUnfinished).toBe(false);
  await f.driver.pull(undefined, heard);
  expect(f.driver.heldSweepUnfinished).toBe(true);
  await f.driver.pull(undefined, heard);
  expect(f.driver.heldSweepUnfinished).toBe(false);
  const asked = f.sendRequest.mock.calls.map(([request]) => request).filter(request => request.method === "sync.pullHosted")
    .map(request => request.params);
  expect(asked).toEqual([{workspaceId: "workspace"}, {workspaceId: "workspace"}, {workspaceId: "workspace", heldAfter: "a"}]);
});

it("leaves a pass uncommitted when a reply is lost, and the next pull carries on", async () => {
  for (const lost of ["sync.materializePendingCursor", "sync.commitCursor"]) {
    const f = fixture(), original = f.answers[lost]!;
    f.answers[lost] = () => {f.answers[lost] = original; throw new Error("the engine stopped answering");};
    const heard = vi.fn();
    await expect(f.driver.pull(undefined, heard)).rejects.toThrow("stopped answering");
    expect(heard).not.toHaveBeenCalled();
    if (lost === "sync.materializePendingCursor") expect(f.methods()).not.toContain("sync.commitCursor");
    expect(await f.driver.pull()).toMatchObject({hasMore: false, pages: [{committed: true}]});
  }
});

it.each([
  {pendingCursor: {kind: "relay", token: "foreign"}}, {held: [{objectId: "doc", reason: "unknown"}]},
  {status: "complete", nextCursor: 1, held: undefined},
])("does not materialize or commit an unusable pass: %j", async patch => {
  const f = fixture();
  f.answers["sync.pullHosted"] = () => ({...pass(), ...patch});
  await expect(f.driver.pull()).rejects.toThrow("hosted sync.pullHosted result");
  expect(f.methods()).not.toContain("sync.materializePendingCursor");
});

it("runs nothing after the relay reports a diverged origin", async () => {
  for (const method of ["sync.pullHosted", "sync.push"]) {
    const f = fixture();
    f.answers[method] = () => {throw diverged();};
    await expect(method === "sync.push" ? f.driver.push() : f.driver.pull()).rejects.toThrow("relay-origin-diverged");
    expect(f.driver.diverged).toBe(true);
    const sent = f.sendRequest.mock.calls.length;
    await expect(f.driver.pull()).rejects.toThrow("origin diverged");
    await expect(f.driver.publish()).rejects.toThrow("origin diverged");
    expect(f.sendRequest.mock.calls).toHaveLength(sent);
  }
});

it("does not latch other engine refusals", async () => {
  const f = fixture();
  f.answers["sync.pullHosted"] = () => {throw new EngineRequestError(1, {code: "INVALID_PARAMS", message: "invalid-pending-cursor", retry: "no"});};
  await expect(f.driver.pull()).rejects.toThrow("invalid-pending-cursor");
  expect(f.driver.diverged).toBe(false);
});

it("retries creation before anything else until the engine creates the replica", async () => {
  const f = fixture();
  f.answers["sync.createHostedReplica"] = () => ({hosted: false});
  await expect(f.driver.push()).rejects.toThrow("hosted sync.createHostedReplica result");
  f.answers["sync.createHostedReplica"] = () => ({hosted: true});
  expect(await f.driver.push()).toEqual({pushed: 1, hasMore: false, sharingDeclined: []});
  expect(f.methods()).toEqual(["sync.createHostedReplica", "sync.createHostedReplica", "sync.push"]);
});

it("refuses simultaneous passes and stops at cancellation before committing", async () => {
  const f = fixture();
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  f.answers["sync.materializePendingCursor"] = () => {entered(); return new Promise(resolve => {finish = () => resolve({materialized: true});});};
  const pending = f.driver.pull();
  await started;
  await expect(f.driver.publish()).rejects.toThrow("already running");
  f.abort.abort();
  finish();
  await expect(pending).rejects.toThrow();
  expect(f.methods()).not.toContain("sync.commitCursor");
});

it("pages publication within the bound and stops at a page that waits for owner admission", async () => {
  const f = fixture(), pending = [{workspaceId: "workspace", originId: "owner", originSeq: 9, versionId: "main", objectId: "doc", path: "docs/a.md"}];
  const pages = [{pushed: 3, hasMore: true, ownerAdmissionPending: []}, {pushed: 2, hasMore: true, ownerAdmissionPending: pending}];
  f.answers["sync.push"] = () => ({status: "complete", sharingDeclined: [], ...pages.shift()!});
  expect(await f.driver.publish()).toEqual({pushed: 5, hasMore: true});
  f.answers["sync.push"] = () => ({status: "complete", pushed: 0, hasMore: false, sharingDeclined: [], ownerAdmissionPending: pending});
  await expect(f.driver.push()).rejects.toThrow("waiting for owner admission");
});
