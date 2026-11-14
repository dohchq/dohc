import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";

type LinksResolve = (typeof LINKS_DECLARATIONS)["linksResolve"];

function changeLinksResolve(change: (declaration: LinksResolve) => object) {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/links-declarations", async (importOriginal) => {
    const original = await importOriginal<{ LINKS_DECLARATIONS: typeof LINKS_DECLARATIONS }>();
    const declarations = original.LINKS_DECLARATIONS;
    return {
      LINKS_DECLARATIONS: { ...declarations, linksResolve: change(declarations.linksResolve) },
    };
  });
}

afterEach(() => {
  vi.doUnmock("@dohc/workspace-contracts/links-declarations");
  vi.doUnmock("@dohc/workspace-contracts/stopped-run-write-declarations");
  vi.resetModules();
});

it("refuses a declared command that repeats a hand-written command", async () => {
  changeLinksResolve((declaration) => ({
    ...declaration,
    cli: { ...declaration.cli, command: ["document", "read"] },
  }));
  await expect(import("./args")).rejects.toThrow("dohc document read is declared twice.");
});

it("refuses a declared command under a command that does not exist", async () => {
  changeLinksResolve((declaration) => ({
    ...declaration,
    cli: { ...declaration.cli, command: ["linkz", "resolve"] },
  }));
  await expect(import("./args")).rejects.toThrow("dohc linkz resolve names no command.");
});

it("refuses a declared socket verb that repeats a hand-written verb", async () => {
  changeLinksResolve((declaration) => ({
    ...declaration,
    cli: { ...declaration.cli, verb: "stopSync" },
  }));
  await expect(import("./protocol")).rejects.toThrow("stopSync is declared twice.");
});

it("refuses a declaration whose access a cast changed to write", async () => {
  changeLinksResolve((declaration) => ({ ...declaration, access: "write" as "read" }));
  await expect(import("./protocol")).rejects.toThrow(
    "linksResolve is declared as write. Only reads can be declared.",
  );
});

it("refuses a declared input that names an envelope field", async () => {
  changeLinksResolve((declaration) => ({
    ...declaration,
    input: declaration.input.extend({ runSecret: z.string() }),
  }));
  await expect(import("./protocol")).rejects.toThrow(
    "linksResolve input names runSecret, which its doors set.",
  );
});

it("loads the declarations as they are", async () => {
  vi.resetModules();
  const { CLI_COMMANDS } = await import("./args");
  expect(Object.keys(CLI_COMMANDS.links!.verbs)).toEqual(["edges", "in", "resolve"]);
  expect(Object.keys(CLI_COMMANDS.chat!.verbs).slice(-2)).toEqual(["links", "file-mentions"]);
});

type StoppedRunWrites =
  typeof import("@dohc/workspace-contracts/stopped-run-write-declarations").STOPPED_RUN_WRITE_DECLARATIONS;

function changeRetry(change: (declaration: StoppedRunWrites["retryStoppedRun"]) => object) {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/stopped-run-write-declarations", async (importOriginal) => {
    const original = await importOriginal<{ STOPPED_RUN_WRITE_DECLARATIONS: StoppedRunWrites }>();
    const { retryStoppedRun } = original.STOPPED_RUN_WRITE_DECLARATIONS;
    return { STOPPED_RUN_WRITE_DECLARATIONS: { retryStoppedRun: change(retryStoppedRun) } };
  });
}

it("refuses a declared write whose command has no parser in its command's table", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    cli: { ...declaration.cli, command: ["chat", "retry-again"] },
  }));
  await expect(import("./args")).rejects.toThrow(
    "dohc chat retry-again is declared but has no parser in its command.",
  );
});

it("refuses a parser for a declared write that names no command", async () => {
  changeRetry((declaration) => ({ ...declaration, cli: { none: "Agents use MCP." } }));
  await expect(import("./args")).rejects.toThrow(
    "chatRetry declares no CLI command: Agents use MCP.",
  );
});

it("refuses a declared write's socket verb that repeats a hand-written verb", async () => {
  changeRetry((declaration) => ({
    ...declaration,
    socket: { ...declaration.socket, verb: "stopSync" },
  }));
  await expect(import("./protocol")).rejects.toThrow("stopSync is declared twice.");
});

it("takes a run id only for a declared write that may name its run", async () => {
  const { cliRequestSchema, CLI_PROTOCOL_VERSION } = await import("./protocol");
  const request = (verb: string, args: object) =>
    cliRequestSchema.safeParse({
      token: "a".repeat(64),
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb,
      args: { cwd: "/workspace", actor: "agent", ...args },
    }).success;
  const id = "00000000-0000-4000-8000-000000000001";
  expect(request("chatRetry", { thread: "thread-1", runId: "run-1" })).toBe(true);
  expect(request("chatRetry", { thread: "thread-1", extra: true })).toBe(false);
  expect(request("restoreProtectedCopy", { id })).toBe(true);
  expect(request("restoreProtectedCopy", { id, runId: "run-1" })).toBe(false);
});
