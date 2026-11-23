import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as Y from "yjs";

const fixtures = new URL("../fixtures/body_sequence/", import.meta.url);
mkdirSync(fixtures, { recursive: true });

function write(name: string, update: Uint8Array) {
  writeFileSync(new URL(`${name}.bin`, fixtures), update);
}

function client(id: number) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = id;
  return { doc, text: doc.getText("sequence") };
}

function writeEdit(name: string, doc: Y.Doc, edit: () => void) {
  let update: Uint8Array | undefined;
  doc.once("update", (bytes: Uint8Array) => {
    update = bytes;
  });
  edit();
  assert.ok(update, `${name} emitted an update`);
  write(name, update);
}

const { doc, text } = client(1);
const paragraph = new Y.XmlElement("block");
paragraph.setAttribute("type", "paragraph");
const heading = new Y.XmlElement<{ type: string; level: number }>("block");
heading.setAttribute("type", "heading");
heading.setAttribute("level", 2);
const image = new Y.XmlElement("image");
image.setAttribute("src", "a.png");

doc.transact(() => {
  text.insertEmbed(0, paragraph);
  text.insert(1, "One");
  text.insertEmbed(4, heading);
  text.insert(5, "Two");
  text.insertEmbed(8, image);
  text.insert(9, "x", { link: { href: "https://example.com", title: "Example" } });
  text.format(2, 5, { bold: true });
});

const seed = Y.encodeStateAsUpdate(doc);
write("seed", seed);

function peer(id: number) {
  const peer = client(id);
  Y.applyUpdate(peer.doc, seed);
  return peer;
}

const join = peer(2);
const undo = new Y.UndoManager(join.text);
writeEdit("join", join.doc, () => join.text.delete(4, 1));
writeEdit("undo_join", join.doc, () => undo.undo());
undo.destroy();

const change = peer(3);
const boundary: unknown = change.text.toDelta()[3].insert;
assert.ok(boundary instanceof Y.XmlElement);
writeEdit("change_type", change.doc, () => boundary.setAttribute("type", "codeBlock"));

const remove = peer(4);
writeEdit("delete_boundary", remove.doc, () => remove.text.delete(4, 1));

const map = new Y.Map();
map.set("label", "metadata");
text.insertEmbed(10, map);
write("with_map", Y.encodeStateAsUpdate(doc));
