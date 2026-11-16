import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ListedReach } from "@dohc/security-contract/listed-reach";
import { engine, harness, SHARE_ID, seedSharedFiles } from "./shareViewFileOps.fixture";
import { createShareViewFiles, type ResolvedShareViewFilesTarget } from "./shareViewFiles";
import type { GrantedSelector } from "./shareViewRecords";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";

const reach = (signature: string): ListedReach => ({
  signature,
  visibilitySignature: signature,
  rootLevel: "edit",
  folders: [],
});

// A membership can end while its copy is closed for a rebuild. The engine then
// answers only that rebuild, so the end path's save of unsent work fails. The
// end must still mark the view ended and keep every file on disk.
it.skipIf(engine.missing)(
  "ends a membership whose copy is closed for a rebuild",
  async () => {
    // The relay serves the member's pages under a new reach.
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith(`/sync/shares/${SHARE_ID}/log`)) {
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(
          JSON.stringify({ ok: true, ops: [], nextCursor: 1, hasMore: false, reach: reach("r2") }),
        );
        return;
      }
      response.writeHead(500, { connection: "close" });
      response.end("Unexpected request");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No relay address");
      const grantedSelector: GrantedSelector = {
        paths: [],
        versionId: null,
        access: "edit",
        wholeWorkspace: true,
      };
      const view = await harness("dohc-end-closed-", "edit", {
        relayUrl: `http://127.0.0.1:${address.port}`,
        joined: { grantedSelector, reach: reach("r1") },
      });
      if (!view.directClient) throw new Error("No share client");
      await seedSharedFiles(view, [{ path: "docs/plan.md", text: "the plan\n" }]);

      const pulled = await view.directClient.pullShareView({
        shareId: SHARE_ID,
        grantedSelector,
        reach: reach("r1"),
      });
      expect(pulled.rebuildId).toEqual(expect.any(String));

      const ended: Array<{
        unsavedPaths: string[] | null | undefined;
        unchecked: boolean | undefined;
      }> = [];
      const retired: string[] = [];
      const requested = { kind: "standalone" as const, workspaceId: view.workspaceId };
      const resolved: ResolvedShareViewFilesTarget = {
        ...requested,
        storeWorkspaceId: view.workspaceId,
        schedulingRootPath: view.rootPath,
        rootPath: view.rootPath,
        shareId: SHARE_ID,
        recipientUserId: "recipient-a",
        granterEmail: "granter@example.com",
        grantedSelector,
        reach: reach("r1"),
        ended: false,
        unsavedPaths: [],
      };
      const files = createShareViewFiles({
        resolveTarget: (candidate) =>
          candidate.kind === requested.kind && candidate.workspaceId === requested.workspaceId
            ? resolved
            : null,
        openStore: () => view.store,
        resolveRelay: async () => null,
        pull: async () => {
          throw new Error("Unexpected pull");
        },
        recordRefusals: async () => undefined,
        updateUnsavedPaths: async () => undefined,
        markEnded: async (_target, unsavedPaths, unconfirmedChanges) => {
          ended.push({ unsavedPaths, unchecked: unconfirmedChanges?.unchecked });
        },
        retireTarget: async (target) => {
          retired.push(target.workspaceId);
        },
        assertProjectionRoot: async () => undefined,
        createMount: async () => undefined,
        removeMount: async () => ({ folderLeft: false }),
        signedInAccount: { settle: async () => undefined, current: () => null },
      });

      await withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
        files.end(lease, requested, () => undefined),
      );

      // The closed copy refused the save, so nothing says which files are
      // unsent. The view keeps them all and says it could not check.
      expect(ended).toEqual([{ unsavedPaths: null, unchecked: true }]);
      expect(retired).toEqual([view.workspaceId]);
      expect(await readFile(join(view.rootPath, "docs/plan.md"), "utf8")).toBe("the plan\n");
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  60_000,
);
