// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentMenu } from "./DocumentMenu";

type ExportDocumentFileCall = {
  workspaceId: string;
  suggestedName: string;
  content: string;
  kind: "html" | "pdf";
};

const writeText = vi.fn(async () => {});
const exportDocumentFile = vi.fn(async (_payload: ExportDocumentFileCall) => ({
  path: "/tmp/out.html",
}));

vi.mock("./bridge", () => ({
  bridge: () => ({ exportDocumentFile }),
}));

const MARKDOWN = "---\ntitle: Plan\n---\n\n# Plan\n\nBody text.\n";

function stubClipboard() {
  // navigator.clipboard is a getter-only property in jsdom; define it AFTER
  // userEvent.setup() so its own stub doesn't shadow this one.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

function renderMenu() {
  return render(
    <DocumentMenu
      workspaceId="ws-1"
      suggestedName="Plan"
      getMarkdown={() => MARKDOWN}
    />,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  writeText.mockClear();
  exportDocumentFile.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("DocumentMenu", () => {
  it("is closed until the trigger is clicked, then opens a labeled menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByTestId("document-menu-trigger"));

    expect(screen.getByRole("menu", { name: "Document actions" })).toBeTruthy();
    expect(screen.getByText("Copy as Markdown")).toBeTruthy();
    expect(screen.getByText("Export as HTML…")).toBeTruthy();
    expect(screen.getByText("Export as PDF…")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("returns focus to the trigger when closed with Escape", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("document-menu-trigger");
    await user.click(trigger);
    // Focus moves into the menu list on open.
    expect(document.activeElement).toBe(screen.getByRole("menu"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates items with ArrowDown/ArrowUp and selects with Enter", async () => {
    const user = userEvent.setup();
    renderMenu();
    stubClipboard();
    await user.click(screen.getByTestId("document-menu-trigger"));

    // First item ("Copy as Markdown") is selected by default.
    expect(
      screen.getByTestId("document-menu-item-copy-markdown").className,
    ).toContain("is-selected");
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByTestId("document-menu-item-export-html").className,
    ).toContain("is-selected");
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByTestId("document-menu-item-copy-markdown").className,
    ).toContain("is-selected");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MARKDOWN));
  });

  it("copies the exact current markdown to the clipboard and shows quiet confirmation", async () => {
    const user = userEvent.setup();
    renderMenu();
    stubClipboard();
    await user.click(screen.getByTestId("document-menu-trigger"));

    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });

  it("exports as HTML through the bridge with the rendered document and closes the menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    await user.click(screen.getByTestId("document-menu-item-export-html"));

    await waitFor(() => expect(exportDocumentFile).toHaveBeenCalledTimes(1));
    const call = exportDocumentFile.mock.calls[0]![0];
    expect(call.workspaceId).toBe("ws-1");
    expect(call.suggestedName).toBe("Plan");
    expect(call.kind).toBe("html");
    expect(call.content).toContain("<!doctype html>");
    expect(call.content).toContain("Plan");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exports as PDF through the bridge with kind: pdf", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    await user.click(screen.getByTestId("document-menu-item-export-pdf"));

    await waitFor(() => expect(exportDocumentFile).toHaveBeenCalledTimes(1));
    expect(exportDocumentFile.mock.calls[0]![0].kind).toBe("pdf");
  });
});
