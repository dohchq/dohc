import { createContext, Fragment, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { extractChatWorkReferenceTokens } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkReferenceOpen, WorkReferenceView } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { basenameOf } from "../path";
import { Ref } from "../ui/Ref";
import type { ObjectKind } from "../ui/KindGlyph";

// The work links in a window's chat messages, `@[work:REF]`: what each one
// names, asked of main in batches, and how one opens. A link is read again
// when it is opened, so a click never follows a rename it has not seen. One
// store serves one workspace; the shell makes a new one when its workspace
// changes, and an answer for the old one is dropped.
export interface WorkReferenceLinks {
  view(reference: string): WorkReferenceView | undefined;
  want(reference: string): void;
  subscribe(listener: () => void): () => void;
  open(reference: string): Promise<void>;
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

  function keep(answer: WorkReferenceView[]) {
    if (disposed) return;
    const now = Date.now();
    for (const view of answer) views.set(view.reference, { view, at: now });
    for (const listener of listeners) listener();
  }

  function flush() {
    scheduled = false;
    const references = [...queued];
    queued.clear();
    for (let at = 0; at < references.length && !disposed; at += BATCH) {
      const batch = references.slice(at, at + BATCH);
      for (const reference of batch) asking.add(reference);
      // A failed read leaves the link as it was; the next time it shows asks again.
      void describe(batch).then(keep, () => {}).finally(() => {
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
    async open(reference) {
      if (disposed) return;
      const answer = await describe([reference]);
      keep(answer);
      const target = answer.find((view) => view.reference === reference)?.open;
      if (!disposed && target) open(target);
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
// already a button. A link this workspace cannot show reads as unavailable;
// one still being read opens once it is read.
export function WorkRef(props: { reference: string; interactive: boolean; testId?: string }) {
  const links = useContext(WorkReferences);
  const view = useSyncExternalStore(links?.subscribe ?? noLinks, () => links?.view(props.reference));
  useEffect(() => links?.want(props.reference), [links, props.reference]);
  const testId = props.testId ? `${props.testId}-work-link` : undefined;
  const onOpen = props.interactive && links ? () => void links.open(props.reference).catch(() => {}) : undefined;
  if (!view || view.kind === null) {
    return (
      <Ref
        path=""
        title={view ? "Unavailable" : "Link"}
        objectKind="chat"
        missing={view !== undefined}
        testId={testId}
        {...(view ? {} : { label: "Open link", onOpen })}
      />
    );
  }
  const objectKind = OBJECT_KINDS[view.kind];
  const opensPath = view.kind === "file" || view.kind === "record" || view.kind === "app" || view.kind === "collection";
  const name = opensPath ? basenameOf(view.label) : view.label.trim() || FALLBACK_NAMES[view.kind] || "";
  return (
    <Ref
      path={opensPath ? view.label : ""}
      {...(opensPath && view.kind !== "collection" ? {} : { title: name })}
      {...(objectKind ? { objectKind } : {})}
      label={`Open ${name}`}
      testId={testId}
      onOpen={view.open ? onOpen : undefined}
    />
  );
}

// Text with its work links shown as chips that do not open, for a row that is
// already a button, such as a post card.
export function WorkLinkText(props: { text: string; testId?: string }) {
  const tokens = extractChatWorkReferenceTokens(props.text);
  if (tokens.length === 0) return <>{props.text}</>;
  let at = 0;
  return (
    <>
      {tokens.map((token) => {
        const before = props.text.slice(at, token.start);
        at = token.end;
        return (
          <Fragment key={token.start}>
            {before}
            <WorkRef reference={token.reference} interactive={false} testId={props.testId} />
          </Fragment>
        );
      })}
      {props.text.slice(at)}
    </>
  );
}
