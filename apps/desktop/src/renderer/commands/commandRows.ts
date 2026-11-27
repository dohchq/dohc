import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import type { UpdateStateEvent } from "../../ipc/bridgeContract";
import { workspaceCreateOffers, type ShareViewWriteScope } from "../../workspaces/shareWriteGate";
import { APP_VIEW_ID_PREFIX, appViewId, type AppViewId } from "../workbench/workbenchState";

export interface CommandContext {
  // The share view this workspace is, or null for an ordinary workspace.
  shareView: ShareViewWriteScope | null;
  // A joined workspace's role, as the relay last named it.
  memberRole?: "admin" | "member";
  activeDocumentKind: string | null;
  activeDocumentShareable: boolean;
  pinnedApps: readonly { root: string; label: string }[];
  updateStatus: UpdateStateEvent["status"] | null;
}

export const COMMAND_AVAILABILITY = {
  always: (_context: CommandContext) => true,
  workspaceWritable: (context: CommandContext) =>
    workspaceCreateOffers(context.shareView, context.memberRole).write,
  folderCreatable: (context: CommandContext) =>
    workspaceCreateOffers(context.shareView, context.memberRole).folder,
  collectionCreatable: (context: CommandContext) =>
    workspaceCreateOffers(context.shareView, context.memberRole).collection,
  activeMarkdown: (context: CommandContext) => context.activeDocumentKind === "markdown",
  activeShareable: (context: CommandContext) => context.activeDocumentShareable,
  localWorkspace: (context: CommandContext) => context.shareView === null,
  joinedWorkspace: (context: CommandContext) => context.shareView?.membership === true,
  membersWorkspace: (context: CommandContext) =>
    context.shareView === null || context.shareView.membership === true,
  updateAvailable: (context: CommandContext) => context.updateStatus === "available",
  updateReady: (context: CommandContext) => context.updateStatus === "ready",
  pinnedApp: (context: CommandContext, id: PinnedAppCommandId) =>
    context.pinnedApps.some((app) => pinnedAppCommandId(app.root) === id),
};

export type CommandIconId =
  | "file-plus"
  | "pen-tool"
  | "folder-plus"
  | "inbox"
  | "table"
  | "search"
  | "folder-open"
  | "upload"
  | "download"
  | "panel-left"
  | "x"
  | "arrow-right"
  | "arrow-left"
  | "columns"
  | "code"
  | "share"
  | "panel-right"
  | "files"
  | "message-circle"
  | "workflow"
  | "history"
  | "layers"
  | "app-window"
  | "cloud"
  | "settings"
  | "palette"
  | "sparkles"
  | "refresh"
  | "gift"
  | "sun-moon"
  | "zoom-in"
  | "zoom-out"
  | "rotate-ccw";

export type CommandGroup = "Create" | "Files" | "Editor & layout" | "Views" | "Settings & app";

interface StaticRow {
  label: string;
  availability: Exclude<keyof typeof COMMAND_AVAILABILITY, "pinnedApp">;
  capabilityId?: CapabilityId;
  group: CommandGroup;
  icon: CommandIconId;
  keywords?: readonly string[];
}

export const COMMAND_ROWS = {
  "new-file": {
    label: "New page",
    availability: "workspaceWritable",
    group: "Create",
    icon: "file-plus",
    keywords: ["page", "document", "markdown", "note", "create"],
  },
  "new-file-at-path": {
    label: "New file…",
    availability: "workspaceWritable",
    group: "Create",
    icon: "file-plus",
    keywords: ["path", "create", "document", "page"],
  },
  "new-drawing": {
    label: "New sketch",
    availability: "workspaceWritable",
    group: "Create",
    icon: "pen-tool",
    keywords: ["drawing", "sketch", "canvas", "excalidraw", "diagram"],
  },
  "new-folder": {
    label: "New folder",
    availability: "folderCreatable",
    capabilityId: "folder.create",
    group: "Create",
    icon: "folder-plus",
    keywords: ["directory", "create"],
  },
  "new-collection": {
    label: "New Collection",
    availability: "collectionCreatable",
    group: "Create",
    icon: "table",
    keywords: ["database", "table", "dataset", "records"],
  },
  "quick-capture": {
    label: "Capture to Inbox",
    availability: "localWorkspace",
    group: "Create",
    icon: "inbox",
    keywords: ["inbox", "capture", "quick capture", "drop", "triage", "clip"],
  },
  "quick-open": {
    label: "Go to",
    availability: "always",
    group: "Files",
    icon: "search",
    keywords: ["quick open", "find file", "jump", "switch"],
  },
  "open-workspace": {
    label: "Open workspace folder…",
    availability: "always",
    group: "Files",
    icon: "folder-open",
    keywords: ["directory", "folder", "project"],
  },
  "import-files": {
    label: "Import files",
    availability: "workspaceWritable",
    group: "Files",
    icon: "upload",
    keywords: ["add", "upload", "copy"],
  },
  "export-workspace": {
    label: "Export workspace as ZIP",
    availability: "always",
    group: "Files",
    icon: "download",
    keywords: ["backup", "archive", "download"],
  },
  "toggle-sidebar": {
    label: "Toggle sidebar",
    availability: "always",
    group: "Editor & layout",
    icon: "panel-left",
    keywords: ["sidebar", "panel", "explorer", "hide", "show"],
  },
  "close-tab": {
    label: "Close tab",
    availability: "always",
    group: "Editor & layout",
    icon: "x",
    keywords: ["editor", "dismiss"],
  },
  "next-tab": {
    label: "Show next tab",
    availability: "always",
    group: "Editor & layout",
    icon: "arrow-right",
    keywords: ["switch tab", "cycle"],
  },
  "previous-tab": {
    label: "Show previous tab",
    availability: "always",
    group: "Editor & layout",
    icon: "arrow-left",
    keywords: ["switch tab", "cycle"],
  },
  "new-editor-group-right": {
    label: "New editor group right",
    availability: "always",
    group: "Editor & layout",
    icon: "columns",
    keywords: ["split", "pane", "side by side", "columns"],
  },
  "toggle-markdown-source": {
    label: "Toggle Markdown source",
    availability: "activeMarkdown",
    group: "Editor & layout",
    icon: "code",
    keywords: ["raw", "code", "source", "markdown"],
  },
  "share-file": {
    label: "Share…",
    availability: "activeShareable",
    group: "Editor & layout",
    icon: "share",
    keywords: ["link", "invite", "collaborate"],
  },
  "toggle-about": {
    label: "Toggle About",
    availability: "always",
    group: "Editor & layout",
    icon: "panel-right",
    keywords: ["inspector", "right sidebar", "info", "details", "sidebar"],
  },
  "show-explorer": {
    label: "View: Explorer",
    availability: "always",
    group: "Views",
    icon: "files",
    keywords: ["files", "tree", "sidebar"],
  },
  "show-chats": {
    label: "View: Chats",
    availability: "localWorkspace",
    group: "Views",
    icon: "message-circle",
    keywords: ["messages", "channels", "discussion"],
  },
  "show-search": {
    label: "View: Search",
    availability: "always",
    group: "Views",
    icon: "search",
    keywords: ["find", "grep", "text"],
  },
  "show-graph": {
    label: "View: Graph",
    availability: "always",
    group: "Views",
    icon: "workflow",
    keywords: ["links", "backlinks", "network"],
  },
  "show-history": {
    label: "View: History",
    availability: "always",
    group: "Views",
    icon: "history",
    keywords: ["timeline", "changes", "diff", "restore"],
  },
  "personal-apps": {
    label: "Personal apps…",
    availability: "joinedWorkspace",
    capabilityId: "app.personal.folder",
    group: "Views",
    icon: "app-window",
    keywords: ["apps", "build", "private", "folder"],
  },
  "workspace-apps": {
    label: "Workspace apps…",
    availability: "membersWorkspace",
    capabilityId: "app.member.list",
    group: "Views",
    icon: "app-window",
    keywords: ["apps", "members", "shared", "review"],
  },
  "open-versions": {
    label: "Show all versions",
    availability: "localWorkspace",
    group: "Views",
    icon: "layers",
    keywords: ["branches", "versions", "merge"],
  },
  "connect-cloud": {
    label: "Connect server",
    availability: "always",
    group: "Settings & app",
    icon: "cloud",
    keywords: ["sync", "sign in", "login", "account", "relay"],
  },
  settings: {
    label: "Settings",
    availability: "always",
    group: "Settings & app",
    icon: "settings",
    keywords: ["prefs", "preferences", "options", "config"],
  },
  "settings-appearance": {
    label: "Settings: Appearance",
    availability: "always",
    group: "Settings & app",
    icon: "palette",
    keywords: ["prefs", "preferences", "theme", "dark", "light", "font", "accent", "sidebar"],
  },
  "settings-agents": {
    label: "Settings: Agents",
    availability: "always",
    group: "Settings & app",
    icon: "sparkles",
    keywords: ["prefs", "preferences", "mcp", "ai", "claude", "codex"],
  },
  "check-updates": {
    label: "Check for updates",
    availability: "always",
    group: "Settings & app",
    icon: "refresh",
    keywords: ["upgrade", "version", "release"],
  },
  "download-update": {
    label: "Update dohc",
    availability: "updateAvailable",
    group: "Settings & app",
    icon: "download",
    keywords: ["upgrade", "install"],
  },
  "install-update": {
    label: "Restart to update",
    availability: "updateReady",
    group: "Settings & app",
    icon: "refresh",
    keywords: ["upgrade", "relaunch"],
  },
  "whats-new": {
    label: "What's new",
    availability: "always",
    group: "Settings & app",
    icon: "gift",
    keywords: ["changelog", "release notes", "updates"],
  },
  "toggle-theme": {
    label: "Toggle light or dark theme",
    availability: "always",
    group: "Settings & app",
    icon: "sun-moon",
    keywords: ["theme", "dark", "light", "appearance", "color scheme"],
  },
  "zoom-in": {
    label: "Zoom in",
    availability: "always",
    group: "Settings & app",
    icon: "zoom-in",
    keywords: ["scale", "bigger", "font size"],
  },
  "zoom-out": {
    label: "Zoom out",
    availability: "always",
    group: "Settings & app",
    icon: "zoom-out",
    keywords: ["scale", "smaller", "font size"],
  },
  "zoom-reset": {
    label: "Reset zoom",
    availability: "always",
    group: "Settings & app",
    icon: "rotate-ccw",
    keywords: ["scale", "default", "100%"],
  },
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
  group: CommandGroup;
  icon: CommandIconId;
  keywords?: readonly string[];
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
      rows.push(
        ...context.pinnedApps.map((app) => ({
          id: pinnedAppCommandId(app.root),
          label: `View: ${app.label}`,
          availability: "pinnedApp" as const,
          group: "Views" as const,
          icon: "app-window" as const,
          keywords: ["app", "pinned", app.label],
        })),
      );
    }
    const row: StaticRow = COMMAND_ROWS[id];
    if (isCommandAvailable(id, context)) rows.push({ id, ...row });
  }
  return rows;
}
