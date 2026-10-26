import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The desktop's CLI socket is <home>/dohc-cli.sock, and a Unix socket path
// holds at most these many bytes before its final NUL. A worktree's
// .agent-artifacts/debug/<id>/home is too long for it on a Mac (#2619). So on
// macOS and Linux the app gets a short link to that folder in the temp
// folder: its files, such as agent run logs, stay with the session's
// evidence, and ending the session removes only the link. Windows uses a
// named pipe, so the app uses the folder itself.
export const SOCKET_PATH_BYTES = { darwin: 103, linux: 107 };
const SOCKET = "dohc-cli.sock";
const LINK_PREFIX = "dohc-debug-home-";

/**
 * The session's home: `files` holds what the app writes, and `home` is the
 * path the app is given. On macOS and Linux, `link` is the temp folder
 * holding `home`, which `removeDebugHome` deletes.
 */
export function makeDebugHome(directory, platform = process.platform, temp = tmpdir()) {
  const files = join(directory, "home");
  mkdirSync(files, { recursive: true });
  if (platform === "win32") return { files, home: files, link: null };
  const limit = SOCKET_PATH_BYTES[platform] ?? SOCKET_PATH_BYTES.darwin;
  // mkdtemp adds six characters to the prefix.
  const fits = (base) => Buffer.byteLength(join(base, `${LINK_PREFIX}XXXXXX`, "home", SOCKET)) <= limit;
  const base = [temp, "/tmp"].find(fits);
  if (!base) throw new Error(`The temp folder ${temp} is too long for the desktop's CLI socket. Set TMPDIR to a shorter folder.`);
  const link = mkdtempSync(join(base, LINK_PREFIX));
  const home = join(link, "home");
  symlinkSync(files, home, "dir");
  return { files, home, link };
}

/** Remove the link to the session's home. The files it points to stay. */
export function removeDebugHome(session) {
  if (session?.link) rmSync(session.link, { recursive: true, force: true });
}
