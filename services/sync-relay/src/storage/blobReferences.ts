import { asRecord } from "@dohc/workspace-core";
import { readableString } from "./currentFiles";
import { type ConflictResolveEnvelopeContext, conflictResolveBlobShas } from "../conflictResolve";

export function versionIdFromVersionCreatePayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  return record ? readableString(record.versionId) : null;
}

// Every blob sha an op requires the relay to already hold before the op may be
// durably logged. This must mirror dohc-engine-sync collect_blob_refs exactly:
// the push client uploads precisely this set (text + binary) before
// POST /log, so validating the same set neither rejects an honest push nor
// lets a referencing op slip through unvalidated. Enumerated by op kind:
//   - moment.append:      payloadBefore/After/before blob shas (both content
//                         kinds ship as uploaded blobs).
//   - conflict.open: base/current/incoming state shas, but only for
//                         binary states -- text conflict states carry their
//                         bytes INLINE in the payload and are never uploaded,
//                         so requiring them would wrongly reject a valid op.
//   - version.create:     every forkSnapshot blob sha (both content kinds).
//   - secret.file.put:    the ciphertext blob sha.
//   - secret.version.fork: every row's ciphertext blob sha.
// conflict.resolve formatVersion 1 is the narrow exception to opaque payload
// handling: its compact state transition is parsed strictly so every required
// side and successor blob is pinned before the atomic append. A malformed
// compound payload throws a classified 400 instead of yielding no roots.
// All other kinds (workspace.init, secret.file.delete, chat.*, reserved
// version.rename/chat.thread.update, and any unknown/opaque kind) reference no
// uploaded blobs. Fully defensive: a malformed payload shape yields no refs
// for that branch rather than throwing (the store's apply-time validation is
// the fail-closed backstop for shape).
export function referencedBlobShas(
  opKind: string,
  payloadJson: string,
  context: ConflictResolveEnvelopeContext,
): string[] {
  if (opKind === "conflict.resolve") {
    return conflictResolveBlobShas(payloadJson, context);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  if (!record) return [];
  const shas: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) shas.push(value);
  };
  if (opKind === "moment.append") {
    push(record.payloadBeforeBlobSha256);
    push(record.payloadAfterBlobSha256);
    push(record.beforeBlobSha256);
  } else if (opKind === "conflict.open") {
    for (const key of ["base", "current", "incoming"] as const) {
      const state = asRecord(record[key]);
      if (state && state.exists === true && state.contentKind === "binary") {
        push(state.sha256);
      }
    }
  } else if (opKind === "version.create") {
    const snapshots = Array.isArray(record.forkSnapshots) ? record.forkSnapshots : [];
    for (const raw of snapshots) {
      const snapshot = asRecord(raw);
      if (snapshot) push(snapshot.blobSha256);
    }
  } else if (opKind === "ydoc.update") {
    // A ydoc.update's Yjs bytes are content-addressed like any binary blob. The
    // relay stays content-agnostic (dumb log) but must count this reference so
    // (a) append-time validation requires the blob uploaded first, and (b) the
    // blob GC treats a blob a live ydoc.update op references as a ROOT — a live
    // rich-doc update blob is never collected out from under the log.
    push(record.updateBlobSha256);
  } else if (opKind === "live.audit.application") {
    push(record.updateBlobSha256);
    const manifest = asRecord(record.manifest);
    const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
    for (const value of chunks) {
      const chunk = asRecord(value);
      if (chunk) push(chunk.sha256);
    }
  } else if (opKind === "live.audit.settlement") {
    const audit = asRecord(record.record);
    if (audit) push(audit.markdownDigest);
  } else if (opKind === "live.audit.base") {
    const audit = asRecord(record.record);
    const checkpoint = audit ? asRecord(audit.checkpoint) : null;
    if (checkpoint) push(checkpoint.stateDigest);
  } else if (opKind === "secret.file.put") {
    push(record.ciphertextSha256);
  } else if (opKind === "secret.version.fork") {
    const rows = Array.isArray(record.rows) ? record.rows : [];
    for (const raw of rows) {
      const row = asRecord(raw);
      if (row) push(row.ciphertextSha256);
    }
  }
  return shas;
}
