// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MarkdownEditorHandle } from "./editor/MarkdownEditor";
import type { PageEditor } from "./MarkdownView";
import { NewPage, type NewPageFile } from "./NewPage";

afterEach(cleanup);

function pageEditor() {
  const editor: MarkdownEditorHandle = {
    focus: vi.fn(),
    getMarkdown: vi.fn(() => ""),
    replaceMarkdown: vi.fn(),
    insertTypedText: vi.fn(),
  };
  return { editor, setIdentity: vi.fn<PageEditor["setIdentity"]>() };
}

// The shell renders the page's file under it once the file exists.
function renderPage() {
  const onLeaveTitle = vi.fn();
  const onHandedOff = vi.fn();
  let ready: ((editor: PageEditor | null) => void) | undefined;
  const file: NewPageFile = (onEditorReady) => {
    ready = onEditorReady;
    return <div data-testid="file-view" />;
  };
  const page = (withFile: boolean) => (
    <NewPage
      draft=""
      onDraftChange={() => undefined}
      onLeaveTitle={onLeaveTitle}
      file={withFile ? file : null}
      handedOff={false}
      onHandedOff={onHandedOff}
    />
  );
  const view = render(page(false));
  return {
    onLeaveTitle,
    onHandedOff,
    fileExists: () => view.rerender(page(true)),
    editorReady: (editor: PageEditor | null) => act(() => ready?.(editor)),
  };
}

it("opens with the cursor in the title and leaves it for the body on Enter", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  expect(screen.getByLabelText("Page title")).toBe(document.activeElement);
  await user.keyboard("Lisbon");
  expect(page.onLeaveTitle).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("Page body")).toBe(document.activeElement);
  expect(page.onLeaveTitle).toHaveBeenCalledTimes(1);
});

it("leaves the title for the body on a press anywhere below it", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("Lisbon");
  await user.click(screen.getByTestId("new-page"));
  expect(screen.getByLabelText("Page body")).toBe(document.activeElement);
  expect(page.onLeaveTitle).toHaveBeenCalledTimes(1);
  await user.keyboard("Day one");
  expect((screen.getByLabelText("Page body") as HTMLTextAreaElement).value).toBe("Day one");
});

it("hands the title, the body and its caret to the editor at once, and steps aside", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("Lisbon{Enter}Day one{Enter}Tram 28 x{Backspace}");
  page.fileExists();
  expect(screen.getByTestId("file-view").parentElement!.hasAttribute("inert")).toBe(true);

  const live = pageEditor();
  page.editorReady(live);
  expect(live.setIdentity).toHaveBeenCalledWith({ title: "Lisbon", icon: "" });
  expect(live.editor.insertTypedText).toHaveBeenCalledWith("Day one\nTram 28 ", "Day one\nTram 28 ".length);
  expect(live.editor.focus).toHaveBeenCalledWith(undefined);
  expect(screen.queryByTestId("new-page")).toBeNull();
  expect(screen.getByTestId("file-view").parentElement!.hasAttribute("inert")).toBe(false);
  expect(page.onHandedOff).toHaveBeenCalledTimes(1);

  // A later editor of the same file is the file's own.
  page.editorReady(pageEditor());
  expect(live.editor.insertTypedText).toHaveBeenCalledTimes(1);
});

it("puts the caret at the start of an empty body", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("{Enter}");
  page.fileExists();
  const live = pageEditor();
  page.editorReady(live);
  expect(live.setIdentity).toHaveBeenCalledWith({ title: "", icon: "" });
  expect(live.editor.focus).toHaveBeenCalledWith("start");
});

it("shows a file that opens with no editor", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("Lisbon{Enter}");
  page.fileExists();
  page.editorReady(null);
  expect(screen.queryByTestId("new-page")).toBeNull();
  expect(screen.getByTestId("file-view").parentElement!.hasAttribute("inert")).toBe(false);
  expect(page.onHandedOff).toHaveBeenCalledTimes(1);
});

it("waits for an input method to finish before the editor takes the body", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("{Enter}");
  page.fileExists();
  const body = screen.getByLabelText("Page body");
  fireEvent.compositionStart(body);
  const live = pageEditor();
  page.editorReady(live);
  expect(live.editor.insertTypedText).not.toHaveBeenCalled();
  expect(screen.getByTestId("new-page")).toBeTruthy();

  fireEvent.change(body, { target: { value: "東京" } });
  act(() => {
    fireEvent.compositionEnd(body);
  });
  expect(live.editor.insertTypedText).toHaveBeenCalledWith("東京", 2);
  expect(screen.queryByTestId("new-page")).toBeNull();
});
