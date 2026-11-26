import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openedLocalState } from "../testing/preparedLocalState";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { datasetResponseAction, readDatasetResponse } from "../ipc/readDatasetResponse";
import { isDatasetServerNotFound, markDatasetServerNotFound } from "../ipc/errorWords";
import { compileClosedApp } from "./closedAppCompiler";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { createLocalDatasetHost } from "./localDatasetHost";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { sendCollectionsUp } from "./collectionMove";
import { createServerCollectionsTransport } from "./serverDatasetApps";
import {
  sealWorkspaceSecret,
  workspaceSecretKeyring,
} from "../../../../services/sync-relay/src/workspaceSecretCrypto";
import {
  definition,
  id,
  operationSource,
  revision,
  schemaSql,
  startTestRelay,
} from "./serverCollectionsTestRelay";

// DOHC_TRIP_TIMES=<round trip ms> also prints how long an app change and a
// Collection's creation take over a network with that round trip.
const roundTripMs = Number(process.env.DOHC_TRIP_TIMES ?? 0);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function computerWithApp(latencyMs = 0) {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  await relay.activate();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-server-app-"));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const trips: string[] = [];
  // Requests the server has answered, and a wait a test can put before a request reaches it. A request held in
  // `before` has not left this computer: once its caller stops waiting, it is never sent. A request held in `late`
  // has left: its caller can stop waiting, and the server still takes it. `deliveries` settles with each request
  // once the server has answered it or it can no longer reach the server. A request held in `lookup` waits, as
  // main's does for this computer's server session, for a step its signal does not stop.
  const answered: string[] = [];
  const gate: {
    lookup?: (trip: string) => Promise<void>;
    before?: (trip: string) => Promise<void>;
    late?: (trip: string) => Promise<void>;
  } = {};
  const deliveries: Array<Promise<unknown>> = [];
  const server = createServerCollectionsTransport("w", async (path, body, signal) => {
    const trip = path.replace(/^\/sync\/w\/[^/]+\/[^/]+\//, "");
    trips.push(trip);
    const lookup = gate.lookup?.(trip);
    if (lookup) {
      deliveries.push(lookup);
      await lookup;
    }
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const send = (signal?: AbortSignal) =>
      fetch(`${relay.origin}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    const delivery = (async () => {
      await gate.before?.(trip);
      const late = gate.late;
      if (!late) return send(signal);
      await late(trip);
      return send();
    })();
    deliveries.push(delivery.catch(() => undefined));
    const response = await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      delivery.then(resolve, reject);
    });
    answered.push(trip);
    // Read as main's transport reads the server's answer.
    const value = (await readDatasetResponse(
      response,
      datasetResponseAction(path) ?? "describe",
      new AbortController().signal,
    )) as { code?: string } | null;
    if (!response.ok)
      throw markDatasetServerNotFound(
        new Error(`${response.status} ${value?.code ?? ""}`),
        response.status,
        value,
      );
    return value;
  });
  const open = async () => {
    const host = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot,
      compile: createDatasetFixtureCompiler(),
      collectionsServer: () => server,
      external: {
        unavailable: () => null,
        call: () => Promise.reject(new Error("Sent from this computer.")),
      },
    });
    cleanups.push(() => host.close());
    return host;
  };
  const host = await open();
  const files = new Map<string, string>([["data/dataset.json", JSON.stringify(definition)]]);
  const generated = generateDatasetFormSources({
    datasetPath: "data/dataset.json",
    approvedRevision: revision,
    tableId: id(2),
    createOperationId: id(5),
    appRoot: "app",
    fieldIds: [id(4)],
  });
  for (const [path, source] of Object.entries(generated.files)) files.set(`app/${path}`, source);
  const prepareApp = (versionId = "main") =>
    prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "app", versionId },
      {
        deferredWrites: [],
        adapter: sourceCaptureAdapter(files),
        compile: compileClosedApp,
        signal: new AbortController().signal,
        assertCurrent() {},
        resolveDatasetRevision: async () => revision,
      },
    );
  const app = await prepareApp();
  const published = await host.apps.activate(app, new AbortController().signal);
  const submit = (name: string, authorityRevision = published.authorityRevision) => ({
    authorityRevision,
    operation: "add",
    idempotencyKey: `submit-${name}`,
    input: { values: { [id(4)]: name } },
  });
  const names = async () =>
    ((await (await relay.computer()).read()).result as Array<{ name: string }>).map(
      (row) => row.name,
    );
  // A change sent to the server directly, as the app at the server's latest approval of it.
  const serverChange = () =>
    server.request(
      published.publicationId,
      "invoke",
      submit("Drew", relay.appRevision(published.publicationId)),
    );
  // What the server answers that change: "ran", or the refusal's status.
  const serverRuns = () =>
    serverChange().then(
      () => "ran",
      (error: Error) => error.message.slice(0, 3),
    );
  // Holds the next request of this kind before it leaves this computer, until `release`.
  const hold = (kind: "lookup" | "before" | "late", trip: string) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      gate[kind] = async (sent) => {
        if (sent !== trip) return;
        gate[kind] = undefined;
        resolve();
        await new Promise<void>((go) => (release = go));
      };
    });
    return { held, release: () => release() };
  };
  return {
    relay,
    server,
    host,
    open,
    app,
    files,
    prepareApp,
    published,
    submit,
    names,
    trips,
    answered,
    gate,
    deliveries,
    serverChange,
    serverRuns,
    hold,
  };
}

it("approves an app on this computer over a Collection on the workspace's server, and the server runs its changes as that app", async () => {
  const f = await computerWithApp();
  expect(
    await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex")),
  ).toMatchObject({ replayed: false });
  expect(await f.names()).toEqual(["Alex"]);

  // The server holds the approval: an action outside it is refused there, not only here.
  await expect(
    f.server.request(f.published.publicationId, "invoke", {
      ...f.submit("Blake"),
      operation: "rename",
      input: { id: 1, name: "Blake" },
    }),
  ).rejects.toThrow(/^40[04]/);
  expect(await f.names()).toEqual(["Alex"]);
}, 60_000);

it("previews a non-Main version's app through the owner's reads, never approving it on the server", async () => {
  const f = await computerWithApp();
  await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex"));
  const manifest = JSON.parse(f.files.get("app/app.publish.json")!);
  manifest.dataset.operationIds = [id(5), id(6)];
  f.files.set("app/app.publish.json", JSON.stringify(manifest));
  f.trips.length = 0;
  const preview = await f.host.apps.activate(
    await f.prepareApp("feature"),
    new AbortController().signal,
  );
  expect(f.host.apps.list("app", "feature")).toMatchObject([{ versionId: "feature" }]);
  expect(
    await f.host.apps.request(preview.publicationId, "invoke", {
      authorityRevision: preview.authorityRevision,
      operation: "read",
      idempotencyKey: "read-one",
      input: {},
    }),
  ).toMatchObject({ result: [{ name: "Alex" }] });
  for (const action of ["invoke", "attempt", "upload"] as const)
    await expect(
      f.host.apps.request(
        preview.publicationId,
        action,
        f.submit("Blake", preview.authorityRevision),
      ),
    ).rejects.toThrow(
      "Previews of non-Main versions are read-only. Merge into Main to save changes to this Collection.",
    );
  expect(f.trips).toEqual(["invoke"]);
  expect(await f.names()).toEqual(["Alex"]);
}, 60_000);

it("tells an app on this computer why the server refused its change", async () => {
  const f = await computerWithApp();
  const refused = f.host.apps.request(f.published.publicationId, "invoke", f.submit("Full"));
  await expect(refused).rejects.toBeInstanceOf(AppBackendRuntimeError);
  await expect(refused).rejects.toMatchObject({
    refusal: { code: "full", message: "This list is full." },
  });
  expect(await f.names()).toEqual([]);
}, 60_000);

it("approves an app again after another computer replaces it on the server", async () => {
  const f = await computerWithApp();
  await f.server.withdraw(id(1), f.published.publicationId);
  expect(
    await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex")),
  ).toMatchObject({ replayed: false });
  expect(await f.names()).toEqual(["Alex"]);
}, 60_000);

it("sends one request for an app's change on this computer", async () => {
  const f = await computerWithApp();
  f.trips.length = 0;
  await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex"));
  await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Blake"));
  expect(f.trips).toEqual(["backend/invoke", "backend/invoke"]);
}, 60_000);

it("keeps working after another computer approves the same app", async () => {
  const f = await computerWithApp();
  // The other computer's approval of the same app, as it sends it to the server.
  await f.server.approve(
    parseAppPublicationCandidate(f.app.candidate, APP_PUBLICATION_LIMITS),
    new AbortController().signal,
  );
  expect(
    await f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex")),
  ).toMatchObject({ replayed: false });
  expect(await f.names()).toEqual(["Alex"]);
}, 60_000);

it("after a restart, gives the server this computer's approval again before the app's first change", async () => {
  const f = await computerWithApp();
  await f.host.close();
  const reopened = await f.open();
  expect(
    await reopened.apps.request(f.published.publicationId, "invoke", f.submit("Casey")),
  ).toMatchObject({ replayed: false });
  expect(await f.names()).toEqual(["Casey"]);
}, 60_000);

it("withdrawing the app on this computer withdraws it on the server", async () => {
  const f = await computerWithApp();
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  await expect.poll(f.serverRuns).toBe("404");
  expect(await f.names()).toEqual([]);
}, 60_000);

it("withdraws the app on the server once it can be reached, after a withdrawal that could not reach it", async () => {
  const f = await computerWithApp();
  f.gate.before = async (trip) => {
    if (trip !== "binding") return;
    f.gate.before = undefined;
    throw new TypeError("fetch failed");
  };
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  await expect.poll(f.serverRuns, { timeout: 15_000, interval: 1_000 }).toBe("404");
}, 60_000);

it("runs no change from an app withdrawn here while the change was on its way, and does not approve it again", async () => {
  const f = await computerWithApp();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    f.gate.before = async (trip) => {
      if (trip !== "backend/invoke") return;
      f.gate.before = undefined;
      resolve();
      await new Promise<void>((go) => (release = go));
    };
  });
  const change = f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex"));
  change.catch(() => undefined);
  await held;
  f.answered.length = 0;
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  // The server takes the withdrawal before the change reaches it.
  await expect.poll(() => f.answered).toContain("binding");
  release();
  await expect(change).rejects.toThrow();
  expect(await f.names()).toEqual([]);
  // The server still refuses the app: nothing approved it again.
  await expect(f.serverChange()).rejects.toThrow(/^404/);
  expect(await f.names()).toEqual([]);
}, 60_000);

it("withdraws the app on the server after an approval that was on its way when the owner withdrew it here", async () => {
  const f = await computerWithApp();
  await f.host.close();
  const reopened = await f.open();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    // After a restart, the app's first change gives the server this computer's approval first.
    f.gate.before = async (trip) => {
      if (trip !== "binding") return;
      f.gate.before = undefined;
      resolve();
      await new Promise<void>((go) => (release = go));
    };
  });
  f.trips.length = 0;
  const change = reopened.apps.request(f.published.publicationId, "invoke", f.submit("Alex"));
  change.catch(() => undefined);
  await held;
  f.answered.length = 0;
  await reopened.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  // A withdrawal sent at once reaches the server before the approval.
  await expect
    .poll(
      () => f.answered.includes("binding") || f.trips.filter((t) => t === "binding").length === 1,
    )
    .toBe(true);
  release();
  await expect(change).rejects.toThrow();
  await expect.poll(f.serverRuns, { timeout: 10_000 }).toBe("404");
  expect(await f.names()).toEqual([]);
}, 60_000);

it("withdraws the app on the server after an approval this computer stopped waiting for, when the server takes that approval late", async () => {
  const f = await computerWithApp();
  await f.host.close();
  const reopened = await f.open();
  let release!: () => void;
  const sent = new Promise<void>((resolve) => {
    // After a restart, the app's first change gives the server this computer's approval first.
    f.gate.late = async (trip) => {
      if (trip !== "binding") return;
      f.gate.late = undefined;
      resolve();
      await new Promise<void>((go) => (release = go));
    };
  });
  const stop = new AbortController();
  const change = reopened.apps.request(
    f.published.publicationId,
    "invoke",
    f.submit("Alex"),
    stop.signal,
  );
  change.catch(() => undefined);
  await sent;
  stop.abort();
  await expect(change).rejects.toThrow();
  f.answered.length = 0;
  await reopened.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  // A withdrawal that does not wait for the approval reaches the server first. This wait times out when the
  // withdrawal waits, as it should; it only sets the order a withdrawal that did not wait would have.
  await expect
    .poll(() => f.answered.includes("binding"), { timeout: 1_000 })
    .toBe(true)
    .catch(() => undefined);
  release();
  // The server has taken the late approval: what it answers from here on follows it.
  await Promise.all(f.deliveries);
  await expect.poll(f.serverRuns, { timeout: 10_000 }).toBe("404");
  expect(await f.names()).toEqual([]);
}, 60_000);

it("keeps the app approved on the server when this computer approves it again while a withdrawal waits for that approval", async () => {
  const f = await computerWithApp();
  const approval = f.hold("before", "binding");
  // The same app approved again, as when the owner approves it a second time.
  const again = f.host.apps.activate(f.app, new AbortController().signal);
  await approval.held;
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  approval.release();
  await again;
  await Promise.all(f.deliveries);
  expect(f.host.apps.list("app", "main")).toEqual([
    expect.objectContaining({ publicationId: f.published.publicationId, active: true }),
  ]);
  expect(await f.serverRuns()).toBe("ran");
}, 60_000);

it("keeps the app approved on the server when this computer approves it again while its withdrawal is on its way", async () => {
  const f = await computerWithApp();
  const withdrawal = f.hold("before", "binding");
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  await withdrawal.held;
  const again = f.host.apps.activate(f.app, new AbortController().signal);
  again.catch(() => undefined);
  // An approval that does not wait for the withdrawal reaches the server first. This wait times out when the
  // approval waits, as it should; it only sets the order an approval that did not wait would have.
  await expect
    .poll(() => f.answered.includes("binding"), { timeout: 1_000 })
    .toBe(true)
    .catch(() => undefined);
  withdrawal.release();
  await again;
  await Promise.all(f.deliveries);
  expect(await f.serverRuns()).toBe("ran");
}, 60_000);

it("sends no withdrawal after the workspace closes, so it cannot undo an approval made after reopening", async () => {
  const f = await computerWithApp();
  const withdrawal = f.hold("before", "binding");
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  await withdrawal.held;
  await f.host.close();
  const reopened = await f.open();
  await reopened.apps.activate(f.app, new AbortController().signal);
  withdrawal.release();
  await Promise.all(f.deliveries);
  expect(await f.serverRuns()).toBe("ran");
}, 60_000);

it("closes while a withdrawal waits for this computer's server session, and sends that withdrawal nowhere", async () => {
  const f = await computerWithApp();
  f.answered.length = 0;
  const withdrawal = f.hold("lookup", "binding");
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  await withdrawal.held;
  await f.host.close();
  withdrawal.release();
  await Promise.all(f.deliveries);
  expect(f.answered).not.toContain("binding");
  expect(await f.serverRuns()).toBe("ran");
}, 60_000);

it("closes while an approval waits for this computer's server session", async () => {
  const f = await computerWithApp();
  await f.server.withdraw(id(1), f.published.publicationId);
  const approval = f.hold("lookup", "binding");
  f.answered.length = 0;
  const change = f.host.apps.request(f.published.publicationId, "invoke", f.submit("Alex"));
  change.catch(() => undefined);
  await approval.held;
  await f.host.close();
  await expect(change).rejects.toThrow();
  approval.release();
  await Promise.all(f.deliveries);
  expect(f.answered).not.toContain("binding");
}, 60_000);

it("withdraws the app on the server after every approval on its way, when two changes approve it again at once", async () => {
  const f = await computerWithApp();
  // Another computer replaced the approval, so both changes approve the app again.
  await f.server.withdraw(id(1), f.published.publicationId);
  const releases: Array<() => void> = [];
  f.gate.before = async (trip) => {
    if (trip !== "binding" || releases.length === 2) return;
    await new Promise<void>((go) => releases.push(go));
  };
  f.trips.length = 0;
  f.answered.length = 0;
  const changes = ["Alex", "Blake"].map((name) =>
    f.host.apps.request(f.published.publicationId, "invoke", f.submit(name)),
  );
  for (const change of changes) change.catch(() => undefined);
  await expect.poll(() => releases.length).toBe(2);
  await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
  const count = (trips: string[]) => trips.filter((trip) => trip === "binding").length;
  releases[1]!();
  // A withdrawal sent after the second approval reaches the server before the first.
  await expect.poll(() => count(f.answered) >= (count(f.trips) === 2 ? 1 : 2)).toBe(true);
  releases[0]!();
  for (const change of changes) await expect(change).rejects.toThrow();
  await expect.poll(f.serverRuns, { timeout: 10_000 }).toBe("404");
  expect(await f.names()).toEqual([]);
}, 60_000);

it("creates a Collection on the workspace's server from rules prepared here, and keeps none of it on this computer", async () => {
  const f = await computerWithApp();
  const prepared = await f.host.prepare({
    descriptorPath: "dataset.json",
    adapter: sourceCaptureAdapter(
      new Map([
        ["dataset.json", JSON.stringify({ ...definition, datasetId: id(9), name: "Second" })],
        [definition.schemaPath, schemaSql],
        [definition.operationsPath, operationSource],
      ]),
    ),
  });
  const approved = await f.host.approve({
    preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256,
  });
  expect(approved.revisionSha256).toBe(prepared.revision.revisionSha256);
  const computer = await f.relay.computer();
  expect((await computer.data.list({})).datasets.map((dataset) => dataset.datasetId)).toEqual([
    id(1),
    id(9),
  ]);
  expect(f.host.keptDatasetIds()).toEqual([]);
}, 60_000);

it.runIf(roundTripMs > 0)(
  "prints how long an app change and a Collection's creation take",
  async () => {
    const f = await computerWithApp(roundTripMs);
    const median = (values: number[]) =>
      Math.round(values.sort((a, b) => a - b)[Math.floor(values.length / 2)]! * 10) / 10;
    const changes: number[] = [];
    f.trips.length = 0;
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      await f.host.apps.request(f.published.publicationId, "invoke", f.submit(`n${index}`));
      changes.push(performance.now() - started);
    }
    const changeTrips = f.trips.length / 20;
    const creations: number[] = [];
    f.trips.length = 0;
    for (let index = 0; index < 5; index++) {
      const prepared = await f.host.prepare({
        descriptorPath: "dataset.json",
        adapter: sourceCaptureAdapter(
          new Map([
            ["dataset.json", JSON.stringify({ ...definition, datasetId: id(20 + index) })],
            [definition.schemaPath, schemaSql],
            [definition.operationsPath, operationSource],
          ]),
        ),
      });
      const started = performance.now();
      await f.host.approve({
        preparationId: prepared.preparationId,
        revisionSha256: prepared.revision.revisionSha256,
      });
      creations.push(performance.now() - started);
    }
    console.log(
      JSON.stringify({
        roundTripMs,
        appChange: { requests: changeTrips, medianMs: median(changes) },
        creation: {
          requests: f.trips.length / 5,
          trips: f.trips.slice(0, 1),
          medianMs: median(creations),
        },
      }),
    );
  },
  300_000,
);

it("replays, on the server, an app's change this computer made before the Collection went up", async () => {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-server-app-sent-"));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const send = async (path: string, init: RequestInit) => {
    const response = await fetch(`${relay.origin}${path}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: "Bearer owner" },
      ...(init.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    });
    // Read as main's transport reads the server's answer.
    const value = (await readDatasetResponse(
      response,
      datasetResponseAction(path) ?? "describe",
      new AbortController().signal,
    )) as { code?: string } | null;
    if (!response.ok)
      throw markDatasetServerNotFound(
        new Error(`${response.status} ${value?.code ?? ""}`),
        response.status,
        value,
      );
    return value;
  };
  const server = createServerCollectionsTransport("w", (path, body, signal) =>
    send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
  );
  let syncing = false;
  const host = await createLocalDatasetHost({
    holder: unguardedCollections,
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot,
    compile: createDatasetFixtureCompiler(),
    collectionsServer: () => (syncing ? server : null),
  });
  cleanups.push(() => host.close());
  const files = new Map<string, string>([
    ["data/dataset.json", JSON.stringify(definition)],
    [definition.schemaPath, schemaSql],
    [definition.operationsPath, operationSource],
  ]);
  const prepared = await host.prepare({
    descriptorPath: "data/dataset.json",
    adapter: sourceCaptureAdapter(files),
  });
  await host.approve({
    preparationId: prepared.preparationId,
    revisionSha256: prepared.revision.revisionSha256,
  });
  const generated = generateDatasetFormSources({
    datasetPath: "data/dataset.json",
    approvedRevision: revision,
    tableId: id(2),
    createOperationId: id(5),
    appRoot: "app",
    fieldIds: [id(4)],
  });
  for (const [path, source] of Object.entries(generated.files)) files.set(`app/${path}`, source);
  const app = await prepareLocalAppPublication(
    { workspaceId: "w", appRoot: "app", versionId: "main" },
    {
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      compile: compileClosedApp,
      signal: new AbortController().signal,
      assertCurrent() {},
      resolveDatasetRevision: async () => revision,
    },
  );
  const published = await host.apps.activate(app, new AbortController().signal);
  const submit = {
    authorityRevision: published.authorityRevision,
    operation: "add",
    idempotencyKey: "submit-before",
    input: { values: { [id(4)]: "Alex" } },
  };
  expect(await host.apps.request(published.publicationId, "invoke", submit)).toMatchObject({
    replayed: false,
  });

  const credentials = {
    serverUrl: relay.origin,
    relayUrl: relay.origin,
    email: "owner@example.test",
    userId: "owner",
    token: "owner",
  };
  const session = { credentials, credentialGeneration: 1 };
  expect(
    await sendCollectionsUp({
      local: host,
      workspaceId: "w",
      server: async () => session,
      currentCredentialGeneration: () => 1,
      relayStream: (_credentials, path, init) => send(path, init),
      signal: new AbortController().signal,
    }),
  ).toEqual(new Map());
  syncing = true;

  // A retry of the same change, as after a lost answer, finds the change the server now holds.
  expect(await host.apps.request(published.publicationId, "invoke", submit)).toMatchObject({
    replayed: true,
  });
  expect(
    ((await (await relay.computer()).read()).result as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  ).toEqual(["Alex"]);
}, 60_000);

it("tags 404 not_found responses on workspace local-apps withdrawals so retries stop cleanly", async () => {
  const relay = await startTestRelay();
  cleanups.push(() => relay.close());
  await relay.activate();
  const server = createServerCollectionsTransport("w", async (path, body, signal) => {
    const action = datasetResponseAction(path);
    const response = await fetch(`${relay.origin}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (action) {
      const value = (await readDatasetResponse(response, action, new AbortController().signal)) as {
        code?: string;
      } | null;
      if (!response.ok)
        throw markDatasetServerNotFound(
          new Error(`${response.status} ${value?.code ?? ""}`),
          response.status,
          value,
        );
      return value;
    }
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  });
  let caught: unknown;
  try {
    await server.withdraw("", "0".repeat(64), new AbortController().signal);
  } catch (error) {
    caught = error;
  }
  expect(isDatasetServerNotFound(caught)).toBe(true);
});

it("withdraws an app's outside calls on the server when a version that uses a Collection replaces it", async () => {
  const f = await computerWithApp();
  const manifest = f.files.get("app/app.publish.json")!;
  const { dataset: _, ...unconnected } = JSON.parse(manifest) as Record<string, unknown>;
  f.files.set(
    "app/app.publish.json",
    JSON.stringify({
      ...unconnected,
      external: {
        events: {
          method: "GET",
          url: "https://us.posthog.com/api/events/",
          secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
        },
      },
    }),
  );
  const outside = await f.host.apps.activate(await f.prepareApp(), new AbortController().signal);
  await expect(
    f.host.apps.external!(
      outside.publicationId,
      { authorityRevision: outside.authorityRevision, operation: "events", input: {} },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ refusal: { code: "external_unavailable" } });
  const onServer = () =>
    f.relay.storage.db
      .prepare(
        "SELECT candidate FROM sync_relay_local_dataset_apps WHERE workspace_id='w' AND app_id=?",
      )
      .get(outside.publicationId)?.candidate;
  expect(onServer()).toContain("us.posthog.com");
  f.files.set("app/app.publish.json", manifest);
  await f.host.apps.activate(await f.prepareApp(), new AbortController().signal);
  await expect.poll(onServer).toBe("");
});

it("sends a synced workspace's outside call through its server, which adds the secret, and withdraws the app there too", async () => {
  const sent: unknown[] = [];
  const relay = await startTestRelay({
    appExternalTransport: {
      resolve: async (rawUrl) => {
        const url = new URL(rawUrl);
        return {
          href: url.href,
          url,
          canonicalHost: url.hostname,
          address: "93.184.216.34",
          family: 4,
        };
      },
      read: async (request) => {
        sent.push(request.headers.Authorization);
        return {
          status: 200,
          contentType: "application/json",
          contentEncoding: null,
          body: Buffer.from('{"events":3}'),
        };
      },
    },
  });
  cleanups.push(() => relay.close());
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-server-external-"));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const server = createServerCollectionsTransport("w", async (path, body, signal) => {
    const response = await fetch(`${relay.origin}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const value = (await readDatasetResponse(
      response,
      datasetResponseAction(path) ?? "describe",
      new AbortController().signal,
    )) as { code?: string } | null;
    if (!response.ok)
      throw markDatasetServerNotFound(new Error(String(response.status)), response.status, value);
    return value;
  });
  let paused: string | null = null;
  const host = await createLocalDatasetHost({
    holder: unguardedCollections,
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot,
    compile: createDatasetFixtureCompiler(),
    collectionsServer: () => server,
    external: {
      unavailable: () => paused,
      call: () => Promise.reject(new Error("Sent from this computer.")),
    },
  });
  cleanups.push(() => host.close());
  const files = new Map([
    [
      "stats/app.publish.json",
      JSON.stringify({
        entryPath: "main.ts",
        inputs: ["main.ts"],
        packageMap: {},
        external: {
          events: {
            method: "GET",
            url: "https://us.posthog.com/api/events/",
            secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
          },
        },
      }),
    ],
    ["stats/main.ts", "export {};"],
  ]);
  const app = await prepareLocalAppPublication(
    { workspaceId: "w", appRoot: "stats", versionId: "main" },
    {
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      compile: compileClosedApp,
      signal: new AbortController().signal,
      assertCurrent() {},
      resolveDatasetRevision: async () => revision,
    },
  );
  const published = await host.apps.activate(app, new AbortController().signal);
  const call = (approved = published) =>
    host.apps.external!(
      approved.publicationId,
      { authorityRevision: approved.authorityRevision, operation: "events", input: {} },
      new AbortController().signal,
    );
  const onServer = (publicationId: string) =>
    expect.poll(
      () =>
        relay.storage.db
          .prepare(
            "SELECT candidate FROM sync_relay_local_dataset_apps WHERE workspace_id='w' AND app_id=?",
          )
          .get(publicationId)?.candidate,
    );
  // The server holds the workspace's secrets, and tells the owner what is missing.
  await expect(call()).rejects.toMatchObject({
    refusal: {
      code: "external_unavailable",
      message: "Secret POSTHOG_KEY isn't in Settings > Secrets.",
    },
  });
  const keyring = workspaceSecretKeyring({ linkKey: "server-collections-test-key" })!;
  const secret = {
    workspaceId: "w",
    ownerUserId: "owner",
    name: "POSTHOG_KEY",
    usage: "http-header" as const,
    allowedHosts: ["us.posthog.com"],
  };
  relay.storage.upsertWorkspaceSecret({
    ...secret,
    mode: "create",
    keyId: keyring.activeId,
    seal: (generation) =>
      sealWorkspaceSecret({
        ...secret,
        keyring,
        keyId: keyring.activeId,
        generation,
        plaintext: "phx_synced",
      }),
    nowMs: 10,
  });
  expect(await call()).toEqual({ status: 200, data: { events: 3 } });
  expect(sent).toEqual(["Bearer phx_synced"]);
  paused = "Sync is paused for this workspace.";
  await expect(call()).rejects.toMatchObject({ refusal: { code: "external_unavailable" } });
  expect(sent).toHaveLength(1);
  paused = null;
  files.set("stats/main.ts", "export const version = 2;");
  const updated = await host.apps.activate(
    await prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "stats", versionId: "main" },
      {
        deferredWrites: [],
        adapter: sourceCaptureAdapter(files),
        compile: compileClosedApp,
        signal: new AbortController().signal,
        assertCurrent() {},
        resolveDatasetRevision: async () => revision,
      },
    ),
    new AbortController().signal,
  );
  await onServer(published.publicationId).toBe("");
  expect(await call(updated)).toEqual({ status: 200, data: { events: 3 } });
  await host.apps.withdraw(updated.publicationId, updated.authorityRevision);
  await onServer(updated.publicationId).toBe("");
});
