import {expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import {reconcileOwnerLiveStops} from "./ownerLiveStop";
const withDocument = <T extends {binding: {mainVersionId: string; objectId: string; currentPath: string}}>(row:T) => ({...row,document:{mainVersionId:row.binding.mainVersionId,objectId:row.binding.objectId,currentPath:row.binding.currentPath},retirementOwed:true});

it("never retries a deferred local fold on later sync passes", async () => {
  const row={...withDocument({binding:{mainVersionId:"main",objectId:"object",currentPath:"a.md"}}),state:"released",retirementOwed:false,deferred:{unsentEdits:65,editable:true}};
  const client={ownerYDocStopList:vi.fn(async () => [row]),ownerYDocStopRequest:vi.fn(async () => row),ownerYDocRelease:vi.fn()} as unknown as EngineClient;
  const retire=vi.fn();
  const options={client,workspaceHandle:"handle",workspaceId:"workspace",signal:new AbortController().signal,assertCurrent() {},retire};
  await reconcileOwnerLiveStops(options);await reconcileOwnerLiveStops(options);
  expect(retire).not.toHaveBeenCalled();expect(client.ownerYDocRelease).not.toHaveBeenCalled();
  expect(client.ownerYDocStopRequest).not.toHaveBeenCalled();
});

it("continues past a corrupt Stop and requests moved documents by their saved key", async () => {
  const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "broken", lineageClaimId: "a".repeat(64),
    currentPath: "old.md", selectorPaths: ["old.md"], restoreFenceGeneration: 7};
  const rows = [binding, {...binding, objectId: "working", currentPath: "other.md"}].map(binding => withDocument({binding, relayDatabaseNamespace: "relay", state: "requested"}));
  const release = vi.fn(async (_request, target) => {
    if (target.objectId === "broken") throw new EngineRequestError(1, {code: "INTERNAL", message: "corrupt", retry: "no"});
    return {...rows[1], state: "released"};
  });
  const request = vi.fn(async (_request, target) => rows.find(row => typeof target==="string" ? row.binding.currentPath===target : row.binding.objectId === target.objectId)!);
  const client = {ownerYDocStopList: vi.fn(async () => rows), ownerYDocStopRequest: request, ownerYDocRelease: release} as unknown as EngineClient;
  await expect(reconcileOwnerLiveStops({client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal,
    assertCurrent() {}, retire: async () => 0})).resolves.toBeUndefined();
  expect(request.mock.calls[0]![1]).toEqual(rows[0]!.document);
  expect(release).toHaveBeenCalledTimes(2);
});

it("retains a waiting Stop and retries with the engine's successor binding", async () => {
  let row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const release = vi.fn(async () => ({...row, state: "released"}));
  const client = {ownerYDocStopList: vi.fn(async () => [withDocument(row)]), ownerYDocStopRequest: vi.fn(async () => withDocument(row)), ownerYDocRelease: release} as unknown as EngineClient;
  const retire = vi.fn<() => Promise<number | null>>(async () => null);
  const options = {client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal, assertCurrent() {}, retire};
  await reconcileOwnerLiveStops(options);
  expect(release).not.toHaveBeenCalled();
  row = {...row, binding: {...row.binding, restoreFenceGeneration: 8}};
  retire.mockResolvedValueOnce(17);
  await reconcileOwnerLiveStops(options);
  expect(retire.mock.calls).toHaveLength(2);
  expect(release).toHaveBeenCalledWith({id: 0, workspace: "handle", deadlineMs: 30_000}, row.binding, {acceptedCursor: 17}, options.signal);
});

it("does not retire a Stop cancelled before its document transition runs", async () => {
  const row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const retire = vi.fn(async () => 0);
  const client = {ownerYDocStopList: vi.fn().mockResolvedValueOnce([withDocument(row)]).mockResolvedValueOnce([])} as unknown as EngineClient;
  await reconcileOwnerLiveStops({client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal, assertCurrent() {}, retire});
  expect(retire).not.toHaveBeenCalled();
});

it.each(["owner-stop-conflict", "owner-stop-restore-pending"])("keeps the requested row after the daemon refuses release with %s", async message => {
  const row = {binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
    currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 7}, relayDatabaseNamespace: "relay", state: "requested"};
  const client = {ownerYDocStopList: vi.fn(async () => [withDocument(row)]), ownerYDocStopRequest: vi.fn(async () => withDocument(row)),
    ownerYDocRelease: vi.fn(async () => {throw new EngineRequestError(1, {code: "CONFLICT", message, retry: "immediate"});})} as unknown as EngineClient;
  await expect(reconcileOwnerLiveStops({client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal,
    assertCurrent() {}, retire: async () => 0})).resolves.toBeUndefined();
  expect(await client.ownerYDocStopList({id: 0, workspace: "handle", deadlineMs: 30_000})).toEqual([withDocument(row)]);
});

it("retries an unenrolled offline Stop by document key and acknowledges retirement once", async () => {
  const row = {binding: null, document: {mainVersionId: "main", objectId: "object", currentPath: "old.md"},
    retirementOwed: true, relayDatabaseNamespace: "", state: "released" as const};
  let owed = true;
  const request = vi.fn(async () => row);
  const ack = vi.fn(async () => {owed = false;});
  const client = {ownerYDocStopList: vi.fn(async () => owed ? [row] : []), ownerYDocStopRequest: request,
    ownerYDocStopRetired: ack, ownerYDocRelease: vi.fn()} as unknown as EngineClient;
  const retire = vi.fn<() => Promise<number | null>>(async () => null);
  const options = {client, workspaceHandle: "handle", workspaceId: "workspace", signal: new AbortController().signal,
    assertCurrent() {}, retire};
  await reconcileOwnerLiveStops(options);
  expect(ack).not.toHaveBeenCalled();
  retire.mockResolvedValue(0);
  await reconcileOwnerLiveStops(options);
  await reconcileOwnerLiveStops(options);
  expect(request).toHaveBeenCalledWith({id: 0, workspace: "handle", deadlineMs: 30_000}, row.document, options.signal);
  expect(retire).toHaveBeenCalledTimes(2);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(client.ownerYDocRelease).not.toHaveBeenCalled();
});
