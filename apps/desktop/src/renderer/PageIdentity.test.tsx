// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageIdentity } from "./PageIdentity";
import { parseFrontmatter } from "./markdown/frontmatter";

function ControlledPageIdentity(props: { initialBody: string; stem: string }) {
  const [body, setBody] = useState(props.initialBody);
  return (
    <>
      <PageIdentity body={body} onChange={setBody} filenameStem={props.stem} />
      <output data-testid="current-body">{body}</output>
    </>
  );
}

function currentMeta(): Record<string, unknown> {
  return parseFrontmatter(screen.getByTestId("current-body").textContent ?? "").meta;
}

describe("PageIdentity", () => {
  afterEach(() => {
    cleanup();
  });

  describe("local markdown mode", () => {
    it("shows the frontmatter title", () => {
      render(
        <PageIdentity
          body={"---\nid: n1\ntitle: Weekly Plan\n---\n\n# Body\n"}
          onChange={() => {}}
          filenameStem="weekly"
        />,
      );
      expect((screen.getByTestId("page-title") as HTMLTextAreaElement).value).toBe(
        "Weekly Plan",
      );
    });

    it("falls back to the filename stem as an empty-state placeholder", () => {
      render(
        <PageIdentity body={"# Body\n"} onChange={() => {}} filenameStem="2026-plan" />,
      );
      const input = screen.getByTestId("page-title") as HTMLTextAreaElement;
      expect(input.value).toBe("");
      expect(input.placeholder).toBe("2026-plan");
    });

    it("writes the title into frontmatter through onChange", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.type(screen.getByTestId("page-title"), "Roadmap");

      expect(currentMeta().title).toBe("Roadmap");
      expect(screen.getByTestId("current-body").textContent).toContain("# Body\n");
    });

    it("removes the title key when the field is cleared", async () => {
      const user = userEvent.setup();
      render(
        <ControlledPageIdentity
          initialBody={"---\ntitle: Draft\n---\n\n# Body\n"}
          stem="note"
        />,
      );

      await user.clear(screen.getByTestId("page-title"));

      // Dropping the last frontmatter key strips the block and the blank
      // line that separated it from the body.
      expect(screen.getByTestId("current-body").textContent).toBe("# Body\n");
    });

    it("sets an icon from the picker grid and orders it after the title", async () => {
      const user = userEvent.setup();
      render(
        <ControlledPageIdentity
          initialBody={"---\ntitle: Plan\n---\n\n# Body\n"}
          stem="note"
        />,
      );

      await user.click(screen.getByTestId("page-icon-add"));
      await user.click(screen.getByLabelText("Use 🚀"));

      const body = screen.getByTestId("current-body").textContent ?? "";
      expect(parseFrontmatter(body).meta.icon).toBe("🚀");
      // title stays ahead of icon (id, title, icon priority order).
      expect(body.indexOf("title:")).toBeLessThan(body.indexOf("icon:"));
    });

    it("accepts a pasted emoji from the free-text field", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));
      await user.type(screen.getByTestId("page-icon-input"), "🌵{Enter}");

      expect(currentMeta().icon).toBe("🌵");
    });

    it("removes an existing icon", async () => {
      const user = userEvent.setup();
      render(
        <ControlledPageIdentity
          initialBody={"---\ntitle: Plan\nicon: 🚀\n---\n\n# Body\n"}
          stem="note"
        />,
      );

      await user.click(screen.getByTestId("page-icon"));
      await user.click(screen.getByTestId("page-icon-remove"));

      const meta = currentMeta();
      expect(meta.icon).toBeUndefined();
      expect(meta.title).toBe("Plan");
    });

    it("does not offer editing affordances when read-only", () => {
      render(
        <PageIdentity
          body={"---\ntitle: Locked\n---\n\n# Body\n"}
          onChange={() => {}}
          filenameStem="note"
          readOnly
        />,
      );
      expect((screen.getByTestId("page-title") as HTMLTextAreaElement).readOnly).toBe(true);
      expect(screen.queryByTestId("page-icon-add")).toBeNull();
    });

    it("moves focus into the picker when it opens", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));

      expect(document.activeElement).toBe(screen.getByLabelText("Use 📄"));
    });

    it("returns focus to the trigger button when Escape closes the picker", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      const trigger = screen.getByTestId("page-icon-add");
      await user.click(trigger);
      await user.keyboard("{Escape}");

      expect(screen.queryByTestId("page-icon-picker")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it("returns focus to the (now icon) trigger button after choosing an emoji", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));
      await user.click(screen.getByLabelText("Use 🚀"));

      expect(screen.queryByTestId("page-icon-picker")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("page-icon"));
    });

    it("traps Tab focus within the open picker", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));

      const picker = screen.getByTestId("page-icon-picker");
      const focusable = picker.querySelectorAll("button, input");
      const last = focusable[focusable.length - 1] as HTMLElement;
      last.focus();

      await user.tab();

      expect(document.activeElement).toBe(focusable[0]);
    });

    it("moves focus into the body on Enter", async () => {
      const user = userEvent.setup();
      const onEnterBody = vi.fn();
      render(
        <PageIdentity
          body={"# Body\n"}
          onChange={() => {}}
          filenameStem="note"
          onEnterBody={onEnterBody}
        />,
      );

      const input = screen.getByTestId("page-title");
      input.focus();
      await user.keyboard("{Enter}");

      expect(onEnterBody).toHaveBeenCalledTimes(1);
    });

    it("keeps Enter for an input method while it composes, and Shift+ArrowDown for selecting", () => {
      const onEnterBody = vi.fn();
      render(
        <PageIdentity body={"# Body\n"} onChange={() => {}} filenameStem="note" onEnterBody={onEnterBody} />,
      );
      const title = screen.getByTestId("page-title");

      fireEvent.keyDown(title, { key: "Enter", isComposing: true });
      fireEvent.keyDown(title, { key: "ArrowDown", shiftKey: true });

      expect(onEnterBody).not.toHaveBeenCalled();
    });

    it("turns pasted line breaks into spaces and keeps the caret after the pasted text", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <PageIdentity body={"---\ntitle: Trip plan\n---\n# Body\n"} onChange={onChange} filenameStem="note" />,
      );
      const title = screen.getByTestId("page-title") as HTMLTextAreaElement;
      title.focus();
      title.setSelectionRange(5, 5);

      await user.paste("to\nTokyo ");

      expect(title.value).toBe("Trip to Tokyo plan");
      expect(title.selectionStart).toBe("Trip to Tokyo ".length);
      expect(onChange.mock.lastCall?.[0]).toContain("title: Trip to Tokyo plan");
    });

    it("keeps focus in the title while an IME picks a candidate", () => {
      const onEnterBody = vi.fn();
      render(
        <PageIdentity
          body={"# Body\n"}
          onChange={() => {}}
          filenameStem="note"
          onEnterBody={onEnterBody}
        />,
      );

      const input = screen.getByTestId("page-title");
      fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      expect(onEnterBody).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onEnterBody).toHaveBeenCalledTimes(1);
    });
  });

  describe("collab (Y.Map) mode", () => {
    it("shows and writes the title through the frontmatter Y.Map", async () => {
      const user = userEvent.setup();
      const doc = new Y.Doc();
      const frontmatter = doc.getMap("frontmatter");
      frontmatter.set("id", "n1");
      frontmatter.set("title", "Shared");

      render(<PageIdentity ydoc={doc} filenameStem="note" />);
      expect((screen.getByTestId("page-title") as HTMLTextAreaElement).value).toBe("Shared");

      await user.type(screen.getByTestId("page-title"), "!");

      expect(frontmatter.get("title")).toBe("Shared!");
      expect(frontmatter.get("id")).toBe("n1");
    });

    it("sets and removes the icon on the Y.Map without touching other keys", async () => {
      const user = userEvent.setup();
      const doc = new Y.Doc();
      const frontmatter = doc.getMap("frontmatter");
      frontmatter.set("title", "Shared");

      render(<PageIdentity ydoc={doc} filenameStem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));
      await user.click(screen.getByLabelText("Use ⭐"));
      expect(frontmatter.get("icon")).toBe("⭐");

      await user.click(screen.getByTestId("page-icon"));
      await user.click(screen.getByTestId("page-icon-remove"));
      expect(frontmatter.get("icon")).toBeUndefined();
      expect(frontmatter.get("title")).toBe("Shared");
    });
  });
});
