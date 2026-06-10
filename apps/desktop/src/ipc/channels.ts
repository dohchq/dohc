export const CHANNELS = {
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  getDefaultWorkspaceRoot: "desktop:get-default-workspace-root",
  createLocalWorkspace: "desktop:create-local-workspace",
  attachWorkspaceFolder: "desktop:attach-workspace-folder",
  listWorkspaceFiles: "desktop:list-workspace-files",
  createWorkspaceFile: "desktop:create-workspace-file",
  importWorkspaceFiles: "desktop:import-workspace-files",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
