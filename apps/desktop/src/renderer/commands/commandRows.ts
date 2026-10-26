import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { workspaceCreateOffers, type ShareViewWriteScope } from "../../workspaces/shareWriteGate";
import { APP_VIEW_ID_PREFIX, appViewId, type AppViewId } from "../workbench/workbenchState";

export interface CommandContext {
  // The share view this workspace is, or null for an ordinary workspace.
  shareView: ShareViewWriteScope | null;
  activeDocumentKind: string | null;
  // Whether the active editor's file has a Share button.
  activeDocumentShareable: boolean;
  pinnedApps: readonly { root: string; label: string }[];
}

export const COMMAND_AVAILABILITY = {
  always: (_context: CommandContext) => true,
  workspaceWritable: (context: CommandContext) => workspaceCreateOffers(context.shareView).write,
  folderCreatable: (context: CommandContext) => workspaceCreateOffers(context.shareView).folder,
  collectionCreatable: (context: CommandContext) => workspaceCreateOffers(context.shareView).collection,
  activeMarkdown: (context: CommandContext) => context.activeDocumentKind === "markdown",
  activeShareable: (context: CommandContext) => context.activeDocumentShareable,
  localWorkspace: (context: CommandContext) => context.shareView === null,
  pinnedApp: (context: CommandContext, id: PinnedAppCommandId) =>
    context.pinnedApps.some((app) => pinnedAppCommandId(app.root) === id),
};

interface StaticRow {
  label: string;
  availability: Exclude<keyof typeof COMMAND_AVAILABILITY, "pinnedApp">;
  capabilityId?: CapabilityId;
}

export const COMMAND_ROWS = {
  "new-file": { label: "New file", availability: "workspaceWritable" },
  "new-drawing": { label: "New drawing", availability: "workspaceWritable" },
  "new-folder": { label: "New folder", availability: "folderCreatable", capabilityId: "folder.create" },
  "new-collection": { label: "New collection", availability: "collectionCreatable" },
  "quick-open": { label: "Go to", availability: "always" },
  "open-workspace": { label: "Open workspace folder…", availability: "always" },
  "import-files": { label: "Import files", availability: "workspaceWritable" },
  "export-workspace": { label: "Export workspace as zip", availability: "always" },
  "toggle-sidebar": { label: "Toggle sidebar", availability: "always" },
  "close-tab": { label: "Close tab", availability: "always" },
  "next-tab": { label: "Show next tab", availability: "always" },
  "previous-tab": { label: "Show previous tab", availability: "always" },
  "new-editor-group-right": { label: "New editor group right", availability: "always" },
  "toggle-markdown-source": { label: "Toggle markdown source view", availability: "activeMarkdown" },
  "share-file": { label: "Share…", availability: "activeShareable" },
  "toggle-about": { label: "Toggle About", availability: "always" },
  "show-explorer": { label: "View: Explorer", availability: "always" },
  "show-chats": { label: "View: Chats", availability: "localWorkspace" },
  "show-search": { label: "View: Search", availability: "always" },
  "show-graph": { label: "View: Graph", availability: "always" },
  "show-sites": { label: "View: Apps", availability: "always" },
  "show-history": { label: "View: History", availability: "always" },
  "connect-cloud": { label: "Connect server", availability: "always" },
  "settings": { label: "Settings", availability: "always" },
  "settings-appearance": { label: "Settings: Open Appearance", availability: "always" },
  "settings-agents": { label: "Settings: Open Agents (MCP)", availability: "always" },
  "check-updates": { label: "Check for updates", availability: "always" },
  "install-update": { label: "Update and restart", availability: "always" },
  "toggle-theme": { label: "Toggle light/dark theme", availability: "always" },
  "zoom-in": { label: "Zoom in", availability: "always" },
  "zoom-out": { label: "Zoom out", availability: "always" },
  "zoom-reset": { label: "Reset zoom", availability: "always" },
} as const satisfies Record<string, StaticRow>;

export type StaticCommandId = keyof typeof COMMAND_ROWS;
export type PinnedAppCommandId = `show-${AppViewId}`;
export type CommandId = StaticCommandId | PinnedAppCommandId;
export type CommandHandlers = Record<CommandId, () => void>;

export interface CommandRow {
  id: CommandId;
  label: string;
  availability: keyof typeof COMMAND_AVAILABILITY;
  capabilityId?: CapabilityId;
}

export function pinnedAppCommandId(root: string): PinnedAppCommandId {
  return `show-${appViewId(root)}`;
}

export function isStaticCommandId(id: string): id is StaticCommandId {
  return Object.hasOwn(COMMAND_ROWS, id);
}

export function isCommandAvailable(id: CommandId, context: CommandContext): boolean {
  if (isStaticCommandId(id)) return COMMAND_AVAILABILITY[COMMAND_ROWS[id].availability](context);
  if (!id.startsWith(`show-${APP_VIEW_ID_PREFIX}`)) throw new Error(`Unknown command: ${id}`);
  return COMMAND_AVAILABILITY.pinnedApp(context, id);
}

// Pinned app rows keep their position before Connect server.
export function paletteCommandRows(context: CommandContext): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const id of Object.keys(COMMAND_ROWS) as StaticCommandId[]) {
    if (id === "connect-cloud") {
      rows.push(...context.pinnedApps.map((app) => ({
        id: pinnedAppCommandId(app.root),
        label: `View: ${app.label}`,
        availability: "pinnedApp" as const,
      })));
    }
    const row: StaticRow = COMMAND_ROWS[id];
    if (isCommandAvailable(id, context)) rows.push({ id, ...row });
  }
  return rows;
}
