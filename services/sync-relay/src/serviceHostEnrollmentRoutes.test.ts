import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import type {ServerResponse} from "node:http";
import {pipeResponseBody} from "@dohc/service-http";
import {afterEach, expect, it, vi} from "vitest";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createServiceHostEnrollmentRoutes, discoverServiceHostDocuments, isServiceHostEnrollmentPath} from "./serviceHostEnrollmentRoutes";
import {createServiceHostReplication} from "./serviceHostReplication";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {relayError} from "./errors";
import {SERVICE_HOST_ENROLLMENTS} from "./storage/serviceHostEnrollment";
import type {ServiceActivationBlock} from "./serviceActivationDriver";
import {RecoveryCopyRefusal, type ServiceKeptEdits} from "./storage/serviceKeptEdits";
import type {JsonValue} from "@dohc/workspace-engine-client";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
// The workspace identity the fixture claims, whose hosted store holds the queues.
const identity = {replicationEpoch: "epoch", streamIdentity: "stream"};
const queue = (outboxId: string, of = identity) => ({workspaceId: scope.workspaceId, identity: of, outboxId});
// One page of a refused queue as the service host's engine answers it. The desktop assembles the pages.
const keptPage = (kept: ServiceKeptEdits, cursor: JsonValue | undefined): JsonValue => ({kind: "page", outboxId: kept.outboxId, after: cursor ?? null});
const key = new Uint8Array(32).fill(17), namespace = "service-route-test";
const serviceReplication = (storage: Parameters<typeof authorizeServiceHostReplication>[0]) => createServiceHostReplication({storage, prefix: "dohc-service-v1.",
  hostedFeed: true, authorize: input => authorizeServiceHostReplication(storage, {key, namespace, ...input})});
async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  // The documents the session host blocked until their owner tries again.
  const blocked = new Map<string, ServiceActivationBlock>();
  const host = {ready: vi.fn(() => false), reconcile: vi.fn(), unavailable: false,
    blocked: vi.fn((document: {objectId: string}) => blocked.get(document.objectId)),
    unblock: vi.fn((document: {objectId: string}) => blocked.delete(document.objectId)),
    diverged: vi.fn((_row: {workspaceId: string; replicationEpoch: string; streamIdentity: string}) => false),
    keptEdits: {page: vi.fn(async (kept: ServiceKeptEdits, cursor: JsonValue | undefined) => keptPage(kept, cursor)),
      // The host grants in the document's turn after rechecking its caller and the refusal.
      retry: vi.fn(async (kept: ServiceKeptEdits, guard: () => void): Promise<"granted" | "changed" | "unavailable"> => {
        guard();
        return f.storage.markServiceKeptEditsRetrying(kept) ? "granted" : "changed";
      }),
      copied: vi.fn(async (_kept: ServiceKeptEdits) => {})},
    block(objectId: string, why: ServiceActivationBlock = "refused") {blocked.set(objectId, why);}};
  let actor = {workspaceId: scope.workspaceId, userId: "owner-1"};
  const resolveActor = vi.fn(async () => actor);
  const handle = createServiceHostEnrollmentRoutes({storage: f.storage, history, host, resolveActor});
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  const request = (method = "GET", body?: unknown, headers: Record<string,string> = {}, suffix = "") => new Request(`https://relay.test/sync/${scope.workspaceId}/live-host${suffix}`,
    {method, headers: {authorization: "Bearer account-token", ...(body === undefined ? {} : {"content-type": "application/json"}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const seed = (path: string, objectId: string, contentKind = "text") => {
    f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,?,1)").run(scope.workspaceId, path, "b".repeat(64), contentKind);
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,?,1,1)`).run(scope.workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64), contentKind);
  };
  // What the service host does once it no longer holds the document.
  const release = (objectId: string) => f.storage.releaseServiceHostEnrollment({workspaceId: scope.workspaceId, objectId, nowMs: 20});
  return {...f, history, host, resolveActor, handle, input, request, seed, release, setActor(value: typeof actor) {actor = value;}};
}

it("requires bearer owner authority, rejects ambient credentials and rejects unknown parameters", async () => {
  const f = await fixture();
  for (const headers of [{authorization: ""}, {cookie: "session=browser"}, {authorization: "Basic x"}] as Record<string,string>[]) {
    expect((await f.handle(f.request("GET", undefined, headers))).status).toBe(404);
  }
  expect(f.resolveActor).not.toHaveBeenCalled();
  f.setActor({workspaceId: scope.workspaceId, userId: "other"});
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({workspaceId: "other", userId: "owner-1"});
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?unknown=1"))).status).toBe(404);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, path: binding.currentPath, root: "/etc"}))).status).toBe(400);
  expect((await f.handle(f.request("DELETE", {path: binding.currentPath, workspaceId: scope.workspaceId}))).status).toBe(400);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}, {"content-type": "text/plain"}))).status).toBe(400);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("lets only the workspace's owner see, read, try again and confirm a copy of edits the server kept, admitting and publishing none of them", async () => {
  const f = await fixture();
  let refusals = 0;
  const refuse = () => {
    f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: `refusal-${++refusals}`, nowMs: 5});
    return f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation;
  };
  const first = refuse();
  const kept = {objectId: binding.objectId, path: binding.currentPath, outboxId: "outbox-1", reason: "invalid-update", store: expect.stringMatching(/^[0-9a-f]{32}$/)};
  const list = async () => ((await (await f.handle(f.request())).json()) as {keptEdits?: unknown}).keptEdits;
  // A copy names the checkpoint it read: none here, as for a queue with no accepted state.
  const act = (action: string, generation: number, outboxId = "outbox-1", extra: Record<string, unknown> = {}) =>
    f.handle(f.request("POST", {action, outboxId, generation, ...(action === "copied" ? {checkpointDigest: null} : {}), ...extra}, {}, "/kept-edits"));
  expect(await list()).toEqual([{...kept, generation: first, recovery: "paused"}]);
  // A recipient of the owner's shares, and the owner of another workspace, learn and reach nothing.
  for (const actor of [{workspaceId: scope.workspaceId, userId: "recipient"}, {workspaceId: "other-workspace", userId: "owner-1"}]) {
    f.setActor(actor);
    expect((await f.handle(f.request())).status).toBe(404);
    for (const action of ["page", "retry", "copied"]) expect((await act(action, first)).status).toBe(404);
  }
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect(f.host.keptEdits.page).not.toHaveBeenCalled();
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  expect(f.storage.readServiceKeptEdits(queue("outbox-1"))).toMatchObject({retrying: false, copied: false});
  // An unknown queue, as one another computer's Try again delivered, and a refusal the owner did not see both changed.
  for (const response of [...await Promise.all(["page", "retry", "copied"].map(action => act(action, first, "outbox-unknown"))), await act("page", first + 1)]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ok: false, code: "kept-edits-changed"});
  }
  expect((await f.handle(f.request("POST", {action: "page", outboxId: "outbox-1"}, {}, "/kept-edits"))).status).toBe(400);
  for (const cursor of ["x", [], {snapshot: "s"}, null]) expect((await act("page", first, "outbox-1", {cursor})).status).toBe(400);
  expect((await act("retry", first, "outbox-1", {cursor: {snapshot: "s", part: "base", sequence: 0, offset: 0}})).status).toBe(400);
  // Each page is the engine's, after the cursor the owner sent, and the relay accepts and publishes none of it.
  const count = (table: string) => Number(f.raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  const before = [count("sync_relay_live_update_journal"), count("sync_relay_log")];
  const cursor = {snapshot: "s", part: "update", sequence: 2, offset: 0};
  expect(await (await act("page", first)).json()).toEqual({ok: true, page: {kind: "page", outboxId: "outbox-1", after: null}});
  expect(await (await act("page", first, "outbox-1", {cursor})).json()).toEqual({ok: true, page: {kind: "page", outboxId: "outbox-1", after: cursor}});
  expect([count("sync_relay_live_update_journal"), count("sync_relay_log")]).toEqual(before);
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  // Try again, once per refusal.
  expect(await (await act("retry", first)).json()).toEqual({ok: true});
  expect(await list()).toEqual([{...kept, generation: first, recovery: "retrying"}]);
  expect((await act("retry", first)).status).toBe(409);
  expect(f.host.keptEdits.retry).toHaveBeenCalledTimes(1);
  // That Try again delivers, so the queue is forgotten; new edits are then refused again.
  // The copy read at the first refusal does not cover the second.
  f.storage.forgetServiceKeptEdits(queue("outbox-1"));
  const second = refuse();
  const held = () => f.storage.serviceKeptEditsHeld({workspaceId: scope.workspaceId, objectId: binding.objectId}, identity);
  expect((await act("copied", first)).status).toBe(409);
  expect(held()).toBe(true);
  // A confirmation names the checkpoint its copy read, and only that.
  for (const shape of [{action: "copied", outboxId: "outbox-1", generation: second}, {action: "copied", outboxId: "outbox-1", generation: second, checkpointDigest: "x"},
    {action: "retry", outboxId: "outbox-1", generation: second, checkpointDigest: null}]) {
    expect((await f.handle(f.request("POST", shape, {}, "/kept-edits"))).status).toBe(400);
  }
  expect(held()).toBe(true);
  // While the queue stays frozen at its seed, a copy of an older checkpoint holds the document, and one of the current checkpoint lets it go.
  f.storage.observeServiceKeptEditsCheckpoint(queue("outbox-1"), "b".repeat(64));
  expect(await (await act("copied", second, "outbox-1", {checkpointDigest: "a".repeat(64)})).json()).toEqual({ok: true});
  expect(await list()).toEqual([{...kept, generation: second, recovery: "paused"}]);
  expect(held()).toBe(true);
  expect(await (await act("copied", second, "outbox-1", {checkpointDigest: "b".repeat(64)})).json()).toEqual({ok: true});
  expect(await list()).toEqual([{...kept, generation: second, recovery: "copied"}]);
  expect(held()).toBe(false);
  // Without live authority here, or once the refusal changed, Try again grants nothing.
  f.host.keptEdits.retry.mockResolvedValueOnce("unavailable");
  expect((await act("retry", second)).status).toBe(409);
  f.host.keptEdits.retry.mockResolvedValueOnce("changed");
  expect((await act("retry", second)).status).toBe(409);
  expect(await list()).toEqual([{...kept, generation: second, recovery: "copied"}]);
  // A refusal recorded while a page was read answers changed.
  const third = refuse();
  f.host.keptEdits.page.mockImplementationOnce(async (row, after) => {refuse(); return keptPage(row, after);});
  const raced = await act("page", third);
  expect(raced.status).toBe(409);
  expect(await raced.json()).toMatchObject({code: "kept-edits-changed"});
  // A queue that delivers again is forgotten.
  f.storage.forgetServiceKeptEdits(queue("outbox-1"));
  expect(await list()).toBeUndefined();
});

// Proves: a row of an earlier workspace identity's store lists as earlier,
// before and after its copy. Its owner reads its pages from that store and
// confirms a copy of it, which marks only that row and lets the host release
// the store; Try again is refused without reaching the host, copied or not.
// The current store's queue with the same outbox
// ID lists as its own row, and each action reaches the row its generation
// names. A recipient or another workspace's owner reaches neither.
it("reads and confirms edits kept in an earlier identity's store, and refuses their Try again", async () => {
  const f = await fixture(), old = {replicationEpoch: "old-epoch", streamIdentity: "old-stream"};
  for (const [of, refusalKey] of [[old, "refusal-1"], [identity, "refusal-1"]] as const) {
    f.storage.recordServiceKeptEdits({identity: of, outboxId: "outbox-x", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey, nowMs: 5});
  }
  const [earlier, current] = [old, identity].map(of => f.storage.readServiceKeptEdits(queue("outbox-x", of))!.generation) as [number, number];
  const row = {objectId: binding.objectId, path: binding.currentPath, outboxId: "outbox-x", reason: "invalid-update", store: expect.any(String)};
  const list = async () => ((await (await f.handle(f.request())).json()) as {keptEdits: Array<{store: string}>}).keptEdits;
  const listed = await list();
  expect(listed).toEqual([{...row, generation: earlier, recovery: "paused", earlier: true}, {...row, generation: current, recovery: "paused"}]);
  // The owner tells the two stores apart without learning either identity.
  expect(listed[0]!.store).not.toBe(listed[1]!.store);
  for (const secret of ["old-epoch", "old-stream", "epoch", "stream"]) expect(JSON.stringify(listed)).not.toContain(secret);
  const act = (action: string, generation: number) => f.handle(f.request("POST", {action, outboxId: "outbox-x", generation,
    ...(action === "copied" ? {checkpointDigest: null} : {})}, {}, "/kept-edits"));
  for (const actor of [{workspaceId: scope.workspaceId, userId: "recipient"}, {workspaceId: "other-workspace", userId: "owner-1"}]) {
    f.setActor(actor);
    for (const action of ["page", "copied"]) expect((await act(action, earlier)).status).toBe(404);
  }
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect(f.host.keptEdits.page).not.toHaveBeenCalled();
  const refused = await act("retry", earlier);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ok: false, code: "kept-edits-earlier"});
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  expect(await (await act("page", earlier)).json()).toEqual({ok: true, page: {kind: "page", outboxId: "outbox-x", after: null}});
  expect(await (await act("copied", earlier)).json()).toEqual({ok: true});
  expect(f.host.keptEdits.page.mock.calls.map(([kept]) => [kept.generation, kept.identity])).toEqual([[earlier, old]]);
  expect(f.host.keptEdits.copied.mock.calls.map(([kept]) => [kept.generation, kept.identity])).toEqual([[earlier, old]]);
  // An earlier store the server could not prepare answers with the reason.
  f.host.keptEdits.page.mockRejectedValueOnce(new RecoveryCopyRefusal("disk-space"));
  const unprepared = await act("page", earlier);
  expect(unprepared.status).toBe(409);
  expect(await unprepared.json()).toMatchObject({ok: false, code: "kept-edits-unrecoverable", reason: "disk-space"});
  expect(f.storage.readServiceKeptEdits(queue("outbox-x", identity))).toMatchObject({generation: current, copied: false});
  expect(await list()).toEqual([{...row, generation: earlier, recovery: "copied", earlier: true}, {...row, generation: current, recovery: "paused"}]);
  const copiedRetry = await act("retry", earlier);
  expect(copiedRetry.status).toBe(409);
  expect(await copiedRetry.json()).toMatchObject({ok: false, code: "kept-edits-earlier"});
  expect(f.host.keptEdits.retry).not.toHaveBeenCalled();
  // A host that could not release the store keeps the confirmation.
  f.host.keptEdits.copied.mockRejectedValueOnce(new Error("engine gone"));
  expect(await (await act("copied", current)).json()).toEqual({ok: true});
  expect(f.storage.readServiceKeptEdits(queue("outbox-x", identity))).toMatchObject({copied: true});
});

// Proves: the relay's dispatch sends both enrollment paths, and nothing else,
// to these routes, and gives them the routes' body limit.
it("routes the live host and its kept edits actions to the enrollment routes", async () => {
  const f = await fixture();
  const generation = (f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1",
    refusalKey: "refusal-1", nowMs: 5}), f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation);
  const requests = [f.request(), f.request("POST", {action: "copied", outboxId: "outbox-1", generation, checkpointDigest: null}, {}, "/kept-edits")];
  for (const request of requests) {
    expect(isServiceHostEnrollmentPath(new URL(request.url).pathname)).toBe(true);
    expect((await f.handle(request)).status).toBe(200);
  }
  for (const path of [`/sync/${scope.workspaceId}/live-host/other`, `/sync/${scope.workspaceId}/live-host/kept-edits/x`, `/sync/${scope.workspaceId}/live-hosts`, "/sync/live-host"]) {
    expect(isServiceHostEnrollmentPath(path)).toBe(false);
  }
});

// Proves: the relay reads at most two pages at once, and each holds its turn
// until its body is taken or cancelled, not only while it is built. Others
// wait, and one whose caller gave up leaves the line without taking a turn.
it("runs at most two recovery page reads at once across the relay, until each body is taken", async () => {
  const f = await fixture();
  for (const index of [1, 2, 3, 4, 5]) {
    f.storage.recordServiceKeptEdits({identity, outboxId: `outbox-${index}`, binding: {...binding, objectId: `other-object-${index}`}, reason: "invalid-update",
      headDeliveryId: "delivery-1", refusalKey: `refusal-${index}`, nowMs: 5});
  }
  const releases: Array<() => void> = [];
  f.host.keptEdits.page.mockImplementation(async (kept: ServiceKeptEdits, cursor: JsonValue | undefined) => {
    await new Promise<void>(resolve => releases.push(resolve)); return keptPage(kept, cursor);
  });
  const read = (index: number, signal?: AbortSignal) => f.handle(new Request(f.request("POST", {action: "page", outboxId: `outbox-${index}`,
    generation: f.storage.readServiceKeptEdits(queue(`outbox-${index}`))!.generation}, {}, "/kept-edits"), signal ? {signal} : {}));
  const abort = new AbortController();
  const answers = [read(1), read(2), read(3, abort.signal), read(4), read(5)];
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(2));
  abort.abort(new Error("Caller gave up."));
  // Both pages are built, but no client took their bodies, so no other read starts.
  releases.shift()!(); releases.shift()!();
  const [one, two] = await Promise.all([answers[0]!, answers[1]!]);
  expect(f.host.keptEdits.page).toHaveBeenCalledTimes(2);
  expect(await one.json()).toMatchObject({ok: true, page: {outboxId: "outbox-1"}});
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(3));
  await two.body!.cancel();
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(4));
  expect(f.host.keptEdits.page.mock.calls.map(([kept]) => kept.outboxId)).toEqual(["outbox-1", "outbox-2", "outbox-4", "outbox-5"]);
  while (releases.length) releases.shift()!();
  expect(await Promise.all(answers.slice(2).map(answer => answer.then(response => response.status, () => "aborted")))).toEqual([expect.anything(), 200, 200]);
});

// A socket whose every write fills its buffer, as a slow client's does, until it drains or closes.
class SlowSocket extends EventEmitter {
  destroyed = false; writableFinished = false; writes = 0;
  write() {this.writes++; return false;}
  end() {this.writableFinished = true;}
  destroy() {this.destroyed = true; queueMicrotask(() => this.emit("close")); return this;}
}

// Proves: through the relay's own body writer, a page keeps its read slot
// while the socket has not drained it, gives it up once the socket drains,
// and gives it up when the client goes away before that.
it("holds a recovery page's read slot until a slow client's socket drains it or closes", async () => {
  const f = await fixture();
  for (const index of [1, 2, 3, 4]) {
    f.storage.recordServiceKeptEdits({identity, outboxId: `outbox-${index}`, binding: {...binding, objectId: `other-object-${index}`}, reason: "invalid-update",
      headDeliveryId: "delivery-1", refusalKey: `refusal-${index}`, nowMs: 5});
  }
  const read = (index: number) => f.handle(f.request("POST", {action: "page", outboxId: `outbox-${index}`,
    generation: f.storage.readServiceKeptEdits(queue(`outbox-${index}`))!.generation}, {}, "/kept-edits"));
  const [one, two] = await Promise.all([read(1), read(2)]);
  const waiting = [read(3), read(4)];
  const slow = new SlowSocket(), piped = pipeResponseBody(one.body!, slow as unknown as ServerResponse);
  await vi.waitFor(() => expect(slow.writes).toBe(1));
  // The whole page is in the socket's buffer, not yet sent, so its slot stays taken.
  await new Promise(resolve => setImmediate(resolve));
  expect(f.host.keptEdits.page).toHaveBeenCalledTimes(2);
  slow.emit("drain");
  await piped;
  expect(slow.writableFinished).toBe(true);
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(3));
  // A client that goes away before its socket drains gives up its slot too.
  const gone = new SlowSocket(), abandoned = pipeResponseBody(two.body!, gone as unknown as ServerResponse);
  await vi.waitFor(() => expect(gone.writes).toBe(1));
  gone.emit("close");
  await abandoned;
  await vi.waitFor(() => expect(f.host.keptEdits.page).toHaveBeenCalledTimes(4));
  expect((await Promise.all(waiting)).map(response => response.status)).toEqual([200, 200]);
});

// Proves: more kept queues than one page never break the live host's answer; the rest follow its cursor.
it("pages the edits the server kept instead of refusing a long list", async () => {
  const f = await fixture();
  for (let index = 0; index <= 256; index++) {
    f.storage.recordServiceKeptEdits({identity, outboxId: `outbox-${index}`, binding: {...binding, objectId: `other-object-${index}`}, reason: "invalid-update",
      headDeliveryId: "delivery-1", refusalKey: `refusal-${index}`, nowMs: 5});
  }
  const response = await f.handle(f.request());
  expect(response.status).toBe(200);
  const first = (await response.json()) as {keptEdits: Array<{outboxId: string}>; keptEditsCursor: number};
  expect(first.keptEdits).toHaveLength(256);
  const rest = (await (await f.handle(f.request("GET", undefined, {}, `?kept=1&after=${first.keptEditsCursor}`))).json()) as {keptEdits: Array<{outboxId: string}>; nextCursor: number | null};
  expect(rest).toMatchObject({ok: true, nextCursor: null});
  expect(new Set([...first.keptEdits, ...rest.keptEdits].map(row => row.outboxId)).size).toBe(257);
  for (const query of ["?kept=1", "?kept=1&after=0", "?kept=1&after=x", "?kept=1&after=1&refusals=1"]) {
    expect((await f.handle(f.request("GET", undefined, {}, query))).status).not.toBe(200);
  }
});

it("discovers rich documents in folders, skips other content, and preserves a paused enrollment", async () => {
  const f = await fixture(); f.seed("docs/b.md", "object-b"); f.seed("docs/data.csv", "object-c"); f.seed("docs/image.md", "object-d", "binary");
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual(["docs/a.md", "docs/b.md"]);
  expect(await (await f.handle(f.request("DELETE", {path: binding.currentPath}))).json()).toEqual({ok: true, path: binding.currentPath, objectId: binding.objectId, status: "paused"});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  f.release(binding.objectId);
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments().every(row => row.enabled && !row.ownerStop)).toBe(true);
  await f.handle(f.request("DELETE", {path: binding.currentPath}));
  await f.handle(f.request("DELETE", {path: "docs/b.md", retire: true, restoreFenceGeneration: 0}));
  f.release("object-b");
  f.seed("docs/retry.md", "retry-object");
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toMatchObject({retired: true, enabled: false});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/retry.md")).toMatchObject({enabled: true});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true, path: binding.currentPath}))).status).toBe(400);
});

it("reports ready only with completed retained activation and the current native runtime", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const state = async () => {
    const response = await f.handle(f.request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    for (const secret of [deriveServiceHostBearer(enrolled, {key, namespace}), "account-token", "owner-1", "replicationEpoch", "streamIdentity"]) expect(text).not.toContain(secret);
    return JSON.parse(text).documents[0];
  };
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, objectId: binding.objectId, status: "preparing"});
  const source = {version: 1, relayDatabaseNamespace: namespace, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: binding.objectId,
    lineageClaimId: binding.lineageClaimId, currentPath: binding.currentPath, replicationEpoch: "epoch", streamIdentity: "stream", committedCursor: 1,
    baseOriginId: "origin", baseOriginSeq: 0, baseRelaySeq: 1, sourceMomentId: "moment-1", sourceDigest: "b".repeat(64), sourceByteLength: 1,
    nativeHeadSequence: 0, fullStateDigest: binding.lineageClaimId, fullStateByteLength: 2};
  // Stored metadata exercises route readiness; native activation is covered by the engine integration suite.
  f.raw.prepare(`INSERT INTO sync_relay_service_activations VALUES (?,?,?,?,?,?,?, ?,?,x'0000','owner-1',?,NULL,1)`)
    .run(namespace, `ordinary-activation-${"a".repeat(64)}`, scope.workspaceId, "main", binding.objectId, binding.lineageClaimId,
      JSON.stringify(source), JSON.stringify(binding), binding.lineageClaimId, scope.shareId);
  expect((await state()).status).toBe("preparing");
  f.raw.exec("UPDATE sync_relay_service_activations SET completion_json='{}'");
  f.host.ready.mockReturnValue(false);
  expect((await state()).status).toBe("preparing");
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, objectId: binding.objectId, status: "ready", document: {binding, relayDatabaseNamespace: namespace, shareId: scope.shareId}});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  expect((await state()).status).toBe("paused");
});

// Proves: a document the session host blocked reads as refused until its
// owner's Resume, which gives it exactly one more attempt. Enrolling its share
// again is not a Resume, and a reading never clears the block.
it("reports a document the session host refused until the owner resumes it", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  const refused = {path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "session-host-refused"};
  f.host.ready.mockReturnValue(true);
  f.host.block(enrolled.objectId);
  expect(await documents()).toEqual([refused]);
  expect(await documents()).toEqual([refused]);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}))).status).toBe(202);
  expect(await documents()).toEqual([refused]);
  expect(f.host.unblock).not.toHaveBeenCalled();
  const resumed = await f.handle(f.request("POST", {path: binding.currentPath}));
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toEqual({ok: true, path: binding.currentPath, objectId: binding.objectId, status: "preparing"});
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  expect(f.host.unblock).toHaveBeenCalledWith(expect.objectContaining({workspaceId: scope.workspaceId, objectId: enrolled.objectId}));
  expect(f.host.unblock.mock.invocationCallOrder[0]).toBeLessThan(f.host.reconcile.mock.invocationCallOrder.at(-1)!);
  expect(await documents()).toEqual([{path: binding.currentPath, objectId: binding.objectId, status: "preparing"}]);
  // Its one attempt failed, so the host blocked it again.
  f.host.block(enrolled.objectId);
  expect(await documents()).toEqual([refused]);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
});

// Proves: a document blocked for having no live-editing history reads as its
// own reason, so its owner learns to open it before Resume, which still unblocks it.
it("reports a document without live-editing history apart from other refusals", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  f.host.block(enrolled.objectId, "without-lineage");
  expect(await documents()).toEqual([{path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "live-document-without-lineage"}]);
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(202);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  expect(await documents()).toEqual([{path: binding.currentPath, objectId: binding.objectId, status: "preparing"}]);
  f.host.block(enrolled.objectId, "refused");
  expect(await documents()).toEqual([{path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "session-host-refused"}]);
});

// Proves: a document whose host copy misses an edit made while live editing
// was off reads as its own reason. A Resume still asks for one more attempt,
// which blocks it again with the same reason.
it("reports a document edited while live editing was off apart from other refusals", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  const unadmitted = {path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "live-edit-unadmitted"};
  f.host.block(enrolled.objectId, "live-edit-unadmitted");
  expect(await documents()).toEqual([unadmitted]);
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(202);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  f.host.block(enrolled.objectId, "live-edit-unadmitted");
  expect(await documents()).toEqual([unadmitted]);
});

// Proves: a document whose hosted replica diverged reads as its own reason
// ahead of a block, a Resume cannot change that, and the owner learns nothing
// of the store. A workspace that changed identity still reads as changed.
it("reports a document whose hosted replica diverged, and nothing about its store", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const diverged = {path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "session-host-diverged"};
  f.host.ready.mockReturnValue(true);
  f.host.block(enrolled.objectId);
  f.host.diverged.mockImplementation(row => row.workspaceId === scope.workspaceId && row.replicationEpoch === "epoch" && row.streamIdentity === "stream");
  const response = await f.handle(f.request());
  expect(await response.json()).toEqual({ok: true, diverged: true, documents: [diverged]});
  const resumed = await f.handle(f.request("POST", {path: binding.currentPath}));
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toEqual({ok: true, ...diverged});
  f.raw.prepare("UPDATE sync_relay_workspaces SET replication_epoch='rotated' WHERE workspace_id=?").run(scope.workspaceId);
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: false, documents: [{path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason: "workspace-changed"}]});
});

// Proves: an owner's Pause or Stop records their intent but cannot hide a
// diverged server copy. The paused and the retired document both keep the
// reason, and the workspace still reads as diverged once no document is active.
it("keeps a diverged document's reason after its owner pauses or stops it", async () => {
  const f = await fixture(); f.seed("docs/b.md", "object-b");
  f.storage.enrollServiceHostDocument(f.input); f.storage.enrollServiceHostDocument({...f.input, path: "docs/b.md"});
  f.host.diverged.mockImplementation(row => row.workspaceId === scope.workspaceId && row.replicationEpoch === "epoch" && row.streamIdentity === "stream");
  const reason = "session-host-diverged";
  expect(await (await f.handle(f.request("DELETE", {path: binding.currentPath}))).json()).toEqual({ok: true, path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({ownerStop: "pause"});
  const stopped = await f.handle(f.request("DELETE", {path: "docs/b.md", retire: true, restoreFenceGeneration: 0}));
  expect(await stopped.json()).toMatchObject({ok: true, path: "docs/b.md", status: "retired"});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toMatchObject({ownerStop: "retire", retired: true});
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: true, documents: [{path: binding.currentPath, objectId: binding.objectId, status: "unavailable", reason}]});
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({ok: true, documents: [{path: "docs/b.md", objectId: "object-b", status: "retired", reason}], nextCursor: null});
  expect((await f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration}))).status).toBe(200);
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: true, documents: []});
  expect((await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).documents).toEqual([
    {path: binding.currentPath, objectId: binding.objectId, status: "retired", reason}, {path: "docs/b.md", objectId: "object-b", status: "retired", reason}]);
});

it("lists automatic enrollment refusals without enrolling documents or exposing other workspaces", async () => {
  const f = await fixture();
  const response = await f.handle(f.request("GET", undefined, {}, "?refusals=1"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  f.raw.exec("DELETE FROM sync_relay_object_moments");
  const before = f.raw.prepare("SELECT total_changes() AS changes").get();
  const refused = await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(refused).toMatchObject({ok: true, refusals: [{shareId: scope.shareId, paths: ["docs"], code: "conflict"}], nextCursor: null});
  expect(f.raw.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  expect(f.host.reconcile).not.toHaveBeenCalled();
  f.setActor({workspaceId: scope.workspaceId, userId: "recipient"});
  expect((await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).status).toBe(404);
  f.setActor({workspaceId: "other", userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).status).toBe(404);
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&refusals=1"))).status).toBe(404);
});

it("clears derived capacity refusals when an owner frees space and retries enrollment", async () => {
  const f = await fixture();
  f.storage.enrollServiceHostDocument(f.input);
  for (let index = 1; index < 64; index++) {
    const path = `docs/capacity-${index}.md`; f.seed(path, `capacity-${index}`);
    f.storage.enrollServiceHostDocument({...f.input, path});
  }
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?").run(JSON.stringify({paths: [binding.currentPath], versionId: null}), scope.shareId);
  f.seed("pending/a.md", "pending-object");
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('pending-share',?,'owner-1',?,1)").run(scope.workspaceId, JSON.stringify({paths: ["pending"], versionId: null}));
  f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT 'pending-grant','pending-share',principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(scope.grantId);
  const read = async () => (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(await read()).toMatchObject({refusals: [{shareId: "pending-share", code: "quota_exceeded"}], nextCursor: null});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(await read()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: "pending-share"}))).status).toBe(202);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "pending/a.md")).toMatchObject({enabled: true});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({retired: true, enabled: false});
});

it("advances refusal pages past healthy shares to an oversized share", async () => {
  const f = await fixture();
  f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  for (let index = 0; index < 65; index++) {
    const shareId = `page-${String(index).padStart(3, "0")}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT ?,workspace_id,granter_user_id,selector_json,created_at_ms FROM sync_relay_shares WHERE share_id=?").run(shareId, scope.shareId);
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(`page-grant-${index}`, shareId, scope.grantId);
  }
  const first = await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(first.refusals).toEqual([]); expect(first.nextCursor).toBe("page-063");
  for (let index = 0; index < 65; index++) f.seed(`large/${index}.md`, `large-${index}`);
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='page-064'").run(JSON.stringify({paths: ["large"], versionId: null}));
  const second = await (await f.handle(f.request("GET", undefined, {}, `?refusals=1&after=${first.nextCursor}`))).json();
  expect(second).toMatchObject({refusals: [{shareId: "page-064", paths: ["large"], code: "bad_request"}], nextCursor: null});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({retired: true, enabled: false});
});

it("counts only missing documents when a share contains more than 64 stopped documents", async () => {
  const f = await fixture();
  // Stop and release have their own lifecycle tests, so one transaction seeds the stopped documents.
  f.raw.exec("BEGIN");
  for (let index = 0; index < 65; index++) {
    const path = `docs/stopped-${index}.md`; f.seed(path, `stopped-${index}`);
    f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      VALUES (?,?,?,'owner-1',?,'epoch','stream','retire',0,1,10,20,1)`).run(scope.workspaceId, `stopped-${index}`, path, scope.shareId);
  }
  f.raw.exec("COMMIT");
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
  expect(f.storage.listServiceHostEnrollments()[0]!.path).toBe(binding.currentPath);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped-0.md")).toMatchObject({retired: true, enabled: false});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(200);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("keeps full Unicode refusal selectors within the client byte budget and resumes at the unreturned share", async () => {
  const f = await fixture();
  const paths = Array.from({length: 100}, (_, index) => `${String(index).padStart(3, "0")}/${"界".repeat(1016)}`);
  for (let index = 0; index < 5; index++) {
    const shareId = `large-selector-${index}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,1)").run(shareId, scope.workspaceId, JSON.stringify({paths, versionId: null}));
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(`large-grant-${index}`, shareId, scope.grantId);
  }
  vi.spyOn(f.storage, "checkServiceHostDocuments").mockImplementation(input => {
    if (input.shareId.startsWith("large-selector-")) throw relayError("quota_exceeded", "No room for live documents.");
  });
  const firstResponse = await f.handle(f.request("GET", undefined, {}, "?refusals=1"));
  const text = await firstResponse.text(); expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
  const first = JSON.parse(text);
  expect(first.refusals).toHaveLength(3); expect(first.refusals[0].paths).toEqual(paths);
  expect(first.nextCursor).toBe("large-selector-2");
  const second = await (await f.handle(f.request("GET", undefined, {}, `?refusals=1&after=${first.nextCursor}`))).json();
  expect(second.refusals.map((row: {shareId: string}) => row.shareId)).toEqual(["large-selector-3", "large-selector-4"]);
  expect(second.nextCursor).toBeNull();
});

it("rolls back every folder enrollment when a later current file lacks a live document", async () => {
  const f = await fixture();
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','docs/z.md',?,'text',1)").run(scope.workspaceId, "b".repeat(64));
  const response = await f.handle(f.request("POST", {shareId: scope.shareId}));
  expect(response.status).toBe(409);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.host.reconcile).not.toHaveBeenCalled();
});

it("continues discovery past an unsupported document without re-enabling paused documents", async () => {
  const f = await fixture();
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','docs/0.md',?,'text',1)").run(scope.workspaceId, "b".repeat(64));
  const refused = vi.fn();
  discoverServiceHostDocuments(f.storage, refused);
  expect(refused).toHaveBeenCalledOnce();
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual([binding.currentPath]);
});

function deferredBody(method: string, url: string, headers: Record<string,string>) {
  let start!: () => void;
  const started = new Promise<void>(resolve => {start = resolve;});
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({start(value) {controller = value;}, pull() {start();}});
  const request = new Request(url, {method, headers, body: stream, duplex: "half"} as RequestInit);
  return {request, started, finish(body: Uint8Array) {controller.enqueue(body); controller.close();}};
}

it("rechecks ownership after an enrollment request body finishes", async () => {
  const f = await fixture();
  const pending = deferredBody("POST", f.request().url, {authorization: "Bearer account-token", "content-type": "application/json"});
  const result = f.handle(pending.request); await pending.started;
  await vi.waitFor(() => expect(f.resolveActor).toHaveBeenCalled());
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  pending.finish(new TextEncoder().encode(JSON.stringify({shareId: scope.shareId, path: binding.currentPath})));
  expect((await result).status).toBe(404); expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("service replication refuses foreign workspaces and account administration", async () => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.storage.enrollServiceHostDocument(f.input), {key, namespace});
  const handler = serviceReplication(f.storage);
  for (const path of ["/sync/workspaces", "/sync/foreign/hosted/bootstrap", `/sync/${scope.workspaceId}/epoch`, `/sync/${scope.workspaceId}/live-host`,
    `/sync/${scope.workspaceId}/hosted/live-host`]) {
    expect((await handler(new Request(`https://relay.test${path}`, {method: "POST", headers: {authorization: `Bearer ${bearer}`}}))).status).toBe(404);
  }
  const response = await handler(new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({replicationEpoch: "epoch", streamIdentity: "stream"});
});

it.each(["blob", "log"] as const)("a service token revoked during the %s body cannot mutate storage", async kind => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.storage.enrollServiceHostDocument(f.input), {key, namespace});
  const handler = serviceReplication(f.storage);
  const bytes = new TextEncoder().encode("unpublished"), digest = createHash("sha256").update(bytes).digest("hex");
  const pending = deferredBody(kind === "blob" ? "PUT" : "POST", `https://relay.test/sync/${scope.workspaceId}/hosted/${kind === "blob" ? `blobs/${digest}` : "log"}`,
    {authorization: `Bearer ${bearer}`, "content-type": kind === "blob" ? "application/octet-stream" : "application/json"});
  const result = handler(pending.request); await pending.started;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  f.release(binding.objectId);
  pending.finish(kind === "blob" ? bytes : new TextEncoder().encode(JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: "service-host:native", ops: [
    {originSeq: 0, opKind: "moment.append", recordedAtMs: 10, payload: {operation: "write"}}]})));
  expect((await result).status).toBe(404);
  expect(f.storage.getBlob(scope.workspaceId, digest)).toBeNull();
  expect(f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "service-host:native", originSeq: 0})).toBeNull();
});

it("reports a renamed enrolled document as unavailable and retains its original enrollment", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/renamed.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  f.host.ready.mockReturnValue(true);
  const response = await f.handle(f.request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok: true, documents: [{path: binding.currentPath, status: "unavailable"}]});
  expect(f.storage.listServiceHostEnrollments()).toEqual([enrolled]);
});

it("retires an owner document, lists it separately, and resumes its retained identity without a supplied share", async () => {
  const f = await fixture(), first = f.storage.enrollServiceHostDocument(f.input);
  const bearer = deriveServiceHostBearer(first, {key, namespace});
  const stop = await f.handle(f.request("DELETE", {path: first.path, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration}));
  expect(await stop.json()).toEqual({ok: true, path: first.path, objectId:first.objectId, status: "retired", acceptedCursor: 0});
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: false, documents: []});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({ok: true, documents: [{path: first.path, objectId: first.objectId, status: "retired"}], nextCursor: null});
  // Stopped but undrained: the host's credential still reads the empty scope, and its release ends it.
  const replication = serviceReplication(f.storage);
  const bootstrap = () => replication(new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}));
  expect(await (await bootstrap()).json()).toMatchObject({hasContent: false});
  f.release(first.objectId);
  expect((await bootstrap()).status).toBe(404);
  expect((await f.handle(f.request("POST", {path: first.path}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]).toMatchObject({objectId: first.objectId, shareId: first.shareId, retired: false, enabled: true});
  expect((await f.handle(f.request("POST", {path: "docs/missing.md"}))).status).toBe(404);
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&retired=1"))).status).toBe(404);
});

it("discovers a new document after more than 64 prior shares without reviving retired enrollment", async () => {
  const f = await fixture(); f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  for (let index = 0; index < 65; index++) {
    const shareId = `old-${String(index).padStart(3, "0")}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT ?,workspace_id,granter_user_id,selector_json,created_at_ms FROM sync_relay_shares WHERE share_id=?").run(shareId, scope.shareId);
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?")
      .run(`grant-${index}`, shareId, scope.grantId);
  }
  const cursor = discoverServiceHostDocuments(f.storage);
  expect(cursor).not.toBeNull(); expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  f.seed("docs/b.md", "object-b");
  const last = discoverServiceHostDocuments(f.storage, undefined, cursor!);
  expect(last).toBeNull();
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual(["docs/b.md"]);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)?.retired).toBe(true);
});

it("hosts a document retired by revocation again for a new Edit share, but leaves an owner's Pause or Stop", async () => {
  const f = await fixture(); f.seed("docs/paused.md", "paused-object"); f.seed("docs/stopped.md", "stopped-object");
  discoverServiceHostDocuments(f.storage);
  await f.handle(f.request("DELETE", {path: "docs/paused.md"}));
  await f.handle(f.request("DELETE", {path: "docs/stopped.md", retire: true}));
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30}).ok).toBe(true);
  for (const objectId of [binding.objectId, "paused-object"]) expect(f.release(objectId)).toMatchObject({enabled: false, retired: true});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  // A new Edit share covering the folder; nobody presses Resume.
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('new-share',?,'owner-1',?,40)")
    .run(scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
  f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT 'new-grant','new-share',principal_kind,principal_user_id,principal_email,access,generation,'active',40,NULL,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(scope.grantId);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments().map(row => [row.path, row.enabled, row.ownerStop, row.shareId])).toEqual([[binding.currentPath, true, null, scope.shareId]]);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({retired: true, ownerStop: "pause"});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped.md")).toMatchObject({retired: true, ownerStop: "retire"});
  // The owner's Resume brings back their paused document.
  expect((await f.handle(f.request("POST", {path: "docs/paused.md"}))).status).toBe(202);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({retired: false, enabled: true, ownerStop: null});
});

it("compares the restore generation before retirement and accepts a repeat", async () => {
  const f = await fixture(); f.storage.enrollServiceHostDocuments([f.input]);
  const request = (generation: number) => f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}));
  const mismatch = await request(binding.restoreFenceGeneration + 1);
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({code: "restore-fenced", restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({enabled: true, retired: false});
  expect((await request(binding.restoreFenceGeneration)).status).toBe(200);
  expect((await request(binding.restoreFenceGeneration)).status).toBe(200);
});

it("retires an unenrolled desktop without a generation and resolves a moved target by object",async () => {
  const f=await fixture();f.storage.enrollServiceHostDocument(f.input);
  f.raw.prepare("UPDATE sync_relay_service_host_enrollments SET path='docs/moved.md'").run();
  const response=await f.handle(f.request("DELETE",{path:binding.currentPath,objectId:binding.objectId,retire:true}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok:true,path:"docs/moved.md",objectId:binding.objectId,status:"retired",acceptedCursor:0});
  expect((await f.handle(f.request("DELETE",{path:binding.currentPath,objectId:"wrong-object",retire:true}))).status).toBe(404);
});

it("rejects invalid generations and a stale repeat after the generation moves", async () => {
  const f = await fixture();f.storage.enrollServiceHostDocument(f.input);
  for (const generation of [-1, 0.5, "7"]) {
    expect((await f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}))).status).toBe(400);
  }
  const retire = (generation: number) => f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}));
  expect((await retire(7)).status).toBe(200);
  f.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=8").run();
  expect((await retire(7)).status).toBe(409);
  expect((await retire(8)).status).toBe(200);
});
