import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { mountRootFor } from "./shareMounts";
import { createTestScratch } from "./testTemp";

import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { claimRelayWorkspace, relayJson } from "../../e2e/helpers/relayPeer";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { RelayFilePeer } from "../testing/relayFilePeer";
import { createRealShareMountHarness } from "../testing/realShareMountHarness";

const engine = requireEngineBinaryOrSkip();

describe("share mounts real daemon", () => {
  it.skipIf(engine.missing)(
    "refuses writes and onward sharing, refreshes edits, preserves revoked files, and unmounts only the share",
    async () => {
      const base = await createTestScratch("dohc-share-mount-relay-e2e-");
      const host = join(base, "host");
      const hostFile = join(host, "notes/mine.md");
      const granterWorkspaceId = "share-mount-granter-e2e";
      const granterToken = "test:e2e-granter";
      const recipientEmail = "e2e-recipient@dohc.test";
      let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | null = null;
      let daemon: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | null = null;
      try {
        await mkdir(join(host, "notes"), { recursive: true });
        await writeFile(hostFile, "# Mine\n\nHost workspace file.\n", "utf8");
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
        const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [] });
        await granter.writeTextFiles([
          { path: "docs/brief.md", text: "# Brief\n\nThe lighthouse memo.\n" },
          { path: "docs/sketch.excalidraw", text: scene },
          { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
          { path: "private/plan.excalidraw", text: scene },
        ]);
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
          {
            workspaceId: "share-mount-host-e2e",
            rootPath: host,
          },
          { maxRestarts: 0 },
        );
        const mounted = createRealShareMountHarness({
          daemon,
          relay: { baseUrl: relay.baseUrl, token: "test:e2e-recipient" },
          recipientEmail,
        });
        await mounted.mount(`dohc-share:${shareId}:${relay.baseUrl}`);
        const mountRoot = mountRootFor(host, "e2e-granter");
        const mountedFile = join(mountRoot, "docs/brief.md");
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("The lighthouse memo.");
        expect(existsSync(join(mountRoot, "private"))).toBe(false);
        const graphFiles: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await mounted.linksEdges(shareId, cursor);
          graphFiles.push(...page.files.map((file) => file.path));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        expect(graphFiles.sort()).toEqual(["docs/brief.md", "docs/sketch.excalidraw"]);
        await expect(mounted.writeText("shared-with-me/e2e-granter/docs/brief.md")).rejects.toThrow(
          "reserved",
        );
        await expect(mounted.reshare("shared-with-me/e2e-granter/docs")).rejects.toThrow(
          "copy it into your own files to share it onward",
        );
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("The lighthouse memo.");

        await granter.writeText("docs/brief.md", "# Brief\n\nThe lighthouse memo, round two.\n");
        await expect(mounted.refresh()).resolves.toEqual({
          results: [{ shareId, label: "e2e-granter", status: "updated", changedPaths: 1 }],
        });
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("round two");

        const revoked = await relayJson(
          relay.baseUrl,
          granterToken,
          `/sync/shares/${shareId}/revoke`,
          { method: "POST" },
        );
        expect(revoked.status).toBe(200);
        const ended = await mounted.refresh();
        expect(ended.results[0]!.status).toBe("ended");
        expect(mounted.workspace.shareMounts[0]!.ended).toBe(true);
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("round two");

        await mounted.unmount(shareId);
        expect(existsSync(mountRoot)).toBe(false);
        expect(mounted.workspace.shareMounts).toEqual([]);
        await expect(readFile(hostFile, "utf8")).resolves.toContain("Host workspace file");
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
