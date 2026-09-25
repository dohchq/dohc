import {
  checkManifest,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export interface CreatedWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

// The mount code creates this on first use; it is exported so every path
// that addresses a mount spells the container the same way.
export const SHARED_WITH_ME_FOLDER = "shared-with-me";

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
  | { kind: "blocked"; reason: string };

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
    return { kind: "blocked", reason: "this folder has a corrupt .dohc/manifest.json" };
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
  if (check.status === "newer-version") {
    return {
      kind: "blocked",
      reason: `this workspace was created by a newer version of dohc (manifest v${check.version})`,
    };
  }
  // A present-but-broken manifest must never be silently overwritten (it may
  // be the user's data). checkManifest never returns "absent" for a file that
  // exists, but narrow defensively.
  const reason = check.status === "invalid" ? check.reason : "unrecognized manifest";
  return { kind: "blocked", reason: `this folder has an invalid .dohc/manifest.json: ${reason}` };
}

// Rolls a failed join back to an empty folder (0P-C gate fix). The join
// handler verified the folder was empty before creating anything, so every
// entry inside it was produced by this join attempt — identity scaffolding
// (.dohc, shared-with-me), the engine store, and any partially materialized
// pull output (all of which still lives on the relay). Removing them restores
// the pre-join state so a retry sees an empty folder again; leaving them
// would strand a half-joined workspace the empty-folder check then rejects.
export async function resetFailedJoinFolder(rootPath: string): Promise<void> {
  const entries = await readdir(rootPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    await rm(join(rootPath, entry), { recursive: true, force: true });
  }
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
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
  const metadataDir = await resolveWorkspaceMetadataDir(input.rootPath);
  const state = await inspectManifest(metadataDir);
  if (state.kind === "blocked") {
    throw new Error(state.reason);
  }
  // A folder that is already a dohc workspace keeps its identity — sync and
  // history hang off workspaceId, so overwriting the manifest severs them.
  if (state.kind === "valid") {
    return {
      workspaceId: state.workspaceId,
      rootPath: input.rootPath,
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
  return {
    workspaceId: manifest.workspaceId,
    rootPath: input.rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
