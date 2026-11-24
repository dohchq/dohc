import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./document-size-fixtures.mjs";

// A native host uses the packaged engine. Operator config comes from the measured
// checkout, including its admission/reservation refusals; the harness raises no bound.
export async function startDocumentNativeHost(options, deployment) {
  const load = (path) => import(pathToFileURL(join(options.checkout, path)).href);
  const [
    { createEngineClient },
    { startServiceLiveHost },
    { selfHostLiveProfile },
    { createNamedFrameChanges },
  ] = await Promise.all([
    load("packages/workspace-engine-client/src/daemon/engineClient.ts"),
    load("services/sync-relay/src/serviceLiveHost.ts"),
    load("services/sync-relay/src/selfHostLiveProfile.ts"),
    load("services/sync-relay/src/liveHostChanges.ts"),
  ]);
  const workspace = join(options.directory, "native-workspace");
  await mkdir(workspace, { recursive: true });
  const seed = await createEngineClient({
    command: options.engineBinary,
    authToken: "document-size-seed",
    protocolVersion: 2,
    capabilities: ["core"],
    connectTimeoutMs: 30000,
  });
  try {
    const opened = await seed.sendRequest({
      id: 1,
      method: "workspace.open",
      params: { rootDir: workspace, workspaceId: "workspace", captureMode: "none" },
      deadlineMs: 30000,
    });
    const main = await seed.sendRequest({
      id: 2,
      method: "versions.ensureMain",
      workspace: opened.result.workspace,
      params: {},
      deadlineMs: 30000,
    });
    assert.equal(main.result.id, "main");
  } finally {
    seed.close();
    await seed.waitForExit();
  }
  const profile = selfHostLiveProfile();
  const { ingress, client, settlement, sync, adoption } = profile.service;
  const configPath = join(options.directory, "native-host.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        engineExecutable: options.engineBinary,
        hostId: "host",
        instanceId: "instance",
        workspaces: [
          { root: workspace, workspaceId: "workspace", maxRegistrations: options.sessions },
        ],
        ingress,
        client,
        settlement,
        sync,
        adoption,
      },
      null,
      2,
    ),
  );
  const frameChanges = createNamedFrameChanges(128);
  const start = () =>
    startServiceLiveHost({
      trustedAccount: (accountId) => ({ accountId, name: "Benchmark account" }),
      configPath,
      ...deployment,
      frameChanges,
      signal: options.signal,
    });
  let active = await start();
  const result = {
    configSha256: sha256(await readFile(configPath)),
    profile,
    joins: [],
    settlements: [],
    restartVerified: false,
  };
  const joinDocument = async (entry, Y, projection, phase) => {
    const started = performance.now();
    await active.drain(entry.document, options.signal);
    const current = deployment.storage.resolveCurrentLiveDocumentBinding({
      document: entry.document,
      actor: { kind: "named", grantId: "grant", userId: "reader" },
    });
    assert.equal(current.kind, "current");
    const capture = await active.captureNative(current.binding, options.signal);
    const response = await capture.client.openLiveAppliedSync(
      {
        id: capture.nextRequestId(),
        workspace: capture.workspace,
        registrationId: capture.registrationId,
        deadlineMs: capture.deadlineMs,
      },
      Uint8Array.of(0),
      {
        maxInputBytes: sync.policy.maxClientVectorBytes,
        maxOutputBytes: sync.policy.maxOutputBytes,
      },
    );
    const browser = new Y.Doc();
    try {
      Y.applyUpdate(browser, response.missingStateUpdate);
      assert.equal(
        sha256(projection.yDocToMarkdown(browser)),
        sha256(projection.yDocToMarkdown(entry.doc)),
      );
      result.joins.push({
        phase,
        ms: performance.now() - started,
        bytes: response.missingStateUpdate.byteLength,
        verified: true,
      });
    } finally {
      browser.destroy();
    }
  };
  return {
    get coordinate() {
      return active.coordinate;
    },
    result,
    capture(binding, signal) {
      return active.captureNative(binding, signal);
    },
    onRestart: null,
    async join(entries, Y, projection, phase = "fresh") {
      for (let n = 0; n < (options.joinRepeats ?? 10); n++)
        for (const entry of entries) await joinDocument(entry, Y, projection, phase);
    },
    async apply(entry) {
      const started = performance.now();
      const delivery = await active.drain(entry.document, options.signal);
      if (delivery.kind !== "done") throw Error("Native application did not complete");
      return performance.now() - started;
    },
    async finish(entries, Y, projection) {
      for (const entry of entries) {
        const started = performance.now();
        const settled = await active.settle(entry.document, options.signal);
        assert.equal(
          sha256(await readFile(join(workspace, entry.currentPath))),
          sha256(projection.yDocToMarkdown(entry.doc)),
        );
        result.settlements.push({
          ms: performance.now() - started,
          verified: true,
          receipt: settled,
        });
      }
      await active.close();
      active = await start();
      await this.join(entries, Y, projection, "restart");
      result.restartVerified = true;
      await this.onRestart?.();
    },
    async close() {
      await active.close();
    },
  };
}
