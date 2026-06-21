import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSectionId } from "./settingsRegistry";

export function DesktopSettings(props: {
  workspaceId: string;
  workspacePath: string;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onAgentActiveChange?: (active: boolean) => void;
  onOpenCloud?: () => void;
}) {
  return <SettingsDialog {...props} />;
}
