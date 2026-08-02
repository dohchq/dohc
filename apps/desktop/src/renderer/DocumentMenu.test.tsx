// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentMenu } from "./DocumentMenu";
// The HTML/PDF actions load ./editor/documentExport lazily, on demand — a
// Tiptap + ProseMirror + KaTeX graph the app deliberately keeps off its open
// path. Import it here so vitest transforms and executes that graph while
// collecting this file, not in the middle of a test. Leaving it on the test's
// own clock put ~600ms of module load inside the assertion, and a busy machine
// pushed it past the window (#522).
import "./editor/documentExport";

type ExportDocumentFileCall = {
  workspaceId: string;
  suggestedName: string;
  content: string;
  kind: "markdown" | "html" | "pdf";
};

// Every assertion below awaits the call itself, never a wall-clock window. A
// slow machine must delay these tests, never fail them — and no abandoned
// export can land in the next test and corrupt its call count.
let pendingClipboardWrite: ((text: string) => void) | null = null;
let pendingExport: ((payload: ExportDocumentFileCall) => void) | null = null;

const writeText = vi.fn(async (text: string) => {
  pendingClipboardWrite?.(text);
  pendingClipboardWrite = null;
});
const exportDocumentFile = vi.fn(async (payload: ExportDocumentFileCall) => {
  pendingExport?.(payload);
  pendingExport = null;
  return { path: "/tmp/out.html" };
});

// Arm before the click that should trigger the call, await after it.
function nextClipboardWrite(): Promise<string> {
  return new Promise((resolve) => {
    pendingClipboardWrite = resolve;
  });
}

function nextExport(): Promise<ExportDocumentFileCall> {
  return new Promise((resolve) => {
    pendingExport = resolve;
  });
}

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
  pendingClipboardWrite = null;
  pendingExport = null;
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
    expect(screen.getByText("Export as Markdown…")).toBeTruthy();
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
      screen.getByTestId("document-menu-item-export-markdown").className,
    ).toContain("is-selected");
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByTestId("document-menu-item-copy-markdown").className,
    ).toContain("is-selected");

    const written = nextClipboardWrite();
    await user.keyboard("{Enter}");
    expect(await written).toBe(MARKDOWN);
  });

  it("copies the exact current markdown to the clipboard and shows quiet confirmation", async () => {
    const user = userEvent.setup();
    renderMenu();
    stubClipboard();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const written = nextClipboardWrite();
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    expect(await written).toBe(MARKDOWN);
    // Lets the component's own `await` chain finish and React repaint. No
    // polling and no timeout: the queued work is microtask-bound, so this
    // does not depend on elapsed time.
    await act(async () => {});
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("exports as HTML through the bridge with the rendered document and closes the menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-html"));

    const call = await exported;
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
    expect(call.workspaceId).toBe("ws-1");
    expect(call.suggestedName).toBe("Plan");
    expect(call.kind).toBe("html");
    expect(call.content).toContain("<!doctype html>");
    expect(call.content).toContain("Plan");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exports as Markdown through the bridge with the RAW document source", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));

    const call = await exported;
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
    expect(call.kind).toBe("markdown");
    // Verbatim source, frontmatter included — no HTML rendering involved.
    expect(call.content).toBe(MARKDOWN);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exports as PDF through the bridge with kind: pdf", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-pdf"));

    expect((await exported).kind).toBe("pdf");
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
  });
});
