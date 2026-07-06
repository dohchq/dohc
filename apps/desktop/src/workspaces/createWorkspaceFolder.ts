import {
  checkManifest,
  createWorkspaceManifest,
  defaultWorkspaceMode,
  validateAttachedFolder,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CreatedWorkspace {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceKind;
  mode: ReturnType<typeof defaultWorkspaceMode>;
}

const FIRST_CONTEXT = `# About me

Tell your agents who you are and how you like to work.
This file lives at .context/me.md inside your workspace folder.
`;

export const SHARED_WITH_ME_FOLDER = "shared-with-me";

type ManifestState =
  | { kind: "absent" }
  | { kind: "valid"; workspaceId: string; workspaceKind: WorkspaceKind; mode: CreatedWorkspace["mode"] }
  | { kind: "blocked"; reason: string };

async function inspectManifest(rootPath: string): Promise<ManifestState> {
  let raw: string;
  try {
    raw = await readFile(join(rootPath, ".dohc", "manifest.json"), "utf8");
  } catch {
    return { kind: "absent" };
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

function assertSharedWithMeFolder(existing: Stats): void {
  if (existing.isSymbolicLink()) {
    throw new Error(`${SHARED_WITH_ME_FOLDER} must not be a symlink`);
  }
  if (!existing.isDirectory()) {
    throw new Error(`${SHARED_WITH_ME_FOLDER} exists but is not a folder`);
  }
}

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
  // Join flow (0P-C): a fresh folder adopting a SYNCED workspace's identity
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

  const state = await inspectManifest(input.rootPath);
  if (state.kind === "blocked") {
    throw new Error(state.reason);
  }
  // Ensure shared-with-me exists in both new and adopted workspaces; existing
  // local workspaces created before sharing support need this migration path.
  const sharedWithMePath = join(input.rootPath, SHARED_WITH_ME_FOLDER);
  const existingSharedFolder = await lstat(sharedWithMePath).catch((statError: unknown) => {
    if ((statError as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Unable to verify ${SHARED_WITH_ME_FOLDER}: ${
        statError instanceof Error ? statError.message : String(statError)
      }`,
    );
  });
  if (existingSharedFolder) {
    assertSharedWithMeFolder(existingSharedFolder);
  } else {
    await mkdir(sharedWithMePath, { recursive: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const createdSharedFolder = await lstat(sharedWithMePath).catch((statError: unknown) => {
      throw new Error(
        `Unable to verify ${SHARED_WITH_ME_FOLDER}: ${
          statError instanceof Error ? statError.message : String(statError)
        }`,
      );
    });
    assertSharedWithMeFolder(createdSharedFolder);
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

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  // wx: manifest is absent (inspectManifest returned "absent"); never clobber
  // an unexpected file that appeared between the check and the write.
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(join(input.rootPath, ".context", "me.md"), FIRST_CONTEXT, {
    flag: "wx",
  }).catch((error: unknown) => {
    // An existing me.md is the user's; never overwrite it. Real failures
    // (permissions, disk) must still surface.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });

  return {
    workspaceId: manifest.workspaceId,
    rootPath: input.rootPath,
    kind: input.kind,
    mode: manifest.mode,
  };
}
