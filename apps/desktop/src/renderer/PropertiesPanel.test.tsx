// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
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
import {
  EDGE_DISPLAY,
  EDGE_FRONTMATTER,
  EDGE_MARKDOWN,
  receivedYDoc,
  recordedYDoc,
} from "./markdown/frontmatter.edge-fixture";

// A text input shows its value on one line.
function propertyValue(key: string): string {
  return (screen.getByLabelText(`Property ${key} value`) as HTMLInputElement).value;
}

function oneLine(text: string): string {
  return text.replaceAll("\n", "");
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

  it("shows shared-type frontmatter as YAML and edits only the changed property", async () => {
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
        expect(propertyValue(key), key).toBe(oneLine(text));
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
      expect(propertyValue("settings")).toBe(oneLine("constructor: kept\npinned: true"));

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
      expect(propertyValue(key), key).toBe(oneLine(text));
    }

    await user.clear(screen.getByLabelText("Property status value"));
    await user.type(screen.getByLabelText("Property status value"), "ready");

    expect(onChange).toHaveBeenLastCalledWith(body.replace("status: draft", "status: ready"));
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
