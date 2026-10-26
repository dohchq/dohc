import { ExplorerMenuEntries, ReadExplorerMenuPayload, RevealExplorerPathPayload } from "./bridgeContract";
import type { OperationTable } from "./operationTable";

// The Explorer's menu: main answers with the entries it offers for what was
// right-clicked, and the renderer draws exactly those. Every entry's own
// operation keeps its own admission.
export const explorerMenuOperations = {
  readExplorerMenu: {
    capabilityId: "explorer.menu.read", channel: "desktop:read-explorer-menu",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Explorer action stopped because this window changed workspaces.",
    payload: ReadExplorerMenuPayload, result: ExplorerMenuEntries,
  },
  revealExplorerPath: {
    capabilityId: "file.reveal", channel: "desktop:reveal-explorer-path",
    scope: "workspace", guard: "active-workspace",
    inactiveMessage: "Explorer action stopped because this window changed workspaces.",
    payload: RevealExplorerPathPayload,
  },
} satisfies OperationTable;
