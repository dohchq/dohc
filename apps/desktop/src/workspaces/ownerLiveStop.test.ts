import {expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {reconcileOwnerLiveStops} from "./ownerLiveStop";

it("retains a waiting Stop and retries with the engine's successor binding", async () => {
  let row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const release = vi.fn(async () => ({...row, state: "released"}));
  const client = {ownerYDocStopList: vi.fn(async () => [row]), ownerYDocStopRequest: vi.fn(async () => row), ownerYDocRelease: release} as unknown as EngineClient;
  const retire = vi.fn(async () => false);
  const options = {client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal, assertCurrent() {}, retire};
  await reconcileOwnerLiveStops(options);
  expect(release).not.toHaveBeenCalled();
  row = {...row, binding: {...row.binding, restoreFenceGeneration: 8}};
  retire.mockResolvedValueOnce(true);
  await reconcileOwnerLiveStops(options);
  expect(retire.mock.calls).toHaveLength(2);
  expect(release).toHaveBeenCalledWith({id: 0, workspace: "handle", deadlineMs: 30_000}, row.binding, options.signal);
});

it("does not retire a Stop cancelled before its document transition runs", async () => {
  const row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const retire = vi.fn(async () => true);
  const client = {ownerYDocStopList: vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([])} as unknown as EngineClient;
  await reconcileOwnerLiveStops({client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal, assertCurrent() {}, retire});
  expect(retire).not.toHaveBeenCalled();
});

it.each(["owner-stop-conflict", "owner-stop-restore-pending"])("keeps the requested row after the daemon refuses release with %s", async message => {
  const row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const client = {ownerYDocStopList: vi.fn(async () => [row]), ownerYDocStopRequest: vi.fn(async () => row),
    ownerYDocRelease: vi.fn(async () => {throw new EngineRequestError(1, {code: "CONFLICT", message, retry: "immediate"});})} as unknown as EngineClient;
  await expect(reconcileOwnerLiveStops({client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal,
    assertCurrent() {}, retire: async () => true})).resolves.toBeUndefined();
  expect(await client.ownerYDocStopList({id: 0, workspace: "handle", deadlineMs: 30_000})).toEqual([row]);
});
