import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createLocalStagedApps } from "./localStagedApps";
import { prepareOwnerAppPublication } from "./ownerAppPublication";
import { openedLocalState } from "../testing/preparedLocalState";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "../../../../examples/lightbox");
const roots: string[] = [];
const hosts: LocalDatasetHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function exampleFiles() {
  const names = (await readdir(EXAMPLE_ROOT, { recursive: true, withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== "README.md" &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.mts"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
  return new Map(
    await Promise.all(
      names.map(
        async (path) =>
          [
            `lightbox/${path.slice(EXAMPLE_ROOT.length + 1).replaceAll("\\", "/")}`,
            await readFile(path, "utf8"),
          ] as const,
      ),
    ),
  );
}

async function openWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-lightbox-"));
  roots.push(workspaceRoot);
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const host = await createLocalDatasetHost({
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot,
    capacityBytes: 64 * 1024 * 1024,
    compile: createDatasetFixtureCompiler(),
    holder: unguardedCollections,
  });
  hosts.push(host);
  const staged = createLocalStagedApps({
    workspaceId: "w",
    workspaceRoot,
    assertCurrent() {},
    compile: compileClosedApp,
    preflightCreate: (input) => host.preflightCreate(input),
    tryApprovedArtifacts: async (datasetId) => {
      try {
        return host.approvedArtifacts(datasetId);
      } catch {
        return null;
      }
    },
    prepareCreate: (input) => host.prepare(input),
    approveCreate: (input) => host.approve(input),
    discardCreate: (id) => host.discard(id),
    prepareMigrationCandidate: (input) => host.prepareMigrationCandidate(input),
    approveMigrationCandidate: (input) => host.approveMigrationCandidate(input),
    discardMigrationCandidate: (input) => host.discardMigrationCandidate(input),
    activateApp: (prepared, signal, agent) => host.apps.activate(prepared, signal, agent),
    withExclusiveDatasets: (datasetIds, signal, work) =>
      host.withExclusiveDatasets(datasetIds, signal, (exclusive) =>
        work({
          approveCreate: (input) => exclusive.approve(input),
          approveMigrationCandidate: (input) => exclusive.approveMigrationCandidate(input),
        }),
      ),
  });
  return { host, staged };
}

it("stages the Lightbox studio and client portal, and a portal can read a photo file only while it is published", async () => {
  const { host, staged } = await openWorkspace();
  const files = await exampleFiles();
  const signal = new AbortController().signal;
  const install = async (appRoot: string) => {
    const summary = await staged.stage({
      appRoot,
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    return staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal });
  };
  const studio = await install("lightbox");
  const portal = await install("lightbox/portal");
  expect(host.list().datasets).toHaveLength(1);

  let key = 0;
  const call = async <T>(app: typeof studio, operation: string, input: unknown) =>
    (
      (await host.apps.request(app.publicationId, "invoke", {
        authorityRevision: app.authorityRevision,
        operation,
        idempotencyKey: `k${key++}`,
        input,
      })) as { result: T }
    ).result;

  await expect(call(portal, "listShoots", {})).rejects.toThrow("not approved for the app");
  const { shoots } = await call<{ shoots: { id: string; accessCode: string }[] }>(
    studio,
    "listShoots",
    {},
  );
  const positano = shoots.find((shoot) => shoot.id === "shoot_positano")!;

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9,
  ]);
  const uploaded = (await host.apps.request(studio.publicationId, "upload", {
    authorityRevision: studio.authorityRevision,
    idempotencyKey: "photo",
    name: "IMG_2041.jpg",
    contentType: "image/jpeg",
    bytesBase64: jpeg.toString("base64"),
  })) as { file: { fileId: string } };
  const asset = await call<{ id: string; published: boolean }>(studio, "uploadAsset", {
    shootId: positano.id,
    fileId: uploaded.file.fileId,
    width: 3000,
    height: 2000,
  });
  expect(asset).toMatchObject({ published: false });

  const read = (app: typeof studio, operation: string, input: object) =>
    host.apps.readBrowserFile(app.publicationId, {
      authorityRevision: app.authorityRevision,
      fileId: uploaded.file.fileId,
      operation,
      input,
    });
  const portalInput = { code: positano.accessCode, assetId: asset.id };
  expect(await read(studio, "studioFileAccess", { assetId: asset.id })).toMatchObject({
    bytesBase64: jpeg.toString("base64"),
  });
  await expect(read(portal, "assetFileAccess", portalInput)).rejects.toThrow(
    "isn't in the gallery",
  );
  await expect(read(portal, "studioFileAccess", { assetId: asset.id })).rejects.toThrow(
    "approved read action",
  );

  await call(studio, "publishAsset", { assetIds: [asset.id], published: true });
  expect(await read(portal, "assetFileAccess", portalInput)).toMatchObject({
    bytesBase64: jpeg.toString("base64"),
  });

  const gallery = await call<{ assets: { id: string }[] }>(portal, "listPublishedAssets", {
    code: positano.accessCode,
  });
  expect(gallery.assets.map((item) => item.id)).toContain(asset.id);
  expect(JSON.stringify(gallery)).not.toMatch(/internal|rate|accessCode|rating/i);

  await call(studio, "publishAsset", { assetIds: [asset.id], published: false });
  await expect(read(portal, "assetFileAccess", portalInput)).rejects.toThrow(
    "isn't in the gallery",
  );
});

it("prepares the client portal from a share link scoped only to lightbox/portal without exposing proofing files", async () => {
  const { host, staged } = await openWorkspace();
  const files = await exampleFiles();
  const signal = new AbortController().signal;
  const summary = await staged.stage({
    appRoot: "lightbox",
    deferredWrites: [],
    adapter: sourceCaptureAdapter(files),
    signal,
  });
  await staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal });

  const prepared = await prepareOwnerAppPublication(
    {
      workspaceId: "w",
      appRoot: "lightbox/portal",
      shareId: "share-portal",
      grantId: "grant-portal",
    },
    {
      shareId: "share-portal",
      grantId: "grant-portal",
      generation: 1,
      status: "active",
      revokedAtMs: null,
      selector: { paths: ["lightbox/portal"], versionId: null },
    },
    {
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
      assertCurrent() {},
      compile: compileClosedApp,
      resolveDatasetRevision: async (lookup) => host.approvedArtifacts(lookup.datasetId).revision,
    },
  );
  const inputPaths = prepared.candidate.inputs.map((entry) => entry.path);
  expect(inputPaths.length).toBeGreaterThan(0);
  expect(inputPaths.every((path) => path.startsWith("lightbox/portal/"))).toBe(true);
  expect(inputPaths.some((path) => path.includes("proofing") || path.endsWith("studio.tsx"))).toBe(
    false,
  );
});
