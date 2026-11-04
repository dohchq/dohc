import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import { ENGINE_BINARY_ENV_VAR, requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";

// The release workflow sets these to the engine from the newest published
// nightly and requires the check, so a missing download fails the release.
const PREVIOUS_ENGINE_ENV_VAR = "DOHC_UPGRADE_PREVIOUS_ENGINE";
const REQUIRE_UPGRADE_ENV_VAR = "DOHC_REQUIRE_UPGRADE_E2E";

const engine = requireEngineBinaryOrSkip();
const previousEngine = process.env[PREVIOUS_ENGINE_ENV_VAR]?.trim() ? resolve(process.env[PREVIOUS_ENGINE_ENV_VAR]!.trim()) : null;
if (process.env[REQUIRE_UPGRADE_ENV_VAR] === "1" && (previousEngine === null || engine.missing)) {
  throw new Error(`${REQUIRE_UPGRADE_ENV_VAR}=1 needs the previous engine in ${PREVIOUS_ENGINE_ENV_VAR} and the new engine in ${ENGINE_BINARY_ENV_VAR} or the cargo output.`);
}

const workspaceId = "engine-upgrade";
const NOTE = "notes/plan.md";
const BINARY = "assets/photo.bin";
const NESTED = "trip/days/day-1.md";
const UNICODE = "Café ünïcödé 日本.md";
const SEED: Record<string, Buffer> = {
  [NOTE]: Buffer.from("# Plan\n\nFirst draft.\n"),
  [BINARY]: Buffer.from(Array.from({ length: 512 }, (_, n) => (n * 37) % 256)),
  [NESTED]: Buffer.from("# Day 1\n\nArrive.\n"),
  [UNICODE]: Buffer.from("# Café\n\nNon-ASCII name.\n"),
};
const NOTE_EDIT = Buffer.from("# Plan\n\nSecond draft, edited.\n");
const NOTE_LAST = Buffer.from("# Plan\n\nThird draft, after the upgrade.\n");

type FileView = { path: string; contentKind: string; sha256: string; binarySha256: string | null; latestMomentId: string };
type EngineView = { files: FileView[]; moments: Map<string, { path: string; operation: string }>; latestMomentOrder: number };

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function withEngine<T>(command: string, rootDir: string, work: (adapter: VersionedLiveAdapter, requester: WorkspaceDaemonRequester) => Promise<T>): Promise<T> {
  const client = await createEngineClient({ command, authToken: "engine-upgrade", protocolVersion: 2, capabilities: [] });
  const requester = new WorkspaceDaemonRequester(client);
  let adapter: VersionedLiveAdapter | undefined;
  // The daemon always exits, and a failed shutdown never hides the failure that preceded it.
  const shutDown = async () => {
    try {
      if (adapter) await requester.request("workspace.close", {}, { workspace: adapter.workspace });
    } finally {
      client.close();
      await client.waitForExit();
    }
  };
  let result: T;
  try {
    adapter = await VersionedLiveAdapter.openWorkspace(client, { rootDir, workspaceId });
    result = await work(adapter, requester);
  } catch (error) {
    await shutDown().catch(cleanup => console.error("The engine also failed to shut down:", cleanup));
    throw error;
  }
  await shutDown();
  return result;
}

/** The sha-256 of each moment's recorded content, read back through the engine the way History reads it. */
async function readBodies(adapter: VersionedLiveAdapter, momentIds: Iterable<string>): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const momentId of momentIds) {
    try {
      const moment = await adapter.getMoment({ workspaceId, momentId });
      if (moment === null) { bodies.set(momentId, "no moment"); continue; }
      const body = moment.afterContentKind === "binary"
        ? moment.afterBinarySha256 === null ? null : await adapter.readBinaryBlob({ workspaceId, sha256: moment.afterBinarySha256 })
        : moment.afterText ?? (moment.afterBlobSha256 === null ? null : await adapter.readTextBlob({ workspaceId, sha256: moment.afterBlobSha256 }));
      bodies.set(momentId, body === null ? "no content" : sha256(body));
    } catch (error) {
      bodies.set(momentId, `unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return bodies;
}

/** The engine's settled view of the active version: every file and every moment in its history. */
async function readView(adapter: VersionedLiveAdapter): Promise<EngineView> {
  const version = await adapter.getActiveVersion({ workspaceId });
  if (version === null) throw new Error("The engine opened the workspace without an active version.");
  const files = (await adapter.listTextFileMetadata({ workspaceId, versionId: version.id }))
    .map(({ path, contentKind, sha256, binarySha256, latestMomentId }) => ({ path, contentKind, sha256, binarySha256, latestMomentId }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const moments = new Map<string, { path: string; operation: string }>();
  let page = await adapter.readHistoryPage({ workspaceId, limit: 100 });
  const latestMomentOrder = page.latestMomentOrder;
  for (;;) {
    for (const moment of page.moments) moments.set(moment.momentId, { path: moment.path, operation: moment.operation });
    if (page.nextCursor === null) break;
    page = await adapter.readHistoryPage({ workspaceId, limit: 100, cursor: page.nextCursor });
  }
  return { files, moments, latestMomentOrder };
}

const momentsFor = (view: EngineView, path: string) => [...view.moments.values()].filter(moment => moment.path === path).length;

/** Flushes capture until it settles with the expected content and per-path moment counts. */
async function settledView(adapter: VersionedLiveAdapter, expected: Record<string, Buffer> = {}, moments: Record<string, number> = {}, previousRequester?: WorkspaceDaemonRequester): Promise<EngineView> {
  let view: EngineView | undefined;
  await expect.poll(async () => {
    // The previous engine may omit fields required by today's capture.flush schema. Only settled is needed here.
    const flushed = previousRequester
      ? await previousRequester.request("capture.flush", {}, { workspace: adapter.workspace })
      : await adapter.workspaceRequest("capture.flush", {});
    if (flushed === null || typeof flushed !== "object" || Array.isArray(flushed) || flushed.settled !== true) return "capture has not settled";
    view = await readView(adapter);
    const listed = new Map(view.files.map(file => [file.path, file]));
    for (const [path, bytes] of Object.entries(expected)) {
      const file = listed.get(path);
      if (file === undefined) return `${path} is not listed`;
      if (file.sha256 !== sha256(bytes)) return `${path} is listed with hash ${file.sha256}; expected ${sha256(bytes)}`;
    }
    for (const [path, count] of Object.entries(moments)) if (momentsFor(view, path) < count) return `${path} has ${momentsFor(view, path)} of ${count} moments`;
    return "settled";
  }, { timeout: REAL_DAEMON_DEADLINE_MS, interval: 50 }).toBe("settled");
  return view!;
}

async function readDisk(root: string, paths: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(join(root, path)))] as const)));
}

it.skipIf(engine.missing || previousEngine === null)("opens a workspace from the previous engine with its files and history intact", async () => {
  const root = await createTestScratch("dohc-engine-upgrade-");
  for (const [path, bytes] of Object.entries(SEED)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const disk = { ...SEED, [NOTE]: NOTE_EDIT };
  const paths = Object.keys(disk).sort((a, b) => a.localeCompare(b));

  const before = await withEngine(previousEngine!, root, async (adapter, requester) => {
    await settledView(adapter, SEED, Object.fromEntries(paths.map(path => [path, 1])), requester);
    await writeFile(join(root, NOTE), NOTE_EDIT);
    const view = await settledView(adapter, disk, { [NOTE]: 2 }, requester);
    return { view, bodies: await readBodies(adapter, view.moments.keys()) };
  });
  const diskBefore = await readDisk(root, paths);
  expect(before.view.files.map(file => file.path), "the previous engine did not capture every seeded file").toEqual(paths);
  // The first draft is older than the file's latest moment, so only history can return it.
  const revisions = (path: string) => [...before.view.moments].filter(([, moment]) => moment.path === path).map(([id]) => before.bodies.get(id));
  for (const [path, bytes] of [[NOTE, SEED[NOTE]], [NOTE, NOTE_EDIT], [BINARY, SEED[BINARY]]] as const) {
    expect(revisions(path), `the previous engine did not return ${path}'s seeded revision from history`).toContain(sha256(bytes));
  }

  await withEngine(engine.require(), root, async adapter => {
    const after = await settledView(adapter);
    expect(await readDisk(root, paths), "opening with the new engine changed file bytes on disk").toEqual(diskBefore);
    const lost = [...before.view.moments].filter(([id, moment]) => JSON.stringify(after.moments.get(id)) !== JSON.stringify(moment))
      .map(([id, moment]) => `${id} (${moment.operation} ${moment.path})`);
    expect(lost, "history moments the previous engine recorded are missing or changed under the new engine").toEqual([]);
    const bodies = await readBodies(adapter, before.bodies.keys());
    const changed = [...before.bodies].filter(([id, body]) => bodies.get(id) !== body)
      .map(([id, body]) => `${id} (${before.view.moments.get(id)?.path}): content ${body} is now ${bodies.get(id)}`);
    expect(changed, "history content the previous engine recorded is unavailable or changed under the new engine").toEqual([]);
    expect(after.files, "the new engine lists different files, hashes, or latest moments than the previous engine").toEqual(before.view.files);
    expect(after.latestMomentOrder, "the new engine's moment order went backwards").toBeGreaterThanOrEqual(before.view.latestMomentOrder);

    await writeFile(join(root, NOTE), NOTE_LAST);
    const edited = await settledView(adapter, { ...disk, [NOTE]: NOTE_LAST }, { [NOTE]: momentsFor(after, NOTE) + 1 });
    expect(edited.latestMomentOrder, "the new engine did not record an edit as a new moment").toBeGreaterThan(after.latestMomentOrder);
  });
}, 4 * REAL_DAEMON_DEADLINE_MS);
