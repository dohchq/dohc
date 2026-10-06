import type { JsonValue, Request, Response } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions, type EngineDaemonClient, type FileWorkStats } from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { nativeWorkStatsDelta, NativeWorkStatsResult } from "./nativeWorkStats";
import { readNativeWorkStats } from "./readNativeWorkStats";

function stats(value = 4) {
  const work = { started: value, active: value, completed: value, cancelled: value, failed: value,
    boundsExceeded: value, entriesVisited: value, filesEnumerated: value, hashesReused: value,
    hashAttemptsCompleted: value, bytesReadForHashing: value };
  return { generation: "engine-generation-a", observation: { ...work }, capture: { ...work } } satisfies FileWorkStats;
}
const snapshot = (work = stats()): NativeWorkStatsResult => ({ workspaceId: "a", status: "available", stats: work });
const owners: EngineWorkspaceSessions[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.closeAll())); });

async function harness() {
  const root = await createTestScratch("dohc-profile-native-");
  const workspace = { workspaceId: "a", rootPath: root, attachmentId: Symbol("a") };
  const workStats = vi.fn(async (): Promise<unknown> => stats());
  const sendRequest = vi.fn(async (request: Request): Promise<Response> => {
    if (request.method === "workspace.open") return { id: request.id, result: { workspace: "binding-a" } };
    if (request.method === "workspace.close") return { id: request.id, result: { closed: true } };
    if (request.method === "files.workStats") return { id: request.id, result: await workStats() as JsonValue };
    throw new Error(`Unexpected native measurement side effect: ${request.method}`);
  });
  let client: EngineDaemonClient = { sendRequest, close() {}, onEvent: () => () => {} };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
  owners.push(sessions);
  let current = true;
  const session = { workspaceId: "a", attachmentId: workspace.attachmentId, generation: 1, isCurrent: () => current };
  const withOperation = createRendererWorkspaceOperationRunner<object, typeof workspace, Record<string, never>, typeof session>({
    currentSession: (_sender: object) => session,
    withPhysicalOperation: async (workspaceId, run) => run({
      workspace: workspaceId === "a" ? workspace : { ...workspace, workspaceId, attachmentId: Symbol("other") },
      state: {}, signal: new AbortController().signal, assertCurrent: () => undefined,
    }),
  });
  const read = (workspaceId = "a") => withOperation({}, workspaceId, "request retired", operation =>
    readNativeWorkStats(sessions, operation.workspace, operation.assertCurrent));
  return { workspace, sessions, read, workStats, sendRequest,
    retireRequest: () => { current = false; },
    replaceClient: () => { client = { sendRequest: vi.fn(), close() {}, onEvent: () => () => {} }; },
  };
}

describe("native work measurement reads", () => {
  it("never opens a missing binding or reads a different workspace", async () => {
    const h = await harness();
    await expect(h.read()).resolves.toMatchObject({ status: "unavailable", reason: "No current open engine binding." });
    await expect(h.read("b")).rejects.toThrow("request retired");
    expect(h.sendRequest).not.toHaveBeenCalled();
    expect(h.workStats).not.toHaveBeenCalled();
    await expect(readNativeWorkStats(null, h.workspace, () => {})).resolves.toMatchObject({ status: "unavailable", reason: "Engine sessions unavailable." });
  });

  it("uses only files.workStats on the existing authorized binding", async () => {
    const h = await harness();
    await h.sessions.run(h.workspace, async () => undefined);
    h.sendRequest.mockClear();
    await expect(h.read()).resolves.toEqual(snapshot());
    expect(h.sendRequest).toHaveBeenCalledOnce();
    expect(h.sendRequest.mock.calls[0]![0]).toMatchObject({ method: "files.workStats", workspace: "binding-a", params: {} });
  });

  it("rejects a response after its renderer workspace request retires", async () => {
    const h = await harness();
    await h.sessions.run(h.workspace, async () => undefined);
    const pending = deferred<unknown>();
    h.workStats.mockReturnValueOnce(pending.promise);
    const reading = h.read();
    const rejected = expect(reading).rejects.toThrow("request retired");
    h.retireRequest(); pending.resolve(stats());
    await rejected;
  });

  it("reports a replaced engine binding and does not reconnect", async () => {
    const h = await harness();
    await h.sessions.run(h.workspace, async () => undefined);
    h.sendRequest.mockClear();
    const pending = deferred<unknown>();
    h.workStats.mockReturnValueOnce(pending.promise);
    const reading = h.read();
    h.replaceClient(); pending.resolve(stats());
    await expect(reading).resolves.toMatchObject({ status: "unavailable", reason: "Rust engine workspace binding retired." });
    expect(h.sendRequest.mock.calls.map(([request]) => request.method)).toEqual(["files.workStats"]);
  });

  it("preserves a read failure as unavailable without retrying or reconnecting", async () => {
    const h = await harness();
    await h.sessions.run(h.workspace, async () => undefined);
    h.sendRequest.mockClear();
    h.workStats.mockRejectedValueOnce(new Error("native stats unavailable"));
    await expect(h.read()).resolves.toMatchObject({ status: "unavailable", reason: "native stats unavailable" });
    expect(h.sendRequest.mock.calls.map(([request]) => request.method)).toEqual(["files.workStats"]);
  });
});

describe("native work snapshot deltas", () => {
  it("subtracts cumulative counters and preserves a valid active gauge decrease", () => {
    const before = stats(), after = stats(7);
    after.capture.active = 0; after.observation.active = 1;
    const result = nativeWorkStatsDelta(snapshot(before), snapshot(after));
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error(result.reason);
    expect(Object.values(result.counters.capture)).toEqual(Array(10).fill(3));
    expect(Object.values(result.counters.observation)).toEqual(Array(10).fill(3));
    expect(result.counters.capture).not.toHaveProperty("active");
    expect(result.active).toEqual({ capture: { before: 4, after: 0 }, observation: { before: 4, after: 1 } });
  });

  it("makes unavailable, changed-generation, and wrong-workspace deltas explicit", () => {
    const available = snapshot();
    expect(nativeWorkStatsDelta({ workspaceId: "a", status: "unavailable", reason: "no binding" }, available).status).toBe("unavailable");
    expect(nativeWorkStatsDelta(available, { workspaceId: "a", status: "unavailable", reason: "no binding" }).status).toBe("unavailable");
    expect(nativeWorkStatsDelta(available, snapshot({ ...stats(), generation: "engine-generation-b" }))).toMatchObject({ status: "unavailable", reason: "Native work generation changed." });
    expect(nativeWorkStatsDelta(available, { ...available, workspaceId: "b" }).status).toBe("unavailable");
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 3])("rejects invalid or decreasing cumulative values: %s", value => {
    const after = stats(); after.capture.bytesReadForHashing = value;
    expect(nativeWorkStatsDelta(snapshot(), snapshot(after)).status).toBe("unavailable");
  });

  it("retains every returned snapshot field and rejects invalid gauges and generations", () => {
    const available = snapshot();
    if (available.status !== "available") throw new Error("fixture unavailable");
    const withExtra = { ...available, stats: { ...available.stats, extra: 1, capture: { ...available.stats.capture, extra: 2 } } };
    expect(NativeWorkStatsResult.parse(withExtra)).toEqual(withExtra);
    const badGauge = stats(); badGauge.capture.active = -1;
    expect(nativeWorkStatsDelta(available, snapshot(badGauge)).status).toBe("unavailable");
    expect(nativeWorkStatsDelta(available, snapshot({ ...stats(), generation: "" })).status).toBe("unavailable");
  });
});
