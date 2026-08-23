import { describe, expect, it, vi } from "vitest";
import {
  createMainIpcHandler,
} from "./mainIpcHandler";

describe("createMainIpcHandler", () => {
  it("runs the fixed envelope in order", async () => {
    const trace: string[] = [];
    const handler = createMainIpcHandler({
      requireTrustedSender: (event: { trusted: boolean }) => {
        trace.push("trust");
        if (!event.trusted) throw new Error("Untrusted renderer.");
        return { senderId: 7 };
      },
      parsePayload: (payload: unknown) => {
        trace.push("parse");
        return payload as { workspaceId: string };
      },
      authorize: async (sender, payload) => {
        trace.push(`authorize:${sender.senderId}:${payload.workspaceId}`);
        return { workspaceId: payload.workspaceId };
      },
      gate: {
        kind: "write",
        assert: async (context) => {
          trace.push(`gate:${context.workspaceId}`);
        },
      },
      run: async (context) => {
        trace.push(`run:${context.workspaceId}`);
        return { ok: true };
      },
      parseResult: (result) => {
        trace.push("result");
        return result;
      },
    });

    await expect(
      handler({ trusted: true }, { workspaceId: "workspace-1" }),
    ).resolves.toEqual({ ok: true });
    expect(trace).toEqual([
      "trust",
      "parse",
      "authorize:7:workspace-1",
      "gate:workspace-1",
      "run:workspace-1",
      "result",
    ]);
  });

  it("requires trust before payload parsing", async () => {
    const parsePayload = vi.fn(() => ({ workspaceId: "workspace-1" }));
    const handler = createMainIpcHandler({
      requireTrustedSender: () => {
        throw new Error("Untrusted renderer.");
      },
      parsePayload,
      authorize: () => ({ workspaceId: "workspace-1" }),
      gate: { kind: "read-only" },
      run: async () => ({ ok: true }),
      parseResult: (result) => result,
    });

    await expect(handler({}, null)).rejects.toThrow("Untrusted renderer.");
    expect(parsePayload).not.toHaveBeenCalled();
  });
});
