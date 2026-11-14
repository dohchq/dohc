import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { checkAutomationReach, type ReachStep } from "@dohc/automation-executor/automation-reach";
import { readSyncHistory, recordNeverSynced, recordSynced } from "../workspaces/syncHistory";
import { createTestScratch } from "../workspaces/testTemp";
import {
  listRosterGrants,
  lookupHistoryAccounts,
  type ListedGrant,
  type RosterAnswer,
  type RosterListing,
} from "@dohc/automation-executor/roster-listing";
import {
  createShareRosters,
  createHistoryLabels,
  reachRosterFor,
  SHARE_ROSTER_FRESH_MS,
} from "./shareRoster";

const WORKSPACE = "ws-trip";

it.each(["Mira", null, ""])(
  "names the received share's owner from relay identity (name %s)",
  (sharerName) => {
    const shareView = { granterUserId: "u-owner", sharerName, granterEmail: "mira@example.test" };
    const lookupAccounts = vi.fn();
    const names = createHistoryLabels({
      snapshot: () => ({
        roster: null,
        owner: false,
        shareView,
        context: "recipient",
        inventory: undefined,
      }),
      lookupAccounts,
    });
    names.prepare(WORKSPACE, [{ userId: "u-owner" }, { userId: "someone-else" }]);
    expect.soft(names.person(WORKSPACE, "u-owner")).toBe(sharerName || "mira@example.test");
    expect(names.person(WORKSPACE, "someone-else")).toBe("Someone you shared with");
    expect(lookupAccounts).not.toHaveBeenCalled();
    shareView.granterUserId = "";
    expect(names.person(WORKSPACE, "u-owner")).toBe("Someone you shared with");
  },
);
const remote = { serverUrl: "https://server.dohc.test", ownerUserId: "u-owner" };

const facts = {
  shareId: "s-1",
  generation: 1,
  status: "active" as const,
  granterUserId: "u-owner",
  granterEmail: null,
  subjectName: null,
  sharerName: null,
};
const { granterUserId, granterEmail } = facts;

function row(overrides: Record<string, unknown> = {}) {
  return {
    ...facts,
    status: overrides.revokedAtMs ? "revoked" : "active",
    shareId: "s-1",
    workspaceId: WORKSPACE,
    grantId: "g-1",
    principalKind: "user",
    generation: 1,
    recipientUserId: "u-ana",
    recipientEmail: "ana@dohc.test",
    createdAtMs: 1,
    revokedAtMs: null,
    selector: { paths: ["Trip"], versionId: null },
    access: "edit",
    automationsGeneration: null,
    ...overrides,
  };
}

const ana: ListedGrant = {
  ...facts,
  grantId: "g-1",
  recipientUserId: "u-ana",
  recipientEmail: "ana@dohc.test",
  selector: { paths: ["Trip"], versionId: null },
  access: "edit",
};
const anaOnRoster = {
  grantId: "g-1",
  recipientUserId: "u-ana",
  recipientEmail: "ana@dohc.test",
  files: { paths: ["Trip"], versionId: null, access: "edit" },
  channel: null,
};

type Page = { status: number; body: unknown } | Error;

function relay(pages: Record<string, Page>) {
  return vi.fn(async (path: string) => {
    const page = pages[path];
    if (page === undefined) throw new Error(`unexpected ${path}`);
    if (page instanceof Error) throw page;
    return page.body !== null && typeof page.body === "object" && "granted" in page.body
      ? { ...page, body: { granterUserId, granterEmail, ...page.body } }
      : page;
  });
}

async function listed(shares: unknown, links: unknown[] = []): Promise<RosterListing> {
  const answer = await listRosterGrants(
    WORKSPACE,
    relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: shares },
      "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links } },
    }),
  );
  if (answer.kind !== "answered") throw new Error("the relay answered every request");
  return answer.listing;
}

describe("roster from the relay's listings", () => {
  it("isolates History caches and discards responses after account or attachment changes", async () => {
    const roster = await listed({ granted: [] });
    const hold = deferred<Awaited<ReturnType<typeof lookupHistoryAccounts>>>();
    let context = "first-account";
    const lookupAccounts = vi.fn(() => hold.promise);
    const names = createHistoryLabels({
      snapshot: () => ({ roster, owner: true, context, inventory: 1 }),
      lookupAccounts,
    });
    const author = { userId: "u-ben", grantId: "g-dep" };
    const pending = names.prepare(WORKSPACE, [author]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    context = "next-account";
    hold.resolve([
      { ...author, recipientUserId: author.userId, recipientEmail: "Ben", parentGrantId: "g-link" },
    ]);
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
    await names.prepare("another-workspace", [author]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(names.author("another-workspace", author)).toBe("Ben (via share link)");
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
  });

  it("keeps holder data owner-only and retries unavailable History lookups", async () => {
    const roster = await listed({ granted: [] });
    let owner = false;
    const lookupAccounts = vi.fn(async () => null);
    const names = createHistoryLabels({
      snapshot: () => ({ roster, owner, context: "window", inventory: 1 }),
      lookupAccounts,
    });
    const author = { userId: "u-ben", grantId: "g-dep" };
    await names.prepare(WORKSPACE, [author]);
    expect(lookupAccounts).not.toHaveBeenCalled();
    owner = true;
    names.prepare(WORKSPACE, [author]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    names.prepare(WORKSPACE, [author]);
    expect(lookupAccounts).toHaveBeenCalledTimes(1);
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
  });

  it("keeps the owner's active grants on this workspace, and only the person of a revoked one", async () => {
    const group = { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null };
    const listing = await listed({
      ok: true,
      granted: [
        row({ grantId: "g-5" }),
        row({ grantId: "g-revoked", revokedAtMs: 9 }),
        row({
          grantId: "g-link",
          principalKind: "link",
          recipientUserId: null,
          recipientEmail: null,
        }),
        row({
          grantId: "g-4",
          principalKind: "email",
          recipientUserId: null,
          recipientEmail: "cai@dohc.test",
          access: "view",
        }),
        row({ grantId: "g-3", selector: group, access: "read-write", fileScope: "served" }),
        row({ grantId: "g-2", selector: group, access: "read-only", fileScope: "served" }),
        row({
          grantId: "g-1",
          selector: { kind: "chat", channelWireId: "wire-family" },
          access: "read-write",
        }),
        row({ grantId: "g-6", selector: { paths: [], versionId: "v-1" }, access: "edit" }),
      ],
      received: [row({ grantId: "g-received", workspaceId: undefined })],
    });
    expect(listing.grants?.map((grant) => grant.grantId)).toEqual([
      "g-1",
      "g-2",
      "g-3",
      "g-4",
      "g-5",
      "g-6",
    ]);
    expect(listing.grants !== null && listing.endedGrants).toEqual([
      {
        ...facts,
        status: "revoked",
        grantId: "g-revoked",
        recipientUserId: "u-ana",
        recipientEmail: "ana@dohc.test",
      },
    ]);
    const entry: RegistryEntry = {
      workspaceId: WORKSPACE,
      rootPath: "/trip",
      kind: "personal",
      mode: "local-first",
      remote,
    };
    expect(
      reachRosterFor({
        entry,
        localUserId: null,
        localPersonId: null,
        history: null,
        latest: listing,
        next: "",
      }),
    ).toEqual({
      kind: "owner",
      ownerUserId: "u-owner",
      grants: [
        { ...anaOnRoster, files: null, channel: { wireId: "wire-family", canPost: true } },
        {
          ...anaOnRoster,
          grantId: "g-2",
          files: { paths: ["Trip"], versionId: null, access: "view" },
          channel: { wireId: "wire-trip", canPost: false },
        },
        { ...anaOnRoster, grantId: "g-3", channel: { wireId: "wire-trip", canPost: true } },
        {
          grantId: "g-4",
          recipientUserId: null,
          recipientEmail: "cai@dohc.test",
          files: { paths: ["Trip"], versionId: null, access: "view" },
          channel: null,
        },
        { ...anaOnRoster, grantId: "g-5" },
        { ...anaOnRoster, grantId: "g-6", files: { paths: [], versionId: "v-1", access: "edit" } },
      ],
      formerEditors: [],
    });
  });

  it("refuses a row with another workspace or no workspace", async () => {
    expect(
      await listed({
        granted: [
          row({ grantId: "g-2", selector: null, damaged: true, revokedAtMs: 5 }),
          row({
            grantId: "g-3",
            workspaceId: "ws-other",
            selector: null,
            damaged: true,
            access: 7,
            principalKind: 3,
            revokedAtMs: "no",
          }),
          row(),
        ],
      }),
    ).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
    expect(await listed({ granted: [row({ workspaceId: undefined })] })).toEqual({
      grants: null,
      problem: { kind: "unusable-listing" },
    });
  });

  it("finds the evidence to hold a step after the owner revoked, from another computer, a recipient who wrote it", async () => {
    const listing = await listed({ granted: [row({ revokedAtMs: 9, automationsGeneration: 1 })] });
    const entry: RegistryEntry = {
      workspaceId: WORKSPACE,
      rootPath: "/trip",
      kind: "personal",
      mode: "local-first",
      remote,
    };
    const roster = reachRosterFor({
      entry,
      localUserId: null,
      localPersonId: null,
      history: null,
      latest: listing,
      next: "",
    });
    expect(roster).toEqual({
      kind: "owner",
      ownerUserId: "u-owner",
      grants: [],
      formerEditors: [
        {
          grantId: "g-1",
          generation: 1,
          holder: "person",
          recipientEmail: "ana@dohc.test",
          files: { paths: ["Trip"], versionId: null },
        },
      ],
    });
    const [reach] = checkAutomationReach(roster, {
      id: "spend",
      collection: { path: "Trip", name: "Trip" },
      codeFiles: [],
      steps: [{ kind: "change-records", collection: { path: "Budget", name: "Budget" } }],
    });
    expect(reach).toEqual({
      allowed: true,
      formerStops: [{ evidence: "g-1#1", name: "ana@dohc.test" }],
    });
  });
});

describe("keeping the roster current", () => {
  let store: ReturnType<typeof createRegistryStore>;
  let now: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = createRegistryStore(join(await createTestScratch("dohc-roster-"), "workspaces.json"));
    store.register({
      workspaceId: WORKSPACE,
      rootPath: "/trip",
      kind: "personal",
      mode: "local-first",
      remote,
    });
    now = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const answered = (listing: RosterListing): RosterAnswer => ({ kind: "answered", listing });
  const offline: RosterAnswer = {
    kind: "unanswered",
    next: "Check your connection, then try again.",
    partial: false,
  };
  const failing: RosterAnswer = {
    kind: "unanswered",
    next: "Your server is not answering. Try again later.",
    partial: false,
  };
  const cached = {
    kind: "owner",
    ownerUserId: "u-owner",
    grants: [anaOnRoster],
    formerEditors: [],
  };
  const unchecked = (next: string) => ({ kind: "unknown", problem: { kind: "unchecked", next } });

  function seed(): void {
    store.setShareRoster(
      WORKSPACE,
      { grants: [ana], links: [], formerGrants: [], endedGrants: [] },
      false,
    );
  }

  function restart(): void {
    store = createRegistryStore(store.registryFile);
  }

  function rosters(
    listRoster: (workspace: RegistryEntry) => Promise<RosterAnswer>,
    save = store.setShareRoster,
    markRosterPulled = store.markShareRosterPulled,
  ) {
    const logError = vi.fn();
    const list = vi.fn(listRoster);
    const saveRoster = vi.fn(save);
    return {
      list,
      logError,
      saveRoster,
      rosters: createShareRosters({
        findWorkspace: store.find,
        saveRoster,
        markRosterPulled,
        listRoster: list,
        localUserId: async () => null,
        localPersonId: async () => null,
        syncHistory: async () => "never-synced",
        logError,
        nowMs: () => now,
      }),
    };
  }

  it("keeps the mark across a restart, so a claim that runs before any listing answers sees it", async () => {
    const before = rosters(async () =>
      answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }),
    );
    await before.rosters.forRun(WORKSPACE);
    before.rosters.pullStarting(WORKSPACE);
    restart();
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(unchecked(offline.next));
  });

  it("refuses the pull when the mark cannot be saved, and names the write", async () => {
    seed();
    let fail = true;
    const { rosters: r } = rosters(
      async () => failing,
      store.setShareRoster,
      (id) => {
        if (fail) throw new Error("disk full");
        store.markShareRosterPulled(id);
      },
    );
    expect(() => r.pullStarting(WORKSPACE)).toThrow(
      "dohc did not pull because it could not save the share roster's pull mark to the workspace registry: disk full",
    );
    const diskFull = unchecked("Check that your disk has free space, then try again.");
    expect(await r.forRun(WORKSPACE)).toEqual(diskFull);
    expect(await r.forRun(WORKSPACE), "the write failure resolved itself").toEqual(diskFull);
    fail = false;
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("lists once more when a pull lands while the listing a run waits on is running", async () => {
    const first = deferred<RosterAnswer>();
    const { list, rosters: r } = rosters(() => first.promise);
    r.open(WORKSPACE);
    const run = r.forRun(WORKSPACE);
    // A pull lands during that listing, and may bring a new editor's change.
    r.pullStarting(WORKSPACE)();
    list.mockImplementation(async () =>
      answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }),
    );
    first.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    expect(await run, "the run used a listing a pull overlapped").toEqual(cached);
    expect(list).toHaveBeenCalledTimes(2);

    const third = deferred<RosterAnswer>();
    const fourth = deferred<RosterAnswer>();
    list.mockImplementationOnce(() => third.promise).mockImplementationOnce(() => fourth.promise);
    now += SHARE_ROSTER_FRESH_MS;
    const busy = r.forRun(WORKSPACE);
    r.pullStarting(WORKSPACE)();
    third.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    r.pullStarting(WORKSPACE)();
    fourth.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    expect(await busy).toEqual(unchecked("Try again in a moment."));
  });

  it("uses a new listing it could not save, and saves it on the next try", async () => {
    seed();
    let fail = true;
    const { list, rosters: r } = rosters(
      async () => answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }),
      (id, listing, pulledAfter) => {
        if (fail) throw new Error("disk full");
        store.setShareRoster(id, listing, pulledAfter);
      },
    );
    expect(await r.forRun(WORKSPACE)).toEqual({
      kind: "owner",
      ownerUserId: "u-owner",
      grants: [],
      formerEditors: [],
    });
    expect(store.find(WORKSPACE)?.shareRoster?.grants).toEqual([ana]);
    fail = false;
    expect(await r.forRun(WORKSPACE)).toEqual({
      kind: "owner",
      ownerUserId: "u-owner",
      grants: [],
      formerEditors: [],
    });
    expect(list, "the retry listed again instead of saving what it knew").toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({
      version: 2,
      grants: [],
      links: [],
      formerGrants: [],
      endedGrants: [],
    });
  });
});

describe("a shared workspace forgotten and attached again", () => {
  const trip = { path: "Trip", name: "Trip" };
  // Steps Ana could have written into Trip/automations.yaml: one that acts
  // as the owner, and one that changes a Collection only the owner can edit.
  const steps: ReachStep[] = [
    { kind: "personal", person: { userId: "u-owner", name: "you" } },
    { kind: "change-records", collection: { path: "Budget", name: "Budget" } },
    { kind: "change-records", collection: trip },
  ];

  it("stops a collaborator's steps until the workspace syncs again, then checks them against its grants", async () => {
    const root = await createTestScratch("dohc-reattach-");
    const store = createRegistryStore(
      join(await createTestScratch("dohc-reattach-registry-"), "workspaces.json"),
    );
    const listing = { grants: [ana], links: [], formerGrants: [], endedGrants: [] };
    let now = 0;
    const rosters = createShareRosters({
      findWorkspace: store.find,
      saveRoster: store.setShareRoster,
      markRosterPulled: store.markShareRosterPulled,
      listRoster: async () => ({ kind: "answered", listing }),
      localUserId: async () => "u-owner",
      localPersonId: async () => null,
      syncHistory: (workspace) => readSyncHistory(workspace.rootPath),
      logError: vi.fn(),
      nowMs: () => now,
    });
    const check = async () =>
      checkAutomationReach(await rosters.forRun(WORKSPACE), {
        id: "a",
        collection: trip,
        codeFiles: [],
        steps,
      });

    await mkdir(join(root, ".dohc"));
    await recordNeverSynced(root, { installId: "install-here", label: "This Mac" });
    store.register({
      workspaceId: WORKSPACE,
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    });
    await recordSynced(root);
    store.setRemote(WORKSPACE, remote);
    const shared = await check();
    expect(shared.map((reach) => reach.allowed)).toEqual([false, false, true]);

    store.remove(WORKSPACE);
    store.register({
      workspaceId: WORKSPACE,
      rootPath: root,
      kind: "personal",
      mode: "local-first",
    });
    const reason =
      "dohc could not check who can edit Trip. Sync this workspace in Settings → Sync and sharing, then try again.";
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));

    const record = join(root, ".dohc", "sync-history.json");
    const synced = await readFile(record, "utf8");
    await writeFile(record, synced.slice(0, 10));
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));
    await rm(record);
    await mkdir(record);
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));
    await rm(record, { recursive: true });
    await writeFile(record, synced);

    store.setRemote(WORKSPACE, remote);
    expect(await check()).toEqual(steps.map(() => expect.objectContaining({ allowed: false })));
    now += SHARE_ROSTER_FRESH_MS;
    expect(await check()).toEqual(shared);
  });
});
