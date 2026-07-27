import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      async (root) => await rm(root, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-engine-sessions-"));
  roots.push(root);
  return root;
}

describe("EngineWorkspaceSessions", () => {
  it("prepares an ordinary workspace before opening it in the daemon", async () => {
    const rootPath = await tempRoot();
    let opened = false;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        const marker = await readFile(
          join(rootPath, ".dohc", "engine", "SHADOW_CLONE"),
          "utf8",
        );
        expect(marker).toMatch(/^[0-9a-f]{64}$/);
        opened = true;
        return {
          id: request.id,
          result: { workspace: "workspace-handle" },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).resolves.toBe("workspace-handle");
    expect(opened).toBe(true);
  });

  it("fails closed on a malformed existing shadow marker", async () => {
    const rootPath = await tempRoot();
    const markerDirectory = join(rootPath, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(join(markerDirectory, "SHADOW_CLONE"), "bad", "utf8");
    let requests = 0;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        requests += 1;
        return {
          id: request.id,
          result: { workspace: "workspace-handle" },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).rejects.toThrow("shadow marker is invalid");
    expect(requests).toBe(0);
  });

  it("invalidates but does not replay a mutation after a transport failure", async () => {
    const rootPath = await tempRoot();
    let opens = 0;
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        opens += 1;
        return {
          id: request.id,
          result: { workspace: `workspace-handle-${opens}` },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });
    let mutationAttempts = 0;

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async () => {
          mutationAttempts += 1;
          throw { code: "transport-error" };
        },
      ),
    ).rejects.toMatchObject({ code: "transport-error" });
    expect(mutationAttempts).toBe(1);

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).resolves.toBe("workspace-handle-2");
    expect(opens).toBe(2);
  });

  it("retries an initial daemon-unavailable open when reconnect retries were requested", async () => {
    const rootPath = await tempRoot();
    const client: EngineDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        return {
          id: request.id,
          result: { workspace: "workspace-after-restart" },
        };
      },
    };
    let available = false;
    const sleeps: number[] = [];
    const sessions = new EngineWorkspaceSessions(
      {
        currentClient: () => {
          if (!available) {
            throw new EngineDaemonUnavailableError("daemon restarting");
          }
          return client;
        },
      },
      {
        transportRebindAttempts: 3,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          available = true;
        },
      },
    );

    const outcome = await sessions
      .run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
        { retryTransportErrors: true },
      )
      .catch((error: unknown) => error);

    // MUTATION: require rebindStarted in the open-error retry branch. The
    // first currentClient() failure is returned here instead of the handle.
    expect(outcome).toBe("workspace-after-restart");
    expect(sleeps).toEqual([100]);
  });

  it.each([".dohc", ".dohc/engine"])(
    "refuses a symlinked %s engine ancestor",
    async (relativeLink) => {
      const rootPath = await tempRoot();
      const outside = await tempRoot();
      const segments = relativeLink.split("/");
      if (segments.length > 1) {
        await mkdir(join(rootPath, segments[0]!));
      }
      await symlink(
        outside,
        join(rootPath, ...segments),
        process.platform === "win32" ? "junction" : "dir",
      );
      let requests = 0;
      const client: EngineDaemonClient = {
        close: () => undefined,
        async sendRequest(request) {
          requests += 1;
          return {
            id: request.id,
            result: { workspace: "workspace-handle" },
          };
        },
      };
      const sessions = new EngineWorkspaceSessions({
        currentClient: () => client,
      });

      await expect(
        sessions.run(
          { workspaceId: "workspace", rootPath },
          async (binding) => binding.workspace,
        ),
      ).rejects.toThrow("must not be a symlink");
      expect(requests).toBe(0);
      await expect(
        readFile(join(outside, "SHADOW_CLONE"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("revalidates prepared directories before a daemon-generation reopen", async () => {
    const rootPath = await tempRoot();
    const outside = await tempRoot();
    let generation = 1;
    let opens = 0;
    const clientForGeneration = (clientGeneration: number): EngineDaemonClient => ({
      close: () => undefined,
      async sendRequest(request) {
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        opens += 1;
        return {
          id: request.id,
          result: { workspace: `workspace-handle-${clientGeneration}` },
        };
      },
    });
    let client = clientForGeneration(generation);
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => client,
    });

    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );
    await rm(join(rootPath, ".dohc"), { recursive: true, force: true });
    await symlink(
      outside,
      join(rootPath, ".dohc"),
      process.platform === "win32" ? "junction" : "dir",
    );
    generation += 1;
    client = clientForGeneration(generation);

    await expect(
      sessions.run(
        { workspaceId: "workspace", rootPath },
        async (binding) => binding.workspace,
      ),
    ).rejects.toThrow("must not be a symlink");
    expect(opens).toBe(1);
  });

  it("mutation proof: restores capture authorship in every generation's open", async () => {
    const rootPath = await tempRoot();
    const requestsByGeneration: Array<Array<{ method: string; params: unknown }>> = [
      [],
      [],
    ];
    let generation = 0;
    const clients = requestsByGeneration.map(
      (requests, index): EngineDaemonClient => ({
        close: () => undefined,
        async sendRequest(request) {
          requests.push({ method: request.method, params: request.params });
          return {
            id: request.id,
            result: { workspace: `workspace-handle-${index + 1}` },
          };
        },
      }),
    );
    const sessions = new EngineWorkspaceSessions({
      currentClient: () => clients[generation]!,
    });
    const author = {
      kind: "agent" as const,
      agentId: "agent",
      onBehalfOf: "local",
      agentRunId: "run",
    };
    sessions.rememberCaptureAuthor("workspace", author);

    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );
    generation = 1;
    await sessions.run(
      { workspaceId: "workspace", rootPath },
      async (binding) => binding.workspace,
    );

    expect(requestsByGeneration).toEqual([
      [
        {
          method: "workspace.open",
          params: {
            rootDir: rootPath,
            workspaceId: "workspace",
            captureAuthor: author,
          },
        },
      ],
      [
        {
          method: "workspace.open",
          params: {
            rootDir: rootPath,
            workspaceId: "workspace",
            captureAuthor: author,
          },
        },
      ],
    ]);
  });
});
