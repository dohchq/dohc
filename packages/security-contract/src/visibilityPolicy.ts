export interface VisibilityPolicyRule {
  path: string;
  visibility?: "visible" | "hidden";
  export?: "included" | "excluded" | "redacted";
}

export type VisibilityPolicyResult = { visibility: "visible" | "hidden"; export: "included" | "excluded" | "redacted" };

type PolicyGlobValidation = { ok: true } | { ok: false; reason: string };

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
  // The length floor makes `*` match zero or more characters, never fewer than
  // zero: without it `draft*draft.md` matched `draft.md`, where the prefix and
  // the suffix overlap and the star would have to consume -5 characters.
  return (
    pathSegment.length >= prefix.length + suffix.length &&
    pathSegment.startsWith(prefix) &&
    pathSegment.endsWith(suffix)
  );
}

/**
 * Matches a policy glob that already passed validatePolicyGlob. Callers must
 * validate first so unsupported syntax is rejected, not silently misread.
 */
export function policyGlobMatches(pattern: string, path: string): boolean {
  return preparePolicyGlob(pattern)(path);
}

function preparePolicyGlob(pattern: string): (path: string) => boolean {
  if (pattern === "**") return path => path.length > 0;
  if (!pattern.includes("*")) return path => path === pattern;
  if (pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*")) {
    const prefix = pattern.slice(0, -2);
    return path => path.startsWith(prefix);
  }
  const patternSegments = pattern.split("/");
  return path => policySegmentsMatch(patternSegments, path.split("/"));
}

function policySegmentsMatch(patternSegments: readonly string[], pathSegments: readonly string[]): boolean {
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

/** The visibility-rule decision, independent of capture and search admission. */
export function resolveVisibilityPolicy(
  path: string,
  rules?: readonly VisibilityPolicyRule[] | null,
): VisibilityPolicyResult {
  return evaluateVisibilityPolicy(path, rules, policyGlobMatches);
}

function evaluateVisibilityPolicy(
  path: string,
  rules: readonly VisibilityPolicyRule[] | null | undefined,
  matches: (pattern: string, path: string) => boolean,
): VisibilityPolicyResult {
  let visibility: VisibilityPolicyResult["visibility"] = "visible";
  let exportPolicy: VisibilityPolicyResult["export"] = "included";
  for (const rule of rules ?? []) {
    if (!matches(rule.path, path)) continue;
    if (rule.visibility !== undefined) visibility = rule.visibility;
    if (rule.export !== undefined) exportPolicy = rule.export;
  }
  return { visibility, export: exportPolicy };
}

/** Prepare matchers once when evaluating the same rules over a complete listing. */
export function prepareVisibilityPolicy(rules: readonly VisibilityPolicyRule[]) {
  const matchers = new Map(rules.map(rule => [rule.path, preparePolicyGlob(rule.path)]));
  return (path: string) => evaluateVisibilityPolicy(path, rules, (pattern, candidate) => matchers.get(pattern)!(candidate));
}

export function sameVisibilityPolicy(a: readonly VisibilityPolicyRule[], b: readonly VisibilityPolicyRule[]): boolean {
  return a === b || a.length === b.length && a.every((rule, i) => {
    const previous = b[i];
    return rule.path === previous.path && rule.visibility === previous.visibility && rule.export === previous.export;
  });
}
