import {afterEach, expect, it} from "vitest";
import {claimWorkspace, closeTestStorages, createShare, inspectDatabase, storagePath, testStorage, testHandler, request, jsonBody, json} from "./testing";
afterEach(closeTestStorages);
it("stores bounded display labels, updates only for the owner, and cascades with the share", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const shareId = await createShare(handler, "owner", "workspace", {paths: ["trip"], recipientUserId: "ana", access: "comment",
    subjectName: " Trip\n\u202e ", sharerName: "A".repeat(200)});
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Trip", sharerName: "A".repeat(160)});
  const received = await json(await handler(request("ana", `/sync/shares/${shareId}`)));
  expect(received).toMatchObject({subjectName: "Trip", sharerName: "A".repeat(160), access: "comment"});
  const update = {...jsonBody({subjectName: "Holiday", sharerName: "Ana"}), method: "PUT"};
  expect((await handler(request("owner", `/sync/shares/${shareId}`, {...jsonBody({subjectName: "partial"}), method: "PUT"}))).status).toBe(400);
  expect((await handler(request("ana", `/sync/shares/${shareId}`, update))).status).toBe(404);
  expect((await handler(request("owner", `/sync/shares/${shareId}`, update))).status).toBe(200);
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Holiday", sharerName: "Ana"});
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
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: null, sharerName: null});
  storage.setShareLabels(shareId, {subjectName: "😀".repeat(200), sharerName: "\t\u0000"}, 99);
  expect(Array.from(storage.getShareLabels(shareId).subjectName!)).toHaveLength(160);
  expect(storage.getShareLabels(shareId).sharerName).toBeNull();
});

it("stores labels with an atomic link share and refuses former or replacement owners", async () => {
  const storage = await testStorage(), handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  const created = await handler(request("owner", "/sync/workspace/shares/links", jsonBody({paths: ["app"], access: "view", subjectName: "Trip app", sharerName: "Ana"})));
  expect(created.status).toBe(200);
  const body = await json(created), shareId = String(body.shareId);
  expect(storage.getShareLabels(shareId)).toEqual({subjectName: "Trip app", sharerName: "Ana"});
  const db = inspectDatabase(storagePath(storage));
  db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'replacement' WHERE workspace_id = 'workspace'").run();
  for (const actor of ["owner", "replacement"]) {
    expect((await handler(request(actor, `/sync/shares/${shareId}`, {...jsonBody({subjectName: "Changed", sharerName: "Other"}), method: "PUT"}))).status).toBe(404);
  }
  expect(storage.getShareLabels(shareId).subjectName).toBe("Trip app");
});
