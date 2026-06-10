export const CHANNELS = {
  getVersion: "desktop:get-version",
  pickWorkspaceRoot: "desktop:pick-workspace-root",
  getWorkspaceRegistry: "desktop:get-workspace-registry",
  firstPaint: "desktop:first-paint",
  getLaunchMarks: "desktop:test:get-launch-marks",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
