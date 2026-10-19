import { systemPrivacySettingsOperations } from "./bridgeContract";
import { registerOperations, type OperationBoundary } from "./operationTable";

const FILES_AND_FOLDERS = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

// Where a person allows dohc a folder macOS refused.
export function registerSystemPrivacySettingsIpc<Event, Operation>(
  boundary: OperationBoundary<Event, Operation>,
  platform: NodeJS.Platform,
  openExternal: (url: string) => Promise<void>,
): void {
  registerOperations(boundary, systemPrivacySettingsOperations, {
    openSystemPrivacySettings: async () => {
      if (platform !== "darwin") throw new Error("Only macOS has these privacy settings.");
      await openExternal(FILES_AND_FOLDERS);
    },
  });
}
