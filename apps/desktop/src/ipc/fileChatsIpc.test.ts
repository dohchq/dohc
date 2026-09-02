import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import { listFileChatsForIpc } from "./fileChatsIpc";

describe("listFileChatsForIpc", () => {
  it("preserves workspace-updating as a stable IPC result", async () => {
    const updating = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "Workspace is still updating. Try again.",
        retry: "afterBackoff",
      },
      null,
    );

    await expect(
      listFileChatsForIpc(vi.fn(() => Promise.reject(updating))),
    ).resolves.toEqual({
      status: "refused",
      code: "workspace-updating",
    });
  });

  it("does not reclassify another overloaded refusal", async () => {
    const overloaded = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "The engine is overloaded.",
        retry: "afterBackoff",
      },
      null,
    );

    await expect(
      listFileChatsForIpc(() => Promise.reject(overloaded)),
    ).rejects.toBe(overloaded);
  });
});
