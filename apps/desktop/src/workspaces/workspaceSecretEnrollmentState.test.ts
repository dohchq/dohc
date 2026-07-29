import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SECRET_FILE_STORE_RELATIVE_PATH,
  installWorkspaceDataKey,
} from "@dohc/workspace-engine";
import type {
  Request,
  Response,
} from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import {
  readWorkspaceDataKeyForEnrollment,
  readWorkspaceSecretState,
} from "./workspaceSecretEnrollmentState";

const WORKSPACE_ID = "workspace-secret-enrollment-state";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-secret-enrollment-"));
  roots.push(root);
  return root;
}

async function createEngineDb(root: string): Promise<void> {
  const path = join(root, SECRET_FILE_STORE_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "daemon-owned-not-a-legacy-db");
}

class SecretStateDaemon implements EngineDaemonClient {
  readonly requests: Request[] = [];
  protectedRowsExist = false;

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(structuredClone(request));
    if (request.method === "workspace.open") {
      return { id: request.id, result: { workspace: "workspace-handle" } };
    }
    if (request.method === "workspace.close") {
      return { id: request.id, result: { closed: true } };
    }
    if (request.method === "secrets.stateExists") {
      return { id: request.id, result: this.protectedRowsExist };
    }
    throw new Error(`Unexpected daemon request: ${request.method}`);
  }

  close(): void {}
}

describe("desktop workspace secret enrollment state", () => {
  it("returns clean cloud-status state for a daemon-owned engine database", async () => {
    const root = await tempRoot();
    await createEngineDb(root);
    const daemon = new SecretStateDaemon();
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => daemon,
    });

    await expect(
      readWorkspaceSecretState(root, WORKSPACE_ID, sessions),
    ).resolves.toBe("none");
    expect(daemon.requests.at(-1)).toMatchObject({
      method: "secrets.stateExists",
      params: { workspaceId: WORKSPACE_ID },
    });
    await sessions.closeAll();
  });

  it("keeps enrollment key reads on disk after the daemon reports protected state", async () => {
    const root = await tempRoot();
    await createEngineDb(root);
    const daemon = new SecretStateDaemon();
    daemon.protectedRowsExist = true;
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => daemon,
    });
    const key = Buffer.alloc(32, 0x5a);
    await installWorkspaceDataKey(root, key);

    await expect(
      readWorkspaceSecretState(root, WORKSPACE_ID, sessions),
    ).resolves.toBe("protected-key-present");
    const loaded = await readWorkspaceDataKeyForEnrollment(
      root,
      WORKSPACE_ID,
      sessions,
    );
    expect(loaded).toEqual(key);
    loaded?.fill(0);
    key.fill(0);
    await sessions.closeAll();
  });

  // The relay route table is keyed by the registry's rootPath as an EXACT
  // string, and registry paths are forward-slashed even on Windows. A
  // `resolve()`d copy reaches the daemon as backslashes, misses the route, and
  // opens the workspace with no relay configuration. mkdtemp already returns
  // native separators, so only a deliberately forward-slashed root shows this.
  it("opens the daemon with the caller's rootPath spelling, not a resolved copy", async () => {
    const root = await tempRoot();
    await createEngineDb(root);
    const forwardSlashed = root.replaceAll("\\", "/");
    const daemon = new SecretStateDaemon();
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => daemon,
    });

    await readWorkspaceSecretState(forwardSlashed, WORKSPACE_ID, sessions);

    const open = daemon.requests.find(
      (request) => request.method === "workspace.open",
    );
    expect(open?.params).toMatchObject({ rootDir: forwardSlashed });
    await sessions.closeAll();
  });

  it("does not open the daemon or create engine.db for an opted-out workspace", async () => {
    const root = await tempRoot();
    const daemon = new SecretStateDaemon();
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => daemon,
    });

    await expect(
      readWorkspaceSecretState(root, WORKSPACE_ID, sessions),
    ).resolves.toBe("none");
    expect(daemon.requests).toEqual([]);
    await expect(
      readWorkspaceDataKeyForEnrollment(root, WORKSPACE_ID, sessions),
    ).resolves.toBeNull();
    expect(daemon.requests).toEqual([]);
    expect(existsSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH))).toBe(false);
    await sessions.closeAll();
  });
});
