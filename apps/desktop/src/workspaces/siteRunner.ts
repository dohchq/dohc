import { spawn, type ChildProcess } from "node:child_process";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { killProcessTreePosix, processDescendantsPosix } from "../process/posixSpawn";
import {
  killChildTreeWin32,
  killProcessTreeWin32,
  processDescendantsWin32,
  resolveSpawnCommand,
} from "../process/windowsSpawn";
import { isLoopbackHostname } from "../security/loopback";
import {
  assertContainedFilePath,
  isInside,
  startStaticDirectoryPreview,
} from "../security/staticDirectoryPreview";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import type { SiteAuthority } from "./sitePackage";

export interface SiteLogEntry {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: number;
}

export interface SiteProcessHandle {
  url: string;
  command: string;
  args: string[];
  cwd: string;
  logs(): SiteLogEntry[];
  onExit(listener: () => void): void;
  stop(): Promise<void>;
}

export interface StaticSitePreview {
  url: string;
  root: string;
  stop(): Promise<void>;
}

export interface BuildSiteResult {
  ok: boolean;
  command: string;
  args: string[];
  outputPath: string | null;
  logs: SiteLogEntry[];
  exitCode: number | null;
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_TEXT_CHARS = 10_000;
const LOG_TRUNCATION_MARKER = "...[truncated]";
const BUILD_TIMEOUT_MS = 120000;
export const BUILD_HARD_KILL_GRACE_MS = 5000;
// How often a running dev server's descendant tree is polled (POSIX only)
// so stopChild can still reach a backgrounded descendant after its wrapper
// has already exited. Frequent enough that a typical preview session (left
// open for minutes) gets several captures; infrequent enough to keep the
// idle cost of an open preview negligible.
const DESCENDANT_CAPTURE_INTERVAL_MS = 5000;
// The will-quit teardown's own budget must cover this site-preview stop
// path's worst case (SIGTERM, then this grace, then the SIGKILL
// round-trip) or an unref'd preview process can survive with no kill
// signal ever sent (round-15 finding 7). Computed HERE, not duplicated as
// an independent literal in main.ts — a hard-coded, independently-drifting
// duplicate is exactly how the two fell out of sync before. Never shorter
// than the ORIGINAL 3 s budget the other, unrelated teardown tasks in
// main.ts's will-quit handler were sized against.
export const WILL_QUIT_BUDGET_MS = Math.max(3000, BUILD_HARD_KILL_GRACE_MS + 1000);
const DEV_URL_RE =
  /(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![A-Za-z0-9.-])(?::\d+)?(?:\/[^\s]*)?)(?=$|[\s.)"'`,\]>])/i;
const DEV_URL_TRAILING_PUNCTUATION_RE = /[.,)"'`,\]>]+$/;
// Dev tools colorize their "Local: http://..." line when FORCE_COLOR reaches
// them (Playwright workers set it; user shells can too). Vite bolds the PORT
// — "http://127.0.0.1:\x1b[1m5173\x1b[22m/" — which used to split the URL at
// the escape and silently drop the port, loading a dead preview. Strip ANSI
// SGR sequences before matching.
// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\u001B\[[0-9;]*m/g;
const HOST_BIND_FLAGS = new Set(["--host", "--hostname", "-H"]);
const MAX_SHELL_NESTING_DEPTH = 3;
const DEV_URL_CARRY_CHARS = 2 * 1024;

async function resolveContainedDir(rootPath: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0") || relativePath.includes("\\")) {
    throw new Error(`Invalid site path: ${relativePath}`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`Site path must be relative: ${relativePath}`);
  }
  const parts = relativePath === "." ? [] : relativePath.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Site path contains traversal: ${relativePath}`);
  }
  const absolute = join(rootPath, ...parts);
  // A site root is a directory dohc serves, spawns a dev server in, and builds
  // from. `app -> .dohc` spells an ordinary folder and makes all three run on
  // the workspace's control plane, so the reserved rule decides on where the
  // root really is. This is also the only guard the spelled path gets: a site
  // root named `.dohc` outright is refused by the same test.
  //
  // The served root, the dev server's cwd, and the build's cwd are all the
  // path this judged. Resolving a second time would run them somewhere the
  // reserved rule never saw.
  const { resolvedAbsolute: realSite } = await assertResolvedWorkspacePath({
    rootPath,
    absolutePath: absolute,
    spelled: relativePath,
    label: "Site path",
    access: "read",
  });
  const info = await stat(realSite);
  if (!info.isDirectory()) throw new Error(`Site path is not a directory: ${relativePath}`);
  return realSite;
}

// Signal 0 sends nothing but still validates the pid — ESRCH means it no
// longer names any running process. Used to prune a captured descendant
// pid the instant it's confirmed dead, so it can't linger in a long-lived
// tracking set until the OS reuses that pid for an unrelated process.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// The periodic descendant capture below runs on every platform: a wrapper
// that backgrounds its real server or build helper and exits leaves an
// orphan behind on Windows exactly as it does on POSIX, and taskkill /T
// needs a live root pid to walk — a snapshot taken while the wrapper was
// still running is the only way to reach it once that wrapper is gone.
function processDescendants(pid: number): Promise<number[]> {
  return process.platform === "win32" ? processDescendantsWin32(pid) : processDescendantsPosix(pid);
}

function pushLog(logs: SiteLogEntry[], stream: SiteLogEntry["stream"], text: string): void {
  const at = Date.now();
  for (const chunk of text.split(/\r?\n/)) {
    if (chunk.length === 0) continue;
    const stored = chunk.length > MAX_LOG_TEXT_CHARS
      ? `${chunk.slice(0, MAX_LOG_TEXT_CHARS - LOG_TRUNCATION_MARKER.length)}${LOG_TRUNCATION_MARKER}`
      : chunk;
    logs.push({ stream, text: stored, at });
  }
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
}

/**
 * Whether `candidate` (a workspace-relative path) falls within `authority`'s
 * bounds. A workspace-authority site excludes shared-with-me/ entirely — its
 * own files can never legitimately reference into someone else's share. A
 * share-authority site is confined to its own mount root. Both the preview
 * server boundary below and the share-manifest scanner (sitePackage.ts)
 * enforce this same rule from this one place.
 */
export function isPathAllowedForAuthority(authority: SiteAuthority, candidate: string): boolean {
  if (authority.kind === "workspace") return !isSharedWithMePath(candidate);
  return (
    candidate === authority.mountRoot || candidate.startsWith(`${authority.mountRoot}/`)
  );
}

export async function startStaticSitePreview(
  workspaceRoot: string,
  siteRoot: string,
  options: { authority: SiteAuthority; entry?: string },
): Promise<StaticSitePreview> {
  const root = await resolveContainedDir(workspaceRoot, siteRoot);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const resolvedRelative = relative(realWorkspaceRoot, root).replaceAll("\\", "/");
  const spelledRelative = siteRoot === "." ? "" : siteRoot;
  const isAllowedByAuthority = (candidate: string): boolean =>
    isPathAllowedForAuthority(options.authority, candidate);
  if (!isAllowedByAuthority(spelledRelative) || !isAllowedByAuthority(resolvedRelative)) {
    const constraint = options.authority.kind === "workspace"
      ? "inside shared-with-me"
      : `outside its own shared mount ${options.authority.mountRoot}`;
    throw new Error(
      `This site's served root is ${constraint}. dohc cannot preview it: ${siteRoot}`,
    );
  }
  const containmentRoot = options.authority.kind === "share"
    ? join(workspaceRoot, ...options.authority.mountRoot.split("/"))
    : workspaceRoot;
  return startStaticDirectoryPreview(root, {
    containmentRoot,
    entry: options.entry ?? "index.html",
    entryLabel: "site entry",
    forbidSharedWithMePaths: true,
  });
}

export function packageManagerCommand(manager: PackageManager, script: string): {
  command: string;
  args: string[];
} {
  if (manager === "npm") return { command: "npm", args: ["run", script] };
  if (manager === "yarn") return { command: "yarn", args: [script] };
  if (manager === "bun") return { command: "bun", args: ["run", script] };
  return { command: "pnpm", args: [script] };
}

export function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  // Backslash is a POSIX shell escape, but on Windows it is the path
  // separator (cmd.exe has no backslash escaping), so a configured command
  // like `node "C:\ws\build.mjs"` must keep its backslashes literal there.
  const backslashEscapes = process.platform !== "win32";

  for (const char of commandLine.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (backslashEscapes && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    // Subshell grouping (`(HOST=0.0.0.0 vite)`), brace grouping
    // (`{ HOST=0.0.0.0 vite; }`), and command substitution (`$(...)`/
    // `` `...` ``) are shell CONSTRUCTS this tokenizer has no way to
    // decompose — `(` glues onto whatever token follows it, so
    // "(HOST=0.0.0.0" never matches the leading-assignment scan's
    // identifier-starting pattern, and the real command hidden inside
    // never gets validated at all. splitShellStatements only recognizes
    // statement SEPARATORS, not constructs that wrap a whole statement —
    // there is no separator here for it to split on. Refuse outright, the
    // same stance this file already takes on a shape it cannot safely
    // parse (ENV_OPTIONS_UNVERIFIABLE, MAX_SHELL_NESTING_DEPTH).
    if (char === "(" || char === ")" || char === "{" || char === "}" || char === "`") {
      throw new Error(
        `Site dev server command contains an unquoted "${char}", a shell grouping or command-substitution ` +
        `construct dohc cannot statically decompose to verify its loopback-only host binding: ${commandLine}`,
      );
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (escaped) token += "\\";
  if (quote) throw new Error("Command contains an unterminated quote.");
  if (token) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) throw new Error("Command cannot be empty.");
  return { command, args };
}

// splitCommandLine's contract is "the ONE command the real shell will run"
// — it has no concept of a shell's own STATEMENT separators, so a raw body
// with an unquoted `;`, `&&`, `||`, `&`, `|`, or newline tokenizes as if the
// whole thing were a single command. `export HOST=0.0.0.0; vite` would
// glue "HOST=0.0.0.0;" onto the args of a command named "export" — the
// loopback check below never reaches "vite", the command a real shell
// actually runs second, so a HOST rebind hidden behind an earlier,
// unrelated statement (`true && HOST=0.0.0.0 vite`) would go unvalidated.
// A genuinely benign compound body (backgrounding a helper with `&`,
// chaining with `;` — dohc's own test fixtures do exactly this to prove
// descendant teardown) must keep working, so refusing every compound body
// outright is too coarse; splitting it into the statements a real shell
// would run and validating each ONE independently checks exactly what
// actually executes, without reimplementing full shell grammar (quoting
// and escaping still use splitCommandLine's own rules, applied per split
// segment) or over-refusing ordinary usage.
export function splitShellStatements(commandLine: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  const backslashEscapes = process.platform !== "win32";
  const chars = [...commandLine];

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (backslashEscapes && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      // "&&"/"||" are one two-character operator, not two separate ones —
      // consume the repeated character too so it isn't re-scanned as the
      // start of its own (empty) statement.
      if (chars[index + 1] === char) index += 1;
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function explicitHostBinds(args: string[]): string[] {
  const hosts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inlineHost = /^(?:--host|--hostname|-H)=(.*)$/i.exec(arg)?.[1];
    if (inlineHost !== undefined) {
      hosts.push(inlineHost);
      continue;
    }
    if (HOST_BIND_FLAGS.has(arg)) {
      const next = args[index + 1];
      hosts.push(next && !next.startsWith("-") ? next : "");
    }
  }
  return hosts;
}

// `splitCommandLine` has no concept of shell env-var assignments — a
// leading `HOST=0.0.0.0 vite` tokenizes as command "HOST=0.0.0.0" with
// args ["vite"], which the flag-based check above never sees. npm's own
// script shell DOES honor a leading assignment, and a server that reads
// process.env.HOST/HOSTNAME (the conventional names many frameworks and
// custom servers use) binds every interface while still printing a
// loopback URL that satisfies startup detection. A shell allows SEVERAL
// leading assignments before the real command (`NODE_ENV=production
// HOST=0.0.0.0 vite`) — HOST/HOSTNAME need not be first among them — so
// this walks the whole leading run of ANY `VAR=value` token, collecting
// only the host-named ones, and stops at the first token that isn't an
// assignment at all (the real command).
const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// GNU env's documented form is `env [OPTION]... [NAME=VALUE]... [COMMAND
// [ARG]...]` — its OPTIONs can precede the assignments this scanner is
// looking for (`env -i HOST=0.0.0.0 vite`, `env -u FOO HOST=0.0.0.0 vite`).
// Each recognized option is skipped, along with the value token it takes,
// so the scan can still reach a HOST/HOSTNAME assignment that follows it.
const ENV_OPTIONS_WITHOUT_VALUE = new Set(["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);
// -S/--split-string re-parses its OWN payload into further OPTIONs,
// NAME=VALUE assignments, and the command — using env(1)'s own splitting
// rules, which are NOT the same as shell quoting (its backslash escapes and
// quote handling differ). Treating it as an opaque value-carrying option
// (the way -u/-C are) would skip a HOST assignment hidden inside it
// entirely; reimplementing env's exact splitting risks a parity mismatch
// that hides one just as effectively. Refuse it instead, the same way an
// unrecognized option is refused below.
const ENV_OPTIONS_UNVERIFIABLE = new Set(["-S", "--split-string"]);

function explicitHostEnvironmentAssignments(tokens: string[], isEnvWrapper: boolean): string[] {
  const hosts: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const assignment = ENV_ASSIGNMENT_PATTERN.exec(token);
    if (assignment) {
      const [, name, value] = assignment;
      if (name && /^host(name)?$/i.test(name)) hosts.push(value ?? "");
      index += 1;
      continue;
    }
    // "export HOST=0.0.0.0" (its own split shell statement — see
    // splitShellStatements) persists an assignment into the CURRENT
    // shell's environment, the same way a bare prefix assignment sets one
    // for the NEXT command — either way, a HOST/HOSTNAME value it sets
    // reaches this statement's own dev server command, so the scan must
    // see past the keyword to the assignment itself, the same way it
    // already sees past `env`'s own OPTIONs below.
    if (!isEnvWrapper && token === "export") {
      index += 1;
      continue;
    }
    // Outside an `env` wrapper the leading run is only ever assignments
    // (`HOST=0.0.0.0 vite`) — the first non-assignment token is the real
    // command, and there are no env OPTIONs to classify here.
    if (!isEnvWrapper) break;
    // env(1): a bare "-" has the same effect as -i (start with an empty
    // environment) and takes no value.
    if (token === "-") {
      index += 1;
      continue;
    }
    // "--" is the standard end-of-options marker: it consumes no value and
    // does not itself reset the environment (unlike "-"), it just says no
    // further env OPTIONs follow — the standard `NAME=VALUE`/command scan
    // resumes right after it either way, so it's handled the same as "-".
    if (token === "--") {
      index += 1;
      continue;
    }
    const longOptionName = token.startsWith("--") && token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (ENV_OPTIONS_WITHOUT_VALUE.has(longOptionName)) {
      index += 1;
      continue;
    }
    if (ENV_OPTIONS_WITH_VALUE.has(longOptionName)) {
      // "--unset=NAME" carries its value in the same token; "-u NAME" and
      // "--unset NAME" need the next token consumed too.
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (ENV_OPTIONS_UNVERIFIABLE.has(longOptionName)) {
      throw new Error(
        `Site dev server command uses "env ${longOptionName}", whose payload dohc cannot statically re-split, so its loopback-only host binding cannot be verified: ${token}`,
      );
    }
    // A token that isn't "-"-prefixed is the wrapped command itself — the
    // leading run of options and assignments is over.
    if (!token.startsWith("-")) break;
    // Anything else "-"-prefixed is an env option this scanner does not
    // recognize. We cannot prove what environment — and therefore what
    // host binding — the wrapped command receives, so refuse rather than
    // silently skip past it.
    throw new Error(
      `Site dev server command uses an unrecognized "env" option, so its loopback-only host binding cannot be verified: ${token}`,
    );
  }
  return hosts;
}

function assertDirectHostBinds(command: string, args: string[]): void {
  const commandName = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  const hosts = [
    ...explicitHostBinds(args),
    ...explicitHostEnvironmentAssignments([command, ...args], false),
    // env itself sets each assignment before running the wrapped command,
    // so the SAME assignments matter here too, just one token later since
    // "env" itself isn't one — and env's own OPTIONs may precede them.
    ...(commandName === "env" ? explicitHostEnvironmentAssignments(args, true) : []),
  ];
  for (const host of hosts) {
    if (host !== "" && isLoopbackHostname(host)) continue;
    const displayHost = host === "" ? "all interfaces" : host;
    throw new Error(
      `Site dev server command must bind to a loopback host, not ${displayHost}: ${[
        command,
        ...args,
      ].join(" ")}`,
    );
  }
}

function nestedShellCommand(command: string, args: string[]): string | null {
  const name = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  let flagIndex = -1;
  if (name === "sh" || name === "bash" || name === "zsh" || name === "dash") {
    flagIndex = args.findIndex(
      (arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes("c"),
    );
  } else if (name === "cmd" || name === "cmd.exe") {
    flagIndex = args.findIndex((arg) => arg.toLowerCase() === "/c");
  } else if (
    name === "powershell" ||
    name === "powershell.exe" ||
    name === "pwsh"
  ) {
    flagIndex = args.findIndex((arg) => arg.toLowerCase() === "-command");
  }
  return flagIndex >= 0 ? args[flagIndex + 1] ?? null : null;
}

function assertLoopbackOnlyDevServerCommandAtDepth(
  command: string,
  args: string[],
  shellDepth: number,
): void {
  assertDirectHostBinds(command, args);
  const nested = nestedShellCommand(command, args);
  if (nested === null) return;
  if (shellDepth >= MAX_SHELL_NESTING_DEPTH) {
    throw new Error(
      "Site dev server command could not statically validate the nested shell command " +
      "for the loopback-only constraint because it exceeds " +
      String(MAX_SHELL_NESTING_DEPTH) +
      " shell levels.",
    );
  }
  // The nested body is itself a real shell command line — `sh -c 'true &&
  // HOST=0.0.0.0 vite'` genuinely runs two statements, not one — so it
  // gets the same statement-by-statement treatment as a package script
  // body (see packageManagerValidatedScriptCommand) before each is parsed
  // and validated (recursively, in case a split statement is itself
  // another shell wrapper).
  for (const statement of splitShellStatements(nested)) {
    let parsed: ReturnType<typeof splitCommandLine>;
    try {
      parsed = splitCommandLine(statement);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Site dev server command could not statically validate the nested shell command " +
        "for the loopback-only constraint: " +
        reason,
      );
    }
    assertLoopbackOnlyDevServerCommandAtDepth(
      parsed.command,
      parsed.args,
      shellDepth + 1,
    );
  }
}

export function assertLoopbackOnlyDevServerCommand(command: string, args: string[]): void {
  assertLoopbackOnlyDevServerCommandAtDepth(command, args, 0);
}

export function packageManagerValidatedScriptCommand(
  manager: PackageManager,
  script: string,
  scriptBody: string,
  lifecycle: { pre?: string; post?: string } = {},
): ReturnType<typeof packageManagerCommand> {
  // npm, pnpm 11, Yarn Classic, and Bun run matching pre/post hooks. Yarn
  // Modern does not, but the detected manager does not carry its major
  // version, so validating Yarn hooks keeps Classic sites safe.
  for (const body of [scriptBody, lifecycle.pre, lifecycle.post]) {
    if (!body) continue;
    // npm/pnpm/Yarn/Bun run this body through a REAL shell — a compound
    // one (`export HOST=0.0.0.0; vite`, `true && HOST=0.0.0.0 vite`)
    // genuinely executes as several statements, so each gets validated on
    // its own instead of only the first.
    for (const statement of splitShellStatements(body)) {
      const visibleCommand = splitCommandLine(statement);
      assertLoopbackOnlyDevServerCommand(visibleCommand.command, visibleCommand.args);
    }
  }
  const packageCommand = packageManagerCommand(manager, script);
  assertLoopbackOnlyDevServerCommand(packageCommand.command, packageCommand.args);
  return packageCommand;
}

export function detectDevUrl(text: string): string | null {
  const plain = text.replace(ANSI_SGR_RE, "");
  const matched = DEV_URL_RE.exec(plain)?.[1];
  // A server that reports "[::1]" listens on the IPv6 loopback specifically
  // — rewriting it to "127.0.0.1" pointed the preview at a DIFFERENT
  // address nothing was necessarily listening on. isLoopbackHostname (and
  // the LoopbackPreviewUrl IPC schema built on it) already accept the
  // bracketed IPv6 form as-is, so there is nothing left to rewrite for.
  return matched?.replace(DEV_URL_TRAILING_PUNCTUATION_RE, "") ?? null;
}

export async function startSiteDevServer(input: {
  workspaceRoot: string;
  siteRoot: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  // Test-only override for the descendant-poll cadence — production always
  // gets DESCENDANT_CAPTURE_INTERVAL_MS.
  descendantCaptureIntervalMs?: number;
}): Promise<SiteProcessHandle> {
  const cwd = await resolveContainedDir(input.workspaceRoot, input.siteRoot);
  const args = input.args ?? [];
  assertLoopbackOnlyDevServerCommand(input.command, args);
  const logs: SiteLogEntry[] = [];
  const env = { ...process.env, ...(input.env ?? {}) };
  // Package-manager commands are .cmd shims on Windows and cannot be spawned
  // directly; resolveSpawnCommand is a no-op on other platforms.
  const spawnSpec = resolveSpawnCommand(input.command, args, { env, cwd });
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
  });
  child.unref();

  // A dev server session can run for a long time after its wrapper exits
  // (see stopChild's comment on the backgrounded-wrapper case) — poll the
  // live tree on POSIX while the wrapper is confirmed still running so a
  // descendant it later backgrounds stays reachable by pid even once the
  // wrapper itself is gone and reparenting has moved it out of the
  // wrapper's own subtree. Best-effort: a descendant forked and orphaned
  // between two polls is still missed, the same residual #857 accepted.
  // A poll that returns fewer pids than an earlier one (a transient `ps`
  // failure, or a descendant that hadn't forked yet on an earlier tick)
  // must not drop a pid an earlier poll already found — union every poll's
  // result instead of replacing it. A stale pid costs nothing:
  // killProcessTreePosix already treats ESRCH as success.
  // A session left open for a long time (the wrapper itself never exits,
  // just repeatedly forks and reaps short-lived helpers) would otherwise
  // retain every helper's pid forever — POSIX pids get REUSED once a
  // process fully exits, so a stale captured pid could eventually name a
  // completely unrelated, currently-running process. Pruning a pid the
  // instant it's confirmed dead (not merely "not currently a descendant",
  // which a reparented-but-still-alive orphan also looks like) keeps the
  // set to only pids that are actually still worth being able to reach.
  const capturedDescendantSet = new Set<number>();
  let capturedDescendants: number[] = [];
  // The latest in-flight capture, so a caller that needs the FRESHEST
  // possible snapshot (stopChild, once the wrapper has already exited) can
  // await it instead of racing its own async ps read.
  let pendingCapture: Promise<void> = Promise.resolve();
  const captureDescendantsOnce = (pid: number): Promise<void> => {
    const capture = processDescendants(pid).then((pids) => {
      for (const descendantPid of pids) capturedDescendantSet.add(descendantPid);
      for (const capturedPid of capturedDescendantSet) {
        if (!isPidAlive(capturedPid)) capturedDescendantSet.delete(capturedPid);
      }
      capturedDescendants = [...capturedDescendantSet];
    });
    pendingCapture = capture;
    return capture;
  };
  const descendantCaptureTimer =
    child.pid !== undefined
      ? setInterval(
          () => captureDescendantsOnce(child.pid!),
          input.descendantCaptureIntervalMs ?? DESCENDANT_CAPTURE_INTERVAL_MS,
        )
      : undefined;
  // setInterval's first tick only fires after a full interval — a wrapper
  // that backgrounds its real server and exits well inside that window
  // (the documented `server & echo URL` case) would otherwise never get
  // captured at all. Take one snapshot immediately too — best-effort only,
  // since spawn() returning is not proof the shell has executed anything
  // yet; maybeResolve (below) takes a second, more reliable one once the
  // wrapper's own ready output proves it already ran everything before it.
  if (child.pid !== undefined) captureDescendantsOnce(child.pid);
  descendantCaptureTimer?.unref?.();
  child.once("exit", () => {
    if (descendantCaptureTimer) clearInterval(descendantCaptureTimer);
  });

  let resolved = false;
  let stopped = false;
  let stdoutCarry = "";
  let stderrCarry = "";

  return await new Promise<SiteProcessHandle>((resolve, reject) => {
    function clearTimers() {
      clearTimeout(failTimer);
      input.signal?.removeEventListener("abort", abortStart);
    }

    function abortStart() {
      if (resolved || stopped) return;
      stopped = true;
      clearTimers();
      void stopChild(child, () => capturedDescendants, undefined, () => pendingCapture).finally(() => {
        reject(new Error("Site dev server start was cancelled."));
      });
    }

    const failTimer = setTimeout(() => {
      if (resolved) return;
      stopped = true;
      // Bring the child fully DOWN before rejecting. stopChild awaits before it
      // delivers SIGTERM (non-win32) / completes the tree kill (win32), so
      // rejecting first would let a caller observe the failure and delete or
      // switch the workspace while the dev server is still alive, holding the
      // site dir. stopChild also sequences the Windows tree kill BEFORE the
      // wrapper signal; signalling first would let the taskkill race a dead
      // wrapper pid and orphan the real dev server.
      void stopChild(child, () => capturedDescendants, undefined, () => pendingCapture).finally(() => {
        reject(
          new Error(
            `Site dev server did not report a local URL within ${input.readyTimeoutMs ?? 15000}ms.`,
          ),
        );
      });
    }, input.readyTimeoutMs ?? 15000);

    if (input.signal?.aborted) abortStart();
    else input.signal?.addEventListener("abort", abortStart, { once: true });

    function maybeResolve(chunk: string, stream: "stdout" | "stderr") {
      const combined =
        (stream === "stdout" ? stdoutCarry : stderrCarry) + chunk;
      const carry = combined.slice(-DEV_URL_CARRY_CHARS);
      if (stream === "stdout") stdoutCarry = carry;
      else stderrCarry = carry;
      const url = detectDevUrl(combined);
      if (!url || resolved) return;
      resolved = true;
      clearTimers();
      // The immediate post-spawn snapshot (above) can race a wrapper that
      // hasn't finished forking its background server yet — spawn()
      // returning is not proof the shell has executed anything. By the
      // time its "ready" line is OUT, everything the script did BEFORE
      // printing that line (backgrounding included) has already run, so
      // this is a far more reliable synchronization point for a second
      // snapshot than an arbitrary short delay would be.
      if (child.pid !== undefined) captureDescendantsOnce(child.pid);
      resolve({
        url,
        command: input.command,
        args,
        cwd,
        logs: () => [...logs],
        onExit: (listener) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            queueMicrotask(listener);
          } else {
            child.once("exit", listener);
          }
        },
        stop: () =>
          stopChild(
            child,
            () => capturedDescendants,
            () => {
              stopped = true;
            },
            () => pendingCapture,
          ),
      });
    }

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      pushLog(logs, "stdout", text);
      maybeResolve(text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      pushLog(logs, "stderr", text);
      maybeResolve(text, "stderr");
    });
    child.once("error", (error) => {
      clearTimers();
      if (!resolved) reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimers();
      if (!resolved && !stopped) {
        reject(new Error(`Site dev server exited before it was ready (code=${code}, signal=${signal}).`));
      }
    });
  });
}

async function stopChild(
  child: ChildProcess,
  capturedDescendants: () => readonly number[] = () => [],
  beforeKill?: () => void,
  awaitPendingCapture: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  let alreadyExited = child.exitCode !== null || child.signalCode !== null;
  // A wrapper that backgrounds the real dev server and exits right after
  // printing its URL (e.g. `node server.js & echo http://127.0.0.1:3000`)
  // leaves `child` exited long before stop() is ever called, with the real
  // server still running as an orphan. taskkill /PID <wrapper> /T (and its
  // POSIX process-group equivalent) needs the wrapper's pid to still be a
  // live process to walk its tree from — a dead pid gives it nothing to
  // reach either way, on EITHER platform. capturedDescendants (see
  // startSiteDevServer's/buildSite's periodic poll, platform-dispatched via
  // processDescendants) carries pids enumerated WHILE the wrapper was still
  // alive, so they stay reachable directly by pid even after the wrapper's
  // own exit reparents them away from its pid in the process table —
  // proceed using those even though the wrapper itself is already gone.
  //
  // captureDescendantsOnce is itself fire-and-forget from its OWN callers
  // (an async `ps` read a caller doesn't block startup or readiness on) —
  // a capture triggered right before the wrapper exits can still be
  // IN FLIGHT the instant stop() runs. Give it a chance to land before
  // deciding there's nothing to reach; only worth the wait once the
  // wrapper is already gone (the common still-running stop() path has no
  // reason to pay for it).
  if (alreadyExited) {
    await awaitPendingCapture();
    alreadyExited = child.exitCode !== null || child.signalCode !== null;
  }
  if (alreadyExited && capturedDescendants().length === 0) return;
  beforeKill?.();
  if (process.platform === "win32") {
    if (!alreadyExited) {
      await killChildTreeWin32(child);
    } else {
      // The wrapper is already gone, so taskkill /PID <wrapper> /T has
      // nothing live left to walk from — reach every descendant this
      // session's periodic poll captured directly by pid instead, the same
      // fallback POSIX takes below via capturedDescendants.
      for (const descendantPid of capturedDescendants()) {
        await killProcessTreeWin32(descendantPid, () => false);
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const hardKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, BUILD_HARD_KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(hardKill);
        resolve();
      });
    });
    return;
  }

  const pid = child.pid;
  if (pid === undefined) {
    if (!alreadyExited) child.kill("SIGTERM");
    return;
  }
  const exited = alreadyExited
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let captured: number[] = [...capturedDescendants()];
  try {
    captured = await killProcessTreePosix(pid, "SIGTERM", { alsoSignal: captured });
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  let graceTimer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, BUILD_HARD_KILL_GRACE_MS);
  });
  await Promise.race([exited, grace]);
  if (graceTimer) clearTimeout(graceTimer);
  try {
    await killProcessTreePosix(pid, "SIGKILL", { alsoSignal: captured });
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectBuildOutput(siteRoot: string, configured?: string): Promise<string | null> {
  const candidates = configured ? [configured] : ["dist", "build", "out"];
  const realSiteRoot = await realpath(siteRoot);
  for (const candidate of candidates) {
    try {
      assertContainedFilePath(candidate, "build output");
    } catch {
      return null;
    }
    const absolute = join(siteRoot, candidate);
    if (!(await pathExists(absolute))) continue;
    const realOutput = await realpath(absolute);
    if (!isInside(realSiteRoot, realOutput)) return null;
    const info = await stat(absolute);
    if (!info.isDirectory()) continue;
    // A build command that exits 0 having created only an EMPTY output
    // directory hasn't actually produced a servable site — the preview
    // path serves <output>/index.html next and fails after buildSite
    // already reported ok: true. Requiring a real, readable index.html
    // file here (not a directory literally named "index.html", and not
    // one whose permissions or ACLs deny reads) is the same check the
    // preview server and share manifest scan both need to succeed anyway.
    const indexPath = join(absolute, "index.html");
    const indexInfo = await stat(indexPath).catch(() => null);
    if (indexInfo?.isFile() && (await pathExists(indexPath))) return absolute;
  }
  return null;
}

export async function buildSite(input: {
  workspaceRoot: string;
  siteRoot: string;
  command: string;
  args?: string[];
  output?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<BuildSiteResult> {
  const cwd = await resolveContainedDir(input.workspaceRoot, input.siteRoot);
  const args = input.args ?? [];
  const timeoutMs = input.timeoutMs ?? BUILD_TIMEOUT_MS;
  const logs: SiteLogEntry[] = [];
  const env = { ...process.env, ...(input.env ?? {}) };
  const spawnSpec = resolveSpawnCommand(input.command, args, { env, cwd });
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
  });

  // A build command that backgrounds a helper or server (a watcher, a
  // local verification server) and lets its own shell wrapper exit
  // successfully once the configured output is written leaves that
  // descendant running — same reasoning, same POSIX-only mechanism, as
  // startSiteDevServer's own capture. A build normally runs and exits on
  // its own quickly, so this poll rarely needs more than its immediate
  // and ready-adjacent snapshots, but the interval still covers a longer
  // one.
  const capturedDescendantSet = new Set<number>();
  let capturedDescendants: number[] = [];
  let pendingCapture: Promise<void> = Promise.resolve();
  const captureDescendantsOnce = (pid: number): Promise<void> => {
    const capture = processDescendants(pid).then((pids) => {
      for (const descendantPid of pids) capturedDescendantSet.add(descendantPid);
      for (const capturedPid of capturedDescendantSet) {
        if (!isPidAlive(capturedPid)) capturedDescendantSet.delete(capturedPid);
      }
      capturedDescendants = [...capturedDescendantSet];
    });
    pendingCapture = capture;
    return capture;
  };
  const descendantCaptureTimer =
    child.pid !== undefined
      ? setInterval(() => captureDescendantsOnce(child.pid!), DESCENDANT_CAPTURE_INTERVAL_MS)
      : undefined;
  if (child.pid !== undefined) captureDescendantsOnce(child.pid);
  descendantCaptureTimer?.unref?.();
  child.once("exit", () => {
    if (descendantCaptureTimer) clearInterval(descendantCaptureTimer);
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortBuild);
      resolve(code);
    }

    function abortBuild() {
      if (settled) return;
      pushLog(logs, "system", "Build cancelled.");
      void stopChild(child, () => capturedDescendants, undefined, () => pendingCapture).then(() => finish(null));
    }

    timer = setTimeout(() => {
      timedOut = true;
      pushLog(logs, "system", `Build timed out after ${timeoutMs}ms.`);
      // stopChild sequences the Windows tree kill BEFORE the wrapper signal
      // and resolves once the child exits (or the kill grace lapses).
      void stopChild(child, () => capturedDescendants, undefined, () => pendingCapture).then(() => finish(null));
    }, timeoutMs);
    if (input.signal?.aborted) abortBuild();
    else input.signal?.addEventListener("abort", abortBuild, { once: true });
    child.stdout.on("data", (chunk) => pushLog(logs, "stdout", String(chunk)));
    child.stderr.on("data", (chunk) => pushLog(logs, "stderr", String(chunk)));
    child.once("error", (error) => {
      pushLog(logs, "system", error.message);
      finish(null);
    });
    child.once("exit", (code) => {
      // A timed-out build reports exitCode null regardless of how the kill
      // is delivered (taskkill termination surfaces as a plain exit code).
      // The wrapper itself has already exited here — stopChild's own guard
      // (and its await of pendingCapture) makes this a no-op unless a
      // descendant was actually captured while the wrapper was alive.
      void stopChild(child, () => capturedDescendants, undefined, () => pendingCapture).then(() =>
        finish(timedOut ? null : code),
      );
    });
  });

  const outputPath = exitCode === 0 ? await detectBuildOutput(cwd, input.output) : null;
  return {
    ok: exitCode === 0 && outputPath !== null,
    command: input.command,
    args,
    outputPath,
    logs,
    exitCode,
  };
}
