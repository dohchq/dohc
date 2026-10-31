// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, within} from "@testing-library/react";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {afterEach, expect, it, vi} from "vitest";
import {OwnerRestoreDialog} from "./OwnerRestoreDialog";
import {OwnerRestoreReview, type OwnerRestoreRequest} from "../ipc/ownerRestoreContract";
import {ownerRestoreOutcomes} from "./ownerRestoreOutcomes";
import {deferred} from "../testing/deferred";

const documentKey = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
const binding = {...documentKey, currentPath: "notes.md", selectorPaths: ["notes.md"], restoreFenceGeneration: 1};
const digest = "a".repeat(64), proposalDigest = "b".repeat(64);
const owner = {principalKind: "owner" as const, principalId: "owner", grantId: null, grantGeneration: null};
const reader = {principalKind: "named" as const, principalId: "reader", grantId: "grant", grantGeneration: 1};
const receipt = (cursor: number) => ({deliveryId: `event-${cursor}`, updateDigest: digest, journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(1)});
function reviewFixture() {
  return OwnerRestoreReview.parse({operationId: "restore", workspaceId: "workspace", binding, proposalDigest, candidateDigest: digest,
    recordedAtMs: 9, selectedPointReceivedAtMs: null, selectedPointAuthority: null, point: {journalCursor: 0, receiptDigest: digest, markdownDigest: digest}, frozenTerminal: receipt(3),
    selectedEventCount: 0, acceptedEventCount: 3, selectedHistoryDigest: digest, acceptedHistoryDigest: digest, nativeSourceManifestDigest: digest,
    content: {frozenMarkdown: "Current text", restoredMarkdown: "Earlier text", frozenMarkdownDigest: digest, restoredMarkdownDigest: digest,
      frozenMarkdownByteLength: 12, restoredMarkdownByteLength: 12},
    acceptedEvents: [1, 2, 3].map(cursor => ({metadata: {accepted: {binding, receipt: receipt(cursor),
      authority: {principalKind: "owner", principalId: "owner", grantId: null, grantGeneration: null}, receivedAtMs: cursor}, firstSeen: [],
      canonicalVersion: 2, authorSnapshot: cursor === 3 ? [{kind: "agent", agentId: "trip-agent-hosted", onBehalfOf: "local-person", depth: 0}] : [], firstSeenDeletes: []}, restoreOperationId: null})),
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
    points: [{cursor: pointCursor, receivedAtMs: pointCursor ? 1788922800000 : null, kind: pointCursor ? "accepted" : "baseline", receiptDigest: digest,
      authority: pointCursor ? owner : null}], authors: [], nextBeforeCursor: null, nextGrantCursor: null, pendingOperation: null};
  const call = vi.fn(async (input: OwnerRestoreRequest): Promise<unknown> => {
    if (input.action === "options") return options;
    if (input.action === "plan") return {intent, path: "notes.md", recipients};
    if (input.action === "begin" || input.action === "status") return status;
    if (input.action === "prepare") {
      status = {...status, phase: "native-fenced"};
      return {status, result: {kind: "prepared", proposalDigest, candidateDigest: digest, recordedAtMs: 9, replayed: false}};
    }
    if (input.action === "review") return {status, result: reviewFixture()};
    status = {...status, phase: "resumed", proposalDigest};
    return {status, result: {kind: "resumed", proposalDigest, receipt: {}, moved: false}};
  });
  window.dohcDesktop = {ownerRestore: call} as unknown as typeof window.dohcDesktop;
  const close = vi.fn(), restored = vi.fn(), release = vi.fn(), error = vi.fn(), refused = vi.fn(), settled = vi.fn(), changed = vi.fn();
  const props = {workspaceId: "workspace", path: "notes.md", onClose: close, onRestored: restored, onBeforeRestore: vi.fn(async () => release), onError: error,
    onDeclineRefused: refused, onSettled: settled, onChanged: changed};
  return {call, props, close, restored, release, error, refused, settled, changed, options, intent, status: () => status};
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
  expect(f.changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  await screen.findByRole("button", {name: "Restore file"});
  // The begin changed the workspace's restores; the plan before it did not.
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Restore point: Before accepted edits")).toBeTruthy();
  expect(f.call.mock.calls.some(([i]) => i.action === "confirm")).toBe(false);
  expect(screen.getByRole("textbox", {name: "Current file before restore"})).toHaveProperty("value", "Current text");
  expect(screen.getByRole("textbox", {name: "File after restore"})).toHaveProperty("value", "Earlier text");
  fireEvent.click(screen.getByRole("button", {name: "Restore file"}));
  await screen.findByText("File restored");
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "confirm", operationId: "restore", proposalDigest});
  expect(f.restored).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.changed).toHaveBeenCalledTimes(2);
});
// Proves: a restore whose file moved before it finished does not claim the
// file was restored. It says the renamed file is unchanged.
it("says the renamed file is unchanged when the restore finishes after a move", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async input => {
    const answer = await original(input);
    return input.action === "confirm" ? {...answer as object, result: {kind: "resumed", proposalDigest, receipt: {}, moved: true}} : answer;
  });
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  fireEvent.click(await screen.findByRole("button", {name: "Restore file"}));
  await screen.findByText("File moved before restoring");
  expect(screen.getByText("The file moved before the restore finished, so the renamed file is unchanged. Share again when you want to give access.")).toBeTruthy();
  expect(screen.queryByText("File restored")).toBeNull();
  expect(f.restored).toHaveBeenCalledTimes(1);
});
// A finish that replies after the dialog closed still says the restore
// changed, so the shell lists again.
it("reports a finish that replies after the dialog closed", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!, finish = deferred<void>();
  f.call.mockImplementation(async input => {
    if (input.action === "confirm") await finish.promise;
    return original(input);
  });
  const view = render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  fireEvent.click(await screen.findByRole("button", {name: "Restore file"}));
  await vi.waitFor(() => expect(f.call.mock.calls.some(([i]) => i.action === "confirm")).toBe(true));
  view.unmount();
  await act(async () => finish.resolve());
  expect(f.changed).toHaveBeenCalledTimes(2);
  expect(f.restored).not.toHaveBeenCalled();
});
// The relay refuses to start a restore while live editing of the file is still
// stopping. Nothing changed, so the shell reports why and the choice stays.
it.each(["plan", "begin"] as const)("reports a refused %s through the shell and keeps the choice on screen", async action => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  const refusal = Error("Live editing is still stopping. Try again in a moment.");
  f.call.mockImplementation(input => input.action === action ? Promise.reject(refusal) : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  if (action === "plan") {
    await screen.findByRole("combobox", {name: "Access to stop"});
    fireEvent.change(screen.getByRole("combobox", {name: "Access to stop"}), {target: {value: "grant"}});
    fireEvent.change(screen.getByRole("combobox", {name: "Shared restore point"}), {target: {value: "0"}});
    fireEvent.click(screen.getByRole("button", {name: "Review affected access"}));
  } else {
    await openStop();
    fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  }
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith("dohc could not start restoring notes.md.", refusal));
  expect(screen.getByRole("button", {name: action === "plan" ? "Review affected access" : "Stop access"})).toHaveProperty("disabled", false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(f.call.mock.calls.some(([input]) => input.action === "prepare" || input.action === "review")).toBe(false);
  // A plan that went through settled the earlier refusal; a refused begin settles nothing more.
  expect(f.settled).toHaveBeenCalledTimes(action === "plan" ? 0 : 1);
});
// A later plan or begin that goes through settles the shell's row for an
// earlier refusal, which no longer holds.
it("settles an earlier refusal when the plan and the begin go through", async () => {
  const f = fixture(); render(<OwnerRestoreDialog {...f.props} />); await openStop();
  expect(f.settled).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  expect(f.settled).toHaveBeenCalledTimes(2);
  expect(f.error).not.toHaveBeenCalled();
});
// Closing keeps an unfinished restore findable: the dialog hands the shell
// the restore it knows of.
it("closes with the unfinished restore it knows of", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "prepare"
    ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "pending"}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  await screen.findByText("dohc could not prepare the restore. Retry in a moment.");
  fireEvent.click(screen.getByRole("button", {name: "Close"}));
  expect(f.close).toHaveBeenCalledWith(expect.objectContaining({operationId: "restore", phase: "fenced"}));
});
// Preparation the relay cannot finish gives no cause beyond a full
// workspace. A repeat says it repeated and what stays stopped meanwhile.
it("says when preparation keeps failing, and when the workspace is full", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let cause: "quota" | undefined;
  f.call.mockImplementation(input => input.action === "prepare"
    ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "pending", ...(cause ? {cause} : {})}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  await screen.findByText("dohc could not prepare the restore. Retry in a moment.");
  expect(screen.getByRole("button", {name: "Decline restore"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("dohc could not prepare the restore again. Live editing of this file stays stopped until it finishes. Retry later.");
  cause = "quota";
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("This workspace has reached its limit on the server. Free some space, then retry the restore.");
});
it("names a full workspace when admission refuses the confirmed restore", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "confirm"
    ? Promise.resolve({status: {...f.status(), phase: "native-fenced"}, result: {kind: "review-required", cause: "quota"}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  fireEvent.click(screen.getByRole("button", {name: "Restore file"}));
  await screen.findByText("This workspace has reached its limit on the server. Free some space, then retry the restore.");
  expect(f.restored).not.toHaveBeenCalled();
});
// Proves: a restore opened by its ID reads only its own status, so it opens
// as itself after the file's restore points are gone.
it("opens a saved restore by its ID without the file's restore choices", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "options"
    ? Promise.reject(Error("The restore point is no longer retained for this document.")) : original(input));
  render(<OwnerRestoreDialog {...f.props} operationId="restore" />);
  await screen.findByText("Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.");
  expect(screen.getByRole("button", {name: "Decline restore"})).toBeTruthy();
  expect(f.call.mock.calls.map(([input]) => input.action)).toEqual(["status"]);
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "status", operationId: "restore"});
});
// Before live editing of the file stops for it, the owner can decline a
// restore. Access stays stopped and the file stays unchanged.
it("declines a reopened restore before its fence", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "options" ? Promise.resolve({...f.options,
    pendingOperation: {operationId: "restore", phase: "authority-invalidated", proposalDigest: null}})
    : input.action === "decline" ? Promise.resolve({status: {...f.status(), phase: "declined"}, result: {kind: "declined"}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByText("Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.");
  expect(screen.getByText("Access has stopped. Declining keeps the file unchanged. Live editing through this access stays stopped until you share the file again.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Decline restore"}));
  await screen.findByText("Restore declined");
  expect(screen.getByText("The file stays unchanged. Live editing through this access stays stopped until you share the file again.")).toBeTruthy();
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "decline", operationId: "restore"});
  expect(f.call.mock.calls.some(([input]) => input.action === "prepare" || input.action === "confirm")).toBe(false);
  fireEvent.click(screen.getByRole("button", {name: "Close"}));
  expect(f.close).toHaveBeenCalledWith(expect.objectContaining({phase: "declined"}));
});
// Another window may have moved the restore on to its admission. The
// refusal shows, the dialog reads where the restore stands, and Decline goes.
// Retry then finishes the restore instead of asking to decline it.
it("shows a refused decline and where the restore stands", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let phase = "authority-invalidated";
  f.call.mockImplementation(input => input.action === "options" ? Promise.resolve({...f.options,
    pendingOperation: {operationId: "restore", phase: "authority-invalidated", proposalDigest: null}})
    : input.action === "status" ? Promise.resolve({...f.status(), phase, proposalDigest})
    : input.action === "decline" ? Promise.reject(Error("The restore is already being applied, so it can no longer be declined. Retry to finish it."))
    : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  const decline = await screen.findByRole("button", {name: "Decline restore"});
  phase = "relay-admitted";
  fireEvent.click(decline);
  await screen.findByText("The restore is already being applied, so it can no longer be declined. Retry to finish it.");
  expect(screen.queryByRole("button", {name: "Decline restore"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("File restored");
  expect(f.call.mock.calls.filter(([input]) => input.action === "decline")).toHaveLength(1);
});

// Proves: the owner can decline a restore at every phase before its
// admission, from a preparation that did not finish and from the review.
it.each(["pending", "review"] as const)("declines a restore after its fence from the %s step", async step => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "prepare" && step === "pending"
    ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "pending"}})
    : input.action === "decline" ? Promise.resolve({status: {...f.status(), phase: "declined"}, result: {kind: "declined"}}) : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  await (step === "pending" ? screen.findByText("dohc could not prepare the restore. Retry in a moment.") : screen.findByRole("button", {name: "Restore file"}));
  fireEvent.click(screen.getByRole("button", {name: "Decline restore"}));
  await screen.findByText("Restore declined");
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "decline", operationId: "restore"});
  expect(f.call.mock.calls.some(([input]) => input.action === "confirm")).toBe(false);
  expect(f.changed).toHaveBeenCalledTimes(2);
});

// Proves: while a Decline has not ended the restore, Retry asks for the
// Decline again instead of preparing the restore.
it("repeats a pending Decline on Retry", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let declines = 0;
  f.call.mockImplementation(input => input.action === "prepare"
    ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "pending"}})
    : input.action === "status" ? Promise.resolve({...f.status(), phase: "fenced"})
    : input.action === "decline" ? (++declines === 1 ? Promise.reject(Error("The restore is still being declined. Try again in a moment."))
      : Promise.resolve({status: {...f.status(), phase: "declined"}, result: {kind: "declined"}}))
    : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  fireEvent.click(await screen.findByRole("button", {name: "Decline restore"}));
  await screen.findByText(DECLINING);
  expect(screen.queryByRole("button", {name: "Decline restore"})).toBeNull();
  const before = f.call.mock.calls.length;
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("Restore declined");
  expect(f.call.mock.calls.slice(before).map(([input]) => input.action)).toEqual(["decline"]);
  expect(f.error).not.toHaveBeenCalled();
});
const DECLINING = "Declining has not finished. Live editing of this file stays stopped until it does. Retry to finish declining.";

// Proves: a pending Decline outlives its dialog. Reopened from its row, the
// restore's Retry prepares it, and the relay ends it by the recorded Decline.
it("finishes a pending Decline from the reopened dialog", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let reopened = false;
  f.call.mockImplementation(input => input.action === "status" ? Promise.resolve({...f.status(), phase: "fenced"})
    : input.action === "decline" ? Promise.reject(Error("The restore is still being declined. Try again in a moment."))
    : input.action === "prepare" ? Promise.resolve({status: {...f.status(), phase: reopened ? "declined" : "fenced"}, result: {kind: "pending"}})
    : original(input));
  const view = render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  fireEvent.click(await screen.findByRole("button", {name: "Decline restore"}));
  await screen.findByText(DECLINING);
  fireEvent.click(screen.getByRole("button", {name: "Close"}));
  expect(f.close).toHaveBeenCalledWith(expect.objectContaining({phase: "fenced"}));
  view.unmount();
  reopened = true;
  const before = f.call.mock.calls.length;
  render(<OwnerRestoreDialog {...f.props} operationId="restore" />);
  await screen.findByText("The restore has not finished. Live editing of this file stays stopped until it does. Retry to continue it.");
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("Restore declined");
  expect(f.call.mock.calls.slice(before).map(([input]) => input.action)).toEqual(["status", "status", "prepare"]);
  expect(f.error).not.toHaveBeenCalled();
});

// Proves: a Decline the relay refused offers no retry. The dialog says what
// stays stopped, and the shell files the refusal with the restore it names.
it("reports a refused Decline through the shell without a retry", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(input => input.action === "prepare"
    ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "pending"}})
    : input.action === "decline" ? Promise.resolve({status: {...f.status(), phase: "fenced"}, result: {kind: "refused"}})
    : original(input));
  render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"}));
  fireEvent.click(await screen.findByRole("button", {name: "Decline restore"}));
  await screen.findByText("Declining did not finish, and trying again will not finish it. Live editing of this file stays stopped.");
  expect(f.refused).toHaveBeenCalledWith(expect.objectContaining({operationId: "restore", phase: "fenced"}));
  expect(f.error).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", {name: "Retry"})).toBeNull();
  expect(screen.queryByRole("button", {name: "Decline restore"})).toBeNull();
});
it("marks the agent the owner's change declared beside the authenticated owner", async () => {
  const f = fixture(); render(<OwnerRestoreDialog {...f.props} />); await openStop();
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  const badges = screen.getAllByTestId("owner-restore-change-agent-badge");
  expect(badges).toHaveLength(1);
  const row = badges[0]!.closest("li")!;
  expect(row.textContent).toContain("Owner");
  expect(row.textContent).toContain("trip-agent-hosted");
  expect(badges[0]!.getAttribute("aria-label")).toBe("agent");
  // The declared person stays out of the row; the server's owner is the authority it names.
  expect(row.textContent?.split("Change details")[0]).not.toContain("local-person");
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
  await screen.findByText("Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.");
  fireEvent.click(screen.getByRole("button", {name: "Review restore"})); await screen.findByRole("button", {name: "Restore file"});
  expect(f.call.mock.calls.some(([input]) => input.action === "begin" || input.action === "confirm")).toBe(false);
});
it.each([false, true])("reviews a saved proposal before confirming after reopen (review fails first: %s)", async failFirst => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  let reviews = 0;
  f.call.mockImplementation(async input => {
    if (input.action === "options") return {...f.options,
      pendingOperation: {operationId: "restore", phase: "native-fenced", proposalDigest}};
    if (input.action === "status") return {...f.status(), phase: "native-fenced", proposalDigest};
    if (input.action === "review" && ++reviews === 1 && failFirst) throw Error("Review unavailable.");
    return original(input);
  });
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByText("The restore has not finished. Live editing of this file stays stopped until it does. Retry to continue it.");
  expect(screen.getByRole("button", {name: "Decline restore"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  if (failFirst) {
    await screen.findByText("Review unavailable.");
    expect(f.call.mock.calls.some(([input]) => input.action === "confirm")).toBe(false);
    fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  }
  await screen.findByRole("button", {name: "Restore file"});
  expect(screen.getByRole("textbox", {name: "File after restore"})).toHaveProperty("value", "Earlier text");
  expect(f.call.mock.calls.some(([input]) => input.action === "confirm" || input.action === "prepare")).toBe(false);
  expect(f.props.onBeforeRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Restore file"}));
  await screen.findByText("File restored");
  expect(f.call.mock.calls.filter(([input]) => input.action === "confirm")).toHaveLength(1);
});
it.each(["relay-admitted", "native-applied", "settled", "resumed"])("continues a confirmed %s restore after reopening", async phase => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async input => {
    if (input.action === "options") return {...f.options,
      pendingOperation: {operationId: "restore", phase: "native-fenced", proposalDigest}};
    if (input.action === "status") return {...f.status(), phase, proposalDigest};
    if (input.action === "review") throw Error("An admitted restore cannot be reviewed again.");
    return original(input);
  });
  const mounted = render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByRole("button", {name: "Retry"});
  mounted.unmount();
  f.call.mockClear();
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByRole("button", {name: "Retry"});
  expect(f.props.onBeforeRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Retry"}));
  await screen.findByText("File restored");
  expect(f.call.mock.calls.map(([input]) => input.action)).toEqual(["options", "status", "status", "confirm"]);
  expect(f.call).toHaveBeenCalledWith({workspaceId: "workspace", action: "confirm", operationId: "restore", proposalDigest});
  expect(f.restored).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
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
    const review = reviewFixture();
    return {status: f.status(), result: OwnerRestoreReview.parse({...review, point: {...review.point, journalCursor: 7},
      selectedPointReceivedAtMs: 1788922800000, selectedPointAuthority: owner})};
  });
  render(<OwnerRestoreDialog {...f.props} />); await openStop("7");
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  const point = screen.getByText(/^Restore point:/);
  expect(point.textContent).toBe(`Restore point: ${new Date(1788922800000).toLocaleString()} · Owner`);
  expect(point.dataset.journalCursor).toBe("7");
  expect(document.querySelector("time")?.dateTime).toBe(new Date(1788922800000).toISOString());
});

// A reopened restore has no choice made in this dialog. The review names the
// author the relay read for its exact restore point.
it("names the accepted restore point's author when a stopped restore reopens", async () => {
  const f = fixture(7), original = f.call.getMockImplementation()!, at = 1788922800000;
  f.call.mockImplementation(async input => {
    // The choices on this page name another author at the same cursor; the review does not read them.
    if (input.action === "options") return {...f.options,
      points: [{cursor: 7, receivedAtMs: at - 60_000, kind: "accepted", receiptDigest: digest, authority: owner}],
      authors: [{grantId: "grant", principalKind: "user", userId: "reader", email: "reader@example.test"}],
      pendingOperation: {operationId: "restore", phase: "native-fenced", proposalDigest: null}};
    if (input.action !== "review") return original(input);
    const review = reviewFixture();
    return {status: f.status(), result: OwnerRestoreReview.parse({...review, point: {...review.point, journalCursor: 7},
      selectedPointReceivedAtMs: at, selectedPointAuthority: reader})};
  });
  render(<OwnerRestoreDialog {...f.props} />);
  await screen.findByText("Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.");
  fireEvent.click(screen.getByRole("button", {name: "Review restore"})); await screen.findByRole("button", {name: "Restore file"});
  expect(screen.getByText(/^Restore point:/).textContent).toBe(`Restore point: ${new Date(at).toLocaleString()} · reader@example.test`);
  expect(f.call.mock.calls.some(([input]) => input.action === "plan" || input.action === "begin")).toBe(false);
});

it("rejects a missing accepted time, a fabricated baseline time, and dates the review cannot render", () => {
  const baseline = reviewFixture();
  expect(OwnerRestoreReview.safeParse({...baseline, selectedPointReceivedAtMs: 30}).success).toBe(false);
  const accepted = {...baseline, point: {...baseline.point, journalCursor: 1}, selectedPointAuthority: owner};
  for (const selectedPointReceivedAtMs of [null, undefined, Number.MAX_SAFE_INTEGER]) {
    expect(OwnerRestoreReview.safeParse({...accepted, selectedPointReceivedAtMs}).success).toBe(false);
  }
  expect(OwnerRestoreReview.safeParse({...accepted, selectedPointReceivedAtMs: 30}).success).toBe(true);
});

it("rejects a restore point author that does not match the point", () => {
  const baseline = reviewFixture();
  expect(OwnerRestoreReview.safeParse({...baseline, selectedPointAuthority: owner}).success).toBe(false);
  const accepted = {...baseline, point: {...baseline.point, journalCursor: 1}, selectedPointReceivedAtMs: 30};
  for (const selectedPointAuthority of [null, undefined, {...reader, grantId: null}]) {
    expect(OwnerRestoreReview.safeParse({...accepted, selectedPointAuthority}).success).toBe(false);
  }
});

it("names people by the email the relay resolved, in the choices and in the review", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!, at = 1788922800000;
  const point = (cursor: number, authority: typeof owner | typeof reader | null, receivedAtMs: number | null = at) =>
    ({cursor, receivedAtMs: authority ? receivedAtMs : null, kind: authority ? "accepted" : "baseline", receiptDigest: digest, authority});
  const grant = {grantId: "grant", principalKind: "user" as const, userId: "reader", email: "reader@example.test", shareId: "share", generation: 1};
  const stranger = {...reader, principalId: "stranger", grantId: "old-grant"};
  f.call.mockImplementation(async input => input.action === "options" ? {...f.options, grants: [grant],
    points: [point(4, reader), point(3, reader), point(2, stranger), point(1, owner, at - 60_000), point(0, null)],
    authors: [{grantId: "grant", principalKind: "user", userId: "reader", email: "reader@example.test"},
      {grantId: "old-grant", principalKind: "user", userId: "stranger", email: null}]} : original(input));
  render(<OwnerRestoreDialog {...f.props} />);
  const access = await screen.findByRole("combobox", {name: "Access to stop"});
  expect(within(access).getByRole("option", {name: "reader@example.test"})).toBeTruthy();
  const points = screen.getByRole("combobox", {name: "Shared restore point"});
  const shown = new Date(at).toLocaleString();
  expect([...points.querySelectorAll("option")].map(option => [option.value, option.textContent])).toEqual([
    ["", "Choose a change"],
    ["4", `${shown} · reader@example.test (2 of 2)`],
    ["3", `${shown} · reader@example.test (1 of 2)`],
    // An account the relay could not name keeps its ID rather than a guessed name.
    ["2", `${shown} · Account stranger`],
    ["1", `${new Date(at - 60_000).toLocaleString()} · Owner`],
    ["0", "Before accepted edits"],
  ]);
  // The review names the same people its choices named.
  const options = f.call.getMockImplementation()!;
  f.call.mockImplementation(async input => {
    if (input.action !== "review") return options(input);
    const review = reviewFixture();
    for (const event of review.acceptedEvents.slice(0, 2)) Object.assign(event.metadata.accepted, {authority: reader});
    return {status: f.status(), result: review};
  });
  fireEvent.change(points, {target: {value: "1"}});
  fireEvent.change(access, {target: {value: "grant"}});
  fireEvent.click(screen.getByRole("button", {name: "Review affected access"}));
  await screen.findByText("Stop access before restoring?");
  fireEvent.click(screen.getByRole("button", {name: "Stop access"})); await screen.findByRole("button", {name: "Restore file"});
  const rows = [...screen.getByTestId("owner-restore-dialog").querySelectorAll("li")].map(row => row.textContent!.split(" · ")[0]);
  expect(rows).toContain("reader@example.test");
  expect(rows.join()).not.toContain("Account reader");
});
