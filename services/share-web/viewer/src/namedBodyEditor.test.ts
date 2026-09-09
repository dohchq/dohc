// @vitest-environment jsdom
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown, getDohcYDocBodyFragment} from "@dohc/ydoc-projection";
import {mountLiveBodyEditor} from "@dohc/ydoc-projection/browser-editor";

it("edits the existing body while live, blocks local paste while paused, and still shows remote updates", () => {
  const doc = markdownToYDoc("# Shared\n\nOriginal"), mount = document.createElement("div"); document.body.append(mount);
  let live = true;
  const editor = mountLiveBodyEditor(mount, {body: getDohcYDocBodyFragment(doc), label: "Shared file editor", canEdit: () => live,
    edit(change) {if (!live) return false; doc.transact(change); return true;}});
  const paste = (text: string) => {
    const event = new Event("paste", {bubbles: true, cancelable: true});
    Object.defineProperty(event, "clipboardData", {value: {getData: (type: string) => type === "text/plain" ? text : "", files: []}});
    mount.querySelector('[role="textbox"]')!.dispatchEvent(event);
  };
  try {
    expect(mount.textContent).toContain("Original");
    paste("Local edit "); expect(yDocToMarkdown(doc)).toContain("Local edit");
    live = false; editor.refresh(); const before = Y.encodeStateAsUpdate(doc);
    paste("Forbidden edit "); expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const peer = new Y.Doc(); Y.applyUpdate(peer, before);
    const body = getDohcYDocBodyFragment(peer), paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
    text.insert(0, "Remote change"); paragraph.insert(0, [text]); body.insert(body.length, [paragraph]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)); peer.destroy();
    expect(mount.textContent).toContain("Remote change");
    expect(mount.querySelector('[contenteditable="false"]')).not.toBeNull();
  } finally {editor.destroy(); doc.destroy(); mount.remove();}
});
it("renders remote image references without creating image fetches or navigable editor links", () => {
  const doc = markdownToYDoc("![Photo](https://example.test/tracker.png)\n\n[Leave](https://example.test)");
  const mount = document.createElement("div"); document.body.append(mount);
  const editor = mountLiveBodyEditor(mount, {body: getDohcYDocBodyFragment(doc), label: "Shared file editor", canEdit: () => false, edit: () => false});
  try {
    expect(mount.querySelector("img[src]")).toBeNull(); expect(mount.textContent).toContain("Photo");
    const anchor = mount.querySelector("a")!, click = new MouseEvent("click", {bubbles: true, cancelable: true});
    anchor.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
  } finally {editor.destroy(); doc.destroy(); mount.remove();}
});
