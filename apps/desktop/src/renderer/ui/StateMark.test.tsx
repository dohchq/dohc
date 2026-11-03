// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewActions } from "../fileInspectorUi";
import type { SettingsSaveState } from "../settings/SettingsDialog";
import { ACCESS_STATE, SAVE_STATE, StateMark, type AccessStateKey, type SaveStateKey, type StatePresentation } from "./StateMark";

afterEach(cleanup);

const KEYS = Object.keys(SAVE_STATE) as SaveStateKey[];

describe("StateMark", () => {
  it("does not promise History has a changed outside file", () => {
    expect(SAVE_STATE["changed-on-disk"].title).toBe("This file changed outside dohc.");
  });

  it("has a row for every member of every save-state union", () => {
    // Each assignment narrows the map to one storage union. A member the map
    // has no row for fails here at compile time, before any test runs.
    const settings: Record<Exclude<SettingsSaveState, "idle">, StatePresentation> = SAVE_STATE;
    for (const rows of [settings]) expect(rows).toBe(SAVE_STATE);
    for (const key of KEYS) expect(SAVE_STATE[key].label).not.toBe("");
  });

  it.each([false, true])("shows no chip for unknown, truncated=%s, and can later show Saved", truncate => {
    const { rerender } = render(<StateMark testId="mark" state={{ kind: "unknown" }} shown={{ kind: "unknown" }} truncate={truncate} />);
    expect(screen.queryByTestId("mark")).toBeNull();
    rerender(<StateMark testId="mark" state={{ kind: "saved-here" }} shown={{ kind: "saved-here" }} truncate={truncate} />);
    expect(screen.getByTestId("mark").textContent).toBe("Saved");
    expect(screen.getByTestId("mark").getAttribute("data-state")).toBe("saved");
  });

  it("fills the mark only for a state the file on disk has settled", () => {
    // "saved" is reported by the engine lease only after the settle that
    // covers the newest local edit, and by the draft hook and Settings only
    // after their write returned. Every other state is still working, held
    // by something, or needs the person, so none of them may read as done.
    // "reloaded" stands in for "saved" only over a saved document that just
    // opened the file as it is on disk.
    const settled = KEYS.filter((key) => SAVE_STATE[key].mark === "settled");
    expect(settled).toEqual(["saved", "reloaded"]);
    // "Saved" at the start of a label claims the edit is durable somewhere.
    // The host and the local engine store are the only other places that
    // can make that claim.
    const claimsSaved = KEYS.filter((key) => SAVE_STATE[key].label.startsWith("Saved"));
    expect(claimsSaved.sort()).toEqual(["pending-share", "saved", "saved-to-host"]);
    for (const key of claimsSaved) {
      if (key !== "saved") expect(SAVE_STATE[key].mark).toBe("working");
    }
  });

  it("settles an access list only when main checked it within its window", () => {
    // Stale is the last list dohc received, and unknown is no list at all:
    // neither may read as done, and unknown must never read as no access.
    expect((Object.keys(ACCESS_STATE) as AccessStateKey[]).filter((key) => ACCESS_STATE[key].mark === "settled")).toEqual(["access-fresh"]);
    // A stale list is settled but old: no check runs for it, so it never
    // takes the ring that says dohc is still working.
    expect(ACCESS_STATE["access-stale"].mark).toBe("dated");
    expect(ACCESS_STATE["access-unknown"].mark).toBe("attention");
    render(<StateMark testId="mark" state="unknown" shown="access-unknown" />);
    const chip = screen.getByTestId("mark");
    expect(chip.getAttribute("data-state")).toBe("unknown");
    expect(chip.textContent).toBe("Unknown");
    expect(chip.getAttribute("title")).toContain("This does not mean that no one has access.");
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

  // jsdom lays nothing out, so this reads the rules that size the header: a
  // narrow window cuts the chip's label, never Try again.
  it("keeps Try again whole in a narrow header and cuts the chip's label instead", () => {
    const { container } = render(
      <ViewActions status={<StateMark testId="mark" truncate state="read-only" shown="read-only-transition" onRetry={() => undefined} />} />,
    );
    const status = container.querySelector<HTMLElement>("[data-view-status]")!;
    // Each column is as narrow as its item allows, so the button's own minimum counts.
    expect(status.className).toContain("auto-cols-[minmax(auto,max-content)]");
    const retry = screen.getByTestId("mark-retry");
    expect(retry.parentElement).toBe(status);
    expect(retry.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    expect(retry.closest(".truncate")).toBeNull();
    // The chip has its own column and keeps room for its mark and an ellipsis.
    const chip = screen.getByTestId("mark");
    expect(chip.parentElement!.parentElement).toBe(status);
    expect(chip.parentElement!.className.split(" ")).toContain("min-w-[28px]");
    expect(chip.querySelector(".truncate")?.textContent).toBe("Read-only");
  });

  // A narrow header cuts the label short. The chip then takes focus and its
  // tooltip carries the whole label and what it means. Its test id and text
  // stay as they were, and its title gives way to the tooltip while cut.
  describe("cut short", () => {
    // jsdom lays nothing out, so the test says how wide the label is.
    function laidOut(scrollWidth: number, clientWidth: number) {
      return {
        scroll: vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth),
        client: vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(clientWidth),
      };
    }
    // ResizeObservers that report a resize when the test says so.
    function resizes() {
      const live = new Set<() => void>();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private readonly callback: () => void) {}
          observe() {
            live.add(this.callback);
          }
          disconnect() {
            live.delete(this.callback);
          }
        },
      );
      return () => act(() => live.forEach((callback) => callback()));
    }
    // What a screen reader hears as the chip's description.
    function description(chip: HTMLElement) {
      const ids = chip.getAttribute("aria-describedby");
      return ids === null ? null : ids.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
    }
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("takes focus, shows the whole label and its explanation, and closes on Escape", async () => {
      laidOut(300, 100);
      render(<StateMark testId="mark" state="pending-share" shown="pending-share" truncate />);
      const chip = screen.getByTestId("mark");
      expect(chip.getAttribute("tabindex")).toBe("0");
      expect(chip.getAttribute("title"), "the browser's own tooltip repeats this one a moment after hover").toBeNull();
      expect(screen.queryByRole("tooltip")).toBeNull();

      await userEvent.setup().tab();
      expect(document.activeElement).toBe(chip);
      expect(screen.getByRole("tooltip").textContent).toBe(
        "Saved locally · Pending shareYour edits are saved on this device. The shared file update is pending.",
      );
      expect(chip.textContent).toBe("Saved locally · Pending share");
      // The chip's words are its label: its description is the explanation alone.
      expect(description(chip)).toBe(SAVE_STATE["pending-share"].title);
      expect(description(chip), "the label is read twice").not.toContain("Saved locally");

      fireEvent.keyDown(chip, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(description(chip)).toBeNull();
    });

    it("sets no description for a label that has no explanation", async () => {
      laidOut(300, 100);
      render(<StateMark testId="mark" state="saved" shown="saved" truncate />);
      await userEvent.setup().tab();
      expect(screen.getByRole("tooltip").textContent).toBe("Saved");
      expect(description(screen.getByTestId("mark"))).toBeNull();
    });

    // Widening the pane, or a share going through, lets the label fit while
    // the chip has focus.
    it("keeps focus when its label stops being cut, and leaves the tab order on blur", async () => {
      const widths = laidOut(300, 100);
      const resize = resizes();
      render(
        <>
          <StateMark testId="mark" state="pending-share" shown="pending-share" truncate />
          <button type="button">next</button>
        </>,
      );
      const chip = screen.getByTestId("mark");
      const user = userEvent.setup();
      await user.tab();
      expect(document.activeElement).toBe(chip);

      widths.scroll.mockReturnValue(100);
      resize();
      expect(document.activeElement, "the tab stop goes and focus falls to the page").toBe(chip);
      expect(chip.getAttribute("tabindex")).toBe("0");
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(chip.getAttribute("title")).toBe(SAVE_STATE["pending-share"].title);

      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "next" }));
      expect(chip.getAttribute("tabindex")).toBeNull();
    });

    // A chip near a pane's left edge would push a right-aligned tooltip off
    // the window, where a pane or panel edge cuts it off.
    it("keeps its tooltip under the chip and inside the window", async () => {
      laidOut(300, 100);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 40, right: 120, top: 10, bottom: 26, width: 80, height: 16, x: 40, y: 10, toJSON: () => ({}) });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(288);
      render(<StateMark testId="mark" state="pending-share" shown="pending-share" truncate />);
      await userEvent.setup().tab();
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.style.left, "right-aligned to the chip, it starts 168px left of the window").toBe("4px");
      expect(tooltip.style.top).toBe("30px");
    });

    // The window shrinks, or the split moves, while the tooltip shows.
    it("follows the chip when the window or the chip changes size while it shows", async () => {
      laidOut(300, 100);
      const resize = resizes();
      let chipBox = { left: 400, right: 480, top: 10, bottom: 26 };
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({
        ...chipBox,
        width: chipBox.right - chipBox.left,
        height: 16,
        x: chipBox.left,
        y: chipBox.top,
        toJSON: () => ({}),
      }));
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
      render(<StateMark testId="mark" state="pending-share" shown="pending-share" truncate />);
      await userEvent.setup().tab();
      const tooltip = screen.getByRole("tooltip");
      expect([tooltip.style.left, tooltip.style.top]).toEqual(["280px", "30px"]);

      chipBox = { left: 300, right: 380, top: 50, bottom: 66 };
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect([tooltip.style.left, tooltip.style.top], "placed once, the tooltip stays where the chip was").toEqual(["180px", "70px"]);

      chipBox = { left: 280, right: 330, top: 36, bottom: 52 };
      resize();
      expect([tooltip.style.left, tooltip.style.top]).toEqual(["130px", "56px"]);
    });

    it("opens on hover and closes when the pointer leaves", () => {
      laidOut(300, 100);
      render(<StateMark testId="mark" state="pending-share" shown="pending-share" truncate />);
      const chip = screen.getByTestId("mark");
      fireEvent.mouseEnter(chip.parentElement!);
      expect(screen.getByRole("tooltip")).toBeTruthy();
      fireEvent.mouseLeave(chip.parentElement!);
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("is not a tab stop, shows no tooltip and keeps its title while its label has room", async () => {
      laidOut(100, 100);
      render(
        <>
          <StateMark testId="mark" state="pending-share" shown="pending-share" truncate />
          <button type="button">next</button>
        </>,
      );
      const chip = screen.getByTestId("mark");
      expect(chip.getAttribute("tabindex")).toBeNull();
      expect(chip.getAttribute("title")).toBe(SAVE_STATE["pending-share"].title);
      await userEvent.setup().tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "next" }));
      fireEvent.mouseEnter(chip.parentElement!);
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
