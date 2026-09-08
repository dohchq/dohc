import { rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { Request } from "../protocol";
import { EngineDaemonLifecycle } from "./engineDaemonLifecycle";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

it.each([false, true])("reports temporary cleanup failure without replacing the health verdict (unhealthy=%s)", async (unhealthy) => {
  const cleanupError = Object.assign(new Error("temporary SQLite file is busy"), { code: "EBUSY" });
  const healthError = new Error("versions.active integrity check failed");
  vi.mocked(rm).mockImplementationOnce(async (root) => {
    roots.push(String(root));
    throw cleanupError;
  });
  const failures: Error[] = [];
  const client = {
    close: vi.fn(),
    closeUnresponsive: vi.fn(),
    async sendRequest(request: Request) {
      if (request.method === "versions.active" && unhealthy) throw healthError;
      return { id: request.id, result: request.method === "workspace.open" ? { workspace: "smoke" } : null };
    },
  };
  const lifecycle = new EngineDaemonLifecycle({
    command: "unused-test-engine", fileExists: () => true,
    launch: async () => client,
    onFailure: (error) => { failures.push(error); },
  });
  try {
    await lifecycle.start();
    await vi.waitFor(() => expect(failures).toHaveLength(unhealthy ? 2 : 1));
    expect(failures.some((error) => error.cause === cleanupError &&
      error.message === "Could not delete the engine startup smoke directory.")).toBe(true);
    if (unhealthy) {
      expect(failures).toContain(healthError);
      expect(client.closeUnresponsive).toHaveBeenCalledOnce();
    } else {
      expect(client.closeUnresponsive).not.toHaveBeenCalled();
      expect(lifecycle.currentClient()).toBe(client);
      await expect(lifecycle.currentClient()!.sendRequest({
        id: 99, method: "engine.ping", params: {},
      })).resolves.toEqual({ id: 99, result: null });
    }
  } finally {
    await lifecycle.stop();
  }
});
