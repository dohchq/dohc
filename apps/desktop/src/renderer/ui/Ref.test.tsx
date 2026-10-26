// @vitest-environment jsdom
import { FILE_KIND_RECORDS, fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ref } from "./Ref";

afterEach(cleanup);

describe("Ref", () => {
  it("names a file by its title, else by its basename with the extension", () => {
    const { rerender } = render(<Ref path="notes/plan.md" title="Launch plan" testId="ref" />);
    expect(screen.getByTestId("ref").textContent).toContain("Launch plan");
    rerender(<Ref path="data/funnel.csv" testId="ref" />);
    expect(screen.getByTestId("ref").textContent).toBe("funnel.csvdata/funnel.csv");
  });

  it("shows the folder only when asked, in the metadata voice", () => {
    const { rerender } = render(<Ref path="research/notes/plan.md" testId="ref" />);
    expect(screen.queryByText("research/notes")).toBeNull();
    rerender(<Ref path="research/notes/plan.md" folder testId="ref" />);
    // A path isn't code, so the folder is in the interface font.
    expect(screen.getByText("research/notes").className).toContain("text-subtle");
    expect(screen.getByText("research/notes").className).not.toContain("font-mono");
    // The name and folder spell the path, so nothing is added for a reader.
    expect(screen.getByTestId("ref").textContent).toBe("plan.mdresearch/notes");
  });

  it("keeps the full path for assistive technology when the name hides it", () => {
    render(<Ref path="notes/alpha.md" title="Alpha" folder testId="ref" />);
    const chip = screen.getByTestId("ref");
    const spoken = chip.querySelector(".sr-only");
    expect(spoken?.textContent).toBe("notes/alpha.md");
    expect(screen.getByText("notes").getAttribute("aria-hidden")).toBe("true");
    expect(chip.getAttribute("title")).toBe("notes/alpha.md");
  });

  it("keeps the full path after a title that repeats the basename, in a folder or at the root", () => {
    const { rerender } = render(<Ref path="notes/alpha.md" title="alpha.md" folder testId="ref" />);
    expect(screen.getByTestId("ref").querySelector(".sr-only")?.textContent).toBe("notes/alpha.md");
    rerender(<Ref path="alpha.md" title="alpha.md" testId="ref" />);
    expect(screen.getByTestId("ref").querySelector(".sr-only")?.textContent).toBe("alpha.md");
  });

  it("draws each kind's registry glyph", () => {
    for (const kind of Object.values(FILE_KIND_RECORDS)) {
      const { container, unmount } = render(<Ref path="any.bin" kind={kind} />);
      expect(container.querySelector("svg")?.classList.contains(`lucide-${kind.glyphId}`)).toBe(true);
      unmount();
    }
    const { container } = render(<Ref path="budget.csv" />);
    expect(container.querySelector("svg")?.classList.contains(`lucide-${fileKindForPath("budget.csv").glyphId}`)).toBe(true);
  });

  it("dashes the border of a target that does not resolve", () => {
    render(<Ref path="notes/gone.md" missing testId="ref" />);
    const chip = screen.getByTestId("ref");
    expect(chip.className).toContain("border-dashed");
    expect(chip.getAttribute("data-missing")).toBe("true");
  });

  it("opens from the pointer, Enter and Space, named for the full path", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Ref path="docs/a-very-long-file-name-that-truncates.md" heading="scope" onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: "Open docs/a-very-long-file-name-that-truncates.md at #scope" });
    expect(chip.getAttribute("title")).toBe("docs/a-very-long-file-name-that-truncates.md#scope");
    await user.click(chip);
    chip.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("is a plain span without onOpen, so a row button can hold it", () => {
    render(
      <button type="button" aria-label="Open diff for notes/plan.md">
        <Ref path="notes/plan.md" folder testId="ref" />
      </button>,
    );
    const chip = screen.getByTestId("ref");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("role")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(chip.querySelector("button")).toBeNull();
  });
});
