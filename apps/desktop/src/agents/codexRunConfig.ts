import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parse } from "smol-toml";

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The person's own Codex config: the system file, then the user file, which
// wins. Null when CODEX_HOME is relative, because Codex resolves it against
// the workspace, and dohc never reads a workspace's config.
export function codexConfigFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): string[] | null {
  const path = platform === "win32" ? win32 : posix;
  if (env.CODEX_HOME && !path.isAbsolute(env.CODEX_HOME)) return null;
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const system = platform === "win32"
    ? path.join(env.ProgramData || "C:\\ProgramData", "OpenAI", "Codex", "config.toml")
    : "/etc/codex/config.toml";
  return [system, path.join(codexHome, "config.toml")];
}

// Null when a file exists that dohc can't read or parse. Then dohc adds
// nothing it would have taken from the person's config.
function readConfigTables(files: readonly string[] | null, read: (path: string) => string): Table[] | null {
  if (!files) return null;
  const tables: Table[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = read(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    try {
      tables.push(parse(text));
    } catch {
      return null;
    }
  }
  return tables;
}

const WINDOWS_SANDBOX_FEATURES = ["elevated_windows_sandbox", "experimental_windows_sandbox", "enable_experimental_windows_sandbox", "prefer_mxc"];

// Whether the person picked a Windows sandbox anywhere, profiles included.
function choosesWindowsSandbox(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(choosesWindowsSandbox);
  if (!isTable(value)) return false;
  const { windows, features } = value;
  if (isTable(windows) && "sandbox" in windows) return true;
  if (isTable(features) && WINDOWS_SANDBOX_FEATURES.some((key) => key in features)) return true;
  return Object.values(value).some(choosesWindowsSandbox);
}

// Codex applies [sandbox_workspace_write] only without a named profile, so
// the run's profile carries these over itself.
function workspaceWrite(tables: readonly Table[], key: "network_access" | "exclude_tmpdir_env_var" | "exclude_slash_tmp"): boolean {
  let value = false;
  for (const table of tables) {
    const section = table.sandbox_workspace_write;
    const setting = isTable(section) ? section[key] : undefined;
    if (typeof setting === "boolean") value = setting;
  }
  return value;
}

// Every spelling Codex looks a folder's trust up under: its canonical path,
// then the path it was given. On Windows Codex lowercases ASCII letters only,
// and one of its lookups keeps the \\?\ prefix of the canonical path.
export function codexTrustKeys(rootPath: string, platform: NodeJS.Platform, realPath: (path: string) => string = realpathSync.native): string[] {
  const path = platform === "win32" ? win32 : posix;
  const given = path.resolve(rootPath);
  let real = given;
  try {
    real = realPath(given);
  } catch {}
  if (platform !== "win32") return [...new Set([real, given])];
  const extended = real.startsWith("\\\\") ? `\\\\?\\UNC\\${real.slice(2)}` : `\\\\?\\${real}`;
  return [...new Set([real, given, extended].map((key) => key.replace(/[A-Z]/gu, (letter) => letter.toLowerCase())))];
}

// Only a basic string holds an apostrophe. cmd.exe can't carry its double
// quotes, so dohc doesn't start an npm-installed Codex in such a folder.
function tomlKey(value: string): string {
  return /\p{Cc}|'/u.test(value) ? JSON.stringify(value) : `'${value}'`;
}

// The --config entries a dohc Codex run adds over the person's config, which
// it leaves unchanged.
// - A permissions profile keeps the workspace's .dohc folder read-only. Its
//   name is new for each run, because Codex merges a profile of the same name
//   from the person's config into it.
// - Mark the folder untrusted so Codex doesn't trust it on its own or load
//   its .codex config.
// - Codex runs Windows commands only in a sandbox the person chose. Without
//   a choice it gets the unelevated one, which needs no setup.
export function codexRunConfig(input: {
  rootPath: string;
  runId: string;
  platform: NodeJS.Platform;
  configFiles: readonly string[] | null;
  readConfig?: (path: string) => string;
  realPath?: (path: string) => string;
}): string[] {
  const tables = readConfigTables(input.configFiles, input.readConfig ?? ((path) => readFileSync(path, "utf8")));
  const filesystem = [
    "':workspace_roots'={'.dohc'='read'}",
    ...(tables && workspaceWrite(tables, "exclude_tmpdir_env_var") ? ["':tmpdir'='read'"] : []),
    ...(tables && workspaceWrite(tables, "exclude_slash_tmp") ? ["':slash_tmp'='read'"] : []),
  ];
  const network = tables && workspaceWrite(tables, "network_access") ? ",network={enabled=true}" : "";
  const profile = `dohc_run_${createHash("sha256").update(input.runId).digest("hex").slice(0, 16)}`;
  const projects = codexTrustKeys(input.rootPath, input.platform, input.realPath)
    .map((key) => `${tomlKey(key)}={trust_level='untrusted'}`);
  return [
    `permissions.${profile}={extends=':workspace',filesystem={${filesystem.join(",")}}${network}}`,
    `default_permissions='${profile}'`,
    `projects={${projects.join(",")}}`,
    ...(input.platform === "win32" && tables && !tables.some(choosesWindowsSandbox) ? ["windows.sandbox='unelevated'"] : []),
  ].flatMap((entry) => ["--config", entry]);
}
