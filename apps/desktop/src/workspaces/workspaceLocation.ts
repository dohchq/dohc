import { execFile } from "node:child_process";
import { realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";

// Where a workspace is kept, when that changes what dohc can promise about it:
// - "icloud-drive": iCloud Drive syncs each file of the Collections database
//   on its own and keeps one whole copy when two Macs change it (#2371).
// - "network-share": the share's server, not dohc, decides who can read the
//   workspace's History (#2379).
// Only the root's path and its volume decide: no folder is listed and no
// file is read.
export type WorkspaceLocation = "icloud-drive" | "network-share";

/** Finder's records of iCloud Drive's Desktop & Documents Folders option. */
export type FinderICloudSetting = "FXICloudDriveDesktop" | "FXICloudDriveDocuments";

/** What the check reads from this computer. Tests replace it. */
export interface LocationProbe {
  platform: NodeJS.Platform;
  home: string;
  realpath: (path: string) => Promise<string>;
  finderSetting: (key: FinderICloudSetting) => Promise<boolean>;
  // macOS: the output of /sbin/mount.
  mounts: () => Promise<string>;
  // Linux: the volume's f_type.
  fileSystemType: (path: string) => Promise<number>;
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: 2_000, encoding: "utf8" }, (error, out) => (error ? reject(error) : resolve(out)));
  });

const systemProbe: LocationProbe = {
  platform: process.platform,
  home: homedir(),
  realpath: (path) => realpath(path),
  finderSetting: (key) => run("/usr/bin/defaults", ["read", "com.apple.finder", key]).then((out) => out.trim() === "1", () => false),
  mounts: () => run("/sbin/mount", []),
  fileSystemType: async (path) => (await statfs(path)).type,
};

// Linux f_type values of NFS, SMB, CIFS and SMB2 volumes.
const LINUX_NETWORK_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42]);

/** Where the workspace at rootPath is kept, or null for this computer's own disk. */
export async function workspaceLocation(
  rootPath: string,
  probe: LocationProbe = systemProbe,
): Promise<WorkspaceLocation | null> {
  switch (probe.platform) {
    case "darwin": {
      const [root, home] = await Promise.all([probe.realpath(rootPath), probe.realpath(probe.home)]);
      if (await inICloudDrive(root, home, probe)) return "icloud-drive";
      return macVolumeIsLocal(root, await probe.mounts()) ? null : "network-share";
    }
    case "win32": {
      // A mapped network drive resolves to the server's path too. WSL's
      // shares are this computer's.
      const server = /^\\\\([^\\]+)\\/u.exec(await probe.realpath(rootPath))?.[1];
      return server !== undefined && !/^(?:[?.]|wsl\$|wsl\.localhost)$/iu.test(server) ? "network-share" : null;
    }
    case "linux":
      return LINUX_NETWORK_TYPES.has(await probe.fileSystemType(rootPath)) ? "network-share" : null;
    default:
      return null;
  }
}

// APFS ignores case by default, and a path may name it either way.
function within(path: string, folder: string): boolean {
  const base = folder.toLowerCase().replace(/\/$/u, "");
  const lower = path.toLowerCase();
  return lower === base || lower.startsWith(`${base}/`);
}

// Under ~/Library/Mobile Documents, or under ~/Desktop or ~/Documents while
// Finder says iCloud Drive holds that folder.
async function inICloudDrive(root: string, home: string, probe: LocationProbe): Promise<boolean> {
  if (within(root, `${home}/Library/Mobile Documents`)) return true;
  if (within(root, `${home}/Desktop`)) return probe.finderSetting("FXICloudDriveDesktop");
  if (within(root, `${home}/Documents`)) return probe.finderSetting("FXICloudDriveDocuments");
  return false;
}

// mount lists each volume as "<device> on <folder> (<type>, <flags>)", and
// flags one the kernel keeps on this computer "local", as the engine reads
// it. The volume is the deepest folder holding the root. autofs only marks
// where another volume appears, so it never decides.
function macVolumeIsLocal(root: string, listing: string): boolean {
  let volume: { folder: string; local: boolean } | null = null;
  for (const line of listing.split("\n")) {
    const [, folder = "", flags = ""] = /^.* on (\/.*) \(([^()]*)\)$/u.exec(line) ?? [];
    const [type, ...rest] = flags.split(", ");
    if (!folder || type === "autofs" || !within(root, folder)) continue;
    if (volume === null || folder.length >= volume.folder.length) volume = { folder, local: rest.includes("local") };
  }
  return volume?.local ?? true;
}
