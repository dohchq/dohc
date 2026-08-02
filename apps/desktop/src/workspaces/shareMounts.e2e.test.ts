import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it } from "vitest";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createMountDirectory,
  mountRootFor,
  refreshShareMountOnce,
  removeMountFolder,
} from "./shareMounts";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { nativeTmpdir } from "./testTemp";

const engine = requireEngineBinaryOrSkip();

describe("share mounts real daemon", () => {
  it.skipIf(engine.missing)(
    "stores durable mount state inside the mount and removes only that mount",
    async () => {
      const host = await mkdtemp(
        join(nativeTmpdir(), "dohc-share-mount-rust-e2e-"),
      );
      const mount = { shareId: "share-1", label: "alex" };
      const mountRoot = mountRootFor(host, mount.label);
      const siblingRoot = mountRootFor(host, "sam");
      const hostSentinel = join(host, "host-keep.md");
      const siblingSentinel = join(siblingRoot, "sibling-keep.md");
      const lifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      let sessions: EngineWorkspaceSessions | null = null;
      let lifecycleStopped = false;

      try {
        await createMountDirectory(host, mount.label);
        await mkdir(siblingRoot);
        await writeFile(hostSentinel, "host", "utf8");
        await writeFile(siblingSentinel, "sibling", "utf8");

        await lifecycle.start();
        const activeSessions = new EngineWorkspaceSessions(lifecycle);
        sessions = activeSessions;
        await expect(
          refreshShareMountOnce({
            hostWorkspaceId: "host-workspace-1",
            hostRoot: host,
            mount,
            relay: {
              baseUrl: "http://unused.invalid",
              token: "unused",
            },
            scope: {
              // A REAL pinned selector: no paths and no version selects
              // nothing at all, which the engine refuses.
              recorded: { paths: ["docs"], versionId: null },
              fetch: () => {
                throw new Error("a pinned selector must not be re-fetched");
              },
              record: () => undefined,
            },
            pull: async () => ({
              fetched: 0,
              applied: 0,
              changedPaths: [],
              nextCursor: 0,
              commitCursor: async () => undefined,
            }),
            openStore: (workspace) =>
              createCaptureLiveStores(workspace, activeSessions).store,
          }),
        ).resolves.toEqual({ status: "unchanged", changedPaths: 0 });

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

        await removeMountFolder(host, mount.label);
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
});
