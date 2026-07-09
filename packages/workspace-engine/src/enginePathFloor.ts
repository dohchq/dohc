import {
  hasIgnoredSegment,
  stripWindowsAliasSuffix,
  validateUserWritePath,
} from "@dohc/workspace-core";
import type { EngineFilePathClassification } from "@dohc/workspace-contracts/engine";

// THE shared engine path policy: one classifier decides which workspace paths
// the engine owns at all, shared by engine search visibility, the desktop
// watcher->engine capture path, the versioned text store's write gate, and
// the secret file store so "what the engine records", "what engine search may
// surface", and "what must only ever be stored encrypted" cannot drift apart.
//
// This lives in its own leaf module (no engine-internal imports) so the
// stores themselves can enforce the floor without import cycles.
export function classifyEngineFilePath(path: string): EngineFilePathClassification {
  const normalized = validateUserWritePath(path);
  if (!normalized.ok || hasIgnoredSegment(path)) {
    return { kind: "ignored" };
  }
  // Classify the DECODED path: validateUserWritePath decodes percent-encoded
  // dots/separators ("secrets%2eenv" -> "secrets.env"), so running the
  // secret checks on the raw string would let an encoded .env slip through
  // as tracked — into engine capture and search results.
  const candidate = normalized.normalized;
  // The whole `.env` family is secret-classified: `.env` (as a segment
  // anywhere), `*.env`, and `.env.*` variants such as `.env.local` or
  // `.env.production`. This deliberately over-classifies `.env.example`:
  // protecting a placeholder costs a lock icon; missing a real `.env.local`
  // would version plaintext secrets.
  // Strip Windows trailing-dot/space aliases per segment first: Windows opens
  // `secret.env ` / `secret.env.` as the real `secret.env`, so they must
  // classify as secret too. This keeps the floor consistent with the reserved
  // and ignored-segment guards, which already alias-normalize the same way.
  const segments = candidate
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
