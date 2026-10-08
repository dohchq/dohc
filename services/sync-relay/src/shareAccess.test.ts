import { afterEach, expect, it, vi } from "vitest";
import { claimWorkspace, closeTestStorages, countStorageCalls, createShare, inspectDatabase, request, storagePath, testHandler, testStorage } from "./testing";
import type { StorageContext } from "./storage/context";

afterEach(closeTestStorages);

it("authorizes access with the recipient grant and hides other accounts and shares", async () => {
  const storage = await testStorage();
  const handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const share = await createShare(handler, "owner", "workspace", { recipientUserId: "reader", paths: ["tasks"], access: "edit" });
  const read = await handler(request("reader", `/sync/shares/${share}/access`));
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ status: "current", access: "edit" });
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  const stranger = await handler(request("stranger", `/sync/shares/${share}/access`));
  const absent = await handler(request("stranger", "/sync/shares/missing/access"));
  expect(stranger.status).toBe(404);
  expect(await stranger.text()).toBe(await absent.text());
  expect((await handler(new Request(`http://relay.test/sync/shares/${share}/access`))).status).toBe(401);
  expect((await handler(request("reader", `/sync/shares/${share}/access`, { method: "POST" }))).status).toBe(405);
  const stopped = await handler(request("owner", `/sync/shares/${share}/revoke`, { method: "POST" }));
  expect(stopped.status).toBe(200);
  const stop = await stopped.json() as { undo: { undoId: string } };
  const removed = await handler(request("reader", `/sync/shares/${share}/access`));
  expect(removed.status).toBe(404);
  expect(await removed.json()).toMatchObject({ code: "share_access_removed" });
  expect((await handler(request("owner", `/sync/shares/${share}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ undoId: stop.undo.undoId }) }))).status).toBe(200);
  expect((await handler(request("reader", `/sync/shares/${share}/access`))).status).toBe(200);
});

it("checks access without claiming invites, fetching account labels, or writing SQLite", async () => {
  const storage = await testStorage();
  const setup = testHandler(storage);
  await claimWorkspace(setup, "owner", "workspace");
  const share = await createShare(setup, "owner", "workspace", { recipientUserId: "reader", paths: ["tasks"], access: "comment" });
  const claim = countStorageCalls(storage, "claimPendingSharesForEmail");
  const labels = countStorageCalls(claim.storage, "getShareLabels");
  const lookupUserEmail = vi.fn(() => "reader@dohc.test");
  const lookupVerifiedUserEmail = vi.fn(() => "reader@dohc.test");
  const lookupUserDisplayName = vi.fn(() => "Reader");
  const handler = testHandler(labels.storage, { lookupUserEmail, lookupVerifiedUserEmail, lookupUserDisplayName });
  const writes = vi.spyOn(storage as StorageContext, "tx");
  const db = inspectDatabase(storagePath(storage), { readOnly: true });
  const before = db.prepare("PRAGMA data_version").get();
  for (let i = 0; i < 12; i++) {
    expect(await (await handler(request("reader", `/sync/shares/${share}/access`))).json()).toEqual({ status: "current", access: "comment" });
  }
  expect(claim.calls).toHaveLength(0);
  expect(labels.calls).toHaveLength(0);
  expect(lookupUserEmail).not.toHaveBeenCalled();
  expect(lookupVerifiedUserEmail).not.toHaveBeenCalled();
  expect(lookupUserDisplayName).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
});

it("limits the actor across shares and refills without limiting another actor", async () => {
  const storage = await testStorage();
  let now = 2_000;
  const handler = testHandler(storage, { nowMs: () => now });
  await claimWorkspace(handler, "owner", "workspace");
  const first = await createShare(handler, "owner", "workspace", { recipientUserId: "reader", paths: ["tasks"] });
  const second = await createShare(handler, "owner", "workspace", { recipientUserId: "reader", paths: ["notes"] });
  const other = await createShare(handler, "owner", "workspace", { recipientUserId: "other", paths: ["tasks"] });
  for (let i = 0; i < 30; i++) expect((await handler(request("reader", `/sync/shares/${i % 2 ? first : second}/access`))).status).toBe(200);
  const limited = await handler(request("reader", `/sync/shares/${second}/access`));
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ code: "share_access_rate_limited" });
  expect((await handler(request("other", `/sync/shares/${other}/access`))).status).toBe(200);
  now += 1_000;
  expect((await handler(request("reader", `/sync/shares/${first}/access`))).status).toBe(200);
});
