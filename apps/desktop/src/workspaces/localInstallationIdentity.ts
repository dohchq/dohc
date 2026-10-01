import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface LocalInstallationIdentity {
  readonly id: string;
  readonly authorContextSecret: string;
}

/** Main's durable signed-out subject and private author-admission credential. */
export function readOrCreateLocalInstallationIdentity(file: string): LocalInstallationIdentity {
  let existing: { id?: unknown; authorContextSecret?: unknown } | undefined;
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) as typeof existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing !== undefined && (typeof existing.id !== "string" || !existing.id ||
      existing.id.length > 1024 || /[\u0000-\u001f\u007f]/u.test(existing.id))) {
    throw new Error("The local installation identity is invalid.");
  }
  if (existing?.authorContextSecret !== undefined &&
      (typeof existing.authorContextSecret !== "string" || !/^[a-f0-9]{64}$/u.test(existing.authorContextSecret))) {
    throw new Error("The local author credential is invalid.");
  }
  const identity = {
    id: existing?.id as string | undefined ?? `local:${randomUUID()}`,
    authorContextSecret: existing?.authorContextSecret as string | undefined ?? randomBytes(32).toString("hex"),
  };
  if (existing?.authorContextSecret !== undefined) return identity;
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(identity, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return identity;
}

/** Opaque local author evidence. The private credential never reaches a renderer. */
export function captureLocalAuthorContext(identity: LocalInstallationIdentity, workspaceId: string, personId: string): string {
  const payload = Buffer.from(JSON.stringify({ workspaceId, personId }));
  const stamp = createHmac("sha256", identity.authorContextSecret).update(payload).digest("base64url");
  return payload.toString("base64url") + "." + stamp;
}
