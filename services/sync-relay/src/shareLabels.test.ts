import {afterEach, expect, it} from "vitest";
import {claimWorkspace, closeTestStorages, createShare, inspectDatabase, storagePath, testStorage, testHandler, request, jsonBody, json} from "./testing";
afterEach(closeTestStorages);
it("stores bounded display labels, updates only for the owner, and cascades with the share", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const shareId = await createShare(handler, "owner", "workspace", {paths: ["trip"], recipientUserId: "ana", access: "comment",
    subjectName: " Trip\n\u202e "});
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Trip"});
  const received = await json(await handler(request("ana", `/sync/shares/${shareId}`)));
  expect(received).toMatchObject({subjectName: "Trip", sharerName: "owner@dohc.test", granterEmail: "owner@dohc.test", access: "comment"});
  const update = {...jsonBody({subjectName: "Holiday"}), method: "PUT"};
  expect((await handler(request("owner", `/sync/shares/${shareId}`, {...jsonBody({subjectName: "partial", sharerName: "IT Security"}), method: "PUT"}))).status).toBe(400);
  expect((await handler(request("ana", `/sync/shares/${shareId}`, update))).status).toBe(404);
  expect((await handler(request("owner", `/sync/shares/${shareId}`, update))).status).toBe(200);
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Holiday"});
  const denial = await handler(request("stranger", `/sync/shares/${shareId}`));
  expect(denial.status).toBe(404); expect(await denial.text()).not.toContain("Holiday");
  const db = inspectDatabase(storagePath(storage), {foreignKeys: true});
  expect(() => db.prepare("UPDATE sync_relay_share_labels SET subject_name = ? WHERE share_id = ?").run("x".repeat(161), shareId)).toThrow();
  db.prepare("DELETE FROM sync_relay_shares WHERE share_id = ?").run(shareId);
  expect(db.prepare("SELECT * FROM sync_relay_share_labels WHERE share_id = ?").get(shareId)).toBeUndefined();
});
it("leaves old shares neutral until the owner refreshes them", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const shareId = await createShare(handler, "owner", "workspace", {versionId: "main", recipientUserId: "ana"});
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: null});
  storage.setShareLabels(shareId, {subjectName: "😀".repeat(200)}, 99);
  expect(Array.from(storage.getShareLabels(shareId).subjectName!)).toHaveLength(160);
  expect(storage.getShareLabels(shareId)).not.toHaveProperty("sharerName");
});

it("stores labels with an atomic link share and refuses former or replacement owners", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const created = await handler(request("owner", "/sync/workspace/shares/links", jsonBody({paths: ["app"], access: "view", subjectName: "Trip app"})));
  expect(created.status).toBe(200);
  const body = await json(created), shareId = String(body.shareId);
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Trip app"});
  const db = inspectDatabase(storagePath(storage));
  db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'replacement' WHERE workspace_id = 'workspace'").run();
  for (const actor of ["owner", "replacement"]) {
    expect((await handler(request(actor, `/sync/shares/${shareId}`, {...jsonBody({subjectName: "Changed"}), method: "PUT"}))).status).toBe(404);
  }
  expect(storage.getShareLabels(shareId).subjectName).toBe("Trip app");
});

it("rejects owner supplied sender identity on named and link creation", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  for (const [path, body] of [["/sync/workspace/shares", {paths: ["trip"], recipientUserId: "ana"}], ["/sync/workspace/shares/links", {paths: ["trip"], access: "view"}]] as const) {
    expect((await handler(request("owner", path, jsonBody({...body, sharerName: "IT Security"})))).status).toBe(400);
  }
});

it.each(["named", "link"])("clears %s labels on whole-share revocation and refuses later updates", async kind => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const shareId = kind === "named"
    ? await createShare(handler, "owner", "workspace", {paths: ["trip"], recipientUserId: "ana", subjectName: "Trip"})
    : String((await json(await handler(request("owner", "/sync/workspace/shares/links", jsonBody({paths: ["trip"], access: "view", subjectName: "Trip"}))))).shareId);
  expect((await handler(request("owner", "/sync/shares/" + shareId, {...jsonBody({subjectName: "Renamed"}), method: "PUT"}))).status).toBe(200);
  expect(storage.revokeShare(shareId, 3000)).toBe(true);
  expect(storage.getShare(shareId)).toBeTruthy();
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: null});
  expect((await handler(request("owner", "/sync/shares/" + shareId, {...jsonBody({subjectName: "Resurrected"}), method: "PUT"}))).status).toBe(404);
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: null});
});

it("answers with the account sender and keeps owner content as the subject", async () => {
  const storage = await testStorage(), handler = testHandler(storage, {lookupUserDisplayName: () => "IT Security"});
  await claimWorkspace(handler, "owner", "workspace");
  const shareId = await createShare(handler, "owner", "workspace", {paths: ["trip"], recipientUserId: "ana", subjectName: "Reset your password at evil.example"});
  for (const path of ["/sync/shares/" + shareId, "/sync/shares"]) {
    const body = await json(await handler(request("ana", path)));
    const received = path === "/sync/shares" ? (body.received as unknown[])[0] : body;
    expect(received).toMatchObject({subjectName: "Reset your password at evil.example", sharerName: "IT Security (owner@dohc.test)", granterEmail: "owner@dohc.test"});
  }
});
