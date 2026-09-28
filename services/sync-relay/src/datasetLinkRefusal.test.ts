import {expect, it, vi} from "vitest";
import {createDatasetAppRoutes} from "./datasetRoutes";
import type {RelayDatasetHost} from "./datasetHost";
import type {SyncRelayStorage} from "./storage";

it("keeps admission limits opaque before a link's operation or file is authorized", async () => {
  const invoke = vi.fn();
  const host = {publication: () => ({workspaceId: "w", datasetId: "dataset", authorityRevision: 1,
    authority: {principalKey: "profile", caller: {kind: "link", grantId: "grant"}},
    capability: {operations: []}}), invoke} as unknown as RelayDatasetHost;
  const storage = {unavailable: new AbortController().signal} as SyncRelayStorage;
  const route = createDatasetAppRoutes(host, storage, {nowMs: () => 1000,
    limits: {participant: {capacity: 1, refillPerSecond: 1}}});
  const auth = {kind: "link" as const, capabilityHash: "cap", profileTokenHash: "profile"};
  for (const action of ["invoke", "invoke", "file"] as const) {
    const request = new Request("https://relay.test/sync/link/app-publications/app/backend/" + action,
      {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({authorityRevision: 1, operation: "outside", input: null, idempotencyKey: "attempt"})});
    await expect(route(request, {route: "app-backend", publicationId: "app", action}, auth)).rejects.toMatchObject({statusCode: 404, code: "not_found"});
  }
  expect(invoke).not.toHaveBeenCalled();
});
