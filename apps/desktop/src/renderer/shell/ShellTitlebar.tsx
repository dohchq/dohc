import type { ReactNode } from "react";
import type { SyncStatusResult, WorkspaceSummary } from "../../ipc/bridgeContract";
import { Titlebar } from "../Titlebar";
import { WorkspaceSyncStatus } from "../workbench/WorkspaceSyncStatus";
import { toggleChats, type WorkbenchState } from "../workbench/workbenchState";

// The shell's titlebar: the workspace switcher, the version picker, the saved
// dot, and the two side panel toggles.
export function ShellTitlebar(props: {
  // The version picker, when this workspace records versions.
  version?: ReactNode;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  onManageWorkspaces?: () => void | Promise<void>;
  manageWorkspaces: () => void;
  setOpenShare: (share: "blank") => void;
  setQuickOpenOpen: (open: boolean) => void;
  syncStatus: SyncStatusResult | null;
  failedSaves: number;
  showWorkbenchMenu: (context: "status") => Promise<void>;
  agentActive: boolean;
  wb: WorkbenchState;
  toggleSidePanel: () => void;
  mutateWb: (updater: (state: WorkbenchState) => WorkbenchState) => void;
}) {
  const {
    manageWorkspaces,
    setOpenShare,
    setQuickOpenOpen,
    syncStatus,
    failedSaves,
    showWorkbenchMenu,
    agentActive,
    wb,
    toggleSidePanel,
    mutateWb,
  } = props;
  return (
    <Titlebar
      workspace={props.workspace}
      workspaces={props.workspaces}
      onSwitchWorkspace={props.onSwitchWorkspace}
      onOpenShare={() => setOpenShare("blank")}
      onManageWorkspaces={props.onManageWorkspaces ? manageWorkspaces : undefined}
      onQuickOpen={() => setQuickOpenOpen(true)}
      version={props.version}
      workspaceStatus={<WorkspaceSyncStatus syncStatus={syncStatus} failedSaves={failedSaves} />}
      onWorkspaceContextMenu={() => void showWorkbenchMenu("status")}
      agentActive={agentActive}
      primarySidebar={{
        visible: wb.sidebarVisible,
        onToggle: toggleSidePanel,
      }}
      chatsSidebar={{
        visible: wb.chatsVisible,
        onToggle: () => mutateWb(toggleChats),
      }}
    />
  );
}
