// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {engineMomentDetailForIpc} from "../../ipc/engineHistoryIpc";
import type {WorkspaceEngineMomentDetail} from "../../workspaces/workspaceEngineCapture";
import {EngineMomentDiffPage} from "./EngineMomentDiffPage";
import {momentDiffTabPath} from "./workbenchState";
import {neutralHistoryPresentations} from "../../testing/historyPageFixture";

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const noop = () => {};
const stopAndRestore = vi.fn();
const base = {id: "baseline", workspaceId: "workspace", versionId: "main", objectId: "object", path: "docs/a.md",
  recordedAtMs: 2, operation: "write" as const, metadata: {origin: "local-file" as const}};
const text = {path: base.path, contentKind: "text" as const, sha256: "a".repeat(64), byteLength: 5, text: "Hello"};
const textDetail: WorkspaceEngineMomentDetail = {protected: false, moment: {...base, payload: {before: null, after: text}}};

async function open(detail: WorkspaceEngineMomentDetail) {
  const moment = engineMomentDetailForIpc(detail, {
    named: () => "Someone you shared with",
    agent: () => "Owner",
    person: () => undefined,
    automation: (automationId) => ({ name: automationId, collection: "Tasks" }),
    presentations: neutralHistoryPresentations,
  });
  const ownerRestore = vi.fn().mockResolvedValue({document: {workspaceId: "workspace"}, grants: [], points: [], authors: [], pendingOperation: null,
    nextGrantCursor: null, nextBeforeCursor: null});
  vi.stubGlobal("dohcDesktop", {readEngineMoment: vi.fn().mockResolvedValue({moment}), ownerRestore});
  render(<EngineMomentDiffPage workspaceId="workspace" tabPath={momentDiffTabPath(moment.id)}
    onBeforeRestore={async () => noop} onOpenFile={noop} onPathResolved={noop} registerActiveUndo={noop} onRestored={noop} onStopAndRestore={stopAndRestore} onError={noop} onSettled={noop}
    historyAnswer={null} onReopenRestore={noop} restoreRequested={false} onRestoreRequestTaken={noop} />);
  await screen.findByTestId("engine-diff-restore-file");
  // The rarer ways back wait behind More.
  fireEvent.click(screen.getByTestId("engine-diff-more"));
  return {moment, ownerRestore};
}

it("opens shared restore for the text detail produced by the real IPC mapper", async () => {
  const {moment, ownerRestore} = await open(textDetail);
  expect(moment.contentKind).toBeUndefined();
  fireEvent.click(screen.getByTestId("engine-diff-shared-restore"));
  await screen.findByTestId("owner-restore-dialog");
  expect(ownerRestore).toHaveBeenCalledWith({workspaceId: "workspace", action: "options", path: "docs/a.md"});
});

it("offers Copy your version on a recovery change only, and copies the kept file whole", async () => {
  await open(textDetail);
  expect(screen.queryByRole("button", {name: "Copy your version"})).toBeNull();
  cleanup();
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  for (const origin of ["capture-recovery", "capture-recovery-cleared"] as const) {
    await open({protected: false, moment: {...base, metadata: {origin}, payload: {before: {...text, text: "# Plan\n\nKept typing.\n"}, after: text}}});
    fireEvent.click(screen.getByRole("button", {name: "Copy your version"}));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("# Plan\n\nKept typing.\n"));
    cleanup();
  }
});

it("does not offer shared restore for a binary Markdown path", async () => {
  const {moment} = await open({protected: false, moment: {...base, payload: {before: null, after: {...text, contentKind: "binary", text: ""}}}});
  expect(moment.contentKind).toBe("binary");
  expect(screen.queryByTestId("engine-diff-shared-restore")).toBeNull();
});

it("does not offer shared restore for protected Markdown history", async () => {
  const {moment} = await open({protected: true, moment: {...base, momentOrder: 0, protected: true}});
  expect(moment.protected).toBe(true);
  expect(moment.contentKind).toBeUndefined();
  expect(screen.queryByTestId("engine-diff-shared-restore")).toBeNull();
});

it("does not offer shared restore for other text formats", async () => {
  await open({protected: false, moment: {...base, path: "docs/a.txt", payload: {before: null, after: {...text, path: "docs/a.txt"}}}});
  expect(screen.queryByTestId("engine-diff-shared-restore")).toBeNull();
});

it("offers Stop and restore only for a change a person the owner shared with, or an Edit link, wrote directly", async () => {
  await open(textDetail);
  expect(screen.queryByTestId("engine-diff-stop-and-restore")).toBeNull();
  cleanup();
  // The relay carries a direct write in as "sync".
  const named: WorkspaceEngineMomentDetail = {protected: false, moment: {...base, path: "docs/collection.yaml",
    metadata: {origin: "sync"},
    authors: [{kind: "named", userId: "user_ana", grantId: "grant-1", grantGeneration: 1}],
    payload: {before: null, after: {...text, path: "docs/collection.yaml"}}}};
  const {moment} = await open(named);
  expect(moment.namedAuthor).toEqual({userId: "user_ana", label: "Someone you shared with"});
  fireEvent.click(screen.getByTestId("engine-diff-stop-and-restore"));
  expect(stopAndRestore).toHaveBeenCalledWith({target: {kind: "person", userId: "user_ana"}, label: "Someone you shared with"});
  cleanup();
  const linked: WorkspaceEngineMomentDetail = {protected: false, moment: {...base, path: "docs/collection.yaml",
    metadata: {origin: "sync"},
    authors: [{kind: "link", grantId: "grant-link", grantGeneration: 2, principalId: "holder"}],
    payload: {before: null, after: {...text, path: "docs/collection.yaml"}}}};
  await open(linked);
  fireEvent.click(screen.getByTestId("engine-diff-stop-and-restore"));
  expect(stopAndRestore).toHaveBeenLastCalledWith({target: {kind: "link", grantId: "grant-link"}, label: "Edit link"});
});

// A live document's settlement names the collaborator whose edit it holds.
// The direct-write ledger has nothing of it, so the page names them and
// offers the shared restore instead.
it("names a live document's collaborator without offering Stop and restore", async () => {
  for (const author of [
    {kind: "named" as const, userId: "user_ana", grantId: "grant-1", grantGeneration: 1},
    {kind: "link" as const, grantId: "grant-link", grantGeneration: 2, principalId: "holder"},
  ]) {
    await open({protected: false, moment: {...base, authors: [author], payload: {before: null, after: text}}});
    expect(screen.queryByTestId("engine-diff-stop-and-restore")).toBeNull();
    expect(screen.getByTestId("engine-diff-shared-restore")).toBeTruthy();
    cleanup();
  }
});
