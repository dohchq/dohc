import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OwnerRestoreDialog } from "../../../src/renderer/OwnerRestoreDialog";
import { NoticeCenter, type WorkspaceErrorNotice } from "../../../src/renderer/workbench/NoticeCenter";
import "./styles.css";

// The production restore review and notice toast. Only the desktop bridge is
// replaced: a restore whose access already stopped, waiting for its review.
const path = "notes/launch-plan.md";
const documentKey = { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "c".repeat(64) };
const binding = { ...documentKey, currentPath: path, selectorPaths: [path], restoreFenceGeneration: 1 };
const digest = "a".repeat(64);
const proposalDigest = "b".repeat(64);
const receipt = (cursor: number) => ({ deliveryId: `change-${cursor}`, updateDigest: digest, journalCursor: cursor, acceptingHostEpoch: 1 });
const text = (label: string) => Array.from({ length: 6 }, (_, index) => `${label} ${index + 1}`).join("\n");
const review = {
  operationId: "restore", workspaceId: "workspace", binding, proposalDigest, candidateDigest: digest, recordedAtMs: 9,
  point: { journalCursor: 0, receiptDigest: digest, markdownDigest: digest }, selectedPointReceivedAtMs: null,
  frozenTerminal: receipt(20), selectedEventCount: 0, acceptedEventCount: 20,
  selectedHistoryDigest: digest, acceptedHistoryDigest: digest, nativeSourceManifestDigest: digest,
  content: { frozenMarkdown: text("Shared edit"), restoredMarkdown: text("Launch step"), frozenMarkdownDigest: digest,
    restoredMarkdownDigest: digest, frozenMarkdownByteLength: 1, restoredMarkdownByteLength: 1 },
  acceptedEvents: Array.from({ length: 20 }, (_, index) => ({ restoreOperationId: null, metadata: { firstSeen: [], accepted: {
    binding, receipt: receipt(index + 1), receivedAtMs: 1_788_922_800_000 + index * 60_000,
    authority: { principalKind: "named", principalId: "reader", grantId: "grant", grantGeneration: 1 },
  } } })),
  priorRestoreCuts: [],
  nativeSources: [],
};
const intent = { deliveryKind: "owner", operationId: "restore", document: documentKey, shareId: "share", grantId: "grant",
  expectedGrantGeneration: 1, expectedDependentGrantIds: [], expectedFence: 1, restorePointCursor: 0, restorePointReceiptDigest: digest };
let status = { operationId: "restore", document: documentKey, path, phase: "native-fenced", intent, proposalDigest: null as string | null };

(window as unknown as { dohcDesktop: unknown }).dohcDesktop = {
  getUpdateState: () => new Promise(() => {}),
  onUpdateState: () => () => {},
  async ownerRestore(input: { action: string }) {
    if (input.action === "options") {
      return { document: documentKey, path, grants: [], points: [], nextBeforeCursor: null, nextGrantCursor: null,
        pendingOperation: { operationId: "restore", phase: "native-fenced", proposalDigest: null } };
    }
    if (input.action === "status") return status;
    if (input.action === "prepare") {
      return { status, result: { kind: "prepared", proposalDigest, candidateDigest: digest, recordedAtMs: 9, replayed: false } };
    }
    if (input.action === "review") {
      status = { ...status, proposalDigest };
      return { status, result: review };
    }
    if (input.action === "confirm") {
      status = { ...status, phase: "resumed", proposalDigest };
      return { status, result: { kind: "resumed", proposalDigest, receipt: {} } };
    }
    throw new Error(`Unexpected restore request: ${input.action}`);
  },
};

const workspaceErrors: WorkspaceErrorNotice[] = [{
  id: "share-refresh", message: "dohc could not refresh who can edit notes/launch-plan.md. Check your connection, then try again.",
  details: "Notice: Sharing refresh failed", atMs: 1_788_922_800_000, canRetry: true, seen: false,
}];
const ignore = () => {};

function SharedRestoreFixture() {
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  return (
    <main className="flex h-screen bg-bg text-ink">
      <nav className="flex w-12 flex-col items-center justify-end border-r border-line bg-panel-2 pb-2">
        <NoticeCenter
          workspaceId="workspace"
          syncStatus={null}
          agentActive={false}
          conflictSummaries={[]}
          onOpenHistory={ignore}
          onOpenSettings={ignore}
          onOpenConflicts={ignore}
          onRefreshShareView={ignore}
          onRebuildEngineStore={ignore}
          workspaceErrors={workspaceErrors}
          onRetryWorkspaceError={ignore}
          onHideWorkspaceError={ignore}
          onDismissWorkspaceError={ignore}
        />
      </nav>
      <section className="flex-1 p-6">
        <button type="button" onClick={() => setOpen(true)}>Open restore review</button>
        <output aria-label="Restore result">{restored ? "restored" : ""}</output>
      </section>
      {open ? (
        <OwnerRestoreDialog
          workspaceId="workspace"
          path={path}
          onClose={() => setOpen(false)}
          onBeforeRestore={async () => ignore}
          onRestored={() => setRestored(true)}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SharedRestoreFixture />);
