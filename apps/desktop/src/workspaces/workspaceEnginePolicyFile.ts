import { validateUserReadPath } from "@dohc/workspace-core/paths";
import { errorMessage } from "./workspaceError";
import {
  parseFilesPolicy,
  parseVisibilityPolicy,
  policyGlobMatches,
  resolveEffectivePolicy,
  type FilesPolicyRule,
  type PolicyParseResult,
  type VisibilityPolicyRule,
  type WorkspacePolicyPath,
} from "@dohc/security-contract/effective-policy";
import {
  type SearchVisibility,
  type TextFileSnapshot,
  type VersionedTextMoment,
} from "@dohc/workspace-contracts/engine";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_WORKSPACE_SETTINGS_FILE_BYTES } from "./workspaceSettingsFile";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

export interface WorkspaceEnginePolicySnapshot {
  filesPolicy: FilesPolicyRule[] | null;
  visibilityPolicy: VisibilityPolicyRule[] | null;
  errors: string[];
  // Where `errors` came from, so a person can be told which file to fix.
  unreadable: WorkspacePolicyPath[];
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

// Search-side policy decision (WS-D). Capture stays FLOOR-ONLY when a policy
// file is malformed (WS-F's documented rule: writes are never dropped), but
// search must fail closed: resolveEffectivePolicy defaults tracked paths to
// searchable, so feeding it null rules from an unparseable policy file would
// widen search and resurface content the (broken) rules meant to hide. Any
// parse/read error therefore blocks engine search outright — the caller
// returns an empty result set and surfaces the error.
export type EngineSearchPolicyDecision =
  | { kind: "blocked"; message: string }
  | { kind: "search"; fileVisibility: (file: TextFileSnapshot) => SearchVisibility };

// History read through the CLI and the MCP shows a path only while the
// workspace's current policy tracks it: canonical, inside the workspace, not a
// secret, and not excluded by files.toml. Retired history stays in the engine
// but stops being readable here. Like search, a broken policy file hides all.
export function historyPathAdmission(
  policy: WorkspaceEnginePolicySnapshot,
): (path: string) => boolean {
  if (policy.errors.length > 0) return () => false;
  return (path) => {
    const validated = validateUserReadPath(path, { platform: process.platform });
    return validated.ok && validated.normalized === path && resolveEffectivePolicy({
      path,
      filesPolicy: policy.filesPolicy,
      visibilityPolicy: policy.visibilityPolicy,
    }).tracked;
  };
}

export function historyMomentPathsAdmitted(
  admitted: (path: string) => boolean,
  moment: Pick<VersionedTextMoment, "path" | "payload">,
): boolean {
  return [moment.path, moment.payload.after.path, ...(moment.payload.before ? [moment.payload.before.path] : [])]
    .every(admitted);
}

// Whether files.toml leaves every file under `directory` out of History, so
// nothing inside it needs reading. Rules apply in order and the last one
// decides. Only a rule that excludes the whole subtree proves it, and a later
// rule that could track anything inside takes that proof back.
export function historyExcludesSubtree(
  policy: WorkspaceEnginePolicySnapshot,
  directory: string,
): boolean {
  if (policy.errors.length > 0) return false;
  const folder = directory.split("/");
  const leads = (segments: readonly string[]) =>
    segments.every((segment, index) => policyGlobMatches(segment, folder[index] ?? ""));
  const coversAll = (pattern: string) => {
    if (pattern === "**") return true;
    const segments = pattern.split("/");
    return segments.at(-1) === "**" && segments.length - 1 <= folder.length && leads(segments.slice(0, -1));
  };
  // `**` is only ever a final segment, so a pattern reaches inside the
  // folder when its leading segments match the folder's.
  const reachesInside = (pattern: string) => {
    if (pattern === "**") return true;
    const segments = pattern.split("/");
    const open = segments.at(-1) === "**";
    if (!open && segments.length <= folder.length) return false;
    return leads((open ? segments.slice(0, -1) : segments).slice(0, folder.length));
  };
  let excluded = false;
  for (const rule of policy.filesPolicy ?? []) {
    if (rule.tracked === undefined) continue;
    if (coversAll(rule.path)) excluded = !rule.tracked;
    else if (rule.tracked && reachesInside(rule.path)) excluded = false;
  }
  return excluded;
}

export function resolveEngineSearchPolicy(
  policy: WorkspaceEnginePolicySnapshot,
): EngineSearchPolicyDecision {
  if (policy.errors.length > 0) {
    return { kind: "blocked", message: policy.errors.join("; ") };
  }
  return {
    kind: "search",
    fileVisibility: (file) => {
      const resolved = resolveEffectivePolicy({
        path: file.path,
        filesPolicy: policy.filesPolicy,
        visibilityPolicy: policy.visibilityPolicy,
      });
      return resolved.tracked && resolved.searchable && resolved.visibility !== "hidden"
        ? { searchable: true }
        : {
            searchable: false,
            reason: resolved.floor === "secret" ? "secret" : "ignored",
          };
    },
  };
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
        `workspace policy directory could not be resolved: ${errorMessage(error)}`,
      ],
      unreadable: [".dohc"],
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
    unreadable: [
      ...(files.errors.length ? [".dohc/files.toml" as const] : []),
      ...(visibility.errors.length ? [".dohc/visibility.toml" as const] : []),
    ],
  };
}
