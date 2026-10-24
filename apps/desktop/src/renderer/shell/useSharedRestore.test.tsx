// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OwnerRestoreRequest } from "../../ipc/ownerRestoreContract";
import { sharedRestoreIdentity, useSharedRestore } from "./useSharedRestore";
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
    if (input.action === "unfinished") return { restores: [], nextCursor: null };
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
// a later one offers Try again. Decline ends it and says access stays stopped.
it("files a row for each unfinished restore, and Decline from the row ends it", async () => {
  const restores = [
    { operationId: "first", path: "docs/a.md", phase: "authority-invalidated", proposalDigest: null },
    { operationId: "second", path: "docs/b.md", phase: "native-fenced", proposalDigest: null },
    { operationId: "third", path: "docs/c.md", phase: "relay-admitted", proposalDigest: digest },
  ];
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores, nextCursor: null };
    if (input.action === "decline") { restores.shift(); return status("declined", "first"); }
    if (input.action === "options") return options();
    throw Error(`Unexpected ${input.action}`);
  }, true);
  await waitFor(() => expect(f.row("docs/c.md")).toBeDefined());
  expect(f.row()).toMatchObject({ tone: "warning", title: "Restore waiting for you", retry: null,
    message: "Access to docs/a.md stopped for a restore. Review the restore, or decline it to keep the file unchanged and access stopped.",
    action: { label: "Review restore", additional: [{ label: "Decline restore" }] } });
  expect(f.row("docs/b.md")).toMatchObject({ title: "Restore waiting", message: "The restore of docs/b.md has not finished. Live editing of this file stays stopped until it does." });
  expect(f.row("docs/c.md")).toMatchObject({ title: "Finishing restore", message: "The restore of docs/c.md has not finished. Try again to finish it." });
  expect(f.row("docs/b.md")?.retry).toBeTypeOf("function");
  act(() => shell.runShellErrorAction(f.row()!.id, 1));
  await waitFor(() => expect(f.row()).toBeUndefined());
  expect(f.ownerRestore).toHaveBeenCalledWith({ workspaceId: "workspace", action: "decline", operationId: "first" });
  expect(shell.shellErrors.some(error => error.tone === "success" &&
    error.message === "Declined the restore of docs/a.md. The file is unchanged, and access stays stopped.")).toBe(true);
  act(() => shell.retryShellError(f.row("docs/b.md")!.id));
  expect(await screen.findByTestId("owner-restore-dialog")).toBeTruthy();
  expect(f.ownerRestore).toHaveBeenCalledWith({ workspaceId: "workspace", action: "options", path: "docs/b.md" });
});

// Proves: closing the dialog on an unfinished restore keeps it findable, and
// a listing that no longer has it, because it finished, clears its row.
it("keeps a row for the restore a closed dialog left unfinished, until a listing drops it", async () => {
  let listed: unknown[] = [];
  const f = fixture(async input => {
    if (input.action === "unfinished") return { restores: listed, nextCursor: null };
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
