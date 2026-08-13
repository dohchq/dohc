// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { ORPHANED_DRAFT_STORAGE_KEY } from "../orphanedDraftStorage";
import {
  disposeEngineDocLeasesForTests,
  useEngineDoc,
} from "./useEngineDoc";

// `useEngineDoc` backs every FileInspector. `@dohc/ydoc-projection`
// statically pulls in the full Tiptap stack and builds its schema at module
// load, so a static top-level import of it here put that whole editor stack
// in the renderer's EAGER chunk — defeating the lazy MarkdownEditor split
// this codebase otherwise relies on. This file pins that the projection
// module loads only when a deletion snapshot actually needs projecting, not
// merely by importing/binding this hook.
//
// vi.mock is hoisted above every import in this file, including this file's
// own `import { useEngineDoc } from "./useEngineDoc"` — so a static import
// chain from useEngineDoc.ts down to the projection module would already
// have run the factory below before any `it()` executes.
let projectionLoads = 0;
let projectionShouldFail = false;
// A held gate: while armed, the mocked import does not resolve until the
// test releases it — the only way to prove what is durable BEFORE the
// projection module answers, not just eventually.
let projectionGate: { promise: Promise<void>; release: () => void } | null =
  null;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  projectionLoads += 1;
  if (projectionGate) await projectionGate.promise;
  if (projectionShouldFail) throw new Error("projection import failed");
  return importOriginal();
});

function armProjectionGate(): () => void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectionGate = { promise, release };
  return release;
}

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

function harnessBridge(initialUpdate?: Uint8Array) {
  const saveStateListeners = new Set<SaveStateListener>();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  let rejectUpdates = false;
  let openedSessionId: string | null = null;
  const doc = new Y.Doc();
  doc.getMap("meta").set("contentKind", "plain-text");
  doc.getText("plainText").insert(0, "seed");
  const seedUpdate = initialUpdate ?? Y.encodeStateAsUpdate(doc);

  const api = {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      return { available: true, initialUpdate: seedUpdate };
    },
    async applyEngineYDocUpdate(payload: { sessionId: string; seq: number }) {
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
      if (rejectUpdates) throw new Error("update delivery failed");
    },
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    async closeEngineYDocSession() {
      return undefined;
    },
  };

  function emitNow(
    state: "settling" | "saved" | "error" | "file-locked" | "deleted",
    seq: number,
  ): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    for (const listener of [...saveStateListeners]) {
      listener({ sessionId: openedSessionId, state, seq });
    }
  }

  return {
    api,
    applied,
    emitNow,
    sessionId: () => openedSessionId,
    rejectUpdates() {
      rejectUpdates = true;
    },
  };
}

function Harness(props: { workspaceId: string; path: string }) {
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  return (
    <div>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="draft">{drafts.at(-1)?.text ?? "none"}</span>
      <span data-testid="draft-count">{drafts.length}</span>
      <button
        type="button"
        data-testid="type"
        onClick={() => {
          const text = engine.doc?.getText("plainText");
          text?.insert(text.length, "!");
        }}
      >
        type
      </button>
      <button
        type="button"
        data-testid="type-rich"
        onClick={() => {
          const doc = engine.doc;
          if (!doc) return;
          doc.transact(() => {
            const body = doc.getXmlFragment("body");
            const list = new Y.XmlElement("bulletList");
            const item = new Y.XmlElement("listItem");
            const paragraph = new Y.XmlElement("paragraph");
            const link = new Y.XmlText();
            link.insert(0, "linked", {
              link: { href: "https://example.test" },
            });
            const image = new Y.XmlElement("image");
            image.setAttribute("src", "assets/diagram.png");
            image.setAttribute("alt", "Diagram");
            paragraph.insert(0, [link, image]);
            item.insert(0, [paragraph]);
            list.insert(0, [item]);

            const table = new Y.XmlElement("table");
            const row = new Y.XmlElement("tableRow");
            const cell = new Y.XmlElement("tableCell");
            const cellParagraph = new Y.XmlElement("paragraph");
            const cellText = new Y.XmlText();
            cellText.insert(0, "Cell");
            cellParagraph.insert(0, [cellText]);
            cell.insert(0, [cellParagraph]);
            row.insert(0, [cell]);
            table.insert(0, [row]);
            body.insert(body.length, [list, table]);
          });
        }}
      >
        type rich
      </button>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  harness = harnessBridge();
  projectionGate = null;
  projectionShouldFail = false;
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
});

afterEach(async () => {
  cleanup();
  await disposeEngineDocLeasesForTests();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
  projectionGate = null;
  projectionShouldFail = false;
});

it("does not load the Tiptap projection module merely by importing useEngineDoc", () => {
  // No render, no bind, nothing — this checks the STATIC import chain only.
  // MUTATION: reintroduce `import { yDocToMarkdown } from "@dohc/ydoc-projection"`
  // at the top of useEngineDoc.ts -> this reads 1 instead of 0, because the
  // test file's own top-level `import { useEngineDoc } from "./useEngineDoc"`
  // already evaluated that chain before this test body ran.
  expect(projectionLoads).toBe(0);
});

// A rich-text doc, so the crude walk (raw text, no markdown syntax) and the
// faithful projection (real heading syntax) visibly differ — the only way to
// prove an upgrade happened rather than the same value read twice.
function richTextInitialUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment("body");
  const heading = new Y.XmlElement("heading");
  heading.setAttribute("level", "1");
  const text = new Y.XmlText();
  text.insert(0, "My Heading");
  heading.insert(0, [text]);
  frag.insert(0, [heading]);
  return Y.encodeStateAsUpdate(doc);
}

it("persists a lossless rich snapshot when delivery and projection fail", async () => {
  projectionShouldFail = true;
  harness = harnessBridge(richTextInitialUpdate());
  harness.rejectUpdates();
  vi.stubGlobal("dohcDesktop", harness.api);
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  const view = render(<Harness workspaceId="ws-1" path="notes/rich.md" />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  act(() => {
    screen.getByTestId("type-rich").click();
  });
  await waitFor(() => expect(harness.applied.length).toBeGreaterThan(0));
  view.unmount();

  // The live mirror is destroyed. Read the raw durable row, as the next
  // renderer process would, instead of consulting this run's in-memory store.
  let storedText = "";
  await waitFor(() => {
    const raw = localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    storedText = (JSON.parse(raw!) as Array<{ text: string }>)[0]?.text ?? "";
    expect(storedText).toMatch(/<!-- dohc-ydoc-recovery-v1:[A-Za-z0-9+/=]+ -->/u);
  });

  const encoded = storedText.match(
    /<!-- dohc-ydoc-recovery-v1:([A-Za-z0-9+/=]+) -->/u,
  )![1]!;
  const binary = atob(encoded);
  const snapshot = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, snapshot);
  const body = recovered.getXmlFragment("body").toString();
  expect(body).toContain("<bulletlist>");
  expect(body).toContain('href="https://example.test"');
  expect(body).toContain('<image alt="Diagram" src="assets/diagram.png"></image>');
  expect(body).toContain("<table>");
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("could not refine the recovery draft"),
    expect.any(Error),
  );
  consoleError.mockRestore();
});

// MUST run before any test that lets a real projection load complete:
// `useEngineDoc.ts`'s own `loadProjectionModule` caches the promise at
// module scope, for the lifetime of this whole test FILE — once resolved by
// an earlier test, a later "held" gate has nothing left to hold.
it("persists a crude-text draft synchronously, before the held projection import resolves", async () => {
  // #697 Codex P1: while the projection chunk is loading, the deletion
  // snapshot must not exist ONLY in the queue's promise closure — a
  // renderer close/reload/crash in that window would lose the text, with
  // the file already deleted and no draft for the recovery close guard to
  // find. Hold the import so the faithful path can never complete inside
  // this test, and prove the crude path already persisted regardless.
  const release = armProjectionGate();
  harness = harnessBridge(richTextInitialUpdate());
  vi.stubGlobal("dohcDesktop", harness.api);

  render(<Harness workspaceId="ws-1" path="notes/rich.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => {
    screen.getByTestId("type").click();
  });
  harness.emitNow("deleted", 0);

  // MUTATION: skip the synchronous captureOrphanedDraft call in
  // captureDeletion -> this reads "none" because nothing is durable yet;
  // the only route to a draft would be the still-held projection import.
  await waitFor(() =>
    expect(screen.getByTestId("draft-count").textContent).toBe("1"),
  );
  expect(screen.getByTestId("draft").textContent).toBe("My Heading");

  release();
  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("# My Heading"),
  );
  // Upgraded in place, not appended: still exactly one row for this path.
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
});

it("preloads the projection module once a session binds, but not before", async () => {
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  // The bind fires the preload fire-and-forget; give its microtask a turn.
  await waitFor(() => expect(projectionLoads).toBeGreaterThan(0));
});
