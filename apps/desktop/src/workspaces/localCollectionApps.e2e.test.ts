import { mkdir, writeFile } from "node:fs/promises";
import { readLocalStateFrom } from "./workspaceLocalState";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";
import { compileClosedApp } from "./closedAppCompiler";
import { LocalAppUnavailableError } from "./localAppLaunch";
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
