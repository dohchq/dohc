// Each test changes one declaration in memory, as a contributor would in
// linksDeclarations.ts, and expects the capability table to refuse it at load.
import { afterEach, expect, it, vi } from "vitest";
import type { LINKS_DECLARATIONS } from "./linksDeclarations";

type Declarations = typeof LINKS_DECLARATIONS;

function changeLinks(change: (declarations: Declarations) => object) {
  vi.resetModules();
  vi.doMock("./linksDeclarations", async importOriginal => {
    const { LINKS_DECLARATIONS: declarations } = await importOriginal<{ LINKS_DECLARATIONS: Declarations }>();
    return { LINKS_DECLARATIONS: change(declarations) };
  });
}

afterEach(() => {
  vi.doUnmock("./linksDeclarations");
  vi.resetModules();
});

it("refuses a declared operation named like a hand-written IPC row", async () => {
  changeLinks(({ linksEdges, ...rest }) => ({ ...rest, listChatMessages: linksEdges }));
  await expect(import("./capabilities")).rejects.toThrow("listChatMessages is declared twice.");
});

it("refuses a declared operation named like one in another family", async () => {
  changeLinks(({ linksEdges, ...rest }) => ({ ...rest, chatLinks: linksEdges }));
  await expect(import("./capabilities")).rejects.toThrow("chatLinks is declared twice.");
});

it("refuses a declared MCP tool named like a hand-written tool", async () => {
  changeLinks(declarations => ({ ...declarations, linksEdges: { ...declarations.linksEdges, mcp: { ...declarations.linksEdges.mcp, tool: "dohc_read_chat" } } }));
  await expect(import("./capabilities")).rejects.toThrow("dohc_read_chat is declared twice.");
});
