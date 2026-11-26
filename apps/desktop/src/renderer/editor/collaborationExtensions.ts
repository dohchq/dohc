type CollaborationExtension = typeof import("@tiptap/extension-collaboration").Collaboration;
type CollaborationCaretExtension =
  typeof import("@tiptap/extension-collaboration-caret").CollaborationCaret;
type YTiptap = typeof import("@tiptap/y-tiptap");
export type BodySequenceModules = {
  BodySequence: typeof import("@dohc/ydoc-projection/body-sequence-tiptap").BodySequence;
  editor: typeof import("@dohc/ydoc-projection/body-sequence-editor");
};

// Both extensions bind to the same ydoc/awareness pair and are only ever
// used together, so they load as one lazy bundle — a caller with an
// `awareness` never waits on a second dynamic import, and a caller without
// one still pays for exactly the bytes it did before (CollaborationCaret is
// tiny, and it's simply never configured into the editor's extensions).
export type CollaborationExtensions = {
  Collaboration: CollaborationExtension;
  CollaborationCaret: CollaborationCaretExtension;
  yTiptap: YTiptap;
  bodySequence: BodySequenceModules;
};

export type CollaborationExtensionsLoad =
  | { status: "loading" }
  | { status: "ready"; extensions: CollaborationExtensions }
  | { status: "failed"; error: Error };

export function collaborationLoadError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("dohc could not load the live editor.", { cause: error });
}

let collaborationExtensionsPromise: Promise<CollaborationExtensions> | null = null;
let collaborationExtensionsLoad: CollaborationExtensionsLoad = { status: "loading" };

/** Read during render, so once the extensions have loaded, a live note's
 *  editor mounts in its first commit instead of painting loading rows over
 *  the note's text. */
export function currentCollaborationExtensionsLoad(): CollaborationExtensionsLoad {
  return collaborationExtensionsLoad;
}

export function loadCollaborationExtensions(): Promise<CollaborationExtensions> {
  collaborationExtensionsPromise ??= Promise.all([
    import("@tiptap/extension-collaboration"),
    import("@tiptap/extension-collaboration-caret"),
    import("@tiptap/y-tiptap"),
    import("@dohc/ydoc-projection/body-sequence-tiptap"),
    import("@dohc/ydoc-projection/body-sequence-editor"),
  ]).then(
    ([collaboration, collaborationCaret, yTiptap, bodySequenceTiptap, bodySequenceEditor]) => {
      const extensions = {
        Collaboration: collaboration.Collaboration,
        CollaborationCaret: collaborationCaret.CollaborationCaret,
        yTiptap,
        bodySequence: { BodySequence: bodySequenceTiptap.BodySequence, editor: bodySequenceEditor },
      };
      collaborationExtensionsLoad = { status: "ready", extensions };
      return extensions;
    },
    (error: unknown) => {
      collaborationExtensionsLoad = { status: "failed", error: collaborationLoadError(error) };
      throw error;
    },
  );
  return collaborationExtensionsPromise;
}

/** Starts the load early. A failure is kept, and the next live editor shows it. */
export function preloadCollaborationExtensions(): void {
  loadCollaborationExtensions().catch(() => undefined);
}
