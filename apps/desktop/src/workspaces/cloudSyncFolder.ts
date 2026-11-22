import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLOUD_SYNC_CANCELLED_ERROR } from "../ipc/errorWords";

export interface CloudSyncFolderMatch {
  service: string | null;
  syncRoot: string;
}

export interface GoogleDriveSqliteRoots {
  mirroredRoots: readonly string[];
  mountPoints: readonly string[];
}

export interface CloudSyncFolderProbe {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  regQuery: (args: readonly string[]) => Promise<string | null>;
  readGoogleDriveSqlite?: (dbPath: string) => Promise<GoogleDriveSqliteRoots>;
}

export function cloudSyncFolderCancelledError(): Error {
  const error = new Error("Cloud sync folder confirmation cancelled.");
  error.name = CLOUD_SYNC_CANCELLED_ERROR;
  return error;
}

const REG_TIMEOUT_MS = 2_000;
const REG_MAX_BUFFER = 4 * 1024 * 1024;

function runRegQuery(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      args,
      {
        timeout: REG_TIMEOUT_MS,
        maxBuffer: REG_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function readGoogleDriveRootsFromSqlite(
  dbPath: string,
): Promise<GoogleDriveSqliteRoots> {
  const empty: GoogleDriveSqliteRoots = { mirroredRoots: [], mountPoints: [] };
  try {
    await access(dbPath);
  } catch {
    return empty;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 500 });
    const mirroredRoots: string[] = [];
    const mountPoints: string[] = [];
    try {
      const rows = db
        .prepare(
          "SELECT last_seen_absolute_path FROM roots WHERE last_seen_absolute_path IS NOT NULL",
        )
        .all() as Array<{ last_seen_absolute_path?: unknown }>;
      for (const row of rows) {
        if (
          typeof row.last_seen_absolute_path === "string" &&
          row.last_seen_absolute_path.trim() !== ""
        ) {
          mirroredRoots.push(row.last_seen_absolute_path.trim());
        }
      }
    } catch {
      // Older or partial DriveFS databases may omit the roots table.
    }
    try {
      // DriveFS records every local and removable volume in `media`; `fs_type = 10`
      // selects Google Drive's virtual streamed volume.
      const rows = db
        .prepare(
          "SELECT last_mount_point FROM media WHERE fs_type = 10 AND last_mount_point IS NOT NULL",
        )
        .all() as Array<{ last_mount_point?: unknown }>;
      for (const row of rows) {
        if (typeof row.last_mount_point === "string" && row.last_mount_point.trim() !== "") {
          mountPoints.push(row.last_mount_point.trim());
        }
      }
    } catch {
      // Older or partial DriveFS databases may omit the media table.
    }
    return { mirroredRoots, mountPoints };
  } catch {
    return empty;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

const systemProbe: CloudSyncFolderProbe = {
  platform: process.platform,
  env: process.env,
  realpath: (path) => realpath(path),
  readFile: (path) => readFile(path, "utf8"),
  regQuery: runRegQuery,
  readGoogleDriveSqlite: readGoogleDriveRootsFromSqlite,
};

function normalizeWindowsPath(rawPath: string): string | null {
  let value = rawPath.trim();
  if (!value) return null;
  if (value.startsWith("\\\\?\\UNC\\")) {
    value = `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  } else if (value.startsWith("\\\\?\\")) {
    value = value.slice("\\\\?\\".length);
  }
  value = value.replaceAll("/", "\\");
  const isUnc = value.startsWith("\\\\");
  if (isUnc) {
    value = `\\\\${value.slice(2).replace(/\\+/gu, "\\")}`;
  } else {
    value = value.replace(/\\+/gu, "\\");
  }
  value = value.replace(/\\+$/u, "");
  if (!isUnc && !/^[a-zA-Z]:(?:\\|$)/u.test(value)) return null;
  if (isUnc && !/^\\\\[^\\]+\\[^\\]+/u.test(value)) return null;
  return value.toLowerCase();
}

function isDriveRoot(normalized: string): boolean {
  return /^[a-z]:$/u.test(normalized);
}

function systemDriveRoot(env: Readonly<Record<string, string | undefined>>): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "systemdrive" && value) {
      const normalized = normalizeWindowsPath(value);
      if (normalized && isDriveRoot(normalized)) return normalized;
    }
  }
  return "c:";
}

function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!value.includes("%")) return value;
  const byLower = new Map<string, string>();
  for (const [key, entry] of Object.entries(env)) {
    if (entry !== undefined) byLower.set(key.toLowerCase(), entry);
  }
  let unresolved = false;
  const expanded = value.replace(/%([^%]+)%/gu, (whole, name: string) => {
    const found = byLower.get(name.toLowerCase());
    if (found === undefined) {
      unresolved = true;
      return whole;
    }
    return found;
  });
  return unresolved ? null : expanded;
}

function withinWindowsFolder(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}\\`);
}

// Resolve an existing ancestor when the leaf folder has not been created yet,
// so a symlinked parent pointing into a cloud-synced folder still matches.
async function resolveExistingPath(
  targetPath: string,
  resolveReal: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await resolveReal(targetPath);
  } catch {
    let current = targetPath;
    for (;;) {
      const parent = win32.dirname(current);
      if (parent === current) return null;
      current = parent;
      try {
        const resolvedParent = await resolveReal(current);
        const suffix = win32.relative(current, targetPath);
        return suffix ? win32.join(resolvedParent, suffix) : resolvedParent;
      } catch {}
    }
  }
}

function serviceFromSyncRootId(syncRootId: string): string | null {
  const lower = syncRootId.toLowerCase();
  if (lower.startsWith("onedrive!") || lower.includes("skydrive")) return "OneDrive";
  if (lower.includes("icloud")) return "iCloud Drive";
  if (lower.startsWith("dropbox!") || lower.includes("dropbox")) return "Dropbox";
  if (lower.includes("googledrive") || lower.includes("google.drive") || lower.includes("drivefs"))
    return "Google Drive";
  if (lower.startsWith("box!") || lower.includes("boxdrive") || lower.includes("box.sync"))
    return "Box";
  if (lower.includes("nextcloud")) return "Nextcloud";
  if (lower.includes("protondrive") || lower.includes("proton.drive")) return "Proton Drive";
  if (lower.includes("owncloud")) return "ownCloud";
  if (lower.includes("mega")) return "MEGA";
  if (lower.includes("pcloud")) return "pCloud";
  return null;
}

interface CandidateRoot {
  service: string | null;
  rawPath: string;
  allowDriveRoot?: boolean;
}

const REG_VALUE_LINE = /^\s+(.+?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.+)$/u;

function parseRegValue(
  line: string,
  env: Readonly<Record<string, string | undefined>>,
): { name: string; value: string } | null {
  const match = REG_VALUE_LINE.exec(line);
  if (!match) return null;
  const name = match[1]!.trim();
  const raw = match[3]!.trim();
  // Expand %VAR% in REG_SZ as well as REG_EXPAND_SZ: providers such as Google
  // DriveFS store paths like `C:\Users\%USERNAME%\Google Drive` as REG_SZ.
  const value = expandEnvVars(raw, env);
  if (!value) return null;
  return { name, value };
}

function parseSyncRootManager(
  output: string | null,
  env: Readonly<Record<string, string | undefined>>,
): CandidateRoot[] {
  if (!output) return [];
  const roots: CandidateRoot[] = [];
  let activeService: string | null | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (/^HKEY_/iu.test(line)) {
      const match = /\\SyncRootManager\\([^\\]+)\\UserSyncRoots$/iu.exec(line);
      activeService = match ? serviceFromSyncRootId(match[1]!) : undefined;
      continue;
    }
    if (activeService === undefined) continue;
    const entry = parseRegValue(line, env);
    if (!entry) continue;
    roots.push({ service: activeService, rawPath: entry.value });
  }
  return roots;
}

function parseOneDriveAccounts(
  output: string | null,
  env: Readonly<Record<string, string | undefined>>,
): CandidateRoot[] {
  if (!output) return [];
  const roots: CandidateRoot[] = [];
  let inScopeCache = false;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (/^HKEY_/iu.test(line)) {
      inScopeCache = /\\ScopeIdToMountPointPathCache$/iu.test(line);
      continue;
    }
    const entry = parseRegValue(line, env);
    if (!entry) continue;
    if (inScopeCache || entry.name.toLowerCase() === "userfolder") {
      roots.push({ service: "OneDrive", rawPath: entry.value });
    }
  }
  return roots;
}

function driveFsPath(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const expanded = expandEnvVars(raw.trim(), env);
  if (!expanded) return null;
  if (/^[a-zA-Z]:?$/u.test(expanded)) {
    return `${expanded[0]}:\\`;
  }
  return expanded;
}

interface ParsedGoogleDriveFs {
  activeMounts: CandidateRoot[];
  mirrorFolders: CandidateRoot[];
  defaultMounts: CandidateRoot[];
}

function parseGoogleDriveFs(
  output: string | null,
  env: Readonly<Record<string, string | undefined>>,
): ParsedGoogleDriveFs {
  const result: ParsedGoogleDriveFs = { activeMounts: [], mirrorFolders: [], defaultMounts: [] };
  if (!output) return result;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line || /^HKEY_/iu.test(line)) continue;
    const entry = parseRegValue(line, env);
    if (!entry) continue;
    const lowerName = entry.name.toLowerCase();
    if (lowerName === "mountpointpath" || lowerName === "defaultmountpoint") {
      const path = driveFsPath(entry.value, env);
      if (path) {
        result.defaultMounts.push({
          service: "Google Drive",
          rawPath: path,
          allowDriveRoot: true,
        });
      }
      continue;
    }
    if (lowerName === "peraccountpreferences") {
      try {
        const parsed = JSON.parse(entry.value) as {
          per_account_preferences?: Array<{
            value?: {
              mount_point_path?: unknown;
              mirror_root_path?: unknown;
              local_sync_root_path?: unknown;
            };
          }>;
        };
        for (const account of parsed.per_account_preferences ?? []) {
          const prefs = account?.value;
          if (!prefs) continue;
          if (typeof prefs.mount_point_path === "string") {
            const path = driveFsPath(prefs.mount_point_path, env);
            if (path) {
              result.activeMounts.push({
                service: "Google Drive",
                rawPath: path,
                allowDriveRoot: true,
              });
            }
          }
          for (const folder of [prefs.mirror_root_path, prefs.local_sync_root_path]) {
            if (typeof folder === "string" && folder.trim()) {
              const expanded = expandEnvVars(folder.trim(), env);
              if (expanded)
                result.mirrorFolders.push({ service: "Google Drive", rawPath: expanded });
            }
          }
        }
      } catch {
        // Ignore malformed DriveFS preferences JSON.
      }
    }
  }
  return result;
}

function resolveGoogleDriveRoots(
  policyOutput: string | null,
  hklmOutput: string | null,
  hkcuOutput: string | null,
  sqlite: GoogleDriveSqliteRoots,
  env: Readonly<Record<string, string | undefined>>,
): CandidateRoot[] {
  const policy = parseGoogleDriveFs(policyOutput, env);
  const hklm = parseGoogleDriveFs(hklmOutput, env);
  const hkcu = parseGoogleDriveFs(hkcuOutput, env);

  const mirrorFolders: CandidateRoot[] = [
    ...policy.mirrorFolders,
    ...hklm.mirrorFolders,
    ...hkcu.mirrorFolders,
    ...sqlite.mirroredRoots.map((rawPath) => ({ service: "Google Drive", rawPath })),
  ];

  // Precedence for streamed mounts: observed DriveFS virtual mount from SQLite,
  // then managed policy override (HKLM\Software\Policies), then per-account
  // preferences, then HKLM and HKCU defaults.
  const sqliteMounts: CandidateRoot[] = sqlite.mountPoints
    .map((raw) => driveFsPath(raw, env))
    .filter((path): path is string => path !== null)
    .map((rawPath) => ({ service: "Google Drive", rawPath, allowDriveRoot: true }));
  if (sqliteMounts.length > 0) {
    return [...mirrorFolders, ...sqliteMounts];
  }

  const policyMounts = [...policy.activeMounts, ...policy.defaultMounts];
  if (policyMounts.length > 0) {
    return [...mirrorFolders, ...policyMounts];
  }

  const perAccountMounts = [...hklm.activeMounts, ...hkcu.activeMounts];
  if (perAccountMounts.length > 0) {
    return [...mirrorFolders, ...perAccountMounts];
  }

  const winningDefault = hklm.defaultMounts.length > 0 ? hklm.defaultMounts : hkcu.defaultMounts;
  return [...mirrorFolders, ...winningDefault];
}

function parseBoxPreferences(
  output: string | null,
  env: Readonly<Record<string, string | undefined>>,
): CandidateRoot[] {
  if (!output) return [];
  const roots: CandidateRoot[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line || /^HKEY_/iu.test(line)) continue;
    const entry = parseRegValue(line, env);
    if (!entry) continue;
    const lowerName = entry.name.toLowerCase();
    if (lowerName === "sync_directory_path") {
      roots.push({ service: "Box", rawPath: entry.value });
    } else if (lowerName === "customboxlocation") {
      // Box Drive always creates a `Box` subfolder inside CustomBoxLocation.
      const trimmed = entry.value.replace(/[\\/]+$/u, "");
      if (trimmed) roots.push({ service: "Box", rawPath: win32.join(trimmed, "Box") });
    }
  }
  return roots;
}

function envDir(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return null;
}

async function readBoxSyncRootFile(probe: CloudSyncFolderProbe): Promise<CandidateRoot[]> {
  const localAppData = envDir(probe.env, "LOCALAPPDATA");
  if (!localAppData) return [];
  try {
    const raw = await probe.readFile(
      win32.join(localAppData, "Box", "Box", "data", "shell", "sync_root_folder.txt"),
    );
    const trimmed = raw.trim();
    return trimmed ? [{ service: "Box", rawPath: trimmed }] : [];
  } catch {
    return [];
  }
}

async function readDropboxInfoRoots(probe: CloudSyncFolderProbe): Promise<CandidateRoot[]> {
  const dirs = new Set<string>();
  for (const name of ["LOCALAPPDATA", "APPDATA"]) {
    const dir = envDir(probe.env, name);
    if (dir) dirs.add(dir);
  }
  const roots: CandidateRoot[] = [];
  await Promise.all(
    [...dirs].map(async (baseDir) => {
      try {
        const raw = await probe.readFile(win32.join(baseDir, "Dropbox", "info.json"));
        const parsed = JSON.parse(raw) as Record<string, { path?: unknown } | undefined>;
        for (const account of [parsed.personal, parsed.business]) {
          if (typeof account?.path === "string" && account.path.trim()) {
            roots.push({ service: "Dropbox", rawPath: account.path.trim() });
          }
        }
      } catch {
        // Absent or unreadable Dropbox info.json means no classic Dropbox root there.
      }
    }),
  );
  return roots;
}

async function readGoogleDriveSqlite(probe: CloudSyncFolderProbe): Promise<GoogleDriveSqliteRoots> {
  const empty: GoogleDriveSqliteRoots = { mirroredRoots: [], mountPoints: [] };
  const reader = probe.readGoogleDriveSqlite;
  const localAppData = envDir(probe.env, "LOCALAPPDATA");
  if (!reader || !localAppData) return empty;
  const dbPath = win32.join(localAppData, "Google", "DriveFS", "root_preference_sqlite.db");
  try {
    return await reader(dbPath);
  } catch {
    return empty;
  }
}

function envOneDriveRoots(env: Readonly<Record<string, string | undefined>>): CandidateRoot[] {
  const roots: CandidateRoot[] = [];
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (
      (lower === "onedrive" || lower === "onedriveconsumer" || lower === "onedrivecommercial") &&
      value?.trim()
    ) {
      roots.push({ service: "OneDrive", rawPath: value.trim() });
    }
  }
  return roots;
}

async function discoverWindowsCloudSyncRoots(
  probe: CloudSyncFolderProbe,
): Promise<CandidateRoot[]> {
  const [
    hklmSyncRoots,
    hkcuSyncRoots,
    oneDriveAccounts,
    googleDriveHkcu,
    googleDrivePolicy,
    googleDriveHklm,
    boxPrefs,
    boxCustomLocation,
    boxSyncRootFile,
    dropboxRoots,
    googleDriveSqlite,
  ] = await Promise.all([
    probe
      .regQuery([
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager",
        "/s",
      ])
      .catch(() => null),
    probe
      .regQuery([
        "query",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager",
        "/s",
      ])
      .catch(() => null),
    probe
      .regQuery(["query", "HKCU\\Software\\Microsoft\\OneDrive\\Accounts", "/s"])
      .catch(() => null),
    probe.regQuery(["query", "HKCU\\Software\\Google\\DriveFS", "/s"]).catch(() => null),
    probe.regQuery(["query", "HKLM\\Software\\Policies\\Google\\DriveFS", "/s"]).catch(() => null),
    probe.regQuery(["query", "HKLM\\Software\\Google\\DriveFS", "/s"]).catch(() => null),
    probe
      .regQuery(["query", "HKCU\\Software\\Box\\Box\\preferences", "/v", "sync_directory_path"])
      .catch(() => null),
    probe
      .regQuery(["query", "HKLM\\SOFTWARE\\Box\\Box", "/v", "CustomBoxLocation"])
      .catch(() => null),
    readBoxSyncRootFile(probe),
    readDropboxInfoRoots(probe),
    readGoogleDriveSqlite(probe),
  ]);

  return [
    ...envOneDriveRoots(probe.env),
    ...parseSyncRootManager(hklmSyncRoots, probe.env),
    ...parseSyncRootManager(hkcuSyncRoots, probe.env),
    ...parseOneDriveAccounts(oneDriveAccounts, probe.env),
    ...resolveGoogleDriveRoots(
      googleDrivePolicy,
      googleDriveHklm,
      googleDriveHkcu,
      googleDriveSqlite,
      probe.env,
    ),
    ...parseBoxPreferences(boxPrefs, probe.env),
    ...parseBoxPreferences(boxCustomLocation, probe.env),
    ...boxSyncRootFile,
    ...dropboxRoots,
  ];
}

/**
 * Returns the cloud sync service syncing `rootPath` on Windows, or null when
 * the folder is outside known cloud-synced roots or on non-Windows platforms.
 * Never reads user files inside the folder.
 */
export async function detectCloudSyncFolder(
  rootPath: string,
  probe: CloudSyncFolderProbe = systemProbe,
): Promise<CloudSyncFolderMatch | null> {
  if (probe.platform !== "win32") return null;

  const rawTarget = normalizeWindowsPath(rootPath);
  const resolvedTargetPath = await resolveExistingPath(rootPath, probe.realpath);
  const resolvedTarget = resolvedTargetPath ? normalizeWindowsPath(resolvedTargetPath) : null;
  const targets = [rawTarget, resolvedTarget].filter((value): value is string => value !== null);
  if (targets.length === 0) return null;

  const candidates = await discoverWindowsCloudSyncRoots(probe);
  if (candidates.length === 0) return null;

  const sysDrive = systemDriveRoot(probe.env);
  let best: { service: string | null; syncRoot: string; normalizedLength: number } | null = null;

  const expandedCandidates = await Promise.all(
    candidates.map(async (candidate) => {
      const forms = new Set<string>();
      const rawNorm = normalizeWindowsPath(candidate.rawPath);
      if (rawNorm) forms.add(rawNorm);
      const real = await probe.realpath(candidate.rawPath).catch(() => null);
      if (real) {
        const realNorm = normalizeWindowsPath(real);
        if (realNorm) forms.add(realNorm);
      }
      return { candidate, forms: [...forms] };
    }),
  );

  for (const { candidate, forms } of expandedCandidates) {
    for (const root of forms) {
      if (isDriveRoot(root) && (!candidate.allowDriveRoot || root === sysDrive)) continue;
      if (!targets.some((target) => withinWindowsFolder(target, root))) continue;
      const betterLength = best === null || root.length > best.normalizedLength;
      const betterName =
        best !== null &&
        root.length === best.normalizedLength &&
        best.service === null &&
        candidate.service !== null;
      if (betterLength || betterName) {
        best = {
          service: candidate.service,
          syncRoot: candidate.rawPath,
          normalizedLength: root.length,
        };
      }
    }
  }

  return best ? { service: best.service, syncRoot: best.syncRoot } : null;
}

const USE_CLOUD_FOLDER = 0;

export function cloudSyncFolderConfirmationCopy(match: Pick<CloudSyncFolderMatch, "service">): {
  message: string;
  detail: string;
} {
  if (match.service) {
    return {
      message: `Use a folder inside ${match.service}?`,
      detail: `${match.service} can corrupt your workspace data when syncing across computers. Choose a local folder outside ${match.service} instead.`,
    };
  }
  return {
    message: "Use a cloud-synced folder?",
    detail:
      "Cloud sync can corrupt your workspace data across computers. Choose a local folder outside cloud sync instead.",
  };
}

/** Main's warning before a Windows user picks or creates a folder inside a cloud-synced root. */
export async function confirmCloudSyncFolder(
  deps: {
    showMessageBox(options: {
      type: "warning";
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
    }): Promise<{ response: number }>;
  },
  match: Pick<CloudSyncFolderMatch, "service">,
): Promise<boolean> {
  const copy = cloudSyncFolderConfirmationCopy(match);
  const { response } = await deps.showMessageBox({
    type: "warning",
    message: copy.message,
    detail: copy.detail,
    buttons: ["Use this folder", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === USE_CLOUD_FOLDER;
}

async function pathVariants(
  folderPath: string,
  resolveReal: (path: string) => Promise<string>,
): Promise<string[]> {
  const out = new Set<string>();
  const raw = normalizeWindowsPath(folderPath);
  if (raw) out.add(raw);
  const resolved = await resolveExistingPath(folderPath, resolveReal);
  if (resolved) {
    const norm = normalizeWindowsPath(resolved);
    if (norm) out.add(norm);
  }
  // Non-Windows test seams can pass POSIX paths.
  if (out.size === 0 && folderPath.trim()) {
    const posix = folderPath.trim().replace(/\/+$/u, "");
    if (posix) out.add(posix);
  }
  return [...out];
}

/**
 * True when `picked` names the same folder as any already-registered workspace
 * root, so Open folder does not re-prompt for a workspace that already exists.
 */
export async function matchesRegisteredWorkspaceRoot(
  picked: string,
  registeredRoots: readonly string[],
  resolveReal: (path: string) => Promise<string> = (path) => realpath(path),
): Promise<boolean> {
  if (registeredRoots.length === 0) return false;
  const pickedSet = new Set(await pathVariants(picked, resolveReal));
  if (pickedSet.size === 0) return false;
  for (const root of registeredRoots) {
    const variants = await pathVariants(root, resolveReal);
    if (variants.some((variant) => pickedSet.has(variant))) return true;
  }
  return false;
}

/**
 * Persists cloud-synced roots the user explicitly confirmed on this computer,
 * so opening or creating a workspace inside that root does not fire a
 * duplicate post-open toast even if the app quits before the check finishes.
 */
export function createCloudSyncConfirmationTracker(options?: {
  filePath?: () => string;
  resolveReal?: (path: string) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  writeAtomic?: (file: string, content: string) => Promise<void>;
}) {
  const resolveReal = options?.resolveReal ?? ((path: string) => realpath(path));
  const readText = options?.readFile ?? ((path: string) => readFile(path, "utf8"));
  const writeAtomic =
    options?.writeAtomic ??
    (async (file: string, content: string) => {
      const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(temp, content, "utf8");
        await rename(temp, file);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });

  const confirmed = new Set<string>();
  let loadedPath: string | null = null;
  let loadPromise: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  function ensureLoaded(): Promise<void> {
    const file = options?.filePath?.();
    if (!file) return Promise.resolve();
    if (loadedPath === file && loadPromise) return loadPromise;
    loadedPath = file;
    loadPromise = (async () => {
      try {
        const raw = await readText(file);
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string" && entry) confirmed.add(entry);
          }
        }
      } catch {
        // Missing or unreadable confirmation state starts empty.
      }
    })();
    return loadPromise;
  }

  function enqueuePersist(): Promise<void> {
    const file = options?.filePath?.();
    if (!file) return Promise.resolve();
    const run = async () => {
      try {
        await writeAtomic(file, `${JSON.stringify([...confirmed].sort())}\n`);
      } catch {
        // Ignore write failures; in-memory tracking still holds for this session.
      }
    };
    writeQueue = writeQueue.then(run, run);
    return writeQueue;
  }

  return {
    async confirm(folderPath: string): Promise<void> {
      await ensureLoaded();
      let added = false;
      for (const variant of await pathVariants(folderPath, resolveReal)) {
        if (!confirmed.has(variant)) {
          confirmed.add(variant);
          added = true;
        }
      }
      if (added) await enqueuePersist();
    },
    async isConfirmed(folderPath: string): Promise<boolean> {
      await ensureLoaded();
      if (confirmed.size === 0) return false;
      const targets = await pathVariants(folderPath, resolveReal);
      for (const target of targets) {
        for (const root of confirmed) {
          if (withinWindowsFolder(target, root) || target === root || target.startsWith(`${root}/`))
            return true;
        }
      }
      return false;
    },
  };
}
