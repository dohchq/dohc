import type { FsDiffOperation } from "@dohc/workspace-fs";

export type SandboxApprovalRequest = {
  path: string;
  reason: string;
};

export function sandboxApprovalFromError(
  error: unknown,
  operation: FsDiffOperation,
): SandboxApprovalRequest | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (!/approval|trust|lock|permission|unauthor/i.test(`${code} ${message}`)) {
    return null;
  }
  return {
    path: operation.op === "rename" ? operation.fromPath : operation.path,
    reason: message,
  };
}
