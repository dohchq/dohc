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
  refusals: [], sharingDeclined: [], held: [], departed: [], ...patch});
const commit = (patch: Partial<HostedSyncMethodResultMap["sync.commitCursor"]> = {}) =>
  ({committed: true, hasMore: false, retirement: null, departed: [], sharingDeclined: [], ...patch});
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

it("pulls again when the scope moved before the commit, and while the commit has more", async () => {
  for (const answer of [commit({committed: false}), commit({hasMore: true})]) {
    const f = fixture(), commits = [answer, commit()];
    f.answers["sync.commitCursor"] = () => commits.shift();
    const result = await f.driver.pull();
    expect(result.hasMore).toBe(false);
    expect(result.pages.map(page => page.committed)).toEqual([answer.committed, true]);
  }
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
  expect(f.driver.departed).toBeNull();
  const passes = [pass({pendingCursor: null, departed: ["doc-b"]}), pass({departed: ["doc-b"]}), pass({departed: ["doc-b"]}), pass()];
  const failed = {code: "INTERNAL", message: "hosted file unexpected: docs/b.md", retry: "no"};
  // The rows retired but the file did not go; then the departed list went unread; then the file went.
  const commits = [commit({hasMore: true, retirement: failed, departed: ["doc-b"]}), commit({hasMore: true, departed: null}), commit()];
  f.answers["sync.pullHosted"] = () => passes.shift();
  f.answers["sync.commitCursor"] = () => commits.shift();
  const seen: Array<string[] | null> = [];
  const record = () => seen.push(f.driver.departed && [...f.driver.departed]);
  await expect(f.driver.pull(undefined, record)).rejects.toThrow("Hosted retirement failed");
  await f.driver.pull(undefined, record);
  expect(seen).toEqual([["doc-b"], ["doc-b"], ["doc-b"], []]);
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

it("pulls nothing when creation finds the relay ahead of the replica's origin", async () => {
  const f = fixture();
  f.answers["sync.createHostedReplica"] = () => {throw diverged();};
  await expect(f.driver.pull()).rejects.toThrow("relay-origin-diverged");
  expect(f.driver.diverged).toBe(true);
  await expect(f.driver.pull()).rejects.toThrow("origin diverged");
  await expect(f.driver.publish()).rejects.toThrow("origin diverged");
  expect(f.methods()).toEqual(["sync.createHostedReplica"]);
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
