import { readBoundedJson } from "@dohc/service-http";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import {
  APP_BACKEND_BULK_LIMITS,
  APP_BACKEND_CATCH_UP_BYTES,
  APP_BACKEND_PROFILE_HEADER,
  APP_BACKEND_RESULT_BYTES,
  APP_BACKEND_UPLOAD_BYTES,
} from "@dohc/security-contract/app-backend";

/** The answer readDatasetResponse reads for a request to the server's Collection routes or an app's change routes, or null for another route. */
export function datasetResponseAction(path: string): string | null {
  const dataset =
    /^\/sync\/(?:shares\/)?[^/]+\/datasets(?:\/([0-9a-f-]{36})(?:\/([a-z]+))?)?(?:\?|$)/.exec(path);
  if (dataset) return dataset[2] ?? (dataset[1] ? "describe" : "list");
  if (/^\/sync\/[^/]+\/local-apps$/.test(path)) return "local-app";
  return (
    /^\/sync\/[^/]+\/app-publications\/[0-9a-f]{64}\/backend\/(invoke|attempt|upload|file|external)$/.exec(
      path,
    )?.[1] ?? null
  );
}

/** Bounds owner responses and retains an operation's correction message. */
export async function readDatasetResponse(
  response: Response,
  action: string,
  signal: AbortSignal,
): Promise<unknown> {
  const profile =
    action === "invoke" && response.headers.get(APP_BACKEND_PROFILE_HEADER) === "bulk"
      ? "bulk"
      : undefined;
  const resultBytes =
    profile === "bulk" ? APP_BACKEND_BULK_LIMITS.resultBytes : APP_BACKEND_RESULT_BYTES;
  const limit = !response.ok
    ? 8192
    : action === "file"
      ? Math.ceil(APP_BACKEND_UPLOAD_BYTES / 3) * 4 + 8192
      : action === "artifacts"
        ? 8 * 1024 * 1024
        : action === "list" ||
            action === "describe" ||
            action === "permissions" ||
            action === "lifecycle" ||
            action === "delete-preview"
          ? 2 * 1024 * 1024
          : action === "invoke"
            ? resultBytes + APP_BACKEND_CATCH_UP_BYTES + 4096
            : APP_BACKEND_RESULT_BYTES + 4096;
  const value: unknown = await readBoundedJson(response, limit, signal);
  if (profile === "bulk" && response.ok && value && typeof value === "object" && "result" in value)
    return { ...value, profile };
  if (
    response.status === 409 &&
    (action === "invoke" || action === "external") &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const refusal = value as Record<string, unknown>;
    if (
      Object.keys(refusal).sort().join() === "code,message" &&
      typeof refusal.code === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(refusal.code) &&
      typeof refusal.message === "string" &&
      Buffer.byteLength(refusal.message) <= 1024
    )
      throw new AppBackendRuntimeError({ code: refusal.code, message: refusal.message });
  }
  return value;
}
