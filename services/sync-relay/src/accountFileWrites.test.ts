import { afterEach, describe, expect, it } from "vitest";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import { parseAccountFileWrite, validateAllowedFileWritePath } from "./accountFileWrites";
import { liveEditors } from "./liveEditors";
import { LIVE_ROOM_EDITS } from "./storage/liveRoomEdits";
import { LIVE_ROOM_PAUSES } from "./storage/liveRoomPauses";
import {
  isObjectMutationFenced,
  LiveHostingRefusal,
  SERVICE_HOST_ENROLLMENTS,
  serviceHostDocumentEnabled,
} from "./storage/serviceHostEnrollment";
import type { StorageContext } from "./storage/context";
import {
  claimWorkspace,
  closeTestStorages,
  denialBytes,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const resolveAccountSession: ResolveAccountSession = async (req) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "phone",
  } satisfies AccountSession;
};

const postOp = (
  workspaceId: string,
  operation: string,
  userId: string,
  body: Record<string, unknown>,
) =>
  new Request(`http://relay.test/sync/${encodeURIComponent(workspaceId)}/ops/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer session:${userId}:phone`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("owner file write path allowlist & argument validation", () => {
  it("allows .md for createPage and .md / .excalidraw for renameFile and deleteFile", () => {
    expect(
      validateAllowedFileWritePath("notes/plan.md", { allowSketch: false, checkDestination: true }),
    ).toEqual({ path: "notes/plan.md", kind: "page" });
    expect(
      validateAllowedFileWritePath("sketches/flow.excalidraw", {
        allowSketch: true,
        checkDestination: true,
      }),
    ).toEqual({ path: "sketches/flow.excalidraw", kind: "sketch" });
    expect(() =>
      validateAllowedFileWritePath("sketches/flow.excalidraw", {
        allowSketch: false,
        checkDestination: true,
      }),
    ).toThrow();
    expect(parseAccountFileWrite("createPage", { path: "hello.md", requestId: "req-1" })).toEqual({
      operation: "createPage",
      path: "hello.md",
      requestId: "req-1",
    });
    expect(() =>
      parseAccountFileWrite("createPage", { path: "hello.md", content: "hi", requestId: "req-1" }),
    ).toThrow();
    expect(
      parseAccountFileWrite("renameFile", {
        fromPath: "a.excalidraw",
        toPath: "b.excalidraw",
        expectedObjectId: "obj-1",
        requestId: "req-2",
      }),
    ).toMatchObject({ fromPath: "a.excalidraw", toPath: "b.excalidraw" });
    expect(
      parseAccountFileWrite("restoreDeletedFile", {
        path: "notes/plan.md",
        objectId: "obj-1",
        deleteMomentId: "mom-1",
        requestId: "req-3",
      }),
    ).toEqual({
      operation: "restoreDeletedFile",
      path: "notes/plan.md",
      objectId: "obj-1",
      deleteMomentId: "mom-1",
      requestId: "req-3",
    });
    expect(() =>
      parseAccountFileWrite("restoreDeletedFile", {
        path: ".secret.md",
        objectId: "obj-1",
        deleteMomentId: "mom-1",
        requestId: "req-3",
      }),
    ).toThrow();
    expect(() =>
      parseAccountFileWrite("restoreDeletedFile", {
        path: "notes/plan.md",
        objectId: "obj-1",
        deleteMomentId: "",
        requestId: "req-3",
      }),
    ).toThrow();
  });

  it("refuses system, collection, hidden, traversal, marker, non-page/sketch, cross-kind, and cross-folder paths", () => {
    const blocked = [
      "collection.yaml",
      "tasks/collection.yaml",
      "dataset.json",
      "tasks/dataset.json",
      "schema.sql",
      "operations.js",
      "automations.yaml",
      ".dohc/note.md",
      ".env",
      ".hidden.md",
      "notes/.secret.md",
      ".dohc-folder",
      "notes/.dohc-access",
      "readme.txt",
      "Guide.markdown",
      "../escape.md",
      "/leading.md",
      "CON.md",
      ".md",
      ".excalidraw",
    ];
    for (const path of blocked) {
      expect(
        () => validateAllowedFileWritePath(path, { allowSketch: true, checkDestination: true }),
        path,
      ).toThrow();
    }
    expect(() =>
      parseAccountFileWrite("renameFile", {
        fromPath: "note.md",
        toPath: "note.excalidraw",
        expectedObjectId: "obj-1",
        requestId: "req-1",
      }),
    ).toThrow();
    expect(() =>
      parseAccountFileWrite("renameFile", {
        fromPath: "note.md",
        toPath: "note.md",
        expectedObjectId: "obj-1",
        requestId: "req-1",
      }),
    ).toThrow();
    for (const [fromPath, toPath] of [
      ["Notes/One.md", "Archive/One.md"],
      ["Notes/One.md", "One.md"],
      ["One.md", "Notes/One.md"],
      ["Notes/One.md", "notes/One.md"],
    ]) {
      expect(
        () =>
          parseAccountFileWrite("renameFile", {
            fromPath,
            toPath,
            expectedObjectId: "obj-1",
            requestId: "req-1",
          }),
        `${fromPath} -> ${toPath}`,
      ).toThrow();
    }
    expect(() =>
      parseAccountFileWrite("createPage", { path: "a.md", requestId: "bad:undo:id" }),
    ).toThrow();
  });
});

describe("owner-only file write authorization and Member 404 isolation", () => {
  for (const hasCopies of [false, true]) {
    it(`returns 404 (matching missing workspace) to joined members and admins when copies=${String(hasCopies)}`, async () => {
      const storage = (await testStorage()) as StorageContext;
      const h = testHandler(storage, {
        resolvePhoneCapableAccountSession: resolveAccountSession,
        ...(hasCopies ? { serverCopies: () => ({ endHold() {} }) as never } : {}),
      });
      await claimWorkspace(h, "ana", "trip");
      storage.claimWorkspaceIdentity({
        workspaceId: "trip",
        replicationEpoch: "epoch",
        streamIdentity: "stream",
      });
      expect(
        storage.inviteWorkspaceMember({
          workspaceId: "trip",
          actorUserId: "ana",
          workspaceName: "Lisbon",
          email: "ben@dohc.test",
          recipientUserId: "ben",
          newMemberId: () => "member-ben",
          newGrantId: () => "grant-ben",
          newShareId: () => "share-trip",
          nowMs: 1,
        }),
      ).toMatchObject({ ok: true });

      const ops: Array<[string, Record<string, unknown>]> = [
        ["createPage", { path: "new.md", requestId: "req-1" }],
        [
          "renameFile",
          {
            fromPath: "a.md",
            toPath: "b.md",
            expectedObjectId: "obj-1",
            requestId: "req-2",
          },
        ],
        ["deleteFile", { path: "a.md", expectedObjectId: "obj-1", requestId: "req-3" }],
        [
          "restoreDeletedFile",
          { path: "a.md", objectId: "obj-1", deleteMomentId: "mom-1", requestId: "req-4" },
        ],
      ];
      for (const [operation, args] of ops) {
        const missingBytes = await denialBytes(await h(postOp("nowhere", operation, "ben", args)));
        expect(await denialBytes(await h(postOp("trip", operation, "ben", args))), operation).toBe(
          missingBytes,
        );
      }

      storage.setWorkspaceMemberRole({
        workspaceId: "trip",
        actorUserId: "ana",
        memberId: "member-ben",
        role: "admin",
      });
      for (const [operation, args] of ops) {
        const missingBytes = await denialBytes(await h(postOp("nowhere", operation, "ben", args)));
        expect(
          await denialBytes(await h(postOp("trip", operation, "ben", args))),
          `admin ${operation}`,
        ).toBe(missingBytes);
      }

      if (!hasCopies) {
        const ownerResp = await h(postOp("trip", "createPage", "ana", ops[0]![1]));
        expect(ownerResp.status).toBe(503);
        const ownerRestore = await h(postOp("trip", "restoreDeletedFile", "ana", ops[3]![1]));
        expect(ownerRestore.status).toBe(503);
      }

      const hiddenResp = await h(
        new Request("http://relay.test/sync/account/workspaces/trip", {
          method: "PATCH",
          headers: {
            authorization: "Bearer session:ana:phone",
            "content-type": "application/json",
          },
          body: JSON.stringify({ showOnPhone: false }),
        }),
      );
      expect(hiddenResp.status).toBe(200);
      expect((await h(postOp("trip", "createPage", "ana", ops[0]![1]))).status).toBe(404);
    });
  }
});

describe("idle service-host enrollment retirement, rebind, and delete cleanup", () => {
  async function enrolledStorage() {
    const storage = (await testStorage()) as StorageContext;
    const h = testHandler(storage);
    await claimWorkspace(h, "ana", "trip");
    storage.claimWorkspaceIdentity({
      workspaceId: "trip",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    storage.db
      .prepare(
        `INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
         VALUES ('trip','obj-1',1,'m-1','main','notes/old.md',?,'text',5,1)`,
      )
      .run("a".repeat(64));
    storage.db
      .prepare(
        `INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
          created_at_ms,updated_at_ms,demand_at_ms,owner_demand,accounted_bytes,generation,state,since_ms,changed_by)
         VALUES ('trip','obj-1','notes/old.md','ana',NULL,'epoch','stream',1,1,1,1,1,64,1,'live',1,'server')`,
      )
      .run();
    return storage;
  }

  it("refuses retirement when an editor is connected or room edits/pauses exist", async () => {
    const storage = await enrolledStorage();
    const release = liveEditors(storage).acquire({ workspaceId: "trip", objectId: "obj-1" });
    expect(
      storage.retireIdleServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        ownerUserId: "ana",
        drainNow: true,
        nowMs: 10,
        guard() {},
      }),
    ).toEqual({ status: "active" });
    release();

    storage.db
      .prepare(
        `INSERT INTO ${LIVE_ROOM_EDITS}(workspace_id,main_version_id,object_id,lineage_claim_id,sender_snapshot_json,update_bytes,received_at_ms,storage_bytes)
         VALUES ('trip','main','obj-1','claim-1','[]',X'00',10,16)`,
      )
      .run();
    expect(
      storage.retireIdleServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        ownerUserId: "ana",
        drainNow: true,
        nowMs: 11,
        guard() {},
      }),
    ).toEqual({ status: "unsettled" });

    storage.db.prepare(`DELETE FROM ${LIVE_ROOM_EDITS}`).run();
    const claim = "c".repeat(64);
    storage.db
      .prepare(
        `INSERT INTO sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id,current_path,baseline_moment_relay_seq,baseline_projected_sha256,baseline_projected_byte_length,baseline_digest,baseline_bytes,lineage_state,admission_state,restore_fence_generation,registered_at_ms)
         VALUES ('trip','main','obj-1',?,'notes/old.md',1,?,5,?,X'00','current','open',0,1)`,
      )
      .run(claim, "a".repeat(64), claim);
    storage.db
      .prepare(
        `INSERT INTO ${LIVE_ROOM_PAUSES}(pause_id,workspace_id,main_version_id,object_id,lineage_claim_id,paused_at_ms,saved_cursor,cause,refusal,named_json,copy_bytes,copy_sha256,storage_bytes)
         VALUES ('pause-1','trip','main','obj-1',?,12,0,'failing',NULL,'[]',NULL,?,16)`,
      )
      .run(claim, "b".repeat(64));
    expect(
      storage.retireIdleServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        ownerUserId: "ana",
        drainNow: true,
        nowMs: 13,
        guard() {},
      }),
    ).toEqual({ status: "unsettled" });
  });

  it("retires an idle enrollment, rebinds it after rename, and clears it after delete", async () => {
    const storage = await enrolledStorage();
    const retired = storage.retireIdleServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      ownerUserId: "ana",
      drainNow: true,
      nowMs: 10,
      guard() {},
    });
    expect(retired).toMatchObject({
      status: "retired",
      enrollment: { retired: true, enabled: false, ownerStop: null, hostDrainedAtMs: 10 },
    });
    if (retired.status !== "retired") throw new Error("expected retired");

    // While fenced, a concurrent owner-open cannot restart the retired enrollment.
    let fencedRefusal: unknown;
    try {
      storage.ensureOwnedLiveDocument({
        intent: "owner-open",
        workspaceId: "trip",
        path: "notes/old.md",
        ownerUserId: "ana",
        nowMs: 12,
        guard() {},
      });
    } catch (error) {
      fencedRefusal = error;
    }
    expect(fencedRefusal).toBeInstanceOf(LiveHostingRefusal);
    expect((fencedRefusal as LiveHostingRefusal).reason).toBe("document-unavailable");
    expect(storage.readServiceHostEnrollmentByObjectId("trip", "obj-1")).toMatchObject({
      retired: true,
      enabled: false,
    });

    storage.db
      .prepare(
        `UPDATE sync_relay_object_moments SET path='notes/new.md' WHERE workspace_id='trip' AND object_id='obj-1'`,
      )
      .run();
    const rebound = storage.rebindRetiredServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      toPath: "notes/new.md",
      ownerUserId: "ana",
      guard() {},
    });
    expect(rebound).toMatchObject({
      status: "rebound",
      enrollment: { path: "notes/new.md", retired: true },
    });
    retired.release();

    // Once released, opening at the new path succeeds cleanly.
    expect(
      storage.ensureOwnedLiveDocument({
        intent: "owner-open",
        workspaceId: "trip",
        path: "notes/new.md",
        ownerUserId: "ana",
        nowMs: 15,
        guard() {},
      }),
    ).toMatchObject({ path: "notes/new.md", enabled: true, retired: false });

    const retiredForDelete = storage.retireIdleServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      ownerUserId: "ana",
      drainNow: true,
      nowMs: 16,
      guard() {},
    });
    expect(retiredForDelete.status).toBe("retired");
    if (retiredForDelete.status === "retired") retiredForDelete.release();

    storage.db
      .prepare(
        `UPDATE sync_relay_object_moments SET path=NULL WHERE workspace_id='trip' AND object_id='obj-1'`,
      )
      .run();
    expect(
      storage.clearDrainedDeletedServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        ownerUserId: "ana",
        guard() {},
      }),
    ).toBe(true);
    expect(storage.readServiceHostEnrollmentByObjectId("trip", "obj-1")).toBeNull();
  });

  it("refuses delete retirement when the source has a retained conflict effect", async () => {
    const storage = await enrolledStorage();
    const parentPayload = JSON.stringify({
      conflictId: "c-1",
      targetVersionId: "main",
      sourceVersionId: "main",
      paths: ["notes/old.md", "notes/other.md"],
      current: { present: true, objectId: "obj-1", contentKind: "text", pathRef: 0 },
      result: { present: true, objectId: "obj-1", contentKind: "text", pathRef: 0 },
      effects: [{ kind: "write", momentId: "m-effect" }],
      lineageTransition: null,
    });
    const effectPayload = JSON.stringify({
      momentId: "m-effect",
      versionId: "main",
      objectId: "obj-1",
      path: "notes/old.md",
      conflictId: "c-1",
      conflictEffectIndex: 0,
    });
    storage.db
      .prepare(
        `INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
         VALUES ('trip','origin-1',1,'conflict.resolve',?,2),
                ('trip','origin-1',2,'moment.append',?,3)`,
      )
      .run(parentPayload, effectPayload);

    expect(
      storage.retireIdleServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        ownerUserId: "ana",
        drainNow: true,
        nowMs: 10,
        guard() {},
      }),
    ).toEqual({ status: "unsettled" });
  });

  it("preserves owner Pause across retirement and rebind so opening still refuses as paused", async () => {
    const storage = await enrolledStorage();
    expect(
      storage.setServiceHostEnrollmentEnabled({
        workspaceId: "trip",
        path: "notes/old.md",
        ownerUserId: "ana",
        enabled: false,
        nowMs: 5,
        guard() {},
      }),
    ).toMatchObject({ ownerStop: "pause", note: { state: "off", reason: "paused" } });

    const retired = storage.retireIdleServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      toPath: "notes/new.md",
      ownerUserId: "ana",
      drainNow: true,
      nowMs: 10,
      guard() {},
    });
    expect(retired).toMatchObject({
      status: "retired",
      enrollment: {
        retired: true,
        enabled: false,
        ownerStop: "pause",
        hostDrainedAtMs: 10,
        note: { state: "off", reason: "paused", changedBy: "person:ana" },
      },
    });
    if (retired.status === "retired") retired.release();

    storage.db
      .prepare(
        `UPDATE sync_relay_object_moments SET path='notes/new.md' WHERE workspace_id='trip' AND object_id='obj-1'`,
      )
      .run();
    const rebound = storage.rebindRetiredServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      toPath: "notes/new.md",
      ownerUserId: "ana",
      guard() {},
    });
    expect(rebound).toMatchObject({
      status: "rebound",
      enrollment: {
        path: "notes/new.md",
        ownerStop: "pause",
        note: { state: "off", reason: "paused", changedBy: "person:ana" },
      },
    });

    let refusal: unknown;
    try {
      storage.ensureOwnedLiveDocument({
        intent: "owner-open",
        workspaceId: "trip",
        path: "notes/new.md",
        ownerUserId: "ana",
        nowMs: 15,
        guard() {},
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(LiveHostingRefusal);
    expect((refusal as LiveHostingRefusal).reason).toBe("paused");
  });

  it("clears a safely drained deleted destination enrollment and refuses an undrained one before mutation", async () => {
    const storage = await enrolledStorage();
    storage.db
      .prepare(
        `INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
         VALUES ('trip','obj-old',2,'m-2','main',NULL,?,'text',5,2)`,
      )
      .run("a".repeat(64));
    storage.db
      .prepare(
        `INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,retired,host_drained_at_ms,
          created_at_ms,updated_at_ms,demand_at_ms,owner_demand,accounted_bytes,generation,state,reason,since_ms,changed_by)
         VALUES ('trip','obj-old','notes/new.md','ana',NULL,'epoch','stream',0,1,NULL,1,2,NULL,0,64,1,'off','access-ended',2,'server')`,
      )
      .run();

    // Undrained deleted occupant blocks before mutating source enrollment.
    expect(
      storage.retireIdleServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        toPath: "notes/new.md",
        ownerUserId: "ana",
        drainNow: true,
        nowMs: 10,
        guard() {},
      }),
    ).toEqual({ status: "unsettled" });
    expect(storage.readServiceHostEnrollmentByObjectId("trip", "obj-1")).toMatchObject({
      enabled: true,
      retired: false,
    });
    expect(
      storage.rebindRetiredServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        toPath: "notes/new.md",
        ownerUserId: "ana",
        guard() {},
      }),
    ).toEqual({ status: "blocked" });

    // Once the deleted destination enrollment is drained, rename clears it and rebinds cleanly.
    storage.db
      .prepare(
        `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET host_drained_at_ms=5 WHERE workspace_id='trip' AND object_id='obj-old'`,
      )
      .run();
    const cleared = storage.retireIdleServiceHostEnrollment({
      workspaceId: "trip",
      objectId: "obj-1",
      toPath: "notes/new.md",
      ownerUserId: "ana",
      drainNow: true,
      nowMs: 10,
      guard() {},
    });
    expect(cleared).toMatchObject({ status: "retired" });
    if (cleared.status === "retired") cleared.release();
    expect(storage.readServiceHostEnrollmentByObjectId("trip", "obj-old")).toBeNull();

    storage.db
      .prepare(
        `UPDATE sync_relay_object_moments SET path='notes/new.md' WHERE workspace_id='trip' AND object_id='obj-1'`,
      )
      .run();
    expect(
      storage.rebindRetiredServiceHostEnrollment({
        workspaceId: "trip",
        objectId: "obj-1",
        toPath: "notes/new.md",
        ownerUserId: "ana",
        guard() {},
      }),
    ).toMatchObject({
      status: "rebound",
      enrollment: { path: "notes/new.md", objectId: "obj-1" },
    });
  });

  it("fences live admission for unenrolled objects while a file mutation is in progress", async () => {
    const storage = await enrolledStorage();
    const doc = { workspaceId: "trip", objectId: "obj-unenrolled" };
    expect(serviceHostDocumentEnabled(storage, doc)).toBe(true);
    expect(isObjectMutationFenced(storage, doc.workspaceId, doc.objectId)).toBe(false);

    const fenced = storage.retireIdleServiceHostEnrollment({
      workspaceId: doc.workspaceId,
      objectId: doc.objectId,
      ownerUserId: "ana",
      drainNow: true,
      nowMs: 10,
      guard() {},
    });
    expect(fenced.status).toBe("none");
    if (fenced.status !== "none") throw new Error("expected none");
    expect(isObjectMutationFenced(storage, doc.workspaceId, doc.objectId)).toBe(true);
    expect(serviceHostDocumentEnabled(storage, doc)).toBe(false);

    fenced.release();
    expect(isObjectMutationFenced(storage, doc.workspaceId, doc.objectId)).toBe(false);
    expect(serviceHostDocumentEnabled(storage, doc)).toBe(true);
  });
});
