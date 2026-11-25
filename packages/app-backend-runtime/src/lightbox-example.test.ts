import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDefinition } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import { privateFolder } from "./private-folder.test-helper";

type Caller = "owner" | "mara" | "theo";
type Result = Record<string, any>;
type File = {
  fileId: string;
  name: string;
  contentType: string;
  byteLength: number;
  sha256: string;
};

const read = (file: string) =>
  readFileSync(new URL(`../../../examples/lightbox/proofing/${file}`, import.meta.url), "utf8");
const CODE = "GOLD-HOUR-2026";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const image = (fileId: string, contentType = "image/png", byteLength = 2048): File => ({
  fileId,
  name: `${fileId}.png`,
  contentType,
  byteLength,
  sha256: "b".repeat(64),
});

async function fixture() {
  const definition = parseDatasetDefinition(JSON.parse(read("dataset.json")), {
    descriptorPath: "lightbox/proofing/dataset.json",
  });
  const schemaSql = read("schema.sql");
  const operationSource = read("operations.js");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const directory = await mkdtemp(join(tmpdir(), "dohc-lightbox-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE attachments(file_id TEXT PRIMARY KEY);");
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({
    journal,
    directory: privateFolder(join(directory, "workers")),
  });
  cleanups.push(async () => {
    await supervisor.close();
    db.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  const files: File[] = [];
  const host = createDatasetHost<Caller>({
    db,
    transaction,
    journal,
    supervisor,
    resolveAuthority(caller, request) {
      if (request.access.kind === "app" && !["studio", "portal"].includes(request.access.appId))
        throw new Error("Wrong app credential");
      return {
        principalKey: caller,
        ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller:
          caller === "owner"
            ? { kind: "owner", userId: "owner" }
            : { kind: "link", principalId: `principal-${caller}`, grantId: "proofing-link" },
      };
    },
    compileOperations: async (source) => source,
    operationResources: () => ({
      files: [...files],
      accountAndAttach: (candidate) => {
        for (const fileId of candidate.attachedFileIds) {
          db.prepare("INSERT OR IGNORE INTO attachments VALUES(?)").run(fileId);
          const index = files.findIndex((entry) => entry.fileId === fileId);
          if (index >= 0) files.splice(index, 1);
        }
      },
    }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource });
  const binding = (access: "link" | "all") => ({
    kind: "dataset" as const,
    datasetId: definition.datasetId,
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationIds: definition.operations
      .filter((operation) => access === "all" || operation.access === "link")
      .map((operation) => operation.operationId),
  });
  host.setBinding("owner", { ...scope, appId: "portal", binding: binding("link") });
  host.setBinding("owner", { ...scope, appId: "studio", binding: binding("all") });
  const operation = (name: string) => {
    const found = definition.operations.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Unknown operation ${name}`);
    return found;
  };
  let sequence = 0;
  const request = (name: string, input: AppBackendJson, caller: Caller) => ({
    ...scope,
    revision: 1,
    revisionSha256: revision.revisionSha256,
    operationId: operation(name).operationId,
    input,
    idempotencyKey: `call-${++sequence}`,
    access: { kind: "app" as const, appId: caller === "owner" ? "studio" : "portal" },
  });
  const call = async (name: string, input: AppBackendJson, caller: Caller = "mara") =>
    (await host.invoke(caller, request(name, input, caller))).result as Result;
  const refusal = (name: string, input: AppBackendJson, caller: Caller = "mara") =>
    expect(host.invoke(caller, request(name, input, caller))).rejects;
  const openFile = (name: string, input: AppBackendJson, fileId: string, caller: Caller = "mara") =>
    host.readOperation(caller, request(name, input, caller), (result) => {
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).length !== 1 ||
        result.fileId !== fileId
      )
        throw new Error("This action does not grant access to the file.");
      return "granted";
    });
  return { host, db, call, refusal, openFile, files, request };
}

async function send(f: Awaited<ReturnType<typeof fixture>>, caller?: Caller) {
  const shown = (await f.call("listPublishedAssets", { code: CODE }, caller)).assets
    .filter((asset: Result) => asset.picked)
    .map((asset: Result) => asset.id);
  return f.call("submitSelection", { code: CODE, assetIds: shown }, caller);
}

const previewFor = (file: File) => image(`prev_${file.fileId.slice(5)}`, "image/jpeg", 200 * 1024);

async function upload(f: Awaited<ReturnType<typeof fixture>>, file: File, title: string) {
  const preview = previewFor(file);
  f.files.push(file, preview);
  return f.call(
    "uploadAsset",
    {
      shootId: "shoot_positano",
      fileId: file.fileId,
      previewFileId: preview.fileId,
      width: 3000,
      height: 2000,
      title,
    },
    "owner",
  );
}

describe("Lightbox proofing Collection", () => {
  it("shows link callers only published photos and no owner-only fields", async () => {
    const f = await fixture();
    const gallery = await f.call("listPublishedAssets", { code: CODE });
    expect(gallery.gallery).toEqual({
      title: "Golden hour in Positano",
      clientName: "Mara & Theo",
      shotOn: "2026-09-14",
      status: "proofing",
      selectionLimit: 12,
      picksUsed: 0,
      sentAtMs: null,
      sentPicks: 0,
      changedSinceSent: false,
    });
    expect(gallery.assets).toHaveLength(13);
    const publicIds = gallery.assets.map((asset: Result) => asset.id);
    for (const hidden of ["pos_0140", "pos_0152", "pos_0167"])
      expect(publicIds).not.toContain(hidden);
    const serialized = JSON.stringify(gallery);
    for (const secret of ["internal", "280000", "GOLDHOUR2026", "rating", "colorLabel", "green"])
      expect(serialized).not.toContain(secret);
    expect(Object.keys(gallery.assets[0]).sort()).toEqual([
      "demoScene",
      "fileId",
      "height",
      "id",
      "mimeType",
      "noteCount",
      "openNoteCount",
      "picked",
      "previewFileId",
      "sent",
      "sortOrder",
      "title",
      "width",
    ]);
    await f.refusal("listPublishedAssets", { code: "NOVE7KQ2X9PD" }).toMatchObject({
      refusal: { code: "gallery_not_found" },
    });
    await f.refusal("listAnnotations", { code: CODE, assetId: "pos_0167" }).toMatchObject({
      refusal: { code: "not_found" },
    });
    const owner = await f.call("listShoots", {}, "owner");
    expect(owner.shoots.map((shoot: Result) => shoot.internalRateCents)).toEqual([450000, 280000]);
  });

  it("pages a large gallery without skipping or repeating photos", async () => {
    const f = await fixture();
    const first = await f.call("listPublishedAssets", { code: CODE, limit: 5 });
    const second = await f.call("listPublishedAssets", {
      code: CODE,
      limit: 5,
      after: first.nextCursor,
    });
    const third = await f.call("listPublishedAssets", {
      code: CODE,
      limit: 5,
      after: second.nextCursor,
    });
    const ids = [...first.assets, ...second.assets, ...third.assets].map(
      (asset: Result) => asset.id,
    );
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps each reviewer within the selection limit in one SQL statement", async () => {
    const f = await fixture();
    await f.call("updateShoot", { shootId: "shoot_positano", selectionLimit: 5 }, "owner");
    const ids = ["pos_0012", "pos_0027", "pos_0031", "pos_0044", "pos_0058", "pos_0063"];
    for (const assetId of ids.slice(0, 5))
      await f.call("toggleClientPick", { code: CODE, assetId, selected: true });
    await f
      .refusal("toggleClientPick", { code: CODE, assetId: ids[5]!, selected: true })
      .toMatchObject({
        refusal: {
          code: "selection_limit_reached",
          message: expect.stringContaining("5 of 5"),
        },
      });
    expect(
      await f.call("toggleClientPick", { code: CODE, assetId: ids[0]!, selected: true }),
    ).toMatchObject({ picksUsed: 5 });
    expect(
      await f.call("toggleClientPick", { code: CODE, assetId: ids[1]!, selected: false }),
    ).toMatchObject({
      selected: false,
      picksUsed: 4,
    });
    expect(
      await f.call("toggleClientPick", { code: CODE, assetId: ids[5]!, selected: true }),
    ).toMatchObject({
      picksUsed: 5,
    });
    expect(
      await f.call("toggleClientPick", { code: CODE, assetId: ids[1]!, selected: true }, "theo"),
    ).toMatchObject({ picksUsed: 1 });

    const racers = await Promise.allSettled(
      ["pos_0058", "pos_0063", "pos_0071", "pos_0086", "pos_0090", "pos_0104"].map((assetId) =>
        f.call("toggleClientPick", { code: CODE, assetId, selected: true }, "theo"),
      ),
    );
    expect(racers.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(4);
    const theo = await f.call("listPublishedAssets", { code: CODE }, "theo");
    expect(theo.gallery.picksUsed).toBe(5);
    expect(theo.assets.filter((asset: Result) => asset.picked)).toHaveLength(5);
  });

  it("refuses republishing a hidden pick or lowering the limit past an existing reviewer's picks", async () => {
    const f = await fixture();
    await f.call("updateShoot", { shootId: "shoot_positano", selectionLimit: 5 }, "owner");
    const shoot = await f.call(
      "createShoot",
      { title: "One pick", clientName: "Ada", shotOn: "2026-11-02", selectionLimit: 1 },
      "owner",
    );
    await f.call("updateShoot", { shootId: shoot.id, status: "proofing" }, "owner");
    const uploadTo = async (fileId: string, title: string) => {
      const file = image(fileId);
      const preview = previewFor(file);
      f.files.push(file, preview);
      return f.call(
        "uploadAsset",
        {
          shootId: shoot.id,
          fileId,
          previewFileId: preview.fileId,
          width: 1200,
          height: 800,
          title,
        },
        "owner",
      );
    };
    const first = await uploadTo("file_cap_a_000000001", "CAP_A");
    const second = await uploadTo("file_cap_b_000000002", "CAP_B");
    await f.call("publishAsset", { assetIds: [first.id, second.id], published: true }, "owner");

    await f.call("toggleClientPick", { code: shoot.accessCode, assetId: first.id, selected: true });
    await f.call("publishAsset", { assetIds: [first.id], published: false }, "owner");
    await f.call("toggleClientPick", {
      code: shoot.accessCode,
      assetId: second.id,
      selected: true,
    });
    await f
      .refusal("publishAsset", { assetIds: [first.id], published: true }, "owner")
      .toMatchObject({ refusal: { code: "selection_limit_exceeded" } });
    expect(
      (await f.call("listPublishedAssets", { code: shoot.accessCode })).gallery.picksUsed,
    ).toBe(1);

    await f.call("updateShoot", { shootId: shoot.id, selectionLimit: 2 }, "owner");
    await f.call("publishAsset", { assetIds: [first.id], published: true }, "owner");
    expect(
      (await f.call("listPublishedAssets", { code: shoot.accessCode })).gallery.picksUsed,
    ).toBe(2);
    await f
      .refusal("updateShoot", { shootId: shoot.id, selectionLimit: 1 }, "owner")
      .toMatchObject({ refusal: { code: "selection_limit_too_low" } });

    await f.call("submitSelection", { code: shoot.accessCode, assetIds: [first.id, second.id] });
    await f.call("toggleClientPick", {
      code: shoot.accessCode,
      assetId: first.id,
      selected: false,
    });
    await f.call("publishAsset", { assetIds: [first.id], published: false }, "owner");
    await f.call("updateShoot", { shootId: shoot.id, selectionLimit: 1 }, "owner");
    await f
      .refusal("publishAsset", { assetIds: [first.id], published: true }, "owner")
      .toMatchObject({ refusal: { code: "selection_limit_exceeded" } });
  });

  it("validates pinned note positions and text", async () => {
    const f = await fixture();
    const base = { code: CODE, assetId: "pos_0012", authorName: "Mara", body: "Warmer?" };
    const saved = await f.call("addPinnedAnnotation", { ...base, xPct: 12.3456, yPct: 100 });
    expect(saved).toMatchObject({ xPct: 12.35, yPct: 100, resolved: false, authorName: "Mara" });
    for (const [xPct, yPct] of [
      [-0.01, 50],
      [50, 100.01],
      [null, 5],
      ["50", 5],
    ] as const)
      await f.refusal("addPinnedAnnotation", { ...base, xPct, yPct } as never).toMatchObject({
        refusal: { code: "invalid_input" },
      });
    await f
      .refusal("addPinnedAnnotation", { ...base, xPct: 1, yPct: 1, body: "x".repeat(1001) })
      .toMatchObject({ refusal: { code: "invalid_input" } });
    await f
      .refusal("addPinnedAnnotation", { ...base, xPct: 1, yPct: 1, body: "   " })
      .toMatchObject({ refusal: { code: "invalid_input" } });
    await f
      .refusal("addPinnedAnnotation", { ...base, xPct: 1, yPct: 1, resolved: true })
      .toMatchObject({ refusal: { code: "invalid_input" } });
    await f
      .refusal("addPinnedAnnotation", { ...base, assetId: "pos_0152", xPct: 1, yPct: 1 })
      .toMatchObject({ refusal: { code: "not_found" } });
    const notes = await f.call("listAnnotations", { code: CODE, assetId: "pos_0012" });
    expect(notes.annotations).toHaveLength(1);
  });

  it("marks a note as mine only for the link that pinned it, whatever name it typed", async () => {
    const f = await fixture();
    const input = { code: CODE, assetId: "pos_0012", xPct: 5, yPct: 5, body: "Warmer?" };
    const saved = await f.call("addPinnedAnnotation", { ...input, authorName: "Theo" }, "mara");
    expect(saved).toMatchObject({ authorName: "Theo", mine: true });
    const read = async (caller: Caller) =>
      (await f.call("listAnnotations", { code: CODE, assetId: "pos_0012" }, caller)).annotations;
    expect(await read("mara")).toMatchObject([{ id: saved.id, mine: true }]);
    expect(await read("theo")).toMatchObject([{ id: saved.id, mine: false }]);
    const studio = await f.call("studioAnnotations", { assetId: "pos_0012" }, "owner");
    expect(studio.annotations).toMatchObject([{ id: saved.id, mine: false }]);
    await f
      .refusal("addPinnedAnnotation", { ...input, authorName: "Mara", authorKey: "owner" } as never)
      .toMatchObject({ refusal: { code: "invalid_input" } });
  });

  it("lets a link edit and delete only the notes it pinned, while the gallery is open", async () => {
    const f = await fixture();
    const pinned = await f.call("addPinnedAnnotation", {
      code: CODE,
      assetId: "pos_0012",
      xPct: 10,
      yPct: 10,
      authorName: "Mara",
      body: "Warmer?",
    });
    const edited = await f.call("updateOwnNote", {
      code: CODE,
      annotationId: pinned.id,
      body: "  Much warmer?  ",
    });
    expect(edited).toMatchObject({ id: pinned.id, body: "Much warmer?", mine: true });
    for (const caller of ["theo", "owner"] as const) {
      await f
        .refusal("updateOwnNote", { code: CODE, annotationId: pinned.id, body: "Mine now" }, caller)
        .toMatchObject({ refusal: { code: "forbidden" } });
      await f
        .refusal("deleteOwnNote", { code: CODE, annotationId: pinned.id }, caller)
        .toMatchObject({ refusal: { code: "forbidden" } });
    }
    await f
      .refusal("deleteOwnNote", { code: CODE, annotationId: "note_seed_01" })
      .toMatchObject({ refusal: { code: "forbidden" } });
    await f
      .refusal("updateOwnNote", { code: CODE, annotationId: pinned.id, body: " " })
      .toMatchObject({ refusal: { code: "invalid_input" } });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    await f
      .refusal("deleteOwnNote", { code: CODE, annotationId: pinned.id })
      .toMatchObject({ refusal: { code: "gallery_closed" } });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "proofing" }, "owner");
    expect(await f.call("deleteOwnNote", { code: CODE, annotationId: pinned.id })).toEqual({
      annotationId: pinned.id,
      deleted: true,
    });
    await f
      .refusal("deleteOwnNote", { code: CODE, annotationId: pinned.id })
      .toMatchObject({ refusal: { code: "not_found" } });
    const left = await f.call("listAnnotations", { code: CODE, assetId: "pos_0012" });
    expect(left.annotations).toEqual([]);
  });

  it("restores each note the link deleted, with its original state", async () => {
    const f = await fixture();
    const pin = (body: string) =>
      f.call("addPinnedAnnotation", {
        code: CODE,
        assetId: "pos_0012",
        xPct: 20,
        yPct: 30,
        authorName: "Mara",
        body,
      });
    const first = await pin("First");
    const second = await pin("Second");
    await f.call("resolveAnnotation", { annotationId: first.id, resolved: true }, "owner");
    await f.call("deleteOwnNote", { code: CODE, annotationId: first.id });
    await f
      .refusal("restoreOwnNote", { code: CODE, annotationId: first.id }, "theo")
      .toMatchObject({ refusal: { code: "not_found" } });
    const back = await f.call("restoreOwnNote", { code: CODE, annotationId: first.id });
    expect(back).toMatchObject({
      id: first.id,
      body: "First",
      resolved: true,
      createdAtMs: first.createdAtMs,
      mine: true,
    });
    await f
      .refusal("restoreOwnNote", { code: CODE, annotationId: first.id })
      .toMatchObject({ refusal: { code: "not_found" } });
    await f.call("deleteOwnNote", { code: CODE, annotationId: first.id });
    await f.call("deleteOwnNote", { code: CODE, annotationId: second.id });
    await f.call("restoreOwnNote", { code: CODE, annotationId: first.id });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    await f
      .refusal("restoreOwnNote", { code: CODE, annotationId: second.id })
      .toMatchObject({ refusal: { code: "gallery_closed" } });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "proofing" }, "owner");
    await f.call("restoreOwnNote", { code: CODE, annotationId: second.id });
    const { annotations } = await f.call("listAnnotations", { code: CODE, assetId: "pos_0012" });
    expect(annotations.map((note: Result) => note.id)).toEqual([first.id, second.id]);
  });

  it("deletes a batch of photos with their picks and notes, or none when one is missing", async () => {
    const f = await fixture();
    const note = await f.call("addPinnedAnnotation", {
      code: CODE,
      assetId: "pos_0012",
      xPct: 20,
      yPct: 30,
      authorName: "Mara",
      body: "Trash me",
    });
    await f.call("deleteOwnNote", { code: CODE, annotationId: note.id });
    await f
      .refusal("deleteAssets", { assetIds: ["pos_0012", "pos_9999"] }, "owner")
      .toMatchObject({ refusal: { code: "not_found" } });
    expect(await f.call("deleteAssets", { assetIds: ["pos_0012", "pos_0027"] }, "owner")).toEqual({
      assetIds: ["pos_0012", "pos_0027"],
      deleted: 2,
    });
    const { assets } = await f.call("studioAssets", { shootId: "shoot_positano" }, "owner");
    expect(assets.map((asset: Result) => asset.id)).not.toContain("pos_0012");
    expect(assets.map((asset: Result) => asset.id)).not.toContain("pos_0027");
    await f
      .refusal("restoreOwnNote", { code: CODE, annotationId: note.id })
      .toMatchObject({ refusal: { code: "not_found" } });
  });

  it("rates and labels a batch of photos in one call", async () => {
    const f = await fixture();
    const assetIds = ["pos_0012", "pos_0027", "pos_0012"];
    expect(await f.call("setOwnerRating", { assetIds, rating: 2 }, "owner")).toEqual({
      assetIds: ["pos_0012", "pos_0027"],
      rating: 2,
    });
    await f.call("setColorLabel", { assetIds, colorLabel: "purple" }, "owner");
    const { assets } = await f.call("studioAssets", { shootId: "shoot_positano" }, "owner");
    for (const id of ["pos_0012", "pos_0027"])
      expect(assets.find((asset: Result) => asset.id === id)).toMatchObject({
        rating: 2,
        colorLabel: "purple",
      });
    await f
      .refusal("setOwnerRating", { assetIds: ["pos_0012", "pos_9999"], rating: 1 }, "owner")
      .toMatchObject({ refusal: { code: "not_found" } });
    await f
      .refusal("setOwnerRating", { assetIds: [], rating: 1 }, "owner")
      .toMatchObject({ refusal: { code: "invalid_input" } });
    await f
      .refusal(
        "setColorLabel",
        { assetIds: Array.from({ length: 101 }, () => "pos_0012"), colorLabel: "red" },
        "owner",
      )
      .toMatchObject({ refusal: { code: "invalid_input" } });
    const after = await f.call("studioAssets", { shootId: "shoot_positano" }, "owner");
    expect(after.assets.find((asset: Result) => asset.id === "pos_0012")).toMatchObject({
      rating: 2,
    });
  });

  it("refuses owner actions from link callers, even through the owner's operation names", async () => {
    const f = await fixture();
    const ownerCalls: Array<[string, AppBackendJson]> = [
      ["setOwnerRating", { assetIds: ["pos_0012"], rating: 5 }],
      ["setColorLabel", { assetIds: ["pos_0012"], colorLabel: "red" }],
      ["publishAsset", { assetIds: ["pos_0152"], published: true }],
      ["deleteAssets", { assetIds: ["pos_0012"] }],
      ["resolveAnnotation", { annotationId: "note_seed_01", resolved: true }],
      ["listShoots", {}],
      ["studioAssets", { shootId: "shoot_positano" }],
      ["exportFinalPicksList", { shootId: "shoot_positano" }],
      ["createShoot", { title: "x", clientName: "y", shotOn: "2026-01-01", selectionLimit: 1 }],
    ];
    for (const [name, input] of ownerCalls) {
      await expect(f.host.invoke("mara", f.request(name, input, "mara"))).rejects.toThrow();
      await expect(
        f.host.invoke("mara", {
          ...f.request(name, input, "mara"),
          access: { kind: "app", appId: "studio" },
        }),
      ).rejects.toThrow();
    }
    const assets = await f.call("studioAssets", { shootId: "shoot_positano" }, "owner");
    const first = assets.assets.find((asset: Result) => asset.id === "pos_0012");
    expect(first).toMatchObject({ rating: 4, colorLabel: "green", published: true });
    expect(assets.assets).toHaveLength(16);
  });

  it("opens a photo file for link callers only while it is published", async () => {
    const f = await fixture();
    const draft = await upload(f, image("file_draft_0000000001"), "POS_0200");
    expect(draft).toMatchObject({ published: false, mimeType: "image/png", byteLength: 2048 });
    expect(
      f.db
        .prepare("SELECT file_id FROM attachments ORDER BY file_id")
        .all()
        .map((row) => (row as { file_id: string }).file_id),
    ).toEqual(["file_draft_0000000001", "prev_draft_0000000001"]);
    const input = { code: CODE, assetId: draft.id, preview: true };
    await expect(f.openFile("assetFileAccess", input, draft.previewFileId)).rejects.toMatchObject({
      refusal: { code: "not_found" },
    });
    await expect(
      f.openFile("studioFileAccess", { assetId: draft.id }, draft.fileId, "owner"),
    ).resolves.toBe("granted");
    await expect(
      f.openFile("studioFileAccess", { assetId: draft.id }, draft.fileId),
    ).rejects.toThrow();

    await f.call("publishAsset", { assetIds: [draft.id], published: true }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.previewFileId)).resolves.toBe(
      "granted",
    );
    await expect(
      f.openFile("assetFileAccess", { code: CODE, assetId: draft.id }, draft.fileId),
    ).rejects.toMatchObject({ refusal: { code: "not_delivered" } });
    await expect(
      f.openFile(
        "assetFileAccess",
        { code: CODE, assetId: "pos_0012", preview: true },
        draft.previewFileId,
      ),
    ).rejects.toMatchObject({ refusal: { code: "not_found" } });
    const other = await upload(f, image("file_other_0000000002"), "POS_0201");
    await f.call("publishAsset", { assetIds: [other.id], published: true }, "owner");
    await expect(
      f.openFile(
        "assetFileAccess",
        { code: CODE, assetId: other.id, preview: true },
        draft.previewFileId,
      ),
    ).rejects.toThrow("does not grant access to the file");

    await f.call("publishAsset", { assetIds: [draft.id], published: false }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.previewFileId)).rejects.toMatchObject({
      refusal: { code: "not_found" },
    });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "draft" }, "owner");
    await f.call("publishAsset", { assetIds: [draft.id], published: true }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.previewFileId)).rejects.toMatchObject({
      refusal: { code: "gallery_not_found" },
    });
  });

  it("serves a small JPEG preview under the same rules as the photo", async () => {
    const f = await fixture();
    const original = image("file_full_0000000001", "image/jpeg", 18 * 1024 * 1024);
    const small = image("file_prev_0000000001", "image/jpeg", 300 * 1024);
    f.files.push(original, small);
    const asset = await f.call(
      "uploadAsset",
      {
        shootId: "shoot_positano",
        fileId: original.fileId,
        previewFileId: small.fileId,
        width: 6000,
        height: 4000,
      },
      "owner",
    );
    expect(asset).toMatchObject({
      fileId: original.fileId,
      previewFileId: small.fileId,
      byteLength: 18 * 1024 * 1024,
    });
    const input = { code: CODE, assetId: asset.id, preview: true };
    await expect(f.openFile("assetFileAccess", input, small.fileId)).rejects.toMatchObject({
      refusal: { code: "not_found" },
    });
    await expect(
      f.openFile("studioFileAccess", { assetId: asset.id, preview: true }, small.fileId, "owner"),
    ).resolves.toBe("granted");
    await f.call("publishAsset", { assetIds: [asset.id], published: true }, "owner");
    await expect(f.openFile("assetFileAccess", input, small.fileId)).resolves.toBe("granted");
    await expect(f.openFile("assetFileAccess", input, original.fileId)).rejects.toThrow(
      "does not grant access to the file",
    );
    await expect(
      f.openFile(
        "assetFileAccess",
        { code: CODE, assetId: "pos_0012", preview: true },
        small.fileId,
      ),
    ).rejects.toMatchObject({ refusal: { code: "not_found" } });

    const big = image("file_prev_big_000001", "image/jpeg", 1024 * 1024 + 1);
    const png = image("file_prev_png_000001", "image/png", 1024);
    const second = image("file_full_0000000002", "image/jpeg");
    f.files.push(big, png, second);
    const withPreview = (previewFileId: string) =>
      f.call(
        "uploadAsset",
        {
          shootId: "shoot_positano",
          fileId: second.fileId,
          previewFileId,
          width: 6000,
          height: 4000,
        },
        "owner",
      );
    await expect(withPreview(big.fileId)).rejects.toMatchObject({
      refusal: { code: "file_too_large", message: expect.stringContaining("1048577 bytes") },
    });
    await expect(withPreview(png.fileId)).rejects.toMatchObject({
      refusal: { code: "unsupported_type" },
    });
    await expect(withPreview(second.fileId)).rejects.toMatchObject({
      refusal: { code: "invalid_input" },
    });
    await f
      .refusal(
        "uploadAsset",
        { shootId: "shoot_positano", fileId: second.fileId, width: 6000, height: 4000 } as never,
        "owner",
      )
      .toMatchObject({ refusal: { code: "invalid_input" } });
    const full = { code: CODE, assetId: asset.id };
    await expect(f.openFile("assetFileAccess", full, original.fileId)).rejects.toMatchObject({
      refusal: { code: "not_delivered" },
    });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    await expect(f.openFile("assetFileAccess", full, original.fileId)).resolves.toBe("granted");
    await expect(f.openFile("assetFileAccess", input, small.fileId)).resolves.toBe("granted");
  });

  it("stores the camera settings sent with an upload, and refuses settings out of range", async () => {
    const f = await fixture();
    const capture = {
      camera: "FUJIFILM X100V",
      iso: 400,
      fNumber: 2,
      exposureS: 0.004,
      focalMm: 23,
    };
    const file = image("file_exif_0000000001", "image/jpeg");
    const other = image("file_exif_0000000002", "image/jpeg");
    f.files.push(file, other, previewFor(file), previewFor(other));
    const asset = await f.call(
      "uploadAsset",
      {
        shootId: "shoot_positano",
        fileId: file.fileId,
        previewFileId: previewFor(file).fileId,
        width: 3000,
        height: 2000,
        capture,
      },
      "owner",
    );
    expect(asset.capture).toEqual({ ...capture, lens: null });
    const listed = (await f.call("studioAssets", { shootId: "shoot_positano" }, "owner")).assets;
    expect(listed.find((item: Result) => item.id === asset.id).capture).toEqual({
      ...capture,
      lens: null,
    });
    expect(listed.find((item: Result) => item.id === "pos_0012").capture).toMatchObject({
      camera: "Sony A7 IV",
      iso: 100,
    });
    for (const bad of [
      { iso: 0 },
      { fNumber: 200 },
      { exposureS: -1 },
      { focalMm: "35" },
      { camera: "" },
      { shutter: 1 },
    ])
      await f
        .refusal(
          "uploadAsset",
          {
            shootId: "shoot_positano",
            fileId: other.fileId,
            previewFileId: previewFor(other).fileId,
            width: 10,
            height: 10,
            capture: bad,
          } as never,
          "owner",
        )
        .toMatchObject({ refusal: { code: "invalid_input" } });
  });

  it("accepts only JPEG, PNG, and WebP uploads up to 20 MiB", async () => {
    const f = await fixture();
    await expect(
      upload(f, image("file_pdf_00000000001", "application/pdf"), "Contract"),
    ).rejects.toMatchObject({
      refusal: { code: "unsupported_type" },
    });
    await expect(
      upload(f, image("file_big_00000000001", "image/jpeg", 20 * 1024 * 1024 + 1), "Huge"),
    ).rejects.toMatchObject({
      refusal: { code: "file_too_large", message: expect.stringContaining("20971521 bytes") },
    });
    expect(f.db.prepare("SELECT file_id FROM attachments").all()).toEqual([]);
    const webp = await upload(
      f,
      image("file_webp_0000000001", "image/webp", 20 * 1024 * 1024),
      "Edge",
    );
    expect(webp).toMatchObject({ mimeType: "image/webp", sortOrder: 170 });
  });

  it("refuses to send favorites that differ from the ones the client sees", async () => {
    const f = await fixture();
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: true }, "mara");
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0027", selected: true }, "mara");
    for (const assetIds of [
      ["pos_0012"],
      ["pos_0012", "pos_0027", "pos_0044"],
      ["pos_0012", "pos_0031"],
    ])
      await f
        .refusal("submitSelection", { code: CODE, assetIds }, "mara")
        .toMatchObject({ refusal: { code: "selection_changed" } });
    await f
      .refusal("submitSelection", { code: CODE, assetIds: "pos_0012" }, "mara")
      .toMatchObject({ refusal: { code: "invalid_input" } });
    expect(
      (await f.call("listPublishedAssets", { code: CODE }, "mara")).gallery.sentAtMs,
    ).toBeNull();
    await expect(
      f.call("submitSelection", { code: CODE, assetIds: ["pos_0027", "pos_0012"] }, "mara"),
    ).resolves.toMatchObject({ picksUsed: 2 });
  });

  it("keeps the sent count after a sent photo is hidden, so delivery does not say the client withdrew", async () => {
    const f = await fixture();
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0031", selected: true }, "theo");
    await send(f, "theo");
    const before = await f.call("listPublishedAssets", { code: CODE }, "theo");
    expect(before.assets.find((asset: Result) => asset.id === "pos_0031")).toMatchObject({
      picked: true,
      sent: true,
    });
    await f.call("publishAsset", { assetIds: ["pos_0031"], published: false }, "owner");
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    expect((await f.call("listPublishedAssets", { code: CODE }, "theo")).gallery).toMatchObject({
      status: "delivered",
      picksUsed: 0,
      sentPicks: 1,
    });
  });

  it("records when each link sends its favorites, and marks them changed after a later pick", async () => {
    const f = await fixture();
    const gallery = async (caller: Caller) =>
      (await f.call("listPublishedAssets", { code: CODE }, caller)).gallery;
    await f
      .refusal("submitSelection", { code: CODE, assetIds: [] }, "mara")
      .toMatchObject({ refusal: { code: "no_picks" } });
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: true }, "mara");
    const sent = await send(f, "mara");
    expect(sent).toMatchObject({ picksUsed: 1, changedSinceSent: false });
    expect(sent.sentAtMs).toEqual(expect.any(Number));
    expect(await gallery("mara")).toMatchObject({
      sentAtMs: sent.sentAtMs,
      changedSinceSent: false,
    });
    expect(await gallery("theo")).toMatchObject({ sentAtMs: null, changedSinceSent: false });
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0027", selected: true }, "mara");
    expect(await gallery("mara")).toMatchObject({ changedSinceSent: true });
    await send(f, "mara");
    expect(await gallery("mara")).toMatchObject({ picksUsed: 2, changedSinceSent: false });
    expect(
      await f.call("toggleClientPick", { code: CODE, assetId: "pos_0044", selected: true }, "mara"),
    ).toMatchObject({ changedSinceSent: true });
    expect(
      await f.call(
        "toggleClientPick",
        { code: CODE, assetId: "pos_0044", selected: false },
        "mara",
      ),
    ).toMatchObject({ changedSinceSent: false });
    expect(
      await f.call(
        "toggleClientPick",
        { code: CODE, assetId: "pos_0044", selected: false },
        "mara",
      ),
    ).toMatchObject({ changedSinceSent: false });
    const shoots = (await f.call("listShoots", {}, "owner")).shoots;
    expect(shoots.find((shoot: Result) => shoot.id === "shoot_positano")).toMatchObject({
      sentCount: 2,
    });
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: false }, "mara");
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0027", selected: false }, "mara");
    expect(await send(f, "mara")).toMatchObject({
      picksUsed: 0,
      changedSinceSent: false,
    });
    expect(
      (await f.call("exportFinalPicksList", { shootId: "shoot_positano" }, "owner")).reviewerCount,
    ).toBe(1);
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0031", selected: true }, "theo");
    await send(f, "theo");
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0031", selected: false }, "theo");
    await send(f, "theo");
    const facts = (await f.call("listShoots", {}, "owner")).shoots.find(
      (shoot: Result) => shoot.id === "shoot_positano",
    );
    expect(facts.sentCount).toBe(3);
    expect(facts.reviewerCount).toBeGreaterThanOrEqual(facts.sentCount);
    await f
      .refusal("submitSelection", { code: "WRONG-CODE", assetIds: [] }, "mara")
      .toMatchObject({ refusal: { code: "gallery_not_found" } });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    await f
      .refusal("submitSelection", { code: CODE, assetIds: [] }, "mara")
      .toMatchObject({ refusal: { code: "gallery_closed" } });
  });

  it("exports only the favorites each link sent, and closes picking once the shoot is delivered", async () => {
    const f = await fixture();
    const exported = async () =>
      f.call("exportFinalPicksList", { shootId: "shoot_positano" }, "owner");
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: true });
    expect(await exported()).toMatchObject({ reviewerCount: 1, selectionLimit: 12 });
    expect((await exported()).picks).toEqual([
      ["POS_0027", 1],
      ["POS_0044", 1],
      ["POS_0071", 1],
      ["POS_0090", 1],
      ["POS_0125", 1],
    ]);
    await send(f);
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: false });
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0031", selected: true });
    expect(await exported()).toMatchObject({ reviewerCount: 2 });
    expect((await exported()).picks).toEqual([
      ["POS_0012", 1],
      ["POS_0027", 1],
      ["POS_0044", 1],
      ["POS_0071", 1],
      ["POS_0090", 1],
      ["POS_0125", 1],
    ]);
    await send(f);
    expect((await exported()).picks.map(([title]: [string]) => title)).toEqual([
      "POS_0027",
      "POS_0031",
      "POS_0044",
      "POS_0071",
      "POS_0090",
      "POS_0125",
    ]);
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0031", selected: false });
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0044", selected: true });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    const delivered = await f.call("listPublishedAssets", { code: CODE });
    expect(delivered.gallery).toMatchObject({ status: "delivered", picksUsed: 1 });
    expect(
      delivered.assets.filter((asset: Result) => asset.picked).map((asset: Result) => asset.id),
    ).toEqual(["pos_0031"]);
    await f
      .refusal("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: false })
      .toMatchObject({ refusal: { code: "gallery_closed" } });
  });

  it("creates shoots with an unguessable gallery code", async () => {
    const f = await fixture();
    const shoot = await f.call(
      "createShoot",
      {
        title: "Lake wedding",
        clientName: "Ada",
        shotOn: "2026-11-01",
        selectionLimit: 40,
        internalRateCents: 1,
      },
      "owner",
    );
    expect(shoot.accessCode).toMatch(/^[A-HJKMNP-Z2-9]{12}$/);
    expect(shoot.status).toBe("draft");
    await f
      .refusal("listPublishedAssets", { code: shoot.accessCode })
      .toMatchObject({ refusal: { code: "gallery_not_found" } });
    await f.call("updateShoot", { shootId: shoot.id, status: "proofing" }, "owner");
    expect(
      (await f.call("listPublishedAssets", { code: shoot.accessCode.toLowerCase() })).assets,
    ).toEqual([]);
    await expect(
      f.call(
        "createShoot",
        { title: "x", clientName: "y", shotOn: "2026-02-30", selectionLimit: 1 },
        "owner",
      ),
    ).rejects.toMatchObject({ refusal: { code: "invalid_input" } });
  });

  it("publishes 100 drafts in one batch and pages large CJK note lists and final pick exports", async () => {
    const f = await fixture();
    const batchIds: string[] = [];
    for (let index = 0; index < 100; index++) {
      const uploaded = await upload(
        f,
        image(`file_batch_${String(index).padStart(8, "0")}`),
        `BATCH_${String(index).padStart(3, "0")}`,
      );
      batchIds.push(uploaded.id);
    }
    const published = await f.call(
      "publishAsset",
      { assetIds: batchIds, published: true },
      "owner",
    );
    expect(published).toMatchObject({ published: true, changed: 100 });

    const cjk = "光".repeat(1000);
    for (let index = 0; index < 95; index++) {
      await f.call("addPinnedAnnotation", {
        code: CODE,
        assetId: "pos_0027",
        xPct: (index % 100) + 0.5,
        yPct: 50,
        authorName: "Mara",
        body: cjk,
      });
    }
    const collectNotes = async (op: "listAnnotations" | "studioAnnotations", caller: Caller) => {
      const all: Result[] = [];
      let after: AppBackendJson = null;
      do {
        const input: Record<string, AppBackendJson> =
          op === "listAnnotations" ? { code: CODE, assetId: "pos_0027" } : { assetId: "pos_0027" };
        if (after) input.after = after;
        const page = await f.call(op, input, caller);
        all.push(...page.annotations);
        after = page.nextCursor;
      } while (after);
      return all;
    };
    expect(await collectNotes("listAnnotations", "mara")).toHaveLength(97);
    expect(await collectNotes("studioAnnotations", "owner")).toHaveLength(97);

    const exportedAll: Array<[string, number]> = [];
    let after: AppBackendJson = null;
    do {
      const page = await f.call(
        "exportFinalPicksList",
        after
          ? { shootId: "shoot_positano", limit: 3, after }
          : { shootId: "shoot_positano", limit: 3 },
        "owner",
      );
      exportedAll.push(...page.picks);
      after = page.nextCursor;
    } while (after);
    expect(exportedAll).toHaveLength(5);
    await f
      .refusal("exportFinalPicksList", { shootId: "shoot_positano", limit: 251 }, "owner")
      .toMatchObject({ refusal: { code: "invalid_input" } });
  });
});
