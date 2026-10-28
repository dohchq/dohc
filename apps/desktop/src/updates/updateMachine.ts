// Pure state machine for the desktop auto-update flow. electron-updater
// events arrive as plain UpdateEvent values (electronUpdater.ts owns that
// wiring), so this module and its tests never touch Electron.

export const UPDATE_CHANNELS = ["latest", "nightly"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

// Main hands the build's channel to every preload as a process argument, so
// the renderer reads it as a constant, like the platform.
const RELEASE_CHANNEL_ARGUMENT = "--dohc-release-channel=";

export function releaseChannelPreloadArguments(channel: UpdateChannel): string[] {
  return [`${RELEASE_CHANNEL_ARGUMENT}${channel}`];
}

export function releaseChannelFromArgv(argv: readonly string[]): UpdateChannel {
  return argv.includes(`${RELEASE_CHANNEL_ARGUMENT}nightly`) ? "nightly" : "latest";
}

export type UpdateState =
  | { status: "idle"; message: string }
  | { status: "checking"; message: string }
  | { status: "up-to-date"; message: string }
  // Found, and waiting for the person to download it.
  | { status: "available"; version: string; message: string }
  // percent is absent until the updater reports progress.
  | { status: "downloading"; version: string; percent?: number; message: string }
  | { status: "ready"; version: string; message: string }
  | { status: "offline"; message: string }
  | { status: "error"; message: string };

// The closed status set the IPC contract admits. `satisfies` proves every
// member is a real status; the check below proves every status is a member.
export const UPDATE_STATUSES = [
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "offline",
  "error",
] as const satisfies readonly UpdateState["status"][];
const _everyStatusListed: (typeof UPDATE_STATUSES)[number] =
  null as unknown as UpdateState["status"];
void _everyStatusListed;

export type UpdateEvent =
  | { type: "check" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "download" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "offline" }
  | { type: "error"; message: string };

export const initialUpdateState: UpdateState = {
  status: "idle",
  message: "Updates have not been checked yet.",
};

const CHECKING: UpdateState = {
  status: "checking",
  message: "Checking for updates…",
};

function available(version: string): UpdateState {
  return { status: "available", version, message: `dohc ${version} is available.` };
}

export function transition(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check":
      // Never interrupts an in-flight check/download or a found update.
      return state.status === "idle" ||
        state.status === "up-to-date" ||
        state.status === "error" ||
        state.status === "offline"
        ? CHECKING
        : state;
    case "available":
      return state.status === "checking" ? available(event.version) : state;
    case "not-available":
      return state.status === "checking"
        ? { status: "up-to-date", message: "You're on the latest version." }
        : state;
    case "download":
      return state.status === "available"
        ? { status: "downloading", version: state.version, message: `Downloading update ${state.version}…` }
        : state;
    case "progress":
      return state.status === "downloading"
        ? {
            status: "downloading",
            version: state.version,
            percent: event.percent,
            message: `Downloading update ${state.version}, ${Math.round(event.percent)}%`,
          }
        : state;
    case "downloaded":
      return state.status === "downloading"
        ? { status: "ready", version: event.version, message: `Update ${event.version} is ready. Restart dohc to install it.` }
        : state;
    case "offline":
    case "error":
      // A downloaded update still installs: installing it is local. A failed
      // download leaves the update to download again.
      if (state.status === "ready") return state;
      if (state.status === "downloading") return available(state.version);
      return event.type === "offline"
        ? { status: "offline", message: "You're offline. dohc checks for updates again later." }
        : { status: "error", message: event.message };
  }
}
