import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { EngineMomentRecord } from "../../../src/ipc/bridgeContract";
import { OwnerRestoreDialog } from "../../../src/renderer/OwnerRestoreDialog";
import { EngineHistoryView } from "../../../src/renderer/workbench/EngineHistory";
import { NoticeCenter, type WorkspaceErrorNotice } from "../../../src/renderer/workbench/NoticeCenter";
import { ConnectionNotices } from "../../../src/renderer/shell/connectionNotices";
import { Overlay } from "../../../src/renderer/Overlay";
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
  point: { journalCursor: 0, receiptDigest: digest, markdownDigest: digest }, selectedPointReceivedAtMs: null, selectedPointAuthority: null,
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
      return { document: documentKey, path, grants: [], points: [], authors: [], nextBeforeCursor: null, nextGrantCursor: null,
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

const workspaceError: WorkspaceErrorNotice = {
  id: "share-refresh", message: "dohc could not refresh who can edit notes/launch-plan.md. Check your connection, then try again.",
  details: "Notice: Sharing refresh failed", atMs: 1_788_922_800_000, canRetry: true, seen: false,
};
const ignore = () => {};
// Several days of History, so a day heading sticks at the top of the list.
const moments: EngineMomentRecord[] = Array.from({ length: 40 }, (_, index) => ({
  id: `moment-${index}`,
  versionId: "main",
  path,
  recordedAtMs: new Date(2026, 8, 17, 18).getTime() - index * 3 * 3_600_000,
  operation: "write",
  origin: "local-file",
  momentOrder: 40 - index,
}));
const entries = moments.map((moment) => ({ kind: "file" as const, moment }));

function SharedRestoreFixture() {
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const [retries, setRetries] = useState(0);
  const [toastClosed, setToastClosed] = useState(false);
  const [warning, setWarning] = useState(false);
  const notices = [{ ...workspaceError, seen: toastClosed }];
  // ?host=corner draws the notices the way a window without the shell does:
  // the corner host in its own fixed wrapper.
  if (new URLSearchParams(location.search).get("host") === "corner") {
    return (
      <main className="h-screen bg-bg p-6 text-ink">
        <button type="button" onClick={() => setWarning(true)}>Open warning</button>
        <output aria-label="Toast retries">{retries}</output>
        <ConnectionNotices
          notices={notices}
          onRetry={() => setRetries((count) => count + 1)}
          onHide={() => setToastClosed(true)}
          onDismiss={ignore}
        />
        {warning ? (
          <Overlay appearance="warning" onClose={() => setWarning(false)} panelProps={{ role: "dialog", "aria-modal": true, "aria-label": "Close dohc?",
            className: "dohc-elevated w-96 rounded-xl border border-line bg-bg p-5" }}>
            <p className="m-0 text-[13px]">Close dohc? A draft is still waiting to save.</p>
            <button type="button" className="mt-4">Keep dohc open</button>
          </Overlay>
        ) : null}
      </main>
    );
  }
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
          workspaceErrors={notices}
          onRetryWorkspaceError={() => setRetries((count) => count + 1)}
          onHideWorkspaceError={() => setToastClosed(true)}
          onDismissWorkspaceError={ignore}
        />
      </nav>
      {/* The History panel at the desktop sidebar's width. Its top offset
          stands in for the window and panel headers above it, which puts a
          day heading level with the review's title. */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel-2 pt-20">
        <EngineHistoryView
          entries={entries}
          hasMore={false}
          loadingMore={false}
          onLoadMore={ignore}
          onOpenMoment={ignore}
        />
      </aside>
      <section className="flex-1 p-6">
        <button type="button" onClick={() => setOpen(true)}>Open restore review</button>
        <output aria-label="Restore result">{restored ? "restored" : ""}</output>
        <output aria-label="Toast retries">{retries}</output>
      </section>
      {open ? (
        <OwnerRestoreDialog
          workspaceId="workspace"
          path={path}
          onClose={() => setOpen(false)}
          onBeforeRestore={async () => ignore}
          onRestored={() => setRestored(true)}
          onError={ignore}
          onSettled={ignore}
          onChanged={ignore}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SharedRestoreFixture />);
