// Pure state machine for the desktop auto-update flow. electron-updater
// events arrive as plain UpdateEvent values (electronUpdater.ts owns that
// wiring), so this module and its tests never touch Electron.

export type UpdateState =
  | { status: "idle"; message: string }
  | { status: "checking"; message: string }
  | { status: "up-to-date"; message: string }
  | { status: "available"; version: string; message: string }
  | { status: "downloading"; version: string; percent: number; message: string }
  // deferred: the user chose to keep working — the update installs on quit.
  | { status: "ready"; version: string; deferred: boolean; message: string }
  | { status: "offline"; message: string }
  | { status: "error"; message: string };

export type UpdateEvent =
  | { type: "check" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "defer" }
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

function ready(version: string, deferred: boolean): UpdateState {
  return {
    status: "ready",
    version,
    deferred,
    message: deferred
      ? `Update ${version} will finish installing when you quit dohc.`
      : `Update ${version} is ready — restart dohc to apply it.`,
  };
}

export function transition(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check":
      // Never interrupts an in-flight check/download or a downloaded update.
      return state.status === "idle" ||
        state.status === "up-to-date" ||
        state.status === "error" ||
        state.status === "offline"
        ? CHECKING
        : state;
    case "available":
      return state.status === "checking"
        ? {
            status: "available",
            version: event.version,
            message: `Update ${event.version} is available — downloading…`,
          }
        : state;
    case "not-available":
      return state.status === "checking"
        ? { status: "up-to-date", message: "You're on the latest version." }
        : state;
    case "progress":
      return state.status === "available" || state.status === "downloading"
        ? {
            status: "downloading",
            version: state.version,
            percent: event.percent,
            message: `Downloading update ${state.version} — ${Math.round(event.percent)}%`,
          }
        : state;
    case "downloaded":
      // Small or cached updates can skip available/progress entirely.
      return state.status === "checking" ||
        state.status === "available" ||
        state.status === "downloading"
        ? ready(event.version, false)
        : state;
    case "defer":
      return state.status === "ready" ? ready(state.version, true) : state;
    case "offline":
      // A downloaded update survives going offline: install-on-quit is local.
      return state.status === "ready"
        ? state
        : {
            // One-shot reality: the wiring checks once at startup, so the next
            // check is the next launch (a "check" event still recovers here).
            status: "offline",
            message: "You're offline — dohc will check for updates the next time it starts.",
          };
    case "error":
      // A downloaded update still installs on quit (autoInstallOnAppQuit), so
      // "ready" survives errors exactly like it survives going offline.
      return state.status === "ready"
        ? state
        : {
            status: "error",
            message: `Update failed: ${event.message}. dohc keeps working and will check again the next time it starts.`,
          };
  }
}
