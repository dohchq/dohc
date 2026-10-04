import { describe, expect, it } from "vitest";
import { EngineFileObservation, decodeFileObservationChanges, decodeFileObservationWake } from "./fileObservation";
import type { Request } from "../protocol";

const cursor = { generation: "process-a", revision: 3 };
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

  it("decodes readiness and relaunch resync without inventing facts", () => {
    expect(decodeFileObservationChanges({ cursor, ready: false, resync: true, facts: [] })).toMatchObject({ ready: false, resync: true });
    expect(decodeFileObservationWake({ workspaceId: "a", cursor })).toEqual({ workspaceId: "a", cursor });
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeFileObservationChanges({ cursor: { ...cursor, revision: invalid }, ready: true, resync: false, facts: [] })).toThrow();
    }
    expect(() => decodeFileObservationChanges({ cursor, ready: true, resync: false, facts: [{ path: "a", kind: "rename" }] })).toThrow();
  });
});
