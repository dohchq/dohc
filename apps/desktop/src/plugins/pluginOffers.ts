import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { readPluginManifestFile } from "./pluginManifest";
import {
  errorMessage,
  isInside,
  removeStaging,
  renameWithWindowsRetry,
} from "./pluginShared";
import { EXCLUDED_SOURCE_NAMES } from "./pluginSourceSnapshot";

export interface OfferedPluginSource {
  directoryName: (typeof BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES)[number];
  displayName: string | null;
  description: string | null;
  publisher: string | null;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * @param existingPluginIds The manifest ids the workspace's plugin pipeline
 * already knows about — identity is the manifest id, not the directory a
 * plugin happens to live in, so `codex` copied to `plugins/my-codex` still
 * suppresses the Codex offer: adding a second `codex` would only degrade to
 * discovery's existing duplicate-id handling, never a clean install.
 */
export async function listOfferedPlugins(
  builtinPluginsRoot: string,
  workspaceRoot: string,
  existingPluginIds: ReadonlySet<string>,
): Promise<OfferedPluginSource[]> {
  const offers: OfferedPluginSource[] = [];
  for (const directoryName of BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES) {
    if (existingPluginIds.has(directoryName)) continue;
    const target = join(workspaceRoot, "plugins", directoryName);
    try {
      if (await pathExists(target)) continue;
    } catch {
      // Only a confirmed missing workspace path is safe to offer.
      continue;
    }

    const sourceRoot = join(builtinPluginsRoot, directoryName);
    const manifest = await readPluginManifestFile(sourceRoot);
    if (!manifest.ok) {
      // A built-in ships with dohc itself — dev repo path or packaged
      // extraResources — so its manifest is never optional the way a
      // hand-authored plugin's is. Silently omitting it here would read as
      // "nothing to offer" instead of "the packaged install is broken";
      // propagating it as a real failure surfaces the retryable offers-error
      // state instead of a falsely reassuring empty list.
      throw new Error(
        `The built-in ${directoryName} plugin's manifest could not be read: ` +
          manifest.diagnostics.join(" "),
      );
    }
    offers.push({
      directoryName,
      displayName: manifest.manifest.displayName ?? null,
      description: manifest.manifest.description ?? null,
      publisher: manifest.manifest.publisher ?? null,
    });
  }
  return offers;
}

/**
 * The plugin whose discovery entry lost a duplicate-id collision to
 * `directoryName`'s own copy, if any — read from `supersededPluginId`, the
 * discovery layer's own structured marker, never from scanning diagnostic
 * text. That text is bounded and re-worded for display, so a record whose
 * diagnostics merely happen to CONTAIN a similar-looking phrase for an
 * unrelated reason must never read as a real collision.
 */
export function findDisplacedByAdd<
  T extends { directoryName: string; supersededPluginId: string | null },
>(plugins: readonly T[], directoryName: string): T | undefined {
  return plugins.find(
    (entry) =>
      entry.directoryName !== directoryName &&
      entry.supersededPluginId === directoryName,
  );
}

export class OfferedPluginAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferedPluginAddError";
  }
}

function isBuiltinDriverPlugin(
  directoryName: string,
): directoryName is (typeof BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES)[number] {
  return (BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES as readonly string[]).includes(
    directoryName,
  );
}

// The renderer composes the full sentence ("dohc could not add <name>. ...");
// every error here states only the cause, never repeats that prefix.
function existingTargetError(directoryName: string): OfferedPluginAddError {
  return new OfferedPluginAddError(
    `plugins/${directoryName} already exists in this workspace.`,
  );
}

function toOfferedPluginAddError(error: unknown): OfferedPluginAddError {
  return error instanceof OfferedPluginAddError
    ? error
    : new OfferedPluginAddError(errorMessage(error));
}

/**
 * Verifies (and creates, if absent) one path segment, refusing the moment it
 * is a symlink/junction or its real location escapes `realParent`. Never
 * calls `mkdir` with `recursive: true` on a multi-level path: that follows
 * a symlink in every intermediate segment transparently, so a `plugins` or
 * `.dohc` planted as a junction into a synced workspace folder could
 * redirect a later create through it before any check ever ran. Calling this
 * once per level, always against the PREVIOUS level's own verified real
 * path, closes that gap — each new segment's immediate parent is already
 * known real and contained by the time this creates or inspects it.
 */
async function ensureContainedDirectory(
  path: string,
  realParent: string,
  label: string,
): Promise<string> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw new OfferedPluginAddError(
        `${label} at ${path} could not be inspected: ${errorMessage(error)}`,
      );
    }
    try {
      await mkdir(path);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OfferedPluginAddError(
          `${label} at ${path} could not be created: ${errorMessage(mkdirError)}`,
        );
      }
    }
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink()) {
    throw new OfferedPluginAddError(
      `${label} at ${path} is a symlink or junction; refusing to use it.`,
    );
  }
  if (!stats.isDirectory()) {
    throw new OfferedPluginAddError(`${label} at ${path} is not a directory.`);
  }
  const realDirectory = await realpath(path);
  if (!isInside(realParent, realDirectory)) {
    throw new OfferedPluginAddError(
      `${label} at ${path} resolves outside this workspace.`,
    );
  }
  return realDirectory;
}

/**
 * Publishes `staged` at `target`, refusing to silently replace anything
 * already there. A bare rename() cannot tell "nothing at target" from
 * "something raced this call here": POSIX rename() atomically REPLACES an
 * existing empty directory rather than failing, so a check-then-rename
 * sequence still clobbers whatever a concurrent creator placed at target in
 * the gap between the two. mkdir(target) is the one atomic claim Node
 * exposes — it fails EEXIST the instant anything (a real plugin, or another
 * concurrent add) already occupies the slot, before this ever touches it.
 * `false` means the claim lost that race; `target` is left exactly as this
 * call found it, for the caller to refuse over.
 *
 * A successful claim still has to be freed before the rename lands: Windows
 * refuses rename() onto ANY existing directory, even an empty one this call
 * just created and exclusively owns (verified empirically — MoveFileEx's
 * REPLACE_EXISTING flag is documented not to accept a directory name, and
 * throws EPERM in practice for both an empty and a populated destination).
 * Freeing the claim with rmdir immediately before the rename keeps one
 * sequence on every platform, at the cost of a narrow window between the
 * free and the rename that is far smaller than, and never silently
 * destructive like, the unconditional replace this replaces.
 */
async function publishStaged(staged: string, target: string): Promise<boolean> {
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  await rmdir(target);
  await renameWithWindowsRetry(staged, target, (error) => error);
  return true;
}

/**
 * @param existingPluginIds The workspace's current plugin ids, sampled
 * fresh right before this copy — not merely at the time the offer list was
 * loaded. A plugin can be discovered under a different directory between
 * an offer showing and this call landing (a rename, an agent's own copy, a
 * second add racing this one); identity is the manifest id, so this must be
 * the same check listOfferedPlugins already applies, re-run at write time
 * rather than trusted from a stale read.
 */
export async function addOfferedPlugin(params: {
  builtinPluginsRoot: string;
  workspaceRoot: string;
  directoryName: string;
  existingPluginIds: ReadonlySet<string>;
}): Promise<{ rootPath: string; identity: OfferedPluginIdentity }> {
  const { builtinPluginsRoot, workspaceRoot, directoryName, existingPluginIds } = params;
  if (!isBuiltinDriverPlugin(directoryName)) {
    throw new OfferedPluginAddError(
      `"${directoryName}" is not a built-in driver plugin.`,
    );
  }
  if (existingPluginIds.has(directoryName)) {
    throw new OfferedPluginAddError(
      `A plugin named "${directoryName}" already exists in this workspace.`,
    );
  }

  const realWorkspaceRoot = await realpath(workspaceRoot);
  const pluginsRoot = await ensureContainedDirectory(
    join(workspaceRoot, "plugins"),
    realWorkspaceRoot,
    "Plugins directory",
  );
  const target = join(pluginsRoot, directoryName);
  if (await pathExists(target)) throw existingTargetError(directoryName);

  // Staged under .dohc, never under plugins/: a mid-copy watcher batch would
  // otherwise list the staging directory itself as a phantom plugin
  // (discoverInstalledPlugins has no dot-prefix skip), and a crash between
  // the copy and the rename would strand it there for good. .dohc is on the
  // same volume as plugins/ (both live under workspaceRoot), so the rename
  // below stays atomic, and .dohc is already excluded from workspace
  // listing, capture, and plugin discovery.
  const dohcRoot = await ensureContainedDirectory(
    join(workspaceRoot, ".dohc"),
    realWorkspaceRoot,
    "Workspace metadata directory",
  );
  const stagingParent = await ensureContainedDirectory(
    join(dohcRoot, "plugin-offer-staging"),
    dohcRoot,
    "Plugin staging directory",
  );
  const staging = join(stagingParent, `${directoryName}-${randomUUID()}`);
  try {
    // The install pipeline's own source snapshot already rejects a symlink
    // or other non-regular entry with a proper diagnostic once this copy is
    // installed — duplicating that check here would only produce a second,
    // worse-worded rejection. fs.cp does not dereference by default, so a
    // hypothetical symlink in the built-in source lands inert (pointing
    // nowhere useful in the copy) rather than pulling in bytes from outside
    // the source tree.
    await cp(join(builtinPluginsRoot, directoryName), staging, {
      recursive: true,
      filter: (source) => !EXCLUDED_SOURCE_NAMES.has(basename(source)),
    });
    // Captured from the STAGING directory, before it is published — rename()
    // preserves the inode, so this identity remains valid for `target`
    // afterward. Reading it back off `target` after the rename would instead
    // let anything that lands at that path in the instant between the
    // rename and this read donate ITS identity to the value
    // removeAddedOfferedPlugin later trusts; staging is private to this call
    // the entire time it is being read, so nothing else can ever race it.
    const identity = await targetIdentity(staging);
    if (!(await publishStaged(staging, target))) {
      throw existingTargetError(directoryName);
    }
    return { rootPath: target, identity };
  } catch (error) {
    await removeStaging(staging).catch(() => undefined);
    throw toOfferedPluginAddError(error);
  }
}

/** Device + inode: the filesystem's own answer to "is this the same
 * directory entry", independent of what the path currently resolves to. */
export interface OfferedPluginIdentity {
  dev: number;
  ino: number;
}

async function targetIdentity(target: string): Promise<OfferedPluginIdentity> {
  const stats = await lstat(target);
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * Deletes what a successful addOfferedPlugin just placed at
 * `plugins/<directoryName>` — reserved for the caller's own post-copy
 * validity check, since a directory claiming the same manifest id can
 * appear between this copy landing and the caller's rediscovery rescan, a
 * race this module cannot close, only let the caller detect and unwind.
 *
 * A check on `target` followed by a SEPARATE delete stays racy no matter
 * how tight the gap: Node has no fd-bound recursive delete, so `plugins/`
 * (or the target itself) could still be swapped for a symlink/junction
 * between the check and the delete syscall actually running. This closes
 * that instead of narrowing it, by binding the delete to a RENAME: moving
 * `target` into `.dohc`'s own contained staging area is one atomic syscall
 * that only ever touches the directory ENTRY currently there — not a
 * symlink's target, and not wherever a parent swap redirects to once the
 * syscall has already completed. Only after that move does this verify the
 * STAGED item's device+inode against `identity` (captured the instant
 * addOfferedPlugin's own rename landed); a mismatch renames it straight
 * back to where it was and refuses, never deleting it. Only a confirmed
 * match is ever deleted, and always from the staging path this module
 * already verified — never from the original, still-swappable one.
 */
export async function removeAddedOfferedPlugin(params: {
  workspaceRoot: string;
  directoryName: string;
  identity: OfferedPluginIdentity;
}): Promise<void> {
  const { workspaceRoot, directoryName, identity } = params;
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const pluginsPath = join(workspaceRoot, "plugins");
  let pluginsStats;
  try {
    pluginsStats = await lstat(pluginsPath);
  } catch (error) {
    if (isMissing(error)) return; // Nothing to roll back.
    throw new OfferedPluginAddError(
      `Plugins directory at ${pluginsPath} could not be inspected: ${errorMessage(error)}`,
    );
  }
  if (pluginsStats.isSymbolicLink()) {
    throw new OfferedPluginAddError(
      `Plugins directory at ${pluginsPath} is a symlink or junction; refusing to remove plugins/${directoryName} through it.`,
    );
  }
  const realPluginsPath = await realpath(pluginsPath);
  if (!isInside(realWorkspaceRoot, realPluginsPath)) {
    throw new OfferedPluginAddError(
      `Plugins directory at ${pluginsPath} resolves outside this workspace; refusing to remove plugins/${directoryName} through it.`,
    );
  }

  const dohcRoot = await ensureContainedDirectory(
    join(workspaceRoot, ".dohc"),
    realWorkspaceRoot,
    "Workspace metadata directory",
  );
  const stagingRoot = await ensureContainedDirectory(
    join(dohcRoot, "plugin-offer-staging"),
    dohcRoot,
    "Plugin staging directory",
  );

  const target = join(pluginsPath, directoryName);
  const staged = join(stagingRoot, `remove-${directoryName}-${randomUUID()}`);
  try {
    // Identity, not wrapped: lets ENOENT (target already gone) be told
    // apart from a real failure below, before either is turned into an
    // OfferedPluginAddError.
    await renameWithWindowsRetry(target, staged, (error) => error);
  } catch (error) {
    if (isMissing(error)) return; // Already gone.
    throw toOfferedPluginAddError(error);
  }

  let stagedStats;
  try {
    stagedStats = await lstat(staged);
  } catch (error) {
    throw new OfferedPluginAddError(
      `plugins/${directoryName} could not be inspected after staging: ${errorMessage(error)}`,
    );
  }
  if (
    stagedStats.isSymbolicLink() ||
    stagedStats.dev !== identity.dev ||
    stagedStats.ino !== identity.ino
  ) {
    // Not what this request created. Putting it back is itself a write
    // through the same swappable `plugins/` path the forward move already
    // grabbed one entry away from — plugins/ could have been replaced with
    // a symlink/junction in the window since the check at the top of this
    // function ran, and the exact target slot could have been reoccupied in
    // the window since that forward move landed. Re-verifying containment,
    // and using the same claim-then-rename publish `addOfferedPlugin` uses
    // rather than a bare rename, catches both without narrowing either gap
    // to zero. Either failure leaves the content exactly where it safely
    // sits — staged, inside this module's own contained area — rather than
    // write it somewhere this call can no longer vouch for, or silently
    // replace whatever now occupies target.
    const strandedError = new OfferedPluginAddError(
      `plugins/${directoryName} no longer matches what this request created; its ` +
        `previous contents are stranded at ${relative(workspaceRoot, staged)} in ` +
        "this workspace rather than restored.",
    );
    const stillContained = await pluginsPathStillContained(pluginsPath, realWorkspaceRoot);
    if (!stillContained) throw strandedError;
    const restored = await publishStaged(staged, target).catch(() => false);
    if (!restored) throw strandedError;
    throw new OfferedPluginAddError(
      `plugins/${directoryName} no longer matches what this request created; refusing to remove it.`,
    );
  }
  await removeStaging(staged);
}

/** Re-checked immediately before a rollback writes back through
 * `plugins/`: the top-of-function check already ran once, but this
 * function's own forward move can take real time, and `plugins/` is a path
 * a rollback does not own the way the module's own staging area does. */
async function pluginsPathStillContained(
  pluginsPath: string,
  realWorkspaceRoot: string,
): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(pluginsPath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  try {
    return isInside(realWorkspaceRoot, await realpath(pluginsPath));
  } catch {
    return false;
  }
}
