import {describe, expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {parseServiceOrdinaryReplicationConfig, ServiceOrdinaryReplication} from "./serviceOrdinaryReplication.js";

const attachment = () => ({relay: {baseUrl: "https://relay.example", bearerToken: "owner-credential"},
  identity: {kind: "join" as const, replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}, maxPagesPerPull: 2});
const page = (nextCursor = 1, hasMore = false) => ({status: "complete", nextCursor, hasMore,
  pendingCursor: {kind: "relay", token: `issued-${nextCursor}`}, fetched: 1, applied: 1, refused: 0, skipped: 0, conflictsOpened: 0,
  changedPaths: [{versionId: "main", path: "work.md", operation: "write", contentKind: "text"}], refusals: [], sharingDeclined: []});
function fixture(config = attachment()) {
  const abort = new AbortController();
  const sendRequest = vi.fn(async (request: Parameters<EngineClient["sendRequest"]>[0]) => {
    const result = request.method === "sync.adoptJoinIdentity" ? {adopted: true} : request.method === "sync.claim" ? {claimed: true} :
      request.method === "sync.materializePendingCursor" ? {materialized: true} : request.method === "sync.commitCursor" ? {committed: true, sharingDeclined: []} : request.method === "sync.push" ?
        {status: "complete", pushed: 1, hasMore: false, sharingDeclined: [], ownerAdmissionPending: []} : page();
    return {result};
  });
  let requestId = 0;
  const assertCurrent = vi.fn();
  const driver = new ServiceOrdinaryReplication({client: {sendRequest} as unknown as Pick<EngineClient, "sendRequest">,
    workspace: "actual-open-handle", workspaceId: "workspace", nextRequestId: () => ++requestId, deadlineMs: 1000,
    signal: abort.signal, assertCurrent}, config);
  return {driver, sendRequest, abort, assertCurrent, methods: () => sendRequest.mock.calls.map(([request]) => request.method)};
}

describe("private ordinary attachment", () => {
  it("preserves optional setup and snapshots the actual owner inputs", () => {
    expect(parseServiceOrdinaryReplicationConfig(undefined)).toBeUndefined();
    const original = attachment(), parsed = parseServiceOrdinaryReplicationConfig(original)!;
    original.identity.streamIdentity = "different";
    expect(parsed.identity).toMatchObject({streamIdentity: "actual-stream"});
    expect(parsed.relay.bearerToken).toBe("owner-credential");
    expect(Object.isFrozen(parsed.relay)).toBe(true);
  });
  it.each([
    {relay: {baseUrl: "http://relay.example", bearerToken: "owner"}},
    {relay: {baseUrl: "https://user:password@relay.example", bearerToken: "owner"}},
    {relay: {baseUrl: "https://relay.example?token=secret", bearerToken: "owner"}},
    {relay: {baseUrl: "https://relay.example", bearerToken: "owner\ncredential"}},
    {identity: {kind: "join", replicationEpoch: "actual"}},
    {identity: {kind: "claim", streamIdentity: "invented"}},
    {maxPagesPerPull: 0},
  ])("rejects malformed configuration without echoing credentials", patch => {
    expect(() => parseServiceOrdinaryReplicationConfig({...attachment(), ...patch})).toThrow();
  });
});

it("reports pending owner admission and retries publication without changing retained work", async () => {
  const f = fixture(), original = f.sendRequest.getMockImplementation()!;
  const pending = [{workspaceId: "workspace", originId: "owner", originSeq: 2, versionId: "main", objectId: "object", path: "private.md"}];
  f.sendRequest.mockImplementation(async request => request.method === "sync.push" ?
    {result: {status: "complete", pushed: 0, hasMore: false, sharingDeclined: [], ownerAdmissionPending: pending}} as never : original(request));
  await expect(f.driver.push()).rejects.toThrow("Ordinary publication is waiting for owner admission.");
  expect(pending).toEqual([{workspaceId: "workspace", originId: "owner", originSeq: 2, versionId: "main", objectId: "object", path: "private.md"}]);
  f.sendRequest.mockImplementation(original);
  expect(await f.driver.push()).toMatchObject({pushed: 1, hasMore: false});
  expect(f.methods()).toEqual(["sync.adoptJoinIdentity", "sync.push", "sync.push"]);
});

it("commits only after materialization and forwards the issued cursor without synthesis", async () => {
  const f = fixture();
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => {
    if (request.method === "sync.materializePendingCursor") {entered(); await new Promise<void>(resolve => {finish = resolve;});}
    return original(request);
  });
  const pending = f.driver.pull();
  await started;
  expect(f.methods()).toEqual(["sync.adoptJoinIdentity", "sync.pull", "sync.materializePendingCursor"]);
  expect(f.sendRequest.mock.calls[0]![0]).toMatchObject({workspace: "actual-open-handle", params: {
    workspaceId: "workspace", replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}});
  finish();
  expect(await pending).toMatchObject({nextCursor: 1, hasMore: false});
  expect(f.sendRequest.mock.calls[2]![0].params).toEqual({workspaceId: "workspace", pendingCursor: {kind: "relay", token: "issued-1"}});
  expect(JSON.stringify(f.sendRequest.mock.calls)).not.toContain("owner-credential");
});

it("leaves failed native materialization uncommitted and retries the page", async () => {
  const f = fixture(), original = f.sendRequest.getMockImplementation()!;
  let fail = true;
  f.sendRequest.mockImplementation(async request => {
    if (request.method === "sync.materializePendingCursor" && fail) throw new Error("disk write failed");
    return original(request);
  });
  await expect(f.driver.pull()).rejects.toThrow("disk write failed");
  expect(f.methods()).not.toContain("sync.commitCursor");
  fail = false; await f.driver.pull();
  expect(f.methods().filter(method => method === "sync.commitCursor")).toHaveLength(1);
});

it.each([false, undefined, "success"])("does not accept native materialization result %s as success", async materialized => {
  const f = fixture(), original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => request.method === "sync.materializePendingCursor" ? {result: {materialized}} as never : original(request));
  await expect(f.driver.pull()).rejects.toThrow("materialization");
  expect(f.methods()).not.toContain("sync.commitCursor");
});

it("does not commit after cancellation during native materialization", async () => {
  const f = fixture(), original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => {if (request.method === "sync.materializePendingCursor") f.abort.abort(); return original(request);});
  await expect(f.driver.pull()).rejects.toThrow();
  expect(f.methods()).not.toContain("sync.commitCursor");
});

it("bounds each pass without scanning the remaining backlog", async () => {
  const f = fixture(); let cursor = 0;
  const original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => request.method === "sync.pull" ? {result: page(++cursor, true)} : original(request));
  const result = await f.driver.pull();
  expect(result).toMatchObject({nextCursor: 2, hasMore: true});
  expect(result.pages).toHaveLength(2);
  expect(f.methods().filter(method => method === "sync.pull")).toHaveLength(2);
});

it("tells the caller of each committed page before a later page fails", async () => {
  const f = fixture(); let cursor = 0;
  const original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => {
    if (request.method === "sync.pull" && ++cursor === 2) throw new Error("the relay stopped answering");
    return request.method === "sync.pull" ? {result: page(cursor, true)} : original(request);
  });
  const heard: string[][] = [];
  await expect(f.driver.pull(undefined, committed => heard.push([...committed.changedPaths]))).rejects.toThrow("stopped answering");
  expect(heard, "the first page committed, and its paths were heard").toEqual([["work.md"]]);
});

it("retains ordinary refusal and sharing-decline evidence", async () => {
  const f = fixture(); const original = f.sendRequest.getMockImplementation()!;
  const refusal = {workspaceId: "workspace", originId: "origin", originSeq: 1, opKind: "ydoc.update", code: "refused", reason: "retained"};
  const decline = {path: "work.md", constraint: "limit", limitBytes: 2, observedBytes: 3};
  f.sendRequest.mockImplementation(async request => request.method === "sync.pull" ? {result: {...page(), refused: 1, refusals: [refusal], sharingDeclined: [decline]}} as never : original(request));
  const result = await f.driver.pull();
  expect(result.pages[0]).toMatchObject({refused: 1, refusals: [refusal], sharingDeclined: [decline], changedPaths: ["work.md"]});
});

it.each([{pendingCursor: {kind: "shareView", token: "foreign"}}, {status: "crashedAfterApply"}, {nextCursor: -1}])(
  "does not materialize or commit an invalid native pull result", async patch => {
    const f = fixture(); const original = f.sendRequest.getMockImplementation()!;
    f.sendRequest.mockImplementation(async request => request.method === "sync.pull" ? {result: {...page(), ...patch}} as never : original(request));
    await expect(f.driver.pull()).rejects.toThrow();
    expect(f.methods()).not.toContain("sync.materializePendingCursor");
    expect(f.methods()).not.toContain("sync.commitCursor");
  });

it("rejects stalled nonterminal pages before their second cursor commit", async () => {
  const f = fixture(); const original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => request.method === "sync.pull" ? {result: page(1, true)} : original(request));
  await expect(f.driver.pull()).rejects.toThrow("cursor progress");
  expect(f.methods().filter(method => method === "sync.commitCursor")).toHaveLength(1);
});

it("refuses simultaneous passes instead of retaining an unbounded queue", async () => {
  const f = fixture(); let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const original = f.sendRequest.getMockImplementation()!;
  f.sendRequest.mockImplementation(async request => {if (request.method === "sync.materializePendingCursor") {entered(); await new Promise<void>(resolve => {finish = resolve;});} return original(request);});
  const pending = f.driver.pull();
  await started;
  await expect(f.driver.push()).rejects.toThrow("already running");
  finish(); await pending;
});

it("does not retry authorization failures or start publication", async () => {
  const f = fixture();
  f.sendRequest.mockRejectedValue(new Error("Relay authorization failed."));
  await expect(f.driver.pull()).rejects.toThrow("authorization failed");
  expect(f.methods()).toEqual(["sync.adoptJoinIdentity"]);
});

it("pushes only on explicit request and preserves the native continuation result", async () => {
  const f = fixture();
  await f.driver.pull();
  expect(f.methods()).not.toContain("sync.push");
  expect(await f.driver.push()).toEqual({pushed: 1, hasMore: false, sharingDeclined: []});
  expect(f.methods().filter(method => method === "sync.adoptJoinIdentity")).toHaveLength(1);
});
