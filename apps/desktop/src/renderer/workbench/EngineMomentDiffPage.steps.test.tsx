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
    historyAnswer={null} onReopenRestore={noop} restoreRequested={false} onRestoreRequestTaken={noop} onOpenSharedRestore={noop} steps={steps} onOpenMoment={onOpenMoment} />;
}

const step = (momentId: string) => ({momentId, path: "docs/a.md"});

it("steps to the older and newer change of the file with its arrows and [ and ]", async () => {
  vi.stubGlobal("dohcDesktop", {readEngineMoment: vi.fn(async ({momentId}: {momentId: string}) => ({moment: engineMomentDetailForIpc(detail(momentId), names)}))});
  const open = vi.fn();
  const view = render(page("m-2", {newer: step("m-3"), older: step("m-1")}, open));
  const older = await screen.findByRole("button", {name: "Older change"});
  fireEvent.keyDown(screen.getByTestId("engine-moment-diff-page"), {key: "["});
  expect(open).toHaveBeenCalledWith("m-1", "docs/a.md");

  // The shell points the tab at the older change; once it loads, focus is
  // back on the arrow, so the next step needs no click.
  fireEvent.click(older);
  view.rerender(page("m-1", {newer: step("m-2"), older: step("m-0")}, open));
  await vi.waitFor(() => expect(screen.getByTestId("engine-moment-diff-page").dataset.momentId).toBe("m-1"));
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Older change"}));
  fireEvent.keyDown(document.activeElement!, {key: "]"});
  expect(open).toHaveBeenLastCalledWith("m-2", "docs/a.md");
});

// At either end, the arrow it stepped with reads as disabled but keeps focus
// in the page, so the other bracket steps back.
it.each([
  ["oldest", "Older change", "[", {newer: step("m-2"), older: null}, "]", "m-2"],
  ["newest", "Newer change", "]", {newer: null, older: step("m-1")}, "[", "m-1"],
] as const)("keeps focus at the %s change, where only the other bracket steps", async (_end, arrowName, key, endSteps, back, target) => {
  vi.stubGlobal("dohcDesktop", {readEngineMoment: vi.fn(async ({momentId}: {momentId: string}) => ({moment: engineMomentDetailForIpc(detail(momentId), names)}))});
  const open = vi.fn();
  const view = render(page("m-start", {newer: step("m-new"), older: step("m-old")}, open));
  fireEvent.keyDown(await screen.findByRole("button", {name: arrowName}), {key});
  view.rerender(page("m-end", endSteps, open));
  await vi.waitFor(() => expect(screen.getByTestId("engine-moment-diff-page").dataset.momentId).toBe("m-end"));
  const arrow = screen.getByRole("button", {name: arrowName});
  expect(document.activeElement).toBe(arrow);
  expect(arrow.getAttribute("aria-disabled")).toBe("true");
  open.mockClear();
  fireEvent.click(arrow);
  fireEvent.keyDown(arrow, {key});
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(arrow, {key: back});
  expect(open).toHaveBeenCalledWith(target, "docs/a.md");
});
