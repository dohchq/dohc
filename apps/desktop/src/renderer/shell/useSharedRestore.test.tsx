// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OwnerRestoreRequest } from "../../ipc/ownerRestoreContract";
import { deferred } from "../../testing/deferred";
import { sharedRestoreIdentity, sharedRestoreListingIdentity, useSharedRestore } from "./useSharedRestore";
import { useShellError } from "./useShellError";

afterEach(() => { cleanup(); delete window.dohcDesktop; });
const documentKey = { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage" };
const digest = "a".repeat(64);
const intent = { deliveryKind: "owner" as const, operationId: "restore", document: documentKey, shareId: "share", grantId: "grant",
  expectedGrantGeneration: 1, expectedDependentGrantIds: [], expectedFence: 1, restorePointCursor: 0, restorePointReceiptDigest: digest };
const status = (phase: string, operationId = "restore") => ({ operationId, document: documentKey, path: "docs/a.md", phase,
  intent: { ...intent, operationId }, proposalDigest: null });
const options = (pendingOperation: unknown = null) => ({ document: documentKey, path: "docs/a.md",
  grants: [{ grantId: "grant", shareId: "share", generation: 1, principalKind: "user", userId: "reader", email: "reader@example.test" }],
  points: [{ cursor: 0, receivedAtMs: null, kind: "baseline", receiptDigest: digest, authority: null }],
  authors: [], pendingOperation, nextGrantCursor: null, nextBeforeCursor: null });

let shell: ReturnType<typeof useShellError>;
// The shell as it hosts Restore shared file: its Notices, and the History page
// that opens the dialog while it is mounted.
function Shell({ enabled, page, openChange }: { enabled: boolean; page: boolean; openChange: (momentId: string, path: string) => void }) {
  shell = useShellError("workspace");
  const shared = useSharedRestore({ workspaceId: "workspace", enabled, onBeforeRestore: async () => () => {}, onRestored: () => {}, openChange,
    reportRestoreError: (fallback, error, retry, identity) => shell.reportShellError(fallback, error, retry, undefined, identity),
    reportShellFailure: shell.reportShellFailure, showSuccessNotice: shell.showSuccessNotice, clearIdentity: shell.clearIdentity });
  return <>{page ? <button type="button" onClick={() => shared.open("docs/a.md", "change")}>Restore shared file…</button> : null}{shared.dialog}</>;
}
function fixture(call: (input: OwnerRestoreRequest) => Promise<unknown>, enabled = false) {
  const ownerRestore = vi.fn(call), openChange = vi.fn();
  window.dohcDesktop = { ownerRestore } as unknown as typeof window.dohcDesktop;
  const view = render(<Shell enabled={enabled} page openChange={openChange} />);
  const row = (path = "docs/a.md") => shell.shellErrors.find(error => error.identity === sharedRestoreIdentity(path));
  const actions = () => ownerRestore.mock.calls.map(([input]) => input.action);
  return { ...view, ownerRestore, openChange, row, actions, rerenderShell: (props: { enabled?: boolean; page?: boolean }) =>
    view.rerender(<Shell enabled={props.enabled ?? enabled} page={props.page ?? true} openChange={openChange} />) };
}
async function choose() {
  fireEvent.change(await screen.findByRole("combobox", { name: "Access to stop" }), { target: { value: "grant" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Shared restore point" }), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Review affected access" }));
}

// Proves: Try again on a refused start works after the History page that
// opened the dialog is gone. It opens that change again and a fresh dialog,
// and a later plan that goes through settles the row.
it("reopens the change and its dialog from Try again after the page unmounts, and a later plan clears the row", async () => {
  let refuse = true;
  const f = fixture(async input => {
    if (input.action === "options") return options();
    if (input.action === "plan" && refuse) throw Error("Live editing is still stopping. Try again in a moment.");
    if (input.action === "plan") return { intent, path: "docs/a.md", recipients: [] };
    if (input.action === "unfinished") return { restores: [], unreadable: 0, nextCursor: null };
    throw Error(`Unexpected ${input.action}`);
  });
  fireEvent.click(screen.getByRole("button", { name: "Restore shared file…" }));
  await choose();
  await waitFor(() => expect(f.row()?.message).toBe("dohc could not start restoring docs/a.md. Live editing is still stopping. Try again in a moment."));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  f.rerenderShell({ page: false });
  expect(screen.queryByTestId("owner-restore-dialog")).toBeNull();
  const opened = f.actions().filter(action => action === "options").length;
  act(() => shell.retryShellError(f.row()!.id));
  expect(f.openChange).toHaveBeenCalledWith("change", "docs/a.md");
  expect(await screen.findByRole("combobox", { name: "Access to stop" })).toHaveProperty("value", "");
  expect(f.actions().filter(action => action === "options")).toHaveLength(opened + 1);
  await choose();
  await waitFor(() => expect(f.row()).toBeDefined());
  refuse = false;
  fireEvent.click(screen.getByRole("button", { name: "Review affected access" }));
  await screen.findByText("Stop access before restoring?");
  expect(f.row()).toBeUndefined();
});

// Proves: every unfinished restore the relay lists has a row that opens it.
// One that can still be declined offers Review restore and Decline restore;
// a later one offers Try again. Decline ends it and says what stays stopped.
it("files a row for each unfinished restore, and Decline from the row ends it", async () => {
  const restores = [
    { operationId: "first", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null },
    { operationId: "second", path: "docs/b.md", phase: "native-fenced", proposalDigest: null },
    { operationId: "third", path: "docs/c.md", phase: "relay-admitted", proposalDigest: digest },
  ];
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores, unreadable: 0, nextCursor: null };
    if (input.action === "decline") { restores.shift(); return { status: status("declined", "first"), result: { kind: "declined" } }; }
    if (input.action === "status") return status("native-fenced", "second");
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row("docs/c.md")).toBeDefined());
  expect(f.row()).toMatchObject({ tone: "warning", title: "Restore waiting for you", retry: null,
    message: "Access to docs/a.md stopped for a restore. Review the restore, or decline it to keep the file unchanged. " +
      "Live editing through that access stays stopped until you share the file again.",
    action: { label: "Review restore", additional: [{ label: "Decline restore" }] } });
  expect(f.row("docs/b.md")).toMatchObject({ title: "Restore waiting", message: "The restore of docs/b.md has not finished. Live editing of this file stays stopped until it does." });
  expect(f.row("docs/c.md")).toMatchObject({ title: "Finishing restore", message: "The restore of docs/c.md has not finished. Try again to finish it." });
  expect(f.row("docs/b.md")?.retry).toBeTypeOf("function");
  act(() => shell.runShellErrorAction(f.row()!.id, 1));
  await waitFor(() => expect(f.row()).toBeUndefined());
  expect(f.ownerRestore).toHaveBeenCalledWith({ workspaceId: "workspace", action: "decline", operationId: "first" });
  expect(shell.shellErrors.some(error => error.tone === "success" && error.message ===
    "Declined the restore of docs/a.md. The file is unchanged. Live editing through that access stays stopped until you share the file again.")).toBe(true);
  act(() => shell.retryShellError(f.row("docs/b.md")!.id));
  expect(await screen.findByText("The restore has not finished. Live editing of this file stays stopped until it does. Retry to continue it.")).toBeTruthy();
  expect(f.ownerRestore).toHaveBeenCalledWith({ workspaceId: "workspace", action: "status", operationId: "second" });
});

// Proves: a row opens its own restore. The saved basis of this one was
// compacted away, so the file's restore choices are gone, and the dialog
// still opens the listed restore rather than an error about them.
it("opens the listed restore from its row after the file's restore points are gone", async () => {
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores: [{ operationId: "restore", path: "docs/a.md", phase: "authority-invalidated",
      proposalDigest: null }], unreadable: 0, nextCursor: null };
    if (input.action === "options") throw Error("The restore point is no longer retained for this document.");
    if (input.action === "status") return status("authority-invalidated");
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row()).toBeDefined());
  act(() => shell.runShellErrorAction(f.row()!.id, 0));
  expect(await screen.findByText("Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Decline restore" })).toBeTruthy();
  expect(f.actions()).not.toContain("options");
});

// Proves: a listing that fails, or reads only some restores, files one row
// with Try again and keeps the rows already filed. A later full listing
// clears it.
it("files one row when the listing fails or reads only some restores, and a full listing clears it", async () => {
  const listingRow = () => shell.shellErrors.find(error => error.identity === sharedRestoreListingIdentity);
  const listed = [{ operationId: "restore", path: "docs/a.md", phase: "native-fenced", proposalDigest: null }];
  let answer: "ok" | "fail" | "partial" = "ok";
  const f = fixture(async input => {
    if (input.action !== "unfinished") throw Error(`Unexpected ${input.action}`);
    if (answer === "fail") throw Error("dohc could not reach the relay.");
    return answer === "partial" ? { restores: [], unreadable: 2, nextCursor: null } : { restores: listed, unreadable: 0, nextCursor: null };
  }, true);
  await waitFor(() => expect(f.row()).toBeDefined());
  answer = "fail";
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  await waitFor(() => expect(listingRow()).toMatchObject({ seen: false,
    message: "dohc could not read this workspace's unfinished restores. dohc could not reach the relay." }));
  expect(listingRow()?.retry).toBeTypeOf("function");
  expect(f.row()).toBeDefined();
  answer = "partial";
  act(() => shell.retryShellError(listingRow()!.id));
  await waitFor(() => expect(listingRow()?.message).toBe("dohc could not read 2 of this workspace's unfinished restores."));
  // The restore it could not read may be this one, so its row stays.
  expect(f.row()).toBeDefined();
  answer = "ok";
  act(() => shell.retryShellError(listingRow()!.id));
  await waitFor(() => expect(f.actions().filter(action => action === "unfinished")).toHaveLength(4));
  await waitFor(() => expect(listingRow()).toBeUndefined());
  expect(f.row()).toBeDefined();
});

// Proves: a listing read before a Decline cannot file the declined restore
// again when its reply arrives late.
it("keeps a declined row gone when an older listing replies after the decline", async () => {
  const restore = { operationId: "restore", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null };
  const late = deferred<unknown>();
  let declined = false, listings = 0;
  const f = fixture(async input => {
    if (input.action === "unfinished") {
      listings += 1;
      if (listings === 2) return late.promise;
      return { restores: declined ? [] : [restore], unreadable: 0, nextCursor: null };
    }
    if (input.action === "decline") { declined = true; return { status: status("declined"), result: { kind: "declined" } }; }
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row()).toBeDefined());
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  await waitFor(() => expect(listings).toBe(2));
  act(() => shell.runShellErrorAction(f.row()!.id, 1));
  await waitFor(() => expect(f.row()).toBeUndefined());
  await act(async () => late.resolve({ restores: [restore], unreadable: 0, nextCursor: null }));
  expect(f.row()).toBeUndefined();
  // The Decline listed again from current state.
  expect(listings).toBe(3);
});

// Proves: a restore begun as its dialog closes still gets a row. The listing
// the close started read the new restore, and the begin reply that arrives
// after it lists again rather than only dropping it.
it("files the row for a restore whose begin replies after its dialog closed", async () => {
  const begin = deferred<unknown>(), closing = deferred<unknown>();
  const restore = { operationId: "restore", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null };
  let listings = 0;
  const f = fixture(async input => {
    if (input.action === "options") return options();
    if (input.action === "plan") return { intent, path: "docs/a.md", recipients: [] };
    if (input.action === "begin") return begin.promise;
    if (input.action === "unfinished") {
      listings += 1;
      if (listings === 1) return { restores: [], unreadable: 0, nextCursor: null };
      if (listings === 2) return closing.promise;
      return { restores: [restore], unreadable: 0, nextCursor: null };
    }
    throw Error(`Unexpected ${input.action}`);
  }, true);
  fireEvent.click(screen.getByRole("button", { name: "Restore shared file…" }));
  await choose();
  fireEvent.click(await screen.findByRole("button", { name: "Stop access" }));
  await waitFor(() => expect(f.actions()).toContain("begin"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(listings).toBe(2));
  await act(async () => begin.resolve(status("authority-invalidated")));
  await act(async () => closing.resolve({ restores: [restore], unreadable: 0, nextCursor: null }));
  await waitFor(() => expect(f.row()).toMatchObject({ title: "Restore waiting for you" }));
  expect(listings).toBe(3);
});

// Proves: a failed Decline keeps its row against a listing read before it,
// and that listing still files the other files' rows. Rejected, the restore
// still waits, which the next listing shows. Committed with its reply lost,
// the next listing has no restore and clears the row.
it.each(["rejected", "lost"] as const)("keeps the row of a %s Decline against an older listing, until a newer one", async outcome => {
  const restore = { operationId: "restore", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null };
  const late = deferred<unknown>();
  let declined = false, listings = 0;
  const f = fixture(async input => {
    if (input.action === "unfinished") {
      listings += 1;
      if (listings === 2) return late.promise;
      return { restores: declined ? [] : [restore], unreadable: 0, nextCursor: null };
    }
    if (input.action === "decline") {
      if (outcome === "lost") declined = true;
      throw Error("dohc could not reach the relay.");
    }
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row()).toBeDefined());
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  await waitFor(() => expect(listings).toBe(2));
  act(() => shell.runShellErrorAction(f.row()!.id, 1));
  const failed = "dohc could not decline the restore of docs/a.md. dohc could not reach the relay.";
  await waitFor(() => expect(f.row()?.message).toBe(failed));
  await act(async () => late.resolve({ restores: [restore, { ...restore, operationId: "other", path: "docs/b.md" }], unreadable: 0, nextCursor: null }));
  expect(f.row()?.message).toBe(failed);
  expect(f.row("docs/b.md")).toMatchObject({ title: "Restore waiting for you" });
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  if (outcome !== "lost") await waitFor(() => expect(f.row()?.title).toBe("Restore waiting for you"));
  else await waitFor(() => expect(f.row()).toBeUndefined());
});

// Proves: a Decline the relay refused, from its row or its dialog, files a
// row with no retry, and the listings that still list the restore keep it.
const REFUSED_ROW = { title: "Restore not declined", retry: null,
  message: "dohc could not decline the restore of docs/a.md. Declining did not finish, and trying again will not finish it. Live editing of this file stays stopped." };
it.each(["row", "dialog"] as const)("files a Decline refused from its %s without a retry, across listings", async from => {
  const restore = { operationId: "restore", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null };
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores: [restore], unreadable: 0, nextCursor: null };
    if (input.action === "options") return options({ operationId: "restore", phase: "authority-invalidated", proposalDigest: null });
    if (input.action === "status") return status("authority-invalidated");
    if (input.action === "decline") return { status: status("fenced"), result: { kind: "refused" } };
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row()?.title).toBe("Restore waiting for you"));
  if (from === "row") act(() => shell.runShellErrorAction(f.row()!.id, 1));
  else {
    fireEvent.click(screen.getByRole("button", { name: "Restore shared file…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Decline restore" }));
    await screen.findByText("Declining did not finish, and trying again will not finish it. Live editing of this file stays stopped.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
  }
  await waitFor(() => expect(f.row()).toMatchObject(REFUSED_ROW));
  const listed = f.actions().filter(action => action === "unfinished").length;
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  await waitFor(() => expect(f.actions().filter(action => action === "unfinished")).toHaveLength(listed + 1));
  await act(async () => {});
  expect(f.row()).toMatchObject(REFUSED_ROW);
  expect(f.row()?.action).toBeUndefined();
});

// Proves: closing the dialog on an unfinished restore keeps it findable, and
// a listing that no longer has it, because it finished, clears its row.
it("keeps a row for the restore a closed dialog left unfinished, until a listing drops it", async () => {
  let listed: unknown[] = [];
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores: listed, unreadable: 0, nextCursor: null };
    if (input.action === "options") return options({ operationId: "restore", phase: "authority-invalidated", proposalDigest: null });
    if (input.action === "status") return status("authority-invalidated");
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.actions()).toContain("unfinished"));
  fireEvent.click(screen.getByRole("button", { name: "Restore shared file…" }));
  await screen.findByRole("button", { name: "Decline restore" });
  listed = [{ operationId: "restore", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null }];
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(f.row()).toMatchObject({ title: "Restore waiting for you", seen: false });
  await waitFor(() => expect(f.actions().filter(action => action === "unfinished")).toHaveLength(2));
  expect(f.row()).toBeDefined();
  listed = [];
  f.rerenderShell({ enabled: false });
  f.rerenderShell({ enabled: true });
  await waitFor(() => expect(f.row()).toBeUndefined());
});
