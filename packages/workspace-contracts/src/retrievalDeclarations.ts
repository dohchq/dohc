import { WorkspaceSearchInput, WorkspaceSearchResult } from "./retrieval";
import type { OperationFamily } from "./operationDeclaration";

export const RETRIEVAL_DECLARATIONS = {
  workspaceSearch: {
    access: "read",
    capabilityId: "workspace.search",
    input: WorkspaceSearchInput,
    result: WorkspaceSearchResult,
    ipc: {
      channel: "desktop:retrieve-workspace",
      inactiveMessage: "Workspace search stopped because this window changed workspaces.",
    },
    cli: {
      verb: "workspaceSearch",
      command: ["workspace", "search"],
      summary: "Search pages, Collections, records, and chats in one ranked call.",
      operands: "<query>",
      flags: [
        {
          name: "--surface",
          value: "surface",
          text: "Limit direct hits to page, collection, record, or chat. Repeatable.",
        },
        {
          name: "--path-prefix",
          value: "path",
          text: "Limit direct hits to a workspace folder prefix.",
        },
        {
          name: "--collection",
          value: "path",
          text: "Limit direct hits to one Collection path.",
        },
        {
          name: "--limit",
          value: "count",
          text: "Maximum direct hits to return, from 1 to 50. Defaults to 15.",
        },
        {
          name: "--no-neighbors",
          text: "Omit 1-hop related edges and connected neighbors.",
        },
      ],
      unavailable: "Workspace search is unavailable.",
      example: ["tokyo"],
    },
    mcp: {
      tool: "dohc_search_workspace",
      levels: ["owner"],
      description:
        "Search across pages, Document Collections, typed records, transactional dataset pointers, and chats in one ranked call, with 1-hop linked context (wikilinks, Collection relations, chat mentions). Use this first to recall context in the owning workspace before listing files or grepping chat. Check complete, indexBuilding, policyDegraded, mountsCovered, sharedChannelRowsUncovered, and truncated for coverage.",
    },
  },
} as const satisfies OperationFamily;
