import { z } from "zod";
import { LinksInInput, LinksResolveInput, LinksInResult, LinksResolveResult } from "@dohc/workspace-contracts/links";
import type { OperationTable } from "./operationTable";

const workspace = { workspaceId: z.string().min(1) };
export const linksOperations = {
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
