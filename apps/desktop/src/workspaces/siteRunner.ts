import { spawn, type ChildProcess } from "node:child_process";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { killProcessTreePosix, processDescendantsPosix } from "../process/posixSpawn";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";
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
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

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
  let parsed: ReturnType<typeof splitCommandLine>;
  try {
    parsed = splitCommandLine(nested);
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
    const visibleCommand = splitCommandLine(body);
    assertLoopbackOnlyDevServerCommand(visibleCommand.command, visibleCommand.args);
  }
  const packageCommand = packageManagerCommand(manager, script);
  assertLoopbackOnlyDevServerCommand(packageCommand.command, packageCommand.args);
  return packageCommand;
}

export function detectDevUrl(text: string): string | null {
  const plain = text.replace(ANSI_SGR_RE, "");
  const matched = DEV_URL_RE.exec(plain)?.[1];
  return matched
    ?.replace(DEV_URL_TRAILING_PUNCTUATION_RE, "")
    .replace("[::1]", "127.0.0.1") ?? null;
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
  let capturedDescendants: number[] = [];
  const descendantCaptureTimer =
    process.platform !== "win32" && child.pid !== undefined
      ? setInterval(() => {
          void processDescendantsPosix(child.pid!).then((pids) => {
            capturedDescendants = pids;
          });
        }, input.descendantCaptureIntervalMs ?? DESCENDANT_CAPTURE_INTERVAL_MS)
      : undefined;
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
      void stopChild(child, () => capturedDescendants).finally(() => {
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
      void stopChild(child, () => capturedDescendants).finally(() => {
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
          stopChild(child, () => capturedDescendants, () => {
            stopped = true;
          }),
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
): Promise<void> {
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  // A wrapper that backgrounds the real dev server and exits right after
  // printing its URL (e.g. `node server.js & echo http://127.0.0.1:3000`)
  // leaves `child` exited long before stop() is ever called, with the real
  // server still running as an orphan. On win32, killChildTreeWin32's own
  // taskkill /T needs the wrapper's pid to still be a live process to walk
  // its tree from — a dead pid gives it nothing to reach either way, and
  // that gap is unchanged here (same scope #857 drew: "Win32 unchanged").
  // On POSIX, capturedDescendants (see startSiteDevServer's periodic poll)
  // carries pids enumerated WHILE the wrapper was still alive, so they stay
  // reachable directly even after the wrapper's own exit reparents them
  // away from its pid in the process table — proceed using those even
  // though the wrapper itself is already gone.
  if (alreadyExited && capturedDescendants().length === 0) return;
  beforeKill?.();
  if (process.platform === "win32") {
    if (!alreadyExited) await killChildTreeWin32(child);
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
    if (info.isDirectory()) return absolute;
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
      void stopChild(child).then(() => finish(null));
    }

    timer = setTimeout(() => {
      timedOut = true;
      pushLog(logs, "system", `Build timed out after ${timeoutMs}ms.`);
      // stopChild sequences the Windows tree kill BEFORE the wrapper signal
      // and resolves once the child exits (or the kill grace lapses).
      void stopChild(child).then(() => finish(null));
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
      finish(timedOut ? null : code);
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
