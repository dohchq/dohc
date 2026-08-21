// Pure MCP tool implementations. Each operates on a workspace ROOT dir and a
// state HOME (the desktop registry/state location). EVERY workspace-relative
// write path is validated through validateUserMaterializePath (reads through
// validateUserReadPath) before it touches the filesystem — traversal (../,
// percent-encoded, the reserved .dohc dir) is rejected here, the #1 security
// requirement, and disk-write mutations also refuse names that cannot be
// materialized on this host. Writes are scoped to the root and never
// auto-apply a boundary crossing.

import {
  addFileChanges,
  createChangeSet,
  databaseSyncStrategy,
  DOHC_METADATA_GUARD,
  DOHC_TRASH_GUARD,
  frameworkConfigName,
  hasIgnoredSegment,
  hasWebDependency,
  isDohcMetadataPath,
  mediaTypeForPath,
  notARealFolderRefusal,
  outsideWorkspaceRefusal,
  packageManagerFromFiles,
  nameUnitFor,
  sameFsEntry,
  entryCharBudget,
  trashEntryPlan,
  WINDOWS_MAX_PATH_CHARS,
  validateUserMaterializePath,
  validateUserReadPath,
  type ChangeAuthor,
  type ChangeProvenance,
  type ChangeSetKind,
  type DohcPathGuard,
  type DohcSiteConfig,
  type FileChange,
  type PackageJson,
  type SiteConfidence,
  type SiteDiagnostic,
  type SiteKind,
  type SiteScripts,
  type WorkspaceSite,
  isSharedWithMePath,
  safeRelativeConfigPath,
} from "@dohc/workspace-core";
import {
  DohcCliError,
  sendCliRequest,
} from "@dohc/cli";
import {
  CLI_PROTOCOL_VERSION,
  parseCliResult,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { workspaceEngineSetting } from "@dohc/workspace-contracts/workspace-settings";
import { mergeMarkdown } from "@dohc/workspace-core/mergeMarkdown";
// The resolved-path rule lives in ONE place for every surface that decides
// authority from a path (#638, #667). This surface owns only its wording.
import {
  realRelativeInRoot,
  resolvedAreaRefusal,
  type RealTarget,
} from "@dohc/workspace-core/realPath";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { hasLegacyAppImport } from "./sourceScanner";

export interface ToolContext {
  // Workspace root the server is scoped to (the --workspace arg). All file
  // paths resolve under here and may never escape it.
  root: string;
  // Desktop state/home dir (the --home arg): holds dohc-workspaces.json.
  home: string;
  // The share level this server was launched for (#646), from the
  // --share-access flag. Absent means a local workspace: every tool registers.
  // A level narrows the write surface — see createDohcMcpServer, which decides
  // which write tools exist for it.
  shareAccess?: ShareAccess;
  // Injectable CLI transport for tests. Production uses sendCliRequest with
  // the explicit desktop state dir supplied by --home.
  request?: (request: CliRequestWithoutToken) => Promise<unknown>;
}

const MCP_AUTHOR: ChangeAuthor = {
  kind: "agent",
  agentId: "dohc-mcp",
  onBehalfOf: "local",
};
const historyRecordedAtMsByRoot = new Map<string, number>();
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const HARD_READ_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SEARCH_MAX_RESULTS = 100;
const HARD_SEARCH_MAX_RESULTS = 1000;
const DEFAULT_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_PREVIEW_CHARS = 200;

async function isWithinRealRoot(root: string, absolute: string): Promise<boolean> {
  return (await realRelativeInRoot(root, absolute)).ok;
}

// A tool's path arg, resolved to an absolute path INSIDE the root, or a reason
// it was refused. Centralizes BOTH guards so no tool can forget them: lexical
// validation (traversal/encoding/reserved) then realpath containment (symlink
// escape). Async because the symlink check touches the filesystem.
// `normalized` is the path as SPELLED (what the agent asked for, what tool
// results and change records report). `realRelative` is where it actually
// lands, root-relative, after symlinks — the only safe input to a guard that
// decides authority from a path.
async function safeResolve(
  ctx: ToolContext,
  relativePath: string,
  access: "read" | "write" | "entry" = "write",
): Promise<
  | { ok: true; absolute: string; normalized: string; realRelative: string }
  | { ok: false; reason: string }
> {
  // "write" (the default — fail closed) refuses the reserved shared-with-me
  // projection; "read" allows it (share mounts exist to be read by agents)
  // while keeping traversal/encoding/ignored-segment guards identical.
  // "entry" is "write" for every rule, and additionally says the caller renames
  // the entry itself rather than following it — see realRelativeInRoot.
  const validated =
    access === "read"
      ? validateUserReadPath(relativePath)
      : validateUserMaterializePath(relativePath);
  if (!validated.ok) {
    return { ok: false, reason: `path rejected (${validated.reason}): ${relativePath}` };
  }
  const absolute = join(ctx.root, validated.normalized);
  const target = await realRelativeInRoot(ctx.root, absolute, access === "entry");
  if (!target.ok) {
    return { ok: false, reason: unresolvedPathRefusal(target, relativePath) };
  }
  const realRelative = target.relative;
  // The check above judged the path as SPELLED. An in-workspace symlink can
  // spell a reserved area under any other name (#638), so the SAME reservation
  // is decided again on where the path really lands. Enumerating spellings is
  // the losing side of this; the resolved path ends the game.
  const refused = resolvedAreaRefusal(realRelative, access);
  if (refused) {
    return {
      ok: false,
      reason:
        `path rejected (symlink resolves into ${refused.article} ${refused.kind} area): ` +
        `${relativePath} resolves to ${realRelative}. ${refused.explain}`,
    };
  }
  return { ok: true, absolute, normalized: validated.normalized, realRelative };
}

// A path the resolver could not place. Each cause gets its own next step: a
// missing target can be created, a cycle cannot, a filesystem error is about
// the path's permissions rather than its spelling, and an unreadable workspace
// root is not about this path at all. One message for all of them would send an
// agent to fix the wrong thing.
function unresolvedPathRefusal(
  target: Extract<RealTarget, { ok: false }>,
  relativePath: string,
): string {
  switch (target.reason) {
    case "escapes-workspace":
      return `path rejected (symlink escapes workspace): ${relativePath}`;
    case "unreadable-root":
      return (
        `path rejected (dohc could not resolve the workspace root: ${target.code}): ` +
        `${relativePath}. The workspace folder failed, not this path. Check that ` +
        `the workspace folder is present and readable.`
      );
    case "dangling-symlink":
      return (
        `path rejected (a symlink on this path has no target): ${relativePath}. ` +
        `dohc cannot tell where the path leads. Create the target first, or use ` +
        `a path with no symlink.`
      );
    case "unresolvable-symlink":
      return (
        `path rejected (a symlink on this path cannot be resolved: ${target.code}): ` +
        `${relativePath}. dohc cannot tell where the path leads. Use a path with ` +
        `no symlink.`
      );
    case "unreadable-path":
      return (
        `path rejected (dohc could not check where this path leads: ${target.code}): ` +
        `${relativePath}. Fix the error on this path, or use another path.`
      );
  }
}

async function safeResolveForMutation(
  ctx: ToolContext,
  normalizedPath: string,
): Promise<{ absolute: string; normalized: string }> {
  const resolved = await safeResolve(ctx, normalizedPath);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.reason), { code: "EINVAL" });
  }
  return resolved;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readFileWindowWithDigest(
  absolute: string,
  offsetBytes: number,
  maxBytes: number,
): Promise<{ bytes: number; window: Buffer; sha256: string; offsetBytes: number; truncated: boolean }> {
  const file = await open(absolute, "r");
  try {
    const { size } = await file.stat();
    const offset = Math.min(size, offsetBytes);
    const windowLength = Math.min(maxBytes, size - offset);
    const window = Buffer.alloc(windowLength);
    if (windowLength > 0) {
      await file.read(window, 0, windowLength, offset);
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const length = Math.min(chunk.byteLength, size - position);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }

    return {
      bytes: size,
      window,
      sha256: hash.digest("hex"),
      offsetBytes: offset,
      truncated: offset + windowLength < size,
    };
  } finally {
    await file.close();
  }
}

// PR 0N-1: is this workspace on the workspace engine? MCP reads the SAME
// per-workspace settings file the desktop reads (.dohc/settings.local.json,
// workspaceSettingsFile.ts) THROUGH THE SAME SCHEMA — the shared contract, not
// a copy of it, because a hand-mirrored rule is how the two answers drift.
// WS-H1 flag flip: the engine is the DEFAULT — an absent group or a missing
// file resolves ON; only an explicit `workspaceEngineAlpha: false` opts the
// workspace out. Cheap enough to read per mutating call — the flag can flip
// between desktop opens.
//
// #641: a file that EXISTS but cannot be trusted resolves UNKNOWN, not OFF —
// the three-state contract at the top of workspaceSettings.ts. Unknown never
// names a recorder, so the read still fails closed.
const MAX_WORKSPACE_SETTINGS_FILE_BYTES = 256 * 1024;
const WORKSPACE_SETTINGS_PATH = ".dohc/settings.local.json";

// Workspace-relative throughout: the agent named a workspace, not a host, and
// an absolute host path is a fact it cannot act on.
const CANNOT_READ_SETTINGS =
  `dohc could not tell whether this workspace records history: it could not read ${WORKSPACE_SETTINGS_PATH}.`;

type HistoryRecordingRead =
  | { state: "on" }
  | { state: "off" }
  | { state: "unknown"; cause: string };

function historyUnknown(detail: string): HistoryRecordingRead {
  return { state: "unknown", cause: `${CANNOT_READ_SETTINGS} ${detail}` };
}

// The noun the reader can see at the path, so the instruction says what to
// look for. "item" covers the rest (a socket, a device node).
function settingsSquatterNoun(stats: Stats): string {
  if (stats.isSymbolicLink()) return "link";
  return stats.isDirectory() ? "folder" : "item";
}

// Why the resolver could not place the settings file. Only ONE of these is an
// escape; the rest are checks that did not finish. Collapsing them to "that
// path leads outside this workspace" would tell an agent to remove a file over
// an escape dohc never established -- the same defect this fix exists to
// remove, one layer down. Each cause names its own next step.
function settingsPathDetail(target: Extract<RealTarget, { ok: false }>): string {
  switch (target.reason) {
    case "escapes-workspace":
      return "That path leads outside this workspace, and it must stay inside. Remove or rename it. Then retry.";
    case "unreadable-root":
      return (
        `dohc could not resolve the workspace folder (${target.code}). The workspace ` +
        `folder failed, not this file. Check that the workspace folder is present and ` +
        `readable. Then retry.`
      );
    case "dangling-symlink":
      return (
        "A link on that path has no target, so dohc cannot tell where the path leads. " +
        "Create the target, or remove the link. Then retry."
      );
    case "unresolvable-symlink":
      return (
        `A link on that path cannot be resolved (${target.code}), so dohc cannot tell ` +
        `where the path leads. Remove the link. Then retry.`
      );
    case "unreadable-path":
      return (
        `dohc could not check where that path leads (${target.code}). Fix that error on ` +
        `the path, or remove it. Then retry.`
      );
  }
}

export async function readHistoryRecording(ctx: ToolContext): Promise<HistoryRecordingRead> {
  const path = join(ctx.root, ".dohc", "settings.local.json");
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    // Only an ABSENT file reads as the default: a new workspace must not be
    // born opted out, and must not be born unknown either.
    if (errnoCode(error) === "ENOENT") return { state: "on" };
    return historyUnknown(
      `The read failed (${errnoCode(error) ?? "no errno"}). Check that dohc can read that file. Then retry.`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    const noun = settingsSquatterNoun(stats);
    return historyUnknown(
      `A ${noun} is at that path, which must be a regular file. Remove or rename that ${noun}. Then retry.`,
    );
  }
  if (stats.size > MAX_WORKSPACE_SETTINGS_FILE_BYTES) {
    return historyUnknown(
      `The file is ${stats.size} bytes and the limit is ${MAX_WORKSPACE_SETTINGS_FILE_BYTES} bytes. Shrink it below the limit. Then retry.`,
    );
  }
  const target = await realRelativeInRoot(ctx.root, path);
  if (!target.ok) return historyUnknown(settingsPathDetail(target));
  let body: unknown;
  try {
    body = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = errnoCode(error);
    return historyUnknown(
      code === null
        ? "The file is not valid JSON. Repair the file. Then retry."
        : `The read failed (${code}). Check that dohc can read that file. Then retry.`,
    );
  }
  const setting = workspaceEngineSetting(body);
  return setting.state === "untrusted"
    ? historyUnknown(
        `The file does not match the settings schema (${setting.cause}). Repair the file. Then retry.`,
      )
    : { state: setting.state };
}

// Retirement Phase C (WS-H1): MCP writes NO legacy change sets. For an engine
// workspace (the default) the desktop watcher captures MCP's physical writes
// into engine moments (agent-attributed when a dohc-tracked run is active; an
// external MCP client without a dohc-tracked run yields actor-neutral engine
// capture — honest per the actor-neutral principle). Caveat a standalone MCP
// client should know: that capture happens via the desktop watcher when the
// app is open — a write made while the desktop is closed is picked up by the
// next startup reconciliation. A workspace that explicitly opted OUT of the
// engine has NO recorder at all; naming a recorder there would be a lie, so
// mutating tools report `historyRecording: "off"` instead. Legacy
// .dohc/history left by pre-flip versions is no longer read (the relic reader
// retired with @dohc/workspace-history); the read tools below list engine
// moments only.
//
// `historyRecording: "unknown"` is the third arm (#641): dohc could not read
// the settings file, so it can name neither a recorder nor an opt-out. It
// carries the cause, because "unknown" alone tells an agent nothing it can act
// on.
type RecordedChangeFields =
  | { recordedBy: "workspace-engine" }
  | { historyRecording: "off" }
  | { historyRecording: "unknown"; historyRecordingUnavailable: string };

async function recordedChangeFields(ctx: ToolContext): Promise<RecordedChangeFields> {
  const history = await readHistoryRecording(ctx);
  if (history.state === "on") return { recordedBy: "workspace-engine" };
  if (history.state === "off") return { historyRecording: "off" };
  return { historyRecording: "unknown", historyRecordingUnavailable: history.cause };
}

// Forward a write's history fields whole. Naming them one by one dropped the
// unknown arm's cause, which is the only part of it an agent can act on.
function forwardedRecordedChangeFields(written: RecordedChangeFields): RecordedChangeFields {
  if ("recordedBy" in written) return { recordedBy: written.recordedBy };
  if (written.historyRecording === "off") return { historyRecording: "off" };
  return {
    historyRecording: "unknown",
    historyRecordingUnavailable: written.historyRecordingUnavailable,
  };
}

function failureReason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// What a failed delete can say about the path afterwards.
//
// It cannot say "unchanged". Three rounds of review walked that claim from
// presence to identity to identity-plus-reuse, and the answer is that no
// comparison of two lstat results supports it: an entry can be deleted and
// recreated with the SAME inode on the same device, and content can be
// rewritten in place without touching identity at all. This is a probe on a
// filesystem dohc holds no lock on, so every "same" reading is evidence, never
// proof. Holding a handle across the operation does not rescue it either -- on
// POSIX an open descriptor pins the inode but not the NAME, so a replacement
// can still land at the path, and the Windows share-mode that would prevent it
// means locking a user's file for the length of a delete, which dohc does not
// do.
//
// What IS provable comes from rename, not from a probe: rename is atomic, so a
// rename that failed moved nothing. That sentence is in every refusal below.
// The probe is demoted to raising a WARNING when it has positive evidence of
// change. A missed warning leaves a true message; there is no reading of the
// probe that makes a false one.
type Aftermath = "replaced" | "gone" | "unchecked" | "undetermined";

// Positive evidence only, for the warning after a failed move: "unknown" is
// not evidence of a replacement and must not read as one. The rule itself is
// shared with the desktop, which runs the same ladder over the same trash.
function replacedSince(before: Stats, after: Stats): boolean {
  return sameFsEntry(before, after) === "replaced";
}

// Is the source still the entry the ladder started on? Asked BEFORE every
// attempt after the first, because a rename that failed for length leaves a
// window in which another MCP call, the desktop, or any local process can
// replace the path -- and the next rung would then move the replacement into
// the trash and report success for a file the agent never named.
//
// "unknown" stops the ladder too. A filesystem with no inode to give cannot
// prove sameness, and the costs are not symmetric: a wrong refusal costs a
// retry, a wrong success trashes the wrong file and says it is done.
async function sourceUnchangedSince(absolute: string, before: Stats): Promise<Aftermath> {
  return lstat(absolute).then(
    (now) => {
      const identity = sameFsEntry(before, now);
      return identity === "same" ? "undetermined" : identity === "replaced" ? "replaced" : "unchecked";
    },
    (probe: unknown) => (errnoCode(probe) === "ENOENT" ? "gone" : "unchecked"),
  );
}

// The half of a delete refusal that warns about the path. The agent's question
// is "can I retry?", so each case answers that and nothing more.
function deleteAftermath(path: string, aftermath: Aftermath): string {
  switch (aftermath) {
    case "replaced":
      // The observation, not a consequence drawn from it. An atomic save
      // replaces the entry too -- writeFileAtomicallyForTool does exactly
      // that, and so does most editors' save -- so "a retry deletes the
      // replacement, not the entry you asked for" was wrong whenever the
      // replacement was the same document, one revision newer. What is at the
      // path changed; who put it there, and whether the agent still wants it
      // deleted, is not this sentence's to decide.
      return ` A different entry is at ${path} now: something replaced it while dohc worked.`;
    case "gone":
      return ` ${path} is no longer in this workspace: something else moved or deleted it.`;
    case "unchecked":
      // The look itself failed. That dohc could not check is ITSELF provable,
      // and it is a different state from "the entry looks the same" -- the two
      // used to render byte-identical, which told an agent the second when the
      // truth was the first.
      return ` dohc could not check ${path} afterwards.`;
    case "undetermined":
      // The look succeeded and found no evidence of change. Nothing about what
      // ELSE touched the path is provable, and the refusal already says what
      // dohc did, which is what a retry decision needs.
      return "";
  }
}

// The errno code alone, for refusals that translate a filesystem failure. An
// agent can act on "EACCES"; it cannot act on a sentence that hides which
// failure happened.
//
// null means "this is not an errno at all", which is a different fact and has
// to stay one: it is how a guard refusal this code wrote is told apart from a
// failure the platform reported, and rendering it as "(unknown)" would put a
// non-code in a slot that is documented to hold one.
function errnoCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return null;
}

async function ensureRecordable(ctx: ToolContext) {
  // Retirement Phase C: no legacy durable-writer platform gate — the engine
  // captures the physical write. The metadata-dir safety check still fails
  // closed before visible disk changes (symlinked/escaping .dohc).
  try {
    await safeMetadataDir(ctx);
    return null;
  } catch (error) {
    return { ok: false as const, reason: metadataDirRefusal(error) };
  }
}

// #642: the errno used to pass through whole, so an agent read
// `EPERM: operation not permitted, lstat 'C:\Users\…\ws\.dohc'` — an absolute
// host path it never supplied and cannot act on.
//
// The two failures are told apart by the errno, not by the message: a guard
// refusal is an Error this code wrote (ensureGuardedDir) and carries no
// `code`, so it is already workspace-relative and passes through whole. Only
// a platform failure is translated. The code stays, as detail rather than as
// the whole message — an agent can act on "EPERM".
// A saturated resource is not a permission problem, and the permission
// instruction sends an agent to widen access that was never the obstacle. Each
// one names the resource that ran out and how to free it, per the backpressure
// rule in AGENTS.md. Both descriptor limits are here because the per-process
// one (EMFILE) and the system-wide one (ENFILE) are freed by different acts.
const METADATA_CAPACITY_INSTRUCTIONS = new Map<string, string>([
  ["ENOSPC", "The disk holding this workspace is full. Free disk space. Then retry."],
  ["EDQUOT", "The disk quota for this workspace is used up. Free space, or raise the quota. Then retry."],
  ["EMFILE", "dohc holds too many open files. Restart dohc. Then retry."],
  ["ENFILE", "This computer holds too many open files. Close other apps. Then retry."],
]);

function metadataDirRefusal(error: unknown): string {
  const code = errnoCode(error);
  if (code === null) return failureReason(error, DOHC_METADATA_GUARD.lead);
  const instruction =
    METADATA_CAPACITY_INSTRUCTIONS.get(code) ??
    `Check that dohc can read and write ${DOHC_METADATA_GUARD.path} in this workspace. Then retry.`;
  return `${DOHC_METADATA_GUARD.lead} Preparing that folder failed (${code}). dohc changed no files. ${instruction}`;
}

// mkdir{recursive} throws a raw errno (EEXIST, or a Windows variant) when
// something that is not a directory squats the path, and every reason here
// reaches the calling agent verbatim. Fall through on PRESENCE, never on an
// errno allowlist: a DANGLING symlink squat raises ENOENT, which an allowlist
// misses. When something is at the path, the check below names it and the way
// out. When nothing is there, the mkdir itself failed (permissions, I/O) --
// rethrow that.
async function ensureGuardedDir(dir: string, guard: DohcPathGuard, root: string) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    if (!(await lstat(dir).catch(() => null))) throw error;
  }
  // Validate AFTER mkdir: mkdir{recursive} silently no-ops on an existing
  // symlink-to-dir, so only the post-mkdir state proves where a write or a
  // rename would land.
  const link = await lstat(dir);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new Error(notARealFolderRefusal(guard, link));
  }
  if (!(await isWithinRealRoot(root, dir))) {
    throw new Error(outsideWorkspaceRefusal(guard));
  }
}

async function safeMetadataDir(ctx: ToolContext): Promise<string> {
  const dir = join(ctx.root, ".dohc");
  await ensureGuardedDir(dir, DOHC_METADATA_GUARD, ctx.root);
  return dir;
}

async function safeTrashDir(ctx: ToolContext): Promise<string> {
  const dir = join(await safeMetadataDir(ctx), "trash");
  await ensureGuardedDir(dir, DOHC_TRASH_GUARD, ctx.root);
  return dir;
}

function mutationRetainedReason(error: unknown, fallback: string): string {
  return `${failureReason(error, fallback)}; visible mutation retained because rollback cannot be made atomic`;
}

function expectedSha256Mismatch(currentSha256: string): Error & { currentSha256: string } {
  return Object.assign(new Error("expectedSha256 does not match current file"), {
    code: "ESTALE",
    currentSha256,
  });
}

function isExpectedSha256Mismatch(
  error: unknown,
): error is Error & { currentSha256: string } {
  return (
    error instanceof Error &&
    typeof (error as { currentSha256?: unknown }).currentSha256 === "string"
  );
}

async function writeFileAtomicallyForTool(
  ctx: ToolContext,
  normalizedPath: string,
  data: string | Buffer,
  options: { expectedSha256?: string; overwrite?: boolean } = {},
): Promise<void> {
  const target = await safeResolveForMutation(ctx, normalizedPath);
  const absolutePath = target.absolute;
  const parentDir = dirname(target.absolute);
  const tempPath = join(parentDir, `.dohc-write-${process.pid}-${randomUUID()}.tmp`);
  let published = false;
  let existingMode: number | undefined;
  const publishTarget = async (): Promise<string> => {
    const current = await safeResolveForMutation(ctx, normalizedPath);
    if (current.absolute !== absolutePath) {
      throw Object.assign(new Error(`path changed before publish: ${normalizedPath}`), {
        code: "EINVAL",
      });
    }
    return current.absolute;
  };
  const assertExpectedCurrent = async (): Promise<void> => {
    if (options.expectedSha256 === undefined) return;
    const finalPath = await publishTarget();
    const existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to overwrite symlink: ${absolutePath}`), {
        code: "ELOOP",
      });
    }
    if (existing && !existing.isFile()) {
      throw Object.assign(new Error(`refusing to overwrite non-file: ${absolutePath}`), {
        code: "EISDIR",
      });
    }
    const currentBytes = existing ? await readFile(finalPath) : Buffer.alloc(0);
    const currentSha256 = sha256(currentBytes);
    if (currentSha256 !== options.expectedSha256) {
      throw expectedSha256Mismatch(currentSha256);
    }
  };
  if (options.overwrite !== false) {
    const existing = await lstat(await publishTarget()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to overwrite symlink: ${absolutePath}`), {
        code: "ELOOP",
      });
    }
    if (existing && !existing.isFile()) {
      throw Object.assign(new Error(`refusing to overwrite non-file: ${absolutePath}`), {
        code: "EISDIR",
      });
    }
    existingMode = existing ? existing.mode & 0o777 : undefined;
  }
  try {
    await writeFile(tempPath, data, { flag: "wx" });
    if (existingMode !== undefined) await chmod(tempPath, existingMode);
    await assertExpectedCurrent();
    const finalPath = await publishTarget();
    if (options.overwrite === false) {
      await link(tempPath, finalPath);
      published = true;
      await rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await rename(tempPath, finalPath);
      published = true;
    }
  } finally {
    if (!published) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const requireFromHere = createRequire(import.meta.url);
interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}
function nodeSqlite(): SqliteModule {
  return requireFromHere("node:sqlite") as SqliteModule;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// --- workspace filesystem ---------------------------------------------------

type WorkspaceFileKind = "file" | "directory";
type WorkspaceSearchMode = "content" | "path" | "both";
type WorkspaceSearchMatch =
  | {
      type: "content";
      path: string;
      mediaType: string;
      line: number;
      column: number;
      preview: string;
    }
  | {
      type: "path";
      path: string;
      mediaType?: string;
      preview: string;
    };

export async function listWorkspaceFiles(
  ctx: ToolContext,
  args: { path?: string; recursive?: boolean } = {},
): Promise<
  | {
      ok: true;
      root: string;
      entries: Array<{ path: string; kind: WorkspaceFileKind; bytes?: number; mediaType?: string }>;
    }
  | { ok: false; reason: string }
> {
  const root =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "" };
  if (!root.ok) return { ok: false as const, reason: root.reason };

  const entries: Array<{ path: string; kind: WorkspaceFileKind; bytes?: number; mediaType?: string }> = [];
  const recursive = args.recursive ?? true;

  async function walk(absolute: string, prefix: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (hasIgnoredSegment(rel) || dirent.isSymbolicLink()) continue;
      const child = join(absolute, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, kind: "directory" });
        if (recursive) await walk(child, rel);
      } else if (dirent.isFile()) {
        const info = await stat(child);
        entries.push({
          path: rel,
          kind: "file",
          bytes: info.size,
          mediaType: mediaTypeForPath(rel) ?? "application/octet-stream",
        });
      }
    }
  }

  const info = await lstat(root.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `path not found: ${args.path ?? "."}` };
  if (info.isDirectory()) {
    await walk(root.absolute, root.normalized);
  } else if (info.isFile()) {
    const file = await stat(root.absolute);
    entries.push({
      path: root.normalized,
      kind: "file",
      bytes: file.size,
      mediaType: mediaTypeForPath(root.normalized) ?? "application/octet-stream",
    });
  } else {
    return { ok: false as const, reason: `not a file or directory: ${args.path ?? "."}` };
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true as const, root: root.normalized, entries };
}

// Secret-backed files (PR 08, plan agent-access default = DENY): dohc-
// controlled agent surfaces never share secret file contents. The floor is
// the same classifyEngineFilePath rule the engine enforces everywhere —
// policy files can never unmark it.
const SECRET_READ_DENIED_REASON =
  "This file is protected: secret-backed files (like .env) are never shared with agents through dohc tools. Agent access to secret contents is denied by default.";

function isSecretWorkspacePath(normalizedPath: string): boolean {
  // Read-aware: a mounted `shared-with-me/alex/.env` classifies as the mount
  // sees it (secret), where the write-side classifier would say "ignored"
  // and wave it through the floor.
  return classifyEngineFilePathForRead(normalizedPath).kind === "secret";
}

// The secret floor decided on BOTH spellings of a resolved path. The name the
// agent asked for is not the name the bytes come from: `notes.md -> .env`
// passes a check on the request and reads the secret anyway, and every tool
// that opens a file follows the link. Neither spelling may classify as secret.
function isSecretResolvedPath(resolved: { normalized: string; realRelative: string }): boolean {
  return isSecretWorkspacePath(resolved.normalized) || isSecretWorkspacePath(resolved.realRelative);
}

export async function readWorkspaceFile(
  ctx: ToolContext,
  args: {
    path: string;
    encoding?: "utf8" | "base64";
    maxBytes?: number;
    offsetBytes?: number;
  },
) {
  const resolved = await safeResolve(ctx, args.path, "read");
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  if (isSecretResolvedPath(resolved)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  try {
    const maxBytes = Math.min(
      HARD_READ_MAX_BYTES,
      Math.max(1, Math.floor(args.maxBytes ?? DEFAULT_READ_MAX_BYTES)),
    );
    const read = await readFileWindowWithDigest(
      resolved.absolute,
      Math.max(0, Math.floor(args.offsetBytes ?? 0)),
      maxBytes,
    );
    const encoding = args.encoding ?? "utf8";
    return {
      ok: true as const,
      path: resolved.normalized,
      mediaType: mediaTypeForPath(resolved.normalized) ?? "application/octet-stream",
      encoding,
      bytes: read.bytes,
      offsetBytes: read.offsetBytes,
      sha256: read.sha256,
      truncated: read.truncated,
      content:
        encoding === "base64" ? read.window.toString("base64") : read.window.toString("utf8"),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to read: ${args.path}`),
    };
  }
}

function isSearchableText(mediaType: string, path: string, bytes: Buffer): boolean {
  const lower = `${mediaType} ${path}`.toLowerCase();
  if (
    lower.includes("image/") ||
    lower.includes("audio/") ||
    lower.includes("video/") ||
    lower.includes("pdf") ||
    lower.includes("sqlite") ||
    lower.endsWith(".db")
  ) {
    return false;
  }
  return !bytes.includes(0);
}

function pathMatchesQuery(
  path: string,
  query: string,
  caseSensitive: boolean,
  regex: RegExp | null,
): boolean {
  if (regex) {
    regex.lastIndex = 0;
    return regex.test(path);
  }
  return caseSensitive
    ? path.includes(query)
    : path.toLowerCase().includes(query.toLowerCase());
}

function fixedStringIndexes(line: string, query: string, caseSensitive: boolean): number[] {
  const indexes: number[] = [];
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + Math.max(1, needle.length))
  ) {
    indexes.push(index);
  }
  return indexes;
}

function regexIndexes(line: string, regex: RegExp): number[] {
  const indexes: number[] = [];
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(line);
    if (!match) break;
    indexes.push(match.index);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return indexes;
}

function previewLine(line: string, matchIndex: number): string {
  if (line.length <= SEARCH_PREVIEW_CHARS) return line;
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(line.length, start + SEARCH_PREVIEW_CHARS);
  return `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`;
}

export async function searchWorkspaceFiles(
  ctx: ToolContext,
  args: {
    query: string;
    path?: string;
    mode?: WorkspaceSearchMode;
    caseSensitive?: boolean;
    regex?: boolean;
    maxResults?: number;
    maxFileBytes?: number;
  },
): Promise<
  | {
      ok: true;
      query: string;
      root: string;
      mode: WorkspaceSearchMode;
      matches: WorkspaceSearchMatch[];
      matchCount: number;
      limitHit: boolean;
      skipped: Array<{ path: string; reason: string }>;
    }
  | { ok: false; reason: string }
> {
  if (args.query.length === 0) {
    return { ok: false as const, reason: "query must not be empty" };
  }
  const root =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "" };
  if (!root.ok) return { ok: false as const, reason: root.reason };

  let regex: RegExp | null = null;
  if (args.regex) {
    try {
      regex = new RegExp(args.query, `g${args.caseSensitive ? "" : "i"}`);
    } catch (error) {
      return { ok: false as const, reason: failureReason(error, "invalid regex") };
    }
  }

  const mode = args.mode ?? "both";
  const caseSensitive = args.caseSensitive ?? false;
  const maxResults = Math.min(
    HARD_SEARCH_MAX_RESULTS,
    Math.max(1, Math.floor(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)),
  );
  const maxFileBytes = Math.min(
    HARD_READ_MAX_BYTES,
    Math.max(1, Math.floor(args.maxFileBytes ?? DEFAULT_SEARCH_MAX_FILE_BYTES)),
  );
  const matches: WorkspaceSearchMatch[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let limitHit = false;

  function pushMatch(match: WorkspaceSearchMatch): boolean {
    if (matches.length >= maxResults) {
      limitHit = true;
      return false;
    }
    matches.push(match);
    if (matches.length >= maxResults) {
      limitHit = true;
      return false;
    }
    return true;
  }

  async function searchFile(absolute: string, relativePath: string): Promise<boolean> {
    // Secret floor (PR 08): never search protected files — neither their
    // contents nor a path hit that would carry a preview. The skip is
    // reported honestly instead of silently vanishing.
    if (isSecretWorkspacePath(relativePath)) {
      skipped.push({ path: relativePath, reason: "protected file (secret contents are never searched)" });
      return true;
    }
    const info = await stat(absolute);
    const mediaType = mediaTypeForPath(relativePath) ?? "application/octet-stream";

    if (mode !== "content" && pathMatchesQuery(relativePath, args.query, caseSensitive, regex)) {
      if (!pushMatch({ type: "path", path: relativePath, mediaType, preview: relativePath })) {
        return false;
      }
    }

    if (mode === "path") return true;
    if (info.size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: `file exceeds maxFileBytes (${info.size})` });
      return true;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      skipped.push({ path: relativePath, reason: failureReason(error, "read failed") });
      return true;
    }
    if (!isSearchableText(mediaType, relativePath, bytes)) {
      skipped.push({ path: relativePath, reason: "binary or unsupported text encoding" });
      return true;
    }

    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      const indexes = regex
        ? regexIndexes(line, regex)
        : fixedStringIndexes(line, args.query, caseSensitive);
      for (const matchIndex of indexes) {
        if (
          !pushMatch({
            type: "content",
            path: relativePath,
            mediaType,
            line: lineIndex + 1,
            column: matchIndex + 1,
            preview: previewLine(line, matchIndex),
          })
        ) {
          return false;
        }
      }
    }
    return true;
  }

  async function walk(absolute: string, prefix: string): Promise<boolean> {
    const info = await lstat(absolute).catch(() => null);
    if (!info) {
      skipped.push({ path: prefix || ".", reason: "path not found" });
      return true;
    }
    if (info.isSymbolicLink()) return true;
    if (info.isFile()) return searchFile(absolute, prefix);
    if (!info.isDirectory()) {
      skipped.push({ path: prefix || ".", reason: "not a file or directory" });
      return true;
    }

    const dirents = await readdir(absolute, { withFileTypes: true }).catch((error: unknown) => {
      skipped.push({ path: prefix || ".", reason: failureReason(error, "directory read failed") });
      return null;
    });
    if (!dirents) return true;
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (hasIgnoredSegment(rel) || dirent.isSymbolicLink()) continue;
      const child = join(absolute, dirent.name);
      if (!(await walk(child, rel))) return false;
    }
    return true;
  }

  try {
    await walk(root.absolute, root.normalized);
  } catch (error) {
    return { ok: false as const, reason: failureReason(error, "search failed") };
  }

  return {
    ok: true as const,
    query: args.query,
    root: root.normalized,
    mode,
    matches,
    matchCount: matches.length,
    limitHit,
    skipped,
  };
}

export async function writeWorkspaceFile(
  ctx: ToolContext,
  args: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    expectedSha256?: string;
    summary?: string;
  },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;

  const bytes =
    args.encoding === "base64"
      ? Buffer.from(args.content, "base64")
      : Buffer.from(args.content, "utf8");
  const parentDir = dirname(resolved.absolute);
  let visibleMutationStarted = false;
  try {
    const createdParent = await mkdir(parentDir, { recursive: true });
    if (createdParent) visibleMutationStarted = true;
    await writeFileAtomicallyForTool(ctx, resolved.normalized, bytes, {
      expectedSha256: args.expectedSha256,
    });
    visibleMutationStarted = true;
  } catch (error) {
    if (isExpectedSha256Mismatch(error)) {
      return {
        ok: false as const,
        reason: error.message,
        currentSha256: error.currentSha256,
      };
    }
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to write: ${args.path}`)
        : failureReason(error, `failed to write: ${args.path}`),
    };
  }
  return {
    ok: true as const,
    path: resolved.normalized,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...(await recordedChangeFields(ctx)),
  };
}

export async function createWorkspaceDirectory(
  ctx: ToolContext,
  args: { path: string; summary?: string },
) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  try {
    const existing = await lstat(resolved.absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (existing.isDirectory()) {
        return { ok: true as const, path: resolved.normalized, unchanged: true as const };
      }
      return {
        ok: false as const,
        reason: `path already exists and is not a directory: ${args.path}`,
      };
    }
    const createdPath = await mkdir(resolved.absolute, { recursive: true });
    if (!createdPath) {
      return { ok: true as const, path: resolved.normalized, unchanged: true as const };
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to create directory: ${args.path}`),
    };
  }
  return {
    ok: true as const,
    path: resolved.normalized,
    ...(await recordedChangeFields(ctx)),
  };
}

export async function moveWorkspacePath(
  ctx: ToolContext,
  args: { fromPath: string; toPath: string; overwrite?: boolean; summary?: string },
) {
  // The source is renamed as an entry (a link moves as a link); the
  // destination is created, so it keeps the following "write" rules.
  const from = await safeResolve(ctx, args.fromPath, "entry");
  if (!from.ok) return { ok: false as const, reason: from.reason };
  const to = await safeResolve(ctx, args.toPath);
  if (!to.ok) return { ok: false as const, reason: to.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  if (to.normalized === from.normalized || to.normalized.startsWith(`${from.normalized}/`)) {
    return { ok: false as const, reason: `cannot move a path into itself: ${args.fromPath}` };
  }
  const destinationExists = await lstat(to.absolute).then(
    () => true,
    () => false,
  );
  if (destinationExists && !args.overwrite) {
    return { ok: false as const, reason: `destination already exists: ${args.toPath}` };
  }
  await mkdir(dirname(to.absolute), { recursive: true });
  try {
    await rename(from.absolute, to.absolute);
    return {
      ok: true as const,
      fromPath: from.normalized,
      toPath: to.normalized,
      ...(await recordedChangeFields(ctx)),
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: failureReason(error, `failed to move: ${args.fromPath}`),
    };
  }
}

export async function deleteWorkspacePath(
  ctx: ToolContext,
  args: { path: string; summary?: string },
) {
  // Renamed into the trash as an entry: a broken link is deleted, not followed.
  const resolved = await safeResolve(ctx, args.path, "entry");
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  // "Nothing is there" answered on its own, before anything can fail: it is a
  // different fact from "the move failed", and an lstat errno naming an
  // absolute host path told the agent neither (#613).
  //
  // ONLY ENOENT is absence. A parent directory without search permission
  // answers EACCES for a file that is right there, and an agent told that file
  // is gone would stop looking for it -- the same lie in the opposite
  // direction. Every other code keeps its own failure.
  const source = await lstat(resolved.absolute).then(
    (stats) => ({ found: true as const, stats }),
    (error: unknown) => ({ found: false as const, code: errnoCode(error) ?? "no errno" }),
  );
  if (!source.found) {
    return {
      ok: false as const,
      reason:
        source.code === "ENOENT"
          ? `dohc could not delete ${resolved.normalized}. Nothing is at that path in this workspace. List the folder to see what is there.`
          : `dohc could not delete ${resolved.normalized}. The check on that path failed (${source.code}). dohc did not move it.`,
    };
  }
  // The guard refusals name their own constraint (#585) and pass through as
  // they are. Everything else here is an errno from mkdir or lstat, and it
  // used to reach the agent raw, absolute host path and all -- the very defect
  // this tool's other arms were fixed for. A guard refusal is an Error this
  // code wrote and carries no `code`; an errno does.
  let trashDir: string;
  try {
    trashDir = await safeTrashDir(ctx);
  } catch (error) {
    const code = errnoCode(error);
    return {
      ok: false as const,
      reason:
        code === null
          ? failureReason(error, `failed to delete: ${resolved.normalized}`)
          : `dohc could not delete ${resolved.normalized}. Preparing the workspace trash folder failed (${code}). dohc did not move it.`,
    };
  }
  // Renaming down a ladder, not predicting which limit applies. Rung 1 is the
  // file's real name: a name that fits is never shortened, which matters
  // because the trash keeps no record of the original and a dropped character
  // cannot be recovered. Rung 2 fits the per-component limit, rung 3 also fits
  // the legacy MAX_PATH limit -- and each is only reached because the platform
  // actually refused the one above it.
  //
  // Predicting went wrong twice: assuming the component limit was the only one
  // (#613, a rename past MAX_PATH answering ENOENT about a file that was right
  // there), then assuming MAX_PATH always binds, which took deletion away from
  // deep workspaces on hosts where long paths work.
  const prefix = `${Date.now()}-${randomUUID()}-`;
  const plan = trashEntryPlan(basename(resolved.normalized), prefix, {
    unit: nameUnitFor(process.platform),
    maxEntryChars: entryCharBudget(trashDir, process.platform),
  });

  let moveError: unknown = null;
  let trashed = false;
  // Set when the ladder stopped because the path stopped being the entry the
  // agent named. The identity comes from the preflight, captured ONCE before
  // the first rename -- re-reading it per rung would compare the source with
  // itself and reopen the window it exists to close.
  let aborted: Aftermath | null = null;
  for (const [rung, candidate] of plan.candidates.entries()) {
    if (rung > 0) {
      const still = await sourceUnchangedSince(resolved.absolute, source.stats);
      if (still !== "undetermined") {
        aborted = still;
        break;
      }
    }
    try {
      await rename(resolved.absolute, join(trashDir, candidate));
      trashed = true;
      break;
    } catch (error) {
      moveError = error;
      // Only a length failure earns another attempt with a shorter name.
      // ENAMETOOLONG says so outright; Windows says ENOENT, because Win32
      // normalization rejects an over-long path as ERROR_PATH_NOT_FOUND --
      // which is exactly how #613 disguised itself. Anything else (EACCES,
      // EBUSY, EXDEV) is not about length and must not be retried into a
      // truncation.
      const code = errnoCode(error);
      if (code !== "ENAMETOOLONG" && code !== "ENOENT") break;
    }
  }

  if (!trashed) {
    // The ladder ran out. When a composed-path limit left no room even for the
    // unique prefix there was never a shorter name to try, so say that and
    // name the limit -- unless the ladder stopped for a changed path instead,
    // which is the truer reason and is reported below.
    if (plan.exhausted && aborted === null) {
      return {
        ok: false as const,
        reason: `dohc could not delete ${resolved.normalized}. The workspace trash folder is ${trashDir.length} characters deep, and this platform allows ${WINDOWS_MAX_PATH_CHARS} characters for a whole path, which leaves no room for a trash entry name. Move the workspace to a shorter path. dohc did not move it.`,
      };
    }
    // Name the outcome, not just the failure: an agent that cannot tell a
    // refused delete from a silent one cannot decide what to do next.
    //
    // "dohc did not move it" is the rename contract, not a guess: rename is
    // atomic, so a failed one moved nothing. That holds whatever else touched
    // the path, and it is what an agent needs to decide whether to retry.
    //
    // The probe only ADDS a warning, and only on positive evidence that the
    // path changed under the tool. Nothing serializes these mutations, so the
    // desktop, another MCP call, or any local process can empty or replace the
    // path between the check above and this rename.
    const after =
      aborted ??
      (await lstat(resolved.absolute).then(
        (stats) => (replacedSince(source.stats, stats) ? "replaced" : "undetermined"),
        (probe: unknown) => (errnoCode(probe) === "ENOENT" ? "gone" : "unchecked"),
      ));
    return {
      ok: false as const,
      reason:
        `dohc could not delete ${resolved.normalized}. The move to the workspace trash failed (${errnoCode(moveError) ?? "no errno"}). dohc did not move it.` +
        deleteAftermath(resolved.normalized, after),
    };
  }
  return {
    ok: true as const,
    path: resolved.normalized,
    trashed: true,
    ...(await recordedChangeFields(ctx)),
  };
}

// --- dohc_list_workspaces / cloud binding helpers ---------------------------

interface RemoteIdentity {
  serverUrl: string;
  remoteWorkspaceId: string;
  ownerUserId: string;
}

interface RegistryWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: string;
  mode?: string;
  remote?: RemoteIdentity;
}

interface RegistryFile {
  version?: number;
  workspaces?: RegistryWorkspace[];
}

interface SyncManifest {
  workspaceId?: string;
  serverUrl?: string;
  remoteWorkspaceId?: string;
}

type CloudCredentialLoad =
  | {
      ok: true;
      status: "available";
      serverUrl: string;
      userId: string;
    }
  | { ok: false; status: "missing" | "encrypted" | "invalid"; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

async function readRegistry(ctx: ToolContext): Promise<RegistryFile | null> {
  return readJson<RegistryFile>(join(ctx.home, "dohc-workspaces.json"));
}

async function readSyncManifest(ctx: ToolContext): Promise<SyncManifest | null> {
  return readJson<SyncManifest>(join(ctx.root, ".dohc", "sync-manifest.json"));
}

async function findWorkspaceEntry(ctx: ToolContext): Promise<RegistryWorkspace | null> {
  const registry = await readRegistry(ctx);
  const workspaces = registry?.workspaces ?? [];
  const realRoot = await realpath(ctx.root).catch(() => ctx.root);
  for (const workspace of workspaces) {
    if (workspace.rootPath === ctx.root) return workspace;
    const realWorkspaceRoot = await realpath(workspace.rootPath).catch(() => workspace.rootPath);
    if (realWorkspaceRoot === realRoot) return workspace;
  }
  return null;
}

function validRemote(remote: unknown): remote is RemoteIdentity {
  return (
    remote !== null &&
    typeof remote === "object" &&
    nonEmptyString((remote as RemoteIdentity).serverUrl) &&
    nonEmptyString((remote as RemoteIdentity).remoteWorkspaceId) &&
    nonEmptyString((remote as RemoteIdentity).ownerUserId)
  );
}

async function remoteForCurrentWorkspace(
  ctx: ToolContext,
): Promise<(RemoteIdentity & { workspaceId?: string }) | null> {
  const entry = await findWorkspaceEntry(ctx);
  if (validRemote(entry?.remote)) {
    return { workspaceId: entry?.workspaceId, ...entry.remote };
  }
  return null;
}

async function loadCloudCredentials(ctx: ToolContext): Promise<CloudCredentialLoad> {
  if (
    process.env.DOHC_MCP_CLOUD_SERVER_URL ||
    process.env.DOHC_MCP_CLOUD_USER_ID
  ) {
    if (
      nonEmptyString(process.env.DOHC_MCP_CLOUD_SERVER_URL) &&
      nonEmptyString(process.env.DOHC_MCP_CLOUD_USER_ID)
    ) {
      return {
        ok: true,
        status: "available",
        serverUrl: process.env.DOHC_MCP_CLOUD_SERVER_URL,
        userId: process.env.DOHC_MCP_CLOUD_USER_ID,
      };
    }
    return {
      ok: false,
      status: "invalid",
      reason: "dohc MCP cloud environment is incomplete.",
    };
  }

  const credentials = await readJson<{
    version?: unknown;
    serverUrl?: unknown;
    email?: unknown;
    userId?: unknown;
    token?: unknown;
  }>(join(ctx.home, "dohc-cloud.json"));
  if (
    !credentials ||
    credentials.version !== 1 ||
    !nonEmptyString(credentials.serverUrl) ||
    !nonEmptyString(credentials.email) ||
    !nonEmptyString(credentials.userId) ||
    !nonEmptyString(credentials.token)
  ) {
    return { ok: false, status: "missing", reason: "Sign in to dohc Cloud first." };
  }

  if (credentials.token.startsWith("plain:")) {
    const token = credentials.token.slice("plain:".length);
    if (!token) {
      return { ok: false, status: "invalid", reason: "dohc Cloud session token is empty." };
    }
    return {
      ok: true,
      status: "available",
      serverUrl: credentials.serverUrl,
      userId: credentials.userId,
    };
  }

  if (credentials.token.startsWith("enc:")) {
    return {
      ok: false,
      status: "encrypted",
      reason:
        "dohc Cloud session is encrypted by Desktop safeStorage; open dohc Desktop or use a desktop-brokered MCP session to sync.",
    };
  }

  return { ok: false, status: "invalid", reason: "dohc Cloud session token has an unknown format." };
}

function credentialStatusFor(
  remote: RemoteIdentity | null,
  credentials: CloudCredentialLoad,
):
  | {
      cloudConnected: false;
      credentialStatus:
        | "not-needed"
        | "missing"
        | "encrypted"
        | "invalid"
        | "server-mismatch"
        | "account-mismatch";
    }
  | { cloudConnected: true; credentialStatus: "available" } {
  if (!remote) return { cloudConnected: false, credentialStatus: "not-needed" };
  if (!credentials.ok) {
    return { cloudConnected: false, credentialStatus: credentials.status };
  }
  if (normalizeServerUrl(credentials.serverUrl) !== normalizeServerUrl(remote.serverUrl)) {
    return { cloudConnected: false, credentialStatus: "server-mismatch" };
  }
  if (credentials.userId !== remote.ownerUserId) {
    return { cloudConnected: false, credentialStatus: "account-mismatch" };
  }
  return { cloudConnected: true, credentialStatus: "available" };
}

export async function listWorkspaces(ctx: ToolContext) {
  const registry = await readRegistry(ctx);
  const workspaces = (registry?.workspaces ?? []).map((w) => ({
    workspaceId: w.workspaceId,
    rootPath: w.rootPath,
    kind: w.kind,
    ...(w.remote ? { remote: w.remote } : {}),
  }));
  return { workspaces };
}

// --- dohc_workspace_status --------------------------------------------------

export async function workspaceStatus(ctx: ToolContext) {
  const [manifest, remote, credentials] = await Promise.all([
    readSyncManifest(ctx),
    remoteForCurrentWorkspace(ctx),
    loadCloudCredentials(ctx),
  ]);
  const remoteWorkspaceId = remote?.remoteWorkspaceId ?? manifest?.remoteWorkspaceId;
  const serverUrl = remote?.serverUrl ?? manifest?.serverUrl;
  const synced = !!remoteWorkspaceId;
  const credential = credentialStatusFor(remote, credentials);
  return {
    synced,
    scope: synced ? ("cloud" as const) : ("local" as const),
    ...credential,
    ...(manifest?.workspaceId ?? remote?.workspaceId
      ? { workspaceId: manifest?.workspaceId ?? remote?.workspaceId }
      : {}),
    ...(remoteWorkspaceId ? { remoteWorkspaceId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
}

// Legacy cloud sync (dohc_sync_now / dohc_sync_cloud) was removed together with
// the retired workspace-api file/sync routes (/workspaces/:id/files,
// /sync/apply). Cloud sync is now automatic per workspace via the sync relay;
// workspace history is read through dohc_list_changes (engine moments) below.

// --- dohc_list_changes / dohc_read_change ----------------------------------

// The workspace engine is the sole recorder of history, but desktop main is
// the sole owner of its database. These tools read moments through the CLI
// transport. The pre-flip legacy `.dohc/history` change-set relic was retired;
// a moment carries path/operation/versionId (the legacy kind,
// boundaryCrossings, and provenance fields no longer exist and are never
// faked).

const LIST_CHANGES_HARD_LIMIT = 500;

export async function listChanges(
  ctx: ToolContext,
  args: { sinceMs?: number; limit?: number; includeFiles?: boolean } = {},
) {
  return requestCli(ctx, "moments", {
    ...args,
    ...(args.limit !== undefined
      ? { limit: Math.min(LIST_CHANGES_HARD_LIMIT, Math.max(1, Math.floor(args.limit))) }
      : {}),
  });
}

export async function readChange(ctx: ToolContext, args: { id: string }) {
  return requestCli(ctx, "moment", args);
}

// --- dohc site tools --------------------------------------------------------

type RawDohcSiteConfig = Partial<Record<keyof DohcSiteConfig, unknown>> &
  Record<string, unknown>;

type SiteCheck = {
  name: string;
  ok: boolean;
  message?: string;
  path?: string;
};

const LEGACY_APPS_SEGMENT = `.${"apps"}`;
const SITE_SCAN_IGNORED_NAMES = new Set([
  ".cache",
  ".dohc",
  ".git",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "coverage",
  "node_modules",
]);
const SITE_BUILD_OUTPUT_NAMES = ["dist", "build", "out"];
const SITE_SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".ts",
  ".tsx",
  ".css",
]);
const MAX_SITE_TEST_BYTES = 2 * 1024 * 1024;
const MAX_SITE_SCAN_DEPTH = 100;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeJoin(prefix: string, name: string): string {
  return prefix && prefix !== "." ? `${prefix}/${name}` : name;
}

function hasLegacyAppsSegment(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => segment.toLowerCase() === LEGACY_APPS_SEGMENT);
}

function sitePathAllowed(path: string): { ok: true } | { ok: false; reason: string } {
  if (hasLegacyAppsSegment(path)) {
    return { ok: false, reason: `site tools do not operate on legacy ${LEGACY_APPS_SEGMENT} paths` };
  }
  return { ok: true };
}

function isIgnoredSitePath(path: string): boolean {
  if (!path) return false;
  if (hasIgnoredSegment(path) || hasLegacyAppsSegment(path)) return true;
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => SITE_SCAN_IGNORED_NAMES.has(segment.toLowerCase()));
}

function siteTitleFromPath(root: string): string {
  const name = basename(root) || "Site";
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function packageNameFromPath(root: string): string {
  const name = basename(root) || "site";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "site";
}

function readPackageScripts(pkg: PackageJson | null): SiteScripts {
  if (!pkg || !isRecord(pkg.scripts)) return {};
  const scripts: SiteScripts = {};
  for (const key of [
    "predev",
    "dev",
    "postdev",
    "prestart",
    "start",
    "poststart",
    "build",
  ] as const) {
    const value = pkg.scripts[key];
    if (typeof value === "string" && value.trim()) scripts[key] = value;
  }
  return scripts;
}

function configString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[key];
  return typeof found === "string" && found.trim() ? found : undefined;
}

// Mirrors workspace-core's safeRelativeConfigPath (packages/workspace-core/src/sites.ts):
// a configured dohc.json path must be relative, not escape its own segments
// with "..", and not embed a NUL byte. The two detectors read the same
// dohc.json field, so an invalid value must be rejected the same way in both
// (#853 round-10 finding 10) — even though safeResolve is the real boundary
// once the value is joined with the site root and read from disk.
// Windows silently drops a segment's trailing dots/spaces, so "foo/.. " reads
// as "foo/..". Compare the alias, not the literal, or that spelling would
// pass this check yet still walk out of the site root once resolved.
function stripConfigPathAliasSuffix(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}

function isSafeRelativeConfigPath(value: string): boolean {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\")) {
    return false;
  }
  if (value.includes("\0")) return false;
  const segments = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return false;
  const aliasSegments = segments.map(stripConfigPathAliasSuffix);
  return !aliasSegments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function normalizedConfigPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

// Reads and validates config.preview.entry the same way workspace-core's
// parsePreview does, so a site with a configured entry is detected with the
// same value regardless of which detector runs.
function configuredPreviewEntry(
  config: RawDohcSiteConfig | null,
  path: string,
  diagnostics: SiteDiagnostic[],
): string | undefined {
  const preview = config?.preview;
  if (!isRecord(preview) || preview.entry === undefined) return undefined;
  const raw = preview.entry;
  const valid = typeof raw === "string" && raw.trim() !== "" && isSafeRelativeConfigPath(raw);
  if (!valid) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-preview-entry",
      path,
      message:
        typeof raw === "string" && raw.trim() !== ""
          ? "dohc.json preview.entry must be a relative workspace path, not '.', './', or an empty path."
          : "dohc.json preview.entry must be a non-empty string.",
    });
    return undefined;
  }
  return normalizedConfigPath(raw);
}

// Joins a configured entry under the site root, mirroring desktop's
// entryPathFor (apps/desktop/src/workspaces/sitePackage.ts): a value the
// author already spelled starting with the site root is used as-is instead
// of being prefixed twice.
function siteEntryPathFor(root: string, entry: string): string {
  if (root && (entry === root || entry.startsWith(`${root}/`))) return entry;
  return relativeJoin(root, entry);
}

async function readJsonDetailed<T>(
  absolute: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(absolute, "utf8")) as T };
  } catch (error) {
    return { ok: false, reason: failureReason(error, "invalid JSON") };
  }
}

async function detectSiteAt(ctx: ToolContext, absolute: string, root: string): Promise<WorkspaceSite | null> {
  let dirents;
  try {
    dirents = await readdir(absolute, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = new Set(dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name));
  const directories = new Set(
    dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name),
  );
  const allNames = new Set([...files, ...directories]);
  const diagnostics: SiteDiagnostic[] = [];
  const configPath = files.has("dohc.json") ? relativeJoin(root, "dohc.json") : undefined;
  let config: RawDohcSiteConfig | null = null;
  if (configPath) {
    const parsed = await readJsonDetailed<RawDohcSiteConfig>(join(ctx.root, configPath));
    if (!parsed.ok) {
      diagnostics.push({
        severity: "error",
        code: "invalid_dohc_json",
        path: configPath,
        message: parsed.reason,
      });
    } else if (!isRecord(parsed.value)) {
      // Valid JSON, but not an object (e.g. `[]`) — matches workspace-core's
      // parseDohcSiteConfig shape check (packages/workspace-core/src/sites.ts),
      // same code and message, so both detectors agree on this input (#853
      // round-11 finding 14). A bare JSON.parse cast would otherwise accept
      // this as a well-formed config with no diagnostic at all.
      diagnostics.push({
        severity: "error",
        code: "invalid-config",
        path: configPath,
        message: "dohc.json must contain a JSON object.",
      });
    } else {
      config = parsed.value;
    }
  }

  let pkg: PackageJson | null = null;
  if (files.has("package.json")) {
    const parsed = await readJsonDetailed<PackageJson>(join(absolute, "package.json"));
    if (!parsed.ok) {
      diagnostics.push({
        severity: "error",
        code: "invalid_package_json",
        path: relativeJoin(root, "package.json"),
        message: parsed.reason,
      });
    } else if (!isRecord(parsed.value)) {
      // Mirrors workspace-core's parsePackageJson shape check — same code and
      // message as the shared parser's non-object case (#853 round-11 finding 14).
      diagnostics.push({
        severity: "error",
        code: "invalid-package-json",
        path: relativeJoin(root, "package.json"),
        message: "package.json must contain a JSON object.",
      });
    } else {
      pkg = parsed.value;
    }
  }

  const scripts = readPackageScripts(pkg);
  const configPreviewCommand = configString(config?.preview, "command");
  const configPreviewMode = configString(config?.preview, "mode");
  const configuredPreviewMode =
    configPreviewMode === "static" ||
    configPreviewMode === "dev" ||
    configPreviewMode === "build"
      ? configPreviewMode
      : undefined;
  if (configPreviewCommand) {
    if (configPreviewMode === "static" || configPreviewMode === "build") {
      diagnostics.push({
        severity: "warning",
        code: "unsupported-preview-command-mode",
        path: configPath ?? relativeJoin(root, "dohc.json"),
        message:
          "Configured preview commands run only in dev mode. Static and build previews use the site's entry file or build output.",
      });
    } else {
      scripts.dev = configPreviewCommand;
    }
  }
  const configBuildCommand = configString(config?.build, "command");
  if (configBuildCommand) scripts.build = configBuildCommand;
  const configuredEntry = configuredPreviewEntry(
    config,
    configPath ?? relativeJoin(root, "dohc.json"),
    diagnostics,
  );

  const frameworkConfig = frameworkConfigName(files);
  const hasIndex = files.has("index.html");
  const hasPackageSignal =
    files.has("package.json") &&
    (Object.keys(scripts).length > 0 || Boolean(frameworkConfig) || hasWebDependency(pkg));
  // A directory ACTUALLY found on disk vs. the configured build.output PATH
  // (a claim, whether or not anything was ever built there) are different
  // signals — workspace-core's hasIndependentWebsiteSignal only accepts the
  // former as the independent signal that overrides an explicit non-site
  // type declaration; its own doc comment explains why (an explicitly
  // non-site config's own build.output claim can't override its own type).
  // Both detectors have to agree on that rule for the SAME input. A bare
  // directory presence isn't enough EITHER: workspace-core only counts a
  // build output as DETECTED when it holds a real <output>/index.html
  // artifact, the same check builtEntry (below) needs — one pass computes
  // both instead of two separate stat sweeps.
  const detectedBuildOutputs: string[] = [];
  let builtEntry: string | undefined;
  for (const name of SITE_BUILD_OUTPUT_NAMES) {
    if (!directories.has(name)) continue;
    const candidate = join(absolute, name, "index.html");
    if (!(await stat(candidate).catch(() => null))) continue;
    detectedBuildOutputs.push(name);
    if (builtEntry === undefined) builtEntry = relativeJoin(relativeJoin(root, name), "index.html");
  }
  // Same safe-relative-path validation as workspace-core's parseBuild — an
  // absolute path, a traversal, or a Windows-alias traversal in
  // build.output gets the SAME invalid-build-output diagnostic and is
  // dropped, not returned as an unsafe planned output for build_site/
  // test_site to act on.
  const rawConfiguredBuildOutput = configString(config?.build, "output");
  const configuredBuildOutput = rawConfiguredBuildOutput
    ? safeRelativeConfigPath(rawConfiguredBuildOutput)
    : undefined;
  if (rawConfiguredBuildOutput && !configuredBuildOutput) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-build-output",
      path: configPath ?? relativeJoin(root, "dohc.json"),
      message: "dohc.json build.output must be a relative workspace path, not '.', './', or an empty path.",
    });
  }
  const buildOutputs = [configuredBuildOutput, ...detectedBuildOutputs].filter(
    (output): output is string => typeof output === "string" && output.length > 0,
  );
  const uniqueBuildOutputs = [...new Set(buildOutputs)];
  const explicitNonSite = config?.type !== undefined && config.type !== "site";

  if (
    explicitNonSite &&
    !hasIndex &&
    !hasPackageSignal &&
    !frameworkConfig &&
    detectedBuildOutputs.length === 0
  ) {
    return null;
  }
  if (explicitNonSite) {
    diagnostics.push({
      severity: "warning",
      code: "unexpected_dohc_type",
      path: configPath ?? relativeJoin(root, "dohc.json"),
      message: "dohc.json has website signals but its type is not \"site\".",
    });
  }

  if (!configPath && !hasIndex && !hasPackageSignal && !frameworkConfig && uniqueBuildOutputs.length === 0) {
    return null;
  }

  const kind: SiteKind = configPath ? "configured" : hasPackageSignal || frameworkConfig ? "package" : "static";
  const confidence: SiteConfidence =
    configPath && diagnostics.every((diagnostic) => diagnostic.severity !== "error")
      ? "high"
      : hasIndex && (hasPackageSignal || frameworkConfig)
        ? "high"
        : hasIndex || hasPackageSignal || frameworkConfig
          ? "medium"
          : "low";
  const configuredTitle = typeof config?.title === "string" && config.title.trim() ? config.title : undefined;
  const packageTitle = typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  const entry = configuredEntry
    ? siteEntryPathFor(root, configuredEntry)
    : hasIndex
      ? relativeJoin(root, "index.html")
      : builtEntry;
  const packageManager = packageManagerFromFiles(allNames, pkg);

  return {
    root,
    title: configuredTitle ?? packageTitle ?? siteTitleFromPath(root),
    kind,
    confidence,
    ...(entry ? { entry } : {}),
    ...(packageManager ? { packageManager } : {}),
    scripts,
    ...(configuredPreviewMode ? { configuredPreviewMode } : {}),
    buildOutputs: uniqueBuildOutputs,
    ...(configPath ? { configPath } : {}),
    diagnostics,
  };
}

export async function detectSites(
  ctx: ToolContext,
  args: { path?: string; maxDepth?: number } = {},
): Promise<{ ok: true; sites: WorkspaceSite[]; count: number; detector: "mcp-local" } | { ok: false; reason: string }> {
  const start =
    args.path && args.path.trim().length > 0
      ? await safeResolve(ctx, args.path, "read")
      : { ok: true as const, absolute: ctx.root, normalized: "", realRelative: "" };
  if (!start.ok) return { ok: false as const, reason: start.reason };
  // Where the scan really lands decides the rule (#638): `sites -> .apps`
  // spells an ordinary folder and reads the legacy tree site tools disown.
  const allowed = sitePathAllowed(start.realRelative);
  if (!allowed.ok) return allowed;

  const info = await lstat(start.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `path not found: ${args.path ?? "."}` };
  if (!info.isDirectory()) return { ok: false as const, reason: `not a directory: ${args.path ?? "."}` };

  const maxDepth = Math.min(12, Math.max(0, Math.floor(args.maxDepth ?? 5)));
  const sites: WorkspaceSite[] = [];
  async function walk(absolute: string, root: string, depth: number): Promise<void> {
    if (isIgnoredSitePath(root)) return;
    const site = await detectSiteAt(ctx, absolute, root);
    if (site) sites.push(site);
    if (depth >= maxDepth) return;

    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
      const childRoot = relativeJoin(root, dirent.name);
      if (isIgnoredSitePath(childRoot)) continue;
      await walk(join(absolute, dirent.name), childRoot, depth + 1);
    }
  }

  await walk(start.absolute, start.normalized, 0);
  sites.sort((a, b) => a.root.localeCompare(b.root));
  return { ok: true as const, sites, count: sites.length, detector: "mcp-local" };
}

export async function createSite(
  ctx: ToolContext,
  args: { path: string; title?: string; withDohcJson?: boolean },
) {
  const root = await safeResolve(ctx, args.path);
  if (!root.ok) return { ok: false as const, reason: root.reason };
  if (!root.normalized) return { ok: false as const, reason: "site path must name a folder" };
  const allowed = sitePathAllowed(root.realRelative);
  if (!allowed.ok) return allowed;
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;

  const existing = await lstat(root.absolute).catch(() => null);
  if (existing && !existing.isDirectory()) {
    return { ok: false as const, reason: `site path is not a directory: ${root.normalized}` };
  }
  if (existing) {
    const entries = await readdir(root.absolute);
    if (entries.length > 0) {
      return { ok: false as const, reason: `site folder already exists and is not empty: ${root.normalized}` };
    }
  }

  const title = args.title?.trim() || siteTitleFromPath(root.normalized);
  const packageName = packageNameFromPath(root.normalized);
  const files = [
    {
      path: relativeJoin(root.normalized, "index.html"),
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main>
      <p class="eyebrow">Fresh Site</p>
      <h1>${escapeHtml(title)}</h1>
      <p>A clean local page, ready for the shape of the work.</p>
    </main>
    <script type="module" src="./script.js"></script>
  </body>
</html>
`,
    },
    {
      path: relativeJoin(root.normalized, "styles.css"),
      content: `:root {
  color: #151515;
  background: #f7f6f1;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

main {
  width: min(720px, calc(100vw - 48px));
}

.eyebrow {
  margin: 0 0 12px;
  color: #66635d;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: 4rem;
  line-height: 0.96;
}

p {
  max-width: 56ch;
  font-size: 1.08rem;
  line-height: 1.6;
}

@media (max-width: 640px) {
  h1 {
    font-size: 2.25rem;
  }
}
`,
    },
    {
      path: relativeJoin(root.normalized, "script.js"),
      content: `document.documentElement.dataset.siteReady = "true";
`,
    },
    {
      path: relativeJoin(root.normalized, "scripts/build-static.mjs"),
      content: `import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const file of ["index.html", "styles.css", "script.js"]) {
  if (existsSync(file)) await copyFile(file, \`dist/\${file}\`);
}
`,
    },
    {
      path: relativeJoin(root.normalized, "package.json"),
      content: `${JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          engines: {
            node: ">=14.8.0",
          },
          scripts: {
            dev: "serve . --listen 127.0.0.1:4173",
            build: "node scripts/build-static.mjs",
            preview: "serve dist --listen 127.0.0.1:4173",
          },
          devDependencies: {
            serve: "14.2.6",
          },
        },
        null,
        2,
      )}\n`,
    },
    ...(args.withDohcJson === false
      ? []
      : [
          {
            path: relativeJoin(root.normalized, "dohc.json"),
            content: `${JSON.stringify(
              {
                type: "site",
                title,
                preview: { mode: "static", entry: "index.html" },
                build: { command: "npm run build", output: "dist" },
              },
              null,
              2,
            )}\n`,
          },
        ]),
  ];

  const resolvedFiles = [];
  for (const file of files) {
    const resolved = await safeResolve(ctx, file.path);
    if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
    const fileAllowed = sitePathAllowed(resolved.realRelative);
    if (!fileAllowed.ok) return fileAllowed;
    if (
      resolved.normalized !== root.normalized &&
      !resolved.normalized.startsWith(`${root.normalized}/`)
    ) {
      return { ok: false as const, reason: `not inside site: ${file.path}` };
    }
    if (await lstat(resolved.absolute).catch(() => null)) {
      return { ok: false as const, reason: `file already exists: ${resolved.normalized}` };
    }
    resolvedFiles.push({ ...file, ...resolved });
  }

  let visibleMutationStarted = false;
  try {
    await mkdir(root.absolute, { recursive: true });
    if (!existing) visibleMutationStarted = true;
    for (const file of resolvedFiles) {
      const parentDir = dirname(file.absolute);
      const createdParent = await mkdir(parentDir, { recursive: true });
      if (createdParent) visibleMutationStarted = true;
      await writeFileAtomicallyForTool(ctx, file.normalized, file.content, { overwrite: false });
      visibleMutationStarted = true;
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to create site: ${root.normalized}`)
        : failureReason(error, `failed to create site: ${root.normalized}`),
    };
  }
  return {
    ok: true as const,
    siteRoot: root.normalized,
    files: resolvedFiles.map((file) => file.normalized),
    ...(await recordedChangeFields(ctx)),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function resolveSiteRoot(ctx: ToolContext, siteRoot: string) {
  const root = await safeResolve(ctx, siteRoot, "read");
  if (!root.ok) return root;
  // Mounted shares (shared-with-me/) are readable, but site tools execute
  // or mutate the site (test/build/preview/publish) — running
  // someone else's shared code with workspace access is refused. Copying
  // the site into the user's own files makes it runnable. The check is the
  // shared case-insensitive/alias-normalizing predicate, NOT a literal
  // compare: normalized paths preserve casing, and "Shared-With-Me/…" names
  // the same directory on case-insensitive filesystems (CodeRabbit). Both
  // gates read the RESOLVED path (#638): reads may enter shared-with-me, so
  // safeResolve lets an alias of it through, and judging the spelling would
  // let `mine -> shared-with-me/alex` run someone else's shared code.
  if (isSharedWithMePath(root.realRelative)) {
    return {
      ok: false as const,
      reason: `site root is a mounted share (read-only): ${siteRoot} — copy it into your own files to run it`,
    };
  }
  const allowed = sitePathAllowed(root.realRelative);
  if (!allowed.ok) return allowed;
  const info = await lstat(root.absolute).catch(() => null);
  if (!info) return { ok: false as const, reason: `site root not found: ${siteRoot}` };
  if (!info.isDirectory()) return { ok: false as const, reason: `site root is not a directory: ${siteRoot}` };
  return root;
}

export async function testSite(ctx: ToolContext, args: { siteRoot: string }) {
  const root = await resolveSiteRoot(ctx, args.siteRoot);
  if (!root.ok) return root;
  const site = await detectSiteAt(ctx, root.absolute, root.normalized);
  if (!site) return { ok: false as const, reason: `not a detected site: ${root.normalized}` };

  const checks: SiteCheck[] = [];
  checks.push({
    name: "detected-site",
    ok: true,
    path: root.normalized,
    message: `${site.kind} site detected with ${site.confidence} confidence.`,
  });
  for (const diagnostic of site.diagnostics) {
    checks.push({
      name: diagnostic.code,
      ok: diagnostic.severity !== "error",
      path: diagnostic.path,
      message: diagnostic.message,
    });
  }

  if (site.entry) {
    const entry = await safeResolve(ctx, site.entry, "read");
    const exists = entry.ok && Boolean(await lstat(entry.absolute).catch(() => null));
    checks.push({
      name: "entry-file",
      ok: exists,
      path: site.entry,
      message: exists ? "Entry file exists." : "Entry file is missing.",
    });
  } else if (!site.scripts.dev && !site.scripts.start && !site.scripts.build) {
    checks.push({
      name: "entry-or-script",
      ok: false,
      path: root.normalized,
      message: "Site needs an index.html entry or a package script.",
    });
  }

  const legacyImport = await findLegacyAppImport(root.absolute, root.normalized);
  checks.push(
    legacyImport
      ? {
          name: "no-legacy-sdk-import",
          ok: false,
          path: legacyImport.path,
          message:
            legacyImport.reason === "too-large"
              ? "Site source is too large for MCP static validation."
              : "Sites must use normal web files or @dohc/sdk, not the legacy app SDK.",
        }
      : {
          name: "no-legacy-sdk-import",
          ok: true,
          message: "No legacy app SDK import found in scanned site source.",
        },
  );

  const ok = checks.every((check) => check.ok);
  return { ok, site, checks };
}

async function findLegacyAppImport(
  absolute: string,
  root: string,
): Promise<{ path: string; reason: "legacy-import" | "too-large" } | null> {
  let totalBytes = 0;
  async function walk(
    currentAbsolute: string,
    currentRoot: string,
    depth: number,
  ): Promise<{ path: string; reason: "legacy-import" | "too-large" } | null> {
    if (depth > MAX_SITE_SCAN_DEPTH) return null;
    if (isIgnoredSitePath(currentRoot)) return null;
    let dirents;
    try {
      dirents = await readdir(currentAbsolute, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dirent of dirents) {
      const rel = relativeJoin(currentRoot, dirent.name);
      if (dirent.isSymbolicLink() || isIgnoredSitePath(rel)) continue;
      const child = join(currentAbsolute, dirent.name);
      if (dirent.isDirectory()) {
        const found = await walk(child, rel, depth + 1);
        if (found) return found;
        continue;
      }
      if (!dirent.isFile() || !SITE_SOURCE_EXTENSIONS.has(fileExtension(dirent.name))) continue;
      const info = await stat(child);
      if (totalBytes + info.size > MAX_SITE_TEST_BYTES) {
        return { path: rel, reason: "too-large" };
      }
      totalBytes += info.size;
      if (hasLegacyAppImport(await readFile(child, "utf8"))) {
        return { path: rel, reason: "legacy-import" };
      }
    }
    return null;
  }
  return walk(absolute, root, 0);
}

function fileExtension(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}

export async function buildSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  const command = site.scripts.build;
  const output = site.buildOutputs[0] ?? (command ? "dist" : site.root);
  return {
    ok: true as const,
    status: command ? "planned" : "static-ready",
    siteRoot: site.root,
    command,
    output,
    message: command
      ? "Build command detected. MCP build execution is not wired yet; run this command in the site folder."
      : "No build command detected; the site can be previewed directly as static files.",
    checks: tested.checks,
  };
}

function previewModesForSite(site: WorkspaceSite) {
  const modes = [];
  if (site.entry) {
    modes.push({ mode: "static" as const, entry: site.entry });
  }
  if (site.scripts.dev || site.scripts.start) {
    modes.push({
      mode: "dev" as const,
      command: site.scripts.dev ? "dev" : "start",
      script: site.scripts.dev ?? site.scripts.start,
      packageManager: site.packageManager ?? "npm",
    });
  }
  if (site.scripts.build || site.buildOutputs.length > 0) {
    modes.push({
      mode: "build" as const,
      command: site.scripts.build,
      output: site.buildOutputs[0] ?? "dist",
      packageManager: site.packageManager ?? "npm",
    });
  }
  return modes;
}

export async function previewSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  const modes = previewModesForSite(site);
  return {
    ok: true as const,
    siteRoot: site.root,
    modes,
    message:
      modes.length > 0
        ? "Open this site in Sites to run the preview."
        : "No preview mode is available yet.",
    checks: tested.checks,
  };
}

export async function publishSite(ctx: ToolContext, args: { siteRoot: string }) {
  const tested = await testSite(ctx, args);
  if (!tested.ok) return tested;
  const site = tested.site;
  return {
    ok: false as const,
    status: "review-required",
    siteRoot: site.root,
    reason:
      "Site publish/share is a dohc Cloud boundary and is not wired in this local MCP tool yet.",
    review: {
      siteRoot: site.root,
      modes: previewModesForSite(site),
      includesSharedWithMe: isSharedWithMePath(site.root),
    },
    checks: tested.checks,
  };
}

// --- dohc_import_data -------------------------------------------------------

// A VISIBLE user database under BOTH spellings. The strategy is read off the
// name, so an alias carries its own: `records.sqlite -> notes/data.sqlite-wal`
// spells a database while the bytes are a sidecar. Both names must qualify.
function isVisibleDatabase(resolved: { normalized: string; realRelative: string }): boolean {
  return (
    databaseSyncStrategy(resolved.normalized) === "operation-log" &&
    databaseSyncStrategy(resolved.realRelative) === "operation-log"
  );
}

// Imports a delimited/structured source into a NEW visible .sqlite, written
// safely under the root. Refuses a hidden-internal (.dohc) or sidecar target —
// only a visible user database is a valid import destination.
export async function importData(
  ctx: ToolContext,
  args: { sourcePath: string; databasePath: string; tableName: string },
) {
  const sourceRel = await safeResolve(ctx, args.sourcePath, "read");
  if (!sourceRel.ok) return { ok: false as const, reason: sourceRel.reason };
  // Same secret floor as read/search: an import is a read of the source,
  // and importing a secret-classified file (".env.csv", mounted or local)
  // into a visible database would launder its contents past the denial.
  if (isSecretResolvedPath(sourceRel)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  const dbRel = await safeResolve(ctx, args.databasePath);
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  const recordable = await ensureRecordable(ctx);
  if (recordable) return recordable;
  if (!isVisibleDatabase(dbRel)) {
    return { ok: false as const, reason: `not a visible database target: ${args.databasePath}` };
  }

  const body = await readFile(sourceRel.absolute, "utf8");
  const { createSqliteEngine } = await import("@dohc/sqlite-worker");
  const engine = await createSqliteEngine();
  const result = await engine.importData({
    name: args.sourcePath,
    mediaType: mediaTypeForPath(args.sourcePath) ?? "text/plain",
    body,
    tableName: args.tableName,
  });
  if (!result.ok) return { ok: false as const, reason: `${result.code}: ${result.message}` };

  const parentDir = dirname(dbRel.absolute);
  let visibleMutationStarted = false;
  try {
    const createdParent = await mkdir(parentDir, { recursive: true });
    if (createdParent) visibleMutationStarted = true;
    const dbBytes = Buffer.from(result.bytesBase64, "base64");
    await writeFileAtomicallyForTool(ctx, dbRel.normalized, dbBytes, { overwrite: false });
    visibleMutationStarted = true;
  } catch (error) {
    return {
      ok: false as const,
      reason: visibleMutationStarted
        ? mutationRetainedReason(error, `failed to write import: ${dbRel.normalized}`)
        : failureReason(error, `failed to write import: ${dbRel.normalized}`),
    };
  }
  return {
    ok: true as const,
    path: dbRel.normalized,
    tableName: result.tableName,
    rowCount: result.rowCount,
    ...(await recordedChangeFields(ctx)),
  };
}

// --- dohc_query_database ----------------------------------------------------

const MAX_QUERY_ROWS = 1000;

// Opens a visible database READ-ONLY and returns a bounded row window. Only a
// single read-only SELECT is honored; anything else is refused.
export async function queryDatabase(
  ctx: ToolContext,
  args: { databasePath: string; sql: string },
) {
  // Registered read-only (SELECT enforcement below): a mounted share's
  // database is queryable like any other readable file.
  const dbRel = await safeResolve(ctx, args.databasePath, "read");
  if (!dbRel.ok) return { ok: false as const, reason: dbRel.reason };
  // Secret floor before any bytes open: a secret-classified database name
  // (".env.sqlite", mounted or local) is denied like any other secret read.
  if (isSecretResolvedPath(dbRel)) {
    return { ok: false as const, reason: SECRET_READ_DENIED_REASON };
  }
  // Only a VISIBLE user database (parity with import_data): never a sidecar,
  // hidden internal, or a non-db file that merely contains SQLite bytes.
  if (!isVisibleDatabase(dbRel)) {
    return { ok: false as const, reason: `not a visible database: ${args.databasePath}` };
  }
  if (!isReadOnlySelect(args.sql)) {
    return { ok: false as const, reason: "only a single read-only SELECT is allowed" };
  }
  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(dbRel.absolute, { readOnly: true });
  try {
    // Bound the work the DB does, not just the result we keep: wrap the SELECT
    // so SQLite stops after MAX_QUERY_ROWS rather than materializing a huge or
    // unbounded result (e.g. a giant join or randomblob) before we slice.
    const bounded = `select * from (${stripTrailingSemicolon(args.sql)}) limit ${MAX_QUERY_ROWS}`;
    const rows = db.prepare(bounded).all();
    return { ok: true as const, rows };
  } catch (cause) {
    return { ok: false as const, reason: cause instanceof Error ? cause.message : "query failed" };
  } finally {
    db.close();
  }
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
}

function isReadOnlySelect(sql: string): boolean {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) return false;
  // No second statement after the (optional) trailing semicolon.
  return !stripTrailingSemicolon(trimmed).includes(";");
}

// --- dohc_share -------------------------------------------------------------

// Sharing crosses a boundary, so this NEVER auto-applies. It routes through
// the liberal collaboration policy and returns needs-confirmation with the
// human-readable reason; only the desktop, with the user's explicit OK, applies
// the share.
export async function share(ctx: ToolContext, args: { path: string; scope: "public" | "workspace" }) {
  const resolved = await safeResolve(ctx, args.path);
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return {
    ok: true as const,
    status: "needs-confirmation" as const,
    boundaryCrossing: args.scope === "public" ? "public-share" : "private-to-shared",
    path: resolved.normalized,
    reason:
      "Sharing crosses a boundary — it waits for your explicit OK in dohc before anything is shared.",
  };
}

// --- dohc_resolve_conflict --------------------------------------------------

// Attempts a conservative three-way merge of a markdown conflict. A clean merge
// is returned as proposed content; an ambiguous one returns conflict so a human
// decides — never a silent overwrite.

// --- desktop-owned history and Chats ---------------------------------------
//
// MCP is a separate process and never opens the daemon-owned engine database.
// The desktop is the sole writer and applies workspace authorization plus chat
// identity before dispatching these CLI verbs.

export const DOHC_TRANSPORT_UNAVAILABLE_REASON =
  "dohc is not running. Open the dohc app to read workspace history or chats, or post chats.";

function cliFailureReason(error: unknown): string {
  if (error instanceof DohcCliError && error.message === "desktop app not running") {
    return DOHC_TRANSPORT_UNAVAILABLE_REASON;
  }
  return failureReason(error, DOHC_TRANSPORT_UNAVAILABLE_REASON);
}

async function requestCli<Verb extends CliVerb>(
  ctx: ToolContext,
  verb: Verb,
  args: Omit<Extract<CliRequestWithoutToken, { verb: Verb }>["args"], "cwd" | "actor">,
): Promise<CliResultByVerb[Verb] | { ok: false; reason: string }> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: {
      cwd: ctx.root,
      actor: "agent" as const,
      ...args,
    },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  try {
    const rawResult = ctx.request
      ? await ctx.request(request)
      : await sendCliRequest(request, { stateDir: ctx.home });
    return parseCliResult(verb, rawResult);
  } catch (error) {
    return { ok: false as const, reason: cliFailureReason(error) };
  }
}

export async function listFileChats(ctx: ToolContext, args: { path: string }) {
  return requestCli(ctx, "fileChats", args);
}

export async function readChat(ctx: ToolContext, args: { threadId: string }) {
  return requestCli(ctx, "chat", args);
}

// --- channels (PR 12/15 slice, WS-E) ----------------------------------------

// Channel discovery for agents: names, slugs, kinds, and each channel's
// threads (id + display title) so a follow-up reply/read has real ids to
// target. Writable MCP profiles ensure the workspace's default "general"
// channel on first use — the same rule the desktop applies. Read-only shared
// views list only existing channels so discovery never creates durable state.
export async function listChannels(ctx: ToolContext) {
  return requestCli(ctx, "channelsFull", {});
}

// Start a chat in a channel AS THE AGENT. `channel` accepts a channel id or
// a name/slug ("general", "#general", "Client ACME"). No title is required:
// untitled chats display their first-message snippet.
export async function startChannelChat(
  ctx: ToolContext,
  args: { channel: string; body: string; title?: string },
) {
  return requestCli(ctx, "startChannelChat", args);
}

export async function replyToChat(
  ctx: ToolContext,
  args: { threadId: string; body: string },
) {
  return requestCli(ctx, "replyToChat", args);
}

export function resolveConflict(args: { base: string; local: string; remote: string }) {
  const result = mergeMarkdown(args);
  return result.kind === "merged"
    ? { resolved: true as const, content: result.content }
    : {
        resolved: false as const,
        reason: "Both sides changed overlapping lines — kept both for a human to pick.",
      };
}

// --- dohc_open_in_dohc ------------------------------------------------------

// Returns the absolute path the desktop should surface (open/select). Path is
// contained first so it can never point outside the workspace.
export async function openInDohc(ctx: ToolContext, args: { path: string }) {
  // Opening is a read: mounted files open in dohc like any other file.
  const resolved = await safeResolve(ctx, args.path, "read");
  if (!resolved.ok) return { ok: false as const, reason: resolved.reason };
  return { ok: true as const, path: resolved.absolute, relativePath: resolved.normalized };
}

export { safeResolve };
