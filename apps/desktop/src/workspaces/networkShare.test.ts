import { describe, expect, it, vi } from "vitest";
import { type NetworkShareProbe, onNetworkShare } from "./networkShare";

const HOME = "/Users/ada";

// The Mac mini's mount listing, plus shares, one of them inside Documents,
// and an autofs folder.
const MOUNTS = `/dev/disk3s3s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s1 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk4s1 on /Volumes/VS Code (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by ada)
//ada@nas.local/Team on /Volumes/Team (smbfs, nodev, nosuid, mounted by ada)
nas.local:/export/home/ada on /System/Volumes/Data/home/ada (nfs, nodev, nosuid, automounted)
//ada@nas.local/Team on /Users/ada/Documents/Team (smbfs, nodev, nosuid, mounted by ada)
`;

// A computer whose links and volumes the test names. Every other path
// resolves to itself.
function computer(options: {
  platform?: NodeJS.Platform;
  links?: Record<string, string>;
  types?: Record<string, number>;
} = {}): NetworkShareProbe {
  return {
    platform: options.platform ?? "darwin",
    realpath: async (path) => options.links?.[path] ?? path,
    mounts: async () => MOUNTS,
    fileSystemType: async (path) => options.types?.[path] ?? 0xef53,
  };
}

describe("onNetworkShare on a Mac", () => {
  it("finds a root on a volume the kernel does not mark local, wherever it is mounted", async () => {
    const probe = computer({ links: { "/tmp/team": "/Volumes/Team/Trip" } });
    for (const root of ["/Volumes/Team/Trip", "/System/Volumes/Data/home/ada/Trip", `${HOME}/Documents/Team/Trip`, "/tmp/team"]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(true);
    }
  });

  it("leaves a root on this computer's own volumes alone", async () => {
    const probe = computer();
    for (const root of [
      HOME,
      `${HOME}/Documents/Trip`,
      "/Volumes/VS Code/Trip",
      "/Volumes/Teamwork/Trip",
      "/System/Volumes/Data/home/bob/Trip",
    ]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(false);
    }
  });

  it("tells a folder from another whose name differs only in capitals, on a case-sensitive volume", async () => {
    // realpath answers with each folder's real capitals, as macOS does.
    const probe = computer();
    await expect(onNetworkShare("/volumes/team/Trip", probe)).resolves.toBe(false);
    await expect(onNetworkShare(`${HOME}/documents/Team/Trip`, probe)).resolves.toBe(false);
  });

  it("logs a failed mount listing and reads the root as on this computer", async () => {
    const probe = computer();
    const failure = new Error("mount timed out");
    probe.mounts = async () => {
      throw failure;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(onNetworkShare("/Volumes/Team/Trip", probe)).resolves.toBe(false);
      expect(logged).toHaveBeenCalledWith("[desktop] could not list volumes to check whether /Volumes/Team/Trip is on a network share:", failure);
    } finally {
      logged.mockRestore();
    }
  });

  it("fails when the root does not resolve", async () => {
    const probe = computer();
    probe.realpath = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(onNetworkShare(`${HOME}/Trip`, probe)).rejects.toThrow("ENOENT");
  });
});

describe("onNetworkShare on Windows", () => {
  it("finds a server's share, including one behind a mapped drive", async () => {
    const probe = computer({ platform: "win32", links: { "Z:\\Trip": "\\\\nas\\team\\Trip" } });
    await expect(onNetworkShare("\\\\nas\\team\\Trip", probe)).resolves.toBe(true);
    await expect(onNetworkShare("Z:\\Trip", probe)).resolves.toBe(true);
  });

  it("reads a root that doesn't resolve as given", async () => {
    const probe = computer({ platform: "win32" });
    probe.realpath = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await expect(onNetworkShare("\\\\nas\\team\\Trip", probe)).resolves.toBe(true);
    await expect(onNetworkShare("C:\\Users\\ada\\Trip", probe)).resolves.toBe(false);
  });

  it("leaves local drives and WSL's shares alone", async () => {
    const probe = computer({ platform: "win32" });
    for (const root of ["C:\\Users\\ada\\Trip", "\\\\wsl$\\Ubuntu\\home\\ada\\Trip", "\\\\wsl.localhost\\Ubuntu\\home\\ada\\Trip"]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(false);
    }
  });
});

describe("onNetworkShare on Linux", () => {
  it("finds NFS, SMB, CIFS, Ceph, AFS and 9p volumes, and only those", async () => {
    const types = { "/mnt/nfs": 0x6969, "/mnt/smb": 0x517b, "/mnt/cifs": 0xff534d42, "/mnt/smb2": 0xfe534d42,
      "/mnt/ceph": 0x00c36400, "/afs/example.org": 0x5346414f, "/mnt/9p": 0x01021997 };
    const probe = computer({ platform: "linux", types, links: { "/home/ada/nfs": "/mnt/nfs" } });
    for (const root of [...Object.keys(types), "/home/ada/nfs"]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(true);
    }
    await expect(onNetworkShare("/home/ada/Trip", probe)).resolves.toBe(false);
  });

  it("finds a share GNOME Files opened, and leaves its phones and cameras alone", async () => {
    const share = "/run/user/1000/gvfs/smb-share:server=nas,share=team/Trip";
    const probe = computer({ platform: "linux", links: { "/home/ada/Team": share } });
    for (const root of [
      share,
      "/home/ada/Team",
      "/run/user/1000/gvfs/sftp:host=nas.local,user=ada/home/ada/Trip",
      "/run/user/1000/gvfs/dav:host=cloud.example.org,ssl=true,prefix=%2Fremote.php/Trip",
      "/run/user/1000/gvfs/google-drive:host=example.org,user=ada/Trip",
    ]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(true);
    }
    for (const root of [
      "/run/user/1000/gvfs/mtp:host=Google_Pixel_8_3A051FDJH0042K/Internal shared storage/Trip",
      "/run/user/1000/gvfs/gphoto2:host=Canon_Inc._Canon_Digital_Camera/DCIM/Trip",
      "/run/user/1000/gvfs/afc:host=00008110-001A2D3E1E38801E/Trip",
      "/run/user/1000/doc/Trip",
    ]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(false);
    }
  });

  it("finds a share KDE opened through kio-fuse, directly or through a link", async () => {
    const share = "/run/user/1000/kio-fuse-AbC123/smb/nas/team/Trip";
    const probe = computer({ platform: "linux", links: { "/home/ada/Team": share } });
    for (const root of [
      share,
      "/home/ada/Team",
      "/run/user/1000/kio-fuse-AbC123/webdavs/ada@cloud.example.org/Trip",
      "/run/user/1000/kio-fuse-AbC123/gdrive/ada@example.org/My Drive/Trip",
    ]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(true);
    }
    for (const root of ["/run/user/1000/kio-fuse-AbC123/mtp/Pixel 8/Trip", "/run/user/1000/kio-fuse-AbC123/smb"]) {
      await expect(onNetworkShare(root, probe)).resolves.toBe(false);
    }
  });
});

it("finds no network share on another platform", async () => {
  await expect(onNetworkShare("/mnt/nfs", computer({ platform: "freebsd", types: { "/mnt/nfs": 0x6969 } }))).resolves.toBe(false);
});
