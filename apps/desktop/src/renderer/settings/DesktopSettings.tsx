import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSectionId } from "./settingsRegistry";

export function DesktopSettings(props: {
  workspaceId: string;
  workspacePath: string;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onAgentActiveChange?: (active: boolean) => void;
  onOpenCloud?: () => void;
  // Share mounts added/removed from Settings change the workspace tree and
  // the shell's live mount set.
  onWorkspaceFilesChanged?: () => void;
}) {
  return <SettingsDialog {...props} />;
}
