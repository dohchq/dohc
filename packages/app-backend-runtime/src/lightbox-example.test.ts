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

async function upload(f: Awaited<ReturnType<typeof fixture>>, file: File, title: string) {
  f.files.push(file);
  return f.call(
    "uploadAsset",
    { shootId: "shoot_positano", fileId: file.fileId, width: 3000, height: 2000, title },
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
      f.files.push(image(fileId));
      return f.call(
        "uploadAsset",
        { shootId: shoot.id, fileId, width: 1200, height: 800, title },
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

  it("refuses owner actions from link callers, even through the owner's operation names", async () => {
    const f = await fixture();
    const ownerCalls: Array<[string, AppBackendJson]> = [
      ["setOwnerRating", { assetId: "pos_0012", rating: 5 }],
      ["setColorLabel", { assetId: "pos_0012", colorLabel: "red" }],
      ["publishAsset", { assetIds: ["pos_0152"], published: true }],
      ["deleteAsset", { assetId: "pos_0012" }],
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
    expect(f.db.prepare("SELECT file_id FROM attachments").all()).toEqual([
      { file_id: "file_draft_0000000001" },
    ]);
    const input = { code: CODE, assetId: draft.id };
    await expect(f.openFile("assetFileAccess", input, draft.fileId)).rejects.toMatchObject({
      refusal: { code: "not_found" },
    });
    await expect(
      f.openFile("studioFileAccess", { assetId: draft.id }, draft.fileId, "owner"),
    ).resolves.toBe("granted");
    await expect(
      f.openFile("studioFileAccess", { assetId: draft.id }, draft.fileId),
    ).rejects.toThrow();

    await f.call("publishAsset", { assetIds: [draft.id], published: true }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.fileId)).resolves.toBe("granted");
    await expect(
      f.openFile("assetFileAccess", { code: CODE, assetId: "pos_0012" }, draft.fileId),
    ).rejects.toMatchObject({ refusal: { code: "not_found" } });
    const other = await upload(f, image("file_other_0000000002"), "POS_0201");
    await f.call("publishAsset", { assetIds: [other.id], published: true }, "owner");
    await expect(
      f.openFile("assetFileAccess", { code: CODE, assetId: other.id }, draft.fileId),
    ).rejects.toThrow("does not grant access to the file");

    await f.call("publishAsset", { assetIds: [draft.id], published: false }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.fileId)).rejects.toMatchObject({
      refusal: { code: "not_found" },
    });
    await f.call("updateShoot", { shootId: "shoot_positano", status: "draft" }, "owner");
    await f.call("publishAsset", { assetIds: [draft.id], published: true }, "owner");
    await expect(f.openFile("assetFileAccess", input, draft.fileId)).rejects.toMatchObject({
      refusal: { code: "gallery_not_found" },
    });
  });

  it("accepts only JPEG, PNG, and WebP uploads up to 5 MiB", async () => {
    const f = await fixture();
    await expect(
      upload(f, image("file_pdf_00000000001", "application/pdf"), "Contract"),
    ).rejects.toMatchObject({
      refusal: { code: "unsupported_type" },
    });
    await expect(
      upload(f, image("file_big_00000000001", "image/jpeg", 5 * 1024 * 1024 + 1), "Huge"),
    ).rejects.toMatchObject({
      refusal: { code: "file_too_large", message: expect.stringContaining("5242881 bytes") },
    });
    expect(f.db.prepare("SELECT file_id FROM attachments").all()).toEqual([]);
    const webp = await upload(
      f,
      image("file_webp_0000000001", "image/webp", 5 * 1024 * 1024),
      "Edge",
    );
    expect(webp).toMatchObject({ mimeType: "image/webp", sortOrder: 170 });
  });

  it("exports final picks and closes picking once the shoot is delivered", async () => {
    const f = await fixture();
    await f.call("toggleClientPick", { code: CODE, assetId: "pos_0012", selected: true });
    const exported = await f.call("exportFinalPicksList", { shootId: "shoot_positano" }, "owner");
    expect(exported).toMatchObject({ reviewerCount: 3, selectionLimit: 12 });
    expect(exported.picks).toEqual([
      ["POS_0012", 1],
      ["POS_0027", 2],
      ["POS_0044", 1],
      ["POS_0071", 2],
      ["POS_0090", 1],
      ["POS_0119", 1],
      ["POS_0125", 1],
    ]);
    await f.call("updateShoot", { shootId: "shoot_positano", status: "delivered" }, "owner");
    expect((await f.call("listPublishedAssets", { code: CODE })).gallery.status).toBe("delivered");
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
    expect(exportedAll).toHaveLength(6);
    await f
      .refusal("exportFinalPicksList", { shootId: "shoot_positano", limit: 251 }, "owner")
      .toMatchObject({ refusal: { code: "invalid_input" } });
  });
});
