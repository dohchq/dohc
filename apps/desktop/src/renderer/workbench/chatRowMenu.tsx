import { Archive, ArchiveRestore, CheckCheck, LogOut, Power, Settings, Trash2, UserPlus } from "lucide-react";
import { MENU_SEPARATOR, type MenuEntry } from "../ui/Menu";

// What a right-click on a chat row in the sidebar can do. Each kind of row
// lists only what that row can do now: a row with nothing unread has no
// Mark as read, and a group shared with you cannot add people.
export type ChatRowMenuTarget =
  | { kind: "group"; unread: boolean; archived: boolean; canAddPeople: boolean; canLeave: boolean }
  | { kind: "person"; unread: boolean; archived: boolean }
  | {
      kind: "agent";
      unread: boolean;
      archived: boolean;
      // The agent's chat stays after its agent leaves Settings, archived, and
      // only Settings can bring the agent back.
      removed: boolean;
      // null for an agent you run yourself, which dohc never starts.
      enabled: boolean | null;
      canRemove: boolean;
    };

export type ChatRowMenuActions = {
  markRead: () => void;
  setArchived: (archived: boolean) => void;
  addPeople: () => void;
  leave: () => void;
  openAgentSettings?: () => void;
  setAgentEnabled: (enabled: boolean) => void;
  removeAgent: () => void;
};

const ICON = 14;

export function chatRowMenuItems(target: ChatRowMenuTarget, actions: ChatRowMenuActions): MenuEntry[] {
  const top: MenuEntry[] = [];
  const bottom: MenuEntry[] = [];
  if (target.unread) {
    top.push({ id: "mark-read", label: "Mark as read", icon: <CheckCheck size={ICON} aria-hidden />, onSelect: actions.markRead, testId: "chat-row-menu-mark-read" });
  }
  const archive: MenuEntry = target.archived
    ? { id: "unarchive", label: "Unarchive", icon: <ArchiveRestore size={ICON} aria-hidden />, onSelect: () => actions.setArchived(false), testId: "chat-row-menu-unarchive" }
    : { id: "archive", label: "Archive", icon: <Archive size={ICON} aria-hidden />, onSelect: () => actions.setArchived(true), testId: "chat-row-menu-archive" };
  if (target.kind === "group") {
    if (target.canAddPeople) {
      top.push({ id: "add-people", label: "Add people…", icon: <UserPlus size={ICON} aria-hidden />, onSelect: actions.addPeople, testId: "chat-row-menu-add-people" });
    }
    bottom.push(archive);
    if (target.canLeave) {
      bottom.push({ id: "leave", label: "Leave group", icon: <LogOut size={ICON} aria-hidden />, danger: true, onSelect: actions.leave, testId: "chat-row-menu-leave" });
    }
  } else if (target.kind === "person") {
    bottom.push(archive);
  } else if (target.removed) {
    // Its agent is gone, so the chat cannot come back from Archived. Agents
    // in Settings is where an agent is added again.
    if (actions.openAgentSettings) {
      top.push({ id: "open-agents", label: "Open Agents", icon: <Settings size={ICON} aria-hidden />, onSelect: actions.openAgentSettings, testId: "chat-row-menu-open-agents" });
    }
  } else {
    if (actions.openAgentSettings) {
      top.push({ id: "agent-settings", label: "Agent settings", icon: <Settings size={ICON} aria-hidden />, onSelect: actions.openAgentSettings, testId: "chat-row-menu-agent-settings" });
    }
    if (target.enabled !== null) {
      const enabled = target.enabled;
      top.push({
        id: "agent-power",
        label: enabled ? "Turn off" : "Turn on",
        icon: <Power size={ICON} aria-hidden />,
        onSelect: () => actions.setAgentEnabled(!enabled),
        testId: "chat-row-menu-agent-power",
      });
    }
    bottom.push(archive);
    if (target.canRemove) {
      bottom.push({ id: "remove-agent", label: "Remove agent", icon: <Trash2 size={ICON} aria-hidden />, danger: true, onSelect: actions.removeAgent, testId: "chat-row-menu-remove-agent" });
    }
  }
  if (top.length > 0 && bottom.length > 0) return [...top, MENU_SEPARATOR, ...bottom];
  return [...top, ...bottom];
}
