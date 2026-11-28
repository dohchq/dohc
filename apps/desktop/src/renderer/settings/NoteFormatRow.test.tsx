// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import type { NoteConversionState } from "../shell/useNoteConversion";
import { NoteFormatRow } from "./NoteFormatRow";

function show(
  state: NoteConversionState,
  options: { converts?: boolean; sharedView?: boolean } = {},
) {
  window.dohcDesktop = { convertsNotes: options.converts ?? true } as unknown as DohcDesktopBridge;
  const start = vi.fn();
  render(
    <NoteFormatRow
      conversion={{ state, start }}
      workspaceName="Trip"
      sharedView={options.sharedView ?? false}
    />,
  );
  return start;
}

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("Settings › Advanced › Note format", () => {
  it("is hidden while the engine does not write the new format, and in a shared view", () => {
    show({ status: "idle" }, { converts: false });
    expect(screen.queryByTestId("settings-row-note-format")).toBeNull();
    cleanup();
    show({ status: "idle" }, { sharedView: true });
    expect(screen.queryByTestId("settings-row-note-format")).toBeNull();
  });

  it("asks first, says it cannot be undone, and converts only on the danger button", () => {
    const start = show({ status: "idle" });
    expect(screen.getByText("Convert this workspace's notes to the new format.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Convert notes…" }));
    const dialog = screen.getByTestId("settings-confirm-convert-notes");
    expect(within(dialog).getByText("Convert notes in Trip to the new format")).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Every computer and phone that opens this workspace must run this version of dohc or a later one first. This cannot be undone.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByTestId("settings-confirm-convert-notes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Convert notes…" }));
    fireEvent.click(screen.getByTestId("settings-confirm-convert-notes-action"));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("settings-confirm-convert-notes")).toBeNull();
  });

  it("checks open notes, then counts with a bar, and waits until the run ends", () => {
    show({ status: "running", done: 0, total: 0 });
    expect(screen.getByText("Checking open notes…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Convert notes…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    show({ status: "running", done: 400, total: 2000 });
    expect(screen.getByText("Converting notes · 400 of 2,000")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Converting notes" });
    expect(bar.getAttribute("aria-valuenow")).toBe("400");
    expect(bar.getAttribute("aria-valuemax")).toBe("2000");
  });

  it("says what the last run did, and Try again runs it again without asking", () => {
    show({ status: "done", converted: 1980 });
    expect(screen.getByText("Converted 1,980 notes")).toBeTruthy();
    cleanup();
    show({ status: "done", converted: 0 });
    expect(screen.getByText("No notes to convert")).toBeTruthy();
    cleanup();

    const start = show({ status: "failed" });
    expect(screen.getByText("dohc could not convert notes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("settings-confirm-convert-notes")).toBeNull();
  });
});
