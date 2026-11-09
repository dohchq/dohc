import {afterEach, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {appendFileSync, mkdirSync, realpathSync, writeFileSync} from "node:fs";
import {cpus, loadavg, platform, release} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {setTimeout as pace} from "node:timers/promises";
import {serveFetchHandler} from "@dohc/service-http";
import {createEngineClient} from "@dohc/workspace-engine-client/daemon";
import type {FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";
import {closeTestStorages, tempRoot} from "./testing";
import {initializeRelayDeployment, openRelayDeployment} from "./relayDeployment";
import {startServiceLiveHost} from "./serviceLiveHost";
import {startSelfHostedLiveHost} from "./selfHostedLiveHost";
import {createNamedFrameChanges} from "./liveHostChanges";
import {authorizeServiceHostReplication} from "./serviceHostCredential";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createFirstOpenPublisher} from "./firstOpenPublication";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import {createSyncRelayHandler} from "./server";

// The service host attaches each workspace with the relay's public HTTPS
// origin; this loopback relay stands for it, as selfHostedLiveNative.integration.ts does.
const harness = vi.hoisted(() => ({relayUrl: ""}));
vi.mock("@dohc/workspace-engine-client/daemon", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>();
  return {...actual, createEngineClient: async (options: Parameters<typeof actual.createEngineClient>[0]) => {
    const client = await actual.createEngineClient(options);
    if (!options.env?.DOHC_ENGINE_LIVE_HOST_CONFIG) return client;
    const send = client.sendRequest.bind(client);
    return Object.assign(client, {sendRequest: (...args: Parameters<typeof send>) => {
      const [request] = args;
      if (request.method === "liveApplication.attachWorkspace") {
        const params = request.params as Record<string, unknown> & {relay: Record<string, unknown>};
        args[0] = {...request, params: {...params, relay: {...params.relay, baseUrl: new URL(harness.relayUrl).origin,
          allowInsecureLoopbackForTests: true}} as typeof request.params};
      }
      return send(...args);
    }});
  }};
});

// #2069 under load: other writers keep appending to the note's workspace while
// the relay starts it through its first open. Every write moves the workspace
// log the relay's writer rechecks, so a publication can meet contention. The
// real caller (the service host's activation driver, its retries and its
// client), the real route, publisher, storage and validation executor, and the
// native engine on both sides. Liveness means the note activates: the relay
// publishes its base, and the host pulls, captures and completes the
// activation, while the appends go on.
//
// Contention: the first request is held, after the engine's check and after
// each catch-up, until the appender's next push has landed, so each of its
// writer attempts meets a moved log and it answers `contention`. Later
// requests run unheld, at the appender's own rate.
//
// Time: the relay's publisher and the host's first-open retries read one
// injected clock that runs SCALE times faster than real time, so the relay's
// one-minute quiet interval and the host's backoffs pass quickly. Builds, the
// engine's checks, captures and appends run in real time.

const engine = requireEngineBinaryOrSkip();
const profile = selfHostLiveProfile();
const WS = "workspace", OWNER = "owner-1", PATH = "docs/plain.md";
const relayOrigin = "https://service-activation-relay.example.test", key = Buffer.from("first-open-liveness-ticket-key-".repeat(2));
const firstOpenFetch: typeof fetch = (url, init) => fetch(String(url).replace(relayOrigin, harness.relayUrl), init);

// The budget, fixed before the first run.
/** The appending writer: an agent writing other files of the workspace, five a second, each pushed to the relay. */
const APPEND_EVERY_MS = 200;
/** How much faster the injected clock runs than real time. */
const SCALE = 10;
/** The note activates within this much real time of the service host starting, */
const RUN_BUDGET_MS = 180_000;
/** and through at most this many first-open requests, each with at most three writer attempts. */
const REQUEST_BUDGET = 8;

/** Deterministic jitter. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  await closeTestStorages();
});

it.skipIf(engine.missing)("activates a never-opened note through its first open while another writer keeps appending to its workspace", async () => {
  const executable = realpathSync(engine.require());
  const root = realpathSync(await tempRoot("first-open-liveness")), hostRoot = join(root, "service"), ownerRoot = join(root, "owner");
  mkdirSync(hostRoot); mkdirSync(join(ownerRoot, "docs"), {recursive: true}); mkdirSync(join(ownerRoot, "notes"));
  const configPath = join(root, "deployment.json"), relayPath = join(root, "relay", "relay.sqlite");
  initializeRelayDeployment({configPath, relayPath, continuityDirectory: join(root, "continuity")});
  // Storage reads first-open history, and the publisher builds, on the relay's one validation executor, as main.ts opens them.
  const {storage, history} = openRelayDeployment(configPath);
  cleanup.push(() => storage.close());
  const relayRead = new DatabaseSync(relayPath, {readOnly: true});
  cleanup.push(() => relayRead.close());

  const started = performance.now();
  const clock = () => started + (performance.now() - started) * SCALE;
  const virtualSeconds = () => Number(((clock() - started) / 1_000).toFixed(1));
  // What each first-open request answered, and what each writer attempt found.
  const requests: {atS: number; outcome: string; writerAttempts: string[]}[] = [];
  let writes: string[] = [];
  const writeFirstOpen = storage.writeFirstOpen.bind(storage);
  storage.writeFirstOpen = (proof, base, guard) => {
    const written = writeFirstOpen(proof, base, guard);
    writes.push(written.kind);
    return written;
  };
  // The appender's pushes, as they land at the relay.
  let appended = 0;
  const landed = new Set<() => void>();
  const nextAppend = () => new Promise<void>(resolve => landed.add(resolve));
  let held = false;
  const catchUpFirstOpen = storage.catchUpFirstOpen.bind(storage);
  storage.catchUpFirstOpen = async (proof, signal) => {
    const caught = await catchUpFirstOpen(proof, signal);
    if (held) await nextAppend();
    return caught;
  };
  let supervisor: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  const publish = createFirstOpenPublisher({storage, namespace: history.namespace, nowMs: clock,
    activation: () => supervisor?.current()?.activationConfig(), host: () => {
      const host = supervisor?.current();
      return host && {checkFirstOpenCandidate: async (...args: Parameters<typeof host.checkFirstOpenCandidate>) => {
        const answer = await host.checkFirstOpenCandidate(...args);
        if (held) await nextAppend();
        return answer;
      }};
    }});
  const firstOpen: typeof publish = async input => {
    writes = [];
    held = !requests.some(row => row.outcome === "contention");
    const outcome: FirstOpenOutcome = await publish(input);
    requests.push({atS: virtualSeconds(), outcome: outcome.kind === "unavailable" ? outcome.reason : outcome.kind === "refused" ? `refused:${outcome.reason}` : outcome.kind,
      writerAttempts: writes});
    return outcome;
  };
  const serviceReplication = createServiceHostReplication({storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen,
    authorize: input => authorizeServiceHostReplication(storage, {key, namespace: history.namespace, ...input})});
  const relayApp = createSyncRelayHandler({storage, shareWebOrigin: "https://share.example.test", relayExchangeKey: "first-open-liveness-exchange-".repeat(2),
    resolveActor: (request, workspaceId) => {
      if (request.headers.get("authorization") !== "Bearer owner") throw new Error("Only the owner's device calls this relay.");
      return {userId: OWNER, workspaceId};
    }});
  const relayHttp = serveFetchHandler({handler: request => request.headers.get("authorization")?.startsWith("Bearer dohc-service-v1.") ? serviceReplication(request) : relayApp(request),
    maxBodyBytes: () => 8_000_000, oversized: () => new Response(null, {status: 404}), failure: () => new Response(null, {status: 500})});
  relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
  cleanup.push(() => new Promise<void>(done => {relayHttp.closeAllConnections(); relayHttp.close(() => done());}));
  harness.relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`;

  // The owner's device, where an agent writes ordinary files.
  const owner = await createEngineClient({command: executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: 30_000,
    onStderr: value => appendFileSync(join(root, "owner-stderr.log"), value), privateLiveApplication: profile.nativeClient,
    env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}});
  cleanup.push(async () => {owner.close(); await owner.waitForExit();});
  let requestId = 1;
  const handle = ((await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId: WS, captureMode: "none",
    relay: {baseUrl: harness.relayUrl, bearerToken: "owner", allowInsecureLoopbackForTests: true}}, deadlineMs: 30_000})).result as {workspace: string}).workspace;
  const rpc = async (method: string, params: Record<string, string>, idempotencyKey?: string) =>
    (await owner.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: 30_000, ...(idempotencyKey === undefined ? {} : {idempotencyKey})})).result as Record<string, unknown>;
  const push = async () => {
    for (let page = 0; page < 8; page++) {
      const result = await rpc("sync.push", {workspaceId: WS});
      expect(result).toMatchObject({status: "complete", refusals: [], sharingDeclined: [], ownerAdmissionPending: []});
      if (!result.hasMore) return;
    }
    throw new Error("The owner's push exceeded its eight-page bound.");
  };
  await rpc("sync.claim", {workspaceId: WS});
  const mainVersionId = (await rpc("versions.ensureMain", {})).id as string;
  await push();
  const writeFile = async (path: string, text: string) => {
    writeFileSync(join(ownerRoot, path), text);
    const written = await rpc("versionedText.write", {workspaceId: WS, versionId: mainVersionId, path, text, origin: "api"}, randomUUID());
    await push();
    return (written.object as {id: string}).id;
  };
  // The note, written as a file. No device ever opens it.
  const objectId = await writeFile(PATH, "# Plan\n\nBring snacks.\n");
  storage.createShare({share: {shareId: "share", workspaceId: WS, granterUserId: OWNER, selectorJson: JSON.stringify({paths: ["docs"], versionId: null}), createdAtMs: Date.now()},
    grant: {grantId: "grant", shareId: "share", principalKind: "user", principalUserId: "collaborator-1", principalEmail: null, access: "edit", generation: 1,
      status: "active", createdAtMs: Date.now(), revokedAtMs: null, parentGrantId: null}});

  // The other writer: an agent writing notes outside the shared folder, at its steady rate, until the note activates.
  let appending = true;
  const appendStarted = performance.now();
  const appender = (async () => {
    for (let i = 0; appending; i++) {
      const tick = performance.now();
      await writeFile(`notes/agent-${i % 20}.md`, `Agent note ${i}\n`);
      appended++;
      for (const resolve of landed) resolve();
      landed.clear();
      const wait = APPEND_EVERY_MS - (performance.now() - tick);
      if (wait > 0) await pace(wait);
    }
  })();
  cleanup.push(async () => {appending = false; await appender;});
  const relayHead = () => Number(relayRead.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log WHERE workspace_id=?").get(WS)!.head);
  await vi.waitFor(() => expect(appended).toBeGreaterThan(3), {timeout: 30_000});

  const reports: string[] = [];
  const hostStarted = performance.now(), headAtStart = relayHead();
  supervisor = await startSelfHostedLiveHost({trustedAccount: accountId => ({accountId, name: accountId}), storage, history,
    frameChanges: createNamedFrameChanges(profile.namedLive.maxListeners), root: hostRoot, engineExecutable: executable, relayOrigin, key, firstOpenFetch,
    startHost: options => startServiceLiveHost({...options, firstOpen: {...options.firstOpen, nowMs: clock, random: seeded(2069)}}),
    onError: error => {reports.push(error instanceof Error ? error.message : String(error));}});
  cleanup.push(() => supervisor?.close());

  const activations = storage.createServiceActivationStore(history);
  const bases = () => relayRead.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND origin_id LIKE 'service-host:first-open:%'")
    .all(WS).map(row => JSON.parse(String(row.payload_json)) as {objectId: string; lineageClaimId: string});
  // Progress, for the record: each change in what the relay holds for the note.
  const progress: {atS: number; realS: number; step: string}[] = [];
  const step = (name: string) => {if (progress.at(-1)?.step !== name) progress.push({atS: virtualSeconds(), realS: Number(((performance.now() - hostStarted) / 1_000).toFixed(1)), step: name});};
  await vi.waitFor(() => {
    const activation = activations.read(WS, PATH, 1_000_000);
    step(activation?.completed ? "activated" : activation ? "activation prepared" : bases().length ? "base published" : `requests ${requests.length}`);
    expect(activation?.completed).toBe(true);
  }, {timeout: RUN_BUDGET_MS, interval: 100});
  const activatedMs = performance.now() - hostStarted, appendedBeforeActivation = appended, headAtActivation = relayHead();
  // The writer still ran when the note activated; it stops only now.
  expect(appending).toBe(true);
  appending = false;
  await appender;
  const appendSeconds = (performance.now() - appendStarted) / 1_000;

  const activation = activations.read(WS, PATH, 1_000_000)!;
  expect(bases()).toEqual([expect.objectContaining({objectId})]);
  expect(activation.source.lineageClaimId).toBe(bases()[0]!.lineageClaimId);
  expect(requests.filter(row => row.outcome === "published")).toHaveLength(1);
  console.log(JSON.stringify({environment: {node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cpus: cpus().length, loadavg: loadavg()},
    budget: {appendEveryMs: APPEND_EVERY_MS, scale: SCALE, runBudgetMs: RUN_BUDGET_MS, requestBudget: REQUEST_BUDGET},
    appender: {appended, appendsPerSecond: Number((appended / appendSeconds).toFixed(2)), rowsWhileFirstOpenRan: headAtActivation - headAtStart, appendedBeforeActivation},
    activatedRealSeconds: Number((activatedMs / 1_000).toFixed(1)), activatedVirtualSeconds: progress.at(-1)?.atS, requests, progress, reports}, null, 2));
  // The held request met a moved log on each of its three writer attempts; every request stopped within three.
  expect(requests.find(row => row.outcome === "contention")?.writerAttempts).toEqual(["retry", "retry", "retry"]);
  for (const row of requests) expect(row.writerAttempts.length).toBeLessThanOrEqual(3);
  expect(requests.length).toBeLessThanOrEqual(REQUEST_BUDGET);
  expect(activatedMs).toBeLessThanOrEqual(RUN_BUDGET_MS);
  // The appends went on through the first open: the workspace log moved while it ran.
  expect(headAtActivation).toBeGreaterThan(headAtStart);
}, 300_000);
