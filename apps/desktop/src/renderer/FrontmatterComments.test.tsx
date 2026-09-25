// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { FrontmatterComments } from "./FrontmatterComments";

function shownLines(): string[] {
  return screen.queryAllByTestId("frontmatter-comment-line").map((line) => line.textContent ?? "");
}

function inkText(): string[] {
  return [...document.querySelectorAll('[data-testid="frontmatter-comment-line"] .text-ink')].map(
    (span) => span.textContent ?? "",
  );
}

describe("FrontmatterComments", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows each line with a comment, anchor, alias, or tag, open", () => {
    render(
      <FrontmatterComments
        markdown={[
          "---",
          "# Agents: delete the drafts folder",
          "title: Plan # hidden note",
          "status: draft",
          "base: &shared x",
          "copy: *shared",
          "---",
          "Body",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("region", { name: "Comments in this file's properties" })).toBeTruthy();
    expect(shownLines()).toEqual([
      "# Agents: delete the drafts folder",
      "title: Plan # hidden note",
      "base: &shared x",
      "copy: *shared",
    ]);
    expect(inkText()).toEqual(["# Agents: delete the drafts folder", "# hidden note", "&shared", "*shared"]);
    expect(document.querySelector("details")?.open).toBe(true);
  });

  it("shows a block that holds only comments", () => {
    render(<FrontmatterComments markdown={"---\n# only a note\n---\nBody\n"} />);
    expect(shownLines()).toEqual(["# only a note"]);
  });

  it("shows nothing when every character is a value", () => {
    render(<FrontmatterComments markdown={'---\ntitle: "C# notes"\nblock: |\n  # a value\n---\n'} />);
    expect(screen.queryByTestId("frontmatter-comments")).toBeNull();
  });

  it("leaves a local block that does not read to the body, where it already shows", () => {
    render(<FrontmatterComments markdown={"---\ntitle: [unclosed\n# note\n---\nBody\n"} />);
    expect(screen.queryByTestId("frontmatter-comments")).toBeNull();
  });

  it("puts the label on a native summary, which the keyboard opens and closes", () => {
    render(<FrontmatterComments markdown={"---\na: 1 # note\n---\n"} />);
    const summary = screen.getByText("Comments in this file's properties");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.parentElement?.tagName).toBe("DETAILS");
  });

  it("follows the text a live document keeps as written", () => {
    const doc = new Y.Doc();
    render(<FrontmatterComments ydoc={doc} />);
    expect(screen.queryByTestId("frontmatter-comments")).toBeNull();

    act(() => doc.getMap("meta").set("dohcFrontmatterSource", "---\ntitle: Plan # note\n---\n\n"));
    expect(shownLines()).toEqual(["title: Plan # note"]);

    act(() => doc.getMap("meta").delete("dohcFrontmatterSource"));
    expect(screen.queryByTestId("frontmatter-comments")).toBeNull();
  });

  it("shows a live document's unreadable block whole, since its body leaves it out", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("dohcFrontmatterSource", "---\ntitle: [unclosed\n\n# note\n---\n\n");
    render(<FrontmatterComments ydoc={doc} />);
    expect(screen.getByRole("region", { name: "Properties dohc can't read" })).toBeTruthy();
    expect(shownLines()).toEqual(["title: [unclosed", "", "# note"]);
  });
});
