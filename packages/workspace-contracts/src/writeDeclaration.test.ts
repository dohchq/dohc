import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ENVELOPE_FIELDS } from "./operationDeclaration";
import type { STOPPED_RUN_WRITE_DECLARATIONS } from "./stoppedRunWriteDeclarations";

type Declarations = typeof STOPPED_RUN_WRITE_DECLARATIONS;
type Retry = Declarations["retryStoppedRun"];

function changeStoppedRun(change: (declarations: Declarations) => object) {
  vi.resetModules();
  vi.doMock("./stoppedRunWriteDeclarations", async (importOriginal) => {
    const { STOPPED_RUN_WRITE_DECLARATIONS: declarations } = await importOriginal<{
      STOPPED_RUN_WRITE_DECLARATIONS: Declarations;
    }>();
    return { STOPPED_RUN_WRITE_DECLARATIONS: change(declarations) };
  });
}

function changeRetry(change: (declaration: Retry) => object) {
  changeStoppedRun(({ retryStoppedRun }) => ({ retryStoppedRun: change(retryStoppedRun) }));
}

afterEach(() => {
  vi.doUnmock("./stoppedRunWriteDeclarations");
  vi.resetModules();
});

it("adds a declared write's IPC row and MCP tool to its capability, with its reason", async () => {
  const { CAPABILITIES } = await import("./capabilities");
  expect(CAPABILITIES["agent.run.retry"]).toMatchObject({
    ipc: { operations: ["retryStoppedRun"] },
    mcp: {
      owner: ["dohc_retry_chat_run"],
      view: [],
      comment: [],
      edit: [],
      reason: "Only the computer that ran a request can run it again. Shared profiles omit it.",
    },
  });
  expect(CAPABILITIES["file.protected.restore"]).toMatchObject({
    ipc: { operations: ["restoreProtectedCopy"] },
    mcp: { owner: ["dohc_restore_protected_copy"], view: [], comment: [], edit: [] },
  });
});

it("gives the reason of a door a write is not offered at", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    ipc: { none: "The app has no command for it." },
    mcp: { none: "Agents use the CLI." },
  }));
  const { CAPABILITIES } = await import("./capabilities");
  expect(CAPABILITIES["agent.run.retry"]).toMatchObject({
    ipc: { operations: [], reason: "The app has no command for it." },
    mcp: { owner: [], reason: "Agents use the CLI." },
  });
});

it("refuses a declared write named like a hand-written IPC row", async () => {
  changeStoppedRun(({ retryStoppedRun }) => ({ listChatMessages: retryStoppedRun }));
  await expect(import("./capabilities")).rejects.toThrow("listChatMessages is declared twice.");
});

it("refuses a declared write's MCP tool named like a hand-written tool", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    mcp: { ...declaration.mcp, tool: "dohc_read_chat" },
  }));
  await expect(import("./capabilities")).rejects.toThrow("dohc_read_chat is declared twice.");
});

it("refuses a declaration whose access a cast changed to read", async () => {
  changeRetry((declaration) => ({ ...declaration, access: "read" as "write" }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun is declared as read. Only writes are declared here.",
  );
});

it.each(["receivedShare", "readOnlyWorkspace", "run", "paths"] as const)(
  "refuses a declared write with no %s rule",
  async (rule) => {
    changeRetry((declaration) => {
      const { [rule]: _removed, ...admission } = declaration.socket.admission;
      return { ...declaration, socket: { ...declaration.socket, admission } };
    });
    await expect(import("./capabilities")).rejects.toThrow(
      `retryStoppedRun has no listed ${rule} rule.`,
    );
  },
);

it("refuses a rule that its list does not hold", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    socket: {
      ...declaration.socket,
      admission: { ...declaration.socket.admission, receivedShare: "everyone" as "chat" },
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun has no listed receivedShare rule.",
  );
});

// The type refuses these too, unless the input is widened to z.ZodObject.
it.each(ENVELOPE_FIELDS)("refuses a declared write's socket input that names %s", async (field) => {
  changeRetry((declaration) => ({
    ...declaration,
    socket: {
      ...declaration.socket,
      input: declaration.socket.input.extend({ [field]: z.string() }) as z.ZodObject,
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    `retryStoppedRun input names ${field}, which its doors set.`,
  );
});

// The run rule alone lets a request name a run.
it("refuses a run id in a declared write's socket or MCP input, and takes one from the window", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    socket: {
      ...declaration.socket,
      admission: { ...declaration.socket.admission, run: "never-a-run" },
      input: declaration.socket.input.extend({ runId: z.string() }) as z.ZodObject,
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun input names runId, which its doors set.",
  );
  changeRetry((declaration) => ({
    ...declaration,
    mcp: {
      ...declaration.mcp,
      input: declaration.mcp.input.extend({ runId: z.string() }) as z.ZodObject,
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun input names runId, which its doors set.",
  );
  vi.doUnmock("./stoppedRunWriteDeclarations");
  vi.resetModules();
  const { WRITE_DECLARATION_FAMILIES } = await import("./allWriteDeclarations");
  expect(
    Object.keys(WRITE_DECLARATION_FAMILIES.stoppedRun.retryStoppedRun.ipc.input.shape),
  ).toContain("runId");
});

it("refuses an envelope field in a declared write's IPC or MCP input", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    ipc: {
      ...declaration.ipc,
      input: declaration.ipc.input.extend({ workspaceId: z.string() }) as z.ZodObject,
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun input names workspaceId, which its doors set.",
  );
  changeRetry((declaration) => ({
    ...declaration,
    mcp: {
      ...declaration.mcp,
      input: declaration.mcp.input.extend({ actor: z.string() }) as z.ZodObject,
    },
  }));
  await expect(import("./capabilities")).rejects.toThrow(
    "retryStoppedRun input names actor, which its doors set.",
  );
});
