import { afterEach, expect, it, vi } from "vitest";
import type { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";

afterEach(() => {
  vi.doUnmock("@dohc/workspace-contracts/links-declarations");
  vi.resetModules();
});

it("refuses a declared channel that repeats a hand-written row's channel", async () => {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/links-declarations", async importOriginal => {
    const { LINKS_DECLARATIONS: declarations } = await importOriginal<{ LINKS_DECLARATIONS: typeof LINKS_DECLARATIONS }>();
    const { linksEdges } = declarations;
    return { LINKS_DECLARATIONS: { ...declarations, linksEdges: { ...linksEdges, ipc: { ...linksEdges.ipc, channel: "desktop:list-chat-messages" } } } };
  });
  await expect(import("./operationTables")).rejects.toThrow("desktop:list-chat-messages is declared twice.");
});

it("refuses a declared channel that repeats a CHANNELS entry", async () => {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/links-declarations", async importOriginal => {
    const { LINKS_DECLARATIONS: declarations } = await importOriginal<{ LINKS_DECLARATIONS: typeof LINKS_DECLARATIONS }>();
    const { linksEdges } = declarations;
    return { LINKS_DECLARATIONS: { ...declarations, linksEdges: { ...linksEdges, ipc: { ...linksEdges.ipc, channel: "desktop:reload-renderer" } } } };
  });
  await expect(import("./operationTables")).rejects.toThrow("desktop:reload-renderer is declared twice.");
});

it("loads every table with distinct channels", async () => {
  const { OPERATION_TABLES } = await import("./operationTables");
  expect(OPERATION_TABLES.length).toBeGreaterThan(0);
});
