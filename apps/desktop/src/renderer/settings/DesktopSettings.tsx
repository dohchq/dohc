import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSectionId } from "./settingsRegistry";

export function DesktopSettings(props: {
  workspaceId: string;
  workspacePath: string;
  /**
   * True when this workspace is a shared view (#589). It is fed by the
   * share's pull and gets no capture, so the workspace-engine row states
   * that capability instead of offering a toggle that records nothing.
   */
  sharedView?: boolean;
  /**
   * Main's open-time recorder decision for this workspace (#687), undefined
   * until its status arrives.
   */
  sessionRecorderOn?: boolean;
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
  onWorkspaceFilesChanged?: (outcome?: {
    // The removal cleaned up the record but left its folder on disk. The
    // shell needs the id before its reload sees the record vanish.
    folderLeftShareId?: string;
  }) => void;
}) {
  return <SettingsDialog {...props} />;
}
