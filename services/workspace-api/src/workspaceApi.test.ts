import { describe, expect, it } from "vitest";
import { createWorkspaceApiHandler } from "./server";

// The service exposes no application routes. It serves Better Auth from
// /api/auth/*; this catch-all returns 404 for every other route.

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
