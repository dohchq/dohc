import { describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "./server";

// The reduced service exposes NO application routes: it is the Better Auth
// server only (mounted in main.ts on /api/auth/*). The collab-token endpoint
// was retired with Hocuspocus (G2-C-3). This handler is the catch-all that
// 404s everything that is not an auth/health/test route in main.ts.

async function json(response: Response) {
  return (await response.json()) as { ok: boolean; error?: string };
}

describe("workspace API service (auth-only surface)", () => {
  it("404s every non-auth route", async () => {
    const handler = createWorkspaceApiHandler();
    for (const request of [
      new Request("http://api.test/workspaces/ws_api/collab/token", { method: "POST" }),
      new Request("http://api.test/workspaces/ws_api/files"),
      new Request("http://api.test/anything"),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(404);
      await expect(json(response)).resolves.toMatchObject({ ok: false });
    }
  });
});
