// Pure engine-history -> IPC record mappers, extracted from main.ts so the
// per-side content-kind rules are unit-testable (WS-G1 review fix). main
// injects how agent, named, and automation authors read, and the Collection
// automations it names them from; nothing here touches Electron or process
// state.
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
import { posix } from "node:path";
import { AUTOMATION_AUTHOR_TEXT_MAX, ListEngineMomentsResponse as ListEngineMomentsResponseSchema } from "./bridgeContract";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import { parseCollectionAutomationId } from "@dohc/automation-executor/automation-plan";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";

type MomentAuthor = NonNullable<VersionedTextMomentSummary["authors"]>[number];

// Main supplies how an author reads. An agent working for this computer's
// person reads as the configured agent name, and any other agent as
// "Agent". This computer's person reads as their name; any other person is
// left unnamed. A Collection automation
// reads as its name and the Collection it belongs to; null leaves any other
// automation on the moment's origin label.
export interface EngineMomentAuthorNames {
  prepare?(authors: readonly MomentAuthor[]): void;
  agent(author: Extract<MomentAuthor, {kind: "agent"}>): string | undefined;
  person(author: Extract<MomentAuthor, {kind: "human"}>): string | undefined;
  automation(automationId: string): { name: string; collection?: string } | null;
  named(author: Extract<MomentAuthor, {kind: "named"}>): string;
}

// A Collection automation that wrote a moment, as History shows it: its
// name from the workspace's automations.yaml as this computer read it, or
// its id when the file no longer has it or the name is longer than History
// shows, and the Collection it belongs to now. Any other automation keeps
// the moment's origin label.
export function collectionAutomationAuthor(
  automations: Pick<CollectionAutomations, "locate" | "automationName"> | undefined,
  automationId: string,
): { name: string; collection?: string } | null {
  const parsed = parseCollectionAutomationId(automationId);
  if (parsed === null) return null;
  const located = automations?.locate(automationId) ?? null;
  const name = automations?.automationName(automationId) ?? null;
  return {
    name: name !== null && name.length <= AUTOMATION_AUTHOR_TEXT_MAX ? name : parsed.id,
    ...(located === null ? {} : { collection: posix.basename(located.collectionPath) }),
  };
}

// A live author snapshot's account holder or link holder, as the relay
// admitted them.
function isSnapshotPerson(author: MomentAuthor): boolean {
  return (author.kind === "human" && "humanName" in author) || (author.kind === "link" && "publicPrincipalId" in author);
}

// How one of several authors reads. A moment one author wrote keeps the
// singleton fields below instead. A snapshot reads as the name its agent
// declared and the relay stored for its account or link holder.
function authorLabel(author: MomentAuthor, names: EngineMomentAuthorNames): string {
  switch (author.kind) {
    case "unattributed": return "An unrecorded author";
    case "agent": return author.agentName ?? names.agent(author) ?? "Agent";
    case "human": return author.humanName ?? names.person(author) ?? "Another person";
    case "named": return names.named(author);
    case "link": return "publicPrincipalId" in author ? `Link holder ${author.label}` : `Edit link · holder ${author.principalId.slice(0, 8)}`;
    case "public": return `Link holder ${author.principalId}`;
    case "automation": {
      const automation = names.automation(author.automationId);
      if (!automation) return "Automation";
      return automation.collection === undefined ? automation.name : `${automation.name} in ${automation.collection}`;
    }
  }
}

export async function listEngineMomentsForIpc(
  read: () => ReturnType<WorkspaceEngineCapture["listMoments"]>,
  names: EngineMomentAuthorNames,
): Promise<ListEngineMomentsResponse> {
  try {
    const page = await read();
    names.prepare?.(page.moments.flatMap(moment => moment.authors ?? []));
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
    "id" | "versionId" | "path" | "recordedAtMs" | "operation" | "metadata" | "authors"
  >,
  names: EngineMomentAuthorNames,
) {
  // Keep every author in IPC. Existing display fields name singleton authors.
  const author = moment.authors?.length === 1 ? moment.authors[0] : undefined;
  const agentAuthorName = author?.kind === "agent" ? author.agentName ?? names.agent(author) : undefined;
  const personAuthorName = author?.kind === "human" && !("humanName" in author) ? names.person(author) : undefined;
  const liveAuthorName = author !== undefined && isSnapshotPerson(author) ? authorLabel(author, names) : undefined;
  return {
    id: moment.id,
    versionId: moment.versionId,
    path: moment.path,
    recordedAtMs: moment.recordedAtMs,
    operation: moment.operation,
    origin: moment.metadata.origin,
    ...(moment.authors !== undefined ? { authors: moment.authors } : {}),
    ...(agentAuthorName !== undefined
      ? { agentAuthorName }
      : {}),
    ...(personAuthorName !== undefined ? { personAuthorName } : {}),
    ...(liveAuthorName !== undefined ? { liveAuthorName } : {}),
    ...(author?.kind === "public" ? { publicAuthor: author } : {}),
    // Only a grant's Edit link wrote directly; a snapshot's link holder never
    // offers Stop and restore.
    ...(author?.kind === "link" && "grantId" in author ? { linkAuthor: author } : {}),
    ...automationAuthorOf(author, names),
    ...(author?.kind === "named"
      ? { namedAuthor: { userId: author.userId, label: names.named(author) } }
      : {}),
    // Several authors: each of them, in the order the moment recorded them.
    // None stands in for the rest.
    ...(moment.authors !== undefined && moment.authors.length > 1
      ? { authorLabels: moment.authors.map((each) => authorLabel(each, names)) }
      : {}),
    ...(moment.operation !== "rename" && moment.metadata.summary !== undefined
      ? { summary: moment.metadata.summary }
      : {}),
    ...(moment.metadata.correlationId !== undefined
      ? { correlationId: moment.metadata.correlationId }
      : {}),
  };
}

function automationAuthorOf(author: MomentAuthor | undefined, names: EngineMomentAuthorNames) {
  const automationAuthor = author?.kind === "automation" ? names.automation(author.automationId) : null;
  return automationAuthor === null ? {} : { automationAuthor };
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
