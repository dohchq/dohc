// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineDocSaveState } from "../collab/engineDocLease";
import type { FileSaveState } from "../fileInspectorUi";
import type { SettingsSaveState } from "../settings/SettingsDialog";
import type { SaveState as DraftSaveState } from "../useAutosavedTextDraft";
import { SAVE_STATE, StateMark, type SaveStateKey, type StatePresentation } from "./StateMark";

afterEach(cleanup);

const KEYS = Object.keys(SAVE_STATE) as SaveStateKey[];

describe("StateMark", () => {
  it("has a row for every member of every save-state union", () => {
    // Each assignment narrows the map to one storage union. A member the map
    // has no row for fails here at compile time, before any test runs.
    const engine: Record<EngineDocSaveState, StatePresentation> = SAVE_STATE;
    const draft: Record<DraftSaveState, StatePresentation> = SAVE_STATE;
    const file: Record<FileSaveState, StatePresentation> = SAVE_STATE;
    const settings: Record<Exclude<SettingsSaveState, "idle">, StatePresentation> = SAVE_STATE;
    for (const rows of [engine, draft, file, settings]) expect(rows).toBe(SAVE_STATE);
    for (const key of KEYS) expect(SAVE_STATE[key].label).not.toBe("");
  });

  it("fills the mark only for a state the file on disk has settled", () => {
    // "saved" is reported by the engine lease only after the settle that
    // covers the newest local edit, and by the draft hook and Settings only
    // after their write returned. Every other state is still working, held
    // by something, or needs the person, so none of them may read as done.
    const settled = KEYS.filter((key) => SAVE_STATE[key].mark === "settled");
    expect(settled).toEqual(["saved"]);
    // "Saved" at the start of a label claims the edit is durable somewhere.
    // The host and the local engine store are the only other places that
    // can make that claim.
    const claimsSaved = KEYS.filter((key) => SAVE_STATE[key].label.startsWith("Saved"));
    expect(claimsSaved.sort()).toEqual(["pending-share", "saved", "saved-to-host"]);
    for (const key of claimsSaved) {
      if (key !== "saved") expect(SAVE_STATE[key].mark).toBe("working");
    }
  });

  it("renders every state with its mark, its label, and the stored state", () => {
    for (const key of KEYS) {
      const { container, unmount } = render(<StateMark testId="mark" state={key} shown={key} />);
      const chip = screen.getByTestId("mark");
      expect(chip.getAttribute("data-state")).toBe(key);
      expect(chip.textContent).toBe(SAVE_STATE[key].label);
      expect(chip.getAttribute("title")).toBe(SAVE_STATE[key].title ?? null);
      // One decorative mark before the words, never a second accessible name.
      expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(1);
      // Nothing moves, so reduced motion has nothing to switch off.
      expect(container.innerHTML).not.toMatch(/animate-|animation/u);
      unmount();
    }
  });

  it("keeps the stored state when a different row is shown", () => {
    // A disabled editor over a saved draft: the chip reads "Read-only" but
    // the shell still sees the draft's own state.
    render(<StateMark testId="mark" state="saved" shown="too-large" />);
    const chip = screen.getByTestId("mark");
    expect(chip.getAttribute("data-state")).toBe("saved");
    expect(chip.textContent).toBe("Read-only");
    expect(chip.getAttribute("title")).toBe("This file is too large to edit in dohc.");
  });

  it("lets the caller's title replace the row's", () => {
    render(<StateMark testId="mark" state="error" shown="error" title="The disk is full." />);
    expect(screen.getByTestId("mark").getAttribute("title")).toBe("The disk is full.");
  });
});
