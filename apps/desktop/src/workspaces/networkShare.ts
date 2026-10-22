import { execFile } from "node:child_process";
import { realpath, statfs } from "node:fs/promises";

// On a network share, the share's server, not dohc, decides who can read the
// workspace's History (#2379). Only the root's path and its volume decide:
// no folder is listed and no file is read.

/** What the check reads from this computer. Tests replace it. */
export interface NetworkShareProbe {
  platform: NodeJS.Platform;
  realpath: (path: string) => Promise<string>;
  // macOS: the output of /sbin/mount.
  mounts: () => Promise<string>;
  // Linux: the volume's f_type.
  fileSystemType: (path: string) => Promise<number>;
}

const systemProbe: NetworkShareProbe = {
  platform: process.platform,
  realpath: (path) => realpath(path),
  mounts: () =>
    new Promise<string>((resolve, reject) => {
      execFile("/sbin/mount", [], { timeout: 2_000, encoding: "utf8" }, (error, out) => (error ? reject(error) : resolve(out)));
    }),
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
  "smb-share", "sftp", "ftp", "ftps", "ftpis", "dav", "dav+sd", "davs+sd", "nfs", "afp-volume", "google-drive", "onedrive",
]);
const KIO_NETWORK_PROTOCOLS = new Set(["smb", "sftp", "ftp", "webdav", "webdavs", "nfs", "fish", "gdrive", "onedrive"]);

function linuxFuseShare(root: string): boolean {
  const gvfs = /^\/run\/user\/\d+\/gvfs\/([^/:]+):/u.exec(root)?.[1];
  const kio = /^\/run\/user\/\d+\/kio-fuse-[^/]+\/([^/]+)\/[^/]/u.exec(root)?.[1];
  return (gvfs !== undefined && GVFS_NETWORK_BACKENDS.has(gvfs)) || (kio !== undefined && KIO_NETWORK_PROTOCOLS.has(kio));
}

/** True when the workspace at rootPath is on a network share. */
export async function onNetworkShare(rootPath: string, probe: NetworkShareProbe = systemProbe): Promise<boolean> {
  switch (probe.platform) {
    case "darwin": {
      // Without a mount listing, the root reads as on this computer.
      const [root, listing] = await Promise.all([
        probe.realpath(rootPath),
        probe.mounts().catch((error: unknown) => {
          console.error(`[desktop] could not list volumes to check whether ${rootPath} is on a network share:`, error);
          return "";
        }),
      ]);
      return !macVolumeIsLocal(root, listing);
    }
    case "win32": {
      // A mapped network drive resolves to the server's path too. A path
      // that doesn't resolve is read as given. WSL's shares are this
      // computer's.
      const root = await probe.realpath(rootPath).catch(() => rootPath);
      const server = /^\\\\([^\\]+)\\/u.exec(root)?.[1];
      return server !== undefined && !/^(?:[?.]|wsl\$|wsl\.localhost)$/iu.test(server);
    }
    case "linux": {
      const root = await probe.realpath(rootPath);
      return linuxFuseShare(root) || LINUX_NETWORK_TYPES.has(await probe.fileSystemType(root));
    }
    default:
      return false;
  }
}

// realpath names each folder with its real capitals, and mount lists them
// that way, so names compare exactly.
function within(path: string, folder: string): boolean {
  const base = folder.replace(/\/$/u, "");
  return path === base || path.startsWith(`${base}/`);
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
