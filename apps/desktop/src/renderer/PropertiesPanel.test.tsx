// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { frontmatterMapValues, patchFrontmatter, setFrontmatterValue } from "@dohc/ydoc-projection/frontmatter-map";
import { PropertiesPanel } from "./PropertiesPanel";
import { parseFrontmatter, PROPERTIES_READ_ONLY_REASON } from "./markdown/frontmatter";
import { EDGE_DISPLAY, EDGE_MARKDOWN, receivedYDoc } from "./markdown/frontmatter.edge-fixture";

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

function ControlledPropertiesPanel(props: { initialBody: string; onShowSource?: () => void }) {
  const [body, setBody] = useState(props.initialBody);
  return (
    <>
      <PropertiesPanel body={body} onChange={setBody} onShowSource={props.onShowSource} />
      <output data-testid="current-body">{body}</output>
    </>
  );
}

describe("PropertiesPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it.each([true])("refuses removing an anchor before mutation (shared: %s)", async (shared) => {
    const user = userEvent.setup();
    const initialBody = "---\na: &v .nan\nb: {nested: [*v]}\n---\n\nBody";
    const doc = markdownToYDoc(initialBody);
    const before = Y.encodeStateAsUpdate(doc);
    const onChange = vi.fn();
    try {
      render(shared ? <PropertiesPanel ydoc={doc} /> : <PropertiesPanel body={initialBody} onChange={onChange} />);
      await user.click(screen.getByLabelText("Remove property a"));
      expect(screen.getByText("Properties are read-only").title).toBe(PROPERTIES_READ_ONLY_REASON);
      expect(onChange).not.toHaveBeenCalled();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(yDocToMarkdown(doc)).toBe(`${initialBody}\n`);
    } finally { doc.destroy(); }
  });

  it("keeps focus on the edited property when another device removes a row above it", async () => {
    const user = userEvent.setup();
    const doc = markdownToYDoc("---\nowner: Sam\nstatus: draft\npriority: low\n---\n\nBody\n");
    try {
      render(<PropertiesPanel ydoc={doc} />);
      await user.click(screen.getByLabelText("Property status value"));

      act(() => patchFrontmatter(doc, new Map(), ["owner"]));

      expect(document.activeElement).toBe(screen.getByLabelText("Property status value"));
      await user.keyboard("!");
      expect(frontmatterMapValues(doc.getMap("frontmatter"))).toEqual({ status: "draft!", priority: "low" });
    } finally { doc.destroy(); }
  });

  it.each([true])("keeps another device's new value when a rename lands before the rows refresh (live: %s)", (live) => {
    const markdown = "---\nstatus: draft\n---\n\nBody\n";
    const doc = markdownToYDoc(markdown);
    const onChange = vi.fn();
    const panel = (body: string) => (live ? <PropertiesPanel ydoc={doc} /> : <PropertiesPanel body={body} onChange={onChange} />);
    // Rename after the panel reads the new value, before its effect refreshes
    // the rows, which still hold the value they read.
    function RenamesOnCommit() {
      useLayoutEffect(() => {
        fireEvent.change(screen.getByLabelText("Property 1 name"), { target: { value: "phase" } });
      }, []);
      return null;
    }
    try {
      const { rerender } = render(<>{panel(markdown)}</>);

      act(() => {
        setFrontmatterValue(doc, "status", "ready");
        rerender(<>{panel(markdown.replace("draft", "ready"))}<RenamesOnCommit /></>);
      });

      const saved = live ? frontmatterMapValues(doc.getMap("frontmatter")) : parseFrontmatter(onChange.mock.lastCall?.[0] ?? "").meta;
      expect(saved).toEqual({ phase: "ready" });
    } finally { doc.destroy(); }
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

  describe("pills", () => {

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

  describe("renaming a shared property", () => {
    const budget = "---\n# Monthly\nbudget: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody";
    const names = () =>
      screen.getAllByTestId("property-key").map((input) => (input as HTMLInputElement).value);
    async function rename(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
      const name = screen.getAllByTestId("property-key").find((input) => (input as HTMLInputElement).value === from)!;
      await user.clear(name);
      await user.type(name, to);
    }

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
        expect(yDocToMarkdown(doc)).toBe("---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: hunter2\n---\n\nBody\n");
      } finally { doc.destroy(); }
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
        const expected = "---\n# Monthly\ncost: 100 # euros\n# Wi-Fi password\nwifi: new\nowner: sam\n---\n\nBody\n";
        expect(yDocToMarkdown(doc)).toBe(expected);
        expect(yDocToMarkdown(peer)).toBe(expected);
      } finally { doc.destroy(); peer.destroy(); }
    });
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
      expect(yDocToMarkdown(replica)).toBe("---\nid: note-1\ntitle: Plan\ndue: friday\noptions:\n  pinned: true\n---\n\nBody\n");
    } finally {
      replica.destroy();
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
      expect(yDocToMarkdown(doc)).toBe("---\ntags:\n  - kyoto\n  - food\n  - '2026'\nstatus: draft\n---\n\nBody\n");
      expect(propertyValue("tags")).toBe("kyoto, food, 2026");
    } finally {
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
});

describe("PropertiesPanel's Source button", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens Source while a reserved name's flag hides a saved value, but not on a new pill", async () => {
    const user = userEvent.setup();
    render(<ControlledPropertiesPanel initialBody={"---\nstatus: draft\nowner: Sam\n---\n\nBody\n"} onShowSource={vi.fn()} />);

    await user.clear(screen.getByLabelText("Property 1 name"));
    await user.type(screen.getByLabelText("Property 1 name"), "title");
    expect(screen.getByTestId("property-reserved")).toBeTruthy();
    expect(screen.getByTestId("current-body").textContent).toBe("---\nstatus: draft\nowner: Sam\n---\n\nBody\n");
    expect(screen.getByTestId("properties-source")).toBeTruthy();

    await user.clear(screen.getByLabelText("Property 1 name"));
    await user.type(screen.getByLabelText("Property 1 name"), "stage");
    expect(screen.queryByTestId("property-reserved")).toBeNull();
    expect(screen.queryByTestId("properties-source")).toBeNull();

    await user.click(screen.getByTestId("property-add"));
    await user.type(screen.getByLabelText("Property 3 name"), "title");
    expect(screen.getByTestId("property-reserved")).toBeTruthy();
    expect(screen.queryByTestId("properties-source")).toBeNull();
  });

  it("shows a note you can only view as pills with no +, no × and no edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PropertiesPanel
        body={"---\nid: 01JD8K2V7QX4\nstatus: Draft\nowner: Sam\n---\n\nBody\n"}
        onChange={onChange}
        readOnly
        onShowSource={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId("property-row")).toHaveLength(2);
    expect(screen.queryByTestId("property-add")).toBeNull();
    expect(screen.queryByTestId("property-remove")).toBeNull();
    expect(screen.getByTestId("properties-source")).toBeTruthy();
    await user.type(screen.getByLabelText("Property status value"), "x");
    await user.type(screen.getByLabelText("Property 1 name"), "x");
    await user.tab();
    expect(propertyValue("status")).toBe("Draft");
    expect(onChange).not.toHaveBeenCalled();
  });
});
