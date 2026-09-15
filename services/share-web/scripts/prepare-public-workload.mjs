// Run from the prepared share-web checkout: node --import tsx scripts/prepare-public-workload.mjs <selection-pin.json> <new-output-directory>
import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";
import {JSDOM} from "jsdom";

const [pinPath, output, ...extra] = process.argv.slice(2);
if (!pinPath || !output || extra.length || !isAbsolute(pinPath) || !isAbsolute(output)) throw new Error("Supply an absolute selection-pin JSON path and a new absolute output directory.");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {pretendToBeVisual: true});
for (const name of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLAnchorElement", "HTMLImageElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, {configurable: true, value: typeof dom.window[name] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name]});
}
try {
  const {preparePublicWorkload} = await import("../src/publicWorkloadAdapter.integration-helper.ts");
  const {renderPublicFixture} = await import("../src/publicWorkloadRendering.integration-helper.ts");
  console.log(JSON.stringify(preparePublicWorkload(JSON.parse(readFileSync(pinPath, "utf8")), output, renderPublicFixture), null, 2));
} finally {dom.window.close();}
