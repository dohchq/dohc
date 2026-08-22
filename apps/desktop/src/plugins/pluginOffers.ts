import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { BUILTIN_DRIVER_PLUGIN_DIRECTORY_NAMES } from "../ipc/channels";
import { readPluginManifestFile } from "./pluginManifest";
import {
  errorMessage,
  isInside,
  removeStaging,
  renameWithWindowsRetry,
} from "./pluginShared";
import { EXCLUDED_SOURCE_NAMES, hashPluginSourceFiles } from "./pluginSourceSnapshot";

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
 * Removes `target` only after confirming it is still exactly the empty
 * claim publishStaged's own mkdir() created — same device+inode as the
 * moment that mkdir() landed, the same identity discipline
 * removeAddedOfferedPlugin's rollback already uses, not merely "looks like
 * an empty directory right now": a dev+ino match is the filesystem's own
 * answer to "is this the same directory entry", immune to a symlink or a
 * fresh directory of the same name that raced in and happens to also be
 * empty. A verification failure (gone already, no longer empty, no longer
 * a plain directory, or a genuinely different entry) means this call can
 * no longer vouch for what is there, so it leaves it alone rather than
 * delete something it cannot account for; the caller's own error still
 * propagates either way, so a genuinely stray claim is at worst inert,
 * never silently swallowed as success.
 *
 * `identity` is null only when targetIdentity() itself refused to capture
 * one (a filesystem reporting no real device/inode) — the "not symlink, is
 * a directory, is empty" checks below are what this call still has to lean
 * on in that case, weaker than a dev+ino match but still real evidence,
 * never a blind delete.
 */
async function removeOwnedEmptyClaim(
  target: string,
  identity: OfferedPluginIdentity | null,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(target, { bigint: true });
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  if (identity && (stats.dev !== identity.dev || stats.ino !== identity.ino)) return;
  let entries;
  try {
    entries = await readdir(target);
  } catch {
    return;
  }
  if (entries.length > 0) return;
  // Node has no dirfd-relative rmdir, so this still names `target` by path
  // rather than the handle just verified — the same platform floor as the
  // rollback's move-into-staging, with strictly smaller harm here: the
  // worst case is deleting a competitor's just-created EMPTY directory in
  // a microsecond window, never real content, and their own Add simply
  // refuses and can retry.
  await rmdir(target).catch(() => undefined);
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
 * What happens to a successful claim before the rename lands is platform-
 * specific:
 *
 * - POSIX: rename() replacing an existing EMPTY directory is exactly the
 *   safe case — and this call is the only one that could have created
 *   target, since mkdir() above is the atomic fail-on-exist claim. Renaming
 *   `staged` directly onto the still-held claim keeps a concurrent
 *   creator's own mkdir(target) failing for as long as this claim stands,
 *   never racing this rename for the slot.
 * - Windows: rename() refuses to land on ANY existing directory, even an
 *   empty one this call just created and exclusively owns (verified
 *   empirically — MoveFileEx's REPLACE_EXISTING flag is documented not to
 *   accept a directory name, and throws EPERM in practice for both an
 *   empty and a populated destination) — so the claim has to be freed with
 *   rmdir first. That reopens a narrow window a concurrent creator could
 *   land in, but the rename that follows FAILS LOUD when it does (the same
 *   EPERM, now because a real directory sits where an empty one was) —
 *   this reads as the claim having been lost, the same refusal as an
 *   outright EEXIST, never a silent clobber.
 *
 * On POSIX, a rename failure for any OTHER reason (disk full, a locked
 * file) leaves this call's own mkdir() claim behind — still empty, never
 * replaced. Left there, it reads as "occupied" forever: every later
 * listOfferedPlugins call and Add attempt sees a directory already at
 * target and refuses, with nothing left to clean it up. removeOwnedEmptyClaim
 * removes it before this rethrows, verifying first that it is still exactly
 * what this call created rather than removing it unconditionally.
 */
// Node has no dirfd-relative mkdir/rename, so this still names `target` by
// path rather than a handle bound to the `plugins/` this call's caller
// already verified — the same platform floor as the rollback's move-into-
// staging and the claim's own rmdir. Bounded here too: the worst case
// publishes dohc's own packaged plugin bytes at wherever a swapped-in
// junction points, never workspace content lost or private data disclosed.
async function publishStaged(staged: string, target: string): Promise<boolean> {
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  // Captured the instant the claim lands, before anything else can ever
  // observe it — removeOwnedEmptyClaim's own failure-path cleanup verifies
  // against this rather than trusting that whatever sits at `target` later
  // is still the same entry this mkdir() created. targetIdentity() can
  // itself refuse (an unverifiable filesystem identity) — the claim it was
  // reading already landed by then, so that failure gets the exact same
  // cleanup as a rejected rename, not a silently leaked claim.
  let claimIdentity: OfferedPluginIdentity;
  try {
    claimIdentity = await targetIdentity(target);
  } catch (error) {
    await removeOwnedEmptyClaim(target, null);
    throw error;
  }
  if (process.platform !== "win32") {
    try {
      await renameWithWindowsRetry(staged, target, (error) => error);
    } catch (error) {
      await removeOwnedEmptyClaim(target, claimIdentity);
      throw error;
    }
    return true;
  }
  await rmdir(target);
  try {
    await renameWithWindowsRetry(staged, target, (error) => error);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
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
}): Promise<{ rootPath: string; identity: OfferedPluginIdentity; contentHash: string }> {
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
    // The same reasoning as identity, for a question dev+ino cannot answer:
    // a directory's own inode never changes when a file inside it is
    // edited, so identity alone still matches an edited tree. Hashed from
    // staging for the same private-until-published reason identity is —
    // this is what the published copy looked like at the instant it became
    // real, so a later rollback can tell "unchanged" from "someone's real
    // work landed on it since" (#779-offers round 15 finding 3).
    const contentHash = (await hashPluginSourceFiles(staging)).sourceHash;
    if (!(await publishStaged(staging, target))) {
      throw existingTargetError(directoryName);
    }
    return { rootPath: target, identity, contentHash };
  } catch (error) {
    await removeStaging(staging).catch(() => undefined);
    throw toOfferedPluginAddError(error);
  }
}

/** Device + inode: the filesystem's own answer to "is this the same
 * directory entry", independent of what the path currently resolves to. */
export interface OfferedPluginIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * The moment this identity is captured is the ONLY point this module can
 * ever refuse an unverifiable one — every later comparison only ever
 * checks equality against what was captured here, so a bad value here
 * would make every later check vacuous rather than protective. bigint
 * stats avoid the precision loss plain Number stats risk for a large
 * inode number; dev or ino reading as zero means this filesystem is not
 * giving this module a real device/inode identity to track at all (some
 * network shares and virtual filesystems), and a zeroed identity would
 * match any other zeroed identity — the opposite of what this exists to
 * detect. Refusing here, not silently proceeding, is the whole point.
 */
async function targetIdentity(target: string): Promise<OfferedPluginIdentity> {
  const stats = await lstat(target, { bigint: true });
  if (stats.dev === 0n || stats.ino === 0n) {
    throw new OfferedPluginAddError(
      `${target} has no verifiable device or inode identity on this filesystem; refusing to continue without one.`,
    );
  }
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
 * syscall has already completed. Node has no dirfd-relative rename, so this
 * move still resolves `plugins/` by path rather than a handle verified at
 * the top of this function — a parent swap in that specific window is a
 * platform floor this cannot close, bounded because the harm is only ever
 * relocation into this module's own contained staging (never deletion, and
 * the identity check below still refuses to delete a mismatch). Only after
 * the move does this verify the STAGED item's device+inode against
 * `identity` (captured from the staging directory before addOfferedPlugin's
 * own publish rename, so it stays valid without ever being read off a path
 * anything else could still race into); a mismatch renames it straight
 * back to where it was and refuses, never deleting it. Only a confirmed
 * match is ever deleted, and always from the staging path this module
 * already verified — never from the original, still-swappable one.
 */
export async function removeAddedOfferedPlugin(params: {
  workspaceRoot: string;
  directoryName: string;
  identity: OfferedPluginIdentity;
  contentHash: string;
}): Promise<void> {
  const { workspaceRoot, directoryName, identity, contentHash } = params;
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
    stagedStats = await lstat(staged, { bigint: true });
  } catch (error) {
    throw new OfferedPluginAddError(
      `plugins/${directoryName} could not be inspected after staging: ${errorMessage(error)}`,
    );
  }
  // Restores `reason` fails on: putting it back is itself a write through
  // the same swappable `plugins/` path the forward move already grabbed one
  // entry away from — plugins/ could have been replaced with a
  // symlink/junction in the window since the check at the top of this
  // function ran, and the exact target slot could have been reoccupied in
  // the window since that forward move landed. Re-verifying containment,
  // and using the same claim-then-rename publish `addOfferedPlugin` uses
  // rather than a bare rename, catches both without narrowing either gap to
  // zero. Either failure leaves the content exactly where it safely sits —
  // staged, inside this module's own contained area — rather than write it
  // somewhere this call can no longer vouch for, or silently replace
  // whatever now occupies target.
  const restoreOrStrand = async (reason: string): Promise<never> => {
    const strandedError = new OfferedPluginAddError(
      `plugins/${directoryName} ${reason}; its previous contents are stranded at ` +
        `${relative(workspaceRoot, staged)} in this workspace rather than restored.`,
    );
    const stillContained = await pluginsPathStillContained(pluginsPath, realWorkspaceRoot);
    if (!stillContained) throw strandedError;
    const restored = await publishStaged(staged, target).catch(() => false);
    if (!restored) throw strandedError;
    throw new OfferedPluginAddError(`plugins/${directoryName} ${reason}; refusing to remove it.`);
  };

  if (
    stagedStats.isSymbolicLink() ||
    stagedStats.dev !== identity.dev ||
    stagedStats.ino !== identity.ino
  ) {
    // Not what this request created.
    await restoreOrStrand("no longer matches what this request created");
  }

  // Identity alone answers "is this the same directory entry", never "does
  // it still hold what this request put there" — a directory's own inode
  // does not change when a file inside it is edited. A rollback can land
  // well after publish (a conflict detected on a slow rescan, a user still
  // deciding whether to keep it), and real work — a settings edit, a note
  // left in the README — can happen inside that window. Deleting it because
  // an unrelated identity check happened to pass would be exactly the harm
  // the identity check itself exists to prevent, just for a different
  // question (#779-offers round 15 finding 3).
  const currentContentHash = await hashPluginSourceFiles(staged)
    .then((digest) => digest.sourceHash)
    .catch(
      async (error) =>
        await restoreOrStrand(
          `could not be verified unchanged since it was added: ${errorMessage(error)}`,
        ),
    );
  if (currentContentHash !== contentHash) {
    await restoreOrStrand("was edited since it was added");
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
