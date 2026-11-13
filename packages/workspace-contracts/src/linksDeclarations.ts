import {
  LinksEdgesInput,
  LinksEdgesResult,
  LinksInInput,
  LinksInResult,
  LinksResolveInput,
  LinksResolveResult,
} from "./links";
import { CURSOR_FLAG, EVERY_MCP_LEVEL, type OperationFamily } from "./operationDeclaration";

const unavailable = "Workspace links are unavailable.";

export const LINKS_DECLARATIONS = {
  linksEdges: {
    access: "read",
    capabilityId: "links.edges",
    input: LinksEdgesInput,
    result: LinksEdgesResult,
    ipc: {
      channel: "desktop:links-edges",
      inactiveMessage: "Graph read stopped because this window changed workspaces.",
    },
    cli: {
      verb: "linksEdges",
      command: ["links", "edges"],
      summary: "Read a bounded page of file links.",
      operands: "",
      flags: [CURSOR_FLAG],
      unavailable,
      example: [],
    },
    mcp: {
      tool: "dohc_links_edges",
      levels: EVERY_MCP_LEVEL,
      description:
        "Read a bounded page of file links and isolated Markdown files and drawings. Continue nextCursor until null. indexBuilding reports active indexing; unchecked names uncertified sources; mountsCovered reports mount coverage.",
    },
  },
  linksIn: {
    access: "read",
    capabilityId: "links.in",
    input: LinksInInput,
    result: LinksInResult,
    ipc: {
      channel: "desktop:links-in",
      inactiveMessage: "Linked mentions stopped because this window changed workspaces.",
    },
    cli: {
      verb: "linksIn",
      command: ["links", "in"],
      summary: "Read documents that link to a file.",
      operands: "<subject-json>",
      flags: [CURSOR_FLAG],
      unavailable,
      example: ['{"path":"a.md"}'],
    },
    mcp: {
      tool: "dohc_links_in",
      levels: EVERY_MCP_LEVEL,
      description:
        "Read a bounded page of documents linking to a file. indexBuilding reports active indexing; unchecked names omitted sources. complete excludes mount coverage, reported by mountsCovered. Cursors carry index state across pages.",
    },
  },
  linksResolve: {
    access: "read",
    capabilityId: "links.resolve",
    input: LinksResolveInput,
    result: LinksResolveResult,
    ipc: {
      channel: "desktop:links-resolve",
      inactiveMessage: "Link navigation stopped because this window changed workspaces.",
    },
    cli: {
      verb: "linksResolve",
      command: ["links", "resolve"],
      summary: "Resolve links from one document.",
      operands: "<source> <literals-json>",
      unavailable,
      example: ["a.md", '[{"kind":"wikilink","literal":"b"}]'],
    },
    mcp: {
      tool: "dohc_links_resolve",
      levels: EVERY_MCP_LEVEL,
      description:
        "Resolve wikilink or Markdown literals from one source document using the engine's link rules.",
    },
  },
} as const satisfies OperationFamily;
