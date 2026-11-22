// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageView } from "./ImageView";

afterEach(cleanup);

describe("ImageView", () => {
  it("renders zoom and backdrop controls, toggles Fit and 100%, and switches backdrops", () => {
    render(<ImageView url="blob:test-image" path="assets/icon.png" />);
    const img = screen.getByRole("img", { name: "icon.png" });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 16 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 16 });
    fireEvent.load(img);

    expect(screen.getByText(/icon\.png · 16×16/)).toBeTruthy();
    expect(img.style.minWidth).toBe("");
    expect(img.className).not.toContain("max-h-[60vh]");

    const toggle = screen.getByTestId("image-zoom-toggle");
    expect(toggle.textContent).toBe("Fit");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("100%");
    expect(img.style.width).toBe("16px");
    expect(img.style.height).toBe("16px");

    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(toggle.textContent).toBe("150%");
    fireEvent.click(screen.getByTestId("image-zoom-out"));
    expect(toggle.textContent).toBe("100%");

    fireEvent.click(img);
    expect(toggle.textContent).toBe("Fit");

    const frame = screen.getByTestId("image-backdrop-frame");
    expect(frame.dataset.backdrop).toBe("checker");
    fireEvent.click(screen.getByRole("radio", { name: "Paper" }));
    expect(frame.dataset.backdrop).toBe("paper");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(frame.dataset.backdrop).toBe("dark");
  });

  it("shows a danger EmptyState when the image fails to load", () => {
    render(<ImageView url="blob:broken" path="assets/broken.png" />);
    fireEvent.error(screen.getByRole("img", { name: "broken.png" }));
    expect(screen.getByText("dohc could not load this image.")).toBeTruthy();
    expect(screen.queryByTestId("image-zoom-toggle")).toBeNull();
  });
});
