// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { TriangleAlert } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_ART, type EmptyArtKind } from "../workbench/EmptyArt";
import { EmptyState, SecondaryButton } from "./controls";

afterEach(cleanup);

describe("EmptyState", () => {
  it("shows a hidden picture, one line, and the action under it", () => {
    const { container } = render(
      <EmptyState data-testid="empty" picture={EMPTY_ART.files} title="This workspace has no files yet.">
        <SecondaryButton size="compact">New file</SecondaryButton>
      </EmptyState>,
    );
    const empty = screen.getByTestId("empty");
    const [picture, line, actions] = Array.from(empty.children);
    expect(picture!.getAttribute("aria-hidden")).toBe("true");
    expect(line!.textContent).toBe("This workspace has no files yet.");
    expect(line!.className.split(" ")).toEqual(expect.arrayContaining(["mt-3", "text-[13px]", "text-muted"]));
    expect(actions!.className.split(" ")).toContain("mt-4");
    expect(screen.getByRole("button", { name: "New file" }).parentElement).toBe(actions);
    expect(empty.textContent).toBe("This workspace has no files yet.New file");
    expect(container.querySelector("svg")).toBeNull();
  });

  it.each(Object.keys(EMPTY_ART) as EmptyArtKind[])("draws the %s picture with no words of its own", (kind) => {
    render(<EmptyState data-testid="empty" picture={EMPTY_ART[kind]} title="Nothing yet." />);
    const empty = screen.getByTestId("empty");
    expect(empty.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(empty.firstElementChild!.childElementCount).toBeGreaterThan(0);
    expect(empty.textContent).toBe("Nothing yet.");
  });

  it("keeps a failure's glyph, tone and Try again, with no picture", () => {
    render(
      <EmptyState data-testid="failed" icon={TriangleAlert} tone="danger" title="Could not load Chats for this file.">
        <SecondaryButton>Try again</SecondaryButton>
      </EmptyState>,
    );
    const failed = screen.getByTestId("failed");
    const glyph = failed.querySelector("svg")!;
    expect(glyph.classList.contains("lucide-triangle-alert")).toBe(true);
    expect(glyph.classList.contains("text-danger")).toBe(true);
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(failed.querySelectorAll("[aria-hidden]")).toHaveLength(1);
    expect(failed.textContent).toBe("Could not load Chats for this file.Try again");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the mark when it has neither a picture nor a glyph", () => {
    render(<EmptyState data-testid="start" title="Select a file" />);
    const start = screen.getByTestId("start");
    expect(start.firstElementChild!.tagName.toLowerCase()).toBe("svg");
    expect(start.textContent).toBe("Select a file");
  });

  it("takes no hint, and no glyph or tone beside a picture", () => {
    // @ts-expect-error The one line says what is missing; there is no second line.
    render(<EmptyState title="No changes yet" hint="Edits appear here." />);
    // @ts-expect-error A picture never shares the state with a glyph.
    render(<EmptyState picture={EMPTY_ART.history} icon={TriangleAlert} title="No changes yet" />);
    // @ts-expect-error A failure keeps its glyph; a picture has no tone.
    render(<EmptyState picture={EMPTY_ART.history} tone="danger" title="No changes yet" />);
  });
});
