import {expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";

// The engine's queue heads, by outbox, as the outbox read answers them.
const outboxes = vi.hoisted(() => ({heads: new Map<string, unknown>(), retried: [] as unknown[]}));
vi.mock("@dohc/workspace-engine-client", async original => ({
  ...await original<typeof import("@dohc/workspace-engine-client")>(),
  OwnerYDocOutbox: class {
    readHead(outboxId: string) {return Promise.resolve(outboxes.heads.get(outboxId));}
    retry(input: unknown) {outboxes.retried.push(input); return Promise.resolve({retryDeliveryId: "delivery-a"});}
    dispose() {}
  },
}));
const {readOwnerLiveQuarantines, retryOwnerLiveQuarantine} = await import("./ownerLiveQuarantine");

const binding = (objectId: string) => ({workspaceId: "workspace", mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64),
  currentPath: `${objectId}.md`, selectorPaths: [`${objectId}.md`], restoreFenceGeneration: 1});
const draft = (objectId: string, state: "active" | "quarantined" | null) =>
  ({binding: binding(objectId), outboxId: state === null ? null : `outbox-${objectId}`, state});
const head = (objectId: string, quarantineReason: string, retryDeliveryId: string | null = null) => outboxes.heads.set(`outbox-${objectId}`,
  {outboxId: `outbox-${objectId}`, binding: binding(objectId), state: "quarantined", quarantineReason, retryDeliveryId,
    entry: {deliveryId: `delivery-${objectId}`}});

it("reads every refused queue from durable state, and leaves binding changes to enrollment", async () => {
  head("a", "invalid-update"); head("b", "binding-changed"); head("c", "capacity-refused", "delivery-c");
  head("d", "invalid-update"); head("e", "stale-binding");
  const listDrafts = vi.fn()
    .mockResolvedValueOnce({drafts: [draft("a", "quarantined"), draft("b", "quarantined"), draft("live", "active")], next: {mainVersionId: "main", objectId: "live", lineageClaimId: "a".repeat(64)}})
    .mockResolvedValueOnce({drafts: [draft("c", "quarantined"), draft("d", "quarantined"), draft("e", "quarantined"), draft("none", null)], next: null});
  const client = {ownerYDocListDrafts: listDrafts, sendRequest: vi.fn(),
    ownerYDocStopList: vi.fn(async () => [{document: {objectId: "d"}}])} as unknown as EngineClient;
  expect(await readOwnerLiveQuarantines(client, "handle")).toEqual([
    {objectId: "a", path: "a.md", reason: "invalid-update", outboxId: "outbox-a", binding: binding("a"), headDeliveryId: "delivery-a", recovery: "paused"},
    {objectId: "c", path: "c.md", reason: "capacity-refused", outboxId: "outbox-c", binding: binding("c"), headDeliveryId: "delivery-c", recovery: "retrying"},
    {objectId: "d", path: "d.md", reason: "invalid-update", outboxId: "outbox-d", binding: binding("d"), headDeliveryId: "delivery-d", recovery: "stopped-kept"},
  ]);
  expect(listDrafts.mock.calls.map(call => call[1].after?.objectId ?? null)).toEqual([null, "live"]);
});

it("asks the engine for one more attempt at the binding the queue was refused at", async () => {
  const record = {objectId: "a", path: "a.md", reason: "invalid-update", outboxId: "outbox-a", binding: binding("a"),
    headDeliveryId: "delivery-a", recovery: "paused" as const};
  await retryOwnerLiveQuarantine({sendRequest: vi.fn()} as unknown as EngineClient, "handle", record);
  expect(outboxes.retried).toEqual([{outboxId: "outbox-a", binding: binding("a")}]);
});
