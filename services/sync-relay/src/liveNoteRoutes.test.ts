import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { liveEditors } from "./liveEditors.js";
import { createLiveNoteRoutes } from "./liveNoteRoutes.js";
import type { StorageContext } from "./storage/context.js";
import { appendLiveRoomEdit } from "./storage/liveRoomEdits.js";
import { pauseLiveRoom } from "./storage/liveRoomPauses.js";
import { SERVICE_ACTIVATIONS } from "./storage/serviceActivationSchema.js";
import {
  moveLiveNoteInTransaction,
  SERVICE_HOST_ENROLLMENTS,
} from "./storage/serviceHostEnrollment.js";

const open: ReturnType<typeof registered>[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  cleanupLiveDeliveryFixtures();
});

function quietNote() {
  const f = registered({ deployment: true });
  open.push(f);
  const document = f.input.evidence.document;
  const storage = f.storage as unknown as StorageContext;
  const list = async (workspaceId = "workspace", userId = "owner") =>
    (
      (await createLiveNoteRoutes(f.storage)(
        new Request("https://relay.invalid/"),
        { route: "live-notes", workspaceId },
        userId,
      ).json()) as { notes: unknown[] }
    ).notes;
  const listed = (...kinds: string[]) => [{ objectId: document.objectId, kinds }];
  const enrol = (workspaceId: string, state: string) =>
    f.write((db) =>
      db
        .prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
          created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes,generation,state,since_ms,changed_by) VALUES (?,?,?,'owner',NULL,'epoch','stream',1,1,1,1,64,1,?,1,'server')`)
        .run(workspaceId, document.objectId, f.input.evidence.currentPath, state),
    );
  return { f, document, storage, list, listed, enrol };
}

it("lists nothing for a note that is not live anywhere on the relay", async () => {
  const { list } = quietNote();
  expect(await list()).toEqual([]);
});

it("lists a note while a live connection holds it, and not once the last one is released", async () => {
  const { f, document, list, listed } = quietNote();
  const editors = liveEditors(f.storage);
  const owner = editors.acquire(document),
    agent = editors.acquire(document),
    elsewhere = editors.acquire({ workspaceId: "elsewhere", objectId: "other" });
  expect(await list()).toEqual(listed("session"));
  owner();
  expect(await list()).toEqual(listed("session"));
  agent();
  elsewhere();
  expect(await list()).toEqual([]);
});

it("lists a note with a hosted activation", async () => {
  const { f, document, list, listed } = quietNote();
  f.write((db) =>
    db
      .prepare(`INSERT INTO ${SERVICE_ACTIVATIONS}(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,accounted_bytes) VALUES ('relay','activation','workspace','main',?,?,'{}','{}',?,x'0000','owner',1)`)
      .run(document.objectId, document.lineageClaimId, "a".repeat(64)),
  );
  expect(await list()).toEqual(listed("activation"));
});

it("lists a note with queued room edits", async () => {
  const { f, document, storage, list, listed } = quietNote();
  const page = new Y.Doc();
  Y.applyUpdate(page, f.input.baselineBytes);
  const before = Y.encodeStateVector(page);
  page.getMap("frontmatter").set("title", "Changed");
  expect(
    appendLiveRoomEdit(storage, {
      document,
      sender: [{ kind: "human", humanId: "ana", humanName: "Ana" }],
      authority: {
        principalKind: "owner",
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      clients: [{ clientId: page.clientID, inNote: false }],
      updateBytes: Y.encodeStateAsUpdate(page, before),
      receivedAtMs: 1,
    }).kind,
  ).toBe("written");
  expect(await list()).toEqual(listed("room-edits"));
});

it("lists a paused note", async () => {
  const { document, storage, list, listed } = quietNote();
  pauseLiveRoom(storage, {
    document,
    cause: "failing",
    refusal: null,
    named: [],
    copy: new Uint8Array([1]),
    pausedAtMs: 1,
  });
  expect(await list()).toEqual(listed("pause"));
});

it("lists a stopped enrolment until the live service host has drained it, and again once reopened", async () => {
  const { f, document, storage, enrol, list, listed } = quietNote();
  enrol("workspace", "live");
  f.write((db) =>
    db.exec(
      `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=1,state='off',reason='stopped',owner_stop='retire'`,
    ),
  );
  expect(await list()).toEqual(listed("enrolment"));
  f.write((db) => db.exec(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET host_drained_at_ms=2`));
  expect(await list()).toEqual([]);
  expect(
    storage.tx(() =>
      moveLiveNoteInTransaction(storage, {
        workspaceId: "workspace",
        objectId: document.objectId,
        generation: 1,
        nowMs: 3,
        move: "start",
        by: "person:owner",
      }),
    ).moved,
  ).toBe(true);
  expect(
    storage.db
      .prepare(`SELECT state,host_drained_at_ms AS drained FROM ${SERVICE_HOST_ENROLLMENTS}`)
      .get(),
  ).toEqual({ state: "starting", drained: null });
  expect(await list()).toEqual(listed("enrolment"));
});

it("lists a note enrolled with the live service host while it starts and once it is live", async () => {
  const { f, enrol, list, listed } = quietNote();
  enrol("workspace", "starting");
  expect(await list()).toEqual(listed("enrolment"));
  f.write((db) => db.exec(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET state='live'`));
  expect(await list()).toEqual(listed("enrolment"));
});

it("refuses anyone but the owner, including a member who can edit", async () => {
  const { list } = quietNote();
  for (const userId of ["reader", "someone"])
    await expect(list("workspace", userId), userId).rejects.toMatchObject({ code: "not_found" });
});

it("never lists another workspace's live notes", async () => {
  const { f, document, enrol, list } = quietNote();
  f.write((db) =>
    db.exec(
      `INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES ('elsewhere','owner',0)`,
    ),
  );
  enrol("elsewhere", "live");
  expect(await list()).toEqual([]);
  expect(await list("elsewhere")).toEqual([{ objectId: document.objectId, kinds: ["enrolment"] }]);
});

it("names the relay's engine floor beside its live notes, so a client behind any proxy reads it", async () => {
  const { f } = quietNote();
  const floor = async (env: Record<string, string>) =>
    (
      (await createLiveNoteRoutes(f.storage, env)(
        new Request("https://relay.invalid/"),
        { route: "live-notes", workspaceId: "workspace" },
        "owner",
      ).json()) as { engineApiMin: unknown }
    ).engineApiMin;
  expect(await floor({ DOHC_RELAY_ENGINE_API_MIN: "2" })).toBe(2);
  expect(await floor({})).toBe(1);
});
