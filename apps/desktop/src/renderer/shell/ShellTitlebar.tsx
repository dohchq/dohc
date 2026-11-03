import type { ReactNode } from "react";
import type { SyncStatusResult, WorkspaceSummary } from "../../ipc/bridgeContract";
import { Titlebar } from "../Titlebar";
import { WorkspaceSyncStatus } from "../workbench/WorkspaceSyncStatus";
import { RestrictedModeIndicator } from "../RestrictedMode";
import { toggleAbout, type WorkbenchState } from "../workbench/workbenchState";

// The shell's titlebar: the workspace switcher, the version picker, the saved
// dot, Restricted Mode, the update button, and the two side panel toggles.
export function ShellTitlebar(props: {
  update: ReactNode;
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
  // Present while the workspace is in Restricted Mode.
  restrictedMode?: { asking: boolean; onTrust: () => void };
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
      workspaceStatus={
        <>
          <WorkspaceSyncStatus syncStatus={syncStatus} failedSaves={failedSaves} />
          {props.restrictedMode ? <RestrictedModeIndicator {...props.restrictedMode} /> : null}
        </>
      }
      onWorkspaceContextMenu={() => void showWorkbenchMenu("status")}
      agentActive={agentActive}
      update={props.update}
      primarySidebar={{
        visible: wb.sidebarVisible,
        onToggle: toggleSidePanel,
      }}
      aboutSidebar={{
        visible: wb.aboutVisible,
        onToggle: () => mutateWb(toggleAbout),
      }}
    />
  );
}
