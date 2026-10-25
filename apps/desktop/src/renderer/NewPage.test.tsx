// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { afterEach, expect, it, vi } from "vitest";
import type { MarkdownEditorHandle } from "./editor/MarkdownEditor";
import type { LiveEditor } from "./MarkdownView";
import { NewPage, type NewPageFile } from "./NewPage";

afterEach(cleanup);

function liveEditor(): LiveEditor {
  const editor: MarkdownEditorHandle = {
    focus: vi.fn(),
    getMarkdown: vi.fn(() => ""),
    replaceMarkdown: vi.fn(),
    insertTypedText: vi.fn(),
  };
  return { ydoc: new Y.Doc(), editor };
}

// The shell renders the page's file under it once the file exists.
function renderPage() {
  const onLeaveTitle = vi.fn();
  const onHandedOff = vi.fn();
  let ready: ((editor: LiveEditor) => void) | undefined;
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
    editorReady: (editor: LiveEditor) => act(() => ready?.(editor)),
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

it("hands the title, the body and its caret to the editor at once, and steps aside", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("Lisbon{Enter}Day one{Enter}Tram 28 x{Backspace}");
  page.fileExists();
  expect(screen.getByTestId("file-view").parentElement!.hasAttribute("inert")).toBe(true);

  const live = liveEditor();
  page.editorReady(live);
  expect(live.ydoc.getMap("frontmatter").get("title")).toBe("Lisbon");
  expect(live.editor.insertTypedText).toHaveBeenCalledWith("Day one\nTram 28 ", "Day one\nTram 28 ".length);
  expect(live.editor.focus).toHaveBeenCalledWith(undefined);
  expect(screen.queryByTestId("new-page")).toBeNull();
  expect(screen.getByTestId("file-view").parentElement!.hasAttribute("inert")).toBe(false);
  expect(page.onHandedOff).toHaveBeenCalledTimes(1);

  // A later editor of the same file is the file's own.
  page.editorReady(liveEditor());
  expect(live.editor.insertTypedText).toHaveBeenCalledTimes(1);
});

it("puts the caret at the start of an empty body", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("{Enter}");
  page.fileExists();
  const live = liveEditor();
  page.editorReady(live);
  expect(live.ydoc.getMap("frontmatter").has("title")).toBe(false);
  expect(live.editor.focus).toHaveBeenCalledWith("start");
});

it("waits for an input method to finish before the editor takes the body", async () => {
  const user = userEvent.setup();
  const page = renderPage();
  await user.keyboard("{Enter}");
  page.fileExists();
  const body = screen.getByLabelText("Page body");
  fireEvent.compositionStart(body);
  const live = liveEditor();
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
