import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import type {BrowserContext, Page} from "@playwright/test";
import {expect as browserExpect} from "@playwright/test";
import {expect, vi} from "vitest";
import {createEngineClient} from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
import type {OrderedLiveUpdateCutPolicy} from "../../../packages/ydoc-projection/src/orderedLiveUpdateCut.js";
import type {ServiceActivationConfig} from "../../sync-relay/src/serviceActivationDriver.js";
import type {PublicTransitionHarness, PublicTransitionFixture} from "./publicTransitionRuntime.integration-helper.js";
import {assertPublicApplication} from "./publicTransitionRuntime.integration-helper.js";
import {workloadHash as hash, type LoadedPublicTransitions} from "./publicTransitionWorkload.integration-helper.js";

const transport = vi.hoisted(() => ({relayUrl: "", transforms: [] as {from: string; to: string; insecureLoopbackForTests: true}[]}));
// Same transport seam as serviceActivationNative: native ordinary sync stays real,
// with its logical HTTPS relay replaced only by this fixture's owned loopback listener.
vi.mock("../../../packages/workspace-engine-client/src/daemon/engineClient.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/workspace-engine-client/src/daemon/engineClient.js")>();
  return {...actual, createEngineClient: async (options: Parameters<typeof actual.createEngineClient>[0]) => {
    const path = options.env?.DOHC_ENGINE_LIVE_HOST_CONFIG;
    if (path && transport.relayUrl) {
      const config = JSON.parse(readFileSync(path, "utf8"));
      for (const workspace of config.workspaces) if (workspace.relay?.baseUrl === "https://public-proof-relay.example.test") {
        const destination = new URL(transport.relayUrl);
        if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1" || destination.username || destination.password || destination.search || destination.hash) throw new Error("Invalid owned relay transport.");
        transport.transforms.push({from: workspace.relay.baseUrl, to: destination.origin, insecureLoopbackForTests: true});
        workspace.relay = {...workspace.relay, baseUrl: destination.origin, allowInsecureLoopbackForTests: true};
      }
      writeFileSync(path, JSON.stringify(config));
    }
    return actual.createEngineClient(options);
  }};
});

export interface AutomaticViewAdmission {
  readContexts: number;
  maxPagesPerPull: number;
  activation: Omit<ServiceActivationConfig, "targets" | "validateBaseline" | "validateJournal">;
  adoption: {maxBytes: number; maxEvents: number; ownerOutbox: {maxPendingBytes: number; maxPendingAgeMs: number}};
}
interface Options {
  h: PublicTransitionHarness; selected: LoadedPublicTransitions["cases"]["view"];
  admission: AutomaticViewAdmission; executable: string; relayUrl: string; ownerToken: string;
  native: Record<string, unknown>; validation: OrderedLiveUpdateCutPolicy; maxRegistrations: number;
  replaceHost(config: unknown): Promise<void>;
  newView(url: string): Promise<{context: BrowserContext; page: Page}>;
}

export async function runPublicAutomaticView(options: Options) {
  const {h, selected, admission} = options;
  if (!Number.isSafeInteger(admission.readContexts) || admission.readContexts < 1 || !Number.isSafeInteger(admission.maxPagesPerPull) || admission.maxPagesPerPull < 1) throw new Error("Explicit View and ordinary replication admission is required.");
  const ownerRoot = join(h.root, "view-owner"), serviceRoot = join(h.root, "view-service"); mkdirSync(ownerRoot); mkdirSync(serviceRoot);
  const workspaceId = "public-view-workspace", path = "docs/view.md";
  mkdirSync(join(ownerRoot, "docs")); writeFileSync(join(ownerRoot, path), selected.baseline.markdown);
  const owner = await createEngineClient({command: options.executable, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"], connectTimeoutMs: h.timeoutMs,
    env: {...process.env, DOHC_ENGINE_LIVE_HOST_CONFIG: undefined, DOHC_ENGINE_OWNER_HOST_CONFIG: undefined}});
  const views: Awaited<ReturnType<Options["newView"]>>[] = [], peers: Awaited<ReturnType<PublicTransitionHarness["openLink"]>>[] = [];
  let socket: Awaited<ReturnType<typeof h.wire.connect>> | undefined;
  let completed = false;
  let stopObservingSettlements: (() => void) | undefined;
  const rounds: Record<string, unknown>[] = [];
  h.evidence.automaticView = {verdict: "INCOMPLETE", rounds, concurrency: h.concurrency, admittedReadContexts: admission.readContexts};
  let requestId = 1;
  try {
    const opened = await owner.sendRequest({id: requestId++, method: "workspace.open", params: {rootDir: ownerRoot, workspaceId, captureMode: "none",
      relay: {baseUrl: options.relayUrl, bearerToken: options.ownerToken, allowInsecureLoopbackForTests: true}}, deadlineMs: h.timeoutMs});
    const handle = (opened.result as {workspace: string}).workspace;
    const rpc = async <T = unknown>(method: string, params: Parameters<typeof owner.sendRequest>[0]["params"]) => {
      const response = await owner.sendRequest({id: requestId++, workspace: handle, method, params, deadlineMs: h.timeoutMs});
      return response.result as T;
    };
    await rpc("sync.claim", {workspaceId});
    const mainVersionId = (await rpc<{id: string}>("versions.ensureMain", {})).id as string;
    async function pushAll() {
      for (let page = 0; ; page++) {
        if (page >= admission.maxPagesPerPull) throw new Error("Ordinary push exceeded admitted page budget.");
        const pushed = await rpc<{status: string; hasMore: boolean; refusals: unknown[]; sharingDeclined: unknown[]; ownerAdmissionPending: unknown[]}>("sync.push", {workspaceId});
        expect(pushed.status).toBe("complete"); expect(pushed.refusals).toEqual([]);
        expect(pushed.sharingDeclined).toEqual([]); expect(pushed.ownerAdmissionPending).toEqual([]);
        if (!pushed.hasMore) return;
      }
    }
    // Establish ordinary enrollment before the owner creates a replicated live lineage.
    await pushAll();
    const written = await rpc<{object: {id: string}}>("versionedText.write", {workspaceId, versionId: mainVersionId, path, text: selected.baseline.markdown.toString(), origin: "api", requestId: randomUUID()});
    const objectId = written.object.id as string;
    const editor = await rpc<{sessionId: string}>("ydoc.open", {versionId: mainVersionId, path, expectedObjectId: objectId, contentKind: "richdoc"});
    await rpc("ydoc.recordUpdate", {sessionId: editor.sessionId, updateBase64: selected.baseline.checkpoint.toString("base64"), seed: true});
    await rpc("ydoc.settle", {sessionId: editor.sessionId}); await rpc("ydoc.close", {sessionId: editor.sessionId});
    await pushAll();
    const link = await h.ownerRequest(`/sync/${workspaceId}/shares/links`, {paths: [path], access: "edit"});
    const viewLink = await h.ownerRequest(`/sync/${workspaceId}/shares/${link.shareId}/links`, {access: "view"});
    const identity = h.storage.getWorkspaceBootstrap(workspaceId).identity;
    if (!identity) throw new Error("Ordinary owner bootstrap identity missing.");
    transport.relayUrl = options.relayUrl;
    const {hostId, instanceId} = h.host().coordinate;
    await options.replaceHost({version: 1, ...options.native, engineExecutable: options.executable, hostId, instanceId,
      workspaces: [{root: serviceRoot, workspaceId, maxRegistrations: options.maxRegistrations, ordinaryReplication: {
        relay: {baseUrl: "https://public-proof-relay.example.test", bearerToken: options.ownerToken},
        identity: {kind: "join", replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity}, maxPagesPerPull: admission.maxPagesPerPull}}],
      adoption: admission.adoption, activation: {...admission.activation, validation: options.validation, targets: [{workspaceId, path, shareId: link.shareId}]}});
    const fixture: PublicTransitionFixture = {document: {workspaceId, mainVersionId, objectId, lineageClaimId: hash(selected.baseline.checkpoint)}, path, link};
    await browserExpect.poll(() => h.storage.resolveCurrentLiveDocumentBinding({document: fixture.document,
      actor: {kind: "owner", userId: h.ownerUserId, shareId: link.shareId}}).kind, {timeout: h.timeoutMs}).toBe("current");
    for (let index = 0; index < admission.readContexts; index++) {
      const view = await options.newView(viewLink.url); views.push(view);
      await browserExpect.poll(async () => hash(Buffer.from(await view.page.locator("article.markdown").textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(selected.baseline.viewText));
      await browserExpect(view.page.getByRole("button", {name: "Edit file", exact: true})).toHaveCount(0);
    }
    for (let index = 0; index < h.concurrency; index++) peers.push(await h.openLink(link.url, index));
    const writer = peers.at(-1)!;
    await writer.page.getByRole("button", {name: "Back to shared files", exact: true}).click();
    await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency - 1);
    socket = await h.wire.connect(writer.context, await h.wire.ticket(writer.context, writer.discriminator, objectId), "automatic-view-writer"); await socket.sync();
    await browserExpect.poll(h.listeners, {timeout: h.timeoutMs}).toBe(h.concurrency);
    const measuredHost = h.host(), manualSettlements = vi.fn(measuredHost.settle);
    const hostAccess = vi.spyOn(h, "host").mockReturnValue({...measuredHost, settle: manualSettlements});
    stopObservingSettlements = () => hostAccess.mockRestore();
    for (const step of selected.updates) {
      // The observer is armed before submission. No mocked clock or explicit settle participates.
      await Promise.all(views.map(view => view.page.evaluate(expected => {
        const state = {expected, renderedAt: null as number | null, observer: undefined as MutationObserver | undefined};
        Object.assign(globalThis, {publicViewObservation: state});
        const inspect = () => {if (globalThis.document.querySelector("article.markdown")?.textContent === expected) {state.renderedAt = Date.now(); observer.disconnect();}};
        const observer = new MutationObserver(inspect); state.observer = observer;
        observer.observe(globalThis.document.body, {subtree: true, childList: true, characterData: true}); inspect();
      }, step.expected.viewText.toString())));
      const submittedAt = Date.now(), outcome = await socket.submit(step.bytes, step.deliveryId);
      if (outcome.kind !== "result" || outcome.result !== "success") throw new Error("Automatic View update was not durably acknowledged.");
      const ack = await assertPublicApplication(h, fixture, step), hostReceiptObservedAt = socket.receiptTimes.get(step.deliveryId)!;
      const renderedAt = await Promise.all(views.map(async view => {
        await view.page.waitForFunction(() => (globalThis as typeof globalThis & {publicViewObservation: {renderedAt: number | null}}).publicViewObservation.renderedAt !== null, undefined, {timeout: h.timeoutMs});
        expect(hash(Buffer.from(await view.page.locator("article.markdown").textContent() ?? ""))).toBe(hash(step.expected.viewText));
        return view.page.evaluate(() => (globalThis as typeof globalThis & {publicViewObservation: {renderedAt: number}}).publicViewObservation.renderedAt);
      }));
      // Submission precedes the durable receipt, so this also conservatively bounds receipt-to-render.
      for (const time of renderedAt) {expect(time).toBeGreaterThanOrEqual(submittedAt); expect(time - submittedAt).toBeLessThanOrEqual(5000);}
      for (const peer of peers.slice(0, -1)) await browserExpect.poll(async () => hash(Buffer.from(await peer.editor.textContent() ?? "")), {timeout: h.timeoutMs}).toBe(hash(step.expected.editorText));
      expect(hash(readFileSync(join(serviceRoot, path)))).toBe(hash(step.expected.markdown));
      rounds.push({deliveryId: step.deliveryId, ack, submittedAt, hostReceiptObservedAt, renderedAt,
        conservativeSubmitToViewMs: renderedAt.map(time => time - submittedAt), markdownSha256: hash(step.expected.markdown)});
    }
    const manualSettlementsDuringMeasurement = manualSettlements.mock.calls.length;
    expect(manualSettlementsDuringMeasurement).toBe(0);
    completed = true;
    return {verdict: "PASS", concurrency: h.concurrency, readContexts: views.length, manualSettlementsDuringMeasurement,
      acceptedEnvelopeMs: 5000, rounds, internalRelayTransport: transport.transforms, publicBrowserTransport: "HTTPS/WSS"};
  } finally {
    stopObservingSettlements?.();
    const cleanup = await Promise.allSettled([socket?.close(), ...peers.map(peer => peer.context.close()), ...views.map(async view => {
      try {await view.page.evaluate(() => (globalThis as typeof globalThis & {publicViewObservation?: {observer?: MutationObserver}}).publicViewObservation?.observer?.disconnect());}
      finally {await view.context.close();}
    }), (async () => {owner.close(); await owner.waitForExit();})()]);
    transport.relayUrl = "";
    const failures = cleanup.filter(result => result.status === "rejected");
    if (failures.length) {
      if (completed) throw new AggregateError(failures.map(result => result.reason), "Automatic View cleanup failed.");
      console.error("Automatic View cleanup failures after original failure:", failures);
    }
  }
}
