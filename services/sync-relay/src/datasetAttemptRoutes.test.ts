import { expect, it, vi } from "vitest";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import { createSyncRelayHandler } from "./server";
import { fixture } from "./appBackendTestFixture";
import type { RelayDatasetHost } from "./datasetHost";

const datasetId = "00000000-0000-4000-8000-000000000001", reference = "a".repeat(64);
function setup() {
  const {storage} = fixture();
  const pendingAttempts = vi.fn((auth: {userId: string}) => {
    if (auth.userId !== "owner") throw new DatasetHostError("not_authorized", "Unavailable.");
    return {datasetId, entries: [{reference, operation: "submit", recordedAtMs: 1, revision: 2, outcome: "committed", attachmentCount: 1}], nextAfter: 3};
  });
  const reconcileAttempt = vi.fn((auth: {userId: string}) => {
    if (auth.userId !== "owner") throw new DatasetHostError("not_authorized", "Unavailable.");
    return {cleared: true};
  });
  const handler = createSyncRelayHandler({storage, datasetHost: {pendingAttempts, reconcileAttempt} as unknown as RelayDatasetHost,
    nowMs: () => 10, resolveActor(request, workspaceId) {return {workspaceId, userId: request.headers.get("authorization")!.slice(7)};}});
  const request = (action: string, body?: unknown, userId = "owner") => handler(new Request(`https://relay/sync/w/datasets/${datasetId}/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: {authorization: `Bearer ${userId}`, "content-type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  return {pendingAttempts, reconcileAttempt, request};
}

it("routes bounded pending attempt pages and explicit reconciliation with verified identity", async () => {
  const f = setup();
  expect(await (await f.request("pending-attempts?after=0&limit=100")).json()).toMatchObject({datasetId, entries: [{reference}], nextAfter: 3});
  expect(f.pendingAttempts).toHaveBeenLastCalledWith({kind: "named", workspaceId: "w", userId: "owner"}, {workspaceId: "w", datasetId, after: 0, limit: 100});
  expect(await (await f.request("reconcile-attempt", {reference, acknowledge: true})).json()).toEqual({cleared: true});
  expect(f.reconcileAttempt).toHaveBeenLastCalledWith({kind: "named", workspaceId: "w", userId: "owner"}, {workspaceId: "w", datasetId, reference, acknowledge: true});
  expect((await f.request("pending-attempts", undefined, "helper")).status).toBe(404);
  expect((await f.request("reconcile-attempt", {reference, acknowledge: true}, "helper")).status).toBe(404);
});

it("rejects malformed pending cursors and reconciliation authority before calling the host", async () => {
  const f = setup();
  for (const query of ["after=-1", "after=1.5", "after=", "after=NaN", "after=1e2", "after=9007199254740992", "after=0&after=1", "limit=101", "limit=0", "limit=1&limit=2", "userId=owner"]) {
    expect((await f.request(`pending-attempts?${query}`)).status, query).toBe(400);
  }
  expect((await f.request("pending-attempts", {})).status).toBe(405);
  expect((await f.request("reconcile-attempt")).status).toBe(405);
  for (const body of [{reference}, {reference, acknowledge: false}, {reference, acknowledge: "true"}, {reference: "invalid", acknowledge: true}, {reference, acknowledge: true, userId: "owner"}]) {
    expect((await f.request("reconcile-attempt", body)).status).toBe(400);
  }
  expect((await f.request("reconcile-attempt?after=0", {reference, acknowledge: true})).status).toBe(400);
  expect(f.pendingAttempts).not.toHaveBeenCalled();
  expect(f.reconcileAttempt).not.toHaveBeenCalled();
});
