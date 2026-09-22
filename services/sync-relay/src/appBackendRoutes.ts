import { readBoundedJson } from "@dohc/service-http";
import { createAppBackendAdmission, type AppBackendAdmissionLimits } from "./appBackendAdmission";
import { APP_BACKEND_REQUEST_BYTES, APP_BACKEND_UPLOAD_REQUEST_BYTES, parseAppBackendInvokeRequest,
  parseAppBackendJson, parseAppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { AppBackendAuth, AppBackendHost } from "./appBackendHost";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { APP_BACKEND_RECOVERY_BYTES, type AppBackendRecoveryBundle } from "./storage/appBackendData";
import { badRequest, notFound, relayError } from "./errors";

export type AppBackendAction = "activate" | "invoke" | "upload" | "file" | "attempt" | "describe" | "descriptor" | "blob" | "export" | "restore" | "helper";
export interface AppBackendRoute {
  route: "app-backend";
  publicationId: string;
  workspaceId?: string;
  action: AppBackendAction;
  sha256?: string;
}
const headers = {"cache-control":"private, no-store", "cross-origin-resource-policy":"same-origin", "x-content-type-options":"nosniff"};
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) {
    throw badRequest("Invalid app request.");
  }
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw badRequest("Invalid app revision.");
  return value;
}
function encodeBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return {encoding:"base64",bytes:Buffer.from(value).toString("base64")};
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,encodeBinary(item)]));
  return value;
}

/** Authentication is resolved by the relay before this bounded operation transport. */
export function createAppBackendRoutes(host: AppBackendHost, unavailable: AbortSignal,
  options: {limits?: Partial<AppBackendAdmissionLimits>; nowMs?: () => number} = {}) {
  const admit = createAppBackendAdmission(options.limits);
  const nowMs = options.nowMs ?? Date.now;
  return async (request: Request, route: AppBackendRoute, auth: AppBackendAuth): Promise<Response> => {
    const get = route.action === "descriptor" || route.action === "blob";
    if (request.method !== (get ? "GET" : "POST")) throw relayError("method_not_allowed");
    if (auth.kind === "link" && !["invoke", "upload", "file"].includes(route.action)) throw notFound();
    const url = new URL(request.url);
    if (route.action !== "blob" && url.search) throw badRequest("App requests do not accept a query.");
    const signal = AbortSignal.any([request.signal, unavailable, AbortSignal.timeout(30_000)]);
    const release = admit(host.authorizeAdmission(auth, route.publicationId), route.action, nowMs());
    try {
      signal.throwIfAborted();
      if (route.action === "descriptor") return Response.json(host.descriptor(auth, route.publicationId, signal), {headers});
      if (route.action === "blob") {
        if (url.searchParams.size !== 1 || !url.searchParams.has("authorityRevision") || !route.sha256) throw badRequest("Invalid app bundle request.");
        const result = host.blob(auth, route.publicationId, route.sha256, revision(Number(url.searchParams.get("authorityRevision"))), signal);
        return new Response(Uint8Array.from(result.bytes), {headers: {...headers, "content-type": result.file.contentType}});
      }
      if (request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("App operations require JSON.");
      let raw: unknown;
      try { raw = await readBoundedJson(request, route.action === "restore" ? APP_BACKEND_RECOVERY_BYTES + 1024 :
        route.action === "upload" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : APP_BACKEND_REQUEST_BYTES, signal); }
      catch (error) { signal.throwIfAborted(); if (error instanceof RangeError) throw relayError("payload_too_large"); throw badRequest("Invalid app JSON."); }
      signal.throwIfAborted();
      let result: unknown;
      if (route.action === "invoke") {
        let input; try { input = parseAppBackendInvokeRequest(raw); } catch { throw badRequest("Invalid app operation."); }
        result = await host.invoke(auth, route.publicationId, input, signal);
      } else if (route.action === "upload") {
        let input; try { input = parseAppBackendUploadRequest(raw); } catch { throw badRequest("Invalid app upload."); }
        result = await host.upload(auth, route.publicationId, input, signal);
      } else if (route.action === "activate") {
        const extra = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).filter(key => key === "preserveData" || key === "expectedRecoverySha256") : [];
        const body = record(raw,["authorityRevision",...extra]);
        if (body.preserveData !== undefined && body.preserveData !== true) throw badRequest("Invalid app activation condition.");
        if (body.expectedRecoverySha256 !== undefined && (typeof body.expectedRecoverySha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRecoverySha256))) throw badRequest("Invalid app recovery identity.");
        result = await host.activate(auth, route.publicationId, revision(body.authorityRevision), signal, {
          preserveData: body.preserveData === true, expectedRecoverySha256: body.expectedRecoverySha256 as string | undefined });
      } else if (route.action === "restore") {
        const body = record(raw,["authorityRevision","bundle"]);
        result = await host.restore(auth, route.publicationId, {authorityRevision:revision(body.authorityRevision),
          bundle:body.bundle as AppBackendRecoveryBundle}, signal);
      } else if (route.action === "file") {
        const body = record(raw,["authorityRevision","fileId","operation","input"]);
        if (typeof body.fileId !== "string" || typeof body.operation !== "string") throw badRequest("Invalid app file request.");
        result = await host.readFile(auth, route.publicationId, {authorityRevision:revision(body.authorityRevision),fileId:body.fileId,
          operation:body.operation,input:parseAppBackendJson(body.input)}, signal);
      } else if (route.action === "helper") {
        const body = record(raw,["authorityRevision","grantId","enabled"]);
        if (typeof body.grantId !== "string" || typeof body.enabled !== "boolean") throw badRequest("Invalid app helper request.");
        result = host.helper(auth, route.publicationId, {authorityRevision:revision(body.authorityRevision),grantId:body.grantId,enabled:body.enabled}, signal);
      } else {
        record(raw,[]);
        result = route.action === "describe" ? host.describe(auth, route.publicationId, signal) : host.export(auth, route.publicationId, signal);
      }
      signal.throwIfAborted();
      return new Response(JSON.stringify(encodeBinary(result)), {headers:{...headers,"content-type":"application/json"}});
    } catch (error) {
      if (error instanceof AppBackendRuntimeError) {
        return Response.json({code:error.refusal.code,message:error.refusal.message}, {status:409,headers});
      }
      throw error;
    } finally { release(); }
  };
}
