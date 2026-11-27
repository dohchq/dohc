import {
  LinksConnectionsInput,
  LinksConnectionsResult,
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
  linksConnections: {
    access: "read",
    capabilityId: "links.connections",
    input: LinksConnectionsInput,
    result: LinksConnectionsResult,
    ipc: {
      channel: "desktop:links-connections",
      inactiveMessage: "Graph read stopped because this window changed workspaces.",
    },
    cli: {
      verb: "linksConnections",
      command: ["links", "connections"],
      summary: "Read how Collections, apps, and automations connect.",
      operands: "",
      unavailable,
      example: [],
    },
    mcp: {
      tool: "dohc_links_connections",
      levels: EVERY_MCP_LEVEL,
      description:
        "Read how the workspace's Collections, Datasets, apps, automations, and Groups connect, from files on this computer. approval says whether an app's data access is approved on this computer or only requested in app.publish.json. records lists each Collection's record files. complete is false when the answer was cut to fit 64 KiB. A received share lists only its shared Collections, their records, and Relations between them. An ended share, a joined workspace, or a call from inside shared-with-me returns scope share-omitted with nothing listed.",
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
