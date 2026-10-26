import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The desktop's CLI socket is <home>/dohc-cli.sock, and a Unix socket path
// holds at most these many bytes before its final NUL. A worktree's
// .agent-artifacts/debug/<id>/home is too long for it on a Mac (#2619), so on
// macOS and Linux a debug session keeps its home in the temp folder. Windows
// uses a named pipe, so its home stays beside the session's other files.
export const SOCKET_PATH_BYTES = { darwin: 103, linux: 107 };

/** The debug session's home folder, and whether it is a temporary one to remove when the session ends. */
export function makeDebugHome(directory, platform = process.platform) {
  if (platform === "win32") return { home: join(directory, "home"), temporary: false };
  return { home: mkdtempSync(join(tmpdir(), "dohc-debug-")), temporary: true };
}

export function removeDebugHome({ home, temporary }) {
  if (temporary) rmSync(home, { recursive: true, force: true });
}
