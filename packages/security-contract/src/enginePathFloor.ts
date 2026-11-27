import {
  hasIgnoredSegment,
  isSharedWithMePath,
  stripWindowsAliasSuffix,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import type { EngineFilePathClassification } from "@dohc/workspace-contracts/engine";

export const SECRET_READ_DENIED_REASON =
  "This file is protected: secret-backed files (like .env) are never shared with agents through dohc tools. Agent access to secret contents is denied by default.";

const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.template", ".env.sample"]);

export function classifyEngineFilePath(path: string): EngineFilePathClassification {
  const normalized = validateUserWritePath(path);
  if (!normalized.ok || hasIgnoredSegment(path)) return { kind: "ignored" };
  const segments = normalized.normalized
    .split("/")
    .map((segment) => stripWindowsAliasSuffix(segment));
  const basename = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (segments.some((segment) => segment.toLowerCase() === ".env")) {
    return { kind: "secret" };
  }
  if (
    basename.endsWith(".env") ||
    (basename.startsWith(".env.") && !ENV_TEMPLATE_NAMES.has(basename))
  ) {
    return { kind: "secret" };
  }
  return { kind: "tracked" };
}

// The platform is the host whose disk the read reaches. The renderer has no
// `process`, so each caller names its own.
export function classifyEngineFilePathForRead(
  path: string,
  platform: NodeJS.Platform,
): EngineFilePathClassification {
  const read = validateUserReadPath(path, { platform });
  if (!read.ok || hasIgnoredSegment(path)) return { kind: "ignored" };
  const candidate = read.normalized;
  if (isSharedWithMePath(candidate)) {
    const segments = candidate.split("/");
    if (segments.length === 1) return { kind: "tracked" };
    const label = segments[1] ?? "";
    if (segments.length === 2) return classifyEngineFilePath(label);
    if (classifyEngineFilePath(label).kind === "secret") return { kind: "secret" };
    return classifyEngineFilePath(segments.slice(2).join("/"));
  }
  return classifyEngineFilePath(candidate);
}
