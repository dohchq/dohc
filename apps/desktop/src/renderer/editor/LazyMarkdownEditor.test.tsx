// @vitest-environment jsdom
import {
  StrictMode,
  Suspense,
  createRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import type { MarkdownEditorHandle } from "./MarkdownEditor";

// The module request stays open until the test settles it, so each test
// decides whether the editor resolves before or after the first render.
let editorModule = {
  loads: 0,
  evaluated: false,
  mounts: 0,
  unmounts: 0,
  resolve: () => {},
  reject: (_error: unknown) => {},
};

// One handle per mount, like the real editor's, so a new handle means a remount.
const MarkdownEditorStub = forwardRef<{ getMarkdown: () => string }, { value: string }>(
  function MarkdownEditorStub(props, ref) {
    const value = useRef(props.value);
    value.current = props.value;
    useImperativeHandle(ref, () => ({ getMarkdown: () => value.current }), []);
    useEffect(() => {
      editorModule.mounts += 1;
      return () => {
        editorModule.unmounts += 1;
      };
    }, []);
    return <div data-testid="markdown-editor">{props.value}</div>;
  },
);

let suspenseFallbackRenders = 0;

function SuspenseFallback() {
  suspenseFallbackRenders += 1;
  return null;
}

function Committed(props: { onCommit: () => void }) {
  useEffect(() => props.onCommit(), [props.onCommit]);
  return null;
}

function editorProps(value: string) {
  return {
    value,
    onDirty: () => undefined,
    workspaceId: "workspace-1",
    path: "notes/a.md",
    knownFiles: [],
  };
}

async function requestedEditorModule() {
  await vi.waitFor(() => expect(editorModule.loads).toBe(1));
}

async function resolveEditorModule() {
  editorModule.resolve();
  await vi.waitFor(() => expect(editorModule.evaluated).toBe(true));
}

beforeEach(() => {
  editorModule = {
    loads: 0,
    evaluated: false,
    mounts: 0,
    unmounts: 0,
    resolve: () => {},
    reject: () => {},
  };
  suspenseFallbackRenders = 0;
  // A fresh loader cache and a fresh module request for every test.
  vi.resetModules();
  vi.doMock("./MarkdownEditor", async () => {
    editorModule.loads += 1;
    await new Promise<void>((resolve, reject) => {
      editorModule.resolve = () => resolve();
      editorModule.reject = reject;
    });
    editorModule.evaluated = true;
    return { MarkdownEditor: MarkdownEditorStub };
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("./MarkdownEditor");
  vi.restoreAllMocks();
});

describe("LazyMarkdownEditor", () => {
  it("mounts a preloaded editor in its first commit and keeps it across renders", async () => {
    const { LazyMarkdownEditor, preloadMarkdownEditor } = await import("./LazyMarkdownEditor");
    preloadMarkdownEditor();
    await requestedEditorModule();
    await resolveEditorModule();

    const ref = createRef<MarkdownEditorHandle>();
    const committed = vi.fn();
    const view = (value: string) => (
      <Suspense fallback={<SuspenseFallback />}>
        <LazyMarkdownEditor {...editorProps(value)} ref={ref}>
          <Committed onCommit={committed} />
        </LazyMarkdownEditor>
      </Suspense>
    );
    const { rerender } = render(view("first"));

    const editor = screen.getByTestId("markdown-editor");
    expect(editor.textContent).toBe("first");
    expect(screen.queryByText("Loading editor...")).toBeNull();
    expect(committed).toHaveBeenCalledTimes(1);
    const handle = ref.current;
    expect(handle?.getMarkdown()).toBe("first");

    rerender(view("second"));

    expect(screen.getByTestId("markdown-editor")).toBe(editor);
    expect(editor.textContent).toBe("second");
    expect(ref.current).toBe(handle);
    expect(handle?.getMarkdown()).toBe("second");
    expect(editorModule).toMatchObject({ loads: 1, mounts: 1, unmounts: 0 });
    expect(suspenseFallbackRenders).toBe(0);
  });

  it("reveals a cold editor from its own loading state, never a Suspense fallback", async () => {
    const { LazyMarkdownEditor } = await import("./LazyMarkdownEditor");
    const committed = vi.fn();
    const view = (value: string) => (
      <Suspense fallback={<SuspenseFallback />}>
        <LazyMarkdownEditor {...editorProps(value)}>
          <Committed onCommit={committed} />
        </LazyMarkdownEditor>
      </Suspense>
    );
    const { rerender } = render(view("cold"));

    expect(screen.getByText("Loading editor...")).toBeTruthy();
    expect(committed).not.toHaveBeenCalled();
    await requestedEditorModule();
    await act(resolveEditorModule);

    expect((await screen.findByTestId("markdown-editor")).textContent).toBe("cold");
    expect(committed).toHaveBeenCalledTimes(1);

    rerender(view("edited"));

    expect(screen.getByTestId("markdown-editor").textContent).toBe("edited");
    expect(editorModule).toMatchObject({ loads: 1, mounts: 1, unmounts: 0 });
    expect(suspenseFallbackRenders).toBe(0);
  });

  it("serves the next mount from a load that settled after its requester unmounted", async () => {
    const { LazyMarkdownEditor } = await import("./LazyMarkdownEditor");
    const { unmount } = render(<LazyMarkdownEditor {...editorProps("gone")} />);
    await requestedEditorModule();
    unmount();
    await act(resolveEditorModule);

    render(<LazyMarkdownEditor {...editorProps("back")} />);

    expect(screen.getByTestId("markdown-editor").textContent).toBe("back");
    expect(editorModule).toMatchObject({ loads: 1, mounts: 1 });
  });

  it("keeps one failed import across Render again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { LazyMarkdownEditor } = await import("./LazyMarkdownEditor");
    render(
      <StrictMode>
        <EditorErrorBoundary resetKey="workspace-1:notes/a.md">
          <LazyMarkdownEditor {...editorProps("broken")} />
        </EditorErrorBoundary>
      </StrictMode>,
    );
    await requestedEditorModule();
    editorModule.reject("editor chunk failed to load");

    expect(await screen.findByTestId("editor-crash-recovery")).toBeTruthy();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(error).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Render again" }));

    expect(screen.getByTestId("editor-crash-recovery")).toBeTruthy();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(editorModule.loads).toBe(1);
  });
});
