import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSectionId } from "./settingsRegistry";

export function DesktopSettings(props: {
  workspaceId: string;
  workspacePath: string;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onAgentActiveChange?: (update: {
    active: boolean;
    /**
     * True only when this panel started or ended the run itself. An
     * OBSERVATION may be older than a refresh the shell already has in
     * flight, so it must never supersede one.
     */
    mutated: boolean;
  }) => void;
  onOpenCloud?: () => void;
  // Share mounts added/removed from Settings change the workspace tree and
  // the shell's live mount set.
  onWorkspaceFilesChanged?: () => void;
}) {
  return <SettingsDialog {...props} />;
}
