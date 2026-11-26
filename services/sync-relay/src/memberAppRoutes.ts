import { createHash } from "node:crypto";
import { parseApprovalAgent } from "@dohc/security-contract/approval-provenance";
import {
  APP_PUBLICATION_MAX_BLOB_BYTES,
  parseAppPublicationCandidate,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import { readBoundedBytes, readBoundedJson } from "@dohc/service-http";
import type { RelayDatasetHost } from "./datasetHost";
import { badRequest, notFound, relayError } from "./errors";
import { ticketRecord } from "./liveTicketInputs";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { readMemberAppSetting, setMemberAppSetting, withdrawMemberApp } from "./storage/memberApps";

export type MemberAppRoute = { route: "member-apps"; workspaceId: string } & (
  | { action: "apps" | "settings" }
  | { action: "withdraw"; publicationId: string }
);

const HEADER_BYTES = 256 * 1024;
/** A header, then each distinct file and input once. */
export const MEMBER_APP_UPLOAD_BYTES = 4 + HEADER_BYTES + 64 * 1024 * 1024;

const json = (value: unknown) =>
  Response.json(value, { headers: { "cache-control": "private, no-store" } });

function record(value: unknown, fields: string[], optional: string[] = []) {
  try {
    return ticketRecord(value, [
      ...fields,
      ...optional.filter(
        (field) => value !== null && typeof value === "object" && Object.hasOwn(value, field),
      ),
    ]);
  } catch {
    throw badRequest("Invalid Member app fields.");
  }
}

/** Splits an upload into its header and the bytes of every file and input the candidate names, each checked against its digest. */
export function parseMemberAppUpload(bytes: Uint8Array, limits: AppPublicationLimits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = bytes.byteLength >= 4 ? view.getUint32(0) : -1;
  if (headerBytes < 0 || headerBytes > HEADER_BYTES || 4 + headerBytes > bytes.byteLength)
    throw badRequest("Invalid Member app upload.");
  let header;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + headerBytes)),
    );
  } catch {
    throw badRequest("Invalid Member app upload.");
  }
  const fields = record(header, ["slug", "candidate"], ["agent"]);
  if (typeof fields.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(fields.slug))
    throw badRequest("Name the app with 1 to 64 lowercase letters, digits, or dashes.");
  let candidate, agent;
  try {
    candidate = parseAppPublicationCandidate(fields.candidate, limits);
    agent = parseApprovalAgent(fields.agent);
  } catch {
    throw badRequest("Invalid Member app candidate.");
  }
  const sizes = new Map<string, number>();
  for (const file of [...candidate.files, ...candidate.inputs]) {
    if (
      file.byteLength > APP_PUBLICATION_MAX_BLOB_BYTES ||
      (sizes.get(file.sha256) ?? file.byteLength) !== file.byteLength
    )
      throw badRequest("Invalid Member app file size.");
    sizes.set(file.sha256, file.byteLength);
  }
  const blobs = new Map<string, Uint8Array>();
  let offset = 4 + headerBytes;
  for (const sha256 of [...sizes.keys()].sort()) {
    const blob = bytes.subarray(offset, offset + sizes.get(sha256)!);
    offset += blob.byteLength;
    if (
      blob.byteLength !== sizes.get(sha256) ||
      createHash("sha256").update(blob).digest("hex") !== sha256
    )
      throw badRequest("A Member app file doesn't match its digest.");
    blobs.set(sha256, blob);
  }
  if (offset !== bytes.byteLength) throw badRequest("A Member app upload has extra bytes.");
  return { slug: fields.slug, candidate, agent, blobs };
}

export function createMemberAppRoutes(options: {
  host: RelayDatasetHost;
  storage: SyncRelayStorage;
  limits?: AppPublicationLimits;
}) {
  return async (request: Request, route: MemberAppRoute, userId: string) => {
    const { host, storage, limits } = options;
    const context = storage as StorageContext;
    if (!limits) throw notFound();
    const { workspaceId } = route;
    const auth = { kind: "named" as const, workspaceId, userId };
    const query = new URL(request.url).searchParams;
    if (request.method === "GET") {
      if (route.action === "withdraw") throw relayError("method_not_allowed");
      if (route.action === "settings") {
        if (query.size) throw badRequest("Member app settings take no query.");
        return json(readMemberAppSetting(context, workspaceId, userId));
      }
      const cursor = query.get("cursor") ?? undefined;
      if (
        [...query.keys()].some((key) => key !== "cursor") ||
        query.getAll("cursor").length > 1 ||
        (cursor !== undefined && !/^[0-9a-f]{64}$/.test(cursor))
      )
        throw badRequest("Invalid Member app list query.");
      return json(host.memberApps(auth, { workspaceId, ...(cursor ? { cursor } : {}) }));
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");
    if (query.size) throw badRequest("Member app changes take no query.");
    const signal = AbortSignal.any([
      request.signal,
      storage.unavailable,
      AbortSignal.timeout(120_000),
    ]);
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (route.action === "apps") {
      if (type !== "application/octet-stream")
        throw badRequest("Share a Member app as application/octet-stream.");
      let bytes;
      try {
        bytes = await readBoundedBytes(request, MEMBER_APP_UPLOAD_BYTES, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RangeError)
          throw relayError(
            "payload_too_large",
            `A Member app upload can be up to ${MEMBER_APP_UPLOAD_BYTES} bytes.`,
          );
        throw badRequest("Invalid Member app upload.");
      }
      return json(
        host.publishMemberApp(auth, { workspaceId, ...parseMemberAppUpload(bytes, limits) }),
      );
    }
    if (type !== "application/json")
      throw badRequest("Member app changes require application/json.");
    let raw;
    try {
      raw = await readBoundedJson(request, 1024, signal);
    } catch {
      signal.throwIfAborted();
      throw badRequest("Invalid Member app JSON body.");
    }
    if (route.action === "withdraw") {
      record(raw, []);
      return json(
        withdrawMemberApp(context, {
          workspaceId,
          actorUserId: userId,
          publicationId: route.publicationId,
        }),
      );
    }
    const body = record(raw, ["membersCanShare"]);
    if (typeof body.membersCanShare !== "boolean") throw badRequest("Invalid Member app setting.");
    return json(
      setMemberAppSetting(context, {
        workspaceId,
        actorUserId: userId,
        membersCanShare: body.membersCanShare,
      }),
    );
  };
}
