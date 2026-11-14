import { DiscussionActivityHub } from "./discussionActivity";
import { ClientClosedRequest } from "@dohc/service-http";
import { guardRelayResponses } from "./relayResponseStanding";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  fixture as ticketFixture,
  binding,
  retainServiceActivation,
  scope,
} from "./liveTickets.test-helper";
import {
  readServiceActivationRetirement,
  type RetirableServiceActivation,
} from "./storage/serviceActivationRetirement";
import type { ServiceHostRetirementPreparation } from "./storage/serviceHostEnrollment";
import type { StorageContext } from "./storage/context";
import { createLiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import {
  createServiceHostEnrollmentRoutes,
  discoverServiceHostDocuments,
} from "./serviceHostEnrollmentRoutes";
import { createServiceHostReplication } from "./serviceHostReplication";
import { authorizeServiceHostReplication, deriveServiceHostBearer } from "./serviceHostCredential";
import { stopWithoutSessionHost } from "./sessionHostStop";
import type { ServiceActivationBlock } from "./serviceActivationDriver";
import type { ServiceHostedHold } from "./serviceHostedReplication";
import { RecoveryCopyRefusal, type ServiceKeptEdits } from "./storage/serviceKeptEdits";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { heldDocumentFixture } from "./heldDocument.test-helper";
import type { KnownRefusalWord } from "./serverLogWords";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const identity = { replicationEpoch: "epoch", streamIdentity: "stream" };
const queue = (outboxId: string, of = identity) => ({
  workspaceId: scope.workspaceId,
  identity: of,
  outboxId,
});
// One page of a refused queue as the service host's engine answers it. The desktop assembles the pages.
const keptPage = (kept: ServiceKeptEdits, cursor: JsonValue | undefined): JsonValue => ({
  kind: "page",
  outboxId: kept.outboxId,
  after: cursor ?? null,
});
const key = new Uint8Array(32).fill(17),
  namespace = "service-route-test";
const serviceReplication = (storage: Parameters<typeof authorizeServiceHostReplication>[0]) =>
  createServiceHostReplication({
    activity: new DiscussionActivityHub(),
    storage,
    prefix: "dohc-service-v1.",
    hostedFeed: true,
    authorize: (input) => authorizeServiceHostReplication(storage, { key, namespace, ...input }),
  });
async function fixture() {
  const f = await ticketFixture();
  cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({
    workspaceId: scope.workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  f.raw
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)",
    )
    .run(scope.workspaceId);
  f.raw
    .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)")
    .run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const history = createLiveJournalHistoryAuthority({ namespace, reconciled: true });
  const blocked = new Map<string, ServiceActivationBlock>(),
    pending = new Set<string>(),
    prepared: RetirableServiceActivation[] = [];
  const host = {
    ready: vi.fn(() => false),
    reconcile: vi.fn(),
    unavailable: false,
    holdReason: vi.fn(
      (_document: { objectId: string }): ServiceHostedHold["reason"] | undefined => undefined,
    ),
    failing: vi.fn(
      (_document: { objectId: string }): { word: KnownRefusalWord; since: number } | undefined =>
        undefined,
    ),
    blocked: vi.fn((document: { objectId: string }) => blocked.get(document.objectId)),
    unblock: vi.fn((document: { objectId: string }) => blocked.delete(document.objectId)),
    diverged: vi.fn(
      (_row: { workspaceId: string; replicationEpoch: string; streamIdentity: string }) => false,
    ),
    keptEdits: {
      page: vi.fn(async (kept: ServiceKeptEdits, cursor: JsonValue | undefined) =>
        keptPage(kept, cursor),
      ),
      // The host grants in the document's turn after rechecking its caller and the refusal.
      retry: vi.fn(
        async (
          kept: ServiceKeptEdits,
          guard: () => void,
        ): Promise<"granted" | "changed" | "unavailable"> => {
          guard();
          return f.storage.markServiceKeptEditsRetrying(kept) ? "granted" : "changed";
        },
      ),
      copied: vi.fn(async (_kept: ServiceKeptEdits) => {}),
    },
    // The documents whose native edits the host has not delivered yet. Stop fences only once none is pending.
    // Otherwise it prepares the activation Stop retires, as `prepared` records, unless `running` is false.
    pending,
    prepared,
    running: true,
    async stop<T>(
      document: { workspaceId: string; objectId: string },
      fence: (preparation?: ServiceHostRetirementPreparation) => T,
    ): Promise<T | "waiting"> {
      if (pending.has(document.objectId)) return "waiting";
      if (!host.running)
        return stopWithoutSessionHost(
          document,
          { code: "host-not-loaded", sessionHost: "starting" },
          fence,
        );
      const candidate = f.storage.retirableServiceActivation(document);
      if (candidate) prepared.push(candidate);
      return fence(candidate ? { ...candidate, assertCurrent() {} } : undefined);
    },
    block(objectId: string, why: ServiceActivationBlock = "refused") {
      blocked.set(objectId, why);
    },
  };
  let actor = { workspaceId: scope.workspaceId, userId: "owner-1" };
  const resolveActor = vi.fn(async () => actor);
  const handle = createServiceHostEnrollmentRoutes({
    storage: f.storage,
    history,
    host,
    resolveActor,
  });
  const input = {
    workspaceId: scope.workspaceId,
    ownerUserId: "owner-1",
    shareId: scope.shareId,
    path: binding.currentPath,
    nowMs: 10,
    guard() {},
  };
  const request = (
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    suffix = "",
  ) =>
    new Request(`https://relay.test/sync/${scope.workspaceId}/live-host${suffix}`, {
      method,
      headers: {
        authorization: "Bearer account-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const seed = (path: string, objectId: string, contentKind = "text") => {
    f.raw
      .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,?,1)")
      .run(scope.workspaceId, path, "b".repeat(64), contentKind);
    f.raw
      .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,?,1,1)`)
      .run(scope.workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64), contentKind);
  };
  const release = (objectId: string) =>
    f.storage.releaseServiceHostEnrollment({ workspaceId: scope.workspaceId, objectId, nowMs: 20 });
  return {
    ...f,
    history,
    host,
    resolveActor,
    handle,
    input,
    request,
    seed,
    release,
    setActor(value: typeof actor) {
      actor = value;
    },
  };
}

it("answers a live documents list its client closed quietly, and still logs any other failure", async () => {
  const f = await fixture();
  const handle = guardRelayResponses(f.storage, f.handle);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const closed = (reason: unknown) => {
    const caller = new AbortController();
    caller.abort(reason);
    return new Request(f.request(), { signal: caller.signal });
  };
  expect((await handle(closed(new ClientClosedRequest()))).status).toBe(499);
  expect(errors).not.toHaveBeenCalled();
  // A connection the server closed itself, as at shutdown, is not a client leaving.
  expect((await handle(closed(undefined))).status).toBe(500);
  expect(errors).toHaveBeenCalledWith("[sync-relay] unhandled error", "AbortError");
  errors.mockClear();
  // Only the close itself is quiet: another failure after the client left still logs.
  f.resolveActor.mockRejectedValueOnce(new Error("actor lookup failed"));
  expect((await handle(closed(new ClientClosedRequest()))).status).toBe(500);
  expect(errors).toHaveBeenCalledWith("[sync-relay] unhandled error", "Error");
});

it("requires bearer owner authority, rejects ambient credentials and rejects unknown parameters", async () => {
  const f = await fixture();
  for (const headers of [
    { authorization: "" },
    { cookie: "session=browser" },
    { authorization: "Basic x" },
  ] as Record<string, string>[]) {
    expect((await f.handle(f.request("GET", undefined, headers))).status).toBe(404);
  }
  expect(f.resolveActor).not.toHaveBeenCalled();
  f.setActor({ workspaceId: scope.workspaceId, userId: "other" });
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({ workspaceId: "other", userId: "owner-1" });
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({ workspaceId: scope.workspaceId, userId: "owner-1" });
  expect((await f.handle(f.request("GET", undefined, {}, "?unknown=1"))).status).toBe(404);
  expect(
    (
      await f.handle(
        f.request("POST", { shareId: scope.shareId, path: binding.currentPath, root: "/etc" }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handle(
        f.request("DELETE", { path: binding.currentPath, workspaceId: scope.workspaceId }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.handle(
        f.request("POST", { shareId: scope.shareId }, { "content-type": "text/plain" }),
      )
    ).status,
  ).toBe(400);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("lets only the workspace's owner see, read, try again and confirm a copy of edits the server kept, admitting and publishing none of them", async () => {
  const f = await fixture();
  let refusals = 0;
  const refuse = () => {
    f.storage.recordServiceKeptEdits({
      identity,
      outboxId: "outbox-1",
      binding,
      reason: "invalid-update",
      headDeliveryId: "delivery-1",
      refusalKey: `refusal-${++refusals}`,
      nowMs: 5,
    });
    return f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation;
  };
  const first = refuse();
  const kept = {
    objectId: binding.objectId,
    path: binding.currentPath,
    outboxId: "outbox-1",
    reason: "invalid-update",
    store: expect.stringMatching(/^[0-9a-f]{32}$/),
  };
  const list = async () =>
    ((await (await f.handle(f.request())).json()) as { keptEdits?: unknown }).keptEdits;
  // A copy names the checkpoint it read: none here, as for a queue with no accepted state.
  const act = (
    action: string,
    generation: number,
    outboxId = "outbox-1",
    extra: Record<string, unknown> = {},
  ) =>
    f.handle(
      f.request(
        "POST",
        {
          action,
          outboxId,
          generation,
          ...(action === "copied" ? { checkpointDigest: null } : {}),
          ...extra,
        },
        {},
        "/kept-edits",
      ),
    );
  expect(await list()).toEqual([{ ...kept, generation: first, recovery: "paused" }]);
  for (const actor of [
    { workspaceId: scope.workspaceId, userId: "recipient" },
    { workspaceId: "other-workspace", userId: "owner-1" },
  ]) {
    f.setActor(actor);
    expect((await f.handle(f.request())).status).toBe(404);
    for (const action of ["page", "retry", "copied"])
      expect((await act(action, first)).status).toBe(404);
  }
  f.setActor({ workspaceId: scope.workspaceId, userId: "owner-1" });
  expect(f.host.keptEdits.page).not.toHaveBeenCalled();
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  expect(f.storage.readServiceKeptEdits(queue("outbox-1"))).toMatchObject({
    retrying: false,
    copied: false,
  });
  for (const response of [
    ...(await Promise.all(
      ["page", "retry", "copied"].map((action) => act(action, first, "outbox-unknown")),
    )),
    await act("page", first + 1),
  ]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "kept-edits-changed" });
  }
  expect(
    (await f.handle(f.request("POST", { action: "page", outboxId: "outbox-1" }, {}, "/kept-edits")))
      .status,
  ).toBe(400);
  for (const cursor of ["x", [], { snapshot: "s" }, null])
    expect((await act("page", first, "outbox-1", { cursor })).status).toBe(400);
  expect(
    (
      await act("retry", first, "outbox-1", {
        cursor: { snapshot: "s", part: "base", sequence: 0, offset: 0 },
      })
    ).status,
  ).toBe(400);
  const count = (table: string) =>
    Number(f.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  const before = [count("sync_relay_live_update_journal"), count("sync_relay_log")];
  const cursor = { snapshot: "s", part: "update", sequence: 2, offset: 0 };
  expect(await (await act("page", first)).json()).toEqual({
    ok: true,
    page: { kind: "page", outboxId: "outbox-1", after: null },
  });
  expect(await (await act("page", first, "outbox-1", { cursor })).json()).toEqual({
    ok: true,
    page: { kind: "page", outboxId: "outbox-1", after: cursor },
  });
  expect([count("sync_relay_live_update_journal"), count("sync_relay_log")]).toEqual(before);
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  expect(await (await act("retry", first)).json()).toEqual({ ok: true });
  expect(await list()).toEqual([{ ...kept, generation: first, recovery: "retrying" }]);
  expect((await act("retry", first)).status).toBe(409);
  expect(f.host.keptEdits.retry).toHaveBeenCalledTimes(1);
  // That Try again delivers, so the queue is forgotten; new edits are then refused again.
  // The copy read at the first refusal does not cover the second.
  f.storage.forgetServiceKeptEdits(queue("outbox-1"));
  const second = refuse();
  const held = () =>
    f.storage.serviceKeptEditsHeld(
      { workspaceId: scope.workspaceId, objectId: binding.objectId },
      identity,
    );
  expect((await act("copied", first)).status).toBe(409);
  expect(held()).toBe(true);
  for (const shape of [
    { action: "copied", outboxId: "outbox-1", generation: second },
    { action: "copied", outboxId: "outbox-1", generation: second, checkpointDigest: "x" },
    { action: "retry", outboxId: "outbox-1", generation: second, checkpointDigest: null },
  ]) {
    expect((await f.handle(f.request("POST", shape, {}, "/kept-edits"))).status).toBe(400);
  }
  expect(held()).toBe(true);
  // While the queue stays frozen at its seed, a copy of an older checkpoint holds the document, and one of the current checkpoint lets it go.
  f.storage.observeServiceKeptEditsCheckpoint(queue("outbox-1"), "b".repeat(64));
  expect(
    await (await act("copied", second, "outbox-1", { checkpointDigest: "a".repeat(64) })).json(),
  ).toEqual({ ok: true });
  expect(await list()).toEqual([{ ...kept, generation: second, recovery: "paused" }]);
  expect(held()).toBe(true);
  expect(
    await (await act("copied", second, "outbox-1", { checkpointDigest: "b".repeat(64) })).json(),
  ).toEqual({ ok: true });
  expect(await list()).toEqual([{ ...kept, generation: second, recovery: "copied" }]);
  expect(held()).toBe(false);
  f.host.keptEdits.retry.mockResolvedValueOnce("unavailable");
  expect((await act("retry", second)).status).toBe(409);
  f.host.keptEdits.retry.mockResolvedValueOnce("changed");
  expect((await act("retry", second)).status).toBe(409);
  expect(await list()).toEqual([{ ...kept, generation: second, recovery: "copied" }]);
  const third = refuse();
  f.host.keptEdits.page.mockImplementationOnce(async (row, after) => {
    refuse();
    return keptPage(row, after);
  });
  const raced = await act("page", third);
  expect(raced.status).toBe(409);
  expect(await raced.json()).toMatchObject({ code: "kept-edits-changed" });
  f.storage.forgetServiceKeptEdits(queue("outbox-1"));
  expect(await list()).toBeUndefined();
});

it("reads and confirms edits kept in an earlier identity's store, and refuses their Try again", async () => {
  const f = await fixture(),
    old = { replicationEpoch: "old-epoch", streamIdentity: "old-stream" };
  for (const [of, refusalKey] of [
    [old, "refusal-1"],
    [identity, "refusal-1"],
  ] as const) {
    f.storage.recordServiceKeptEdits({
      identity: of,
      outboxId: "outbox-x",
      binding,
      reason: "invalid-update",
      headDeliveryId: "delivery-1",
      refusalKey,
      nowMs: 5,
    });
  }
  const [earlier, current] = [old, identity].map(
    (of) => f.storage.readServiceKeptEdits(queue("outbox-x", of))!.generation,
  ) as [number, number];
  const row = {
    objectId: binding.objectId,
    path: binding.currentPath,
    outboxId: "outbox-x",
    reason: "invalid-update",
    store: expect.any(String),
  };
  const list = async () =>
    ((await (await f.handle(f.request())).json()) as { keptEdits: Array<{ store: string }> })
      .keptEdits;
  const listed = await list();
  expect(listed).toEqual([
    { ...row, generation: earlier, recovery: "paused", earlier: true },
    { ...row, generation: current, recovery: "paused" },
  ]);
  expect(listed[0]!.store).not.toBe(listed[1]!.store);
  for (const secret of ["old-epoch", "old-stream", "epoch", "stream"])
    expect(JSON.stringify(listed)).not.toContain(secret);
  const act = (action: string, generation: number) =>
    f.handle(
      f.request(
        "POST",
        {
          action,
          outboxId: "outbox-x",
          generation,
          ...(action === "copied" ? { checkpointDigest: null } : {}),
        },
        {},
        "/kept-edits",
      ),
    );
  for (const actor of [
    { workspaceId: scope.workspaceId, userId: "recipient" },
    { workspaceId: "other-workspace", userId: "owner-1" },
  ]) {
    f.setActor(actor);
    for (const action of ["page", "copied"]) expect((await act(action, earlier)).status).toBe(404);
  }
  f.setActor({ workspaceId: scope.workspaceId, userId: "owner-1" });
  expect(f.host.keptEdits.page).not.toHaveBeenCalled();
  const refused = await act("retry", earlier);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ ok: false, code: "kept-edits-earlier" });
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  expect(await (await act("page", earlier)).json()).toEqual({
    ok: true,
    page: { kind: "page", outboxId: "outbox-x", after: null },
  });
  expect(await (await act("copied", earlier)).json()).toEqual({ ok: true });
  expect(
    f.host.keptEdits.page.mock.calls.map(([kept]) => [kept.generation, kept.identity]),
  ).toEqual([[earlier, old]]);
  expect(
    f.host.keptEdits.copied.mock.calls.map(([kept]) => [kept.generation, kept.identity]),
  ).toEqual([[earlier, old]]);
  f.host.keptEdits.page.mockRejectedValueOnce(new RecoveryCopyRefusal("disk-space"));
  const unprepared = await act("page", earlier);
  expect(unprepared.status).toBe(409);
  expect(await unprepared.json()).toMatchObject({
    ok: false,
    code: "kept-edits-unrecoverable",
    reason: "disk-space",
  });
  expect(f.storage.readServiceKeptEdits(queue("outbox-x", identity))).toMatchObject({
    generation: current,
    copied: false,
  });
  expect(await list()).toEqual([
    { ...row, generation: earlier, recovery: "copied", earlier: true },
    { ...row, generation: current, recovery: "paused" },
  ]);
  const copiedRetry = await act("retry", earlier);
  expect(copiedRetry.status).toBe(409);
  expect(await copiedRetry.json()).toMatchObject({ ok: false, code: "kept-edits-earlier" });
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  f.host.keptEdits.copied.mockRejectedValueOnce(new Error("engine gone"));
  expect(await (await act("copied", current)).json()).toEqual({ ok: true });
  expect(f.storage.readServiceKeptEdits(queue("outbox-x", identity))).toMatchObject({
    copied: true,
  });
});

it("runs at most two recovery page reads at once across the relay, until each body is taken", async () => {
  const f = await fixture();
  for (const index of [1, 2, 3, 4, 5]) {
    f.storage.recordServiceKeptEdits({
      identity,
      outboxId: `outbox-${index}`,
      binding: { ...binding, objectId: `other-object-${index}` },
      reason: "invalid-update",
      headDeliveryId: "delivery-1",
      refusalKey: `refusal-${index}`,
      nowMs: 5,
    });
  }
  const releases: Array<() => void> = [];
  f.host.keptEdits.page.mockImplementation(
    async (kept: ServiceKeptEdits, cursor: JsonValue | undefined) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return keptPage(kept, cursor);
    },
  );
  const read = (index: number, signal?: AbortSignal) =>
    f.handle(
      new Request(
        f.request(
          "POST",
          {
            action: "page",
            outboxId: `outbox-${index}`,
            generation: f.storage.readServiceKeptEdits(queue(`outbox-${index}`))!.generation,
          },
          {},
          "/kept-edits",
        ),
        signal ? { signal } : {},
      ),
    );
  const abort = new AbortController();
  const answers = [read(1), read(2), read(3, abort.signal), read(4), read(5)];
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(2));
  abort.abort(new Error("Caller gave up."));
  // Both pages are built, but no client took their bodies, so no other read starts.
  releases.shift()!();
  releases.shift()!();
  const [one, two] = await Promise.all([answers[0]!, answers[1]!]);
  expect(f.host.keptEdits.page).toHaveBeenCalledTimes(2);
  expect(await one.json()).toMatchObject({ ok: true, page: { outboxId: "outbox-1" } });
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(3));
  await two.body!.cancel();
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(4));
  expect(f.host.keptEdits.page.mock.calls.map(([kept]) => kept.outboxId)).toEqual([
    "outbox-1",
    "outbox-2",
    "outbox-4",
    "outbox-5",
  ]);
  while (releases.length) releases.shift()!();
  expect(
    await Promise.all(
      answers.slice(2).map((answer) =>
        answer.then(
          (response) => response.status,
          () => "aborted",
        ),
      ),
    ),
  ).toEqual([expect.anything(), 200, 200]);
});

it("discovers rich documents in folders, skips other content, and preserves a paused enrollment", async () => {
  const f = await fixture();
  f.seed("docs/b.md", "object-b");
  f.seed("docs/data.csv", "object-c");
  f.seed("docs/image.md", "object-d", "binary");
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments().map((row) => row.path)).toEqual([
    "docs/a.md",
    "docs/b.md",
  ]);
  expect(await (await f.handle(f.request("DELETE", { path: binding.currentPath }))).json()).toEqual(
    { ok: true, path: binding.currentPath, objectId: binding.objectId, status: "paused" },
  );
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  f.release(binding.objectId);
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  expect((await f.handle(f.request("POST", { shareId: scope.shareId }))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]).toMatchObject({
    enabled: false,
    ownerStop: "pause",
  });
  expect((await f.handle(f.request("POST", { path: binding.currentPath }))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments().every((row) => row.enabled && !row.ownerStop)).toBe(
    true,
  );
  await f.handle(f.request("DELETE", { path: binding.currentPath }));
  await f.handle(
    f.request("DELETE", { path: "docs/b.md", retire: true, restoreFenceGeneration: 0 }),
  );
  f.release("object-b");
  f.seed("docs/retry.md", "retry-object");
  expect((await f.handle(f.request("POST", { shareId: scope.shareId, retry: true }))).status).toBe(
    202,
  );
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toMatchObject({
    retired: true,
    enabled: false,
  });
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/retry.md")).toMatchObject({
    enabled: true,
  });
  expect(
    (
      await f.handle(
        f.request("POST", { shareId: scope.shareId, retry: true, path: binding.currentPath }),
      )
    ).status,
  ).toBe(400);
});

it("reports ready only with completed retained activation and the current native runtime", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  const state = async () => {
    const response = await f.handle(f.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    for (const secret of [
      deriveServiceHostBearer(enrolled, { key, namespace }),
      "account-token",
      "owner-1",
      "replicationEpoch",
      "streamIdentity",
    ])
      expect(text).not.toContain(secret);
    return JSON.parse(text).documents[0];
  };
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({
    path: binding.currentPath,
    objectId: binding.objectId,
    status: "preparing",
  });
  retainServiceActivation(f.raw, namespace);
  expect((await state()).status).toBe("preparing");
  f.raw.exec("UPDATE sync_relay_service_activations SET completion_json='{}'");
  f.host.ready.mockReturnValue(false);
  expect((await state()).status).toBe("preparing");
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({
    path: binding.currentPath,
    objectId: binding.objectId,
    status: "ready",
    document: { binding, relayDatabaseNamespace: namespace },
    head: 0,
  });
  // `head` is the note's last accepted journal position; another note's edit leaves it alone.
  const accept = (deliveryId: string, objectId: string) =>
    Number(
      f.raw
        .prepare(`INSERT INTO sync_relay_live_update_journal
      (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
      restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
      relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,first_seen_deletes_json)
      VALUES (?,?,?,'main',?,?,?,'["docs/a.md"]',1,'owner','owner-1',1,1,x'01',?,1,?,1,2,'[]') RETURNING journal_cursor`)
        .get(
          deliveryId,
          "c".repeat(64),
          binding.workspaceId,
          objectId,
          binding.lineageClaimId,
          binding.currentPath,
          namespace,
          "d".repeat(64),
        )!.journal_cursor,
    );
  const first = accept("first-edit", binding.objectId);
  expect((await state()).head).toBe(first);
  accept("other-note-edit", "other-object");
  expect((await state()).head).toBe(first);
  const second = accept("second-edit", binding.objectId);
  expect(second).toBeGreaterThan(first);
  expect((await state()).head).toBe(second);
  f.storage.setServiceHostEnrollmentEnabled({ ...f.input, enabled: false });
  expect(await state()).not.toHaveProperty("head");
  expect((await state()).status).toBe("paused");
});

it.each([0, 1] as const)(
  "keeps the conflict-parent reason on a retired held document after Stop clears the running hold (effect %s)",
  async (effectIndex) => {
    const f = await heldDocumentFixture(undefined, effectIndex);
    cleanup.push(f.close);
    expect((await (await f.handle(f.request())).json()).documents[0]).toMatchObject({
      reason: "conflict-parent-withheld",
    });
    expect((await f.stop()).status).toBe(200);
    expect(f.host.holdReason()).toBeUndefined();
    f.storage.releaseServiceHostEnrollment({
      workspaceId: f.binding.workspaceId,
      objectId: f.binding.objectId,
      nowMs: 20,
    });
    expect(await (await f.handle(f.request("GET", "?retired=1"))).json()).toEqual({
      ok: true,
      documents: [
        {
          path: f.binding.currentPath,
          objectId: f.binding.objectId,
          status: "retired",
          stopped: true,
          reason: "conflict-parent-withheld",
        },
      ],
      nextCursor: null,
    });
    const resume = await f.handle(f.request("POST", "", { path: f.binding.currentPath }));
    expect(resume.status).toBe(202);
    expect(
      f.storage.readServiceHostEnrollment(f.binding.workspaceId, f.binding.currentPath),
    ).toMatchObject({ enabled: true, retired: false, ownerStop: null });
  },
);

// Duplicate is the way out for a held note: its copy is a new object whose
// one moment carries no conflict, so the server can host it if the share covers it.
it.each([
  ["a share of the note's folder", ["docs"], true],
  ["a share of exactly the note", ["docs/a.md"], false],
] as const)(
  "enrols a held note's copy, which carries no conflict effect, under %s only if it covers the copy",
  async (_shape, paths, covered) => {
    const f = await heldDocumentFixture();
    cleanup.push(f.close);
    const workspaceId = f.binding.workspaceId,
      copy = { workspaceId, objectId: "copy-object", path: "docs/a - Copy.md" };
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
      .run(JSON.stringify({ paths, versionId: null }), scope.shareId);
    f.raw
      .prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq)
      VALUES (?,'owner',3,'moment.append',?,1,4)`)
      .run(
        workspaceId,
        JSON.stringify({
          objectId: copy.objectId,
          versionId: "main",
          path: copy.path,
          momentId: "copy-moment",
        }),
      );
    f.raw
      .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)")
      .run(workspaceId, copy.path, "b".repeat(64));
    f.raw
      .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,4,'copy-moment','main',?,?,'text',1,1)`)
      .run(workspaceId, copy.objectId, copy.path, "b".repeat(64));
    discoverServiceHostDocuments(f.storage);
    const enrolled = f.storage.listServiceHostEnrollments().map((row) => row.path);
    expect(enrolled).toContain(f.binding.currentPath);
    if (covered) expect(enrolled).toContain(copy.path);
    else expect(enrolled).not.toContain(copy.path);
    expect(f.storage.hasServiceHostConflictEffect(f.binding)).toBe(true);
    expect(f.storage.hasServiceHostConflictEffect(copy)).toBe(false);
  },
);

it("reports only a conflict-parent hold, after document state and existing blocks", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  const state = async () => (await (await f.handle(f.request())).json()).documents[0];
  const base = { path: binding.currentPath, objectId: binding.objectId };
  expect(await state()).toEqual({ ...base, status: "preparing" });
  for (const hold of [
    undefined,
    "hosted-backfill-work-waiting",
    "hosted-backfill-path-held",
    "hosted-scope-path-mismatch",
    "hosted-live-edit-unadmitted",
  ] as const) {
    f.host.holdReason.mockReturnValue(hold);
    f.host.unavailable = true;
    expect(await state()).toEqual({ ...base, status: "unavailable" });
    f.host.unavailable = false;
    expect(await state()).toEqual({ ...base, status: "preparing" });
  }
  f.host.holdReason.mockReturnValue("hosted-conflict-parent-withheld");
  expect(await state()).toEqual({
    ...base,
    status: "unavailable",
    reason: "conflict-parent-withheld",
  });
  for (const [block, reason] of [
    ["without-lineage", "live-document-without-lineage"],
    ["refused", "session-host-refused"],
    ["live-edit-unadmitted", "live-edit-unadmitted"],
    ["history-over-budget", "live-history-over-budget"],
  ] as const) {
    f.host.block(enrolled.objectId, block);
    expect(await state()).toEqual({ ...base, status: "unavailable", reason });
  }
  f.host.unblock(enrolled);
  f.host.holdReason.mockReturnValue(undefined);
  expect(await state()).toEqual({ ...base, status: "preparing" });
  f.host.holdReason.mockReturnValue("hosted-conflict-parent-withheld");
  f.storage.setServiceHostEnrollmentEnabled({ ...f.input, enabled: false });
  expect(await state()).toEqual({ ...base, status: "paused" });
  f.host.diverged.mockReturnValue(true);
  expect(await state()).toEqual({
    ...base,
    status: "unavailable",
    reason: "session-host-diverged",
  });
  f.host.diverged.mockReturnValue(false);
  f.storage.ensureOwnedLiveDocument({ intent: "owner-resume", ...f.input });
  f.raw
    .prepare("UPDATE sync_relay_object_moments SET path='moved.md' WHERE workspace_id=?")
    .run(scope.workspaceId);
  expect(await state()).toEqual({ ...base, status: "unavailable", reason: "document-unavailable" });
  f.raw
    .prepare("UPDATE sync_relay_workspaces SET replication_epoch='rotated' WHERE workspace_id=?")
    .run(scope.workspaceId);
  expect(await state()).toEqual({ ...base, status: "unavailable", reason: "workspace-changed" });
});

it("reports a document whose live start keeps failing, after a down host, every hold and every block", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  const state = async () => (await (await f.handle(f.request())).json()).documents[0];
  const base = { path: binding.currentPath, objectId: binding.objectId };
  f.host.failing.mockReturnValue({
    word: "engine-refused",
    since: Date.parse("2026-11-13T01:00:00.000Z"),
  });
  expect(await state()).toEqual({
    ...base,
    status: "unavailable",
    reason: "live-start-failing",
    failure: { word: "engine-refused", since: "2026-11-13T01:00:00.000Z" },
  });
  f.host.unavailable = true;
  expect(await state()).toEqual({ ...base, status: "unavailable" });
  f.host.unavailable = false;
  for (const hold of [
    "hosted-backfill-work-waiting",
    "hosted-backfill-path-held",
    "hosted-scope-path-mismatch",
    "hosted-live-edit-unadmitted",
    "released-lineage-unsettled",
  ] as const) {
    f.host.holdReason.mockReturnValue(hold);
    expect(await state()).toEqual({ ...base, status: "preparing" });
  }
  f.host.holdReason.mockReturnValue("hosted-conflict-parent-withheld");
  expect(await state()).toEqual({
    ...base,
    status: "unavailable",
    reason: "conflict-parent-withheld",
  });
  f.host.holdReason.mockReturnValue(undefined);
  for (const [block, reason] of [
    ["without-lineage", "live-document-without-lineage"],
    ["refused", "session-host-refused"],
    ["live-edit-unadmitted", "live-edit-unadmitted"],
    ["history-over-budget", "live-history-over-budget"],
  ] as const) {
    f.host.block(enrolled.objectId, block);
    expect(await state()).toEqual({ ...base, status: "unavailable", reason });
  }
  f.host.unblock(enrolled);
  f.host.failing.mockReturnValue(undefined);
  expect(await state()).toEqual({ ...base, status: "preparing" });
});

function deferredBody(method: string, url: string, headers: Record<string, string>) {
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      start();
    },
  });
  const request = new Request(url, {
    method,
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
  return {
    request,
    started,
    finish(body: Uint8Array) {
      controller.enqueue(body);
      controller.close();
    },
  };
}
it("rechecks ownership after an enrollment request body finishes", async () => {
  const f = await fixture();
  const pending = deferredBody("POST", f.request().url, {
    authorization: "Bearer account-token",
    "content-type": "application/json",
  });
  const result = f.handle(pending.request);
  await pending.started;
  await vi.waitFor(() => expect(f.resolveActor).toHaveBeenCalled());
  f.raw
    .prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?")
    .run(scope.workspaceId);
  pending.finish(new TextEncoder().encode(JSON.stringify({ shareId: scope.shareId })));
  expect((await result).status).toBe(404);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("service replication refuses foreign workspaces and account administration", async () => {
  const f = await fixture(),
    bearer = deriveServiceHostBearer(
      f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input }),
      { key, namespace },
    );
  const handler = serviceReplication(f.storage);
  for (const path of [
    "/sync/workspaces",
    "/sync/foreign/hosted/bootstrap",
    `/sync/${scope.workspaceId}/epoch`,
    `/sync/${scope.workspaceId}/live-host`,
    `/sync/${scope.workspaceId}/hosted/live-host`,
  ]) {
    expect(
      (
        await handler(
          new Request(`https://relay.test${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}` },
          }),
        )
      ).status,
    ).toBe(404);
  }
  const response = await handler(
    new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
});

it.each(["blob", "log"] as const)(
  "a service token revoked during the %s body cannot mutate storage",
  async (kind) => {
    const f = await fixture(),
      bearer = deriveServiceHostBearer(
        f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input }),
        { key, namespace },
      );
    const handler = serviceReplication(f.storage);
    const bytes = new TextEncoder().encode("unpublished"),
      digest = createHash("sha256").update(bytes).digest("hex");
    const pending = deferredBody(
      kind === "blob" ? "PUT" : "POST",
      `https://relay.test/sync/${scope.workspaceId}/hosted/${kind === "blob" ? `blobs/${digest}` : "log"}`,
      {
        authorization: `Bearer ${bearer}`,
        "content-type": kind === "blob" ? "application/octet-stream" : "application/json",
      },
    );
    const result = handler(pending.request);
    await pending.started;
    f.storage.setServiceHostEnrollmentEnabled({ ...f.input, enabled: false });
    f.release(binding.objectId);
    pending.finish(
      kind === "blob"
        ? bytes
        : new TextEncoder().encode(
            JSON.stringify({
              replicationEpoch: "epoch",
              streamIdentity: "stream",
              originId: "service-host:native",
              ops: [
                {
                  originSeq: 0,
                  opKind: "moment.append",
                  recordedAtMs: 10,
                  payload: { operation: "write" },
                },
              ],
            }),
          ),
    );
    expect((await result).status).toBe(404);
    expect(f.storage.getBlob(scope.workspaceId, digest)).toBeNull();
    expect(
      f.storage.fetchLogCoordinate({
        workspaceId: scope.workspaceId,
        originId: "service-host:native",
        originSeq: 0,
      }),
    ).toBeNull();
  },
);

it("retires an owner document, lists it separately, and resumes its retained identity without a supplied share", async () => {
  const f = await fixture(),
    first = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  const bearer = deriveServiceHostBearer(first, { key, namespace });
  const stop = await f.handle(
    f.request("DELETE", {
      path: first.path,
      retire: true,
      restoreFenceGeneration: binding.restoreFenceGeneration,
    }),
  );
  expect(await stop.json()).toEqual({
    ok: true,
    path: first.path,
    objectId: first.objectId,
    status: "retired",
    acceptedCursor: 0,
    changed: true,
  });
  expect(await (await f.handle(f.request())).json()).toEqual({
    ok: true,
    diverged: false,
    documents: [],
  });
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({
    ok: true,
    documents: [{ path: first.path, objectId: first.objectId, status: "retired", stopped: true }],
    nextCursor: null,
  });
  // Stopped but undrained: the host's credential still reads the empty scope, and its release ends it.
  const replication = serviceReplication(f.storage);
  const bootstrap = () =>
    replication(
      new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
  expect(await (await bootstrap()).json()).toMatchObject({ hasContent: false });
  f.release(first.objectId);
  expect((await bootstrap()).status).toBe(404);
  expect((await f.handle(f.request("POST", { path: first.path }))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]).toMatchObject({
    objectId: first.objectId,
    shareId: first.shareId,
    retired: false,
    enabled: true,
  });
  expect((await f.handle(f.request("POST", { path: "docs/missing.md" }))).status).toBe(404);
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&retired=1"))).status).toBe(
    404,
  );
});

// Proves: while the service host still holds an edit the relay has not
// admitted, Stop answers waiting and fences nothing: no retirement opens and
// the document stays live. Once the edit is delivered, Stop retires through it.
it("waits to stop a hosted document until its pending edit is delivered, then retires with it", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  retainServiceActivation(f.raw, namespace, true);
  const retirement = () => readServiceActivationRetirement(f.storage as StorageContext, enrolled);
  const stop = () =>
    f.handle(
      f.request("DELETE", {
        path: binding.currentPath,
        retire: true,
        restoreFenceGeneration: binding.restoreFenceGeneration,
      }),
    );
  f.host.pending.add(binding.objectId);
  const waiting = await stop();
  expect(waiting.status).toBe(409);
  expect(await waiting.json()).toEqual({
    ok: false,
    code: "edits-pending",
    error: "Live editing didn't stop. Recent edits haven't reached the server yet.",
  });
  expect(retirement()).toBeNull();
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject(
    { enabled: true, retired: false, ownerStop: null },
  );
  expect(f.storage.serviceHostDocumentEnabled(enrolled)).toBe(true);
  // The host delivers the edit while admission is open.
  const cursor = Number(
    f.raw
      .prepare(`INSERT INTO sync_relay_live_update_journal
    (delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,
    restore_fence_generation,principal_kind,principal_id,accepting_host_epoch,received_at_ms,update_bytes,
    relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,first_seen_deletes_json)
    VALUES ('pending-edit',?,?,'main',?,?,?,'["docs/a.md"]',7,'owner','owner-1',1,1,x'01',?,1,?,1,2,'[]') RETURNING journal_cursor`)
      .get(
        "c".repeat(64),
        scope.workspaceId,
        binding.objectId,
        binding.lineageClaimId,
        binding.currentPath,
        namespace,
        "d".repeat(64),
      )!.journal_cursor,
  );
  f.host.pending.delete(binding.objectId);
  const stopped = await stop();
  expect(await stopped.json()).toEqual({
    ok: true,
    path: binding.currentPath,
    objectId: binding.objectId,
    status: "retired",
    acceptedCursor: cursor,
    changed: true,
  });
  expect(retirement()).toMatchObject({ objectId: binding.objectId, acceptedThrough: cursor });
  expect(f.storage.serviceHostDocumentEnabled(enrolled)).toBe(false);
});

// Proves: a Stop whose reply was lost is done in the relay's durable state.
// Reading it reports the document retired, and a second Stop replays that
// retirement at its fence without preparing again.
it("reports a Stop whose reply was lost as done and replays it without preparing again", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  const activationId = retainServiceActivation(f.raw, namespace, true);
  const stop = () =>
    f.handle(
      f.request("DELETE", {
        path: binding.currentPath,
        retire: true,
        restoreFenceGeneration: binding.restoreFenceGeneration,
      }),
    );
  await stop();
  expect(f.host.prepared).toEqual([
    {
      activationId,
      lineageClaimId: binding.lineageClaimId,
      restoreFenceGeneration: binding.restoreFenceGeneration,
    },
  ]);
  expect((await (await f.handle(f.request("GET"))).json()).documents).toEqual([]);
  expect(
    (await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).documents,
  ).toEqual([
    { path: binding.currentPath, objectId: binding.objectId, status: "retired", stopped: true },
  ]);
  const fence = readServiceActivationRetirement(f.storage as StorageContext, enrolled)!;
  const replayed = await stop();
  expect(replayed.status).toBe(200);
  // The replay retired nothing, so it credits no one: the lost reply's credit stays lost.
  expect(await replayed.json()).toEqual({
    ok: true,
    path: binding.currentPath,
    objectId: binding.objectId,
    status: "retired",
    acceptedCursor: fence.acceptedThrough,
    changed: false,
  });
  expect(f.host.prepared).toHaveLength(1);
  expect(readServiceActivationRetirement(f.storage as StorageContext, enrolled)).toEqual(fence);
});

// Proves: with no running host to deliver its edits, Stop of a document with a
// retained activation waits and fences nothing.
it("waits to stop a retained activation that no running host can prepare", async () => {
  const f = await fixture(),
    enrolled = f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  f.host.running = false;
  retainServiceActivation(f.raw, namespace, true);
  const waiting = await f.handle(f.request("DELETE", { path: binding.currentPath, retire: true }));
  expect(waiting.status).toBe(409);
  expect(await waiting.json()).toEqual({
    ok: false,
    code: "host-not-loaded",
    sessionHost: "starting",
    error:
      "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.",
  });
  expect(readServiceActivationRetirement(f.storage as StorageContext, enrolled)).toBeNull();
  expect(f.storage.serviceHostDocumentEnabled(enrolled)).toBe(true);
});
