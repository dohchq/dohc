import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parse } from "smol-toml";

type Table = Record<string, unknown>;
type ConfigTable = { file: string; table: Table };

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface CodexConfigFiles {
  // The system requirements, which can choose a Windows sandbox.
  requirements: readonly string[];
  // The system config, the user config, then on Unix the managed config.
  // Each wins over the ones before it.
  config: readonly string[];
}

// The person's own Codex files. Null when CODEX_HOME is relative, because
// Codex resolves it against the workspace, and dohc never reads a
// workspace's config.
export function codexConfigFiles(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home = homedir()): CodexConfigFiles | null {
  const path = platform === "win32" ? win32 : posix;
  if (env.CODEX_HOME && !path.isAbsolute(env.CODEX_HOME)) return null;
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const system = platform === "win32" ? path.join(env.ProgramData || "C:\\ProgramData", "OpenAI", "Codex") : "/etc/codex";
  return {
    requirements: [path.join(system, "requirements.toml")],
    config: [
      path.join(system, "config.toml"), path.join(codexHome, "config.toml"),
      ...(platform === "win32" ? [] : [path.join(system, "managed_config.toml")]),
    ],
  };
}

// Null when a file exists that dohc can't read or parse. Then dohc adds
// nothing it would have taken from the person's config.
function readConfigTables(files: readonly string[], read: (path: string) => string): ConfigTable[] | null {
  const tables: ConfigTable[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = read(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    try {
      tables.push({ file, table: parse(text) });
    } catch {
      return null;
    }
  }
  return tables;
}

const WINDOWS_SANDBOX_FEATURES = ["elevated_windows_sandbox", "experimental_windows_sandbox", "enable_experimental_windows_sandbox", "prefer_mxc"];

// Whether the person or their organization picked a Windows sandbox
// anywhere, profiles included. Requirements can also list the sandboxes they
// allow, and spell [features] as [feature_requirements].
function choosesWindowsSandbox(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(choosesWindowsSandbox);
  if (!isTable(value)) return false;
  const { windows } = value;
  const features = value.features ?? value.feature_requirements;
  if (isTable(windows) && ("sandbox" in windows || "allowed_sandbox_implementations" in windows)) return true;
  if (isTable(features) && WINDOWS_SANDBOX_FEATURES.some((key) => key in features)) return true;
  return Object.values(value).some(choosesWindowsSandbox);
}

// The older names Codex still reads for features a read-only run turns off.
const READ_ONLY_FEATURE_ALIASES = ["connectors", "experimental_use_unified_exec_tool", "imagegenext", "collab", "memory_tool", "codex_hooks"];

// Whether the system requirements would override what a read-only run sets,
// which Codex does with a warning instead of refusing: they allow only listed
// permission profiles, and the run's is new each time; they leave out the
// never approval policy; they turn on a feature the run turns off; or on
// Windows they leave the unelevated sandbox out of the ones they allow, or
// require MXC. On Unix, a managed config that sets anything also counts,
// because it wins over every setting the run passes. A file dohc can't read
// or parse counts as yes.
export function codexRequirementsRefuseReadOnly(
  files: CodexConfigFiles | null,
  platform: NodeJS.Platform,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  const tables = files && readConfigTables(files.requirements, read);
  const managed = files && readConfigTables(files.config.filter((file) => posix.basename(file) === "managed_config.toml"), read);
  if (tables === null || managed === null || managed.some(({ table }) => Object.keys(table).length > 0)) return true;
  const disabled = new Set<string>([...READ_ONLY_DISABLED_FEATURES, ...REPLY_ONLY_DISABLED_FEATURES, ...READ_ONLY_FEATURE_ALIASES]);
  return tables.some(({ table }) => {
    if ("allowed_permission_profiles" in table) return true;
    const approvals = table.allowed_approval_policies;
    if (approvals !== undefined && !(Array.isArray(approvals) && approvals.includes("never"))) return true;
    if ([table.features, table.feature_requirements].some((features) =>
      isTable(features) && Object.entries(features).some(([key, on]) => on === true && disabled.has(key)))) return true;
    if (platform !== "win32" || !isTable(table.windows)) return false;
    const allowed = table.windows.allowed_sandbox_implementations;
    return table.windows.require_mxc === true || (allowed !== undefined && !(Array.isArray(allowed) && allowed.includes("unelevated")));
  });
}

// Codex applies [sandbox_workspace_write] only without a named profile, so
// the run's profile carries these over itself.
function workspaceWrite(tables: readonly ConfigTable[], key: "network_access" | "exclude_tmpdir_env_var" | "exclude_slash_tmp"): boolean {
  let value = false;
  for (const { table } of tables) {
    const section = table.sandbox_workspace_write;
    const setting = isTable(section) ? section[key] : undefined;
    if (typeof setting === "boolean") value = setting;
  }
  return value;
}

// Whether Codex may reach a model without the saved login that
// `codex login status` reports: through CODEX_API_KEY, or through a model
// provider other than OpenAI's. The system requirements' provider wins over
// the config's. A file dohc can't read counts as maybe. dohc doesn't read
// macOS managed preferences or a Windows policy that moves the requirements.
export function codexMayRunWithoutLogin(
  env: NodeJS.ProcessEnv,
  files: CodexConfigFiles | null,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  if (env.CODEX_API_KEY) return true;
  const tables = files && readConfigTables([...files.config, ...files.requirements], read);
  if (tables === null) return true;
  let provider = "openai";
  for (const { table } of tables) if (typeof table.model_provider === "string") provider = table.model_provider;
  return provider !== "openai";
}

const lowerAscii = (key: string) => key.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

// Every spelling Codex looks a folder's trust up under: its canonical path,
// then the path it was given. On Windows Codex lowercases ASCII letters only,
// and one of its lookups keeps the \\?\ prefix of the canonical path. Under
// WSL it lowercases the canonical path of a folder on a Windows drive.
export function codexTrustKeys(rootPath: string, platform: NodeJS.Platform, realPath: (path: string) => string = realpathSync.native): string[] {
  const path = platform === "win32" ? win32 : posix;
  const given = path.resolve(rootPath);
  let real = given;
  try {
    real = realPath(given);
  } catch {}
  if (platform !== "win32") {
    const wsl = platform === "linux" && /^\/mnt\/[a-z](\/|$)/iu.test(real) ? [lowerAscii(real)] : [];
    return [...new Set([...wsl, real, given])];
  }
  const extended = real.startsWith("\\\\") ? `\\\\?\\UNC\\${real.slice(2)}` : `\\\\?\\${real}`;
  return [...new Set([real, given, extended].map(lowerAscii))];
}

// Only a basic string holds an apostrophe or a control character, and JSON
// leaves DEL unescaped. cmd.exe can't carry the double quotes, so an
// npm-installed Codex doesn't start in such a workspace or get such a writable
// folder.
function needsBasicString(value: string): boolean {
  return /\p{Cc}|'/u.test(value);
}

function tomlKey(value: string): string {
  return needsBasicString(value) ? JSON.stringify(value).replace(/\u007f/gu, "\\u007f") : `'${value}'`;
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// The folders in the person's last valid writable_roots list that a run may
// write, by their real paths. Folders compare by file id, so a link, short
// name, letter case or network path counts as the folder it reaches. dohc
// drops a folder that
// - doesn't exist, is a drive-relative Windows path, or reads as a pattern;
// - is .dohc under another name, such as a share;
// - is inside the workspace, a temp folder or another folder dohc keeps, or
//   is reached through one of them or through the folder itself, because the
//   run can write there and swap it for a link that this run or the next one
//   would follow;
// - contains the workspace, because the run could move the workspace away
//   from .dohc's rule.
function writableRootEntries(tables: readonly ConfigTable[], input: {
  rootPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  realPath: (path: string) => string;
  readLink: (path: string) => string | null;
  fileId: (path: string) => string;
  listFolder: (path: string) => readonly string[];
  behindCmd: boolean;
}): string[] {
  let setting: { file: string; roots: string[] } | undefined;
  for (const { file, table } of tables) {
    const roots = isTable(table.sandbox_workspace_write) ? table.sandbox_workspace_write.writable_roots : undefined;
    if (Array.isArray(roots) && roots.every((root: unknown): root is string => typeof root === "string")) setting = { file, roots };
  }
  if (!setting) return [];
  const workspace = attempt(() => input.fileId(input.rootPath));
  if (workspace === null) return [];
  const path = input.platform === "win32" ? win32 : posix;
  // The ids of a folder and every folder above it.
  const above = (folder: string): string[] => {
    const ids: string[] = [];
    for (let at = folder; ; at = path.dirname(at)) {
      const id = attempt(() => input.fileId(at));
      if (id !== null) ids.push(id);
      if (path.dirname(at) === at) return ids;
    }
  };
  // The folder a path names, found one link at a time, and every folder looked
  // in on the way, where a link could be. Throws on a loop, and on a Windows
  // link that readlink can't read, such as a junction to a volume path,
  // because the folders it passes through would go unchecked.
  const follow = (at: string, hops = { left: 40 }): { path: string; through: string[] } => {
    const parent = path.dirname(at);
    if (parent === at) return { path: at, through: [] };
    const up = follow(parent, hops);
    const here = path.join(up.path, path.basename(at));
    const through = [...up.through, up.path];
    const target = input.readLink(here);
    if (target === null) {
      if (input.platform === "win32") {
        // A name that isn't a link is the folder of that name in the folder
        // above. Another letter case of it must not be an entry of its own, as
        // it can be in a folder that tells case apart.
        const real = input.realPath(here);
        const [name, stored] = [path.basename(here), path.basename(real)];
        const same = stored === name || (stored.toLowerCase() === name.toLowerCase() && !input.listFolder(up.path).includes(name));
        if (!same || input.fileId(path.dirname(real)) !== input.fileId(up.path)) throw new Error("Unreported link");
      }
      return { path: here, through };
    }
    if (--hops.left < 0) throw new Error("Too many links");
    const next = follow(path.resolve(up.path, target), hops);
    return { path: next.path, through: [...through, ...next.through] };
  };
  const writable = new Set([
    workspace, attempt(() => input.fileId(path.join(input.rootPath, ".dohc"))),
    ...[input.env.TMPDIR, input.env.TEMP, input.env.TMP, ...(input.platform === "win32" ? [] : ["/tmp", "/var/tmp"])]
      .map((folder) => folder && path.isAbsolute(folder) ? attempt(() => input.fileId(folder)) : null),
  ].filter((id): id is string => id !== null));
  const listed: { id: string; real: string; above: string[] }[] = [];
  for (const root of setting.roots) {
    const expanded = (input.platform === "win32" ? /^~(?:[\\/]|$)/u : /^~(?:\/|$)/u).test(root) ? path.join(input.home, root.slice(1)) : root;
    if (input.platform === "win32" && /^[a-z]:(?![\\/])/iu.test(expanded)) continue;
    const written = path.resolve(path.dirname(setting.file), expanded);
    const real = attempt(() => input.realPath(written));
    const id = real === null ? null : attempt(() => input.fileId(real));
    const reached = attempt(() => follow(written));
    // The id of the folder follow reaches, then of each folder it looks in.
    const ids = reached === null ? [] : [reached.path, ...reached.through].map((folder) => attempt(() => input.fileId(folder)));
    // Codex reads these characters as a pattern, and a colon past the drive as an error.
    if (real === null || id === null || /[*?[\]]/u.test(real) || (input.platform === "win32" && real.includes(":", 2))) continue;
    if (input.behindCmd && needsBasicString(real)) continue;
    // A `..` after a link can take Codex somewhere follow didn't go, and a
    // link inside the folder itself lets the run point it elsewhere.
    if (ids[0] !== id || ids.includes(id, 1)) continue;
    listed.push({ id, real, above: [...above(real), ...ids.filter((each): each is string => each !== null)] });
  }
  // Codex may name the workspace by either path.
  const aboveWorkspace = new Set([input.rootPath, attempt(() => input.realPath(input.rootPath)) ?? input.rootPath].flatMap(above));
  const safe = listed.filter((root) => !aboveWorkspace.has(root.id) && !root.above.some((each) => writable.has(each)));
  const safeIds = new Set(safe.map((root) => root.id));
  // One entry per folder, however many of its spellings are safe.
  const kept = new Map(safe
    .filter((root) => !root.above.some((each) => each !== root.id && safeIds.has(each)))
    .map((root): [string, string] => [root.id, root.real]));
  return [...kept.values()].map((real) => `${tomlKey(real)}='write'`);
}

// The --config entries a dohc Codex run adds over the person's config, which
// it leaves unchanged, and the features a read-only run turns off.
// - A read-only run turns off each MCP server the person's config names, web
//   search, and the command the person's config runs after each turn, so it
//   changes things only through dohc's tools.
// - A permissions profile keeps the workspace's .dohc folder read-only. Its
//   name is new for each run, because Codex merges a profile of the same name
//   from the person's config into it. A read-only run's profile reads only
//   the workspace, without its .dohc folder, and takes none of the person's
//   writable_roots.
// - Mark the folder untrusted so Codex doesn't trust it on its own or load
//   its .codex config.
// - Codex runs Windows commands only in a sandbox the person or their
//   organization chose. Without a choice it gets the unelevated one, which
//   needs no setup. A read-only run always gets the unelevated one, without
//   MXC.
// - A read-only run doesn't start where the system requirements or a Unix
//   managed config would override these (codexRequirementsRefuseReadOnly).
export function codexRunConfig(input: {
  rootPath: string;
  runId: string;
  platform: NodeJS.Platform;
  files: CodexConfigFiles | null;
  readOnly?: boolean;
  replyOnly?: boolean;
  readConfig?: (path: string) => string;
  realPath?: (path: string) => string;
  readLink?: (path: string) => string | null;
  fileId?: (path: string) => string;
  listFolder?: (path: string) => readonly string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  // The run starts behind cmd.exe, as an npm-installed Codex does on Windows.
  behindCmd?: boolean;
}): string[] {
  const read = input.readConfig ?? ((path: string) => readFileSync(path, "utf8"));
  const roots = {
    rootPath: input.rootPath,
    platform: input.platform,
    behindCmd: input.behindCmd ?? false,
    env: input.env ?? process.env,
    home: input.home ?? homedir(),
    realPath: input.realPath ?? realpathSync.native,
    readLink: input.readLink ?? ((path: string) => lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null),
    fileId: input.fileId ?? ((path: string) => {
      const { dev, ino } = statSync(path, { bigint: true });
      return `${dev}:${ino}`;
    }),
    listFolder: input.listFolder ?? ((path: string) => readdirSync(path)),
  };
  const tables = input.files && readConfigTables(input.files.config, read);
  const requirements = input.platform === "win32" && input.files && tables ? readConfigTables(input.files.requirements, read) : null;
  const filesystem = [
    "':workspace_roots'={'.dohc'='read'}",
    ...(tables && workspaceWrite(tables, "exclude_tmpdir_env_var") ? ["':tmpdir'='read'"] : []),
    ...(tables && workspaceWrite(tables, "exclude_slash_tmp") ? ["':slash_tmp'='read'"] : []),
    ...(tables && !input.readOnly ? writableRootEntries(tables, roots) : []),
  ];
  const network = tables && workspaceWrite(tables, "network_access") ? ",network={enabled=true}" : "";
  const profile = `dohc_run_${createHash("sha256").update(input.runId).digest("hex").slice(0, 16)}`;
  const projects = codexTrustKeys(input.rootPath, input.platform, input.realPath)
    .map((key) => `${tomlKey(key)}={trust_level='untrusted'}`);
  return [
    ...[
      ...(input.readOnly
        ? [
          `permissions.${profile}={filesystem={':workspace_roots'={'.'='read','.dohc'='deny'}}}`, `default_permissions='${profile}'`,
          ...ownerServers(tables ?? []).map((name) => `mcp_servers.${name}.enabled=false`), "web_search='disabled'", "notify=[]",
          // A model can start sub-agents whatever multi_agent says, unless
          // agents.enabled is false and multi_agent_v2 is off.
          "agents.enabled=false",
        ]
        : [`permissions.${profile}={extends=':workspace',filesystem={${filesystem.join(",")}}${network}}`, `default_permissions='${profile}'`]),
      `projects={${projects.join(",")}}`,
      ...(input.platform === "win32" && input.readOnly
        ? ["windows.sandbox='unelevated'", "windows.allow_mxc=false"]
        : tables && requirements && ![...tables, ...requirements].some(({ table }) => choosesWindowsSandbox(table)) ? ["windows.sandbox='unelevated'"] : []),
    ].flatMap((entry) => ["--config", entry]),
    ...(input.readOnly ? [...READ_ONLY_DISABLED_FEATURES, ...(input.replyOnly ? REPLY_ONLY_DISABLED_FEATURES : [])] : [])
      .flatMap((feature) => ["--disable", feature]),
  ];
}

// The features a read-only run turns off, because they act outside the
// sandbox, bring in the person's own tools, or aren't needed to read and
// reply. Codex refuses a name it doesn't know. The code-mode host stays on,
// because a model that uses only code mode makes every tool call through it.
export const READ_ONLY_DISABLED_FEATURES = [
  "plugins", "remote_plugin", "apps", "computer_use", "browser_use", "browser_use_external", "hooks",
  "multi_agent", "multi_agent_v2", "memories", "skill_search", "tool_suggest", "skill_mcp_dependency_install", "image_generation", "goals", "token_budget",
] as const;

// A reply-only run also turns off the shell and view_image.
export const REPLY_ONLY_DISABLED_FEATURES = ["shell_tool", "unified_exec", "view_image"] as const;

// The MCP servers the person's config names, other than dohc's. A --config
// key splits at each dot, so a name with other characters stays on, and the
// check before a read-only run refuses it (chatRunnerProcess.ts).
function ownerServers(tables: readonly ConfigTable[]): string[] {
  const names = tables.flatMap(({ table }) => isTable(table.mcp_servers) ? Object.keys(table.mcp_servers) : []);
  return [...new Set(names)].filter((name) => name !== "dohc" && /^[A-Za-z0-9_-]+$/u.test(name));
}
