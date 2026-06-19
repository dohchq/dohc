// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
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
