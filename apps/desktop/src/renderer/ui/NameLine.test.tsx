// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NameLine } from "./NameLine";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NameLine", () => {
  it("keeps a short extension apart from the part that cuts", () => {
    const { container } = render(<NameLine name="notes/product-plan.md" />);
    const [head, extension] = container.firstElementChild!.children;
    expect(head!.textContent).toBe("notes/product-plan");
    expect(head!.className).toContain("truncate");
    expect(extension!.textContent).toBe(".md");
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });

  it("draws a cut name with its ellipsis against the extension, with no gap", () => {
    // Every letter is 7px wide, and the name's head has 35px of its 84px.
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return { font: "", letterSpacing: "", measureText: (text: string) => ({ width: Array.from(text).length * 7 }) };
      }
    });
    vi.stubGlobal("ResizeObserver", class {
      changed: () => void;
      constructor(changed: () => void) {
        this.changed = changed;
      }
      observe() {
        this.changed();
      }
      disconnect() {}
    });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(84);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(35);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 35 } as DOMRect);

    const { container } = render(<NameLine name="product-plan.md" />);
    const [head, extension] = container.firstElementChild!.children;
    expect(container.querySelector("[aria-hidden]")!.textContent).toBe("prod….md");
    // The whole name still takes the room, and draws nothing under the cut one.
    expect(head!.textContent).toBe("product-plan");
    expect(head!.className).toContain("text-transparent");
    expect(extension!.className).toContain("text-transparent");
  });
});
