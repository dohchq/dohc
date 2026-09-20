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
  const connection = createServerOwnerConnection({stateDir: () => "C:/unused", workspaces: () => workspaces,
    credentials: () => credentials && {value: credentials, signal: lifetime.signal}, fetch});
  return {connection, fetch, lifetime, workspace: workspaces[0]!, setCredentials: (value: CloudCredentials | null) => {credentials = value;},
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
