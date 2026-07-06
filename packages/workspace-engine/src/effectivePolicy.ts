import { parse as parseToml } from "smol-toml";
import { classifyEngineFilePath } from "./workspaceSearch";

export interface FilesPolicyRule {
  path: string;
  tracked?: boolean;
  searchable?: boolean;
}

export interface VisibilityPolicyRule {
  path: string;
  visibility?: "visible" | "hidden";
  export?: "included" | "excluded" | "redacted";
}

export type PolicyParseResult<T> =
  | { ok: true; rules: T[] }
  | { ok: false; errors: string[] };

export interface EffectivePolicyInput {
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

export type PolicyGlobValidation = { ok: true } | { ok: false; reason: string };

type ParsedToml = Record<string, unknown>;
type ParsedTable = Record<string, unknown>;

const FILES_POLICY_KEYS = new Set(["path", "tracked", "searchable"]);
const VISIBILITY_POLICY_KEYS = new Set(["path", "visibility", "export"]);

/**
 * Validates the intentionally small policy glob subset:
 * - slash-separated segments, no leading slash, no empty or `..` segments;
 * - within one segment, at most one `*`, matching zero or more non-slash chars;
 * - a segment exactly `**` matches zero or more whole path segments and is only
 *   allowed as the final segment; `dir/**` matches strict descendants only;
 * - bare `**` is allowed and matches every path;
 * - `?`, character classes, braces, leading `!`, and backslashes are rejected.
 */
export function validatePolicyGlob(pattern: string): PolicyGlobValidation {
  if (pattern.length === 0) return { ok: false, reason: "glob must not be empty" };
  if (pattern.startsWith("/")) {
    return { ok: false, reason: "glob must be workspace-relative, without a leading slash" };
  }
  if (pattern.startsWith("!")) {
    return { ok: false, reason: "glob negation is not supported" };
  }
  if (pattern.includes("\\")) {
    return { ok: false, reason: "glob backslash escapes are not supported" };
  }
  if (/[?[{\]}]/.test(pattern)) {
    return { ok: false, reason: "glob character classes, braces, and ? are not supported" };
  }
  const segments = pattern.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0) {
      return { ok: false, reason: "glob must not contain empty path segments" };
    }
    if (segment === "..") {
      return { ok: false, reason: "glob must not contain .. segments" };
    }
    if (segment === "**") {
      if (index !== segments.length - 1) {
        return { ok: false, reason: "** is only supported as the final segment" };
      }
      continue;
    }
    if (segment.includes("**")) {
      return { ok: false, reason: "** must occupy a complete final segment" };
    }
    const stars = [...segment].filter((char) => char === "*").length;
    if (stars > 1) {
      return { ok: false, reason: "only one * is supported per path segment" };
    }
  }
  return { ok: true };
}

function segmentMatches(patternSegment: string, pathSegment: string): boolean {
  const starIndex = patternSegment.indexOf("*");
  if (starIndex === -1) return patternSegment === pathSegment;
  const prefix = patternSegment.slice(0, starIndex);
  const suffix = patternSegment.slice(starIndex + 1);
  return pathSegment.startsWith(prefix) && pathSegment.endsWith(suffix);
}

/**
 * Matches a policy glob that already passed validatePolicyGlob. Callers must
 * validate first so unsupported syntax is rejected, not silently misread.
 */
export function policyGlobMatches(pattern: string, path: string): boolean {
  if (pattern === "**") return path.length > 0;
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  const finalPattern = patternSegments[patternSegments.length - 1];
  if (finalPattern === "**") {
    const prefixSegments = patternSegments.slice(0, -1);
    if (pathSegments.length <= prefixSegments.length) return false;
    return prefixSegments.every((segment, index) =>
      segmentMatches(segment, pathSegments[index] ?? ""),
    );
  }
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) =>
    segmentMatches(segment, pathSegments[index] ?? ""),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const errors: string[] = [];
  const ruleValue = validateTopLevel(parsed.value, errors);
  if (!Array.isArray(ruleValue)) {
    errors.push("rule must be an array of tables");
  }
  const rules: FilesPolicyRule[] = [];
  if (Array.isArray(ruleValue)) {
    for (let index = 0; index < ruleValue.length; index += 1) {
      const label = `rule ${index + 1}`;
      const rule = ruleValue[index];
      if (!isObject(rule)) {
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
      if (!isObject(rule)) {
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
  let visibility: EffectivePolicyResult["visibility"] = "visible";
  let exportPolicy: EffectivePolicyResult["export"] = "included";

  for (const rule of input.filesPolicy ?? []) {
    if (!policyGlobMatches(rule.path, input.path)) continue;
    if (rule.tracked !== undefined) tracked = rule.tracked;
    if (rule.searchable !== undefined) searchable = rule.searchable;
  }
  for (const rule of input.visibilityPolicy ?? []) {
    if (!policyGlobMatches(rule.path, input.path)) continue;
    if (rule.visibility !== undefined) visibility = rule.visibility;
    if (rule.export !== undefined) exportPolicy = rule.export;
  }

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
