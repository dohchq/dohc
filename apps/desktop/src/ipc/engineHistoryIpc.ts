// Pure engine-history -> IPC record mappers, extracted from main.ts so the
// per-side content-kind rules are unit-testable (WS-G1 review fix). main
// injects how agent and automation authors read; nothing here touches
// Electron or process state.
import type { VersionedTextMomentSummary } from "@dohc/workspace-contracts/engine";
import type {
  WorkspaceEngineCapture,
  WorkspaceEngineMomentDetail,
  WorkspaceEngineMomentSummary,
} from "../workspaces/workspaceEngineCapture";
import type {
  EngineMomentDetailRecord,
  EngineMomentRecord,
  ListEngineMomentsResponse,
  WorkspaceVersionConflict,
} from "./bridgeContract";
import { ListEngineMomentsResponse as ListEngineMomentsResponseSchema } from "./bridgeContract";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";

type MomentAuthor = NonNullable<VersionedTextMomentSummary["author"]>;

// Main supplies how an author reads. An agent follows the display-name rule
// the chat rail uses (onBehalfOf "local" -> the cloud email or "You";
// anything else is already a user-facing label). An automation reads as its
// name and the Collection it belongs to.
export interface EngineMomentAuthorNames {
  agent(author: Extract<MomentAuthor, {kind: "agent"}>): string;
  automation(automationId: string): { name: string; collection: string | null };
}

export async function listEngineMomentsForIpc(
  read: () => ReturnType<WorkspaceEngineCapture["listMoments"]>,
  names: EngineMomentAuthorNames,
): Promise<ListEngineMomentsResponse> {
  try {
    const page = await read();
    return ListEngineMomentsResponseSchema.parse({
      moments: page.moments.map((moment) =>
        engineMomentForIpc(moment, names),
      ),
      nextBeforeMomentOrder: page.nextBeforeMomentOrder,
      latestMomentOrder: page.latestMomentOrder,
      activeVersionId: page.activeVersionId,
      protectedTruncated: page.protectedTruncated,
    });
  } catch (error) {
    if (isWorkspaceUpdatingRefusal(error)) {
      return ListEngineMomentsResponseSchema.parse({ status: "updating" });
    }
    throw error;
  }
}

// The shared id/version/path/timestamp/metadata shape both engine-moment
// record formats are built from — one mapper so they can never drift.
function engineMomentBaseForIpc(
  moment: Pick<
    WorkspaceEngineMomentSummary,
    "id" | "versionId" | "path" | "recordedAtMs" | "operation" | "metadata" | "author"
  >,
  names: EngineMomentAuthorNames,
) {
  return {
    id: moment.id,
    versionId: moment.versionId,
    path: moment.path,
    recordedAtMs: moment.recordedAtMs,
    operation: moment.operation,
    origin: moment.metadata.origin,
    ...(moment.author?.kind === "agent"
      ? { agentAuthorName: names.agent(moment.author) }
      : {}),
    ...(moment.author?.kind === "public" ? { publicAuthor: moment.author } : {}),
    ...(moment.author?.kind === "automation"
      ? { automationAuthor: names.automation(moment.author.automationId) }
      : {}),
    ...(moment.metadata.summary !== undefined
      ? { summary: moment.metadata.summary }
      : {}),
    ...(moment.metadata.correlationId !== undefined
      ? { correlationId: moment.metadata.correlationId }
      : {}),
  };
}

function engineMomentForIpc(
  moment: WorkspaceEngineMomentSummary,
  names: EngineMomentAuthorNames,
): EngineMomentRecord {
  return {
    ...engineMomentBaseForIpc(moment, names),
    momentOrder: moment.momentOrder,
    // Only stamped for protected (secret-backed) moments so ordinary rows
    // stay byte-identical to the pre-PR-08 shape.
    ...(moment.protected ? { protected: true } : {}),
    ...(moment.contentKind === "binary"
      ? { contentKind: "binary" as const, byteLength: moment.byteLength ?? 0 }
      : {}),
  };
}

// A binary payload side presents as bytes (byteLength/sha256) — it never
// serves text, so a text/binary transition can't fake an empty text side.
function binarySideDetail(side: { sha256?: string; byteLength?: number }) {
  return {
    byteLength: side.byteLength ?? 0,
    ...(side.sha256 ? { sha256: side.sha256 } : {}),
  };
}

export function engineMomentDetailForIpc(
  detail: WorkspaceEngineMomentDetail,
  names: EngineMomentAuthorNames,
): EngineMomentDetailRecord {
  if (detail.protected) {
    // Protected moments are metadata-only: no payload exists anywhere, so
    // both text sides are null and the renderer shows "Contents are
    // protected" in place of a diff.
    return {
      ...engineMomentBaseForIpc(detail.moment, names),
      protected: true,
      beforeText: null,
      afterText: null,
    };
  }
  const moment = detail.moment;
  const before = moment.payload.before ?? null;
  const after = moment.payload.after;
  // Classified per side (WS-G1 review fix): a binary->text transition must
  // not serve the binary preimage's empty anchor text as beforeText (a
  // false empty->text diff) — each side presents by its own contentKind.
  const beforeBinary = before !== null && before.contentKind === "binary" ? before : null;
  const afterBinary = after.contentKind === "binary" ? after : null;
  return {
    ...engineMomentBaseForIpc(moment, names),
    // The record-level kind mirrors the timeline row: keyed on the after
    // side, so a pure-binary detail keeps its established shape.
    ...(afterBinary !== null
      ? { contentKind: "binary" as const, byteLength: afterBinary.byteLength ?? 0 }
      : {}),
    beforeText: beforeBinary !== null ? null : (before?.text ?? null),
    // A delete moment stores the removed content as its payload; the diff
    // page renders it as before -> nothing.
    afterText:
      afterBinary !== null || moment.operation === "delete" ? null : after.text,
    ...(beforeBinary !== null ? { beforeBinary: binarySideDetail(beforeBinary) } : {}),
    ...(afterBinary !== null ? { afterBinary: binarySideDetail(afterBinary) } : {}),
  };
}

export function versionConflictForIpc(conflict: {
  id: string;
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
  // Present on engine conflict records; origin "sync" marks a two-machine
  // divergence (the review UI labels sides as machines, not versions).
  metadata?: { origin?: string };
  current: { exists: boolean; text?: string; contentKind?: "text" | "binary"; sha256?: string; byteLength?: number };
  incoming: { exists: boolean; text?: string; contentKind?: "text" | "binary"; sha256?: string; byteLength?: number };
  base: { exists: boolean; text?: string; contentKind?: "text" | "binary"; sha256?: string; byteLength?: number };
}): WorkspaceVersionConflict {
  // Record-level kind answers one question: can these two sides be combined as
  // text? Only the live sides decide it. A binary BASE is history, and keying
  // on it would hide two readable texts behind a binary notice; a binary
  // current or incoming means there is no second text to combine, which is
  // exactly when `resolve_text_conflict` refuses combined text.
  const contentKind =
    conflict.current.contentKind === "binary" || conflict.incoming.contentKind === "binary"
      ? "binary"
      : "text";
  // Each side reports its own kind. A mixed conflict carries the readable
  // text beside its binary sibling, so the user reads the side they can read
  // instead of choosing blind between two "Binary file" notices.
  const textSide = (side: {
    exists: boolean;
    text?: string;
    contentKind?: "text" | "binary";
  }) => (side.exists && side.contentKind !== "binary" ? (side.text ?? "") : null);
  const binarySide = (side: {
    exists: boolean;
    contentKind?: "text" | "binary";
    sha256?: string;
    byteLength?: number;
  }) =>
    // A side without a real content hash serializes as null — never
    // sha256: "", which fails the wire schema and would turn a mixed
    // binary/text conflict into an IPC error.
    side.exists && side.contentKind === "binary" && side.sha256
      ? {
          sha256: side.sha256,
          byteLength: side.byteLength ?? 0,
        }
      : null;
  return {
    conflictId: conflict.id,
    path: conflict.path,
    sourceVersionId: conflict.sourceVersionId,
    targetVersionId: conflict.targetVersionId,
    origin: conflict.metadata?.origin === "sync" ? "sync" : "merge",
    contentKind,
    currentText: textSide(conflict.current),
    incomingText: textSide(conflict.incoming),
    baseText: textSide(conflict.base),
    ...(contentKind === "binary"
      ? {
          currentBinary: binarySide(conflict.current),
          incomingBinary: binarySide(conflict.incoming),
          baseBinary: binarySide(conflict.base),
        }
      : {}),
  };
}
