import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";

export interface CommandContext {
  isShareView: boolean;
  shareViewWritable: boolean;
  activeDocumentKind: string | null;
  pinnedApps: readonly { root: string; label: string }[];
}

export const COMMAND_AVAILABILITY = {
  always: (_context: CommandContext) => true,
  collectionWritable: (context: CommandContext) => !context.isShareView || context.shareViewWritable,
  activeMarkdown: (context: CommandContext) => context.activeDocumentKind === "markdown",
  localWorkspace: (context: CommandContext) => !context.isShareView,
  pinnedApp: (context: CommandContext, id: PinnedAppCommandId) =>
    context.pinnedApps.some((app) => pinnedAppCommandId(app.root) === id),
};

interface StaticRow {
  label: string;
  availability: Exclude<keyof typeof COMMAND_AVAILABILITY, "pinnedApp">;
  capabilityId?: CapabilityId;
  palette?: false;
}

export const COMMAND_ROWS = {
  "new-file": { label: "New file", availability: "always" },
  "new-drawing": { label: "New drawing", availability: "always" },
  "new-folder": { label: "New folder", availability: "always", capabilityId: "folder.create" },
  "new-collection": { label: "New collection", availability: "collectionWritable" },
  "quick-open": { label: "Go to", availability: "always" },
  "open-workspace": { label: "Open workspace folder…", availability: "always" },
  "import-files": { label: "Import files", availability: "always" },
  "export-workspace": { label: "Export workspace as zip", availability: "always" },
  "toggle-sidebar": { label: "Toggle sidebar", availability: "always" },
  "close-tab": { label: "Close tab", availability: "always" },
  "new-editor-group-right": { label: "New editor group right", availability: "always" },
  "toggle-markdown-source": { label: "Toggle markdown source view", availability: "activeMarkdown" },
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
  "open-history": { label: "Open History", availability: "always", palette: false },
} as const satisfies Record<string, StaticRow>;

export type StaticCommandId = keyof typeof COMMAND_ROWS;
export type PinnedAppCommandId = `show-app-view:${string}`;
export type CommandId = StaticCommandId | PinnedAppCommandId;
export type CommandHandlers = Record<CommandId, () => void>;

export interface CommandRow {
  id: CommandId;
  label: string;
  availability: keyof typeof COMMAND_AVAILABILITY;
  capabilityId?: CapabilityId;
}

export function pinnedAppCommandId(root: string): PinnedAppCommandId {
  return `show-app-view:${encodeURIComponent(root)}`;
}

export function isStaticCommandId(id: string): id is StaticCommandId {
  return Object.hasOwn(COMMAND_ROWS, id);
}

export function isCommandAvailable(id: CommandId, context: CommandContext): boolean {
  if (isStaticCommandId(id)) return COMMAND_AVAILABILITY[COMMAND_ROWS[id].availability](context);
  if (!id.startsWith("show-app-view:")) throw new Error(`Unknown command: ${id}`);
  return COMMAND_AVAILABILITY.pinnedApp(context, id);
}

// Workbench-only Open History keeps its own id and dispatch. It is not a
// palette entry. Pinned app rows keep their position before Connect server.
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
    if (row.palette !== false && isCommandAvailable(id, context)) rows.push({ id, ...row });
  }
  return rows;
}
