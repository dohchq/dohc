import {
  checkManifest,
  ReservedWorkspaceIdError,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  normalizeAbsolutePath,
  validateAttachedFolder,
  validateWorkspaceRootChoice,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { recordNeverSynced, recordSynced } from "./syncHistory";

export interface CreatedWorkspace {
  workspaceId: string;
  // Always canonicalWorkspaceRoot's spelling.
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

// A workspace folder's one spelling: its real path after every link, in the
// app's forward-slash form. The registry holds only this spelling, so the root
// it lists and the root a workspace operation receives are the same string.
// Throws when the folder does not exist.
export function canonicalWorkspaceRoot(rootPath: string): string {
  return normalizeAbsolutePath(realpathSync.native(rootPath));
}

// The mount code creates this on first use; it is exported so every path
// that addresses a mount spells the container the same way.
export const SHARED_WITH_ME_FOLDER = "shared-with-me";

// A .dohc/manifest.json dohc will not adopt or overwrite. ERROR_WORDS reads
// `code` into words; the message, with the parser's reason, is for Copy.
export class WorkspaceManifestError extends Error {
  override name = "WorkspaceManifestError";
  readonly code: "unreadable" | "newer-version";

  constructor(code: WorkspaceManifestError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] };

async function inspectManifest(metadataDir: string): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(join(metadataDir, "manifest.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceManifestError("unreadable", "this folder has a corrupt .dohc/manifest.json");
  }
  const check = checkManifest(parsed);
  if (check.status === "valid") {
    return {
      kind: "valid",
      workspaceId: check.manifest.workspaceId,
      workspaceKind: check.manifest.kind,
      mode: check.manifest.mode,
    };
  }
  if (check.status === "reserved-id") {
    throw new ReservedWorkspaceIdError(check.workspaceId);
  }
  if (check.status === "newer-version") {
    throw new WorkspaceManifestError(
      "newer-version",
      `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    );
  }
  // A present-but-broken manifest must never be silently overwritten (it may
  // be the user's data). checkManifest never returns "absent" for a file that
  // exists, but narrow defensively.
  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
  throw new WorkspaceManifestError("unreadable", `this folder has an invalid .dohc/manifest.json: ${reason}`);
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  // The home folder the root must not resolve to.
  homeDir: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
  // Join flow (0P-C): a fresh folder adopting a synced workspace's identity
  // gets the sync id instead of a random one, so the local engine store and
  // the relay bucket agree from the first pull. Ignored when the folder is
  // already a dohc workspace (an existing manifest's identity always wins —
  // silently rebinding it would sever history and sync).
  workspaceId?: string;
}): Promise<CreatedWorkspace> {
  const folderCheck = validateAttachedFolder(input.rootPath);
  if (!folderCheck.ok) {
    throw new Error(`Invalid workspace root: ${folderCheck.reason}`);
  }

  await mkdir(input.rootPath, { recursive: true });
  // Judge the folder a link leads to, not the link: a link to the home folder
  // or a disk is refused like the folder itself. Everything below writes and
  // registers this same real path.
  const rootPath = canonicalWorkspaceRoot(input.rootPath);
  let home = input.homeDir;
  try {
    home = canonicalWorkspaceRoot(home);
  } catch {
    // A home folder that does not exist is no folder's real path.
  }
  const rootCheck = validateWorkspaceRootChoice(rootPath, home, process.platform);
  if (!rootCheck.ok) throw new Error(rootCheck.reason);
  const metadataDir = await resolveWorkspaceMetadataDir(rootPath);
  // The metadata resolver reads the real path again. A different answer means
  // a folder on the path became a link after the check above.
  if (normalizeAbsolutePath(dirname(metadataDir)) !== rootPath) {
    throw new Error("The folder changed while dohc was opening it. Open it again.");
  }
  const state = await inspectManifest(metadataDir);
  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  if (state.kind === "valid") {
    return {
      workspaceId: state.workspaceId,
      rootPath,
      kind: state.workspaceKind === "cloud-only" ? input.kind : state.workspaceKind,
      mode: state.mode,
    };
  }

  const manifest = createWorkspaceManifest({
    workspaceId: input.workspaceId ?? randomUUID(),
    kind: input.kind,
  });

  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
  // an unexpected file that appeared between the check and the write.
  await writeFile(
    join(metadataDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  // A folder that had no manifest was never a dohc workspace. A join names
  // the synced workspace's id, and its folder records that it synced.
  if (input.workspaceId === undefined) await recordNeverSynced(rootPath);
  else await recordSynced(rootPath);
  return {
    workspaceId: manifest.workspaceId,
    rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
