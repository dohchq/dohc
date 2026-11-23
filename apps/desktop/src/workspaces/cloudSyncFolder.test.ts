import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  type CloudSyncFolderProbe,
  type GoogleDriveSqliteRoots,
  confirmCloudSyncFolder,
  createCloudSyncConfirmationTracker,
  detectCloudSyncFolder,
  matchesRegisteredWorkspaceRoot,
  readGoogleDriveRootsFromSqlite,
} from "./cloudSyncFolder";
import { createTestScratch } from "./testTemp";

function windowsComputer(
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    links?: Record<string, string>;
    files?: Record<string, string>;
    reg?: Record<string, string>;
    googleDriveSqlite?: Partial<GoogleDriveSqliteRoots>;
  } = {},
): CloudSyncFolderProbe {
  const env = {
    SystemDrive: "C:",
    USERNAME: "ada",
    USERPROFILE: "C:\\Users\\ada",
    LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
    ...options.env,
  };
  return {
    platform: options.platform ?? "win32",
    env,
    realpath: async (path) => {
      if (options.links && path in options.links) return options.links[path]!;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFile: async (path) => {
      const hit = Object.entries(options.files ?? {}).find(
        ([candidate]) => candidate.toLowerCase() === path.toLowerCase(),
      );
      if (hit) return hit[1];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    regQuery: async (args) => {
      const key = args[1] ?? "";
      const hit = Object.entries(options.reg ?? {}).find(
        ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
      );
      return hit ? hit[1] : null;
    },
    readGoogleDriveSqlite: async () => ({
      mirroredRoots: options.googleDriveSqlite?.mirroredRoots ?? [],
      mountPoints: options.googleDriveSqlite?.mountPoints ?? [],
    }),
  };
}

describe("detectCloudSyncFolder", () => {
  it("returns null on macOS and Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const probe = windowsComputer({
        platform,
        env: { OneDrive: "C:\\Users\\ada\\OneDrive" },
      });
      await expect(detectCloudSyncFolder("C:\\Users\\ada\\OneDrive\\Notes", probe)).resolves.toBe(
        null,
      );
    }
  });

  it("detects OneDrive from environment variables and respects folder boundaries", async () => {
    const probe = windowsComputer({
      env: {
        OneDrive: "C:\\Users\\ada\\OneDrive",
        OneDriveCommercial: "D:\\Work\\OneDrive - Contoso",
      },
    });
    await expect(
      detectCloudSyncFolder("C:/Users/ADA/onedrive/Documents/Trip", probe),
    ).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "C:\\Users\\ada\\OneDrive",
    });
    await expect(detectCloudSyncFolder("\\\\?\\C:\\Users\\ada\\OneDrive", probe)).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "C:\\Users\\ada\\OneDrive",
    });
    await expect(
      detectCloudSyncFolder("D:\\Work\\OneDrive - Contoso\\Projects", probe),
    ).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "D:\\Work\\OneDrive - Contoso",
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\OneDriveBackup\\Trip", probe),
    ).resolves.toBe(null);
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\dohc\\Personal", probe)).resolves.toBe(
      null,
    );
  });

  it("detects providers registered in Windows SyncRootManager, including unknown providers", async () => {
    const syncRootOutput = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\OneDrive!S-1-5-21-1!Personal
    DisplayNameResource    REG_SZ    OneDrive

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\OneDrive!S-1-5-21-1!Personal\\UserSyncRoots
    S-1-5-21-1    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\AppleInc.iCloud_abc!S-1-5-21-1!Default\\UserSyncRoots
    S-1-5-21-1    REG_SZ    C:\\Users\\ada\\iCloudDrive

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\CustomProvider!S-1-5-21-1!Main\\UserSyncRoots
    S-1-5-21-1    REG_SZ    C:\\Users\\ada\\CloudVault
`;
    const probe = windowsComputer({
      reg: {
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager":
          syncRootOutput,
      },
    });

    await expect(detectCloudSyncFolder("C:\\Users\\ada\\OneDrive\\Notes", probe)).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "C:\\Users\\ada\\OneDrive",
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\iCloudDrive\\Docs", probe),
    ).resolves.toEqual({
      service: "iCloud Drive",
      syncRoot: "C:\\Users\\ada\\iCloudDrive",
    });
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\CloudVault\\App", probe)).resolves.toEqual({
      service: null,
      syncRoot: "C:\\Users\\ada\\CloudVault",
    });
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\Notes", probe)).resolves.toBe(null);
  });

  it("detects OneDrive Accounts and SharePoint synced libraries from the registry", async () => {
    const accountsOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1
    UserFolder    REG_SZ    C:\\Users\\ada\\OneDrive - Acme

HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1\\ScopeIdToMountPointPathCache
    abc-123    REG_SZ    C:\\Users\\ada\\Acme\\Design - Documents
`;
    const probe = windowsComputer({
      reg: { "HKCU\\Software\\Microsoft\\OneDrive\\Accounts": accountsOutput },
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\Acme\\Design - Documents\\Specs", probe),
    ).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "C:\\Users\\ada\\Acme\\Design - Documents",
    });
  });

  it("detects Dropbox personal and business roots from info.json", async () => {
    const probe = windowsComputer({
      files: {
        "C:\\Users\\ada\\AppData\\Local\\Dropbox\\info.json": JSON.stringify({
          personal: { path: "D:\\Dropbox" },
          business: { path: "C:\\Users\\ada\\Acme Dropbox" },
        }),
      },
    });
    await expect(detectCloudSyncFolder("D:\\Dropbox\\Workspace", probe)).resolves.toEqual({
      service: "Dropbox",
      syncRoot: "D:\\Dropbox",
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\Acme Dropbox\\Team", probe),
    ).resolves.toEqual({
      service: "Dropbox",
      syncRoot: "C:\\Users\\ada\\Acme Dropbox",
    });
  });

  it("applies Google Drive precedence without flagging overridden defaults or SystemDrive", async () => {
    const driveFsPolicy = `
HKEY_LOCAL_MACHINE\\Software\\Policies\\Google\\DriveFS
    DefaultMountPoint    REG_SZ    R
`;
    const driveFsHklm = `
HKEY_LOCAL_MACHINE\\Software\\Google\\DriveFS
    DefaultMountPoint    REG_SZ    D
`;
    const policyProbe = windowsComputer({
      reg: {
        "HKLM\\Software\\Policies\\Google\\DriveFS": driveFsPolicy,
        "HKLM\\Software\\Google\\DriveFS": driveFsHklm,
        "HKCU\\Software\\Google\\DriveFS": `
HKEY_CURRENT_USER\\Software\\Google\\DriveFS
    PerAccountPreferences    REG_SZ    {"per_account_preferences":[{"key":"1","value":{"mount_point_path":"D:"}}]}
`,
      },
    });
    await expect(detectCloudSyncFolder("R:\\My Drive\\Trip", policyProbe)).resolves.toEqual({
      service: "Google Drive",
      syncRoot: "R:\\",
    });
    // Policy R: overrides both HKLM default and in-app PerAccountPreferences D:, so local D: stays unflagged.
    await expect(detectCloudSyncFolder("D:\\Local\\Workspace", policyProbe)).resolves.toBe(null);

    const sqliteMountProbe = windowsComputer({
      reg: {
        "HKLM\\Software\\Google\\DriveFS": driveFsHklm,
        "HKCU\\Software\\Google\\DriveFS": `
HKEY_CURRENT_USER\\Software\\Google\\DriveFS
    PerAccountPreferences    REG_SZ    {"per_account_preferences":[{"key":"1","value":{"mount_point_path":"H:","mirror_root_path":"C:\\\\Users\\\\ada\\\\My Drive"}},{"key":"2","value":{"mount_point_path":"C:"}}]}
`,
      },
      googleDriveSqlite: {
        mirroredRoots: ["E:\\MirroredDrive"],
        mountPoints: ["G:\\"],
      },
    });
    await expect(detectCloudSyncFolder("G:\\My Drive\\Trip", sqliteMountProbe)).resolves.toEqual({
      service: "Google Drive",
      syncRoot: "G:\\",
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\My Drive\\Notes", sqliteMountProbe),
    ).resolves.toEqual({
      service: "Google Drive",
      syncRoot: "C:\\Users\\ada\\My Drive",
    });
    await expect(
      detectCloudSyncFolder("E:\\MirroredDrive\\Notes", sqliteMountProbe),
    ).resolves.toEqual({
      service: "Google Drive",
      syncRoot: "E:\\MirroredDrive",
    });
    // Live SQLite mount G: supersedes both HKLM DefaultMountPoint=D: and stale PerAccountPreferences=H:.
    await expect(detectCloudSyncFolder("D:\\Local\\Workspace", sqliteMountProbe)).resolves.toBe(
      null,
    );
    await expect(detectCloudSyncFolder("H:\\Local\\Workspace", sqliteMountProbe)).resolves.toBe(
      null,
    );
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\dohc\\Personal", sqliteMountProbe),
    ).resolves.toBe(null);

    const perAccountProbe = windowsComputer({
      reg: {
        "HKLM\\Software\\Google\\DriveFS": driveFsHklm,
        "HKCU\\Software\\Google\\DriveFS": `
HKEY_CURRENT_USER\\Software\\Google\\DriveFS
    PerAccountPreferences    REG_SZ    {"per_account_preferences":[{"key":"1","value":{"mount_point_path":"H:"}},{"key":"2","value":{"mount_point_path":"C:"}}]}
`,
      },
    });
    await expect(detectCloudSyncFolder("H:\\Shared drives\\Ops", perAccountProbe)).resolves.toEqual(
      {
        service: "Google Drive",
        syncRoot: "H:\\",
      },
    );
    await expect(detectCloudSyncFolder("D:\\Local\\Workspace", perAccountProbe)).resolves.toBe(
      null,
    );
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\dohc\\Personal", perAccountProbe),
    ).resolves.toBe(null);

    const expandedRegSzProbe = windowsComputer({
      reg: {
        "HKCU\\Software\\Google\\DriveFS": `
HKEY_CURRENT_USER\\Software\\Google\\DriveFS
    DefaultMountPoint    REG_SZ    C:\\Users\\%USERNAME%\\Google Drive
`,
      },
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\Google Drive\\Project", expandedRegSzProbe),
    ).resolves.toEqual({
      service: "Google Drive",
      syncRoot: "C:\\Users\\ada\\Google Drive",
    });
  });

  it("reads mirrored roots and streamed mount points from a real Google DriveFS root_preference_sqlite.db", async () => {
    const dir = await createTestScratch("drivefs-sqlite-");
    const dbPath = join(dir, "root_preference_sqlite.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE roots (id INTEGER PRIMARY KEY, last_seen_absolute_path TEXT);
        INSERT INTO roots (last_seen_absolute_path) VALUES ('D:\\Mirrored\\My Drive'), (NULL), ('  ');
        CREATE TABLE media (id INTEGER PRIMARY KEY, fs_type INTEGER, last_mount_point TEXT);
        INSERT INTO media (fs_type, last_mount_point) VALUES (10, 'G:\\'), (1, 'E:\\'), (10, NULL);
      `);
    } finally {
      db.close();
    }
    await expect(readGoogleDriveRootsFromSqlite(dbPath)).resolves.toEqual({
      mirroredRoots: ["D:\\Mirrored\\My Drive"],
      mountPoints: ["G:\\"],
    });
    await expect(readGoogleDriveRootsFromSqlite(join(dir, "missing.db"))).resolves.toEqual({
      mirroredRoots: [],
      mountPoints: [],
    });
  });

  it("detects Box Drive roots from sync_root_folder.txt, HKCU preferences, and HKLM CustomBoxLocation", async () => {
    const boxPrefs = `
HKEY_CURRENT_USER\\Software\\Box\\Box\\preferences
    sync_directory_path    REG_SZ    C:\\Users\\ada\\BoxPrefs
`;
    const boxCustom = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Box\\Box
    CustomBoxLocation    REG_SZ    D:\\Box
`;
    const probe = windowsComputer({
      reg: {
        "HKCU\\Software\\Box\\Box\\preferences": boxPrefs,
        "HKLM\\SOFTWARE\\Box\\Box": boxCustom,
      },
      files: {
        "C:\\Users\\ada\\AppData\\Local\\Box\\Box\\data\\shell\\sync_root_folder.txt":
          "C:\\Users\\ada\\Box\r\n",
      },
    });
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\Box\\Client", probe)).resolves.toEqual({
      service: "Box",
      syncRoot: "C:\\Users\\ada\\Box",
    });
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\BoxPrefs\\Client", probe)).resolves.toEqual(
      {
        service: "Box",
        syncRoot: "C:\\Users\\ada\\BoxPrefs",
      },
    );
    // CustomBoxLocation=D:\Box always puts synced files in D:\Box\Box, never D:\Box\Other.
    await expect(detectCloudSyncFolder("D:\\Box\\Box\\Notes", probe)).resolves.toEqual({
      service: "Box",
      syncRoot: "D:\\Box\\Box",
    });
    await expect(detectCloudSyncFolder("D:\\Box\\Other\\Notes", probe)).resolves.toBe(null);
  });

  it("catches a symlinked folder or not-yet-created subfolder pointing into a synced root", async () => {
    const probe = windowsComputer({
      env: { OneDrive: "C:\\Users\\ada\\OneDrive" },
      links: {
        "C:\\Users\\ada\\WorkLink": "C:\\Users\\ada\\OneDrive\\Work",
      },
    });
    await expect(
      detectCloudSyncFolder("C:\\Users\\ada\\WorkLink\\NewWorkspace", probe),
    ).resolves.toEqual({
      service: "OneDrive",
      syncRoot: "C:\\Users\\ada\\OneDrive",
    });
  });

  it("tolerates failed registry queries and malformed Dropbox JSON", async () => {
    const probe = windowsComputer({
      files: { "C:\\Users\\ada\\AppData\\Local\\Dropbox\\info.json": "{bad json" },
    });
    probe.regQuery = async () => {
      throw new Error("reg failed");
    };
    await expect(detectCloudSyncFolder("C:\\Users\\ada\\dohc\\Personal", probe)).resolves.toBe(
      null,
    );
  });
});

describe("confirmCloudSyncFolder", () => {
  it("warns with Cancel as the default and only accepts Use this folder", async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    await expect(confirmCloudSyncFolder({ showMessageBox }, { service: "OneDrive" })).resolves.toBe(
      false,
    );
    expect(showMessageBox).toHaveBeenCalledWith({
      type: "warning",
      message: "Use a folder inside OneDrive?",
      detail:
        "OneDrive can corrupt your workspace data when syncing across computers. Choose a local folder outside OneDrive instead.",
      buttons: ["Use this folder", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });

    showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(confirmCloudSyncFolder({ showMessageBox }, { service: null })).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Use a cloud-synced folder?",
        defaultId: 1,
        cancelId: 1,
      }),
    );
  });
});

describe("matchesRegisteredWorkspaceRoot", () => {
  it("matches an already-registered root across casing and slashes, not its parent or sibling", async () => {
    const registered = ["C:/Users/ada/OneDrive/Notes"];
    await expect(
      matchesRegisteredWorkspaceRoot("C:\\Users\\ADA\\OneDrive\\notes", registered, async (p) => p),
    ).resolves.toBe(true);
    await expect(
      matchesRegisteredWorkspaceRoot("C:\\Users\\ada\\OneDrive", registered, async (p) => p),
    ).resolves.toBe(false);
    await expect(
      matchesRegisteredWorkspaceRoot(
        "C:\\Users\\ada\\OneDrive\\Notes2",
        registered,
        async (p) => p,
      ),
    ).resolves.toBe(false);
  });
});

describe("createCloudSyncConfirmationTracker", () => {
  it("persists confirmed roots across restarts and covers workspaces created inside them", async () => {
    const dir = await createTestScratch("cloud-sync-confirm-");
    const file = join(dir, "confirmed-cloud-sync-folders.json");
    const first = createCloudSyncConfirmationTracker({
      filePath: () => file,
      resolveReal: async (path) => path,
    });
    await expect(first.isConfirmed("C:\\Users\\ada\\OneDrive\\Docs\\Personal")).resolves.toBe(
      false,
    );
    await first.confirm("C:\\Users\\ada\\OneDrive\\Docs");
    await expect(first.isConfirmed("c:/users/ada/onedrive/docs")).resolves.toBe(true);
    await expect(first.isConfirmed("C:/Users/ADA/OneDrive/Docs/Personal")).resolves.toBe(true);
    await expect(first.isConfirmed("C:\\Users\\ada\\OneDrive\\Docs2\\Personal")).resolves.toBe(
      false,
    );

    const relaunched = createCloudSyncConfirmationTracker({
      filePath: () => file,
      resolveReal: async (path) => path,
    });
    await expect(relaunched.isConfirmed("C:/Users/ADA/OneDrive/Docs/Personal")).resolves.toBe(true);
  });

  it("shares the in-flight initial load across concurrent lookups and serializes concurrent writes", async () => {
    const loadGate = Promise.withResolvers<string>();
    const readFile = vi.fn(() => loadGate.promise);
    const writes: string[] = [];
    const firstWriteGate = Promise.withResolvers<void>();
    let writeCount = 0;
    const writeAtomic = vi.fn(async (_file: string, content: string) => {
      const current = ++writeCount;
      if (current === 1) await firstWriteGate.promise;
      writes.push(content);
    });

    const tracker = createCloudSyncConfirmationTracker({
      filePath: () => "C:\\state\\confirmed.json",
      resolveReal: async (path) => path,
      readFile,
      writeAtomic,
    });

    const lookupA = tracker.isConfirmed("C:\\Users\\ada\\OneDrive\\Saved");
    const lookupB = tracker.isConfirmed("C:\\Users\\ada\\OneDrive\\Saved");
    loadGate.resolve(JSON.stringify(["c:\\users\\ada\\onedrive\\saved"]));
    await expect(Promise.all([lookupA, lookupB])).resolves.toEqual([true, true]);
    expect(readFile).toHaveBeenCalledTimes(1);

    const confirmA = tracker.confirm("C:\\Users\\ada\\OneDrive\\A");
    const confirmB = tracker.confirm("C:\\Users\\ada\\OneDrive\\B");
    firstWriteGate.resolve();
    await Promise.all([confirmA, confirmB]);
    // The final serialized write must contain all confirmed roots, never dropping B.
    expect(JSON.parse(writes[writes.length - 1]!)).toEqual([
      "c:\\users\\ada\\onedrive\\a",
      "c:\\users\\ada\\onedrive\\b",
      "c:\\users\\ada\\onedrive\\saved",
    ]);
  });
});
