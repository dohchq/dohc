import {
  parseFilesPolicy,
  parseVisibilityPolicy,
  type FilesPolicyRule,
  type PolicyParseResult,
  type VisibilityPolicyRule,
} from "@dohc/workspace-engine";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_WORKSPACE_SETTINGS_FILE_BYTES } from "./workspaceSettingsFile";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export interface WorkspaceEnginePolicySnapshot {
  filesPolicy: FilesPolicyRule[] | null;
  visibilityPolicy: VisibilityPolicyRule[] | null;
  errors: string[];
}

type PolicyReadResult<T> = { rules: T[] | null; errors: string[] };

async function readPolicyFile<T>(
  dir: string,
  fileName: string,
  parse: (text: string) => PolicyParseResult<T>,
): Promise<PolicyReadResult<T>> {
  const path = join(dir, fileName);
  try {
    const fileStats = await lstat(path);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return {
        rules: null,
        errors: [`${fileName} was not a regular file and was ignored.`],
      };
    }
    if (fileStats.size > MAX_WORKSPACE_SETTINGS_FILE_BYTES) {
      return {
        rules: null,
        errors: [`${fileName} was too large and was ignored.`],
      };
    }
    const parsed = parse(await readFile(path, "utf8"));
    if (!parsed.ok) {
      return {
        rules: null,
        errors: parsed.errors.map((error) => `${fileName}: ${error}`),
      };
    }
    return { rules: parsed.rules, errors: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { rules: null, errors: [] };
    }
    return {
      rules: null,
      errors: [`${fileName} could not be read and was ignored.`],
    };
  }
}

export async function readWorkspaceEnginePolicy(
  rootPath: string,
): Promise<WorkspaceEnginePolicySnapshot> {
  let dir: string;
  try {
    dir = await resolveWorkspaceMetadataDir(rootPath);
  } catch (error) {
    return {
      filesPolicy: null,
      visibilityPolicy: null,
      errors: [
        `workspace policy directory could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
  const [files, visibility] = await Promise.all([
    readPolicyFile(dir, "files.toml", parseFilesPolicy),
    readPolicyFile(dir, "visibility.toml", parseVisibilityPolicy),
  ]);
  return {
    filesPolicy: files.rules,
    visibilityPolicy: visibility.rules,
    errors: [...files.errors, ...visibility.errors],
  };
}
