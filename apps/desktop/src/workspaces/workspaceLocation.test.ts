import { describe, expect, it } from "vitest";
import { type FinderICloudSetting, type LocationProbe, workspaceLocation } from "./workspaceLocation";

const HOME = "/Users/ada";

// The Mac mini's mount listing, plus a share and an autofs folder.
const MOUNTS = `/dev/disk3s3s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s1 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk4s1 on /Volumes/VS Code (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by ada)
//ada@nas.local/Team on /Volumes/Team (smbfs, nodev, nosuid, mounted by ada)
nas.local:/export/home/ada on /System/Volumes/Data/home/ada (nfs, nodev, nosuid, automounted)
`;

// A computer whose links, Finder settings and volumes the test names. Every
// other path resolves to itself.
function computer(options: {
  platform?: NodeJS.Platform;
  links?: Record<string, string>;
  finder?: FinderICloudSetting[];
  types?: Record<string, number>;
} = {}) {
  const asked: string[] = [];
  const probe: LocationProbe = {
    platform: options.platform ?? "darwin",
    home: HOME,
    realpath: async (path) => options.links?.[path] ?? path,
    finderSetting: async (key) => {
      asked.push(key);
      return options.finder?.includes(key) ?? false;
    },
    mounts: async () => MOUNTS,
    fileSystemType: async (path) => options.types?.[path] ?? 0xef53,
  };
  return { probe, asked };
}

describe("workspaceLocation on a Mac", () => {
  it("finds a root inside iCloud Drive, in any letter case and through a link", async () => {
    const { probe, asked } = computer({ links: { "/tmp/trip": `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Trip` } });
    for (const root of [
      `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Trip`,
      `${HOME}/library/mobile documents/com~apple~CloudDocs/Trip`,
      "/tmp/trip",
    ]) {
      await expect(workspaceLocation(root, probe)).resolves.toBe("icloud-drive");
    }
    expect(asked).toEqual([]);
  });

  it("finds a root in Desktop or Documents in iCloud Drive only while iCloud Drive holds that folder", async () => {
    const off = computer();
    await expect(workspaceLocation(`${HOME}/Desktop/Trip`, off.probe)).resolves.toBeNull();
    await expect(workspaceLocation(`${HOME}/Documents/Trip`, off.probe)).resolves.toBeNull();
    expect(off.asked).toEqual(["FXICloudDriveDesktop", "FXICloudDriveDocuments"]);

    const documents = computer({ finder: ["FXICloudDriveDocuments"] });
    await expect(workspaceLocation(`${HOME}/Documents`, documents.probe)).resolves.toBe("icloud-drive");
    await expect(workspaceLocation(`${HOME}/Desktop/Trip`, documents.probe)).resolves.toBeNull();
  });

  it("finds a root on a volume the kernel does not mark local", async () => {
    const { probe } = computer();
    await expect(workspaceLocation("/Volumes/Team/Trip", probe)).resolves.toBe("network-share");
    await expect(workspaceLocation("/System/Volumes/Data/home/ada/Trip", probe)).resolves.toBe("network-share");
  });

  it("leaves a root on this computer's own volumes alone, without asking Finder", async () => {
    const { probe, asked } = computer({ finder: ["FXICloudDriveDesktop", "FXICloudDriveDocuments"] });
    for (const root of [
      HOME,
      `${HOME}/Projects/Trip`,
      `${HOME}/Library/Mobile Documents Old/Trip`,
      `${HOME}/DesktopApps/Trip`,
      "/Volumes/VS Code/Trip",
      "/Volumes/Teamwork/Trip",
      "/System/Volumes/Data/home/bob/Trip",
    ]) {
      await expect(workspaceLocation(root, probe)).resolves.toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("fails when the root does not resolve", async () => {
    const { probe } = computer();
    probe.realpath = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(workspaceLocation(`${HOME}/Trip`, probe)).rejects.toThrow("ENOENT");
  });
});

describe("workspaceLocation on Windows", () => {
  it("finds a server's share, including one behind a mapped drive", async () => {
    const { probe } = computer({ platform: "win32", links: { "Z:\\Trip": "\\\\nas\\team\\Trip" } });
    await expect(workspaceLocation("\\\\nas\\team\\Trip", probe)).resolves.toBe("network-share");
    await expect(workspaceLocation("Z:\\Trip", probe)).resolves.toBe("network-share");
  });

  it("leaves local drives and WSL's shares alone", async () => {
    const { probe } = computer({ platform: "win32" });
    for (const root of ["C:\\Users\\ada\\Trip", "\\\\wsl$\\Ubuntu\\home\\ada\\Trip", "\\\\wsl.localhost\\Ubuntu\\home\\ada\\Trip"]) {
      await expect(workspaceLocation(root, probe)).resolves.toBeNull();
    }
  });
});

describe("workspaceLocation on Linux", () => {
  it("finds NFS, SMB and CIFS volumes, and only those", async () => {
    const { probe } = computer({
      platform: "linux",
      types: { "/mnt/nfs": 0x6969, "/mnt/smb": 0x517b, "/mnt/cifs": 0xff534d42, "/mnt/smb2": 0xfe534d42 },
    });
    for (const root of ["/mnt/nfs", "/mnt/smb", "/mnt/cifs", "/mnt/smb2"]) {
      await expect(workspaceLocation(root, probe)).resolves.toBe("network-share");
    }
    await expect(workspaceLocation("/home/ada/Trip", probe)).resolves.toBeNull();
  });

  it("reads no iCloud Drive location anywhere but a Mac", async () => {
    const { probe } = computer({ platform: "linux" });
    await expect(workspaceLocation(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Trip`, probe)).resolves.toBeNull();
  });
});
