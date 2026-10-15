import { policyGlobMatches, validatePolicyGlob, resolveVisibilityPolicy, type VisibilityPolicyRule } from "./visibilityPolicy";
export { policyGlobMatches, validatePolicyGlob, resolveVisibilityPolicy, prepareVisibilityPolicy, type VisibilityPolicyRule } from "./visibilityPolicy";
import { isRecord } from "@dohc/workspace-core/records";
import { parse as parseToml } from "smol-toml";
import { classifyEngineFilePath } from "./enginePathFloor";
import { fileVersionError } from "@dohc/workspace-contracts/file-version";

// Where a workspace keeps the rules for which files History tracks and who
// sees them: the folder, and its two rules files. A person is told which of
// these dohc could not read.
export const WORKSPACE_POLICY_PATHS = [".dohc", ".dohc/files.toml", ".dohc/visibility.toml"] as const;
export type WorkspacePolicyPath = (typeof WORKSPACE_POLICY_PATHS)[number];

export interface FilesPolicyRule {
  path: string;
  tracked?: boolean;
  searchable?: boolean;
}

export type PolicyParseResult<T> =
  | { ok: true; rules: T[] }
  | { ok: false; errors: string[] };

interface EffectivePolicyInput {
  path: string;
  filesPolicy?: readonly FilesPolicyRule[] | null;
  visibilityPolicy?: readonly VisibilityPolicyRule[] | null;
}

export interface EffectivePolicyResult {
  path: string;
  tracked: boolean;
  // This slice has no untracked-but-versioned tier yet. Version ownership
  // therefore mirrors post-policy tracked ownership exactly.
  versioned: boolean;
  searchable: boolean;
  visibility: "visible" | "hidden";
  export: "included" | "excluded" | "redacted";
  // Capture has no separate actor/permission model in this slice, so capture
  // ownership mirrors post-policy tracked ownership exactly.
  captureOwned: boolean;
  floor: "tracked" | "ignored" | "secret";
}

type ParsedToml = Record<string, unknown>;
type ParsedTable = Record<string, unknown>;
const FILES_POLICY_KEYS = new Set(["path", "tracked", "searchable"]);
const VISIBILITY_POLICY_KEYS = new Set(["path", "visibility", "export"]);

// Real TOML parsing (smol-toml, pure JS): the policy files are TOML by
// contract, so valid TOML must parse — the strictness lives in the shape
// validation below, never in a private syntax subset. A syntax error is a
// validation failure surfaced to the caller, not a thrown exception.
function parsePolicyToml(
  tomlText: string,
): { ok: true; value: ParsedToml } | { ok: false; errors: string[] } {
  try {
    return { ok: true, value: parseToml(tomlText) };
  } catch (error) {
    return {
      ok: false,
      errors: [
        `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function validateRulePath(rule: ParsedTable, label: string, errors: string[]): string | null {
  const path = rule.path;
  if (typeof path !== "string" || path.length === 0) {
    errors.push(`${label}: path is required and must be a non-empty string`);
    return null;
  }
  const glob = validatePolicyGlob(path);
  if (!glob.ok) {
    errors.push(`${label}: invalid path glob "${path}": ${glob.reason}`);
    return null;
  }
  return path;
}

function validateTopLevel(parsed: ParsedToml, errors: string[]): unknown {
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (key !== "rule") errors.push(`unknown top-level key: ${key}`);
  }
  if (keys.length !== 1 || !keys.includes("rule")) {
    errors.push("policy must contain exactly one top-level key: rule");
  }
  return parsed.rule;
}

export function parseFilesPolicy(tomlText: string): PolicyParseResult<FilesPolicyRule> {
  const parsed = parsePolicyToml(tomlText);
  if (!parsed.ok) return parsed;
  const versionError = fileVersionError(parsed.value.version, "files.toml");
  if (versionError) return { ok: false, errors: [versionError] };
  const errors: string[] = [];
  const { version: _version, ...policy } = parsed.value;
  const ruleValue = validateTopLevel(policy, errors);
  if (!Array.isArray(ruleValue)) {
    errors.push("rule must be an array of tables");
  }
  const rules: FilesPolicyRule[] = [];
  if (Array.isArray(ruleValue)) {
    for (let index = 0; index < ruleValue.length; index += 1) {
      const label = `rule ${index + 1}`;
      const rule = ruleValue[index];
      if (!isRecord(rule)) {
        errors.push(`${label}: rule entry must be an object`);
        continue;
      }
      for (const key of Object.keys(rule)) {
        if (!FILES_POLICY_KEYS.has(key)) errors.push(`${label}: unknown key: ${key}`);
      }
      const path = validateRulePath(rule, label, errors);
      const tracked = rule.tracked;
      const searchable = rule.searchable;
      if (tracked !== undefined && typeof tracked !== "boolean") {
        errors.push(`${label}: tracked must be a boolean`);
      }
      if (searchable !== undefined && typeof searchable !== "boolean") {
        errors.push(`${label}: searchable must be a boolean`);
      }
      if (path && (tracked === undefined || typeof tracked === "boolean") && (searchable === undefined || typeof searchable === "boolean")) {
        rules.push({
          path,
          ...(typeof tracked === "boolean" ? { tracked } : {}),
          ...(typeof searchable === "boolean" ? { searchable } : {}),
        });
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

export function parseVisibilityPolicy(
  tomlText: string,
): PolicyParseResult<VisibilityPolicyRule> {
  const parsed = parsePolicyToml(tomlText);
  if (!parsed.ok) return parsed;
  const errors: string[] = [];
  const ruleValue = validateTopLevel(parsed.value, errors);
  if (!Array.isArray(ruleValue)) {
    errors.push("rule must be an array of tables");
  }
  const rules: VisibilityPolicyRule[] = [];
  if (Array.isArray(ruleValue)) {
    for (let index = 0; index < ruleValue.length; index += 1) {
      const label = `rule ${index + 1}`;
      const rule = ruleValue[index];
      if (!isRecord(rule)) {
        errors.push(`${label}: rule entry must be an object`);
        continue;
      }
      for (const key of Object.keys(rule)) {
        if (!VISIBILITY_POLICY_KEYS.has(key)) errors.push(`${label}: unknown key: ${key}`);
      }
      const path = validateRulePath(rule, label, errors);
      const visibility = rule.visibility;
      const exportPolicy = rule.export;
      if (visibility !== undefined && visibility !== "visible" && visibility !== "hidden") {
        errors.push(`${label}: visibility must be "visible" or "hidden"`);
      }
      if (
        exportPolicy !== undefined &&
        exportPolicy !== "included" &&
        exportPolicy !== "excluded" &&
        exportPolicy !== "redacted"
      ) {
        errors.push(`${label}: export must be "included", "excluded", or "redacted"`);
      }
      if (
        path &&
        (visibility === undefined || visibility === "visible" || visibility === "hidden") &&
        (exportPolicy === undefined ||
          exportPolicy === "included" ||
          exportPolicy === "excluded" ||
          exportPolicy === "redacted")
      ) {
        rules.push({
          path,
          ...(visibility === "visible" || visibility === "hidden" ? { visibility } : {}),
          ...(exportPolicy === "included" ||
          exportPolicy === "excluded" ||
          exportPolicy === "redacted"
            ? { export: exportPolicy }
            : {}),
        });
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

export function resolveEffectivePolicy(input: EffectivePolicyInput): EffectivePolicyResult {
  const floor = classifyEngineFilePath(input.path);
  if (floor.kind !== "tracked") {
    return {
      path: input.path,
      tracked: false,
      versioned: false,
      searchable: false,
      visibility: "hidden",
      export: "excluded",
      captureOwned: false,
      floor: floor.kind,
    };
  }

  let tracked = true;
  let searchable = true;

  for (const rule of input.filesPolicy ?? []) {
    if (!policyGlobMatches(rule.path, input.path)) continue;
    if (rule.tracked !== undefined) tracked = rule.tracked;
    if (rule.searchable !== undefined) searchable = rule.searchable;
  }
  const { visibility, export: exportPolicy } = resolveVisibilityPolicy(input.path, input.visibilityPolicy);

  return {
    path: input.path,
    tracked,
    versioned: tracked,
    searchable,
    visibility,
    export: exportPolicy,
    captureOwned: tracked,
    floor: floor.kind,
  };
}
