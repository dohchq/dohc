import { forwardRef, useState, type ReactNode } from "react";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import type {
  MarkdownEditor,
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from "./MarkdownEditor";

type MarkdownEditorComponent = typeof MarkdownEditor;

type MarkdownEditorLoad =
  | { status: "loading" }
  | { status: "ready"; Editor: MarkdownEditorComponent }
  | { status: "failed"; error: unknown };

let markdownEditorPromise: Promise<MarkdownEditorComponent> | null = null;

// Read during render, so an editor that finished loading mounts in the first
// commit. A shared React.lazy payload suspends on its first render after
// renderer start even when the promise has resolved, and React holds the
// reveal of that Suspense retry for up to 300ms.
let markdownEditorLoad: MarkdownEditorLoad = { status: "loading" };

function loadMarkdownEditor(): Promise<MarkdownEditorComponent> {
  markdownEditorPromise ??= import("./MarkdownEditor").then(
    (mod) => {
      markdownEditorLoad = { status: "ready", Editor: mod.MarkdownEditor };
      return mod.MarkdownEditor;
    },
    (error: unknown) => {
      markdownEditorLoad = { status: "failed", error };
      throw error;
    },
  );
  return markdownEditorPromise;
}

export function preloadMarkdownEditor(): void {
  void loadMarkdownEditor();
}

// Children commit with the editor, never with the loading state.
export const LazyMarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps & { children?: ReactNode }
>(function LazyMarkdownEditor({ children, ...props }, ref) {
  const [load, setLoad] = useState(markdownEditorLoad);

  useAsyncResponseEffect(
    () => (load.status === "loading" ? loadMarkdownEditor() : null),
    {
      onSuccess: (Editor) => setLoad({ status: "ready", Editor }),
      onError: (error) => setLoad({ status: "failed", error }),
    },
    [load.status],
  );

  // A failed import stays failed: Render again rethrows the cached error
  // instead of importing again.
  if (load.status === "failed") throw load.error;

  if (load.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-subtle">
        Loading editor...
      </div>
    );
  }

  return (
    <>
      <load.Editor {...props} ref={ref} />
      {children}
    </>
  );
});
