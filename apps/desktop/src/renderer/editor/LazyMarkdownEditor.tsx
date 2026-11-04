import { forwardRef, useEffect, useState, type ReactNode } from "react";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import {
  currentCollaborationExtensionsLoad,
  loadCollaborationExtensions,
  preloadCollaborationExtensions,
} from "./collaborationExtensions";
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
  if (markdownEditorPromise) return markdownEditorPromise;
  // A live note's editor also needs the collaboration code. Loading both
  // together keeps a note's text on screen through its first open.
  preloadCollaborationExtensions();
  markdownEditorPromise = import("./MarkdownEditor").then(
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
  // A failure stays in `markdownEditorLoad`, and the editor shows it.
  loadMarkdownEditor().catch(() => undefined);
}

function liveEditorSettled(): boolean {
  return (
    markdownEditorLoad.status === "failed" ||
    (markdownEditorLoad.status === "ready" &&
      currentCollaborationExtensionsLoad().status !== "loading")
  );
}

/** Whether a live note's editor can mount without loading rows: its code and
 *  the collaboration code have loaded, or one of them failed and the editor
 *  shows that failure. A failed editor shows it without waiting for the
 *  collaboration code. */
export function useLiveEditorSettled(wanted: boolean): boolean {
  const [settled, setSettled] = useState(liveEditorSettled);
  useEffect(() => {
    if (!wanted || settled) return;
    let current = true;
    const settle = () => {
      if (current && liveEditorSettled()) setSettled(true);
    };
    loadMarkdownEditor().then(settle, settle);
    loadCollaborationExtensions().then(settle, settle);
    return () => {
      current = false;
    };
  }, [settled, wanted]);
  return settled || liveEditorSettled();
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

  // The editor's own top padding, so its first line lands on the first bar.
  if (load.status === "loading") {
    return <SkeletonRows layout="document" label="Loading editor..." className="h-full pt-1.5" />;
  }

  return (
    <>
      <load.Editor {...props} ref={ref} />
      {children}
    </>
  );
});
