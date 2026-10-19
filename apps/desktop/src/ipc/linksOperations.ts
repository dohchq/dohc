import { z } from "zod";
import { LinksEdgesInput, LinksEdgesResult, LinksInInput, LinksResolveInput, LinksInResult, LinksResolveResult } from "@dohc/workspace-contracts/links";
import type { OperationTable } from "./operationTable";

const workspace = { workspaceId: z.string().min(1).max(256) };
export const linksOperations = {
  linksEdges: {
    capabilityId: "links.edges",
    channel: "desktop:links-edges",
    scope: "workspace",
    guard: "active-workspace",
    inactiveMessage: "Graph read stopped because this window changed workspaces.",
    payload: LinksEdgesInput.extend(workspace),
    result: LinksEdgesResult,
  },
  linksIn: {
    capabilityId: "links.in",
    channel: "desktop:links-in",
    scope: "workspace",
    guard: "active-workspace",
    inactiveMessage: "Linked mentions stopped because this window changed workspaces.",
    payload: LinksInInput.extend(workspace),
    result: LinksInResult,
  },
  linksResolve: {
    capabilityId: "links.resolve",
    channel: "desktop:links-resolve",
    scope: "workspace",
    guard: "active-workspace",
    inactiveMessage: "Link navigation stopped because this window changed workspaces.",
    payload: LinksResolveInput.extend(workspace),
    result: LinksResolveResult,
  },
} satisfies OperationTable;
