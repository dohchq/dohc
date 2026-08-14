// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { RecoveryList } from "./RecoveryList";
import { durableMarkdownFromSnapshot } from "./collab/recoverySnapshot";
import type { OrphanedDraftRow } from "./orphanedDrafts";

// These tests drive the lazy projection import itself — held, and failed — so
// the mock sits between the decoder and the real module.
//
// This file must therefore never import `@dohc/ydoc-projection` at the top
// level: the first successful load is cached for the whole file, and a later
// gate has nothing left to hold. The fixture below is built with plain yjs
// for the same reason.
let projectionShouldFail = false;
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
  return () => {
    projectionGate = null;
    release();
  };
}

afterEach(() => {
  cleanup();
  projectionShouldFail = false;
  projectionGate = null;
});

function rowFor(text: string): OrphanedDraftRow {
  return {
    workspaceId: "ws-1",
    workspaceLabel: "Personal notes",
    path: "notes/rich.md",
    draft: { id: 1, text, capturedAtMs: 1 },
    persisted: true,
  };
}

// A heading, a linked list item and a table: the crude walk flattens all
// three, so the projected text ("# My Heading") and the fallback
// ("My Heading") are told apart by one character.
function encodedDraftText(): string {
  const doc = new Y.Doc();
  const heading = new Y.XmlElement("heading");
  heading.setAttribute("level", "1");
  const headingText = new Y.XmlText();
  headingText.insert(0, "My Heading");
  heading.insert(0, [headingText]);

  const list = new Y.XmlElement("bulletList");
  const item = new Y.XmlElement("listItem");
  const paragraph = new Y.XmlElement("paragraph");
  const link = new Y.XmlText();
  link.insert(0, "linked", { link: { href: "https://example.test" } });
  paragraph.insert(0, [link]);
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

  doc.getXmlFragment("body").insert(0, [heading, list, table]);
  // The producer's own output, so this pins the real contract and not a
  // hand-written imitation of it.
  return durableMarkdownFromSnapshot(doc, Y.encodeStateAsUpdate(doc));
}

// MUST run before any test that lets a real projection load complete: a
// resolved import is cached for the lifetime of this file, and neither the
// failure nor the gate below can act on it afterwards.
it("retries a failed projection on the next copy, and waits for the decode", async () => {
  const text = encodedDraftText();
  projectionShouldFail = true;
  const user = userEvent.setup();
  render(<RecoveryList rows={[rowFor(text)]} />);

  // A failed import degrades to the readable half — never to the encoding.
  await user.click(screen.getByTestId("recovery-list-copy"));
  await waitFor(async () => {
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("My Heading");
    expect(copied).not.toContain("dohc-ydoc-recovery-v1");
    expect(copied).not.toContain("# My Heading");
  });

  // The failure was transient, and the row still holds the canonical
  // snapshot — until a Dismiss deletes it. The next copy has to retry the
  // import and WAIT for it, or the user keeps taking the lossy half away from
  // the only lossless copy there is.
  projectionShouldFail = false;
  const release = armProjectionGate();
  await user.click(screen.getByTestId("recovery-list-copy"));
  // MUTATION: copy the displayed fallback at click time — this reads the
  // projected text already, because nothing waited for the decode.
  expect(await navigator.clipboard.readText()).not.toContain("# My Heading");

  release();
  await waitFor(async () => {
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("# My Heading");
    expect(copied).toContain("[linked](https://example.test)");
    expect(copied).toMatch(/\| Cell\s*\|/u);
  });
});

it("copies the projected document, not the encoded recovery snapshot", async () => {
  const text = encodedDraftText();
  expect(text).toContain("dohc-ydoc-recovery-v1");
  const user = userEvent.setup();
  render(<RecoveryList rows={[rowFor(text)]} />);

  await user.click(screen.getByTestId("recovery-list-copy"));
  await waitFor(async () => {
    const copied = await navigator.clipboard.readText();
    // MUTATION: copy `row.draft.text` straight through — the user gets the
    // opaque blob, and the list, the table and the link stay locked in it.
    expect(copied).not.toContain("dohc-ydoc-recovery-v1");
    expect(copied).toContain("# My Heading");
    expect(copied).toContain("[linked](https://example.test)");
    expect(copied).toMatch(/\| Cell\s*\|/u);
  });
});

it("copies the readable half when the recovery snapshot cannot be decoded", async () => {
  // Valid base64, not a Y.Doc update: the decode has to degrade to the text
  // beside it instead of throwing or handing over the encoding.
  const text = "Crude fallback text\n\n<!-- dohc-ydoc-recovery-v1:AAECAwQ= -->";
  const user = userEvent.setup();
  render(<RecoveryList rows={[rowFor(text)]} />);

  await user.click(screen.getByTestId("recovery-list-copy"));
  await waitFor(async () =>
    expect(await navigator.clipboard.readText()).toBe("Crude fallback text"),
  );
});
