// Each test changes one declaration or the family list in memory, as a
// contributor would in linksDeclarations.ts or allDeclarations.ts.
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LINKS_DECLARATIONS } from "./linksDeclarations";
import { ENVELOPE_FIELDS } from "./operationDeclaration";

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
  vi.doUnmock("./allDeclarations");
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

it("refuses a declaration whose access a cast changed to write", async () => {
  changeLinks(declarations => ({ ...declarations, linksEdges: { ...declarations.linksEdges, access: "write" as "read" } }));
  await expect(import("./capabilities")).rejects.toThrow("linksEdges is declared as write. Only reads can be declared.");
});

it("joins every listed family, and only those", async () => {
  vi.resetModules();
  vi.doMock("./allDeclarations", async importOriginal => {
    const { DECLARATION_FAMILIES: { links } } = await importOriginal<typeof import("./allDeclarations")>();
    return { DECLARATION_FAMILIES: { links } };
  });
  const { CAPABILITIES } = await import("./capabilities");
  expect(CAPABILITIES["links.edges"].mcp.view).toEqual(["dohc_links_edges"]);
  expect(CAPABILITIES["chat.read"].ipc.operations).not.toContain("chatLinks");
  expect(CAPABILITIES["chat.read"].mcp.view).not.toContain("dohc_chat_links");
});

// The type refuses these too, unless the input is widened to z.ZodObject.
it.each(ENVELOPE_FIELDS)("refuses a declared input that names %s", async field => {
  changeLinks(declarations => ({ ...declarations, linksEdges: { ...declarations.linksEdges, input: declarations.linksEdges.input.extend({ [field]: z.string() }) as z.ZodObject } }));
  await expect(import("./capabilities")).rejects.toThrow(`linksEdges input names ${field}, which its doors set.`);
});
