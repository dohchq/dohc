import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  appendLog,
  claimWorkspace,
  closeTestStorages,
  createShare,
  json,
  logOp,
  moment,
  putBlob,
  request,
  resetOpSeq,
  seedDependentGrant,
  seedLinkGrant,
  sha256,
  testHandler,
  testStorage,
} from "./testing";

// A named recipient with View or Comment reads current files only, as a View
// or Comment link does. Edit keeps the retained history.

afterEach(closeTestStorages);
beforeEach(resetOpSeq);

const GRANTER = "granter";
const WORKSPACE = "workspace-a";

type ServedOp = { relaySeq: number; opKind: string; payload: Record<string, unknown> };

// Every content version the owner replaced or removed before any share existed.
const REPLACED = ["first draft", "old name body", "gone body"];

async function seedHistory(): Promise<{ storage: SyncRelayStorage; h: SyncRelayHandler }> {
  const storage = await testStorage();
  const h = testHandler(storage);
  await claimWorkspace(h, GRANTER, WORKSPACE);
  for (const body of [...REPLACED, "second draft", "moved body"])
    await putBlob(h, GRANTER, WORKSPACE, body);
  await appendLog(h, GRANTER, WORKSPACE, [
    moment("docs/plan.md", "first draft", { objectId: "object-plan" }),
    moment("docs/plan.md", "second draft", {
      objectId: "object-plan",
      beforeContent: "first draft",
      beforePath: "docs/plan.md",
    }),
    moment("docs/old-name.md", "old name body", { objectId: "object-moved" }),
    moment("docs/moved.md", "old name body", {
      objectId: "object-moved",
      operation: "rename",
      beforeContent: "old name body",
      beforePath: "docs/old-name.md",
    }),
    moment("docs/moved.md", "moved body", {
      objectId: "object-moved",
      beforeContent: "old name body",
      beforePath: "docs/moved.md",
    }),
    moment("docs/gone.md", "gone body", { objectId: "object-gone" }),
    moment("docs/gone.md", "gone body", {
      objectId: "object-gone",
      operation: "delete",
      beforeContent: "gone body",
      beforePath: "docs/gone.md",
      // The engine records a delete with the deleted content as its after-hash.
      afterPath: "docs/gone.md",
    }),
  ]);
  return { storage, h };
}

async function readLog(h: SyncRelayHandler, user: string, shareId: string, since = 0) {
  const response = await h(request(user, `/sync/shares/${shareId}/log?since=${since}`));
  expect(response.status, await response.clone().text()).toBe(200);
  const page = await json(response);
  return { ops: page.ops as ServedOp[], nextCursor: page.nextCursor as number, body: page };
}

async function blobStatus(
  h: SyncRelayHandler,
  user: string,
  shareId: string,
  body: string | Uint8Array,
) {
  const response = await h(request(user, `/sync/shares/${shareId}/blobs/${sha256(body)}`));
  return { status: response.status, text: await response.text() };
}

// The recipient's file replay (`replay_share_view_op` in
// crates/dohc-engine-sync/src/relay.rs): a write or rename places its after
// content at its after path, a rename also removes its before path, and a
// delete removes its path. Applied in order to a path→content-hash map.
function replay(files: Map<string, string>, ops: readonly ServedOp[]): Map<string, string> {
  for (const { opKind, payload } of ops) {
    if (opKind !== "moment.append") continue;
    const afterPath = (payload.payloadAfterPath ?? payload.path) as string;
    if (payload.operation === "delete") files.delete(payload.path as string);
    if (payload.operation === "rename") files.delete(payload.payloadBeforePath as string);
    if (payload.operation === "write" || payload.operation === "rename")
      files.set(afterPath, payload.payloadAfterBlobSha256 as string);
  }
  return files;
}

describe("named recipient History by access level", () => {
  for (const access of ["view", "comment"] as const) {
    it(`gives a ${access} recipient current files only, through the log and the blob door`, async () => {
      const { h } = await seedHistory();
      const shareId = await createShare(h, GRANTER, WORKSPACE, {
        recipientEmail: "reader@dohc.test",
        paths: ["docs"],
        access,
      });

      const first = await readLog(h, "reader", shareId);
      const served = JSON.stringify(first.body);
      for (const body of REPLACED) expect(served).not.toContain(sha256(body));
      expect([...replay(new Map(), first.ops)]).toEqual(
        expect.arrayContaining([
          ["docs/plan.md", sha256("second draft")],
          ["docs/moved.md", sha256("moved body")],
        ]),
      );
      expect(replay(new Map(), first.ops).size).toBe(2);
      for (const body of REPLACED) {
        const blob = await blobStatus(h, "reader", shareId, body);
        expect(blob.status).toBe(404);
        expect(blob.text).not.toContain(body);
      }
      expect(await blobStatus(h, "reader", shareId, "second draft")).toEqual({
        status: 200,
        text: "second draft",
      });

      // Following later changes keeps working; what they replace becomes unreadable.
      await putBlob(h, GRANTER, WORKSPACE, "third draft");
      await appendLog(h, GRANTER, WORKSPACE, [
        moment("docs/plan.md", "third draft", {
          objectId: "object-plan",
          beforeContent: "second draft",
          beforePath: "docs/plan.md",
        }),
        moment("docs/renamed.md", "moved body", {
          objectId: "object-moved",
          operation: "rename",
          beforeContent: "moved body",
          beforePath: "docs/moved.md",
        }),
      ]);
      const later = await readLog(h, "reader", shareId, first.nextCursor);
      expect(JSON.stringify(later.body)).not.toContain(sha256("second draft"));
      expect(replay(replay(new Map(), first.ops), later.ops)).toEqual(
        new Map([
          ["docs/plan.md", sha256("third draft")],
          ["docs/renamed.md", sha256("moved body")],
        ]),
      );
      // A recipient that never read the first page reaches the same files.
      expect(replay(new Map(), (await readLog(h, "reader", shareId)).ops)).toEqual(
        new Map([
          ["docs/plan.md", sha256("third draft")],
          ["docs/renamed.md", sha256("moved body")],
        ]),
      );
      expect((await blobStatus(h, "reader", shareId, "second draft")).status).toBe(404);
      expect((await blobStatus(h, "reader", shareId, "third draft")).status).toBe(200);
    });
  }

  // A live note keeps the text its edits deleted. Below Edit no named door
  // serves its document updates: the log filter refuses `ydoc.update`, and
  // every named live-document route requires Edit.
  for (const access of ["view", "comment"] as const) {
    it(`gives a ${access} recipient none of a live note's document updates`, async () => {
      const { h } = await seedHistory();
      const doc = new Y.Doc({ gc: false });
      doc.getText("body").insert(0, "the old budget");
      doc.getText("body").delete(0, "the old budget".length);
      doc.getText("body").insert(0, "second draft");
      const update = Y.encodeStateAsUpdate(doc);
      // The update still holds the deleted text.
      expect(Buffer.from(update).toString("utf8")).toContain("old budget");
      const updateSha = await putBlob(h, GRANTER, WORKSPACE, update);
      await appendLog(h, GRANTER, WORKSPACE, [
        logOp("ydoc.update", {
          versionId: "main",
          objectId: "object-plan",
          path: "docs/plan.md",
          contentKind: "plaintext",
          updateBlobSha256: updateSha,
          isBaseState: true,
        }),
      ]);
      const shareId = await createShare(h, GRANTER, WORKSPACE, {
        recipientEmail: "reader@dohc.test",
        paths: ["docs"],
        access,
      });
      const { ops, body } = await readLog(h, "reader", shareId);
      expect(ops.map((op) => op.opKind)).not.toContain("ydoc.update");
      expect(JSON.stringify(body)).not.toContain(updateSha);
      expect((await blobStatus(h, "reader", shareId, update)).status).toBe(404);
    });
  }

  it("serves a current file to a view recipient however many other files once held its bytes", async () => {
    const { h } = await seedHistory();
    await putBlob(h, GRANTER, WORKSPACE, "template");
    const ops = [moment("docs/kept.md", "template", { objectId: "object-kept" })];
    // More objects than the blob route's candidate limit, each newer than the
    // kept file, that held the same bytes and then changed.
    for (let index = 0; index < 65; index += 1) {
      await putBlob(h, GRANTER, WORKSPACE, `filled ${index}`);
      ops.push(
        moment(`docs/note-${index}.md`, "template", { objectId: `object-note-${index}` }),
        moment(`docs/note-${index}.md`, `filled ${index}`, {
          objectId: `object-note-${index}`,
          beforeContent: "template",
          beforePath: `docs/note-${index}.md`,
        }),
      );
    }
    await appendLog(h, GRANTER, WORKSPACE, ops);
    const shareId = await createShare(h, GRANTER, WORKSPACE, {
      recipientEmail: "reader@dohc.test",
      paths: ["docs"],
      access: "view",
    });
    expect(await blobStatus(h, "reader", shareId, "template")).toEqual({
      status: 200,
      text: "template",
    });
  });

  it("serves a current file to a view recipient behind other current files the share refuses", async () => {
    const { h } = await seedHistory();
    await putBlob(h, GRANTER, WORKSPACE, "template");
    const ops = [];
    // More current files than one candidate page, ahead in path order, that
    // arrived by a rename from outside the share, which the share filter refuses.
    for (let index = 0; index < 65; index += 1) {
      const name = `a${String(index).padStart(2, "0")}.md`;
      ops.push(
        moment(`outside/${name}`, "template", { objectId: `object-a${index}` }),
        moment(`docs/${name}`, "template", {
          objectId: `object-a${index}`,
          operation: "rename",
          beforeContent: "template",
          beforePath: `outside/${name}`,
        }),
      );
    }
    ops.push(moment("docs/z.md", "template", { objectId: "object-z" }));
    await appendLog(h, GRANTER, WORKSPACE, ops);
    const shareId = await createShare(h, GRANTER, WORKSPACE, {
      recipientEmail: "reader@dohc.test",
      paths: ["docs"],
      access: "view",
    });
    expect(await blobStatus(h, "reader", shareId, "template")).toEqual({
      status: 200,
      text: "template",
    });
  });

  it("gives an edit recipient the retained history, including what came before the share", async () => {
    const { h } = await seedHistory();
    const shareId = await createShare(h, GRANTER, WORKSPACE, {
      recipientEmail: "editor@dohc.test",
      paths: ["docs"],
      access: "edit",
    });
    const served = JSON.stringify((await readLog(h, "editor", shareId)).body);
    for (const body of REPLACED) expect(served).toContain(sha256(body));
    expect(await blobStatus(h, "editor", shareId, "first draft")).toEqual({
      status: 200,
      text: "first draft",
    });
  });

  it("follows the grant's current level when it is lowered or a person is shared again at Edit", async () => {
    const { storage, h } = await seedHistory();
    const shareId = await createShare(h, GRANTER, WORKSPACE, {
      recipientEmail: "someone-else@dohc.test",
      paths: ["docs"],
      access: "edit",
    });
    // A person who converted an Edit link holds an Edit grant that follows the
    // link when the owner narrows it.
    seedLinkGrant(storage, {
      grantId: "grant-link",
      shareId,
      secretHash: "link-secret-hash",
      access: "edit",
    });
    expect(
      seedDependentGrant(storage, {
        shareId,
        parentGrantId: "grant-link",
        grantId: "grant-converted",
        principalUserId: "converted",
        createdAtMs: 2_002,
      }),
    ).toMatchObject({ ok: true });
    expect((await blobStatus(h, "converted", shareId, "first draft")).status).toBe(200);

    expect(
      storage.retuneShareGrant({
        shareId,
        grantId: "grant-link",
        access: "view",
        changedAtMs: 2_003,
        expectedDependentGrantIds: ["grant-converted"],
        guard: () => undefined,
      }),
    ).toMatchObject({ ok: true });
    expect(storage.getShareGrant("grant-converted")).toMatchObject({ access: "view" });
    expect((await blobStatus(h, "converted", shareId, "first draft")).status).toBe(404);
    const lowered = JSON.stringify((await readLog(h, "converted", shareId)).body);
    for (const body of REPLACED) expect(lowered).not.toContain(sha256(body));

    // Raising a named person to Edit is a new share at Edit; it reads history.
    const raised = await createShare(h, GRANTER, WORKSPACE, {
      recipientEmail: "converted@dohc.test",
      paths: ["docs"],
      access: "edit",
    });
    expect((await blobStatus(h, "converted", raised, "first draft")).status).toBe(200);
    expect((await blobStatus(h, "converted", shareId, "first draft")).status).toBe(404);
  });
});
