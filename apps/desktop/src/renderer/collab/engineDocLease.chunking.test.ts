// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { retainObservedEngineDocLease } from "./engineDocLeaseTestHarness";
import { ORPHANED_DRAFT_STORAGE_PREFIX } from "../orphanedDraftStorage";
import { harnessBridge } from "./engineDocChunkingTestHarness";

let projectionShouldFail = false;
// A held gate: while armed, the mocked import does not resolve until the
// test releases it — the only way to prove what is durable before the
// projection module answers, not just eventually.
let projectionGate: { promise: Promise<void>; release: () => void } | null =
  null;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
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

function editRichDocument(doc: Y.Doc) {
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
}

let observer: ReturnType<typeof retainObservedEngineDocLease> | null = null;

function retainDocument() {
  const retained = retainObservedEngineDocLease({
    workspaceId: "ws-1",
    path: "notes/rich.md",
    enabled: true,
  });
  observer = retained;
  return retained;
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  observer = null;
  harness = harnessBridge();
  projectionGate = null;
  projectionShouldFail = false;
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
});

afterEach(async () => {
  projectionGate?.release();
  cleanup();
  observer?.release();
  await disposeEngineDocLeasesForTests();
  await observer?.lease.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
  projectionGate = null;
  projectionShouldFail = false;
});

it("persists a lossless rich snapshot when delivery and projection fail", async () => {
  projectionShouldFail = true;
  harness = harnessBridge(richTextInitialUpdate());
  harness.rejectUpdates();
  vi.stubGlobal("dohcDesktop", harness.api);
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  const retained = retainDocument();
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );
  act(() => {
    editRichDocument(retained.boundDoc());
  });
  await waitFor(() => expect(harness.applied.length).toBeGreaterThan(0));
  const doc = retained.boundDoc();
  retained.release();
  await waitFor(() => expect(doc.isDestroyed).toBe(true));
  await retained.lease.dispose();

  // The live mirror is destroyed. Read the raw durable row, as the next
  // renderer process would, instead of consulting this run's in-memory store.
  let storedText = "";
  await waitFor(() => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(ORPHANED_DRAFT_STORAGE_PREFIX));
    expect(keys).toHaveLength(1);
    const raw = localStorage.getItem(keys[0]!);
    expect(raw).not.toBeNull();
    storedText = (JSON.parse(raw!) as { text: string }).text;
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

it("persists a lossless rich snapshot when a deletion's projection fails", async () => {
  // The deletion boundary is the sibling of the delivery boundary above, and
  // it loses the same way: the synchronous write is the only copy when the
  // projection never answers, so it has to carry the document structure, not
  // the crude walk's flattened text.
  projectionShouldFail = true;
  harness = harnessBridge(richTextInitialUpdate());
  vi.stubGlobal("dohcDesktop", harness.api);
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);

  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/rich.md"));
  const retained = retainDocument();
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );
  act(() => {
    editRichDocument(retained.boundDoc());
  });
  harness.emitNow("deleted", 0);
  await waitFor(() =>
    expect(drafts.result.current.length).toBe(1),
  );
  drafts.unmount();
  const doc = retained.boundDoc();
  retained.release();
  await waitFor(() => expect(doc.isDestroyed).toBe(true));
  await retained.lease.dispose();

  // The file is gone and the live mirror is destroyed. Read the raw durable
  // row, as the next renderer process would.
  let storedText = "";
  await waitFor(() => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(ORPHANED_DRAFT_STORAGE_PREFIX));
    expect(keys).toHaveLength(1);
    const raw = localStorage.getItem(keys[0]!);
    expect(raw).not.toBeNull();
    storedText = (JSON.parse(raw!) as { text: string }).text;
    expect(storedText).toMatch(/<!-- dohc-ydoc-recovery-v1:[A-Za-z0-9+/=]+ -->/u);
  });

  const encoded = storedText.match(
    /<!-- dohc-ydoc-recovery-v1:([A-Za-z0-9+/=]+) -->/u,
  )![1]!;
  const snapshot = Uint8Array.from(atob(encoded), (character) =>
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
    expect.stringContaining("could not write a recovery draft"),
    expect.any(Error),
  );
  consoleError.mockRestore();
});

// Must run before any test that lets a real projection load complete:
// `recoverySnapshot.ts`'s `loadProjectionModule` caches the promise at
// module scope, for the lifetime of this whole test FILE — once resolved by
// an earlier test, a later "held" gate has nothing left to hold.
it("persists a crude-text draft synchronously, before the held projection import resolves", async () => {
  // While the projection chunk is loading, the deletion
  // snapshot must not exist only in the queue's promise closure — a
  // renderer close/reload/crash in that window would lose the text, with
  // the file already deleted and no draft for the recovery close guard to
  // find. Hold the import so the faithful path can never complete inside
  // this test, and prove the crude path already persisted regardless.
  const release = armProjectionGate();
  harness = harnessBridge(richTextInitialUpdate());
  vi.stubGlobal("dohcDesktop", harness.api);

  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/rich.md"));
  const retained = retainDocument();
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));

  act(() => {
    const text = retained.boundDoc().getText("plainText");
    text.insert(text.length, "!");
  });
  harness.emitNow("deleted", 0);

  await waitFor(() =>
    expect(drafts.result.current.length, "skip the synchronous captureOrphanedDraft call in captureDeletion -> this reads 'none' because nothing is durable yet; the only route to a draft would be the still-held projection import.").toBe(1),
  );
  expect(drafts.result.current.at(-1)?.text).toContain("My Heading");

  release();
  await waitFor(
    () => {
      expect(drafts.result.current.length).toBe(1);
      expect(drafts.result.current.at(-1)?.text).toBe("# My Heading");
    },
  );
  // Upgraded in place, not appended: still exactly one row for this path.
  expect(drafts.result.current.length).toBe(1);
});
