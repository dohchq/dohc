// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useKeptFilesNotice } from "./useKeptFilesNotice";
import { useShellError } from "./useShellError";

afterEach(cleanup);

it("clears the Notice when recovery copies are removed", () => {
  const mounted = mount("recovery-removed", [["a.md", ".dohc/engine/displaced/6a31.0"]] as const);
  expect(mounted.result.current.shell.shellErrors).toHaveLength(1);
  mounted.rerender({ paths: [] });
  expect(mounted.result.current.shell.shellErrors).toHaveLength(0);
});

function mount(workspaceId: string, paths: readonly (readonly [string, string])[]) {
  const openFolder = vi.fn();
  return { openFolder, ...renderHook(({ paths }: { paths: readonly (readonly [string, string])[] }) => {
    const shell = useShellError(workspaceId);
    const notice = useKeptFilesNotice({ workspaceId, paths, report: shell.reportKeptFiles, openFolder });
    return { shell, notice };
  }, { initialProps: { paths } }) };
}

it("shows one recovery Notice with copy paths and a working folder action", () => {
  const paths = [["a.md", ".dohc/engine/displaced/6a31.0"]] as const;
  const first = mount("recovery-one", paths);
  const row = first.result.current.shell.shellErrors[0];
  expect(row.seen).toBe(false);
  expect(row.details).toEqual([["a.md", paths[0][1]]]);
  first.rerender({ paths: [...paths] });
  expect(first.result.current.shell.shellErrors).toEqual([row]);
  act(() => first.result.current.shell.runShellErrorAction(row.id));
  expect(first.openFolder).toHaveBeenCalledOnce();
  first.unmount();
  const again = mount("recovery-one", paths);
  expect(again.result.current.shell.shellErrors[0].seen).toBe(true);
  const other = mount("recovery-two", paths);
  expect(other.result.current.shell.shellErrors[0].seen).toBe(false);
});

it("keeps dismissal for the same copies and reports newly recovered files", () => {
  const first = mount("recovery-dismiss", [["a.md", ".dohc/engine/displaced/6a31.0"]] as const);
  act(() => {
    first.result.current.notice.noteDismissed();
    first.result.current.shell.dismissShellError(first.result.current.shell.shellErrors[0].id);
  });
  first.unmount();
  const again = mount("recovery-dismiss", [["a.md", ".dohc/engine/displaced/6a31.0"]] as const);
  expect(again.result.current.shell.shellErrors).toHaveLength(0);
  again.rerender({ paths: [["a.md", ".dohc/engine/displaced/6a31.0"], ["b.md", ".dohc/engine/displaced/6a32.0"]] });
  expect(again.result.current.shell.shellErrors).toHaveLength(1);
  expect(again.result.current.shell.shellErrors[0].seen).toBe(false);
});

it("keeps an adopted copy without its original path accessible through the recovery folder", () => {
  const path = ".dohc/engine/displaced/6a6f62.0";
  const h = mount("orphan-recovery", [["", path]]);
  const row = h.result.current.shell.shellErrors[0]!;
  expect(row.details).toEqual([["Copy", path]]);
  act(() => h.result.current.shell.runShellErrorAction(row.id));
  expect(h.openFolder).toHaveBeenCalledOnce();
});
