import type { CliResultByVerb } from "@dohc/cli/protocol";
import { validateUserReadPath } from "@dohc/workspace-contracts/workspace-paths";
import { pathRejected } from "./results";

// Live Markdown documents. The host answers through the session that holds a
// document, and rejects when it cannot read one.
export interface DocumentsHost {
  read(path: string): Promise<{ path: string; markdown: string }>;
}

export function documentsUnavailable() {
  return {
    ok: false as const,
    reason: "documents are not available in this workspace",
  };
}

// `path` is workspace-relative. `platform` is the one whose path rules apply.
// A failed read rejects, so the caller words the failure.
export async function readDocument(
  documents: DocumentsHost | undefined,
  path: string,
  platform: string,
): Promise<CliResultByVerb["documentRead"]> {
  if (!documents) return documentsUnavailable();
  const validated = validateUserReadPath(path, { platform });
  if (!validated.ok) return pathRejected(validated.reason, path);
  return { ok: true as const, ...(await documents.read(validated.normalized)) };
}
