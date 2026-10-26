import {expect, it, vi} from "vitest";
import {createServerOwnerConnection} from "./serverOwnerConnection";
import type {CloudCredentials} from "./cloudCredentialStore";
import type {RegistryEntry} from "./registryStore";
import {deferred} from "../testing/deferred";
import {ServerKeptEditsConflict, ServerRecoveryCopyRefusedError} from "./ownerLiveQuarantine";

function fixture() {
  let credentials: CloudCredentials | null = {serverUrl: "https://auth.test", relayUrl: "https://relay.test", userId: "owner", email: "owner@test", token: "secret"};
  const lifetime = new AbortController();
  let workspaces: RegistryEntry[] = [{workspaceId: "workspace", rootPath: "C:/workspace", mode: "local-first", kind: "personal",
    remote: {serverUrl: "https://auth.test", ownerUserId: "owner"}}];
  const fetch = vi.fn(async () => new Response(JSON.stringify({ok: true, documents: []})));
  const changed = vi.fn();
  const connection = createServerOwnerConnection({stateDir: () => "C:/unused", workspaces: () => workspaces,
    credentials: () => credentials && {value: credentials, signal: lifetime.signal}, fetch, onRefusalsChanged: changed});
  return {connection, fetch, changed, lifetime, workspace: workspaces[0]!, setCredentials: (value: CloudCredentials | null) => {credentials = value;},
    setWorkspaces: (value: RegistryEntry[]) => {workspaces = value;}};
}

it("discovers only owned synced workspaces and sends credentials only to their pinned relay", async () => {
  const f = fixture();
  f.setWorkspaces([f.workspace, {...f.workspace, workspaceId: "local", remote: undefined},
    {...f.workspace, workspaceId: "other-owner", remote: {serverUrl: "https://auth.test", ownerUserId: "other"}},
    {...f.workspace, workspaceId: "other-server", remote: {serverUrl: "https://another.test", ownerUserId: "owner"}},
    {...f.workspace, workspaceId: "bootstrapping", joinBootstrapPending: true}]);
  expect(f.connection.workspaceIds()).toEqual(["workspace"]);
  const session = await f.connection.connect(f.workspace, new AbortController().signal);
  expect(session).toMatchObject({bearer: "secret", accountId: "owner"});
  expect(await session!.documents(new AbortController().signal)).toEqual({ok: true, documents: []});
  expect(await session!.documents(new AbortController().signal)).toEqual({ok: true, documents: []});
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledWith("https://relay.test/sync/workspace/live-host", expect.objectContaining({headers: {authorization: "Bearer secret"}, redirect: "error"}));
  f.setCredentials(null);
  expect(f.connection.workspaceIds()).toEqual([]);
  await expect(session!.documents(new AbortController().signal)).rejects.toThrow("changed");
});

it("sends the owner's kept-edits actions to the owner route, and reads the list fresh after one changes it", async () => {
  const f = fixture(), session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  const signal = new AbortController().signal;
  await session.documents(signal);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: true})));
  const checkpointDigest = "c".repeat(64);
  expect(await session.keptEdits({action: "copied", outboxId: "outbox", generation: 2, checkpointDigest}, signal)).toEqual({ok: true});
  expect(f.fetch).toHaveBeenLastCalledWith("https://relay.test/sync/workspace/live-host/kept-edits", expect.objectContaining({method: "POST",
    headers: {authorization: "Bearer secret", "content-type": "application/json"}, body: JSON.stringify({action: "copied", outboxId: "outbox", generation: 2, checkpointDigest}), redirect: "error"}));
  await session.documents(signal);
  expect(f.fetch).toHaveBeenCalledTimes(3);
  // A refusal that changed or is gone, and a Try again of edits an earlier copy keeps, answer as such; any other conflict keeps the server's words.
  for (const [code, earlier] of [["kept-edits-changed", false], ["kept-edits-earlier", true]] as const) {
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: false, code, error: "x"}), {status: 409}));
    const refused = session.keptEdits({action: "retry", outboxId: "outbox", generation: 2}, signal);
    await expect(refused).rejects.toBeInstanceOf(ServerKeptEditsConflict);
    await expect(refused).rejects.toMatchObject({earlier});
  }
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: false, code: "conflict", error: "Live editing is off for this document."}), {status: 409}));
  await expect(session.keptEdits({action: "retry", outboxId: "outbox", generation: 2}, signal)).rejects.toThrow("Live editing is off for this document.");
  // An earlier copy the server could not prepare says why, in the desktop's words; an unknown reason asks for a check.
  for (const [reason, code, words] of [["disk-space", "disk-space", "Ask the server administrator to free disk space, then try again."],
    ["newer-schema", "newer-schema", "Ask the server administrator to update dohc, then try again."],
    ["busy", "busy", "The server is using the earlier workspace copy. Try again when it finishes."],
    ["later", "server", "Ask the server administrator to check the server, then try again."]] as const) {
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: false, code: "kept-edits-unrecoverable", reason, error: "x"}), {status: 409}));
    const refused = session.keptEdits({action: "page", outboxId: "outbox", generation: 2}, signal);
    await expect(refused).rejects.toBeInstanceOf(ServerRecoveryCopyRefusedError);
    await expect(refused).rejects.toMatchObject({code, message: words, name: "ServerRecoveryCopyRefusedError"});
  }
  // A page read names the previous page's cursor, and leaves the cached list alone.
  const cursor = {snapshot: "s", part: "base", sequence: 0, offset: 0};
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: true, page: {kind: "readChanged"}})));
  expect(await session.keptEdits({action: "page", outboxId: "outbox", generation: 2, cursor}, signal)).toEqual({ok: true, page: {kind: "readChanged"}});
  expect(f.fetch).toHaveBeenLastCalledWith("https://relay.test/sync/workspace/live-host/kept-edits", expect.objectContaining({
    body: JSON.stringify({action: "page", outboxId: "outbox", generation: 2, cursor})}));
  // A later page of the list follows the cursor.
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: true, keptEdits: [], nextCursor: null})));
  expect(await session.keptEditsPage(256, signal)).toEqual({ok: true, keptEdits: [], nextCursor: null});
  expect(f.fetch).toHaveBeenLastCalledWith("https://relay.test/sync/workspace/live-host?kept=1&after=256", expect.objectContaining({headers: {authorization: "Bearer secret"}, redirect: "error"}));
  f.fetch.mockResolvedValueOnce(new Response("{}", {status: 500}));
  await expect(session.keptEditsPage(256, signal)).rejects.toThrow("discovery failed");
});

const refusal = {shareId: "share", paths: ["docs"], code: "live_document_limit", message: "This server reached its live document limit."};
it("reports an older relay's non-JSON refusal before parsing a success body", async () => {
  const f=fixture(), session=(await f.connection.connect(f.workspace,new AbortController().signal))!;
  f.fetch.mockResolvedValueOnce(new Response("Bad request",{status:400}));
  await expect(session.retire({objectId:"object",currentPath:"old.md",restoreFenceGeneration:0},new AbortController().signal)).rejects.toThrow("dohc could not stop live editing. Try again.");
  await expect(session.documents(new AbortController().signal)).resolves.toEqual({ok:true,documents:[]});
});
it.each(["restore-fenced", "restore-in-progress"])("keeps Stop pending for %s and retries the successor generation", async code => {
  const f = fixture();
  const session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 7};
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: false, code, restoreFenceGeneration: 8}), {status: 409}));
  expect(await session.retire(binding, new AbortController().signal)).toBe(null);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: true, path: binding.currentPath, objectId:binding.objectId, status: "retired", acceptedCursor: 0})));
  expect(await session.retire({...binding, restoreFenceGeneration: 8}, new AbortController().signal)).toBe(0);
  expect(f.fetch.mock.calls.map(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).restoreFenceGeneration)).toEqual([7, 8]);
});
const refusalPage = (refusals: typeof refusal[], nextCursor: string | null = null) => new Response(JSON.stringify({ok: true, refusals, nextCursor}));

it("surfaces refused enrollment on the existing tick and clears only after a complete clean scan", async () => {
  const f = fixture(); let now = 1;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
    f.fetch.mockResolvedValueOnce(refusalPage([refusal], "page-two"));
    await session.refusals(new AbortController().signal);
    expect(f.connection.hasRefusals("workspace")).toBe(true);
    expect(f.changed).toHaveBeenLastCalledWith("workspace");
    await session.refusals(new AbortController().signal);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    now += 10_000; f.fetch.mockResolvedValueOnce(refusalPage([]));
    await session.refusals(new AbortController().signal);
    expect(f.fetch.mock.lastCall).toEqual(["https://relay.test/sync/workspace/live-host?refusals=1&after=page-two", expect.objectContaining({headers: {authorization: "Bearer secret"}, redirect: "error"})]);
    expect(f.connection.hasRefusals("workspace")).toBe(true);
    now += 10_000; f.fetch.mockResolvedValueOnce(refusalPage([], "page-two"));
    await session.refusals(new AbortController().signal);
    expect(f.connection.hasRefusals("workspace")).toBe(true);
    now += 10_000; f.fetch.mockResolvedValueOnce(new Response("", {status: 503}));
    await expect(session.refusals(new AbortController().signal)).rejects.toThrow();
    expect(f.connection.hasRefusals("workspace")).toBe(true);
    now += 10_000; f.fetch.mockResolvedValueOnce(refusalPage([]));
    await session.refusals(new AbortController().signal);
    expect(f.connection.hasRefusals("workspace")).toBe(false);
    expect(f.changed).toHaveBeenCalledTimes(2);
  } finally {clock.mockRestore();}
});

it.each(["credentials", "workspace", "signal"] as const)("does not publish a late refusal after %s changes", async change => {
  const f = fixture(), pending = deferred<Response>(), operation = new AbortController();
  const session = (await f.connection.connect(f.workspace, operation.signal))!;
  f.fetch.mockImplementation(() => pending.promise);
  const read = session.refusals(new AbortController().signal);
  if (change === "credentials") f.setCredentials(null);
  else if (change === "workspace") f.setWorkspaces([{...f.workspace, rootPath: "C:/replacement"}]);
  else operation.abort();
  pending.resolve(refusalPage([refusal]));
  await expect(read).rejects.toThrow();
  expect(f.connection.hasRefusals("workspace")).toBeUndefined();
  expect(f.changed).not.toHaveBeenCalled();
});

it("pins the registry spelling of the root and shares refusal state across connects of that row", async () => {
  const f = fixture(); let now = 1;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    f.setWorkspaces([{...f.workspace, rootPath: "C:/Users/Ice/Workspace"}]);
    const native = (await f.connection.connect({...f.workspace, rootPath: "C:\\Users\\Ice\\Workspace"}, new AbortController().signal))!;
    const linked = (await f.connection.connect({...f.workspace, rootPath: "D:\\target"}, new AbortController().signal))!;
    expect(() => native.assertCurrent()).not.toThrow();
    expect(() => linked.assertCurrent()).not.toThrow();
    f.fetch.mockResolvedValueOnce(refusalPage([refusal], "page-two"));
    await native.refusals(new AbortController().signal);
    expect(f.connection.hasRefusals("workspace")).toBe(true);
    now += 10_000; f.fetch.mockResolvedValueOnce(refusalPage([]));
    await linked.refusals(new AbortController().signal);
    expect(f.fetch.mock.lastCall).toEqual(["https://relay.test/sync/workspace/live-host?refusals=1&after=page-two", expect.objectContaining({headers: {authorization: "Bearer secret"}})]);
    f.setWorkspaces([{...f.workspace, rootPath: "c:/users/ice/workspace"}]);
    expect(() => native.assertCurrent()).toThrow("changed");
    f.setWorkspaces([{...f.workspace, rootPath: "C:/Users/Ice/Workspace2"}]);
    expect(() => linked.assertCurrent()).toThrow("changed");
    expect(f.connection.hasRefusals("workspace")).toBeUndefined();
    f.setWorkspaces([]);
    expect(await f.connection.connect({...f.workspace, rootPath: "C:\\Users\\Ice\\Workspace"}, new AbortController().signal)).toBeNull();
  } finally {clock.mockRestore();}
});

it("drops credential-scoped refusal state and starts the new session at its first page", async () => {
  const f = fixture(), session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  f.fetch.mockResolvedValueOnce(refusalPage([refusal], "old-page"));
  await session.refusals(new AbortController().signal);
  f.setCredentials({serverUrl: "https://auth.test", relayUrl: "https://relay.test", userId: "owner", email: "owner@test", token: "new-token"});
  expect(f.connection.hasRefusals("workspace")).toBeUndefined();
  const next = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  f.fetch.mockResolvedValueOnce(refusalPage([]));
  await next.refusals(new AbortController().signal);
  expect(f.fetch.mock.lastCall).toEqual(["https://relay.test/sync/workspace/live-host?refusals=1", expect.objectContaining({headers: {authorization: "Bearer new-token"}})]);
  expect(f.connection.hasRefusals("workspace")).toBe(false);
  f.setWorkspaces([{...f.workspace, remote: undefined}]);
  expect(f.connection.workspaceIds()).toEqual([]);
  expect(f.connection.hasRefusals("workspace")).toBeUndefined();
});

it("rejects a late discovery response after disconnect or workspace rebinding", async () => {
  for (const revoke of ["credentials", "workspace"] as const) {
    const f = fixture(), pending = deferred<Response>();
    f.fetch.mockImplementation(() => pending.promise);
    const session = await f.connection.connect(f.workspace, new AbortController().signal);
    const read = session!.documents(new AbortController().signal);
    if (revoke === "credentials") f.lifetime.abort();
    else f.setWorkspaces([{...f.workspace, rootPath: "C:/replacement"}]);
    pending.resolve(new Response(JSON.stringify({ok: true, documents: []})));
    await expect(read).rejects.toThrow();
  }
});

it("rejects discovery errors and bounds response bytes before parsing", async () => {
  for (const [response, error] of [[new Response("", {status: 403}), "discovery failed"], [new Response("x".repeat(5 * 1024 * 1024)), "byte limit"]] as const) {
    const f = fixture(); f.fetch.mockResolvedValue(response);
    const session = await f.connection.connect(f.workspace, new AbortController().signal);
    await expect(session!.documents(new AbortController().signal)).rejects.toThrow(error);
  }
});

// Proves: a full page of the edits the server kept fits its response limit
// even when every row has the longest path, in characters UTF-8 spends three bytes on.
it("reads a full page of kept edits whose paths are all as long as a path can be", async () => {
  const keptEdits = Array.from({length: 256}, (_, index) => ({objectId: `object-${index}`, path: "界".repeat(4096), outboxId: "o".repeat(512),
    reason: "invalid-update", generation: index + 1, store: "s".repeat(32), recovery: "paused"}));
  const page = JSON.stringify({ok: true, keptEdits, nextCursor: null});
  expect(Buffer.byteLength(page)).toBeGreaterThan(3 * 1024 * 1024);
  const f = fixture(), session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  f.fetch.mockResolvedValueOnce(new Response(page));
  expect(await session.keptEditsPage(256, new AbortController().signal)).toEqual({ok: true, keptEdits, nextCursor: null});
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ok: true, documents: [], keptEdits, keptEditsCursor: 256})));
  expect(await session.documents(new AbortController().signal)).toMatchObject({keptEdits: {length: 256}});
});

it("keeps the credential account when discovery contains a client-selected account", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(new Response(JSON.stringify({ok: true, accountId: "forged-account", documents: []})));
  const session = (await f.connection.connect(f.workspace, new AbortController().signal))!;
  await session.documents(new AbortController().signal);
  expect(session).toMatchObject({bearer: "secret", accountId: "owner"});
});
