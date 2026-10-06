import { describe, expect, it } from "vitest";
import { EngineFileObservation, decodeFileObservationChanges, decodeFileObservationWake, decodeFileWorkStats } from "./fileObservation";
import type { Request } from "../protocol";

const cursor = { generation: "process-a", revision: 3 };
const work = { started: 2, active: 1, completed: 1, cancelled: 0, failed: 0, boundsExceeded: 0, entriesVisited: 3, filesEnumerated: 2, hashesReused: 1, hashAttemptsCompleted: 1, bytesReadForHashing: 5 };
const stats = { generation: "binding-a", observation: work, capture: { ...work, bytesReadForHashing: 9 } };
describe("engine file observation contract", () => {
  it("reads and drains with the workspace binding and exact cursor", async () => {
    const requests: Request[] = [];
    const feed = new EngineFileObservation({ async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: { cursor, ready: true, resync: false, facts: [{ path: "note.md", kind: "changed" }] } };
    } }, "workspace-a");
    expect(await feed.changesSince(cursor)).toMatchObject({ resync: false, facts: [{ kind: "changed" }] });
    await feed.drain(cursor);
    expect(requests.map(({ method, workspace, params }) => ({ method, workspace, params }))).toEqual([
      { method: "files.changesSince", workspace: "workspace-a", params: { cursor } },
      { method: "files.drain", workspace: "workspace-a", params: { cursor } },
    ]);
  });

  it("reads binding counters with an empty read-only request", async () => {
    const requests: Request[] = [];
    const feed = new EngineFileObservation({ async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: stats };
    } }, "workspace-a");
    expect(await feed.workStats()).toEqual(stats);
    expect(requests.map(({ method, workspace, params }) => ({ method, workspace, params }))).toEqual([
      { method: "files.workStats", workspace: "workspace-a", params: {} },
    ]);
  });

  it("rejects incomplete snapshots and unsafe counters", () => {
    expect(decodeFileWorkStats(stats)).toEqual(stats);
    for (const field of Object.keys(work)) {
      for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", undefined]) {
        expect(() => decodeFileWorkStats({ ...stats, observation: { ...work, [field]: invalid } })).toThrow();
        expect(() => decodeFileWorkStats({ ...stats, capture: { ...work, [field]: invalid } })).toThrow();
      }
    }
    expect(() => decodeFileWorkStats({ ...stats, generation: "" })).toThrow();
    expect(() => decodeFileWorkStats({ generation: "a", observation: work })).toThrow();
  });

  it("decodes readiness and relaunch resync without inventing facts", () => {
    expect(decodeFileObservationChanges({ cursor, ready: false, resync: true, facts: [] })).toMatchObject({ ready: false, resync: true });
    expect(decodeFileObservationWake({ workspaceId: "a", cursor })).toEqual({ workspaceId: "a", cursor });
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeFileObservationChanges({ cursor: { ...cursor, revision: invalid }, ready: true, resync: false, facts: [] })).toThrow();
    }
    expect(() => decodeFileObservationChanges({ cursor, ready: true, resync: false, facts: [{ path: "a", kind: "rename" }] })).toThrow();
  });
});
