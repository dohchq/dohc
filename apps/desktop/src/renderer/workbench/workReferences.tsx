import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { WorkReferenceOpen, WorkReferenceView } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { basenameOf } from "../path";
import { Ref } from "../ui/Ref";
import type { ObjectKind } from "../ui/KindGlyph";

// The work links in a window's chat messages, `@[work:REF]`: what each one
// names, asked of main in batches, and how one opens. One store serves one
// workspace; the shell makes a new one when its workspace changes, and an
// answer for the old one is dropped.
export interface WorkReferenceLinks {
  view(reference: string): WorkReferenceView | undefined;
  want(reference: string): void;
  subscribe(listener: () => void): () => void;
  open(target: WorkReferenceOpen): void;
}

export const WorkReferences = createContext<WorkReferenceLinks | null>(null);

// A chat or file can be renamed or deleted after its link was read, so a link
// shown again after this long is read again.
const FRESH_MS = 30_000;
const BATCH = 64;

export function createWorkReferenceLinks(
  workspaceId: string,
  open: (target: WorkReferenceOpen) => void,
  describe = (references: string[]) => bridge().describeWorkReferences({ workspaceId, references }),
): WorkReferenceLinks & { dispose(): void } {
  const views = new Map<string, { view: WorkReferenceView; at: number }>();
  const queued = new Set<string>();
  const asking = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  let disposed = false;

  function flush() {
    scheduled = false;
    const references = [...queued];
    queued.clear();
    for (let at = 0; at < references.length && !disposed; at += BATCH) {
      const batch = references.slice(at, at + BATCH);
      for (const reference of batch) asking.add(reference);
      // A failed read leaves the link as it was; the next time it shows asks again.
      void describe(batch).then((answer) => {
        if (disposed) return;
        const now = Date.now();
        for (const view of answer) views.set(view.reference, { view, at: now });
        for (const listener of listeners) listener();
      }, () => {}).finally(() => {
        for (const reference of batch) asking.delete(reference);
      });
    }
  }

  return {
    view: (reference) => views.get(reference)?.view,
    want(reference) {
      const known = views.get(reference);
      if (disposed || (known && Date.now() - known.at < FRESH_MS) || asking.has(reference) || queued.has(reference)) return;
      queued.add(reference);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (target) => {
      if (!disposed) open(target);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

export function useWorkReferenceLinks(workspaceId: string, open: (target: WorkReferenceOpen) => void): WorkReferenceLinks {
  const links = useMemo(() => createWorkReferenceLinks(workspaceId, open), [workspaceId, open]);
  useEffect(() => () => links.dispose(), [links]);
  return links;
}

const noLinks = () => () => {};

const OBJECT_KINDS: Partial<Record<NonNullable<WorkReferenceView["kind"]>, ObjectKind>> = {
  chat: "group",
  thread: "chat",
  message: "chat",
  app: "app",
  collection: "collection",
  data: "collection",
};

const FALLBACK_NAMES: Partial<Record<NonNullable<WorkReferenceView["kind"]>, string>> = {
  chat: "Chat",
  thread: "Thread",
  message: "Message",
  data: "Table",
};

// One work link, as the chip a file link shows. It opens what it names
// unless `interactive` is false, as inside another link or a row that is
// already a button. A link this workspace cannot show reads as unavailable.
export function WorkRef(props: { reference: string; interactive: boolean; testId?: string }) {
  const links = useContext(WorkReferences);
  const view = useSyncExternalStore(links?.subscribe ?? noLinks, () => links?.view(props.reference));
  useEffect(() => links?.want(props.reference), [links, props.reference]);
  const testId = props.testId ? `${props.testId}-work-link` : undefined;
  if (!view || view.kind === null) {
    return <Ref path="" title={view ? "Unavailable" : "Link"} objectKind="chat" missing={view !== undefined} testId={testId} />;
  }
  const objectKind = OBJECT_KINDS[view.kind];
  const opensPath = view.kind === "file" || view.kind === "record" || view.kind === "app" || view.kind === "collection";
  const name = opensPath ? basenameOf(view.label) : view.label.trim() || FALLBACK_NAMES[view.kind] || "";
  const target = view.open;
  return (
    <Ref
      path={opensPath ? view.label : ""}
      {...(opensPath && view.kind !== "collection" ? {} : { title: name })}
      {...(objectKind ? { objectKind } : {})}
      label={`Open ${name}`}
      testId={testId}
      onOpen={props.interactive && links && target ? () => links.open(target) : undefined}
    />
  );
}
