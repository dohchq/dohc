// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuggestInput } from "./SuggestInput";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FOLDERS = Array.from({ length: 10 }, (_, index) => ({
  value: `Folder ${index}`,
  label: `Folder ${index}`,
}));

function Harness() {
  const [value, setValue] = useState("");
  return (
    <SuggestInput
      label="Folder path"
      listLabel="Folders"
      icon={Folder}
      value={value}
      onChange={setValue}
      suggestions={FOLDERS}
    />
  );
}

// jsdom has no layout: a 100px list over 28px rows, so rows 3 and on start
// out of view.
function layOut() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Number(this.dataset.index ?? 0) * 28;
  });
}

describe("SuggestInput", () => {
  it("scrolls the list to a row the arrow keys choose, and not to a row the pointer is on", async () => {
    layOut();
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show folders" }));
    const list = screen.getByRole("listbox", { name: "Folders" });
    const rows = screen.getAllByRole("option");

    // The click lands on the row under the pointer, so that row stays put.
    fireEvent.mouseMove(rows[3]!, { movementX: 1, movementY: 1 });
    expect(rows[3]!.getAttribute("aria-selected")).toBe("true");
    expect(list.scrollTop).toBe(0);

    await user.keyboard("{ArrowDown}");
    expect(rows[4]!.getAttribute("aria-selected")).toBe("true");
    // Row 4 ends at 140: 140 - 100.
    expect(list.scrollTop).toBe(40);
  });
});
