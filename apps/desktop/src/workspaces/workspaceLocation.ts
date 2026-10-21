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

// Linux f_type values of NFS, SMB, CIFS, SMB2, Ceph, AFS and 9p volumes.
const LINUX_NETWORK_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x00c36400, 0x5346414f, 0x01021997]);

// GNOME Files and KDE mount what a person opens through FUSE, phones and
// cameras as well as shares, so only a network backend or protocol counts.
// GVfs names each mount <runtime dir>/gvfs/<backend>:<keys> (daemon/mount.c,
// common/gmountspec.c). kio-fuse puts a URL at
// <runtime dir>/kio-fuse-XXXXXX/<protocol>/<host>/<path>
// (src/kiofuseservice.cpp, src/kiofusevfs.cpp).
const GVFS_NETWORK_BACKENDS = new Set([
  "smb-share", "sftp", "ftp", "ftps", "ftpis", "dav", "davs", "dav+sd", "davs+sd", "nfs", "afp-volume", "google-drive", "onedrive",
]);
const KIO_NETWORK_PROTOCOLS = new Set(["smb", "sftp", "ftp", "webdav", "webdavs", "nfs", "fish"]);

function linuxFuseShare(root: string): boolean {
  const gvfs = /^\/run\/user\/\d+\/gvfs\/([^/:]+):/u.exec(root)?.[1];
  const kio = /^\/run\/user\/\d+\/kio-fuse-[^/]+\/([^/]+)\/[^/]/u.exec(root)?.[1];
  return (gvfs !== undefined && GVFS_NETWORK_BACKENDS.has(gvfs)) || (kio !== undefined && KIO_NETWORK_PROTOCOLS.has(kio));
}

/** Where the workspace at rootPath is kept, or null for this computer's own disk. */
export async function workspaceLocation(
  rootPath: string,
  probe: LocationProbe = systemProbe,
): Promise<WorkspaceLocation | null> {
  switch (probe.platform) {
    case "darwin": {
      // A share mounted inside a folder iCloud Drive holds is still a share.
      // Without a mount listing, iCloud Drive is still checked.
      const [root, home, listing] = await Promise.all([
        probe.realpath(rootPath),
        probe.realpath(probe.home),
        probe.mounts().catch(() => ""),
      ]);
      if (!macVolumeIsLocal(root, listing)) return "network-share";
      return (await inICloudDrive(root, home, probe)) ? "icloud-drive" : null;
    }
    case "win32": {
      // A mapped network drive resolves to the server's path too. A path
      // that doesn't resolve is read as given. WSL's shares are this
      // computer's.
      const root = await probe.realpath(rootPath).catch(() => rootPath);
      const server = /^\\\\([^\\]+)\\/u.exec(root)?.[1];
      return server !== undefined && !/^(?:[?.]|wsl\$|wsl\.localhost)$/iu.test(server) ? "network-share" : null;
    }
    case "linux": {
      const root = await probe.realpath(rootPath);
      if (linuxFuseShare(root)) return "network-share";
      return LINUX_NETWORK_TYPES.has(await probe.fileSystemType(root)) ? "network-share" : null;
    }
    default:
      return null;
  }
}

// realpath names each folder with its real capitals, and mount lists them
// that way, so names compare exactly.
function within(path: string, folder: string): boolean {
  const base = folder.replace(/\/$/u, "");
  return path === base || path.startsWith(`${base}/`);
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
