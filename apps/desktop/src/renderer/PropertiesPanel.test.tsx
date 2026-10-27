// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  frontmatterAsWritten,
  frontmatterMapValues,
  patchFrontmatter,
  setFrontmatterValue,
} from "@dohc/ydoc-projection/frontmatter-map";
import { PropertiesPanel } from "./PropertiesPanel";
import { parseFrontmatter } from "./markdown/frontmatter";
import {
  EDGE_DISPLAY,
  EDGE_FRONTMATTER,
  EDGE_MARKDOWN,
  receivedYDoc,
  recordedYDoc,
} from "./markdown/frontmatter.edge-fixture";

function propertyValue(key: string): string {
  return (screen.getByLabelText(`Property ${key} value`) as HTMLInputElement).value;
}

// The properties each change touches. A change inside a shared value reports
// the property that holds it.
function trackChangedProperties(frontmatter: Y.Map<unknown>): Set<string> {
  const changed = new Set<string>();
  frontmatter.observeDeep((events) => {
    for (const event of events) {
      if (event.target !== frontmatter) changed.add(String(event.path[0]));
      else if (event instanceof Y.YMapEvent) for (const key of event.keysChanged) changed.add(key);
    }
  });
  return changed;
}

// A value the canonical writer keeps in shared Y types: keys Yjs Any loses,
// exact integers, and a literal key spelled like the integer's marker. It is
// the last entry, so its row keeps its place while a rename moves its key to
// the end of the map.
const ZONE_ENTRY = [
  "zone:",
  "  __proto__: nested-value",
  "  constructor: own",
  "  inner:",
  "    __proto__: nested-proto",
  "    exact: 9007199254740993",
  "  list:",
  "    - $dohcBigInt: 9007199254740993",
  "    - 9007199254740993",
  "",
].join("\n");
// A computed `__proto__` key is an own property, as the file holds it.
const ZONE = {
  ["__proto__"]: "nested-value",
  constructor: "own",
  inner: { ["__proto__"]: "nested-proto", exact: 9007199254740993n },
  list: [{ $dohcBigInt: 9007199254740993n }, 9007199254740993n],
};
const OPTIONS_ENTRY = ZONE_ENTRY.replace("zone:", "options:");

// The panel's rows read the document in an effect after its render decoded
// the source snapshot. A layout effect lands between the two, where a device's
// update arrives after a render and before the effects it schedules.
function ForwardsOnCommit(props: { from: Y.Doc; to: Y.Doc }) {
  useLayoutEffect(() => {
    Y.applyUpdate(props.to, Y.encodeStateAsUpdate(props.from, Y.encodeStateVector(props.to)));
  }, [props.from, props.to]);
  return null;
}

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

  describe("pills", () => {
    it("keeps the keyboard order name, value, remove in each pill, then the +", async () => {
      const user = userEvent.setup();
      render(<PropertiesPanel body={"---\nowner: Sam\nstatus: Draft\n---\n"} onChange={vi.fn()} />);

      await user.click(screen.getByLabelText("Property 1 name"));
      const order = [document.activeElement];
      for (let step = 0; step < 6; step += 1) {
        await user.tab();
        order.push(document.activeElement);
      }
      expect(order).toEqual([
        screen.getByLabelText("Property 1 name"),
        screen.getByLabelText("Property owner value"),
        screen.getByLabelText("Remove property owner"),
        screen.getByLabelText("Property 2 name"),
        screen.getByLabelText("Property status value"),
        screen.getByLabelText("Remove property status"),
        screen.getByTestId("property-add"),
      ]);
    });

    it("keeps Add a property as the +'s name and tooltip, and adds then removes a pill", async () => {
      const user = userEvent.setup();
      render(<ControlledPropertiesPanel initialBody={"---\nowner: Sam\n---\n\nBody"} />);
      const add = screen.getByRole("button", { name: "Add a property" });
      expect(add.getAttribute("title")).toBe("Add a property");
      expect(add.textContent).toBe("");

      await user.click(add);
      expect(screen.getAllByTestId("property-row")).toHaveLength(2);
      await user.type(screen.getByLabelText("Property 2 name"), "release");
      await user.type(screen.getByLabelText("Property release value"), "September");
      expect(screen.getByTestId("current-body").textContent).toBe("---\nowner: Sam\nrelease: September\n---\n\nBody");

      await user.click(screen.getByLabelText("Remove property owner"));
      expect(screen.getAllByTestId("property-row")).toHaveLength(1);
      expect(screen.getByTestId("current-body").textContent).toBe("---\nrelease: September\n---\n\nBody");
    });

    it("moves focus to the new pill's name after an add", async () => {
      const user = userEvent.setup();
      render(<ControlledPropertiesPanel initialBody={"---\nowner: Sam\n---\n\nBody"} />);

      await user.click(screen.getByTestId("property-add"));
      expect(document.activeElement).toBe(screen.getByLabelText("Property 2 name"));
      await user.keyboard("release");
      expect((screen.getByLabelText("Property 2 name") as HTMLInputElement).value).toBe("release");
    });

    it("moves focus after a remove to the next pill, else the one before, else the +", async () => {
      const user = userEvent.setup();
      render(<ControlledPropertiesPanel initialBody={"---\nowner: Sam\nrelease: September\nstatus: Draft\n---\n\nBody"} />);

      // The middle pill: the next one takes its place.
      screen.getByLabelText("Remove property release").focus();
      await user.keyboard("{Enter}");
      expect(screen.getAllByTestId("property-row")).toHaveLength(2);
      expect(document.activeElement).toBe(screen.getAllByTestId("property-key")[1]);
      expect((document.activeElement as HTMLInputElement).value).toBe("status");

      // The last pill: the one before it.
      screen.getByLabelText("Remove property status").focus();
      await user.keyboard("{Enter}");
      expect(document.activeElement).toBe(screen.getAllByTestId("property-key")[0]);
      expect((document.activeElement as HTMLInputElement).value).toBe("owner");

      // The only pill: the +.
      screen.getByLabelText("Remove property owner").focus();
      await user.keyboard("{Enter}");
      expect(screen.queryAllByTestId("property-row")).toHaveLength(0);
      expect(document.activeElement).toBe(screen.getByTestId("property-add"));
    });

    it.each([false, true])("offers no + and no × on a block written on one line (shared: %s)", (shared) => {
      const body = "---\n{status: draft, owner: Sam}\n---\n\nBody";
      const doc = markdownToYDoc(body);
      try {
        render(shared ? <PropertiesPanel ydoc={doc} /> : <PropertiesPanel body={body} onChange={vi.fn()} />);
        expect(screen.getByTestId("properties-locked").textContent).toBe("Edit in Source");
        expect(screen.getAllByTestId("property-row")).toHaveLength(2);
        expect(screen.queryByTestId("property-add")).toBeNull();
        expect(screen.queryAllByTestId("property-remove")).toHaveLength(0);
      } finally { doc.destroy(); }
    });

    it("keeps a long value whole in its tooltip", () => {
      const value = "https://example.com/a/very/long/path/that/keeps/going/past/the/width/of/one/pill";
      render(<PropertiesPanel body={`---\nlink: ${value}\n---\n`} onChange={vi.fn()} />);
      const input = screen.getByLabelText("Property link value") as HTMLInputElement;
      expect(input.value).toBe(value);
      expect(input.title).toBe(value);
      expect(input.className).toContain("text-ellipsis");
    });

    it("shows the + alone, hidden until hover or focus, on a page with no properties", () => {
      render(<PropertiesPanel body={"Body"} onChange={vi.fn()} />);
      expect(screen.queryAllByTestId("property-row")).toHaveLength(0);
      const add = screen.getByTestId("property-add");
      expect(add.className).toContain("opacity-0");
      expect(add.className).toContain("group-hover/topmatter:opacity-100");
      expect(add.className).toContain("focus-visible:opacity-100");
    });

    it("flags a reserved or duplicate name in its pill in place of the value", async () => {
      const user = userEvent.setup();
      render(<ControlledPropertiesPanel initialBody={"---\nowner: Sam\nstatus: Draft\n---\n"} />);

      await user.clear(screen.getByLabelText("Property 2 name"));
      await user.type(screen.getByLabelText("Property 2 name"), "owner");
      const flag = screen.getByTestId("property-duplicate");
      expect(flag.closest('[data-testid="property-row"]')).toBe(screen.getAllByTestId("property-row")[1]);
      expect(flag.title).toBe("This name isn't saved. Another property has it.");
      expect(screen.getByLabelText("Property 2 name")).toHaveProperty("value", "owner");
      expect(propertyValue("owner")).toBe("Sam");
      expect(screen.getByTestId("current-body").textContent).toBe("---\nowner: Sam\nstatus: Draft\n---\n");

      await user.clear(screen.getByLabelText("Property 2 name"));
      await user.type(screen.getByLabelText("Property 2 name"), "icon");
      const reserved = screen.getByTestId("property-reserved");
      expect(reserved.closest('[data-testid="property-row"]')).toBe(screen.getAllByTestId("property-row")[1]);
      expect(screen.getAllByTestId("property-value")).toHaveLength(1);
    });
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

    expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(1);
    expect(screen.getByTestId("current-body").textContent).toBe(initialBody);

    await user.clear(screen.getAllByTestId("property-key")[0]);
    await user.type(screen.getByLabelText("Property 1 name"), "phase");

    expect(screen.queryByTestId("property-duplicate")).toBeNull();
    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\nid: note-1\ntitle: Plan\nphase: draft\nowner: ice\n---\n\n# Plan\n",
    );
  });

  it("keeps saving other properties while a name another property has is held", async () => {
    const user = userEvent.setup();
    const initialBody = "---\nstatus: draft\nowner: Sam\ntags: [kyoto]\n---\n\nBody\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.clear(screen.getByLabelText("Property 1 name"));
    await user.type(screen.getByLabelText("Property 1 name"), "owner");
    await user.type(screen.getByLabelText("Property owner value"), "a");
    await user.type(screen.getByLabelText("Property tags value"), ", osaka");

    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\nstatus: draft\nowner: Sama\ntags:\n  - kyoto\n  - osaka\n---\n\nBody\n",
    );
    expect(screen.getByLabelText("Property 1 name")).toHaveProperty("value", "owner");
    expect(screen.getAllByTestId("property-duplicate")).toHaveLength(1);

    await user.type(screen.getByLabelText("Property 1 name"), "2");

    expect(screen.queryByTestId("property-duplicate")).toBeNull();
    expect(screen.getByTestId("current-body").textContent).toBe(
      "---\nowner2: draft\nowner: Sama\ntags:\n  - kyoto\n  - osaka\n---\n\nBody\n",
    );
  });

  it("shows a held name's property as saved once no other property has the name", async () => {
    const user = userEvent.setup();
    const initialBody = "---\nstatus: draft\nowner: Sam\n---\n\nBody\n";
    render(<ControlledPropertiesPanel initialBody={initialBody} />);

    await user.clear(screen.getByLabelText("Property 1 name"));
    await user.type(screen.getByLabelText("Property 1 name"), "owner");
    await user.clear(screen.getByLabelText("Property 2 name"));
    await user.type(screen.getByLabelText("Property 2 name"), "lead");

    expect(screen.queryByTestId("property-duplicate")).toBeNull();
    expect(screen.getByLabelText("Property 1 name")).toHaveProperty("value", "status");
    expect(screen.getByTestId("current-body").textContent).toBe("---\nstatus: draft\nlead: Sam\n---\n\nBody\n");
  });

  it("flags both names and keeps saving other properties when the file holds a name in two cases", async () => {
    const user = userEvent.setup();
    render(<ControlledPropertiesPanel initialBody={"---\nowner: Sam\nOwner: Ada\nstatus: draft\n---\n\nBody\n"} />);

    expect(screen.getAllByTestId("property-duplicate").map((flag) => flag.title)).toEqual([
      "Use a unique property name.",
      "Use a unique property name.",
    ]);
    await user.type(screen.getByLabelText("Property status value"), "!");

    expect(screen.getByTestId("current-body").textContent).toBe("---\nowner: Sam\nOwner: Ada\nstatus: draft!\n---\n\nBody\n");
  });

  it("keeps both of two names that differ only by spaces inside quotes", async () => {
    const user = userEvent.setup();
    render(<ControlledPropertiesPanel initialBody={'---\nowner: Sam\n" owner ": Ada\nstatus: draft\n---\n\nBody\n'} />);

    await user.type(screen.getByLabelText("Property status value"), "!");

    expect(screen.getByTestId("current-body").textContent).toBe('---\nowner: Sam\n" owner ": Ada\nstatus: draft!\n---\n\nBody\n');
  });

  it("holds a name a property with a cleared name still saves under, so neither value is lost", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\na: one\nb: two\n---\n\nBody\n"} onChange={onChange} />);

    await user.clear(screen.getByLabelText("Property 1 name"));
    await user.clear(screen.getByLabelText("Property 2 name"));
    await user.type(screen.getByLabelText("Property 2 name"), "a");

    const flag = screen.getByTestId("property-duplicate");
    expect(flag.closest('[data-testid="property-row"]')).toBe(screen.getAllByTestId("property-row")[1]);
    expect(onChange.mock.calls.filter(([written]) => !String(written).includes("a: one\nb: two\n"))).toEqual([]);
  });

  it("keeps a held name on its own pill when a pill before it is removed", async () => {
    const user = userEvent.setup();
    render(<PropertiesPanel body={"---\nowner: Sam\n---\n\nBody\n"} onChange={vi.fn()} />);

    await user.click(screen.getByTestId("property-add"));
    await user.click(screen.getByTestId("property-add"));
    await user.type(screen.getByLabelText("Property 3 name"), "owner");
    await user.click(screen.getByTestId("property-add"));
    await user.click(screen.getByLabelText("Remove property 2"));

    expect(screen.getAllByTestId("property-key").map((input) => (input as HTMLInputElement).value)).toEqual(["owner", "owner", ""]);
    const flag = screen.getByTestId("property-duplicate");
    expect(flag.closest('[data-testid="property-row"]')).toBe(screen.getAllByTestId("property-row")[1]);
  });

  it("drops a held name with its pill, so it doesn't move to the next new pill", async () => {
    const user = userEvent.setup();
    render(<PropertiesPanel body={"---\nowner: Sam\n---\n\nBody\n"} onChange={vi.fn()} />);

    await user.click(screen.getByTestId("property-add"));
    await user.type(screen.getByLabelText("Property 2 name"), "owner");
    await user.click(screen.getByTestId("property-add"));
    await user.click(screen.getByLabelText("Remove property 2"));

    expect(screen.getAllByTestId("property-key").map((input) => (input as HTMLInputElement).value)).toEqual(["owner", ""]);
    expect(screen.queryByTestId("property-duplicate")).toBeNull();
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

    expect(screen.getByTestId("properties-locked").textContent).toBe("Edit in Source");
    await user.type(screen.getByLabelText("Property status value"), "x");
    // A locked block offers no + and no ×, which could do nothing.
    expect(screen.queryByTestId("property-add")).toBeNull();
    expect(screen.queryAllByTestId("property-remove")).toHaveLength(0);

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
        markdown: '---\nstatus: draft\n"owner": ice # lead\n---\n\nBody', from: "owner", to: "lead", rows: ["status", "lead"],
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
      {
        name: "a value that keeps its text",
        markdown: "---\nbudget: .nan # unknown\nwifi: x\n---\n\nBody", from: "budget", to: "cost", rows: ["cost", "wifi"],
        expected: "---\ncost: .nan # unknown\nwifi: x\n---\n\nBody",
      },
      {
        name: "canonical frontmatter",
        markdown: "---\nbudget: 100\nwifi: hunter2\n---\n\nBody", from: "budget", to: "yearly", rows: ["yearly", "wifi"],
        expected: "---\nyearly: 100\nwifi: hunter2\n---\n\nBody",
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
        expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(1);
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

    it("shows the properties in the order the file holds them", () => {
      const doc = markdownToYDoc("---\nwifi: hunter2\nbudget: 100\n---\n\nBody");
      try {
        render(<PropertiesPanel ydoc={doc} />);
        expect(names()).toEqual(["wifi", "budget"]);
      } finally { doc.destroy(); }
    });

    it.each([false, true])("shows integer-like names in the order the file holds them (shared: %s)", (shared) => {
      const markdown = "---\nbudget: 100\n'2026': a\n'10': b\n'1': c\n---\n\nBody";
      const doc = markdownToYDoc(markdown);
      try {
        render(shared ? <PropertiesPanel ydoc={doc} /> : <ControlledPropertiesPanel initialBody={markdown} />);
        expect(names()).toEqual(["budget", "2026", "10", "1"]);
      } finally { doc.destroy(); }
    });

    it("keeps an integer-like name where it was renamed after a reopen", async () => {
      const user = userEvent.setup();
      const doc = markdownToYDoc("---\nbudget: 100\nwifi: hunter2\n---\n\nBody");
      try {
        const { unmount } = render(<PropertiesPanel ydoc={doc} />);
        await rename(user, "wifi", "2026");
        unmount();
        const reopened = markdownToYDoc(yDocToMarkdown(doc));
        try {
          render(<PropertiesPanel ydoc={reopened} />);
          expect(names()).toEqual(["budget", "2026"]);
        } finally { reopened.destroy(); }
      } finally { doc.destroy(); }
    });

    it("shows a property another device renames in its row", () => {
      const doc = markdownToYDoc(budget);
      const peer = new Y.Doc();
      try {
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
        render(<PropertiesPanel ydoc={doc} />);
        expect(names()).toEqual(["budget", "wifi"]);
        patchFrontmatter(peer, new Map([["cost", 100]]), ["budget"], new Map([["budget", "cost"]]));
        act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)));
        expect(names()).toEqual(["cost", "wifi"]);
      } finally { doc.destroy(); peer.destroy(); }
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

  // `settings` is the last entry, so its row keeps its place while a rename
  // moves its key to the end of the map.
  it("renames a shared map property without losing it", async () => {
    const user = userEvent.setup();
    const doc = markdownToYDoc("---\nid: note-1\ntitle: Plan\ndue: friday\nsettings:\n  pinned: true\n---\n\nBody\n");
    const frontmatter = doc.getMap<unknown>("frontmatter");
    const changed = trackChangedProperties(frontmatter);
    const replica = new Y.Doc();
    try {
      expect(doc.getMap("meta").get("dohcFrontmatterSource")).toBeUndefined();
      render(<PropertiesPanel ydoc={doc} />);
      await user.clear(screen.getByDisplayValue("settings"));
      await user.type(screen.getByLabelText("Property 2 name"), "options");

      expect(screen.queryByTestId("properties-locked")).toBeNull();
      expect([...frontmatter.keys()]).toEqual(["due", "id", "title", "options"]);
      expect([...changed].filter((key) => !"options".startsWith(key))).toEqual(["settings"]);
      // An ordinary map stays a Yjs Any value.
      expect(frontmatter.get("options")).not.toBeInstanceOf(Y.AbstractType);

      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      expect(frontmatterMapValues(replica.getMap("frontmatter"))).toEqual({
        due: "friday",
        id: "note-1",
        options: { pinned: true },
        title: "Plan",
      });
      expect(yDocToMarkdown(replica)).toBe("---\nid: note-1\ntitle: Plan\ndue: friday\noptions:\n  pinned: true\n---\n\nBody");
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  // A rename keeps the property in its place: canonical frontmatter keeps the
  // text its first rename starts from, so the file no longer settles sorted.
  it.each([
    ["canonical", `---\nstatus: draft\n${ZONE_ENTRY}---\n\nBody\n`, `---\nstatus: draft\n${OPTIONS_ENTRY}---\n\n`],
    [
      "kept",
      `---\n# Keep this note\nstatus: draft\n${ZONE_ENTRY}---\n\nBody\n`,
      `---\n# Keep this note\nstatus: draft\n${OPTIONS_ENTRY}---\n\n`,
    ],
  ])("renames a shared-type property that another replica reads back (%s text)", async (_name, markdown, settled) => {
    const user = userEvent.setup();
    const doc = receivedYDoc(markdown);
    const frontmatter = doc.getMap<unknown>("frontmatter");
    const changed = trackChangedProperties(frontmatter);
    const replica = new Y.Doc();
    try {
      expect(frontmatter.get("zone")).toBeInstanceOf(Y.Map);
      expect(frontmatterMapValues(frontmatter).zone).toEqual(ZONE);
      render(<PropertiesPanel ydoc={doc} />);
      await user.clear(screen.getByDisplayValue("zone"));
      await user.type(screen.getByLabelText("Property 2 name"), "options");

      expect(screen.queryByTestId("properties-locked")).toBeNull();
      expect(changed.has("status")).toBe(false);
      expect(frontmatterAsWritten(doc, true)).toBe(settled);

      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      const values = frontmatterMapValues(replica.getMap("frontmatter"));
      expect(Object.keys(values)).toEqual(["options", "status"]);
      expect(values.options).toEqual(ZONE);
      expect(yDocToMarkdown(replica)).toBe(`${settled}Body`);
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("shows shared-type frontmatter as one line of YAML and edits only the changed property", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc(EDGE_MARKDOWN);
    const frontmatter = doc.getMap("frontmatter");
    const changed: string[] = [];
    frontmatter.observeDeep((events) => {
      for (const event of events) {
        // A change inside a shared value reports the property that holds it.
        if (event.target !== frontmatter) changed.push(String(event.path[0]));
        else if (event instanceof Y.YMapEvent) changed.push(...event.keysChanged);
      }
    });
    try {
      render(<PropertiesPanel ydoc={doc} />);
      for (const [key, text] of Object.entries(EDGE_DISPLAY)) {
        expect(propertyValue(key), key).toBe(text);
      }

      await user.clear(screen.getByLabelText("Property status value"));
      await user.type(screen.getByLabelText("Property status value"), "ready");

      expect(new Set(changed)).toEqual(new Set(["status"]));
      expect(yDocToMarkdown(doc)).toBe(
        `${EDGE_FRONTMATTER.replace("status: draft", "status: ready")}Body`,
      );
    } finally {
      doc.destroy();
    }
  });

  // The root map's observer does not report a change inside a shared value,
  // so the rows can hold a device's newer value while the panel's source
  // snapshot holds the older one. Editing status must not write settings.
  it("keeps a shared value another device changes before the rows read it, while only status changes", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\nsettings:\n  constructor: kept\n  pinned: false\nstatus: draft\n---\n\nBody\n");
    const frontmatter = doc.getMap<unknown>("frontmatter");
    const settings = frontmatter.get("settings") as Y.Map<unknown>;
    const replica = new Y.Doc();
    try {
      expect(settings).toBeInstanceOf(Y.Map);
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      const replicaSettings = replica.getMap<unknown>("frontmatter").get("settings") as Y.Map<unknown>;
      replicaSettings.set("pinned", true);
      render(
        <>
          <PropertiesPanel ydoc={doc} />
          <ForwardsOnCommit from={replica} to={doc} />
        </>,
      );
      expect(propertyValue("settings")).toBe("{constructor: kept, pinned: true}");

      replicaSettings.set("note", "later");
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc))));
      const changed = trackChangedProperties(frontmatter);
      await user.clear(screen.getByLabelText("Property status value"));
      await user.type(screen.getByLabelText("Property status value"), "ready");

      expect(frontmatter.get("status")).toBe("ready");
      expect(frontmatter.get("settings")).toBe(settings);
      expect(changed).toEqual(new Set(["status"]));
      expect(frontmatterMapValues(frontmatter).settings).toEqual({ constructor: "kept", note: "later", pinned: true });
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("shows a direct Any bigint and leaves it alone while a neighbour changes", async () => {
    const user = userEvent.setup();
    const { doc } = recordedYDoc("numbers");
    const frontmatter = doc.getMap("frontmatter");
    try {
      render(<PropertiesPanel ydoc={doc} />);
      expect(propertyValue("c")).toBe("9007199254740993");

      await user.clear(screen.getByLabelText("Property d value"));
      await user.type(screen.getByLabelText("Property d value"), "2");

      expect(frontmatter.get("d")).toBe("2");
      expect(frontmatter.get("c")).toBe(9007199254740993n);
    } finally {
      doc.destroy();
    }
  });

  it("keeps hostile keys and exact integers beside an edited local property", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const body = EDGE_MARKDOWN.replace(
      "---\n",
      "---\n__proto__: top-proto\nconstructor: top-constructor\n",
    );
    render(<PropertiesPanel body={body} onChange={onChange} />);
    expect(propertyValue("__proto__")).toBe("top-proto");
    for (const [key, text] of Object.entries(EDGE_DISPLAY)) {
      expect(propertyValue(key), key).toBe(text);
    }

    await user.clear(screen.getByLabelText("Property status value"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(onChange).toHaveBeenLastCalledWith(body.replace("status: draft", "status: ready"));
  });

  it("saves a list's items as you type, and shows the text as typed until you leave it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const body = "---\ntags:\n  - kyoto\n  - food\nstatus: draft\n---\n\nBody\n";
    render(<PropertiesPanel body={body} onChange={onChange} />);
    const input = screen.getByLabelText("Property tags value");
    expect(propertyValue("tags")).toBe("kyoto, food");

    await user.type(input, ", ");
    expect(onChange).not.toHaveBeenCalled();
    expect(propertyValue("tags")).toBe("kyoto, food, ");

    await user.type(input, "ramen ,");
    expect(onChange).toHaveBeenLastCalledWith(body.replace("  - food\n", "  - food\n  - ramen\n"));
    expect(propertyValue("tags")).toBe("kyoto, food, ramen ,");
    await user.tab();
    expect(propertyValue("tags")).toBe("kyoto, food, ramen");
  });

  it("keeps the typed list text when the window loses focus with the field still focused", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\ntags: [kyoto, food]\n---\n\nBody\n"} onChange={onChange} />);
    const input = screen.getByLabelText("Property tags value");

    await user.type(input, ", ");
    fireEvent.blur(input);
    expect(document.activeElement).toBe(input);
    expect(propertyValue("tags")).toBe("kyoto, food, ");
    await user.type(input, "nara");

    expect(onChange).toHaveBeenLastCalledWith("---\ntags:\n  - kyoto\n  - food\n  - nara\n---\n\nBody\n");
  });

  it("writes each list item as text, trimmed and without blank items", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\ntags:\n  - kyoto\n---\n\nBody\n"} onChange={onChange} />);
    const input = screen.getByLabelText("Property tags value");

    await user.clear(input);
    await user.type(input, " 2026,yes , null,, ~, 1.0, ramen ,");

    const written = onChange.mock.lastCall?.[0] as string;
    expect(written).toBe(
      "---\ntags:\n  - '2026'\n  - yes\n  - 'null'\n  - '~'\n  - '1.0'\n  - ramen\n---\n\nBody\n",
    );
    expect(parseFrontmatter(written).meta.tags).toEqual(["2026", "yes", "null", "~", "1.0", "ramen"]);
  });

  it("writes nothing when a list edit leaves the same items, so the list stays as written", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\ntags: [kyoto, food]\n---\n\nBody\n"} onChange={onChange} />);

    await user.type(screen.getByLabelText("Property tags value"), " ,, ");
    await user.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(propertyValue("tags")).toBe("kyoto, food");
  });

  it("saves an empty list when an edit leaves no items", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\ntags:\n  - kyoto\nstatus: draft\n---\n\nBody\n"} onChange={onChange} />);
    const input = screen.getByLabelText("Property tags value");

    await user.clear(input);
    await user.type(input, " , ");

    expect(onChange).toHaveBeenCalledExactlyOnceWith("---\ntags: []\nstatus: draft\n---\n\nBody\n");
  });

  it("saves a live document's list as you type, and writes nothing when the items stay the same", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\ntags:\n  - kyoto\n  - food\nstatus: draft\n---\n\nBody\n");
    const frontmatter = doc.getMap("frontmatter");
    try {
      render(<PropertiesPanel ydoc={doc} />);
      const input = screen.getByLabelText("Property tags value");
      const before = Y.encodeStateAsUpdate(doc);

      await user.type(input, " ,,");
      await user.tab();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(propertyValue("tags")).toBe("kyoto, food");

      const changed = trackChangedProperties(frontmatter);
      await user.type(input, ", 2026");

      expect(changed).toEqual(new Set(["tags"]));
      expect(frontmatterMapValues(frontmatter).tags).toEqual(["kyoto", "food", "2026"]);
      expect(yDocToMarkdown(doc)).toBe("---\ntags:\n  - kyoto\n  - food\n  - '2026'\nstatus: draft\n---\n\nBody");
      expect(propertyValue("tags")).toBe("kyoto, food, 2026");
    } finally {
      doc.destroy();
    }
  });

  it("keeps a live document's typed list text when another device changes another property", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\ntags: [kyoto, food]\nstatus: draft\n---\n\nBody\n");
    const replica = new Y.Doc();
    try {
      render(<PropertiesPanel ydoc={doc} />);
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      await user.type(screen.getByLabelText("Property tags value"), ", ramen,");

      setFrontmatterValue(replica, "status", "ready");
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc))));

      expect(propertyValue("status")).toBe("ready");
      expect(propertyValue("tags")).toBe("kyoto, food, ramen,");
      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ tags: ["kyoto", "food", "ramen"], status: "ready" });
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("shows another device's newer list in place of the typed text, and writes nothing over it", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\ntags: [kyoto, food]\n---\n\nBody\n");
    const replica = new Y.Doc();
    try {
      render(<PropertiesPanel ydoc={doc} />);
      await user.type(screen.getByLabelText("Property tags value"), ", osaka,");
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));

      setFrontmatterValue(replica, "tags", ["paris"]);
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc))));
      expect(propertyValue("tags")).toBe("paris");
      await user.tab();

      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ tags: ["paris"] });
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("keeps typed list items saved when another device moves their row", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\nowner: Sam\ntags: [kyoto, food]\nstatus: draft\n---\n\nBody\n");
    const replica = new Y.Doc();
    try {
      render(<PropertiesPanel ydoc={doc} />);
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      await user.type(screen.getByLabelText("Property tags value"), ", osaka");

      replica.getMap("frontmatter").delete("owner");
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc))));

      expect(propertyValue("tags")).toBe("kyoto, food, osaka");
      expect(propertyValue("status")).toBe("draft");
      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ tags: ["kyoto", "food", "osaka"], status: "draft" });
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("keeps a local file's typed list text when the file changes another property", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<PropertiesPanel body={"---\ntags: [kyoto, food]\nstatus: draft\n---\n\nBody\n"} onChange={onChange} />);
    await user.type(screen.getByLabelText("Property tags value"), ", ramen,");
    const saved = onChange.mock.lastCall?.[0] as string;
    expect(saved).toBe("---\ntags:\n  - kyoto\n  - food\n  - ramen\nstatus: draft\n---\n\nBody\n");

    rerender(<PropertiesPanel body={saved.replace("draft", "ready")} onChange={onChange} />);
    expect(propertyValue("status")).toBe("ready");
    expect(propertyValue("tags")).toBe("kyoto, food, ramen,");
    await user.type(screen.getByLabelText("Property tags value"), " osaka");

    expect(onChange).toHaveBeenLastCalledWith("---\ntags:\n  - kyoto\n  - food\n  - ramen\n  - osaka\nstatus: ready\n---\n\nBody\n");
  });

  it("edits a local list from what it saved, before the file catches up", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PropertiesPanel body={"---\ntags: [kyoto, food]\n---\n\nBody\n"} onChange={onChange} />);
    const input = screen.getByLabelText("Property tags value");

    await user.type(input, ", osaka");
    expect(onChange).toHaveBeenLastCalledWith("---\ntags:\n  - kyoto\n  - food\n  - osaka\n---\n\nBody\n");
    await user.type(input, ", rome");
    expect(onChange).toHaveBeenLastCalledWith("---\ntags:\n  - kyoto\n  - food\n  - osaka\n  - rome\n---\n\nBody\n");
  });

  it("shows a local file's newer list in place of the typed text, and writes nothing over it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const body = "---\ntags: [kyoto, food]\n---\n\nBody\n";
    const { rerender } = render(<PropertiesPanel body={body} onChange={onChange} />);
    await user.type(screen.getByLabelText("Property tags value"), ", osaka,");
    const writes = onChange.mock.calls.length;

    rerender(<PropertiesPanel body={body.replace("[kyoto, food]", "[paris]")} onChange={onChange} />);
    expect(propertyValue("tags")).toBe("paris");
    await user.tab();

    expect(onChange).toHaveBeenCalledTimes(writes);
  });

  it("shows why a list or map can't be edited, with its whole value, to the keyboard as well as the pointer", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const body = "---\nplaces: [\"Kyoto, Japan\", Osaka]\nwhere: {lat: 35.5}\n---\n\nBody\n";
    render(<PropertiesPanel body={body} onChange={onChange} />);
    const places = screen.getByLabelText("Property places value") as HTMLInputElement;
    const words = document.getElementById(places.getAttribute("aria-describedby") ?? "");

    expect(places.value).toBe("['Kyoto, Japan', Osaka]");
    expect(places.readOnly).toBe(true);
    expect(places.parentElement?.querySelector("svg[class*='lucide-lock']")).not.toBeNull();
    // A screen reader reads the reason with the value even while it is hidden.
    expect(words?.getAttribute("role")).toBe("tooltip");
    expect(words?.hidden).toBe(true);
    expect(words?.textContent).toBe(
      "['Kyoto, Japan', Osaka]dohc can't edit this list because an item has a comma. Change it in another app, or ask an agent.",
    );

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(places);
    expect(words?.hidden).toBe(false);
    await user.keyboard("x");
    expect(places.value).toBe("['Kyoto, Japan', Osaka]");
    await user.keyboard("{Escape}");
    expect(words?.hidden).toBe(true);

    const where = screen.getByLabelText("Property where value") as HTMLInputElement;
    await user.hover(where);
    expect(document.getElementById(where.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "{lat: 35.5}dohc can't edit a value with named fields. Change it in another app, or ask an agent.",
    );
    // Leaving a name saves the rows, which leaves the file as it was.
    for (const [written] of onChange.mock.calls) expect(written).toBe(body);
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

    expect(screen.queryAllByTestId("property-duplicate")).toHaveLength(1);
    expect(frontmatter.get("status")).toBe("draft");
    expect(frontmatter.get("owner")).toBe("ice");
  });

  it("keeps saving a live document's other properties while a name another property has is held", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\nstatus: draft\nowner: Sam\n---\n\nBody\n");
    const frontmatter = doc.getMap("frontmatter");
    try {
      render(<PropertiesPanel ydoc={doc} />);
      await user.clear(screen.getByLabelText("Property 1 name"));
      await user.type(screen.getByLabelText("Property 1 name"), "Owner");
      await user.type(screen.getByLabelText("Property owner value"), "a");

      expect(frontmatterMapValues(frontmatter)).toEqual({ status: "draft", owner: "Sama" });
      expect(screen.getByLabelText("Property 1 name")).toHaveProperty("value", "Owner");
      expect(screen.getAllByTestId("property-duplicate")).toHaveLength(1);

      await user.clear(screen.getByLabelText("Property 1 name"));
      await user.type(screen.getByLabelText("Property 1 name"), "lead");

      expect(frontmatterMapValues(frontmatter)).toEqual({ lead: "draft", owner: "Sama" });
    } finally {
      doc.destroy();
    }
  });

  it("drops a held name when another device renames its property", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\nstatus: draft\nowner: Sam\n---\n\nBody\n");
    const replica = new Y.Doc();
    try {
      render(<PropertiesPanel ydoc={doc} />);
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
      await user.clear(screen.getByLabelText("Property 1 name"));
      await user.type(screen.getByLabelText("Property 1 name"), "owner");

      replica.getMap("frontmatter").delete("status");
      setFrontmatterValue(replica, "phase", "draft");
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc))));

      expect(screen.queryByTestId("property-duplicate")).toBeNull();
      expect(screen.getByLabelText("Property 1 name")).toHaveProperty("value", "phase");
      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ owner: "Sam", phase: "draft" });
    } finally {
      replica.destroy();
      doc.destroy();
    }
  });

  it("holds a live document's name that a property with a cleared name still saves under", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc("---\na: one\nb: two\n---\n\nBody\n");
    try {
      render(<PropertiesPanel ydoc={doc} />);
      await user.clear(screen.getByLabelText("Property 1 name"));
      await user.clear(screen.getByLabelText("Property 2 name"));
      await user.type(screen.getByLabelText("Property 2 name"), "a");

      expect(screen.getAllByTestId("property-duplicate")).toHaveLength(1);
      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ a: "one", b: "two" });
    } finally {
      doc.destroy();
    }
  });

  it("keeps both of a live document's names that differ only by spaces inside quotes", async () => {
    const user = userEvent.setup();
    const doc = receivedYDoc('---\nowner: Sam\n" owner ": Ada\nstatus: draft\n---\n\nBody\n');
    try {
      render(<PropertiesPanel ydoc={doc} />);
      await user.type(screen.getByLabelText("Property status value"), "!");

      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ owner: "Sam", " owner ": "Ada", status: "draft!" });
    } finally {
      doc.destroy();
    }
  });
});
