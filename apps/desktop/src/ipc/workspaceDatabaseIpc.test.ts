import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceDatabaseWorkerOwner } from "../workspaces/workspaceDatabaseWorker";
import { CHANNELS } from "./channels";
import {
  registerWorkspaceDatabaseIpcHandlers,
  type WorkspaceDatabaseIpcDependencies,
} from "./workspaceDatabaseIpc";

interface TestEvent {
  trusted: boolean;
}

interface TestWorkspace {
  workspaceId: string;
  writable: boolean;
}

function harness() {
  const trace: string[] = [];
  const controller = new AbortController();
  const workspace: TestWorkspace = {
    workspaceId: "workspace-1",
    writable: true,
  };
  const handlers = new Map<
    string,
    (event: TestEvent, payload: unknown) => Promise<unknown>
  >();
  const read = vi.fn<() => Promise<unknown>>(async () => ({
    path: "data.sqlite",
    tables: [],
  }));
  const readPage = vi.fn<() => Promise<unknown>>(async () => ({
    path: "data.sqlite",
    table: "items",
    offset: 1_000,
    rows: [],
    nextOffset: null,
  }));
  const edit = vi.fn<() => Promise<unknown>>(async () => ({
    path: "data.sqlite",
    table: "items",
    page: { offset: 0, rows: [], nextOffset: null },
    version: 1,
  }));
  const dependencies: WorkspaceDatabaseIpcDependencies<
    TestEvent,
    TestWorkspace
  > = {
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: (event) => {
      trace.push("trust");
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    withWorkspaceOperation: async (
      _event,
      workspaceId,
      inactiveMessage,
      work,
    ) => {
      trace.push(`workspace:${workspaceId}`);
      if (workspaceId !== workspace.workspaceId) throw new Error(inactiveMessage);
      return work({ workspace, signal: controller.signal });
    },
    assertWritableWorkspace: (candidate) => {
      trace.push("writable");
      if (!candidate.writable) throw new Error("Workspace is read-only.");
    },
    read,
    readPage,
    edit,
    now: () => 1_700_000_000_000,
    createId: () => "op_ipc_1",
  };
  registerWorkspaceDatabaseIpcHandlers(dependencies);
  return {
    handlers,
    trace,
    workspace,
    controller,
    read,
    readPage,
    edit,
    invoke: (channel: string, payload: unknown, trusted = true) =>
      handlers.get(channel)!({ trusted }, payload),
  };
}

describe("workspace database IPC", () => {
  it("registers snapshot, page, and edit handlers", () => {
    expect([...harness().handlers.keys()]).toEqual([
      CHANNELS.readWorkspaceDatabase,
      CHANNELS.readWorkspaceDatabasePage,
      CHANNELS.applyDatabaseEdit,
    ]);
  });

  it("checks trust and exact workspace authority before a read", async () => {
    const test = harness();

    await expect(
      test.invoke(CHANNELS.readWorkspaceDatabase, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
      }),
    ).resolves.toEqual({ path: "data.sqlite", tables: [] });

    expect(test.trace).toEqual(["trust", "workspace:workspace-1"]);
    expect(test.read).toHaveBeenCalledWith(
      { workspace: test.workspace, signal: test.controller.signal },
      "data.sqlite",
    );
  });

  it("forwards the requested table page under the operation signal", async () => {
    const test = harness();

    await expect(
      test.invoke(CHANNELS.readWorkspaceDatabasePage, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        table: "items",
        offset: 1_000,
      }),
    ).resolves.toMatchObject({ table: "items", offset: 1_000 });

    expect(test.readPage).toHaveBeenCalledWith(
      { workspace: test.workspace, signal: test.controller.signal },
      { relativePath: "data.sqlite", table: "items", offset: 1_000 },
    );
  });

  it("checks writability and stamps edit metadata before dispatch", async () => {
    const test = harness();
    const edit = {
      table: "items",
      op: "update" as const,
      pkColumn: "id",
      rowId: "1",
      payload: { value: "next" },
    };

    await expect(
      test.invoke(CHANNELS.applyDatabaseEdit, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        edit,
      }),
    ).resolves.toMatchObject({ version: 1 });

    expect(test.trace).toEqual([
      "trust",
      "workspace:workspace-1",
      "writable",
    ]);
    expect(test.edit).toHaveBeenCalledWith(
      { workspace: test.workspace, signal: test.controller.signal },
      {
        relativePath: "data.sqlite",
        edit,
        nowMs: 1_700_000_000_000,
        operationId: "op_ipc_1",
      },
    );
  });

  it("rejects untrusted, malformed, unauthorized, and read-only requests before work", async () => {
    const untrusted = harness();
    await expect(
      untrusted.invoke(CHANNELS.readWorkspaceDatabase, null, false),
    ).rejects.toThrow("Untrusted renderer.");
    expect(untrusted.read).not.toHaveBeenCalled();

    const malformed = harness();
    await expect(
      malformed.invoke(CHANNELS.readWorkspaceDatabasePage, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        table: "items",
        offset: -1,
      }),
    ).rejects.toThrow();
    expect(malformed.readPage).not.toHaveBeenCalled();

    const unauthorized = harness();
    await expect(
      unauthorized.invoke(CHANNELS.readWorkspaceDatabase, {
        workspaceId: "workspace-2",
        relativePath: "data.sqlite",
      }),
    ).rejects.toThrow(/changed workspaces/i);
    expect(unauthorized.read).not.toHaveBeenCalled();

    const readOnly = harness();
    readOnly.workspace.writable = false;
    await expect(
      readOnly.invoke(CHANNELS.applyDatabaseEdit, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        edit: {
          table: "items",
          op: "delete",
          pkColumn: "id",
          rowId: "1",
        },
      }),
    ).rejects.toThrow(/read-only/i);
    expect(readOnly.edit).not.toHaveBeenCalled();
  });

  it("validates worker results at the privileged boundary", async () => {
    const snapshot = harness();
    snapshot.read.mockResolvedValueOnce({ path: 42, tables: [] });
    await expect(
      snapshot.invoke(CHANNELS.readWorkspaceDatabase, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
      }),
    ).rejects.toThrow();

    const page = harness();
    page.readPage.mockResolvedValueOnce({ path: "data.sqlite", rows: [] });
    await expect(
      page.invoke(CHANNELS.readWorkspaceDatabasePage, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        table: "items",
        offset: 0,
      }),
    ).rejects.toThrow();

    const edit = harness();
    edit.edit.mockResolvedValueOnce({ path: "data.sqlite", version: 0 });
    await expect(
      edit.invoke(CHANNELS.applyDatabaseEdit, {
        workspaceId: "workspace-1",
        relativePath: "data.sqlite",
        edit: {
          table: "items",
          op: "delete",
          pkColumn: "id",
          rowId: "1",
        },
      }),
    ).rejects.toThrow();
  });

  it("answers an interleaved IPC ping while a large worker read is running", async () => {
    const root = await createTestScratch("dohc-database-ipc-responsive-");
    const databasePath = join(root, "large.sqlite");
    const requireFromHere = createRequire(import.meta.url);
    const { DatabaseSync } = requireFromHere("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE payload (
          id INTEGER PRIMARY KEY,
          a TEXT, b TEXT, c TEXT, d TEXT,
          e TEXT, f TEXT, g TEXT, h TEXT
        );
        WITH RECURSIVE rows(id) AS (
          VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 1000
        )
        INSERT INTO payload
        SELECT id,
          hex(zeroblob(2048)), hex(zeroblob(2048)),
          hex(zeroblob(2048)), hex(zeroblob(2048)),
          hex(zeroblob(2048)), hex(zeroblob(2048)),
          hex(zeroblob(2048)), hex(zeroblob(2048))
        FROM rows;
      `);
    } finally {
      database.close();
    }

    const started = Promise.withResolvers<void>();
    const databaseWorker = createWorkspaceDatabaseWorkerOwner({
      onRequestStarted: () => started.resolve(),
    });
    const handlers = new Map<
      string,
      (event: TestEvent, payload: unknown) => Promise<unknown>
    >();
    const workspace = { workspaceId: "workspace-1", writable: true };
    registerWorkspaceDatabaseIpcHandlers<TestEvent, typeof workspace>({
      registerHandler: (channel, handler) => handlers.set(channel, handler),
      assertTrustedSender: () => undefined,
      withWorkspaceOperation: async (_event, _workspaceId, _message, work) =>
        work({ workspace, signal: new AbortController().signal }),
      assertWritableWorkspace: () => undefined,
      read: (_operation, path) =>
        databaseWorker.readPath({ absolutePath: databasePath, path }),
      readPage: async () => {
        throw new Error("Page read was not expected.");
      },
      edit: async () => {
        throw new Error("Edit was not expected.");
      },
      now: () => 0,
      createId: () => "unused",
    });
    const pingChannel = "test:database-ipc-ping";
    handlers.set(pingChannel, async () => ({ pong: true }));
    let readSettled = false;

    try {
      const read = handlers
        .get(CHANNELS.readWorkspaceDatabase)!({ trusted: true }, {
          workspaceId: workspace.workspaceId,
          relativePath: "large.sqlite",
        })
        .finally(() => {
          readSettled = true;
        });
      await started.promise;

      await expect(
        handlers.get(pingChannel)!({ trusted: true }, undefined),
      ).resolves.toEqual({ pong: true });
      expect(readSettled).toBe(false);
      await read;
    } finally {
      await databaseWorker.dispose();
    }
  }, 20_000);
});
