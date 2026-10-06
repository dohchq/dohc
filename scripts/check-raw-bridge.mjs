import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function rawBridgeCalls(source) {
  return (source.match(/\bbridge\(\)|window\.dohcDesktop\b/gu) ?? []).length;
}
export function rendererSources(root) {
  return readdirSync(root, { recursive: true }).filter(name => /\.tsx?$/u.test(name) && statSync(join(root, name)).isFile());
}
export function checkRawBridge(root, inventory) {
  const violations = [];
  for (const name of rendererSources(root)) {
    const file = name.split(sep).join("/");
    if (/\.test(?:-d)?\.|testHarness|fixture/u.test(file) || ["bridge.ts", "desktopAction.ts", "desktopActionTesting.ts", "desktopOperations.ts"].includes(file)) continue;
    const before = inventory.migrated.includes(file) ? 0 : inventory.counts[file] ?? 0;
    const after = rawBridgeCalls(readFileSync(join(root, name), "utf8"));
    if (after > before) violations.push("RATCHET " + file + ": raw bridge() calls " + before + " -> " + after + ". Use desktopAction or the operation's owner.");
  }
  return violations;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root = "apps/desktop/src/renderer", inventoryPath = new URL("./renderer-raw-bridge-inventory.json", import.meta.url)] = process.argv.slice(2);
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const violations = checkRawBridge(root, inventory);
  for (const line of violations) console.log(line);
  console.log(JSON.stringify({ base: inventory.base, added: violations.length }));
  process.exitCode = violations.length ? 1 : 0;
}
