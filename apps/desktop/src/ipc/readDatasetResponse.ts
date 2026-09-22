import { readBoundedJson } from "@dohc/service-http";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { APP_BACKEND_RESULT_BYTES, APP_BACKEND_UPLOAD_BYTES } from "@dohc/security-contract/app-backend";

/** Bounds owner responses and retains an operation's correction message. */
export async function readDatasetResponse(response: Response, action: string, signal: AbortSignal): Promise<unknown> {
  const limit = !response.ok ? 8192 : action === "file" ? Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3) * 4 + 8192
    : action === "artifacts" ? 8 * 1024 * 1024 : action === "list" || action === "describe" || action === "permissions" || action === "lifecycle" ? 2 * 1024 * 1024
    : APP_BACKEND_RESULT_BYTES + 4096;
  const value: unknown = await readBoundedJson(response, limit, signal);
  if (response.status === 409 && action === "invoke" && value && typeof value === "object" && !Array.isArray(value)) {
    const refusal = value as Record<string, unknown>;
    if (Object.keys(refusal).sort().join() === "code,message" && typeof refusal.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(refusal.code) &&
      typeof refusal.message === "string" && Buffer.byteLength(refusal.message) <= 1024) throw new AppBackendRuntimeError({ code: refusal.code, message: refusal.message });
  }
  return value;
}
