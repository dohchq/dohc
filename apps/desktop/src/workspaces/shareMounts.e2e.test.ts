import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../testing/realDaemonWorkspaceSessions";
import { mountRootFor } from "./shareMounts";
import {
  createShareMountDirectoryThroughOwnerForTest,
  refreshShareMountThroughOwnerForTest,
  removeShareMountFolderThroughOwnerForTest,
} from "../testing/shareViewFilesMountHarness";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";

import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { claimRelayWorkspace, relayJson } from "../../e2e/helpers/relayPeer";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { RelayFilePeer } from "../testing/relayFilePeer";
import { createRealShareMountHarness } from "../testing/realShareMountHarness";

const engine = requireEngineBinaryOrSkip();

describe("share mounts real daemon", () => {
  it.skipIf(engine.missing)(
    "stores durable mount state inside the mount and removes only that mount",
    async () => {
      const host = await createTestScratch("dohc-share-mount-rust-e2e-");
      const mount = { shareId: "share-1", label: "alex" };
      const mountRoot = mountRootFor(host, mount.label);
      const siblingRoot = mountRootFor(host, "sam");
      const hostSentinel = join(host, "host-keep.md");
      const siblingSentinel = join(siblingRoot, "sibling-keep.md");
      const lifecycle = createRealDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      let sessions: EngineWorkspaceSessions | null = null;
      let lifecycleStopped = false;

      try {
        await createShareMountDirectoryThroughOwnerForTest(host, mount.label);
        await mkdir(siblingRoot);
        await writeFile(hostSentinel, "host", "utf8");
        await writeFile(siblingSentinel, "sibling", "utf8");

        await lifecycle.start();
        const activeSessions = createRealDaemonWorkspaceSessions(lifecycle);
        sessions = activeSessions;
        await expect(
          refreshShareMountThroughOwnerForTest({
            hostWorkspaceId: "host-workspace-1",
            hostRoot: host,
            mount,
            relay: {
              baseUrl: "http://unused.invalid",
              token: "unused",
            },
            // A real pinned selector: no paths and no version selects
            // nothing at all, which the engine refuses.
            pinnedSelector: { paths: ["docs"], versionId: null, access: "view" },
            recordRefusals: async () => undefined,
            pull: async () => ({
              fetched: 0,
              applied: 0,
              skipped: 0,
              refusals: [],
              refusalCount: 0,
              changedPaths: [],
              nextCursor: 0,
              commitCursor: async () => undefined,
            }),
            openStore: (workspace) =>
              createCaptureLiveStores(workspace, activeSessions).store,
          }),
        ).resolves.toEqual({
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });

        expect(
          existsSync(join(mountRoot, ".dohc", "engine", "engine.db")),
        ).toBe(true);
        expect(existsSync(join(host, ".dohc", "engine", "engine.db"))).toBe(
          false,
        );
        expect(
          existsSync(join(siblingRoot, ".dohc", "engine", "engine.db")),
        ).toBe(false);

        await activeSessions.closeAll();
        sessions = null;
        await lifecycle.stop();
        lifecycleStopped = true;

        await removeShareMountFolderThroughOwnerForTest(host, mount.label);
        expect(existsSync(mountRoot)).toBe(false);
        await expect(readFile(hostSentinel, "utf8")).resolves.toBe("host");
        await expect(readFile(siblingSentinel, "utf8")).resolves.toBe(
          "sibling",
        );
      } finally {
        await sessions?.closeAll().catch(() => undefined);
        if (!lifecycleStopped) {
          await lifecycle.stop().catch(() => undefined);
        }
        await rm(host, { recursive: true, force: true });
      }
    },
    30_000,
  );

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
        relay = await spawnSyncRelay({ dbPath: join(base, "relay.sqlite") });
        await claimRelayWorkspace({
          baseUrl: relay.baseUrl, token: granterToken, workspaceId: granterWorkspaceId,
        });
        const granter = new RelayFilePeer({
          baseUrl: relay.baseUrl, token: granterToken, workspaceId: granterWorkspaceId,
        });
        await granter.writeTextFiles([
          { path: "docs/brief.md", text: "# Brief\n\nThe lighthouse memo.\n" },
          { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
        ]);
        const created = await relayJson(relay.baseUrl, granterToken,
          `/sync/${granterWorkspaceId}/shares`, {
            method: "POST",
            body: JSON.stringify({ recipientEmail, paths: ["docs"], access: "view" }),
          },
        );
        expect(created.status).toBe(200);
        const { shareId } = JSON.parse(created.body) as { shareId: string };
        daemon = await openLiveDaemonWorkspace({
          workspaceId: "share-mount-host-e2e", rootPath: host,
        }, { maxRestarts: 0 });
        const mounted = createRealShareMountHarness({
          daemon, relay: { baseUrl: relay.baseUrl, token: "test:e2e-recipient" }, recipientEmail,
        });
        await mounted.mount(`dohc-share:${shareId}:${relay.baseUrl}`);
        const mountRoot = mountRootFor(host, "e2e-granter");
        const mountedFile = join(mountRoot, "docs/brief.md");
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("The lighthouse memo.");
        expect(existsSync(join(mountRoot, "private"))).toBe(false);
        await expect(mounted.writeText("shared-with-me/e2e-granter/docs/brief.md"))
          .rejects.toThrow("reserved");
        await expect(mounted.reshare("shared-with-me/e2e-granter/docs"))
          .rejects.toThrow("copy it into your own files to share it onward");
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("The lighthouse memo.");

        await granter.writeText("docs/brief.md", "# Brief\n\nThe lighthouse memo, round two.\n");
        await expect(mounted.refresh()).resolves.toEqual({
          results: [{ shareId, label: "e2e-granter", status: "updated", changedPaths: 1 }],
        });
        await expect(readFile(mountedFile, "utf8")).resolves.toContain("round two");

        const revoked = await relayJson(relay.baseUrl, granterToken,
          `/sync/shares/${shareId}/revoke`, { method: "POST" },
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
