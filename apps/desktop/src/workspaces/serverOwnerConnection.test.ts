import {expect, it, vi} from "vitest";
import {createServerOwnerConnection} from "./serverOwnerConnection";
import type {CloudCredentials} from "./cloudCredentialStore";
import type {RegistryEntry} from "./registryStore";
import {deferred} from "../testing/deferred";

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
  expect(await session!.documents(new AbortController().signal)).toEqual({ok: true, documents: []});
  expect(await session!.documents(new AbortController().signal)).toEqual({ok: true, documents: []});
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch).toHaveBeenCalledWith("https://relay.test/sync/workspace/live-host", expect.objectContaining({headers: {authorization: "Bearer secret"}, redirect: "error"}));
  f.setCredentials(null);
  expect(f.connection.workspaceIds()).toEqual([]);
  await expect(session!.documents(new AbortController().signal)).rejects.toThrow("changed");
});

const refusal = {shareId: "share", paths: ["docs"], code: "live_document_limit", message: "This server reached its live document limit."};
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
  for (const response of [new Response("", {status: 403}), new Response("x".repeat(1_048_577))]) {
    const f = fixture(); f.fetch.mockResolvedValue(response);
    const session = await f.connection.connect(f.workspace, new AbortController().signal);
    await expect(session!.documents(new AbortController().signal)).rejects.toThrow();
  }
});
