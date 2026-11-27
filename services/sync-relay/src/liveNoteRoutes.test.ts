import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { parseRedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { createLiveMembershipRegistry } from "./liveMembership.js";
import { createLiveNoteRoutes } from "./liveNoteRoutes.js";
import type { StorageContext } from "./storage/context.js";
import { appendLiveRoomEdit } from "./storage/liveRoomEdits.js";
import { pauseLiveRoom } from "./storage/liveRoomPauses.js";
import { SERVICE_ACTIVATIONS } from "./storage/serviceActivationSchema.js";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment.js";

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
  const sessions = createLiveMembershipRegistry(
    { maxSessions: 8, maxMembers: 8, maxSnapshotBytes: 153 },
    (read) => read(),
  );
  const join = () =>
    sessions.join({
      ticket: parseRedeemedLiveTicket({
        ticketId: "ticket",
        audience: "https://share.invalid",
        authority: {
          principalKind: "named",
          principalId: "reader",
          grantId: "grant",
          grantGeneration: 4,
        },
        binding: {
          ...document,
          currentPath: f.input.evidence.currentPath,
          selectorPaths: ["docs"],
          restoreFenceGeneration: 1,
        },
        hostEpoch: 1,
        mintedAtMs: 0,
        expiresAtMs: 30_000,
        redeemedAtMs: 1,
      }),
      invalidated: new AbortController().signal,
      assertCurrent() {},
    });
  const list = async (workspaceId = "workspace", userId = "owner") =>
    (
      (await createLiveNoteRoutes(f.storage, (workspace) => sessions.liveObjects(workspace))(
        new Request("https://relay.invalid/"),
        { route: "live-notes", workspaceId },
        userId,
      ).json()) as { notes: unknown[] }
    ).notes;
  const listed = (...kinds: string[]) => [
    { objectId: document.objectId, path: f.input.evidence.currentPath, kinds },
  ];
  const enrol = (workspaceId: string, state: string) =>
    f.write((db) =>
      db
        .prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
          created_at_ms,updated_at_ms,demand_at_ms,accounted_bytes,generation,state,since_ms,changed_by) VALUES (?,?,?,'owner',NULL,'epoch','stream',1,1,1,1,64,1,?,1,'server')`)
        .run(workspaceId, document.objectId, f.input.evidence.currentPath, state),
    );
  return { f, document, storage, join, list, listed, enrol };
}

it("lists nothing for a note that is not live anywhere on the relay", async () => {
  const { list } = quietNote();
  expect(await list()).toEqual([]);
});

it("lists a note while someone has it open for live editing, and not once they leave", async () => {
  const { join, list, listed } = quietNote();
  const session = join();
  expect(await list()).toEqual(listed("session"));
  session.close();
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

it("lists a stopped enrolment until the host has drained it", async () => {
  const { f, enrol, list, listed } = quietNote();
  enrol("workspace", "live");
  f.write((db) =>
    db.exec(
      `UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0,retired=1,state='off',reason='stopped',owner_stop='retire'`,
    ),
  );
  expect(await list()).toEqual(listed("enrolment"));
  f.write((db) => db.exec(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET host_drained_at_ms=2`));
  expect(await list()).toEqual([]);
});

it("lists a note enrolled with the automation host once it has started", async () => {
  const { f, enrol, list, listed } = quietNote();
  enrol("workspace", "starting");
  expect(await list()).toEqual([]);
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
  expect(await list("elsewhere")).toEqual([
    { objectId: document.objectId, path: null, kinds: ["enrolment"] },
  ]);
});
