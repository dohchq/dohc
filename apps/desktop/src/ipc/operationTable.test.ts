import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import {
  operationBridge,
  registerOperations,
  type OperationHandlers,
  type OperationTable,
} from "./operationTable";

const table = {
  rename: {
    channel: "desktop:test-rename",
    payload: z.object({ name: z.string().min(1) }),
    result: z.object({ renamed: z.string() }),
    guard: "trusted-sender",
  },
  forget: {
    channel: "desktop:test-forget",
    payload: z.object({ name: z.string() }),
    guard: "trusted-sender",
  },
  readNote: {
    channel: "desktop:test-read-note",
    payload: z.object({ workspaceId: z.string(), path: z.string() }),
    result: z.object({ text: z.string() }),
    guard: "active-workspace",
    inactiveMessage: "This window changed workspaces.",
  },
} satisfies OperationTable;

interface Sender {
  openWorkspaceId: string | null;
}
interface Event {
  trusted: boolean;
  sender: Sender;
}
const attachment = Symbol("workspace-a");

function harness(handlers: OperationHandlers<typeof table, Event, { workspace: { workspaceId: string } }>) {
  const listeners = new Map<string, (event: Event, payload: unknown) => Promise<unknown>>();
  // Main's own guard over a fake physical workspace: the sender's session is
  // current while the window still shows the workspace it names.
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<
    Sender,
    { workspaceId: string; attachmentId: symbol },
    Record<string, never>,
    { workspaceId: string; attachmentId: symbol; generation: number; isCurrent(): boolean }
  >({
    currentSession: (sender) =>
      sender.openWorkspaceId === null
        ? undefined
        : {
            workspaceId: sender.openWorkspaceId,
            attachmentId: attachment,
            generation: 1,
            isCurrent: () => sender.openWorkspaceId !== null,
          },
    withPhysicalOperation: async (workspaceId, work) =>
      work({
        workspace: { workspaceId, attachmentId: attachment },
        state: {},
        signal: new AbortController().signal,
        assertCurrent: () => undefined,
      }),
  });
  registerOperations<typeof table, Event, { workspace: { workspaceId: string } }>(
    {
      handle: (channel, listener) => {
        expect(listeners.has(channel)).toBe(false);
        listeners.set(channel, listener);
      },
      assertTrustedSender: (event) => {
        if (!event.trusted) throw new Error("Untrusted IPC sender");
      },
      withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
    },
    table,
    handlers,
  );
  const invoke = (channel: string, payload: unknown, event: Partial<Event> = {}) =>
    listeners.get(channel)!(
      { trusted: true, sender: { openWorkspaceId: "workspace-a" }, ...event },
      payload,
    );
  return { listeners, invoke };
}

function spies() {
  return {
    rename: vi.fn<OperationHandlers<typeof table, Event>["rename"]>(({ name }) => ({ renamed: name })),
    forget: vi.fn<OperationHandlers<typeof table, Event>["forget"]>(),
    readNote: vi.fn<OperationHandlers<typeof table, Event>["readNote"]>(() => ({ text: "note" })),
  };
}

describe("operation registrar", () => {
  it("registers one listener per row under the row's channel", () => {
    const { listeners } = harness(spies());
    expect([...listeners.keys()]).toEqual(["desktop:test-rename", "desktop:test-forget", "desktop:test-read-note"]);
  });

  it("refuses an untrusted sender before parsing or running the handler", async () => {
    const handlers = spies();
    const { invoke } = harness(handlers);
    await expect(invoke(table.rename.channel, null, { trusted: false })).rejects.toThrow("Untrusted IPC sender");
    await expect(
      invoke(table.readNote.channel, { workspaceId: "workspace-a", path: "a.md" }, { trusted: false }),
    ).rejects.toThrow("Untrusted IPC sender");
    expect(handlers.rename).not.toHaveBeenCalled();
    expect(handlers.readNote).not.toHaveBeenCalled();
  });

  it("refuses an invalid payload before running the handler", async () => {
    const handlers = spies();
    const { invoke } = harness(handlers);
    await expect(invoke(table.rename.channel, { name: "" })).rejects.toThrow();
    await expect(invoke(table.readNote.channel, { path: "a.md" })).rejects.toThrow();
    expect(handlers.rename).not.toHaveBeenCalled();
    expect(handlers.readNote).not.toHaveBeenCalled();
  });

  it("passes the parsed payload and the event, and replies with the parsed result", async () => {
    const handlers = spies();
    const { invoke } = harness(handlers);
    await expect(invoke(table.rename.channel, { name: "draft", extra: true })).resolves.toEqual({ renamed: "draft" });
    expect(handlers.rename).toHaveBeenCalledExactlyOnceWith(
      { name: "draft" },
      { event: expect.objectContaining({ trusted: true }) },
    );
  });

  it("refuses a result that does not match the row after the handler ran", async () => {
    const handlers = spies();
    handlers.rename.mockReturnValue({ renamed: 7 } as unknown as { renamed: string });
    const { invoke } = harness(handlers);
    await expect(invoke(table.rename.channel, { name: "draft" })).rejects.toThrow();
    expect(handlers.rename).toHaveBeenCalledOnce();
  });

  it("replies undefined for a row without a result, whatever the handler returned", async () => {
    const handlers = spies();
    handlers.forget.mockReturnValue({ leaked: true } as unknown as undefined);
    const { invoke } = harness(handlers);
    await expect(invoke(table.forget.channel, { name: "draft" })).resolves.toBeUndefined();
    expect(handlers.forget).toHaveBeenCalledOnce();
  });

  it("runs an active-workspace row inside the sender's workspace operation", async () => {
    const handlers = spies();
    const { invoke } = harness(handlers);
    await expect(invoke(table.readNote.channel, { workspaceId: "workspace-a", path: "a.md" })).resolves.toEqual({ text: "note" });
    expect(handlers.readNote).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "workspace-a", path: "a.md" },
      {
        event: expect.objectContaining({ trusted: true }),
        operation: expect.objectContaining({ workspace: { workspaceId: "workspace-a", attachmentId: attachment } }),
      },
    );
  });

  it.each([
    ["another workspace", { openWorkspaceId: "workspace-b" }],
    ["no workspace", { openWorkspaceId: null }],
  ])("refuses a sender showing %s before running the handler", async (_case, sender) => {
    const handlers = spies();
    const { invoke } = harness(handlers);
    await expect(
      invoke(table.readNote.channel, { workspaceId: "workspace-a", path: "a.md" }, { sender }),
    ).rejects.toThrow(table.readNote.inactiveMessage);
    expect(handlers.readNote).not.toHaveBeenCalled();
  });

  it("drops the answer when the sender leaves the workspace while the handler runs", async () => {
    const handlers = spies();
    const sender: Sender = { openWorkspaceId: "workspace-a" };
    handlers.readNote.mockImplementation(async () => {
      sender.openWorkspaceId = null;
      return { text: "note" };
    });
    const { invoke } = harness(handlers);
    await expect(
      invoke(table.readNote.channel, { workspaceId: "workspace-a", path: "a.md" }, { sender }),
    ).rejects.toThrow(table.readNote.inactiveMessage);
    expect(handlers.readNote).toHaveBeenCalledOnce();
  });
});

describe("operation bridge", () => {
  it("forwards each method's payload to its row's channel and returns main's reply", async () => {
    const invoke = vi.fn(async (channel: string) => ({ channel }));
    const bridge = operationBridge(table, invoke);
    await expect(bridge.rename({ name: "draft" })).resolves.toEqual({ channel: "desktop:test-rename" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop:test-rename", { name: "draft" });
    expect(Object.keys(bridge)).toEqual(["rename", "forget", "readNote"]);
  });
});
