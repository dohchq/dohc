// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {engineMomentDetailForIpc} from "../../ipc/engineHistoryIpc";
import type {WorkspaceEngineMomentDetail} from "../../workspaces/workspaceEngineCapture";
import type {MomentSteps} from "./EngineHistory";
import {EngineMomentDiffPage} from "./EngineMomentDiffPage";
import {momentDiffTabPath} from "./workbenchState";
import {neutralHistoryPresentations} from "../../testing/historyPageFixture";

afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const noop = () => {};
const text = {path: "docs/a.md", contentKind: "text" as const, sha256: "a".repeat(64), byteLength: 5, text: "Hello"};
function detail(id: string): WorkspaceEngineMomentDetail {
  return {protected: false, moment: {id, workspaceId: "workspace", versionId: "main", objectId: "object", path: "docs/a.md",
    recordedAtMs: 2, operation: "write", metadata: {origin: "local-file"}, payload: {before: null, after: text}}};
}
const names = {named: () => "Someone", agent: () => "Owner", person: () => undefined,
  automation: (automationId: string) => ({name: automationId}), presentations: neutralHistoryPresentations};

function page(momentId: string, steps: MomentSteps, onOpenMoment: (momentId: string, path: string) => void) {
  return <EngineMomentDiffPage workspaceId="workspace" tabPath={momentDiffTabPath(momentId)}
    onBeforeRestore={async () => noop} onOpenFile={noop} onPathResolved={noop} registerActiveUndo={noop} onRestored={noop} onStopAndRestore={noop} onError={noop} onSettled={noop}
    historyAnswer={null} onReopenRestore={noop} restoreRequested={false} onRestoreRequestTaken={noop} steps={steps} onOpenMoment={onOpenMoment} />;
}

it("steps to the older and newer change of the file with its arrows and [ and ]", async () => {
  vi.stubGlobal("dohcDesktop", {readEngineMoment: vi.fn(async ({momentId}: {momentId: string}) => ({moment: engineMomentDetailForIpc(detail(momentId), names)}))});
  const open = vi.fn();
  const view = render(page("m-2", {newer: null, older: {momentId: "m-1", path: "docs/a.md"}}, open));
  const older = await screen.findByRole("button", {name: "Older change"});
  expect(screen.getByRole("button", {name: "Newer change"})).toHaveProperty("disabled", true);
  fireEvent.keyDown(screen.getByTestId("engine-moment-diff-page"), {key: "]"});
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("engine-moment-diff-page"), {key: "["});
  expect(open).toHaveBeenCalledWith("m-1", "docs/a.md");

  // The shell points the tab at the older change; once it loads, focus is
  // back on the arrow, so the next step needs no click.
  fireEvent.click(older);
  view.rerender(page("m-1", {newer: {momentId: "m-2", path: "docs/a.md"}, older: {momentId: "m-0", path: "docs/a.md"}}, open));
  await vi.waitFor(() => expect(screen.getByTestId("engine-moment-diff-page").dataset.momentId).toBe("m-1"));
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Older change"}));
  fireEvent.keyDown(document.activeElement!, {key: "]"});
  expect(open).toHaveBeenLastCalledWith("m-2", "docs/a.md");
});
