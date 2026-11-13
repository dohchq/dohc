import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LINKS_DECLARATIONS } from "@dohc/workspace-contracts/links-declarations";

afterEach(() => {
  vi.doUnmock("@dohc/workspace-contracts/links-declarations");
  vi.doUnmock("@dohc/workspace-contracts/all-declarations");
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

it("refuses a listed family with no IPC table", async () => {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/all-declarations", async importOriginal => {
    const { DECLARATION_FAMILIES: families } = await importOriginal<{ DECLARATION_FAMILIES: { links: typeof LINKS_DECLARATIONS } }>();
    const { linksEdges } = families.links;
    return { DECLARATION_FAMILIES: { ...families, notes: { notesEdges: { ...linksEdges, ipc: { ...linksEdges.ipc, channel: "desktop:notes-edges" } } } } };
  });
  await expect(import("./operationTables")).rejects.toThrow("notesEdges has no IPC row.");
});

it("refuses an IPC table whose family the list does not name", async () => {
  vi.resetModules();
  vi.doMock("@dohc/workspace-contracts/all-declarations", async importOriginal => {
    const { DECLARATION_FAMILIES: { chat } } = await importOriginal<{ DECLARATION_FAMILIES: { chat: object } }>();
    return { DECLARATION_FAMILIES: { chat } };
  });
  // linksOperations.ts also fails the typecheck: the list has no links family.
  await expect(import("./operationTables")).rejects.toThrow("links is not a listed family.");
});

it("makes IPC rows only for a listed family", async () => {
  const { declaredRows } = await import("./operationTable");
  // @ts-expect-error notes is not a key of DECLARATION_FAMILIES.
  expect(() => declaredRows("notes", z.string())).toThrow("notes is not a listed family.");
});

it("loads every table with distinct channels", async () => {
  const { OPERATION_TABLES } = await import("./operationTables");
  expect(OPERATION_TABLES.length).toBeGreaterThan(0);
});
