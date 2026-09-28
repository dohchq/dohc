import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_FILE_WRITE_BYTES, type CliFileWrite, type CliResultByVerb } from "@dohc/cli/protocol";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { withOrderedWorkspaceTargetPath } from "./workspaceAssets";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { historyPathAdmission, readWorkspaceEnginePolicy, type WorkspaceEnginePolicySnapshot } from "./workspaceEnginePolicyFile";
import { AuthoredTextChangedError, requirePublishedWrite, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

export const FILE_DOCUMENT_REFUSAL = "Use dohc_create_document or dohc_edit_document for live documents. Choose a plain file path for this write.";

export function decodeFileWriteContent(contentBase64: string): Buffer {
  if (contentBase64.length > Math.ceil(MAX_FILE_WRITE_BYTES / 3) * 4) {
    throw new Error("File content exceeds 10 MiB. Write a smaller file.");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    throw new Error("File content is not valid base64. Encode the content again.");
  }
  if (bytes.byteLength > MAX_FILE_WRITE_BYTES) {
    throw new Error("File content exceeds 10 MiB. Write a smaller file.");
  }
  return bytes;
}

async function admit(rootPath: string, path: string, policy: WorkspaceEnginePolicySnapshot) {
  if (policy.errors.length) throw new Error(`dohc could not read the workspace file policy: ${policy.errors.join("; ")}. Fix the policy and retry.`);
  const checked = validateUserMaterializePath(path, { platform: process.platform });
  if (!checked.ok) throw new Error(`Cannot write ${path}: ${checked.reason}. Choose a writable workspace path.`);
  const target = await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, checked.normalized),
    spelled: path, label: "File path", access: "write" });
  for (const name of [checked.normalized, target.relative]) {
    if (liveDocumentKindForPath(name) !== null) throw new Error(FILE_DOCUMENT_REFUSAL);
  }
  const allowed = historyPathAdmission(policy);
  if (!allowed(checked.normalized) || !allowed(target.relative)) {
    throw new Error(`History cannot record ${path}. Choose a non-secret path included by files.toml.`);
  }
  return { path: checked.normalized, ...target };
}

export async function writeWorkspaceFilesAs<Workspace extends { rootPath: string; readOnly?: boolean; shareView?: unknown }, State>(
  operation: WorkspaceAuthorityOperation<Workspace, State>,
  files: readonly CliFileWrite[],
  author: MomentWriteAuthor,
  options: { capture: Pick<WorkspaceEngineCapture, "writeAuthoredFile">; requestId?: string },
): Promise<CliResultByVerb["fileWrite"]> {
  const written: string[] = [];
  let failedPath: string | undefined;
  let failedAbsolute: string | undefined;
  const rootPath = operation.workspace.rootPath;
  const requestId = options.requestId ?? randomUUID();
  try {
    operation.assertCurrent();
    if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) {
      throw new Error("This workspace is read-only. Write in the owning workspace.");
    }
    const policy = await readWorkspaceEnginePolicy(rootPath);
    const prepared = [];
    for (const file of files) {
      failedPath = file.path;
      const bytes = decodeFileWriteContent(file.contentBase64);
      prepared.push({ ...file, bytes, ...(await admit(rootPath, file.path, policy)) });
    }
    for (const [index, file] of prepared.entries()) {
      failedPath = file.path;
      await withOrderedWorkspaceTargetPath(rootPath, file.resolvedAbsolute, async () => {
        operation.assertCurrent();
        if (operation.signal.aborted) throw new Error("The write was cancelled.");
        failedAbsolute = file.resolvedAbsolute;
        const outcome = await options.capture.writeAuthoredFile(file.resolvedAbsolute, file.bytes, author, {
          createOnly: file.createOnly, expectedContentHash: file.expectedSha256, signal: operation.signal,
          requestId: `fileWrite:${requestId}:${index}`, correlationId: `fileWrite:${requestId}`,
          beforeWrite: async resolvedAbsolute => {
            if (resolvedAbsolute !== file.resolvedAbsolute) throw new Error("The file path changed. Retry the write.");
            operation.assertCurrent();
            const queued = await admit(rootPath, file.path, await readWorkspaceEnginePolicy(rootPath));
            if (queued.resolvedAbsolute !== file.resolvedAbsolute) throw new Error("The file path changed. Retry the write.");
          },
        });
        requirePublishedWrite(file.path, outcome);
      });
      written.push(file.path);
    }
    return { ok: true, written };
  } catch (error) {
    const currentSha256 = error instanceof AuthoredTextChangedError && failedAbsolute
      ? await readFile(failedAbsolute).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => null)
      : undefined;
    return { ok: false, written, path: failedPath,
      reason: error instanceof Error ? error.message : "dohc could not write the file. Retry the write.",
      ...(currentSha256 !== undefined ? { currentSha256 } : {}),
    };
  }
}
