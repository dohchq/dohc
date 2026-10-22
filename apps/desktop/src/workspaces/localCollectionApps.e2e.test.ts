import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { readLocalStateFrom } from "./workspaceLocalState";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { deferred } from "../testing/deferred";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalAppLaunchHost, LocalAppUnavailableError } from "./localAppLaunch";
import type { LocalCollectionEngine } from "./localCollectionApps";
import { localCollectionEngine } from "./localCollectionEngine";
import { createLocalDatasetHost, reconcileExistingLocalCollectionApps, type LocalDatasetHost } from "./localDatasetHost";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { unguardedCollections } from "../testing/collectionsHolder";

const engine = requireEngineBinaryOrSkip();
const compile = createDatasetFixtureCompiler();
const schema = "version: 1\nfields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n";
const person: MomentWriteAuthor = { kind: "human", humanId: "person-local" };
const signal = () => new AbortController().signal;
type Receipt = { kind: "accepted"; acceptanceId: string; objectId: string; path: string; momentId: string; acceptedAtMs: number };

/**
 * A trip app over a real daemon, its capture, and the local store. `wrap` stands in only
 * for what a real engine cannot stage: a lost answer or a write held between two steps.
 */
async function tripWorkspace(name: string) {
  const root = await createTestScratch(`dohc-local-collection-${name}-`), workspaceId = `local-collection-${name}`;
  await mkdir(join(root, "trip/responses"), { recursive: true });
  await writeFile(join(root, "trip/main.ts"), "document.body.textContent = 'Trip';");
  await writeFile(join(root, "trip/app.publish.json"), JSON.stringify({ version: 1, entryPath: "main.ts", inputs: ["main.ts"], packageMap: {},
    collection: { kind: "collection-create", collectionPath: "responses", allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination", "name"] } }));
  await writeFile(join(root, "trip/responses/collection.yaml"), schema);
  const attached = { workspaceId, rootPath: root, attachmentId: Symbol(workspaceId) };
  const startEngine = async () => {
    const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    // The real engine's open prepares `.dohc/local`, where the host keeps its store and workers.
    readLocalStateFrom(sessions);
    const capture = createWorkspaceEngineCapture({ ...attached, rustEngineSessions: sessions, onError: () => undefined });
    const adapter = () => sessions.run(attached, async ({ client, workspace: handle }) => new VersionedLiveAdapter(client, handle, { workspaceId }));
    const binding = localCollectionEngine({ workspaceId, rootPath: root, capture, withAdapter: async work => work(await adapter()) });
    return { capture, adapter, binding, async stop() {
      capture.beginShutdown();
      await capture.stop().catch(() => undefined);
      await sessions.closeAll();
      await lifecycle.stop();
    } };
  };
  let running = await startEngine();
  await waitForPathMoments(running.capture, "trip/responses/collection.yaml", 1);
  const hosts: LocalDatasetHost[] = [];
  // `down`: the engine is unavailable to the app, as when the daemon is gone.
  const control = { wrap: (real: LocalCollectionEngine): LocalCollectionEngine => real, down: false };
  async function open() {
    const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId, workspaceRoot: root, attachmentId: attached.attachmentId, capacityBytes: 1024 * 1024, compile,
      collectionEngine: () => { if (control.down) throw new Error("The workspace engine is unavailable."); return control.wrap(running.binding); },
      collectionAuthor: async () => person });
    hosts.push(host);
    return host;
  }
  return {
    root, control, open,
    get capture() { return running.capture; },
    async approve() {
      const host = await open();
      const prepared = await prepareLocalAppPublication({ workspaceId, appRoot: "trip" }, { deferredWrites: [], adapter: await running.adapter(), compile: compileClosedApp, signal: signal(), assertCurrent() {} });
      return { host, published: await host.apps.activate(prepared, signal()) };
    },
    async restartEngine() {
      await running.stop();
      running = await startEngine();
      // The desktop reconciles once the engine has opened the workspace again, as its store in `.dohc/local` needs.
      await running.adapter();
    },
    async close() {
      for (const host of hosts) await host.close();
      await running.stop();
    },
  };
}

it.skipIf(engine.missing)("creates and lists through the loopback launch on the real engine, writing a retried response once", async () => {
  const w = await tripWorkspace("launch");
  try {
    const { host, published } = await w.approve();
    // The engine's open prepared `.dohc/local`, so the host holds its worker folder there.
    expect(await readdir(join(w.root, ".dohc", "local", "datasets", "workers"))).toEqual(expect.arrayContaining([".dohc-worker-lock.sqlite"]));
    const lifetime = new AbortController(), launcher = await createLocalAppLaunchHost({ backend: host.apps, lifetime: lifetime.signal });
    try {
      const url = new URL(await launcher.launch(published.publicationId, signal())), origin = url.origin;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const { proof } = await (await post("/session", { handoff: url.hash.slice(1) })).json() as { proof: string };
      const backend = (body: unknown) => post("/backend", body, { "x-dohc-app-proof": proof });
      const create = () => backend({ id: "create", op: "collection.create", idempotencyKey: "trip-1", fields: { destination: "Manila", name: "Bo" } });
      const created = await create();
      expect(created.status).toBe(200);
      const receipt = await created.json() as Receipt;
      expect(await (await create()).json()).toEqual(receipt);
      // The engine recorded one write, by the person here, at the receipt's moment.
      expect(await waitForPathMoments(w.capture, receipt.path, 1)).toEqual([expect.objectContaining({ id: receipt.momentId, objectId: receipt.objectId, operation: "write", authors: [expect.objectContaining(person)] })]);
      expect(await readFile(join(w.root, receipt.path), "utf8")).toContain('"destination":"Manila"');

      // Only direct-child records are listed, and no cursor names another file.
      await mkdir(join(w.root, "trip/responses/drafts"));
      await writeFile(join(w.root, "trip/responses/drafts/private.md"), `---\n${JSON.stringify({ destination: "Tokyo" })}\n---\n`);
      await writeFile(join(w.root, "trip/responses/notes.txt"), "Not a response.\n");
      await writeFile(join(w.root, "trip/responses/zz.md"), `---\n${JSON.stringify({ destination: "Tokyo", name: "Cy" })}\n---\n`);
      await waitForPathMoments(w.capture, "trip/responses/zz.md", 1);
      const pages: Array<{ records: Array<{ path: string; fields: Record<string, unknown> }>; nextPath: string | null }> = [];
      let afterPath: string | undefined;
      do {
        const page = await (await backend({ id: "list", op: "collection.list", limit: 1, ...(afterPath === undefined ? {} : { afterPath }) })).json() as typeof pages[number];
        pages.push(page); afterPath = page.nextPath ?? undefined;
      } while (afterPath && pages.length < 10);
      expect(pages.map(page => page.records.map(record => [record.path, record.fields]))).toEqual([[[receipt.path, { destination: "Manila", name: "Bo" }]], [["trip/responses/zz.md", { destination: "Tokyo", name: "Cy" }]]]);
      expect(pages.map(page => page.nextPath)).toEqual([receipt.path, null]);
    } finally { lifetime.abort(); await launcher.close(); }
  } finally { await w.close(); }
}, REAL_DAEMON_TEST_TIMEOUT_MS);

it.skipIf(engine.missing)("keeps admitted responses through a lost answer and a restart, then completes each with one write", async () => {
  const w = await tripWorkspace("restart");
  try {
    const { host, published } = await w.approve();
    const create = (key: string, target: LocalDatasetHost) =>
      target.apps.request(published.publicationId, "create", { authorityRevision: published.authorityRevision, idempotencyKey: key, fields: { destination: "Tokyo" } }) as Promise<Receipt>;
    // The engine commits this write and its answer is lost.
    w.control.wrap = real => ({ ...real, async create(envelope) { await real.create(envelope); throw new Error("The engine connection closed."); } });
    await expect(create("committed", host)).rejects.toBeInstanceOf(LocalAppUnavailableError);
    // This write never reaches the engine.
    w.control.wrap = real => ({ ...real, async create() { throw new Error("The engine connection closed."); } });
    await expect(create("unsent", host)).rejects.toBeInstanceOf(LocalAppUnavailableError);
    expect(host.apps.list("trip")[0]).toMatchObject({ pendingCreates: 2 });
    w.control.down = true;
    await host.close();
    await w.restartEngine();
    w.control.down = false; w.control.wrap = real => real;

    let reopened: LocalDatasetHost | undefined;
    await reconcileExistingLocalCollectionApps(w.root, async () => (reopened = await w.open()));
    await expect.poll(() => reopened!.apps.list("trip")[0], { timeout: REAL_DAEMON_DEADLINE_MS }).toMatchObject({ pendingCreates: 0 });
    // The first completes from its committed moment; the second is sent once the engine confirms it absent.
    for (const key of ["committed", "unsent"]) {
      const receipt = await create(key, reopened!);
      expect(await waitForPathMoments(w.capture, receipt.path, 1)).toEqual([expect.objectContaining({ id: receipt.momentId, objectId: receipt.objectId })]);
    }
  } finally { await w.close(); }
}, 2 * REAL_DAEMON_TEST_TIMEOUT_MS);

it.skipIf(engine.missing)("confirms withdrawal only after a held write commits in the real engine, and admits none afterward", async () => {
  const w = await tripWorkspace("withdraw");
  try {
    const gate = deferred();
    let held = 0;
    w.control.wrap = real => ({ ...real, async create(envelope) { held++; await gate.promise; return real.create(envelope); } });
    const { host, published } = await w.approve();
    const request = (key: string) => host.apps.request(published.publicationId, "create", { authorityRevision: published.authorityRevision, idempotencyKey: key, fields: { destination: "Tokyo" } });
    const pending = request("held").catch((error: unknown) => error);
    await expect.poll(() => held).toBe(1);
    const withdrawal = host.apps.withdraw(published.publicationId, published.authorityRevision);
    await expect(request("after")).rejects.toThrow(/approval changed/);
    gate.resolve();
    expect(await withdrawal).toEqual({ kind: "withdrawn", publicationId: published.publicationId, authorityRevision: published.authorityRevision + 1 });
    expect(await pending).toBeInstanceOf(Error);
    expect(host.apps.list("trip")[0]).toMatchObject({ active: false, pendingCreates: 0 });
    const responses = (await w.capture.listMoments({ limit: 100 })).moments.filter(moment => moment.path.startsWith("trip/responses/") && moment.path.endsWith(".md"));
    expect(responses).toHaveLength(1);
    expect(held).toBe(1);
  } finally { await w.close(); }
}, REAL_DAEMON_TEST_TIMEOUT_MS);
