// @vitest-environment jsdom
// #536: PR #524 made a 2 MB - 10 MiB conflict side listable, and the conflict
// surface then painted it unguarded — a whole side per `<pre>`, a whole side
// seeded into a CONTROLLED textarea, and every open conflict at once, two panes
// each. These pin all three bounds on the surface itself.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceVersionConflict } from "../../ipc/bridgeContract";

// The exact UTF-8 byte count is the one expensive thing this surface does to a
// whole side. Spy on it, so a test can see it being spent on cards the user
// cannot see — a render-count assertion cannot, and every bound test here
// passed while twenty collapsed 10 MiB cards cost 750 ms on mount.
const utf8ByteLengthSpy = vi.hoisted(() => vi.fn());
vi.mock("./conflictPane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conflictPane")>();
  utf8ByteLengthSpy.mockImplementation(actual.utf8ByteLength);
  return { ...actual, utf8ByteLength: utf8ByteLengthSpy };
});

const { CONFLICT_COMBINED_MAX_BYTES, CONFLICT_PREVIEW_MAX_CHARS } = await import(
  "./conflictPane"
);
const { ConflictReviewDialog, openConflictId } = await import("./WorkspaceVersions");

// 250,000 lines of 41 characters: over 10 MiB, the band #524 opened up.
function hugeBody(marker: string): string {
  const line = marker.repeat(40);
  const out: string[] = [];
  for (let index = 0; index < 250_000; index += 1) out.push(line);
  return out.join("\n") + "\n";
}

function conflict(
  overrides: Partial<WorkspaceVersionConflict> = {},
): WorkspaceVersionConflict {
  return {
    conflictId: "c-1",
    path: "notes.md",
    sourceVersionId: "v-1",
    targetVersionId: "main",
    origin: "merge",
    contentKind: "text",
    currentText: "main side\n",
    incomingText: "feature side\n",
    baseText: null,
    ...overrides,
  };
}

const bridgeMock = {
  listWorkspaceVersionConflicts: vi.fn(),
  listWorkspaceVersions: vi.fn(),
  resolveWorkspaceVersionConflict: vi.fn(),
};

beforeEach(() => {
  utf8ByteLengthSpy.mockClear();
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listWorkspaceVersions.mockResolvedValue({
    versions: [
      { id: "main", name: "Main", kind: "main", createdAtMs: 0, canMergeIntoMain: false },
      { id: "v-1", name: "Feature", kind: "named", createdAtMs: 1, canMergeIntoMain: true },
    ],
    activeVersionId: "v-1",
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openReview(conflicts: WorkspaceVersionConflict[]) {
  bridgeMock.listWorkspaceVersionConflicts.mockResolvedValue({ conflicts });
  render(
    <ConflictReviewDialog
      workspaceId="ws-1"
      onWorkspaceStateChanged={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findAllByTestId("version-conflict");
}

describe("a conflict side pane", () => {
  it("paints one window of a 10 MiB side and says what it held back", async () => {
    const incoming = hugeBody("b");
    await openReview([
      conflict({ currentText: "main side\n", incomingText: incoming }),
    ]);

    const panes = screen.getAllByTestId("version-conflict-side-text");
    expect(panes).toHaveLength(2);
    // Before the fix this was the whole 10 MiB body in one text node.
    const painted = panes[1].textContent ?? "";
    expect(painted.length).toBeLessThanOrEqual(CONFLICT_PREVIEW_MAX_CHARS);
    expect(painted.length).toBeGreaterThan(0);
    // The small side is untouched: the bound only cuts what is over it.
    expect(panes[0].textContent).toBe("main side\n");

    const hidden = screen.getByTestId("version-conflict-side-hidden");
    expect(hidden.textContent).toContain("more characters hidden");
    expect(hidden.textContent).toContain(
      (incoming.length - painted.length).toLocaleString("en-US"),
    );
  });

  it("shows one more window per press, and the rest stays reachable", async () => {
    await openReview([conflict({ incomingText: hugeBody("b") })]);
    const paintedLength = () =>
      (screen.getAllByTestId("version-conflict-side-text")[1].textContent ?? "")
        .length;
    const first = paintedLength();
    fireEvent.click(screen.getByTestId("version-conflict-side-show-more"));
    const second = paintedLength();
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(CONFLICT_PREVIEW_MAX_CHARS * 2);
  });

  it("offers no Show more when the whole side already fits", async () => {
    await openReview([conflict()]);
    expect(screen.queryByTestId("version-conflict-side-hidden")).toBeNull();
    expect(screen.queryByTestId("version-conflict-side-show-more")).toBeNull();
  });
});

describe("combine by hand", () => {
  it("is not offered when NEITHER side fits, and names the limit", async () => {
    await openReview([
      conflict({ currentText: hugeBody("a"), incomingText: hugeBody("b") }),
    ]);
    expect(screen.queryByTestId("version-conflict-combine")).toBeNull();
    const note = screen.getByTestId("version-conflict-combine-unavailable");
    expect(note.textContent).toContain(
      CONFLICT_COMBINED_MAX_BYTES.toLocaleString("en-US"),
    );
    expect(note.textContent).toContain("bytes");
    expect(note.textContent).toContain("Keep one copy, then edit the file.");
  });

  it("is offered for a side that fits, seeded with the incoming copy", async () => {
    await openReview([conflict()]);
    fireEvent.click(screen.getByTestId("version-conflict-combine"));
    const input = screen.getByTestId(
      "version-conflict-combined-input",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("feature side\n");
    expect(screen.getByTestId("version-conflict-combined-source").textContent).toBe(
      "Started from Feature's copy.",
    );
    expect(screen.queryByTestId("version-conflict-combine-unavailable")).toBeNull();
  });

  it("falls back to the OTHER side when the preferred one is over the cap", async () => {
    // A 10 MiB incoming copy beside a small copy on Main is still a conflict
    // the user can combine by hand. Preferring the oversized side and then
    // declaring the affordance unavailable refuses work the engine accepts.
    await openReview([
      conflict({ currentText: "main side\n", incomingText: hugeBody("b") }),
    ]);
    expect(screen.queryByTestId("version-conflict-combine-unavailable")).toBeNull();
    fireEvent.click(screen.getByTestId("version-conflict-combine"));
    expect(
      (screen.getByTestId("version-conflict-combined-input") as HTMLTextAreaElement)
        .value,
    ).toBe("main side\n");
    // The user has to know which copy they are editing.
    expect(screen.getByTestId("version-conflict-combined-source").textContent).toBe(
      "Started from Main's copy.",
    );
    expect(
      (screen.getByTestId("version-conflict-apply-combined") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("refuses to apply a combined copy typed past the cap, and names the limit", async () => {
    await openReview([conflict()]);
    fireEvent.click(screen.getByTestId("version-conflict-combine"));
    const input = screen.getByTestId("version-conflict-combined-input");
    const overCap = "x".repeat(CONFLICT_COMBINED_MAX_BYTES + 1);
    fireEvent.change(input, { target: { value: overCap } });

    const apply = screen.getByTestId(
      "version-conflict-apply-combined",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const alert = screen.getByTestId("version-conflict-combined-over-cap");
    expect(alert.textContent).toContain(
      (CONFLICT_COMBINED_MAX_BYTES + 1).toLocaleString("en-US"),
    );
    expect(alert.textContent).toContain(
      CONFLICT_COMBINED_MAX_BYTES.toLocaleString("en-US"),
    );
    fireEvent.click(apply);
    expect(bridgeMock.resolveWorkspaceVersionConflict).not.toHaveBeenCalled();

    // Back under the cap, the apply works again.
    fireEvent.change(input, { target: { value: "combined\n" } });
    expect(
      (screen.getByTestId("version-conflict-apply-combined") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByTestId("version-conflict-combined-over-cap")).toBeNull();
  });
});

describe("a list of open conflicts", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    conflict({ conflictId: `c-${index}`, path: `file-${index}.md` }),
  );

  it("paints two side panes however many conflicts are open", async () => {
    await openReview(many);
    expect(screen.getAllByTestId("version-conflict")).toHaveLength(40);
    // Before the fix this was 80 panes, each holding a whole side.
    expect(screen.getAllByTestId("version-conflict-side-text")).toHaveLength(2);
    expect(screen.getAllByTestId("version-conflict-keep-current")).toHaveLength(1);
  });

  it("never measures a side it is not painting", async () => {
    // Every one of these seeds is over the apply cap, so every card WOULD
    // count its bytes exactly if the count were not deferred to expansion.
    // Twenty 10 MiB sides cost 750 ms on mount that way, against 79 ms here —
    // and every other test in this file passed through that regression.
    const heavy = Array.from({ length: 20 }, (_, index) =>
      conflict({
        conflictId: `h-${index}`,
        path: `heavy-${index}.md`,
        currentText: hugeBody("a"),
        incomingText: hugeBody("b"),
      }),
    );
    await openReview(heavy);
    // The open card measures its two over-cap sides. The nineteen collapsed
    // ones measure nothing.
    expect(utf8ByteLengthSpy).toHaveBeenCalledTimes(2);

    utf8ByteLengthSpy.mockClear();
    const cards = screen.getAllByTestId("version-conflict");
    fireEvent.click(within(cards[7]).getByTestId("version-conflict-toggle"));
    expect(utf8ByteLengthSpy).toHaveBeenCalledTimes(2);
  });

  it("lets the open conflict be collapsed, and leaves the others closed", async () => {
    await openReview(many);
    const cards = screen.getAllByTestId("version-conflict");

    // Closing the card that is open must close it, not hand the turn back to
    // the first card.
    fireEvent.click(within(cards[0]).getByTestId("version-conflict-toggle"));
    expect(screen.queryAllByTestId("version-conflict-side-text")).toHaveLength(0);
    expect(
      within(cards[0]).getByTestId("version-conflict-toggle").getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");

    // And collapsing a LATER card must not reopen the first one.
    fireEvent.click(within(cards[5]).getByTestId("version-conflict-toggle"));
    expect(within(cards[5]).queryAllByTestId("version-conflict-side-text")).toHaveLength(2);
    fireEvent.click(within(cards[5]).getByTestId("version-conflict-toggle"));
    expect(screen.queryAllByTestId("version-conflict-side-text")).toHaveLength(0);
  });

  it("opens the first conflict, and expanding another closes it", async () => {
    await openReview(many);
    const cards = screen.getAllByTestId("version-conflict");
    expect(
      within(cards[0])
        .getByTestId("version-conflict-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(within(cards[3]).getByTestId("version-conflict-toggle"));
    expect(
      within(cards[3]).queryAllByTestId("version-conflict-side-text"),
    ).toHaveLength(2);
    expect(
      within(cards[0]).queryAllByTestId("version-conflict-side-text"),
    ).toHaveLength(0);
    expect(screen.getAllByTestId("version-conflict-side-text")).toHaveLength(2);
  });

  it("keeps a hand-written combined copy across a collapse", async () => {
    await openReview(many);
    const cards = screen.getAllByTestId("version-conflict");
    fireEvent.click(within(cards[0]).getByTestId("version-conflict-combine"));
    fireEvent.change(within(cards[0]).getByTestId("version-conflict-combined-input"), {
      target: { value: "my combined copy\n" },
    });

    // Collapsing must not discard the draft — the same discipline that keeps a
    // backdrop click from unmounting this card.
    fireEvent.click(within(cards[3]).getByTestId("version-conflict-toggle"));
    expect(
      within(cards[0]).getByTestId("version-conflict-draft-marker").textContent,
    ).toBe("Combined copy in progress");

    fireEvent.click(within(cards[0]).getByTestId("version-conflict-toggle"));
    expect(
      (
        within(cards[0]).getByTestId(
          "version-conflict-combined-input",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("my combined copy\n");
  });

  it("opens the next conflict once the open one is resolved", async () => {
    await openReview(many);
    bridgeMock.resolveWorkspaceVersionConflict.mockResolvedValue({
      conflicts: many.slice(1),
    });
    fireEvent.click(screen.getByTestId("version-conflict-keep-current"));
    await screen.findByText("file-1.md");
    const cards = screen.getAllByTestId("version-conflict");
    expect(cards).toHaveLength(39);
    expect(
      within(cards[0])
        .getByTestId("version-conflict-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getAllByTestId("version-conflict-side-text")).toHaveLength(2);
  });
});

describe("openConflictId", () => {
  const list = [conflict({ conflictId: "a" }), conflict({ conflictId: "b" })];

  it("opens the first conflict before the user has chosen", () => {
    expect(openConflictId(list, undefined)).toBe("a");
  });

  it("keeps every card closed once the user has closed the open one", () => {
    expect(openConflictId(list, null)).toBe(null);
  });

  it("opens the card the user chose", () => {
    expect(openConflictId(list, "b")).toBe("b");
  });

  it("hands the turn to the next file when the chosen one is resolved", () => {
    expect(openConflictId(list, "gone")).toBe("a");
  });

  it("opens nothing when there is nothing to open", () => {
    expect(openConflictId([], undefined)).toBe(null);
    expect(openConflictId([], "a")).toBe(null);
  });
});
