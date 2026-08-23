import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function syncLinuxStableCliBin(input: {
  resourcesCliBinDir: string;
  targetDir: string;
}): Promise<void> {
  await mkdir(input.targetDir, { recursive: true });
  await Promise.all([
    copyFile(
      join(input.resourcesCliBinDir, "dohc-mcp"),
      join(input.targetDir, "dohc-mcp"),
    ),
    copyFile(
      join(input.resourcesCliBinDir, "dohc-mcp.mjs"),
      join(input.targetDir, "dohc-mcp.mjs"),
    ),
  ]);
  await chmod(join(input.targetDir, "dohc-mcp"), 0o755);
}
