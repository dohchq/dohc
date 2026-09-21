import { expect, it } from "vitest";
import { evaluateAppOperation, type EvaluateAppOperationInput } from "@dohc/app-backend-runtime";
import type { AppBackendAuth } from "./appBackendHost";
import { fixture, owner, input } from "./appBackendTestFixture";

it("serializes concurrent last-slot reservations, preserving an invocation identity across retries", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => {release = resolve;});
  const seen: EvaluateAppOperationInput[] = [];
  const f = fixture(async value => {
    seen.push(value);
    if (seen.length === 2) release();
    if (seen.length <= 2) await ready;
    return evaluateAppOperation(value);
  });
  await f.host.activate(owner, f.publicationId, 1);
  const outcomes = await Promise.allSettled([f.host.invoke(f.link("a"), f.publicationId, input("a")), f.host.invoke(f.link("b"), f.publicationId, input("b"))]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
  expect(seen).toHaveLength(3);
  const repeated = seen.slice(0, 2).find(value => value.requestId === seen[2]!.requestId)!;
  expect(repeated.secret).toBe(seen[2]!.secret);
  expect((await f.host.invoke(owner, f.publicationId, input("read", "read"))).result).toEqual([{id: "only", remaining: 0}]);
});

it("replays committed replies without executing again and checks authority before replay", async () => {
  let evaluations = 0;
  const f = fixture(value => {evaluations++; return evaluateAppOperation(value);});
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const first = await f.host.invoke(caller, f.publicationId, input("one"));
  expect(await f.host.invoke(caller, f.publicationId, input("one"))).toEqual({...first, replayed: true});
  expect(evaluations).toBe(1);
  await expect(f.host.invoke(caller, f.publicationId, input("one", "reserve", {changed: true}))).rejects.toMatchObject({code: "conflict"});
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_shares SET link_writes_paused_at_ms=10 WHERE share_id='s'").run());
  await expect(f.host.invoke(caller, f.publicationId, input("one"))).rejects.toMatchObject({code: "not_found"});
});

it.each(["withdraw", "block", "pause", "owner", "abort"])("refuses %s between evaluation and commit", async kind => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const ready = new Promise<void>(resolve => {release = resolve;});
  const f = fixture(async value => {const result = await evaluateAppOperation(value); entered(); await ready; return result;});
  await f.host.activate(owner, f.publicationId, 1);
  const controller = new AbortController();
  const operation = f.host.invoke(f.link("a"), f.publicationId, input("one"), controller.signal);
  const refused = expect(operation).rejects.toThrow();
  await started;
  if (kind === "withdraw") f.storage.withdrawAppPublication({workspaceId: "w", ownerUserId: "owner", publicationId: f.publicationId, expectedAuthorityRevision: 1});
  if (kind === "abort") controller.abort();
  if (kind === "block") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_link_principals SET blocked_at_ms=10").run());
  if (kind === "pause") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_shares SET link_writes_paused_at_ms=10").run());
  if (kind === "owner") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other'").run());
  release(); await refused;
  expect(f.storage.db.prepare("SELECT count(*) AS n FROM sync_relay_app_backend_receipts").get()?.n).toBe(0);
  expect(f.storage.db.prepare("SELECT revision FROM sync_relay_app_backends").get()?.revision).toBe(1);
});

it("keeps staged files private, attaches atomically, and refuses arbitrary public reads", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const upload = {authorityRevision: 1, idempotencyKey: "file", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.7 test").toString("base64")};
  const staged = f.host.upload(caller, f.publicationId, upload);
  expect(f.host.upload(caller, f.publicationId, upload)).toEqual({...staged, replayed: true});
  await expect(f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).rejects.toThrow();
  await f.host.invoke(caller, f.publicationId, input("one", "reserve", {fileId: staged.file.fileId}));
  await expect(f.host.readFile(caller, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).rejects.toThrow();
  await expect(f.host.readFile(caller, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId, operation: "fileAccess", input: {fileId: staged.file.fileId}})).rejects.toThrow();
  expect((await f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId})).bytesBase64).toBe(upload.bytesBase64);
  expect(() => f.host.upload(caller, f.publicationId, {...upload, idempotencyKey: "spoof", bytesBase64: Buffer.from("html").toString("base64")})).toThrow();
});

it("requires both an explicit helper mark and a current named Edit grant", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  f.storage.tx(() => f.storage.db.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES('helper','s','user','helper-user',NULL,'edit',1,'active',1,NULL,NULL)`).run());
  const caller: AppBackendAuth = {kind: "named", workspaceId: "w", userId: "helper-user"};
  await expect(f.host.invoke(caller, f.publicationId, input("admin", "administer"))).rejects.toThrow();
  f.host.helper(owner, f.publicationId, {authorityRevision: 1, grantId: "helper", enabled: true});
  expect((await f.host.invoke(caller, f.publicationId, input("admin", "administer"))).result).toEqual({kind: "named"});
  expect(f.host.descriptor(caller, f.publicationId).files.map(file => file.path)).toEqual(["bundle.js"]);
  await expect(f.host.invoke(caller, f.publicationId, input("owner", "ownerOnly"))).rejects.toThrow();
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE grant_id='helper'").run());
  await expect(f.host.invoke(caller, f.publicationId, input("admin", "administer"))).rejects.toThrow();
});

it("retains committed data and receipts through restart and source publication changes", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const caller = f.link("a");
  const first = await f.host.invoke(caller, f.publicationId, input("one"));
  f.restart();
  expect(await f.host.invoke(caller, f.publicationId, input("one"))).toEqual({...first, replayed: true});
  expect(await f.host.activate(owner, f.publicationId, 1)).toMatchObject({revision: first.revision});
  const next = f.publishUpgrade();
  await f.host.activate(owner, next, 1);
  expect((await f.host.invoke(owner, next, input("read", "read"))).result).toEqual([{id: "only", remaining: 0}]);
  await expect(f.host.invoke(caller, f.publicationId, input("one"))).rejects.toThrow();
  expect(f.host.export(owner, next)).toBeDefined();
});

it("does not return private bytes when an access decision becomes stale", async () => {
  let revoke: (() => void) | undefined;
  const f = fixture(async value => {
    const result = await evaluateAppOperation(value);
    if (value.operation === "fileAccess") revoke?.();
    return result;
  });
  await f.host.activate(owner, f.publicationId, 1);
  const staged = f.host.upload(owner, f.publicationId, {authorityRevision: 1, idempotencyKey: "upload", name: "private.txt", contentType: "text/plain", bytesBase64: Buffer.from("private").toString("base64")});
  await f.host.invoke(owner, f.publicationId, input("attach", "reserve", {fileId: staged.file.fileId}));
  revoke = () => f.storage.withdrawAppPublication({workspaceId: "w", ownerUserId: "owner", publicationId: f.publicationId, expectedAuthorityRevision: 1});
  await expect(f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: staged.file.fileId, operation: "fileAccess", input: {fileId: staged.file.fileId}})).rejects.toThrow();
});

it("rechecks authority before exposing an app refusal message", async () => {
  let revoke: (() => void) | undefined;
  const f = fixture(async () => {
    revoke?.();
    throw new Error("private data in a refusal");
  });
  await f.host.activate(owner, f.publicationId, 1);
  revoke = () => f.storage.withdrawAppPublication({workspaceId: "w", ownerUserId: "owner", publicationId: f.publicationId, expectedAuthorityRevision: 1});
  await expect(f.host.invoke(f.link("a"), f.publicationId, input("one"))).rejects.toMatchObject({code: "not_found", message: "not found"});
});

it("restores a fresh app store without reopening accepted work or importing helper access", async () => {
  const original = fixture();
  await original.host.activate(owner, original.publicationId, 1);
  const receipt = await original.host.invoke(owner, original.publicationId, input("one"));
  const bundle = original.host.export(owner, original.publicationId);
  const recovered = fixture();
  expect(await recovered.host.restore(owner, recovered.publicationId, {authorityRevision: 1, bundle})).toMatchObject({revision: receipt.revision + 1});
  expect(await recovered.host.invoke(owner, recovered.publicationId, input("one"))).toEqual({...receipt, replayed: true});
  expect((await recovered.host.invoke(owner, recovered.publicationId, input("read", "read"))).result).toEqual([{id: "only", remaining: 0}]);
  await expect(recovered.host.restore(owner, recovered.publicationId, {authorityRevision: 1, bundle})).rejects.toMatchObject({code: "conflict"});
  const unauthorized = fixture();
  await expect(unauthorized.host.restore({kind: "named", workspaceId: "w", userId: "stranger"}, unauthorized.publicationId, {authorityRevision: 1, bundle})).rejects.toThrow();
});

it("does not attach another participant's staged upload", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const upload = f.host.upload(f.link("a"), f.publicationId, {authorityRevision: 1, idempotencyKey: "upload", name: "private.txt", contentType: "text/plain", bytesBase64: Buffer.from("private").toString("base64")});
  await expect(f.host.invoke(f.link("b"), f.publicationId, input("steal", "reserve", {fileId: upload.file.fileId}))).rejects.toThrow();
  expect((await f.host.invoke(owner, f.publicationId, input("read", "read"))).result).toEqual([{id: "only", remaining: 1}]);
  expect(f.storage.db.prepare("SELECT attached_revision FROM sync_relay_app_backend_files WHERE file_id=?").get(upload.file.fileId)?.attached_revision).toBeNull();
});

it("keeps reads and new submissions working after more than 32 attached uploads", async () => {
  const f = fixture();
  await f.host.activate(owner, f.publicationId, 1);
  const upload = (index: number) => f.host.upload(owner, f.publicationId, {authorityRevision: 1, idempotencyKey: `upload-${index}`, name: "receipt.txt", contentType: "text/plain", bytesBase64: Buffer.from("receipt").toString("base64")});
  const pending = Array.from({length: 32}, (_, index) => upload(index));
  expect(() => upload(32)).toThrow(/Submit pending uploads/);
  expect(upload(0)).toEqual({...pending[0], replayed: true});
  expect((await f.host.invoke(owner, f.publicationId, input("read-pending", "read"))).result).toEqual([{id: "only", remaining: 1}]);
  await f.host.invoke(owner, f.publicationId, input("attach-first", "attach", {fileIds: pending.map(row => row.file.fileId)}));
  const next = upload(32);
  await f.host.invoke(owner, f.publicationId, input("attach-next", "attach", {fileIds: [next.file.fileId]}));
  expect((await f.host.invoke(owner, f.publicationId, input("read-attached", "read"))).result).toEqual([{id: "only", remaining: 1}]);
  expect((await f.host.readFile(owner, f.publicationId, {authorityRevision: 1, fileId: pending[0]!.file.fileId, operation: "fileAccess", input: {fileId: pending[0]!.file.fileId}})).file.fileId).toBe(pending[0]!.file.fileId);
  expect(upload(33).replayed).toBe(false);
});

it("uses one timestamp when staging an upload while the clock advances", async () => {
  let now = 10;
  const f = fixture(evaluateAppOperation, () => now++);
  await f.host.activate(owner, f.publicationId, 1);
  expect(f.host.upload(owner, f.publicationId, {authorityRevision: 1, idempotencyKey: "upload", name: "receipt.txt", contentType: "text/plain", bytesBase64: Buffer.from("receipt").toString("base64")})).toMatchObject({replayed: false});
});
