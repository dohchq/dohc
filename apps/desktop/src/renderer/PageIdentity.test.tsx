// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { Lexer } from "marked";
import { PageIdentity } from "./PageIdentity";
import { NoticeCenter } from "./workbench/NoticeCenter";
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
        <PageIdentity body={"Body text\n"} onChange={() => {}} filenameStem="2026-plan" />,
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

    it("holds Add icon's box out of reach while an editable page opens", () => {
      const view = render(
        <PageIdentity body={"# Body\n"} onChange={() => {}} filenameStem="note" opening />,
      );
      expect((screen.getByTestId("page-title") as HTMLTextAreaElement).readOnly).toBe(true);
      expect(screen.queryByTestId("page-icon-add")).toBeNull();
      expect(screen.queryByRole("button", { name: "Add icon" })).toBeNull();
      const held = view.container.querySelector("button[aria-hidden]") as HTMLButtonElement | null;
      expect(held?.textContent, "`) : opening ? (` → `) : null}`. The opening row lacks Add icon's box and is shorter than the ready row, so the page moves when it opens.").toBe("Add icon");
      expect(held?.classList.contains("invisible")).toBe(true);
      expect(held?.disabled).toBe(true);
      expect(held?.tabIndex).toBe(-1);

      // A read-only page shows no Add icon once open either, so it holds none.
      view.rerender(
        <PageIdentity body={"# Body\n"} onChange={() => {}} filenameStem="note" readOnly opening />,
      );
      expect(view.container.querySelector("button[aria-hidden]")).toBeNull();
    });

    it("moves focus into the picker when it opens", async () => {
      const user = userEvent.setup();
      render(<ControlledPageIdentity initialBody={"# Body\n"} stem="note" />);

      await user.click(screen.getByTestId("page-icon-add"));

      expect(screen.getByRole("dialog", { name: "Choose an icon" }).getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(screen.getByLabelText("Use 📄"));
    });

    // A toast sits above the picker. F6 reaches it and comes back to the
    // emoji it left; Escape in the toast comes back without closing.
    it("moves between the picker and a toast above it on F6", async () => {
      const user = userEvent.setup();
      render(
        <>
          <ControlledPageIdentity initialBody={"# Body\n"} stem="note" />
          <div data-dohc-toasts>
            <button type="button">Try again</button>
          </div>
        </>,
      );
      await user.click(screen.getByTestId("page-icon-add"));
      const emoji = screen.getByLabelText("Use 📄");
      expect(document.activeElement).toBe(emoji);

      await user.keyboard("{F6}");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));
      await user.keyboard("{Escape}");
      expect(screen.getByTestId("page-icon-picker")).toBeTruthy();
      expect(document.activeElement).toBe(emoji);
      await user.keyboard("{F6}");
      await user.keyboard("{F6}");
      expect(document.activeElement).toBe(emoji);
    });

    // The picker is not an Overlay. A toast that goes away while it holds
    // the focus F6 brought from the picker hands it back to the emoji F6
    // left, not to the Notices button behind the page.
    it("returns focus to the picker when the focused toast goes away", async () => {
      vi.stubGlobal("dohcDesktop", {
        platform: "win32",
        getUpdateState: () => new Promise(() => {}),
        onUpdateState: () => () => {},
      });
      const user = userEvent.setup();
      const ignore = () => undefined;
      const page = (toastShown: boolean) => (
        <>
          <ControlledPageIdentity initialBody={"# Body\n"} stem="note" />
          <NoticeCenter
            workspaceId="ws"
            syncStatus={null}
            agentActive={false}
            conflictSummaries={[]}
            onOpenHistory={ignore}
            onOpenSettings={ignore}
            onOpenConflicts={ignore}
            onRefreshShareView={ignore}
            onRebuildEngineStore={ignore}
            workspaceErrors={[{ id: "e", message: "dohc could not reach this server.", details: "", atMs: 1, canRetry: true, seen: !toastShown }]}
            onRetryWorkspaceError={ignore}
            onHideWorkspaceError={ignore}
          />
        </>
      );
      const view = render(page(true));
      await user.click(screen.getByTestId("page-icon-add"));
      const emoji = screen.getByLabelText("Use 📄");
      await user.keyboard("{F6}");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));

      view.rerender(page(false));
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(emoji));
      expect(screen.getByTestId("page-icon-picker")).toBeTruthy();
      vi.unstubAllGlobals();
    });

    // The picker is a dialog without an Overlay. Opening it from the
    // keyboard closes Notices, as a click outside Notices does.
    it("closes Notices when the picker opens from the keyboard", async () => {
      vi.stubGlobal("dohcDesktop", {
        platform: "win32",
        getUpdateState: () => new Promise(() => {}),
        onUpdateState: () => () => {},
      });
      const user = userEvent.setup();
      const ignore = () => undefined;
      render(
        <>
          <ControlledPageIdentity initialBody={"# Body\n"} stem="note" />
          <NoticeCenter
            workspaceId="ws"
            syncStatus={null}
            agentActive={false}
            conflictSummaries={[]}
            onOpenHistory={ignore}
            onOpenSettings={ignore}
            onOpenConflicts={ignore}
            onRefreshShareView={ignore}
            onRebuildEngineStore={ignore}
            workspaceErrors={[{ id: "e", message: "dohc could not reach this server.", details: "", atMs: 1, canRetry: true, seen: true }]}
            onRetryWorkspaceError={ignore}
            onHideWorkspaceError={ignore}
          />
        </>,
      );
      await user.click(screen.getByTestId("notice-center-toggle"));
      expect(screen.getByTestId("notice-center")).toBeTruthy();
      screen.getByTestId("page-icon-add").focus();
      await user.keyboard("{Enter}");

      await waitFor(() => expect(screen.queryByTestId("notice-center")).toBeNull());
      expect(screen.getByTestId("page-icon-picker")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText("Use 📄"));
      vi.unstubAllGlobals();
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

  describe("one title", () => {
    const titleField = () => screen.getByTestId("page-title") as HTMLTextAreaElement;
    // Folded, the field says "Add title" beside "Add icon"; open, it shows
    // the title, or the file name in its place.
    const folded = () => titleField().placeholder === "Add title";

    // A paragraph with a setext underline is read with the editor's lexer,
    // which loads on first use. Once it has, every page answers on its first
    // render.
    beforeAll(async () => {
      render(<PageIdentity body={"Plan\n===\n"} onChange={() => {}} filenameStem="plan" />);
      await waitFor(() => expect(folded()).toBe(true));
      cleanup();
    });

    // A long first block with no blank line: 5,000 lines of one paragraph.
    const longLines = (word: string) => Array.from({ length: 5_000 }, (_, line) => `${word} ${line}`).join("\n");

    it.each([
      ["an H1 first and no title", "# Plan\n\nBody\n", true],
      ["frontmatter, then an H1", "---\nicon: 🚀\n---\n\n# Plan\n", true],
      ["blank lines, then an H1", "\n  \n# Plan\n", true],
      ["a setext H1 first", "Plan\n====\n\nBody\n", true],
      ["a multiline setext H1", "First line\nSecond line\n===\n", true],
      ["an H1 with CRLF line ends", "# Plan\r\n\r\nBody\r\n", true],
      ["a setext H1 with CRLF line ends", "First line\r\nSecond line\r\n===\r\n", true],
      ["an empty H1, # alone", "#\n\nBody\n", true],
      ["#word, a paragraph", "#word\n", false],
      ["a byte order mark before the #, a paragraph to the editor", "﻿# Plan\n", false],
      ["a fence holding ===", "```text\nPlan\n===\n```\n", false],
      ["a fence holding # x", "```\n# x\n```\n\n# Plan\n", false],
      ["a fence with a blank line before # x", "~~~\ncode\n\n# x\n~~~\n", false],
      ["a paragraph a fence interrupts", "Intro\n```\n===\n```\n", false],
      ["a setext H2", "Plan\n---\n", false],
      ["seven #, a paragraph", "####### Plan\n", false],
      ["indented code", "    # Plan\n", false],
      ["a quote", "> # Plan\n", false],
      ["a list item", "- # Plan\n", false],
      ["a list item before ===", "- Plan\n===\n", false],
      ["inline HTML with an underline", "<em>Plan</em>\n===\n", true],
      ["an HTML block holding ===", "<div>\n===\n</div>\n", false],
      ["an underline after 17 lines", `${Array.from({ length: 17 }, (_, line) => `Line ${line}`).join("\n")}\n===\n`, true],
      ["# then a no-break space", "# Plan\n", true],
      ["lone CR line ends", "Plan\r===\r", true],
      ["a title property", "---\ntitle: Plan\n---\n\n# Plan\n", false],
      ["no H1", "Body\n", false],
      ["an H2 first", "## Plan\n", false],
      ["a later H1", "Intro\n\n# Plan\n", false],
    ])("folds the title field for %s: %s", (_, body, expected) => {
      render(<PageIdentity body={body} onChange={() => {}} filenameStem="plan" />);
      expect(folded()).toBe(expected);
    });

    it("decides a clear ATX heading without the lexer, even with no blank line, and as the title is typed", async () => {
      const user = userEvent.setup();
      const lex = vi.spyOn(Lexer, "lex");
      try {
        const body = (edit: string) => `# Plan\n${longLines(edit)}\n`;
        const view = render(<PageIdentity body={body("Body")} onChange={() => {}} filenameStem="plan" />);
        expect(folded()).toBe(true);
        view.rerender(<PageIdentity body={body("Edited")} onChange={() => {}} filenameStem="plan" />);
        expect(folded()).toBe(true);
        view.unmount();

        render(<ControlledPageIdentity initialBody={"# Plan\n\nBody\n"} stem="plan" />);
        await user.click(titleField());
        await user.keyboard("Q3 plan");
        expect(currentMeta().title).toBe("Q3 plan");
        expect(lex).not.toHaveBeenCalled();
      } finally {
        lex.mockRestore();
      }
    });

    it("lexes only an underlined paragraph's lines, once, while the long body after it changes", () => {
      const lex = vi.spyOn(Lexer, "lex");
      try {
        const body = (edit: string) => `First line\nSecond line\n===\n${longLines(edit)}\n`;
        const view = render(<PageIdentity body={body("Body")} onChange={() => {}} filenameStem="plan" />);
        expect(folded()).toBe(true);
        view.rerender(<PageIdentity body={body("Edited")} onChange={() => {}} filenameStem="plan" />);
        expect(folded()).toBe(true);
        expect(lex.mock.calls).toEqual([["First line\nSecond line\n==="]]);

        // A long paragraph with no underline needs no lexer at all.
        view.rerender(<PageIdentity body={`Intro\n${longLines("Body")}\n`} onChange={() => {}} filenameStem="plan" />);
        expect(folded()).toBe(false);
        expect(lex).toHaveBeenCalledTimes(1);
      } finally {
        lex.mockRestore();
      }
    });

    // A blur can come before the composed text reaches onChange. The field
    // keeps its text, as if it still had focus, until the composition ends:
    // a title written from outside reaches it only then. The live document
    // writes that outside title.
    function renderComposing() {
      const doc = markdownToYDoc("# Plan\n");
      render(
        <>
          <PageIdentity ydoc={doc} filenameStem="plan" />
          <button type="button">elsewhere</button>
        </>,
      );
      const field = titleField();
      const elsewhere = screen.getByRole("button", { name: "elsewhere" });
      const writeOutside = (title: string) => act(() => void doc.getMap("frontmatter").set("title", title));
      act(() => field.focus());
      fireEvent.compositionStart(field);
      fireEvent.input(field, { target: { value: "東" }, isComposing: true, inputType: "insertCompositionText" });
      act(() => elsewhere.focus());
      return { doc, field, elsewhere, writeOutside };
    }

    it("keeps the field's text through a blur during composition, until the composition ends", () => {
      const { doc, field, writeOutside } = renderComposing();
      expect(field.value).toBe("東");
      writeOutside("Outside");
      expect(field.value).toBe("東");

      fireEvent.compositionEnd(field);
      expect(field.value).toBe("Outside");
      doc.destroy();
    });

    // Some input methods never send compositionend after a blur. The next
    // move elsewhere ends the composition, so outside titles reach the field
    // and later blurs count again.
    it.each([
      ["a click elsewhere", () => fireEvent.pointerDown(document.body)],
      ["a key elsewhere", () => fireEvent.keyDown(screen.getByRole("button", { name: "elsewhere" }), { key: "a" })],
      ["the window's focus", () => window.dispatchEvent(new Event("focus"))],
    ])("ends a composition that never ends on %s", (_, move) => {
      const { doc, field, elsewhere, writeOutside } = renderComposing();
      writeOutside("Held");
      expect(field.value).toBe("東");

      act(move);
      expect(field.value).toBe("Held");
      act(() => field.focus());
      writeOutside("Focused");
      expect(field.value).toBe("Held");
      act(() => elsewhere.focus());
      expect(field.value).toBe("Focused");
      doc.destroy();
    });

    it("keeps a held composition through a key the input method still owns", () => {
      const { doc, field, elsewhere, writeOutside } = renderComposing();
      fireEvent.keyDown(elsewhere, { key: "Process", isComposing: true });
      fireEvent.keyDown(elsewhere, { key: "Process", keyCode: 229 });
      writeOutside("Outside");
      expect(field.value).toBe("東");

      fireEvent.keyDown(elsewhere, { key: "a" });
      expect(field.value).toBe("Outside");
      doc.destroy();
    });

    it("keeps a held composition through interim text, even empty, until it ends", () => {
      const { doc, field, writeOutside } = renderComposing();
      expect(folded()).toBe(false);
      fireEvent.input(field, { target: { value: "" }, isComposing: true, inputType: "insertCompositionText" });
      // Text opened the title, so empty interim text does not fold it.
      expect(folded()).toBe(false);
      writeOutside("Outside");
      expect(field.value).toBe("");

      fireEvent.compositionEnd(field);
      expect(field.value).toBe("Outside");
      expect(folded()).toBe(false);
      doc.destroy();
    });

    it("keeps an open title open through empty interim text while it has focus, and folds when the composition ends empty", () => {
      render(<PageIdentity body={"# Plan\n"} onChange={() => {}} filenameStem="plan" />);
      const field = titleField();
      act(() => field.focus());
      fireEvent.compositionStart(field);
      fireEvent.input(field, { target: { value: "東" }, isComposing: true, inputType: "insertCompositionText" });
      expect(folded()).toBe(false);
      fireEvent.input(field, { target: { value: "" }, isComposing: true, inputType: "insertCompositionText" });
      expect(folded()).toBe(false);

      fireEvent.compositionEnd(field);
      expect(document.activeElement).toBe(field);
      expect(folded()).toBe(true);
    });

    it("leaves a focused empty title folded when a title is written elsewhere, and opens it on blur", () => {
      const doc = markdownToYDoc("# Plan\n");
      render(
        <>
          <PageIdentity ydoc={doc} filenameStem="plan" />
          <button type="button">elsewhere</button>
        </>,
      );
      const field = titleField();
      act(() => field.focus());
      act(() => void doc.getMap("frontmatter").set("title", "Outside"));
      expect(folded()).toBe(true);
      expect(field.value).toBe("");

      act(() => screen.getByRole("button", { name: "elsewhere" }).focus());
      expect(folded()).toBe(false);
      expect(field.value).toBe("Outside");
      doc.destroy();
    });

    it("keeps text a composition commits after a blur with no compositionend, and counts later blurs", () => {
      const { doc, field, elsewhere, writeOutside } = renderComposing();
      fireEvent.change(field, { target: { value: "東京" } });
      expect(field.value).toBe("東京");
      expect(doc.getMap("frontmatter").get("title")).toBe("東京");

      writeOutside("Outside");
      expect(field.value).toBe("Outside");
      act(() => field.focus());
      fireEvent.change(field, { target: { value: "" } });
      act(() => elsewhere.focus());
      expect(folded()).toBe(true);
      expect(doc.getMap("frontmatter").get("title")).toBeUndefined();
      doc.destroy();
    });

    it("folds a read-only title too, keeping it mounted and read-only", () => {
      render(<PageIdentity body={"# Plan\n"} onChange={() => {}} filenameStem="plan" readOnly />);
      expect(folded()).toBe(true);
      expect(titleField().readOnly).toBe(true);
      expect(titleField().className).toContain("invisible");
    });

    // Focus and blur never change the layout below the title: the field folds
    // while it holds no text, so only typing opens or folds it.
    it("stays folded through focus and blur, opens on the first character, and folds when cleared", async () => {
      const user = userEvent.setup();
      render(
        <>
          <ControlledPageIdentity initialBody={"# Plan\n"} stem="plan" />
          <button type="button">elsewhere</button>
        </>,
      );
      const field = titleField();
      expect(folded()).toBe(true);

      act(() => field.focus());
      expect(document.activeElement).toBe(field);
      expect(folded()).toBe(true);
      expect(field.className).toContain("focus:opacity-100");
      await user.click(screen.getByRole("button", { name: "elsewhere" }));
      expect(folded()).toBe(true);

      await user.click(field);
      await user.keyboard("Q");
      expect(titleField()).toBe(field);
      expect(folded()).toBe(false);
      expect(field.placeholder).toBe("plan");
      await user.keyboard("3");
      expect(field.selectionStart).toBe(2);
      expect(currentMeta().title).toBe("Q3");

      await user.keyboard("{Backspace}{Backspace}");
      expect(document.activeElement).toBe(field);
      expect(folded()).toBe(true);
      expect(currentMeta().title).toBeUndefined();

      await user.keyboard("Q3");
      await user.click(screen.getByRole("button", { name: "elsewhere" }));
      expect(folded()).toBe(false);
      expect(field.value).toBe("Q3");
    });

    // jsdom draws nothing, so these read the classes that draw it: "Add icon"
    // shows whenever focus is in the header, not only on hover, and the
    // folded field's square corners keep its focus underline straight.
    it("shows Add icon beside a focused folded title, and keeps that title's underline straight", () => {
      render(<PageIdentity body={"# Plan\n"} onChange={() => {}} filenameStem="plan" />);
      const header = screen.getByTestId("page-identity");
      const addIcon = screen.getByTestId("page-icon-add");
      expect(header.className.split(" ")).toContain("group");
      expect(addIcon.className).toContain("group-hover:opacity-100");
      expect(addIcon.className).toContain("group-focus-within:opacity-100");
      expect(header.contains(titleField())).toBe(true);
      expect(folded()).toBe(true);
      expect(titleField().className).not.toMatch(/\brounded/);
    });

    it("keeps the Tab order icon, then title, without opening the empty title", async () => {
      const user = userEvent.setup();
      render(<PageIdentity body={"# Plan\n"} onChange={() => {}} filenameStem="plan" />);

      await user.tab();
      expect(document.activeElement).toBe(screen.getByTestId("page-icon-add"));
      await user.tab();
      expect(document.activeElement).toBe(titleField());
      expect(folded()).toBe(true);
    });

    describe("in a live document", () => {
      function insertParagraph(doc: Y.Doc, index: number) {
        const block = new Y.XmlElement("paragraph");
        block.insert(0, [new Y.XmlText("Text")]);
        doc.getXmlFragment("body").insert(index, [block]);
      }

      it("follows the first block and renders only when the answer changes", () => {
        // The editor's own encoding, which keeps a heading's level as a number.
        const doc = markdownToYDoc("# Plan\n\nBody\n");
        const heading = doc.getXmlFragment("body").get(0) as Y.XmlElement;
        let renders = 0;
        render(
          <Profiler id="identity" onRender={() => (renders += 1)}>
            <PageIdentity ydoc={doc} filenameStem="plan" />
          </Profiler>,
        );
        expect(folded()).toBe(true);
        const before = renders;

        // Typing in the H1, and a block after it, leave the answer alone.
        act(() => (heading.get(0) as Y.XmlText).insert(4, " more"));
        act(() => insertParagraph(doc, 1));
        expect(renders).toBe(before);

        // An H2, then a paragraph above the H1, unfold it.
        act(() => heading.setAttribute("level", "2"));
        expect(folded()).toBe(false);
        act(() => heading.setAttribute("level", "1"));
        expect(folded()).toBe(true);
        act(() => insertParagraph(doc, 0));
        expect(folded()).toBe(false);
      });

      it("shows a title property instead of folding", () => {
        const doc = markdownToYDoc("---\ntitle: Plan\n---\n\n# Plan\n");
        render(<PageIdentity ydoc={doc} filenameStem="plan" />);
        expect(folded()).toBe(false);
        expect(titleField().value).toBe("Plan");
      });
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
