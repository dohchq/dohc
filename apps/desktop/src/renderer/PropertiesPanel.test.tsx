// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { setFrontmatterValue } from "@dohc/ydoc-projection/frontmatter";
import { PropertiesPanel } from "./PropertiesPanel";

function ControlledPropertiesPanel(props: { initialBody: string }) {
  const [body, setBody] = useState(props.initialBody);
  return (
    <>
      <PropertiesPanel body={body} onChange={setBody} />
      <output data-testid="current-body">{body}</output>
    </>
  );
}

describe("PropertiesPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([false, true])("refuses removing an anchor before mutation (shared: %s)", async (shared) => {
    const user = userEvent.setup();
    const initialBody = "---\na: &v .nan\nb: {nested: [*v]}\n---\n\nBody";
    const doc = markdownToYDoc(initialBody);
    const before = Y.encodeStateAsUpdate(doc);
    const onChange = vi.fn();
    try {
      render(shared ? <PropertiesPanel ydoc={doc} /> : <PropertiesPanel body={initialBody} onChange={onChange} />);
      await user.click(screen.getByLabelText("Remove property a"));
      expect(screen.getByTestId("properties-locked").getAttribute("title")).toContain("without rewriting the others");
      expect(onChange).not.toHaveBeenCalled();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(yDocToMarkdown(doc)).toBe(initialBody);
    } finally { doc.destroy(); }
  });

  it("preserves system fields while editing user properties", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        body={"---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n"}
        onChange={onChange}
      />,
    );

    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(onChange).toHaveBeenLastCalledWith(
      "---\nid: note-1\ntitle: Plan\nstatus: ready\n---\n\n# Plan\n",
    );
  });

  it("preserves untouched structured YAML values while editing another property", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        body={
          [
            "---",
            "id: note-1",
            "title: Plan",
            "tags:",
            "  - a",
            "  - b",
            "settings:",
            "  pinned: true",
            "status: draft",
            "---",
            "",
            "# Plan",
            "",
          ].join("\n")
        }
        onChange={onChange}
      />,
    );

    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(onChange).toHaveBeenLastCalledWith(
      [
        "---",
        "id: note-1",
        "title: Plan",
        "tags:",
        "  - a",
        "  - b",
        "settings:",
        "  pinned: true",
        "status: ready",
        "---",
        "",
        "# Plan",
        "",
      ].join("\n"),
    );
  });

  it("preserves untouched structured YAML values while renaming a property", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        body={
          [
            "---",
            "id: note-1",
            "title: Plan",
            "tags:",
            "  - a",
            "  - b",
            "status: draft",
            "---",
            "",
            "# Plan",
            "",
          ].join("\n")
        }
        onChange={onChange}
      />,
    );

    await user.clear(screen.getByDisplayValue("tags"));
    await user.type(screen.getByLabelText("Property 1 name"), "labels");

    expect(onChange).toHaveBeenLastCalledWith(
      [
        "---",
        "id: note-1",
        "title: Plan",
        "labels:",
        "  - a",
        "  - b",
        "status: draft",
        "---",
        "",
        "# Plan",
        "",
      ].join("\n"),
    );
  });

  it("keeps a renamed property's comments and value text in a local file", async () => {
    const user = userEvent.setup();
    render(<ControlledPropertiesPanel initialBody={"---\n# Monthly\nbudget:  100 # euros\nwifi: x\n---\n\nBody"} />);

    await user.clear(screen.getByDisplayValue("budget"));
    await user.type(screen.getByLabelText("Property 1 name"), "cost");

    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\n# Monthly\ncost:  100 # euros\nwifi: x\n---\n\nBody",
    );
  });

  it("marks each property an automation sets, and names the automations to keyboard and screen reader users", async () => {
    const user = userEvent.setup();
    render(
      <PropertiesPanel
        body={"---\nid: rec-1\nStatus: Done\nFinished on: 2026-09-25\n---\n"}
        onChange={vi.fn()}
        fieldMarks={new Map([["Finished on", ["Stamp the finish date", "Tidy"]]])}
      />,
    );
    const marks = screen.getAllByTestId("automation-field-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.closest('[data-testid="property-row"]')?.querySelector("input")?.value).toBe("Finished on");
    const mark = screen.getByRole("img", { name: "Automation" });
    const words = document.getElementById(mark.getAttribute("aria-describedby") ?? "")!;
    expect(words.textContent).toBe('"Stamp the finish date" and "Tidy" set this field');
    expect(words.hidden).toBe(true);
    // The mark follows its property's name in the tab order, and its words show on focus.
    await user.click(screen.getByDisplayValue("Finished on"));
    await user.tab();
    expect(document.activeElement).toBe(mark);
    expect(words.hidden).toBe(false);
    await user.keyboard("{Escape}");
    expect(words.hidden).toBe(true);
  });

  it("hides the reserved icon key from the user property rows", () => {
    render(
      <PropertiesPanel
        body={"---\nid: n1\ntitle: Plan\nicon: 🚀\nstatus: draft\n---\n\n# Plan\n"}
        onChange={vi.fn()}
      />,
    );

    // Only the single user property (status) is editable; id/title/icon are
    // managed by the document system and never surface as rows.
    expect(screen.queryAllByTestId("property-row")).toHaveLength(1);
    expect(screen.queryByDisplayValue("🚀")).toBeNull();
    expect(screen.getByDisplayValue("status")).toBeTruthy();
  });

  it("rejects the reserved icon name without writing it", async () => {
    const user = userEvent.setup({ delay: 20 });
    const initialBody = "---\nid: note-1\ntitle: Plan\n---\n\n# Plan\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.click(screen.getByTestId("property-add"));
    await user.type(screen.getByLabelText("Property 1 name"), "icon");

    expect(screen.getByTestId("property-reserved")).toBeTruthy();
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);
  });

  it("rejects reserved property names without writing them", async () => {
    const user = userEvent.setup({ delay: 20 });
    const initialBody = "---\nid: note-1\ntitle: Plan\n---\n\n# Plan\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.click(screen.getByTestId("property-add"));
    await user.type(screen.getByLabelText("Property 1 name"), "title");

    expect(screen.getByTestId("property-reserved")).toBeTruthy();
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);
  });

  it("preserves an existing property when its key is edited to a reserved name", async () => {
    const user = userEvent.setup({ delay: 20 });
    const initialBody =
      "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.clear(screen.getByDisplayValue("status"));
    await user.type(screen.getByLabelText("Property 1 name"), "title");

    expect(screen.getByTestId("property-reserved")).toBeTruthy();
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);
  });

  it("keeps an existing property row while its key is cleared during rename", async () => {
    const user = userEvent.setup();
    const initialBody = "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.clear(screen.getByDisplayValue("status"));

    expect(screen.queryAllByTestId("property-row")).toHaveLength(1);
    expect((screen.getByLabelText("Property 1 name") as HTMLInputElement).value).toBe(
      "",
    );
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);

    await user.type(screen.getByLabelText("Property 1 name"), "phase");

    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\nid: note-1\ntitle: Plan\nphase: draft\n---\n\n# Plan\n",
    );
  });

  it("does not save duplicate local property names while renaming", async () => {
    const user = userEvent.setup({ delay: 20 });
    const initialBody =
      "---\nid: note-1\ntitle: Plan\nstatus: draft\nowner: ice\n---\n\n# Plan\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.clear(screen.getByDisplayValue("status"));
    await user.type(screen.getByLabelText("Property 1 name"), "owner");

    expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(2);
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);

    await user.clear(screen.getAllByTestId("property-key")[0]);
    await user.type(screen.getByLabelText("Property 1 name"), "phase");

    expect(screen.queryByTestId("property-duplicate")).toBeNull();
    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\nid: note-1\ntitle: Plan\nphase: draft\nowner: ice\n---\n\n# Plan\n",
    );
  });

  it.each([
    '{status: draft, score: .nan}',
    '&root {status: draft, score: .nan}',
    '!!map &root {status: draft, score: .nan}',
    ': note\nstatus: draft\nscore: .nan',
  ])("refuses edits without changing the file: %s", async (yaml) => {
    const user = userEvent.setup();
    const initialBody = `---\n# Keep\n${yaml}\n---\n\n# Plan\n`;
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    expect(screen.getByTestId("properties-locked")).toBeTruthy();
    await user.type(screen.getByLabelText("Property status value"), "x");
    await user.click(screen.getByLabelText("Remove property score"));

    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);
  });

  it("writes shared properties into the Y.Doc frontmatter map", async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    const frontmatter = doc.getMap("frontmatter");
    frontmatter.set("id", "note-1");
    frontmatter.set("title", "Plan");
    frontmatter.set("status", "draft");

    render(<PropertiesPanel ydoc={doc} />);
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(frontmatter.get("id")).toBe("note-1");
    expect(frontmatter.get("title")).toBe("Plan");
    expect(frontmatter.get("status")).toBe("ready");
  });

  it("keeps an edited shared property's comment and never brings back a removed one's", async () => {
    const user = userEvent.setup();
    const doc = markdownToYDoc(
      "---\n# Wi-Fi password\nwifi: hunter2\n# Monthly\nbudget: 100\n---\n\nBody",
    );

    render(<PropertiesPanel ydoc={doc} />);
    await user.clear(screen.getByDisplayValue("100"));
    await user.type(screen.getByLabelText("Property budget value"), "200");
    await user.click(screen.getByLabelText("Remove property wifi"));
    doc.getMap("frontmatter").set("wifi", "new");

    expect(yDocToMarkdown(doc)).toBe("---\nwifi: new\n# Monthly\nbudget: '200'\n---\n\nBody");
    doc.destroy();
  });

  describe("renaming a shared property", () => {
    const budget = "---\n# Monthly\nbudget: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody";
    const names = () =>
      screen.getAllByTestId("property-key").map((input) => (input as HTMLInputElement).value);
    async function rename(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
      const name = screen.getAllByTestId("property-key").find((input) => (input as HTMLInputElement).value === from)!;
      await user.clear(name);
      await user.type(name, to);
    }

    it.each([
      {
        name: "its leading and inline comments",
        markdown: budget, from: "budget", to: "cost", rows: ["cost", "wifi"],
        expected: "---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody",
      },
      {
        name: "a quoted key",
        markdown: '---\nstatus: draft\n"owner": ice # lead\n---\n\nBody', from: "owner", to: "lead", rows: ["lead", "status"],
        expected: "---\nstatus: draft\nlead: ice # lead\n---\n\nBody",
      },
      {
        name: "a key that needs quotes",
        markdown: budget, from: "budget", to: "2026", rows: ["2026", "wifi"],
        expected: "---\n# Monthly\n'2026': 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody",
      },
      {
        name: "a nested value",
        markdown: "---\ntags:   # labels\n  - a   # first\n  - b\nwifi: x\n---\n\nBody", from: "tags", to: "labels",
        rows: ["labels", "wifi"],
        expected: "---\nlabels:   # labels\n  - a   # first\n  - b\nwifi: x\n---\n\nBody",
      },
    ])("keeps $name in place while a person types the name", async ({ markdown, from, to, rows, expected }) => {
      const user = userEvent.setup();
      const doc = markdownToYDoc(markdown);
      try {
        render(<PropertiesPanel ydoc={doc} />);
        await rename(user, from, to);
        expect(names()).toEqual(rows);
        expect(yDocToMarkdown(doc)).toBe(expected);
      } finally { doc.destroy(); }
    });

    it("keeps the comments above it when its value changes next", async () => {
      const user = userEvent.setup();
      const doc = markdownToYDoc(budget);
      try {
        render(<PropertiesPanel ydoc={doc} />);
        await rename(user, "budget", "cost");
        await user.clear(screen.getByLabelText("Property cost value"));
        await user.type(screen.getByLabelText("Property cost value"), "200");
        expect(yDocToMarkdown(doc)).toBe("---\n# Monthly\ncost: '200'\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody");
      } finally { doc.destroy(); }
    });

    it("writes nothing for a duplicate or reserved name, then renames in place", async () => {
      const user = userEvent.setup({ delay: 20 });
      const doc = markdownToYDoc(budget);
      const before = Y.encodeStateAsUpdate(doc);
      try {
        render(<PropertiesPanel ydoc={doc} />);
        await rename(user, "budget", "wifi");
        expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(2);
        await user.clear(screen.getByLabelText("Property 1 name"));
        await user.type(screen.getByLabelText("Property 1 name"), "title");
        expect(screen.getByTestId("property-reserved")).toBeTruthy();
        expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

        await user.clear(screen.getByLabelText("Property 1 name"));
        await user.type(screen.getByLabelText("Property 1 name"), "cost");
        expect(names()).toEqual(["cost", "wifi"]);
        expect(yDocToMarkdown(doc)).toBe("---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody");
      } finally { doc.destroy(); }
    });

    it("never brings back the comments of a removed property", async () => {
      const user = userEvent.setup();
      const onto = markdownToYDoc(budget);
      const recreated = markdownToYDoc(budget);
      try {
        const { unmount } = render(<PropertiesPanel ydoc={onto} />);
        await user.click(screen.getByLabelText("Remove property wifi"));
        await rename(user, "budget", "wifi");
        expect(yDocToMarkdown(onto)).toBe("---\n# Monthly\nwifi: 100 # euros\n---\n\nBody");
        unmount();

        render(<PropertiesPanel ydoc={recreated} />);
        await rename(user, "budget", "cost");
        await user.click(screen.getByLabelText("Remove property cost"));
        await user.click(screen.getByTestId("property-add"));
        await user.type(screen.getByLabelText("Property 2 name"), "cost");
        await user.type(screen.getByLabelText("Property cost value"), "100");
        expect(yDocToMarkdown(recreated)).toBe("---\ncost: '100'\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody");
      } finally { onto.destroy(); recreated.destroy(); }
    });

    it("keeps edits another device makes to other properties during the rename", async () => {
      const user = userEvent.setup();
      const doc = markdownToYDoc(budget);
      const peer = new Y.Doc();
      try {
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        setFrontmatterValue(peer, "wifi", "new");
        setFrontmatterValue(peer, "owner", "sam");
        render(<PropertiesPanel ydoc={doc} />);
        const name = screen.getByLabelText("Property 1 name");
        await user.clear(name);
        await user.type(name, "co");
        act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)));
        await user.type(name, "st");
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

        expect(names()).toEqual(["cost", "wifi", "owner"]);
        const expected = "---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: new\nowner: sam\n---\n\nBody";
        expect(yDocToMarkdown(doc)).toBe(expected);
        expect(yDocToMarkdown(peer)).toBe(expected);
      } finally { doc.destroy(); peer.destroy(); }
    });
  });

  it("does not rewrite unrelated shared frontmatter keys", async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    const frontmatter = doc.getMap("frontmatter");
    frontmatter.set("id", "note-1");
    frontmatter.set("title", "Plan");
    frontmatter.set("status", "draft");

    render(<PropertiesPanel ydoc={doc} />);
    frontmatter.set("settings", { pinned: true });
    await user.clear(screen.getByDisplayValue("draft"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(frontmatter.get("status")).toBe("ready");
    expect(frontmatter.get("settings")).toEqual({ pinned: true });
  });

  it("does not collapse duplicate shared frontmatter keys", async () => {
    const user = userEvent.setup({ delay: 20 });
    const doc = new Y.Doc();
    const frontmatter = doc.getMap("frontmatter");
    frontmatter.set("id", "note-1");
    frontmatter.set("title", "Plan");
    frontmatter.set("status", "draft");
    frontmatter.set("owner", "ice");

    render(<PropertiesPanel ydoc={doc} />);
    await user.clear(screen.getByDisplayValue("status"));
    await user.type(screen.getByLabelText("Property 1 name"), "owner");

    expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(2);
    expect(frontmatter.get("status")).toBe("draft");
    expect(frontmatter.get("owner")).toBe("ice");
  });
});
