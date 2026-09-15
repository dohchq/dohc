// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {afterEach, expect, it, vi} from "vitest";
import {OwnerRestoreDialog} from "./OwnerRestoreDialog";
import {OwnerRestoreReview, type OwnerRestoreRequest} from "../ipc/ownerRestoreContract";
import {ownerRestoreOutcomes} from "./ownerRestoreOutcomes";
import {deferred} from "../testing/deferred";

const documentKey = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
const binding = {...documentKey, currentPath: "notes.md", selectorPaths: ["notes.md"], restoreFenceGeneration: 1};
const digest = "a".repeat(64), proposalDigest = "b".repeat(64);
const receipt = (cursor: number) => ({deliveryId: `event-${cursor}`, updateDigest: digest, journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(1)});
function reviewFixture() {
  return OwnerRestoreReview.parse({operationId: "restore", workspaceId: "workspace", binding, proposalDigest, candidateDigest: digest,
    recordedAtMs: 9, selectedPointReceivedAtMs: null, point: {journalCursor: 0, receiptDigest: digest, markdownDigest: digest}, frozenTerminal: receipt(3),
    selectedEventCount: 0, acceptedEventCount: 3, selectedHistoryDigest: digest, acceptedHistoryDigest: digest, nativeSourceManifestDigest: digest,
    content: {frozenMarkdown: "Current text", restoredMarkdown: "Earlier text", frozenMarkdownDigest: digest, restoredMarkdownDigest: digest,
      frozenMarkdownByteLength: 12, restoredMarkdownByteLength: 12},
    acceptedEvents: [1, 2, 3].map(cursor => ({metadata: {accepted: {binding, receipt: receipt(cursor),
      authority: {principalKind: "owner", principalId: "owner", grantId: null, grantGeneration: null}, receivedAtMs: cursor}, firstSeen: []}, restoreOperationId: null})),
    priorRestoreCuts: [{operationId: "earlier", proposalDigest: digest, restoreJournalCursor: 3, selectedEventCount: 0,
      acceptedEventCount: 2, selectedTerminal: null, frozenTerminal: receipt(2)}],
    nativeSources: [{source: {deliveryId: "event-3", updateDigest: digest}, acceptedReceipt: receipt(3), acceptedRelation: "after-selected",
      occurrences: [{operationId: "restore", proposalDigest, context: "current-fence", acceptedReceipt: receipt(3)}]}],
  });
}
function fixture(pointCursor = 0) {
  const intent = {deliveryKind: "owner" as const, operationId: "restore", document: documentKey, shareId: "share", grantId: "grant",
    expectedGrantGeneration: 1, expectedDependentGrantIds: ["dependent"], expectedFence: 1, restorePointCursor: pointCursor, restorePointReceiptDigest: digest};
  let status = {operationId: "restore", document: documentKey, path: "notes.md", phase: "authority-invalidated", intent, proposalDigest: null as string | null};
  const recipients = [{grantId: "grant", principalKind: "link" as const, email: null, userId: null},
    {grantId: "dependent", principalKind: "user" as const, email: "reader@example.test", userId: "reader"}];
  const options = {document: documentKey, path: "notes.md", grants: [{...recipients[0]!, shareId: "share", generation: 1}],
    points: [{cursor: pointCursor, receivedAtMs: pointCursor ? 1788922800000 : null, kind: pointCursor ? "accepted" : "baseline", receiptDigest: digest}], nextBeforeCursor: null, nextGrantCursor: null, pendingOperation: null};
  const call = vi.fn(async (input: OwnerRestoreRequest): Promise<unknown> => {
    if (input.action === "options") return options;
    if (input.action === "plan") return {intent, path: "notes.md", recipients};
    if (input.action === "begin" || input.action === "status") return status;
    if (input.action === "prepare") return {status, result: {kind: "prepared", proposalDigest, candidateDigest: digest, recordedAtMs: 9, replayed: false}};
    if (input.action === "review") return {status, result: reviewFixture()};
    status = {...status, phase: "resumed", proposalDigest};
    return {status, result: {kind: "resumed", proposalDigest, receipt: {}}};
  });
  window.dohcDesktop = {ownerRestore: call} as unknown as typeof window.dohcDesktop;
  const close = vi.fn(), restored = vi.fn(), release = vi.fn();
  const props = {workspaceId: "workspace", path: "notes.md", onClose: close, onRestored: restored, onBeforeRestore: vi.fn(async () => release)};
  return {call, props, close, restored, release, options, intent, status: () => status};
}
afterEach(() => {cleanup(); delete window.dohcDesktop;});
async function openStop(point = "0") {
  await screen.findByRole("combobox", {name: "Access to stop"});
  fireEvent.change(screen.getByRole("combobox", {name: "Access to stop"}), {target: {value: "grant"}});
  fireEvent.change(screen.getByRole("combobox", {name: "Shared restore point"}), {target: {value: point}});
  fireEvent.click(screen.getByRole("button", {name: "Review affected access"}));
  await screen.findByText("Stop access before restoring?");
}
it("requires separate stop and content confirmations and names every affected recipient", async () => {
  const f = fixture(); render(<OwnerRestoreDialog {...f.props} />); await openStop();
  expect(screen.getByText("This access stays stopped, even if you decline the restore.")).toBeTruthy();
  expect(screen.getByText("reader@example.test")).toBeTruthy();
  expect(f.call.mock.calls.some(([i]) => i.action === "begin" || i.action === "confirm")).toBe(false);
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  await screen.findByRole("button", {name: "Restore file"});
  expect(screen.getByText("Restore point: Before accepted edits")).toBeTruthy();
  expect(f.call.mock.calls.some(([i]) => i.action === "confirm")).toBe(false);
  expect(screen.getByRole("textbox", {name: "Current file before restore"})).toHaveProperty("value", "Current text");
  expect(screen.getByRole("textbox", {name: "File after restore"})).toHaveProperty("value", "Earlier text");
  fireEvent.click(screen.getByRole("button", {name: "Restore file"}));
  await screen.findByText("File restored");
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "confirm", operationId: "restore", proposalDigest});
  expect(f.restored).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
});
it("allows declining content replacement after access stops", async () => {
  const f = fixture(); render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  fireEvent.click(screen.getByRole("button", {name: "Close"}));
  expect(f.close).toHaveBeenCalled(); expect(f.call.mock.calls.some(([i]) => i.action === "confirm")).toBe(false);
});
it("returns a missing proposal to review without reporting completion", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "confirm" ? Promise.resolve({status: f.status(), result: {kind: "review-required"}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  fireEvent.click(screen.getByRole("button", {name: "Restore file"})); await screen.findByText("The restore needs a new review. Retry to review it again.");
  expect(screen.queryByText("File restored")).toBeNull(); expect(f.restored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Retry"})); await screen.findByRole("button", {name: "Restore file"});
  expect(f.call.mock.calls.filter(([i]) => i.action === "confirm")).toHaveLength(1);
});
it("drops an old workspace response while the next workspace loads", async () => {
  const f = fixture(), old = deferred<unknown>();
  f.call.mockImplementation(input => input.workspaceId === "workspace" ? old.promise : Promise.resolve({...f.options, document: {...documentKey, workspaceId: "other"}, path: "other.md"}));
  const mounted = render(<OwnerRestoreDialog {...f.props} />);
  mounted.rerender(<OwnerRestoreDialog {...f.props} workspaceId="other" path="other.md" />);
  await screen.findByRole("combobox", {name: "Access to stop"});
  await act(async () => old.resolve({...f.options, pendingOperation: {operationId: "old-restore", phase: "native-fenced", proposalDigest: null}}));
  expect(screen.getByText("other.md")).toBeTruthy();
  expect(f.call.mock.calls.some(([i]) => i.action === "status")).toBe(false);
});
it("keeps overlapping historical exclusions and counts accepted native sources once", () => {
  const review = reviewFixture();
  review.priorRestoreCuts.push({...review.priorRestoreCuts[0]!, operationId: "overlap", selectedTerminal: receipt(1)});
  const groups = ownerRestoreOutcomes(review);
  expect(groups.excluded.map(e => e.metadata.accepted.receipt.journalCursor)).toEqual([1, 2]);
  expect(groups.removed.map(e => e.metadata.accepted.receipt.journalCursor)).toEqual([3]);
  expect(groups.local).toEqual([]);
});

it("recovers a lost admitted confirmation reply using fresh status", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let lost = false;
  f.call.mockImplementation(async input => {
    const result = await original(input);
    if (input.action === "confirm" && !lost) {lost = true; throw Error("The connection closed.");}
    return result;
  });
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  fireEvent.click(screen.getByRole("button", {name: "Restore file"})); await screen.findByText("The connection closed.");
  expect(f.restored).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  const beforeRetry = f.call.mock.calls.length;
  fireEvent.click(screen.getByRole("button", {name: "Retry"})); await screen.findByText("File restored");
  expect(f.call.mock.calls.slice(beforeRetry).map(([input]) => input.action)).toEqual(["status", "confirm"]);
  expect(f.restored).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(2);
});
it("reopens a stopped operation for review without first admitting content", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "options" ? Promise.resolve({...f.options,
    pendingOperation: {operationId: "restore", phase: "native-fenced", proposalDigest: null}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByText("Access stopped. Continue reviewing or finishing this restore.");
  fireEvent.click(screen.getByRole("button", {name: "Retry"})); await screen.findByRole("button", {name: "Restore file"});
  expect(f.call.mock.calls.some(([input]) => input.action === "begin" || input.action === "confirm")).toBe(false);
});
it("releases the local restore pause when scope changes while it is acquiring", async () => {
  const f = fixture(), pause = deferred<typeof f.release>();
  f.props.onBeforeRestore.mockImplementation(() => pause.promise);
  const mounted = render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  fireEvent.click(screen.getByRole("button", {name: "Restore file"}));
  mounted.rerender(<OwnerRestoreDialog {...f.props} path="other.md" />);
  await act(async () => pause.resolve(f.release));
  expect(f.release).toHaveBeenCalledTimes(1); expect(f.restored).not.toHaveBeenCalled();
  expect(f.call.mock.calls.some(([input]) => input.action === "confirm")).toBe(false);
});

it("loads later access after an empty source page and preserves the selected point", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  const cursor = {shareCreatedAtMs: 1, shareId: "unrelated", grantCreatedAtMs: null, grantId: null};
  f.call.mockImplementation(input => input.action === "options" ? Promise.resolve(input.grantCursor ? f.options :
    {...f.options, grants: [], nextGrantCursor: cursor}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByRole("button", {name: "More access choices"});
  expect(screen.queryByText("No active edit access is available for this file. Close this review.")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", {name: "Shared restore point"}), {target: {value: "0"}});
  fireEvent.click(screen.getByRole("button", {name: "More access choices"}));
  await screen.findByRole("option", {name: "Anyone using this link"});
  expect(screen.getByRole("combobox", {name: "Shared restore point"})).toHaveProperty("value", "0");
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "options", path: "notes.md", grantCursor: cursor});
  fireEvent.change(screen.getByRole("combobox", {name: "Access to stop"}), {target: {value: "grant"}});
  fireEvent.click(screen.getByRole("button", {name: "Review affected access"}));
  await screen.findByText("Stop access before restoring?");
});

it("identifies the accepted restore point in the review", async () => {
  const f = fixture(7), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async input => {
    if (input.action !== "review") return original(input);
    const review = reviewFixture(); review.point.journalCursor = 7; review.selectedPointReceivedAtMs = 1788922800000;
    return {status: f.status(), result: OwnerRestoreReview.parse(review)};
  });
  render(<OwnerRestoreDialog {...f.props} />); await openStop("7");
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  expect(screen.getByText("Change 7")).toBeTruthy();
  expect(document.querySelector("time")?.dateTime).toBe(new Date(1788922800000).toISOString());
});

it("rejects a missing accepted time, a fabricated baseline time, and dates the review cannot render", () => {
  const baseline = reviewFixture();
  expect(OwnerRestoreReview.safeParse({...baseline, selectedPointReceivedAtMs: 30}).success).toBe(false);
  const accepted = {...baseline, point: {...baseline.point, journalCursor: 1}};
  for (const selectedPointReceivedAtMs of [null, undefined, Number.MAX_SAFE_INTEGER]) {
    expect(OwnerRestoreReview.safeParse({...accepted, selectedPointReceivedAtMs}).success).toBe(false);
  }
});
