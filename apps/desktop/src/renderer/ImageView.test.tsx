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

  it("scopes plain zoom keys to the focused viewport without hijacking Ctrl/Cmd app zoom", () => {
    render(<ImageView url="blob:test-image" path="assets/icon.png" />);
    const img = screen.getByRole("img", { name: "icon.png" });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 100 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 100 });
    img.getBoundingClientRect = () => ({
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.load(img);

    const toggle = screen.getByTestId("image-zoom-toggle");
    const viewport = screen.getByRole("region", { name: "Image preview: icon.png" });
    expect(viewport.className).not.toContain("items-center");
    expect(viewport.className).not.toContain("outline-none");
    expect(viewport.className).toContain("focus-visible:-outline-offset-2");
    expect(screen.getByTestId("image-backdrop-frame").className).toContain("m-auto");

    // Ctrl+= must not be intercepted by ImageView so Electron app zoom remains intact.
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    fireEvent.keyDown(viewport, { key: "=", ctrlKey: true });
    expect(toggle.textContent).toBe("Fit");

    // Plain + / - / 0 on the focused image viewport or zoom buttons steps zoom cleanly.
    fireEvent.keyDown(viewport, { key: "+" });
    expect(toggle.textContent).toBe("150%");
    fireEvent.keyDown(screen.getByTestId("image-zoom-in"), { key: "-" });
    expect(toggle.textContent).toBe("100%");
    fireEvent.keyDown(screen.getByTestId("image-zoom-out"), { key: "0" });
    expect(toggle.textContent).toBe("Fit");
  });

  it("steps from actual fitted scale on wide and tall images instead of magnifying on Zoom Out", () => {
    const first = render(<ImageView url="blob:huge" path="assets/huge.png" />);
    const img = screen.getByRole("img", { name: "huge.png" });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 2000 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 1000 });
    // Simulated fitted width is 400px => 20% actual scale (below the 25% minimum zoom preset).
    img.getBoundingClientRect = () => ({
      width: 400,
      height: 200,
      top: 0,
      left: 0,
      right: 400,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.load(img);

    const zoomOut = screen.getByTestId("image-zoom-out") as HTMLButtonElement;
    const zoomIn = screen.getByTestId("image-zoom-in") as HTMLButtonElement;
    const toggle = screen.getByTestId("image-zoom-toggle");
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);

    fireEvent.click(zoomIn);
    expect(toggle.textContent).toBe("25%");
    first.unmount();

    // Tall image (400×4000) fitted into a 400×379 box: actual scale is 379/4000 (~9.5%), not 400/400 (100%).
    render(<ImageView url="blob:tall" path="assets/tall.png" />);
    const tallImg = screen.getByRole("img", { name: "tall.png" });
    Object.defineProperty(tallImg, "naturalWidth", { configurable: true, value: 400 });
    Object.defineProperty(tallImg, "naturalHeight", { configurable: true, value: 4000 });
    tallImg.getBoundingClientRect = () => ({
      width: 400,
      height: 379,
      top: 0,
      left: 0,
      right: 400,
      bottom: 379,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.load(tallImg);

    expect((screen.getByTestId("image-zoom-out") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-toggle").textContent).toBe("25%");
    expect(tallImg.className).toContain("max-w-none");
  });

  it("keeps focus inside the viewer when Zoom Out or Zoom In hits its limit so 0 still resets to Fit", () => {
    render(<ImageView url="blob:limit" path="assets/limit.png" />);
    const img = screen.getByRole("img", { name: "limit.png" });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1280 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 720 });
    img.getBoundingClientRect = () => ({
      width: 400,
      height: 225,
      top: 0,
      left: 0,
      right: 400,
      bottom: 225,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    fireEvent.load(img);

    const viewport = screen.getByRole("region", { name: "Image preview: limit.png" });
    const zoomOut = screen.getByTestId("image-zoom-out") as HTMLButtonElement;
    zoomOut.focus();
    fireEvent.click(zoomOut);
    expect(screen.getByTestId("image-zoom-toggle").textContent).toBe("25%");
    expect(zoomOut.disabled).toBe(true);
    expect(document.activeElement).toBe(viewport);

    fireEvent.keyDown(document.activeElement!, { key: "0" });
    expect(screen.getByTestId("image-zoom-toggle").textContent).toBe("Fit");
  });
});
