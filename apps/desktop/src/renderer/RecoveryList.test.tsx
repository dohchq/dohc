// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { RecoveryList } from "./RecoveryList";
import {
  durableMarkdownFromSnapshot,
  restoreRecoveryDraftText,
} from "./collab/recoverySnapshot";
import type { OrphanedDraftRow } from "./orphanedDrafts";

afterEach(() => {
  cleanup();
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

const RICH_SOURCE = [
  "# My Heading",
  "",
  "- [linked](https://example.test)",
  "",
  "| Column |",
  "| ------ |",
  "| Cell |",
  "",
].join("\n");

// What the deletion and delivery boundaries write when the projection never
// answers: the crude walk's flattened text plus the canonical Y.Doc update.
function encodedDraftText(): string {
  const doc = markdownToYDoc(RICH_SOURCE);
  return durableMarkdownFromSnapshot(doc, Y.encodeStateAsUpdate(doc));
}

it("copies the projected document, not the encoded recovery snapshot", async () => {
  const text = encodedDraftText();
  // The producer's own output, so this pins the real contract and not a
  // hand-written imitation of it.
  expect(text).toContain("dohc-ydoc-recovery-v1");
  const user = userEvent.setup();
  render(<RecoveryList rows={[rowFor(text)]} />);

  // The projection module is lazy and shared. Awaiting the same restore the
  // row is already running settles both.
  await act(async () => {
    await restoreRecoveryDraftText(text);
  });

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

  await act(async () => {
    await restoreRecoveryDraftText(text);
  });

  await user.click(screen.getByTestId("recovery-list-copy"));
  await waitFor(async () =>
    expect(await navigator.clipboard.readText()).toBe("Crude fallback text"),
  );
});
