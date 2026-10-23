import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const OPERATOR_TIMEOUT_MS = 10_000;
export const OPERATOR_MAX_REQUEST_BYTES = 8192;
export const OPERATOR_MAX_RESPONSE_BYTES = 16384;
export interface DisablePublicationRequest { type: "disable-publication"; publicationId: string; reason: string }
export interface OperatorResponse { code: 0 | 1 | 2 | 3; message: string; publicationId?: string; authorityRevision?: number; operatorTakedown?: {actor: "operator"; disabledAtMs: number; reason: string} }

export function operatorSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const identity = resolve(env.DOHC_RELAY_DEPLOYMENT_CONFIG ?? env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite"));
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  if (typeof process.getuid !== "function") return `\\\\.\\pipe\\dohc-relay-operator-${key}`;
  return join(process.platform === "linux" ? "/tmp" : tmpdir(), `dohc-relay-operator-${key}`, "control.sock");
}

export function parseDisableRequest(value: unknown): DisablePublicationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid takedown request.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "publicationId,reason,type" || row.type !== "disable-publication" ||
      typeof row.publicationId !== "string" || !/^[a-f0-9]{64}$/.test(row.publicationId) ||
      typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 1024 ||
      Buffer.byteLength(row.reason) > 4096 || row.reason.includes("\0")) throw new Error("Invalid takedown request. Supply a publication ID and a reason of 1 to 1024 characters.");
  return {type: "disable-publication", publicationId: row.publicationId, reason: row.reason};
}

// Deployment configuration lives on /continuity, outside every replica store.
// A development or test relay keeps the secret beside its database, so
// removing the database's folder removes the secret too.
export function operatorSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DOHC_RELAY_DEPLOYMENT_CONFIG) return join(dirname(resolve(env.DOHC_RELAY_DEPLOYMENT_CONFIG)), "publication-operator.secret");
  return `${resolve(env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite"))}.operator-secret`;
}
