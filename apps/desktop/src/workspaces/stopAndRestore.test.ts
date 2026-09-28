import { describe, expect, it, vi } from "vitest";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId, definitionHash } from "@dohc/automation-executor/automation-plan";
import { restoreDirectWrites, type DirectWriteFile, type StopAndRestoreDependencies } from "./stopAndRestore";

const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const SCHEMA_TWO = "name: Packing\nfields:\n  Title:\n    type: text\n  Count:\n    type: number\n";
const STAMP = "  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Packed\n";
const WIPE = "  - id: wipe\n    name: Wipe\n    when: record-added\n    do:\n      - set:\n          Title: gone\n";
const WIPE_TWO = "  - id: wipe\n    name: Wipe\n    when: record-added\n    do:\n      - set:\n          Title: really gone\n";
const OWNERS = "  - id: owners\n    name: Owners\n    when: record-added\n    do:\n      - set:\n          Title: mine\n";
const automations = (...items: string[]) => `version: 1\nautomations:\n${items.join("")}`;
const RECORD = "---\nTitle: Tent\n---\n";

function moment(id: string, objectId: string, path: string, before: string | null, after: string | null): VersionedTextMoment {
  return {
    id,
    workspaceId: "workspace",
    versionId: "main",
    objectId,
    path,
    recordedAtMs: 1,
    operation: after === null ? "delete" : "write",
    payload: {
      before: before === null ? null : { path, text: before },
      after: { path, text: after ?? before ?? "" },
    },
    metadata: { origin: "sync" },
  };
}

/**
 * An engine over a list of moments, oldest first. A restore appends a
 * moment that puts the file back, as History does.
 */
function engine(moments: VersionedTextMoment[], folders: Record<string, string[]> = {}) {
  const all = [...moments];
  const restored: string[] = [];
  const refused = new Set<string>();
  const changedAtRestore = new Set<string>();
  const failing = new Map<string, Error>();
  // Files another queued operation adds to a folder just before a restore runs.
  const addedAtRestore = new Map<string, string>();
  const dependencies = {
    moment: vi.fn(async (id: string) => all.find((item) => item.id === id) ?? null),
    momentsAfter: vi.fn(async (objectId: string, id: string) => {
      const mine = all.filter((item) => item.objectId === objectId);
      return mine.slice(mine.findIndex((item) => item.id === id) + 1).map((item) => item.id).reverse();
    }),
    assertCurrent: vi.fn(),
    restore: vi.fn<StopAndRestoreDependencies["restore"]>(async (id, expectedHead, aloneInFolder) => {
      const target = all.find((item) => item.id === id)!;
      if (failing.has(id)) throw failing.get(id)!;
      if (refused.has(id)) return { kind: "refused", detail: "This action is unavailable for shared live files." };
      const heads = all.filter((item) => item.objectId === target.objectId);
      if (changedAtRestore.has(id) || heads.at(-1)!.id !== expectedHead) return { kind: "changed" };
      const targetFolder = target.path.slice(0, target.path.lastIndexOf("/"));
      const added = addedAtRestore.get(id);
      if (added) folders[targetFolder] = [...(folders[targetFolder] ?? []), added];
      if (aloneInFolder && (folders[targetFolder] ?? []).some((entry) => !target.path.endsWith(`/${entry}`))) {
        return { kind: "folder-in-use" };
      }
      const back = moment(`back-${id}`, target.objectId, target.path, heads.at(-1)!.payload.after.text, target.payload.before?.text ?? null);
      all.push(back);
      restored.push(id);
      const folder = target.path.slice(0, target.path.lastIndexOf("/"));
      const name = target.path.slice(target.path.lastIndexOf("/") + 1);
      if (target.payload.before === null) folders[folder] = (folders[folder] ?? []).filter((entry) => entry !== name);
      return { kind: "restored", receipt: { path: target.path, restoredMomentId: back.id } };
    }),
    folderEntries: vi.fn(async (path: string) => folders[path] ?? []),
    removeEmptyFolder: vi.fn(async () => undefined),
    undoRuns: vi.fn(async (_definitions: ReadonlyArray<{ automationId: string; definitionHash: string }>) => ({ undone: 2, left: 1, kept: 3, errorMessage: null as string | null })),
  };
  return { dependencies, restored, refused, changedAtRestore, failing, addedAtRestore, all };
}

function file(momentId: string, objectId: string, path: string, created = false): DirectWriteFile {
  return { momentId, objectId, path, created };
}

function definitionOf(text: string, id: string): string {
  const parsed = parseAutomationsFile(text);
  if (parsed.status !== "read") throw new Error("fixture does not read");
  const entry = parsed.entries.find((candidate) => candidate.status === "valid" && candidate.automation.id === id);
  if (entry?.status !== "valid") throw new Error("fixture has no such automation");
  return definitionHash(entry.automation);
}

describe("restoring what a person wrote directly", () => {
  it("puts each file back before their first write, automations first, and undoes only the definitions each write added", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const autoOne = moment("m-auto-1", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const autoTwo = moment("m-auto-2", "o-auto", "trip/packing/automations.yaml", automations(STAMP, WIPE), automations(STAMP, WIPE_TWO));
    const { dependencies, restored } = engine([schema, autoOne, autoTwo]);

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-schema", "o-schema", "trip/packing/collection.yaml"),
      file("m-auto-1", "o-auto", "trip/packing/automations.yaml"),
      file("m-auto-2", "o-auto", "trip/packing/automations.yaml"),
    ]);

    expect(restored).toEqual(["m-auto-1", "m-schema"]);
    expect(dependencies.restore.mock.calls).toEqual([["m-auto-1", "m-auto-2", false], ["m-schema", "m-schema", false]]);
    expect(outcome).toEqual({
      status: "restored",
      restored: [
        { path: "trip/packing/automations.yaml", restoredMomentId: "back-m-auto-1" },
        { path: "trip/packing/collection.yaml", restoredMomentId: "back-m-schema" },
      ],
      review: [],
      runsUndone: 2,
      runsLeft: 1,
      runChangesKept: 3,
      wroteAutomations: true,
      sendsMessages: false,
      errorMessage: null,
    });
    const wipe = collectionAutomationId("trip/packing", "wipe");
    expect(dependencies.undoRuns.mock.calls[0]![0]).toEqual([
      { automationId: wipe, definitionHash: definitionOf(automations(WIPE), "wipe") },
      { automationId: wipe, definitionHash: definitionOf(automations(WIPE_TWO), "wipe") },
    ]);
  });

  it("says an automation they wrote sends messages, which no Undo takes back", async () => {
    const NOTIFY = "  - id: tell\n    name: Tell\n    when: record-added\n    do:\n      - notify: Packed\n        to: [user_owner]\n";
    const auto = moment("m-auto", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, NOTIFY));
    expect(parseAutomationsFile(automations(NOTIFY))).toMatchObject({ status: "read", entries: [{ status: "valid" }] });
    const { dependencies } = engine([auto]);
    await expect(restoreDirectWrites(dependencies, [file("m-auto", "o-auto", "trip/packing/automations.yaml")]))
      .resolves.toMatchObject({ wroteAutomations: true, sendsMessages: true });
    // A schema alone wrote no automation.
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const other = engine([schema]);
    await expect(restoreDirectWrites(other.dependencies, [file("m-schema", "o-schema", "trip/packing/collection.yaml")]))
      .resolves.toMatchObject({ wroteAutomations: false, sendsMessages: false, runsUndone: 0, runChangesKept: 0 });
    expect(other.dependencies.undoRuns).not.toHaveBeenCalled();
  });

  it("keeps what undoing some runs found when a later run's Undo fails", async () => {
    const auto = moment("m-auto", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const { dependencies } = engine([auto]);
    dependencies.undoRuns.mockResolvedValueOnce({ undone: 1, left: 0, kept: 4, errorMessage: "The workspace engine is not running." });
    await expect(restoreDirectWrites(dependencies, [file("m-auto", "o-auto", "trip/packing/automations.yaml")])).resolves.toMatchObject({
      restored: [{ path: "trip/packing/automations.yaml" }],
      runsUndone: 1,
      runChangesKept: 4,
      errorMessage: "The workspace engine is not running.",
    });
  });

  it("does not blame the person for an automation the owner added between their writes", async () => {
    const theirs = moment("m-auto-1", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const owner = moment("m-owner", "o-auto", "trip/packing/automations.yaml", automations(STAMP, WIPE), automations(STAMP, WIPE, OWNERS));
    const again = moment("m-auto-2", "o-auto", "trip/packing/automations.yaml", automations(STAMP, WIPE, OWNERS), automations(STAMP, WIPE_TWO, OWNERS));
    const { dependencies, restored } = engine([theirs, owner, again]);

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-auto-1", "o-auto", "trip/packing/automations.yaml"),
      file("m-auto-2", "o-auto", "trip/packing/automations.yaml"),
    ]);

    // The owner's change between theirs keeps the file for review.
    expect(restored).toEqual([]);
    expect(outcome).toMatchObject({ review: [{ path: "trip/packing/automations.yaml", reason: "changed-since" }] });
    const definitions = dependencies.undoRuns.mock.calls[0]![0].map((definition) => definition.automationId);
    expect(definitions).not.toContain(collectionAutomationId("trip/packing", "owners"));
    expect(definitions).toEqual([collectionAutomationId("trip/packing", "wipe"), collectionAutomationId("trip/packing", "wipe")]);
  });

  it("lists a file someone changed since for review, and passes over one already as it was", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const later = moment("m-owner", "o-schema", "trip/packing/collection.yaml", SCHEMA_TWO, `${SCHEMA_TWO}# mine\n`);
    const auto = moment("m-auto", "o-auto", "trip/other/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const putBack = moment("m-back", "o-auto", "trip/other/automations.yaml", automations(STAMP, WIPE), automations(STAMP));
    const { dependencies, restored } = engine([schema, later, auto, putBack]);

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-schema", "o-schema", "trip/packing/collection.yaml"),
      file("m-auto", "o-auto", "trip/other/automations.yaml"),
    ]);

    expect(restored).toEqual([]);
    expect(outcome).toMatchObject({ restored: [], review: [{ path: "trip/packing/collection.yaml", reason: "changed-since" }] });
  });

  it("sends a file that changed after the check to review, restoring nothing over it", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const { dependencies, restored, changedAtRestore } = engine([schema]);
    changedAtRestore.add("m-schema");

    const outcome = await restoreDirectWrites(dependencies, [file("m-schema", "o-schema", "trip/packing/collection.yaml")]);

    expect(restored).toEqual([]);
    expect(outcome).toMatchObject({ restored: [], review: [{ path: "trip/packing/collection.yaml", reason: "changed-since" }] });
  });

  it("waits, changing nothing, until every change the person wrote is here", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const { dependencies } = engine([schema]);

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-schema", "o-schema", "trip/packing/collection.yaml"),
      file("m-record", "o-record", "trip/ideas/a.md", true),
    ]);

    expect(outcome).toEqual({ status: "waiting" });
    expect(dependencies.momentsAfter).not.toHaveBeenCalled();
    expect(dependencies.restore).not.toHaveBeenCalled();
  });

  it("removes a Collection they created, schema last, and its empty folder", async () => {
    const schema = moment("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", null, SCHEMA);
    const record = moment("m-new-record", "o-new-record", "trip/ideas/a.md", null, RECORD);
    const { dependencies, restored } = engine([schema, record], { "trip/ideas": ["collection.yaml", "a.md"] });

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", true),
      file("m-new-record", "o-new-record", "trip/ideas/a.md", true),
    ]);

    expect(restored).toEqual(["m-new-record", "m-new-schema"]);
    expect(dependencies.removeEmptyFolder).toHaveBeenCalledWith("trip/ideas");
    expect(outcome).toMatchObject({ review: [] });
  });

  it("keeps a Collection they created, with a reason, when someone else's file remains in it", async () => {
    const schema = moment("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", null, SCHEMA);
    const record = moment("m-new-record", "o-new-record", "trip/ideas/a.md", null, RECORD);
    const { dependencies, restored } = engine([schema, record], { "trip/ideas": ["collection.yaml", "a.md", "mine.md"] });

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", true),
      file("m-new-record", "o-new-record", "trip/ideas/a.md", true),
    ]);

    expect(restored).toEqual(["m-new-record"]);
    expect(dependencies.removeEmptyFolder).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ review: [{ path: "trip/ideas/collection.yaml", reason: "folder-in-use" }] });
  });

  it("keeps a created Collection's schema when History will not restore one of its records", async () => {
    const schema = moment("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", null, SCHEMA);
    const record = moment("m-new-record", "o-new-record", "trip/ideas/a.md", null, RECORD);
    const { dependencies, restored, refused } = engine([schema, record], { "trip/ideas": ["collection.yaml", "a.md"] });
    refused.add("m-new-record");

    const outcome = await restoreDirectWrites(dependencies, [
      file("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", true),
      file("m-new-record", "o-new-record", "trip/ideas/a.md", true),
    ]);

    expect(restored).toEqual([]);
    expect(outcome).toMatchObject({
      review: [
        { path: "trip/ideas/a.md", reason: "restore-refused", detail: "This action is unavailable for shared live files." },
        { path: "trip/ideas/collection.yaml", reason: "folder-in-use" },
      ],
    });
  });

  it("keeps a created Collection's schema when a file lands in its folder as the schema's restore runs", async () => {
    const schema = moment("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", null, SCHEMA);
    const { dependencies, restored, addedAtRestore } = engine([schema], { "trip/ideas": ["collection.yaml"] });
    addedAtRestore.set("m-new-schema", "queued.md");

    const outcome = await restoreDirectWrites(dependencies, [file("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", true)]);

    expect(dependencies.restore).toHaveBeenCalledWith("m-new-schema", "m-new-schema", true);
    expect(restored).toEqual([]);
    expect(dependencies.removeEmptyFolder).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ review: [{ path: "trip/ideas/collection.yaml", reason: "folder-in-use" }] });
  });

  it("stops, removing nothing, when it cannot read a created Collection's folder", async () => {
    const schema = moment("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", null, SCHEMA);
    const { dependencies, restored } = engine([schema]);
    dependencies.folderEntries.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));

    await expect(restoreDirectWrites(dependencies, [file("m-new-schema", "o-new-schema", "trip/ideas/collection.yaml", true)]))
      .resolves.toMatchObject({ restored: [], review: [], errorMessage: "EACCES: permission denied" });
    expect(restored).toEqual([]);
  });

  it("stops at a restore that fails for another reason, answering what went before", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const auto = moment("m-auto", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const { dependencies, failing } = engine([schema, auto]);
    failing.set("m-schema", new Error("The workspace engine is not running."));

    await expect(restoreDirectWrites(dependencies, [
      file("m-schema", "o-schema", "trip/packing/collection.yaml"),
      file("m-auto", "o-auto", "trip/packing/automations.yaml"),
    ])).resolves.toMatchObject({
      restored: [{ path: "trip/packing/automations.yaml", restoredMomentId: "back-m-auto" }],
      review: [],
      errorMessage: "The workspace engine is not running.",
    });
    expect(dependencies.undoRuns).not.toHaveBeenCalled();
  });

  it("answers what it restored when undoing the automations fails, and a second try passes those files over", async () => {
    const schema = moment("m-schema", "o-schema", "trip/packing/collection.yaml", SCHEMA, SCHEMA_TWO);
    const auto = moment("m-auto", "o-auto", "trip/packing/automations.yaml", automations(STAMP), automations(STAMP, WIPE));
    const { dependencies } = engine([schema, auto]);
    dependencies.undoRuns.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    const files = [
      file("m-schema", "o-schema", "trip/packing/collection.yaml"),
      file("m-auto", "o-auto", "trip/packing/automations.yaml"),
    ];

    await expect(restoreDirectWrites(dependencies, files)).resolves.toMatchObject({
      restored: [
        { path: "trip/packing/automations.yaml", restoredMomentId: "back-m-auto" },
        { path: "trip/packing/collection.yaml", restoredMomentId: "back-m-schema" },
      ],
      errorMessage: "The workspace engine is not running.",
    });
    await expect(restoreDirectWrites(dependencies, files)).resolves.toMatchObject({
      restored: [],
      review: [],
      runsUndone: 2,
      errorMessage: null,
    });
    expect(dependencies.restore).toHaveBeenCalledTimes(2);
  });
});
