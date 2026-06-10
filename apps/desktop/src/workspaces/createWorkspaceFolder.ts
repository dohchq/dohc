import {
  createWorkspaceManifest,
  defaultWorkspaceMode,
  type WorkspaceKind,
} from "@dohc/workspace-core";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

export async function createWorkspaceFolder(input: {
  rootPath: string;
  kind: Extract<WorkspaceKind, "personal" | "shared">;
}): Promise<CreatedWorkspace> {
  const manifest = createWorkspaceManifest({
    workspaceId: randomUUID(),
    kind: input.kind,
  });

  await mkdir(join(input.rootPath, ".dohc"), { recursive: true });
  await mkdir(join(input.rootPath, ".context"), { recursive: true });
  await writeFile(
    join(input.rootPath, ".dohc", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
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
