import {
  hasIgnoredSegment,
  isSharedWithMePath,
  stripWindowsAliasSuffix,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import type { EngineFilePathClassification } from "@dohc/workspace-contracts/engine";

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
  if (basename.endsWith(".env") || basename.startsWith(".env.")) {
    return { kind: "secret" };
  }
  return { kind: "tracked" };
}

export function classifyEngineFilePathForRead(
  path: string,
): EngineFilePathClassification {
  const read = validateUserReadPath(path);
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
