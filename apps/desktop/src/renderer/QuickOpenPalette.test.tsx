// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./workbench/quick-open-rank", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workbench/quick-open-rank")>();
  return {
    ...original,
    prepareQuickOpenPaths: vi.fn(original.prepareQuickOpenPaths),
  };
});

import { QuickOpenPalette } from "./QuickOpenPalette";
import { prepareQuickOpenPaths } from "./workbench/quick-open-rank";
import { SHORTCUTS } from "../shortcuts/shortcutRegistry";

const files = [{ path: "notes.md" }, { path: "docs/report.md" }];
const recent = ["docs/report.md"];
const pinned = ["notes.md"];
const onOpenPath = vi.fn();
const onClose = vi.fn();

function palette(overrides: {
  files?: readonly { path: string }[];
  recent?: readonly string[];
  pinned?: readonly string[];
  onOpenPath?: (path: string) => void;
  onClose?: () => void;
} = {}) {
  return (
    <QuickOpenPalette
      files={overrides.files ?? files}
      recent={overrides.recent ?? recent}
      pinned={overrides.pinned ?? pinned}
      onOpenPath={overrides.onOpenPath ?? onOpenPath}
      onClose={overrides.onClose ?? onClose}
    />
  );
}

function Harness(props: { unrelatedShellRevision: number }) {
  return (
    <div data-shell-revision={props.unrelatedShellRevision}>
      {palette({
        onOpenPath: (path) => onOpenPath(path),
        onClose: () => onClose(),
      })}
    </div>
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(prepareQuickOpenPaths).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["win32", "darwin"].flatMap((platform) =>
  ["input", "result row", "panel"].map((focus) => ({ platform, focus })),
))("handles its own Go to toggle shortcut on $platform with focus on the $focus", ({ platform, focus }) => {
  vi.stubGlobal("dohcDesktop", { platform });
  const close = vi.fn();
  render(palette({ onClose: close }));
  const target = focus === "input"
    ? screen.getByRole("textbox", { name: "File" })
    : focus === "result row"
      ? screen.getByRole("button", { name: /notes.md/ })
      : screen.getByTestId("quick-open").closest<HTMLElement>('[data-focus-surface="dialog"]')!;
  target.focus();
  expect(document.activeElement).toBe(target);
  const event = new KeyboardEvent("keydown", {
    key: SHORTCUTS["quick-open"].accelerators[0].split("+").at(-1)!,
    ctrlKey: platform === "win32", metaKey: platform === "darwin",
    bubbles: true, cancelable: true,
  });
  fireEvent(target, event);
  expect(event.defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("does not rebuild derived file data for unrelated shell renders", () => {
  const view = render(<Harness unrelatedShellRevision={0} />);
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(1);

  view.rerender(<Harness unrelatedShellRevision={1} />);
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(1);
});

it("rebuilds derived file data when each ranking input identity changes", () => {
  const view = render(palette());
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(1);

  const changedFiles = [...files];
  view.rerender(palette({ files: changedFiles }));
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(2);

  const changedRecent = [...recent];
  view.rerender(palette({ files: changedFiles, recent: changedRecent }));
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(3);

  view.rerender(
    palette({ files: changedFiles, recent: changedRecent, pinned: [...pinned] }),
  );
  expect(prepareQuickOpenPaths).toHaveBeenCalledTimes(4);
});
