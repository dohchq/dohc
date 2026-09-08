import { jsonResponse } from "@dohc/service-http";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { badRequest, relayError } from "./errors";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import { assertSha256, readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES } from "./wireLimits";

export type WorkspaceBlobRoute =
  | { route: "gc"; workspaceId: string }
  | { route: "blob"; workspaceId: string; sha256: string }
  | { route: "blob-have"; workspaceId: string };

export function createWorkspaceBlobRoutes(
  storage: Pick<SyncRelayStorage,
    | "collectUnreferencedBlobs"
    | "putBlob"
    | "getBlob"
    | "missingBlobs"
  >,
  nowMs: () => number,
) {
  async function respondToWorkspaceBlobs(
    request: Request,
    route: WorkspaceBlobRoute,
  ): Promise<Response> {
    if (route.route === "gc" && request.method === "POST") {
      const result = await storage.collectUnreferencedBlobs(route.workspaceId, {
        nowMs: nowMs(),
      });
      return jsonResponse({ ok: true, ...result });
    }
    if (route.route === "gc") throw relayError("method_not_allowed");

    if (route.route === "blob" && request.method === "PUT") {
      assertSha256(route.sha256);
      const bytes = await readBytes(request, MAX_BLOB_BYTES);
      const actual = sha256Hex(bytes);
      if (actual !== route.sha256) {
        throw badRequest("blob content does not match sha256 path");
      }
      const put = storage.putBlob({
        workspaceId: route.workspaceId,
        sha256: route.sha256,
        content: bytes,
        createdAtMs: nowMs(),
      });
      return jsonResponse({
        ok: true,
        workspaceId: route.workspaceId,
        sha256: route.sha256,
        byteLength: put.byteLength,
        alreadyHad: put.alreadyHad,
      });
    }

    if (route.route === "blob" && request.method === "GET") {
      assertSha256(route.sha256);
      const blob = storage.getBlob(route.workspaceId, route.sha256);
      // Distinct from the absent-workspace 404: the caller already proved
      // workspace ownership, so this leaks nothing about other tenants, and
      // sync clients must be able to tell missing content apart from an
      // unavailable workspace.
      if (!blob) throw relayError("blob_not_found");
      return new Response(arrayBufferForBytes(blob), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }

    if (route.route === "blob-have" && request.method === "POST") {
      const input = await readJsonObject(request);
      if (!Array.isArray(input.sha256s)) throw badRequest("sha256s must be an array");
      if (input.sha256s.length > 2_000) throw badRequest("too many sha256s");
      const sha256s = input.sha256s.map((value) => {
        if (typeof value !== "string") throw badRequest("sha256s must be strings");
        assertSha256(value);
        return value;
      });
      return jsonResponse({
        ok: true,
        missing: storage.missingBlobs(route.workspaceId, sha256s),
      });
    }

    throw relayError("method_not_allowed");
  }

  return respondToWorkspaceBlobs;
}
