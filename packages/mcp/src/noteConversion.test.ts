import { expect, it, vi } from "vitest";
import { requestDeclaredWriteTool } from "./tools";

const client = vi.hoisted(() => ({ sendCliRequest: vi.fn() }));
vi.mock("@dohc/cli/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendCliRequest: client.sendCliRequest,
}));

it("waits for a note conversion that runs longer than 30 seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = {
      ok: true,
      converted: 3,
      unchanged: 0,
      skipped: [],
      doesNotFit: [],
      failed: [],
      sent: true,
    };
    client.sendCliRequest.mockImplementation(
      (_request: unknown, options: { timeoutMs?: number }) =>
        new Promise((resolve, reject) => {
          if ((options.timeoutMs ?? 30_000) < 40_000)
            setTimeout(
              () => reject(new Error("desktop app did not respond")),
              options.timeoutMs ?? 30_000,
            );
          setTimeout(() => resolve(result), 40_000);
        }),
    );
    const pending = requestDeclaredWriteTool(
      { root: "/workspace", home: "/state" },
      "dohc_convert_notes",
      {},
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await pending).toEqual(result);
    expect(client.sendCliRequest).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "notesConvert", door: "mcp" }),
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  } finally {
    vi.useRealTimers();
  }
});
