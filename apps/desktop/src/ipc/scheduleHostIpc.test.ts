import { describe, expect, it, vi } from "vitest";
import { scheduleHostOperations, type ScheduleHostResult } from "./bridgeContract";
import { registerOperations } from "./operationTable";
import { scheduleHostHandlers } from "./scheduleHostIpc";
import { deferred } from "../testing/deferred";

describe("schedule host IPC", () => {
  it.each(Object.keys(scheduleHostOperations) as Array<keyof typeof scheduleHostOperations>)(
    "binds %s to the window without holding a workspace during the relay call", async name => {
      const sender = {};
      const otherSender = {};
      let current: { workspaceId: string } | undefined = { workspaceId: "own" };
      const service = vi.fn(async (_id: string, _change?: unknown): Promise<ScheduleHostResult> => ({ kind: "this-computer" }));
      const handlers = new Map<string, (event: { sender: object }, payload: unknown) => Promise<unknown>>();
      const withActiveWorkspace = vi.fn(async () => { throw new Error("A network call must not hold a workspace"); });
      registerOperations({ handle: (channel, handler) => handlers.set(channel, handler),
        assertTrustedSender: () => undefined, withActiveWorkspace }, scheduleHostOperations,
        scheduleHostHandlers({ currentRendererSession: value => value === sender ? current : undefined, scheduleHostState: service }));
      const invoke = (workspaceId: string, value = sender) => handlers.get(scheduleHostOperations[name].channel)!(
        { sender: value }, { workspaceId, ...(name === "chooseScheduleHost" ? { installId: "computer" } : {}),
          ...(name === "readScheduleHost" ? {} : { generation: 1 }) });
      await expect(invoke("own")).resolves.toEqual({ kind: "this-computer" });
      expect(service).toHaveBeenCalledOnce();
      service.mockClear();
      await expect(invoke("other")).rejects.toThrow("no longer active");
      await expect(invoke("own", otherSender)).rejects.toThrow("no longer active");
      current = undefined;
      await expect(invoke("own")).rejects.toThrow("no longer active");
      expect(service).not.toHaveBeenCalled();
      current = { workspaceId: "own" };
      const drain = deferred<ScheduleHostResult>();
      service.mockReturnValue(drain.promise);
      const result = invoke("own");
      current = undefined;
      expect(withActiveWorkspace).not.toHaveBeenCalled();
      drain.resolve({ kind: "this-computer" });
      await expect(result).resolves.toEqual({ kind: "this-computer" });
    },
  );
});
