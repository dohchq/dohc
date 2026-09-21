import { readBoundedJson } from "@dohc/service-http";
import { APP_BACKEND_RESULT_BYTES } from "@dohc/security-contract/app-backend";
import { APP_BACKEND_EXPORT_MAX_BYTES } from "../workspaces/appBackendExport";

export function readAppBackendResponse(response: Response, action: string, signal: AbortSignal): Promise<unknown> {
  return readBoundedJson(response, response.ok && action === "export" ? APP_BACKEND_EXPORT_MAX_BYTES : APP_BACKEND_RESULT_BYTES + 4096, signal);
}
