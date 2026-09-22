import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const require = createRequire(join(repo, "package.json"));
const bases = [process.env.DOHC_YJS_BASE, join(repo, "crates/yrs-interop/scripts"), repo].filter(Boolean);
let path;
for (const base of bases) {
  try { path = require.resolve("yjs", { paths: [base] }); break; } catch { /* next base */ }
}
if (!path) throw new Error(`could not resolve yjs from any base:\n${bases.join("\n")}`);
const Y = require(path);
if (require(join(dirname(path), "../package.json")).version !== "13.6.30") throw new Error("requires pinned yjs 13.6.30");
const doc = new Y.Doc({ gc: false });
doc.clientID = 987680794;
const updates = [];
doc.on("update", bytes => updates.push([...bytes]));
const frontmatter = doc.getMap("frontmatter");
const body = doc.getXmlFragment("body");
const nested = new Y.Map();
const paragraph = new Y.XmlElement("paragraph");
const text = new Y.XmlText();
doc.transact(() => {
  doc.getMap("meta").set("schemaVersion", 1);
  frontmatter.set("title", "delivery");
  frontmatter.set("nested", nested);
  nested.set("label", "deleted-nested-value");
  body.insert(0, [paragraph]);
  paragraph.insert(0, [text]);
  text.insert(0, "deleted-text Hello");
});
doc.transact(() => {
  frontmatter.set("title", "after-restart");
  nested.set("label", "second-nested-value");
  text.delete(0, 13);
});
doc.transact(() => {
  frontmatter.delete("nested");
  body.delete(0, 1);
  const survivor = new Y.XmlElement("paragraph");
  const survivorText = new Y.XmlText();
  body.insert(0, [survivor]);
  survivor.insert(0, [survivorText]);
  survivorText.insert(0, "Hello");
  frontmatter.set("title", "stop-cut");
});
const retainedState = [...Y.encodeStateAsUpdate(doc)];
const collected = new Y.Doc();
for (const update of updates) Y.applyUpdate(collected, Uint8Array.from(update));
const collectedState = [...Y.encodeStateAsUpdate(collected)];
if (JSON.stringify(retainedState) === JSON.stringify(collectedState)) throw new Error("fixture did not exercise GC");
const output = process.env.DOHC_FIXTURE_OUT ? resolve(process.env.DOHC_FIXTURE_OUT) : here;
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "deleted-history.json"), `${JSON.stringify({ yjs: "13.6.30", updates, retainedState, collectedState }, null, 2)}\n`);
doc.destroy();
collected.destroy();
