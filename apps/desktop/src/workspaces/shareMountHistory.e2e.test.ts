import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealShareMountHarness } from "../testing/realShareMountHarness";
import { RelayFilePeer } from "../testing/relayFilePeer";
import { createTestScratch } from "./testTemp";
import { mountRootFor } from "./shareMounts";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { claimRelayWorkspace, relayJson } from "../../e2e/helpers/relayPeer";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

const engine = requireEngineBinaryOrSkip();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// A View or Comment recipient's desktop receives current files only. What the
// owner replaced before the share reaches neither the mount's History nor the
// host workspace's History, which the command line and MCP tools read.
describe("a mounted View share's History", () => {
  it.skipIf(engine.missing)(
    "holds no version replaced before the share, and keeps following later changes",
    async () => {
      const base = await createTestScratch("dohc-share-mount-history-e2e-");
      const host = join(base, "host");
      const granterWorkspaceId = "share-mount-history-granter";
      const granterToken = "test:history-granter";
      const recipientEmail = "history-recipient@dohc.test";
      const earlier = "# Plan\n\nThe first draft names the old budget.\n";
      const current = "# Plan\n\nThe second draft.\n";
      const later = "# Plan\n\nThe third draft.\n";
      let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | null = null;
      let daemon: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
      try {
        await mkdir(host, { recursive: true });
        relay = await spawnSyncRelay({ dbPath: join(base, "relay", "relay.sqlite") });
        await claimRelayWorkspace({
          baseUrl: relay.baseUrl,
          token: granterToken,
          workspaceId: granterWorkspaceId,
        });
        const granter = new RelayFilePeer({
          baseUrl: relay.baseUrl,
          token: granterToken,
          workspaceId: granterWorkspaceId,
        });
        await granter.writeText("docs/plan.md", earlier);
        await granter.writeText("docs/plan.md", current);
        const created = await relayJson(
          relay.baseUrl,
          granterToken,
          `/sync/${granterWorkspaceId}/shares`,
          {
            method: "POST",
            body: JSON.stringify({ recipientEmail, paths: ["docs"], access: "view" }),
          },
        );
        expect(created.status).toBe(200);
        const { shareId } = JSON.parse(created.body) as { shareId: string };
        daemon = await openLiveDaemonWorkspace(
          { workspaceId: "share-mount-history-host", rootPath: host },
          { maxRestarts: 0 },
        );
        const mounted = createRealShareMountHarness({
          daemon,
          relay: { baseUrl: relay.baseUrl, token: "test:history-recipient" },
          recipientEmail,
        });
        await mounted.mount(`dohc-share:${shareId}:${relay.baseUrl}`);
        const mountedFile = join(mountRootFor(host, "history-granter"), "docs/plan.md");
        await expect(readFile(mountedFile, "utf8")).resolves.toBe(current);

        // The capture the command line's `moments` and `moment` read.
        const capture = createWorkspaceEngineCapture({
          ...daemon.workspace,
          rustEngineSessions: daemon.sessions,
        });
        const hostHistory = async () => {
          const { moments } = await capture.listMoments({ limit: 50 });
          return await Promise.all(moments.map((moment) => capture.readMoment(moment.id)));
        };
        const held = JSON.stringify([await mounted.history(shareId), await hostHistory()]);
        expect(held).toContain("The second draft");
        expect(held).not.toContain("old budget");
        expect(held).not.toContain(sha256(earlier));

        await granter.writeText("docs/plan.md", later);
        await expect(mounted.refresh()).resolves.toEqual({
          results: [{ shareId, label: "history-granter", status: "updated", changedPaths: 1 }],
        });
        await expect(readFile(mountedFile, "utf8")).resolves.toBe(later);
        expect(JSON.stringify(await mounted.history(shareId))).not.toContain("old budget");
      } finally {
        try {
          await daemon?.close();
        } finally {
          try {
            await relay?.stop();
          } finally {
            await rm(base, { recursive: true, force: true });
          }
        }
      }
    },
    120_000,
  );
});
