import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";

// PR 0M-5 history flip: the engine store exposes the workspace's moment
// timeline (newest first, keyset-paginated on the global moment order) plus a
// single-moment read with full before/after payloads for the diff page.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-moment-timeline-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const workspaceId = "workspace-timeline";
const write = { origin: "local-file" as const };

describe("versionedTextStore.listMoments", () => {
  it("lists moments newest first with order, metadata, and no payload bodies", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "a.md",
      text: "one\n",
      metadata: write,
    });
    await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "b.md",
      text: "two\n",
      metadata: { origin: "api", summary: "Merged version Draft into Main", correlationId: "merge-1" },
    });
    await store.deleteTextFile({
      workspaceId,
      versionId: "main",
      path: "a.md",
      metadata: { origin: "local-file", summary: "Reconciled offline edits" },
    });

    const page = await store.listMoments({ workspaceId });
    expect(page.moments.map((moment) => [moment.path, moment.operation])).toEqual([
      ["a.md", "delete"],
      ["b.md", "write"],
      ["a.md", "write"],
    ]);
    // Newest first means strictly descending moment order.
    const orders = page.moments.map((moment) => moment.momentOrder);
    expect([...orders].sort((a, b) => b - a)).toEqual(orders);
    expect(page.latestMomentOrder).toBe(orders[0]);
    expect(page.nextBeforeMomentOrder).toBeNull();

    const merged = page.moments[1];
    expect(merged.metadata.summary).toBe("Merged version Draft into Main");
    expect(merged.metadata.correlationId).toBe("merge-1");
    expect(merged.metadata.origin).toBe("api");
    expect(merged.versionId).toBe("main");
    expect(merged.objectId.length).toBeGreaterThan(0);
    // Summaries never haul snapshot text bodies.
    expect("payload" in merged).toBe(false);
  });

  it("paginates with a keyset cursor and never repeats or skips a moment", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    for (let index = 0; index < 7; index += 1) {
      await store.writeTextFile({
        workspaceId,
        versionId: "main",
        path: `notes/file-${index}.md`,
        text: `body ${index}\n`,
        metadata: write,
      });
    }

    const first = await store.listMoments({ workspaceId, limit: 3 });
    expect(first.moments).toHaveLength(3);
    expect(first.nextBeforeMomentOrder).not.toBeNull();
    const second = await store.listMoments({
      workspaceId,
      limit: 3,
      beforeMomentOrder: first.nextBeforeMomentOrder ?? undefined,
    });
    expect(second.moments).toHaveLength(3);
    const third = await store.listMoments({
      workspaceId,
      limit: 3,
      beforeMomentOrder: second.nextBeforeMomentOrder ?? undefined,
    });
    expect(third.moments).toHaveLength(1);
    expect(third.nextBeforeMomentOrder).toBeNull();

    const seen = [...first.moments, ...second.moments, ...third.moments].map(
      (moment) => moment.id,
    );
    expect(new Set(seen).size).toBe(7);
    // Every page keeps the workspace-global latest order so callers can use it
    // as a monotonic refresh key.
    expect(second.latestMomentOrder).toBe(first.latestMomentOrder);
  });

  it("filters by version and by object id", async () => {
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });
    const draft = await store.createNamedVersion({
      workspaceId,
      name: "Draft",
      fromVersionId: main.id,
    });
    const mainWrite = await store.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "shared.md",
      text: "main body\n",
      metadata: write,
    });
    await store.writeTextFile({
      workspaceId,
      versionId: draft.id,
      path: "draft-only.md",
      text: "draft body\n",
      metadata: write,
    });

    const mainPage = await store.listMoments({ workspaceId, versionId: main.id });
    expect(mainPage.moments.map((moment) => moment.path)).toEqual(["shared.md"]);
    const draftPage = await store.listMoments({ workspaceId, versionId: draft.id });
    expect(draftPage.moments.map((moment) => moment.path)).toEqual(["draft-only.md"]);

    const byObject = await store.listMoments({
      workspaceId,
      objectId: mainWrite.object.id,
    });
    expect(byObject.moments.map((moment) => moment.path)).toEqual(["shared.md"]);
  });

  it("fails closed on unknown versions and stays inside the workspace", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await store.ensureMainVersion({ workspaceId: "other-workspace" });
    await store.writeTextFile({
      workspaceId: "other-workspace",
      versionId: "main",
      path: "secret.md",
      text: "other workspace\n",
      metadata: write,
    });

    await expect(
      store.listMoments({ workspaceId, versionId: "no-such-version" }),
    ).rejects.toBeInstanceOf(VersionedTextStoreError);

    const page = await store.listMoments({ workspaceId });
    expect(page.moments).toHaveLength(0);
    expect(page.latestMomentOrder).toBe(-1);
  });
});

describe("versionedTextStore.getMoment", () => {
  it("returns the full before/after payload for one moment", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "doc.md",
      text: "first\n",
      metadata: write,
    });
    const updated = await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "doc.md",
      text: "second\n",
      metadata: { origin: "restore", summary: "Restored doc.md" },
    });

    const moment = await store.getMoment({ workspaceId, momentId: updated.moment.id });
    expect(moment?.payload.before?.text).toBe("first\n");
    expect(moment?.payload.after.text).toBe("second\n");
    expect(moment?.metadata.summary).toBe("Restored doc.md");
    expect(moment?.operation).toBe("write");
  });

  it("returns null for unknown ids and other workspaces' moments", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await store.ensureMainVersion({ workspaceId: "other-workspace" });
    const other = await store.writeTextFile({
      workspaceId: "other-workspace",
      versionId: "main",
      path: "secret.md",
      text: "hidden\n",
      metadata: write,
    });

    expect(await store.getMoment({ workspaceId, momentId: "moment_missing" })).toBeNull();
    expect(
      await store.getMoment({ workspaceId, momentId: other.moment.id }),
    ).toBeNull();
  });
});
