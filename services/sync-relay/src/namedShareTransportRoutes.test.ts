import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import type { StorageContext } from "./storage/context";
import {
  appendLog,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  json,
  jsonBody,
  moment,
  putBlob,
  request,
  sequenced,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "pull-guard";
const TEAM = "wire-team";
const THREAD_REF = "T".repeat(43);
const FILE_REF = "F".repeat(43);
const DATASET_REF = "D".repeat(43);

// A held name lookup: each call waits for the test to let it go.
function heldNames() {
  const waiting: Array<{ release: () => void }> = [];
  let entered: (() => void) | null = null;
  return {
    lookup: async (userId: string) => {
      if (waiting.length > 0) {
        const gate = waiting.shift()!;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate.release = release;
        entered?.();
        await held;
      }
      return userId === OWNER ? "Kim" : "Ana";
    },
    /** Holds the next lookup; resolves once it is waiting, with its release. */
    hold() {
      const gate = { release: () => {} };
      waiting.push(gate);
      return new Promise<() => void>((resolve) => {
        entered = () => resolve(() => gate.release());
      });
    },
  };
}

// The owner's workspace: a file, and a Group, Team, with a thread and a
// message, each with a registered reference. Ana is a member.
async function seed(activity = new DiscussionActivityHub()) {
  const storage = (await testStorage()) as StorageContext;
  const names = heldNames();
  const h = testHandler(storage, {
    lookupUserDisplayName: names.lookup,
    discussionActivity: activity,
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  await putBlob(h, OWNER, WORKSPACE, "Plan");
  await appendLog(
    h,
    OWNER,
    WORKSPACE,
    [moment("notes/plan.md", "Plan", { originSeq: 0, objectId: "plan", recordedAtMs: 1 })],
    { originId: "device" },
  );
  await appendLog(
    h,
    OWNER,
    WORKSPACE,
    sequenced([
      chatChannelCreate(TEAM, { name: "Team", kind: "channel", type: "both" }),
      chatThreadCreate("t-team", TEAM),
      chatMessageAppend("m-team", "t-team", "the surprise is on Friday", {
        authorUserId: OWNER,
      }),
    ]),
    { originId: "chat-device" },
  );
  const registered = await h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/log`,
      jsonBody({
        originId: "reference-probe",
        ops: [],
        workReferences: [
          {
            reference: THREAD_REF,
            target: { kind: "thread", threadId: "t-team", channelId: `channel-${TEAM}` },
            createdAtMs: 1,
          },
          {
            reference: FILE_REF,
            target: { kind: "file", versionId: "main", objectId: "plan" },
            createdAtMs: 2,
          },
        ],
      }),
    ),
  );
  expect(registered.status, await registered.clone().text()).toBe(200);
  const invited = await h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/members/invites`,
      jsonBody({ email: "ana@dohc.test", workspaceName: "Community" }),
    ),
  );
  expect(invited.status, await invited.clone().text()).toBe(200);
  const received = await json(await h(request("ana", "/sync/shares")));
  const shareId = (received.received as Array<Record<string, unknown>>).find(
    (row) => (row.selector as { kind?: string }).kind === "workspace",
  )!.shareId as string;
  expect((await h(request("ana", `/sync/shares/${shareId}/access`))).status).toBe(200);
  const memberId = (
    (await json(invited)).people as Array<{ memberId: string; email: string | null }>
  ).find((person) => person.email === "ana@dohc.test")!.memberId;
  const rule = async (level: string | null) => {
    const response = await h(
      request(OWNER, `/sync/${WORKSPACE}/members/groups/${TEAM}/rule`, {
        ...jsonBody({ level }),
        method: "PUT",
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const pull = (query = "since=0") => h(request("ana", `/sync/shares/${shareId}/log?${query}`));
  return { storage, h, names, shareId, memberId, rule, pull };
}

const mappedTo = (body: Record<string, unknown>) =>
  ((body.workReferences ?? []) as Array<{ reference: string }>).map((row) => row.reference);

describe("a member's raw pull answered across a change", () => {
  it("rebuilds the answer when a Group is hidden while it is assembled, and serves nothing of the Group", async () => {
    const s = await seed();
    const before = await json(await s.pull());
    expect(JSON.stringify(before.ops)).toContain("the surprise");
    expect(mappedTo(before)).toEqual(expect.arrayContaining([THREAD_REF, FILE_REF]));

    const held = s.names.hold();
    const reading = s.pull();
    const release = await held;
    await s.rule("none");
    release();
    const response = await reading;
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json(response);
    const text = JSON.stringify(body);
    expect(text).not.toContain("Team");
    expect(text).not.toContain("the surprise");
    expect(text).not.toContain("t-team");
    expect(mappedTo(body)).not.toContain(THREAD_REF);
    expect(mappedTo(body)).toContain(FILE_REF);

    const later = await json(await s.pull());
    expect(mappedTo(later)).toEqual([FILE_REF]);
  });

  it("rebuilds the answer when a level change lands during a dataset proof", async () => {
    const s = await seed();
    await s.rule("comment");
    const registered = await s.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/log`,
        jsonBody({
          originId: "reference-probe-2",
          ops: [],
          workReferences: [
            {
              reference: DATASET_REF,
              target: {
                kind: "transactionalCollection",
                datasetId: "00000000-0000-4000-8000-000000000001",
                tableId: "00000000-0000-4000-8000-000000000002",
              },
              createdAtMs: 3,
            },
          ],
        }),
      ),
    );
    expect(registered.status, await registered.clone().text()).toBe(200);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const suspended = new Promise<void>((resolve) => {
      entered = resolve;
    });
    s.storage.workReferenceDatasetAccess = async () => {
      s.storage.workReferenceDatasetAccess = async () => () => true;
      entered();
      await waiting;
      return () => true;
    };
    const reading = s.pull();
    await suspended;
    await s.rule("view");
    release();
    const response = await reading;
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json(response);
    const next = await s.pull(`since=${body.nextCursor as string}`);
    expect(next.status, await next.clone().text()).toBe(200);
  });

  it("ends a held pull when a rule hides a Group, with none of its messages", async () => {
    const activity = new DiscussionActivityHub();
    const s = await seed(activity);
    const first = await json(await s.pull());
    const held = s.pull(`since=${first.nextCursor as string}&hold=30000`);
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    // Only the rule's wake ends the hold: nothing else is written.
    await s.rule("none");
    const response = await held;
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ ops: [], levelChanged: true });
    expect(JSON.stringify(body)).not.toContain("the surprise");
  });

  it("answers busy when the rerun is stale too, and not-found when access ends", async () => {
    const s = await seed();
    const first = s.names.hold();
    const reading = s.pull();
    const releaseFirst = await first;
    await s.rule("view");
    const second = s.names.hold();
    releaseFirst();
    // The rerun's own lookup is held while the level changes back.
    const releaseSecond = await second;
    await s.rule("comment");
    releaseSecond();
    const busy = await reading;
    expect(busy.status, await busy.clone().text()).toBe(503);
    expect(await json(busy)).toMatchObject({ code: "server_busy" });
    const clean = await s.pull();
    expect(clean.status).toBe(200);
    expect(JSON.stringify(await json(clean))).toContain("the surprise");

    const held = s.names.hold();
    const revoked = s.pull();
    const release = await held;
    expect(
      (await s.h(request(OWNER, `/sync/${WORKSPACE}/members/${s.memberId}/remove`, jsonBody({}))))
        .status,
    ).toBe(200);
    release();
    expect((await revoked).status).toBe(404);
  });
});
