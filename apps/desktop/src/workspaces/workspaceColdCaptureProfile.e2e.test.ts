import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import {
  createEngineClient,
  EngineWorkspaceSessions,
  type EngineClient,
  type EngineWorkspace,
} from "@dohc/workspace-engine-client/daemon";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createTestScratch } from "./testTemp";

const FILE_COUNT_ENV = "DOHC_COLD_CAPTURE_PROFILE_FILES";
const MAX_OPEN_MS_ENV = "DOHC_COLD_CAPTURE_PROFILE_MAX_MS";
const OUTPUT_ENV = "DOHC_COLD_CAPTURE_PROFILE_OUTPUT";
const SEARCH_MODE_ENV = "DOHC_COLD_CAPTURE_PROFILE_SEARCH";
const PROFILE_OPEN_DEADLINE_MS = 5 * 60_000;
const WRITE_CONCURRENCY = 128;
const engine = requireEngineBinaryOrSkip();

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}.`);
  }
  return value;
}

async function seedFiles(root: string, count: number): Promise<void> {
  for (let first = 0; first < count; first += WRITE_CONCURRENCY) {
    await Promise.all(
      Array.from(
        { length: Math.min(WRITE_CONCURRENCY, count - first) },
        async (_, offset) => {
          const index = first + offset;
          await writeFile(
            join(root, `note-${String(index).padStart(5, "0")}.md`),
            `# Note ${index}\n\nbody ${index}\n`,
            "utf8",
          );
        },
      ),
    );
  }
}

async function startClient(binary: string): Promise<EngineClient> {
  return await createEngineClient({
    command: binary,
    cwd: dirname(binary),
    authToken: randomBytes(32).toString("hex"),
    protocolVersion: 2,
    capabilities: ["blobs"],
  });
}

async function stopClient(client: EngineClient): Promise<void> {
  client.close();
  await client.waitForExit();
}

async function countDurableMoments(
  sessions: EngineWorkspaceSessions,
  workspace: EngineWorkspace,
): Promise<{ moments: number; paths: number; latestMomentOrder: number }> {
  return await sessions.run(workspace, async ({ client, workspace: handle }) => {
    const adapter = new VersionedLiveAdapter(client, handle, {
      workspaceId: workspace.workspaceId,
    });
    const paths = new Set<string>();
    let moments = 0;
    let latestMomentOrder = 0;
    let beforeMomentOrder: number | undefined;
    do {
      const page = await adapter.listMoments({
        workspaceId: workspace.workspaceId,
        limit: 500,
        ...(beforeMomentOrder !== undefined ? { beforeMomentOrder } : {}),
      });
      latestMomentOrder = Math.max(latestMomentOrder, page.latestMomentOrder);
      moments += page.moments.length;
      for (const moment of page.moments) paths.add(moment.path);
      beforeMomentOrder = page.nextBeforeMomentOrder ?? undefined;
    } while (beforeMomentOrder !== undefined);
    return { moments, paths: paths.size, latestMomentOrder };
  });
}

const fileCount = positiveInteger(FILE_COUNT_ENV, 0);

it.skipIf(fileCount === 0 || engine.missing)(
  "profiles fresh default-capture workspace adoption and proves history survives restart",
  async () => {
    const maxOpenMs = positiveInteger(MAX_OPEN_MS_ENV, Number.MAX_SAFE_INTEGER);
    const root = await createTestScratch("dohc-cold-capture-profile-");
    const searchMode = process.env[SEARCH_MODE_ENV]?.trim() || "default";
    if (searchMode === "excluded") {
      await mkdir(join(root, ".dohc"), { recursive: true });
      await writeFile(
        join(root, ".dohc", "files.toml"),
        '[[rule]]\npath = "**"\nsearchable = false\n',
        "utf8",
      );
    } else if (searchMode !== "default") {
      throw new Error(
        `${SEARCH_MODE_ENV} must be default or excluded, received ${searchMode}.`,
      );
    }
    await seedFiles(root, fileCount);

    const workspace = {
      workspaceId: `cold-capture-profile-${fileCount}`,
      rootPath: root,
      attachmentId: Symbol(`cold-capture-profile-${fileCount}`),
    };
    const binary = engine.require();
    let client = await startClient(binary);
    let sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      { workspaceOpenDeadlineMs: PROFILE_OPEN_DEADLINE_MS },
    );
    let openMs = 0;
    let captured = { moments: 0, paths: 0, latestMomentOrder: 0 };
    let restarted = { moments: 0, paths: 0, latestMomentOrder: 0 };
    try {
      const openedAt = performance.now();
      await sessions.run(workspace, async () => undefined);
      openMs = performance.now() - openedAt;
      captured = await countDurableMoments(sessions, workspace);

      await sessions.closeAll();
      await stopClient(client);

      client = await startClient(binary);
      sessions = new EngineWorkspaceSessions(
        { currentClient: () => client },
        { workspaceOpenDeadlineMs: PROFILE_OPEN_DEADLINE_MS },
      );
      restarted = await countDurableMoments(sessions, {
        ...workspace,
        attachmentId: Symbol(`cold-capture-restart-${fileCount}`),
        captureMode: "none" as const,
      });
    } finally {
      await sessions.closeAll();
      await stopClient(client).catch(() => undefined);
    }

    const result = {
      fileCount,
      openMs,
      captured,
      restarted,
      maxOpenMs,
      searchMode,
    };
    console.log(`COLD_CAPTURE_PROFILE ${JSON.stringify(result)}`);
    const output = process.env[OUTPUT_ENV]?.trim();
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }

    expect(captured.moments).toBe(fileCount);
    expect(captured.paths).toBe(fileCount);
    expect(restarted).toEqual(captured);
    expect(openMs).toBeLessThan(maxOpenMs);
  },
  PROFILE_OPEN_DEADLINE_MS + 60_000,
);
